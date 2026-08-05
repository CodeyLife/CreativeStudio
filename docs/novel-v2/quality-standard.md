# 高质量长篇网文质量标准

> 本文是 Novel V2 的创作与审核原则，不把文学偏好转换为逐章必填字段。工程可靠性由 artifact、revision、fingerprint、source provenance、结构 schema、证据和 workflow gate 保证。

## 1. 长篇创作基准

高质量长篇网文不是把每章压缩成同一种任务模板，而是在长期承诺下安排不同尺度和功能的章节。全局架构负责方向、状态和收束，故事弧负责当前阶段的因果窗口，章节蓝图负责局部执行，正文负责把过程写成读者可经历的场景。

稳定的长篇能力包括：

- 长期因果：人物选择、关系变化、世界规则和代价能够跨章节追溯；
- 功能变化：行动、铺陈、相处、等待、恢复、内省、余波和阶段收束都可以成立；
- 过程承载：关键变化通过行为、对白、感官、环境、信息抵达和后果发生，而不是摘要替代；
- 人物独立性：人物有自己的欲望、知识边界、声部和选择，不只是主角的说明工具；
- 关系积累：感情和关系通过具体行动、距离、误解、照料、冲突与选择逐步形成；
- 世界质地：规则可预测，设定通过生活、职业、制度、环境和事件进入正文；
- 语言适配：句式、节奏、意象和幽默服务于人物、场景和当前叙事功能；
- 长期留白：不提前消费后续结果，也不为证明本章完成而强行加入反转或钩子。

这些是观察原则，不是每章必须同时出现的清单。安静章节可以没有外部状态变化；章节可以在理解、关系温度、处境、情绪或阅读体验上完成。

## 2. 五大审核维度

三个 reviewer 通过内部 REVIEW_COVERAGE 映射覆盖五大维度，但模型输出不包含 dimensionScores，也不要求逐项评分。

### D1 世界观

检查冻结事实、规则、时间线、位置、人物知识边界和选择后果是否一致。规则应允许读者形成预测，不能为了当前段落临时改写。世界观的文化和社会质地应在需要时通过具体生活和行动显现，不要求每章解释设定。

### D2 故事性

检查章节功能、场景因果、信息抵达、人物选择与后果是否成立，检查当前弧是否越过自身边界。节奏可以波动，高潮、过渡、余波和相处不使用同一强度。不能用章节摘要、巧合或临时线索替代正文中的因果过程。

### D3 群像

检查人物能动性、独立欲望、关系网络、对白声部和视角边界。配角不需要每章行动，也不需要机械增加戏份；只有在正文承担相关内容且确实出现工具化、声部混淆或知识越界时才报告问题。

### D4 感情线

检查关系变化是否符合人物处境、已知信息和过程证据。感情可以停顿、回避、积累或反复，不要求每章推进恋爱线，不要求直接告白或情绪宣言。问题必须落到具体行为、对白、距离或后果。

### D5 幽默与语言体验

检查幽默、语言、节奏、具体性、场景沉浸和情绪抵达是否服务于当前人物和场景。没有幽默不是问题；幽默不应因固定模板、时代错位、声部不符或打断重要情绪而损害正文。

### 2.1 AI 味专项诊断边界

AI 味是正文质量问题的观察标签，不是单一检测分数，也不是精确短语黑名单。当前专项只报告已经由正文证据证明并造成阅读损害的共享机制：规划/审核信息泄漏、摘要替代过程、段落或章节同构、POV/声部趋同、抽象表达替代现场经验，以及只换词不修根因的表面修订。单个词、句式、字数、章节对称性或检测器结果只能辅助定位，不能单独构成失败理由。

修复顺序固定为“事实/因果 → 场景承载 → POV/人物声部 → 段落节奏 → 句法和词语”。审校 issue 必须引用正文片段、说明当前功能受到的损害、给出最小 revisionRanges，并标明保留边界。安静、抒情、回忆、等待和余波章节可以采用不同速度与抽象程度，只要其功能有可感知证据；不得为了降低 AI 信号强行加入事件、危险、反转、幽默或固定章尾。

