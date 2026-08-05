import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startStoryArcBatchPlanning, startStoryArcPlanning, startStoryArcReview } from "../application/story-arc-workflow";
import type { NovelPostgresRepository } from "../postgres-repository";

describe("story arc review authority boundary", () => {
  it("retries a failed arc without chapters as ordinary planning, not rebase", async () => {
    const putWorkflowRun = vi.fn(async () => undefined);
    const markStoryArcGenerating = vi.fn(async () => ({ id: "arc-1", blueprintArtifactId: undefined, chapters: [] }));
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-1" }));
    const repository = {
      getStoryArc: vi.fn(async () => ({ id: "arc-1", planningStatus: "failed", blueprintArtifactId: undefined, chapters: [] })),
      markStoryArcGenerating,
      putWorkflowRun,
    } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start } } as never;

    await startStoryArcPlanning(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "web", reviewPolicy: "manual", taskQueue: "creative-studio-v2" });

    expect(markStoryArcGenerating).toHaveBeenCalledWith("project-1", "arc-1", "web-author", { workflowId: expect.any(String) });
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rebase: false }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ rebase: false })] }));
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
    const repository = { prepareStoryArcBatchRetry: retry, putWorkflowRun } as unknown as NovelPostgresRepository;
    const temporal = { workflow: { start } } as never;

    await startStoryArcBatchPlanning(repository, temporal, { projectId: "project-1", arcId: "arc-1", mode: "mcp", retryFailed: true, taskQueue: "novel-v2" });

    expect(retry).toHaveBeenCalledWith("project-1", "arc-1");
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ retryFailed: true, batchIndex: 2, startChapterIndex: 11 }) }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({ args: [expect.objectContaining({ batchIndex: 2, startChapterIndex: 11 })] }));
  });
});
