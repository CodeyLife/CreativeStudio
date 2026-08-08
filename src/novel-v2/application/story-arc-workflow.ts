import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { StoryArcPlotOutline } from "./story-arc";

/**
 * 故事弧外部编排模式（模式 B）：
 *
 * 外部大模型或用户提供剧情编排（plotOutline：objective 必填，其余为弧级
 * 设计意图），系统负责完善——规划工作流内部把编排作为 required section
 * 注入 arc.plan / chapter.blueprint / arc.review / arc.revision 执行点，
 * 对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、
 * 连续性约束与责任承接，再走正式弧审核 → 修订闭环。编排输入持久化在
 * workflow_runs.payload.plotOutline（arcs.payload 会被 bundle.arc 覆盖，
 * 不能作为编排的持久化位置），并写入蓝图 artifact 的 structuredData 提供
 * provenance。后续批次与审校通过 getStoryArcPlanningInput(projectId, arcId)
 * 读取同一份编排作为参考。
 */
export async function startStoryArcOrchestratedPlanning(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; plotOutline: StoryArcPlotOutline; mode: "web" | "mcp"; reviewPolicy?: "manual" | "auto"; authorIntent?: string; taskQueue?: string },
) {
  return repository.withStoryArcWorkflowLock(input.projectId, "next", async () => {
    const workflowId = `story-arc-${randomUUID()}`;
    const reviewPolicy = input.reviewPolicy ?? (input.mode === "mcp" ? "auto" : "manual");
    let arc: Awaited<ReturnType<NovelPostgresRepository["getStoryArc"]>>;
    try {
      arc = await repository.createNextStoryArc({ projectId: input.projectId, workflowId, authorIntent: input.authorIntent ?? input.plotOutline.objective, plotOutline: input.plotOutline });
      await repository.putWorkflowRun({
        id: workflowId,
        workflowType: "story-arc-planning",
        projectId: input.projectId,
        temporalWorkflowId: workflowId,
        status: "accepted",
        payload: { arcId: arc.id, mode: input.mode, reviewPolicy, authorIntent: input.authorIntent, rebase: false, plotOutline: input.plotOutline, orchestrated: true },
      });
      const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
        args: [{ workflowId, projectId: input.projectId, arcId: arc.id, mode: input.mode, reviewPolicy, authorIntent: input.authorIntent, plotOutline: input.plotOutline }],
        taskQueue: input.taskQueue ?? "novel-v2",
        workflowId,
      });
      return { arcId: arc.id, workflowId, runId: handle.firstExecutionRunId, status: "accepted", orchestrated: true, plotOutline: input.plotOutline };
    } catch (error) {
      await repository.updateWorkflowRunStatus(workflowId, "failed", { error: error instanceof Error ? error.message : String(error), reasonCode: "workflow-start-failed" }).catch(() => undefined);
      if (arc) await repository.recoverStoryArcAfterWorkflowCancellation(input.projectId, arc.id).catch(() => undefined);
      throw error;
    }
  });
}

export async function startStoryArcPlanning(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; mode: "web" | "mcp"; reviewPolicy?: "manual" | "auto"; authorIntent?: string; taskQueue?: string; arcId?: string },
) {
  return repository.withStoryArcWorkflowLock(input.projectId, input.arcId ?? "next", async () => {
    const workflowId = `story-arc-${randomUUID()}`;
    const reviewPolicy = input.reviewPolicy ?? (input.mode === "mcp" ? "auto" : "manual");
    const existingArc = input.arcId ? await repository.getStoryArc(input.projectId, input.arcId) : undefined;
    const rebase = Boolean(input.arcId && (existingArc?.blueprintArtifactId || existingArc?.chapters.some((chapter) => Boolean(chapter.documentId))));
    let arc: Awaited<ReturnType<NovelPostgresRepository["getStoryArc"]>>;
    try {
      arc = input.arcId
        ? await repository.markStoryArcGenerating(input.projectId, input.arcId, input.mode === "web" ? "web-author" : "mcp", { workflowId })
        : await repository.createNextStoryArc({ projectId: input.projectId, workflowId, authorIntent: input.authorIntent });
      if (!arc) throw new Error("故事弧不存在");
      await repository.putWorkflowRun({
        id: workflowId,
        workflowType: "story-arc-planning",
        projectId: input.projectId,
        temporalWorkflowId: workflowId,
        status: "accepted",
        payload: { arcId: arc.id, mode: input.mode, reviewPolicy, authorIntent: input.authorIntent, rebase },
      });
      const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
        args: [{ workflowId, projectId: input.projectId, arcId: arc.id, mode: input.mode, reviewPolicy, authorIntent: input.authorIntent, rebase }],
        taskQueue: input.taskQueue ?? "novel-v2",
        workflowId,
      });
      return { arcId: arc.id, workflowId, runId: handle.firstExecutionRunId, status: "accepted" };
    } catch (error) {
      await repository.updateWorkflowRunStatus(workflowId, "failed", { error: error instanceof Error ? error.message : String(error), reasonCode: "workflow-start-failed" }).catch(() => undefined);
      if (arc) await repository.recoverStoryArcAfterWorkflowCancellation(input.projectId, arc.id).catch(() => undefined);
      throw error;
    }
  });
}

