ALTER TABLE model_invocations
  ADD COLUMN IF NOT EXISTS provider_cached_input_tokens INTEGER;
