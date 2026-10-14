/**
 * 篇幅契约单源（2026-09-17 断链修复的**写作侧半段**，2026-10-13 补测）。
 *
 * 背景（docs/novel-v2/ai-taint-diagnosis-20260917.md F1/§四-3，本项目 168 章实测）：
 * 蓝图声明的 `targetWordCount` 一度在 `chapterBlueprintFromRow` 这一步被静默丢弃，
 * 于是同一目标在系统里存在三个数——编排者手写的 2600、写作契约播报的回落 3500、
 * 提交门执法的 2600×0.6=1560。写作侧因此永远看不到本章真实目标，全书 168 章
 * （226 行 planning context 实测 0 行携带该字段）都在"被播报 3500、被门按 1560 验收"
 * 的错位下产出，章长衰减带（120-159 章均长 2293 vs 1-39 章 3125）由此而来。
 *
 * 09-17 修复了上游映射（`chapterBlueprintFromRow` 读 payload），但下游"写作契约必须
 * 播报**蓝图声明的那个数**"此前只由 schema 测试与 arc 侧测试间接覆盖——若 `chapter-draft`
 * 哪天改读别的字段或重新内联回落值，没有任何测试会红，全书会静默退回错位状态。
 *
 * 双向断言：
 * - 正向：planningContext 声明 2600 时，正文契约播报 2600，且**不得**出现回落值 3500。
 * - 反例：无 planningContext（无蓝图章）时，契约回落 3500——回落本身是设计，不能被误删。
 * - 单源：两处播报（写作契约与蓝图上下文）对同一输入给出同一个数。
 */
import { describe, expect, it } from "vitest";
import type { ExecutionBlueprint, MemoryBundle } from "../protocol";
import { buildChapterDraftPromptPackage } from "../prompts/chapter-draft";
import { renderChapterExecutionContract } from "../prompts/chapter-planning-context";
import { DEFAULT_TARGET_WORD_COUNT } from "../word-count";
import type { ChapterPlanningContext } from "../application/story-arc";

function contextWithTarget(targetWordCount: number | undefined): ChapterPlanningContext {
  return {
    fingerprint: "fp-length-contract",
    arc: { title: "弧一", objective: "抵达下一状态", centralConflict: "冲突", development: ["一步"], exitState: "出口" },
    chapter: {
      globalOrder: 12,
      title: "安静的一章",
      narrativeFunction: "余波",
      ...(targetWordCount === undefined ? {} : { targetWordCount }),
      stateTransition: { before: "回避", after: "愿意倾听", evidence: "留下来听完" },
      scenes: [{ title: "屋檐下", participants: [], situation: "雨夜等待", observableActions: ["没有离开"], outcome: "听见事实" }],
      continuityConstraints: [],
      unresolvedAtClose: [],
    },
    neighbors: [],
  } as unknown as ChapterPlanningContext;
}

function draftInstruction(planningContext?: ChapterPlanningContext): string {
  const memory = { claims: [], conflicts: [], missingFacets: [] } as unknown as MemoryBundle;
  const blueprint = { id: "bp-length", tasks: [], budget: { maxInputTokens: 40000, maxOutputTokens: 4000 } } as unknown as ExecutionBlueprint;
  return buildChapterDraftPromptPackage({
    intent: { id: "intent-length", projectId: "project", source: "chapter-review", objective: "完成章节", createdAt: 1, idempotencyKey: "intent-length" } as never,
    blueprint,
    memory,
    skills: { id: "skills-length", skills: [], resolution: { bundleId: "skills-length", fingerprint: "skills", executionPoint: "chapter.drafting", skills: [] } } as never,
    ...(planningContext ? { planningContext } : {}),
    workflowId: "wf-length",
    system: "系统",
  } as never).instruction;
}

describe("篇幅契约单源（写作侧半段）", () => {
  it("正向：蓝图声明 2600 时正文契约播报 2600，而非回落值 3500", () => {
    const instruction = draftInstruction(contextWithTarget(2600));
    expect(instruction).toContain("约 2600 字");
    // 错位复现的判据：声明值在场时回落值不得同时出现在播报里（"同一目标两个数"）。
    expect(instruction).not.toContain(`约 ${DEFAULT_TARGET_WORD_COUNT} 字`);
  });

  it("反例：无蓝图（无 planningContext）时契约回落系统默认值——回落是设计，不得被误删", () => {
    const instruction = draftInstruction(undefined);
    expect(instruction).toContain(`约 ${DEFAULT_TARGET_WORD_COUNT} 字`);
  });

  it("单源：写作契约与蓝图上下文对同一声明给出同一个数", () => {
    const context = contextWithTarget(3200);
    const contract = renderChapterExecutionContract(context);
    const instruction = draftInstruction(context);
    expect(contract).toContain("约 3200 字");
    expect(instruction).toContain("约 3200 字");
  });
});
