# Novel V2 小说创作工作流

> 当前活动契约：2026-08-03。本文以源码和当前 workflow 行为为准；历史 artifact、旧审校记录和旧 reflection 数据只读保留，不被新运行消费。

## 1. 目标流程

~~~mermaid
flowchart TD
  P["5 个全书核心规划"] --> A["Story Arc 因果/状态蓝图"]
  A --> C["事实检索与上下文编译"]
  C --> D["正文生成"]
  D --> R["结构与事实 / 人物与关系 / 正文体验与语言"]
  R --> V["目标修订"]
  V --> G["审批与质量门"]
  G --> F["事实提取与去重"]
  F --> M["commit + chapter memory"]
  M --> L["learning / skill iteration"]
~~~

Web、HTTP、MCP、CLI 都是可替换客户端。PostgreSQL 保存结构化真源，Temporal 持有 durable execution，正文对象通过对象存储保存，Qdrant 只承担可重建索引。

章节正式链路固定为：

review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters

没有新的 reflection activity、reflection schema 或 reflection artifact 消费路径。旧 reflection 产物可以查看和审计，但不参与新 draft、review、revision 或 commit。

## 2. Foundation 全书规划

活动阶段只有五个：

| taskKey | 职责 |
| --- | --- |
| project-positioning | 项目定位、读者方向、核心承诺与作者边界 |
| architecture | 全书结构、卷级层次、长期状态与收束方式 |
| characters | 主要人物、动机、声部、知识边界与关系可能 |
| worldview | 世界事实、规则、代价和可验证边界 |
| plot-design | 长程主线、支线、信息释放、伏笔和终局策略 |

依赖关系：project-positioning → architecture / characters / worldview → plot-design。旧 relations、plot-threads、foreshadowing、timeline、story-control 不再生成独立 task；相关信息可作为上述五阶段 payload 的可选结构存在。

每个 Foundation artifact 保留 artifact id、fingerprint、source provenance、审核和作者确认状态。可选结构不转换为固定数量、逐章字段或每章质量门。生成失败、编辑、重生成和上游 stale 仍由原有 section 生命周期和审计记录管理。

## 3. Story Arc 与章节蓝图

Story Arc 按故事弧和批次滚动生成，不在开篇冻结整部长篇章节表。章节蓝图的活动字段是：

| 字段 | 用途 |
| --- | --- |
| index / title | 叙事顺序和工作标题 |
| narrativeFunction | 当前章节的叙事功能，可为空或由模型选择 |
| povCharacterId | POV 边界 |
| stateTransition | before、after、evidence，允许外部状态保持稳定 |
| scenes | 当前执行场景 |
| continuityConstraints | 冻结事实和连续性边界 |
| unresolvedAtClose | 章节结束后仍未解决的事项 |

场景只保留 title、participants、situation、observableActions、opposition、decision、outcome、cost。opposition、decision、cost 允许为空；安静、关系、背景、等待、恢复、内省和余波章节不必被改造成冲突升级。

删除的章节级编辑字段包括 summary、chapterPurpose、readerExperience、thematicTreatment、romanceTreatment、humorTreatment、dramaticQuestion、emotionalMovement、stateDeltaBudget、narrativeScale、optionalBeats、setupRefs、payoffRefs、closingForce、freedom、participantStakes，以及旧版 goal/turn。历史 JSONB 原样保留，新的生成、编辑和正文 prompt 不再依赖这些字段。

Story Arc 审核只检查状态连续、场景因果、事实权威、章节功能与长篇位置是否相容。它不要求每章新事件、外部压力、强钩子、反转、爽点、主题表达或不可逆变化。

## 4. 上下文编译

ChapterPlanningContext 只保存：

- 当前章节执行合同和 artifact 引用；
- 当前章节状态边界、场景执行材料和连续性约束；
- 相邻章节的 narrativeFunction 与状态边界；
- fingerprint、source provenance 和必要的事实投影。

它不保存完整宏观规划 payload。正文阶段通过 memory claims 获取冻结事实，不通过蓝图重复注入世界观、主题和人物标签。draft、review、revision 共用 renderChapterExecutionContract，避免三套 prompt 对同一蓝图各自解释。

NarrativeRhythmEntry 只保留 documentId、revisionId、narrativeOrder、title、narrativeFunction。summary、keyEvents、emotionalArc、主题字段和 issue families 不再作为章节节奏输入。

