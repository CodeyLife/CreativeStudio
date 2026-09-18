import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_WORKFLOW_RUN_STATUSES,
  ACTIVE_WORKFLOW_RUN_STATUSES_SQL,
  HUMAN_GATE_WORKFLOW_RUN_STATUSES,
  HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES_SQL,
  WAITING_EXTERNAL_WORKFLOW_RUN_STATUS,
  WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL,
  WORKFLOW_RUN_STATUSES,
  isHumanGateWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  isWorkflowRunStatus,
  type WorkflowRunStatus,
} from "../run-lifecycle";
import { isTerminalWorkflowStatus, withTerminalOutcome } from "../terminal-outcome";

/**
 * run 生命周期词表守卫。
 *
 * 词表本身不难写对，难的是**让每个状态都有归属**：新增一个状态时最容易发生的是
 * "只加了写入侧，忘了对账/总览/门态判定"，而这类漏项不会编译报错、也不会立刻表现为
 * 故障（run 只是永远不被收编，或永远被误收编）。所以下面三条穷尽性断言才是本文件的
 * 重点，其他都是配套的接线锁。
 */
describe("workflow_runs 生命周期词表", () => {
  it("词表无重复且读取侧判据与词表一致", () => {
    expect(new Set(WORKFLOW_RUN_STATUSES).size).toBe(WORKFLOW_RUN_STATUSES.length);
    for (const status of WORKFLOW_RUN_STATUSES) expect(isWorkflowRunStatus(status)).toBe(true);
    expect(isWorkflowRunStatus("workflow-start-failed")).toBe(false);
    expect(isWorkflowRunStatus("pending")).toBe(false);
  });

  it("三个分类两两不相交，且并集恰好等于词表（新增状态必须归类，不得悬空）", () => {
    const groups = [ACTIVE_WORKFLOW_RUN_STATUSES, HUMAN_GATE_WORKFLOW_RUN_STATUSES, TERMINAL_WORKFLOW_RUN_STATUSES, [WAITING_EXTERNAL_WORKFLOW_RUN_STATUS]] as const;
    const flat = groups.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual([...WORKFLOW_RUN_STATUSES].sort());
  });

  it("SQL 清单与分类集合逐项同源（对账/收编判据不靠手写字符串）", () => {
    const sqlOf = (statuses: readonly string[]) => statuses.map((status) => `'${status}'`).join(",");
    expect(ACTIVE_WORKFLOW_RUN_STATUSES_SQL).toBe(sqlOf(ACTIVE_WORKFLOW_RUN_STATUSES));
    expect(TERMINAL_WORKFLOW_RUN_STATUSES_SQL).toBe(sqlOf(TERMINAL_WORKFLOW_RUN_STATUSES));
    expect(HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL).toBe(sqlOf(HUMAN_GATE_WORKFLOW_RUN_STATUSES));
    expect(WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL).toBe(`'${WAITING_EXTERNAL_WORKFLOW_RUN_STATUS}'`);
  });

  it("每个终态都能派生出 terminalOutcome（含作者放弃/拒绝两种曾漏覆盖的结局）", () => {
    for (const status of TERMINAL_WORKFLOW_RUN_STATUSES) {
      expect(isTerminalWorkflowRunStatus(status)).toBe(true);
      expect(isTerminalWorkflowStatus(status)).toBe(true);
      const derived = withTerminalOutcome(status, { marker: 1 });
      expect(typeof derived.terminalOutcome).toBe("string");
      expect(derived.marker).toBe(1);
    }
    for (const status of [...ACTIVE_WORKFLOW_RUN_STATUSES, ...HUMAN_GATE_WORKFLOW_RUN_STATUSES, WAITING_EXTERNAL_WORKFLOW_RUN_STATUS]) {
      expect(isTerminalWorkflowStatus(status)).toBe(false);
      // 非终态不注入，避免中间态被当成结局（幂等契约的另一半）。
      expect(withTerminalOutcome(status, { a: 1 })).toEqual({ a: 1 });
    }
  });
});

describe("run 状态写入面接线锁", () => {
  const repository = readFileSync(fileURLToPath(new URL("../postgres-repository.ts", import.meta.url)), "utf8");
  const terminalOutcome = readFileSync(fileURLToPath(new URL("../terminal-outcome.ts", import.meta.url)), "utf8");

  it("terminal-outcome 不再自带第二份终态清单", () => {
    expect(terminalOutcome).toContain('from "./run-lifecycle"');
    expect(terminalOutcome).not.toMatch(/new Set\(\["completed"/);
  });

  it("workflow_runs.status 只有两个写入者：受控漏斗与带乐观守卫的对账", () => {
    const writers = [...repository.matchAll(/UPDATE workflow_runs SET status/g)].length;
    expect(writers).toBe(2);
    // 对账那条必须自带乐观并发守卫（WHERE status=旧快照），否则会用过期判据覆写新鲜事实。
    expect(repository).toContain("WHERE temporal_workflow_id=$1 AND status=$2");
    // 漏斗的状态参数必须是词表类型，不是宽 string。
    expect(repository).toMatch(/updateWorkflowRunStatus\(temporalWorkflowId: string, status: WorkflowRunStatus/);
  });

  it("对账候选查询取词表常量，不再内联状态清单", () => {
    expect(repository).toContain("status IN (${ACTIVE_WORKFLOW_RUN_STATUSES_SQL})");
    expect(repository).toContain("status=${WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL}");
    expect(repository).not.toMatch(/status IN \('running','accepted'\)/);
  });

  it("人工门族成员确实等人，对账不得收编", () => {
    const reconcile = repository.slice(repository.indexOf("async reconcileStaleWorkflowRuns"), repository.indexOf("async reconcileStaleWorkflowRuns") + 6000);
    for (const status of HUMAN_GATE_WORKFLOW_RUN_STATUSES) {
      expect(isHumanGateWorkflowRunStatus(status)).toBe(true);
      expect(reconcile).not.toContain(`'${status}'`);
    }
    expect([...HUMAN_GATE_WORKFLOW_RUN_STATUSES].sort()).toEqual<WorkflowRunStatus[]>(
      ["manual-review-required", "rebuild-requested", "regression-validation-required"],
    );
  });
});
