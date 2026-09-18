/**
 * workflow_runs 生命周期词表——单一真源。
 *
 * 根因：run 状态此前只有 `status: string`（protocol.ts 的 WorkflowRunRecord 与仓储
 * `updateWorkflowRunStatus(status: string)` 都是宽字符串），词表散落在 workflows.ts 的
 * 写入调用、application 的 putWorkflowRun 初态、以及 reconcile 的内联 SQL
 * `status IN ('running','accepted')` 里。三处各写一份的直接后果不是拼写错误（TS 会
 * 放过任意字符串），而是**分类判据漂移**：一个状态是"活跃""人工门"还是"终态"决定它
 * 是否被周期对账收编、是否计入未清账面板、是否允许被后续信号覆写。这类判定每处重述
 * 一遍，就必然在某次新增状态时漏掉一处（新增 `regression-validation-required` 与
 * `rebuild-requested` 时只改了写入侧，对账与总览口径靠人工回忆）。
 *
 * 边界：本模块定义**词表与分类**，不定义转移合法性（哪些状态之间允许迁移）。转移表
 * 需要在真实历史数据上核对后再立——本仓运行库现存行的状态分布未经审计，先上合法性
 * 校验等于凭猜测拒绝写入。合法性作为下一步，词表与分类是它的前提。
 *
 * 与 terminal-outcome 的关系：terminal-outcome 管"终态的子类型"（这次结束是业务失败、
 * 外部等待超时还是基础设施失败），本模块管"处于生命周期的哪一档"。终态集合以本模块
 * 为准，terminal-outcome 的取值域由守卫测试与之对齐。
 */

export const WORKFLOW_RUN_STATUSES = [
  /** putWorkflowRun 初态：已受理，尚未确认工作流真正跑起来 */
  "accepted",
  "running",
  /** 等外部模型执行者认领任务（Temporal 侧在 condition 上挂起，不占 worker） */
  "waiting-external",
  /** 等待作者/编排者裁决的人工门族（含回归验证门与重建请求门） */
  "manual-review-required",
  "regression-validation-required",
  "rebuild-requested",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "rejected",
] as const;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** 终态：不再有合法的后继写入（除对账/审计留痕），也是 run 总览的"已清账"口径。 */
export const TERMINAL_WORKFLOW_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "rejected",
] as const satisfies readonly WorkflowRunStatus[];

/** 人工门：等待的是人不是机器，周期对账**不得**收编（机器无权判定人何时回来）。 */
export const HUMAN_GATE_WORKFLOW_RUN_STATUSES = [
  "manual-review-required",
  "regression-validation-required",
  "rebuild-requested",
] as const satisfies readonly WorkflowRunStatus[];

/** 活跃态：仍在推进、超时即视为僵尸，由 reconcile 收编为 failed。 */
export const ACTIVE_WORKFLOW_RUN_STATUSES = ["accepted", "running"] as const satisfies readonly WorkflowRunStatus[];

/**
 * 人工门被外部提交裁决后的回写目标态。这是**唯一**允许工作流以外的写入者改的态，
 * 且必须配守卫（见 `resumeWorkflowRunFromHumanGate`）：信号送达后工作流可能已经
 * 自行推进甚至进入终态，无守卫的回写会把终态覆成 running，再被对账收编为 failed。
 */
export const HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS = "running" satisfies WorkflowRunStatus;

/** 外部等待态：单独的墙钟预算（受 Temporal history retention 窗口约束）。 */
export const WAITING_EXTERNAL_WORKFLOW_RUN_STATUS = "waiting-external" as const satisfies WorkflowRunStatus;

/** 对账 SQL 里的等待态字面量（与词表同源，避免第二处手写）。 */
export const WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL = `'${WAITING_EXTERNAL_WORKFLOW_RUN_STATUS}'`;

const asSqlList = (statuses: readonly string[]): string => statuses.map((status) => `'${status}'`).join(",");

/** SQL 字面量清单（值全部来自上面的词表，新增状态不会漏掉任一判据处）。 */
export const ACTIVE_WORKFLOW_RUN_STATUSES_SQL = asSqlList(ACTIVE_WORKFLOW_RUN_STATUSES);
export const TERMINAL_WORKFLOW_RUN_STATUSES_SQL = asSqlList(TERMINAL_WORKFLOW_RUN_STATUSES);
export const HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL = asSqlList(HUMAN_GATE_WORKFLOW_RUN_STATUSES);

export function isTerminalWorkflowRunStatus(status: string): status is (typeof TERMINAL_WORKFLOW_RUN_STATUSES)[number] {
  return (TERMINAL_WORKFLOW_RUN_STATUSES as readonly string[]).includes(status);
}

export function isHumanGateWorkflowRunStatus(status: string): status is (typeof HUMAN_GATE_WORKFLOW_RUN_STATUSES)[number] {
  return (HUMAN_GATE_WORKFLOW_RUN_STATUSES as readonly string[]).includes(status);
}

export function isWorkflowRunStatus(status: string): status is WorkflowRunStatus {
  return (WORKFLOW_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * 读取侧收口：数据库列的真实取值域比词表更宽（历史版本写入过已废弃态与旧拼写），
 * 而 TS 无法校验来自数据库的字符串。这里不做静默改写也不抛错——原样透出并集中在
 * 这一个可搜索的 cast 点，避免 mapper 里散落 `as`。写入侧才是受控面
 * （updateWorkflowRunStatus 的参数已是 WorkflowRunStatus）。
 */
export function toWorkflowRunStatus(status: string): WorkflowRunStatus {
  return status as WorkflowRunStatus;
}
