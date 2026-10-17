import { describe, expect, it } from "vitest";
import { buildStoryArcReviewPrompt } from "../prompts/story-arc";
import { renderStoryArcDialogueDrift } from "../prompts/story-arc";
import { countDialogueCharacters, countNovelCharacters, inspectDialogueDrift, intersectSoloSilentOrders } from "../word-count";

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
    const report = inspectDialogueDrift([chapter(1, 100, 10), chapter(2, 100, 30), chapter(3, 100, 0), chapter(4, 100, 0)]);
    expect(report).toEqual({
      windowSize: 4,
      avgRatio: 0.1,
      silentOrders: [3, 4],
      minRatio: 0,
      hintBelowRatio: 0.01,
      // 4 章 ⇒ 切分 2/2：首半窗 [ch1, ch2] 均值 0.2，近半窗 [ch3, ch4] 均值 0。
      decayRatio: 0,
      decayed: true,
    });
  });

  /**
   * 相对衰减读数（2026-10-17）——绝对均值看不见的病灶。
   *
   * 现成证据（state-audit §7 第 5 项存量实测）：该书首段对白占比 6.78%、061-080 段
   * 0.67%，崩落约 10×。绝对均值把两者都读成"低"，而"相对自己早段退了多少"才区分
   * "退场"与"本就安静的题材形态"。故判据取近半窗 / 首半窗，不用任何外部基准。
   */
  it("reads decay against the book's own early window, not against an external baseline", () => {
    // 首半窗 20%，近半窗 4% ⇒ 比值 0.2，衰减过半 ⇒ decayed。
    const decayed = inspectDialogueDrift([
      chapter(1, 100, 20), chapter(2, 100, 20), chapter(3, 100, 20), chapter(4, 100, 20),
      chapter(5, 100, 4), chapter(6, 100, 4), chapter(7, 100, 4), chapter(8, 100, 4),
    ]);
    expect(decayed?.decayRatio).toBeCloseTo(0.2, 6);
    expect(decayed?.decayed).toBe(true);

    // 反向：同样低的对白，但首半窗本就低 ⇒ 无衰减（安静型作品不应命中）。
    const quiet = inspectDialogueDrift([
      chapter(1, 100, 4), chapter(2, 100, 4), chapter(3, 100, 4), chapter(4, 100, 4),
      chapter(5, 100, 4), chapter(6, 100, 4), chapter(7, 100, 4), chapter(8, 100, 4),
    ]);
    expect(quiet?.decayRatio).toBeCloseTo(1, 6);
    expect(quiet?.decayed).toBe(false);

    // 反向：对白在增长（0.1 → 0.3）同样不是衰减——判据不对称于"变高"。
    const growing = inspectDialogueDrift([
      chapter(1, 100, 10), chapter(2, 100, 10), chapter(3, 100, 10), chapter(4, 100, 10),
      chapter(5, 100, 30), chapter(6, 100, 30), chapter(7, 100, 30), chapter(8, 100, 30),
    ]);
    expect(growing?.decayRatio).toBeCloseTo(3, 6);
    expect(growing?.decayed).toBe(false);
  });

  it("omits the decay ratio when either half has no dialogue at all (0/0 is meaningless)", () => {
    // 两半窗全体零对白：这类作品从头到尾没有对白，属题材形态而非"衰减"，
    // 0/0 没有判据意义。渲染侧据此不渲染该读数（见下方渲染用例）。
    const noDialogue = inspectDialogueDrift([
      chapter(1, 100, 0), chapter(2, 100, 0), chapter(3, 100, 0), chapter(4, 100, 0),
      chapter(5, 100, 0), chapter(6, 100, 0),
    ]);
    expect(noDialogue?.avgRatio).toBe(0);
    expect(noDialogue?.silentOrders).toEqual([1, 2, 3, 4, 5, 6]);
    expect(noDialogue?.decayRatio).toBeUndefined();
    expect(noDialogue?.decayed).toBe(false);

    // 后半窗全体零但前半窗有对白 ⇒ 正是"彻底退场"，读数 0 且判衰减。
    const dropped = inspectDialogueDrift([
      chapter(1, 100, 20), chapter(2, 100, 20), chapter(3, 100, 0), chapter(4, 100, 0),
    ]);
    expect(dropped?.decayRatio).toBe(0);
    expect(dropped?.decayed).toBe(true);
  });

  /**
   * 上游独处 × 下游零对白的交集判据（2026-10-17）。
   *
   * 这是把"蓝图参与者数"与"正文对白"接成回读的那一处：此前两个信号各报各的，
   * 审阅者要自己在心里求交。交集非空时上游计划与下游产出相互印证——
   * "安静型作品本就如此"的辩解需要一个额外假设才成立，故值得被看见。
   */
  it("intersects solo-only blueprints with zero-dialogue manuscripts", () => {
    expect(intersectSoloSilentOrders({ soloOnlyChapterIndexes: [2, 5, 7] }, { silentOrders: [5, 7, 9] })).toEqual([5, 7]);
    // 乱序输入按章序升序返回（章序是读者阅读顺序，不是集合顺序）。
    expect(intersectSoloSilentOrders({ soloOnlyChapterIndexes: [9, 2] }, { silentOrders: [2, 9] })).toEqual([2, 9]);
    // 无交集 ⇒ 空（不是 undefined：空是"已判定、无重合"的确定答案）。
    expect(intersectSoloSilentOrders({ soloOnlyChapterIndexes: [1, 2] }, { silentOrders: [3, 4] })).toEqual([]);
  });

  it("returns an empty intersection when either signal is missing (never asserts presence or absence from half the data)", () => {
    expect(intersectSoloSilentOrders(undefined, { silentOrders: [1, 2] })).toEqual([]);
    expect(intersectSoloSilentOrders({ soloOnlyChapterIndexes: [1, 2] }, undefined)).toEqual([]);
    expect(intersectSoloSilentOrders({ soloOnlyChapterIndexes: [] }, { silentOrders: [1, 2] })).toEqual([]);
    expect(intersectSoloSilentOrders(undefined, undefined)).toEqual([]);
  });

  it("carries the hint threshold out of the policy constant, never as a literal", () => {
    const report = inspectDialogueDrift([chapter(1, 100, 10), chapter(2, 100, 10), chapter(3, 100, 10)]);
    expect(report?.hintBelowRatio).toBe(0.01);
    // 渲染层与审核层都从报告里取这条线，任何一侧重写字面量都会与这里脱钩
    expect(renderStoryArcDialogueDrift({ windowSize: 3, avgRatio: report!.hintBelowRatio - 0.001, silentOrders: [], minRatio: 0, hintBelowRatio: report!.hintBelowRatio, decayed: false }))
      .toContain("对白密度提示");
    expect(renderStoryArcDialogueDrift({ windowSize: 3, avgRatio: report!.hintBelowRatio + 0.001, silentOrders: [], minRatio: 0, hintBelowRatio: report!.hintBelowRatio, decayed: false }))
      .not.toContain("对白密度提示");
  });
});

