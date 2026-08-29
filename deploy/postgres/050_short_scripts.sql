-- 创意短剧脚本独立存储：脱离 artifacts 的 novel_projects 外键依赖。
-- 设计依据：剧本创作是完全独立于小说创作的板块——创意短剧不依赖任何小说
-- 项目（无定稿正文、不走工作流），强制挂在 artifacts(project_id NOT NULL)
-- 下导致无小说项目的用户无法创作。本表 project_id 可空：独立短剧为 NULL，
-- 关联某小说作品（衍生短剧）时保留原值。artifacts 中 kind='short-script'
-- 的历史行保留作审计，不删除不重写（迁移只复制）。

CREATE TABLE IF NOT EXISTS short_scripts (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES novel_projects(id) ON DELETE SET NULL,
  idea TEXT NOT NULL,
  instruction TEXT,
  target_duration_seconds INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  object_key TEXT,
  content_hash TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_short_scripts_fingerprint ON short_scripts(source_fingerprint);
CREATE INDEX IF NOT EXISTS idx_short_scripts_project ON short_scripts(project_id) WHERE project_id IS NOT NULL;

-- 既有 artifacts 短剧产物一次性带入新表（幂等，可重放）：
-- id 沿用原 artifact id（跨表可追溯），project_id 保留为关联作品，
-- payload 沿用 artifacts.payload（structuredData 结构一致，读取层零转换）。
-- DISTINCT ON 取每个 fingerprint 最新一条：新表 source_fingerprint 唯一，
-- artifacts 历史中同指纹多行（早期无幂等约束时重复生成）只保留最新。
-- 兜底值出处：30 = DEFAULT_SHORT_SCRIPT_TARGET_SECONDS（应用层缺省目标时长）；
-- '1' = 迁移前产物均为契约 v1（SHORT_SCRIPT_CONTRACT_VERSION 起始版本，
-- v1 产物指纹不含契约维度，v2 起新输入按 v2 指纹天然不冲突）。
-- TODO P2：兜底值与应用层常量非联动，应用层调整缺省值时须同步本迁移。
INSERT INTO short_scripts (id, project_id, idea, instruction, target_duration_seconds, source_fingerprint, contract_version, object_key, content_hash, workflow_id, payload, created_at)
SELECT DISTINCT ON (a.payload->>'sourceFingerprint')
  a.id,
  a.project_id,
  COALESCE(a.payload->>'idea', ''),
  NULLIF(a.payload->>'instruction', ''),
  COALESCE((a.payload->>'targetDurationSeconds')::INTEGER, 30),
  COALESCE(a.payload->>'sourceFingerprint', ''),
  COALESCE(a.payload->>'contractVersion', '1'),
  a.object_key,
  a.content_hash,
  COALESCE(NULLIF(a.task_id, ''), a.id),
  a.payload,
  a.created_at
FROM artifacts a
WHERE a.kind = 'short-script'
ORDER BY a.payload->>'sourceFingerprint', a.created_at DESC
ON CONFLICT (id) DO NOTHING;
