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
  M --> L["learning assessment / candidate queue"]
  L --> E["isolated schema chapter regression"]
  E --> H["author review"]
  H --> S["atomic skill/prompt promotion"]
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

### 2.1 全书架构审计与正文审校分层

全书架构审计发生在 Foundation 与 Story Arc 之间，审计对象是跨阶段结构数据，不是当前章节正文。`auditFullBookArchitecture` 只检查以下共享契约：

- architecture：每卷的入口状态、阶段压力、退出状态和承诺窗口；
- characters：重要人物的限制/恐惧、独立行动与选择代价；
- worldview：规则陈述、调用代价和不可越过的边界；
- plot-design：人物终点引用、长线阶段责任/下一次推进和信息边界。

故事弧对剧情线不再只保存 `plotThreadRefs` 名单；规范蓝图还保存 `threadResponsibilities`，每条引用对应本弧责任和下一次可验证推进条件。它是阶段传递契约，不是逐章兑现清单；暂缓的剧情线可以记录保持/观察责任与触发条件。

审计报告以 `fullBookArchitecture` 独立返回，保留 volumeCount、estimatedChapterCount、characterCount、longHorizonThreadCount 和结构问题列表；缺少或为空的 architecture.volumes、characters.characters、worldview.rules、plotStrategy.characterDestinations 或 plotStrategy.longHorizonThreads 会产生 major。它不读取正文质量分，也不要求每章出现事件、钩子、反转、主题、感情或幽默。`architecture/health.issues` 继续负责批次重叠、已提交剧情线和伏笔引用等硬完整性问题。

两类问题的处理入口不同：Foundation 契约缺失先修 Foundation 并使受影响故事弧 stale，再通过弧级 rebase 重新编译阶段计划。rebase 先严格校验新候选，再覆盖已提交章节的冻结蓝图；历史章节以 `revisionId` 或 `committedMemory` 的生命周期身份识别为冻结权威，不依赖新旧 JSON 完全相等，即使旧的可选场景字段不完整，也不能在 rebase 时强迫改写正文。只有当架构契约已经成立、问题仍具体表现为当前段落的场景因果、视角、人物行为或语言时，才进入 `chapterReviewWorkflow`。章节正文审校不能替代全书架构审计。

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

Story Arc 审核只检查状态连续、场景因果、事实权威、章节功能与长篇位置是否相容，并要求审核输出完整覆盖每章的四个结构维度、三个整弧维度和每章事实权威校验。它不要求每章新事件、外部压力、强钩子、反转、爽点、主题表达或不可逆变化；审核完整性不等于正文创作约束。

## 4. 上下文编译

ChapterPlanningContext 只保存：

- 当前章节执行合同和 artifact 引用；
- 当前章节状态边界、场景执行材料和连续性约束；
- 相邻章节的 narrativeFunction 与状态边界；
- fingerprint、source provenance 和必要的事实投影。

它不保存完整宏观规划 payload。正文阶段通过 memory claims 获取冻结事实，不通过蓝图重复注入世界观、主题和人物标签。draft、review、revision 共用 renderChapterExecutionContract，避免三套 prompt 对同一蓝图各自解释。

NarrativeRhythmEntry 只保留 documentId、revisionId、narrativeOrder、title、narrativeFunction。summary、keyEvents、emotionalArc、主题字段和 issue families 不再作为章节节奏输入。

上下文编译仍保留 required/normal/critical 优先级、输入预算、manifest、prompt fingerprint、source artifact id、Skill provenance 和可审计排除记录。事实、人物知识边界、当前 POV、起始状态、结束状态和场景因果是可靠性边界；文学偏好不转成必填字段。记忆选择区分两层：叙事状态账本和 required facet 是当前阶段的硬上下文，开放伏笔/承诺是可排序候选；它们仍可被检索和回收，但不会因为“开放”就全部挤占 pinned 预算或把局部正文变成清单执行。

