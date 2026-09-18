-- 089_runtime_observation_indexes.sql
-- 审核 N10（观测面查询索引缺口）：087 引入的可 JOIN 面与 46919 行级台账的重放面
-- 都在顺序扫描上跑：
--   ① getEstimatedVsProviderRatio 的"已物化采样行"关联按 prompt_fingerprint 过滤
--     prompt_executions（部分索引与 EXISTS 谓词同形：只覆盖采样命中行）；
--   ② repairStoryArcReferenceHygiene 每次 migrate 全扫 audit_records 找
--     action='story-arc.reference-hygiene' 重放历史——audit_records 单调增长，
--     无 action 索引时线性劣化（seed 短路与本索引共同止血）。
-- 全幂等；索引名沿用 <table>_<col>_idx 惯例。
CREATE INDEX IF NOT EXISTS prompt_executions_prompt_fingerprint_sampled_idx
  ON prompt_executions(prompt_fingerprint) WHERE context_manifest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_records_action_idx
  ON audit_records(action);
