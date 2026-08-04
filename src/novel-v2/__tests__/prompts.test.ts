import { describe, expect, it } from "vitest";
import { buildFoundationContextMarkdown } from "../prompts/chapter-draft";
import { buildChapterDraftPrompt } from "../prompts/chapter-draft";
import { dedupeNarrativeRhythmMemory } from "../prompts/chapter-planning-context";
import { buildFoundationPrompt } from "../prompts/foundation";
import { buildFoundationReviewPrompt } from "../prompts/foundation-review";
import { getReviewFocus } from "../prompts/chapter-review";
import Ajv from "ajv";
import { buildStoryArcPlanningContextSections, buildStoryArcPrompt, buildStoryArcRebasePrompt, buildStoryArcReviewPrompt, buildStoryArcRevisionPrompt, storyArcBundleSchema } from "../prompts/story-arc";
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

  it("projects ledger elements and learning mechanisms into story-arc planning without forcing them into events", () => {
    const prompt = buildStoryArcPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [{ id: "thread-1", title: "未决线", payload: { pressure: "资源不足" } }],
      openForeshadowings: [{ id: "foreshadowing-1", description: "旧门上的异常刻痕", triggerKeywords: ["刻痕"], expectedPayoffWindow: "本卷中段", plantedRevisionId: "r1" }],
      openPromises: [{ id: "promise-1", promiser: "甲", promisee: "乙", statement: "会在月末回来", sourceRevisionId: "r2" }],
      planningFeedback: [{ sourceChapterOrder: 8, targetId: "plot-causality", underlyingMechanism: "阶段退出状态没有回写到下一批规划", affectedInputClass: "长篇连续故事弧", boundaries: "不要求每章新增事件" }],
    });
    expect(prompt).toContain("foreshadowing-1");
    expect(prompt).toContain("promise-1");
    expect(prompt).toContain("阶段退出状态没有回写到下一批规划");
    expect(prompt).toContain("开放线索是待判断的责任与素材，不是本批次必须兑现的事件");
    expect(prompt).not.toContain("叙事状态：{");
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

  it("projects story arc context into auditable sections with cutoff and provenance", () => {
    const sections = buildStoryArcPlanningContextSections({
      projectTitle: "测试项目",
      macro: [{ taskKey: "architecture", title: "结构", summary: "阶段边界" }],
      recentChapters: [{ order: 3, summary: "上一章", unresolvedThreads: ["thread-1"] }],
      openThreads: [],
      contextReceipt: {
        narrativeCutoff: 3,
        sourceArtifactIds: ["artifact-1"],
        sourceRevisionIds: ["revision-3"],
        sectionFingerprints: { macro: "macro-fp", recent: "recent-fp" },
        fingerprint: "context-fp",
        legacy: false,
      },
    });
    expect(sections.map((section) => section.id)).toEqual([
      "arc-context-macro",
      "arc-context-recent",
      "arc-context-open-elements",
      "arc-context-feedback-state",
      "arc-context-receipt",
    ]);
    expect(sections.find((section) => section.id === "arc-context-recent")?.text).toContain("叙事截止点：第 3 章");
    expect(sections.find((section) => section.id === "arc-context-macro")?.provenanceRefs).toContain("story-arc-section:macro:macro-fp");
  });

  it("treats rebase input envelopes as read-only and preserves the affected batch window", () => {
    const prompt = buildStoryArcRebasePrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      target: {
        arcId: "arc-1",
        executionStatus: "active",
        approvedArc: {
          title: "第一弧",
          objective: "保留既有因果并修复边界",
          entryState: "入口",
          centralConflict: "冲突",
          development: [],
          resolution: "阶段结果",
          exitState: "出口",
          plotThreadRefs: [],
          threadResponsibilities: [],
          foreshadowingRefs: [],
          expectedChapterCount: 2,
          phases: [],
        },
        batchIndex: 1,
        startChapterIndex: 1,
        chapters: [{
          chapterId: "chapter-1",
          documentId: "document-1",
          globalOrder: 1,
          title: "第一章",
          revisionId: "revision-1",
          approvedPlan: { sceneEvents: [], continuityConstraints: [], setupRefs: [], payoffRefs: [] },
          authoritativeFacts: [],
        }],
      },
    });
    expect(prompt).toContain("不是下一批次生成");
    expect(prompt).toContain("batch.batchIndex=1");
    expect(prompt).toContain("只读输入 envelope");
    expect(prompt).toContain("不得原样复制到输出");
  });

  it("does not require optional scene execution detail to invent constraints", () => {
    const validate = new Ajv({ strict: false }).compile(storyArcBundleSchema);
    expect(validate({
      arc: {
        title: "第一弧",
        objective: "保留因果并建立下一步方向",
        entryState: "入口",
        centralConflict: "冲突",
        development: [],
        resolution: "阶段结果",
        exitState: "出口",
        plotThreadRefs: [],
        threadResponsibilities: [],
        foreshadowingRefs: [],
        expectedChapterCount: 1,
        phases: [],
        thematicQuestions: [],
      },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{
        index: 1,
        title: "安静的一章",
        stateTransition: { before: "入口", after: "状态仍在", evidence: "观察与相处留下可见证据" },
        scenes: [{ title: "室内", participants: ["主角"], situation: "两人等待消息", observableActions: ["主角把未寄出的信收回抽屉"], outcome: "关系和信息边界保持开放" }],
        continuityConstraints: [],
      }],
    })).toBe(true);
  });

  it("keeps empty continuity and thematic collections optional", () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(storyArcBundleSchema);
    const value = {
      arc: {
        title: "quiet arc",
        objective: "recover",
        entryState: "safe",
        centralConflict: "fatigue",
        development: ["rest"],
        resolution: "recovered",
        exitState: "ready",
        plotThreadRefs: [],
        threadResponsibilities: [],
        foreshadowingRefs: [],
        expectedChapterCount: 1,
        phases: [],
      },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{
        index: 1,
        title: "quiet chapter",
        stateTransition: { before: "tired", after: "rested", evidence: "sleep" },
        scenes: [{ title: "rest", participants: ["person"], situation: "at home", observableActions: ["sleep"], outcome: "rested" }],
      }],
    };
    expect(validate(value)).toBe(true);
  });

  it("declares canonical review vocabulary instead of leaving provider aliases ambiguous", () => {
    const prompt = buildStoryArcReviewPrompt({
      arc: { title: "arc", objective: "objective", entryState: "entry", centralConflict: "conflict", development: [], resolution: "resolution", exitState: "exit", plotThreadRefs: [], threadResponsibilities: [], foreshadowingRefs: [], expectedChapterCount: 1, phases: [] },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{ index: 1, title: "chapter", stateTransition: { before: "before", after: "after", evidence: "evidence" }, scenes: [{ title: "scene", participants: ["person"], situation: "situation", observableActions: ["action"], outcome: "outcome" }], continuityConstraints: [] }],
    }, "context");
    expect(prompt).toContain("verdict 只能是 passed、revise、blocked");
    expect(prompt).toContain("certaintyUpgrades 的字段必须是 candidateClaim、frozenBoundary、reason");
    expect(prompt).toContain("chapterChecks 对每个章节分别输出四个 dimension");
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
