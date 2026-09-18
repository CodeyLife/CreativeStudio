-- OR-D2（product-audit-20260910 E5）：嵌入幂等短路的内容寻址缓存。
-- 症状：1877 次 memory.embed 里 337 次内容全等重复嵌入——重复嵌入同一文本
-- 既不省钱也烧 provider 墙钟，reindex/重提交路径尤其明显。
-- 机制：prompt_fingerprint = sha256(model + text)（model 参与哈希保证跨
-- provider/模型隔离，向量永不串用）；gateway 在发起 provider 调用前查此表，
-- 命中即短路，miss 才调用并回填。缓存无项目归属：向量按内容全局复用。
CREATE TABLE IF NOT EXISTS embedding_cache (
  prompt_fingerprint TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  vector JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embedding_cache_model_idx ON embedding_cache(model);
