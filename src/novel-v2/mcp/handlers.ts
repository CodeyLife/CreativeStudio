/**
 * V2 MCP 工具处理函数（37 个工具的 handler 实现）。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase B-2 MCP 工具网关。
 *
 * 职责：
 * - 实现 37 个工具的具体调用逻辑
 * - 路由到 creative/ + evaluation/ + postgres-repository 模块
 * - 返回标准 JSON-serializable 结果（executeTool 包装为 McpToolResponse）
 *
 * 工具分组（与 tool-definitions.ts 对齐）：
 * - Run / Action 主体（7）
 * - Catalog / Receipt（3）
 * - Craft Rule 候选演进（7）—— 基于 craft-rule 模块（Postgres）
 * - 项目生命周期（3）
 * - 规划与创作（11）—— foundation bootstrap、故事弧（含外部编排模式）、章节审校 workflow、章节剧本派生与创意短剧脚本
 * - 评估闭环（1，v2 新增）
 * - Workflow 查询（2）
 * - Workflow 决策（1）
 * - 上下文与产物查询（2，新增）
 *
 * 与 v1 的区别：v1 用 IndexedDB + CreativeToolEnvelope，v2 全部基于
 * NovelPostgresRepository + creative/evaluation 模块。
 */
import { randomUUID } from "node:crypto";
import type { ToolHandler, ToolContext } from "./types";
import type {
  CreativeCommand,
  CreativeReviewInput,
  CreativeRunMode,
  CreativeRunPolicy,
  CreativeWorkKind,
  NovelIntent,
  SkillExecutionPoint,
} from "../protocol";
import { startNovelBootstrap } from "../application/bootstrap";
import { provisionalTitle } from "../application/provisional-title";
import { parseStoryArcPlotOutline, validateStoryArcPlotOutline } from "../application/story-arc";
import { DEFAULT_ARTIFACT_LIST_LIMIT, DEFAULT_WORKFLOW_LIST_LIMIT } from "./tool-definitions";
import { startStoryArcBatchPlanning, startStoryArcOrchestratedPlanning, startStoryArcPlanning, startStoryArcReview } from "../application/story-arc-workflow";
import { parseCreativeBrief } from "../application/creative-brief";
import { generateChapterScriptH3, submitExternalChapterScriptH3 } from "../application/chapter-script-h3";
import { generateShortScriptH3, submitExternalShortScriptH3, brainstormShortScriptWonders } from "../application/short-script-h3";
import { ContentObjectStore } from "../object-store";
import { createConfiguredSkillProvider, resolveStageSkillBundle, renderSkillInstruction, SKILL_EXECUTION_POLICIES } from "../skill-runtime";
import {
  createCreativeRun,
  executeCreativeCommand,
  getRunSnapshot,
  listCreativeRuns,
  updateRunStatusFromWork,
  enqueueCreativeWork,
  listWorkItems,
  submitReview,
} from "../creative";
import { runClosedLoop } from "../evaluation/closed-loop";
import {
  createCraftRuleCandidate,
  inspectCraftRuleCandidate,
  recordCraftRuleEvidence,
  evaluateCraftRuleOnFoundation,
  submitCraftRuleReview,
  promoteCraftRuleCandidate,
  rollbackCraftRuleCandidate,
  type CraftRuleScopeAnalysis,
} from "../craft-rule";

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
  } catch {
    // workflow 已结束/不可达,或 work item 不存在——review 落库已成功,信号失败不阻塞。
    // TODO P2: 结构化日志记录 signal 失败,便于排查 manual-gate 死锁。
  }
}

// ===== Run / Action 主体（7）=====

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

const novel_run_get: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  if (!runId) throw new Error("runId 必填");
  const afterSequence = asNumber(args.afterSequence);
  const snapshot = await getRunSnapshot(ctx.repository, runId, afterSequence);
  if (!snapshot) throw new Error(`CreativeRun 不存在：${runId}`);
  return snapshot;
};

const novel_action_list: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  if (!runId) throw new Error("runId 必填");
  const workItems = await listWorkItems(ctx.repository, runId);
  return { workItems };
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
  //（与 novel_review_submit 对齐，补齐信号通道）。
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

const novel_artifact_get: ToolHandler = async (args, ctx) => {
  const artifactId = asString(args.artifactId);
  if (!artifactId) throw new Error("artifactId 必填");

  const artifact = await ctx.repository.getArtifact(artifactId);
  if (!artifact) throw new Error(`Artifact 不存在：${artifactId}`);
  return { artifact };
};

const novel_review_submit: ToolHandler = async (args, ctx) => {
  const workItemId = asString(args.workItemId);
  const reviewInput = asRecord(args.review);
  if (!workItemId) throw new Error("workItemId 必填");
  if (!reviewInput) throw new Error("review 必填");

  const review = parseReviewInput(reviewInput);
  const created = await submitReview(ctx.repository, workItemId, review);

  // 接通 manual-gate 闭环:review 落库后向 creativeRunWorkflow 发 reviewSubmitted 信号,
  // 唤醒 processWorkItem 中等待信号的 manual gate(reviewGate=manual 时必备)。
  // reviewGate=none/auto 的 run 信号会被静默忽略(workflow 已结束或不在等待态)。
  await signalReviewSubmitted(ctx, workItemId);

  // 若 run.policy.reviewGate=auto，检查 gate 并自动 accept
  // 注意：本工具不直接触发自动 accept，由调用方根据返回的 review 决定后续动作。
  // 若需自动 accept，应使用 novel_action_execute 的 review.submit action（带自动 gate）。
  return { review: created };
};

