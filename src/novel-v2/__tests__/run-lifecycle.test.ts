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
  const slice = readFileSync(fileURLToPath(new URL("../repository/workflow-run-slice.ts", import.meta.url)), "utf8");
  const terminalOutcome = readFileSync(fileURLToPath(new URL("../terminal-outcome.ts", import.meta.url)), "utf8");

  it("terminal-outcome 不再自带第二份终态清单", () => {
    expect(terminalOutcome).toContain('from "./run-lifecycle"');
    expect(terminalOutcome).not.toMatch(/new Set\(\["completed"/);
  });

  it("workflow_runs 的 status 写入者恰为六处，每处各自带守卫", () => {
    // 判据扫"折叠空白后的 SQL"而不是源码原文：多行模板串写成
    // `UPDATE workflow_runs\n  SET status=...` 时，同行正则一律看不见——
    // 本锁此前断言"恰三个写入者"却漏掉两处（消费人工裁决的 gate→running、
    // 弧强制删除的 →cancelled），即"再开第四个写入者"根本不会被发现（2026-09-19 实测）。
    // 第二类失明是"无字面量的写入形态"：注册面写的是
    // `ON CONFLICT DO UPDATE SET status=EXCLUDED.status`，按 UPDATE…SET status 数永远数不到
    // 它（F5′，现计入第六处）。该形态必须绑定表名匹配——`runtime_services` 有一条形同样的
    // `DO UPDATE SET status=EXCLUDED.status`，只按片段数会把别的表的写入者算进本账（实测）。
    const scan = (source: string) => {
      // 先剥注释：本锁数的是"代码里的写入形态"，而解释这段历史的文档注释本身就引用了
      // `UPDATE workflow_runs SET status` 这个写法（不剥则计数虚高，且改注释会改断言结果）。
      const sql = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\s+/g, " ");
      return [...sql.matchAll(/UPDATE workflow_runs SET status/g)].length
        + [...sql.matchAll(/INSERT INTO workflow_runs\([^)]*\) VALUES\([^)]*\) ON CONFLICT\(temporal_workflow_id\) DO UPDATE SET status=EXCLUDED\.status/g)].length;
    };
    expect(scan(repository)).toBe(3);
    expect(scan(slice)).toBe(3);
    // 对账那条必须自带乐观并发守卫（WHERE status=旧快照），否则会用过期判据覆写新鲜事实。
    expect(repository).toContain("WHERE temporal_workflow_id=$1 AND status=$2");
    // 漏斗的状态参数必须是词表类型，不是宽 string；仓储侧只允许委托。
    expect(slice).toMatch(/async updateStatus\(temporalWorkflowId: string, status: WorkflowRunStatus/);
    expect(repository).toMatch(/async updateWorkflowRunStatus\(temporalWorkflowId: string, status: WorkflowRunStatus[^)]*\) \{\r?\n    return this\.workflowRuns\.updateStatus\(/);
    // 门态回写：判据必须写进 UPDATE 的 WHERE（先读后判会留竞态窗口）。
    expect(slice).toMatch(/AND status IN \(\$\{HUMAN_GATE_WORKFLOW_RUN_STATUSES_SQL\}\)/);
    // 漏斗本体必须挂终态吸收守卫（删掉即回到"任何写入者都能复活终态 run"的旧形态）。
    expect(slice).toMatch(/WHERE temporal_workflow_id=\$1 \$\{terminalOverwriteGuardSql\("\$2"\)\}/);
    // 守卫挡下时不得静默：留一条 refusal 事件供审计发现覆写尝试。
    expect(slice).toContain('"workflow.transition-refused"');
    // 注册面（第六处写入者）：无字面量的 upsert 同样要挂终态吸收守卫，且挡住时走同一条
    // refusal 留痕与同一份事件口径（各自实现一份"怎么记账"迟早漂移）。upsert 的 WHERE 里
    // 目标表与 EXCLUDED 同列同名，旧态引用必须限定表名（真库报 ambiguous）。
    expect(slice).toMatch(/DO UPDATE SET status=EXCLUDED\.status[^\n]*\n\s*WHERE \$\{terminalOverwriteGuardPredicateSql\("EXCLUDED\.status", "workflow_runs\.status"\)\}/);
    // 判据只有一份：两种拼接形态（AND 形式与前缀无的独立谓词）都由同一函数族导出。
    expect([...slice.matchAll(/terminalOverwriteGuard(?:Sql|PredicateSql)\(/g)].length).toBe(2);
    expect([...slice.matchAll(/recordTransitionRefusal\(/g)].length).toBe(3);
    expect(slice).toMatch(/return this\.announceStatus\(result\.rows\[0\], input\.status/);
    // 注册面的状态参数同属词表：宽 string 意味着任何调用方都能申报一个不在词表里的态。
    expect(slice).toMatch(/async put\(input: \{[^}]*status: WorkflowRunStatus/);
    expect(repository).toMatch(/async putWorkflowRun\(input: \{[^}]*status: WorkflowRunStatus/);
    // 消费人工裁决的 gate→running 与漏斗同判据（同一 vocabulary，不另立第二份规则）：
    // reject/abandon 短路径已把 run 写成终态时，裁决消费不得把它覆回 running。
    expect(repository).toContain('terminalOverwriteGuardSql("$3")');
    expect([...repository.matchAll(/terminalOverwriteGuardSql\(/g)].length).toBe(1);
    expect(repository).not.toMatch(/SET status='running'/);
    // 强制删除弧 →cancelled 是"终态→终态"的收编写入，指向本项目自有谓词（项目内章集合），
    // 不借漏斗；但它必须留下可审计的动机键，否则把 completed 覆成 cancelled 无从解释。
    // 两条断言分开写：动机键在 SQL 模板之后的参数里，按"相隔多少字符"锁会随无关编辑漂移。
    expect(repository).toMatch(/SET status='cancelled',[\s\S]{0,160}WHERE project_id=\$1 AND id=ANY\(\$2::text\[\]\)/);
    expect(repository).toContain('cancelledBy: "story-arc.force-delete"');
    // 反向：仓储里不得再留第二份"参数化状态"SQL（那意味着绕过 slice 漏斗）。
    expect(repository).not.toMatch(/UPDATE workflow_runs SET status=\$2/);
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

  it("注册面（put）也是终态吸收的受控写入者：复活被挡且 payload 不并，重申终态照旧放行", async () => {
    if (!available) return;
    // 这一写入形态此前对计数锁与守卫双向不可见：`DO UPDATE SET status=EXCLUDED.status` 里
    // 没有一个状态字面量（F5′）。真库双向，且要连 payload 一起看——upsert 被挡住时整条
    // DO UPDATE 都不执行，否则"复活失败"仍会污染展示位（与漏斗同一口径）。
    const doneId = `put-absorb-${randomUUID()}`;
    await repo.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-review", projectId, temporalWorkflowId: doneId, status: "completed", payload: { outcome: "first" } });
    const resurrected = await repo.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-review", projectId, temporalWorkflowId: doneId, status: "running", payload: { outcome: "resurrect" } });
    expect(resurrected.status).toBe("completed");
    const row = await repo.pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM workflow_runs WHERE temporal_workflow_id=$1", [doneId]);
    expect(row.rows[0].payload.outcome).toBe("first");
    const refused = await repo.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_events WHERE aggregate_type='workflow-run' AND aggregate_id=$1 AND event_type='workflow.transition-refused'",
      [doneId],
    );
    expect(refused.rowCount).toBe(1);
    expect(refused.rows[0].payload).toMatchObject({ from: "completed", to: "running", rule: "terminal-absorbing-except-redrive" });
    const restated = await repo.putWorkflowRun({ id: `run-${randomUUID()}`, workflowType: "chapter-review", projectId, temporalWorkflowId: doneId, status: "failed", payload: { outcome: "restated" } });
    expect(restated.status).toBe("failed");
    expect(restated.payload.outcome).toBe("restated");
  });
});
