/**
 * V2 MCP 工具处理函数（21 个工具的 handler 实现）。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase B-2 MCP 工具网关。
 *
 * 职责：
 * - 实现 21 个工具的具体调用逻辑
 * - 路由到 creative/ + evaluation/ + postgres-repository 模块
 * - 返回标准 JSON-serializable 结果（executeTool 包装为 McpToolResponse）
 *
 * 工具分组（与 tool-definitions.ts 对齐）：
 * - Run / Action 主体（2）
 * - 项目生命周期（1）—— project_create 撤出 MCP 面（2026-09-24 三批，能力走 REST/Web）
 * - 项目观测（1）—— project_inspect 吸收 catalog_get + context_get（view=catalog|context）
 * - 产物与工作流观测（2）—— artifact_query / workflow_query 各吸收单查与列查
 * - Craft Rule 候选演进（2）
 * - 规划与创作（8）—— story_arc_start 按 mode 三合一（auto/batch/orchestrated）；
 *   chapter_review 吸收 issue_add（issues 参数直接带意见启动 targeted 审校）
 * - Workflow 决策（1）—— workflow_decision 合并章节门与故事弧门
 * - 外部 LLM 上下文查询（4）
 *
 * 与 v1 的区别：v1 用 IndexedDB + CreativeToolEnvelope，v2 全部基于
 * NovelPostgresRepository + creative/evaluation 模块。
 */
import { randomUUID } from "node:crypto";
import type { ToolHandler, ToolContext } from "./types";
import { serialContextWithAssets } from "../application/serial-context-assets";
import type {
  CreativeCommand,
  CreativeReviewInput,
  CreativeRunMode,
  CreativeRunPolicy,
  CreativeWorkKind,
  NovelIntent,
  MemoryClaim,
  SkillExecutionPoint,
} from "../protocol";
import { startNovelBootstrap } from "../application/bootstrap";
import { parseStoryArcPlotOutline, validateStoryArcPlotOutline } from "../application/story-arc";
import { DEFAULT_ARTIFACT_LIST_LIMIT, DEFAULT_WORKFLOW_LIST_LIMIT } from "./tool-definitions";
import { startStoryArcBatchPlanning, startStoryArcOrchestratedPlanning, startStoryArcPlanning, startStoryArcReview } from "../application/story-arc-workflow";
import { locateEvidenceParagraphs } from "../evidence-check";
import { CHAPTER_CHANGE_SCOPES } from "../prompts/chapter-review";
import { createConfiguredSkillProvider, resolveStageSkillBundle, SKILL_EXECUTION_POLICIES } from "../skill-runtime";
import {
  createCreativeRun,
  executeCreativeCommand,
  listCreativeRuns,
  enqueueCreativeWork,
} from "../creative";
import {
  createCraftRuleCandidate,
  recordCraftRuleEvidence,
  evaluateCraftRuleOnFoundation,
  submitCraftRuleReview,
  promoteCraftRuleCandidate,
  rollbackCraftRuleCandidate,
  type CraftRuleScopeAnalysis,
} from "../craft-rule";
import { describePromptPatchFormatWarning } from "../craft-rule/prompt-patch";

// ===== 辅助：类型断言 =====

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * 解析可选的 reviewGate / progression 入参为 bootstrap 可用的强类型值。
 *
 * 设计依据：tool-definitions.ts 中 novel_project_create / novel_bootstrap_run
 * 已暴露 reviewGate(manual|auto|none) 与 progression(automatic|user-driven)。
 * 非法值统一回退 undefined,由 startNovelBootstrap 兜底为 "none" / "automatic",
 * 避免 MCP 调用方传错枚举值时直接抛错。
 */
function parseBootstrapPolicy(args: Record<string, unknown>): {
  reviewGate?: "manual" | "auto" | "none";
  progression?: "automatic" | "user-driven";
} {
  const reviewGateRaw = asString(args.reviewGate);
  const progressionRaw = asString(args.progression);
  return {
    reviewGate:
      reviewGateRaw === "manual" || reviewGateRaw === "auto" || reviewGateRaw === "none"
        ? reviewGateRaw
        : undefined,
    progression:
      progressionRaw === "automatic" || progressionRaw === "user-driven"
        ? (progressionRaw as "automatic" | "user-driven")
        : undefined,
  };
}

/**
 * 向 creativeRunWorkflow 发 reviewSubmitted 信号,唤醒 manual-gate 等待循环。
 *
 * 设计依据(根因修复):
 * - review-gate.ts evaluateReviewGate 的 manual 分支要求 reviewer=human 且 verdict=passed 才放行;
 * - workflows.ts processWorkItem 在 manual gate 下持久等待 reviewSubmittedSignal(defineSignal<[string]>),
 *   信号 payload 是单个 workItemId 字符串;
 * - 但 submitReview(review-gate.ts)只写 creative_reviews 表,不发 Temporal 信号,
 *   导致 reviewGate=manual 的 bootstrap run 在每阶段生成后死锁——
 *   这正是"架构 5 阶段没有审核"的底层机制(MCP 层未暴露 reviewGate + 信号通道断裂)。
 *
 * 本 helper 在 review 落库后补发信号,接通 manual-gate 闭环。
 *
 * 容错:workflow 可能已 completed/cancelled(如 reviewGate=none 的旧 run),
 * getHandle().signal() 会抛 WorkflowNotFoundError 类异常;review 落库已成功,
 * 信号失败不阻塞主流程,静默吞掉即可。
 */
