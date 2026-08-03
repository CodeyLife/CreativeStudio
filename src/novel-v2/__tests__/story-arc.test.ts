import { describe, expect, it } from "vitest";
import { parseStoryArcBundle, projectChapterForExecution, validateStoryArcExecutionContracts, type StoryArcBundle } from "../application/story-arc";

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
});
