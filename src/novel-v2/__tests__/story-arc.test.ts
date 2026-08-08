import { describe, expect, it } from "vitest";
import { normalizeStoryArcRebaseBundle, parseStoryArcBundle, projectChapterForExecution, validateStoryArcExecutionContracts, validateStoryArcPlanContracts, validateStoryArcRebaseBundle, type ChapterBlueprint, type StoryArcBundle, type StoryArcRebaseTarget } from "../application/story-arc";

const bundle: StoryArcBundle = {
  arc: {
    title: "第一弧",
    objective: "建立归乡者与旧案的初始关系",
    entryState: "归乡者抵达旧宅",
    centralConflict: "旧案线索与家族沉默冲突",
    development: ["抵达", "试探"],
    resolution: "确认旧案仍在影响当下",
    exitState: "决定继续查证",
    threadResponsibilities: [],
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

  it("preserves the optional targetWordCount suggestion for the drafting stage", () => {
    const withTarget = { ...bundle, chapters: [{ ...bundle.chapters[0], targetWordCount: 3500 }] };
    expect(parseStoryArcBundle(withTarget).chapters[0].targetWordCount).toBe(3500);
    // 缺省时不注入，正文产出阶段回退默认建议值
    expect(parseStoryArcBundle(bundle).chapters[0].targetWordCount).toBeUndefined();
    // 非法值（非正数）不保留
    const invalid = { ...bundle, chapters: [{ ...bundle.chapters[0], targetWordCount: 0 }] };
    expect(parseStoryArcBundle(invalid).chapters[0].targetWordCount).toBeUndefined();
  });

  it("validates quiet chapters through state boundaries and observable actions", () => {
    expect(() => validateStoryArcExecutionContracts(bundle)).not.toThrow();
    const projection = projectChapterForExecution(bundle.chapters[0]);
    expect(projection.scenes[0]).toMatchObject({ situation: "雨夜停电，两人同处厨房", outcome: "没有获得新线索，但相处距离变化" });
    expect(projection.scenes[0].opposition).toBeUndefined();
  });

  it("validates arc responsibilities as the sole source of referenced plot threads", () => {
    const arc = { ...bundle.arc, threadResponsibilities: [{ threadRef: "thread-a", responsibility: "保持线索压力并观察新的证据", nextAdvance: "出现与旧证据矛盾的可验证信息" }] };
    expect(() => validateStoryArcPlanContracts(arc)).not.toThrow();
    expect(() => validateStoryArcPlanContracts({ ...arc, threadResponsibilities: [{ ...arc.threadResponsibilities[0], threadRef: "" }] })).toThrow("threadRef");
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
        chapterMemory: { summary: "history", keyEvents: [], characterStates: [], unresolvedThreads: ["ledger boundary"] },
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
        chapterMemory: { summary: "history", keyEvents: [], characterStates: [], unresolvedThreads: ["ledger boundary"] },
        authoritativeFacts: [],
      }],
    };
    const rebased = normalizeStoryArcRebaseBundle(bundle, target);
    expect(rebased.chapters[0].index).toBe(1);
    expect(() => validateStoryArcRebaseBundle(rebased, target)).not.toThrow();
  });

  it("lets a rebase candidate update a planned chapter while preserving its unresolved boundary", () => {
    const plannedOld: ChapterBlueprint = {
      index: 1,
      title: "旧标题",
      narrativeFunction: "development",
      povCharacterId: "protagonist",
      stateTransition: {
        before: "旧前状态",
        after: "旧后状态",
        evidence: "旧证据（含职业黑话）",
      },
      scenes: [{ title: "旧场景", participants: ["protagonist"], situation: "旧处境", observableActions: ["记录旧规则"], outcome: "旧结果", planningRationale: "", opposition: "", decision: "", cost: "" }],
      continuityConstraints: [],
      unresolvedAtClose: ["某异常现象是否具有特定含义"],
    };
    const candidateNew: ChapterBlueprint = {
      index: 1,
      title: "新标题",
      narrativeFunction: "development",
      povCharacterId: "protagonist",
      stateTransition: {
        before: "新前状态",
        after: "新后状态",
        evidence: "新证据（题材通用表述）",
      },
      scenes: [{ title: "新场景", participants: ["protagonist"], situation: "新处境", observableActions: ["暗中观察新规矩"], outcome: "新结果", planningRationale: "", opposition: "", decision: "", cost: "" }],
      continuityConstraints: [],
      unresolvedAtClose: ["其他未解边界"],
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
        title: "旧标题",
        revisionId: undefined,
        plannedBlueprint: plannedOld,
        authoritativeFacts: [],
      }],
    };
    const rebased = normalizeStoryArcRebaseBundle({ ...bundle, chapters: [candidateNew] }, target);
    // 修订后的标题/证据以候选蓝图为准，不被旧 plannedBlueprint 覆盖
    expect(rebased.chapters[0].title).toBe("新标题");
    expect(rebased.chapters[0].stateTransition.evidence).toBe("新证据（题材通用表述）");
    // 已批准的未解边界保留
    expect(rebased.chapters[0].unresolvedAtClose).toEqual(["某异常现象是否具有特定含义"]);
    expect(() => validateStoryArcRebaseBundle(rebased, target)).not.toThrow();
  });
});
