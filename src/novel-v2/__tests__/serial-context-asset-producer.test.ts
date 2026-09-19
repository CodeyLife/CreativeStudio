import { describe, expect, it, vi } from "vitest";
import { createNovelWorkflowActivities } from "../temporal/activities";
import { serialContextFingerprint } from "../application/serial-context-fingerprint";
import { renderSerialContext } from "../prompts/chapter-planning-context";
import type { SerialContextSnapshot } from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";

/**
 * 序列证据资产账本的生产者侧回归（F1 断链）。
 *
 * 症状：`assetSpans` 的确定性扫描只挂在 `retrieveMemoryForReview` 一处，repository
 * 恒返回空数组，于是 draft/revision 两面拿到的是"有序列证据、无资产对照"的快照，
 * `renderSerialContext` 的资产行判据 `if (serial.assetSpans?.length)` 恒假——
 * 渲染点四处都在，数据只到一处。旧的 `serial-context.test.ts` 手工构造 assetSpans，
 * 属"夹具照实现的假设写"，故断链期间照绿。
 *
 * 边界：本测试只判生产者是否把账本送到每一面，以及回填是否连带重算指纹；
 * 扫描算法自身的精度局限（名词吞尾、不做存量解算）由 asset-ledger 自己的测试负责。
 */

function makeSnapshot(overrides: Partial<SerialContextSnapshot> = {}): SerialContextSnapshot {
  const base: Omit<SerialContextSnapshot, "fingerprint"> = {
    window: 6,
    chapters: [
      { documentId: "doc-1", revisionId: "rev-1", narrativeOrder: 1, title: "起", narrativeFunction: "development" },
      { documentId: "doc-2", revisionId: "rev-2", narrativeOrder: 2, title: "承", narrativeFunction: "discovery" },
    ],
    characterSpans: [],
    functionRuns: [],
    subjectSpans: [],
    openPromises: [],
    // repository 侧实形就是空数组——扫描发生在上层（只有上层能取正文）。
    assetSpans: [],
  };
  const snapshot = { ...base, ...overrides };
  return { ...snapshot, fingerprint: serialContextFingerprint(snapshot) };
}

function buildActivities(snapshot: SerialContextSnapshot, texts: Record<string, string | Error>) {
  const repository = {
    ensureFoundationMemoryClaims: vi.fn(async () => []),
    countDocuments: vi.fn(async () => 2),
    getNarrativeStatePinnedClaims: vi.fn(async () => []),
    getOpenForeshadowingAndPromises: vi.fn(async () => ({ foreshadowings: [], promises: [] })),
    getNarrativeRhythmSnapshot: vi.fn(async () => undefined),
    getActiveStyleContract: vi.fn(async () => null),
    getSerialContextSnapshot: vi.fn(async () => snapshot),
    getChapterContentRefsByOrders: vi.fn(async () => [
      { narrativeOrder: 1, objectKey: "obj-1" },
      { narrativeOrder: 2, objectKey: "obj-2" },
    ]),
  };
  const objects = {
    getText: vi.fn(async (key: string) => {
      const value = texts[key];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`无该对象: ${key}`);
      return value;
    }),
  };
  const activities = createNovelWorkflowActivities({
    repository: repository as unknown as NovelPostgresRepository,
    memoryProvider: { search: async () => [] },
    skillProvider: { list: async () => [] },
    modelGateway: {} as unknown as ModelGateway,
    objectStore: objects as unknown as ContentObjectStore,
  });
  return { activities, repository, objects };
}

const plan = { projectId: "p1", taskClass: "drafting", targetDocumentId: "doc-3", narrativeCutoff: 2, facets: [] } as never;

describe("序列证据资产账本的生产者（四面同源）", () => {
  it("正文（draft）侧的序列证据带资产账本，且渲染出对照行", async () => {
    const { activities } = buildActivities(makeSnapshot(), {
      "obj-1": "他借着火光数了数，怀里两块灵石。",
      "obj-2": "账房伸出指头，要三块灵石。",
    });
    const bundle = await activities.retrieveMemory({ projectId: "p1", plan });
    const serial = bundle.serialContext!;
    expect(serial.assetSpans.map((span) => span.subject)).toContain("灵石");
    expect(renderSerialContext(serial)).toContain("可数资产数量对照");
  });

  it("回填后指纹按新内容重算（指纹不得停在扫描前，否则 bundle 指纹漏记账本）", async () => {
    const snapshot = makeSnapshot();
    const { activities } = buildActivities(snapshot, {
      "obj-1": "他借着火光数了数，怀里两块灵石。",
      "obj-2": "他说只剩一块灵石了。",
    });
    const serial = (await activities.retrieveMemory({ projectId: "p1", plan })).serialContext!;
    expect(serial.assetSpans.length).toBeGreaterThan(0);
    expect(serial.fingerprint).not.toBe(snapshot.fingerprint);
    expect(serial.fingerprint).toBe(serialContextFingerprint(serial));
  });

  it("正文取不到时降级为无资产对照，且不留下与内容不符的指纹", async () => {
    const snapshot = makeSnapshot();
    const { activities, objects } = buildActivities(snapshot, { "obj-1": new Error("对象存储不可用"), "obj-2": new Error("对象存储不可用") });
    const serial = (await activities.retrieveMemory({ projectId: "p1", plan })).serialContext!;
    expect(serial.assetSpans).toEqual([]);
    expect(serial.fingerprint).toBe(snapshot.fingerprint);
    expect(objects.getText).toHaveBeenCalled();
  });

  it("窗口正文没有可数资产提及时指纹与内容都不变（不给历史项目制造漂移）", async () => {
    const snapshot = makeSnapshot();
    const { activities } = buildActivities(snapshot, {
      "obj-1": "雨落了一夜，他没有睡。",
      "obj-2": "第二天一早，他往城门走去。",
    });
    const serial = (await activities.retrieveMemory({ projectId: "p1", plan })).serialContext!;
    expect(serial.assetSpans).toEqual([]);
    expect(serial.fingerprint).toBe(snapshot.fingerprint);
  });

  it("repository 已带账本时不重复扫描（唯一生产者，不再分叉）", async () => {
    const withAssets = makeSnapshot({ assetSpans: [{ subject: "灵石", entries: [{ narrativeOrder: 1, quantity: "两块", value: 2 }, { narrativeOrder: 2, quantity: "三块", value: 3 }] }] });
    const { activities, objects } = buildActivities(withAssets, {});
    const serial = (await activities.retrieveMemory({ projectId: "p1", plan })).serialContext!;
    expect(serial.assetSpans).toHaveLength(1);
    expect(objects.getText).not.toHaveBeenCalled();
  });
});
