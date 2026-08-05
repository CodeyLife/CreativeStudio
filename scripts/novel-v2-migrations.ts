import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { migrationChecksum, readMigrationManifest } from "../src/novel-v2/migrations";
import { resolveNovelRuntimeConfig } from "../src/novel-v2/runtime-config";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";

Object.assign(process.env, loadRuntimeEnv(process.cwd()));
const runtime = resolveNovelRuntimeConfig(process.env);
const command = process.argv[2] ?? "audit";

async function audit() {
  const repository = new NovelPostgresRepository(runtime.databaseUrl);
  try {
    const result = await repository.auditMigrations(runtime.migrationsDir);
    console.log(JSON.stringify({ command: "audit", runtime: { profile: runtime.profile, runtimeId: runtime.runtimeId }, result }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await repository.close();
  }
}

async function repairCompatible020() {
  const version = "020_foreshadowing_narrative_order.sql";
  const sqlPath = join(runtime.migrationsDir, version);
  const expected = migrationChecksum(readFileSync(sqlPath, "utf8"));
  const manifest = readMigrationManifest(runtime.migrationsDir);
  const legacyAlias = manifest.legacyAliases?.find((item) => item.version === "014_migrate_v1_skills.sql");
  const pool = new Pool({ connectionString: runtime.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const applied = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version=$1 FOR UPDATE", [version]);
    if (!applied.rowCount) throw new Error(`${version} 尚未有历史记录，拒绝把兼容修复当作迁移执行`);
    const marker = await client.query<{ compatible: boolean }>(`
      SELECT
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='foreshadowing' AND column_name='narrative_order') = 1
        AND (SELECT count(*) FROM pg_indexes
             WHERE schemaname=current_schema() AND indexname='idx_foreshadowing_project_order') = 1
        AS compatible
    `);
    if (marker.rows[0]?.compatible !== true) throw new Error(`${version} 结构兼容性校验失败，未修改 schema_migrations`);
    if (applied.rows[0].checksum !== expected) {
      await client.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [version, expected]);
    }
    await client.query("COMMIT");
    const legacy = await client.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version=$1", ["014_migrate_v1_skills.sql"]);
    console.log(JSON.stringify({ command: "repair-compatible", version, changed: applied.rows[0].checksum !== expected, checksum: expected, legacyAlias, legacyApplied: legacy.rowCount === 1 }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (command === "audit") await audit();
else if (command === "repair-compatible") await repairCompatible020();
else throw new Error(`用法：pnpm novel:v2:migrations [audit|repair-compatible]`);
