/**
 * OR-A2（product-audit-20260910 E2）：工作流终态子类型契约。
 *
 * 症状：业务失败伪装 `completed`——故事弧"最大修订次数未过审"、人工复核挂起等
 * 结果都以 status="completed" 落库，与真正成功不可区分，重驱动也无运行侧留痕。
 * 根因：status 枚举只表达"引擎是否跑完"，不表达"业务是否达成"，且各失败出口
 * （弧审核超时 / 外部等待窗 / activity StartToClose）payload 形态各异，无统一规则。
 *
 * 修复（机制非个案）：终态写入统一经 `withTerminalOutcome`——status 枚举不动，
 * payload 增加固定键 `terminalOutcome` 表达业务结局子类型。调用方可显式给更精确
 * 的子类型（业务失败出口应显式标注），否则按 status 派生默认（completed→succeeded、
 * failed→infrastructure-failed、cancelled→cancelled）。三种失败出口因此共享同一条
 * "终态必有 terminalOutcome"的规则，事后审计可直接按子类型区分成功/业务失败/基础设施失败。
 *
 * 边界：非终态（running/waiting-external/pending）不注入，避免中间态被误当结局；
 * 已有 terminalOutcome 不覆盖（幂等 + 尊重调用方显式判定）。
 */
import { TERMINAL_WORKFLOW_RUN_STATUSES } from "./run-lifecycle";

export type TerminalOutcome =
  | "succeeded"
  | "business-revision-exhausted"
  | "business-review-rejected"
  | "manual-review-required"
  | "external-wait-timed-out"
  | "activity-timed-out"
  | "abandoned-stale-run"
  | /** 作者经人工门主动放弃本次重建（区别于对账收编的 abandoned-stale-run） */ "abandoned-by-author"
  | "infrastructure-failed"
  | "cancelled";

/**
 * 终态集合派生自 run 生命周期词表，不再自带第二份清单。
 *
 * 根因：此处曾手写 `["completed", "failed", "cancelled"]`，而词表里 `abandoned` 与
 * `rejected` 同样是终态（人工门作者放弃/拒绝后工作流即返回，重驱动是新 run）。两份
 * 清单分叉的直接后果是这两类终态落库时**没有 terminalOutcome 固定键**，与本文件开头
 * 声明的"三种失败出口共享同一条终态必有 terminalOutcome 的规则"自相矛盾——审计要按
 * 子类型区分结局时，恰恰在"作者放弃/拒绝"这两种业务结局上失明。
 */
const TERMINAL_DEFAULT_OUTCOME: Readonly<Record<(typeof TERMINAL_WORKFLOW_RUN_STATUSES)[number], TerminalOutcome>> = {
  completed: "succeeded",
  failed: "infrastructure-failed",
  cancelled: "cancelled",
  abandoned: "abandoned-by-author",
  rejected: "business-review-rejected",
};

export function isTerminalWorkflowStatus(status: string): status is (typeof TERMINAL_WORKFLOW_RUN_STATUSES)[number] {
  return (TERMINAL_WORKFLOW_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * 保证终态 run 的 payload 带 `terminalOutcome`。非终态原样返回。
 * 显式值优先（调用方判定业务语义），否则按 status 派生基础设施级默认。
 */
export function withTerminalOutcome(status: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  if (!isTerminalWorkflowStatus(status)) return payload;
  if (typeof payload.terminalOutcome === "string") return payload;
  return { ...payload, terminalOutcome: TERMINAL_DEFAULT_OUTCOME[status] };
}
