import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { afterAll, beforeAll } from "vitest";
import { NovelPostgresRepository, V1_MIGRATED_SKILL_IDS, hasCompatibleV1SkillSet } from "../postgres-repository";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("017 migrated Skill compatibility marker", () => {
  it("requires every canonical V1 Skill ID instead of trusting total row count", () => {
    const missing = V1_MIGRATED_SKILL_IDS[0];
    const customRows = Array.from({ length: 4 }, (_, index) => `custom-skill-${index}`);
    const rowsWithSameTotal = [...V1_MIGRATED_SKILL_IDS.slice(1), ...customRows];

    expect(rowsWithSameTotal).toHaveLength(31);
    expect(hasCompatibleV1SkillSet(rowsWithSameTotal)).toBe(false);
    expect(hasCompatibleV1SkillSet([...V1_MIGRATED_SKILL_IDS, "custom-skill"])).toBe(true);
    expect(rowsWithSameTotal).not.toContain(missing);
  });
});

describe("017 migration replay", () => {
  const schemaName = `migration_skill_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const migrationsDir = join(process.cwd(), "deploy", "postgres");
  const admin = new Pool({ connectionString: TEST_DB_URL });
  const isolated = new Pool({ connectionString: TEST_DB_URL, options: `-c search_path=${schemaName},pg_catalog` });
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  const promotedSkillId = V1_MIGRATED_SKILL_IDS[1];

  beforeAll(async () => {
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`);
      const legacyMigrations = readdirSync(migrationsDir)
        .filter((file) => /^\d{3}_.+\.sql$/u.test(file) && file < "017_migrate_v1_skills.sql")
        .sort();
      await isolated.query("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      for (const file of legacyMigrations) {
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        await isolated.query(sql);
        const checksum = createHash("sha256").update(sql.replace(/\r\n?/gu, "\n")).digest("hex");
        await isolated.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [file, checksum]);
      }

      const missingId = V1_MIGRATED_SKILL_IDS[0];
      const existingIds = V1_MIGRATED_SKILL_IDS.filter((skillId) => skillId !== missingId);
      for (const skillId of existingIds) {
        await isolated.query("INSERT INTO skill_definitions(skill_id,version,prompt_sections) VALUES($1,'1.0.0','{}'::jsonb)", [skillId]);
      }
      await isolated.query(
        "UPDATE skill_definitions SET version='9.9.9',prompt_sections=$2::jsonb,enabled=false WHERE skill_id=$1",
        [promotedSkillId, JSON.stringify({ "chapter.review": "已晋升的审核规则" })],
      );
      await isolated.query("INSERT INTO skill_definitions(skill_id,version,prompt_sections) VALUES($1,'1.0.0','{}'::jsonb)", [`custom-skill-${randomUUID()}`]);
      const before = await isolated.query<{ count: string }>("SELECT count(*)::text AS count FROM skill_definitions");
      expect(before.rows[0].count).toBe("31");
      await isolated.query("INSERT INTO schema_migrations(version,checksum) VALUES('017_migrate_v1_skills.sql','legacy-checksum')");

      repository = new NovelPostgresRepository(TEST_DB_URL).forSchema(schemaName);
      await repository.migrate();
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[migration-compatibility.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    await repository?.close().catch(() => undefined);
    await isolated.end().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it("replays 017 when a canonical Skill is missing despite 31 total rows", async () => {
    if (!available) return;
    const result = await isolated.query<{ skill_id: string }>(
      "SELECT skill_id FROM skill_definitions WHERE skill_id=ANY($1::text[])",
      [V1_MIGRATED_SKILL_IDS],
    );
    expect(result.rows).toHaveLength(V1_MIGRATED_SKILL_IDS.length);
    expect(result.rows.map((row) => row.skill_id)).toContain(V1_MIGRATED_SKILL_IDS[0]);
  });

  it("preserves an existing promoted Skill while restoring the missing seed", async () => {
    if (!available) return;
    const result = await isolated.query<{ version: string; prompt_sections: Record<string, string>; enabled: boolean }>(
      "SELECT version,prompt_sections,enabled FROM skill_definitions WHERE skill_id=$1",
      [promotedSkillId],
    );
    expect(result.rows[0]).toEqual({
      version: "9.9.9",
      prompt_sections: { "chapter.review": "已晋升的审核规则" },
      enabled: false,
    });
  });
});
