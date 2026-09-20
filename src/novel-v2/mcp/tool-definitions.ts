/**
 * V2 MCP 工具定义：每个工具的 name/description/inputSchema（JSON Schema draft-07）。
 * 本数组是唯一注册表——工具数不写在这里，派生值看 `tool-metadata.ts` 的 `TOOL_COUNT`；
 * docs/novel-v2/{mcp-orchestrator,workflow-map}.md 与各 skill 声明的数字由
 * `__tests__/mcp-tool-face-single-source.test.ts` 强制与本数组一致。
 *
 * 设计依据：AGENTS.md 架构阶段和 V2 MCP 工具契约。
 *
 * 与 v1 的区别：
 * - v1 含 novel_foundation_export，v2 替换为 novel_closed_loop_run（评估闭环）
 * - v2 全部基于 Postgres，inputSchema 严格校验入参
 *
 * 工具分组（各括号数即该组工具数，总和 = TOOL_COUNT）：
 * - Run / Action 主体（7）
 * - Catalog / Receipt（3）
 * - Craft Rule 候选演进（7）
 * - 项目生命周期（3）
 * - 规划与创作（15，含外部编排模式 novel_story_arc_orchestrate、短剧剧本派生
 *   novel_chapter_script_h3、伏笔账本分流 novel_foreshadowing_list/triage）
 * - 评估闭环（1，v2 新增）
 * - Workflow 查询（2）
 * - Workflow 决策（1）
 * - 上下文与产物查询（2，novel_context_get / novel_artifact_list）
 * - 外部 LLM 深度参与（9，记忆查询/梳理报告/回述对照/候选队列/裁决/skill 查询/prompt 审计/
 *   调用审计/模型调度；明细见 tool-metadata.ts 的 TOOL_GROUPS）
 */
import type { ToolDefinition } from "./types";
import { readerReconstructionSchema } from "../reader-reconstruction-schema";
// 常量来自浏览器安全的叶子模块（story-arc.ts 依赖 node:crypto，禁止进入前端包）
import { MAX_CHAPTER_HINTS, MAX_EXPECTED_CHAPTER_COUNT } from "../application/story-arc-limits";

// TODO P2: 分页默认值与上限应可配置——当前默认 20/50、上限 100 适配 MCP 单次响应。
// 未来应由 API 网关或项目级配置决定，而非硬编码。
export const DEFAULT_WORKFLOW_LIST_LIMIT = 20;
export const DEFAULT_ARTIFACT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

// ===== 共享 Schema 片段 =====

const issueSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["blocker", "major", "warning"] },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    evidence: { type: "string", minLength: 1 },
    excerpt: { type: "string" },
    paragraph: { type: "number" },
    revisionRanges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
    },
    rule: { type: "string" },
    sourceId: { type: "string" },
    suggestion: { type: "string" },
    readerReconstruction: readerReconstructionSchema,
  },
  required: ["severity", "title", "evidence"],
  additionalProperties: false,
};

const reviewInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    subjectArtifactId: { type: "string", minLength: 1 },
    reviewer: { type: "string", enum: ["internal", "independent", "human"] },
    verdict: { type: "string", enum: ["passed", "revise", "blocked"] },
    issues: { type: "array", items: issueSchema },
    summary: { type: "string" },
  },
  required: ["subjectArtifactId", "reviewer", "verdict", "issues", "summary"],
  additionalProperties: false,
};

const workInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["generation", "revision", "review"] },
    taskKey: { type: "string" },
    targetId: { type: "string" },
    instruction: { type: "string", minLength: 1 },
    dependsOn: { type: "array", items: { type: "string" } },
    parameters: { type: "object", additionalProperties: true },
  },
  required: ["kind", "instruction"],
  additionalProperties: false,
};

const policySchema: Record<string, unknown> = {
  type: "object",
  properties: {
    maxRetries: { type: "integer", minimum: 0 },
    reviewGate: { type: "string", enum: ["manual", "auto", "none"] },
    autoAcceptThreshold: { type: "number" },
  },
  additionalProperties: false,
};

const creativeBriefSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    version: { type: "integer", enum: [1] },
    targetReader: { type: "string" },
    corePromise: { type: "string" },
    themeQuestion: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: false, required: ["notApplicable", "rationale"], properties: { notApplicable: { const: true }, rationale: { type: "string", minLength: 1 } } }] },
    protagonistNeed: { type: "string" },
    protagonistContradiction: { type: "string" },
    centralOpposition: { type: "string" },
    emotionalContract: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: false, required: ["notApplicable", "rationale"], properties: { notApplicable: { const: true }, rationale: { type: "string", minLength: 1 } } }] },
    worldAnchor: { type: "string" },
    researchNeeds: { type: "array", items: { type: "string" } },
    nonNegotiables: { type: "array", items: { type: "string" } },
    endingEnvelope: { type: "string" },
    stylePreferences: { type: "string" },
  },
};