const novel_run_complete: ToolHandler = async (args, ctx) => {
  const runId = asString(args.runId);
  if (!runId) throw new Error("runId 必填");

  // updateRunStatusFromWork 会根据所有 work items 的状态决定 run 是否完成
  await updateRunStatusFromWork(ctx.repository, runId);

  // 取最新状态返回
  const snapshot = await getRunSnapshot(ctx.repository, runId);
  if (!snapshot) throw new Error(`CreativeRun 不存在：${runId}`);

  // 校验所有 work items 必须为 accepted 且无 blocker issue
  const hasUnfinished = snapshot.workItems.some(
    (w) => w.status !== "accepted" && w.status !== "recovered",
  );
  const hasBlocker = snapshot.reviews.some((r) =>
    r.issues.some((i) => i.severity === "blocker"),
  );

  if (hasUnfinished) {
    return {
      completed: false,
      reason: "存在未完成的 work items",
      run: snapshot.run,
    };
  }
  if (hasBlocker) {
    return {
      completed: false,
      reason: "存在 blocker issue 未解决",
      run: snapshot.run,
    };
  }

  return {
    completed: true,
    run: snapshot.run,
  };
};

// ===== Catalog / Receipt（3）=====

const novel_catalog_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");

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
};

const novel_receipt_get: ToolHandler = async (args, ctx) => {
  const receiptId = asString(args.receiptId);
  if (!receiptId) throw new Error("receiptId 必填");

  const receipt = await ctx.repository.getPromotionReceiptById(receiptId);
  if (!receipt) throw new Error(`PromotionReceipt 不存在：${receiptId}`);
  return { receipt };
};

const novel_rule_target_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const targetKind = asString(args.targetKind);
  const targetId = asString(args.targetId);
  if (!projectId || !targetKind || !targetId) throw new Error("projectId/targetKind/targetId 必填");

  if (targetKind === "system-prompt") {
    const separator = targetId.indexOf(":");
    const promptProjectId = separator >= 0 ? targetId.slice(0, separator) : projectId;
    const templateId = separator >= 0 ? targetId.slice(separator + 1) : targetId;
    if (!promptProjectId || !templateId) throw new Error("system-prompt targetId 格式非法");
    const promptTemplate = await ctx.repository.getCraftRuleTarget({ kind: "system-prompt", projectId: promptProjectId, targetId: templateId });
    if (!promptTemplate) throw new Error(`PromptTemplate 不存在：${promptProjectId}:${templateId}`);
    return { promptTemplate };
  }
  if (targetKind !== "skill") throw new Error(`targetKind 非法：${targetKind}`);

  const skill = await ctx.repository.getCraftRuleTarget({ kind: "skill", projectId, targetId });
  if (!skill) throw new Error(`SkillDefinition 不存在：${targetId}`);
  return { skill };
};

// ===== Craft Rule 候选演进（7）=====

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
  return { candidate };
};

const novel_rule_candidate_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  if (!projectId || !candidateId) throw new Error("projectId/candidateId 必填且非空");
  const candidate = await inspectCraftRuleCandidate(ctx.repository, projectId, candidateId);
  if (!candidate) throw new Error(`CraftRuleCandidate 不存在：${candidateId}`);
  return { candidate };
};

const novel_rule_evidence_submit: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const scenarioClass = asString(args.scenarioClass);
  const scenarioRole = asString(args.scenarioRole) as "source-failure" | "cross-scenario";
  const baselineWorkItemId = asString(args.baselineWorkItemId);
  const candidateWorkItemId = asString(args.candidateWorkItemId);
  if (!projectId || !candidateId || !scenarioClass || !scenarioRole || !baselineWorkItemId || !candidateWorkItemId) {
    throw new Error("projectId/candidateId/scenarioClass/scenarioRole/baselineWorkItemId/candidateWorkItemId 必填且非空");
  }
  const candidate = await recordCraftRuleEvidence(ctx.repository, {
    projectId, candidateId, scenarioClass, scenarioRole, baselineWorkItemId, candidateWorkItemId,
  });
  return { candidate };
};

const novel_rule_foundation_evaluate: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const taskKey = asString(args.taskKey) as
    | "project-positioning" | "architecture" | "characters"
    | "worldview" | "plot-design";
  const scenarioClass = asString(args.scenarioClass);
  const scenarioRole = asString(args.scenarioRole) as "source-failure" | "cross-scenario";
  const instruction = asString(args.instruction) || undefined;
  if (!projectId || !candidateId || !taskKey || !scenarioClass || !scenarioRole) {
    throw new Error("projectId/candidateId/taskKey/scenarioClass/scenarioRole 必填且非空");
  }
  if (!ctx.model) throw new Error("novel_rule_foundation_evaluate 需要 ctx.model");
  const result = await evaluateCraftRuleOnFoundation(ctx.repository, ctx.model, {
    projectId, candidateId, taskKey, scenarioClass, scenarioRole, instruction,
  });
  return result;
};

const novel_rule_review_submit: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  const role = asString(args.role);
  const reviewerId = asString(args.reviewerId);
  const reviewRunId = asString(args.reviewRunId);
  const model = asString(args.model);
  const provider = asString(args.provider) || undefined;
  const promptFingerprint = asString(args.promptFingerprint) || undefined;
  const verdict = asString(args.verdict) as "passed" | "revise" | "rejected";
  const summary = asString(args.summary);
  const concerns = asStringArray(args.concerns) ?? [];
  if (!projectId || !candidateId || !role || !reviewerId || !reviewRunId || !model || !verdict || !summary) {
    throw new Error("projectId/candidateId/role/reviewerId/reviewRunId/model/verdict/summary 必填且非空");
  }
  const candidate = await submitCraftRuleReview(ctx.repository, {
    projectId, candidateId, role, reviewerId, reviewRunId, model, provider, promptFingerprint,
    verdict, summary, concerns,
  });
  return { candidate };
};

