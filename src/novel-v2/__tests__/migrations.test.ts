import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditMigrations, migrationChecksum } from "../migrations";
import { candidateFilePattern, findWriterMatches, parseDroppedFaces, type DroppedFace } from "../migration-face-writers";

const subtractionMigration = readFileSync(new URL("../../../deploy/postgres/041_workflow_subtraction.sql", import.meta.url), "utf8");
const MIGRATION_DIR = new URL("../../../deploy/postgres/", import.meta.url);

const files = [
  { version: "001_initial.sql", checksum: migrationChecksum("CREATE TABLE initial;\n") },
  { version: "002_followup.sql", checksum: migrationChecksum("ALTER TABLE initial ADD COLUMN value text;\n") },
];

describe("migration audit", () => {
  it("declares the schema subtraction as an append-only migration", () => {
    expect(subtractionMigration).toContain("DROP TABLE IF EXISTS payoff_curve");
    expect(subtractionMigration).toContain("DROP COLUMN IF EXISTS blueprint");
    expect(subtractionMigration).toContain("DROP COLUMN IF EXISTS blueprint_fingerprint");
    expect(subtractionMigration).toContain("DROP COLUMN IF EXISTS source_artifact_id");
    expect(subtractionMigration).toContain("needs-restart");
    expect(subtractionMigration).toContain("thread-responsibilities-required-after-schema-subtraction");
    expect(subtractionMigration).toContain("payload - ARRAY");
  });

  it("accepts a declared historical alias without treating it as an unknown migration", () => {
    const result = auditMigrations(files, [
      { version: "001_initial.sql", checksum: files[0].checksum },
      { version: "002_followup.sql", checksum: files[1].checksum },
      { version: "014_migrate_v1_skills.sql", checksum: "legacy-checksum" },
    ], { legacyAliases: [{ version: "014_migrate_v1_skills.sql", reason: "historical seed" }] });
    expect(result.ok).toBe(true);
    expect(result.duplicateOrdinals).toEqual([]);
    expect(result.legacyApplied).toEqual(["014_migrate_v1_skills.sql"]);
    expect(result.unexpectedApplied).toEqual([]);
  });

  it("rejects applied checksum drift and unknown history", () => {
    const result = auditMigrations(files, [
      { version: "001_initial.sql", checksum: "changed" },
      { version: "003_unknown.sql", checksum: "unknown" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.checksumMismatches).toEqual([{ version: "001_initial.sql", expected: files[0].checksum, actual: "changed" }]);
    expect(result.unexpectedApplied).toEqual(["003_unknown.sql"]);
    expect(result.duplicateOrdinals).toEqual([]);
  });

  it("accepts only an explicitly declared historical checksum alias", () => {
    const result = auditMigrations(files, [
      { version: "001_initial.sql", checksum: "historical-checksum" },
      { version: "002_followup.sql", checksum: files[1].checksum },
    ], {
      checksumAliases: [{ version: "001_initial.sql", checksum: "historical-checksum", reason: "approved historical source revision" }],
    });

    expect(result.ok).toBe(true);
    expect(result.checksumMismatches).toEqual([]);
  });

  it("reports missing files without inventing an applied record", () => {
    const result = auditMigrations(files, [{ version: "001_initial.sql", checksum: files[0].checksum }]);
    expect(result.ok).toBe(true);
    expect(result.missingInDatabase).toEqual(["002_followup.sql"]);
    expect(result.applied.map((migration) => migration.version)).toEqual(["001_initial.sql"]);
  });
});

function migrationText(version: string): string {
  return readFileSync(new URL(version, MIGRATION_DIR), "utf8");
}

function repoSources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...repoSources(abs));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) out.push({ file: abs, text: readFileSync(abs, "utf8") });
  }
  return out;
}

/**
 * 撤面对账判据（doctor 的 `dropped-face-writers` 检查用同一份代码）。
 * 立它的起因是一条真实缺口：撤表迁移由新代码跑，旧进程若还活着就仍在往已不存在的对象写。
 */