Story Arc 的规划输入使用结构化反馈投影，而不是把 narrative state 原样 JSON 倾倒给模型。投影包括开放剧情线 payload、开放伏笔/承诺的规范 ID、最近定稿章节状态和与规划/连续性/因果相关的 RuntimeLearning underlyingMechanism、affectedInputClass、边界。review/revision 使用独立的 context sections，并在 manifest 中记录 `narrativeCutoff`、来源 artifact/revision、section fingerprint 和总 fingerprint；旧 planning 数据标为 legacy provenance。反馈只提示共享机制风险，已定稿事实、叙事账本和作者边界仍具有更高权威，开放线索也不等于本批次必须兑现的事件。

模型请求的结构化契约由 gateway transport 统一投影：Responses 请求把 JSON Schema 放在 `text.format`，不再把完整 schema 重复注入 user input；Chat Completions 兼容请求保留一次 prompt-level schema fallback，因为部分兼容网关只接受但不强制 `response_format`。两种协议都继续经过同一 AJV 校验、prompt manifest 和输入预算检查。该优化只减少结构化 schema 的重复输入，不删除正文、事实、章节规划、Skill 或 reviewer 证据。

`model_invocations` 同时保存 provider input/output tokens 与 provider 返回的 cached input tokens（若供应商提供）；没有 provider 用量时仍保留估算值并标记 `usage_source`，不把估算值伪装成真实计费数据。

### 架构体检与引用边界

`GET /v2/projects/:projectId/architecture/health` 是只读诊断入口。它汇总 Foundation 批准状态、故事弧批次区间、章节定稿状态，以及剧情线/伏笔引用的规范 ID、兼容别名、未知项和歧义项；同时返回独立的 `fullBookArchitecture` 结构审计。章节 `planned` 表示蓝图尚未关联正文，或已关联但正文仍为 planned；`orphaned` 只表示无故事弧、关联正文不存在，或已批准故事弧仍缺正文。审批前故事弧下的正常蓝图不计为 orphaned。诊断不会改变正文或章节蓝图。

历史数据修复通过作者可追溯的正式入口完成：`POST /v2/projects/:projectId/architecture/normalize-references` 使用同一项目级映射同步转换 `plotThreadRefs` 与 `threadResponsibilities[].threadRef`，转换后重新校验责任覆盖并记录映射；`POST /v2/projects/:projectId/architecture/reconcile-batches` 只会把没有章节归属的历史重叠批次标记为 failed，有章节归属的重叠仍返回阻塞问题，不自动删除或改写章节。

批次区间和明确的剧情线/伏笔引用属于提交边界：新批次不得与活动批次重叠，`failed` 历史批次不占用活动区间；故事弧批准时必须同时满足 Foundation.required 的阶段批准、`fullBookArchitecture` 无 blocker/major、明确引用解析为当前项目对象，未知或歧义引用都必须先通过规范化/作者消解。未解析引用不能以警告状态进入已批准故事弧，但这不把逐章兑现变成必填字段。章节功能、场景数量、篇幅和钩子仍属于作者创作空间。

故事弧引用审批和批次修复都以持久化状态为准：`approveStoryArc` 按 blocking integrity issue 拒绝未解析引用；`reconcile-batches` 只处理活动批次之间、后者没有章节归属的历史重叠。一个空重叠批次被标记 failed 后，后续区间继续与最后一个仍存活的活动区间比较；已有章节的重叠保留为作者可见阻塞问题。

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

当同一轮修订可以定位到多个彼此分离的安全窗口时，内部 API 路径使用一次 `targetedRevisionBatchSchema` 结构化调用，把冻结事实、章节规划、Skill 和修订契约作为共享上下文只注入一次；每个窗口仍独立保留前后邻段、审核证据和原章段号。单窗口继续使用局部文本调用；批量上下文无法通过现有输入预算时回退到逐窗口调用。返回结果必须覆盖全部声明窗口，并由窗口范围校验拒绝越界、漏项或无实际修改，避免 token 优化改变修订边界。

commit 前仍执行事实提取和 novelty 去重。commit 使用当前 artifact、revision 和 source provenance 更新正文、事实和 chapter memory。成功章节只在 commit/enrich 后生成一次 RuntimeLearningAssessment；质量门失败的终态尝试可保留一次失败证据，事实审批挂起不创建候选。propose-improvement 必须记录 underlyingMechanism、affectedInputClass、边界和回归风险。