运行时投影也应保持这一范围：`prose-craft` 与 `reader-emotion` 只服务章节正文创作、文风审核和章节修订；`plot-causality` 的专项退化规则只服务章节蓝图、结构审核和章节修订。全书架构与故事弧仍执行基础事实、状态和因果契约，不把正文风格诊断重复注入上游规划。

## 3. 审核证据

每个 issue 必须：

- 针对当前 artifact fingerprint；
- 提供能够说明问题的 excerpt/evidence；该字段是审校说明，不要求与当前正文逐字一致；
- 指定最小 revisionRanges；
- 描述实际损害；
- 说明通用问题机制 rule；
- 只提供修复方向，不强制 rewriteExample。

所有审核 issue 都保留为审计记录，不因 excerpt/evidence 无法与正文逐字匹配而丢弃；是否进入自动修订仍按 severity 和 revision policy 决定，修订窗口无法安全定位时走整章修订或人工处理。审核不以字数、段落数量、关键词、固定章尾、反转、爽点、主题、感情线或幽默是否出现作为单独失败依据。

## 4. 审核角色

| role | identity | 覆盖重点 |
| --- | --- | --- |
| structure-reviewer | internal | D1、D2：结构、事实、因果、世界规则与知识边界 |
| character-reviewer | independent | D3、D4：人物能动性、关系、对白与情感变化 |
| prose-reviewer | independent | D2、D5：场景体验、语言、节奏、具体性与幽默 |

每个 reviewer 输出 verdict、0-5 score 和 issues。完整性由 commit gate 检查三个当前 artifact reviewer 是否齐全；质量回退由总体改善阈值和单 reviewer 局部下降上限共同保护。

## 5. Prompt 与规划原则

Foundation 只生成 project-positioning、architecture、characters、worldview、plot-design 五个核心阶段。relations、plot-threads、foreshadowing、timeline、story-control 等信息可以折入核心 payload 的可选结构，但不再生成独立 task，也不变成逐章检查项。

章节蓝图只承载局部因果和状态执行合同：index、title、narrativeFunction、povCharacterId、stateTransition、scenes、continuityConstraints、unresolvedAtClose。scene 只承载 title、participants、situation、observableActions，以及可为空的 opposition、decision、outcome、cost。

结构质量门分为两层：事实、身份、时间线、知识边界、状态转移、活动批次归属和权威记忆投影是硬门；characterFocus、worldRuleRefs、payoffRefs、场景数量、篇幅、钩子和章节功能分布只作为软诊断。`fullBookArchitecture` 缺少或为空的必需根集合产生 major；故事弧批准必须同时通过 Foundation.required 和 fullBookArchitecture 的 blocker/major 门禁。`architecture/health` 负责先报告问题，章节蓝图在审批前缺正文仍属 planned，不计 orphaned；只有已批准故事弧缺正文、关联正文不存在或缺故事弧才计 orphaned。

故事弧引用采用“规范 ID + 兼容别名”：输入边界可以提交旧名称或自然语言别名，内部诊断使用规范 ID；多个对象匹配同一别名时不得自动合并。新伏笔概念在规划阶段可以暂存为未知警告，待事实提取或作者确认后再建立正式对象。

### 5.1 全书架构质量门

全书架构质量不是把五大正文审核维度提前套到每一章，而是检查 Foundation 是否提供了能向 Story Arc 传递的阶段合同。当前共享审计覆盖四类根因：卷缺少入口/压力/出口/承诺窗口，人物只有主线功能而没有独立行动和代价，世界规则只有设定描述而没有成本与边界，长线或人物终点跨阶段引用无法解析。长线还需要阶段责任、下一次可见推进和信息状态边界。

这些检查属于结构数据门，不是写作禁令：`chapterCount` 只能是资源估计；`promiseWindows` 是责任窗口而不是逐章兑现清单；`informationBoundaries` 允许作者保留 hidden、notDesigned 和 open 状态。审计通过后，基础设定的作者确认才允许完成；受影响的活动故事弧必须 rebase，再由 Story Arc 审核确认。它不因架构审计通过而要求正文变长，也不因章节审校出现问题而反向增加卷级字段。

