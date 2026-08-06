import type { Client } from "@temporalio/client";
import { createCreativeRun, enqueueCreativeWork, getRunSnapshot } from "../creative";
import type { NovelPostgresRepository } from "../postgres-repository";
import { PROJECT_PLAN_STAGES } from "./project-plan";

export const FOUNDATION_TASK_CHAIN = PROJECT_PLAN_STAGES;

/** 聚焦重生成的纯逻辑：过滤白名单 + 依赖裁剪 + 意见注入。供测试与复用。 */
export function buildFocusedTaskChain(input: {
  objective: string;
  focusedTaskKeys?: Array<(typeof PROJECT_PLAN_STAGES)[number]["taskKey"]>;
  revisionInstructions?: Record<string, string>;
}): Array<{ taskKey: string; instruction: string; dependsOn: string[] }> {
  const focusedSpecified = Boolean(input.focusedTaskKeys && input.focusedTaskKeys.length > 0);
  const base = PROJECT_PLAN_STAGES.map((task) => ({
    taskKey: task.taskKey,
    dependsOn: [...task.dependsOn],
    instruction: `${task.instruction}。项目目标：${input.objective}`,
  })).filter((task) => !focusedSpecified || input.focusedTaskKeys!.includes(task.taskKey as (typeof PROJECT_PLAN_STAGES)[number]["taskKey"]));

  const focusedSet = new Set(focusedSpecified ? input.focusedTaskKeys : []);
  return base.map((task) => {
    const dependsOn = task.dependsOn.filter((taskKey) => focusedSet.has(taskKey));
    const revisionInstruction = input.revisionInstructions?.[task.taskKey];
    return {
      taskKey: task.taskKey,
      dependsOn,
      instruction: revisionInstruction
        ? `${task.instruction}\n\n## 修订要求（作者指令，优先级最高）\n${revisionInstruction}`
        : task.instruction,
    };
  });
}

export interface StartBootstrapInput {
  projectId: string;
  objective: string;
  idempotencyKey: string;
  includeChapterPlan?: boolean;
  progression?: "automatic" | "user-driven";
  reviewGate?: "manual" | "auto" | "none";
  taskQueue?: string;
  /**
   * 聚焦重生成：只重新生成这些阶段的 work item（其余已 approved 阶段
   * 作为 prior context 读取，不重新生成）。缺省时重跑全部 5 阶段。
   */
  focusedTaskKeys?: Array<(typeof PROJECT_PLAN_STAGES)[number]["taskKey"]>;
  /**
   * 每阶段的重生成意见：key 为 taskKey，value 作为该阶段的 instruction
   * 注入重新生成 prompt（作者修订指令/审核意见）。
   */
  revisionInstructions?: Record<string, string>;
}

/**
 * Creates and starts the durable foundation workflow used by HTTP and MCP.
 * The CreativeRun id is also the workflow_runs id and Temporal workflow id so
 * model tasks, signals, persisted status, and Temporal history share one key.
 */
export async function startNovelBootstrap(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: StartBootstrapInput,
) {
  // chapter-plan 已由滚动故事弧蓝图替代。保留入参仅用于旧客户端兼容。
  const includeChapterPlan = false;
  const existingId = await repository.findBootstrapRunId(input.projectId, input.idempotencyKey);
  if (existingId) {
    const snapshot = await getRunSnapshot(repository, existingId);
    if (snapshot) {
      return {
        run: snapshot.run,
        workItems: snapshot.workItems.map((item) => item.id),
        taskChain: snapshot.workItems.map((item) => item.taskKey).filter((value): value is string => Boolean(value)),
        workflowId: snapshot.run.id,
        temporalRunId: undefined,
        reused: true,
      };
    }
  }

  const run = await createCreativeRun(repository, {
    projectId: input.projectId,
    mode: "chapter",
    policy: {
      // Quality-first default: every foundation artifact receives a dedicated review;
      // explicit reviewGate=none remains available only for tests/debugging.
      reviewGate: input.reviewGate ?? "manual",
      progression: input.progression ?? "automatic",
    },
    payload: {
      objective: input.objective,
      includeChapterPlan,
      bootstrap: true,
      bootstrapKey: input.idempotencyKey,
    },
  });

  const taskChain = buildFocusedTaskChain({
    objective: input.objective,
    focusedTaskKeys: input.focusedTaskKeys,
    revisionInstructions: input.revisionInstructions,
  });

  const workItems: string[] = [];
  const workItemByTaskKey = new Map<string, string>();
  // 聚焦重生成时 work.dependsOn 会被 buildFocusedTaskChain 裁剪为空/白名单内，
  // 仅靠 dependsOn 无法把已批准的先行阶段注入 prior context；设置
  // focusedPlanRegeneration 标志让 generateFoundationWork 从 project_plan_sections
  // 读取已批准阶段作为重新生成的 prior context（见 postgres-repository.getFoundationWorkContext）。
  const focusedPlanRegeneration = Boolean(input.focusedTaskKeys && input.focusedTaskKeys.length > 0);
  for (const task of taskChain) {
    const dependsOn = task.dependsOn.map((taskKey) => {
      const workItemId = workItemByTaskKey.get(taskKey);
      if (!workItemId) throw new Error(`foundation DAG 引用了尚未定义的依赖：${task.taskKey} -> ${taskKey}`);
      return workItemId;
    });
    const item = await enqueueCreativeWork(repository, run.id, {
      kind: "generation",
      taskKey: task.taskKey,
      instruction: task.instruction,
      dependsOn,
      parameters: { bootstrap: true, ...(focusedPlanRegeneration ? { focusedPlanRegeneration: true } : {}) },
    });
    workItems.push(item.id);
    workItemByTaskKey.set(task.taskKey, item.id);
  }
  await repository.initializeProjectPlan({
    projectId: input.projectId,
    workItemByTaskKey,
    includedTaskKeys: taskChain.map((task) => task.taskKey),
  });

  const workflowId = run.id;
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "creative-run",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: {
      runId: run.id,
      objective: input.objective,
      includeChapterPlan,
      bootstrapKey: input.idempotencyKey,
    },
  });
  const handle = await temporal.workflow.start("creativeRunWorkflow", {
    args: [run.id],
    taskQueue: input.taskQueue ?? "novel-v2",
    workflowId,
  });

  return {
    run,
    workItems,
    taskChain: taskChain.map((task) => task.taskKey),
    workflowId,
    temporalRunId: handle.firstExecutionRunId,
    reused: false,
  };
}
