-- Skill projection hygiene.
-- A skill row may only serve runtime guidance when it carries provenance:
-- either it is synced from a workspace manifest (source_ref = skills/**.yaml)
-- or it was seeded by a dedicated database migration (source_ref = database:*).
-- V1-era rows persisted before the source_ref column exists are unversioned
-- legacy text; leaving them enabled lets database-mode projections resurrect
-- outdated guidance into every bundle. Disable them structurally, by
-- provenance, not by case-by-case skill id lists. Re-running is a no-op.
UPDATE skill_definitions
SET enabled = FALSE, updated_at = now()
WHERE source_ref IS NULL AND enabled = TRUE;
