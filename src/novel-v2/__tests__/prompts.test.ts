import { describe, expect, it } from "vitest";
import { buildChapterDraftPromptPackage, buildFoundationContextMarkdown } from "../prompts/chapter-draft";
import { dedupeNarrativeRhythmMemory } from "../prompts/chapter-planning-context";
import { buildFoundationPrompt } from "../prompts/foundation";
import { buildFoundationReviewPrompt } from "../prompts/foundation-review";
import { getReviewFocus, isStaleExcerptIssue, toReview } from "../prompts/chapter-review";
import Ajv from "ajv";
import { buildStoryArcChaptersPrompt, buildStoryArcPlanningContextSections, buildStoryArcPrompt, buildStoryArcRebasePrompt, buildStoryArcReviewPrompt, buildStoryArcRevisionPrompt, storyArcBundleSchema } from "../prompts/story-arc";

describe("long-form prompt contracts", () => {
  it("keeps prose constraints short and leaves chapter length to natural completion", () => {
    const prompt = buildChapterDraftPromptPackage({
      intent: { id: "intent-1", projectId: "p", source: "chapter-review", objective: "完成章节", createdAt: 1, idempotencyKey: "intent-1" },
      blueprint: { id: "blueprint-1", baseRevision: 0, commitPolicy: "human-only", tasks: [], budget: { maxInputTokens: 10000, maxOutputTokens: 1000 } } as never,
      memory: { id: "memory-1", claims: [], conflicts: [], missingFacets: [], narrativeRhythm: undefined } as never,
      skills: { id: "skills-1", skills: [], resolution: { bundleId: "skills-1", fingerprint: "skills", executionPoint: "chapter.drafting", skills: [] } } as never,
      workflowId: "workflow-1",
      system: "系统",
    }).instruction;
    expect(prompt).toContain("只输出连续的小说正文");
    expect(prompt).toContain("状态可以保持稳定");
    expect(prompt).not.toContain("3000");
    expect(prompt).not.toContain("narrativeScale");
    expect(prompt).not.toContain("必须有新鲜贡献");
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

  it("guides arc-level design contracts: question ladder, causal scenes, quiet-chapter function and irreversible exit", () => {
    const prompt = buildStoryArcPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
    });
    expect(prompt).toContain("问题阶梯");
    expect(prompt).toContain("可感知变化");
    expect(prompt).toContain("确认规则的陈述若改变了角色后续选择或风险判断，即算功能");
    expect(prompt).toContain("一个场景的 outcome 应成为下一场景 situation 的触发条件");
    expect(prompt).not.toContain("每章必须有新事件");
    expect(prompt).not.toContain("安静章必须承担");
  });

  it("keeps quiet-chapter function requirement in the split chapters contract", () => {
    const prompt = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      arc: { title: "当前弧" } as never,
      batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
    });
    expect(prompt).toContain("确认规则的陈述若改变了角色后续选择或风险判断，即算功能");
    expect(prompt).toContain("状态保持稳定也是合法结果");
    // 窗口契约双向：未声明 windowChapters（旧弧/无预算形态）不得出现窗口句——
    // 契约只随系统分配走，不凭空发明窗口。
    expect(prompt).not.toContain("本批次窗口由系统定为");
  });

  it("批次窗口契约注入生成面（arc5 单章坍缩根因；重基线契约不受影响）", () => {
    const prompted = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      arc: { title: "守夜名册与渠道反噬", expectedChapterCount: 7 } as never,
      batch: { batchIndex: 1, startChapterIndex: 28, complete: false },
      windowChapters: 7,
    });
    expect(prompted).toContain("本批次窗口由系统定为 7 章");
    expect(prompted).toContain("完整覆盖序号 28 至 34");
    expect(prompted).toContain("不是缩减本批次章节窗口");
    // 正常批次面不得混入重基线专属契约文本（两分支契约互不泄漏）。
    expect(prompted).not.toContain("重基线");
    expect(prompted).not.toContain("数量必须等于");
    // 截断窗口（剩余>上限）：数字随系统分配而非硬编码全弧。
    const capped = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      arc: { title: "长弧" } as never,
      batch: { batchIndex: 1, startChapterIndex: 5, complete: false },
      windowChapters: 16,
    });
    expect(capped).toContain("本批次窗口由系统定为 16 章：chapters 必须完整覆盖序号 5 至 20");
  });

  it("checks arc design contracts during arc review without requiring per-chapter events or blanket gates", () => {
    const prompt = buildStoryArcReviewPrompt({
      arc: { title: "当前弧" },
      batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
      chapters: [{
        index: 1,
        title: "当前章",
        narrativeFunction: "development",
        povCharacterId: "char-1",
        stateTransition: { before: "前", after: "后", evidence: "证据" },
        scenes: [{ situation: "处境", observableActions: ["动作"], outcome: "结果" }],
        continuityConstraints: [],
        unresolvedAtClose: ["未知"],
      }],
    } as never, "");
    expect(prompt).toContain("development 各阶段是否呈承接的子问题链而非并列步骤");
    expect(prompt).toContain("推进型弧的退出状态相对入口是否有身份、资源、知识、关系或威胁级别中的可感知变化");
    expect(prompt).toContain("安静、关系、背景、铺垫和余波弧与行动弧同样合法");
    expect(prompt).toContain("本弧的读者回报");
    expect(prompt).toContain("entryState/objective 承诺了什么体验");
    expect(prompt).not.toContain("缺失任一契约按 major 报告");
    expect(prompt).not.toContain("每章必须有事件");
  });

  it("declares the complete chapter field contract for split arc planning", () => {
    const prompt = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      arc: { title: "当前弧" } as never,
      batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
    });
    expect(prompt).toContain("index、title、narrativeFunction、povCharacterId、stateTransition、scenes、continuityConstraints、unresolvedAtClose");
    expect(prompt).toContain("before、after、evidence 三个非空字符串");
    expect(prompt).toContain("narrativeFunction 必须使用 schema 枚举值");
  });

  it("重基线 chapters 面携带逐章对应硬契约（数量与序号按 target 泛化），普通批次不携带", () => {
    const target = {
      arcId: "arc-x", executionStatus: "completed", approvedArc: {} as never,
      batchIndex: 1, startChapterIndex: 8,
      chapters: [8, 9, 10].map((globalOrder) => ({ globalOrder, chapterId: `ch-${globalOrder}`, documentId: `doc-${globalOrder}`, title: `第${globalOrder}章`, revisionId: `rev-${globalOrder}`, committedBlueprint: { index: globalOrder } as never })),
    } as never;
    const rebased = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目", macro: [], recentChapters: [], openThreads: [],
      arc: { title: "当前弧" } as never,
      batch: { batchIndex: 1, startChapterIndex: 8, complete: true },
    }, target);
    expect(rebased).toContain("数量必须等于 3");
    expect(rebased).toContain("8、9、10");
    expect(rebased).toContain("不得只输出单章或窗口子集");
    // 反方向：普通批次不得出现重基线措辞（防把批次生成误导成冻结保真）。
    const normal = buildStoryArcChaptersPrompt({
      projectTitle: "测试项目", macro: [], recentChapters: [], openThreads: [],
      arc: { title: "当前弧" } as never,
      batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
    });
    expect(normal).not.toContain("重基线");
    expect(normal).not.toContain("数量必须等于"); // 冻结保真契约词也不许泄漏进普通批次（审核 B#7）
    expect(normal).not.toContain("逐章对应");
    // 修订回流面同样带契约（数量泛化自 target）。
    const revision = buildStoryArcRevisionPrompt(
      { arc: { title: "当前弧" }, batch: { batchIndex: 1, startChapterIndex: 8, complete: true }, chapters: [] } as never,
      { opinion: "修一下", verdict: "revise" } as never,
      "",
      target,
    );
    expect(revision).toContain("数量等于 3");
    expect(revision).toContain("不得缩减为子集");
    expect(revision).toContain("chapters[].globalOrder"); // N7/D4：契约字段名必须=StoryArcRebaseTargetChapter 实形
    // 无 target 的修订回流不得携带任何重基线措辞（双向）。
    const normalRevision = buildStoryArcRevisionPrompt(
      { arc: { title: "当前弧" }, batch: { batchIndex: 2, startChapterIndex: 11, complete: false }, chapters: [] } as never,
      { opinion: "修一下", verdict: "revise" } as never,
      "",
    );
    expect(normalRevision).not.toContain("重基线");
    expect(normalRevision).not.toContain("数量等于");
  });

  it("guards local reactions from becoming unsupported material functions", () => {
    const prompt = buildStoryArcReviewPrompt({
      arc: { title: "当前弧" },
      batch: { batchIndex: 2, startChapterIndex: 11, complete: false },
      chapters: [{
        index: 1,
        title: "当前章",
        narrativeFunction: "development",
        povCharacterId: "char-1",
        stateTransition: { before: "前", after: "后", evidence: "证据" },
        scenes: [{ situation: "处境", observableActions: ["动作"], outcome: "结果" }],
        continuityConstraints: [],
        unresolvedAtClose: ["未知"],
      }],
    } as never, "");
    expect(prompt).toContain("未知物质、装置、痕迹或局部反应");
    expect(prompt).toContain("不能单凭一次反应推出用途、成分、机制");
    expect(prompt).toContain("保留未知状态");
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

  it("forbids preset per-volume chapter counts and only allows relative pacing hints", () => {
    const prompt = buildFoundationPrompt({
      taskKey: "architecture",
      instruction: "形成全书架构",
      projectTitle: "测试项目",
      priorArtifacts: [],
    });
    expect(prompt).toContain("不得在架构层预设每卷的固定章节数量");
    expect(prompt).toContain("章节数量不是质量目标");
    expect(prompt).not.toContain("chapterCount");
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

  it("binds foundation review to the current stage and keeps revise within its own responsibility", () => {
    const prompt = buildFoundationReviewPrompt({
      taskKey: "project-positioning",
      artifact: { id: "artifact-1", fingerprint: "fingerprint-1", taskId: "project-positioning", structuredData: {} } as never,
    });
    expect(prompt).toContain("跨阶段职责判定");
    expect(prompt).toContain("只对当前 taskKey 的核心职责负责");
    expect(prompt).toContain("下游阶段");
    expect(prompt).toContain("判 revise 的唯一依据");
    expect(prompt).toContain("待确认项");
  });

  it("keeps foundation review opinion safe to flow back as a regeneration instruction", () => {
    const prompt = buildFoundationReviewPrompt({
      taskKey: "worldview",
      artifact: { id: "artifact-1", fingerprint: "fingerprint-1", taskId: "worldview", structuredData: {} } as never,
    });
    expect(prompt).toContain("意见回流卫生");
    expect(prompt).toContain("禁止使用中文全角引号");
    expect(prompt).toContain("不要求模型增加特定的 structuredData 字段名");
    expect(prompt).toContain("只针对当前阶段可修复的问题");
  });

  it("binds foundation review to convergence discipline so revise loops terminate", () => {
    const prompt = buildFoundationReviewPrompt({
      taskKey: "project-positioning",
      artifact: { id: "artifact-1", fingerprint: "fingerprint-1", taskId: "project-positioning", structuredData: {} } as never,
    });
    expect(prompt).toContain("判定纪律");
    expect(prompt).toContain("只报阻断项");
    expect(prompt).toContain("修订循环要收敛");
    expect(prompt).toContain("默认倾向是放行");
  });

  it("subjects foundation planning to a strict reader-view baseline audit", () => {
    const prompt = buildFoundationReviewPrompt({
      taskKey: "project-positioning",
      artifact: { id: "artifact-1", fingerprint: "fingerprint-1", taskId: "project-positioning", structuredData: {} } as never,
    });
    expect(prompt).toContain("读者视角严苛检查");
    expect(prompt).toContain("读者承诺可兑现");
    expect(prompt).toContain("主题进入选择");
    expect(prompt).toContain("欲望遇阻力产生选择");
    expect(prompt).toContain("群像独立");
    expect(prompt).toContain("世界观压力系统");
    expect(prompt).toContain("感情线行动累积");
    expect(prompt).toContain("疲劳管理");
    expect(prompt).toContain("留白证据");
    expect(prompt).toContain("不是必须全部成立的硬门");
    expect(prompt).not.toContain("每章必须有新事件");
  });

  it("gives story arc planning, review and revision different responsibilities", () => {
    const planning = buildStoryArcPrompt({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
    });
    const review = buildStoryArcReviewPrompt({ chapters: [] } as never, "上下文");
    const revision = buildStoryArcRevisionPrompt({ chapters: [] } as never, { verdict: "revise", opinion: "逐章意见" } as never, "上下文");
    expect(planning).toContain("关键选择、代价、退出状态和新问题");
    expect(planning).toContain("安静场景也要有可感知的");
    expect(review).toContain("前置证据、行动代价和意义变化");
    expect(review).toContain("跨章节持续的物件、伤势、资源、关系、知识或限制");
    expect(review).toContain("故事弧按批次滚动审核");
    expect(review).toContain("对每章按其权威路径逐一核对证据边界");
    expect(review).toContain("PASSED");
    expect(revision).toContain("保留已经成立的人物选择、关系积累");
    expect(revision).toContain("审核意见：逐章意见");
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
      "arc-context-serial-signals",
      "arc-context-receipt",
    ]);
    expect(sections.find((section) => section.id === "arc-context-recent")?.text).toContain("叙事截止点：第 3 章");
    expect(sections.find((section) => section.id === "arc-context-macro")?.provenanceRefs).toContain("story-arc-section:macro:macro-fp");
    // 负方向（PL-8③）：无秘密投影时不得出现该段（空清单不注入占位噪声）。
    expect(sections.map((section) => section.id)).not.toContain("arc-context-secrets");
  });

  it("injects the undisclosed-secrets ledger into arc planning context and arms the review check (PL-8③)", () => {
    const sections = buildStoryArcPlanningContextSections({
      projectTitle: "测试项目",
      macro: [],
      recentChapters: [],
      openThreads: [],
      undisclosedSecrets: [
        { claim: "旧秩序维护者的真实动机", revealWindow: "第三卷后" },
        { claim: "力量体系的底层来源", carrier: "关键道具的来历" },
      ],
    });
    const secrets = sections.find((section) => section.id === "arc-context-secrets");
    expect(secrets).toBeDefined();
    expect(secrets?.priority).toBe("required");
    expect(secrets?.text).toContain("旧秩序维护者的真实动机");
    expect(secrets?.text).toContain("揭示窗口：第三卷后");
    expect(secrets?.text).toContain("载体：关键道具的来历");
    // 段序：秘密清单先于开放候选（边界在消费清单之前呈现）。
    const ids = sections.map((section) => section.id);
    expect(ids.indexOf("arc-context-secrets")).toBeLessThan(ids.indexOf("arc-context-open-elements"));
    // 审核侧：通用检查在场（清单为空时指令自身声明跳过，不依赖注入）。
    const review = buildStoryArcReviewPrompt({ chapters: [] } as never, "上下文");
    expect(review).toContain("秘密边界检查");
    expect(review).toContain("未揭示作者秘密");
    // P2 负结果收口：字面 carry-run 全书实测为零 → 不建确定性检测器；
    // "悬念续费"是语义现象，落审核面语义检查（换措辞不换账）。
    expect(review).toContain("悬念续费检查");
    expect(review).toContain("语义同一");
  });

  it("injects the window-elapsed foreshadowing ledger without claiming debt (P1, 2026-09-18 语义修正)", () => {
    const base = { projectTitle: "测试项目", macro: [], recentChapters: [], openThreads: [] };
    const sections = buildStoryArcPlanningContextSections({
      ...base,
      dueLedger: {
        currentOrder: 122,
        windowElapsedCount: 2,
        agedOpenCount: 3,
        items: [
          { id: "f1", description: "玉牌监控机制未明", horizonOrder: 40, plantedOrder: 6 },
          { id: "f2", description: "黑风林影子的去向", horizonOrder: 80, plantedOrder: 20 },
        ],
      },
    });
    const due = sections.find((section) => section.id === "arc-context-due-ledger");
    expect(due?.priority).toBe("required");
    expect(due?.text).toContain("2 条 open 伏笔的兑现窗口上界已过");
    expect(due?.text).toContain("3 条埋设 40+ 章");
    // 清单按窗口上界升序呈现（最老的先面对规划者）。
    expect(due!.text.indexOf("f1")).toBeLessThan(due!.text.indexOf("f2"));
    // 语义修正的核心：不得把"上界已过"表述为欠债/超期，否则指挥作者处理不存在的问题。
    expect(due?.text).toContain("不等于");
    expect(due?.text).toContain("欠债");
    expect(due?.text).not.toContain("已超自声明窗口上界");
    // 负方向：无账不注入占位段（与秘密清单同纪律）。
    expect(buildStoryArcPlanningContextSections(base).map((section) => section.id)).not.toContain("arc-context-due-ledger");
    // 审核面检查常驻（无段时指令自身声明跳过）。
    expect(buildStoryArcReviewPrompt({ chapters: [] } as never, "上下文")).toContain("到期账处置检查");
  });

  it("injects the narrative-dormancy ledger and marks silence as the actionable signal (P1, 2026-09-18)", () => {
    const base = { projectTitle: "测试项目", macro: [], recentChapters: [], openThreads: [] };
    const dormancy = {
      currentOrder: 168,
      measured: 427,
      silent: [
        // 账本按沉默章数降序给出（summarizeDormancy 的排序契约），渲染器信任该顺序。
        { id: "f2", description: "树洞蓝光性质", plantedOrder: 34, lastMentionOrder: 42, silentFor: 126 },
        { id: "f1", description: "齐姓人的去向", plantedOrder: 20, lastMentionOrder: 60, silentFor: 108 },
      ],
      // 15 条孤儿需与 silent 同形（DormancyLedgerEntry）。
      neverMentioned: Array.from({ length: 15 }, (_, index) => ({ id: `n${index}`, description: `孤儿线索 ${index}`, plantedOrder: 1, lastMentionOrder: null, silentFor: null })),
      silentBands: [{ fromOrder: 120, toOrder: 139, count: 37 }, { fromOrder: 140, toOrder: 159, count: 16 }],
      running: 346,
      unmeasurable: 0,
    };
    const sections = buildStoryArcPlanningContextSections({ ...base, narrativeDormancy: dormancy });
    const seg = sections.find((section) => section.id === "arc-context-dormancy");
    expect(seg?.priority).toBe("required");
    expect(seg?.text).toContain("2 条线索");
    expect(seg?.text).toContain("曾活跃、现已静默");
    expect(seg?.text).toContain("15 条埋设后从未被正文再提及");
    expect(seg?.text).toContain("仍在推进 346 条");
    // 静默带呈现（成片失线优先核对）。
    expect(seg?.text).toContain("第120-139章 37条");
    // 清单按沉默章数降序：静默最久的先面对规划者。
    expect(seg!.text.indexOf("f2")).toBeLessThan(seg!.text.indexOf("f1"));
    // 负方向 1：无静默也无孤儿时不注入占位段。
    expect(
      buildStoryArcPlanningContextSections({ ...base, narrativeDormancy: { ...dormancy, silent: [], neverMentioned: [], silentBands: [] } })
        .map((section) => section.id),
    ).not.toContain("arc-context-dormancy");
    // 负方向 2：完全无账不注入。
    expect(buildStoryArcPlanningContextSections(base).map((section) => section.id)).not.toContain("arc-context-dormancy");
  });

  it("跨弧回报节奏信号：连续零兑付给出透支提示，密度正常不误伤（P5）", () => {
    const base = { projectTitle: "测试项目", macro: [], recentChapters: [], openThreads: [] };
    const sections = buildStoryArcPlanningContextSections({
      ...base,
      payoffRhythm: [
        { arcOrdinal: 15, title: "用字的人", finalChapters: 7, payoffCount: 3 },
        { arcOrdinal: 16, title: "弧16：看一眼", finalChapters: 7, payoffCount: 0 },
        { arcOrdinal: 17, title: "弧17：补证人", finalChapters: 7, payoffCount: 0 },
      ],
    });
    const serial = sections.find((section) => section.id === "arc-context-serial-signals");
    expect(serial?.text).toContain("弧15《用字的人》 7章/3笔兑付");
    expect(serial?.text).toContain("弧16《看一眼》 7章/0笔兑付");
    expect(serial?.text).toContain("已连续 2 弧零兑付");
    // 反例：有兑付节奏/无账目时不出现透支提示（不设数值硬门纪律）。
    const healthy = buildStoryArcPlanningContextSections({ ...base, payoffRhythm: [{ arcOrdinal: 3, title: null, finalChapters: 6, payoffCount: 2 }] });
    expect(healthy.find((section) => section.id === "arc-context-serial-signals")?.text).not.toContain("零兑付");
    const none = buildStoryArcPlanningContextSections(base);
    expect(none.find((section) => section.id === "arc-context-serial-signals")?.text).not.toContain("跨弧回报节奏");
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
          threadResponsibilities: [{ threadRef: "thread-1", responsibility: "保持压力", nextAdvance: "出现新证据" }],
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
          chapterMemory: { summary: "历史章节", keyEvents: [], characterStates: [], unresolvedThreads: [] },
          authoritativeFacts: [],
        }],
      },
    });
    expect(prompt).toContain("不是下一批次生成");
    expect(prompt).toContain("batch.batchIndex=1");
    expect(prompt).toContain("只读输入 envelope");
    expect(prompt).toContain("approvedArc 必须已经符合当前故事弧契约");
    expect(prompt).not.toContain("legacyArcContractGaps");
    expect(prompt).toContain("不得原样复制到输出");
  });

  it("uses explicit empty execution values instead of optional scene fields", () => {
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
        threadResponsibilities: [],
        foreshadowingRefs: [],
        expectedChapterCount: 1,
        phases: [],
      },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{
        index: 1,
        title: "安静的一章",
        narrativeFunction: "unspecified",
        povCharacterId: "",
        targetWordCount: 2600,
        stateTransition: { before: "入口", after: "状态仍在", evidence: "观察与相处留下可见证据" },
        scenes: [{ title: "室内", participants: ["主角"], situation: "两人等待消息", observableActions: ["主角把未寄出的信收回抽屉"], planningRationale: "", opposition: "", decision: "", outcome: "关系和信息边界保持开放", cost: "" }],
        continuityConstraints: [],
        unresolvedAtClose: [],
      }],
    })).toBe(true);
  });

  it("accepts the reduced arc contract without deprecated fields", () => {
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
        threadResponsibilities: [],
        foreshadowingRefs: [],
        expectedChapterCount: 1,
        phases: [],
      },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{
        index: 1,
        title: "quiet chapter",
        narrativeFunction: "unspecified",
        povCharacterId: "",
        targetWordCount: 1800,
        stateTransition: { before: "tired", after: "rested", evidence: "sleep" },
        scenes: [{ title: "rest", participants: ["person"], situation: "at home", observableActions: ["sleep"], planningRationale: "", opposition: "", decision: "", outcome: "rested", cost: "" }],
        continuityConstraints: [],
        unresolvedAtClose: [],
      }],
    };
    expect(validate(value)).toBe(true);
  });

  it("declares the text review contract with an explicit PASSED marker", () => {
    const prompt = buildStoryArcReviewPrompt({
      arc: { title: "arc", objective: "objective", entryState: "entry", centralConflict: "conflict", development: [], resolution: "resolution", exitState: "exit", threadResponsibilities: [], foreshadowingRefs: [], expectedChapterCount: 1, phases: [] },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{ index: 1, title: "chapter", stateTransition: { before: "before", after: "after", evidence: "evidence" }, scenes: [{ title: "scene", participants: ["person"], situation: "situation", observableActions: ["action"], outcome: "outcome" }], continuityConstraints: [] }],
    }, "context");
    expect(prompt).toContain("只输出一行：PASSED");
    expect(prompt).toContain("若存在问题，输出审核意见");
    expect(prompt).toContain("不要输出 JSON、Markdown 代码块或 Schema");
    expect(prompt).not.toContain("verdict 只能是");
    expect(prompt).not.toContain("chapterChecks 对每个章节分别输出四个 dimension");
  });

  it("puts scene experience and applicability into draft and three-role review contracts", () => {
    const draft = buildChapterDraftPromptPackage({
      intent: { id: "intent-1", projectId: "p", source: "chapter-review", objective: "完成章节", createdAt: 1, idempotencyKey: "intent-1" },
      blueprint: { id: "blueprint-1", baseRevision: 0, commitPolicy: "human-only", tasks: [], budget: { maxInputTokens: 10000, maxOutputTokens: 1000 } } as never,
      memory: { id: "memory-1", claims: [], conflicts: [], missingFacets: [], narrativeRhythm: undefined } as never,
      skills: { id: "skills-1", skills: [], resolution: { bundleId: "skills-1", fingerprint: "skills", executionPoint: "chapter.drafting", skills: [] } } as never,
      workflowId: "workflow-1",
      system: "系统",
    }).instruction;
    expect(draft).toContain("完成当前章节执行合同");
    expect(draft).toContain("状态可以保持稳定");
    expect(draft).not.toContain("人物此刻想要什么");
    expect(getReviewFocus("structure-reviewer")).toContain("D1 世界观与 D2 故事性");
    expect(getReviewFocus("character-reviewer")).toContain("D3 群像与 D4 感情线");
    expect(getReviewFocus("prose-reviewer")).toContain("D5 幽默");
    expect(getReviewFocus("prose-reviewer")).toContain("专业化、制度化或理论化术语");
    expect(getReviewFocus("prose-reviewer")).toContain("对技术认知做删除测试");
    expect(getReviewFocus("prose-reviewer")).toContain("即使动作仍可复原，这仍然是正文质量问题");
  });

  it("preserves reviewer issues and score without exact excerpt matching", () => {
    const review = toReview({
      artifact: { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" },
      identity: "independent",
      role: "prose-reviewer",
      output: {
        verdict: "revise",
        score: 3.2,
        issues: [{
          severity: "major",
          title: "场景承载不足",
          description: "关键情绪被摘要带过。",
          excerpt: "审核模型概括的现场证据，不要求逐字相同",
          revisionRanges: [{ start: 2, end: 2 }],
          rule: "关键变化需要由场景过程承载。",
          suggestion: "补足动作和即时反馈。",
          readerReconstruction: null,
        }],
      },
    });

    expect(review).toMatchObject({ verdict: "revise", score: 3.2, issues: [{ title: "场景承载不足" }] });
  });

  it("currentText 在场时机械执行摘录契约：旧文复读丢弃+verdict 回推，现行文证据与无摘录 issue 不误杀（ch67 复读死循环实证）", () => {
    const artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft" as const, contentHash: "hash", baseRevision: 0, fingerprint: "fp", createdAt: 0, text: "" };
    const text = "他把空砚台扶正，白日收工时随手搁下的地方已经干透。窗外风把纸角掀起又放下。";
    const stale = { severity: "major" as const, title: "正文夹杂外文词", description: "夹杂 daytime", excerpt: "窗台上摆着那只空砚台， daytime 收工时他随手搁的", revisionRanges: [], rule: "摘录须在场", suggestion: "核对当前正文", readerReconstruction: null };
    const live = { severity: "warning" as const, title: "纸角动作重复", description: "掀起又放下与前段同构", excerpt: "窗外风把纸角掀起又放下", revisionRanges: [], rule: "重复动作", suggestion: "减一处", readerReconstruction: null };
    const noExcerpt = { severity: "warning" as const, title: "收束略急", description: "结尾可再多一拍", excerpt: "", revisionRanges: [], rule: "收束", suggestion: "多一拍身体动作", readerReconstruction: null };
    const dropped = toReview({ artifact, identity: "internal", role: "structure-reviewer", output: { verdict: "revise", score: 4, issues: [stale] }, currentText: text });
    expect(dropped).toMatchObject({ verdict: "passed", issues: [] }); // 复读孤证被丢，revise 失去 issue 支撑按契约语义回推
    const mixed = toReview({ artifact, identity: "internal", role: "structure-reviewer", output: { verdict: "revise", score: 4, issues: [stale, live, noExcerpt] }, currentText: text });
    expect(mixed.issues.map((i) => i.title)).toEqual(["纸角动作重复", "收束略急"]); // 真证据保留、无摘录保守保留
    expect(mixed.verdict).toBe("revise");
    const legacy = toReview({ artifact, identity: "internal", role: "structure-reviewer", output: { verdict: "revise", score: 4, issues: [stale] } });
    expect(legacy.issues).toHaveLength(1); // 无 currentText 时旧行为零回归
    expect(isStaleExcerptIssue({ excerpt: "他把空砚台扶正……白日收工时随手搁下的地方已经干透" }, text)).toBe(false); // 省略号分段有一即真
  });
});
