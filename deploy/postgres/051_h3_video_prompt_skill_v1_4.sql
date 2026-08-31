-- h3-video-prompt v1.4.0：描述体量契约（两执行点同步）
-- 根因：此前 schema 只设描述下限（summary 20 / detailedDescription 80 字符）且 skill 未给体量目标，
-- 模型贴下限交付概要化产物，Ref2VA 指南体量（detailed_description 350-500 英文词）只存在于代码注释。
-- v1.4.0 在 chapter.script / short.script 两执行点补全字段级体量要求：
-- 宁详勿简原则、detailedDescription 每片段 350-500 英文词、每 [Shot N] 四要素写全、
-- summary 完整句、retentionAnalysis 逐标签具体内容、overallSoundscape 分层、
-- subjectDefinitions 人物外观基线写全。
-- 配套：chapter-script-h3.ts schema 描述下限抬升；short-script-h3 契约 v3（旧简短产物指纹失效）。
-- 043-050 保持不可变历史；本迁移 upsert 运行时 descriptor，与 YAML 对齐。

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
  '1.4.0',
  ARRAY['script'],
  ARRAY['drafting'],
  ARRAY['chapter.script', 'short.script'],
  ARRAY[]::text[],
  ARRAY[]::text[],
  ARRAY['h3-six-section-order', 'shot-timing-consistency'],
  $js${"chapter.script":"任务：把已定稿章节正文改写为短剧分镜剧本提示词，供 MiniMax H3 全参考模式（Ref2VA）视频生成使用。每个片段是一条独立可生成的目标视频提示词。输出格式语法（六段结构、[Shot N] 标记、<d> 标签、说话人编号）以 h3-prompt-writing 技能为准；本指引负责导演层与剧作层——写什么、怎么拍、如何让观众留到下一集。\n\n分段与镜头：\n- 按场景节拍把本章拆成多个片段：每片段目标时长 5-10 秒，承载一个完整的动作、反应或一次对话交换；相邻片段在剧情与时空上连续衔接。\n- 每个片段可有多个镜头：[Shot 1] 为开场镜头且不带时间戳；其后每个 [Shot N] 以 At MM:SS.mmm 格式的切点开始，切点落在片段时长内并严格递增。\n- 切镜必须引入新信息（主体、空间、状态、视角或时间的变化）；只是距离或小幅角度变化时优先用运镜而非切镜。运镜写成自然的英文动作句，类型+幅度+速度只在有意义时表达。\n\n影视镜头语言（每个 [Shot N] 的四要素）：\n1. 景别与角度：从特写/中近景/中景/中全景/全景/大远景与平视/仰拍/俯拍/斜角/过肩/主观视角中选用，写明本镜头取景范围与机位关系。\n2. 运镜：按 H3 运镜语法写自然的英文动作句（推/拉/摇/移/升降/变焦/弧形/跟拍/固定/震动/滚转 + 幅度 + 速度，按需表达）。\n3. 光线与氛围：写明光源（油灯/窗光/月光/火光/余烬辉光等）、方向（逆光剪影/轮廓光/侧光塑形）、色温对比，以及空气元素（尘埃/薄雾/雨丝/蒸汽/漂浮微粒）——有依据的氛围元素是廉价而有效的电影密度。\n4. 状态变化：镜头内可见地改变了什么（位置/表情/物件状态/光量），结束态能被下一镜继承。\n刻意的静态镜头也须写明景别与光线；没有镜头与光的句子只是剧情概述，不是镜头。\n开场先写整片风格句（画幅质感/色调/时代感，如 live-action cinematic、去饱和冷调配单源暖光），再进入 [Shot 1]。\n\n剧集剧作层（分段之上的集级节奏）：\n- 开场即冲突：第 1 个片段的第一个镜头落在冲突现场或其临界点，开场 3 秒内呈现钩子形态之一（直接冲突、强悬念、极致反差、身份落差、倒计时压力）；本章核心冲突、对立双方、主角即时目标须在前 10 秒内可见或可闻，铺垫性开场视为失败。\n- 情绪节点节奏：每 2-4 个片段落一个情绪节点（对话冲突、动作冲突或信息揭示），前 1/3 的片段内完成第一次小反转；连续 3 个片段无节点视为节奏断裂。\n- 出口即钩子：每个片段的出口状态抛出问题或抬高压（未揭的身份、被推翻的假设、逼近的危险、两难抉择、逼近的期限）；末片段在冲击瞬间切卡（揭示、接触或决定发生的一刻），不在余韵处收尾——观众应带着未解的钩子离开。\n- 台词密度：每句台词至少承担身份/关系确认、冲突引爆、后果陈述之一，纯填充性寒暄压缩掉；关键情绪节拍静音可读（表情、动作或屏幕可读文字）。\n- 反转须有伏笔：每个反转必须对应正文前文已呈现过的伏笔（plant → overlook → detonate）；正文未铺垫的反转不得新增，伏笔应经插入镜头、台词或可读细节在早期片段中可见。\n- 人物经济：镜头内出场人物围绕核心三角（主角、对手、助力者）加少量配角组织；人物标签靠稳定的视觉锚点（标志道具、服饰、特征）跨片段复用同一外形。\n\n片段节奏范式：\n- 每片段设计一个节奏峰（动作完成/揭示/台词落地）与一个刹车（保持的特写/可读的一行/安定帧），开场用 establishing 镜头交代空间与主体，结尾用出口镜头钩向下一片段。\n- 节奏意图词汇：setup / establish / prepare / impact / brake / settle。\n- 高光时刻（正文自然给出的爆发点）采用递进范式：光效或粒子升级 → 高能瞬间（白屏/爆响/揭示）→ 物理冲击反应（踉跄/畏缩/物体震颤）→ 余韵收束（安定的、已改变的帧）。不强求每章多个高光；静态章节可用刻意的刹车镜头承载，不必伪造场面。\n\n题材视觉特效：世界观中可见的元素（能量通道辉光、符文光效、灵息流转等）是可拍摄的画面信息，必须写得具体可拍——颜色、强度、运动方式、出现在身体或空间的哪个位置，并跨片段保持同一视觉系统。抽象设定陈述不进入画面描述。\n\n描述体量契约（全字段硬性要求）：\n- 视频生成器只能依据文字复原画面——凡未写出的细节在成片中不存在。宁详勿简：具体、可拍、可复原的描述永远优于简短概括；禁止概要化、清单化或以单个名词带过本应成段的画面描述。\n- detailedDescription 每片段约 350-500 英文词（Ref2VA 指南体量）；每个 [Shot N] 写全四要素（景别角度/运镜/光线氛围/状态变化）与主体位置、外观、动作。\n- summary 是点名主体与动作/变化的完整句；retentionAnalysis 每行说明保留的具体内容（外观、姿态、环境哪一部分）；overallSoundscape 分层写底层环境声与间歇动作声及其时机。\n- subjectDefinitions 中每个人物定义行写全外观基线（体貌、年龄感、发型、服装、标志物），不得只写角色名或代词——定义不完整则该角色外形在生成时不可控。\n\n输出六段（每段是独立字段，段内英文书写，对白、歌词与画面文字保留原文语言）：\n1. subjectDefinitions：定义本片段实际使用的引用内容单元（人物、环境、服装道具等），每项一行；出场人物的外观基线必须与输入 characters 提供的 appearanceEn 英文外观描述一致，使同一角色跨片段保持同一外形与着装。仅作为外观来源的参考图并入对应 Subject 的定义行说明来源，不为它单列条目。\n2. summary：以方括号任务类型前缀开头（如 [reference generation]，存在多种关系时用 + 连接且不重复类型）；一句话概括目标视频的内容脉络与主要引用关系，只使用已定义的标签。\n3. retentionAnalysis：逐标签一行说明保留关系；可见内容用 fully_preserved / partially_preserved / attribute_transfer / weak_reference，音频用 fully_copy / partially_copy / reference / weak_reference。\n4. detailedDescription：主体内容，逐镜头按播放顺序写具体画面与声音：构图、人物外观与位置、环境与光线、动作与状态变化、运镜、对白及其触发时机；在重要主体首次清晰出现处描述其参考特征并复用同一标签；说话人使用稳定的 (S1)(S2) 编号，台词写在 <d>[中文] ……</d> 内。描述要让生成器能从文字复原现场证据，不做剧情概要化；人物心理不直接翻译成画面，转为可观察的表情、动作或选择。\n5. overallSoundscape：全片环境声与物理动作声的总结；与特定镜头同步的对白和音效留在 detailedDescription，不在本段重复。\n6. nonDiegeticMusic：只有观众听得见、剧中人听不到的配乐描述（乐器、节奏与力度发展），并说明配乐如何与画面时刻对位（在冲击处扬起、在揭示后骤停）；没有配乐写 N/A。\n\n硬性边界：\n- 标签一致性：<Subject N>、<Picture N>、<Audio N> 一旦定义不得悬空，也不得中途重新定义；summary / retentionAnalysis / detailedDescription 中出现的每个标签都必须已在 subjectDefinitions 中定义，且每个定义都应被实际使用。\n- 参考资产诚实：不给未提供的参考资产生成 <Video N> 或 <Audio N> 条目；仅有图片类外观参考时，任务类型就是 reference generation。\n- 时间线自洽：最后一个切点之后要保留完成当前动作所需的剩余时间，任何镜头编排不得超出片段 durationSeconds。\n- 对白忠实于正文中的原话语义，可压缩但不得改变事实与因果；对白密集时优先保证完整口播时间线，不以机械字数指标削减内容。\n","short.script":"任务：把给定的核心创意扩展为一条自洽的简短短剧脚本（MiniMax H3 全参考模式 Ref2VA），供单支竖屏短视频生成使用。没有定稿正文作为事实源——剧情节拍由你从核心创意穷举自拟，但不得新增与创意冲突的设定、人物或结局走向。输出格式语法（六段结构、[Shot N] 标记、<d> 标签、说话人编号）以 h3-prompt-writing 技能为准；本指引负责导演层与剧作层。\n\n分段与镜头（与章节剧本同契约）：\n- 每片段目标时长 5-10 秒，承载一个完整的动作、反应或一次对话交换；片段数与总时长服从输入给定的时长预算。\n- [Shot 1] 为开场镜头且不带时间戳；其后每个 [Shot N] 以 At MM:SS.mmm 格式切点开始，切点落在片段时长内并严格递增；切镜必须引入新信息。\n\n影视镜头语言（每个 [Shot N] 的四要素）：\n1. 景别与角度（特写/中近景/中景/中全景/全景/大远景；平视/仰拍/俯拍/斜角/过肩/主观视角）。\n2. 运镜：自然的英文动作句（推/拉/摇/移/升降/变焦/弧形/跟拍/固定/震动/滚转 + 幅度 + 速度，按需表达）。\n3. 光线与氛围：光源、方向、色温对比、空气元素（尘埃/薄雾/雨丝/蒸汽）。\n4. 状态变化：镜头内可见地改变了什么，结束态能被下一镜继承。\n开场先写整片风格句（画幅质感/色调，如 live-action cinematic、竖屏构图），再进入 [Shot 1]。\n\n剧作层（创意起点，单集自洽）：\n- 开场即冲突：第 1 个片段的第一个镜头落在冲突现场或其临界点，开场 3 秒内呈现钩子形态之一（直接冲突、强悬念、极致反差、身份落差、倒计时压力）；创意的核心冲突、对立双方、主角即时目标须在前 10 秒内可见或可闻。\n- 情绪闭环：短剧本体量小，节拍密度高于连载——每 2-3 个片段落一个情绪节点（对话冲突、动作冲突或信息揭示），前 1/3 内完成第一次小反转。\n- 出口即钩子：每个片段的出口抛出问题或抬高压；整条短剧在情绪闭环完成后的最强钩子瞬间收尾——观众带着未解的钩子或余震离开，不在平淡余韵处结束。\n- 台词密度：每句台词至少承担身份/关系确认、冲突引爆、后果陈述之一；台词口语化、短句、可念出口；关键节拍静音可读。\n- 反转须有伏笔：反转须由早期片段经插入镜头、台词或可读细节埋设（plant → overlook → detonate）。\n- 人物经济：出场人物围绕核心三角（主角、对手、助力者）加少量配角；跨片段复用同一外形与视觉锚点。\n\n描述体量契约（全字段硬性要求，与章节剧本同契约）：\n- 视频生成器只能依据文字复原画面——凡未写出的细节在成片中不存在。宁详勿简：具体、可拍、可复原的描述永远优于简短概括；禁止概要化、清单化或以单个名词带过本应成段的画面描述。\n- detailedDescription 每片段约 350-500 英文词（Ref2VA 指南体量）；每个 [Shot N] 写全四要素（景别角度/运镜/光线氛围/状态变化）与主体位置、外观、动作。\n- summary 是点名主体与动作/变化的完整句；retentionAnalysis 每行说明保留的具体内容（外观、姿态、环境哪一部分）；overallSoundscape 分层写底层环境声与间歇动作声及其时机。\n- subjectDefinitions 中每个人物定义行写全外观基线（体貌、年龄感、发型、服装、标志物），不得只写角色名或代词——定义不完整则该角色外形在生成时不可控。\n\n输出六段（每段是独立字段，段内英文书写，对白、歌词与画面文字保留原文语言）：\n1. subjectDefinitions：定义本片段实际使用的引用内容单元；出场人物的外观基线与顶层 characters 的 appearanceEn 一致。\n2. summary：方括号任务类型前缀开头（如 [reference generation]）；一句话概括内容脉络与引用关系，只用已定义标签。\n3. retentionAnalysis：逐标签一行说明保留关系；可见内容用 fully_preserved / partially_preserved / attribute_transfer / weak_reference，音频用 fully_copy / partially_copy / reference / weak_reference。\n4. detailedDescription：逐镜头写具体画面与声音（构图/外观/环境/光线/动作/运镜/对白时机）；说话人用稳定 (S1)(S2) 编号，台词写在 <d>[中文] ……</d> 内；不做剧情概要化，心理转为可观察的表情、动作或选择。\n5. overallSoundscape：全片环境声与物理动作声总结；镜头同步对白与音效留在 detailedDescription。\n6. nonDiegeticMusic：观众才听得见的配乐（乐器、节奏、力度发展）与画面对位说明；没有配乐写 N/A。\n\n硬性边界：\n- 标签一致性：正文中出现的每个标签都必须已在 subjectDefinitions 中定义且被使用，不得悬空或中途重定义。\n- 参考资产诚实：不给未提供的参考资产生成 <Video N> 或 <Audio N> 条目。\n- 时间线自洽：镜头编排不得超出片段 durationSeconds；各片段 durationSeconds 之和落在目标时长容差内。\n- 忠实于核心创意给定的设定、冲突与人物关系；台词无原文明文时自拟，但语义须与节拍承载的信息一致。\n"}$js$::jsonb,
  'required',
  '',
  'database:051_h3_video_prompt_skill_v1_4.sql',
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
