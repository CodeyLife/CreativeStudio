import { describe, expect, it, vi } from "vitest";
import { assessRuntimeLearningWithModel, buildRuntimeLearningPrompt, parseRuntimeLearningAssessmentV2, reviewIssuesForLearning } from "../learning-assessment";
import { buildCraftRuleCandidateInput, createNovelWorkflowActivities } from "../temporal/activities";
import type { Artifact, Review, RuntimeLearningAssessmentV2, SerialContextSnapshot } from "../protocol";
import type { ModelGateway, ModelUsage } from "../model-gateway";
import type { ModelExecutionProvenance, ModelRoutingSnapshot } from "../model-routing";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { ContentObjectStore } from "../object-store";
import type { CommitService } from "../commit-service";

const usage: ModelUsage = { model: "test", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 };
const mockProvenance: ModelExecutionProvenance = {
  routeSnapshotId: "test-snapshot",
  purpose: "learning.assess",
  candidateIndex: 0,
  executor: "api",
  model: "test",
  promptFingerprint: "test-fingerprint",
};
const mockRoutingSnapshot: ModelRoutingSnapshot = {
  id: "test-snapshot",
  configVersion: 1,
  profiles: [],
  routes: {},
  createdAt: 0,
};
const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
const blockingReview: Review = { id: "review-1", projectId: "p1", artifactId: artifact.id, reviewerId: "internal", identity: "internal", verdict: "blocked", issues: [{ severity: "blocker", title: "视角越界", evidence: "章节写出 POV 角色无法知道的幕后真相。" }], createdAt: 2, artifactFingerprint: artifact.fingerprint };

function base() {
  return { projectId: "p1", source: { workflowId: "wf-1", artifactId: artifact.id, reviewIds: ["review-1"], fingerprint: artifact.fingerprint }, createdAt: 3 };
}

