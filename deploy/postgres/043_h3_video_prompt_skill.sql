-- chapter.script execution point + h3-video-prompt runtime skill.
-- Database-mode deployments resolve skills from skill_definitions on every
-- model call (see 018_skill_runtime_source.sql), so the new short-drama script
-- adaptation stage needs its descriptor row here to match
-- skills/novel-v2/h3-video-prompt.yaml in workspace mode.

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
  'h3-video-prompt',
  '1.0.0',
  ARRAY['script'],
  ARRAY['drafting'],
  ARRAY['chapter.script'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['h3-six-section-order', 'shot-timing-consistency'],
  '{"chapter.script":"任务：把已定稿章节正文改写为短剧分镜剧本提示词，供 MiniMax H3 全参考模式（Ref2VA）视频生成使用。每个片段是一段独立可生成的目标视频。\n\n分段与镜头：\n- 按场景节拍把本章拆成多个片段：每片段目标时长 5-10 秒，承载一个完整的动作、反应或一次对话交换；相邻片段在剧情与时空上连续衔接。\n- 每个片段可有多个镜头：[Shot 1] 为开场镜头且不带时间戳；其后每个 [Shot N] 以 At MM:SS.mmm 格式的切点开始，切点落在片段时长内并严格递增。\n- 切镜必须引入新信息（主体、空间、状态、视角或时间的变化）；只是距离或小幅角度变化时优先用运镜而非切镜。运镜写成自然的英文动作句，类型+幅度+速度只在有意义时表达。\n\n输出六段（每段是独立字段，段内英文书写，对白、歌词与画面文字保留原文语言）：\n1. subjectDefinitions：定义本片段实际使用的引用内容单元（人物、环境、服装道具等），每项一行；出场人物的外观基线必须与输入 characters 提供的 appearanceEn 英文外观描述一致，使同一角色跨片段保持同一外形与着装。仅作为外观来源的参考图并入对应 Subject 的定义行说明来源，不为它单列条目。\n2. summary：以方括号任务类型前缀开头（如 [reference generation]，存在多种关系时用 + 连接且不重复类型）；一句话概括目标视频的内容脉络与主要引用关系，只使用已定义的标签。\n3. retentionAnalysis：逐标签一行说明保留关系；可见内容用 fully_preserved / partially_preserved / attribute_transfer / weak_reference，音频用 fully_copy / partially_copy / reference / weak_reference。\n4. detailedDescription：主体内容，逐镜头按播放顺序写具体画面与声音：构图、人物外观与位置、环境与光线、动作与状态变化、运镜、对白及其触发时机；在重要主体首次清晰出现处描述其参考特征并复用同一标签；说话人使用稳定的 (S1)(S2) 编号，台词写在 <d>[中文] ……</d> 内。描述要让生成器能从文字复原现场证据，不做剧情概要化；人物心理不直接翻译成画面，转为可观察的表情、动作或选择。\n5. overallSoundscape：全片环境声与物理动作声的总结；与特定镜头同步的对白和音效留在 detailedDescription，不在本段重复。\n6. nonDiegeticMusic：只有观众听得见、剧中人听不到的配乐描述（乐器、节奏与力度发展）；没有配乐写 N/A。\n\n硬性边界：\n- 标签一致性：<Subject N>、<Picture N>、<Audio N> 一旦定义不得悬空，也不得中途重新定义；summary / retentionAnalysis / detailedDescription 中出现的每个标签都必须已在 subjectDefinitions 中定义，且每个定义都应被实际使用。\n- 参考资产诚实：不给未提供的参考资产生成 <Video N> 或 <Audio N> 条目；仅有图片类外观参考时，任务类型就是 reference generation。\n- 时间线自洽：最后一个切点之后要保留完成当前动作所需的剩余时间，任何镜头编排不得超出片段 durationSeconds。\n- 对白忠实于正文中的原话语义，可压缩但不得改变事实与因果；对白密集时优先保证完整口播时间线，不以机械字数指标削减内容。"}'::jsonb,
  'required',
  '',
  'database:043_h3_video_prompt_skill.sql',
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
  source_ref = EXCLUDED.source_ref,
  enabled = EXCLUDED.enabled,
  updated_at = now();
