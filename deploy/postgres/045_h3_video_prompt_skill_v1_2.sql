-- h3-video-prompt v1.2.0: segments deliver five body sections only; the chapter-wide
-- subject_definitions block is exported separately from subjects (chapter-library),
-- so segment prompts never re-declare definitions. 043/044 stay immutable history;
-- this row upserts the runtime descriptor to match skills/novel-v2/h3-video-prompt.yaml.

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
  '1.2.0',
  ARRAY['script'],
  ARRAY['drafting'],
  ARRAY['chapter.script'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['h3-six-section-order', 'shot-timing-consistency'],
  $js${"chapter.script":"任务：把已定稿章节正文改写为短剧分镜剧本提示词，供 MiniMax H3 全参考模式（Ref2VA）视频生成使用。每个片段是一条独立可生成的目标视频提示词。\n\n统一定义库 subjects（全章唯一，最重要的去重契约）：\n- 先提取本章实际出场且可复用的内容单元：出场人物、反复出现的场景环境、影响情节的关键道具，输出为顶层 subjects 数组；<Subject N> 编号由数组顺序决定。\n- 人物必须给一句完整的英文外观描述作为该角色跨所有片段的唯一外观基线（身形、发型、着装、随身物）；同一角色的描述文本在整章只出现一次。\n- 场景与道具同样只在库里定义一次；descriptionEn 写完整英文句子，不得引用 <Picture>/<Video>/<Audio> 等未提供资产的标签。\n\n片段引用而非定义（交付契约）：\n- 片段只声明本段实际用到的 subjectLabels（统一定义库的序号），正文五段为 summary / retentionAnalysis / detailedDescription / overallSoundscape / nonDiegeticMusic。\n- 片段内不输出 subjectDefinitions：统一定义库由系统作为独立的 subject_definitions 块随全章导出，由编排者在 H3 生成时前置提供；任何片段重复书写定义都视为违规。\n- 声明与出场必须双向一致：本段声明的条目必须在正文出场，正文出现的标签必须已在本段声明。\n\n分段与镜头：\n- 按场景节拍把本章拆成多个片段：每片段目标时长 5-10 秒，承载一个完整的动作、反应或一次对话交换；相邻片段在剧情与时空上连续衔接。\n- 每个片段可有多个镜头：[Shot 1] 为开场镜头且不带时间戳；其后每个 [Shot N] 以 At MM:SS.mmm 格式的切点开始，切点落在片段时长内并严格递增。\n- 切镜必须引入新信息（主体、空间、状态、视角或时间的变化）；只是距离或小幅角度变化时优先用运镜而非切镜。运镜写成自然的英文动作句，类型+幅度+速度只在有意义时表达。\n\n片段五段内容（全部英文书写，对白、歌词与画面文字保留原文语言；不含 subject_definitions）：\n1. summary：以方括号任务类型前缀开头（如 [reference generation]，存在多种关系时用 + 连接且不重复类型）；一句话概括目标视频的内容脉络与引用关系，只使用已声明的 <Subject N>。\n2. retentionAnalysis：逐标签一行说明保留关系，使用 fully_preserved / partially_preserved / attribute_transfer / weak_reference 中与其定义角色相符者。\n3. detailedDescription：主体内容，逐镜头按播放顺序写具体画面与声音：构图、人物外观与位置、环境与光线、动作与状态变化、运镜、对白及其触发时机；重要主体首次清晰出现处复述其关键参考特征并复用同编号；说话人使用稳定的 (S1)(S2) 编号，台词写在 <d>[中文] ……</d> 内。描述要让生成器能从文字复原现场证据，不做剧情概要化；人物心理不直接翻译成画面，转为可观察的表情、动作或选择。\n4. overallSoundscape：全片环境声与物理动作声的总结；与特定镜头同步的对白和音效留在 detailedDescription，不在本段重复。\n5. nonDiegeticMusic：只有观众听得见、剧中人听不到的配乐描述（乐器、节奏与力度发展）；没有配乐写 N/A。\n\n硬性边界：\n- 标签一致性：<Subject N> 一旦在统一定义库中赋号，含义跨片段保持不变；不得新增未入库的单元，也不得中途改写其描述。\n- 交付形态：片段文本绝不含 subject_definitions 区块；定义只存在于顶层 subjects。\n- 参考资产诚实：不给未提供的参考资产生成 <Picture N>/<Video N>/<Audio N> 条目；仅有外观参考时任务类型就是 reference generation。\n- 时间线自洽：最后一个切点之后要保留完成当前动作所需的剩余时间，任何镜头编排不得超出片段 durationSeconds。\n- 对白忠实于正文中的原话语义，可压缩但不得改变事实与因果；对白密集时优先保证完整口播时间线，不以机械字数指标削减内容。\n"}$js$::jsonb,
  'required',
  '',
  'database:045_h3_video_prompt_skill_v1_2.sql',
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
