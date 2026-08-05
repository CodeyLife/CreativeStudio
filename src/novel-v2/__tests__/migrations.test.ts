import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { auditMigrations, migrationChecksum } from "../migrations";

const subtractionMigration = readFileSync(new URL("../../../deploy/postgres/041_workflow_subtraction.sql", import.meta.url), "utf8");

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
