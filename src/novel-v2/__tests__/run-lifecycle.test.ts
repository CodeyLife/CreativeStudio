import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import { isPostgresUnavailable } from "./test-db";
import {
  ACTIVE_WORKFLOW_RUN_STATUSES,
  ACTIVE_WORKFLOW_RUN_STATUSES_SQL,
  HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS,
  HUMAN_GATE_WORKFLOW_RUN_STATUSES,
  HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES_SQL,
  TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS,
  WAITING_EXTERNAL_WORKFLOW_RUN_STATUS,
  WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL,
  WORKFLOW_RUN_STATUSES,
  isForbiddenTerminalOverwrite,
  isHumanGateWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  isWorkflowRunStatus,
  terminalOverwriteGuardSql,
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

  it("终态吸收规则的三条边界都按观测收口（复活挡、重申与重驱动放）", () => {
    for (const from of TERMINAL_WORKFLOW_RUN_STATUSES) {
      // ③ 复活：终态 → 非终态且非 accepted ⇒ 挡
      for (const to of [...ACTIVE_WORKFLOW_RUN_STATUSES, ...HUMAN_GATE_WORKFLOW_RUN_STATUSES, WAITING_EXTERNAL_WORKFLOW_RUN_STATUS].filter((status) => status !== TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS)) {
        expect(isForbiddenTerminalOverwrite(from, to), `${from}->${to}`).toBe(true);
      }
      // ① 重驱动：同一 intent 键控 workflowId 再收一次 ⇒ 放（历史观测 4 次）
      expect(isForbiddenTerminalOverwrite(from, TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS), `${from}->accepted`).toBe(false);
      // ② 重申业务结局：终态 → 终态 ⇒ 放（对账/审计会重写终态行）
      for (const to of TERMINAL_WORKFLOW_RUN_STATUSES) expect(isForbiddenTerminalOverwrite(from, to), `${from}->${to}`).toBe(false);
    }
    // 非终态出发一律放开（含新态首用：零历史的 waiting-external / 人工门族不得被挡）
    for (const from of [...ACTIVE_WORKFLOW_RUN_STATUSES, ...HUMAN_GATE_WORKFLOW_RUN_STATUSES, WAITING_EXTERNAL_WORKFLOW_RUN_STATUS]) {
      for (const to of WORKFLOW_RUN_STATUSES) expect(isForbiddenTerminalOverwrite(from, to), `${from}->${to}`).toBe(false);
    }
  });

  it("SQL 守卫由词表派生，且与 TS 判据同集合（两处各自演化即红）", () => {
    const sql = terminalOverwriteGuardSql("$2");
    expect(sql).toContain(`status NOT IN (${TERMINAL_WORKFLOW_RUN_STATUSES_SQL})`);
    expect(sql).toContain(`$2='${TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS}'`);
    for (const status of WORKFLOW_RUN_STATUSES) {
      const allowedByTs = !isForbiddenTerminalOverwrite("completed", status);
      // SQL 里出现该目标态时（终态集或 accepted），必须与 TS 判据一致
      const allowedBySql = TERMINAL_WORKFLOW_RUN_STATUSES.includes(status as (typeof TERMINAL_WORKFLOW_RUN_STATUSES)[number]) || status === TERMINAL_REDRIVE_WORKFLOW_RUN_STATUS;
      expect(allowedBySql, status).toBe(allowedByTs);
    }
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

  it("workflow_runs.status 写入者只有三个：受控漏斗、乐观守卫对账、人工门守卫回写", () => {
    const writers = [...repository.matchAll(/UPDATE workflow_runs SET status/g)].length;
    expect(writers).toBe(3);
    // 对账那条必须自带乐观并发守卫（WHERE status=旧快照），否则会用过期判据覆写新鲜事实。
    expect(repository).toContain("WHERE temporal_workflow_id=$1 AND status=$2");
    // 漏斗的状态参数必须是词表类型，不是宽 string。
    expect(repository).toMatch(/updateWorkflowRunStatus\(temporalWorkflowId: string, status: WorkflowRunStatus/);
    // 第三条是人工门回写：判据必须写进 UPDATE 的 WHERE（先读后判会留竞态窗口）。
    expect(repository).toMatch(/AND status IN \(\$\{HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL\}\)/);
    // 漏斗本体必须挂终态吸收守卫（删掉即回到"任何写入者都能复活终态 run"的旧形态）。
    expect(repository).toMatch(/WHERE temporal_workflow_id=\$1 \$\{terminalOverwriteGuardSql\("\$2"\)\}/);
    // 守卫挡下时不得静默：留一条 refusal 事件供审计发现覆写尝试。
    expect(repository).toContain('"workflow.transition-refused"');
  });

  it("人工裁决链路的状态回写一律走守卫方法（未命中即由工作流独占状态）", () => {
    const api = readFileSync(fileURLToPath(new URL("../../../scripts/novel-v2-api.ts", import.meta.url)), "utf8");
    const handlers = readFileSync(fileURLToPath(new URL("../mcp/handlers.ts", import.meta.url)), "utf8");
    expect([...api.matchAll(/resumeWorkflowRunFromHumanGate\(/g)].length).toBe(2);
    expect([...handlers.matchAll(/resumeWorkflowRunFromHumanGate\(/g)].length).toBe(1);
    // 反向：gate→running 不得再直接用无守卫漏斗。
    expect(`${api}${handlers}`).not.toMatch(/updateWorkflowRunStatus\([^\n]*"running",[^\n]*pendingHumanDecisionSubmitted/);
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

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/**
 * 人工门 → running 回写的真实落库验证。
 *
 * 竞态本身不可在单测里复现（要靠信号与写入的时序巧合），但守卫的**判据**可以：
 * 正向证明"仍处门态才回写"，反向证明"终态绝不被覆、payload 绝不被合并"——后者正是
 * 旧写法把成功裁决改写回 running 的形态。事件面同批验证，避免守卫方法悄悄丢了留痕。
 */
describe("人工门守卫回写（落库）", () => {
  let repo: NovelPostgresRepository;
  let available = false;
  const projectId = `test-gate-resume-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repo = new NovelPostgresRepository(TEST_DB_URL);
      await repo.migrate();
      await repo.ensureProject(projectId, "Gate Resume Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[run-lifecycle.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repo.deleteProject(projectId).catch(() => undefined);
    await repo.close();
  });

  it("门态回写生效并留事件；终态既不改状态也不并 payload（双向）", async () => {
    if (!available) return;
    expect(ACTIVE_WORKFLOW_RUN_STATUSES).toContain(HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS);

    const gateId = `gate-${randomUUID()}`;
    await repo.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-review", projectId, temporalWorkflowId: gateId, status: "manual-review-required" });
    const resumed = await repo.resumeWorkflowRunFromHumanGate(gateId, { stage: "revision", decision: "revise", pendingHumanDecisionSubmitted: true });
    expect(resumed?.status).toBe("running");
    expect(resumed?.payload.decision).toBe("revise");
    const events = await repo.pool.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_events WHERE aggregate_type='workflow-run' AND aggregate_id=$1 ORDER BY id",
      [gateId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(["workflow.manual-review-required", "workflow.running", "workflow.progress.revision"]);

    const doneId = `done-${randomUUID()}`;
    await repo.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-review", projectId, temporalWorkflowId: doneId, status: "completed" });
    const untouched = await repo.resumeWorkflowRunFromHumanGate(doneId, { stage: "fact-extraction", decision: "approve", pendingHumanDecisionSubmitted: true });
    expect(untouched).toBeUndefined();
    const row = await repo.pool.query<{ status: string; payload: Record<string, unknown> }>(
      "SELECT status,payload FROM workflow_runs WHERE temporal_workflow_id=$1",
      [doneId],
    );
    expect(row.rows[0].status).toBe("completed");
    expect(row.rows[0].payload.decision).toBeUndefined();
    expect(row.rows[0].payload.terminalOutcome).toBe("succeeded");
  });

  it("终态吸收：复活被挡且留 refusal 事件；重申终态与重驱动照旧放行", async () => {
    if (!available) return;
    const doneId = `absorb-${randomUUID()}`;
    await repo.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-review", projectId, temporalWorkflowId: doneId, status: "running" });
    await repo.updateWorkflowRunStatus(doneId, "completed", { stage: "fact-extraction" });

    const resurrected = await repo.updateWorkflowRunStatus(doneId, "running", { stage: "revision" });
    expect(resurrected).toBeUndefined();
    const row = await repo.pool.query<{ status: string; payload: Record<string, unknown> }>("SELECT status,payload FROM workflow_runs WHERE temporal_workflow_id=$1", [doneId]);
    expect(row.rows[0].status).toBe("completed");
    // 被挡的写入连 payload 都不留，否则"复活失败"仍会污染展示位。
    expect(row.rows[0].payload.stage).toBe("fact-extraction");

    const refused = await repo.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_events WHERE aggregate_type='workflow-run' AND aggregate_id=$1 AND event_type='workflow.transition-refused'",
      [doneId],
    );
    expect(refused.rowCount).toBe(1);
    expect(refused.rows[0].payload).toMatchObject({ from: "completed", to: "running", rule: "terminal-absorbing-except-redrive" });

    // 放行面②：重申业务结局（终态→终态）；放行面①：重驱动（终态→accepted）。
    expect((await repo.updateWorkflowRunStatus(doneId, "failed", { error: "restated" }))?.status).toBe("failed");
    expect((await repo.updateWorkflowRunStatus(doneId, "accepted", { redrive: true }))?.status).toBe("accepted");
  });
});
