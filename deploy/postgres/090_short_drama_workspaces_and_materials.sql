-- 短剧创作台：公用参考素材库 + 多剧情容器。
--
-- 设计依据：升级独立短剧创作台，引入「短剧创作」容器概念——
-- 每个创作台拥有一个公用参考图片素材库（图片 + 简短描述），并支持在
-- 同一创作台内创建多个剧情（短剧脚本，short_scripts 行）；每部剧情在
-- 创建时通过交互手段手动勾选要引入的公用素材，被选中的素材以
-- ref2va <Subject N> 参考帧的形式注入该剧情的生成提示词，同时图片本身
-- 保留为后续视频生成的参考图库。
--
-- - short_drama_workspaces：创作台容器，独立于小说项目（project_id 可空=独立创作台）。
-- - short_drama_materials：公用素材（属于某创作台，可被该创作台下多部剧情复用）。
-- - short_scripts 追加 workspace_id（归属创作台）+ material_refs（该剧情选中素材快照）。
--   material_refs 存选中素材快照（含描述与 subjectTag）而非仅 ID：保证生成提示词内容
--   与幂等指纹自包含，不受素材被删/改描述影响。workspace_id/material_refs 均可空/默认
--   空，既有无创作台的独立剧情与独立创作行为保持兼容。
-- 全表 DDL 幂等（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS），可重放。

CREATE TABLE IF NOT EXISTS short_drama_workspaces (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  project_id  TEXT REFERENCES novel_projects(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS short_drama_materials (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES short_drama_workspaces(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  object_url   TEXT,
  content_hash TEXT NOT NULL,
  file_name    TEXT,
  mime_type    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 素材遍历与内容去重：同一创作台内同内容图片只保留一条（多剧情共享引用同一素材）。
CREATE INDEX IF NOT EXISTS idx_sdm_workspace ON short_drama_materials(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sdm_content ON short_drama_materials(workspace_id, content_hash);

-- short_scripts（一部创作台下的一个剧情）追加两列：workspace_id + material_refs。
ALTER TABLE short_scripts ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES short_drama_workspaces(id) ON DELETE SET NULL;
ALTER TABLE short_scripts ADD COLUMN IF NOT EXISTS material_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_short_scripts_workspace ON short_scripts(workspace_id) WHERE workspace_id IS NOT NULL;