长期叙事上下文采用“账本硬约束、开放元素可检索”的分层：当前叙事状态、截止点事实和满足当前 facet 的必要记忆不得静默丢弃；开放伏笔/承诺保留规范 ID、窗口和来源，但作为可排序候选进入局部创作。故事弧规划额外接收结构化的近期机制反馈，用于修复规划回写缺口，不把某个章节的问题直接变成所有章节的固定写法。

正文 prompt 只保留少量硬边界：正文输出、事实与 POV、章节执行合同、禁止元注释、自然收束。不得写入固定字数、3000 字、最小段落、narrativeScale、固定钩子、每章新贡献、持续施压或逐章主题/感情/幽默要求。若问题是卷级状态、跨卷长线、人物终点或世界规则边界缺失，先修上游架构，不用正文 prompt 代偿。

## 6. 修订与学习

修订必须从审核 issue 和 revisionRanges 出发，只改变问题机制相关范围，其余正文保持稳定；excerpt/evidence 不参与与正文的逐字匹配门禁。输出净化基于 Markdown 围栏、标题行、冒号前缀等结构特征，不使用精确短语黑名单。

review/commit 后的 learning 必须分析 underlyingMechanism 和 affectedInputClass，而不只是复制 issue 症状。`no-shared-learning` 只保存 assessment，不创建候选；`propose-improvement` 必须同时保存机制、影响输入类、适用边界、回归风险和 before/after 候选文本。

章节生命周期中，成功章节只在 `commit → enrichCharacters` 完成后执行一次持久化 learning；质量门失败的终态尝试可以执行一次 learning 作为原始失败证据；事实人工审批挂起时不得对未提交 artifact 创建候选，恢复后由 post-commit learning 统一完成。不得对同一提交候选重复评估并用后一次 assessment 覆盖前一次结果。

事实提取对伏笔/承诺兑现采用精确 ID 优先、唯一候选兼容回退的关联契约。没有足够证据时保持开放，不因关键词相似或承诺者相同而批量关闭；该规则保护长期可信度，同时不要求每章处理所有开放元素。

候选队列是作者可见的审计对象，状态为 `proposed → evidencing → reviewing → promoted / rolled-back / rejected`。候选生成不等于 skill 迭代：正式版本在实验、作者审核和原子晋升前不得改变，历史候选不得自动合并或自动晋升。

实验回归必须复用正式章节生命周期，并在隔离 schema 的实际 Skill execution point 注入候选版本。至少覆盖一条原失败场景和一条异构输入场景；异构场景必须由历史蓝图派生的 `ScenarioProfile` 在叙事功能、POV、未解决事项模式或场景结构上产生实质差异，不能只依赖不同章节 ID。候选版本必须在 prompt execution manifest 中被实际读取。回归通过要求正式提交成功、结构质量不退化、总体质量不下降、blocker/major 数量不增加、新 blocker/major 模式不出现且原模式不复现。任一回归失败、作者拒绝或目标版本漂移，都只能记录原因并保持正式 skill/prompt 不变。

作者审核通过且两类回归证据齐全后，promotion service 在单一事务中更新目标文本、版本、适用题材和晋升收据。Skill target 的 afterText JSON 是 execution-point patch，历史普通文本映射为 drafting，并合并到既有 `prompt_sections`；system-prompt target 仍写入完整文本。后续 drafting/revision 通过数据库 Skill provider 重新解析版本，不能只更新候选状态或 receipt。promote 后的验证只允许在隔离环境重跑；失败时用保存的完整 beforeText 恢复旧文本并把候选标记为 rolled-back。

Skill descriptor 中未知 execution point 必须保留为诊断信息；`novel:skills:check --target database` 报告数据库漂移，实际 Skill resolution 遇到失效点时直接阻断并指出 skill/version/失效值，不得静默过滤。

## 7. 历史兼容

旧章节字段、dimensionScores、旧五角色 review、历史 reflection artifact 和历史审核维度可以在 JSONB、审计和历史页面中保留。它们不是当前活动 contract；新 workflow 不生成、不消费，也不要求迁移历史正文。
