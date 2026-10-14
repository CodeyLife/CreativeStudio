import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModelTaskSlice } from "../repository/model-task-slice";
import type { OutboxWriter } from "../repository/shared";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 租约不变式的独立单测（第二片拆分的直接收益）。
 *
 * 这些判据此前只有两个去处：真库集成测试（DB 不可用即整组静默跳过），或者读 SQL 目测。
 * slice 只需要 pool + outbox 两个依赖，于是"非 pending 不得领取""无活租约不得交付"
 * "重复交付幂等""指纹不匹配即拒"都能在假连接上逐条断言，含事务边界与 ROLLBACK。
 */

type FakeResult = { rows: unknown[]; rowCount?: number };

function makeSlice(results: FakeResult[]) {
  const sqls: string[] = [];
  const events: Array<{ aggregateType: string; type: string; payload: Record<string, unknown> }> = [];
  const queue = [...results];
  const take = () => queue.shift() ?? { rows: [], rowCount: 0 };
  // 事务控制语句不消耗脚本：否则每个 BEGIN/COMMIT 都会把后续结果错位一格。
  const paramsList: unknown[][] = [];
  const run = (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    paramsList.push(params);
    return /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql) ? { rows: [], rowCount: 0 } : take();
  };
  const client = { query: async (sql: string, params?: unknown[]) => run(sql, params), release: () => undefined };
  const pool = { query: async (sql: string, params?: unknown[]) => run(sql, params), connect: async () => client } as unknown as Pool;
  const appendOutbox: OutboxWriter = async (aggregateType, _id, eventType, payload) => {
    events.push({ aggregateType, type: eventType, payload });
    return events.length;
  };
  return { slice: new ModelTaskSlice({ pool, appendOutbox }), sqls, events, paramsList };
}

const pendingTask = { id: "mt1", workflow_run_id: "wf1", task_id: "t1", purpose: "text", config_revision: "r1", candidate_index: 0, status: "pending", work_package: { inputFingerprint: "fp-1" }, result: null, idempotency_key: "k1", project_id: "p1", created_at: new Date(0), updated_at: new Date(0) };
const submittedTask = { ...pendingTask, status: "submitted" };