const novel_rule_promote: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  if (!projectId || !candidateId) throw new Error("projectId/candidateId 必填且非空");
  if (!ctx.model) throw new Error("novel_rule_promote 需要 ctx.model（用于回归验证 LLM 调用）");
  const { candidate, receipt, regressionVerified, regressionDetails } = await promoteCraftRuleCandidate(
    ctx.repository,
    ctx.model,
    { projectId, candidateId },
  );
  return { candidate, receipt, regressionVerified, regressionDetails };
};

const novel_rule_rollback: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const candidateId = asString(args.candidateId);
  if (!projectId || !candidateId) throw new Error("projectId/candidateId 必填且非空");
  if (!ctx.model) throw new Error("novel_rule_rollback 需要 ctx.model（保持接口对称，便于未来扩展）");
  const { candidate, receiptId } = await rollbackCraftRuleCandidate(
    ctx.repository,
    ctx.model,
    { projectId, candidateId },
  );
  return { candidate, receiptId };
};

// ===== 项目生命周期（3）=====

const novel_project_create: ToolHandler = async (args, ctx) => {
  const premise = asString(args.premise);
  const idempotencyKey = asString(args.idempotencyKey);
  if (!premise || !idempotencyKey) throw new Error("premise/idempotencyKey 必填且非空");

  // 一句话创意:premise 必填,title 可选(未提供则从 premise 自动派生)
  // 设计依据:v1 bootstrapNovelFromCoreIdea 的 provisionalTitle 函数——
  // 取 premise 第一句前 24 字作为临时标题,project-positioning task 会润色生成正式书名。
  const title = asString(args.title) || provisionalTitle(premise);
  const genre = asString(args.genre) || undefined;
  const autoBootstrap = asBoolean(args.autoBootstrap) ?? true;
  const includeChapterPlan = asBoolean(args.includeChapterPlan) ?? true;
  const objective = asString(args.objective) || premise;
  const creativeBrief = parseCreativeBrief(args.creativeBrief);
  // 解析 reviewGate/progression,使 foundation 5 阶段支持人工审核门禁(架构阶段必备)。
  // 未提供时由 startNovelBootstrap 兜底为质量优先的 manual / automatic。
  const { reviewGate, progression } = parseBootstrapPolicy(args);

  // 使用 idempotencyKey 作为 projectId(与 v1 行为一致)
  const projectId = idempotencyKey;

  // premise/genre 写入 metadata(题材通用差异化,不内置金手指/系统流特化)
  // genre 用于 resolveSkillBundle 匹配 applicableGenres;
  // premise 作为创作上下文提示,由 craft rule 决定如何使用。
  const metadata: Record<string, unknown> = { premise };
  if (genre) metadata.genre = genre;
  if (creativeBrief) metadata.creativeBrief = creativeBrief;
  await ctx.repository.ensureProject(projectId, title, metadata);

  const project = await ctx.repository.getProjectDetail(projectId);

  // 自动启动全书规划(默认 true):创建项目后立即调用 startNovelBootstrap
  // 设计依据:用户需求"一句话创意创建项目"——一站式完成项目创建+全书规划。
  // premise 作为 objective 传给 bootstrap,让每个 foundation task 都知道创意核心。
  // includeChapterPlan 仅保留旧客户端兼容；bootstrap 已由滚动故事弧替代静态章节表。
  if (autoBootstrap) {
    if (!ctx.temporal) throw new Error("novel_project_create(autoBootstrap=true) 需要 ToolContext.temporal 才能启动 Temporal 工作流");
    const bootstrapRun = await startNovelBootstrap(ctx.repository, ctx.temporal, {
      projectId,
      objective,
      idempotencyKey,
      includeChapterPlan,
      reviewGate,
      progression,
      taskQueue: ctx.taskQueue,
    });
    return { project, bootstrapRun };
  }

  return { project };
};

const novel_project_list: ToolHandler = async (_args, ctx) => {
  const projects = await ctx.repository.listProjects();
  return { projects };
};

const novel_project_delete: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");

  await ctx.repository.deleteProject(projectId);
  return { deleted: true, projectId };
};

// ===== 一键流程（2）—— TODO P2 =====

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

const novel_story_arc_start: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");
  if (!ctx.temporal) throw new Error("novel_story_arc_start 需要 Temporal");
  return startStoryArcPlanning(ctx.repository, ctx.temporal, { projectId, mode: "mcp", authorIntent: asString(args.authorIntent) || undefined, taskQueue: ctx.taskQueue });
};

const novel_story_arc_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const arcId = asString(args.arcId);
  if (!projectId) throw new Error("projectId 必填");
  return arcId ? { arc: await ctx.repository.getStoryArc(projectId, arcId) } : { arcs: await ctx.repository.listStoryArcs(projectId) };
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

const novel_story_arc_batch_start: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const arcId = asString(args.arcId);
  if (!projectId || !arcId) throw new Error("projectId/arcId 必填且非空");
  if (!ctx.temporal) throw new Error("novel_story_arc_batch_start 需要 Temporal");
  const reviewPolicy = asString(args.reviewPolicy);
  if (reviewPolicy && reviewPolicy !== "manual" && reviewPolicy !== "auto") {
    throw new Error("reviewPolicy 必须是 manual 或 auto");
  }
  return startStoryArcBatchPlanning(ctx.repository, ctx.temporal, {
    projectId,
    arcId,
    mode: "mcp",
    reviewPolicy: reviewPolicy as "manual" | "auto" | undefined,
    retryFailed: args.retryFailed === true,
    taskQueue: ctx.taskQueue,
  });
};