async function signalReviewSubmitted(ctx: ToolContext, workItemId: string): Promise<void> {
  if (!ctx.temporal) return;
  try {
    const result = await ctx.repository.pool.query<{ run_id: string }>(
      "SELECT run_id FROM creative_work_items WHERE id = $1",
      [workItemId],
    );
    const runId = result.rows[0]?.run_id;
    if (!runId) return;
    const handle = ctx.temporal.workflow.getHandle(runId);
    // 信号名 "reviewSubmitted" 与 workflows.ts reviewSubmittedSignal 定义对齐;
    // payload 为单个 workItemId 字符串(defineSignal<[string]>)。
    await handle.signal("reviewSubmitted", workItemId);
  } catch (error) {
    // workflow 已结束/不可达,或 work item 不存在——review 落库已成功,信号失败不阻塞。
    // OR-E1（product-audit-20260910 E6）禁裸吞：降级须可从日志追溯（manual-gate 死锁排查面）。
    console.warn(`[novel-v2.mcp] reviewSubmitted-signal degraded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ===== Run / Action 主体（2）=====

const novel_run_create: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const mode = asString(args.mode) as CreativeRunMode;
  const idempotencyKey = asString(args.idempotencyKey);
  if (!projectId || !mode || !idempotencyKey) {
    throw new Error("projectId/mode/idempotencyKey 必填且非空");
  }

  const policyInput = asRecord(args.policy);
  const policy: Partial<CreativeRunPolicy> | undefined = policyInput
    ? (() => {
        const result: Partial<CreativeRunPolicy> = {};
        const maxRetries = asNumber(policyInput.maxRetries);
        if (maxRetries !== undefined) result.maxRetries = maxRetries;
        if (
          policyInput.reviewGate === "manual" ||
          policyInput.reviewGate === "auto" ||
          policyInput.reviewGate === "none"
        ) {
          result.reviewGate = policyInput.reviewGate;
        }
        const autoAcceptThreshold = asNumber(policyInput.autoAcceptThreshold);
        if (autoAcceptThreshold !== undefined) result.autoAcceptThreshold = autoAcceptThreshold;
        return Object.keys(result).length > 0 ? result : undefined;
      })()
    : undefined;

  // TODO P2: payload 用于存储 objective/章节计划等业务参数，当前透传
  const payload = asRecord(args.payload) ?? {};

  const run = await createCreativeRun(ctx.repository, {
    projectId,
    mode,
    policy,
    payload,
  });

  return { run };
};

const novel_action_execute: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  const action = asString(args.action);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!runId || !action || !idempotencyKey) {
    throw new Error("runId/action/idempotencyKey 必填且非空");
  }

  // work.enqueue 不在 CreativeCommand 类型中，单独处理
  if (action === "work.enqueue") {
    const workInput = asRecord(args.work);
    if (!workInput) throw new Error("work.enqueue 需要 work 参数");
    const kind = asString(workInput.kind) as CreativeWorkKind;
    const instruction = asString(workInput.instruction);
    if (!kind || !instruction) throw new Error("work.kind 与 work.instruction 必填");

    const workItem = await enqueueCreativeWork(ctx.repository, runId, {
      kind,
      taskKey: asString(workInput.taskKey) || undefined,
      targetId: asString(workInput.targetId) || undefined,
      instruction,
      dependsOn: asStringArray(workInput.dependsOn) ?? [],
      parameters: asRecord(workInput.parameters) ?? {},
    });
    return { workItem };
  }

  // 其他 action 走 executeCreativeCommand（已含幂等检查）
  const command = buildCreativeCommand(args, runId, action, idempotencyKey);
  const result = await executeCreativeCommand(ctx.repository, command, ctx.model);

  // 落库后向 creativeRunWorkflow 发 reviewSubmitted 信号，唤醒 manual-gate 等待循环
  //（review.submit 自 2026-09-24 起是唯一 MCP 审核提交通道，独立工具已并入）。
  // reviewGate=none/auto 的 run 信号会被静默忽略。workItemId 从 command 提取；
  // review.request 仅返回只读预览，不落库也不能唤醒门禁。
  // work.accept 也需要发信号:外部 accept 命令绕过 gate 直接改状态后,
  // workflow 仍阻塞在 manual-gate while 循环;信号唤醒后 processWorkItem 检查
  // status===accepted 短路返回,让 loop 推进下游 work items。
  // plan.approve 发信号:作者确认后唤醒 workflow 重新检查 foundationAuthorApproved,
  // 满足(独立审核 passed + section approved)后自动 accept 推进。
  // work.revise / work.start / work.retry 发信号（根因修复）：外部命令只改 DB 状态，
  // workflow 的 processWorkItem 仍阻塞在旧的等待循环中，主循环 Promise.all 挂起后
  // 永远走不到"重新扫描 pending"；信号唤醒后 processWorkItem 检测到状态已变更
  //（非 running）即短路返回，主循环重新 listPendingWork 拾取被修订的 work item。
  if (
    action === "review.submit" ||
    action === "work.accept" ||
    action === "plan.approve" ||
    action === "work.revise" ||
    action === "work.start" ||
    action === "work.retry"
  ) {
    const workItemId = asString(args.workItemId);
    if (workItemId) await signalReviewSubmitted(ctx, workItemId);
  }

  return { result };
};

/**
 * 从 args 构造 CreativeCommand。
 *
 * action 已校验非空，idempotencyKey 已校验非空。
 * 根据 action 类型提取 workItemId/instruction/force/review 等字段。
 */
function buildCreativeCommand(
  args: Record<string, unknown>,
  runId: string,
  action: string,
  idempotencyKey: string,
): CreativeCommand & { runId: string } {
  const base = { runId, idempotencyKey };

  switch (action) {
    case "work.start":
    case "work.accept":
    case "work.retry":
    case "plan.approve": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error(`${action} 需要 workItemId`);
      return { type: action, workItemId, ...base } as CreativeCommand & { runId: string };
    }

    case "work.revise": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("work.revise 需要 workItemId");
      const instruction = asString(args.instruction) || undefined;
      return { type: "work.revise", workItemId, instruction, ...base };
    }

    case "work.recover": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("work.recover 需要 workItemId");
      const force = asBoolean(args.force);
      return { type: "work.recover", workItemId, force, ...base };
    }

    case "review.request": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("review.request 需要 workItemId");
      return { type: "review.request", workItemId, ...base };
    }

    case "review.submit": {
      const workItemId = asString(args.workItemId);
      if (!workItemId) throw new Error("review.submit 需要 workItemId");
      const reviewInput = asRecord(args.review);
      if (!reviewInput) throw new Error("review.submit 需要 review 参数");
      const review = parseReviewInput(reviewInput);
      return { type: "review.submit", workItemId, review, ...base };
    }

    case "run.pause":
      return { type: "run.pause", ...base };
    case "run.resume":
      return { type: "run.resume", ...base };
    case "run.cancel":
      return { type: "run.cancel", ...base };

    default:
      throw new Error(`未知的 action 类型：${action}`);
  }
}

/**
 * 解析 review input（从 args.record 转 CreativeReviewInput）。
 *
 * 校验 reviewer/verdict 在合法枚举内，issues 是数组。
 */
function parseReviewInput(input: Record<string, unknown>): CreativeReviewInput {
  const subjectArtifactId = asString(input.subjectArtifactId);
  const reviewer = asString(input.reviewer);
  const verdict = asString(input.verdict);
  const summary = asString(input.summary);

  if (!subjectArtifactId) throw new Error("review.subjectArtifactId 必填");
  if (reviewer !== "internal" && reviewer !== "independent" && reviewer !== "human") {
    throw new Error(`review.reviewer 非法：${reviewer}`);
  }
  if (verdict !== "passed" && verdict !== "revise" && verdict !== "blocked") {
    throw new Error(`review.verdict 非法：${verdict}`);
  }
  if (!Array.isArray(input.issues)) throw new Error("review.issues 必须是数组");
  if (typeof summary !== "string") throw new Error("review.summary 必须是字符串");

  return {
    subjectArtifactId,
    reviewer,
    verdict,
    issues: input.issues as CreativeReviewInput["issues"],
    summary,
  };
}

/**
 * 产物观测（单查/列查合一，2026-09-24 三批吸收 novel_artifact_get + novel_artifact_list）：
 * artifactId 传入=单查持久化产物全文；否则 projectId 必填走列表（workflowId 定向复用
 * listRunArtifacts，其余项目级列表 kind 可过滤）——外部模型先定位 artifactId 再读内容。
 */
const novel_artifact_query: ToolHandler = async (args, ctx) => {
  const artifactId = asString(args.artifactId);
  if (artifactId) {
    const artifact = await ctx.repository.getArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact 不存在：${artifactId}`);
    return { artifact };
  }

  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("artifactId 与 projectId 必须提供其一");
  const workflowId = asString(args.workflowId) || undefined;
  const kind = asString(args.kind) || undefined;
  const limit = asNumber(args.limit) ?? DEFAULT_ARTIFACT_LIST_LIMIT;

  const artifacts = workflowId
    ? await ctx.repository.listRunArtifacts(workflowId)
    : await ctx.repository.listProjectArtifacts({ projectId, kind, limit });

  return {
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      taskId: artifact.taskId,
      fingerprint: artifact.fingerprint,
      createdAt: artifact.createdAt,
      objectKey: artifact.objectKey,
    })),
    count: artifacts.length,
    nextAction: "带 artifactId 再次调用 novel_artifact_query 阅读产物内容",
  };
};


// ===== 项目观测（1）=====

/**
 * 项目观测（view 分发，2026-09-24 三批吸收 novel_catalog_get + novel_context_get）：
 * view=catalog（默认）返回项目目录（项目详情+文档列表+creative runs，compact/documentStatus 可选）；
 * view=context 返回当前创作上下文（宏观规划摘要、叙事状态账本、最近定稿章节记忆、
 * 开放线索/伏笔/承诺、规划机制反馈）——外部模型在编排剧情或下达编辑指令前读取，
 * 避免与已定稿事实冲突。context 复用 getStoryArcPlanningInput 的上下文组装（同一投影）。
 */
