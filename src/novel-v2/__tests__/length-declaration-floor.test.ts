/**
 * 蓝图声明目标的项目级下限（2026-10-13，docs/novel-v2/state-audit-20261013.md §7 第 4 项）。
 *
 * 背景（本项目 168 章实测）：`targetWordCount` 的**声明侧**从未设下限，于是"声明一个较低
 * 目标"反而把提交门的欠量下限一并下移——门按 `MIN_LENGTH_RATIO`(0.6) × 声明执法，
 * 未声明章回落 `DEFAULT_TARGET_WORD_COUNT`(3500) ⇒ 门限 2100，而声明 2400 ⇒ 门限 1440。
 * 实测正是该形态：1-119 章全部未声明（产出均长 2806-3125），120-159 章开始逐章声明
 * 且声明值 2400/2600，该段产出均长 2293、最短 1290。
 *
 * 修法（作者裁决 A）：在**架构/指引层**设项目级声明下限 + 让弧审核面把"系统性低声明"
 * 变成可执行审核意见；不重写正文，只对新章生效。
 *
 * 双向断言：
 * - 正向：已声明章过半低于下限 ⇒ 弧审核面按 major 报告，并指认具体章号。
 * - 反例：未过半（单章功能静章）⇒ 只记信号，明确不据此判 revise——下限不得退化成硬门。
 * - 推导：下限由项目已有两常量算出，不是经验魔数；改任一常量，下限随之变。
 */
import { describe, expect, it } from "vitest";
import { buildStoryArcChaptersPrompt, buildStoryArcReviewPrompt } from "../prompts/story-arc";
import {
  DEFAULT_TARGET_WORD_COUNT,
  LENGTH_DECLARATION_POLICY,
  LENGTH_DRIFT_POLICY,
  MIN_LENGTH_RATIO,
  inspectLengthDeclarations,
} from "../word-count";

/** 与 prompts.test.ts 同形的弧审核夹具；`targetWordCount` 缺省即"未声明"。 */
function chapter(index: number, targetWordCount?: number) {
  return {
    index,
    title: `第${index}章`,
    narrativeFunction: "development",
    povCharacterId: "char-1",
    ...(targetWordCount === undefined ? {} : { targetWordCount }),
    stateTransition: { before: "前", after: "后", evidence: "证据" },
    scenes: [{ situation: "处境", observableActions: ["动作"], outcome: "结果", participants: [] }],
    continuityConstraints: [],
    unresolvedAtClose: [],
  };
}

function reviewPrompt(chapters: ReturnType<typeof chapter>[]): string {
  return buildStoryArcReviewPrompt({
    arc: { title: "当前弧" },
    batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
    chapters,
  } as never, "");
}

describe("声明侧篇幅下限（项目级）", () => {
  it("推导：下限 = ceil(稀疏线 / 门兑现率)，不是经验魔数", () => {
    expect(LENGTH_DECLARATION_POLICY.floor)
      .toBe(Math.ceil(LENGTH_DRIFT_POLICY.sparseFloor / MIN_LENGTH_RATIO));
    // 推导的语义判据：门限（下限 × 兑现率）不得跌破项目自己的稀疏线。
    expect(LENGTH_DECLARATION_POLICY.floor * MIN_LENGTH_RATIO)
      .toBeGreaterThanOrEqual(LENGTH_DRIFT_POLICY.sparseFloor);
    // 反向：低于下限的声明会击穿稀疏线——这正是被修的形态，不得被放宽回来。
    expect((LENGTH_DECLARATION_POLICY.floor - 1) * MIN_LENGTH_RATIO)
      .toBeLessThan(LENGTH_DRIFT_POLICY.sparseFloor);
  });

  it("统计：未声明章不计入占比（回落系统默认值本身即项目标准）", () => {
    const report = inspectLengthDeclarations([
      chapter(1), // 未声明
      chapter(2), // 未声明
      chapter(3, LENGTH_DECLARATION_POLICY.floor - 100), // 低于下限
      chapter(4, DEFAULT_TARGET_WORD_COUNT), // 达标
    ]);
    expect(report.total).toBe(4);
    expect(report.undeclared).toEqual([1, 2]);
    expect(report.underDeclared).toEqual([3]);
    expect(report.anchored).toEqual([4]);
    // 均值只统计已声明者，不把回落值算进去（否则会稀释信号）。
    expect(report.averageDeclared).toBe(Math.round(((LENGTH_DECLARATION_POLICY.floor - 100) + DEFAULT_TARGET_WORD_COUNT) / 2));
  });

  it("占比边界：恰好半数即判系统性（inclusive），低于半数不判", () => {
    const floor = LENGTH_DECLARATION_POLICY.floor;
    const half = inspectLengthDeclarations([chapter(1, floor - 1), chapter(2, floor)]);
    expect(half.systematic).toBe(true);
    const third = inspectLengthDeclarations([chapter(1, floor - 1), chapter(2, floor), chapter(3, floor)]);
    expect(third.systematic).toBe(false);
  });

  it("正向：过半低声明时弧审核面按 major 报告并指认章号", () => {
    const prompt = reviewPrompt([
      chapter(11, 2400), chapter(12, 2600), chapter(13, 2400), chapter(14, DEFAULT_TARGET_WORD_COUNT),
    ]);
    expect(prompt).toContain("声明侧篇幅信号");
    expect(prompt).toContain(`低于项目下限 ${LENGTH_DECLARATION_POLICY.floor} 字`);
    expect(prompt).toContain("第11、12、13章");
    expect(prompt).toContain("本批已构成系统性低声明（3/4 章低于下限）");
    expect(prompt).toContain("按 major 报告");
  });

  it("反例：未过半（个别功能静章）只记信号，明确不据此判 revise", () => {
    const prompt = reviewPrompt([
      chapter(11, 2400), chapter(12, DEFAULT_TARGET_WORD_COUNT), chapter(13, 3200),
    ]);
    expect(prompt).toContain("声明侧篇幅信号");
    expect(prompt).toContain("第11章");
    expect(prompt).toContain("本批未构成系统性低声明");
    expect(prompt).toContain("不据此判 revise");
    expect(prompt).not.toContain("按 major 报告，逐条指出哪些章应提高声明");
  });

  it("生成面：蓝图契约播报下限数值，规划模型可据此合规", () => {
    const prompt = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      arc: { title: "当前弧" } as never,
      batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
    });
    expect(prompt).toContain("项目级下限");
    expect(prompt).toContain(`不得低于 ${LENGTH_DECLARATION_POLICY.floor} 字`);
    expect(prompt).toContain(`${Math.round(MIN_LENGTH_RATIO * 100)}%`);
  });
});