/**
 * 故事弧外部编排模式（模式 B）。
 *
 * 设计依据：mcp-orchestrator.md 阶段 1 模式 B——外部大模型或用户提供剧情
 * 编排（plotOutline），系统负责完善为规范蓝图并走正式弧审核→修订闭环。
 * 解析与校验在 handler 层执行（parse 拒绝结构错误、validate 拒绝空编排与
 * 重复责任线），然后启动编排式规划工作流；工作流把编排持久化到
 * workflow_runs.payload.plotOutline 并在规划/审核/修订 prompt 注入编排 section。
 */
const novel_story_arc_orchestrate: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");
  if (!ctx.temporal) throw new Error("novel_story_arc_orchestrate 需要 Temporal");

  const plotOutline = parseStoryArcPlotOutline(args.plotOutline);
  validateStoryArcPlotOutline(plotOutline);

  const reviewPolicy = asString(args.reviewPolicy);
  if (reviewPolicy && reviewPolicy !== "manual" && reviewPolicy !== "auto") {
    throw new Error("reviewPolicy 必须是 manual 或 auto");
  }
  const authorIntent = asString(args.authorIntent) || undefined;

  return startStoryArcOrchestratedPlanning(ctx.repository, ctx.temporal, {
    projectId,
    plotOutline,
    mode: "mcp",
    reviewPolicy: reviewPolicy as "manual" | "auto" | undefined,
    authorIntent,
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
  } else {
    // 生成与重审是互斥生命周期；仓储层同时按 status/current revision 防御陈旧蓝图投影。
    await ctx.repository.assertChapterGenerationAllowed(projectId, targetDocumentId);
  }
  await ctx.repository.getChapterPlanningContext(projectId, targetDocumentId);

  // 3. 创建 NovelIntent:target.kind="chapter" 触发 classify 返回 drafting
  const intent: NovelIntent = {
    id: randomUUID(),
    projectId,
    source: "mcp",
    objective: instruction || `生成章节正文(${targetDocumentId})`,
    target: { kind: "chapter", id: targetDocumentId },
    constraints: instruction ? [instruction] : undefined,
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
    taskQueue: ctx.taskQueue ?? "novel-v2",
    workflowId,
  });

  return {
    workflowId,
    temporalRunId: handle.firstExecutionRunId,
    documentId: targetDocumentId,
    intentId: stored.id,
    status: "accepted",
    nextAction: "调用 novel_workflow_get({ workflowId }) 查询生成进度",
  };
};

const novel_chapter_review: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");
  if (!ctx.temporal) throw new Error("novel_chapter_review 需要 ToolContext.temporal 才能启动 Temporal 工作流");

  const instruction = asString(args.instruction) || undefined;
  const mode = asString(args.mode) || "full";
  if (mode !== "full" && mode !== "targeted") throw new Error("章节审校 mode 必须为 full 或 targeted");
  const targetIssueIds = asStringArray(args.targetIssueIds) ?? [];
  if (mode === "targeted" && !targetIssueIds.length) throw new Error("targeted 章节审校必须提供 targetIssueIds");
  if (mode === "full" && targetIssueIds.length) throw new Error("full 章节审校不能提供 targetIssueIds，请使用 targeted 模式");
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

  const workflowId = `chapter-review-${documentId}-${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`.slice(0, 200);
  const params = { projectId, documentId, instruction, workflowId, mode: mode as "full" | "targeted", targetIssueIds: mode === "targeted" ? targetIssueIds : undefined };
  // workflow_runs.id 必须等于 workflowId：chapterReviewWorkflow 全程用 workflowId 作 workflowRunId
  // （updateTaskAttempt / draft / review / revise / externalTask），task_attempts.workflow_run_id 有 FK→workflow_runs.id。
  // 若 id=randomUUID() 而 workflow 用 workflowId，FK 会失败。与 novelIntentWorkflow 对齐。
  await ctx.repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "accepted", payload: { documentId, instruction, idempotencyKey, mode, targetIssueIds: mode === "targeted" ? targetIssueIds : [] } });
  let handle;
  try {
    handle = await ctx.temporal.workflow.start("chapterReviewWorkflow", { args: [params], taskQueue: ctx.taskQueue ?? "novel-v2", workflowId });
  } catch (error) {
    // accepted 记录会被单文档与项目级审校查询视为活跃；若 start 失败而记录
    // 悬挂，该章节乃至整个项目的审校启动都会被永久阻塞（工作流从未运行，
    // 没有路径会把它转终态）。因此 start 失败时必须把记录转 failed 释放占用。
    await ctx.repository.updateWorkflowRunStatus(workflowId, "failed", { reason: "workflow.start 失败", error: (error as Error)?.message ?? String(error) }).catch(() => undefined);
    throw error;
  }
  return { workflowId, temporalRunId: handle.firstExecutionRunId, documentId, instruction, mode, targetIssueIds: mode === "targeted" ? targetIssueIds : [], status: "accepted", nextAction: "调用 novel_workflow_get({ workflowId }) 查询审校进度" };
};

