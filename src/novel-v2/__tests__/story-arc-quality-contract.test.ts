import { describe, expect, it } from "vitest";
import { parseStoryArcBundle, projectChapterForExecution, validateChapterExecutionContract, type StoryArcBundle } from "../application/story-arc";

const baseBundle: StoryArcBundle = {
  arc: {
    title: "第一弧",
    objective: "建立归乡者与旧案的初始关系",
    entryState: "归乡者抵达旧宅",
    centralConflict: "旧案线索与家族沉默相互抵触",
    development: ["抵达", "试探", "发现"],
    resolution: "确认旧案仍在影响当下",
    exitState: "归乡者决定继续查证",
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
    stateTransition: { before: "两人互相防备", after: "外部关系仍稳定，但彼此理解出现松动", evidence: "一次没有结果的夜谈改变了称呼和距离" },
    scenes: [{ title: "厨房", participants: ["protagonist", "aunt"], situation: "雨夜停电，两人被迫同处厨房", observableActions: ["姑母换掉了原本锋利的称呼", "主角把问题收回没有追问"], outcome: "谈话没有给出新线索，却改变了两人的相处距离" }],
    continuityConstraints: ["旧案真相不得提前揭示"],
    unresolvedAtClose: ["旧案钥匙的主人仍未知"],
  }],
};

describe("story arc execution contract", () => {
  it("keeps chapter blueprints to causal state and observable scene material", () => {
    const chapter = parseStoryArcBundle(baseBundle).chapters[0];
    expect(projectChapterForExecution(chapter)).toMatchObject({
      narrativeFunction: "relationship",
      stateTransition: baseBundle.chapters[0].stateTransition,
      continuityConstraints: ["旧案真相不得提前揭示"],
    });
    expect(chapter).not.toHaveProperty("readerExperience");
    expect(chapter).not.toHaveProperty("thematicTreatment");
    expect(chapter).not.toHaveProperty("narrativeScale");
  });

  it("allows quiet relationship chapters without opposition, decision or cost", () => {
    expect(() => validateChapterExecutionContract(baseBundle.chapters[0])).not.toThrow();
    const scene = projectChapterForExecution(baseBundle.chapters[0]).scenes[0];
    expect(scene.opposition).toBeUndefined();
    expect(scene.decision).toBeUndefined();
    expect(scene.cost).toBeUndefined();
  });
});
