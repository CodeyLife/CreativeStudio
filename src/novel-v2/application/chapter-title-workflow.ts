import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import type { ChapterTitleWorkflowRepositoryAccess } from "../repository-capabilities";
import { isOpenWorkflowRunStatus } from "../run-lifecycle";
import { chapterTitleSourceFingerprint } from "./chapter-title";

export async function startChapterTitleGeneration(
  repository: ChapterTitleWorkflowRepositoryAccess,
  temporal: Client,
  input: { projectId: string; documentId: string; taskQueue?: string },
) {
  const [source, runs] = await Promise.all([
    repository.getChapterTitleSource(input.projectId, input.documentId),
    repository.listProjectRuns(input.projectId, 30),
  ]);
  if (!source) throw new Error("章节不存在");
  const sourceFingerprint = chapterTitleSourceFingerprint(source);
  const active = runs.find((run) => run.workflowType === "chapter-title" && isOpenWorkflowRunStatus(run.status)
    && run.payload.documentId === input.documentId && run.payload.sourceFingerprint === sourceFingerprint);
  if (active) return { workflowId: active.temporalWorkflowId, status: active.status, sourceFingerprint, reused: true };

  const workflowId = `chapter-title-${randomUUID()}`;
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "chapter-title",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { documentId: input.documentId, sourceFingerprint },
  });
  try {
    const handle = await temporal.workflow.start("chapterTitleWorkflow", {
      args: [{ workflowId, projectId: input.projectId, documentId: input.documentId, sourceFingerprint }],
      taskQueue: input.taskQueue ?? "creative-studio-novel-v2",
      workflowId,
    });
    return { workflowId, runId: handle.firstExecutionRunId, status: "accepted", sourceFingerprint, reused: false };
  } catch (error) {
    await repository.updateWorkflowRunStatus(workflowId, "failed", { documentId: input.documentId, reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
