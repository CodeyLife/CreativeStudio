import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { WorkflowRunSlice } from "../repository/workflow-run-slice";
import type { OutboxWriter } from "../repository/shared";
import { HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL, TERMINAL_WORKFLOW_RUN_STATUSES_SQL } from "../run-lifecycle";

/**
 * workflow-run slice 的独立单测（拆片的直接收益）。
 *
 * 这些判据此前**没法在不起 Postgres 的情况下测**：状态 SQL 与 outbox 双写埋在 7,000 行的
 * `NovelPostgresRepository` 里，只能靠 DB 集成面间接覆盖——DB 不可用时整组静默失效。
 * slice 只需要两样依赖（连接 + outbox 写入器），于是守卫 SQL、refusal 留痕、事件顺序
 * 都能用假连接逐条断言。DB 集成测试仍保留（真库上验证并发与 JSONB 合并语义），两者互补。
 */

type FakeResult = { rows: unknown[]; rowCount: number };

function makeSlice(results: FakeResult[]) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql, params });
      const next = results.shift();
      return next ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const appendOutbox: OutboxWriter = async (_aggregateType, _id, eventType, payload) => {
    events.push({ type: eventType, payload });
    return events.length;
  };
  return { slice: new WorkflowRunSlice({ pool, appendOutbox }), sqls, events };
}

const row = { id: "r1", workflow_type: "chapter-review", project_id: "p1", temporal_workflow_id: "wf1", status: "running", payload: {}, created_at: new Date(0), updated_at: new Date(0) };

describe("workflow-run slice（假连接）", () => {
  it("状态漏斗带终态吸收守卫，且目标态走绑定参数不内联", async () => {
    const { slice, sqls } = makeSlice([{ rows: [row], rowCount: 1 }]);
    await slice.updateStatus("wf1", "completed", { reason: "ok" });
    const update = sqls[0].sql;
    expect(update).toContain(`status NOT IN (${TERMINAL_WORKFLOW_RUN_STATUSES_SQL})`);
    expect(update).toContain("$2='accepted'");
    expect(sqls[0].params[1]).toBe("completed");
    // 终态写入必带 terminalOutcome 固定键（slice 不绕过该规则）。
    expect(JSON.parse(JSON.stringify(sqls[0].params[2]))).toMatchObject({ terminalOutcome: "succeeded" });
  });

  it("门态回写只认人工门族，未命中即静默交还状态权", async () => {
    const { slice, sqls, events } = makeSlice([{ rows: [], rowCount: 0 }]);
    expect(await slice.resumeFromHumanGate("wf1", { stage: "revision" })).toBeUndefined();
    expect(sqls[0].sql).toContain(`status IN (${HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL})`);
    expect(events).toEqual([]);
  });

  it("守卫挡下时留 refusal 事件；行不存在则安静（正常竞态）", async () => {
    const refused = makeSlice([{ rows: [], rowCount: 0 }, { rows: [{ status: "completed" }], rowCount: 1 }]);
    expect(await refused.slice.updateStatus("wf1", "running", { stage: "revision" })).toBeUndefined();
    expect(refused.events).toEqual([
      { type: "workflow.transition-refused", payload: { from: "completed", to: "running", rule: "terminal-absorbing-except-redrive" } },
    ]);

    const missing = makeSlice([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]);
    expect(await missing.slice.updateStatus("gone", "running")).toBeUndefined();
    expect(missing.events).toEqual([]);
  });

  it("事件面顺序：状态事件先于 progress 事件，两者同 payload；无 stage 不产 progress", async () => {
    const withStage = makeSlice([{ rows: [row], rowCount: 1 }]);
    await withStage.slice.updateStatus("wf1", "running", { stage: "revision-decision", iteration: 2 });
    expect(withStage.events.map((event) => event.type)).toEqual(["workflow.running", "workflow.progress.revision-decision"]);
    expect(withStage.events[1].payload.iteration).toBe(2);

    const noStage = makeSlice([{ rows: [row], rowCount: 1 }]);
    await noStage.slice.updateStatus("wf1", "running", { note: "无阶段" });
    expect(noStage.events.map((event) => event.type)).toEqual(["workflow.running"]);
  });

  it("put 走 ON CONFLICT 合并并在非终态时不注入 terminalOutcome", async () => {
    const { slice, sqls, events } = makeSlice([{ rows: [row], rowCount: 1 }]);
    const record = await slice.put({ id: "r1", workflowType: "chapter-review", projectId: "p1", temporalWorkflowId: "wf1", status: "accepted" });
    expect(sqls[0].sql).toContain("ON CONFLICT(temporal_workflow_id) DO UPDATE");
    expect(sqls[0].params[5]).toEqual({});
    expect(record?.status).toBe("running");
    expect(events.map((event) => event.type)).toEqual(["workflow.accepted"]);
  });
});
