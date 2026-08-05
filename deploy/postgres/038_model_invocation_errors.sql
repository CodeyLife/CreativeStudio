ALTER TABLE model_invocations
  ADD COLUMN IF NOT EXISTS provider_label TEXT;

ALTER TABLE model_invocations
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_model_invocations_failed_created
  ON model_invocations(created_at DESC)
  WHERE status='failed';

UPDATE model_invocations
SET error_message = error_category || '（历史记录未保存 provider 返回正文）'
WHERE status='failed'
  AND error_message IS NULL
  AND error_category IS NOT NULL;

UPDATE model_invocations invocation
SET provider_label = provider.label
FROM provider_configs provider
WHERE invocation.profile_id = provider.id
  AND invocation.provider_label IS NULL;
