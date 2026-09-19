/**
 * Skill projection hygiene: the runtime may only serve guidance rows that carry
 * provenance. A row is sourced when it was synced from a workspace manifest
 * (`source_ref` points at a skills/**.yaml file) or seeded deliberately by a
 * database migration (`source_ref` starts with `database:`). Rows without any
 * source_ref are V1-era or ad-hoc leftovers; if left enabled they resurrect
 * outdated or test guidance into every resolved bundle in database mode.
 *
 * Migration 082 enforces this for stored rows; the `check` command enforces it
 * continuously so new leftovers can never sit enabled unnoticed.
 */

export interface SkillHygieneRow {
  skillId: string;
  sourceRef?: string | null;
  enabled?: boolean;
}

export function hasSkillProvenance(sourceRef: string | null | undefined): boolean {
  return typeof sourceRef === "string" && sourceRef.trim().length > 0;
}

export interface SkillHygieneFindings {
  /** Enabled rows without any provenance (V1-era or ad-hoc leftovers). */
  unsourced: string[];
  /** Enabled rows that belong to neither the workspace manifest nor a database seed. */
  orphaned: string[];
}

export function findUnsourcedEnabledSkills(rows: readonly SkillHygieneRow[]): string[] {
  return rows.filter((row) => row.enabled !== false && !hasSkillProvenance(row.sourceRef)).map((row) => row.skillId).sort();
}

export function findOrphanedEnabledSkills(workspaceSkillIds: Iterable<string>, rows: readonly SkillHygieneRow[]): string[] {
  const known = new Set(workspaceSkillIds);
  return rows
    .filter((row) => row.enabled !== false && !known.has(row.skillId) && !String(row.sourceRef ?? "").startsWith("database:"))
    .map((row) => row.skillId)
    .sort();
}

export function inspectSkillProjection(workspaceSkillIds: Iterable<string>, enabledRows: readonly SkillHygieneRow[]): SkillHygieneFindings {
  return {
    unsourced: findUnsourcedEnabledSkills(enabledRows),
    orphaned: findOrphanedEnabledSkills(workspaceSkillIds, enabledRows),
  };
}

export function formatSkillHygieneFindings(findings: SkillHygieneFindings): string[] {
  const lines: string[] = [];
  if (findings.unsourced.length) lines.push(`SKILL_UNSOURCED(${findings.unsourced.length}): ${findings.unsourced.join(", ")}`);
  if (findings.orphaned.length) lines.push(`SKILL_ORPHANED(${findings.orphaned.length}): ${findings.orphaned.join(", ")}`);
  return lines;
}

/**
 * Seed↔DB projection drift — the observation face of SK-2's single source of truth.
 *
 * Root cause this function exists to close (2026-09-19, live-DB evidence): the
 * `check` command used to call `migrate()` before comparing, and `migrate()` ends
 * with `seedWorkspaceSkills`, which writes the workspace seed into the database.
 * Comparing *after* writing makes seed-ahead drift structurally invisible — the
 * command prints `ok` because it just erased the difference it was supposed to
 * report — and a tool named "check" mutates the shared runtime database as a side
 * effect. Extracting the predicate into a pure function is what lets both the
 * direction rules and the "observation commands never migrate" lock be tested.
 *
 * Direction rules mirror `sync`'s guard: a database version ahead of the seed is
 * the learning loop's promotion winning (expected state, `promotionAhead`), not
 * drift; anything else that differs (missing row, seed ahead, same version with
 * different content) is drift and only an explicit `sync` may write it.
 */
export interface SkillProjectionRow {
  skillId: string;
  version: string;
  /** 旧库行可缺指纹；缺位与 seed 的指纹不等 ⇒ 判漂移（内容状态本就不一致）。 */
  contentFingerprint?: string | null;
}

export type SkillDriftReason = "missing-in-database" | "content-or-version-drift";

export interface SkillProjectionDrift {
  drift: Array<{ skillId: string; reason: SkillDriftReason; workspace: SkillProjectionRow; database?: SkillProjectionRow }>;
  promotionAhead: Array<{ skillId: string; workspace: string; database: string }>;
}

export function compareSkillProjections(
  workspace: readonly SkillProjectionRow[],
  database: readonly SkillProjectionRow[],
  compareVersions: (left: string, right: string) => number,
): SkillProjectionDrift {
  const byId = new Map(database.map((row) => [row.skillId, row]));
  const drift: SkillProjectionDrift["drift"] = [];
  const promotionAhead: SkillProjectionDrift["promotionAhead"] = [];
  for (const skill of workspace) {
    const current = byId.get(skill.skillId);
    if (!current) {
      drift.push({ skillId: skill.skillId, reason: "missing-in-database", workspace: skill });
      continue;
    }
    const databaseRow = { skillId: current.skillId, version: current.version, contentFingerprint: current.contentFingerprint };
    if (compareVersions(current.version, skill.version) > 0) {
      promotionAhead.push({ skillId: skill.skillId, workspace: skill.version, database: current.version });
      continue;
    }
    if (current.contentFingerprint !== skill.contentFingerprint || current.version !== skill.version) {
      drift.push({ skillId: skill.skillId, reason: "content-or-version-drift", workspace: skill, database: databaseRow });
    }
  }
  return { drift, promotionAhead };
}