describe("dropped-face vs live-writer reconciliation", () => {
  it("从真实迁移派生撤面：注释里的示例 SQL 不算语句", () => {
    const zeroNineThree = parseDroppedFaces({ version: "093_drop_zero_reference_tables.sql", text: migrationText("093_drop_zero_reference_tables.sql") });
    expect(zeroNineThree.filter((face) => face.kind === "table").map((face) => face.name).sort()).toEqual([
      "character_knowledge", "memory_snapshots", "short_drama_materials", "short_drama_workspaces", "short_scripts", "skill_bindings", "skill_versions", "usage_ledger",
    ]);
    // 093 头注释里有 `CREATE TABLE x (LIKE public.x ...)` 这类示例：不剥注释就会多出一张表。
    expect(zeroNineThree.some((face) => face.name === "x")).toBe(false);

    const zeroFourOne = parseDroppedFaces({ version: "041_workflow_subtraction.sql", text: subtractionMigration });
    expect(zeroFourOne.some((face) => face.kind === "table" && face.name === "payoff_curve")).toBe(true);
    for (const column of ["blueprint", "blueprint_fingerprint", "source_artifact_id"]) {
      const face = zeroFourOne.find((item) => item.kind === "column" && item.name === column);
      expect(face, `041 撤了列 ${column}，派生不到就说明解析器读不到多子句 ALTER`).toBeTruthy();
      expect((face as Extract<DroppedFace, { kind: "column" }>).table).toBeTruthy();
    }
    expect(candidateFilePattern(zeroFourOne)).toContain("payoff_curve");
    expect(candidateFilePattern([])).toBe("");
  });

  it("写入者精判双向：SQL 短语算、注释与缺席探测不算、通用列名需宿主表共现", () => {
    /**
     * 夹具用**合成**表名列名，不借用真实的 `commit_records`/`last_workflow_id`——
     * 本仓的派生复活锁按"SQL 动词 + 已死表名"扫全仓（含测试），借真名写反例就等于
     * 让锁把自己的夹具判成复活（093 那轮"锁唯一抓到的 offender 是它自己"同一形）。
     */
    const faces: DroppedFace[] = [
      { kind: "table", name: "probe_ledger", migration: "096_probe.sql" },
      { kind: "column", name: "probe_counter_col", table: "probe_gate_state", migration: "097_probe.sql" },
      { kind: "column", name: "probe_dropped_col", table: "probe_event_ledger", migration: "094_probe.sql" },
    ];
    const offenders = findWriterMatches(faces, [{
      file: "a.ts",
      text: [
        "// 旧写法：INSERT INTO probe_ledger(...) 已随迁移撤除",
        "await client.query(\"INSERT INTO probe_ledger(id) VALUES($1)\", [id]);",
        "await pool.query(\"SELECT to_regclass('public.probe_ledger')::text\");",
        "const text = \"INSERT INTO probe_gate_state(project_id,probe_counter_col) VALUES($1,$2)\";",
        "const unrelated = { probe_dropped_col: 1, chapterBlueprintPrompt: \"x\" };",
      ].join("\n"),
    }]);
    expect(offenders.map((item) => `${item.face}@${item.at}`).sort()).toEqual(["probe_gate_state.probe_counter_col@4", "probe_ledger@2"]);

    // 反例（必须全不命中）：撤掉的表只剩"证明它没了"的守卫；被撤列名以 SELECT 别名或
    // information_schema 缺席守卫的形态出现——本检查只抓"还在写"，这两种都不算。
    expect(findWriterMatches(faces, [{
      file: "b.ts",
      text: [
        "// INSERT INTO probe_ledger 已撤",
        "expect(await pool.query(\"SELECT to_regclass('public.probe_ledger')\")).toBeNull();",
        "await pool.query(`SELECT ch.payload AS probe_dropped_col FROM manuscript_documents d JOIN probe_event_ledger p ON p.document_id=d.id`);",
        "await pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='probe_event_ledger' AND column_name='probe_dropped_col'\");",
      ].join("\n"),
    }])).toEqual([]);
  });

  it("现况自证：运行时代码里没有任何仍写 096/097 被撤对象的语句", () => {
    const faces = ["096_drop_write_only_ledgers.sql", "097_drop_memory_gate_dead_columns.sql"].flatMap((version) => parseDroppedFaces({ version, text: migrationText(version) }));
    expect(faces.length).toBeGreaterThanOrEqual(4); // 派生为空时下面的空集断言会假绿
    // 刻意不扫 __tests__：上面那条双向用例正是"含被撤对象的写 SQL 字符串"，扫进来就成了
    // 自己定罪自己（本仓复活锁踩过同一形）。测试夹具里的这类写法若真跑到库里，撤表后
    // 自然以 relation does not exist 判红，不靠本锁兜。
    const sources = repoSources(join(process.cwd(), "src")).concat(repoSources(join(process.cwd(), "scripts")))
      .filter((item) => !item.file.includes("__tests__"));
    expect(sources.length).toBeGreaterThan(100); // 过滤把扫描面清空时，下面的空集同样是假绿
    expect(findWriterMatches(faces, sources)).toEqual([]);
  });
});