const novel_chapter_review_issue_add: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  const severity = asString(args.severity) as "blocker" | "major" | "warning";
  const title = asString(args.title);
  if (!projectId || !documentId || !severity || !title) throw new Error("projectId/documentId/severity/title 必填且非空");
  if (severity !== "blocker" && severity !== "major" && severity !== "warning") throw new Error("severity 必须是 blocker/major/warning");
  const paragraph = asNumber(args.paragraph);
  if (paragraph !== undefined && (!Number.isInteger(paragraph) || paragraph < 1)) throw new Error("paragraph 必须是正整数");
  const rawRanges = args.revisionRanges;
  const revisionRanges = Array.isArray(rawRanges)
    ? rawRanges.map((range) => {
        if (!range || typeof range !== "object" || Array.isArray(range)) throw new Error("revisionRanges 每项必须是 {start,end} 对象");
        const start = asNumber((range as Record<string, unknown>).start);
        const end = asNumber((range as Record<string, unknown>).end);
        if (start === undefined || end === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error("revisionRanges 的 start/end 必须是满足 1<=start<=end 的整数");
        return { start, end };
      })
    : undefined;
  if (revisionRanges?.length && paragraph !== undefined) throw new Error("paragraph 与 revisionRanges 不能同时提供，使用 revisionRanges 表达多段落范围");
  const issue = await ctx.repository.addChapterReviewIssue({
    projectId,
    documentId,
    severity,
    title,
    description: asString(args.description) || undefined,
    evidenceQuote: asString(args.evidenceQuote) || undefined,
    paragraph,
    revisionRanges,
    suggestion: asString(args.suggestion) || undefined,
  });
  return { issue };
};

// ===== 评估闭环（1，v2 新增）=====

const novel_closed_loop_run: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");

  const dryRun = asBoolean(args.dryRun) ?? false;
  const instruction = asString(args.instruction) || undefined;

  if (!ctx.model) {
    throw new Error("novel_closed_loop_run 需要 ToolContext.model（LLM 网关）");
  }

  const result = await runClosedLoop({
    repository: ctx.repository,
    model: ctx.model,
    projectId,
    documentId,
    instruction,
    dryRun,
    // TODO P2: authorId/codeRevision 由调用方传入
  });

  return result;
};

// ===== Workflow 查询（2，新增）=====

/**
 * 按 workflowId 查询单个 workflow run 状态。
 *
 * 设计依据：novel_chapter_generate / novel_chapter_review 写入 workflow_runs 表，
 * 但 novel_run_get 查 creative_runs 表（两表不相交），导致 Agent 无法用返回的
 * workflowId 查询生成进度。此工具填补该缺口，复用 repository.getWorkflowRunByTemporalId。
 *
 * 附加 Temporal 运行时状态：workflow_runs.status 由 workflow 自己写，可能滞后于
 * Temporal 实际状态（如 commit activity 还没更新 DB）。Agent 需要真实状态判断是否
 * 继续轮询。Temporal 不可达时 temporal 字段留空，以 run.status 为准。
 */
const novel_workflow_get: ToolHandler = async (args, ctx) => {
  const workflowId = asString(args.workflowId);
  if (!workflowId) throw new Error("workflowId 必填");

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
    } catch {
      // Temporal 不可达或 workflow 不存在——temporal 留空，仅返回 DB 状态。
      // TODO P2: 结构化日志记录 describe 失败，便于排查 Temporal 连通性。
    }
  }

  return { run, temporal };
};

/**
 * 按 projectId 列出最新 workflow runs。
 *
 * 轻量替代 novel_catalog_get（32KB+）查章节生成历史的场景。
 * 支持 workflowType 过滤（如只看 novel-intent 章节生成）。
 */
const novel_workflow_list: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");
  const limit = asNumber(args.limit) ?? DEFAULT_WORKFLOW_LIST_LIMIT;
  const workflowType = asString(args.workflowType) || undefined;

  const runs = await ctx.repository.listProjectRuns(projectId, limit, workflowType);
  return { runs };
};

// ===== Workflow 决策（1，新增）=====

/**
 * 向 chapter-review 工作流提交人工决策。
 *
 * 设计依据：findings.md Process Issue — MCP 工具不提供提交人工决策的途径，
 * 导致 manual-review-required 状态的工作流无法通过 MCP 推进。
 * 此 handler 复用 HTTP API `POST /v2/workflows/:id/tasks/:taskId/human-decision`
 * 的逻辑：claimApprovalEvidence → signal(humanSignal) → updateWorkflowRunStatus。
 */
const novel_chapter_review_decision: ToolHandler = async (args, ctx) => {
  const workflowId = asString(args.workflowId);
  const artifactId = asString(args.artifactId);
  const decision = asString(args.decision);
  if (!workflowId || !artifactId) throw new Error("workflowId/artifactId 必填且非空");
  if (decision !== "approve" && decision !== "reject" && decision !== "revise" && decision !== "abandon") {
    throw new Error("decision 必须是 approve/reject/revise/abandon");
  }
  if (!ctx.temporal) throw new Error("novel_chapter_review_decision 需要 ToolContext.temporal 才能发送工作流信号");

  const feedback = asString(args.feedback) || undefined;
  const revisionBase = args.revisionBase === "previous" ? "previous" : args.revisionBase === "current" ? "current" : undefined;

  // 1. 创建 approval evidence 并抢占决策锁（同一 artifact 只能提交一次决策）
  const claimed = await ctx.repository.claimApprovalEvidence({
    workflowId,
    artifactId,
    decision,
    actorSource: "interactive-web",
    actorId: "web-author",
    feedback,
    revisionBase,
  });
  if (!claimed) throw new Error("该候选稿的审批已提交，或运行已离开当前审批阶段。调用 novel_workflow_get 确认当前状态");

  // 2. 发送 humanSignal 到 Temporal 工作流
  const signalPayload = { approvalEvidenceId: claimed.evidence.id, taskId: artifactId };
  try {
    await ctx.repository.recordTaskSignal({ workflowId, taskId: artifactId, signal: "humanSignal", payload: signalPayload });
    await ctx.temporal.workflow.getHandle(workflowId).signal("humanSignal", signalPayload);

    // 3. 更新工作流状态为 running
    const stage = decision === "approve" ? "fact-extraction" : decision === "revise" ? "revision" : "manuscript-approval";
    await ctx.repository.updateWorkflowRunStatus(workflowId, "running", { stage, decision, pendingHumanDecisionSubmitted: true });

    return {
      accepted: true,
      workflowId,
      artifactId,
      decision,
      approvalEvidenceId: claimed.evidence.id,
      stage,
      nextAction: `调用 novel_workflow_get({ workflowId: "${workflowId}" }) 查询${decision === "approve" ? "定稿提交" : decision === "revise" ? "修订" : "处理"}进度`,
    };
  } catch (error) {
    // 信号发送失败时释放决策锁，允许重试
    await ctx.repository.releaseHumanDecisionClaim(workflowId, artifactId).catch(() => undefined);
    throw error;
  }
};

