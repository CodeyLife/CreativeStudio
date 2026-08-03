import { describe, expect, it } from "vitest";
import {
  PROJECT_PLAN_STAGES,
  approvedProjectBookTitle,
  isProjectPlanTaskKey,
  isRetiredFoundationTaskKey,
  resolveProjectTitle,
  transitivePlanDependents,
} from "../application/project-plan";
import { buildFoundationPrompt } from "../prompts/foundation";

describe("project plan dependency contract", () => {
  it("keeps the active foundation vocabulary at five stages", () => {
    expect(PROJECT_PLAN_STAGES.map((stage) => stage.taskKey)).toEqual([
      "project-positioning",
      "architecture",
      "characters",
      "worldview",
      "plot-design",
    ]);
    expect(isProjectPlanTaskKey("chapter-plan")).toBe(true);
    expect(isRetiredFoundationTaskKey("chapter-plan")).toBe(true);
    for (const legacy of ["relations", "plot-threads", "foreshadowing", "timeline", "story-control"]) {
      expect(isProjectPlanTaskKey(legacy)).toBe(false);
      expect(isRetiredFoundationTaskKey(legacy)).toBe(true);
    }
    expect(isRetiredFoundationTaskKey("plot-design")).toBe(false);
  });

  it("invalidates only active downstream planning stages", () => {
    expect(new Set(transitivePlanDependents("characters"))).toEqual(new Set(["plot-design"]));
    expect(new Set(transitivePlanDependents("worldview"))).toEqual(new Set(["plot-design"]));
    expect(transitivePlanDependents("plot-design")).toEqual([]);
  });

  it("keeps plot-design as a long-horizon strategy rather than a chapter outline", () => {
    const stage = PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === "plot-design");
    expect(stage).toMatchObject({ label: "长程叙事战略" });
    expect(stage?.instruction).toContain("不生成固定章节表");
    const prompt = buildFoundationPrompt({
      taskKey: "plot-design",
      instruction: stage!.instruction,
      projectTitle: "长夜归舟",
      premise: "归乡者追查一桩旧案",
      priorArtifacts: [],
    });
    expect(prompt).toContain("plotStrategy");
    expect(prompt).toContain("不生成固定章节表");
    expect(prompt).not.toContain("第一章的功能");
  });

  it("only adopts an explicit Chinese title from approved positioning data", () => {
    expect(approvedProjectBookTitle({ structuredData: { positioning: { bookTitle: "《长夜归舟》" } } })).toBe("长夜归舟");
    expect(approvedProjectBookTitle({ structuredData: { positioning: { bookTitle: "technical-project-id" } } })).toBeUndefined();
    expect(approvedProjectBookTitle({ summary: "正文里偶然提到《别人的作品》" } as never)).toBeUndefined();
    expect(resolveProjectTitle("project-1", "project-1", { structuredData: { positioning: { bookTitle: "《正式书名》" } } })).toBe("正式书名");
  });
});