describe("model-task slice 租约不变式（假连接）", () => {
  it("非 pending 不得领取，且事务回滚", async () => {
    const { slice, sqls } = makeSlice([
      { rows: [], rowCount: 0 },                          // claim 前的读路径自愈 reopen
      { rows: [{ ...pendingTask, status: "claimed" }], rowCount: 1 }, // SELECT ... FOR UPDATE
    ]);
    await expect(slice.claim({ taskId: "mt1", attemptId: "a1", leaseOwner: "w1", leaseMs: 60_000 })).rejects.toThrow("外部模型任务不可领取：claimed");
    // claim 也走"读路径自愈"，所以第一条是 reopen 的 UPDATE，之后才进事务。
    expect(sqls[0]).toContain("SET status='pending'");
    expect(sqls[1]).toBe("BEGIN");
    expect(sqls.find((sql) => sql.includes("FOR UPDATE"))).toBeTruthy();
    expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
    expect(sqls.some((sql) => sql.includes("INSERT INTO task_attempts"))).toBe(false);
  });

  it("领取走行锁 + 同事务建 attempt，提交后再回读", async () => {
    const { slice, sqls } = makeSlice([
      { rows: [], rowCount: 0 },                      // claim 前的 reopen
      { rows: [pendingTask], rowCount: 1 },          // SELECT ... FOR UPDATE
      { rows: [], rowCount: 1 },                      // UPDATE model_tasks -> claimed
      { rows: [], rowCount: 1 },                      // INSERT task_attempts
      { rows: [], rowCount: 0 },                      // get() 之前的 reopen
      { rows: [{ ...pendingTask, status: "claimed" }], rowCount: 1 }, // get()
    ]);
    const claimed = await slice.claim({ taskId: "mt1", attemptId: "a1", leaseOwner: "w1", leaseMs: 60_000 });
    expect(claimed.status).toBe("claimed");
    expect(sqls.filter((sql) => sql === "COMMIT").length).toBe(1);
    const attemptInsert = sqls.find((sql) => sql.includes("INSERT INTO task_attempts"))!;
    expect(attemptInsert).toContain("model_task_id");   // 086 的显式关联列，不靠 task_id 巧合
    expect(attemptInsert).toContain("ON CONFLICT(id) DO UPDATE");
  });

  it("心跳要求活租约且属于当前执行者，否则抛错不动任务状态", async () => {
    const { slice, sqls } = makeSlice([{ rows: [], rowCount: 0 }]);
    await expect(slice.heartbeat({ taskId: "mt1", attemptId: "a1", leaseOwner: "other", leaseMs: 60_000 })).rejects.toThrow("任务租约不存在、已过期或不属于当前执行者");
    expect(sqls.some((sql) => sql.includes("UPDATE model_tasks"))).toBe(false);
  });

  it("交付幂等：已 submitted 原样返回，不再次改状态", async () => {
    const { slice, sqls } = makeSlice([{ rows: [submittedTask], rowCount: 1 }]);
    const result = await slice.submit({ taskId: "mt1", attemptId: "a1", leaseOwner: "w1", inputFingerprint: "fp-1", result: { text: "x" } });
    expect(result.status).toBe("submitted");
    expect(sqls.some((sql) => sql.includes("SET status='submitted'"))).toBe(false);
    expect(sqls.filter((sql) => sql === "COMMIT").length).toBe(1);
    expect(sqls.filter((sql) => sql === "ROLLBACK").length).toBe(0);
  });

  it("输入指纹不匹配即拒并回滚（上下文已变的任务不接受旧执行者的结果）", async () => {
    const { slice, sqls } = makeSlice([{ rows: [pendingTask], rowCount: 1 }]);
    await expect(slice.submit({ taskId: "mt1", attemptId: "a1", leaseOwner: "w1", inputFingerprint: "fp-OTHER", result: { text: "x" } })).rejects.toThrow("输入指纹不匹配");
    expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
  });

  it("交付需三证齐全：任务在、指纹对、租约活", async () => {
    const { slice } = makeSlice([{ rows: [pendingTask], rowCount: 1 }, { rows: [], rowCount: 0 }]);
    await expect(slice.submit({ taskId: "mt1", attemptId: "a1", leaseOwner: "stale", inputFingerprint: "fp-1", result: { text: "x" } })).rejects.toThrow("任务租约不存在、已过期或不属于当前执行者");
  });

  it("结果既无 text 又无 value 时拒绝落库", async () => {
    const { slice, sqls } = makeSlice([{ rows: [pendingTask], rowCount: 1 }, { rows: [{ one: 1 }], rowCount: 1 }]);
    await expect(slice.submit({ taskId: "mt1", attemptId: "a1", leaseOwner: "w1", inputFingerprint: "fp-1", result: {} })).rejects.toThrow("必须包含 text 或 value");
    expect(sqls.some((sql) => sql.includes("SET status='submitted'"))).toBe(false);
  });

  it("过期回收只对无人认领的任务留 expired 事件，并回写租约行", async () => {
    const { slice, sqls, events, paramsList } = makeSlice([{ rows: [{ project_id: "p1", workflow_run_id: "wf1" }], rowCount: 1 }]);
    await slice.expire("mt1", "no-claim");
    expect(sqls[0]).toContain("status IN ('pending','claimed','running')");
    expect(sqls[1]).toContain("WHERE model_task_id=$1 AND status IN ('claimed','running')");
    expect(events).toEqual([{ aggregateType: "model-task", type: "model-task.expired", payload: { projectId: "p1", modelTaskId: "mt1", workflowRunId: "wf1", reason: "no-claim" } }]);
    // expired 标记在写入的 result/payload 里，不在 SQL 文本里。
    expect(paramsList[0][1]).toMatchObject({ value: { reason: "no-claim", expired: true } });
    expect(paramsList[1][1]).toMatchObject({ reason: "no-claim", expired: true });
  });

  it("整 run 过期返回受影响行数；不逐个补 expired 事件（批量语义只给一次总量）", async () => {
    const { slice, events } = makeSlice([{ rows: [], rowCount: 4 }]);
    expect(await slice.expireForWorkflow("wf1", "run-cancelled")).toBe(4);
    expect(events).toEqual([]);
  });

  it("信号留痕按信号名映射 attempt 状态，并落 task.<status> 事件", async () => {
    const cases: Array<[string, string]> = [["claim", "claimed"], ["heartbeat", "running"], ["artifact", "submitted"], ["review", "reviewed"], ["fail", "failed"], ["whatever", "running"]];
    for (const [signal, status] of cases) {
      const { slice, events } = makeSlice([{ rows: [{ id: `t1:signal`, workflow_run_id: "wf1", task_id: "t1", lease_owner: null, lease_expires_at: null, heartbeat_at: new Date(0), status, payload: { signal } }], rowCount: 1 }]);
      await slice.recordSignal({ workflowId: "wf1", taskId: "t1", signal });
      expect(events[0].aggregateType).toBe("task-attempt");
      expect(events[0].type).toBe(`task.${status}`);
    }
  });

  it("读路径自愈：任何一次读都先回收失去活租约的任务", async () => {
    const { slice, sqls } = makeSlice([{ rows: [], rowCount: 0 }]);
    await slice.get("mt1");
    expect(sqls[0]).toContain("UPDATE model_tasks mt SET status='pending'");
    expect(sqls[0]).toContain("ta.lease_expires_at>now()");
  });
});

