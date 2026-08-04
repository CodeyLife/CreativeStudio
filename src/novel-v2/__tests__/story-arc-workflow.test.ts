import { describe, expect, it, vi } from "vitest";
import { startStoryArcReview } from "../application/story-arc-workflow";
import type { NovelPostgresRepository } from "../postgres-repository";

describe("story arc review authority boundary", () => {
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
});
