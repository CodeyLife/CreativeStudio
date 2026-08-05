import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { FOUNDATION_TASK_CONTRACTS, foundationRequiredFields, foundationSchemaForTask } from "../application/foundation-contract";
import { parseStoryArcBundle } from "../application/story-arc";
import { buildChapterReviewPromptPackage, getReviewFocus } from "../prompts/chapter-review";
import { buildFoundationPrompt } from "../prompts/foundation";
import { reviewerSchema } from "../prompts/schemas";
import type { Artifact, ExecutionBlueprint, MemoryBundle } from "../protocol";

describe("workflow contract hardening", () => {
  it("derives plot-design prompt and schema requirements from the complete Foundation contract", () => {
    expect(FOUNDATION_TASK_CONTRACTS["plot-design"].requiredPaths).toEqual([
      "plotStrategy.narrativePromises",
      "plotStrategy.characterDestinations",
      "plotStrategy.longHorizonThreads",
      "plotStrategy.informationBoundaries",
      "plotStrategy.endingEnvelope",
      "plotStrategy.nonNegotiables",
    ]);
    expect(foundationRequiredFields("plot-design")).toEqual([
      "narrativePromises",
      "characterDestinations",
      "longHorizonThreads",
      "informationBoundaries",
      "endingEnvelope",
      "nonNegotiables",
    ]);

    const prompt = buildFoundationPrompt({ taskKey: "plot-design", instruction: "规划长期结构", projectTitle: "测试", priorArtifacts: [] });
    for (const field of foundationRequiredFields("plot-design")) expect(prompt).toContain(field);

    const validate = new Ajv({ allErrors: true, strict: false }).compile(foundationSchemaForTask("plot-design"));
    const envelope = {
      title: "长期规划",
      summary: "这是一段足够长的规划摘要，用于说明长期承诺、人物方向、信息边界、终局条件和后续适应性修订原则。",
      sections: [],
      structuredData: { plotStrategy: { narrativePromises: ["回应核心问题"], characterDestinations: [{}], endingEnvelope: {}, nonNegotiables: ["保留代价"] } },
    };
    expect(validate(envelope)).toBe(false);
  });

  it("normalizes omitted active chapter arrays without making literary options mandatory", () => {
    const parsed = parseStoryArcBundle({
      arc: { title: "阶段", objective: "抵达下一状态" },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{
        index: 1,
        title: "静夜",
        stateTransition: { before: "回避", after: "愿意倾听", evidence: "留下来听完" },
        scenes: [{ title: "屋檐下", participants: ["甲"], situation: "雨夜等待", observableActions: ["没有离开"], outcome: "听见事实" }],
      }],
    });
    expect(parsed.chapters[0].continuityConstraints).toEqual([]);
    expect(parsed.chapters[0].unresolvedAtClose).toEqual([]);
    expect(parsed.chapters[0].povCharacterId).toBeUndefined();
    expect(parsed.chapters[0].narrativeFunction).toBeUndefined();
  });

  it("keeps reviewer focus in the system role instead of repeating it in user instructions", () => {
    const prompt = buildChapterReviewPromptPackage({
      role: "structure-reviewer",
      artifact: { id: "artifact", projectId: "project" } as Artifact,
      text: "正文",
      blueprint: { tasks: [], budget: { maxInputTokens: 10000, maxOutputTokens: 1000 } } as unknown as ExecutionBlueprint,
      memory: { claims: [], conflicts: [], missingFacets: [] } as unknown as MemoryBundle,
      workflowId: "workflow-1",
      system: "系统",
    }).instruction;
    const focus = getReviewFocus("structure-reviewer");
    expect(focus).toContain("D1 世界观与 D2 故事性");
    expect(prompt).not.toContain("D1 世界观与 D2 故事性");
    expect(prompt).toContain("structure-reviewer");
  });

  it("makes reviewer enum and paragraph-range semantics explicit", () => {
    const prompt = buildChapterReviewPromptPackage({
      role: "prose-reviewer",
      artifact: { id: "artifact", projectId: "project" } as Artifact,
      text: "正文第一段。\n\n正文第二段。",
      blueprint: { tasks: [], budget: { maxInputTokens: 10000, maxOutputTokens: 1000 } } as unknown as ExecutionBlueprint,
      memory: { claims: [], conflicts: [], missingFacets: [] } as unknown as MemoryBundle,
      workflowId: "workflow-1",
      system: "系统",
    }).instruction;
    expect(prompt).toContain("verdict 必须是字符串 passed、revise 或 blocked");
    expect(prompt).toContain("severity 只能是 warning、major 或 blocker");
    expect(prompt).toContain("start/end 是从 1 开始计数的正文段落编号");

    const validate = new Ajv({ allErrors: true, strict: false }).compile(reviewerSchema);
    expect(validate({ verdict: "revise", score: 4, issues: [] })).toBe(true);
    expect(validate({ verdict: 4, passed: true, score: 4, issues: [] })).toBe(false);
  });
});
