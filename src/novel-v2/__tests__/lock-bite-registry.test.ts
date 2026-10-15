import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 锁咬合力注册表：负向锁（注入验证）+ 正向源码锁（防"守副本"）。
 *
 * 两个注册表共用一份方法论：**锁的失效形态不是"写错"，而是"看起来在守、实际守的是别的"**。
 *
 * ① 负向锁（round 23 落地）：禁形若不在生产源码中，"改回去看是否判红"这条路走不通
 *    （没有可改回去的东西），只能靠**注入**证明。round 23 扫出 7 个，逐个注入后全部咬人。
 *
 * ② 正向源码锁（round 24 落地）：断言对象是**源码文本**的正向锁，若它钉的字面量
 *    只存在于测试文件里，说明它在"守副本"——机制漂移时副本不跟着漂，锁不会响。
 *    round 24 全仓扫出 24 条，**全部与被测源码一致**（零守副本）。
 *
 * ③ 为何把正向锁也纳入注册表：它们表面上"目标漂移就会判红"（自响），
 *    但那只在"钉的是真源"时成立。一旦钉成副本，它就从"会响的锁"退化成
 *    "永真的断言"——比没有锁更坏，因为它占着一个"已验证"的位置。
 *    故对每条正向源码锁，这里复核一次"字面量在被测源码中真实存在"。
 *
 * 维护约定：新增/修改任一侧的锁时，请在对应注册表补一行（含来源文件与字面量）。
 */

const repo = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/** 与被测锁完全一致的取段口径（复制自原测试，两处必须同步改）。 */
const workflowsSource = () => repo("src/novel-v2/temporal/workflows.ts");
const ddlOnly = (sql: string) => sql.split("\n").filter((line) => !/^\s*--/u.test(line)).join("\n");
const methodBody = (source: string, startMarker: string, endMarker: string) =>
  source.slice(source.indexOf(startMarker), source.indexOf(endMarker, source.indexOf(startMarker)))
    .split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line)).join("\n");

/* ------------------------------------------------------------------ *
 * ① 负向锁注册表：禁形不在生产源码中、必须注入验证                   *
 * ------------------------------------------------------------------ */

interface NegativeEntry {
  名称: string;
  /** 该锁原本所在的测试文件（同源自检用）。 */
  来源: string;
  /** 原测试里那条正则的**字面量文本**（须与原文件逐字一致）。 */
  originalLiteral: string;
  基线: () => string;
  注入: (base: string) => string;
  正则: RegExp;
}

const NEGATIVE_REGISTRY: NegativeEntry[] = [
  {
    名称: "workflows.ts 不得有本地第二份等待实现",
    来源: "src/novel-v2/__tests__/external-fallback-budget.test.ts",
    originalLiteral: "/const externalResults = new Map/",
    基线: workflowsSource,
    注入: (base) => `${base}\nconst externalResults = new Map<string, unknown>();`,
    正则: /const externalResults = new Map/,
  },
  {
    名称: "workflows.ts 不得有本地预算计数副本",
    来源: "src/novel-v2/__tests__/external-fallback-budget.test.ts",
    originalLiteral: "/externalAdvances \\+= 1;/",
    基线: workflowsSource,
    注入: (base) => `${base}\nexternalAdvances += 1;`,
    正则: /externalAdvances \+= 1;/,
  },
  {
    名称: "092 迁移不得用事务内非法的 CONCURRENTLY",
    来源: "src/novel-v2/__tests__/hot-path-indexes.test.ts",
    originalLiteral: "/CONCURRENTLY/iu",
    基线: () => ddlOnly(repo("deploy/postgres/092_hot_path_indexes.sql")),
    注入: (base) => base.replace(/CREATE INDEX/iu, "CREATE INDEX CONCURRENTLY"),
    正则: /CONCURRENTLY/iu,
  },
  {
    名称: "章节数据清理不得读摘要面/探文档存在性",
    来源: "src/novel-v2/__tests__/lease-integrity.test.ts",
    originalLiteral: "/workflow_run_summaries|SELECT 1 FROM manuscript_documents/",
    基线: () => methodBody(repo("src/novel-v2/postgres-repository.ts"), "async cleanupExpiredChapterData", "async refreshChapterReviewSnapshot"),
    注入: (base) => `${base}\nconst rows = await pool.query("SELECT 1 FROM manuscript_documents LIMIT 1");`,
    正则: /workflow_run_summaries|SELECT 1 FROM manuscript_documents/,
  },
  {
    名称: "prompt_executions 清理刻意不删行",
    来源: "src/novel-v2/__tests__/prompt-execution-retention.test.ts",
    originalLiteral: "/DELETE FROM prompt_executions/",
    基线: () => methodBody(repo("src/novel-v2/postgres-repository.ts"), "async cleanupExpiredPromptExecutions", "async saveBookSynopsisIfCurrent"),
    注入: (base) => `${base}\nawait client.query("DELETE FROM prompt_executions WHERE expires_at < now()");`,
    正则: /DELETE FROM prompt_executions/,
  },
  {
    名称: "技能段预算封顶不得退化成逐技能标题残留",
    来源: "src/novel-v2/__tests__/evaluation.test.ts",
    originalLiteral: "/## Skill: skill-\\d+@1\\.0\\.0\\s*$/u",
    基线: () => "",
    注入: () => "## Skill: skill-0@1.0.0",
    正则: /## Skill: skill-\d+@1\.0\.0\s*$/u,
  },
  {
    名称: "plainTextLength 不得直接用 draft.text.length",
    来源: "src/novel-v2/__tests__/chapter-lifecycle.test.ts",
    originalLiteral: "/plainTextLength: draft\\.text\\.length/",
    基线: () => repo("src/novel-v2/postgres-repository.ts"),
    注入: (base) => `${base}\nconst payload = { plainTextLength: draft.text.length };`,
    正则: /plainTextLength: draft\.text\.length/,
  },
];

