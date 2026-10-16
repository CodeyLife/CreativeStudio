import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
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
  OPEN_WORKFLOW_RUN_STATUSES,
  OPEN_WORKFLOW_RUN_STATUSES_SQL,
  SUCCEEDED_WORKFLOW_RUN_STATUSES,
  SUCCEEDED_WORKFLOW_RUN_STATUSES_SQL,
  ABANDONED_WORKFLOW_RUN_STATUSES,
  WORKFLOW_RUN_STATUSES,
  FAILED_WORKFLOW_RUN_STATUSES,
  isAbandonedWorkflowRunStatus,
  isFailedWorkflowRunStatus,
  isForbiddenTerminalOverwrite,
  isHumanGateWorkflowRunStatus,
  isOpenWorkflowRunStatus,
  isSucceededWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  isWorkflowRunStatus,
  terminalOverwriteGuardSql,
  type WorkflowRunStatus,
} from "../run-lifecycle";
import { isTerminalWorkflowStatus, withTerminalOutcome } from "../terminal-outcome";

/**
 * 源码锁的判据必须落在**代码**上，不是注释上：本仓的注释里大量引用被删掉的手写集
 * （例如 terminal-outcome.ts 记着"此处曾手写 `["completed","failed","cancelled"]`"），
 * 不剥注释就会把"记录历史"误判成"又写了一份"。剥离只可能让守卫更宽松，不会造出假阳性。
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

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
    expect(OPEN_WORKFLOW_RUN_STATUSES_SQL).toBe(sqlOf(OPEN_WORKFLOW_RUN_STATUSES));
    expect(WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL).toBe(`'${WAITING_EXTERNAL_WORKFLOW_RUN_STATUS}'`);
  });

  /**
   * 未结账（轮询口径）是本片新增的**第二个**分类轴，与 ACTIVE（对账口径）不同名不同义。
   *
   * 双向锁：终态侧必须全 false、非终态侧必须全 true；幽灵状态必须 false。只锁一侧时，
   * 把判据写成恒真或恒假都能骗过一条正向用例。
   */
  it("未结账态与终态严格互补，且幽灵状态一律判 false（双向）", () => {
    expect([...OPEN_WORKFLOW_RUN_STATUSES].sort()).toEqual(
      WORKFLOW_RUN_STATUSES.filter((status) => !isTerminalWorkflowRunStatus(status)).sort(),
    );
    expect(OPEN_WORKFLOW_RUN_STATUSES.length + TERMINAL_WORKFLOW_RUN_STATUSES.length).toBe(WORKFLOW_RUN_STATUSES.length);

    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(isOpenWorkflowRunStatus(status), `${status} 的未结账判定`).toBe(!isTerminalWorkflowRunStatus(status));
    }

    // 等待外部与三个人工门态必须落在未结账一侧——这正是本片修掉的漂移：
    // 它们此前在 8 处手写判据里被判为「已结束」，于是轮询停摆、总览不显示、去重会再起重复 run。
    for (const status of [...HUMAN_GATE_WORKFLOW_RUN_STATUSES, WAITING_EXTERNAL_WORKFLOW_RUN_STATUS]) {
      expect(isOpenWorkflowRunStatus(status), `${status} 应继续轮询`).toBe(true);
    }

    // 幽灵状态：这些字符串在消费方历史代码里被当作 run 状态用过，但不在词表内。
    for (const phantom of ["pending", "paused", "received", "succeeded", "terminated", "blocked"]) {
      expect(isOpenWorkflowRunStatus(phantom), `${phantom} 不是 run 状态`).toBe(false);
    }
    expect(isOpenWorkflowRunStatus(undefined)).toBe(false);
    expect(isOpenWorkflowRunStatus("")).toBe(false);
  });

  /**
   * 消费方不得再手写「未结账」成员集——本文件 :7-11 记的根因（每处重述一遍就必然
   * 漏掉一处）在 8 处判据里各发生过一次。
   *
   * 签名不能只认含 `waiting-external` 的那一种：首版判据是"`accepted` 与
   * `waiting-external` 在 80 字符内相邻"，它只抓得住**曾经写对过**的近似集，抓不住
   * **漏掉 `waiting-external`** 的那一种——而那正是本片要修的缺陷形态。2026-10-16
   * 复核轮实测：`NovelPipelineBoard.tsx` 手写 `{running, manual-review-required,
   * pending, accepted}`、`mcp/handlers.ts` 手写 `{accepted, running,
   * manual-review-required}`，两道守卫都看不见。
   *
   * 泛化签名（不认任何具体状态名，只认**形状 + 词表归属**）：字面量集合（比较链或
   * 数组成员判断）里 ≥2 个成员是 run 状态，且**全部为非终态**——"全是非终态"就是
   * "这份集合在回答『它还开着吗』"，那正是 `OPEN_WORKFLOW_RUN_STATUSES` 的语义，
   * 不该有第二份。非词表成员（如 `pending`）不计入判据，故漏写/误写成员不会让判据失效。
   *
   * 边界（为什么不把所有状态字面量集合都判红）：本仓另有共用同名成员的状态词表——
   * `CreativeRunStatus`（completed/failed/cancelled）、故事弧 `executionStatus`
   * （completed/abandoned）、项目卡片 `ProjectState`（failed/running）。它们的集合
   * 必然含**终态**成员，故不命中本签名；实测这三类共 4 处集合零误报。
   *
   * `__tests__` 排除在外：测试里写死成员是正当夹具（例如 terminal-outcome.test.ts
   * 故意把幽灵状态 pending 混进非终态清单，用来证明判据是真分类而非字符串透传）。
   */
  it("单一真源之外零手写未结账集，且旧标识符不得复活", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });
    const files = walk(join(process.cwd(), "src"))
      .filter((file) => !file.endsWith("run-lifecycle.ts") && !file.includes("__tests__"));
    const rel = (file: string) => relative(process.cwd(), file).replace(/\\/g, "/");

    const openMembers = new Set<string>(OPEN_WORKFLOW_RUN_STATUSES);
    /** 抽出源码里的状态字面量集合：比较链与数组成员判断两种形状。 */
    const literalSets = (text: string): string[][] => {
      const sets: string[][] = [];
      // 比较链：`status === "x" || … status === "y"`。刻意用 `\bstatus` 而非 `\.status`——
      // 只认属性访问形态会漏掉裸变量（`status === "running" || status === "accepted"`），
      // 实测该形态注入后守卫不响（2026-10-16 探针）。`\b` 同样匹配 `run?.status`。
      const comparison = /\bstatus\s*(?:===|==|!==|!=)\s*["']([a-z][a-z-]*)["'][\s\S]{0,160}?\|\|[\s\S]{0,160}?\bstatus\s*(?:===|==|!==|!=)\s*["']([a-z][a-z-]*)["']/gu;
      for (const match of text.matchAll(comparison)) sets.push([match[1], match[2]]);
      const membership = /\[([^\]]{0,240})\]\s*\.\s*(?:includes|has|some)\s*\(/gu;
      for (const match of text.matchAll(membership)) {
        sets.push([...match[1].matchAll(/["']([a-z][a-z-]*)["']/gu)].map((item) => item[1]));
      }
      return sets;
    };

    const handWritten = files.filter((file) => {
      const text = stripComments(readFileSync(file, "utf8"));
      // 形状一：曾经的近似集（含 waiting-external 的相邻写法），任意容器形态都抓。
      if (/["']accepted["'][\s\S]{0,80}?["']waiting-external["']/.test(text)
        || /["']waiting-external["'][\s\S]{0,80}?["']accepted["']/.test(text)) return true;
      // 形状二：全部成员都是非终态 run 状态的集合。
      return literalSets(text).some((members) => {
        const inVocab = members.filter((member) => isWorkflowRunStatus(member));
        return inVocab.length >= 2 && inVocab.every((member) => openMembers.has(member));
      });
    });
    expect(handWritten.map(rel), "这些文件又手写了一份未结账集").toEqual([]);

    const revived = files.filter((file) => /\b(isActiveStatus|ACTIVE_STATUSES|RUN_ACTIVE_STATUSES)\b/.test(readFileSync(file, "utf8")));
    expect(revived.map(rel), "旧的活跃态标识符复活了").toEqual([]);
  });

  /**
   * 失败轴（终态的子集）与它的源码锁。
   *
   * 成员判据刻意**不等价于终态**：`completed` 是成功，`abandoned` 是作者主动放弃。
   * 双向锁要求两侧都断言——只锁正向时，把成员集扩成"全部终态"仍会通过正向用例，
   * 而那样会把成功的 run 报成"运行异常"。
   */
  it("失败态是终态的真子集，且作者放弃与成功都不算失败（双向）", () => {
    for (const status of FAILED_WORKFLOW_RUN_STATUSES) {
      expect(isFailedWorkflowRunStatus(status), `${status} 应判失败`).toBe(true);
      expect(isTerminalWorkflowRunStatus(status), `${status} 应是终态`).toBe(true);
    }
    expect(FAILED_WORKFLOW_RUN_STATUSES.length).toBeLessThan(TERMINAL_WORKFLOW_RUN_STATUSES.length);

    // 反向：成功与作者主动放弃都不是"异常"。
    for (const notFailed of ["completed", "abandoned"]) {
      expect(isFailedWorkflowRunStatus(notFailed), `${notFailed} 不是失败`).toBe(false);
    }
    // 未结账侧一律不是失败。
    for (const status of OPEN_WORKFLOW_RUN_STATUSES) {
      expect(isFailedWorkflowRunStatus(status), `${status} 还没结账，不是失败`).toBe(false);
    }
    // 幽灵状态：它们不是 run 状态，且分别属于审校裁决（blocked）与 craft-rule 候选（rolled-back/promoted）。
    for (const phantom of ["terminated", "blocked", "succeeded", "rolled-back", "promoted", "passed", "pending", "paused", "received"]) {
      expect(isFailedWorkflowRunStatus(phantom), `${phantom} 不是 run 状态`).toBe(false);
    }
    expect(isFailedWorkflowRunStatus(undefined)).toBe(false);
    expect(isFailedWorkflowRunStatus("")).toBe(false);
  });

  it("单一真源之外零手写失败集与幽灵 terminated（源码签名锁）", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });
    const files = walk(join(process.cwd(), "src"))
      .filter((file) => !file.endsWith("run-lifecycle.ts") && !file.includes("__tests__"));
    const rel = (file: string) => relative(process.cwd(), file).replace(/\\/g, "/");

    const handWritten = files.filter((file) => {
      const text = stripComments(readFileSync(file, "utf8"));
      // 手写失败集的签名：逗号相邻的 failed+rejected / failed+cancelled，或正则形态的 failed|rejected。
      return /["']failed["']\s*,\s*["'](rejected|cancelled)["']/.test(text)
        || /["'](rejected|cancelled)["']\s*,\s*["']failed["']/.test(text)
        || /failed\s*\|\s*rejected/.test(text);
    });
    expect(handWritten.map(rel), "这些文件又手写了一份失败集").toEqual([]);

    // `terminated` 不是任何实体的状态（全仓无生产者），被引号包裹即说明有人又把它当 run 状态。
    const terminated = files.filter((file) => /["']terminated["']/.test(stripComments(readFileSync(file, "utf8"))));
    expect(terminated.map(rel), "幽灵状态 terminated 被当作状态字面量使用了").toEqual([]);

    const revived = files.filter((file) => /\b(FAILED_STATUSES|RUN_FAILURE_STATUSES)\b/.test(readFileSync(file, "utf8")));
    expect(revived.map(rel), "旧的失败态标识符复活了").toEqual([]);
  });

  /**
   * 成功终态轴。词表里只有一个成员，但"只有一个"本身要被锁住：把 `abandoned`
   * （作者主动放弃）混进来，就会把放弃的 run 渲染成"全部阶段已完成 + 成功横幅"。
   */
  it("成功终态恰为 completed，且与失败/未结账/人工门三轴互斥（双向）", () => {
    expect([...SUCCEEDED_WORKFLOW_RUN_STATUSES]).toEqual(["completed"]);
    expect(SUCCEEDED_WORKFLOW_RUN_STATUSES_SQL).toBe(`'completed'`);

    expect(isSucceededWorkflowRunStatus("completed")).toBe(true);
    for (const status of WORKFLOW_RUN_STATUSES.filter((item) => item !== "completed")) {
      expect(isSucceededWorkflowRunStatus(status), `${status} 不是成功终态`).toBe(false);
    }
    for (const phantom of ["succeeded", "terminated", "blocked", "passed", "promoted", "rolled-back", "pending", "paused", "received"]) {
      expect(isSucceededWorkflowRunStatus(phantom), `${phantom} 不是 run 状态`).toBe(false);
    }
    expect(isSucceededWorkflowRunStatus(undefined)).toBe(false);
    expect(isSucceededWorkflowRunStatus("")).toBe(false);

    /**
     * 四轴穷尽且互斥：每个词表成员恰好落进「成功终态 / 失败态 / 作者放弃 / 未结账」之一，
     * 人工门是未结账的子集故单列校验。这条锁两件事：① 某状态被两个轴同时认领（同一次 run
     * 既显示成功又显示异常）；② 某状态**谁都不认领**（消费方只能落进兜底分支）——
     * 本片首跑就是靠这条发现 `abandoned` 三轴皆空，于是补出第四轴。
     */
    for (const status of WORKFLOW_RUN_STATUSES) {
      const buckets = [
        isSucceededWorkflowRunStatus(status),
        isFailedWorkflowRunStatus(status),
        isAbandonedWorkflowRunStatus(status),
        isOpenWorkflowRunStatus(status),
      ].filter(Boolean).length;
      expect(buckets, `${status} 应恰好归属一个轴`).toBe(1);
      if (isHumanGateWorkflowRunStatus(status)) expect(isOpenWorkflowRunStatus(status), `${status} 人工门属未结账`).toBe(true);
    }

    // 四轴并集恰好等于词表（与 :44 那条三分类穷尽性同型）。
    const flat = [
      ...SUCCEEDED_WORKFLOW_RUN_STATUSES,
      ...FAILED_WORKFLOW_RUN_STATUSES,
      ...ABANDONED_WORKFLOW_RUN_STATUSES,
      ...OPEN_WORKFLOW_RUN_STATUSES,
    ];
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual([...WORKFLOW_RUN_STATUSES].sort());
  });

  it("单一真源之外零手写成功判据（源码签名锁）", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });
    const files = walk(join(process.cwd(), "src"))
      .filter((file) => !file.endsWith("run-lifecycle.ts") && !file.includes("__tests__"));

    // 手写成功判据的签名：completed 与幽灵 succeeded 相邻成对（逗号或 | 分隔）。
    const offenders = files.filter((file) => {
      const text = stripComments(readFileSync(file, "utf8"));
      return /["']completed["']\s*[,|]\s*["']succeeded["']/.test(text)
        || /["']succeeded["']\s*[,|]\s*["']completed["']/.test(text);
    });
    expect(offenders.map((file) => relative(process.cwd(), file).replace(/\\/g, "/")), "这些文件又手写了一份成功判据").toEqual([]);
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

    /**
     * 泛化：`status IN ('…')` 里出现 ≥2 个**非终态** run 状态字面量，就是一份手写的
     * 未结账集——与 TS 侧源码签名锁同形（见上面那条用例）。
     *
     * 首版只锁 `('running','accepted')` 这一个字符串，于是 `findActiveChapterReview` /
     * `findActiveProjectChapterReview` 的 `('accepted','running','manual-review-required')`
     * 一直无人对（2026-10-16 复核轮发现）。其余状态词表（craft-rule 的
     * proposed/evidencing/reviewing、文档的 locked/stale 等）不含 ≥2 个 run 非终态成员，
     * 故不命中——实测本文件当前零误报。
     */
    const sql = repository.replace(/\/\*[\s\S]*?\*\//g, " ");
    const offenders = [...sql.matchAll(/status IN \(([^)]*)\)/gu)]
      .map((match) => [...match[1].matchAll(/'([a-z][a-z-]*)'/gu)].map((item) => item[1]))
      .filter((members) => {
        const inVocab = members.filter((member) => isWorkflowRunStatus(member));
        return inVocab.length >= 2 && inVocab.every((member) => (OPEN_WORKFLOW_RUN_STATUSES as readonly string[]).includes(member));
      });
    expect(offenders, "又手写了一份 SQL 未结账集").toEqual([]);
  });

  it("人工门族成员确实等人，对账不得收编", () => {
    const start = repository.indexOf("async reconcileStaleWorkflowRuns");
    // 锚点改名或方法被搬走时 indexOf 返回 −1，slice 只剩尾字符 ⇒ 下面的 not.toContain 会恒真。
    expect(start, "对账方法改名会让本条锁空转").toBeGreaterThan(-1);
    const reconcile = repository.slice(start, start + 6000);
    expect(reconcile.length, "切片要真的覆盖到方法体").toBeGreaterThan(1000);
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
