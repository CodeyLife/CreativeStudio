-- Novel V2 文风契约（书级、可版本的叙述声音约束）。
--
-- 设计依据：参考手册 §7.1 把文风记录为一组可解释滑杆。契约按版本保存，
-- 每项目同一时刻至多一个 active 版本；作者创建草稿并激活后，draft/review/revision
-- 通过记忆注入读取当前 active 契约作为叙述声音的对照参考。
-- 滑杆是参考基线，不是逐章质量门；payload 中的缺失维度按未指定处理，不阻断。

CREATE TABLE IF NOT EXISTS style_contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  source_artifact_id TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_style_contracts_project ON style_contracts(project_id, version);
CREATE INDEX IF NOT EXISTS idx_style_contracts_active ON style_contracts(project_id) WHERE status='active';
