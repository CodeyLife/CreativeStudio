/**
 * 故事弧外部编排模式（模式 B）测试。
 *
 * 覆盖：
 * - parseStoryArcPlotOutline：结构校验（objective 必填、责任/阶段条目畸形、
 *   章节数越界、chapterHints 上限）与字符串裁剪；
 * - validateStoryArcPlotOutline：空编排（只有 objective）拒绝、threadRef 重复拒绝；
 * - prompt 注入：编排作为 required section 进入 planning sections，plan/chapters
 *   prompt 携带"编排是设计意图基线、事实优先"的权威声明，不把编排字段变成逐字清单；
 * - 跨场景验证：完整编排与最小编排（objective + plotNotes）都成立。
 */
import { describe, expect, it } from "vitest";
import { parseStoryArcPlotOutline, validateStoryArcPlotOutline, type StoryArcPlotOutline } from "../application/story-arc";
import { buildStoryArcChaptersPrompt, buildStoryArcPlanPrompt, buildStoryArcPlanningContextSections, buildStoryArcPrompt, renderStoryArcPlotOutline } from "../prompts/story-arc";

const fullOutline: StoryArcPlotOutline = {
  objective: "主角必须混进暗渠上方的体系，才能找到失踪者",
  title: "暗渠之上",
  entryState: "主角被逐出底层工会，带着一条线索",
  centralConflict: "体系允诺秩序，却要求他交出所有秘密",
  development: ["查明暗渠上方的守门人是谁", "用假身份通过第一道审查", "发现审查结果会暴露他失踪者的位置"],
  resolution: "他换到位置，但审查者认出他",
  exitState: "主角进入体系内部，身份暴露风险悬置",
  threadResponsibilities: [{ threadRef: "thread-1", responsibility: "本弧推进暗渠体系探查", nextAdvance: "身份暴露后必须转移" }],
  expectedChapterCount: 12,
  phases: [{ title: "潜入", objective: "通过第一道审查" }],
  chapterHints: ["开篇是底层工会的驱逐现场"],
  plotNotes: "伏笔：失踪者的最后一封信在守门人手里",
};

describe("parseStoryArcPlotOutline", () => {
  it("parses a full outline and trims string fields", () => {
    const parsed = parseStoryArcPlotOutline(fullOutline);
    expect(parsed.objective).toBe("主角必须混进暗渠上方的体系，才能找到失踪者");
    expect(parsed.development).toHaveLength(3);
    expect(parsed.threadResponsibilities?.[0]).toEqual({ threadRef: "thread-1", responsibility: "本弧推进暗渠体系探查", nextAdvance: "身份暴露后必须转移" });
    expect(parsed.expectedChapterCount).toBe(12);
  });

  it("parses a minimal outline with only objective + plotNotes", () => {
    const parsed = parseStoryArcPlotOutline({ objective: "本弧解决信任问题", plotNotes: "关系在误解与和解间推进" });
    expect(parsed.objective).toBe("本弧解决信任问题");
    expect(parsed.plotNotes).toBe("关系在误解与和解间推进");
    expect(parsed.development).toBeUndefined();
  });

  it("rejects a non-object outline", () => {
    expect(() => parseStoryArcPlotOutline("剧情")).toThrow("必须是对象");
    expect(() => parseStoryArcPlotOutline(null)).toThrow("必须是对象");
  });

  it("rejects an outline without objective", () => {
    expect(() => parseStoryArcPlotOutline({ plotNotes: "只有说明" })).toThrow("objective");
  });

  it("rejects a malformed threadResponsibility entry instead of silently dropping it", () => {
    expect(() => parseStoryArcPlotOutline({
      objective: "目标",
      threadResponsibilities: [{ threadRef: "t-1", responsibility: "", nextAdvance: "x" }],
    })).toThrow("threadRef/responsibility/nextAdvance");
  });

  it("rejects out-of-range expectedChapterCount", () => {
    expect(() => parseStoryArcPlotOutline({ objective: "目标", expectedChapterCount: 0 })).toThrow("1..80");
    expect(() => parseStoryArcPlotOutline({ objective: "目标", expectedChapterCount: 81 })).toThrow("1..80");
  });

  it("rejects chapterHints beyond the single-batch window", () => {
    expect(() => parseStoryArcPlotOutline({ objective: "目标", chapterHints: Array.from({ length: 17 }, (_, index) => `hint-${index}`) })).toThrow("16");
  });

  it("rejects a malformed phase entry", () => {
    expect(() => parseStoryArcPlotOutline({ objective: "目标", phases: [{ title: "只有标题" }] })).toThrow("title/objective");
  });
});

