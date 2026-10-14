import { describe, expect, it, vi } from "vitest";
import { createNovelWorkflowActivities } from "../temporal/activities";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";

/**
 * 开放伏笔注入按线索静默账过滤的生产者侧回归（docs/novel-v2/state-audit-20261013.md §4.5）。
 *
 * 症状：`retrieveMemory` 把整本 open 伏笔无条件映射成 `score: 1.0` 的记忆命中，实测
 * 占 98K 记忆预算的 71%（425 条 / 69,845 token），把 24 条真事实断言挤出预算
 * （第 167 章 manifest 的 44 条 excluded 里 32 条是 chapter-memory/memory/graph）。
 *
 * 边界：本测试只判"哪类伏笔进入注入通道"——仍在推进的线不进（留给检索与竞价）、
 * 已静默/从未提及/无法判定的线进；不判静默扫描算法自身的精度（那是
 * narrative-dormancy.test.ts 的职责），也不判预算分配（cognition 测试的职责）。
 */

/** 三条 open 伏笔：一条仍在推进（关键词在近章仍出现）、一条曾活跃已静默、一条埋设后从未再提及。 */
const foreshadowings = [
  { id: "f-running", description: "仍在推进的线", triggerKeywords: ["老槐树"], plantedRevisionId: "rev-1", expectedPayoffWindow: "20章内" },
  { id: "f-silent", description: "曾活跃现已静默的线", triggerKeywords: ["蓝光"], plantedRevisionId: "rev-2", expectedPayoffWindow: "20章内" },
  { id: "f-never", description: "埋设后从未再被提及的线", triggerKeywords: ["树洞"], plantedRevisionId: "rev-3", expectedPayoffWindow: "20章内" },
];

/** 40 章正文：老槐树在第 39 章仍被提及（running）；蓝光只在第 3 章出现（silent）；树洞从未出现（never-mentioned）。
 *  注意 narrative-dormancy 的扫描范围是"埋设章之后"（`narrativeOrder <= plantedOrder` 跳过），
 *  所以每条线的关键词都必须出现在其埋设章之后才有提及记录。 */
function chapterTexts(): Record<string, string> {
  const texts: Record<string, string> = {};
  for (let order = 1; order <= 40; order += 1) {
    const parts = [`第${order}章的正文。`];
    if (order === 3) parts.push("他看见了蓝光。");
    if (order === 39) parts.push("老槐树下有人等他。");
    texts[`obj-${order}`] = parts.join("");
  }
  return texts;
}

function buildActivities() {
  const repository = {
    ensureFoundationMemoryClaims: vi.fn(async () => []),
    countDocuments: vi.fn(async () => 40),
    getNarrativeStatePinnedClaims: vi.fn(async () => []),
    getOpenForeshadowingAndPromises: vi.fn(async () => ({ foreshadowings, promises: [] })),
    getNarrativeRhythmSnapshot: vi.fn(async () => undefined),
    getActiveStyleContract: vi.fn(async () => null),
    getSerialContextSnapshot: vi.fn(async () => undefined),
    listFinalChapterContentRefs: vi.fn(async () => Array.from({ length: 40 }, (_, index) => ({ narrativeOrder: index + 1, objectKey: `obj-${index + 1}` }))),
    listOpenForeshadowingPresenceInputs: vi.fn(async () =>
      foreshadowings.map((item) => ({
        id: item.id,
        description: item.description,
        plantedOrder: item.id === "f-running" ? 30 : item.id === "f-silent" ? 2 : 3,
        keywords: item.triggerKeywords,
      })),
    ),
  };
  const objects = { getText: vi.fn(async (key: string) => chapterTexts()[key] ?? "") };
  const activities = createNovelWorkflowActivities({
    repository: repository as unknown as NovelPostgresRepository,
    memoryProvider: { search: async () => [] },
    skillProvider: { list: async () => [] },
    modelGateway: {} as unknown as ModelGateway,
    objectStore: objects as unknown as ContentObjectStore,
  });
  return { activities, repository };
}

const plan = { projectId: "p1", taskClass: "drafting", targetDocumentId: "doc-41", narrativeCutoff: 40, facets: [] } as never;

describe("开放伏笔注入按静默账过滤", () => {
  it("只注入已静默/从未提及的伏笔，仍在推进的线不进注入通道", async () => {
    const { activities } = buildActivities();
    const bundle = await activities.retrieveMemory({ projectId: "p1", plan });
    const injected = bundle.claims.filter((claim) => claim.reason === "open-foreshadowing-injection").map((claim) => claim.id);
    expect(injected).toContain("f-silent");
    expect(injected).toContain("f-never");
    expect(injected).not.toContain("f-running");
  });

  it("注入项不再自称满分相关度（score 0），不抢在证据排序的事实之前占预算", async () => {
    const { activities } = buildActivities();
    const bundle = await activities.retrieveMemory({ projectId: "p1", plan });
    const injected = bundle.claims.filter((claim) => claim.reason === "open-foreshadowing-injection");
    expect(injected.length).toBeGreaterThan(0);
    for (const claim of injected) {
      expect(claim.score).toBe(0);
      expect(claim.semanticRank).toBe(0);
    }
  });

  it("静默账不可得时不注入任何伏笔（无判定即全量注入正是被修的缺陷）", async () => {
    const { activities, repository } = buildActivities();
    // 抽掉定稿集：静默扫描无从判定在场，宁可不注入。
    repository.listFinalChapterContentRefs.mockResolvedValueOnce([]);
    const bundle = await activities.retrieveMemory({ projectId: "p1", plan });
    expect(bundle.claims.filter((claim) => claim.reason === "open-foreshadowing-injection")).toHaveLength(0);
    // 伏笔行仍被取到，只是没有静默判定可用。
    expect(repository.getOpenForeshadowingAndPromises).toHaveBeenCalled();
  });
});