// ===== 上下文与产物查询（2，新增）=====

/**
 * 获取项目当前创作上下文（事实梳理与编排依据）。
 *
 * 设计依据：mcp-orchestrator.md 阶段 3——外部模型在编排剧情、下达编辑指令前
 * 用本工具读取叙事状态账本、定稿章节记忆、开放线索/伏笔/承诺与规划机制反馈，
 * 避免编排与已定稿事实冲突。复用 getStoryArcPlanningInput 的上下文组装
 * （同一投影，外部可见版本），按 sections 裁剪输出体积。
 */
const novel_context_get: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");

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

/**
 * 列出项目下的创作产物。
 *
 * 设计依据：mcp-orchestrator.md「外部大模型作为编排者」——外部模型需要先
 * 定位 blueprint/draft/review 的 artifactId 才能阅读内容并做审核/决策。
 * workflowId 定向复用 listRunArtifacts；其余走项目级列表（kind 可过滤）。
 */
const novel_artifact_list: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填且非空");

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
    nextAction: "使用 novel_artifact_get({ artifactId }) 阅读产物内容",
  };
};

/**
 * 为已定稿章节生成短剧分镜剧本提示词（MiniMax H3 Ref2VA）。
 *
 * 设计依据：创作支撑层基线 —— 定稿正文的只读辅助派生，不走 Temporal 工作流，
 * 也不进正文质量门；skill 指引经 chapter.script 执行点解析后注入系统提示。
 */
const novel_chapter_script_h3: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");
  if (!ctx.model) throw new Error("novel_chapter_script_h3 需要 ToolContext.model（LLM 网关）");

  // 项目级共享定义由作者在前端预设（REST/前端管理），MCP 生成时读取同一份。
  const sharedSubjectsText = await ctx.repository.getChapterScriptSubjectPreset(projectId);
  const record = await generateChapterScriptH3({ projectId, documentId, instruction: asString(args.instruction) || undefined }, {
    repository: ctx.repository,
    objects: new ContentObjectStore(),
    model: ctx.model,
    skillProvider: createConfiguredSkillProvider({ databaseList: (pid) => ctx.repository.listSkills(pid) }),
    sharedSubjectsText,
  });

  return {
    projectId: record.projectId,
    documentId: record.documentId,
    artifactId: record.artifactId,
    revisionId: record.revisionId,
    sourceFingerprint: record.sourceFingerprint,
    mode: "ref2va",
    minSegments: record.minSegments,
    plotBeats: record.plotBeats,
    cinematicHints: record.cinematicHints,
    sharedSubjects: record.sharedSubjects,
    characterBaselines: record.characters,
    segments: record.segments.map((segment) => ({
      index: segment.index,
      title: segment.title,
      synopsis: segment.synopsis,
      durationSeconds: segment.durationSeconds,
      promptText: segment.promptText,
    })),
    nextAction: "把各片段 promptText 直接送入 MiniMax H3；完整产物可用 novel_artifact_get 阅读，历史剧本可用 novel_artifact_list(kind=chapter-script) 查询",
  };
};

/**
 * 从核心创意生成简短短剧脚本提示词（MiniMax H3 Ref2VA）。
 *
 * 设计依据：创作支撑层基线 —— 无定稿正文依赖的独立创作派生物，不走 Temporal
 * 工作流，也不进正文质量门；skill 指引经 short.script 执行点解析后注入系统提示；
 * 与章节剧本共用六段式片段契约与结构特征校验。
 */
const novel_short_script_h3: ToolHandler = async (args, ctx) => {
  const idea = asString(args.idea);
  if (!idea) throw new Error("idea 必填且非空");
  if (!ctx.model) throw new Error("novel_short_script_h3 需要 ToolContext.model（LLM 网关）");
  const projectId = asString(args.projectId) || undefined;

  const targetDurationSecondsRaw = args.targetDurationSeconds;
  const targetDurationSeconds = typeof targetDurationSecondsRaw === "number" && Number.isFinite(targetDurationSecondsRaw)
    ? Math.round(targetDurationSecondsRaw)
    : undefined;
  const record = await generateShortScriptH3(
    {
      projectId,
      idea,
      instruction: asString(args.instruction) || undefined,
      ...(targetDurationSeconds !== undefined ? { targetDurationSeconds } : {}),
    },
    {
      repository: ctx.repository,
      objects: new ContentObjectStore(),
      model: ctx.model,
      skillProvider: createConfiguredSkillProvider({ databaseList: (pid) => ctx.repository.listSkills(pid) }),
    },
  );

  return {
    projectId: record.projectId,
    scriptId: record.scriptId,
    sourceFingerprint: record.sourceFingerprint,
    reused: record.reused ?? false,
    mode: "ref2va",
    targetDurationSeconds: record.targetDurationSeconds,
    plotBeats: record.plotBeats,
    cinematicHints: record.cinematicHints,
    characterBaselines: record.characters,
    segments: record.segments.map((segment) => ({
      index: segment.index,
      title: segment.title,
      synopsis: segment.synopsis,
      durationSeconds: segment.durationSeconds,
      promptText: segment.promptText,
    })),
    nextAction: "把各片段 promptText 直接送入 MiniMax H3；短剧产物存储于 short_scripts 独立表（不依赖小说项目），可通过 REST GET /v2/short-script-h3/:scriptId 读取",
  };
};

