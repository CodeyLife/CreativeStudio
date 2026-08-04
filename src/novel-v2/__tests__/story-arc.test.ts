import { describe, expect, it } from "vitest";
import { normalizeStoryArcRebaseBundle, parseStoryArcBundle, projectChapterForExecution, validateStoryArcExecutionContracts, validateStoryArcPlanContracts, validateStoryArcRebaseBundle, type StoryArcBundle, type StoryArcRebaseTarget } from "../application/story-arc";
import { normalizeStoryArcReviewAuthority, validateStoryArcReview } from "../application/story-arc-review-policy";

const bundle: StoryArcBundle = {
  arc: {
    title: "第一弧",
    objective: "建立归乡者与旧案的初始关系",
    entryState: "归乡者抵达旧宅",
    centralConflict: "旧案线索与家族沉默冲突",
    development: ["抵达", "试探"],
    resolution: "确认旧案仍在影响当下",
    exitState: "决定继续查证",
    plotThreadRefs: [],
    foreshadowingRefs: [],
    expectedChapterCount: 1,
    phases: [],
  },
  batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
  chapters: [{
    index: 1,
    title: "旧宅夜谈",
    narrativeFunction: "relationship",
    povCharacterId: "protagonist",
    stateTransition: { before: "两人互相防备", after: "关系仍稳定但称呼距离松动", evidence: "夜谈让称呼和动作发生细微变化" },
    scenes: [{ title: "厨房", participants: ["protagonist", "aunt"], situation: "雨夜停电，两人同处厨房", observableActions: ["姑母换掉称呼"], outcome: "没有获得新线索，但相处距离变化" }],
    continuityConstraints: ["旧案真相不得提前揭示"],
    unresolvedAtClose: ["钥匙主人未知"],
  }],
};

describe("story arc blueprint subtraction contract", () => {
  it("parses only execution fields and removes old editorial fields", () => {
    const parsed = parseStoryArcBundle(bundle);
    expect(parsed.chapters[0]).not.toHaveProperty("summary");
    expect(parsed.chapters[0]).not.toHaveProperty("readerExperience");
    expect(parsed.chapters[0]).not.toHaveProperty("narrativeScale");
  });

  it("validates quiet chapters through state boundaries and observable actions", () => {
    expect(() => validateStoryArcExecutionContracts(bundle)).not.toThrow();
    const projection = projectChapterForExecution(bundle.chapters[0]);
    expect(projection.scenes[0]).toMatchObject({ situation: "雨夜停电，两人同处厨房", outcome: "没有获得新线索，但相处距离变化" });
    expect(projection.scenes[0].opposition).toBeUndefined();
  });

  it("requires every referenced plot thread to carry an arc-level responsibility", () => {
    const arc = { ...bundle.arc, plotThreadRefs: ["thread-a"], threadResponsibilities: [{ threadRef: "thread-a", responsibility: "保持线索压力并观察新的证据", nextAdvance: "出现与旧证据矛盾的可验证信息" }] };
    expect(() => validateStoryArcPlanContracts(arc)).not.toThrow();
    expect(() => validateStoryArcPlanContracts({ ...arc, threadResponsibilities: [] })).toThrow("缺少剧情线阶段责任");
  });

  it("preserves legacy frozen scene shape during rebase without weakening new candidates", () => {
    const legacyFrozen = {
      ...bundle.chapters[0],
      scenes: [{ title: "历史场景", participants: ["protagonist"], situation: "", observableActions: [], outcome: "" }],
    };
    const target: StoryArcRebaseTarget = {
      arcId: "arc-1",
      executionStatus: "active",
      approvedArc: bundle.arc,
      batchIndex: 1,
      startChapterIndex: 1,
      chapters: [{
        chapterId: "chapter-1",
        documentId: "document-1",
        globalOrder: 1,
        title: "历史场景",
        revisionId: "revision-1",
        committedBlueprint: legacyFrozen,
        approvedPlan: { sceneEvents: [], continuityConstraints: [], setupRefs: [], payoffRefs: [] },
        authoritativeFacts: [],
      }],
    };
    validateStoryArcExecutionContracts(bundle);
    const rebased = normalizeStoryArcRebaseBundle(bundle, target);
    expect(rebased.chapters[0].scenes[0]).toMatchObject({ situation: "", observableActions: [], outcome: "" });
    expect(() => validateStoryArcRebaseBundle(rebased, target)).not.toThrow();
  });

  it("recognizes committed history by lifecycle identity even when the memory ledger adds boundaries", () => {
    const target: StoryArcRebaseTarget = {
      arcId: "arc-1",
      executionStatus: "active",
      approvedArc: bundle.arc,
      batchIndex: 1,
      startChapterIndex: 1,
      chapters: [{
        chapterId: "chapter-1",
        documentId: "document-1",
        globalOrder: 1,
        title: "旧宅夜谈",
        revisionId: "revision-1",
        committedBlueprint: bundle.chapters[0],
        approvedPlan: { sceneEvents: [], continuityConstraints: [], setupRefs: [], payoffRefs: [] },
        committedMemory: { summary: "history", keyEvents: [], characterStates: [], unresolvedThreads: ["ledger boundary"] },
        authoritativeFacts: [],
      }],
    };
    const review = {
      verdict: "passed" as const,
      summary: "history",
      issues: [],
      chapterChecks: ["state-continuity", "causal-fit", "function-fit", "authority-boundary"].map((dimension) => ({ chapterIndex: 1, dimension: dimension as "state-continuity" | "causal-fit" | "function-fit" | "authority-boundary", verdict: "passed" as const, evidence: "history", reason: "history" })),
      arcChecks: ["arc-boundary", "window-rhythm", "longform-hierarchy"].map((dimension) => ({ dimension: dimension as "arc-boundary" | "window-rhythm" | "longform-hierarchy", verdict: "passed" as const, evidence: "history", reason: "history" })),
      authorityChecks: [{ chapterIndex: 1, verdict: "passed" as const, unresolvedAtClose: [], checkedPaths: ["summary-only"], candidateClaims: ["summary-only"], frozenEvidence: ["history"], certaintyUpgrades: [], reason: "history" }],
    };
    const normalized = normalizeStoryArcReviewAuthority(bundle, review, target);
    expect(normalized.authorityChecks[0].checkedPaths).toEqual(["stateTransition.before", "stateTransition.after", "stateTransition.evidence", "scenes[0].situation", "scenes[0].observableActions", "scenes[0].outcome"]);
    expect(normalized.authorityChecks[0].unresolvedAtClose).toEqual(bundle.chapters[0].unresolvedAtClose);
    expect(() => validateStoryArcReview(bundle, normalized)).not.toThrow();
  });
});