伏笔/承诺兑现优先使用 fact-extraction 提取阶段可见的 `matchedForeshadowingIds` / `matchedPromiseId` 精确关联。兼容旧输出时，关键词或承诺者只在恰好命中一个仍开放、且处于叙事截止点之前的对象时自动兑现；多候选只保留未关联记录，不猜测关闭对象。这样既保留旧 artifact 的可读性，也避免同名角色或共享关键词造成错误回收。

Learning assessment 与 skill iteration 是两个不同的边界：assessment 只分析机制并创建 `craft_rule_candidate`，不直接改正式 skill，也不自动运行 `runSkillIteration`。项目级 learning 查询同时返回 assessment、来源章节、候选目标和候选状态；看板的“经验沉淀”属于 commit 后沉淀区，不增加创作阶段。

候选状态按 `proposed → evidencing → reviewing → promoted / rolled-back / rejected` 流转。`afterText` 的 JSON 对象被视为 execution-point patch，历史普通文本兼容映射为 drafting；新 learning 候选必须从目标 Skill 声明的 execution point 中选择与失败层相符且会实际执行的 key。实验隔离库和正式晋升都把 patch 合并到现有 `prompt_sections`，不会删除未被 patch 覆盖的执行点。`system-prompt` 仍使用完整文本，rollback 使用候选保存的完整 beforeText。`POST /v2/projects/:projectId/craft-rule-candidates/:candidateId/experiment`（也兼容 body `operation=experiment`）从当前正式快照创建独立 Postgres schema；原失败章节由候选的 learning assessment provenance 唯一反查，调用方只能选择异构章节。before/after 分别调用正式章节生命周期，候选通过条件是其具体规则文本指纹出现在 prompt execution 的已包含 Skill section 中，而不是只出现 proposed Skill 版本号；原失败章节和异构章节都通过后才可作者审核。作者审核通过后才允许原子更新 `skill_definitions` 或 `prompt_templates`，晋升在事务内锁定并校验目标版本，rollback 只允许恢复仍保持晋升版本的目标；目标版本漂移、规则未进入实际执行点、回归失败或作者拒绝均保持正式版本不变并留下证据。

章节实验复用 `executeChapterReviewExperiment` 及正式 review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters 链路，不调用独立离线修订器。现有历史候选原样保留；没有章节实际消费点的 `system-prompt` 候选必须先补齐消费点，不能用基础任务评分冒充章节回归。

## 8. 已定稿章节重审

已定稿章节重审入口仍是 chapterReviewWorkflow，从 review 阶段半截启动并复用正式 review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters activity。入口要求 document.status=final、无活跃 workflow 和历史 blueprint artifact；正文包装为 draft artifact，复用历史 blueprint structuredData 的兼容部分，但新审核只读取当前执行合同。该入口用于正文局部不完美，不用于修复卷级状态、长线责任、人物终点或世界规则边界；后者必须回到 Foundation 审计和 Story Arc rebase。

## 9. 兼容与审计

- 旧 Foundation task、旧章节字段、旧 dimensionScores、旧 review 记录和旧 reflection artifact 原样保留；
- 新 API、repository、workflow 和 active task 列表只生成五阶段、三 reviewer 的活动结构；
- 数据迁移不重写历史正文或审核记录；
- artifact、revision、fingerprint、source provenance、结构 schema、证据和 workflow gate 始终保留；
- architecture health、批次区间审计和引用解析只增加可追溯诊断，不把软创作偏好升级为硬门；
- 任何 prompt 示例都必须描述通用叙事机制，不得以标题、角色、章节号或特定短语作为产品契约。

## 10. 维护清单

章节修订将已批准/episodic 事实作为 required，背景记忆和 narrative rhythm 作为可按预算淘汰的 normal/soft sections；`sourceArtifactId` 只用于 provenance，不用于语义去重。未知 Skill execution point 保留诊断并阻断实际 resolution。

修改 Foundation 阶段、ChapterBlueprint、ScenarioProfile、Skill execution point、reviewer role、commit gate、fact extraction、learning assessment、craft-rule candidate 或 promotion contract 时，同步更新：

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
