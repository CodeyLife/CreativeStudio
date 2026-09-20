/**
 * workflow run 生命周期 slice（`NovelPostgresRepository` 的第一片物理拆分）。
 *
 * 为什么切这一片：`repository-capabilities.ts` 的度量显示 run 写入面
 * （`putWorkflowRun` / `updateWorkflowRunStatus`）同时出现在作品简介、章节命名、故事弧
 * 三个工作流能力清单里——重复出现的方法集就是切片线。这一片承载
 * `workflow_runs.status` 的**全部受控写入**，也正是最近两处守卫的落点（终态吸收、
 * 人工门回写），把它的真值逻辑独立出来，守卫就能被单独测、单独推演，而不必在 7,000 行
 * 文件里找。
 *
 * 依赖注入而非继承仓储：只需要两样东西——一条连接与一个 outbox 写入器。仓储用
 * `(type, id, event, payload) => this.appendOutbox(...)` 接线，事件留痕口径仍由仓储统一
 * 决定（`outboxProjectId` 那套归属规则只有一份）。
 *
 * 边界（刻意不在本片）：`reconcileStaleWorkflowRuns`（要跨域清名下外部任务，本片只在终态转换处
 * 经注入回调过期任务，任务表 SQL 仍归 model-task 片）；
 * `claimApprovalEvidence`/`releaseHumanDecisionClaim`（事务内同时动 approvals 与 artifacts，
 * 属于审批片）、`listRunArtifacts`/`listRunReviews`（读的是别的表，只是按 run 过滤）。
 * 这些留在仓储里，等各自的切片线出现再搬——搬动时机由消费面度量决定，不由文件行数决定。
 */
import type { Pool } from "pg";
import type { WorkflowRunRecord } from "../protocol";
import { HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS, HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL, isForbiddenTerminalOverwrite, isTerminalWorkflowRunStatus, terminalOverwriteGuardPredicateSql, terminalOverwriteGuardSql, type WorkflowRunStatus } from "../run-lifecycle";
import { withTerminalOutcome } from "../terminal-outcome";
import { workflowFromRow, type OutboxWriter, type WorkflowRunRow } from "./shared";

const RUN_COLUMNS = "id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at";

export interface WorkflowRunSliceDeps {
  pool: Pool;
  appendOutbox: OutboxWriter;
  /**
   * run 进终态时清其名下未交付的外部任务（由仓储接到 model-task slice）。
   * 注入而不是在本片直接写 `model_tasks`：状态机与事件留痕归本片，任务表的 SQL 归那片，
   * 这条回调就是两片之间唯一的接缝。
   */
  expireOutstandingTasks: (workflowRunKey: string, reason: string) => Promise<number>;
}

export class WorkflowRunSlice {
  private readonly pool: Pool;
  private readonly appendOutbox: OutboxWriter;
  private readonly expireOutstandingTasks: WorkflowRunSliceDeps["expireOutstandingTasks"];

  constructor(deps: WorkflowRunSliceDeps) {
    this.pool = deps.pool;
    this.appendOutbox = deps.appendOutbox;
    this.expireOutstandingTasks = deps.expireOutstandingTasks;
  }

  /**
   * run 注册（按 `temporal_workflow_id` 幂等）。
   *
   * 它同样是 `workflow_runs.status` 的一个写入者，而且此前对计数锁完全不可见：SQL 里没有
   * 状态字面量，写的是 `DO UPDATE SET status=EXCLUDED.status`，按 `UPDATE workflow_runs SET status`
   * 形态数写入者的锁自然放过它（F5′）。同一道终态吸收守卫因此也必须挂在这里——Temporal 重放
   * 或同名重启会把已 `completed` 的 run 覆回 `running`，而覆写之后工作流不再写自己的终态，
   * 该 run 只能等对账把"僵尸 running"收编成 `failed`：一次成功的运行以失败入账。
   * 守卫挡住时不静默：沿用漏斗的 refusal 事件口径留痕，并把既有行原样返回（注册方拿到的
   * 是账上真实状态，不是它申报的那个）。
   */
  async put(input: { id: string; workflowType: string; projectId: string; temporalWorkflowId: string; status: WorkflowRunStatus; payload?: Record<string, unknown> }) {
    const result = await this.pool.query<WorkflowRunRow>(`INSERT INTO workflow_runs(id,workflow_type,project_id,temporal_workflow_id,status,payload)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(temporal_workflow_id) DO UPDATE SET status=EXCLUDED.status,payload=workflow_runs.payload || EXCLUDED.payload,updated_at=now()
      WHERE ${terminalOverwriteGuardPredicateSql("EXCLUDED.status", "workflow_runs.status")}
      RETURNING ${RUN_COLUMNS}`, [input.id, input.workflowType, input.projectId, input.temporalWorkflowId, input.status, withTerminalOutcome(input.status, input.payload ?? {})]);
    if (!result.rowCount) {
      const existing = await this.getByTemporalId(input.temporalWorkflowId);
      if (!existing) throw new Error(`workflow run 注册未落库且目标行不存在（并发删除？）：${input.temporalWorkflowId}`);
      await this.recordTransitionRefusal(input.temporalWorkflowId, existing.status, input.status);
      return existing;
    }
    return this.announceStatus(result.rows[0], input.status, input.payload ?? {});
  }

  async updateStatus(temporalWorkflowId: string, status: WorkflowRunStatus, payload: Record<string, unknown> = {}) {
    const result = await this.pool.query<WorkflowRunRow>(`UPDATE workflow_runs SET status=$2,payload=payload || $3,updated_at=now()
      WHERE temporal_workflow_id=$1 ${terminalOverwriteGuardSql("$2")}
      RETURNING ${RUN_COLUMNS}`, [temporalWorkflowId, status, withTerminalOutcome(status, payload)]);
    if (!result.rowCount) return this.diagnoseRefusedStatusUpdate(temporalWorkflowId, status);
    return this.announceStatus(result.rows[0], status, payload);
  }

