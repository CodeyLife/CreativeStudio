import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import type { NovelPostgresRepository } from "../postgres-repository";

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
      arc = await repository.prepareStoryArcReviewRetry(input.projectId, input.arcId, input.mode === "web" ? "web-author" : "mcp");
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
    const hasPendingBatchReview = arc.batches?.some((batch) => batch.status === "awaiting-review") ?? false;
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