describe("V2 runtime learning assessment", () => {
  it("requires mechanism and affected input class before proposing an improvement", () => {
    expect(() => parseRuntimeLearningAssessmentV2({
      conclusion: "propose-improvement",
      symptom: "视角越界",
      failingLayer: "review",
      affectedInputClass: "限知视角章节",
      boundaries: "仅限 POV 知识边界",
      regressionRisks: ["可能误伤全知叙事"],
      candidate: { targetKind: "skill", targetId: "pov", rationale: "补足规则", afterText: "x".repeat(120) },
    }, base())).toThrow(/underlyingMechanism/);
  });

  it("does not hardcode propose-improvement when the model gateway is unavailable", async () => {
    const { assessment, validationError } = await assessRuntimeLearningWithModel({ projectId: "p1", workflowId: "wf-1", artifact, reviews: [blockingReview], now: 4 });
    expect(assessment.conclusion).toBe("no-shared-learning");
    expect(assessment.symptom).toContain("视角越界");
    expect(validationError).toContain("模型网关未配置");
  });

  it("uses model output only after parser validation succeeds", async () => {
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => ({ value: {
        conclusion: "propose-improvement",
        symptom: "限知视角章节泄漏幕后真相",
        failingLayer: "review",
        underlyingMechanism: "审核规则只要求发现视角越界，但 drafting skill 没有把 POV 角色知识边界转化为写作前自检与替换决策，导致长篇章节在铺陈反派行动时绕过了冻结记忆的角色可知范围。",
        affectedInputClass: "采用限知 POV 且存在作者已知但角色未知事实的章节正文",
        boundaries: "仅覆盖限知 POV 的知识边界；全知叙事、插叙旁白或已明确授权的戏剧反讽不适用。",
        regressionRisks: ["可能让合法的悬念铺垫过度保守"],
        candidate: {
          targetKind: "skill",
          targetId: "pov-boundary",
          rationale: "把审校机制前移到 drafting 自检",
          afterText: JSON.stringify({ "chapter.review.structure": "通用原则：审核限知视角章节时，先核对 POV 角色在当前叙事截止点已经亲历、听闻或可合理推断的信息。决策规则：凡是只存在于作者全局记忆、他人私下行动或未来章节的事实，除非通过可观察痕迹被 POV 角色感知，否则标记为知识边界问题。验证方式：逐段检查信息来源，无法标注来源的句子必须要求改写为可观察现象、角色误判或暂时留白。" }),
        },
      } as T, usage, provenance: mockProvenance }),
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    const { assessment } = await assessRuntimeLearningWithModel({
      projectId: "p1",
      workflowId: "wf-1",
      artifact,
      reviews: [blockingReview],
      model,
      now: 5,
      availableSkills: [{ skillId: "pov-boundary", capabilities: ["review"], executionPoints: ["chapter.review.structure"] }],
    });
    expect(assessment).toMatchObject({
      conclusion: "propose-improvement",
      underlyingMechanism: expect.stringContaining("POV"),
      affectedInputClass: expect.stringContaining("限知 POV"),
      candidate: { targetKind: "skill", targetId: "pov-boundary" },
    });
    const rejected = await assessRuntimeLearningWithModel({
      projectId: "p1",
      workflowId: "wf-1",
      artifact,
      reviews: [blockingReview],
      model,
      now: 6,
      availableSkills: [{ skillId: "pov-boundary", capabilities: ["draft"], executionPoints: ["chapter.drafting"] }],
    });
    expect(rejected.assessment.conclusion).toBe("no-shared-learning");
    expect(rejected.validationError).toContain("未声明的 executionPoint");
  });

  it("short-circuits zero-issue chapters when only presence spans are present", async () => {
    let called = 0;
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => {
        called += 1;
        return { value: { conclusion: "propose-improvement" } as T, usage, provenance: mockProvenance };
      },
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    // 只有状态/主题跨度（在场统计）时，不触发零 issue 评估
    const { assessment } = await assessRuntimeLearningWithModel({
      projectId: "p1",
      workflowId: "wf-1",
      artifact,
      reviews: [],
      model,
      now: 8,
      serialContext: { ...serialSnapshot, functionRuns: [] },
    });
    expect(called).toBe(0);
    expect(assessment.conclusion).toBe("no-shared-learning");
  });

  it("still triggers zero-issue evaluation for function runs and issue clusters", async () => {
    let called = 0;
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => {
        called += 1;
        return { value: { conclusion: "no-shared-learning", candidate: { targetKind: "none" } } as T, usage, provenance: mockProvenance };
      },
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    await assessRuntimeLearningWithModel({
      projectId: "p1",
      workflowId: "wf-1",
      artifact,
      reviews: [],
      model,
      now: 9,
      serialContext: serialSnapshot,
    });
    await assessRuntimeLearningWithModel({
      projectId: "p1",
      workflowId: "wf-1",
      artifact,
      reviews: [],
      model,
      now: 10,
      recentIssueClusters: [{ key: "cross-chapter-restatement", chapterCount: 2, narrativeOrders: [2, 3], titles: ["第二章", "第三章"], severities: ["warning"] }],
    });
    expect(called).toBe(2);
  });

  it("exposes declared execution points when asking for a reusable Skill patch", () => {
    const prompt = buildRuntimeLearningPrompt({
      artifact,
      reviews: [blockingReview],
      availableSkills: [{ skillId: "pov-boundary", capabilities: ["review"], executionPoints: ["chapter.review.structure"] }],
    });
    expect(prompt).toContain("executionPoints: chapter.review.structure");
    expect(prompt).toContain("JSON 对象的字符串表示");
  });

  it("keeps warning-only review evidence in the learning assessment path", async () => {
    const warningReview: Review = {
      ...blockingReview,
      id: "review-warning",
      verdict: "passed",
      issues: [{ severity: "warning", title: "兑现承接偏弱", evidence: "上一章留下的承诺没有在本章形成可观察余波。" }],
    };
    expect(reviewIssuesForLearning([warningReview])).toHaveLength(1);

    let called = 0;
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => {
        called += 1;
        return { value: { conclusion: "no-shared-learning" } as T, usage, provenance: mockProvenance };
      },
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    const { assessment } = await assessRuntimeLearningWithModel({ projectId: "p1", workflowId: "wf-1", artifact, reviews: [warningReview], model, now: 7 });
    expect(called).toBe(1);
    expect(assessment.conclusion).toBe("no-shared-learning");
  });

  it("falls back to no-shared-learning when model output fails validation", async () => {
    const model: ModelGateway = {
      getRoutingSnapshot: () => mockRoutingSnapshot,
      generateStructured: async <T,>() => ({ value: { conclusion: "propose-improvement", symptom: "视角越界" } as T, usage, provenance: mockProvenance }),
      generateText: async () => ({ value: "", text: "", usage, provenance: mockProvenance }),
      embed: async () => ({ value: [], vectors: [], usage, provenance: mockProvenance }),
      rerank: async () => ({ value: [], scores: [], usage, provenance: mockProvenance }),
    };
    const { assessment, validationError } = await assessRuntimeLearningWithModel({ projectId: "p1", workflowId: "wf-1", artifact, reviews: [blockingReview], model, now: 6 });
    expect(assessment.conclusion).toBe("no-shared-learning");
    expect(validationError).toContain("underlyingMechanism");
  });

  it("does not build a candidate for no-shared-learning and preserves propose evidence", () => {
    const noShared = {
      ...base(),
      id: "learning-no-shared",
      projectId: "p1",
      conclusion: "no-shared-learning" as const,
    };
    expect(buildCraftRuleCandidateInput(noShared)).toBeUndefined();

    const propose = {
      ...base(),
      id: "learning-propose",
      projectId: "p1",
      conclusion: "propose-improvement" as const,
      symptom: "限知视角泄漏作者信息",
      failingLayer: "drafting skill",
      underlyingMechanism: "写作执行点没有把 POV 的可知边界转化为逐段决策",
      affectedInputClass: "限知 POV 且存在角色未知事实的章节",
      boundaries: "不适用于全知叙事或已授权的戏剧反讽",
      regressionRisks: ["可能压制合法悬念铺垫"],
      candidate: {
        targetKind: "skill" as const,
        targetId: "narrative-continuity",
        rationale: "在 drafting 前置检查角色可知范围",
        afterText: "通用规则：写作前列出 POV 角色已知信息，正文中的事实必须能回溯到亲历、听闻、合理推断或可观察痕迹；无法回溯的作者信息改写为现象、误判或留白。".repeat(2),
      },
    };
    expect(buildCraftRuleCandidateInput(propose)).toMatchObject({
      targetId: "narrative-continuity",
      afterText: propose.candidate.afterText,
      scope: {
        underlyingMechanism: propose.underlyingMechanism,
        affectedInputClass: propose.affectedInputClass,
        boundaries: [propose.boundaries],
        regressionRisks: propose.regressionRisks,
      },
      learningSource: { assessmentId: propose.id, mechanism: propose.underlyingMechanism },
    });
  });
});

