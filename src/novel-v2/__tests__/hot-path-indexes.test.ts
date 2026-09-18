import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import { isPostgresUnavailable } from "./test-db";
import { ACTIVE_WORKFLOW_RUN_STATUSES } from "../run-lifecycle";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
const MIGRATION = readFileSync(new URL("../../../deploy/postgres/092_hot_path_indexes.sql", import.meta.url), "utf8");

/** 092 的目标索引：每条对应运行库上取证到的一个真实顺序扫描形状。 */
const EXPECTED = [
  "workflow_runs_project_type_created_idx",
  "workflow_runs_project_updated_at_idx",
  "workflow_runs_status_updated_at_idx",
  "artifacts_project_idx",
];

describe("热路径索引迁移（092）", () => {
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[hot-path-indexes.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.close();
  });

  it("四条索引随 migrate 落库且有效（被删或 INVALID 即红）", async () => {
    if (!available) return;
    const rows = await repository.pool.query<{ indexname: string; valid: boolean }>(
      // 必须限定 public：实验工作流为每个 experiment 建独立 schema 并跑同一批迁移，
      // 不限定命名空间会把同名索引的实验副本一起数进来。
      `SELECT c.relname AS indexname, i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid=c.oid
       JOIN pg_class t ON t.oid=i.indrelid
       JOIN pg_namespace ns ON ns.oid=c.relnamespace AND ns.nspname='public'
       WHERE t.relname IN ('workflow_runs','artifacts') AND c.relname = ANY($1::text[])`,
      [EXPECTED],
    );
    expect(rows.rows.map((row) => row.indexname).sort()).toEqual([...EXPECTED].sort());
    for (const row of rows.rows) expect(row.valid, row.indexname).toBe(true);
  });

  it("幂等：重复 migrate 不报重名也不产生第二份", async () => {
    if (!available) return;
    await repository.migrate();
    const dupes = await repository.pool.query<{ n: string }>(
      "SELECT COUNT(DISTINCT c.relname)::text AS n FROM pg_class c WHERE c.relname = ANY($1::text[])",
      [EXPECTED],
    );
    expect(dupes.rows[0].n).toBe(String(EXPECTED.length));
  });
});

/** 只看 DDL 本体：注释里解释"为什么不用某写法"不能把守卫判成违规。 */
const ddlOnly = (sql: string) => sql.split("\n").filter((line) => !/^\s*--/u.test(line)).join("\n");

describe("092 迁移文本守卫", () => {
  it("状态判据不把词表抄进 SQL（partial index 内联状态清单必然与 run-lifecycle 漂移）", () => {
    const ddl = ddlOnly(MIGRATION);
    for (const status of ACTIVE_WORKFLOW_RUN_STATUSES) expect(ddl).not.toContain(`'${status}'`);
    // 反向：确实建了 (status, updated_at) 全量复合索引，而不是退回旧的 partial 形态。
    expect(ddl).toMatch(/workflow_runs\(status, updated_at\)/u);
  });

  it("不使用事务内非法的 CONCURRENTLY（migrate() 按文件包事务）", () => {
    expect(ddlOnly(MIGRATION)).not.toMatch(/CONCURRENTLY/iu);
  });
});
