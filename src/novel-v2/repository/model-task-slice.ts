/**
 * 外部模型任务与租约 slice（第二片物理拆分）。
 *
 * 为什么这一片：`model_tasks` 与 `task_attempts` 的**全部 SQL**（含 `SELECT` 与 `DELETE`）
 * 都归本文件——这是可判定的不变量，由 `model-task-slice.test.ts` 按**表名**锁住。
 * 它承载的恰恰是最容易被跨域写入破坏的不变式——migration 086 的
 * `CHECK (claimed/running ⇒ lease_owner 非空)`、088 把 `task_attempts.workflow_run_id` 的 FK
 * 改指 `temporal_workflow_id`（FK 必须服从实际写入面而非注释）、以及"只有无人认领的任务才打
 * expired 留痕"的判据。把这些 SQL 关进一个文件，不变式才有单一归属地，也才能不起 Postgres 就单测。
 *
 * **归属的划线方式（2026-10-13 修正）**：初版只把 `INSERT`/`UPDATE` 搬了过来，`SELECT`/`DELETE`
 * 留在 god-object 里，守卫也只匹配那两个动词——于是"租约表生命周期"横跨两个文件，而守卫断言
 * 了一个不成立的不变量（绿的说谎）。现按**表**划线：一张表的所有 SQL 都在这里。
 *
 * 租约模型（本片的地基，逐条对应下面的 SQL）：
 * - 领取靠 `SELECT … FOR UPDATE` 行锁 + `status='pending'` 判据，同事务里建 attempt；
 * - 心跳/交付都要求"attempt 存在、属于当前执行者、租约未过期"，否则抛错而非静默；
 * - 交付幂等：已 `submitted` 的任务原样返回（外部执行者重发同一结果不再次改状态）；
 * - 过期回收 `reopenExpiredModelTasks` 是**读路径上的自愈**：任何一次读都先把失去活租约的
 *   claimed/running 退回 pending，所以编排者永远看不到"被死租约锁住的任务"。
 *
 * 边界（刻意不在本片）：`recordArtifact`（artifacts 表）、`recordTaskSignal` 之外的 signal
 * 审计、以及 reconcile 里对 run 状态的收编——那些各自属于 artifact 片与 run 片。
 * `expireWorkflowModelTasks` 被 reconcile 调用，但写的是本片的表，故留在本片由本片负责。
 */
import type { Pool, PoolClient } from "pg";
import type { TaskAttemptRecord } from "../protocol";
import type { ModelTaskRecord, ModelWorkPackage } from "../model-routing";
import { TERMINAL_WORKFLOW_RUN_STATUSES_SQL } from "../run-lifecycle";
import { iso, type OutboxWriter } from "./shared";

type TaskAttemptRow = { id: string; workflow_run_id: string | null; task_id: string; lease_owner: string | null; lease_expires_at: Date | string | null; heartbeat_at: Date | string | null; status: TaskAttemptRecord["status"]; payload: Record<string, unknown> };
type ModelTaskRow = { id: string; workflow_run_id: string; task_id: string; purpose: ModelTaskRecord["purpose"]; config_revision: string; candidate_index: number; status: ModelTaskRecord["status"]; work_package: ModelWorkPackage; result: ModelTaskRecord["result"] | null; idempotency_key: string; project_id: string | null; created_at: Date | string; updated_at: Date | string };

function taskAttemptFromRow(row: TaskAttemptRow): TaskAttemptRecord {
  return { id: row.id, workflowRunId: row.workflow_run_id ?? undefined, taskId: row.task_id, leaseOwner: row.lease_owner ?? undefined, leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined, heartbeatAt: row.heartbeat_at ? iso(row.heartbeat_at) : undefined, status: row.status, payload: row.payload ?? {} };
}

