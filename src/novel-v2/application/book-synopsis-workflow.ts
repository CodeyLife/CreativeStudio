import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import type { BookSynopsisWorkflowRepositoryAccess } from "../repository-capabilities";
import { isOpenWorkflowRunStatus } from "../run-lifecycle";
import { bookSynopsisSourceFingerprint, bookTitleSourceFingerprint, missingSynopsisPlanStages } from "./book-synopsis";

export async function startBookSynopsisGeneration(
  repository: BookSynopsisWorkflowRepositoryAccess,
  temporal: Client,
  input: { projectId: string; taskQueue?: string },
) {
  const [sections, project, runs] = await Promise.all([
    repository.listProjectPlanSections(input.projectId),
    repository.getProjectDetail(input.projectId),
    repository.listProjectRuns(input.projectId, 20),
  ]);
  const missing = missingSynopsisPlanStages(sections);
  if (missing.length) throw new Error(`全书规划尚未全部确认：${missing.join("、")}`);
  const sourceFingerprint = bookSynopsisSourceFingerprint({ projectTitle: project.title, sections });
  const active = runs.find((run) => run.workflowType === "book-synopsis" && isOpenWorkflowRunStatus(run.status) && run.payload.sourceFingerprint === sourceFingerprint);
  if (active) return { workflowId: active.temporalWorkflowId, status: active.status, sourceFingerprint, reused: true };

  const workflowId = `book-synopsis-${randomUUID()}`;
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "book-synopsis",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { sourceFingerprint },
  });
  try {
    const handle = await temporal.workflow.start("bookSynopsisWorkflow", {
      args: [{ workflowId, projectId: input.projectId, sourceFingerprint }],
      taskQueue: input.taskQueue ?? "creative-studio-novel-v2",
      workflowId,
    });
    return { workflowId, runId: handle.firstExecutionRunId, status: "accepted", sourceFingerprint, reused: false };
  } catch (error) {
    await repository.updateWorkflowRunStatus(workflowId, "failed", { reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function startBookTitleCandidateGeneration(
  repository: BookSynopsisWorkflowRepositoryAccess,
  temporal: Client,
  input: { projectId: string; taskQueue?: string },
) {
  const [sections, runs] = await Promise.all([
    repository.listProjectPlanSections(input.projectId),
    repository.listProjectRuns(input.projectId, 20),
  ]);
  const missing = missingSynopsisPlanStages(sections);
  if (missing.length) throw new Error(`全书规划尚未全部确认：${missing.join("、")}`);
  const sourceFingerprint = bookTitleSourceFingerprint(sections);
  const active = runs.find((run) => run.workflowType === "book-title-candidates" && isOpenWorkflowRunStatus(run.status) && run.payload.sourceFingerprint === sourceFingerprint);
  if (active) return { workflowId: active.temporalWorkflowId, status: active.status, sourceFingerprint, reused: true };

  const workflowId = `book-title-candidates-${randomUUID()}`;
  await repository.putWorkflowRun({
    id: workflowId,
    workflowType: "book-title-candidates",
    projectId: input.projectId,
    temporalWorkflowId: workflowId,
    status: "accepted",
    payload: { sourceFingerprint },
  });
  try {
    const handle = await temporal.workflow.start("bookTitleCandidatesWorkflow", {
      args: [{ workflowId, projectId: input.projectId, sourceFingerprint }],
      taskQueue: input.taskQueue ?? "creative-studio-novel-v2",
      workflowId,
    });
    return { workflowId, runId: handle.firstExecutionRunId, status: "accepted", sourceFingerprint, reused: false };
  } catch (error) {
    await repository.updateWorkflowRunStatus(workflowId, "failed", { reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
