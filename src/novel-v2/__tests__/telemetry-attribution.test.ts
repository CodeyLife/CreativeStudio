import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelWorkPackage } from "../model-routing";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/**
 * Telemetry (model_tasks / model_invocations / prompt_executions) and the
 * transactional outbox used to have no project attribution: deleting a
 * project silently orphaned their rows and per-project accounting was
 * impossible. Migration 083 plus the write-path changes make attribution
 * structural and the FK cascade complete.
 */
describe("telemetry project attribution (migration 083)", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-telemetry-${randomUUID().slice(0, 8)}`;
  const otherProjectId = `test-telemetry-b-${randomUUID().slice(0, 8)}`;
  const runId = `run-${randomUUID()}`;
  const temporalId = `temporal-${randomUUID()}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Telemetry Test");
      await repository.ensureProject(otherProjectId, "Telemetry Test B");
      await repository.putWorkflowRun({ id: runId, workflowType: "chapter-generation", projectId, temporalWorkflowId: temporalId, status: "running" });
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[telemetry-attribution.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.deleteProject(otherProjectId).catch(() => undefined);
    await repository.close();
  });

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await repository.pool.query<{ count: string }>(sql, params);
    return Number(result.rows[0]?.count ?? "0");
  }

  it("derives project_id from the owning run regardless of run id form", async () => {
    if (!available) return;
    const base = { purpose: "writing.draft" as const, configRevision: "test", candidateIndex: 0, executor: "api" as const, model: "test-model", status: "completed" as const, inputTokens: 1, outputTokens: 1, latencyMs: 1, promptFingerprint: `fp-${randomUUID()}` };
    await repository.recordModelInvocation({ ...base, workflowRunId: runId });
    await repository.recordModelInvocation({ ...base, workflowRunId: temporalId });
    await repository.recordModelInvocation({ ...base });

    expect(await count("SELECT count(*) FROM model_invocations WHERE workflow_run_id=$1 AND project_id=$2", [runId, projectId])).toBe(1);
    expect(await count("SELECT count(*) FROM model_invocations WHERE workflow_run_id=$1 AND project_id=$2", [temporalId, projectId])).toBe(1);
    // Unattributable rows (no owning run) must stay attributable-null, not be dropped.
    expect(await count("SELECT count(*) FROM model_invocations WHERE workflow_run_id IS NULL AND project_id IS NULL")).toBeGreaterThanOrEqual(1);
  });

  it("attributes external work packages and filters the queue by project", async () => {
    if (!available) return;
    const workPackage: ModelWorkPackage = {
      id: `wp-${randomUUID()}`, workflowRunId: temporalId, taskId: "draft", purpose: "writing.draft",
      configRevision: "test", candidateIndex: 0, outputKind: "text", instruction: "写一段测试", baseRevision: 1,
      inputFingerprint: `ifp-${randomUUID()}`, contextRefs: {}, createdAt: Date.now(),
    };
    const task = await repository.createModelTask(workPackage, `idem-${randomUUID()}`);
    expect(task.projectId).toBe(projectId);
    const own = await repository.listModelTasks("pending", 100, projectId);
    expect(own.map((row) => row.id)).toContain(task.id);
    const other = await repository.listModelTasks("pending", 100, otherProjectId);
    expect(other.map((row) => row.id)).not.toContain(task.id);
  });

  it("stamps outbox events with the payload project", async () => {
    if (!available) return;
    // putWorkflowRun appends workflow.* with { projectId } in the payload.
    expect(await count("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND project_id=$2", [temporalId, projectId])).toBeGreaterThanOrEqual(1);
  });

  it("purges all project telemetry when the project is deleted", async () => {
    if (!available) return;
    const strayProjectId = `test-telemetry-stray-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(strayProjectId, "Stray");
    const strayRunId = `run-${randomUUID()}`;
    await repository.putWorkflowRun({ id: strayRunId, workflowType: "chapter-generation", projectId: strayProjectId, temporalWorkflowId: `temporal-${randomUUID()}`, status: "running" });
    await repository.recordModelInvocation({ workflowRunId: strayRunId, purpose: "writing.draft", configRevision: "test", candidateIndex: 0, executor: "api", model: "m", status: "completed", inputTokens: 1, outputTokens: 1, latencyMs: 1, promptFingerprint: `fp-${randomUUID()}` });
    await repository.createModelTask(
      { id: `wp-${randomUUID()}`, workflowRunId: strayRunId, taskId: "draft", purpose: "writing.draft", configRevision: "test", candidateIndex: 0, outputKind: "text", instruction: "x", baseRevision: 1, inputFingerprint: `ifp-${randomUUID()}`, contextRefs: {}, createdAt: Date.now() },
      `idem-${randomUUID()}`,
    );
    await repository.deleteProject(strayProjectId);
    expect(await count("SELECT count(*) FROM model_invocations WHERE workflow_run_id=$1", [strayRunId])).toBe(0);
    expect(await count("SELECT count(*) FROM model_tasks WHERE workflow_run_id=$1", [strayRunId])).toBe(0);
    expect(await count("SELECT count(*) FROM outbox_events WHERE payload->>'projectId'=$1", [strayProjectId])).toBe(0);
    // Rows without any owning run are untouched by the delete.
    expect(await count("SELECT count(*) FROM model_invocations WHERE workflow_run_id IS NULL AND project_id IS NULL")).toBeGreaterThanOrEqual(1);
  });

  it("category guard: every project-bearing table cascades or is explicitly exempted", async () => {
    if (!available) return;
    const result = await repository.pool.query<{ table_name: string }>(`
      WITH proj_tables AS (
        SELECT table_name FROM information_schema.columns
        WHERE column_name='project_id' AND table_schema=current_schema() AND table_name NOT LIKE 'LiteLLM%'
      ), fk AS (
        SELECT c.relname AS tbl, r.confdeltype::text AS deltype
        FROM pg_constraint r
        JOIN pg_class c ON c.oid=r.conrelid
        JOIN pg_class conf ON conf.oid=r.confrelid
        WHERE r.contype='f' AND conf.relname='novel_projects'
      )
      SELECT pt.table_name FROM proj_tables pt LEFT JOIN fk ON fk.tbl=pt.table_name
      WHERE coalesce(fk.deltype,'N') <> 'c' AND pt.table_name <> 'novel_projects'
    `);
    // short_scripts detaches (SET NULL) by design: scripts outlive their workspace project.
    // short_drama_workspaces 同形（090 明文 ON DELETE SET NULL，创作台可独立于小说项目存在）。
    const EXEMPT = new Set(["short_scripts", "short_drama_workspaces"]);
    expect(result.rows.map((row) => row.table_name).filter((name) => !EXEMPT.has(name))).toEqual([]);
  });
});
