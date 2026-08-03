import { describe, expect, it } from "vitest";
import { buildFoundationContextMarkdown } from "../prompts/chapter-draft";
import { buildChapterDraftPrompt } from "../prompts/chapter-draft";
import { dedupeNarrativeRhythmMemory } from "../prompts/chapter-planning-context";
import { buildFoundationPrompt } from "../prompts/foundation";
import { buildFoundationReviewPrompt } from "../prompts/foundation-review";
import { getReviewFocus } from "../prompts/chapter-review";
import { buildStoryArcPrompt, buildStoryArcReviewPrompt, buildStoryArcRevisionPrompt } from "../prompts/story-arc";
import { WRITER_HARD_CONSTRAINTS } from "../prompts/writer-rules";

describe("long-form prompt contracts", () => {
  it("keeps prose constraints short and leaves chapter length to natural completion", () => {
    expect(WRITER_HARD_CONSTRAINTS).toContain("只输出正文");
    expect(WRITER_HARD_CONSTRAINTS).toContain("允许安静、铺陈、关系、内省和余波自然展开");
    expect(WRITER_HARD_CONSTRAINTS).not.toContain("3000");
    expect(WRITER_HARD_CONSTRAINTS).not.toContain("narrativeScale");
    expect(WRITER_HARD_CONSTRAINTS).not.toContain("必须有新鲜贡献");
  });

  it("renders useful foundation projections without forcing them into chapter fields", () => {
    const markdown = buildFoundationContextMarkdown([{
      id: "foundation-1", projectId: "p", taskId: "characters", attemptId: "a", kind: "foundation",
      contentHash: "h", objectKey: "o", baseRevision: 0, createdAt: 1, fingerprint: "f",
      structuredData: { taskKey: "characters", characters: [{ name: "甲", voiceAnchor: { directness: "克制" } }] },
    }]);
    expect(markdown).toContain("声部锚点：directness=克制");
    expect(markdown).not.toContain("narrativeScale");
  });

  it("keeps global planning claims in the shared memory projection", () => {
    const memory = {
      id: "memory-1",
      projectId: "p",
      preflightId: "preflight-1",
      claims: [{
        id: "foundation:artifact-1",
        projectId: "p",
        kind: "hierarchical",
        title: "全书架构",
        content: "长期承诺与退出状态",
        subjectRefs: ["foundation:architecture"],
        knowledgeScope: "author",
        authority: "derived",
        confidence: 0.8,
        sourceRevisionIds: [],
        contentHash: "hash-1",
        supersedes: [],
      }],
      conflicts: [],
      missingFacets: [],
      tokenBudget: 1000,
      sourceRevisionIds: [],
      fingerprint: "fingerprint-1",
      createdAt: 1,
    } as never;
    expect(dedupeNarrativeRhythmMemory(memory).claims.map((claim) => claim.id)).toEqual(["foundation:artifact-1"]);
  });

  it("describes a local causal contract while preserving long-form space", () => {
    const prompt = buildStoryArcPrompt({
      projectTitle: "测试项目",
      macro: [{ taskKey: "architecture", title: "架构", summary: "保留长期选择的后果" }],
      recentChapters: [],
      openThreads: [],
    });
    expect(prompt).toContain("当前因果、状态、事实边界和场景执行材料");
    expect(prompt).toContain("状态保持稳定也是合法结果");
    expect(prompt).not.toContain("每章必须有新鲜贡献");
  });

  it("keeps global planning responsible for promises, hierarchy, choices and uncertainty", () => {
    const prompt = buildFoundationPrompt({
      taskKey: "architecture",
      instruction: "形成全书架构",
      projectTitle: "测试项目",
      priorArtifacts: [],
    });
    expect(prompt).toContain("全书承诺与终局边界");
    expect(prompt).toContain("timeSpan");
    expect(prompt).toContain("欲望/压力");
    expect(prompt).toContain("已确认事实、基于事实的推导方案和待作者确认项");
    expect(prompt).toContain("不生成逐章章节表");
  });

  it("keeps every active foundation prompt aligned with its required data root", () => {
    const cases = [
      ["project-positioning", ["sellingPoints", "activePressureSource", "emotionalContract", "themeQuestion"]],
      ["architecture", ["volumes", "povStrategy", "timeSpan"]],
      ["characters", ["fear", "voiceAnchor", "arc", "independentAction"]],
      ["worldview", ["factions", "rules"]],
      ["plot-design", ["narrativePromises", "endingEnvelope", "nonNegotiables"]],
    ] as const;
    for (const [taskKey, requiredFields] of cases) {
      const prompt = buildFoundationPrompt({ taskKey, instruction: "形成当前规划", projectTitle: "测试项目", priorArtifacts: [] });
      for (const field of requiredFields) expect(prompt).toContain(field);
    }
  });

  it("makes foundation review evidence-driven across contract and downstream risks", () => {
    const prompt = buildFoundationReviewPrompt({
      taskKey: "architecture",
      artifact: { id: "artifact-1", fingerprint: "fingerprint-1", taskId: "architecture", structuredData: {} } as never,
    });
    expect(prompt).toContain("规划契约是否完整");
    expect(prompt).toContain("审查不确定性");
    expect(prompt).toContain("问题机制、影响范围和最小修复方向");
  });

  it("gives story arc planning, review and revision different responsibilities", () => {
    const planning = buildStoryArcPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
    });
    const review = buildStoryArcReviewPrompt({ chapters: [] } as never, "上下文");
    const revision = buildStoryArcRevisionPrompt({ chapters: [] } as never, { issues: [] } as never, "上下文");
    expect(planning).toContain("关键选择、代价、退出状态和新问题");
    expect(planning).toContain("安静场景也要有可感知的");
    expect(review).toContain("前置证据、行动代价和意义变化");
    expect(revision).toContain("保留已经成立的人物选择、关系积累");
  });

  it("puts scene experience and applicability into draft and three-role review contracts", () => {
    const draft = buildChapterDraftPrompt({
      blueprint: { id: "blueprint-1", baseRevision: 0, commitPolicy: "manual", tasks: [] },
      instructionsOnly: true,
    } as never);
    expect(draft).toContain("完成当前章节执行合同");
    expect(draft).toContain("状态可以保持稳定");
    expect(draft).not.toContain("人物此刻想要什么");
    expect(getReviewFocus("structure-reviewer")).toContain("D1 世界观与 D2 故事性");
    expect(getReviewFocus("character-reviewer")).toContain("D3 群像与 D4 感情线");
    expect(getReviewFocus("prose-reviewer")).toContain("D5 幽默");
  });
});
