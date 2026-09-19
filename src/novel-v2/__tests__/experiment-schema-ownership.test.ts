import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPERIMENT_RUNTIME_TABLES } from "../evaluation/experiment-workspace";

/**
 * 迁移文本派生的"存活 / 已被删除"表集合。
 *
 * 为什么不用手写豁免集（本条此前是 `deletedBySubtractionMigration = ["payoff_curve"]`）：
 * 093 一次删了 8 张零引用表，手写清单要么漏登记（实验 clone 清单里留着已不存在的表名，
 * 每次建实验工作区都抛"V2 runtime schema 不完整"），要么留着已死条目假装还在用。
 * 按迁移顺序派生后，"删表"这个动作本身就是唯一需要维护的事实。
 *
 * 必须先剥 SQL 注释：093 的头注释里就有"用 `CREATE TABLE x (LIKE public.x …)` 克隆"这句
 * 说明文字，不剥会把一个根本不存在的表 `x` 当成存活表（实测踩到）。
 */
function migrationTables() {
  const migrationDir = join(process.cwd(), "deploy", "postgres");
  const names = readdirSync(migrationDir).filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
  const state = new Map<string, boolean>();
  const dropped = new Set<string>();
  for (const name of names) {
    const text = stripSqlComments(readFileSync(join(migrationDir, name), "utf8"));
    for (const match of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/giu)) {
      state.set(match[1], true);
      dropped.delete(match[1]);
    }
    for (const match of text.matchAll(/DROP TABLE(?: IF EXISTS)?\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/giu)) {
      for (const table of match[1].split(",").map((item) => item.trim())) {
        state.set(table, false);
        dropped.add(table);
      }
    }
  }
  return { state, dropped };
}

function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** 整行注释与块注释行剔除后的代码本体（同仓接线锁口径：注释里的表名是说明，不是读写方）。 */
function codeOnly(text: string): string {
  return text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*|--)/.test(line)).join("\n");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
}

describe("experiment schema ownership", () => {
  it("classifies every migrated V2 table as runtime data or explicit control data", () => {
    const { state } = migrationTables();
    const controlTables = new Set(["candidate_bundles", "experiment_workspaces", "iterated_skills", "project_snapshots", "promotion_receipts", "runtime_configuration", "runtime_services"]);
    const expectedRuntime = [...new Set([...state.entries()].filter(([table, live]) => live && !controlTables.has(table)).map(([table]) => table))].sort();
    expect(expectedRuntime.length).toBeGreaterThan(40); // 派生为空时下面的相等断言会因清单也变空而假绿

    expect([...EXPERIMENT_RUNTIME_TABLES].sort()).toEqual(expectedRuntime);
  });

  it("被删表不得在代码里复活（按 SQL 用法判，不按裸名判）", () => {
    /**
     * 待查表名从迁移文本派生（"最后一次出现是 DROP"的那些），不在本文件里重述一遍——
     * 首版把名字写成常量，结果这条锁唯一抓到的 offender 就是它自己。
     *
     * 判据刻意取"SQL 动词 + 表名"而不是裸名，两向都有代价要认：
     * - 裸名会误伤正当引用——`migrations.test.ts` 里 `toContain("DROP TABLE IF EXISTS payoff_curve")`
     *   正是断言"这张表被删了"，按裸名判就成了假红；
     * - 反过来，注释里"某表仍在"的过时说法它看不见。那一类由本批文档同步处理（workflow-map
     *   的"表保留但不再写入"等句子按实形改掉），把注释也纳入判据会让任何解释"为什么它没了"
     *   的说明文字都变红。
     */
    const { dropped } = migrationTables();
    expect(dropped.size).toBeGreaterThan(0);
    const root = process.cwd().replace(/\\/g, "/");
    const offenders: Array<{ table: string; file: string }> = [];
    for (const file of walkFiles(join(process.cwd(), "src")).concat(walkFiles(join(process.cwd(), "scripts")))) {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(file)) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      const relative = file.replace(/\\/g, "/").replace(`${root}/`, "");
      for (const table of dropped) {
        if (new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|SELECT[\\s\\S]{0,200}?FROM|JOIN|CREATE\\s+TABLE)\\s+(?:public\\.)?${table}\\b`, "i").test(code)) offenders.push({ table, file: relative });
      }
    }
    expect(offenders).toEqual([]);
  });
});