describe("renderStoryArcDialogueDrift", () => {
  /** 构造夹具：hintBelowRatio 默认随 policy 常量，避免每个用例重写。 */
  const drift = (over: Partial<{ windowSize: number; avgRatio: number; silentOrders: number[]; minRatio: number; decayRatio?: number; decayed: boolean }>) => ({
    windowSize: 6, avgRatio: 0.052, silentOrders: [] as number[], minRatio: 0.011, hintBelowRatio: 0.01, decayed: false, ...over,
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

  it("renders the relative decay reading, and omits it when the ratio is undefined", () => {
    const decaying = renderStoryArcDialogueDrift(drift({ decayRatio: 0.2, decayed: true }));
    // 必须说清这是"跟自己早段比"，否则读者会读成外部基准线。
    expect(decaying).toContain("相对首半窗");
    expect(decaying).toContain("为原先的 20%");
    expect(decaying).toContain("已衰减过半");
    expect(decaying).toContain("不是外部基准");

    const stable = renderStoryArcDialogueDrift(drift({ decayRatio: 1, decayed: false }));
    expect(stable).toContain("为原先的 100%");
    expect(stable).not.toContain("已衰减过半");

    // 0/0（两半窗全体零对白）不渲染该读数——没有"原先"可比。
    const allSilent = renderStoryArcDialogueDrift(drift({ avgRatio: 0, minRatio: 0, silentOrders: [1, 2, 3, 4, 5, 6], decayed: false }));
    expect(allSilent).not.toContain("相对首半窗");
  });

  it("hints from decay alone, so a book whose absolute average never looked thin still gets seen", () => {
    // 绝对均值 6.8% 远高于提示线、且每章都有对白（silentOrders 空）——
    // 按旧判据这条窗口完全静默；只有相对衰减能看出"正在退场"。
    const text = renderStoryArcDialogueDrift(drift({ avgRatio: 0.068, minRatio: 0.004, silentOrders: [], decayRatio: 0.1, decayed: true }));
    expect(text).toContain("对白密度提示");
  });

  it("renders the solo×silent intersection so the reviewer does not have to join two lists by hand", () => {
    const text = renderStoryArcDialogueDrift(drift({}), [5, 7]);
    expect(text).toContain("独处蓝图与零对白正文的交集章");
    expect(text).toContain("第5、7章");
    // 交集是结构事实，不是"这些章有问题"的判决（安静章合法）。
    expect(text).toContain("不等于");
    expect(text).toContain("安静章合法");

    // 无交集时不渲染该段（空清单会变成一句没有信息量的噪声）。
    expect(renderStoryArcDialogueDrift(drift({}))).not.toContain("交集章");
    expect(renderStoryArcDialogueDrift(drift({}), [])).not.toContain("交集章");
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