describe("validateStoryArcPlotOutline", () => {
  it("accepts a full outline", () => {
    expect(() => validateStoryArcPlotOutline(fullOutline)).not.toThrow();
  });

  it("rejects an empty outline (objective only) — caller should use the normal mode", () => {
    expect(() => validateStoryArcPlotOutline({ objective: "写一个故事" })).toThrow("novel_story_arc_start");
  });

  it("rejects duplicate threadRef in the outline", () => {
    expect(() => validateStoryArcPlotOutline({
      ...fullOutline,
      threadResponsibilities: [
        { threadRef: "t-1", responsibility: "a", nextAdvance: "x" },
        { threadRef: "t-1", responsibility: "b", nextAdvance: "y" },
      ],
    })).toThrow("不能重复");
  });
});

describe("story arc orchestration prompt injection", () => {
  const baseInput = {
    projectTitle: "测试项目",
    macro: [{ taskKey: "architecture", title: "架构", summary: "体系压力" }],
    recentChapters: [],
    openThreads: [],
  };

  it("renders the outline as a required planning section with provenance", () => {
    const sections = buildStoryArcPlanningContextSections({ ...baseInput, plotOutline: fullOutline });
    const outlineSection = sections.find((section) => section.id === "arc-context-plot-outline");
    expect(outlineSection).toBeDefined();
    expect(outlineSection?.priority).toBe("required");
    expect(outlineSection?.provenanceRefs).toContain("orchestrated-plot-outline");
    expect(outlineSection?.text).toContain("objective：主角必须混进暗渠上方的体系");
    expect(outlineSection?.text).toContain("编排责任线：thread-1");
    expect(outlineSection?.text).toContain("逐章提示");
    expect(outlineSection?.text).toContain("编排说明");
  });

  it("omits the outline section when no orchestration is provided", () => {
    const sections = buildStoryArcPlanningContextSections(baseInput);
    expect(sections.find((section) => section.id === "arc-context-plot-outline")).toBeUndefined();
  });

  it("injects the outline authority rule into plan and chapters prompts", () => {
    const planPrompt = buildStoryArcPlanPrompt({ ...baseInput, plotOutline: fullOutline });
    expect(planPrompt).toContain("外部剧情编排（如有）是设计意图基线");
    expect(planPrompt).toContain("编排与已定稿事实冲突时以已定稿事实为准");
    expect(planPrompt).not.toContain("逐字兑现");

    const chaptersPrompt = buildStoryArcChaptersPrompt({
      ...baseInput,
      plotOutline: fullOutline,
      arc: { title: "暗渠之上", objective: fullOutline.objective, entryState: "", centralConflict: "", development: [], resolution: "", exitState: "", threadResponsibilities: [], foreshadowingRefs: [], expectedChapterCount: 0, phases: [] },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
    });
    expect(chaptersPrompt).toContain("外部剧情编排");
    expect(chaptersPrompt).toContain("暗渠之上");
  });

  it("keeps the authority statement generic across outline shapes", () => {
    const minimal = parseStoryArcPlotOutline({ objective: "本弧解决信任问题", plotNotes: "关系在误解与和解间推进" });
    const prompt = buildStoryArcPrompt({ ...baseInput, plotOutline: minimal });
    expect(prompt).toContain("不得为了贴合编排而虚构事实、提前消费后续答案或改写人物知识边界");
  });

  it("renderStoryArcPlotOutline covers every optional field once", () => {
    const text = renderStoryArcPlotOutline(fullOutline);
    for (const marker of ["objective", "标题建议", "入口状态", "核心冲突", "发展阶梯", "解决", "退出状态", "编排责任线", "期望章节数", "阶段", "逐章提示", "编排说明"]) {
      expect(text).toContain(marker);
    }
  });
});
