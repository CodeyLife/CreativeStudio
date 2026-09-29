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
 * - Run / Action 主体（2）
 * - 项目观测（1，project_inspect 吸收 catalog_get 与 context_get）
 * - Craft Rule 候选演进（2）
 * - 规划与创作（8，story_arc_start 按 mode 三合一；chapter_review 吸收 issue_add）
 * - 产物与工作流观测（2，artifact_query / workflow_query 各吸收单查与列查）
 * - Workflow 决策（1，workflow_decision 合并章节门与故事弧门）
 * - 外部 LLM 深度参与（4，记忆查询/候选队列/裁决/skill 查询；
 *   明细见 tool-metadata.ts 的 TOOL_GROUPS）
 *
 * 减法记录 2026-09-24（四批）：21→20——novel_project_list（项目列表 REST `GET /v2/projects`
 * 完整同源孪生（同一 listProjects），Web 面板直执本就走 REST；项目级状态观测由
 * novel_project_inspect(view=catalog) 承载，MCP 形态是纯重复壳）。
 *
 * 减法记录 2026-09-24（三批）：29→21，净撤 8 增 0——novel_project_create（近零 MCP 调用，
 * REST/Web 创建通道在场）；story_arc_batch_start / story_arc_orchestrate 并入
 * novel_story_arc_start(mode=batch|orchestrated)；workflow_get+workflow_list 并为
 * novel_workflow_query、artifact_get+artifact_list 并为 novel_artifact_query（单查/列查
 * 同一能力面）、catalog_get+context_get 并为 novel_project_inspect(view=catalog|context)；
 * novel_chapter_review_issue_add 并入 novel_chapter_review(issues=…)（两步协议并一步）；
 * chapter_review_decision + story_arc_decision 并为 novel_workflow_decision(target 分发)。
 *
 * 减法记录 2026-09-24（二批）：41→29，净撤 12 增 1——novel_chapter_script_h3（MCP 面
 * 零调用，Web 弹窗与 REST 双入口在场）、novel_closed_loop_run（零调用，学习候选由章节
 * workflow 自动产生，REST 孪生在场）、novel_prompt_inspect / novel_invocation_list
 * （出生即坏零使用铁证，REST 孪生在场）、novel_rule_candidate_get（各推进步骤返回值
 * 携带完整 candidate）、rule_evidence_submit / rule_foundation_evaluate / rule_review_submit /
 * rule_promote / rule_rollback（整组零 MCP 调用，合并为 novel_rule_candidate_advance，
 * 与 REST 合并路由同构）、novel_review_submit（并入 action_execute(review.submit) 的
 * 自动 gate 超集）、novel_project_delete（REST 主通道）、novel_run_get（近零调用）。
 * 减法记录 2026-09-24（一批）：50→41，九项全部零真实调用——novel_action_list（run_get
 * 快照可派生）、novel_run_complete（workflow 链路已取代）、novel_receipt_get（promote/
 * rollback 返回值携带）、novel_rule_target_get（读取面由 prompt_inspect 覆盖，beforeText
 * 由 candidate_create 自动快照）、novel_skill_get（并入 novel_skill_query 的
 * availableSkills）、novel_chapter_script_h3_submit（外部提交双轨零使用）、
 * novel_memory_grooming_report / novel_chapter_recall_report（零调用诊断面）、
 * novel_model_dispatch（子 agent 调度零使用）。
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
  // Run / Action 主体（2）
  "novel_run_create",
  "novel_action_execute",
  // 项目观测（1）
  "novel_project_inspect",
  // Craft Rule 候选演进（2）
  "novel_rule_candidate_create",
  "novel_rule_candidate_advance",
  // 规划与创作（8）
  "novel_bootstrap_run",
  "novel_chapter_review",
  "novel_chapter_generate",
  "novel_story_arc_start",
  "novel_story_arc_get",
  "novel_story_arc_review",
  "novel_foreshadowing_list",
  "novel_foreshadowing_triage",
  // 产物与工作流观测（2）
  "novel_artifact_query",
  "novel_workflow_query",
  // Workflow 决策（1）
  "novel_workflow_decision",
  // 外部 LLM 深度参与：上下文查询（4）
  "novel_memory_query",
  "novel_fact_candidate_queue",
  "novel_fact_candidate_decide",
  "novel_skill_query",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// ===== 工具定义 =====

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ===== Run / Action 主体（2）=====

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




  // ===== 项目观测（1）=====

  {
    name: "novel_project_inspect",
    description: "项目观测（view 分发，2026-09-24 三批吸收 novel_catalog_get 与 novel_context_get）：view=catalog（默认）返回项目目录（项目详情+文档列表+creative runs），compact 精简/documentStatus 过滤可选；view=context 返回当前创作上下文（宏观规划摘要、叙事状态账本、最近定稿章节记忆、开放剧情线/伏笔/承诺、规划机制反馈）——外部模型在编排剧情或下达编辑指令前读取，避免与已定稿事实冲突。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        view: { type: "string", enum: ["catalog", "context"], default: "catalog", description: "catalog=项目目录；context=创作上下文（编排依据）" },
        compact: { type: "boolean", default: false, description: "仅 view=catalog：true 时省略 documents 与 creativeRuns，只返回项目元数据 + latestRuns" },
        documentStatus: { type: "array", items: { type: "string", enum: ["planned", "drafting", "reviewing", "final", "archived"] }, description: "仅 view=catalog：按 status 过滤 documents" },
        sections: { type: "array", items: { type: "string", enum: ["foundation", "recent-chapters", "narrative-state", "open-elements", "planning-feedback"] }, description: "仅 view=context：只返回指定 section；缺省返回全部" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },



  // ===== Craft Rule 候选演进（2）=====

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
    name: "novel_rule_candidate_advance",
    description: "推进规则候选生命周期——单工具按 action 分发五个人工步骤（2026-09-24 起取代五个独立工具，与 REST 合并路由同构）：evidence=提交 A/B 证据（需 scenarioClass/scenarioRole/baselineWorkItemId/candidateWorkItemId）；evaluate=基础阶段评估（需 taskKey/scenarioClass/scenarioRole，可选 instruction）；review=提交评审（需 role/reviewerId/reviewRunId/model/verdict/summary，可选 provider/promptFingerprint/concerns）；promote=晋升（含回归验证 LLM 调用）；rollback=回滚晋升。evidence/review/promote/rollback 返回值携带完整 candidate。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        candidateId: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["evidence", "evaluate", "review", "promote", "rollback"] },
        scenarioClass: { type: "string", minLength: 1 },
        scenarioRole: { type: "string", enum: ["source-failure", "cross-scenario"] },
        baselineWorkItemId: { type: "string", minLength: 1 },
        candidateWorkItemId: { type: "string", minLength: 1 },
        taskKey: { type: "string", enum: ["project-positioning", "architecture", "characters", "worldview", "plot-design"] },
        instruction: { type: "string" },
        role: { type: "string", minLength: 1 },
        reviewerId: { type: "string", minLength: 1 },
        reviewRunId: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        provider: { type: "string" },
        promptFingerprint: { type: "string" },
        verdict: { type: "string", enum: ["passed", "revise", "rejected"] },
        summary: { type: "string" },
        concerns: { type: "array", items: { type: "string" } },
      },
      required: ["projectId", "candidateId", "action"],
      additionalProperties: false,
    },
  },

  // ===== 规划与创作主体（8）=====

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
    description: "启动章节审校工作流（从 review 阶段半截启动，复用正式生成的 review→revision→fact-extraction→commit 闭环）。full=完整审校（默认）；targeted=定向修订——带 issues（新登记意见，2026-09-24 三批吸收原 novel_chapter_review_issue_add，两步协议并一步，段落号自动定位）或 targetIssueIds（引用当前完整审核快照已有 issue）。同一机制多处时用 revisionRanges 数组一次覆盖全部段落；一处 issue 只锁一个段落一个目标。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        documentId: { type: "string", minLength: 1 },
        instruction: { type: "string" },
        mode: { type: "string", enum: ["full", "targeted"], description: "缺省按入参推导：带 issues/targetIssueIds 即 targeted，否则 full" },
        issues: { type: "array", minItems: 1, maxItems: 20, description: "新登记审校意见并立即以 targeted 模式启动定向修订（与 targetIssueIds 互斥）", items: { type: "object", properties: { severity: { type: "string", enum: ["blocker", "major", "warning"] }, title: { type: "string", minLength: 1 }, description: { type: "string" }, evidenceQuote: { type: "string", minLength: 1, description: "正文中的可核对证据；不填写时使用 title" }, paragraph: { type: "integer", minimum: 1, description: "单个目标段落（1-based）；与 revisionRanges 二选一" }, revisionRanges: { type: "array", minItems: 1, items: { type: "object", required: ["start", "end"], additionalProperties: false, properties: { start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } } }, description: "多段落修订范围（1-based，1<=start<=end）" }, suggestion: { type: "string" } }, required: ["severity", "title"], additionalProperties: false } },
        targetIssueIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "引用当前章节完整审核快照已有意见（与 issues 互斥）" },
        idempotencyKey: { type: "string", minLength: 1 },
      },
      required: ["projectId", "documentId", "idempotencyKey"],
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
    name: "novel_story_arc_start",
    description: "故事弧规划三入口合一（mode 分发，2026-09-24 三批吸收 novel_story_arc_batch_start 与 novel_story_arc_orchestrate）：mode=auto（默认）依据当前宏观规划生成下一顺序弧及整弧章节蓝图，由外部 LLM 审核并自动修订至通过，传 arcId 则重生成既有弧（已有落稿章节时自动 rebase：以已定稿事实为冻结权威重建规划）；mode=batch 为当前已批准且仍在执行的故事弧规划下一批章节（需 arcId），或 retryFailed=true 重试没有章节投影的失败批次，复用正式弧规划、审核和批次区间校验；mode=orchestrated 由外部大模型或用户提供剧情编排 plotOutline（objective 必填，只有 objective 的编排会被拒绝，请用 auto 模式），系统对照冻结事实与叙事状态账本完善为规范蓝图并走正式弧审核→修订闭环——编排是设计意图基线，权威低于已定稿事实与作者边界，冲突时以事实为准。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["auto", "batch", "orchestrated"], default: "auto", description: "auto=下一顺序弧/重生成既有弧；batch=当前弧下一批章节；orchestrated=外部剧情编排" },
        arcId: { type: "string", description: "auto：重生成指定既有故事弧（缺省=创建下一个顺序弧）；batch 必填：目标故事弧" },
        authorIntent: { type: "string", description: "可选，作者整体意图说明（并入规划上下文，权威低于已定稿事实）" },
        reviewPolicy: { type: "string", enum: ["manual", "auto"], default: "auto", description: "batch/orchestrated：manual=弧审核通过后等待人工/外部审批；auto=自动批准（默认）" },
        retryFailed: { type: "boolean", default: false, description: "仅 mode=batch：仅当最近批次为 failed 且没有章节投影时重试原区间" },
        plotOutline: { ...plotOutlineSchema, description: "仅 mode=orchestrated：外部剧情编排" },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
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






  // ===== 产物与工作流观测（2）=====

  {
    name: "novel_artifact_query",
    description: "产物观测（单查/列查合一，2026-09-24 三批吸收 novel_artifact_get 与 novel_artifact_list）：带 artifactId 返回持久化创作产物及其内容哈希、对象存储键和执行元数据；带 projectId 列出项目创作产物（foundation/蓝图/draft/review 等，按时间倒序，kind 过滤与 workflowId 定向可选），返回 artifactId 供单查阅读内容。",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", minLength: 1, description: "单查：产物 ID" },
        projectId: { type: "string", minLength: 1, description: "列查：项目 ID" },
        workflowId: { type: "string", description: "仅列查：只返回该 workflow run 的产物" },
        kind: { type: "string", description: "仅列查：产物类型过滤（foundation/chapter-blueprint/draft/review 等）" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_ARTIFACT_LIST_LIMIT },
      },
      additionalProperties: false,
    },
  },

  {
    name: "novel_workflow_query",
    description: "工作流观测（单查/列查合一，2026-09-24 三批吸收 novel_workflow_get 与 novel_workflow_list）：带 workflowId 查询单个 workflow run 状态（章节生成/章节审校/故事弧规划），返回 workflow_runs 记录 + Temporal 运行时状态；带 projectId 列出最新 workflow runs（updatedAt DESC，workflowType 过滤可选），轻量替代项目观测的 catalog 视图查章节生成历史。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string", minLength: 1, description: "单查：Temporal workflow ID（来自 novel_chapter_generate / novel_chapter_review 的返回值）" },
        projectId: { type: "string", minLength: 1, description: "列查：项目 ID" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_WORKFLOW_LIST_LIMIT },
        workflowType: { type: "string", description: "仅列查。常见值: novel-intent(章节生成)、chapter-review(章节审校)、story-arc-planning(故事弧规划)" },
      },
      additionalProperties: false,
    },
  },





  // ===== Workflow 决策（1）=====

  {
    name: "novel_workflow_decision",
    description: "工作流人工门决策（2026-09-24 三批合并章节门 novel_chapter_review_decision 与故事弧门 novel_story_arc_decision，target 分发）：target=chapter-review（默认）向 chapter-review 工作流提交 approve/revise/reject/abandon，解除 manual-review-required 阻塞（workflowId+artifactId 必填；approve 需 interactive-web 来源且覆盖严重审校问题时须提供 feedback；revise 可选 revisionBase=current/previous）；target=story-arc 故事弧人工门（projectId+arcId 必填）approve=批准当前蓝图（审核未过时会被门禁正当拒绝）、revise=把作者修订指令送进等待中的门，系统定向修订→重审→再入门（feedback 必填，与审核意见合并，不覆盖审核器发现的问题）。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["chapter-review", "story-arc"], default: "chapter-review" },
        workflowId: { type: "string", minLength: 1, description: "仅 chapter-review：Temporal workflow ID（来自 novel_chapter_generate / novel_chapter_review 的返回值）" },
        artifactId: { type: "string", minLength: 1, description: "仅 chapter-review：候选稿 artifact ID（来自 workflow payload 的 artifactId 字段）" },
        projectId: { type: "string", minLength: 1, description: "仅 story-arc" },
        arcId: { type: "string", minLength: 1, description: "仅 story-arc" },
        decision: { type: "string", enum: ["approve", "revise", "reject", "abandon"], description: "chapter-review：approve/revise/reject/abandon；story-arc：approve/revise" },
        feedback: { type: "string", description: "作者判断理由/修订指令。chapter-review approve 覆盖严重审校问题时必填；story-arc revise 必填" },
        revisionBase: { type: "string", enum: ["current", "previous"], description: "仅 chapter-review revise：current=从当前候选稿修订、previous=从修订前原稿修订" },
        actorId: { type: "string", description: "决策责任主体署名（审计用，如 author / orchestrator:<model>）；缺省 web-author / mcp-author" },
      },
      additionalProperties: false,
    },
  },








  // ===== 外部 LLM 深度参与：上下文查询（4）=====

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
    description: "查询指定 execution point 的 SkillBundle——哪些 skill 将被加载到 prompt 中、每个 skill 的 promptSections 完整文本、fingerprint，另附 availableSkills（各 skill 的 executionPoints，供外部发现合法执行点）。外部编排 LLM 在下达编辑指令或审核意见前调用，精确了解模型将收到哪些创作指引，用于判断'这段指引是否覆盖了我要检查的方面'。只读，不调模型。2026-09-24 起吸收原 novel_skill_get 的发现能力。",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "可选；DB 源 skill 按项目过滤（workspace 源忽略）" },
        executionPoint: { type: "string", description: "执行点（如 chapter.drafting / arc.plan / chapter.review.structure / short.script 等）" },
        role: { type: "string", description: "可选，角色过滤（writer / structural-validator 等）" },
      },
      required: ["executionPoint"],
      additionalProperties: false,
    },
  },


];
