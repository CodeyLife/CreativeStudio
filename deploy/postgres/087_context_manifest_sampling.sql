-- OR-D3（product-audit-20260910 E5 剩余子项）：上下文采样关联 + 估算/上报可比对性。
-- 症状：context_manifests 仅 25 份对 1523 次调用——上下文膨胀在遥测面不可见；
-- model_invocations.estimated_input_tokens 曾长期 NULL（估算与 provider 上报
-- 无法逐行比对，"差最高 76 倍"只能人工抓样本）。
-- 机制：prompt_executions 加可空 context_manifest_id 引用列——按 purpose 稳定
-- 采样（sha256(purpose:prompt_fingerprint) 命中比率）时把该次调用的上下文清单
-- 物化进 context_manifests 并回填此列；未采样行保持 NULL（manifest 全量 JSONB 仍留在
-- context_manifest 列，只欠可 JOIN 的规范化关联）。估算列由 gateway 在 record
-- 时一并上报（见 model-gateway 的 estimatedInputTokens），报表按
-- provider_input_tokens / NULLIF(estimated_input_tokens,0) 聚合。
-- 泛化：采样比率 env 可配（默认 5%），无 skill/purpose 专属分支；列可空不影响
-- 存量行，旧数据不回填（回填=伪造采样面）。
ALTER TABLE prompt_executions ADD COLUMN IF NOT EXISTS context_manifest_id TEXT;
CREATE INDEX IF NOT EXISTS prompt_executions_context_manifest_id_idx
  ON prompt_executions(context_manifest_id) WHERE context_manifest_id IS NOT NULL;