/* ------------------------------------------------------------------ *
 * ② 正向源码锁注册表：断言对象是源码文本，字面量必须在被测源码中真实存在 *
 * ------------------------------------------------------------------ */

interface PositiveEntry {
  名称: string;
  /** 被测源码文件。 */
  被测源: string;
  /** 该锁钉住的字面量。 */
  字面量: string;
  /** 原测试文件（同源自检用）。 */
  来源: string;
}

const POSITIVE_REGISTRY: PositiveEntry[] = [
  ...["DROP TABLE IF EXISTS payoff_curve", "DROP COLUMN IF EXISTS blueprint", "DROP COLUMN IF EXISTS blueprint_fi",
      "DROP COLUMN IF EXISTS source_artif", "needs-restart", "thread-responsibilities-required-a",
      "payload - ARRAY"].map((字面量) => ({
    名称: `041 迁移：${字面量}`,
    被测源: "deploy/postgres/041_workflow_subtraction.sql",
    字面量,
    来源: "src/novel-v2/__tests__/migrations.test.ts",
  })),
  {
    名称: "章节规划上下文读取归位到方法而非内联 SQL",
    被测源: "src/novel-v2/postgres-repository.ts",
    字面量: "this.getChapterPlanningContext(inp",
    来源: "src/novel-v2/__tests__/planning-context-connection.test.ts",
  },
  {
    名称: "稀疏线取自策略常量而非字面量",
    被测源: "src/novel-v2/prompts/story-arc.ts",
    字面量: "LENGTH_DRIFT_POLICY.sparseFloor",
    来源: "src/novel-v2/__tests__/prompts.test.ts",
  },
];

/* ------------------------------------------------------------------ *
 * ③ 测试体                                                          *
 * ------------------------------------------------------------------ */

describe("锁咬合力注册表", () => {
  it("两张表都非空（空表会让整条守卫空转）", () => {
    expect(NEGATIVE_REGISTRY.length).toBeGreaterThan(0);
    expect(POSITIVE_REGISTRY.length).toBeGreaterThan(0);
  });

  describe("负向锁（禁形不在生产源码中 ⇒ 注入验证）", () => {
    it("同源：原测试里的正则字面量未被改动", () => {
      for (const entry of NEGATIVE_REGISTRY) {
        expect(repo(entry.来源).includes(entry.originalLiteral), `${entry.名称}：原测试 ${entry.来源} 里已找不到 ${entry.originalLiteral} —— 原锁正则已被改动，请复核注册表`).toBe(true);
      }
    });

    for (const entry of NEGATIVE_REGISTRY) {
      it(`锁仍咬人：${entry.名称}`, () => {
        const base = entry.基线();
        expect(entry.正则.test(base), `${entry.名称}：基线已命中禁形，说明被断言的源码已含缺陷形态`).toBe(false);
        expect(entry.正则.test(entry.注入(base)), `${entry.名称}：注入禁形后仍未命中，锁不咬人（正则被改坏或取段口径漂移）`).toBe(true);
      });
    }
  });

  describe("正向源码锁（防守副本）", () => {
    for (const entry of POSITIVE_REGISTRY) {
      it(`钉的是真源：${entry.名称}`, () => {
        const source = repo(entry.被测源);
        // ① 字面量在被测源码中真实存在（否则就是在守测试文件里的副本）。
        expect(source.includes(entry.字面量), `${entry.名称}：被测源码 ${entry.被测源} 中已找不到 ${JSON.stringify(entry.字面量)} —— 该锁要么机制已漂移，要么原测试钉的是副本，请复核`).toBe(true);
        // ② 同源：原测试文件里也还留着这条锁（否则本注册表在守一条已被删的锁）。
        expect(repo(entry.来源).includes(entry.字面量), `${entry.名称}：原测试 ${entry.来源} 里已找不到该字面量，原锁可能已删/改，请同步注册表`).toBe(true);
      });
    }
  });

  /**
   * 反向哨兵：确认上面两条判据**真的会判红**（round 23 的教训——注册表自己抄一份
   * 就可能抓不住原锁退化）。这里用一个必然失败的构造验证断言本身有效。
   */
  it("反向哨兵：判据本身会响", () => {
    const missing = "这个字面量在任何源码里都不存在-round24-probe";
    const anywhere = ["src/novel-v2/postgres-repository.ts", "src/novel-v2/prompts/story-arc.ts"]
      .some((file) => repo(file).includes(missing));
    expect(anywhere, "探针字面量本不该存在；若它存在说明判据失效").toBe(false);
    // 再验正向：注册表里挑一条，用它的字面量去查，必须命中（证明判据不是恒假）。
    const probe = POSITIVE_REGISTRY[0]!;
    expect(repo(probe.被测源).includes(probe.字面量)).toBe(true);
  });
});
