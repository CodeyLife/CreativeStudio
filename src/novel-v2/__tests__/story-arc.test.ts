import { describe, expect, it } from "vitest";
import { assertStoryArcBatchWindow, inspectStoryArcEnsemble, normalizeStoryArcRebaseBundle, parseStoryArcBundle, projectChapterForExecution, storyArcBatchWindow, validateStoryArcExecutionContracts, validateStoryArcPlanContracts, validateStoryArcRebaseBundle, type ChapterBlueprint, type StoryArcBundle, type StoryArcRebaseTarget } from "../application/story-arc";

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

  it("PL-6 绑定校验面：要么不绑（旧弧）、要么互斥越界检查全过且全量覆盖（N5）", () => {
    const arcBase = { ...bundle.arc, expectedChapterCount: 4, threadResponsibilities: [], phases: [{ title: "起", objective: "o", chapterOrdinals: [1, 2] }, { title: "收", objective: "o", chapterOrdinals: [3, 4] }] };
    expect(() => validateStoryArcPlanContracts(arcBase as never)).not.toThrow();
    // 无绑定=旧弧形态：留给 health warning 通道，校验不拦。
    expect(() => validateStoryArcPlanContracts({ ...arcBase, phases: [{ title: "旧", objective: "o" }] } as never)).not.toThrow();
    // 重叠：跨阶段共享序号 → 拒（first-hit 静默偏向即"半真源"）。
    expect(() => validateStoryArcPlanContracts({ ...arcBase, phases: [{ title: "起", objective: "o", chapterOrdinals: [1, 2] }, { title: "收", objective: "o", chapterOrdinals: [2, 3] }] } as never)).toThrow(/重叠/);
    // 越界：超出 expectedChapterCount。
    expect(() => validateStoryArcPlanContracts({ ...arcBase, phases: [{ title: "全", objective: "o", chapterOrdinals: [1, 2, 3, 5] }] } as never)).toThrow(/越界/);
    // 部分绑定：绑了又不绑全 → 拒。
    expect(() => validateStoryArcPlanContracts({ ...arcBase, phases: [{ title: "起", objective: "o", chapterOrdinals: [1] }, { title: "收", objective: "o" }] } as never)).toThrow(/全量覆盖/);
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

describe("批次窗口系统分配契约（arc5 单章坍缩根因修复）", () => {
  it("storyArcBatchWindow：弧内剩余按上限截断；无声明窗口返回 0", () => {
    expect(storyArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 0 })).toBe(7);   // 新弧全量
    expect(storyArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 3 })).toBe(4);   // 后续批次=剩余
    expect(storyArcBatchWindow({ expectedChapterCount: 20, plannedBeforeInArc: 2 })).toBe(16); // 上限截断（滚动批次合法面）
    expect(storyArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 7 })).toBe(0);   // 无剩余
    expect(storyArcBatchWindow({ expectedChapterCount: undefined, plannedBeforeInArc: 0 })).toBe(0); // 旧弧零回归
  });

  it("assertStoryArcBatchWindow 双向：窗口恰好=放行；缩窗/扩窗=拒绝；无声明=不约束", () => {
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 0, chaptersCount: 7 })).not.toThrow();
    // 坍缩面（arc5 实证形态：7 章弧只出 1 章）必须被拒绝——旧系统此形态静默通过。
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 0, chaptersCount: 1 })).toThrow(/窗口由系统定为 7 章/);
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 0, chaptersCount: 8 })).toThrow(/窗口章数不得由生成侧缩减或扩张/);
    // 剩余>上限：按截断后的 16 章判定（17 拒、16 放）。
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: 20, plannedBeforeInArc: 0, chaptersCount: 16 })).not.toThrow();
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: 20, plannedBeforeInArc: 0, chaptersCount: 20 })).toThrow(/窗口上限 16/);
    // 旧弧无声明：任何章数都不受本契约约束（零回归）。
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: undefined, plannedBeforeInArc: 0, chaptersCount: 1 })).not.toThrow();
    expect(() => assertStoryArcBatchWindow({ expectedChapterCount: 7, plannedBeforeInArc: 7, chaptersCount: 99 })).not.toThrow(); // window=0 ⇒ 交由 prepareNext 门槛拦截
  });
});

describe("inspectStoryArcEnsemble（群像结构信号，2026-09-16 对白崩落根因的机制端）", () => {
  const soloChapter = (index: number) => ({ index, scenes: [{ participants: ["主角"] }, { participants: ["主角", ""] }] });
  const ensembleChapter = (index: number) => ({ index, scenes: [{ participants: ["主角"] }, { participants: ["主角", "姑母"] }] });

  it("两人同场=群像章；参与者按去重计（重复名/空名不充数）", () => {
    const report = inspectStoryArcEnsemble([
      { index: 1, scenes: [{ participants: ["主角", "主角", " "] }] },
      ensembleChapter(2),
      soloChapter(3),
    ]);
    expect(report.ensembleChapterIndexes).toEqual([2]);
    expect(report.soloOnlyChapterIndexes).toEqual([1, 3]);
  });

  it("配额双向：7 章批 ≥3 章同场放行、全独处批拒绝并给出最长独处游程", () => {
    const quota7 = Math.ceil(7 / 3);
    const passing = [ensembleChapter(1), ensembleChapter(2), ensembleChapter(3), soloChapter(4), soloChapter(5), soloChapter(6), soloChapter(7)];
    const ok = inspectStoryArcEnsemble(passing);
    expect(ok.ensembleQuota).toBe(quota7);
    expect(ok.quotaMet).toBe(true);
    expect(ok.longestSoloRun).toBe(4);
    const failing = inspectStoryArcEnsemble(Array.from({ length: 7 }, (_, i) => soloChapter(i + 1)));
    expect(failing.quotaMet).toBe(false);
    expect(failing.soloOnlyChapterIndexes).toHaveLength(7);
    expect(failing.longestSoloRun).toBe(7);
  });

  it("边界：小批（<3 章）不设配额恒满足；空场景章不判为独处", () => {
    expect(inspectStoryArcEnsemble([soloChapter(1), soloChapter(2)]).quotaMet).toBe(true);
    const noScenes = inspectStoryArcEnsemble([
      { index: 1, scenes: [] },
      ensembleChapter(2),
      ensembleChapter(3),
    ]);
    expect(noScenes.soloOnlyChapterIndexes).toEqual([]);
    expect(noScenes.quotaMet).toBe(true);
  });

  it("本函数只统计可数事实：opposition 内容不参与任何判定（第二意志是语义判断，2026-09-17 负结果）", () => {
    // 两章参与者结构与场景数完全相同，仅 opposition 文本不同（一章指向活人、
    // 一章指向格法）——本函数必须给出**完全相同**的报告。若未来有人重新引入
    // opposition 正则判据，这条测试会失败并指向 application/story-arc.ts 的负结果记录。
    const withPerson = { index: 1, scenes: [{ participants: ["主角", "老吏"], opposition: "老吏要赶在散堂前把这一页收回去" }] };
    const withRule = { index: 2, scenes: [{ participants: ["主角", "老吏"], opposition: "旧例不许翻检未归案的册页" }] };
    const a = inspectStoryArcEnsemble([withPerson, withRule]);
    const b = inspectStoryArcEnsemble([
      { index: 1, scenes: [{ participants: ["主角", "老吏"] }] },
      { index: 2, scenes: [{ participants: ["主角", "老吏"] }] },
    ]);
    expect(a).toEqual(b);
    expect(a.ensembleChapterIndexes).toEqual([1, 2]);
    expect(a.quotaMet).toBe(true);
  });
});