const serialSnapshot: SerialContextSnapshot = {
  window: 6,
  chapters: [
    { documentId: "doc-1", narrativeOrder: 1, title: "第一章", narrativeFunction: "development" },
    { documentId: "doc-2", narrativeOrder: 2, title: "第二章", narrativeFunction: "discovery" },
    { documentId: "doc-3", narrativeOrder: 3, title: "第三章", narrativeFunction: "discovery" },
  ],
  characterSpans: [
    { characterId: "陈渊", states: [{ narrativeOrder: 1, stateSnapshot: "虚弱。" }, { narrativeOrder: 2, stateSnapshot: "肋骨断茬钝痛。" }] },
  ],
  functionRuns: [
    { narrativeFunction: "discovery", narrativeOrders: [2, 3] },
  ],
  subjectSpans: [
    { subject: "金属残片", narrativeOrders: [1, 3], latestExcerpt: "陈渊握着金属残片。" },
  ],
  fingerprint: "serial-fp",
};

function learningActivities(repository: Partial<NovelPostgresRepository>, generateStructured: ModelGateway["generateStructured"]) {
  return createNovelWorkflowActivities({
    repository: repository as unknown as NovelPostgresRepository,
    memoryProvider: { search: async () => [] },
    skillProvider: {
      list: async () => [{
        skillId: "learning-audit",
        version: "1",
        capabilities: ["learning"],
        applicableTasks: [],
        requiredMemoryKinds: [],
        conflicts: [],
        qualityGates: [],
        promptSections: { "learning.assessment": "保持规则文本泛化，不绑定具体书名人物。" },
        enabled: true,
        executionPoints: ["learning.assessment" as const],
        roles: ["learning-auditor"],
      }],
    },
    modelGateway: { generateStructured } as unknown as ModelGateway,
    objectStore: { getText: async () => undefined } as unknown as ContentObjectStore,
    commitService: {} as CommitService,
    enableChapterMemory: false,
  });
}