describe("model_tasks / task_attempts 的写入归属", () => {
  const repo = readFileSync(join(process.cwd(), "src/novel-v2/postgres-repository.ts"), "utf8");
  const slice = readFileSync(join(process.cwd(), "src/novel-v2/repository/model-task-slice.ts"), "utf8");

  /**
   * 判据落在**代码**上，不是注释上：`workflow-run-slice.ts` 与 `mcp/handlers.ts` 的注释里
   * 正当提到这两张表（讲"任务表的 SQL 归那片"），不剥注释会误判。
   */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * 归属判据按**表**判，不按动词判。
   *
   * 初版只匹配 `INSERT`/`UPDATE` 四个模式，于是 `DELETE FROM task_attempts`（deleteProject）、
   * `SELECT … FROM model_tasks`（expireOrphanedModelTasks）、`DELETE FROM model_tasks`
   * （cleanupExpiredChapterData）全部漏网——守卫断言了一个不成立的不变量（绿的说谎），
   * 而"租约表生命周期"实际横跨两个文件。详见 `.scratch/w2-model-task-ownership/spec.md`。
   */
  const SQL_ON_OWNED_TABLES = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+(model_tasks|task_attempts)\b/;

  it("切片自己持有这两张表的全部 SQL（判据非空转）", () => {
    const hits = stripComments(slice).match(new RegExp(SQL_ON_OWNED_TABLES.source, "g")) ?? [];
    // 现有 SQL 条数远多于此；下限只是防"判据被改宽到恒不命中"。
    expect(hits.length).toBeGreaterThanOrEqual(10);
  });

  it("全仓（除测试与迁移 DDL）没有第二处 SQL：一张表一个家", async () => {
    const { readdirSync } = await import("node:fs");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
    const offenders = walk(join(process.cwd(), "src")).concat(walk(join(process.cwd(), "scripts")))
      .filter((file) => !file.endsWith("model-task-slice.ts"))
      .filter((file) => SQL_ON_OWNED_TABLES.test(stripComments(readFileSync(file, "utf8"))));
    expect(offenders.map((file) => relative(process.cwd(), file).replace(/\\/g, "/"))).toEqual([]);
  });

  it("仓储侧只剩委托", () => {
    expect(repo).toContain("return this.modelTasks.claim(input);");
    expect(repo).toContain("return this.modelTasks.submit(input);");
    expect(repo).toContain("return this.modelTasks.upsertAttempt(input);");
    expect(repo).toContain("return this.modelTasks.recordSignal(input);");
    // 级联删除与孤儿收编也一并委托（含 SELECT/DELETE，不再只有写动词）。
    expect(repo).toContain("await this.modelTasks.removeProjectTasks(client, projectId);");
    expect(repo).toContain("await this.modelTasks.removeRunTasks(client,");
    expect(repo).toContain("return this.modelTasks.expireOrphaned(reason);");
    // 仓储不再需要 outstanding 词表的 SQL 片段（它随 SELECT 一起搬回切片）。
    expect(repo).not.toContain("OUTSTANDING_MODEL_TASK_STATUSES_SQL");
  });
});

