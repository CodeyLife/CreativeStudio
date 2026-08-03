import { describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact, RuntimeLearningAssessmentV2 } from "../protocol";

type QueryCall = { sql: string; params?: unknown[] };

function createRepository(responses: Array<{ rows?: unknown[]; rowCount?: number }> = []) {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
    connect: async () => {
      const clientCalls: QueryCall[] = [];
      const client = {
        calls: clientCalls,
        query: async (sql: string, params?: unknown[]) => {
          clientCalls.push({ sql, params });
          if (sql.startsWith("DELETE FROM novel_projects")) return { rows: [{ id: params?.[0] }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
      return client;
    },
  };
  const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
  Object.defineProperty(repository, "pool", { value: pool });
  return { repository, calls };
}

const documentRow = { id: "doc-1", project_id: "p1", title: "第一章", narrative_order: 1, pov_character_id: null, current_revision_id: null, status: "planned", created_at: new Date(0), updated_at: new Date(0) };

describe("V2 repository management APIs", () => {
  it("does not publish a project title while project-positioning is awaiting confirmation", async () => {
    const calls: QueryCall[] = [];
    const sectionRow = {
      project_id: "p1",
      task_key: "project-positioning",
      work_item_id: "work-1",
      source_artifact_id: "artifact-2",
      status: "awaiting-confirmation",
      payload: {
        title: "项目定位",
        summary: "摘要不应被当作书名",
        structuredData: { positioning: { bookTitle: "《保存后的正式书名》" } },
      },
      edit_revision: 1,
      approved_at: null,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("UPDATE project_plan_sections SET source_artifact_id")) return { rows: [sectionRow], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) } });
    const artifact = {
      id: "artifact-2",
      projectId: "p1",
      taskId: "project-positioning",
      attemptId: "attempt-2",
      kind: "foundation",
      contentHash: "hash-2",
      objectKey: "objects/hash-2",
      baseRevision: 0,
      fingerprint: "fingerprint-2",
      structuredData: sectionRow.payload,
      createdAt: Date.now(),
    } satisfies Artifact;

    await repository.replaceProjectPlanSection({ projectId: "p1", taskKey: "project-positioning", artifact, actor: "web-author" });

    expect(calls.some((call) => call.sql.startsWith("UPDATE novel_projects SET title"))).toBe(false);
  });

  it("publishes the explicit book title only after project-positioning is approved", async () => {
    const calls: QueryCall[] = [];
    const sectionRow = {
      project_id: "p1",
      task_key: "project-positioning",
      work_item_id: "work-1",
      source_artifact_id: "artifact-2",
      status: "awaiting-confirmation",
      payload: { structuredData: { positioning: { bookTitle: "《确认后的正式书名》" } } },
      edit_revision: 1,
      approved_at: null,
      created_at: new Date(0),
      updated_at: new Date(0),
    };
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.startsWith("SELECT project_id,task_key,work_item_id")) return { rows: [sectionRow], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) } });

    await repository.approveProjectPlanSection("p1", "project-positioning", "artifact-2", "web-author");

    const titleUpdate = calls.find((call) => call.sql.startsWith("UPDATE novel_projects SET title"));
    expect(titleUpdate?.params).toEqual(["p1", "确认后的正式书名"]);
  });

  it("updates documents with explicit POV clearing and emits an outbox event", async () => {
    const { repository, calls } = createRepository([{ rows: [documentRow], rowCount: 1 }, { rows: [{ id: 1 }], rowCount: 1 }]);
    await expect(repository.updateDocument({ projectId: "p1", documentId: "doc-1", title: "新标题", povCharacterId: null, status: "review" })).resolves.toMatchObject({ id: "doc-1", title: "第一章" });
    expect(calls[0].params).toEqual(["p1", "doc-1", "新标题", null, true, null, "review"]);
    expect(calls[1].sql).toContain("INSERT INTO outbox_events");
    expect(calls[1].params?.[2]).toBe("document.updated");
  });

  it("lists project runs as protocol records", async () => {
    const { repository } = createRepository([{ rows: [{ id: "run-1", workflow_type: "novel-intent", project_id: "p1", temporal_workflow_id: "wf-1", status: "accepted", payload: { task: "draft" }, created_at: new Date(0), updated_at: new Date(1) }], rowCount: 1 }]);
    await expect(repository.listProjectRuns("p1", 5)).resolves.toEqual([{ id: "run-1", workflowType: "novel-intent", projectId: "p1", temporalWorkflowId: "wf-1", status: "accepted", payload: { task: "draft" }, createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString() }]);
  });

  it("loads focused plan regeneration context from current approved projections", async () => {
    const { repository, calls } = createRepository([
      { rows: [{ title: "测试项目", metadata: { genre: "悬疑" } }], rowCount: 1 },
      { rows: [{ task_key: "project-positioning", payload: { title: "定位", summary: "作者修订后的当前项目定位" } }], rowCount: 1 },
    ]);
    await expect(repository.getFoundationWorkContext("p1", [], "characters")).resolves.toEqual({
      project: { title: "测试项目", metadata: { genre: "悬疑" } },
      priorArtifacts: [{ taskKey: "project-positioning", title: "定位", summary: "作者修订后的当前项目定位" }],
    });
    expect(calls[1].sql).toContain("FROM project_plan_sections ps");
    expect(calls[1].sql).toContain("ps.status='approved'");
    expect(calls[1].params).toEqual(["p1", ["project-positioning"]]);
  });

  it("does not promote learning directly; it records regression validation requirement", async () => {
    const assessment: RuntimeLearningAssessmentV2 = { id: "learn-1", projectId: "p1", source: { workflowId: "wf-1", reviewIds: [], fingerprint: "fp" }, conclusion: "propose-improvement", symptom: "问题", failingLayer: "review", underlyingMechanism: "共享机制", affectedInputClass: "长篇章节", boundaries: "仅章节", regressionRisks: ["误伤"], candidate: { targetKind: "skill", targetId: "reader-audit", rationale: "修复", afterText: "足够长的候选文本" }, createdAt: 1 };
    const { repository, calls } = createRepository([{ rows: [{ project_id: "p1", payload: assessment }], rowCount: 1 }, { rows: [], rowCount: 1 }, { rows: [{ id: 7 }], rowCount: 1 }]);
    await expect(repository.requestLearningPromotion("learn-1")).resolves.toMatchObject({ promoted: false, status: "regression-validation-required" });
    expect(calls[1].sql).toContain("INSERT INTO audit_records");
    expect(calls[2].params?.[2]).toBe("learning.promotion-regression-required");
  });

  it("deletes projects through a transaction before removing the project row", async () => {
    const { repository } = createRepository();
    await expect(repository.deleteProject("p1")).resolves.toEqual({ deleted: true, projectId: "p1" });
  });
});
