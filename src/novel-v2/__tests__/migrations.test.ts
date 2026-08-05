import { describe, expect, it } from "vitest";
import { auditMigrations, migrationChecksum } from "../migrations";

const files = [
  { version: "001_initial.sql", checksum: migrationChecksum("CREATE TABLE initial;\n") },
  { version: "002_followup.sql", checksum: migrationChecksum("ALTER TABLE initial ADD COLUMN value text;\n") },
];

describe("migration audit", () => {
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

  it("reports missing files without inventing an applied record", () => {
    const result = auditMigrations(files, [{ version: "001_initial.sql", checksum: files[0].checksum }]);
    expect(result.ok).toBe(true);
    expect(result.missingInDatabase).toEqual(["002_followup.sql"]);
    expect(result.applied.map((migration) => migration.version)).toEqual(["001_initial.sql"]);
  });
});
