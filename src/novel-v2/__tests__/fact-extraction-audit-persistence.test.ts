import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createNovelWorkflowActivities } from "../temporal/activities";
import { createWorkspaceSkillProvider } from "../skill-runtime";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact } from "../protocol";

/**
 * 提取审计必须落盘（2026-10-14 复核轮 round 66）。
 *
 * 缺陷（本轮实测）：fact-extraction 的 artifact 在**提取前**就建好，只带
 * `sourceArtifactId`；而矛盾核验（`verification`）、自造主体（`coinedSubjects`）、
 * 丢弃统计（`stats`）都在提取**后**才算出，且只 `console.warn`。
 * 真库核验：最近 5 个 fact-extraction artifact 的 payload 里
 * `stats`/`verification` **全为 null** ⇒ 这些痕迹随日志一起消失。
 *
 * 后果：事后无法回答"这一章提取消遇了多少条、为何判 candidate、有没有自造主体"。
 * 这是 round 15 那条（"不阻塞主路径"与"不留痕迹"是两件事）在提取侧的同族。
 *
 * 本锁：落库的 artifact 必须带 verification / stats / coinedSubjects。
 * 用例驱动真实的 extractFacts 路径（model gateway 返回结构化 claim），
 * 不 stub 被测函数（round 26 的教训：stub 掉被测对象等于没测）。
 */
describe("fact-extraction 审计落盘（round 66）", () => {
  const buildActivitiesWithModel = (claims: Array<{ subject: { kind: string; id: string }; predicate: string; object: { kind: string; value: unknown }; evidence: string; humanReadable: string; confidence: number; narrativeStart?: number }>) => {
    const recorded: Artifact[] = [];
    const repository = {
      recordArtifact: vi.fn(async () => undefined),
      getFactExtractionContext: vi.fn(async () => ({ claimsDigest: "d", contentHashes: new Set<string>(), claimsIndex: new Map(), existingValueHashById: new Map() })),
      getOpenForeshadowingAndPromises: vi.fn(async () => ({ foreshadowings: [], promises: [] })),
      recordFactExtraction: vi.fn(async (input: { artifact: Artifact }) => { recorded.push(input.artifact); return []; }),
      registerPendingSubjects: vi.fn(async () => 0),
      recordNarrativeElements: vi.fn(async () => ({ foreshadowings: 0, promises: 0, payoffs: 0 })),
      getProjectDetail: vi.fn(async () => ({ id: "p1", title: "测试项目", metadata: {} })),
      projectModelRoutingConfig: vi.fn(async () => undefined),
      recordModelInvocation: vi.fn(async () => undefined),
    };
    const modelGateway = {
      getRoutingSnapshot: () => ({ id: "snap" }),
      generateStructured: vi.fn(async () => ({
        value: {
          facts: claims,
          narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
        },
      })),
      embed: vi.fn(async () => ({ value: [], vectors: [] })),
    };
    const { extractFacts } = createNovelWorkflowActivities({
      repository: repository as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] } as never,
      skillProvider: createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2")) as never,
      modelGateway: modelGateway as never,
    });
    return { extractFacts, recorded };
  };

  const artifact = {
    id: "artifact-source",
    projectId: "p1",
    taskId: "task-1",
    kind: "chapter" as const,
    baseRevision: 1,
    text: "正文",
    fingerprint: "fp",
    structuredData: {},
  } as unknown as Artifact;

  const claim = (subjectId: string, evidence: string) => ({
    subject: { kind: "character", id: subjectId },
    predicate: "持有",
    object: { kind: "string", value: "某物" },
    evidence,
    humanReadable: `${subjectId}持有某物`,
    confidence: 0.9,
    narrativeStart: 41,
  });

  const run = async (extractFacts: ReturnType<typeof createNovelWorkflowActivities>["extractFacts"], text: string) =>
    extractFacts({
      workflowId: "w1",
      projectId: "p1",
      artifact,
      text,
      blueprint: { preflightId: "pf", id: "bp" } as never,
      routingSnapshot: {} as never,
      documentId: "doc-1",
      narrativeOrder: 41,
    });

  it("① 落库的 artifact 带 verification / stats / coinedSubjects", async () => {
    // 注意：模型返回的 subject.id 会被 identityIndex 归一——这里没有注册表，原样保留。
    const { extractFacts, recorded } = buildActivitiesWithModel([
      claim("灰衣杂役", "灰衣杂役站在门口，手里捧着册子"), // 自造主体（正文无此合称）
      claim("楚衡", "楚衡把册子接过来，翻了翻"),          // 正常主体
    ]);

    await run(extractFacts, "灰衣被汗水浸透。杂役们列队走过。楚衡把册子接过来。");

    expect(recorded).toHaveLength(1);
    const persisted = recorded[0]!.structuredData as Record<string, unknown>;
    expect(persisted["verification"], "矛盾核验必须落盘").toBeDefined();
    expect(persisted["stats"], "丢弃统计必须落盘").toBeDefined();
    expect(persisted["coinedSubjects"], "自造主体必须落盘").toEqual(["灰衣杂役"]);
    expect(persisted["sourceArtifactId"], "来源工件 id 必须保留").toBe("artifact-source");
  });

  it("② 无问题时字段仍存在（空值而非缺失）——审计面可依赖字段存在性", async () => {
    const { extractFacts, recorded } = buildActivitiesWithModel([claim("楚衡", "楚衡把册子接过来，翻了翻")]);

    await run(extractFacts, "楚衡把册子接过来，翻了翻。");

    const persisted = recorded[0]!.structuredData as Record<string, unknown>;
    expect(persisted["verification"]).toEqual({ contradictions: [] });
    expect(persisted["stats"]).toBeDefined();
    expect(persisted["coinedSubjects"]).toEqual([]);
  });
});

