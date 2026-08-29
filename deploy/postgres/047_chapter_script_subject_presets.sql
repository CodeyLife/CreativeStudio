-- 章节短剧剧本：项目级共享 subject_definitions 预设。
-- 用户在生成前手动录入/编辑（自由文本，<Subject N> 行格式），各章节生成时
-- 直接复用已定义主体（片段 subject_definitions 只写新增主体，编号从共享
-- 最大编号 +1 起续接）；定义内容完全由用户掌控，AI 不重写不重复。

CREATE TABLE IF NOT EXISTS chapter_script_subject_presets (
  project_id TEXT PRIMARY KEY REFERENCES novel_projects(id) ON DELETE CASCADE,
  definition_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
