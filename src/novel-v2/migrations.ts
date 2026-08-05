import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationFile { version: string; checksum: string; }
export interface AppliedMigration { version: string; checksum: string; appliedAt?: string; }
export interface MigrationManifest { legacyAliases?: Array<{ version: string; reason: string }>; }
export interface MigrationAudit {
  files: MigrationFile[];
  applied: AppliedMigration[];
  missingInDatabase: string[];
  duplicateOrdinals: string[];
  checksumMismatches: Array<{ version: string; expected: string; actual: string }>;
  unexpectedApplied: string[];
  legacyApplied: string[];
  ok: boolean;
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n?/gu, "\n"), "utf8").digest("hex");
}

export function readMigrationFiles(migrationsDir: string): MigrationFile[] {
  // The filename is the durable identity; numeric prefixes are ordering only.
  return readdirSync(migrationsDir)
    .filter((file: string) => /^\d{3}_.+\.sql$/u.test(file))
    .sort()
    .map((version: string) => ({ version, checksum: migrationChecksum(readFileSync(join(migrationsDir, version), "utf8")) }));
}

export function readMigrationManifest(migrationsDir: string): MigrationManifest {
  try { return JSON.parse(readFileSync(join(migrationsDir, "migration-manifest.json"), "utf8")) as MigrationManifest; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function auditMigrations(files: MigrationFile[], applied: AppliedMigration[], manifest: MigrationManifest = {}): MigrationAudit {
  const fileMap = new Map(files.map((file) => [file.version, file.checksum]));
  const appliedMap = new Map(applied.map((row) => [row.version, row]));
  const legacy = new Set((manifest.legacyAliases ?? []).map((item) => item.version));
  const ordinalCounts = new Map<string, number>();
  for (const file of files) ordinalCounts.set(file.version.slice(0, 3), (ordinalCounts.get(file.version.slice(0, 3)) ?? 0) + 1);
  const duplicateOrdinals = [...ordinalCounts.entries()].filter(([, count]) => count > 1).map(([ordinal]) => ordinal);
  const missingInDatabase = files.filter((file) => !appliedMap.has(file.version)).map((file) => file.version);
  const checksumMismatches = files.flatMap((file) => {
    const row = appliedMap.get(file.version);
    return row && row.checksum !== file.checksum ? [{ version: file.version, expected: file.checksum, actual: row.checksum }] : [];
  });
  const unexpectedApplied = applied.filter((row) => !fileMap.has(row.version) && !legacy.has(row.version)).map((row) => row.version);
  const legacyApplied = applied.filter((row) => !fileMap.has(row.version) && legacy.has(row.version)).map((row) => row.version);
  return { files, applied, missingInDatabase, duplicateOrdinals, checksumMismatches, unexpectedApplied, legacyApplied, ok: checksumMismatches.length === 0 && unexpectedApplied.length === 0 };
}

export function formatMigrationAudit(audit: MigrationAudit): string[] {
  return [
    `migration files=${audit.files.length} applied=${audit.applied.length}`,
    `missing=${audit.missingInDatabase.length} duplicateOrdinals=${audit.duplicateOrdinals.length} checksumMismatches=${audit.checksumMismatches.length} unexpectedApplied=${audit.unexpectedApplied.length} legacyApplied=${audit.legacyApplied.length}`,
    ...audit.missingInDatabase.map((version) => `MISSING_IN_DATABASE ${version}`),
    ...audit.duplicateOrdinals.map((ordinal) => `DUPLICATE_ORDINAL ${ordinal}`),
    ...audit.checksumMismatches.map((item) => `CHECKSUM_MISMATCH ${item.version} expected=${item.expected.slice(0, 12)} actual=${item.actual.slice(0, 12)}`),
    ...audit.unexpectedApplied.map((version) => `UNEXPECTED_APPLIED ${version}`),
    ...audit.legacyApplied.map((version) => `LEGACY_APPLIED ${version}`),
  ];
}