export async function startStoryArcReview(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; arcId: string; mode: "web" | "mcp"; reviewPolicy?: "manual" | "auto"; taskQueue?: string },
) {
  return repository.withStoryArcWorkflowLock(input.projectId, input.arcId, async () => {
    const activeWorkflowIds = await repository.listActiveStoryArcWorkflowIds(input.projectId, input.arcId);
    if (activeWorkflowIds.length) throw new Error(`故事弧已有活动工作流：${activeWorkflowIds.join("、")}`);
    let arc = await repository.getStoryArc(input.projectId, input.arcId);
    if (arc?.planningStatus === "failed" && arc.blueprintArtifactId) {
      // failed 弧的恢复路径按批次状态分流，避免 retry 与 rebase 前置条件互斥造成死锁：
      // - 存在引用当前蓝图的 awaiting-review 批次：审核中断重审，走 retry（保留原蓝图，不重生成）
      // - 无引用当前蓝图的 awaiting-review 批次（批次已 approved 或引用旧蓝图，当前蓝图过时）：
      //   恢复 awaiting-review 走 rebase；"匹配当前蓝图"语义与 prepareStoryArcReviewRetry 精确互补
      const blueprintArtifactId = arc.blueprintArtifactId;
      const hasMatchingPendingBatchReview = arc.batches?.some((batch) => batch.status === "awaiting-review" && batch.sourceArtifactId === blueprintArtifactId) ?? false;
      const actor = input.mode === "web" ? "web-author" : "mcp";
      arc = hasMatchingPendingBatchReview
        ? await repository.prepareStoryArcReviewRetry(input.projectId, input.arcId, actor)
        : await repository.prepareStoryArcRebase(input.projectId, input.arcId, actor);
    }
    if (!arc?.blueprintArtifactId || arc.planningStatus !== "awaiting-review") throw new Error("故事弧当前没有可审核的蓝图");
    const workflowId = `story-arc-review-${randomUUID()}`;
    const reviewPolicy = input.reviewPolicy ?? (input.mode === "mcp" ? "auto" : "manual");
    // A review of an active arc can still sit behind committed chapters. Those
    // chapters remain frozen authority during review even before the whole arc
    // reaches completed status.
    // A pending batch artifact contains only the new planning window. Reviewing
    // it must stay on the ordinary batch path even when earlier chapters are
    // already committed; frozen-history rebase is for an artifact whose target
    // is the committed chapter set.
    const hasPendingBatchReview = arc.batches?.some((batch) => batch.status === "awaiting-review" && batch.sourceArtifactId === arc.blueprintArtifactId) ?? false;
    const rebase = !hasPendingBatchReview && (arc.executionStatus === "completed" || arc.chapters.some((chapter) => Boolean(chapter.documentId)));
    try {
      await repository.putWorkflowRun({
        id: workflowId,
        workflowType: "story-arc-planning",
        projectId: input.projectId,
        temporalWorkflowId: workflowId,
        status: "accepted",
        payload: { arcId: input.arcId, mode: input.mode, reviewPolicy, existingArtifactId: arc.blueprintArtifactId, rebase },
      });
      const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
        args: [{ workflowId, projectId: input.projectId, arcId: input.arcId, mode: input.mode, reviewPolicy, existingArtifactId: arc.blueprintArtifactId, rebase }],
        taskQueue: input.taskQueue ?? "novel-v2",
        workflowId,
      });
      return { arcId: input.arcId, workflowId, runId: handle.firstExecutionRunId, status: "accepted" };
    } catch (error) {
      await repository.updateWorkflowRunStatus(workflowId, "failed", { error: error instanceof Error ? error.message : String(error), reasonCode: "workflow-start-failed" }).catch(() => undefined);
      throw error;
    }
  });
}

export async function startStoryArcBatchPlanning(
  repository: NovelPostgresRepository,
  temporal: Client,
  input: { projectId: string; arcId: string; mode: "web" | "mcp"; reviewPolicy?: "manual" | "auto"; taskQueue?: string; retryFailed?: boolean },
) {
  return repository.withStoryArcWorkflowLock(input.projectId, input.arcId, async () => {
    const workflowId = `story-arc-batch-${randomUUID()}`;
    const reviewPolicy = input.reviewPolicy ?? (input.mode === "mcp" ? "auto" : "manual");
    let batch: { batchIndex: number; startChapterIndex: number } | undefined;
    try {
      batch = input.retryFailed
        ? await repository.prepareStoryArcBatchRetry(input.projectId, input.arcId)
        : await repository.prepareNextStoryArcBatch(input.projectId, input.arcId);
      await repository.putWorkflowRun({
        id: workflowId,
        workflowType: "story-arc-planning",
        projectId: input.projectId,
        temporalWorkflowId: workflowId,
        status: "accepted",
        payload: { arcId: input.arcId, mode: input.mode, reviewPolicy, retryFailed: input.retryFailed === true, batchIndex: batch.batchIndex, startChapterIndex: batch.startChapterIndex },
      });
      const handle = await temporal.workflow.start("storyArcPlanningWorkflow", {
        args: [{ workflowId, projectId: input.projectId, arcId: input.arcId, mode: input.mode, reviewPolicy, ...batch }],
        taskQueue: input.taskQueue ?? "novel-v2",
        workflowId,
      });
      return { arcId: input.arcId, workflowId, runId: handle.firstExecutionRunId, status: "accepted", ...batch };
    } catch (error) {
      if (batch) await repository.failStoryArcBatch(input.projectId, input.arcId, batch.batchIndex, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      await repository.updateWorkflowRunStatus(workflowId, "failed", { error: error instanceof Error ? error.message : String(error), reasonCode: "workflow-start-failed" }).catch(() => undefined);
      throw error;
    }
  });
}