/**
 * 本片新增的三个方法（级联删除两处 + 孤儿收编一处）。
 *
 * 它们的价值不在于"多测了几条 SQL"，而在于**把此前只存在于 god-object 里的语句挪到可单测的
 * 边界内**：`deleteProject` 与 `cleanupExpiredChapterData` 都必须起真库 + 真事务才能验，
 * 而"删哪两张表、按哪些键形态、用哪个连接"现在能在假连接上逐条断言。
 */
describe("model_tasks / task_attempts 的级联删除与孤儿收编（假连接）", () => {
  /** 只记录、不返回数据的 executor，用来证明"用的是调用方给的连接"而不是 this.pool。 */
  function makeExecutor() {
    const sqls: string[] = [];
    const paramsList: unknown[][] = [];
    const executor = {
      query: async (sql: string, params?: unknown[]) => { sqls.push(sql); paramsList.push(params ?? []); return { rows: [], rowCount: 0 }; },
    };
    return { executor, sqls, paramsList };
  }

  it("removeProjectTasks 用调用方的 executor（事务内），先 model_tasks 后 task_attempts，且两种键形态都认", async () => {
    const { slice, sqls: poolSqls } = makeSlice([]);
    const { executor, sqls, paramsList } = makeExecutor();
    await slice.removeProjectTasks(executor as never, "p1");

    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain("DELETE FROM model_tasks");
    expect(sqls[0]).toContain("project_id=$1 OR workflow_run_id IN (");
    expect(sqls[1]).toContain("DELETE FROM task_attempts");
    // 两种键形态（workflow_runs.id 与 temporal_workflow_id）缺一即收不全——migration 088 的实形。
    expect(sqls[1]).toContain("SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1");
    expect(sqls[1]).toContain("SELECT id FROM workflow_runs WHERE project_id=$1");
    expect(paramsList).toEqual([["p1"], ["p1"]]);
    // 关键：一条都没落到 this.pool——否则删除会跑在调用方事务之外。
    expect(poolSqls).toEqual([]);
  });

  it("removeRunTasks 用调用方的 executor，先 task_attempts 后 model_tasks，两个键都传", async () => {
    const { slice, sqls: poolSqls } = makeSlice([]);
    const { executor, sqls, paramsList } = makeExecutor();
    await slice.removeRunTasks(executor as never, { id: "run-id-1", temporalWorkflowId: "wf-temporal-1" });

    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain("DELETE FROM task_attempts WHERE workflow_run_id=$1 OR workflow_run_id=$2");
    expect(sqls[1]).toContain("DELETE FROM model_tasks WHERE workflow_run_id=$1");
    expect(paramsList[0]).toEqual(["run-id-1", "wf-temporal-1"]);
    expect(paramsList[1]).toEqual(["wf-temporal-1"]);
    expect(poolSqls).toEqual([]);
  });

  it("expireOrphaned 选键与收编同在一处：先按终态反选，再逐键走 expireForWorkflow 并累加", async () => {
    const { slice, sqls, paramsList } = makeSlice([
      { rows: [{ key: "wf-a" }, { key: "wf-b" }], rowCount: 2 },   // SELECT 孤儿键
      { rows: [{ project_id: "p1", workflow_run_id: "wf-a" }], rowCount: 1 }, // expire wf-a
      { rows: [{ project_id: "p1", workflow_run_id: "wf-b" }], rowCount: 1 }, // expire wf-b
    ]);
    const expired = await slice.expireOrphaned("test-reason");

    expect(expired).toBe(2);
    expect(sqls[0]).toContain("SELECT DISTINCT t.workflow_run_id AS key");
    expect(sqls[0]).toContain("FROM model_tasks t");
    // 判据与 run-lifecycle 同源：两段状态串都由常量内插，不在本文件手写。
    // 精确断言终态片段——`'running'` 在 outstanding 那侧是正当成员（见上一行），
    // 所以"整个 SQL 不含 running"是错的断言；要锁的是它**不在终态集合里**。
    expect(sqls[0]).toContain("t.status IN ('pending','claimed','running')");
    expect(sqls[0]).toContain("r.status NOT IN ('completed','failed','cancelled','abandoned','rejected')");
    // 逐键收编，键原样透传（不再由仓储读、切片写）。
    expect(sqls.slice(1).every((sql) => sql.includes("SET status='failed'"))).toBe(true);
    expect(paramsList.slice(1).map((params) => params[0])).toEqual(["wf-a", "wf-b"]);
  });
});