const novel_project_inspect: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");
  const view = asString(args.view) || "catalog";
  if (view !== "catalog" && view !== "context") throw new Error("view 必须是 catalog 或 context");

  if (view === "catalog") {
    const compact = asBoolean(args.compact) ?? false;
    const documentStatus = asStringArray(args.documentStatus);

    if (compact) {
      // 精简模式：只返回项目元数据 + latestRuns，省略 documents 与 creativeRuns
      // 响应从 32KB+ 降到 ~2KB，用于快速确认项目状态
      const project = await ctx.repository.getProjectDetail(projectId);
      return { project: { ...project, documents: [] } };
    }

    // 完整模式：并行查询项目详情 + creative runs
    const [project, runs] = await Promise.all([
      ctx.repository.getProjectDetail(projectId),
      listCreativeRuns(ctx.repository, projectId),
    ]);

    // documentStatus 过滤在 handler 层（getProjectDetail 不支持参数）
    // TODO P2: repository 层加 documentStatus 参数，避免拉取多余 document 行
    const filteredDocuments = documentStatus
      ? project.documents.filter((d) => documentStatus.includes(d.status))
      : project.documents;

    return {
      project: { ...project, documents: filteredDocuments },
      creativeRuns: runs,
    };
  }

  const sections = asStringArray(args.sections);

  const planning = await ctx.repository.getStoryArcPlanningInput(projectId);

  const all: Record<string, unknown> = {
    projectTitle: planning.projectTitle,
    narrativeCutoff: planning.contextReceipt.narrativeCutoff ?? null,
    contextFingerprint: planning.contextReceipt.fingerprint,
    foundation: planning.macro,
    recentChapters: planning.recentChapters,
    narrativeState: planning.narrativeState ?? null,
    openThreads: planning.openThreads,
    openForeshadowings: planning.openForeshadowings ?? [],
    openPromises: planning.openPromises ?? [],
    planningFeedback: planning.planningFeedback ?? [],
    plotOutline: planning.plotOutline ?? null,
  };
  // 外部 LLM 深度参与增强（2026-09-08）：序列证据 + 最近模型调用摘要。
  // OR-E1（product-audit-20260910 E6）：两块增强独立降级并把失败显式记入 enhancementErrors[]——
  // 此前合并成单个裸 catch 全吞，坏 SQL（不存在的列）曾借此"恒静默丢字段"长期无人发现。
  const enhancementErrors: string[] = [];
  try {
    // target 必须是"真能被序列证据当锚点用"的定稿章。此前这里传 documentId=""（想当然按
    // max(narrative_order) 取 cutoff），rhythm 查询绑该值必 0 行 ⇒ 整个增强块恒缺且不报错。
    const target = await ctx.repository.getLatestFinalChapterTarget(projectId);
    if (target) {
      const loaded = await ctx.repository.getSerialContextSnapshot(projectId, target.documentId, target.narrativeOrder);
      if (loaded) {
        // 资产账本要读正文：与生成链路同一份实现，避免 MCP 侧另起一径又留下空账本。
        const attached = await serialContextWithAssets(loaded, projectId, {
          getChapterContentRefs: (id, orders) => ctx.repository.getChapterContentRefsByOrders(id, orders),
          getText: ctx.objects ? (key) => ctx.objects!.getText(key) : undefined,
        });
        if (attached.degradation) enhancementErrors.push(attached.degradation);
        const serialContext = attached.snapshot;
        all.serialContext = {
          window: serialContext.window,
          openPromises: serialContext.openPromises ?? [],
          assetSpans: (serialContext.assetSpans ?? []).slice(0, 8),
          characterSpans: serialContext.characterSpans.slice(0, 5),
          subjectSpans: serialContext.subjectSpans.slice(0, 8),
        };
      } else {
        // 解析得到目标章却拿不到快照＝断链，必须可见；旧实现这里静默缺字段无人知。
        enhancementErrors.push(`serialContext: 目标章 ${target.documentId}（第${target.narrativeOrder}章）已解析但序列证据快照为空`);
      }
    }
  } catch (error) {
    enhancementErrors.push(`serialContext: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const recentInvocations = await ctx.repository.pool.query(
      `SELECT purpose, model, status, provider_input_tokens, provider_output_tokens, latency_ms, error_category, created_at FROM model_invocations WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [projectId],
    );
    all.recentModelInvocations = recentInvocations.rows;
  } catch (error) {
    enhancementErrors.push(`recentModelInvocations: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (enhancementErrors.length) all.enhancementErrors = enhancementErrors;
  if (!sections?.length) return all;

  const allowed = new Set(["foundation", "recent-chapters", "narrative-state", "open-elements", "planning-feedback"]);
  const selected: Record<string, unknown> = { projectTitle: planning.projectTitle, narrativeCutoff: all.narrativeCutoff, contextFingerprint: all.contextFingerprint };
  if (sections.includes("foundation")) selected.foundation = all.foundation;
  if (sections.includes("recent-chapters")) selected.recentChapters = all.recentChapters;
  if (sections.includes("narrative-state")) selected.narrativeState = all.narrativeState;
  if (sections.includes("open-elements")) {
    selected.openThreads = all.openThreads;
    selected.openForeshadowings = all.openForeshadowings;
    selected.openPromises = all.openPromises;
  }
  if (sections.includes("planning-feedback")) {
    selected.planningFeedback = all.planningFeedback;
    selected.plotOutline = all.plotOutline;
  }
  const unknown = sections.filter((item) => !allowed.has(item));
  if (unknown.length) throw new Error(`sections 含未知项：${unknown.join("、")}`);
  return selected;
};

// ===== Craft Rule 候选演进（2）=====

const novel_rule_candidate_create: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const targetKind = asString(args.targetKind) as "skill" | "system-prompt";
  const targetId = asString(args.targetId);
  const afterText = asString(args.afterText);
  const rationale = asString(args.rationale);
  if (!projectId || !targetKind || !targetId || !afterText || !rationale) {
    throw new Error("projectId/targetKind/targetId/afterText/rationale 必填且非空");
  }
  const scopeInput = asRecord(args.scope) ?? {};
  const scope: CraftRuleScopeAnalysis = {
    observedSymptom: asString(scopeInput.observedSymptom) ?? "",
    failingLayer: asString(scopeInput.failingLayer) ?? "",
    underlyingMechanism: asString(scopeInput.underlyingMechanism) ?? "",
    affectedInputClass: asString(scopeInput.affectedInputClass) ?? "",
    intendedBenefits: Array.isArray(scopeInput.intendedBenefits) ? scopeInput.intendedBenefits as string[] : [],
    boundaries: Array.isArray(scopeInput.boundaries) ? scopeInput.boundaries as string[] : [],
    nonGoals: Array.isArray(scopeInput.nonGoals) ? scopeInput.nonGoals as string[] : [],
    regressionRisks: Array.isArray(scopeInput.regressionRisks) ? scopeInput.regressionRisks as string[] : [],
  };
  const candidate = await createCraftRuleCandidate(ctx.repository, {
    projectId, targetKind, targetId, afterText, rationale, scope,
  });
  // afterText 格式兼容性告警（2026-09-11 实证）：多执行点 skill 快照 + 纯文本
  // afterText 会在 promote 时整体覆盖 drafting 段——创建时即提示，避免僵尸候选。
  const formatWarning = describePromptPatchFormatWarning(candidate.beforeText, afterText);
  return { candidate, ...(formatWarning ? { formatWarning } : {}) };
};

/**
 * 规则候选推进（2026-09-24 合并 evidence_submit / foundation_evaluate / review_submit /
 * promote / rollback 五个独立工具为单工具 action 分发，与 REST 合并路由
 * /v2/projects/:id/craft-rule-candidates/:id/* 同构）。每步返回值携带完整 candidate，
 * 事后重读走 novel_rule_candidate_advance 之外的 REST 读取面。
 */
const novel_rule_candidate_advance: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const action = asString(args.action);
  if (!projectId || !candidateId || !action) {
    throw new Error("projectId/candidateId/action 必填且非空");
  }

  if (action === "evidence") {
    const scenarioClass = asString(args.scenarioClass);
    const scenarioRole = asString(args.scenarioRole) as "source-failure" | "cross-scenario";
    const baselineWorkItemId = asString(args.baselineWorkItemId);
    const candidateWorkItemId = asString(args.candidateWorkItemId);
    if (!scenarioClass || !scenarioRole || !baselineWorkItemId || !candidateWorkItemId) {
      throw new Error("action=evidence 需要 scenarioClass/scenarioRole/baselineWorkItemId/candidateWorkItemId");
    }
    const candidate = await recordCraftRuleEvidence(ctx.repository, {
      projectId, candidateId, scenarioClass, scenarioRole, baselineWorkItemId, candidateWorkItemId,
    });
    return { candidate };
  }

  if (action === "evaluate") {
    const taskKey = asString(args.taskKey) as
      | "project-positioning" | "architecture" | "characters"
      | "worldview" | "plot-design";
    const scenarioClass = asString(args.scenarioClass);
    const scenarioRole = asString(args.scenarioRole) as "source-failure" | "cross-scenario";
    const instruction = asString(args.instruction) || undefined;
    if (!taskKey || !scenarioClass || !scenarioRole) {
      throw new Error("action=evaluate 需要 taskKey/scenarioClass/scenarioRole");
    }
    if (!ctx.model) throw new Error("novel_rule_candidate_advance(evaluate) 需要 ctx.model");
    return evaluateCraftRuleOnFoundation(ctx.repository, ctx.model, {
      projectId, candidateId, taskKey, scenarioClass, scenarioRole, instruction,
    });
  }

  if (action === "review") {
    const role = asString(args.role);
    const reviewerId = asString(args.reviewerId);
    const reviewRunId = asString(args.reviewRunId);
    const model = asString(args.model);
    const provider = asString(args.provider) || undefined;
    const promptFingerprint = asString(args.promptFingerprint) || undefined;
    const verdict = asString(args.verdict) as "passed" | "revise" | "rejected";
    const summary = asString(args.summary);
    const concerns = asStringArray(args.concerns) ?? [];
    if (!role || !reviewerId || !reviewRunId || !model || !verdict || !summary) {
      throw new Error("action=review 需要 role/reviewerId/reviewRunId/model/verdict/summary");
    }
    const candidate = await submitCraftRuleReview(ctx.repository, {
      projectId, candidateId, role, reviewerId, reviewRunId, model, provider, promptFingerprint,
      verdict, summary, concerns,
    });
    return { candidate };
  }

  if (action === "promote") {
    if (!ctx.model) throw new Error("novel_rule_candidate_advance(promote) 需要 ctx.model（用于回归验证 LLM 调用）");
    const { candidate, receipt, regressionVerified, regressionDetails } = await promoteCraftRuleCandidate(
      ctx.repository,
      ctx.model,
      { projectId, candidateId },
    );
    return { candidate, receipt, regressionVerified, regressionDetails };
  }

  if (action === "rollback") {
    if (!ctx.model) throw new Error("novel_rule_candidate_advance(rollback) 需要 ctx.model（保持接口对称，便于未来扩展）");
    const { candidate, receiptId } = await rollbackCraftRuleCandidate(
      ctx.repository,
      ctx.model,
      { projectId, candidateId },
    );
    return { candidate, receiptId };
  }

  throw new Error("action 只能是 evidence/evaluate/review/promote/rollback");
};

// ===== 规划与创作（8）=====

const novel_bootstrap_run: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!projectId || !idempotencyKey) throw new Error("projectId/idempotencyKey 必填且非空");

  const objective = asString(args.objective) || "完成基础+规划阶段";
  // includeChapterPlan 仅保留旧客户端兼容，startNovelBootstrap 会忽略该值。
  const includeChapterPlan = asBoolean(args.includeChapterPlan) ?? true;
  // 解析 reviewGate/progression,使 foundation 5 阶段支持人工审核门禁(架构阶段必备)。
  // 未提供时由 startNovelBootstrap 兜底为质量优先的 manual / automatic。
  const { reviewGate, progression } = parseBootstrapPolicy(args);
  // 聚焦重生成：只重跑白名单阶段，其余 approved 阶段作为 prior context。
  const focusedTaskKeys = asStringArray(args.focusedTaskKeys)?.filter(Boolean) as
    | Array<"project-positioning" | "architecture" | "characters" | "worldview" | "plot-design">
    | undefined;
  const revisionInstructions = asRecord(args.revisionInstructions) as Record<string, string> | undefined;

  if (!ctx.temporal) throw new Error("novel_bootstrap_run 需要 ToolContext.temporal 才能启动 Temporal 工作流");
  return startNovelBootstrap(ctx.repository, ctx.temporal, {
    projectId,
    objective,
    idempotencyKey,
    includeChapterPlan,
    reviewGate,
    progression,
    taskQueue: ctx.taskQueue,
    focusedTaskKeys,
    revisionInstructions,
  });
};

/**
 * 故事弧规划三入口合一（2026-09-24 三批：吸收原 novel_story_arc_batch_start 与
 * novel_story_arc_orchestrate，按 mode 分发）：
 * - auto（默认）：生成下一个顺序弧蓝图；arcId 传入=重生成既有弧（底层自动 rebase 判定）。
 * - batch：为当前已批准且仍在执行的弧规划下一批章节，或显式重试没有章节投影的失败批次
 *   （retryFailed）；复用正式弧规划、审核和批次区间校验，不能跳过当前弧继续生成正文。
 * - orchestrated（模式 B）：外部大模型或用户提供剧情编排（plotOutline），系统负责完善为
 *   规范蓝图并走正式弧审核→修订闭环；编排是设计意图基线，权威低于已定稿事实与作者边界。
 * 解析与校验在 handler 层执行（parse 拒绝结构错误、validate 拒绝空编排与重复责任线）。
 */
const novel_story_arc_start: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");
  if (!ctx.temporal) throw new Error("novel_story_arc_start 需要 Temporal");
  const mode = asString(args.mode) || "auto";
  if (mode !== "auto" && mode !== "batch" && mode !== "orchestrated") {
    throw new Error("mode 必须是 auto/batch/orchestrated");
  }
  const reviewPolicyRaw = asString(args.reviewPolicy);
  if (reviewPolicyRaw && reviewPolicyRaw !== "manual" && reviewPolicyRaw !== "auto") {
    throw new Error("reviewPolicy 必须是 manual 或 auto");
  }
  const reviewPolicy = reviewPolicyRaw as "manual" | "auto" | undefined;

  if (mode === "batch") {
    const arcId = asString(args.arcId);
    if (!arcId) throw new Error("mode=batch 需要 arcId（为当前已批准弧规划下一批章节）");
    return startStoryArcBatchPlanning(ctx.repository, ctx.temporal, {
      projectId,
      arcId,
      mode: "mcp",
      reviewPolicy,
      retryFailed: args.retryFailed === true,
      taskQueue: ctx.taskQueue,
    });
  }

  if (mode === "orchestrated") {
    const plotOutline = parseStoryArcPlotOutline(args.plotOutline);
    validateStoryArcPlotOutline(plotOutline);
    return startStoryArcOrchestratedPlanning(ctx.repository, ctx.temporal, {
      projectId,
      plotOutline,
      mode: "mcp",
      reviewPolicy,
      authorIntent: asString(args.authorIntent) || undefined,
      taskQueue: ctx.taskQueue,
    });
  }

  // mode=auto：arcId 传入时重生成既有弧（底层自动 rebase 判定），缺省创建下一顺序弧。
  return startStoryArcPlanning(ctx.repository, ctx.temporal, { projectId, arcId: asString(args.arcId) || undefined, mode: "mcp", authorIntent: asString(args.authorIntent) || undefined, taskQueue: ctx.taskQueue });
};

const novel_story_arc_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const arcId = asString(args.arcId);
  if (!projectId) throw new Error("projectId 必填");
  return arcId ? { arc: await ctx.repository.getStoryArc(projectId, arcId) } : { arcs: await ctx.repository.listStoryArcs(projectId) };
};

/**
 * 伏笔账本分流（弧6 收口实践抓出的工具缺口）：health 的 foreshadowing-overdue 告警
 * 一直指示作者"兑现/改写窗口/放弃"三选一，但兑现走正文账、后两者全系统无通道，
 * 告警在指挥作者做不存在的操作。list 给分流决策所需的三态视图（含 overdue 同源判定），
 * triage 只写终局决定：abandon（open 消费面出局）与 rewrite-window（只动窗口不动埋设账），
 * 两者都必须带 reason（审计），逐条幂等 skip 不炸整批。
 */
const novel_foreshadowing_list: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");
  const status = asString(args.status) || "open";
  if (!["open", "fulfilled", "abandoned", "all"].includes(status)) throw new Error("status 必须是 open/fulfilled/abandoned/all");
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 400)) throw new Error("limit 必须是 1..400 的整数");
  const rows = await ctx.repository.listForeshadowingForTriage(projectId, { status: status as "open", ...(limit ? { limit } : {}) });
  return { projectId, status, count: rows.length, foreshadowings: rows };
};

const novel_foreshadowing_triage: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const actorId = asString(args.actorId);
  if (!projectId || !actorId) throw new Error("projectId/actorId 必填且非空");
  if (!Array.isArray(args.entries) || !args.entries.length) throw new Error("entries 必须是非空数组");
  const entries: Array<{ id: string; action: "abandon" | "rewrite-window"; reason: string; windowFrom?: number; windowTo?: number }> = [];
  for (const raw of args.entries as unknown[]) {
    if (!raw || typeof raw !== "object") throw new Error("entries 每项必须是对象");
    const e = raw as Record<string, unknown>;
    const id = asString(e.id); const action = asString(e.action); const reason = asString(e.reason);
    if (!id) throw new Error("entries 每项必须含 id");
    if (action !== "abandon" && action !== "rewrite-window") throw new Error("action 只能是 abandon/rewrite-window（兑现走正文 payoffs，不经此门）");
    if (!reason.trim()) throw new Error("分流是作者终局决定，reason 必填");
    entries.push({ id, action, reason, ...(typeof e.windowFrom === "number" ? { windowFrom: e.windowFrom } : {}), ...(typeof e.windowTo === "number" ? { windowTo: e.windowTo } : {}) });
  }
  return ctx.repository.triageForeshadowing({ projectId, actorId, entries });
};

const novel_story_arc_review: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const arcId = asString(args.arcId);
  if (!projectId || !arcId) throw new Error("projectId/arcId 必填且非空");
  if (!ctx.temporal) throw new Error("novel_story_arc_review 需要 Temporal");

  const reviewPolicy = asString(args.reviewPolicy);
  if (reviewPolicy && reviewPolicy !== "manual" && reviewPolicy !== "auto") {
    throw new Error("reviewPolicy 必须是 manual 或 auto");
  }
  return startStoryArcReview(ctx.repository, ctx.temporal, {
    projectId,
    arcId,
    mode: "mcp",
    reviewPolicy: reviewPolicy as "manual" | "auto" | undefined,
    taskQueue: ctx.taskQueue,
  });
};

const novel_chapter_generate: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!projectId || !idempotencyKey) throw new Error("projectId/idempotencyKey 必填且非空");
  if (!ctx.temporal) throw new Error("novel_chapter_generate 需要 ToolContext.temporal 才能启动 Temporal 工作流");

  const documentId = asString(args.documentId) || undefined;
  const instruction = asString(args.instruction) || undefined;

  // 1. 前置检查:校验 foundation artifacts 包含必填 taskKey。
  // 设计依据:AGENTS.md「root-cause analysis」——v2 重构后章节生成不基于全书规划,
  // 此处在 MCP 入口层强制"先规划再写章节"。workflow 层也有同样的检查(双保险)。
  await ctx.repository.assertRequiredPlanApproved(projectId);

  // 2. 未指定章节时，从当前已批准故事弧中选择下一个 planned 文档。
  let targetDocumentId = documentId;
  if (!targetDocumentId) {
    const document = await ctx.repository.findNextPlannedArcDocument(projectId);
    if (!document) throw new Error("没有已批准故事弧中的待创作章节，请先完成故事弧规划和审核");
    targetDocumentId = document.id;
  } else if (args.reprocess !== true) {
    // 生成与重审是互斥生命周期；仓储层同时按 status/current revision 防御陈旧蓝图投影。
    // reprocess=true 为定稿整章重出通道（ch51 双通道证伪后定案）：绕过 planned-only 闸门，
    // 但下游 draft→三审→门→commit 全链与幂等/基线守卫一律不变，旧正式稿批准前不动。
    await ctx.repository.assertChapterGenerationAllowed(projectId, targetDocumentId);
  }
  await ctx.repository.getChapterPlanningContext(projectId, targetDocumentId);

  // 3. 创建 NovelIntent:target.kind="chapter" 触发 classify 返回 drafting
  const changeScope = asString(args.changeScope) || undefined;
  if (changeScope && !CHAPTER_CHANGE_SCOPES.includes(changeScope as (typeof CHAPTER_CHANGE_SCOPES)[number])) {
    throw new Error(`changeScope 必须为 ${CHAPTER_CHANGE_SCOPES.join("/")}`);
  }
  const intent: NovelIntent = {
    id: randomUUID(),
    projectId,
    source: "mcp",
    objective: instruction || `生成章节正文(${targetDocumentId})`,
    target: { kind: "chapter", id: targetDocumentId },
    constraints: instruction ? [instruction] : undefined,
    reprocess: args.reprocess === true || undefined,
    changeScope: changeScope as NovelIntent["changeScope"],
    createdAt: Date.now(),
    idempotencyKey,
  };
  const stored = await ctx.repository.putIntent(intent);

  // 4. 落库 WorkflowRun + 启动 Temporal workflow
  // 与 novel_chapter_review / HTTP /v2/intents 入口对齐:workflow_runs.id = workflowId
  const workflowId = `novel-intent-${stored.id}`;
  await ctx.repository.putWorkflowRun({
    id: workflowId,
    workflowType: "novel-intent",
    projectId: stored.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { intent: stored, intentId: stored.id, documentId: targetDocumentId, source: "novel_chapter_generate" },
  });
  const handle = await ctx.temporal.workflow.start("novelIntentWorkflow", {
    args: [stored, workflowId],
    taskQueue: ctx.taskQueue ?? "creative-studio-novel-v2",
    workflowId,
  });

  return {
    workflowId,
    temporalRunId: handle.firstExecutionRunId,
    documentId: targetDocumentId,
    intentId: stored.id,
    status: "accepted",
    nextAction: "调用 novel_workflow_query({ workflowId }) 查询生成进度",
  };
};

type ReviewIssueInput = {
  severity?: unknown; title?: unknown; description?: unknown; evidenceQuote?: unknown;
  paragraph?: unknown; revisionRanges?: unknown; suggestion?: unknown;
};

/**
 * 追加章节审校意见（2026-09-24 三批吸收原 novel_chapter_review_issue_add）：
 * 只写入 pending issue，不直接修改正文；随后必须以 targeted 模式启动定向修订闭环。
 * 段落号自动定位（2026-09-08）：用 evidenceQuote 反查正文中全部命中段落，校正
 * 编辑器行号/非空行序错位（实证：ch15 定向修订因行号 vs 段落号错位放置到无关段落）。
 * 定位成功时 paragraph 与 revisionRanges 一律以定位结果为准；无法定位时保留调用方传入值。
 */
async function appendReviewIssue(ctx: ToolContext, projectId: string, documentId: string, raw: ReviewIssueInput) {
  const severity = asString(raw.severity) as "blocker" | "major" | "warning";
  const title = asString(raw.title);
  if (!severity || !title) throw new Error("issues 每项必须含 severity/title");
  if (severity !== "blocker" && severity !== "major" && severity !== "warning") throw new Error("severity 必须是 blocker/major/warning");
  let paragraph = asNumber(raw.paragraph);
  if (paragraph !== undefined && (!Number.isInteger(paragraph) || paragraph < 1)) throw new Error("paragraph 必须是正整数");
  const rawRanges = raw.revisionRanges;
  let revisionRanges = Array.isArray(rawRanges)
    ? rawRanges.map((range) => {
        if (!range || typeof range !== "object" || Array.isArray(range)) throw new Error("revisionRanges 每项必须是 {start,end} 对象");
        const start = asNumber((range as Record<string, unknown>).start);
        const end = asNumber((range as Record<string, unknown>).end);
        if (start === undefined || end === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error("revisionRanges 的 start/end 必须是满足 1<=start<=end 的整数");
        return { start, end };
      })
    : undefined;
  if (revisionRanges?.length && paragraph !== undefined) throw new Error("paragraph 与 revisionRanges 不能同时提供，使用 revisionRanges 表达多段落范围");
  let locatedNote: string | undefined;
  try {
    {
      const content = await ctx.repository.getFinalDocumentContentRef(projectId, documentId);
      const evidenceQuote = asString(raw.evidenceQuote) || title;
      if (content?.objectKey && ctx.objects) {
        const plainText = await ctx.objects.getText(content.objectKey);
        const located = locateEvidenceParagraphs(plainText, evidenceQuote);
        if (located.length) {
          const before = JSON.stringify({ paragraph, revisionRanges });
          paragraph = located[0];
          revisionRanges = located.map((value) => ({ start: value, end: value }));
          locatedNote = `段落号自动定位：${before} → paragraph=${paragraph}, revisionRanges=${JSON.stringify(revisionRanges)}`;
        }
      }
    }
  } catch (error) { /* 定位失败不阻塞登记，保留调用方传入值 */
    // OR-E1 禁裸吞：自动定位降级留痕（审查者需知道传的是手填值而非定位值）。
    console.warn(`[novel-v2.mcp] issue-paragraph-locator degraded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const issue = await ctx.repository.addChapterReviewIssue({
    projectId,
    documentId,
    severity,
    title,
    description: asString(raw.description) || undefined,
    evidenceQuote: asString(raw.evidenceQuote) || undefined,
    paragraph,
    revisionRanges,
    suggestion: asString(raw.suggestion) || undefined,
  });
  return { issue, ...(locatedNote ? { locatedNote } : {}) };
}

const novel_chapter_review: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");
  if (!ctx.temporal) throw new Error("novel_chapter_review 需要 ToolContext.temporal 才能启动 Temporal 工作流");

  const instruction = asString(args.instruction) || undefined;
  const rawIssues = Array.isArray(args.issues) ? (args.issues as ReviewIssueInput[]) : [];
  const targetIssueIds = asStringArray(args.targetIssueIds) ?? [];
  if (rawIssues.length && targetIssueIds.length) throw new Error("issues 与 targetIssueIds 不能同时提供：issues=新登记意见并定向修订，targetIssueIds=引用当前快照已有意见");
  // mode 省略时按入参推导：带 issues 即 targeted，否则 full。
  const mode = asString(args.mode) || (rawIssues.length ? "targeted" : "full");
  if (mode !== "full" && mode !== "targeted") throw new Error("章节审校 mode 必须为 full 或 targeted");
  if (mode === "targeted" && !targetIssueIds.length && !rawIssues.length) throw new Error("targeted 章节审校必须提供 targetIssueIds 或 issues");
  if (mode === "full" && (targetIssueIds.length || rawIssues.length)) throw new Error("full 章节审校不能提供 targetIssueIds/issues，请使用 targeted 模式");
  const idempotencyKey = asString(args.idempotencyKey) ?? `${projectId}:${documentId}:review:${Date.now()}`;

  // 校验 document 存在 + status="final"（AGENTS.md 契约：仅对已定稿章节开放重审）
  const preflight = await ctx.repository.getChapterReviewPreflight(projectId, documentId);
  if (!preflight) throw new Error(`章节不存在：${documentId}`);
  if (preflight.status !== "final") throw new Error("章节审校仅对已定稿章节开放");
  if (preflight.activeWorkflowId) throw new Error(`该章节已有活跃审校工作流：${preflight.activeWorkflowId}`);
  if (!preflight.hasBlueprint) throw new Error("找不到该章节的历史 blueprint artifact，无法启动章节审校");
  // 项目级串行约束：同项目其他章节的活跃 chapter-review 会先 commit 提升项目基线，
  // 使本工作流 commit 失败（"正式稿基线已变化"）。启动时提示调用方串行等待。
  const projectActiveReviewWorkflowId = preflight.projectActiveReviewWorkflowId;
  if (projectActiveReviewWorkflowId) {
    throw new Error(`该项目已有其他章节的活跃审校工作流（${projectActiveReviewWorkflowId}），并发审校会因项目基线变化导致提交失败；请等待其完成后再启动本审校`);
  }

  // issues 两步协议并一步（2026-09-24 三批）：先逐条登记 pending issue（含段落号自动
  // 定位），再以登记结果作为 targetIssueIds 启动 targeted 审校；单条登记失败即整体中止，
  // 不带半截意见进修订环。
  const locatedNotes: string[] = [];
  const registeredIssueIds: string[] = [];
  for (const raw of rawIssues) {
    const { issue, locatedNote } = await appendReviewIssue(ctx, projectId, documentId, raw);
    registeredIssueIds.push(issue.id);
    if (locatedNote) locatedNotes.push(locatedNote);
  }
  const effectiveTargetIssueIds = mode === "targeted" ? (targetIssueIds.length ? targetIssueIds : registeredIssueIds) : [];

  const workflowId = `chapter-review-${documentId}-${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`.slice(0, 200);
  const params = { projectId, documentId, instruction, workflowId, mode: mode as "full" | "targeted", targetIssueIds: mode === "targeted" ? effectiveTargetIssueIds : undefined };
  // workflow_runs.id 必须等于 workflowId：chapterReviewWorkflow 全程用 workflowId 作 workflowRunId
  // （updateTaskAttempt / draft / review / revise / externalTask），task_attempts.workflow_run_id 有 FK→workflow_runs.id。
  // 若 id=randomUUID() 而 workflow 用 workflowId，FK 会失败。与 novelIntentWorkflow 对齐。
  await ctx.repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "accepted", payload: { documentId, instruction, idempotencyKey, mode, targetIssueIds: mode === "targeted" ? effectiveTargetIssueIds : [] } });
  let handle;
  try {
    handle = await ctx.temporal.workflow.start("chapterReviewWorkflow", { args: [params], taskQueue: ctx.taskQueue ?? "creative-studio-novel-v2", workflowId });
  } catch (error) {
    // accepted 记录会被单文档与项目级审校查询视为活跃；若 start 失败而记录
    // 悬挂，该章节乃至整个项目的审校启动都会被永久阻塞（工作流从未运行，
    // 没有路径会把它转终态）。因此 start 失败时必须把记录转 failed 释放占用。
    await ctx.repository.updateWorkflowRunStatus(workflowId, "failed", { reason: "workflow.start 失败", error: (error as Error)?.message ?? String(error) }).catch(() => undefined);
    throw error;
  }
  return {
    workflowId, temporalRunId: handle.firstExecutionRunId, documentId, instruction, mode,
    ...(registeredIssueIds.length ? { registeredIssueIds } : {}),
    ...(locatedNotes.length ? { locatedNotes } : {}),
    targetIssueIds: mode === "targeted" ? effectiveTargetIssueIds : [],
    status: "accepted",
    nextAction: "调用 novel_workflow_query({ workflowId }) 查询审校进度",
  };
};