上下文编译仍保留 required/normal/critical 优先级、输入预算、manifest、prompt fingerprint、source artifact id、Skill provenance 和可审计排除记录。事实、人物知识边界、当前 POV、起始状态、结束状态和场景因果是可靠性边界；文学偏好不转成必填字段。

## 5. 正文生成

正文 prompt 的硬边界只有：

1. 只输出正文；
2. 遵守冻结事实、当前 POV 和人物知识边界；
3. 完成当前章节的因果、场景和状态合同；
4. 不输出作者说明、审核意见、指令回显或元注释；
5. 在体验自然完成的位置收束。

正文不包含固定字数、3000 字目标、最小段落数、篇幅等级、固定钩子、强制反转、强制新鲜贡献、持续施压规则，以及主题、感情线、幽默或卖点的逐章检查。章节长度由当前功能、过程展开和自然收束决定。

## 6. 三类章节审校

| role | identity | 执行点 | 职责 |
| --- | --- | --- | --- |
| structure-reviewer | internal | chapter.review.structure | 结构、事实、因果、世界规则、人物知识边界 |
| character-reviewer | independent | chapter.review.character | 人物能动性、关系、对白和情感变化 |
| prose-reviewer | independent | chapter.review.prose | 场景体验、语言、节奏、具体性、情绪和幽默 |

schema 只要求：

~~~text
verdict
score: 0-5
issues[]
~~~

issue 保留 severity、title、description、excerpt/evidence、revisionRanges、rule、suggestion，以及可选 paragraph/sourceId。审核必须以当前 artifact fingerprint、正文逐字证据和最小修改范围为依据；不强制 rewriteExample，不强制 14 维度逐项评分。

REVIEW_COVERAGE 只作为内部完整性映射，覆盖 D1 世界观、D2 故事性、D3 群像、D4 感情线、D5 幽默；这些维度不是模型必须逐项填充的输出字段。

commit gate 仍要求三个 reviewer 针对当前 artifact，三个 verdict 均 passed，结构检查通过，不存在 blocker/major，且满足总体分数和局部 reviewer 分数守卫。局部退化上限与整体改善阈值用于质量回退保护，不用于规定文学内容。

## 7. 修订、事实与学习

修订以 grounded issue 和 revisionRanges 为入口，只改变问题机制相关范围；无证据的问题不进入修订。sanitizeRevisionOutput 使用代码围栏、标题行、冒号前缀等结构特征清理元注释，不使用 prompt 短语黑名单。

commit 前仍执行事实提取和 novelty 去重。commit 使用当前 artifact、revision 和 source provenance 更新正文、事实和 chapter memory。review/commit 后生成 RuntimeLearningAssessment；propose-improvement 必须记录 underlyingMechanism、affectedInputClass、边界和回归风险。promote 后必须使用新版本重跑失败场景验证。

## 8. 已定稿章节重审

已定稿章节重审入口仍是 chapterReviewWorkflow，从 review 阶段半截启动并复用正式 review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters activity。入口要求 document.status=final、无活跃 workflow 和历史 blueprint artifact；正文包装为 draft artifact，复用历史 blueprint structuredData 的兼容部分，但新审核只读取当前执行合同。

## 9. 兼容与审计

- 旧 Foundation task、旧章节字段、旧 dimensionScores、旧 review 记录和旧 reflection artifact 原样保留；
- 新 API、repository、workflow 和 active task 列表只生成五阶段、三 reviewer 的活动结构；
- 数据迁移不重写历史正文或审核记录；
- artifact、revision、fingerprint、source provenance、结构 schema、证据和 workflow gate 始终保留；
- 任何 prompt 示例都必须描述通用叙事机制，不得以标题、角色、章节号或特定短语作为产品契约。

## 10. 维护清单

修改 Foundation 阶段、ChapterBlueprint、Skill execution point、reviewer role、commit gate、fact extraction 或 learning contract 时，同步更新：

- src/novel-v2/protocol.ts
- src/novel-v2/application/project-plan.ts
- src/novel-v2/application/story-arc.ts
- src/novel-v2/prompts/chapter-planning-context.ts
- src/novel-v2/prompts/chapter-draft.ts
- src/novel-v2/prompts/chapter-review.ts
- src/novel-v2/prompts/schemas.ts
- src/novel-v2/temporal/workflows.ts
- src/novel-v2/temporal/revision-policy.ts
- 本文、quality-standard.md、pipeline-audit.md