/**
 * 开放创意方向 → N 个截然不同的具体奇观候选（创意发散，不生成脚本、不落库）。
 *
 * 设计依据：开放命题直接喂给 novel_short_script_h3 时模型会塌缩到默认母题
 * （东方仙侠+云上→倒悬巨钟）。本工具在正式生成前先让模型以「创意策划」视角穷举
 * N 个彼此明显不同的可拍奇观，每个候选 wonder 已是可直接喂给 novel_short_script_h3
 * 的 idea 字符串；编排者挑定其一后再生成。属「外部编排者给方向」层的创意发散。
 */
const novel_short_script_h3_brainstorm: ToolHandler = async (args, ctx) => {
  const idea = asString(args.idea);
  if (!idea) throw new Error("idea 必填且非空");
  if (!ctx.model) throw new Error("novel_short_script_h3_brainstorm 需要 ToolContext.model（LLM 网关）");

  const countRaw = args.count;
  const count = typeof countRaw === "number" && Number.isFinite(countRaw) ? Math.round(countRaw) : undefined;
  const targetDurationSecondsRaw = args.targetDurationSeconds;
  const targetDurationSeconds = typeof targetDurationSecondsRaw === "number" && Number.isFinite(targetDurationSecondsRaw)
    ? Math.round(targetDurationSecondsRaw)
    : undefined;
  const instruction = asString(args.instruction) || undefined;

  const result = await brainstormShortScriptWonders(
    { idea, count, targetDurationSeconds, instruction },
    { model: ctx.model },
  );

  return {
    idea: result.idea,
    count: result.count,
    candidates: result.candidates.map((candidate, index) => ({
      index: index + 1,
      wonder: candidate.wonder,
      why: candidate.why,
      nextAction: "挑定一个候选后调用 novel_short_script_h3(idea=candidate.wonder, targetDurationSeconds?) 生成完整脚本",
    })),
    note: `本工具只做创意发散，不生成脚本、不落库；候选数 = ${result.count}`,
  };
};

/**
 * 读取指定执行点的已解析 Skill 指引文本（通用）。
 *
 * 设计依据：支持外部 MCP 接手短剧内容产出——先读 skill 拿到 h3-video-prompt
 * 方法论，再自行产出模型形态 JSON 落库。校验 executionPoint 为合法执行点
 * （SKILL_EXECUTION_POLICIES 键），解析并渲染该执行点的 skill 文本；同时返回
 * availableSkills（含各 skill 的 executionPoints）供外部发现合法执行点。
 */
const novel_skill_get: ToolHandler = async (args, ctx) => {
  const executionPoint = asString(args.executionPoint);
  if (!executionPoint) throw new Error("executionPoint 必填且非空");
  if (!(executionPoint in SKILL_EXECUTION_POLICIES)) {
    const valid = Object.keys(SKILL_EXECUTION_POLICIES).join(" / ");
    throw new Error(`executionPoint 非法：${executionPoint}；合法执行点见 availableSkills[].executionPoints，如 ${valid}`);
  }
  const projectId = asString(args.projectId) || undefined;
  const provider = createConfiguredSkillProvider({ databaseList: (pid) => ctx.repository.listSkills(pid) });

  // 发现：列出当前 provider 下所有可用 skill 及其执行点（即使目标点解析失败也返回，便于外部探索）。
  let availableSkills: Array<{ skillId: string; version: string; executionPoints: string[] }> = [];
  try {
    const descriptors = await provider.list(projectId ?? "");
    availableSkills = descriptors.map((descriptor) => ({
      skillId: descriptor.skillId,
      version: descriptor.version,
      executionPoints: (descriptor.executionPoints ?? []).map(String),
    }));
  } catch {
    // provider 源不可用时忽略发现，仅影响 availableSkills 完整性。
  }

  try {
    const bundle = await resolveStageSkillBundle({
      projectId: projectId ?? "",
      provider,
      executionPoint: executionPoint as SkillExecutionPoint,
      preflightId: `skill-get:${executionPoint}`,
    });
    const skillText = renderSkillInstruction(bundle, executionPoint);
    return {
      executionPoint,
      skillText,
      resolvedSkills: bundle.skills.map((skill) => ({
        skillId: skill.skillId,
        version: skill.version,
        priority: skill.priority,
        executionPoints: (skill.executionPoints ?? []).map(String),
      })),
      resolution: bundle.resolution,
      availableSkills,
      nextAction: "将 skillText 作为外部 MCP 创作短剧脚本的方法论，按核心创意与时长参数产出模型形态 JSON，再用 novel_short_script_h3_submit / novel_chapter_script_h3_submit 落库",
    };
  } catch (error) {
    return {
      executionPoint,
      skillText: "",
      resolvedSkills: [],
      availableSkills,
      note: `该执行点暂无可用 skill：${(error as Error)?.message ?? String(error)}；可用执行点见 availableSkills[].executionPoints`,
    };
  }
};

/**
 * 外部 MCP 接手短剧内容产出（核心创意路径）。
 *
 * 设计依据：与 novel_short_script_h3（系统内部生成）互为双轨。外部 MCP 自行产出
 * 模型形态剧本 JSON 后提交，系统复用 normalizeChapterScriptOutput 零阻断组装 +
 * 落库；短剧脚本是正文只读派生，不进正文质量门，故允许外部产出（mcp-orchestrator
 * 外部编排「治理与产出解耦」原则在该派生产物上的放宽为可读）。
 */