// ===== 外部 LLM 深度参与：上下文查询（4）=====

const novel_memory_query: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");
  const documentId = asString(args.documentId) || undefined;
  const compact = args.compact === true;
  const narrativeCutoff = asNumber(args.narrativeCutoff);
  const targetNarrativeOrder = documentId ? await ctx.repository.getDocumentNarrativeOrder(projectId, documentId) : undefined;
  const cutoff = narrativeCutoff ?? (targetNarrativeOrder !== undefined && targetNarrativeOrder > 1 ? targetNarrativeOrder - 1 : undefined);
  const serialContextLoaded = cutoff !== undefined && documentId ? await ctx.repository.getSerialContextSnapshot(projectId, documentId, cutoff) : undefined;
  // 与 novel_context_get、生成链路同一份账本生产者：此前本面直取 repository，assetSpans
  // 恒为空账本，而 compact 摘要里偏偏有一个 `assetSpanCount` 字段——读得到字段、读不到账。
  // 降级回报沿用 novel_context_get 的 `enhancementErrors` 通道名，两面同键。
  const enhancementErrors: string[] = [];
  let serialContext = serialContextLoaded;
  if (serialContextLoaded) {
    const attached = await serialContextWithAssets(serialContextLoaded, projectId, {
      getChapterContentRefs: (id, orders) => ctx.repository.getChapterContentRefsByOrders(id, orders),
      getText: ctx.objects ? (key) => ctx.objects!.getText(key) : undefined,
    });
    if (attached.degradation) enhancementErrors.push(attached.degradation);
    serialContext = attached.snapshot;
  }
  const memories = await ctx.repository.getChapterMemories({ projectId, narrativeCutoff: cutoff, limit: 8 });
  const claims = await ctx.repository.getOpenForeshadowingAndPromises(projectId, cutoff);
  if (compact) {
    return {
      narrativeCutoff: cutoff ?? null,
      chapterMemories: memories.map((m) => ({ id: m.id, summary: m.summary.slice(0, 200), range: m.narrativeRange })),
      openForeshadowings: claims.foreshadowings.map((f) => ({ id: f.id, description: f.description.slice(0, 100) })),
      openPromises: claims.promises.map((p) => ({ id: p.id, statement: p.statement.slice(0, 100) })),
      serialContextSummary: serialContext ? { window: serialContext.window, characterSpanCount: serialContext.characterSpans.length, subjectSpanCount: serialContext.subjectSpans.length, openPromiseCount: serialContext.openPromises?.length ?? 0, assetSpanCount: serialContext.assetSpans?.length ?? 0 } : null,
      ...(enhancementErrors.length ? { enhancementErrors } : {}),
    };
  }
  return {
    narrativeCutoff: cutoff ?? null,
    chapterMemories: memories,
    openForeshadowings: claims.foreshadowings,
    openPromises: claims.promises,
    serialContext: serialContext ?? null,
    ...(enhancementErrors.length ? { enhancementErrors } : {}),
  };
};