/**
 * 外部剧情编排（故事弧模式 B）schema。
 *
 * 设计依据：mcp-orchestrator.md 阶段 1 模式 B——外部大模型/用户提供剧情编排
 * （objective 必填，其余为弧级设计意图），系统负责完善为规范蓝图并走正式
 * 审核闭环。threadResponsibilities 沿用 threadRef/responsibility/nextAdvance
 * 三段契约，与 story arc 规范一致；chapterHints 上限与单批次窗口（16 章）对齐。
 */
const plotOutlineSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    objective: { type: "string", minLength: 1, description: "本弧创作目的 / 核心读者问题（必填）" },
    title: { type: "string", description: "弧标题建议" },
    entryState: { type: "string", description: "入口状态" },
    centralConflict: { type: "string", description: "核心冲突" },
    development: { type: "array", items: { type: "string" }, description: "发展阶梯：子问题链，每项承接前项并引出下一项" },
    resolution: { type: "string", description: "解决" },
    exitState: { type: "string", description: "退出状态" },
    threadResponsibilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["threadRef", "responsibility", "nextAdvance"],
        properties: {
          threadRef: { type: "string", minLength: 1 },
          responsibility: { type: "string", minLength: 1 },
          nextAdvance: { type: "string", minLength: 1 },
          foreshadowingRefs: { type: "array", items: { type: "string", minLength: 1 }, description: "本条线在本弧承担的伏笔引用（id 或登记名原文）；系统只接受本弧伏笔账内的引用，账外引用会阻止批准" },
        },
      },
      description: "本弧责任线（threadRef 必须能解析到当前项目剧情线，未解析引用会阻止批准；伏笔归属写在对应线程的 foreshadowingRefs 上）",
    },
    expectedChapterCount: { type: "integer", minimum: 1, maximum: MAX_EXPECTED_CHAPTER_COUNT, description: "期望章节数" },
    phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "objective"], properties: { title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, chapterOrdinals: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 }, description: "本阶段覆盖的弧内章节序号（1-based）；提供后章节所属阶段按此绑定，不再等分推算" } } }, description: "阶段划分（建议绑定 chapterOrdinals）" },
    chapterHints: { type: "array", maxItems: MAX_CHAPTER_HINTS, items: { type: "string" }, description: `逐章提示（作为章节设计意图，最多 ${MAX_CHAPTER_HINTS} 条）` },
    plotNotes: { type: "string", description: "自由剧情编排说明：人物安排、伏笔、关系进展、信息释放节奏等" },
  },
  required: ["objective"],
};

// ===== 工具名常量 =====

