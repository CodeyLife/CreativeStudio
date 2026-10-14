import { describe, expect, it } from "vitest";
import { buildStoryArcReviewPrompt } from "../prompts/story-arc";
import { renderStoryArcDialogueDrift } from "../prompts/story-arc";
import { countDialogueCharacters, countNovelCharacters, inspectDialogueDrift } from "../word-count";

describe("countDialogueCharacters", () => {
  it("counts novel characters inside full-width quote pairs only", () => {
    expect(countDialogueCharacters("他抬头看了一眼。")).toBe(0);
    expect(countDialogueCharacters("他说：「走吧。」")).toBe(2);
    expect(countDialogueCharacters("「你好，世界！」")).toBe(4);
  });

  it("recognises every supported quote pair", () => {
    expect(countDialogueCharacters("“回家吧！”")).toBe(3);
    expect(countDialogueCharacters("『记账。』")).toBe(2);
    expect(countDialogueCharacters('"go home"')).toBe(6);
  });

  it("ignores unclosed quotes and counts the outer pair only", () => {
    expect(countDialogueCharacters("他说「未闭合")).toBe(0);
    expect(countDialogueCharacters("「外层『内层』还在」")).toBe(6);
  });

  it("stays on the same character scale as countNovelCharacters", () => {
    const text = "他站着。「我记下了。」";
    expect(countDialogueCharacters(text)).toBeLessThanOrEqual(countNovelCharacters(text));
  });
});

describe("inspectDialogueDrift", () => {
  const chapter = (order: number, characters: number, dialogueCharacters: number) => ({ order, characters, dialogueCharacters });

  it("requires at least three measured chapters", () => {
    expect(inspectDialogueDrift([chapter(1, 100, 10), chapter(2, 100, 5)])).toBeUndefined();
    expect(inspectDialogueDrift([chapter(1, 100, 10), chapter(2, 100, 5), chapter(3, 100, 30)])).toBeDefined();
  });

  it("excludes unmeasured chapters instead of treating them as zero dialogue", () => {
    const report = inspectDialogueDrift([chapter(1, 100, 10), chapter(2, 0, 0), chapter(3, 100, 10), chapter(4, 100, 10)]);
    expect(report?.windowSize).toBe(3);
    expect(report?.avgRatio).toBeCloseTo(0.1, 5);
    expect(report?.silentOrders).toEqual([]);
  });

  it("reports the window average, the lowest ratio and every zero-dialogue chapter", () => {
    const report = inspectDialogueDrift([chapter(3, 100, 30), chapter(1, 100, 10), chapter(2, 100, 0)]);
    expect(report).toEqual({ windowSize: 3, avgRatio: 0.13333333333333333, silentOrders: [2], minRatio: 0, hintBelowRatio: 0.01 });
  });

  it("carries the hint threshold out of the policy constant, never as a literal", () => {
    const report = inspectDialogueDrift([chapter(1, 100, 10), chapter(2, 100, 10), chapter(3, 100, 10)]);
    expect(report?.hintBelowRatio).toBe(0.01);
    // 渲染层与审核层都从报告里取这条线，任何一侧重写字面量都会与这里脱钩
    expect(renderStoryArcDialogueDrift({ windowSize: 3, avgRatio: report!.hintBelowRatio - 0.001, silentOrders: [], minRatio: 0, hintBelowRatio: report!.hintBelowRatio }))
      .toContain("对白密度提示");
    expect(renderStoryArcDialogueDrift({ windowSize: 3, avgRatio: report!.hintBelowRatio + 0.001, silentOrders: [], minRatio: 0, hintBelowRatio: report!.hintBelowRatio }))
      .not.toContain("对白密度提示");
  });
});

describe("renderStoryArcDialogueDrift", () => {
  /** 构造夹具：hintBelowRatio 默认随 policy 常量，避免每个用例重写。 */
  const drift = (over: Partial<{ windowSize: number; avgRatio: number; silentOrders: number[]; minRatio: number }>) => ({
    windowSize: 6, avgRatio: 0.052, silentOrders: [] as number[], minRatio: 0.011, hintBelowRatio: 0.01, ...over,
  });

  it("stays silent below the window minimum", () => {
    expect(renderStoryArcDialogueDrift(undefined)).toBe("");
    expect(renderStoryArcDialogueDrift(drift({ windowSize: 2 }))).toBe("");
  });

  it("states the window statistic without pushing guidance for a healthy window", () => {
    const text = renderStoryArcDialogueDrift(drift({}));
    expect(text).toContain("近 6 章正文对白密度");
    expect(text).toContain("每章都有对白");
    expect(text).not.toContain("对白密度提示");
  });

  it("pushes the batch-level hint once dialogue thins out, while denying it is a fill-dialogue order", () => {
    const text = renderStoryArcDialogueDrift(drift({ avgRatio: 0.004, silentOrders: [3, 5], minRatio: 0 }));
    expect(text).toContain("对白密度提示");
    expect(text).toContain("第3、5章");
    expect(text).toContain("不是补对白指令");
  });

  it("hints from the zero-dialogue count alone even when the average clears the line", () => {
    // 结构面（零对白章数 ≥2）与提示线是"或"关系：整章零对白的形态先按结构量触发，
    // 不依赖任何阈值判断。这是提示线之外的另一半，去掉它本用例即红。
    const text = renderStoryArcDialogueDrift(drift({ avgRatio: 0.3, silentOrders: [2, 4] }));
    expect(text).toContain("对白密度提示");
  });
});

describe("story-arc review face", () => {
  it("carries the dialogue-density check and keeps it non-blocking for single chapters", () => {
    const prompt = buildStoryArcReviewPrompt({ chapters: [] } as never, "上下文");
    expect(prompt).toContain("对白密度检查（通用，语义判断）");
    expect(prompt).toContain("单章低对白不单独判问题");
    expect(prompt).toContain("不得为凑密度要求添加台词或情绪宣言");
  });
});
