import { describe, expect, it } from "vitest";
import { assessRuntimeLearningWithModel, buildRuntimeLearningPrompt, parseRuntimeLearningAssessmentV2, reviewIssuesForLearning } from "../learning-assessment";
import { buildCraftRuleCandidateInput } from "../temporal/activities";
import type { Artifact, Review } from "../protocol";
import type { ModelGateway, ModelUsage } from "../model-gateway";
import type { ModelExecutionProvenance, ModelRoutingSnapshot } from "../model-routing";

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
