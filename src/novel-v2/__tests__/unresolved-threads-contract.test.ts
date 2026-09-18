/**
 * SK-11 承接口径统一（product-audit-20260910 C6，双向测试）。
 *
 * 症状：reviewer 对"明确承接"从严 vs 写作侧不禁止把未解项当必填，安静章易误伤——
 * 同一份"章末未解"清单在写作/审核/修订三侧没有统一读法。修复：唯一权威口径常量
 * 挂在三面共用的蓝图解释器 renderChapterExecutionContract 的"章末未解"块，三面逐字同源。
 *
 * 双向断言：
 * - 正向：口径声明随清单出现（有未解项时）。
 * - 安静章反例：未解清单为空时口径仍必须在场——误伤正发生在"清单为空/仅安静处理"的章，
 *   若声明被挪进列表条件分支，本测试即失败（防止未来重构漂移回双载体）。
 * - 三面同源：draft 与 review 的 prompt 包都通过共用解释器携带同一常量文本。
 */
import { describe, expect, it } from "vitest";
import type { Artifact, ExecutionBlueprint, MemoryBundle } from "../protocol";
import { renderChapterExecutionContract, UNRESOLVED_THREADS_READING_CONTRACT } from "../prompts/chapter-planning-context";
import { buildChapterDraftPromptPackage } from "../prompts/chapter-draft";
import { buildChapterReviewPromptPackage } from "../prompts/chapter-review";
import type { ChapterPlanningContext } from "../application/story-arc";

function makeContext(unresolved: string[]): ChapterPlanningContext {
  return {
    fingerprint: "fp-skill-contract",
    arc: { title: "弧一", objective: "抵达下一状态", centralConflict: "冲突", development: ["一步"], exitState: "出口" },
    chapter: {
      globalOrder: 3,
      title: "静夜",
      narrativeFunction: "余波",
      targetWordCount: 3000,
      stateTransition: { before: "回避", after: "愿意倾听", evidence: "留下来听完" },
      scenes: [{ title: "屋檐下", participants: [], situation: "雨夜等待", observableActions: ["没有离开"], outcome: "听见事实" }],
      continuityConstraints: [],
      unresolvedAtClose: unresolved,
    },
    neighbors: [],
  } as unknown as ChapterPlanningContext;
}

describe("SK-11 未解清单口径统一", () => {
  it("正向：有未解项时，口径声明与清单同时出现在执行合同中", () => {
    const rendered = renderChapterExecutionContract(makeContext(["旧账未清"]));
    expect(rendered).toContain("旧账未清");
    expect(rendered).toContain(UNRESOLVED_THREADS_READING_CONTRACT);
  });

  it("安静章反例：未解清单为空时口径声明仍必须在场（误伤高发面，禁止挪进列表分支）", () => {
    const rendered = renderChapterExecutionContract(makeContext([]));
    expect(rendered).toContain("不是逐章必须推进的承接清单");
    expect(rendered).toContain(UNRESOLVED_THREADS_READING_CONTRACT);
  });

  it("三面同源：draft 与 review 的执行合同 section 携带同一口径文本", () => {
    const context = makeContext(["悬置的问题"]);
    const memory = { claims: [], conflicts: [], missingFacets: [] } as unknown as MemoryBundle;
    // 三面合同文本本身已近千字符，budget 需容得下 draft 侧全部 required section，
    // 否则 compileStageContext 会把执行合同裁出 instruction（假阴性）。
    const blueprint = { id: "bp-1", tasks: [], budget: { maxInputTokens: 40000, maxOutputTokens: 4000 } } as unknown as ExecutionBlueprint;
    const artifact = { id: "artifact", projectId: "project" } as Artifact;
    const draft = buildChapterDraftPromptPackage({
      intent: { id: "intent-1", projectId: "project", source: "chapter-review", objective: "完成章节", createdAt: 1, idempotencyKey: "intent-1" } as never,
      blueprint,
      memory,
      skills: { id: "skills-1", skills: [], resolution: { bundleId: "skills-1", fingerprint: "skills", executionPoint: "chapter.drafting", skills: [] } } as never,
      planningContext: context,
      workflowId: "wf-1",
      system: "系统",
    } as never);
    const review = buildChapterReviewPromptPackage({
      workflowId: "wf-1", system: "系统", role: "structure-reviewer", artifact, text: "正文", blueprint, memory, planningContext: context,
    });
    const draftText = JSON.stringify(draft);
    const reviewText = JSON.stringify(review);
    expect(draftText, "draft 侧缺口径").toContain(UNRESOLVED_THREADS_READING_CONTRACT);
    expect(reviewText, "review 侧缺口径").toContain(UNRESOLVED_THREADS_READING_CONTRACT);
  });
});
