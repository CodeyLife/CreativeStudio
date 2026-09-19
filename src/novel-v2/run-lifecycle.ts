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
 * 终态的唯一合法逃逸目标：`accepted`（重驱动）。
 *
 * 运行库取证（ymcp，2026-09-19，3,725 条状态变更事件 / 513 个 run）：终态之后的写入
 * **只出现过** `failed -> accepted`（3 次）与 `completed -> accepted`（1 次），全部是
 * 同一 intent 键控的 workflowId 被重新驱动（`putWorkflowRun` 的 intake/re-drive 路径
 * 写 `accepted`），没有一次终态被直接改写回 `running` 等非终态。
 */
export const TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS = "accepted" satisfies WorkflowRunStatus;

/**
 * 拒写集（不是合法集）：终态 → **非终态且非重驱动目标** 一律非法。
 *
 * 三条边界，都来自观测：
 * ① 终态 → `accepted` 合法——同一 intent 键控的 workflowId 被重新驱动（观测 4 次）；
 * ② 终态 → 终态 合法——业务结局可以被重申（如先落 `completed` 再显式改标
 *    `business-revision-exhausted`，对账与审计都会重写终态行），挡它会把正常留痕改成 no-op；
 * ③ 终态 → 其余（running / waiting-external / 人工门态）非法——"复活已结束的 run"正是
 *    人工门竞态那一类 bug 的通用形态（见 `resumeWorkflowRunFromHumanGate`），且在 3,725 条
 *    历史事件里**零观测**，即没有生产者路径依赖它。
 *
 * 为什么不装完整"合法迁移表"：词表里 `waiting-external` / `regression-validation-required`
 * / `rebuild-requested` 在该运行库零历史事件（新于数据或该项目未走到），以观测集为正集
 * 等于禁止一切未观测的合法首用——写失败退化成静默 no-op，比现状更糟。
 */
export function isForbiddenTerminalOverwrite(from: string, to: string): boolean {
  return isTerminalWorkflowRunStatus(from) && !isTerminalWorkflowRunStatus(to) && to !== TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS;
}

/**
 * 把上面那条判据表达成 SQL 片段，供状态漏斗写进 UPDATE 的 WHERE（判据与写入同一原子内）。
 * `toStatusParam` 是目标态的绑定占位符名（如 `$2`）；目标态走参数而非内联，避免词表
 * 值在 SQL 里出现第二份字面量。
 */
export function terminalOverwriteGuardSql(toStatusParam: string): string {
  return `AND ${terminalOverwriteGuardPredicateSql(toStatusParam)}`;
}

/**
 * 同一判据的**独立谓词**形态（不带动词关键字前缀），供没有既有 WHERE 子句可拼接的写入形态使用。
 *
 * 为什么要有这一份而不是在调用点 `WHERE true AND (...)`：注册面写的是
 * `INSERT … ON CONFLICT DO UPDATE … WHERE <判据>`，那里没有前导条件可拼 `AND`（拼上去就是
 * `WHERE AND (…)` 语法错）。两种形态若各写一份判据，漏斗改了注册面不会跟着改——正是本仓
 * "同一 vocabulary 不另立第二份规则" 要挡的分裂。
 *
 * `fromStatusRef` 是"账上旧态"的列引用：UPDATE 里裸 `status` 无歧义，而 upsert 的 WHERE 里
 * 目标表与 `EXCLUDED` 伪表同列同名，裸引用直接报 `column reference "status" is ambiguous`
 * （真库实测），故那里必须传 `workflow_runs.status`。
 */
export function terminalOverwriteGuardPredicateSql(toStatusParam: string, fromStatusRef = "status"): string {
  const redrive = TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS;
  return `(${fromStatusRef} NOT IN (${TERMINAL_WORKFLOW_RUN_STATUSES_SQL}) OR ${toStatusParam} IN (${TERMINAL_WORKFLOW_RUN_STATUSES_SQL}) OR ${toStatusParam}='${redrive}')`;
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
