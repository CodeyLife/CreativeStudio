import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelWorkPackage } from "../model-routing";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function workPackage(workflowRunId: string): ModelWorkPackage {
  return {
    id: `mt-${randomUUID()}`, workflowRunId, taskId: `task-${randomUUID()}`, purpose: "writing.draft",
    configRevision: `rev-${randomUUID().slice(0, 8)}`, candidateIndex: 0, outputKind: "text",
    instruction: "租约完整性测试工作包", baseRevision: 1, inputFingerprint: `fp-${randomUUID()}`,
    contextRefs: {}, createdAt: Date.now(),
  };
}

/**
 * OR-B2/B3/B4（product-audit-20260910 E3）：外部任务链路自洽。
 * 核心症状是 claim/heartbeat/submit "从未真正跑通"——本文件先证明它能跑通，
 * 再守住"无 owner 租约行不可能存在"与僵尸对账的双向边界。
 */
describe("外部任务租约链路（migration 086）", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-lease-${randomUUID().slice(0, 8)}`;
  const runId = `run-${randomUUID()}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Lease Integrity Test");
      await repository.putWorkflowRun({ id: runId, workflowType: "chapter-generation", projectId, temporalWorkflowId: `temporal-${runId}`, status: "running" });
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[lease-integrity.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("claim → heartbeat → submit 全循环真正跑通，租约行带 model_task_id", async () => {
    if (!available) return;
    const wp = workPackage(`temporal-${runId}`);
    await repository.createModelTask(wp, `idem-${randomUUID()}`);
    const attemptId = `attempt-${randomUUID()}`;
    const owner = "probe-owner";

    await repository.claimModelTask({ taskId: wp.id, attemptId, leaseOwner: owner, leaseMs: 60_000 });
    const claimed = await repository.pool.query<{ model_task_id: string | null; lease_owner: string | null; status: string }>(
      "SELECT model_task_id, lease_owner, status FROM task_attempts WHERE id=$1", [attemptId],
    );
    expect(claimed.rows[0]).toMatchObject({ model_task_id: wp.id, lease_owner: owner, status: "claimed" });

    await repository.heartbeatModelTask({ taskId: wp.id, attemptId, leaseOwner: owner, leaseMs: 60_000 });
    // 错误 owner 的心跳必须被守卫拒绝（租约专属）。
    await expect(repository.heartbeatModelTask({ taskId: wp.id, attemptId, leaseOwner: "thief", leaseMs: 60_000 })).rejects.toThrow(/租约/);
    await repository.submitModelTask({ taskId: wp.id, attemptId, leaseOwner: owner, inputFingerprint: wp.inputFingerprint, result: { text: "外部结果" } });
    const submitted = await repository.getModelTask(wp.id);
    expect(submitted?.status).toBe("submitted");
  });

  it("CHECK 约束双向：外部租约行无 owner 的 running 不可能存在；workflow 业务 attempt 不受约束", async () => {
    if (!available) return;
    await expect(repository.pool.query(
      "INSERT INTO task_attempts(id,workflow_run_id,task_id,model_task_id,status) VALUES($1,$2,'t','mt-no-owner','running')",
      [`zombie-${randomUUID()}`, `temporal-${runId}`],
    )).rejects.toThrow(/task_attempts_owner_required|check|violates/iu);
    await repository.pool.query(
      "INSERT INTO task_attempts(id,workflow_run_id,task_id,model_task_id,lease_owner,lease_expires_at,status) VALUES($1,$2,'t','mt-owned',$3,now()+interval '1 minute','running')",
      [`owned-${randomUUID()}`, `temporal-${runId}`, "probe-owner"],
    );
    // 业务 attempt（model_task_id NULL）running 无 owner 合法——进度标记无租约语义。
    await repository.upsertTaskAttempt({ id: `biz-${randomUUID()}`, workflowRunId: `temporal-${runId}`, taskId: `blueprint:review`, status: "running", payload: { taskKind: "review" } });
  });

  it("reopen join 走 model_task_id：过期租约的任务回到 pending，业务 attempt 不干扰", async () => {
    if (!available) return;
    const wp = workPackage(`temporal-${runId}`);
    await repository.createModelTask(wp, `idem-${randomUUID()}`);
    await repository.claimModelTask({ taskId: wp.id, attemptId: `attempt-${randomUUID()}`, leaseOwner: "slow-worker", leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 任意 listModelTasks/getModelTask 触发 reopen：租约过期 ⇒ 任务回 pending。
    const refreshed = await repository.getModelTask(wp.id);
    expect(refreshed?.status).toBe("pending");
    // 反方向：租约仍有效的任务不被 reopen 抢回。
    const held = workPackage(`temporal-${runId}`);
    await repository.createModelTask(held, `idem-${randomUUID()}`);
    await repository.claimModelTask({ taskId: held.id, attemptId: `attempt-${randomUUID()}`, leaseOwner: "live-worker", leaseMs: 60_000 });
    expect((await repository.getModelTask(held.id))?.status).toBe("claimed");
  });

  it("expireModelTask 发 model-task.expired outbox 事件且幂等（重复 expire 不重复发）", async () => {
    if (!available) return;
    const wp = workPackage(`temporal-${runId}`);
    await repository.createModelTask(wp, `idem-${randomUUID()}`);
    await repository.expireModelTask(wp.id, "外部模型任务等待超时");
    await repository.expireModelTask(wp.id, "外部模型任务等待超时");
    const events = await repository.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_type='model-task' AND aggregate_id=$1 AND event_type='model-task.expired'",
      [wp.id],
    );
    expect(Number(events.rows[0].count)).toBe(1);
    // pending 状态的僵尸 run 名下任务也被对账清账（见 reconcile 用例），此处验证直接 expire 生效。
    expect((await repository.getModelTask(wp.id))?.status).toBe("failed");
  });
});

describe("reconcileStaleWorkflowRuns（OR-B4 僵尸对账）", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-reconcile-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Reconcile Test");
      available = true;
    } catch (error) {
      console.warn(`[lease-integrity.test] reconcile 组跳过: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  async function makeRun(temporalId: string, status: string, agePrefix: string) {
    await repository.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-generation", projectId, temporalWorkflowId: temporalId, status: "running" });
    await repository.pool.query(`UPDATE workflow_runs SET status=$2, updated_at=now() - ${agePrefix} WHERE temporal_workflow_id=$1`, [temporalId, status]);
  }
  async function runStatus(temporalId: string) {
    const row = await repository.pool.query<{ status: string; payload: Record<string, unknown> }>("SELECT status,payload FROM workflow_runs WHERE temporal_workflow_id=$1", [temporalId]);
    return row.rows[0];
  }

  it("超窗收编与合法停驻保留的双向全矩阵", async () => {
    if (!available) return;
    const nowMs = Date.now();
    await makeRun("rec-running-stale", "running", "interval '7 days'");
    await makeRun("rec-running-fresh", "running", "interval '5 hours'");
    await makeRun("rec-waiting-stale", "waiting-external", "interval '25 hours'");
    await makeRun("rec-waiting-fresh", "waiting-external", "interval '23 hours'");
    await makeRun("rec-manual-old", "manual-review-required", "interval '10 days'");
    // stale run 名下挂一个未认领外部任务，验证随对账清账。
    const wp = workPackage("rec-running-stale");
    await repository.createModelTask(wp, `idem-${randomUUID()}`);

    const reconciled = await repository.reconcileStaleWorkflowRuns({ nowMs });
    const byId = new Map(reconciled.map((item) => [item.workflowId, item]));

    const staleRunning = await runStatus("rec-running-stale");
    expect(staleRunning?.status).toBe("failed");
    expect(staleRunning?.payload.terminalOutcome).toBe("abandoned-stale-run");
    expect(byId.get("rec-running-stale")?.reasonCode).toBe("stale-running-beyond-temporal-retention");
    expect((await repository.getModelTask(wp.id))?.status).toBe("failed");

    expect((await runStatus("rec-running-fresh"))?.status).toBe("running");
    expect((await runStatus("rec-waiting-fresh"))?.status).toBe("waiting-external");
    // 等人的状态机器无权收编。
    expect((await runStatus("rec-manual-old"))?.status).toBe("manual-review-required");

    const staleWaiting = await runStatus("rec-waiting-stale");
    expect(staleWaiting?.status).toBe("failed");
    expect(staleWaiting?.payload.terminalOutcome).toBe("external-wait-timed-out");
    const events = await repository.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_type='workflow-run' AND aggregate_id=$1 AND event_type='workflow.reconciled-abandoned'",
      ["rec-waiting-stale"],
    );
    expect(Number(events.rows[0].count)).toBe(1);
    // 幂等：已收编行不再出现第二次。
    const second = await repository.reconcileStaleWorkflowRuns({ nowMs: nowMs + 60_000 });
    expect(second.map((item) => item.workflowId)).not.toContain("rec-running-stale");
  });

  it("乐观守卫：对账窗口内 run 自己推进了状态则不覆写", async () => {
    if (!available) return;
    await makeRun("rec-race", "running", "interval '7 days'");
    // 模拟并发完成：先被别的写者推进为 completed。
    await repository.pool.query("UPDATE workflow_runs SET status='completed', updated_at=now() WHERE temporal_workflow_id='rec-race'");
    const reconciled = await repository.reconcileStaleWorkflowRuns({ nowMs: Date.now() });
    expect(reconciled.map((item) => item.workflowId)).not.toContain("rec-race");
    expect((await runStatus("rec-race"))?.status).toBe("completed");
  });

  it("creative_runs：pending 超窗收编、paused 保留", async () => {
    if (!available) return;
    await repository.pool.query(
      "INSERT INTO creative_runs(id,project_id,mode,status,payload,updated_at) VALUES($1,$2,'audit','pending','{}',now() - interval '7 days'),($3,$2,'audit','paused','{}',now() - interval '7 days')",
      [`cr-pending-${randomUUID().slice(0, 8)}`, projectId, `cr-paused-${randomUUID().slice(0, 8)}`],
    );
    const pendingRow = await repository.pool.query<{ id: string }>("SELECT id FROM creative_runs WHERE project_id=$1 AND status='pending' LIMIT 1", [projectId]);
    const pausedRow = await repository.pool.query<{ id: string }>("SELECT id FROM creative_runs WHERE project_id=$1 AND status='paused' LIMIT 1", [projectId]);
    await repository.reconcileStaleWorkflowRuns({ nowMs: Date.now() });
    expect((await repository.pool.query("SELECT status FROM creative_runs WHERE id=$1", [pendingRow.rows[0].id])).rows[0].status).toBe("failed");
    expect((await repository.pool.query("SELECT status FROM creative_runs WHERE id=$1", [pausedRow.rows[0].id])).rows[0].status).toBe("paused");
  });
});