const novel_fact_candidate_queue: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");
  // A3/FM-2：候选队列一等公民化——积压面板让编排者看见债务，配合 decide 工具形成闭环。
  return await ctx.repository.getFactCandidateBacklog(projectId);
};

const novel_fact_candidate_decide: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const claimIds = Array.isArray(args.claimIds) ? args.claimIds.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const decision = args.decision === "approve" || args.decision === "reject" ? args.decision : undefined;
  const reason = asString(args.reason);
  if (!projectId || !claimIds.length || !decision || !reason) throw new Error("projectId/claimIds/decision/reason 必填且非空");
  const actorId = asString(args.actorId) || "mcp-orchestrator";
  const results: Array<{ claimId: string; status: "decided" | "skipped" | "failed"; authority?: string; error?: string }> = [];
  const approvedClaims: MemoryClaim[] = [];
  for (const claimId of claimIds) {
    try {
      const outcome = await ctx.repository.decideFactCandidate({ projectId, claimId, actorId, decision, reason });
      results.push({ claimId, status: "decided", authority: outcome.authority });
      if (decision === "approve") {
        const claim = await ctx.repository.getMemoryClaimById(projectId, claimId);
        if (claim) approvedClaims.push(claim);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 已处理视为幂等跳过（批量重放不报错）；其余失败逐条上报，不中断整批。
      if (message.includes("已处理")) results.push({ claimId, status: "skipped" });
      else results.push({ claimId, status: "failed", error: message });
    }
  }
  // 向量层同步（与 workflow approveFactClaims 同一契约）：approve 写入新点并按
  // supersedes 删除被退役点；reject 防御性删除（候选通常不在库中）。
  let vectorSyncError: string | undefined;
  if (ctx.memoryIndex) {
    try {
      if (approvedClaims.length) await ctx.memoryIndex.upsertClaims(projectId, approvedClaims);
      const rejectedIds = results.filter((item) => item.status === "decided" && item.authority === "rejected").map((item) => item.claimId);
      if (rejectedIds.length) await ctx.memoryIndex.deleteClaims?.(projectId, rejectedIds);
    } catch (error) {
      vectorSyncError = error instanceof Error ? error.message : String(error);
    }
  }
  return { decision, actorId, indexed: Boolean(ctx.memoryIndex), ...(vectorSyncError ? { vectorSyncError } : {}), results };
};

