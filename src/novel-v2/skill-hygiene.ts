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