  /**
   * 人工门 → running 的**守卫式**回写（供提交人工裁决的消费面使用）。
   *
   * 为什么要守卫：裁决链路是 claimApprovalEvidence → signal(humanSignal) → 回写状态。
   * 信号一送达，工作流就恢复自驱——reject/abandon 这类短路径可能在回写落地前已经写完
   * 终态。无守卫的回写会把 `completed`/`failed` 覆回 `running`，而工作流此后不再写自己
   * 的终态，该 run 就只能等对账把"僵尸 running"收编成 `failed`：一次成功的裁决最终以
   * 失败收场。守卫放进 UPDATE 的 WHERE 里（不是先读后判），所以判据与写入同一原子内，
   * 不存在竞态窗口；未命中即返回 undefined，交由工作流这一个写入者继续负责状态。
   */
  async resumeFromHumanGate(temporalWorkflowId: string, payload: Record<string, unknown> = {}) {
    const status = HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS;
    const result = await this.pool.query<WorkflowRunRow>(`UPDATE workflow_runs SET status=$2,payload=payload || $3,updated_at=now()
      WHERE temporal_workflow_id=$1 AND status IN (${HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL})
      RETURNING ${RUN_COLUMNS}`, [temporalWorkflowId, status, withTerminalOutcome(status, payload)]);
    if (!result.rowCount) return undefined;
    return this.announceStatus(result.rows[0], status, payload);
  }

  async getByTemporalId(temporalWorkflowId: string): Promise<WorkflowRunRecord | undefined> {
    const result = await this.pool.query<WorkflowRunRow>(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE temporal_workflow_id=$1`, [temporalWorkflowId]);
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async listProjectRuns(projectId: string, limit = 20, workflowType?: string): Promise<WorkflowRunRecord[]> {
    const sql = workflowType
      ? `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE project_id=$1 AND workflow_type=$2 ORDER BY updated_at DESC LIMIT $3`
      : `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2`;
    const params = workflowType ? [projectId, workflowType, limit] : [projectId, limit];
    const result = await this.pool.query<WorkflowRunRow>(sql, params);
    return result.rows.map(workflowFromRow);
  }

  /**
   * 零行更新的原因区分（守卫不得静默）。
   *
   * 行不存在是正常竞态（run 尚未落库或已随项目删除）；被终态守卫挡下则必须留痕，
   * 否则装了守卫反而比没有更糟——原来至少看得见覆写结果，现在只剩一次 no-op。
   * 判据本身已经在 UPDATE 的 WHERE 里原子生效，这里只做事后归因（多读一次当前行，
   * 取值可能已更新，故只用于留痕不用于二次决策）。
   */
  private async diagnoseRefusedStatusUpdate(temporalWorkflowId: string, status: WorkflowRunStatus) {
    const current = await this.pool.query<{ status: string }>("SELECT status FROM workflow_runs WHERE temporal_workflow_id=$1", [temporalWorkflowId]);
    const from = current.rows[0]?.status;
    if (from) await this.recordTransitionRefusal(temporalWorkflowId, from, status);
    return undefined;
  }

  /** 覆写尝试的留痕（漏斗与注册面共用一条事件口径）：只有确属被禁的终态覆写才记账。 */
  private async recordTransitionRefusal(temporalWorkflowId: string, from: string, to: WorkflowRunStatus) {
    if (!isForbiddenTerminalOverwrite(from, to)) return;
    await this.appendOutbox("workflow-run", temporalWorkflowId, "workflow.transition-refused", { from, to, rule: "terminal-absorbing-except-redrive" });
  }

  /** 状态写入后的事件面：run 状态变更与有语义 progress 事件双写（两条写入路径共用，避免口径分叉）。 */
  private async announceStatus(row: WorkflowRunRow, status: WorkflowRunStatus, payload: Record<string, unknown>) {
    const record = workflowFromRow(row);
    await this.appendOutbox("workflow-run", record.temporalWorkflowId, `workflow.${status}`, { projectId: record.projectId, workflowId: record.temporalWorkflowId, runId: record.id, ...payload });
    // 进终态即过期名下未交付任务。放在这条共用出口而不是各调用点：此前"僵尸 pending 任务"的
    // 成因正是**没有任何一处**在 run 进终态时清任务——reconcile 只挑非终态 run 收编并顺手清，
    // 而经人工取消/正常 completed 进终态的 run 永不进那个候选集，其 pending 任务就永久挂着，
    // 被编排者的队列视图反复领到（运行库实测 3 条）。
    if (isTerminalWorkflowRunStatus(status)) {
      await this.expireOutstandingTasks(record.temporalWorkflowId, `run-terminal:${status}`);
    }
    // OR-C1（product-audit-20260910 E4）：有语义 progress 事件双写持久事件表。
    // run payload 的 stage 键是"后写覆盖"的当前态展示位，守卫决策（revision-decision/
    // revision-reverted/manual-review-required…）若无追加式留痕则事后无法回答
    // "阈值挡下过什么"。规则泛化：凡带 stage 的写入即按 `workflow.progress.<stage>`
    // 落一条事件，不设阶段白名单——新阶段零登记自动可审计。
    if (typeof payload.stage === "string" && payload.stage.trim()) {
      await this.appendOutbox("workflow-run", record.temporalWorkflowId, `workflow.progress.${payload.stage.trim()}`, { projectId: record.projectId, workflowId: record.temporalWorkflowId, runId: record.id, ...payload });
    }
    return record;
  }
}