const novel_short_script_h3_submit: ToolHandler = async (args, ctx) => {
  const idea = asString(args.idea);
  if (!idea) throw new Error("idea 必填且非空");
  const payload = asRecord(args.payload);
  if (!payload) throw new Error("payload 必填（外部 MCP 产出的模型形态剧本 JSON）");
  if (!Array.isArray(payload.segments) || !payload.segments.length) {
    throw new Error("payload.segments 必填且非空");
  }
  const projectId = asString(args.projectId) || undefined;
  const targetDurationSecondsRaw = args.targetDurationSeconds;
  const targetDurationSeconds = typeof targetDurationSecondsRaw === "number" && Number.isFinite(targetDurationSecondsRaw)
    ? Math.round(targetDurationSecondsRaw)
    : undefined;

  const record = await submitExternalShortScriptH3(
    {
      projectId,
      idea,
      instruction: asString(args.instruction) || undefined,
      ...(targetDurationSeconds !== undefined ? { targetDurationSeconds } : {}),
      payload: { plotBeats: payload.plotBeats, characters: payload.characters, segments: payload.segments },
    },
    {
      repository: ctx.repository,
      objects: new ContentObjectStore(),
    },
  );

  return {
    projectId: record.projectId,
    scriptId: record.scriptId,
    sourceFingerprint: record.sourceFingerprint,
    reused: record.reused ?? false,
    origin: "external",
    mode: "ref2va",
    targetDurationSeconds: record.targetDurationSeconds,
    plotBeats: record.plotBeats,
    cinematicHints: record.cinematicHints,
    characterBaselines: record.characters,
    segments: record.segments.map((segment) => ({
      index: segment.index,
      title: segment.title,
      synopsis: segment.synopsis,
      durationSeconds: segment.durationSeconds,
      promptText: segment.promptText,
    })),
    nextAction: "把各片段 promptText 直接送入 MiniMax H3；本产物由外部 MCP 产出（origin=external），存储于 short_scripts 独立表",
  };
};

/**
 * 外部 MCP 接手章节派生短剧内容产出。
 *
 * 设计依据：与 novel_chapter_script_h3（系统内部生成）互为双轨。门禁与内部一致
 * （章节须为定稿），共享预设从仓储读取，使引用一致性校验对齐。
 */
const novel_chapter_script_h3_submit: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  const documentId = asString(args.documentId);
  if (!projectId || !documentId) throw new Error("projectId/documentId 必填且非空");
  const payload = asRecord(args.payload);
  if (!payload) throw new Error("payload 必填（外部 MCP 产出的模型形态剧本 JSON）");
  if (!Array.isArray(payload.segments) || !payload.segments.length) {
    throw new Error("payload.segments 必填且非空");
  }
  const sharedSubjectsText = await ctx.repository.getChapterScriptSubjectPreset(projectId);
  const record = await submitExternalChapterScriptH3(
    {
      projectId,
      documentId,
      instruction: asString(args.instruction) || undefined,
      payload: { plotBeats: payload.plotBeats, characters: payload.characters, segments: payload.segments },
    },
    {
      repository: ctx.repository,
      objects: new ContentObjectStore(),
      sharedSubjectsText,
    },
  );

  return {
    projectId: record.projectId,
    documentId: record.documentId,
    artifactId: record.artifactId,
    sourceFingerprint: record.sourceFingerprint,
    reused: record.reused ?? false,
    origin: "external",
    mode: "ref2va",
    minSegments: record.minSegments,
    plotBeats: record.plotBeats,
    cinematicHints: record.cinematicHints,
    sharedSubjects: record.sharedSubjects,
    characterBaselines: record.characters,
    segments: record.segments.map((segment) => ({
      index: segment.index,
      title: segment.title,
      synopsis: segment.synopsis,
      durationSeconds: segment.durationSeconds,
      promptText: segment.promptText,
    })),
    nextAction: "把各片段 promptText 送入 MiniMax H3；本产物由外部 MCP 产出（origin=external）",
  };
};

// ===== Handler 注册表 =====

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // Run / Action 主体（7）
  novel_run_create,
  novel_run_get,
  novel_action_list,
  novel_action_execute,
  novel_artifact_get,
  novel_review_submit,
  novel_run_complete,

  // Catalog / Receipt（3）
  novel_catalog_get,
  novel_receipt_get,
  novel_rule_target_get,

  // Craft Rule 候选演进（7）
  novel_rule_candidate_create,
  novel_rule_candidate_get,
  novel_rule_evidence_submit,
  novel_rule_foundation_evaluate,
  novel_rule_review_submit,
  novel_rule_promote,
  novel_rule_rollback,

  // 项目生命周期（3）
  novel_project_create,
  novel_project_list,
  novel_project_delete,

  // 规划与创作（11）
  novel_bootstrap_run,
  novel_chapter_review,
  novel_chapter_review_issue_add,
  novel_chapter_generate,
  novel_chapter_script_h3,
  novel_short_script_h3,
  novel_short_script_h3_brainstorm,
  novel_story_arc_start,
  novel_story_arc_get,
  novel_story_arc_review,
  novel_story_arc_batch_start,
  novel_story_arc_orchestrate,

  // 外部产出与 Skill 读取（3，v2 新增）
  novel_skill_get,
  novel_short_script_h3_submit,
  novel_chapter_script_h3_submit,

  // 评估闭环（1）
  novel_closed_loop_run,

  // Workflow 查询（2）
  novel_workflow_get,
  novel_workflow_list,

  // Workflow 决策（1，新增）
  novel_chapter_review_decision,

  // 上下文与产物查询（2，新增）
  novel_context_get,
  novel_artifact_list,
};
