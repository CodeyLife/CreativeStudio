import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 负向锁咬合力注册表（2026-10-14 复核轮 round 23）。
 *
 * 由来：round 22 发现一个只写 `\w+\.revisionId` 的负向锁对 `[f.plantedRevisionId]`
 * **漏网**——测试全绿、看着有保护，实际从不判红。锁的失效形态不是"写错"，
 * 而是"**看起来覆盖了、实际有条形洞**"。
 *
 * 更广的一类：一个锁禁止的形态若在**生产源码里根本不存在**，那么
 * "改回去看是否判红"这条常用验证路**走不通**（没有可改回去的东西），它的咬合
 * 只能靠**注入**证明。round 23 全仓扫出 7 个这样的锁，逐个注入验证**全部会咬人**。
 *
 * 本文件把那次审计固化成注册表。**两条独立的不变量**：
 *   ① 咬合：基线不命中 + 注入禁形后命中（否则是死锁/装饰）；
 *   ② 同源：`originalLiteral` 必须仍原样出现在原测试文件里。
 *      没有②会怎样：本次反向复跑实测——把 evaluation 那条锁的正则改窄后，
 *      注册表用自己抄的正确副本**照样全绿**，抓不住最该抓的那种退化。
 *      故②把"原锁被改"变成显式判红，逼作者显式复核注册表。
 */
const repo = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/** 与被测锁完全一致的取段口径（复制自原测试，两处必须同步改）。 */
const workflowsSource = () => repo("src/novel-v2/temporal/workflows.ts");
const ddlOnly = (sql: string) => sql.split("\n").filter((line) => !/^\s*--/u.test(line)).join("\n");
const methodBody = (source: string, startMarker: string, endMarker: string) =>
  source.slice(source.indexOf(startMarker), source.indexOf(endMarker, source.indexOf(startMarker)))
    .split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line)).join("\n");

interface RegistryEntry {
  名称: string;
  /** 该锁原本所在的测试文件（用于同源自检）。 */
  来源: string;
  /** 原测试里那条正则的**字面量文本**（同源自检用，须与原文件逐字一致）。 */
  originalLiteral: string;
  基线: () => string;
  注入: (base: string) => string;
  正则: RegExp;
}

const REGISTRY: RegistryEntry[] = [
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

describe("负向锁咬合力注册表（禁形不在生产源码中、必须注入验证的锁）", () => {
  it("注册表非空（空表会让整条守卫空转）", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
  });

  it("同源：原测试里的正则字面量未被改动（改了就必须显式复核注册表）", () => {
    for (const entry of REGISTRY) {
      const source = repo(entry.来源);
      expect(source.includes(entry.originalLiteral), `${entry.名称}：原测试 ${entry.来源} 里已找不到 ${entry.originalLiteral} —— 原锁正则已被改动，请复核注册表是否仍准确`).toBe(true);
    }
  });

  for (const entry of REGISTRY) {
    it(`锁仍咬人：${entry.名称}`, () => {
      const base = entry.基线();
      expect(entry.正则.test(base), `${entry.名称}：基线已命中禁形，说明被断言的源码已含缺陷形态`).toBe(false);
      expect(entry.正则.test(entry.注入(base)), `${entry.名称}：注入禁形后仍未命中，锁不咬人（正则被改坏或取段口径漂移）`).toBe(true);
    });
  }
});
