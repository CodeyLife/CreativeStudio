-- Skill runtime source contract.
-- workspace mode reads the repository skill files directly; database mode reads
-- the current row on every model call. These columns describe routing and audit
-- metadata without introducing runtime snapshots.

ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS execution_points TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS depends_on TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS content_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS source_ref TEXT;

ALTER TABLE skill_definitions DROP CONSTRAINT IF EXISTS skill_definitions_priority_check;
ALTER TABLE skill_definitions ADD CONSTRAINT skill_definitions_priority_check CHECK (priority IN ('required', 'normal', 'optional'));

INSERT INTO skill_definitions(
  skill_id,
  version,
  capabilities,
  applicable_tasks,
  execution_points,
  roles,
  depends_on,
  quality_gates,
  prompt_sections,
  priority,
  content_fingerprint,
  source_ref,
  enabled
)
VALUES (
  'learning-loop',
  '1.0.0',
  ARRAY['learning'],
  ARRAY['review'],
  ARRAY['learning.assessment', 'skill.iteration'],
  ARRAY['learning-auditor', 'skill-iterator'],
  ARRAY[]::text[],
  ARRAY['mechanism-analysis', 'regression-validation'],
  '{"learning.assessment":"只有在能够说明底层机制、受影响的输入类别、边界和回归风险时，才提出共享规则改进；不要只重复某个章节的表面症状。", "skill.iteration":"修改 Skill 时输出完整规则文本，说明它覆盖的输入类别和不覆盖的边界；必须结合审核证据和 underlyingMechanism，而不是堆叠精确短语禁令。"}'::jsonb,
  'required',
  '6ca277bc0e4116ec394e7c069b41830d8cb85b3e049e2936215355fe07434c15',
  'database:018_skill_runtime_source.sql',
  TRUE
)
ON CONFLICT (skill_id) DO UPDATE SET
  version = EXCLUDED.version,
  capabilities = EXCLUDED.capabilities,
  applicable_tasks = EXCLUDED.applicable_tasks,
  execution_points = EXCLUDED.execution_points,
  roles = EXCLUDED.roles,
  depends_on = EXCLUDED.depends_on,
  quality_gates = EXCLUDED.quality_gates,
  prompt_sections = EXCLUDED.prompt_sections,
  priority = EXCLUDED.priority,
  content_fingerprint = EXCLUDED.content_fingerprint,
  source_ref = EXCLUDED.source_ref,
  enabled = EXCLUDED.enabled,
  updated_at = now();
