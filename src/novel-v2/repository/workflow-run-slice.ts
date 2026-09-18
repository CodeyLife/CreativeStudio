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
 * 边界（刻意不在本片）：`reconcileStaleWorkflowRuns`（要跨域清名下外部任务）、
 * `claimApprovalEvidence`/`releaseHumanDecisionClaim`（事务内同时动 approvals 与 artifacts，
 * 属于审批片）、`listRunArtifacts`/`listRunReviews`（读的是别的表，只是按 run 过滤）。
 * 这些留在仓储里，等各自的切片线出现再搬——搬动时机由消费面度量决定，不由文件行数决定。
 */
import type { Pool } from "pg";
import type { WorkflowRunRecord } from "../protocol";
import { HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS, HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL, isForbiddenTerminalOverwrite, terminalOverwriteGuardSql, type WorkflowRunStatus } from "../run-lifecycle";
import { withTerminalOutcome } from "../terminal-outcome";
import { workflowFromRow, type OutboxWriter, type WorkflowRunRow } from "./shared";

const RUN_COLUMNS = "id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at";

export interface WorkflowRunSliceDeps {
  pool: Pool;
  appendOutbox: OutboxWriter;
}

export class WorkflowRunSlice {
  private readonly pool: Pool;
  private readonly appendOutbox: OutboxWriter;

  constructor(deps: WorkflowRunSliceDeps) {
    this.pool = deps.pool;
    this.appendOutbox = deps.appendOutbox;
  }

  async put(input: { id: string; workflowType: string; projectId: string; temporalWorkflowId: string; status: string; payload?: Record<string, unknown> }) {
    const result = await this.pool.query<WorkflowRunRow>(`INSERT INTO workflow_runs(id,workflow_type,project_id,temporal_workflow_id,status,payload)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(temporal_workflow_id) DO UPDATE SET status=EXCLUDED.status,payload=workflow_runs.payload || EXCLUDED.payload,updated_at=now()
      RETURNING ${RUN_COLUMNS}`, [input.id, input.workflowType, input.projectId, input.temporalWorkflowId, input.status, withTerminalOutcome(input.status, input.payload ?? {})]);
    await this.appendOutbox("workflow-run", input.temporalWorkflowId, `workflow.${input.status}`, { projectId: input.projectId, workflowId: input.temporalWorkflowId, runId: input.id });
    return workflowFromRow(result.rows[0]);
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
    if (from && isForbiddenTerminalOverwrite(from, status)) {
      await this.appendOutbox("workflow-run", temporalWorkflowId, "workflow.transition-refused", { from, to: status, rule: "terminal-absorbing-except-redrive" });
    }
    return undefined;
  }

  /** 状态写入后的事件面：run 状态变更与有语义 progress 事件双写（两条写入路径共用，避免口径分叉）。 */
  private async announceStatus(row: WorkflowRunRow, status: WorkflowRunStatus, payload: Record<string, unknown>) {
    const record = workflowFromRow(row);
    await this.appendOutbox("workflow-run", record.temporalWorkflowId, `workflow.${status}`, { projectId: record.projectId, workflowId: record.temporalWorkflowId, runId: record.id, ...payload });
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
