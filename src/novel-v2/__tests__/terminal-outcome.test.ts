import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { withTerminalOutcome, isTerminalWorkflowStatus } from "../terminal-outcome";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

// ===== OR-A2 单元：终态子类型派生规则 =====
describe("withTerminalOutcome（OR-A2 派生规则）", () => {
  it("终态注入默认子类型，非终态原样返回（双向）", () => {
    expect(withTerminalOutcome("completed", { x: 1 })).toEqual({ x: 1, terminalOutcome: "succeeded" });
    expect(withTerminalOutcome("failed")).toEqual({ terminalOutcome: "infrastructure-failed" });
    expect(withTerminalOutcome("cancelled", {})).toEqual({ terminalOutcome: "cancelled" });
    // 词表里同为终态、但曾被本地清单漏掉的两种作者结局（漏掉的后果是审计缺固定键）。
    expect(withTerminalOutcome("abandoned", {})).toEqual({ terminalOutcome: "abandoned-by-author" });
    expect(withTerminalOutcome("rejected", {})).toEqual({ terminalOutcome: "business-review-rejected" });
    for (const nonTerminal of ["running", "waiting-external", "pending", "manual-review-required", "regression-validation-required", "rebuild-requested", "accepted"]) {
      expect(withTerminalOutcome(nonTerminal, { a: 1 })).toEqual({ a: 1 });
      expect(isTerminalWorkflowStatus(nonTerminal)).toBe(false);
    }
  });

  it("显式子类型不被覆盖（调用方业务判定优先 + 幂等）", () => {
    const explicit = withTerminalOutcome("completed", { terminalOutcome: "business-revision-exhausted" });
    expect(explicit.terminalOutcome).toBe("business-revision-exhausted");
    expect(withTerminalOutcome("completed", explicit).terminalOutcome).toBe("business-revision-exhausted");
  });
});

// ===== OR-A2 集成：终态写路径落库保证固定键 =====
describe("workflow run 终态写入必带 terminalOutcome", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-terminal-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Terminal Outcome Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[terminal-outcome.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("创建非终态无键 → completed 派生 succeeded → failed 派生 infrastructure-failed → 显式业务子类型保留", async () => {
    if (!available) return;
    const temporalId = `terminal-${randomUUID()}`;
    const created = await repository.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "story-arc-planning", projectId, temporalWorkflowId: temporalId, status: "running" });
    expect(created.payload.terminalOutcome).toBeUndefined();

    const done = await repository.updateWorkflowRunStatus(temporalId, "completed", { reason: "ok" });
    expect(done?.status).toBe("completed");
    expect(done?.payload.terminalOutcome).toBe("succeeded");

    const disguised = await repository.updateWorkflowRunStatus(temporalId, "completed", { reason: "故事弧蓝图在最大修订次数内未通过审核", terminalOutcome: "business-revision-exhausted" });
    expect(disguised?.payload.terminalOutcome).toBe("business-revision-exhausted");

    const broken = await repository.updateWorkflowRunStatus(temporalId, "failed", { error: "timeout" });
    expect(broken?.payload.terminalOutcome).toBe("infrastructure-failed");
  });

  it("putWorkflowRun 直接以终态创建时也注入", async () => {
    if (!available) return;
    const temporalId = `terminal-direct-${randomUUID()}`;
    const run = await repository.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-generation", projectId, temporalWorkflowId: temporalId, status: "failed", payload: { error: "boom" } });
    expect(run.payload.terminalOutcome).toBe("infrastructure-failed");
  });

  it("OR-C1 双写：带 stage 的 progress 逐条落 outbox（后写覆盖不再丢守卫历史），无 stage 不产生 progress 事件", async () => {
    if (!available) return;
    const temporalId = `progress-${randomUUID()}`;
    await repository.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-generation", projectId, temporalWorkflowId: temporalId, status: "running" });
    await repository.updateWorkflowRunStatus(temporalId, "running", { stage: "revision-decision", iteration: 1, decision: "improved" });
    await repository.updateWorkflowRunStatus(temporalId, "running", { stage: "revision-reverted", iteration: 2, reason: "修订降低质量" });
    // run payload 上 stage 仍是最后写入值（展示位"后写覆盖"现状不变，事件表才是历史）……
    const runRow = await repository.pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM workflow_runs WHERE temporal_workflow_id=$1", [temporalId]);
    expect(runRow.rows[0].payload.stage).toBe("revision-reverted");
    // ……但守卫历史在事件表逐条可查——旧 bug 形态（run payload 0 命中）的反证。
    const events = await repository.pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type,payload FROM outbox_events WHERE aggregate_type='workflow-run' AND aggregate_id=$1 AND event_type LIKE 'workflow.progress.%' ORDER BY id",
      [temporalId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(["workflow.progress.revision-decision", "workflow.progress.revision-reverted"]);
    expect(events.rows[0].payload.iteration).toBe(1);
    // 双向：同 run 上的无 stage 状态写入不得混入 progress 事件。
    await repository.updateWorkflowRunStatus(temporalId, "running", { heartbeat: 1 });
    const progressCount = await repository.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_type='workflow-run' AND aggregate_id=$1 AND event_type LIKE 'workflow.progress.%'",
      [temporalId],
    );
    expect(Number(progressCount.rows[0].count)).toBe(2);
  });
});
