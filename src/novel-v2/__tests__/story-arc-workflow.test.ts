import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startStoryArcBatchPlanning, startStoryArcOrchestratedPlanning, startStoryArcPlanning, startStoryArcReview } from "../application/story-arc-workflow";
import type { NovelPostgresRepository } from "../postgres-repository";

const withStoryArcWorkflowLock = async <T>(_projectId: string, _arcId: string, callback: () => Promise<T>): Promise<T> => callback();

describe("story arc review authority boundary", () => {
  it("retries a failed arc without chapters as ordinary planning, not rebase", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const markStoryArcGenerating = vi.fn(async () => ({ id: "arc-1", blueprintArtifactId: undefined, chapters: [] }));
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const repository = {
      getStoryArc: vi.fn(async () => ({ id: "arc-1", planningStatus: "failed", blueprintArtifactId: undefined, chapters: [] })),
      markStoryArcGenerating,
      putWorkflowRun,
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      recoverStoryArcAfterWorkflowCancellation: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start } } as never;

    await startStoryArcPlanning(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "web", reviewPolicy: "manual", taskQueue: "creative-studio-v2" });

    expect(markStoryArcGenerating).toHaveBeenCalledWith("project-1", "arc-1", "web-author", { workflowId: expect.any(String) });
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rebase: false }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ rebase: false })] }));
  });

  it("recovers the arc and records a failed run when Temporal start fails", async () => {
    const recoverStoryArcAfterWorkflowCancellation = vi.fn(async () => undefined);
    const updateWorkflowRunStatus = vi.fn(async () => undefined);
    const repository = {
      getStoryArc: vi.fn(async () => ({ id: "arc-1", planningStatus: "failed", blueprintArtifactId: undefined, chapters: [] })),
      markStoryArcGenerating: vi.fn(async () => ({ id: "arc-1", blueprintArtifactId: undefined, chapters: [] })),
      putWorkflowRun: vi.fn(async () => undefined),
      updateWorkflowRunStatus,
      recoverStoryArcAfterWorkflowCancellation,
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = {
      workflow: { start: vi.fn(async () => { throw new Error("Temporal unavailable"); }) },
    } as never;

    await expect(startStoryArcPlanning(repository, temporal, {
      projectId: "project-1",
      arcId: "arc-1",
      mode: "web",
      reviewPolicy: "manual",
      taskQueue: "creative-studio-v2",
    })).rejects.toThrow("Temporal unavailable");

    expect(updateWorkflowRunStatus).toHaveBeenCalledWith(expect.any(String), "failed", expect.objectContaining({ reasonCode: "workflow-start-failed" }));
    expect(recoverStoryArcAfterWorkflowCancellation).toHaveBeenCalledWith("project-1", "arc-1");
  });

  it("rejects a review while another story-arc workflow is active", async () => {
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const repository = {
      listActiveStoryArcWorkflowIds: vi.fn(async () => ["story-arc-active"]),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start } } as never;

    await expect(startStoryArcReview(repository, temporal, {
      projectId: "project-1",
      arcId: "arc-1",
      mode: "web",
      reviewPolicy: "manual",
      taskQueue: "creative-studio-v2",
    })).rejects.toThrow("故事弧已有活动工作流");

    expect(start).not.toHaveBeenCalled();
  });

  it("marks an active arc with committed chapters as a frozen-history review", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const repository = {
      getStoryArc: vi.fn(async () => ({
        id: "arc-1",
        planningStatus: "awaiting-review",
        executionStatus: "active",
        blueprintArtifactId: "artifact-1",
        chapters: [{ documentId: "document-1" }],
      })),
      putWorkflowRun,
      listActiveStoryArcWorkflowIds: vi.fn(async () => []),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = {
      workflow: { start: vi.fn(async () => ({ firstExecutionRunId: "run-1" })) },
    } as never;

    await startStoryArcReview(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "web", reviewPolicy: "manual", taskQueue: "creative-studio-v2" });

    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rebase: true, existingArtifactId: "artifact-1" }) }));
  });

  it("keeps an uncommitted arc on the ordinary review path", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const repository = {
      getStoryArc: vi.fn(async () => ({
        id: "arc-1",
        planningStatus: "awaiting-review",
        executionStatus: "active",
        blueprintArtifactId: "artifact-1",
        chapters: [{ documentId: undefined }],
      })),
      putWorkflowRun,
      listActiveStoryArcWorkflowIds: vi.fn(async () => []),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start: vi.fn(async () => ({ firstExecutionRunId: "run-1" })) } } as never;

    await startStoryArcReview(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "web", reviewPolicy: "manual", taskQueue: "creative-studio-v2" });

    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rebase: false }) }));
  });

  it("keeps a pending later batch on the ordinary review path beside committed history", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const repository = {
      getStoryArc: vi.fn(async () => ({
        id: "arc-1",
        planningStatus: "awaiting-review",
        executionStatus: "active",
        blueprintArtifactId: "artifact-2",
        chapters: [{ documentId: "document-1" }, { documentId: undefined }],
        batches: [
          { batchIndex: 1, status: "approved", sourceArtifactId: "artifact-1" },
          { batchIndex: 2, status: "awaiting-review", sourceArtifactId: "artifact-2" },
        ],
      })),
      putWorkflowRun,
      listActiveStoryArcWorkflowIds: vi.fn(async () => []),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = {
      workflow: { start: vi.fn(async () => ({ firstExecutionRunId: "run-1" })) },
    } as never;

    await startStoryArcReview(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "mcp", reviewPolicy: "auto", taskQueue: "novel-v2" });

    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rebase: false, existingArtifactId: "artifact-2" }) }));
  });

  it("expires the latest external task when split arc generation fails", () => {
    const source = readFileSync(fileURLToPath(new URL("../temporal/workflows.ts", import.meta.url)), "utf8");
    const start = source.indexOf("const generateBundle = async");
    const end = source.indexOf("const reviewBundle = async", start);
    const block = source.slice(start, end);

    expect(block).toContain("let failedTask = generated.task");
    expect(block).toContain("failedTask = chapters.task");
    expect(block).toContain("modelTaskId: failedTask.id");
    expect(block).toContain("nextCandidate = failedTask.candidateIndex + 1");
  });

  it("does not retry the full story-arc model activity after the gateway exhausts candidates", () => {
    const source = readFileSync(fileURLToPath(new URL("../temporal/workflows.ts", import.meta.url)), "utf8");
    const start = source.indexOf("export async function storyArcPlanningWorkflow");
    const end = source.indexOf("export async function creativeRunWorkflow", start);
    const block = source.slice(start, end);
    expect(block).toContain("const storyArcModelActivities = proxyActivities");
    expect(block).toContain("retry: { maximumAttempts: 1");
    expect(block).toContain("storyArcModelActivities.generateStoryArcBundle");
  });

  it("feeds warning-only story-arc review evidence into learning", () => {
    const source = readFileSync(fileURLToPath(new URL("../temporal/workflows.ts", import.meta.url)), "utf8");
    const start = source.indexOf("const runStoryArcLearning = async");
    const end = source.indexOf("  try {", start);
    const block = source.slice(start, end);

    expect(block).toContain("if (!reviewed.review.issues.length) return;");
    expect(block).not.toContain('issue.severity === "blocker" || issue.severity === "major"');
  });

  it("keeps Temporal cancellation on the cancellation lifecycle", () => {
    const source = readFileSync(fileURLToPath(new URL("../temporal/workflows.ts", import.meta.url)), "utf8");
    const start = source.indexOf("export async function storyArcPlanningWorkflow");
    const end = source.indexOf("export async function creativeRunWorkflow", start);
    const block = source.slice(start, end);

    expect(source).toContain("isCancellation");
    expect(block).toContain("CancellationScope.nonCancellable");
    expect(block).toContain('status: "cancelled"');
    expect(block).toContain('if (isCancellation(error))');
  });

  it("reopens a failed arc review without regenerating its blueprint", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const retry = vi.fn(async () => ({
      id: "arc-1",
      planningStatus: "awaiting-review",
      executionStatus: "active",
      blueprintArtifactId: "artifact-1",
      chapters: [{ documentId: "document-1" }],
    }));
    const repository = {
      getStoryArc: vi.fn(async () => ({
        id: "arc-1",
        planningStatus: "failed",
        executionStatus: "active",
        blueprintArtifactId: "artifact-1",
        chapters: [{ documentId: "document-1" }],
      })),
      prepareStoryArcReviewRetry: retry,
      putWorkflowRun,
      listActiveStoryArcWorkflowIds: vi.fn(async () => []),
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start: vi.fn(async () => ({ firstExecutionRunId: "run-1" })) } } as never;

    await startStoryArcReview(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "web", reviewPolicy: "manual", taskQueue: "creative-studio-v2" });

    expect(retry).toHaveBeenCalledWith("project-1", "arc-1", "web-author");
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ existingArtifactId: "artifact-1", rebase: true }) }));
  });

  it("retries a failed batch in its original chapter range", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const retry = vi.fn(async () => ({ batchIndex: 2, startChapterIndex: 11 }));
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-2" }));
    const repository = {
      prepareStoryArcBatchRetry: retry,
      putWorkflowRun,
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      failStoryArcBatch: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start } } as never;

    await startStoryArcBatchPlanning(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "mcp", retryFailed: true, taskQueue: "novel-v2" });

    expect(retry).toHaveBeenCalledWith("project-1", "arc-1");
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ retryFailed: true, batchIndex: 2, startChapterIndex: 11 }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ batchIndex: 2, startChapterIndex: 11 })] }));
  });

  it("starts orchestrated planning with the plot outline persisted in the run payload", async () => {
    const createNextStoryArc = vi.fn(async () => ({ id: "arc-orch-1" }));
    const putWorkflowRun = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-orch" }));
    const repository = {
      createNextStoryArc,
      putWorkflowRun,
      updateWorkflowRunStatus: vi.fn(async () => undefined),
      recoverStoryArcAfterWorkflowCancellation: vi.fn(async () => undefined),
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start } } as never;
    const outline = { objective: "查明暗渠上方的体系", development: ["找到守门人", "通过审查"], plotNotes: "伏笔在守门人手里" };

    const result = await startStoryArcOrchestratedPlanning(repository, temporal, { projectId: "project-1", plotOutline: outline, mode: "mcp", reviewPolicy: "auto", taskQueue: "novel-v2" });

    expect(result).toMatchObject({ arcId: "arc-orch-1", status: "accepted", orchestrated: true });
    expect(createNextStoryArc).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", plotOutline: outline, authorIntent: outline.objective }));
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "story-arc-planning",
      payload: expect.objectContaining({ orchestrated: true, plotOutline: outline, arcId: "arc-orch-1" }),
    }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({
      args: [expect.objectContaining({ arcId: "arc-orch-1", plotOutline: outline })],
    }));
  });

  it("records a failed run and recovers the arc when orchestrated workflow start fails", async () => {
    const updateWorkflowRunStatus = vi.fn(async () => undefined);
    const recover = vi.fn(async () => undefined);
    const repository = {
      createNextStoryArc: vi.fn(async () => ({ id: "arc-orch-fail" })),
      putWorkflowRun: vi.fn(async () => undefined),
      updateWorkflowRunStatus,
      recoverStoryArcAfterWorkflowCancellation: recover,
      withStoryArcWorkflowLock,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start: vi.fn(async () => { throw new Error("Temporal unavailable"); }) } } as never;

    await expect(startStoryArcOrchestratedPlanning(repository, temporal, {
      projectId: "project-1",
      plotOutline: { objective: "查明暗渠上方的体系", plotNotes: "伏笔在守门人手里" },
      mode: "mcp",
      taskQueue: "novel-v2",
    })).rejects.toThrow("Temporal unavailable");

    expect(updateWorkflowRunStatus).toHaveBeenCalledWith(expect.any(String), "failed", expect.objectContaining({ reasonCode: "workflow-start-failed" }));
    expect(recover).toHaveBeenCalledWith("project-1", "arc-orch-fail");
  });
});