describe("assessLearning activity serial-context wiring", () => {
  it("passes the caller documentId to getSerialContextSnapshot instead of artifact.taskId", async () => {
    const getSerialContextSnapshot = vi.fn(async () => serialSnapshot);
    const getRecentReviewIssueClusters = vi.fn(async () => []);
    const recordLearningAssessment = vi.fn(async (assessment: RuntimeLearningAssessmentV2) => assessment);
    const generateStructured = vi.fn<ModelGateway["generateStructured"]>(async <T,>() => ({ value: { conclusion: "no-shared-learning", candidate: { targetKind: "none" } } as T, usage, provenance: mockProvenance }));
    const activities = learningActivities({ getSerialContextSnapshot, getRecentReviewIssueClusters, recordLearningAssessment }, generateStructured as unknown as ModelGateway["generateStructured"]);

    const result = await activities.assessLearning({ projectId: "p1", workflowId: "wf-1", assessmentKey: "1", artifact, reviews: [blockingReview], routingSnapshot: mockRoutingSnapshot, narrativeOrder: 4, documentId: "doc-4" });

    expect(result.kind).toBe("completed");
    expect(getSerialContextSnapshot).toHaveBeenCalledOnce();
    expect(getSerialContextSnapshot).toHaveBeenCalledWith("p1", "doc-4", 3);
    expect(getSerialContextSnapshot).not.toHaveBeenCalledWith("p1", artifact.taskId, expect.anything());
    expect(getRecentReviewIssueClusters).toHaveBeenCalledWith("p1", 3);
    expect(recordLearningAssessment).toHaveBeenCalledOnce();
  });

  it("skips the serial-context query when documentId is missing (no misleading taskId lookup)", async () => {
    const getSerialContextSnapshot = vi.fn(async () => serialSnapshot);
    const getRecentReviewIssueClusters = vi.fn(async () => []);
    const recordLearningAssessment = vi.fn(async (assessment: RuntimeLearningAssessmentV2) => assessment);
    const generateStructured = vi.fn<ModelGateway["generateStructured"]>(async <T,>() => ({ value: { conclusion: "no-shared-learning", candidate: { targetKind: "none" } } as T, usage, provenance: mockProvenance }));
    const activities = learningActivities({ getSerialContextSnapshot, getRecentReviewIssueClusters, recordLearningAssessment }, generateStructured as unknown as ModelGateway["generateStructured"]);

    const result = await activities.assessLearning({ projectId: "p1", workflowId: "wf-1", assessmentKey: "1", artifact, reviews: [blockingReview], routingSnapshot: mockRoutingSnapshot, narrativeOrder: 4 });

    expect(result.kind).toBe("completed");
    expect(getSerialContextSnapshot).not.toHaveBeenCalled();
    expect(getRecentReviewIssueClusters).toHaveBeenCalledWith("p1", 3);
  });

  it("skips both pre-chapter queries when narrativeOrder is missing", async () => {
    const getSerialContextSnapshot = vi.fn(async () => serialSnapshot);
    const getRecentReviewIssueClusters = vi.fn(async () => []);
    const recordLearningAssessment = vi.fn(async (assessment: RuntimeLearningAssessmentV2) => assessment);
    const generateStructured = vi.fn<ModelGateway["generateStructured"]>(async <T,>() => ({ value: { conclusion: "no-shared-learning", candidate: { targetKind: "none" } } as T, usage, provenance: mockProvenance }));
    const activities = learningActivities({ getSerialContextSnapshot, getRecentReviewIssueClusters, recordLearningAssessment }, generateStructured as unknown as ModelGateway["generateStructured"]);

    const result = await activities.assessLearning({ projectId: "p1", workflowId: "wf-1", assessmentKey: "1", artifact, reviews: [blockingReview], routingSnapshot: mockRoutingSnapshot });

    expect(result.kind).toBe("completed");
    expect(getSerialContextSnapshot).not.toHaveBeenCalled();
    expect(getRecentReviewIssueClusters).not.toHaveBeenCalled();
  });

  it("injects the loaded serial context into the learning prompt", async () => {
    const getSerialContextSnapshot = vi.fn(async () => serialSnapshot);
    const getRecentReviewIssueClusters = vi.fn(async () => []);
    const recordLearningAssessment = vi.fn(async (assessment: RuntimeLearningAssessmentV2) => assessment);
    const generateStructured = vi.fn<ModelGateway["generateStructured"]>(async <T,>() => ({ value: { conclusion: "no-shared-learning", candidate: { targetKind: "none" } } as T, usage, provenance: mockProvenance }));
    const activities = learningActivities({ getSerialContextSnapshot, getRecentReviewIssueClusters, recordLearningAssessment }, generateStructured as unknown as ModelGateway["generateStructured"]);

    await activities.assessLearning({ projectId: "p1", workflowId: "wf-1", assessmentKey: "1", artifact, reviews: [blockingReview], routingSnapshot: mockRoutingSnapshot, narrativeOrder: 4, documentId: "doc-4" });

    const call = generateStructured.mock.calls[0]![0];
    expect(call.prompt).toContain("角色状态跨度");
    expect(call.prompt).toContain("陈渊");
    expect(call.prompt).toContain("连续同类功能");
  });
});