export const TOOL_NAMES = [
  // Run / Action 主体（7）
  "novel_run_create",
  "novel_run_get",
  "novel_action_list",
  "novel_action_execute",
  "novel_artifact_get",
  "novel_review_submit",
  "novel_run_complete",
  // Catalog / Receipt（3）
  "novel_catalog_get",
  "novel_receipt_get",
  "novel_rule_target_get",
  // Craft Rule 候选演进（7）
  "novel_rule_candidate_create",
  "novel_rule_candidate_get",
  "novel_rule_evidence_submit",
  "novel_rule_foundation_evaluate",
  "novel_rule_review_submit",
  "novel_rule_promote",
  "novel_rule_rollback",
  // 项目生命周期（3）
  "novel_project_create",
  "novel_project_list",
  "novel_project_delete",
  // 规划与创作（13）
  "novel_bootstrap_run",
  "novel_chapter_review",
  "novel_chapter_review_issue_add",
  "novel_chapter_generate",
  "novel_chapter_script_h3",
  "novel_story_arc_start",
  "novel_story_arc_get",
  "novel_story_arc_review",
  "novel_story_arc_decision",
  "novel_story_arc_batch_start",
  "novel_story_arc_orchestrate",
  "novel_foreshadowing_list",
  "novel_foreshadowing_triage",
  // 外部产出与 Skill 读取（2，v2 新增）
  "novel_skill_get",
  "novel_chapter_script_h3_submit",
  // 评估闭环（1，v2 新增）
  "novel_closed_loop_run",
  // Workflow 查询（2，新增）
  "novel_workflow_get",
  "novel_workflow_list",
  // Workflow 决策（1，新增）
  "novel_chapter_review_decision",
  // 上下文与产物查询（2，新增）
  "novel_context_get",
  "novel_artifact_list",
  // 外部 LLM 深度参与：上下文查询与子 agent 调度（6，2026-09-08；梳理报告 2026-09-09）
  "novel_memory_query",
  "novel_memory_grooming_report",
  "novel_chapter_recall_report",
  "novel_skill_query",
  "novel_prompt_inspect",
  "novel_invocation_list",
  "novel_model_dispatch",
  // 事实候选队列一等公民化（2，FM-2 2026-09-10：积压面板 + 批量裁决）
  "novel_fact_candidate_queue",
  "novel_fact_candidate_decide",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ===== 工具定义 =====

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ===== Run / Action 主体（7）=====

  {
    name: "novel_run_create",
    description: "创建 CreativeRun（创意执行运行）。初始状态 pending，按 mode（chapter/segment-auto）执行多章节或分段创作。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["chapter", "segment-auto"] },
        policy: policySchema,
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "mode", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_run_get",
    description: "获取 CreativeRun 快照（run + work items + reviews + events）。支持 afterSequence 增量拉取事件。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        afterSequence: { type: "integer", minimum: 0 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_action_list",
    description: "列出 CreativeRun 当前可执行的 action 列表（根据 run 状态与 work items 状态派生）。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_action_execute",
    description: "执行 CreativeRun action（work.start/accept/revise/retry/recover/review.request/review.submit/plan.approve/run.pause/resume/cancel/work.enqueue）。plan.approve=作者确认：批准当前 work item 的 foundation 产物为规划阶段定稿（approveProjectPlanSection，actor=author），approve 后发信号唤醒 workflow 完成 accept。review.request 只返回只读审核预览；必须显式 review.submit 才会落库并参与门禁。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        action: {
          type: "string",
          enum: [
            "work.start",
            "work.accept",
            "work.revise",
            "work.retry",
            "work.recover",
            "review.request",
            "review.submit",
            "plan.approve",
            "run.pause",
            "run.resume",
            "run.cancel",
            "work.enqueue",
          ],
        },
        workItemId: { type: "string" },
        work: workInputSchema,
        instruction: { type: "string" },
        force: { type: "boolean" },
        idempotencyKey: { type: "string", minLength: 1 },
        review: reviewInputSchema,
      },
      required: ["runId", "action", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_artifact_get",
    description: "按 artifactId 获取持久化创作产物及其内容哈希、对象存储键和执行元数据。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        artifactId: { type: "string", minLength: 1 },
      },
      required: ["artifactId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_review_submit",
    description: "提交审核（review.submit）。若 run.policy.reviewGate=auto 且 gate 通过，自动 accept work item。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        workItemId: { type: "string", minLength: 1 },
        review: reviewInputSchema,
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["runId", "workItemId", "review", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_run_complete",
    description: "完成 CreativeRun。校验所有 work items 必须为 accepted 且无 blocker issue。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },

  // ===== Catalog / Receipt（3）=====

  {
    name: "novel_catalog_get",
    description: "获取项目目录（项目详情 + 文档列表 + creative runs），并行查询。支持 compact 精简模式与 documentStatus 过滤，避免大项目响应过重。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        compact: { type: "boolean", default: false, description: "true 时省略 documents 与 creativeRuns，只返回项目元数据 + latestRuns。用于快速确认项目状态" },
        documentStatus: {
          type: "array",
          items: { type: "string", enum: ["planned", "drafting", "reviewing", "final", "archived"] },
          description: "可选，按 status 过滤 documents（仅 compact=false 时生效）",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_receipt_get",
    description: "获取晋升收据（查询 promotion_receipts 表）。",
    inputSchema: {
      type: "object",
      properties: {
        receiptId: { type: "string", minLength: 1 },
      },
      required: ["receiptId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_target_get",
    description: "获取规则目标的当前版本，支持 skill 与项目级 system-prompt。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        targetKind: { type: "string", enum: ["skill", "system-prompt"] },
        targetId: { type: "string", minLength: 1 },
        version: { type: "string" },
      },
      required: ["projectId", "targetKind", "targetId"],
      additionalProperties: false,
    },
  },

  // ===== Craft Rule 候选演进（7）=====

  {
    name: "novel_rule_candidate_create",
    description: "创建规则候选：基于当前 skill/system-prompt 版本快照（beforeText）与提案文本（afterText）创建候选，校验 scope 必填字段（observedSymptom/failingLayer/underlyingMechanism/affectedInputClass）并计算 proposedVersion=nextPatchVersion(beforeVersion)。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        targetKind: { type: "string", enum: ["skill", "system-prompt"] },
        targetId: { type: "string", minLength: 1 },
        afterText: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
        scope: { type: "object", additionalProperties: true },
      },
      required: ["projectId", "targetKind", "targetId", "afterText", "rationale"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_candidate_get",
    description: "获取规则候选详情（含 scope/evidenceCases/reviews/learningSource/status 等）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_evidence_submit",
    description: "提交规则候选证据：校验 baseline/candidate work item 存在于 creative_work_items，追加到 evidenceCases 并将 status 置为 evidencing。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        scenarioClass: { type: "string", minLength: 1 },
        scenarioRole: { type: "string", enum: ["source-failure", "cross-scenario"] },
        baselineWorkItemId: { type: "string", minLength: 1 },
        candidateWorkItemId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId", "scenarioClass", "scenarioRole", "baselineWorkItemId", "candidateWorkItemId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_foundation_evaluate",
    description: "在基础阶段评估规则候选：在指定 taskKey 下分别用 beforeText/afterText 执行 LLM，对比分数和 blocker/major，并记录带场景角色的回归证据。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        taskKey: {
          type: "string",
          enum: ["project-positioning", "architecture", "characters", "worldview", "plot-design"],
        },
        scenarioClass: { type: "string", minLength: 1 },
        scenarioRole: { type: "string", enum: ["source-failure", "cross-scenario"] },
        instruction: { type: "string" },
      },
      required: ["projectId", "candidateId", "taskKey", "scenarioClass", "scenarioRole"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_review_submit",
    description: "提交规则候选审核：追加 review 到 reviews 数组，status 置为 reviewing；若 verdict=rejected 则直接置为 rejected。需要 status 已为 evidencing 或 reviewing。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1 },
        reviewerId: { type: "string", minLength: 1 },
        reviewRunId: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        provider: { type: "string" },
        promptFingerprint: { type: "string" },
        verdict: { type: "string", enum: ["passed", "revise", "rejected"] },
        summary: { type: "string", minLength: 1 },
        concerns: { type: "array", items: { type: "string" } },
      },
      required: ["projectId", "candidateId", "role", "reviewerId", "reviewRunId", "model", "verdict", "summary"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_promote",
    description: "晋升规则候选：要求原失败场景和异构场景回归证据、通过审核和未漂移目标版本；晋升后重跑证据，回归失败自动回滚。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_rule_rollback",
    description: "回滚规则候选晋升：恢复 skill/system-prompt 的 beforeText/beforeVersion，并同步更新 receipt 与候选状态。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
      },
      required: ["projectId", "candidateId"],
      additionalProperties: false,
    },
  },

  // ===== 项目生命周期（3）=====

  {
    name: "novel_project_create",
    description: "一句话创意创建小说项目。premise 作为创意核心,自动派生标题,默认自动启动 5 阶段宏观规划；逐章蓝图由故事弧在创作过程中滚动生成。autoBootstrap=false 时仅创建项目不启动规划。若需对已存在项目重新启动规划,请使用 novel_bootstrap_run。",
    inputSchema: {
      type: "object",
      properties: {
        premise: { type: "string", minLength: 1, description: "一句话创意/故事梗概(必填,作为创作核心)" },
        title: { type: "string", description: "可选,项目标题。未提供则从 premise 自动派生(取第一句前 24 字)" },
        genre: { type: "string", description: "可选,题材标签(如 玄幻/都市/言情/科幻/悬疑),用于 resolveSkillBundle 匹配 applicableGenres" },
        creativeBrief: { ...creativeBriefSchema, description: "可选,创作简报种子。用于明确读者承诺、人物核心、主题、研究与结局边界" },
        autoBootstrap: { type: "boolean", description: "是否自动启动全书规划,默认 true" },
        includeChapterPlan: { type: "boolean", description: "兼容旧客户端，当前已忽略；宏观规划不再生成固定章节表" },
        objective: { type: "string", description: "可选,bootstrap 目标。未提供则用 premise 作为 objective" },
        reviewGate: {
          type: "string",
          enum: ["manual", "auto", "none"],
          description: "可选,foundation 5 阶段审核门禁。manual=质量优先，生成后等待人工或独立审核；auto=按专属 foundation review 与 openIssues/score 自动判定；none=仅测试/调试使用，跳过质量门。未提供时默认 manual。",
        },
        progression: {
          type: "string",
          enum: ["automatic", "user-driven"],
          description: "可选,work item 推进方式。automatic=依赖就绪即自动推进(默认);user-driven=需显式请求才推进(配合 manual gate 做精细控制)",
        },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["premise", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_project_list",
    description: "列出所有项目（按 updatedAt DESC）。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },

  {
    name: "novel_project_delete",
    description: "删除项目（级联删除所有关联数据）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  // ===== 规划与创作主体（13：含一键流程 2 条，另 2 条见下"外部产出"段）=====

  {
    name: "novel_bootstrap_run",
    description: "对已存在项目启动宏观全书规划。任务链结束于 plot-design；章节蓝图由 novel_story_arc_start 按故事弧滚动生成。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        objective: { type: "string", description: "可选,规划目标。未提供则默认'完成项目基础设定与全书规划'" },
        includeChapterPlan: { type: "boolean", description: "兼容旧客户端，当前已忽略；宏观规划不再生成全书章节表" },
        reviewGate: {
          type: "string",
          enum: ["manual", "auto", "none"],
          description: "可选,foundation 5 阶段审核门禁。manual=质量优先，生成后等待人工或独立审核；auto=按专属 foundation review 与 openIssues/score 自动判定；none=仅测试/调试使用。未提供时默认 manual。",
        },
        progression: {
          type: "string",
          enum: ["automatic", "user-driven"],
          description: "可选,work item 推进方式。automatic=依赖就绪即自动推进(默认);user-driven=需显式请求才推进(配合 manual gate 做精细控制)",
        },
        focusedTaskKeys: {
          type: "array",
          items: { type: "string", enum: ["project-positioning", "architecture", "characters", "worldview", "plot-design"] },
          description: "可选,聚焦重生成：只重新生成这些阶段，其余已 approved 阶段作为 prior context 读取、不重新生成。缺省时重跑全部 5 阶段。",
        },
        revisionInstructions: {
          type: "object",
          additionalProperties: { type: "string", minLength: 1 },
          description: "可选,每阶段重生成意见：key 为 taskKey，value 为注入该阶段重新生成 prompt 的修订指令/审核意见（作者指令，优先级最高）。",
        },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_review",
    description: "启动章节审校工作流（从 review 阶段半截启动，复用正式生成的 review→revision→fact-extraction→commit 闭环）。默认 full 审校；targeted 模式按已有完整审核快照中的 issue 定向修订，仍经过正式审核、事实提取和提交门禁。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        instruction: { type: "string" },
        mode: { type: "string", enum: ["full", "targeted"], default: "full", description: "可选，full=完整审校；targeted=只修复 targetIssueIds 指定的当前快照意见" },
        targetIssueIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "targeted 模式必填，来自当前章节完整审核快照的 issue id" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "documentId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_review_issue_add",
    description: "向当前章节完整审核快照追加一条作者/架构审校意见。只写入 pending issue，不直接修改正文；随后可用 novel_chapter_review(mode=targeted) 复用正式定向修订闭环。同一机制多处时用 revisionRanges 数组一次覆盖全部段落，避免只修首段导致问题残留；paragraph 与 revisionRanges 二选一。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        severity: { type: "string", enum: ["blocker", "major", "warning"] },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        evidenceQuote: { type: "string", minLength: 1, description: "正文中的可核对证据；不填写时使用 title" },
        paragraph: { type: "integer", minimum: 1, description: "单个目标段落（1-based）；与 revisionRanges 二选一" },
        revisionRanges: { type: "array", minItems: 1, items: { type: "object", required: ["start", "end"], additionalProperties: false, properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } } }, description: "多段落修订范围（1-based，1<=start<=end）；同机制多处时全部列出" },
        suggestion: { type: "string" },
      },
      required: ["projectId", "documentId", "severity", "title"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_generate",
    description: "生成已批准故事弧中的目标章节，并走完整审核修订闭环。未提供 documentId 时选择当前故事弧最早的 planned 章节。reprocess=true 时对已定稿章节整章重出：从已批准蓝图+instruction 全新生成正文（不是修订编辑——修订通道会把重写令执行成加法；新稿仍走三审/门/提交全链，旧正式稿在批准前保持不动）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", description: "可选，当前已批准故事弧中的目标章节 document" },
        chapterTitle: { type: "string", description: "兼容旧客户端，章节标题以已批准蓝图为准" },
        instruction: { type: "string", description: "可选,章节生成指令/特殊要求" },
        reprocess: { type: "boolean", description: "可选：对定稿章节整章重出（自足重写指令必配，语义=从蓝图新生成而非编辑旧稿）。默认 false=仅 planned 章可生成" },
        changeScope: { type: "string", enum: ["mechanical-format", "local-text", "narrative"], description: "可选（E4）：变更意图档位。机械微修（黑话降噪/引号错别字/去重）用 mechanical-format，局部文本改写用 local-text——评审面按档位收窄（裁掉与该类变更无关的评审角色），结构校验与 commit gate 任何档位完整保留，非后门。缺省 narrative=全量三审" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_script_h3",
    description: "为已定稿章节生成短剧分镜剧本提示词（MiniMax H3 Ref2VA 全参考模式六段结构：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）。按场景节拍拆分为多个 10-15 秒片段，每片段一条完整提示词、可含多镜头；人物外观基线跨片段一致。只读定稿正文派生辅助产物（kind=chapter-script），不改正文、不进质量门；同一定稿内容幂等复用既有产物。需要 ToolContext.model。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1, description: "目标章节 document（须已有正式 revision 的定稿）" },
        instruction: { type: "string", description: "可选，剧本改编指令/特殊要求" },
      },
      required: ["projectId", "documentId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_story_arc_start",
    description: "依据当前宏观规划生成故事弧及整弧章节蓝图，由外部 LLM 审核并自动修订至通过；默认生成下一个顺序弧，传 arcId 则重生成既有弧（该弧已有落稿章节（documentId 已投影）时自动进入 rebase：以已定稿事实为冻结权威重建规划；仅存失败尝试遗留的孤儿蓝图时按普通重生成，不进 rebase）。",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1 }, arcId: { type: "string", description: "可选：重生成指定既有故事弧（缺省=创建下一个顺序弧）" }, authorIntent: { type: "string" } }, required: ["projectId"], additionalProperties: false },
  },
  {
    name: "novel_story_arc_get",
    description: "查询项目故事弧列表或指定故事弧、章节蓝图及当前审核状态。",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1 }, arcId: { type: "string" } }, required: ["projectId"], additionalProperties: false },
  },
  {
    name: "novel_story_arc_review",
    description: "对已有故事弧蓝图启动正式审核；失败但保留蓝图的故事弧按批次状态自动恢复：存在引用当前蓝图的 awaiting-review 批次时走 retry（重审原蓝图，不重生成），无引用当前蓝图的 awaiting-review 批次（含批次已批准或引用旧蓝图的过期批次）时走 rebase 恢复（对齐当前宏观规划重新审核修订蓝图）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        arcId: { type: "string", minLength: 1 },
        reviewPolicy: { type: "string", enum: ["manual", "auto"], default: "auto" },
      },
      required: ["projectId", "arcId"],
      additionalProperties: false,
    },
  },
  {
    name: "novel_story_arc_decision",
    description: "故事弧人工门决策（与章节门 novel_chapter_review_decision 平权）：manual 审核策略下工作流停在人工稿审批门时用本工具放行。approve=批准当前蓝图（复用正式落库+唤醒信号，审核未过时会被门禁正当拒绝）；revise=把作者修订指令送进等待中的门，系统定向修订→重审→再入门（feedback 必填，与审核意见合并，不覆盖审核器发现的问题）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        arcId: { type: "string", minLength: 1 },
        decision: { type: "string", enum: ["approve", "revise"] },
        feedback: { type: "string", description: "decision=revise 必填：作者修订指令" },
        actorId: { type: "string", description: "批准责任主体（审计用），默认 mcp-author" },
      },
      required: ["projectId", "arcId", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "novel_foreshadowing_list",
    description: "伏笔账本分流视图：按状态列出伏笔（含 overdue 判定，与架构健康告警同一谓词），供作者/外部编排者做 兑现/改写窗口/放弃 决策；兑现由正文 payoffs 账驱动，本视图只暴露三态与窗口。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["open", "fulfilled", "abandoned", "all"], default: "open" },
        limit: { type: "integer", minimum: 1, maximum: 400, default: 200 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "novel_foreshadowing_triage",
    description: "伏笔账本作者分流：abandon=放弃（open 消费面出局，规划/审校/账本不再注入）；rewrite-window=改写兑现窗口上界（只动窗口，不动描述与埋设账）。每条必须带 reason（审计轨迹），逐条幂等 skip 不炸整批；兑现动作不经此门（由章节正文事实提取的 payoffs 账驱动）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        actorId: { type: "string", minLength: 1, description: "分流责任主体（作者/编排者），必填进审计" },
        entries: {
          type: "array", minItems: 1, maxItems: 100,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1 },
              action: { type: "string", enum: ["abandon", "rewrite-window"] },
              reason: { type: "string", minLength: 1 },
              windowFrom: { type: "integer", minimum: 1 },
              windowTo: { type: "integer", minimum: 1 },
            },
            required: ["id", "action", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectId", "actorId", "entries"],
      additionalProperties: false,
    },
  },
  {
    name: "novel_story_arc_batch_start",
    description: "为当前已批准且仍在执行的故事弧规划下一批章节，或显式重试没有章节投影的失败批次；复用正式故事弧规划、审核和批次区间校验，不能跳过当前弧继续生成正文。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        arcId: { type: "string", minLength: 1 },
        reviewPolicy: { type: "string", enum: ["manual", "auto"], default: "auto" },
        retryFailed: { type: "boolean", default: false, description: "仅当最近批次为 failed 且没有章节投影时重试原区间" },
      },
      required: ["projectId", "arcId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_story_arc_orchestrate",
    description: "故事弧外部编排模式：由外部大模型或用户提供剧情编排（plotOutline），系统负责完善——对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、连续性约束与章节蓝图，再走正式弧审核→修订闭环。编排是设计意图基线，权威低于已定稿事实与作者边界；编排与事实冲突时以事实为准。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        plotOutline: { ...plotOutlineSchema, description: "外部剧情编排：objective 必填；其余为弧级设计意图。只有 objective 的编排会被拒绝，请用 novel_story_arc_start 普通模式" },
        reviewPolicy: { type: "string", enum: ["manual", "auto"], default: "auto", description: "manual=弧审核通过后等待人工/外部审批；auto=自动批准（默认，适合外部模型作为编排者驱动）" },
        authorIntent: { type: "string", description: "可选，作者整体意图说明（并入规划上下文，权威低于已定稿事实）" },
      },
      required: ["projectId", "plotOutline"],
      additionalProperties: false,
    },
  },

  // ===== 规划与创作·外部产出与 Skill 读取（2，v2 新增）=====

  {
    name: "novel_skill_get",
    description: "读取指定执行点的已解析运行时 Skill 指引文本（含 h3-video-prompt 等短剧剧本方法论），供外部 MCP 接手短剧内容产出：先读 skill 拿到方法论，再按核心创意与时长参数自行产出模型形态 JSON，最后用 novel_chapter_script_h3_submit 落库（独立短剧已改浏览器本地存储，无外部落库工具）。返回 skillText（可注入外部模型 prompt）、resolvedSkills 与 availableSkills（含各 skill 的 executionPoints，供发现合法执行点）。",
    inputSchema: {
      type: "object",
      properties: {
        executionPoint: { type: "string", description: "Skill 执行点；短剧创意脚本用 short.script，章节派生短剧用 chapter.script；其余执行点（chapter.drafting 等）亦可读取" },
        projectId: { type: "string", description: "可选；DB 源 skill 按项目过滤（workspace 源忽略）" },
      },
      required: ["executionPoint"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_script_h3_submit",
    description: "外部 MCP 接手章节派生短剧内容产出：提交为已定稿章节自行生成的模型形态剧本 JSON，系统负责零阻断组装与落库（artifacts kind=chapter-script）。需 projectId+documentId 且章节须为定稿（与系统内部生成同门禁）。read-only 派生产物，不进正文质量门。幂等：同一外部内容重放复用既有产物（指纹前缀 ext:）。与 novel_chapter_script_h3（系统内部生成）互为双轨。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1, description: "目标章节 document（须已有正式 revision 的定稿）" },
        instruction: { type: "string", description: "可选，改编指令" },
        payload: {
          type: "object",
          description: "外部模型产出的剧本 JSON（segments 结构约定见 novel_chapter_script_h3；独立短剧的外部提交已随 IndexedDB 迁移移除）",
          properties: {
            plotBeats: { type: "array" },
            characters: { type: "array" },
            segments: { type: "array" },
          },
          required: ["segments"],
          additionalProperties: true,
        },
      },
      required: ["projectId", "documentId", "payload"],
      additionalProperties: false,
    },
  },

  // ===== 评估闭环（1，v2 新增）=====

  {
    name: "novel_closed_loop_run",
    description: "执行评估闭环（snapshot → experiment → skill-iteration → candidate → promote）。需要 ToolContext.model。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        dryRun: { type: "boolean" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "documentId", "idempotencyKey"],
      additionalProperties: false,
    },
  },

  // ===== Workflow 查询（2，新增）=====

  {
    name: "novel_workflow_get",
    description: "按 workflowId 查询单个 workflow run 状态（章节生成/章节审校/故事弧规划）。返回 workflow_runs 记录 + Temporal 运行时状态。workflowId 来自 novel_chapter_generate / novel_chapter_review 的返回值。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1 },
      },
      required: ["workflowId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_workflow_list",
    description: "按 projectId 列出最新 workflow runs，按 updatedAt DESC 排序。支持 workflowType 过滤。轻量替代 novel_catalog_get 查章节生成历史。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_WORKFLOW_LIST_LIMIT },
        workflowType: { type: "string", description: "可选。常见值: novel-intent(章节生成)、chapter-review(章节审校)、story-arc-planning(故事弧规划)" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  // ===== Workflow 决策（1，新增）=====

  {
    name: "novel_chapter_review_decision",
    description: "向 chapter-review 工作流提交人工决策（approve/revise/reject/abandon），解除 manual-review-required 阻塞。工作流必须在 manual-review-required 状态，artifactId 来自 workflow payload 的 artifactId 字段。approve 需 interactive-web 来源且覆盖严重审校问题时须提供 feedback。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, description: "Temporal workflow ID（来自 novel_chapter_review / novel_chapter_generate 的返回值）" },
        artifactId: { type: "string", minLength: 1, description: "候选稿 artifact ID（来自 workflow payload 的 artifactId 字段）" },
        decision: { type: "string", enum: ["approve", "revise", "reject", "abandon"], description: "approve=定稿提交(需 interactive-web)、revise=按审核意见继续修订、reject=拒绝并保留原稿、abandon=放弃本轮修订" },
        feedback: { type: "string", description: "作者判断理由。approve 覆盖严重审校问题时必填；revise 时作为补充修订指令" },
        revisionBase: { type: "string", enum: ["current", "previous"], description: "revise 时选择修订基础：current=从当前候选稿修订、previous=从修订前原稿修订" },
        actorId: { type: "string", description: "决策责任主体署名（审计用，如 author / orchestrator:<model>）；缺省 web-author" },
      },
      required: ["workflowId", "artifactId", "decision"],
      additionalProperties: false,
    },
  },

  // ===== 上下文与产物查询（2，新增）=====

  {
    name: "novel_context_get",
    description: "获取项目当前创作上下文（事实梳理与编排依据）：宏观规划摘要、叙事状态账本、最近定稿章节记忆、开放剧情线/伏笔/承诺、规划机制反馈。外部模型在编排剧情或下达编辑指令前调用，避免与已定稿事实冲突。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        sections: {
          type: "array",
          items: { type: "string", enum: ["foundation", "recent-chapters", "narrative-state", "open-elements", "planning-feedback"] },
          description: "可选，只返回指定 section；缺省返回全部",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_artifact_list",
    description: "列出项目下的创作产物（foundation/蓝图/draft/review 等，按时间倒序），返回 artifactId 供 novel_artifact_get 阅读内容。支持 kind 过滤与 workflowId 定向（复用工作流级产物列表）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        workflowId: { type: "string", description: "可选，只返回该 workflow run 的产物" },
        kind: { type: "string", description: "可选，产物类型过滤（foundation/chapter-blueprint/draft/review 等）" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_ARTIFACT_LIST_LIMIT },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  // ===== 外部 LLM 深度参与：上下文查询与子 agent 调度（9，2026-09-08 起陆续扩至 9 条）=====

  {
    name: "novel_memory_query",
    description: "查询指定章节/purpose 的 MemoryBundle 内容——冻结事实（claims 列表）、跨章序列证据（openPromises/assetSpans/characterSpans/subjectSpans）、叙事节奏摘要（narrativeRhythm）。外部编排 LLM 在故事弧规划、章节蓝图或正文创作前调用，精确了解模型将收到哪些记忆注入，避免'凭感觉编排'。只读，不调模型，不改变状态。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", description: "目标章节文档 ID（用于计算 narrativeCutoff 防剧透；不传则返回最近全局记忆）" },
        narrativeCutoff: { type: "integer", description: "可选，叙事截止章序（默认目标章-1）；小于 1 时返回全局记忆" },
        compact: { type: "boolean", description: "true 时只返回 claims 摘要（id/title/subject）和序列证据计数，不返回完整 content 与 evidenceQuote" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_chapter_recall_report",
    description: "回述对照诊断（只读）：抽出本章\"他想起/那日/上次\"类回述句，按字符二元组相似度给出近窗各章最可能的被引原句（含章号与相似度）。机械层不判定是否矛盾、不下\"回述无据\"结论——把「凭印象回忆」变成「有原文可 diff」，判定与后续修订指令仍由审校者/作者经正式通道做。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        narrativeOrder: { type: "integer", minimum: 1, description: "被检章的叙事序（manuscript_documents.narrative_order）" },
        window: { type: "integer", minimum: 1, maximum: 40, description: "向前对照的章数，默认 12" },
      },
      required: ["projectId", "narrativeOrder"],
      additionalProperties: false,
    },
  },
  {
    name: "novel_memory_grooming_report",
    description: "生成记忆梳理诊断报告：把 active 事实账本按（规范化主体 × 规范谓词）身份槽位分组，组内给出近重复候选对（字符二元组 Dice 相似度排序）。外部编排 LLM 作为事实梳理审核者消费本报告，按文本意见契约输出梳理意见（通过=单行 PASSED；不通过=指出哪对是语义重复、哪对是状态演化需 supersedes、哪对是误提取），意见经作者确认后走既有 claim 生命周期，本工具不提供任何改库能力。只读。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_fact_candidate_queue",
    description: "事实候选积压面板（只读）：按章聚合待人工/外部裁决的 candidate 事实——数量、最长账龄、与该章可见冻结事实的积压率，附样本。外部编排 LLM 在章节收口、弧收口或定期巡检时调用，逐条裁决（approve/reject 走 novel_fact_candidate_decide），防止候选长期滞留成为事实坟场（未裁决候选不会退役既有事实，但正式事实供给被悬置）。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_fact_candidate_decide",
    description: "裁决事实候选（批量，逐条幂等检查）：approve 使候选升为 approved 并让其 supersedes 边生效（退役旧值、写入向量索引）；reject 拒绝并保留记录。reason 必填（审计轨迹：来自作者原话或外部审核意见引用）。已处理过的 claimId 不报错但标记 skipped，整批不因单条冲突中断。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        claimIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 50 },
        decision: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string", minLength: 1 },
        actorId: { type: "string", description: "裁决责任主体（如 author、orchestrator:<model>），默认 mcp-orchestrator" },
      },
      required: ["projectId", "claimIds", "decision", "reason"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_skill_query",
    description: "查询指定 execution point 的 SkillBundle——哪些 skill 将被加载到 prompt 中、每个 skill 的 promptSections 完整文本、fingerprint。外部编排 LLM 在下达编辑指令或审核意见前调用，精确了解模型将收到哪些创作指引，用于判断'这段指引是否覆盖了我要检查的方面'。只读，不调模型。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        executionPoint: { type: "string", description: "执行点（如 chapter.drafting / arc.plan / chapter.review.structure 等）" },
        role: { type: "string", description: "可选，角色过滤（writer / structural-validator 等）" },
      },
      required: ["projectId", "executionPoint"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_prompt_inspect",
    description: "审计指定模型调用的完整 StagePromptPackage——system 指令、组装后的 instruction、prompt manifest、模型响应、路由候选与 token 用量。外部编排 LLM 在诊断质量问题或优化 prompt 时调用，精确看到'模型收到了什么、返回了什么'。只读。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, description: "工作流 ID" },
        taskId: { type: "string", minLength: 1, description: "任务 ID（如 blueprint:xxx:draft 或 blueprint:xxx:review:structure）" },
      },
      required: ["workflowId", "taskId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_invocation_list",
    description: "列出项目或工作流最近的模型调用审计记录——purpose、模型、候选序号、状态、token 用量、错误分类。外部编排 LLM 在诊断质量问题或了解模型使用情况时调用。只读。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        workflowId: { type: "string", description: "可选，只返回该工作流的调用" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },

  {
    name: "novel_model_dispatch",
    description: "外部编排 LLM 主动调度一个 API 模型执行子任务（子 agent 模式）：传入 purpose 和 prompt，系统从路由配置选择候选链首位可用模型，直接调用并返回结果。不进工作流、不落 artifact、不触发审核——外部 LLM 拿到结果后自行决定是否启动正式工作流。用途：前置草稿预生成、段落改写实验、审核意见预分析。purpose 白名单限制为创作类（writing.draft / writing.revision），不允许替代审核与事实提取。",
    inputSchema: {
      type: "object",
      properties: {
        purpose: { type: "string", enum: ["writing.draft", "writing.revision"], description: "用途（决定路由到哪个模型候选链）" },
        prompt: { type: "string", minLength: 1, description: "发给模型的 prompt（外部 LLM 自行组装，可包含从 novel_memory_query / novel_skill_query 获取的上下文）" },
        system: { type: "string", description: "可选，system 指令" },
        maxTokens: { type: "integer", minimum: 1024, maximum: 128000, default: 32768 },
      },
      required: ["purpose", "prompt"],
      additionalProperties: false,
    },
  },
];
