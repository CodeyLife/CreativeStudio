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

## 3. 审核证据

每个 issue 必须：

- 针对当前 artifact fingerprint；
- 引用当前正文逐字 excerpt/evidence；
- 指定最小 revisionRanges；
- 描述实际损害；
- 说明通用问题机制 rule；
- 只提供修复方向，不强制 rewriteExample。

无法被正文或冻结来源证明的问题不进入修订和 commit gate。审核不以字数、段落数量、关键词、固定章尾、反转、爽点、主题、感情线或幽默是否出现作为单独失败依据。

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

正文 prompt 只保留少量硬边界：正文输出、事实与 POV、章节执行合同、禁止元注释、自然收束。不得写入固定字数、3000 字、最小段落、narrativeScale、固定钩子、每章新贡献、持续施压或逐章主题/感情/幽默要求。

## 6. 修订与学习

修订必须从正文证据和 revisionRanges 出发，只改变问题机制相关范围，其余正文保持稳定。输出净化基于 Markdown 围栏、标题行、冒号前缀等结构特征，不使用精确短语黑名单。

review/commit 后的 learning 必须分析 underlyingMechanism 和 affectedInputClass，而不只是复制 issue 症状。propose-improvement 记录边界、回归风险和候选输入类；promote 后重新运行失败场景，验证改进没有把局部偏好变成全局硬约束。

## 7. 历史兼容

旧章节字段、dimensionScores、旧五角色 review、历史 reflection artifact 和历史审核维度可以在 JSONB、审计和历史页面中保留。它们不是当前活动 contract；新 workflow 不生成、不消费，也不要求迁移历史正文。