function modelTaskFromRow(row: ModelTaskRow): ModelTaskRecord {
  return { id: row.id, workflowRunId: row.workflow_run_id, taskId: row.task_id, purpose: row.purpose, configRevision: row.config_revision, candidateIndex: row.candidate_index, status: row.status, workPackage: row.work_package, result: row.result ?? undefined, idempotencyKey: row.idempotency_key, projectId: row.project_id ?? undefined, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

export interface ModelTaskSliceDeps {
  pool: Pool;
  appendOutbox: OutboxWriter;
}

/**
 * 事务参与者：`Pool` 与 `PoolClient` 都满足。
 *
 * 级联删除类的操作由调用方开事务，本片必须用**同一个连接**执行，否则删除落在事务之外。
 * 仓储里 `assertNoActiveStoryArcWorkflow` 早就是同一写法（`client: Pool | PoolClient`）。
 */
export type ModelTaskExecutor = Pool | PoolClient;

/**
 * "尚未交付"的任务态。过期、放弃、按 run 收编三处判据共用这一份——写第二份字面量时
 * 一旦漏掉某个态（例如只写 `pending`），僵尸任务就会在账上永久挂着并被编排者反复领到。
 * 不含 `submitted`：已交付的任务其结果是事实，永不被清理改写。
 */
export const OUTSTANDING_MODEL_TASK_STATUSES = ["pending", "claimed", "running"] as const;
/** 上面词表的 SQL `IN (...)` 片段（与 run-lifecycle 的 asSqlList 同一动机：词表只在 TS 侧单源）。 */
export const OUTSTANDING_MODEL_TASK_STATUSES_SQL = OUTSTANDING_MODEL_TASK_STATUSES.map((status) => `'${status}'`).join(",");

export class ModelTaskSlice {
  private readonly pool: Pool;
  private readonly appendOutbox: OutboxWriter;

  constructor(deps: ModelTaskSliceDeps) {
    this.pool = deps.pool;
    this.appendOutbox = deps.appendOutbox;
  }

  async create(workPackage: ModelWorkPackage, idempotencyKey: string): Promise<ModelTaskRecord> {
    const result = await this.pool.query<ModelTaskRow>(
      `INSERT INTO model_tasks(id,workflow_run_id,task_id,purpose,config_revision,candidate_index,status,work_package,idempotency_key,project_id)
       VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,(SELECT r.project_id FROM workflow_runs r WHERE r.id=$2 OR r.temporal_workflow_id=$2 LIMIT 1))
       ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=model_tasks.updated_at
       RETURNING *`,
      [workPackage.id, workPackage.workflowRunId, workPackage.taskId, workPackage.purpose, workPackage.configRevision, workPackage.candidateIndex, workPackage, idempotencyKey],
    );
    return modelTaskFromRow(result.rows[0]);
  }

  async list(status: ModelTaskRecord["status"] = "pending", limit = 50, projectId?: string): Promise<ModelTaskRecord[]> {
    await this.reopenExpired();
    const result = await this.pool.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE status=$1 AND ($3::text IS NULL OR project_id=$3) ORDER BY created_at ASC LIMIT $2", [status, limit, projectId ?? null]);
    return result.rows.map(modelTaskFromRow);
  }

  async get(taskId: string): Promise<ModelTaskRecord | undefined> {
    await this.reopenExpired();
    const result = await this.pool.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE id=$1", [taskId]);
    return result.rows[0] ? modelTaskFromRow(result.rows[0]) : undefined;
  }

  async claim(input: { taskId: string; attemptId: string; leaseOwner: string; leaseMs: number }): Promise<ModelTaskRecord> {
    await this.reopenExpired();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE id=$1 FOR UPDATE", [input.taskId]);
      if (!task.rowCount) throw new Error("外部模型任务不存在");
      if (task.rows[0].status !== "pending") throw new Error(`外部模型任务不可领取：${task.rows[0].status}`);
      await client.query("UPDATE model_tasks SET status='claimed',updated_at=now() WHERE id=$1", [input.taskId]);
      const leaseExpires = new Date(Date.now() + input.leaseMs);
      await client.query(
        `INSERT INTO task_attempts(id,workflow_run_id,task_id,model_task_id,lease_owner,lease_expires_at,heartbeat_at,status,payload)
         VALUES($1,$2,$3,$3,$4,$5,now(),'claimed',$6)
         ON CONFLICT(id) DO UPDATE SET model_task_id=EXCLUDED.model_task_id,lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at,heartbeat_at=now(),status='claimed',payload=task_attempts.payload || EXCLUDED.payload`,
        [input.attemptId, task.rows[0].workflow_run_id, input.taskId, input.leaseOwner, leaseExpires, { modelTaskId: input.taskId }],
      );
      await client.query("COMMIT");
      return (await this.get(input.taskId))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async heartbeat(input: { taskId: string; attemptId: string; leaseOwner: string; leaseMs: number }): Promise<void> {
    const leaseExpires = new Date(Date.now() + input.leaseMs);
    const result = await this.pool.query(
      `UPDATE task_attempts SET heartbeat_at=now(),lease_expires_at=$4,status='running'
       WHERE id=$1 AND model_task_id=$2 AND lease_owner=$3 AND lease_expires_at>now()`,
      [input.attemptId, input.taskId, input.leaseOwner, leaseExpires],
    );
    if (!result.rowCount) throw new Error("任务租约不存在、已过期或不属于当前执行者");
    await this.pool.query("UPDATE model_tasks SET status='running',updated_at=now() WHERE id=$1 AND status IN ('claimed','running')", [input.taskId]);
  }

  async submit(input: { taskId: string; attemptId: string; leaseOwner: string; inputFingerprint: string; result: ModelTaskRecord["result"] }): Promise<ModelTaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const task = await client.query<ModelTaskRow>("SELECT * FROM model_tasks WHERE id=$1 FOR UPDATE", [input.taskId]);
      if (!task.rowCount) throw new Error("外部模型任务不存在");
      const row = task.rows[0];
      if (row.status === "submitted") { await client.query("COMMIT"); return modelTaskFromRow(row); }
      if (row.work_package.inputFingerprint !== input.inputFingerprint) throw new Error("输入指纹不匹配，任务上下文已变化");
      const lease = await client.query("SELECT 1 FROM task_attempts WHERE id=$1 AND model_task_id=$2 AND lease_owner=$3 AND lease_expires_at>now()", [input.attemptId, input.taskId, input.leaseOwner]);
      if (!lease.rowCount) throw new Error("任务租约不存在、已过期或不属于当前执行者");
      if (typeof input.result?.text !== "string" && input.result?.value === undefined) throw new Error("外部任务结果必须包含 text 或 value");
      const updated = await client.query<ModelTaskRow>("UPDATE model_tasks SET status='submitted',result=$2,updated_at=now() WHERE id=$1 RETURNING *", [input.taskId, input.result]);
      await client.query("UPDATE task_attempts SET status='submitted',heartbeat_at=now() WHERE id=$1", [input.attemptId]);
      await client.query("COMMIT");
      return modelTaskFromRow(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async fail(input: { taskId: string; attemptId: string; leaseOwner: string; reason: string }): Promise<ModelTaskRecord> {
    const lease = await this.pool.query("SELECT 1 FROM task_attempts WHERE id=$1 AND model_task_id=$2 AND lease_owner=$3", [input.attemptId, input.taskId, input.leaseOwner]);
    if (!lease.rowCount) throw new Error("任务 attempt 不属于当前执行者");
    const result = await this.pool.query<ModelTaskRow>("UPDATE model_tasks SET status='failed',result=$2,updated_at=now() WHERE id=$1 RETURNING *", [input.taskId, { text: "", value: { reason: input.reason } }]);
    if (!result.rowCount) throw new Error("外部模型任务不存在");
    await this.pool.query("UPDATE task_attempts SET status='failed',payload=payload || $2 WHERE id=$1", [input.attemptId, { reason: input.reason }]);
    return modelTaskFromRow(result.rows[0]);
  }

  /**
   * 读路径自愈：失去活租约的 claimed/running 退回 pending。
   * 判据是"该任务名下不存在 claimed/running 且租约未过期的 attempt"，与 086 的
   * owner CHECK 同向——没有活执行者的任务不该一直被占用。
   */
  private async reopenExpired(): Promise<void> {
    await this.pool.query(
      `UPDATE model_tasks mt SET status='pending',updated_at=now()
       WHERE mt.status IN ('claimed','running') AND NOT EXISTS (
         SELECT 1 FROM task_attempts ta WHERE ta.model_task_id=mt.id AND ta.status IN ('claimed','running') AND ta.lease_expires_at>now()
       )`,
    );
  }

  async expire(taskId: string, reason: string): Promise<void> {
    const updated = await this.pool.query<{ project_id: string | null; workflow_run_id: string | null }>(
      `UPDATE model_tasks SET status='failed',result=$2,updated_at=now() WHERE id=$1 AND status IN (${OUTSTANDING_MODEL_TASK_STATUSES_SQL}) RETURNING project_id,workflow_run_id`,
      [taskId, { value: { reason, expired: true } }],
    );
    await this.pool.query("UPDATE task_attempts SET status='failed',payload=payload || $2 WHERE model_task_id=$1 AND status IN ('claimed','running')", [taskId, { reason, expired: true }]);
    // OR-B3（product-audit-20260910 E3）：waiting-external 超时不再静默——outbox 事件
    // 让编排者感知"任务发了没人领"（观测审计里的 34 次等待、0 claim 0 submit）。
    for (const row of updated.rows) {
      await this.appendOutbox("model-task", taskId, "model-task.expired", { projectId: row.project_id, modelTaskId: taskId, workflowRunId: row.workflow_run_id, reason });
    }
  }

  /**
   * 按 run 过期其名下未交付任务。
   *
   * 键的两种形态都要认：`model_tasks.workflow_run_id` 与 `task_attempts` 一样存在"id 形态"与
   * "temporal_workflow_id 形态"并存（migration 088 就是被这个实形逼着改 FK 指向的），reconcile
   * 传的是 temporal id，而工作流侧建任务时常传 `workflow_runs.id` —— 只认一种形态就会收编不全。
   * 僵尸行的真正成因不在此而在"run 进终态时没人清任务"，那一条由 `WorkflowRunSlice` 的终态
   * 转换挂钩负责（见 announceStatus）。
   */
  async expireForWorkflow(workflowRunKey: string, reason: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE model_tasks SET status='failed',result=$2,updated_at=now()
        WHERE status IN (${OUTSTANDING_MODEL_TASK_STATUSES_SQL})
          AND (workflow_run_id=$1
               OR workflow_run_id IN (SELECT id FROM workflow_runs WHERE temporal_workflow_id=$1)
               OR workflow_run_id IN (SELECT temporal_workflow_id FROM workflow_runs WHERE id=$1))`,
      [workflowRunKey, { text: "", value: { reason } }],
    );
    return result.rowCount ?? 0;
  }

  /**
   * 收编「run 已终态（或 run 行已不存在）却仍挂着未交付」的外部任务。
   *
   * **整个概念归本片**：选键（SELECT）与收编（`expireForWorkflow` 循环）都在这里。
   * 此前是仓储选键、再回调本片写——同一对 slice 之间的第二条接缝，且读侧在仓储里重述了
   * 一份 outstanding 词表。写入判据仍只有 `expireForWorkflow` 一处。
   *
   * `submitted`/`failed` 不动：已交付与已放弃的结果是事实。幂等：收编后不再命中，重放为 no-op。
   */
  async expireOrphaned(reason = "run-already-terminal"): Promise<number> {
    const orphans = await this.pool.query<{ key: string }>(
      `SELECT DISTINCT t.workflow_run_id AS key
         FROM model_tasks t
        WHERE t.status IN (${OUTSTANDING_MODEL_TASK_STATUSES_SQL})
          AND NOT EXISTS (
            SELECT 1 FROM workflow_runs r
            WHERE (r.temporal_workflow_id = t.workflow_run_id OR r.id = t.workflow_run_id)
              AND r.status NOT IN (${TERMINAL_WORKFLOW_RUN_STATUSES_SQL})
          )`,
    );
    let expired = 0;
    for (const row of orphans.rows) expired += await this.expireForWorkflow(row.key, reason);
    return expired;
  }

  /**
   * 项目级级联删除：**两张表一起**，且认项目名下 run 的两种键形态。
   *
   * 归本片的理由就是守卫锁的那条不变量——这两张表的所有 SQL 只有一个家。此前 `model_tasks`
   * 的 DELETE 混在 `deleteProject` 的通用表循环里、`task_attempts` 的 DELETE 另起一行，
   * 于是"租约表生命周期"横跨两个文件，而守卫按动词匹配（只认 INSERT/UPDATE）看不见它们。
   *
   * 接受 `executor` 而非只用 `this.pool`：调用方在事务内，必须与它同一个连接。
   */
  async removeProjectTasks(executor: ModelTaskExecutor, projectId: string): Promise<void> {
    await executor.query(
      `DELETE FROM model_tasks WHERE project_id=$1 OR workflow_run_id IN (SELECT id FROM workflow_runs WHERE project_id=$1 UNION SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1)`,
      [projectId],
    );
    await executor.query(
      `DELETE FROM task_attempts WHERE workflow_run_id IN (SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1) OR workflow_run_id IN (SELECT id FROM workflow_runs WHERE project_id=$1)`,
      [projectId],
    );
  }

  /**
   * run 级诊断数据清理：两张表一起，顺序照旧（先 attempt 后 task，attempt 引用 task）。
   * 两种键形态都要认——migration 088 就是被这个实形逼着把 FK 改指 `temporal_workflow_id`。
   */
  async removeRunTasks(executor: ModelTaskExecutor, keys: { id: string; temporalWorkflowId: string }): Promise<void> {
    await executor.query("DELETE FROM task_attempts WHERE workflow_run_id=$1 OR workflow_run_id=$2", [keys.id, keys.temporalWorkflowId]);
    await executor.query("DELETE FROM model_tasks WHERE workflow_run_id=$1", [keys.temporalWorkflowId]);
  }

  async upsertAttempt(input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; leaseOwner?: string; leaseMs?: number; payload?: Record<string, unknown> }) {
    const leaseExpires = input.leaseOwner && input.leaseMs ? new Date(Date.now() + input.leaseMs) : null;
    const result = await this.pool.query<TaskAttemptRow>(`INSERT INTO task_attempts(id,workflow_run_id,task_id,lease_owner,lease_expires_at,heartbeat_at,status,payload)
      VALUES($1,$2,$3,$4,$5,now(),$6,$7)
      ON CONFLICT(id) DO UPDATE SET workflow_run_id=COALESCE(EXCLUDED.workflow_run_id,task_attempts.workflow_run_id),lease_owner=COALESCE(EXCLUDED.lease_owner,task_attempts.lease_owner),lease_expires_at=COALESCE(EXCLUDED.lease_expires_at,task_attempts.lease_expires_at),heartbeat_at=now(),status=EXCLUDED.status,payload=task_attempts.payload || EXCLUDED.payload
      RETURNING id,workflow_run_id,task_id,lease_owner,lease_expires_at,heartbeat_at,status,payload`, [input.id, input.workflowRunId ?? null, input.taskId, input.leaseOwner ?? null, leaseExpires, input.status, input.payload ?? {}]);
    const row = taskAttemptFromRow(result.rows[0]);
    await this.appendOutbox("task-attempt", row.id, `task.${row.status}`, { workflowRunId: row.workflowRunId, taskId: row.taskId, attemptId: row.id, ...row.payload });
    return row;
  }

  /**
   * 信号留痕 attempt：一次 signal 对应一条 attempt 行，状态由信号名映射。
   * 归本片是因为它写的就是 `task_attempts`（attempt 语义的另一个生产者）。
   */
  async recordSignal(input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) {
    const attemptId = typeof input.payload?.attemptId === "string" ? input.payload.attemptId : `${input.taskId}:signal`;
    const status: TaskAttemptRecord["status"] = input.signal === "claim" ? "claimed" : input.signal === "heartbeat" ? "running" : input.signal === "artifact" ? "submitted" : input.signal === "review" ? "reviewed" : input.signal === "fail" ? "failed" : "running";
    return this.upsertAttempt({ id: attemptId, workflowRunId: input.workflowId, taskId: input.taskId, status, leaseOwner: typeof input.payload?.leaseOwner === "string" ? input.payload.leaseOwner : undefined, leaseMs: 10 * 60_000, payload: { signal: input.signal, ...(input.payload ?? {}) } });
  }
}