/**
 * 查询指定执行点的 SkillBundle（外部编排 LLM 的指引透视面）。
 *
 * 2026-09-24 工具面减法：吸收原 novel_skill_get 的执行点发现能力——返回
 * availableSkills（各 skill 的 executionPoints）供外部发现合法执行点；
 * projectId 可选（workspace 源 skill 不绑定项目）。
 */
const novel_skill_query: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId) || undefined;
  const executionPoint = asString(args.executionPoint);
  const role = asString(args.role) || undefined;
  if (!executionPoint) throw new Error("executionPoint 必填且非空");
  if (!(executionPoint in SKILL_EXECUTION_POLICIES)) {
    const valid = Object.keys(SKILL_EXECUTION_POLICIES).join(" / ");
    throw new Error(`executionPoint 非法：${executionPoint}；合法执行点见 availableSkills[].executionPoints，如 ${valid}`);
  }
  const provider = createConfiguredSkillProvider({ source: process.env.NODE_ENV === "production" ? "database" : "workspace", databaseList: (id) => ctx.repository.listSkills(id) });

  // 发现：列出当前 provider 下所有可用 skill 及其执行点（即使目标点解析失败也返回，便于外部探索）。
  let availableSkills: Array<{ skillId: string; version: string; executionPoints: string[] }> = [];
  try {
    const descriptors = await provider.list(projectId ?? "");
    availableSkills = descriptors.map((descriptor) => ({
      skillId: descriptor.skillId,
      version: descriptor.version,
      executionPoints: (descriptor.executionPoints ?? []).map(String),
    }));
  } catch (error) {
    // provider 源不可用时忽略发现，仅影响 availableSkills 完整性。OR-E1 禁裸吞：降级留痕。
    console.warn(`[novel-v2.mcp] skill-discovery degraded: ${error instanceof Error ? error.message : String(error)}`);
  }

  const bundle = await resolveStageSkillBundle({ projectId: projectId ?? "", executionPoint: executionPoint as SkillExecutionPoint, role, provider });
  return { executionPoint, resolution: bundle.resolution, fingerprint: bundle.fingerprint, availableSkills, skills: bundle.skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, priority: skill.priority, sourceRef: skill.sourceRef, contentFingerprint: skill.contentFingerprint, promptSections: skill.promptSections })) };
};

// ===== 产物与工作流观测（2）=====

/**
 * 工作流观测（单查/列查合一，2026-09-24 三批吸收原 novel_workflow_get + novel_workflow_list）：
 * workflowId 传入=单查（返回 workflow_runs 记录 + Temporal 运行时状态；workflowId 来自
 * novel_chapter_generate / novel_chapter_review 的返回值）；否则 projectId 必填走列表
 * （按 updatedAt DESC，支持 workflowType 过滤）。
 *
 * 单查附加 Temporal 运行时状态：workflow_runs.status 由 workflow 自己写，可能滞后于
 * Temporal 实际状态（如 commit activity 还没更新 DB）。Temporal 不可达时 temporal 字段留空，
 * 以 run.status 为准。
 */
const novel_workflow_query: ToolHandler = async (args, ctx) => {
  const workflowId = asString(args.workflowId);
  if (workflowId) {
    const run = await ctx.repository.getWorkflowRunByTemporalId(workflowId);
    if (!run) throw new Error(`WorkflowRun 不存在：${workflowId}`);

    let temporal: { status: string; closeTime?: string } | undefined;
    if (ctx.temporal) {
      try {
        const handle = ctx.temporal.workflow.getHandle(workflowId);
        const info = await handle.describe();
        temporal = {
          status: info.status.name,
          closeTime: info.closeTime?.toISOString(),
        };
      } catch (error) {
        // Temporal 不可达或 workflow 不存在——temporal 留空，仅返回 DB 状态。
        // OR-E1 禁裸吞：降级留痕，Temporal 连通性排查从日志起步。
        console.warn(`[novel-v2.mcp] workflow-describe degraded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { run, temporal };
  }

  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("workflowId 与 projectId 必须提供其一");
  const limit = asNumber(args.limit) ?? DEFAULT_WORKFLOW_LIST_LIMIT;
  const workflowType = asString(args.workflowType) || undefined;

  const runs = await ctx.repository.listProjectRuns(projectId, limit, workflowType);
  return { runs };
};

// ===== Workflow 决策（1）=====

/**
 * 工作流人工门决策（2026-09-24 三批合并章节门与故事弧门，target 分发）：
 * - target=chapter-review：向 chapter-review 工作流提交人工决策（approve/revise/reject/abandon），
 *   解除 manual-review-required 阻塞。复用 HTTP API human-decision 逻辑：
 *   claimApprovalEvidence → signal(humanSignal) → resumeWorkflowRunFromHumanGate。
 * - target=story-arc：故事弧人工门决策。approve=批准当前蓝图（复用正式落库+唤醒信号，
 *   审核未过时会被门禁正当拒绝）；revise=把作者修订指令送进等待中的门，系统定向修订→重审→再入门
 *   （feedback 必填，与审核意见合并，不覆盖审核器发现的问题）。
 */
const novel_workflow_decision: ToolHandler = async (args, ctx) => {
  const target = asString(args.target) || "chapter-review";
  if (target !== "chapter-review" && target !== "story-arc") throw new Error("target 必须是 chapter-review 或 story-arc");
  if (target === "story-arc") {
    const projectId = asString(args.projectId);
    const arcId = asString(args.arcId);
    const decision = asString(args.decision);
    if (!projectId || !arcId) throw new Error("story-arc 决策需要 projectId/arcId");
    if (decision !== "approve" && decision !== "revise") throw new Error("story-arc 决策 decision 必须是 approve 或 revise");
    if (!ctx.temporal) throw new Error("novel_workflow_decision 需要 ToolContext.temporal 才能发送工作流信号");
    const workflow = await ctx.repository.getStoryArcWorkflow(projectId, arcId);
    const gateActive = Boolean(workflow && ["accepted", "running", "manual-review-required"].includes(workflow.status));
    const feedback = asString(args.feedback);
    if (decision === "revise") {
      if (!feedback.trim()) throw new Error("revise 必须携带 feedback 修订指令");
      if (!gateActive) throw new Error("当前没有等待作者决策的故事弧工作流，修订指令无处投递");
      await ctx.temporal.workflow.getHandle(workflow!.temporalWorkflowId).signal("storyArcApproved", { decision: "revise", feedback, arcId });
      return { accepted: true, target, decision, workflowId: workflow!.temporalWorkflowId, stage: "revision" };
    }
    const preview = await ctx.repository.previewStoryArcApproval(projectId, arcId);
    // 信号优先：storyArcPlanningWorkflow 的 manual 分支在 condition(() => approved)
    // 解除后自己调用 approveStoryArcAutomatically 落库——REST 入口（web 路径）正是
    // 这个顺序。若先就地落库，工作流醒来的第二次 approve 必撞"当前状态不可批准"
    // （2026-09-12 弧6 实践批：MCP 首用即 failed，修订环作者批准被误报成工作流失败）。
    // 活动门在，交由工作流落库；无活动门（工作流崩溃/放弃后补批）才直接落库兜底。
    if (gateActive) {
      await ctx.temporal.workflow.getHandle(workflow!.temporalWorkflowId).signal("storyArcApproved", { arcId, artifactId: preview.artifactId });
      return { accepted: true, target, decision, arcId, workflowId: workflow!.temporalWorkflowId, approvedBy: "story-arc-workflow" };
    }
    const reviewArtifactId = typeof workflow?.payload.reviewArtifactId === "string" ? workflow.payload.reviewArtifactId : undefined;
    if (!reviewArtifactId) throw new Error("故事弧缺少当前蓝图的审核证据，请先完成审核");
    const approval = await ctx.repository.approveStoryArc(projectId, arcId, preview.artifactId, reviewArtifactId, asString(args.actorId) || "mcp-author");
    return { accepted: true, target, decision, arcId, planningStatus: approval.arc?.planningStatus, executionStatus: approval.arc?.executionStatus };
  }

  const workflowId = asString(args.workflowId);
  const artifactId = asString(args.artifactId);
  const decision = asString(args.decision);
  if (!workflowId || !artifactId) throw new Error("chapter-review 决策需要 workflowId/artifactId");
  if (decision !== "approve" && decision !== "reject" && decision !== "revise" && decision !== "abandon") {
    throw new Error("decision 必须是 approve/reject/revise/abandon");
  }
  if (!ctx.temporal) throw new Error("novel_workflow_decision 需要 ToolContext.temporal 才能发送工作流信号");

  const feedback = asString(args.feedback) || undefined;
  const revisionBase = args.revisionBase === "previous" ? "previous" : args.revisionBase === "current" ? "current" : undefined;

  // 1. 创建 approval evidence 并抢占决策锁（同一 artifact 只能提交一次决策）
  // actorId 允许编排者署名（审计真实性）；actorSource 保持 interactive-web 语义 =
  // "作者代理通道"，repository 对 automation 来源的批准限制不受影响。
  const claimed = await ctx.repository.claimApprovalEvidence({
    workflowId,
    artifactId,
    decision,
    actorSource: "interactive-web",
    actorId: asString(args.actorId) || "web-author",
    feedback,
    revisionBase,
  });
  if (!claimed) throw new Error("该候选稿的审批已提交，或运行已离开当前审批阶段。调用 novel_workflow_query 确认当前状态");

  // 2. 发送 humanSignal 到 Temporal 工作流
  const signalPayload = { approvalEvidenceId: claimed.evidence.id, taskId: artifactId };
  try {
    await ctx.repository.recordTaskSignal({ workflowId, taskId: artifactId, signal: "humanSignal", payload: signalPayload });
    await ctx.temporal.workflow.getHandle(workflowId).signal("humanSignal", signalPayload);

    // 3. 更新工作流状态为 running（守卫式：仍处人工门才回写，工作流已自行推进时不覆态）
    const stage = decision === "approve" ? "fact-extraction" : decision === "revise" ? "revision" : "manuscript-approval";
    await ctx.repository.resumeWorkflowRunFromHumanGate(workflowId, { stage, decision, pendingHumanDecisionSubmitted: true });

    return {
      accepted: true,
      target,
      workflowId,
      artifactId,
      decision,
      approvalEvidenceId: claimed.evidence.id,
      stage,
      nextAction: `调用 novel_workflow_query({ workflowId: "${workflowId}" }) 查询${decision === "approve" ? "定稿提交" : decision === "revise" ? "修订" : "处理"}进度`,
    };
  } catch (error) {
    // 信号发送失败时释放决策锁，允许重试
    await ctx.repository.releaseHumanDecisionClaim(workflowId, artifactId).catch(() => undefined);
    throw error;
  }
};

// ===== Handler 注册表 =====

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // Run / Action 主体（2）
  novel_run_create,
  novel_action_execute,

  // 项目观测（1）
  novel_project_inspect,

  // 产物与工作流观测（2）
  novel_artifact_query,
  novel_workflow_query,

  // Craft Rule 候选演进（2）
  novel_rule_candidate_create,
  novel_rule_candidate_advance,

  // 规划与创作（8）
  novel_bootstrap_run,
  novel_chapter_review,
  novel_chapter_generate,
  novel_story_arc_start,
  novel_story_arc_get,
  novel_story_arc_review,
  novel_foreshadowing_list,
  novel_foreshadowing_triage,

  // Workflow 决策（1）
  novel_workflow_decision,

  // 外部 LLM 上下文查询（4）
  novel_memory_query,
  novel_fact_candidate_queue,
  novel_fact_candidate_decide,
  novel_skill_query,
};
