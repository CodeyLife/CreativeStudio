# Novel V2 小说创作工作流

> 当前活动契约：2026-08-04。本文以源码和当前 workflow 行为为准；历史 artifact、已完成旧审校记录和旧 reflection 数据只读保留，不被新运行消费；不兼容的活跃审核运行可直接终止并废弃未提交候选。

运行数据卷、仓库更名后的恢复步骤、正式审校边界和质量 A/B 产物契约见 [data-recovery-quality-validation.md](./data-recovery-quality-validation.md)。混合开发模式使用稳定命名的 `creative_studio_novel_*` 卷；卷不存在时由 Compose 创建，不能通过切换到另一组卷来伪造空库。全 Docker profile 使用隔离的 `creative_studio_container_*` 卷，不连接混合模式当前数据。

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

provider 端 `foundationSchema` 只校验 `structuredData` 是 JSON 文本字符串，无法表达 task 级容器键（如 `architecture` / `worldview`）。`structuredData` 根形态采用平铺契约：对象型 task（project-positioning / architecture / worldview / plot-design / plot-threads / timeline / story-control）的根直接承载 task 数据，不再包一层与 task 同名的容器键；数组型 task（characters / relations / foreshadowings）的数据本质是数组，但 `structuredData` 根必须是对象，因此保留 `{ [collectionKey]: [...] }` 集合容器（provider 与解析层都要求根为对象）。`normalizeFoundationModelOutput(value, taskKey)` 在最低共享层做形态归一：对象型 task 根含 `dataRoot` 容器键（历史容器或模型遵守旧契约）时解包为平铺，已平铺则保持不变；数组型 task 保持集合容器。判定基于纯结构特征（dataRoot 键与 schema type），跨 provider/题材复用；根是其他 task 容器或内容确实缺失时不误解包，契约校验仍如实报告，避免掩盖内容问题。该归一化在生成与 external-mcp 物化两条路径同时生效，保证落库 artifact 始终是规范平铺形态，历史容器数据在读取侧（全书审计、书名读取）同样被解包。

### 2.1 角色身份与展示投影

Foundation `characters[]` 中的 `id` 是项目内规范人物 ID，`name` 是作者可读的展示名。`entities.id` 只保存稳定关联键，`entities.name` 与 `payload.displayName` 保存展示名；角色富化和关系写入必须先通过项目内身份映射解析规范 ID、中文/原文名称和实体 ID，不能把模型返回的稳定 ID直接当作展示名。已有 Foundation 映射优先于自然语言别名，未知的关系目标创建为 `pendingEnrichment=true` 的待补全实体，不推断或伪造正式角色名。知识工作台读取角色时合并 Foundation 基线与实体增量，展示名优先，规范 ID 只作为可追溯副信息。

### 2.2 全书架构审计与正文审校分层

全书架构审计发生在 Foundation 与 Story Arc 之间，审计对象是跨阶段结构数据，不是当前章节正文。`auditFullBookArchitecture` 只检查以下共享契约：

- architecture：每卷的入口状态、阶段压力、退出状态和承诺窗口；
- characters：重要人物的限制/恐惧、独立行动与选择代价；
- worldview：规则陈述、调用代价和不可越过的边界；可选资源/技术分配（resourcesAndTechnology）与价值/冲突（valuesAndConflicts）压力层；
- plot-design：人物终点引用、长线阶段责任/下一次推进和信息边界。

长线（longHorizonThreads）可携带可选的 `coupling`（与主线的耦合机制：改变人物选择/资源/认知/关系/世界规则之一）和 `mergePoint`/`exitPoint`/`transformPoint`（交汇/退出/转化条件）。缺方向、结局、阶段责任等必需契约仍产生 major；只缺耦合机制或生命周期条件的线产生 `long-horizon-thread-coupling-incomplete` warning，不阻断审批，旧数据不因缺少这些可选字段失效。`architecture.structureType` 是可选的 `linear | tree | network` 枚举，只描述结构与承诺的匹配理由，不作为质量门。

故事弧只持久化 `threadResponsibilities`，每条责任的 `threadRef` 同时承担剧情线引用和本弧的下一次可验证推进条件。不存在可独立维护的 `plotThreadRefs` 名单；暂缓的剧情线可以记录保持/观察责任，不把长线变成逐章兑现清单。

重基线 envelope 携带符合当前契约的 `approvedArc`、历史章节提交包和事实证据。章节冻结权威仍来自章节提交包、`chapterMemory` 和事实证据。缺少可验证责任的旧弧在迁移中标记为 stale，不能由运行时静默推断或投影为新契约，必须重新生成并审核故事弧。

审计报告以 `fullBookArchitecture` 独立返回，保留 volumeCount、estimatedChapterCount、characterCount、longHorizonThreadCount 和结构问题列表；缺少或为空的 architecture.volumes、characters.characters、worldview.rules、plotStrategy.characterDestinations 或 plotStrategy.longHorizonThreads 会产生 major。卷级 `promiseWindows` 除数组存在性检查外，还做内容软诊断：条目缺少可解析引用（promiseRef/id/description）或阶段窗口（windowOrdinals/window/payoffWindow）时报告 `promise-window-ungrounded` warning，不阻断审批。它不读取正文质量分，也不要求每章出现事件、钩子、反转、主题、感情或幽默。`architecture/health.issues` 继续负责批次重叠、已提交剧情线和伏笔引用等硬完整性问题。

两类问题的处理入口不同：Foundation 契约缺失先修 Foundation 并使受影响故事弧 stale，再通过弧级 rebase 重新编译阶段计划。rebase 先严格校验新候选，再覆盖已提交章节的冻结蓝图；历史章节以 `revisionId` 或 `chapterMemory` 的生命周期身份识别为冻结权威，不依赖新旧 JSON 完全相等。只有当架构契约已经成立、问题仍具体表现为当前段落的场景因果、视角、人物行为或语言时，才进入 `chapterReviewWorkflow`。章节正文审校不能替代全书架构审计。

Foundation 审核（`foundation.book-plan` 执行点，`foundation-reviewer` 角色）在既有契约完整性、层级因果、多线耦合与不确定性检查之外，以目标读者视角加查十项基线（由 `review-gate` Skill 与 foundation-review prompt 共同承载）：承诺可兑现（卖点是可体验的冲突组合而非名词堆）、主题进入选择（主题落在人物利益/关系/责任/代价的具体选择上）、欲望-阻力-选择-代价闭环、配角独立欲望与关系网络、世界观规则改变人物可选集合（删掉设定名词后选择是否不变）、感情线靠行动累积而非宣言、重复与升级是否改变层级/意义/代价、读者不确定性是否有可推断证据、表层大众化（卷名/章节名/概念与术语命名面向大众读者，专业概念出现在表面时须转译且全篇同译名）、揭示物分层（核心创意与世界观真相是剧情揭示物而非开篇设定，规划区分世界表面事实/异常现象/底层真相，删除真相后开局仍须成立）。十项是检查方向与证据类型，不是必须全部成立的硬门：按当前 taskKey 的适用性选择，不适用项跳过，不因缺少某项扣分，只有缺失确实损害已承诺功能时才产出审核意见并驱动修订。审核仍不要求每章事件、钩子、反转、主题、感情或幽默，也不通过增加固定章节数量、固定爽点密度或强制感情线来修复问题。

规划级审核（Foundation 与 Story Arc）采用文本意见契约（`src/novel-v2/text-review.ts`）：通过时模型只输出单行 `PASSED`，不通过时输出可执行审核意见全文，意见本身即「不通过」信号；verdict 只保留 `passed`/`revise` 二值，不再有 `blocked`。设计依据：规划级审核产出本质是指导意见，强结构化枚举（维度分数、逐章校验账本、authorityChecks）依赖 provider 真正执行 strict json_schema，第三方中转站可能忽略该字段导致模型自由发挥、修复循环仍失败；文本契约对任何 provider 零依赖。审核不通过时，意见作为重新生成的 `instruction` 回流（Foundation 经 `reviseWork` 写入 work item instruction 由 `buildFoundationPrompt` 消费；Story Arc 经 `buildStoryArcRevisionPrompt` 注入修订 prompt），learning 评估以同一意见为输入。解析基于结构特征（单行标记/围栏剥离），跨题材与模型复用。

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

删除的章节级编辑字段包括 summary、chapterPurpose、readerExperience、thematicTreatment、romanceTreatment、humorTreatment、dramaticQuestion、emotionalMovement、stateDeltaBudget、narrativeScale、optionalBeats、setupRefs、payoffRefs、closingForce、freedom、participantStakes，以及旧版 goal/turn。041 迁移清理这些 JSONB 字段，新的生成、编辑和正文 prompt 只读取 `chapters.payload` 的 canonical blueprint。

Story Arc 审核只检查状态连续、场景因果、事实权威、章节功能与长篇位置是否相容：审核 prompt 要求按整弧与逐章清单完整覆盖（每章的状态连续、场景因果、章节功能、权威边界，整弧的阶段边界/窗口节奏/长篇层级），输出为文本意见而非结构化账本（见上文规划级审核文本契约）。它不要求每章新事件、外部压力、强钩子、反转、爽点、主题表达或不可逆变化；审核完整性不等于正文创作约束。

弧规划由 `story-arc-design` Skill 提供设计契约（execution points：arc.plan / arc.review / arc.revision / chapter.blueprint），把弧视为"一个读者问题被逐级回答并升级"的叙事单元而非章节状态序列。五项设计契约：问题阶梯（主线推进弧的核心读者问题在 development 中逐级被回答并升级）、压力类型轮换（连续同类压力必须升级规模、代价或牵连）、场景因果链（场景 outcome 成为下一场景 situation 的触发条件；不推动外部因果的场景必须承担关系温度/理解修正/余波承载或独立体验功能，否则视为赘余）、安静章功能（无外部事件章节必须让读者获得可感知的新东西——关系温度变化/风险判断改变/物品易主/理解修正/情绪确认/余波承载之一；确认规则的陈述若改变角色后续选择或风险判断即算功能）、不可逆出口（推进型弧 exitState 相对 entryState 至少一项不可逆变化；铺垫/过渡弧出口可稳定但须说明静态功能）。弧审核另加读者回报检查：本弧 entryState/objective 承诺的体验（解决问题、关系升温、世界揭秘、认知落差、情绪确认）是否在 exitState 与 development 中真正交付；弧结束时读者只经历过程而无解决、成长、理解、情绪或新问题中的任何回报时报告为节奏问题，安静弧的回报可以是理解修正或关系温度。这些契约是弧级检查方向与证据类型，不是必须全部成立的硬门：安静、关系、背景、铺垫和余波弧与行动弧同样合法，只要功能有可感知证据；只有契约缺失且确实损害本弧承诺功能时才按 major 报告。规划 prompt 同步承载同一契约的压缩表述；章节级 quiet chapter 仍可通过关系温度、理解、信息分布、情绪或余波完成功能，不必被改造成冲突升级。

**外部编排模式（模式 B）**：故事弧规划另有外部编排入口 `novel_story_arc_orchestrate`，由外部大模型或用户提供剧情编排（plotOutline：objective 必填，其余为弧级设计意图——entryState/centralConflict/development/resolution/exitState/threadResponsibilities/expectedChapterCount/phases/chapterHints/plotNotes），系统负责完善：把编排作为 `arc-context-plot-outline` required section 注入 arc.plan / chapter.blueprint / arc.review / arc.revision 执行点，对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、连续性约束与责任承接，再走正式弧审核 → 修订闭环。编排是设计意图基线，权威低于已定稿事实、叙事状态账本与作者边界：冲突时以事实为准，不得为了贴合编排虚构事实、提前消费后续答案或改写人物知识边界；空编排（只有 objective）被拒绝，提示改用普通模式。编排输入持久化在 `workflow_runs.payload.plotOutline`（`arcs.payload` 在项目蓝图投影时会被 bundle.arc 覆盖，不能作为编排持久化位置），并写入蓝图 artifact structuredData 提供 provenance；后续批次与审校通过 `getStoryArcPlanningInput(projectId, arcId)` 按弧精确读取同一份编排。外部任务降级路径在 contextRefs 中携带 outlineJson，物化时写回 artifact。编排含 threadResponsibilities 时沿用 threadRef/responsibility/nextAdvance 契约，未解析引用仍按提交边界阻止批准。

审核 pass 之间相互隔离，并受 `NOVEL_ARC_REVIEW_PASS_TIMEOUT_MS` 的单 pass 超时预算约束（默认 120000ms；TODO：迁入持久化模型路由合同）。单个 provider、视角或结构结果失败时记录丢弃视角元数据；若仍有完整审核结果则继续聚合，只有零个完整结果才失败。已有 blueprint 的失败弧仅在匹配的 `awaiting-review` 批次仍存在时，通过正式 retry 状态转换重新进入审核，不重新生成 blueprint；MCP 通过 `novel_story_arc_review` 暴露这一恢复入口，客户端不能用“启动下一故事弧”替代失败弧恢复。若当前弧已有前批次定稿章节但还存在待审核的后续批次，审核只针对该新增批次走普通审核路径；只有没有待审核批次且审核对象确实覆盖已提交章节时，才进入冻结历史 rebase，避免把前批次位置误套到后续批次。

故事弧规划、审核和下一批次入口在同一项目/故事弧范围内持有 PostgreSQL advisory lock，锁覆盖状态检查、workflow_runs 登记和 Temporal 启动，避免重复请求绕过状态检查并产生并行工作流。入口在状态变更或 Temporal 启动失败时把已登记运行标记为 failed，并通过正式恢复状态转换回收 generating 故事弧或 generating 批次；锁只保护 admission，不替代工作流自身的状态机。放弃故事弧也在同一锁内读取活动运行，先持久化弧的 abandoned 状态，再取消对应 Temporal workflow、标记运行 cancelled 并过期其外部模型任务；取消失败只保留警告，不阻塞故事弧的本地放弃。

已批准且仍在执行的故事弧按批次继续规划；MCP `novel_story_arc_batch_start` 先通过 `prepareNextStoryArcBatch` 分配不重叠的下一章节区间，再复用同一套故事弧规划、审核、修订和提交工作流。若模型服务失败，调用方必须以 `retryFailed=true` 走同一工具的正式重试状态转换；`prepareStoryArcBatchRetry` 只恢复没有章节投影的最近失败批次，并保留失败原因和重试审计，不创建伪造的后续批次。它不绕过当前弧的 `exitState`、已定稿章节冻结和批次完整性校验，也不允许客户端直接伪造下一批章节蓝图。

故事弧模型 activity 的 Temporal 重试上限为 1，因为一次 activity 内的 gateway 已按 routing snapshot 完成候选切换和失败审计；activity 级重复会再次消耗全部候选并掩盖“路由耗尽”的终态。失败批次不会自动伪造新窗口，作者/客户端必须通过 `retryFailed=true` 显式恢复，确保重试有边界且可追溯。

审核 prompt 还对相邻章节的持续状态做通用反向核对：物件、伤势、资源、关系、知识和限制的身份变化必须有可验证的丢失、转移、消耗、恢复或新证据。对未知物质、装置、痕迹或局部反应，湿度、颜色、气味、声音、光亮或接触变化只能支持当下现象，不能单凭一次反应推出用途、成分、机制或功能；越过这条边界的蓝图主张必须在审核意见中明确指出并要求修订保留未知状态。故事弧按批次滚动审核；未完成批次不要求当前章节证明未来 `exitState`，弧级审核检查的是当前窗口与阶段边界、长线责任和后续空间是否相容。审核完整性（逐章覆盖、证据边界、确定性升级防越界）由审核 prompt 的检查清单要求模型逐项覆盖，不再以机器账本强制；审核意见中的问题必须引用实际蓝图字段或章节证据，并在修订中最小化修复。它是弧级状态契约，不是正文句式黑名单，也不将每个名词变成逐章必填项。

## 4. 上下文编译

ChapterPlanningContext 只保存：

- 当前章节执行合同和 artifact 引用；
- 当前章节状态边界、场景执行材料和连续性约束；
- 相邻章节的 narrativeFunction 与状态边界；
- fingerprint、source provenance 和必要的事实投影。

它不保存完整宏观规划 payload。正文阶段通过 memory claims 获取冻结事实，不通过蓝图重复注入世界观、主题和人物标签。draft、review、revision 共用 renderChapterExecutionContract，避免三套 prompt 对同一蓝图各自解释。

章节工作区的 `chapter_production_specs` 只保存作者明确输入的 `chapter_goal`；蓝图、来源 artifact 和指纹统一从 `chapters.payload` 及其来源 artifact 投影。`NarrativeStateSnapshot` 只保存弧阶段、开放线程、伏笔、承诺、兑现节点和提前消费边界；summary、keyEvents、characterStates 只由 `ChapterMemory` 持有。开放伏笔记录可携带 readerQuestion、possiblePayoffs、meaningDelta、cost 四个可选规划字段（缺失按未指定处理，不作为逐章必填），供故事弧把兑现方向与代价作为可排序候选；这些字段来自 fact-extraction 的结构化提取，属于设计态而非叙事事实。

NarrativeRhythmEntry 只保留 documentId、revisionId、narrativeOrder、title、narrativeFunction。summary、keyEvents、emotionalArc、主题字段和 issue families 不再作为章节节奏输入。

跨章序列证据（`SerialContextSnapshot`，`MemoryBundle.serialContext`）把最近 N=6 章的结构化统计投影给 draft/review/revision/learning，弥补单章审核结构上看不见跨章模式的问题（状态等幅重述、连续同功能章节、物件/主题跨度）。它由 `getSerialContextSnapshot` 确定性计算（无 LLM），只输出描述性统计信号，不输出短语黑名单："角色状态跨度"来自各章最新 `ChapterMemory.characterStates`，"连续同类功能"来自 `chapters.payload.narrativeFunction` 的连续游程（≥3），"物件/主题跨度"来自 memory_claims 中出现在 ≥2 个窗口章节的 subject_refs。"母题还是疲劳"的判断（重复必须改变层级/意义/代价）由 reviewer 依正文证据作出；窗口与游程阈值为魔法值，标注 TODO 可配置意图。该投影与 narrative rhythm 同级（priority=normal，可被预算淘汰），不影响事实可靠性边界。

上下文编译仍保留 required/normal/critical 优先级、输入预算、manifest、prompt fingerprint、source artifact id、Skill provenance 和可审计排除记录。事实、人物知识边界、当前 POV、起始状态、结束状态和场景因果是可靠性边界；文学偏好不转成必填字段。记忆选择区分两层：叙事状态账本和 required facet 是当前阶段的硬上下文，开放伏笔/承诺是可排序候选；它们仍可被检索和回收，但不会因为“开放”就全部挤占 pinned 预算或把局部正文变成清单执行。

文风契约（`style_contracts` 表）是书级、可版本的叙述声音约束：十维滑杆（POV、叙述距离、时间方式、句式节奏、词汇层级、感官重心、比喻密度、对白比例、留白程度、叙述态度）以 JSONB 按版本保存，同一项目至多一个 `active` 版本。draft/review/revision 通过 retrieveMemory 读取 active 契约，作为 `style` facet 的可排序候选注入（ranked-fill，可被预算淘汰，不冻结）。契约是 prose-reviewer 与写作者的对照参考基线，不强制每章逐维满足，也不把任何取值变成质量门；缺失维度按未指定处理，旧项目无契约时静默降级。

Story Arc 的规划输入使用结构化反馈投影，而不是把 narrative state 原样 JSON 倾倒给模型。投影包括开放剧情线 payload、开放伏笔/承诺的规范 ID、最近定稿章节状态和与规划/连续性/因果相关的 RuntimeLearning underlyingMechanism、affectedInputClass、边界。模型输出契约不再包含 `authorIntent`、`thematicQuestions` 或 `phases[].exitCondition`；`authorIntent` 只作为请求上下文参与规划。review/revision 使用独立的 context sections，并在 manifest 中记录 `narrativeCutoff`、来源 artifact/revision、section fingerprint 和总 fingerprint；旧 planning 数据标为 legacy provenance。反馈只提示共享机制风险，已定稿事实、叙事账本和作者边界仍具有更高权威，开放线索也不等于本批次必须兑现的事件。

模型请求的结构化契约由 gateway transport 统一投影：Responses 使用 `text.format`，Chat Completions 使用 `response_format.json_schema`。发送前的 native schema 预检拒绝 optional properties、动态或空 object、`additionalProperties: true` 及 `anyOf/allOf/oneOf` 等不稳定组合关键字；失败分类为 schema incompatibility，只切换下一个原生候选或外部 MCP。Schema 不再注入 prompt，所有返回仍经过同一 AJV、业务语义校验和修复循环。故事弧规划拆为 arc+batch 与 chapters 两个原生请求，只有两段均完成并通过业务校验后才组装并创建 artifact；draft、review、revision 统一使用 `StagePromptPackage`，三个 reviewer 并行启动。

`model_invocations` 同时保存 provider input/output tokens 与 provider 返回的 cached input tokens（若供应商提供）；没有 provider 用量时仍保留估算值并标记 `usage_source`，不把估算值伪装成真实计费数据。每次调用还保存 `config_revision`，章节审校和故事弧工作流都在进入模型阶段前冻结 `routingSnapshot.id` 并写入运行 payload；因此可以区分“当前配置”与已启动运行使用的“历史路由快照”。路由解析优先使用显式 purpose（如 `review.structure`），再回退到同前缀通配路由（如 `review.*`），最后才回退到 `*`；设置页必须显示解析来源和快照短 ID。provider 能力探测会临时固定单个 provider，只证明该 provider 的传输/协议契约，不代表真实候选链的顺序或 fallback 结果。候选链表示有序尝试计划，实际 provider/model 必须以调用审计为准；一次成功请求或最终失败前，网关可能已经按候选序号逐个留下失败记录。每次失败调用还保存 `provider_label`、`error_category` 和截断后的 `error_message`，总览通过 `/v2/projects/:projectId/model-invocation-errors?limit=50` 展示该项目最近 50 条失败，按 `created_at DESC,id DESC` 排序；工作流页通过 `/v2/runs/:workflowId/model-invocations` 展示该次运行的实际 provider/model/protocol、候选序号、状态和路由快照短 ID，不再从当前配置反推历史请求。`workflowId` 是数据库/Temporal 工作流标识，Temporal `runId` 只是一次执行尝试，不能混用；历史记录若没有响应正文，只显示“历史记录未保存 provider 返回正文”的明确占位说明。
事实抽取的模型契约顶层只返回 `facts` 与 `narrativeElements`；事实对象的 `value` 始终是字符串，数字、布尔值和 JSON 通过规范化 JSON 文本传输，再由应用层按 `object.kind` 解码。`ChapterMemory` 与角色富化继续使用独立流程，章节状态快照不再复制摘要、事件和角色状态。模型路由耗尽错误同时登记 `NonRetryableModelTransportError` 与其可能的 Temporal 序列化类型 `ModelTransportError`，确保运行进入失败/人工可见状态而不是长时间停留在 `running`。

### 架构体检与引用边界

`GET /v2/projects/:projectId/architecture/health` 是只读诊断入口。它汇总 Foundation 批准状态、故事弧批次区间、章节定稿状态，以及剧情线/伏笔引用的规范 ID、兼容别名、未知项和歧义项；同时返回独立的 `fullBookArchitecture` 结构审计。章节 `planned` 表示蓝图尚未关联正文，或已关联但正文仍为 planned；`orphaned` 只表示无故事弧、关联正文不存在，或已批准故事弧仍缺正文。审批前故事弧下的正常蓝图不计为 orphaned。诊断不会改变正文或章节蓝图。

章节生命周期有两个持久化投影，但权威只有一处：`manuscript_documents.status='final'` 且存在 `current_revision_id` 表示正文已经定稿；`chapters.status` 是故事弧查询和规划索引使用的反规范化标记。正文 commit、手工保存、版本恢复都必须在同一事务中把关联 `chapters.status` 回填为 `final`；故事弧重基线不得让受保护的已定稿章节回退为 `planned`。读取 Story Arc 时还要从关联 manuscript 投影出 `final`，作为历史脏数据和失败重基线的防御性兜底。迁移 `037_chapter_status_projection.sql` 修复章节状态不一致，迁移 `039_story_arc_completion_projection.sql` 修复“最后批次已完成且所有章节已定稿、但故事弧仍为 active”的生命周期投影，迁移 `040_story_arc_completion_projection_failed_attempts.sql` 进一步处理后续失败尝试覆盖已批准完成批次的情况；完成判定必须排除未关联或无当前 revision 的章节，并允许最后批准批次的 `endChapterIndex` 已覆盖 `expectedChapterCount` 时修正模型遗漏的 `complete=false`。生成入口以 `manuscript_documents` 的正文状态决定是否可生成，不能仅依据蓝图状态；MCP、HTTP `/v2/intents` 与 `novelIntentWorkflow` 统一调用 `assertChapterGenerationAllowed`，定稿章节必须转入 `chapterReviewWorkflow`，不得创建新的生成工作流。

历史 schema 收敛由 append-only migration 完成：可验证的旧 artifact 映射为 `review` 或 `chapter-blueprint`，无法判定的记录失效；旧活动 workflow 标记为 `needs-restart`，缺少责任契约的故事弧标记为 `stale`。运行时的 `normalize-references` 只处理当前 `threadResponsibilities` 和伏笔规范引用，遇到已删除的 `plotThreadRefs` 直接拒绝，不再提供旧字段兼容读取。

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
| prose-reviewer | independent | chapter.review.prose | 场景体验、语言、节奏、具体性、情绪和幽默；识别专业化/制度化/理论化抽象表达替代现场感的情况 |

schema 只要求：

~~~text
verdict
score: 0-5
issues[]
~~~

issue 保留 severity、title、description、excerpt/evidence、revisionRanges、rule、suggestion，以及可选 paragraph/sourceId。审核记录保留模型提供的审校说明，不再把 excerpt/evidence 与当前正文做逐字匹配或作为丢弃条件；当前 artifact fingerprint 和最小修改范围仍用于审计与修订边界。不强制 rewriteExample，不强制 14 维度逐项评分。

REVIEW_COVERAGE 只作为内部完整性映射，覆盖 D1 世界观、D2 故事性、D3 群像、D4 感情线、D5 幽默；这些维度不是模型必须逐项填充的输出字段。

三个 reviewer 的职责在注入「跨章序列证据」（`serial-context` section）时扩展跨章机制检查，但只报告有序列证据与正文共同支持的问题，不把单个安静章、单次状态保持或母题式重复当作问题：structure-reviewer 检查连续同类功能章节（≥3）是否缺少压力推进或回报，以及同一状态/物件跨章以相近措辞重述且无恶化/愈合/消耗/转移等可观察增量时的状态重述；character-reviewer 检查同一配角连续多章仅以功能声部出现（无独立欲望、关系、秘密、工作或代价增量）时的群像单薄；prose-reviewer 把技术认知删除测试扩展为跨章重复命名——同一抽象命名（技术/制度比喻）跨章重复出现且本次未承担新选择/新因果/新世界观信息时报告，不因单个陌生术语重复报告。这些检查是机制描述，不嵌任何词表、角色名或题材样本。

commit gate 仍要求三个 reviewer 针对当前 artifact，三个 verdict 均 passed，结构检查通过，不存在 blocker/major，且满足总体分数和局部 reviewer 分数守卫。局部退化上限与整体改善阈值用于质量回退保护，不用于规定文学内容。

审校 issue 落库时对 evidence 做正文包含性软校验（`isEvidencePresentInText`）：evidence 在正文零命中（按省略号分段取最长连续片段匹配；省略号形态覆盖 U+2026 与 ASCII 点号）时，在 dimension 字段附 `evidence-unverified` 机器标记；不删除 issue、不改变指纹，供人工决策识别审校模型对指令示例词/修订前文本的回显误报。作者来源 issue 不做该校验。标记基于被审 artifact 自身的正文计算：内部审校路径传候选正文、外部 MCP 审校路径从被审 artifact 的 objectKey 解析正文、commit 后刷新快照时传提交正文。快照刷新是 DELETE 后全量重插，标记随每次刷新按当前正文重算；存储不可用（外部路径降级）或调用方未提供正文的刷新（如 backfill 只补建缺失快照、不触碰已有快照）不会保留既有标记——该降级仅影响软标记，不影响 issue 本身与指纹。

章节审校启动受项目级串行约束：同项目其他章节存在活跃 chapter-review 工作流时拒绝启动（并发审校会因前一个工作流 commit 提升项目基线导致本工作流提交失败）；preflight 返回 `projectActiveReviewWorkflowId` 供调用方识别。

## 7. 修订、事实与学习

修订以审核 issue 和 `revisionRanges` 为入口，只改变问题机制相关范围；`revisionRanges.start/end` 统一表示从 1 开始的正文段落编号，不接受字符或 token 偏移。issue 不因 excerpt/evidence 无法与正文逐字匹配而删除或跳过；无法形成安全局部窗口时按既有策略转为整章修订或报告契约错误。定向修订只执行一次，不自动把完整审核中的同机制问题扩展进作者选定范围；作者 issue 支持 `revisionRanges` 多段落数组（`paragraph` 与 `revisionRanges` 二选一），同机制多处必须一次覆盖全部位置，避免只修首段导致同一问题反复残留。章节规划的 `unresolvedAtClose` 是冻结未解边界，局部修订不得删除、回答或合并其中的问题，只能在保留未解状态的前提下具象化表达。修订契约允许保留人物的专业认知声部，但当抽象术语连续替代身体、环境或即时判断时，要求把重复解释收束为可观察依据，不通过同义术语替换制造表面修复。`sanitizeRevisionOutput` 使用代码围栏、标题行、冒号前缀等结构特征清理元注释，不使用 prompt 短语黑名单；它只折叠相邻的完全重复段落，保留非连续复沓和有实际变化的重复，避免误伤正常修辞。窗口应用层（`applyRevisionWindows`）额外做替换边界重复检测：修订模型把相邻原文段落复制进替换文本时（整段完全重复，或"前邻段全文 + 追加"的前缀复制），在应用窗口时剔除，防止修订拼接产生硬重复段。

章节执行合同版本 `reader-grounded-v1` 将规划器内部分析与写作者执行材料分离。场景蓝图可选的 `planningRationale` 在完整蓝图和规划上下文读取投影中保留，但不进入正文 draft、prose review 或 revision；执行投影只包含处境、可观察行动、阻力、选择、结果和代价。三处章节 prompt 共用读者复原契约：技术认知不能成为当前动作的唯一主语、原因或结果；同一局部节拍中重复命名同一体验的标签应删去多余部分；删掉技术句后事实、选择和因果都不变时，不保留它。身体危机和动作场景先让必要的身体或物理反应成立，再让技术判断服务下一步选择。该边界不使用术语、句长或抽象词数量判定失败。`ReviewIssue.readerReconstruction` 保存 `impact`、缺失证据类型和 blocked question；它不参与 issue 身份指纹，历史 issue 缺少该字段时按 null 处理并继承既有状态。

当同一轮修订可以定位到多个彼此分离的安全窗口时，内部 API 路径使用一次 `targetedRevisionBatchSchema` 结构化调用，把冻结事实、章节规划、Skill 和修订契约作为共享上下文只注入一次；每个窗口仍独立保留前后邻段、审核证据和原章段号。单窗口继续使用局部文本调用；批量上下文无法通过现有输入预算，或批量结果缺失、越界、重复、漏项、空修改时回退到逐窗口调用。外部 MCP 使用相同 schema 和业务校验，只有完整结果通过后才创建 artifact，避免 token 优化改变修订边界。

commit 前仍执行事实提取和 novelty 去重。commit 使用当前 artifact、revision 和 source provenance 更新正文、事实和 chapter memory。成功章节只在 commit/enrich 后生成一次 RuntimeLearningAssessment；质量门失败的终态尝试可保留一次失败证据，事实审批挂起不创建候选。若同一 assessment 因模型重试或 execution-point 校验回退为 `no-shared-learning`，仅清理其仍处于 `proposed` 的未审核候选；已进入 evidencing/reviewing 或已晋升的候选保留审计轨迹，避免 assessment 与候选状态分叉。propose-improvement 必须记录 underlyingMechanism、affectedInputClass、边界和回归风险。

learning 评估输入在每章 commit 后聚合跨章模式（持续模式证据），不只分析当前章 issue：`getRecentReviewIssueClusters` 按 rule/title 聚类近 N=6 章的章节审核 issue（同规则类出现 ≥2 章即构成持续模式），并注入 `serialContext` 序列信号。`serialContext` 查询的 documentId 必须由调用方透传（章节生成取 `intent.target.id`，章节审校取 `params.documentId`），不能使用 artifact 的 taskId——taskId 形如 `blueprint:<intent-uuid>:draft`，与 `chapters.document_id` 永不匹配，会导致序列信号恒空；documentId 缺失时跳过查询而不是发起必然为空的查询。决策规则扩展：同 rule 类近 N 章出现 ≥2 次，或连续同类功能章节缺少压力推进时，即使当前章无 blocker/major 也触发 propose-improvement 评估；单章偶发且序列信号无持续证据则 no-shared-learning。状态/主题跨度（characterSpans/subjectSpans）只作为有 issue 时的持续模式证据注入 prompt，不参与零 issue 触发——它们只是"同一角色/物件在窗口内出现 ≥2 章"的在场统计，POV 主角与核心物件在长篇中段必然满足，作为触发信号会让零 issue 短路径恒真失效。连续低行动/观察型章节密度类问题，failingLayer 优先定位到 story-arc planning 层，candidate 指向规划类 skill 的 planning 执行点（或规划相关 system-prompt），而不是只修 drafting——根因在规划批准了被动功能序列，正文修订只能事后补救。

伏笔/承诺兑现优先使用 fact-extraction 提取阶段可见的 `matchedForeshadowingIds` / `matchedPromiseId` 精确关联。兼容旧输出时，关键词或承诺者只在恰好命中一个仍开放、且处于叙事截止点之前的对象时自动兑现；多候选只保留未关联记录，不猜测关闭对象。这样既保留旧 artifact 的可读性，也避免同名角色或共享关键词造成错误回收。

Learning assessment 与 skill iteration 是两个不同的边界：assessment 只分析机制并创建 `craft_rule_candidate`，不直接改正式 skill，也不自动运行 `runSkillIteration`。项目级 learning 查询同时返回 assessment、来源章节、候选目标和候选状态；看板的“经验沉淀”属于 commit 后沉淀区，不增加创作阶段。

skill iteration 的触发门禁与 learning 打通：存在 blocker/major issue，或 learning assessment 判定 `propose-improvement`（含仅由跨章模式触发、当前章无 blocker/major 的情况）时都会运行迭代；两者都没有时跳过。这样 learning 提出的改进不会停在候选队列，跨章模式聚合的 propose-improvement 能实际进入 skill 迭代。

候选状态按 `proposed → evidencing → reviewing → promoted / rolled-back / rejected` 流转。`afterText` 的 JSON 对象被视为 execution-point patch，历史普通文本兼容映射为 drafting；新 learning 候选必须从目标 Skill 声明的 execution point 中选择与失败层相符且会实际执行的 key。实验隔离库和正式晋升都把 patch 合并到现有 `prompt_sections`，不会删除未被 patch 覆盖的执行点。`system-prompt` 仍使用完整文本，rollback 使用候选保存的完整 beforeText。`POST /v2/projects/:projectId/craft-rule-candidates/:candidateId/experiment`（也兼容 body `operation=experiment`）从当前正式快照创建独立 Postgres schema；原失败章节由候选的 learning assessment provenance 唯一反查，调用方只能选择异构章节。before/after 分别调用正式章节生命周期，候选通过条件是其具体规则文本指纹出现在 prompt execution 的已包含 Skill section 中，而不是只出现 proposed Skill 版本号；原失败章节和异构章节都通过后才可作者审核。作者审核通过后才允许原子更新 `skill_definitions` 或 `prompt_templates`，晋升在事务内锁定并校验目标版本，rollback 只允许恢复仍保持晋升版本的目标；目标版本漂移、规则未进入实际执行点、回归失败或作者拒绝均保持正式版本不变并留下证据。

章节实验复用 `executeChapterReviewExperiment` 及正式 review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters 链路，不调用独立离线修订器。已进入审核或晋升流程的历史候选保留；与回退为 `no-shared-learning` 的 assessment 绑定且仍未审核的孤儿候选直接丢弃。没有章节实际消费点的 `system-prompt` 候选必须先补齐消费点，不能用基础任务评分冒充章节回归。

## 8. 已定稿章节重审

已定稿章节重审入口仍是 chapterReviewWorkflow，从 review 阶段半截启动并复用正式 review → revise → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters activity。入口要求 document.status=final、无活跃 workflow 和历史 blueprint artifact；正文包装为 draft artifact，复用历史 blueprint structuredData 的兼容部分，但新审核只读取当前执行合同。该入口用于正文局部不完美，不用于修复卷级状态、长线责任、人物终点或世界规则边界；后者必须回到 Foundation 审计和 Story Arc rebase。

## 9. 兼容与审计

- 旧 Foundation task、旧章节字段、旧 dimensionScores 和旧 reflection artifact 可作为审计历史保留；旧 review 记录不作为新运行输入，不为不兼容的活跃 Temporal history 提供回放兼容，直接终止并将 workflow_runs 标记为 abandoned；
- 新 API、repository、workflow 和 active task 列表只生成五阶段、三 reviewer 的活动结构；
- 数据迁移不重写历史正文或已完成审核证据；不兼容的活动审核运行可丢弃其未提交候选，但不得删除或覆盖 manuscript_documents.current_revision_id 指向的定稿；
- artifact、revision、fingerprint、source provenance、结构 schema、证据和 workflow gate 始终保留；
- architecture health、批次区间审计和引用解析只增加可追溯诊断，不把软创作偏好升级为硬门；
- 任何 prompt 示例都必须描述通用叙事机制，不得以标题、角色、章节号或特定短语作为产品契约。

## 10. 维护清单
- 修改 Foundation 阶段、ChapterBlueprint、ScenarioProfile、Skill execution point、reviewer role、commit gate、fact extraction、learning assessment、craft-rule candidate 或 promotion contract 时，先同步协议、workflow、prompt、schema 和相关审计文档，再运行 lint、focused tests、doctor 与 smoke。

## 11. 运行环境与数据一致性契约

唯一标准启动命令是 `pnpm dev`：先等待 PostgreSQL、Temporal、Temporal UI、MinIO、Qdrant，再等待迁移审计、API `/ready`、Worker `/ready`，最后启动 Vite。API、Worker、Vite、doctor 和迁移脚本都从统一运行时配置读取绝对项目根、迁移目录、模型配置路径、数据库、对象存储、Qdrant、Temporal namespace、Task Queue 和端口。

小说创作 MCP 服务器（`scripts/novel-v2-mcp-server.mjs`）默认走 stdio，兼容 OpenCode `type=local`；`--http [port]` 切换为 Streamable HTTP 常驻模式（默认 `NOVEL_MCP_HTTP_PORT`/7654，GET 用于健康检查、POST /mcp 是协议端点）。npm 唯一入口 `pnpm novel:mcp:v2`（`npm run novel:mcp:v2`），进程启动即通过 `loadRuntimeEnv` 把 `.env.example`（基线）+ `.env.local`（覆盖）+ 外层 shell（最高）合并注入 `process.env`，因此无论由 npm 脚本、OpenCode 直接 spawn（`opencode.json` 内 `mcp.novel-v2` 指向同一入口）还是命令行直连，运行时配置（DATABASE_URL、TEMPORAL_ADDRESS、模型 API key、NOVEL_*）都一致，不依赖外层 shell 预注入。模型 key 不在 `.env*` 明文时仍回退到 `config/model-providers.local.yaml` 的运行时覆盖。MCP 依赖 PostgreSQL、Temporal、MinIO、Qdrant 已就绪（由 `pnpm dev` 或 `docker compose -f docker-compose.v2.yml` 拉起），同类并发 MCP 进程会各自持有连接与 Temporal 客户端；本章节审核互斥等业务约束不受多客户端影响。

当前开发数据边界固定为 PostgreSQL 真源、MinIO/S3 正文对象、Qdrant 可重建索引、IndexedDB/localStorage 视觉工具/MCP 历史/界面偏好。工作流从 active 转为 terminal 后，Web 统一失效项目、运行列表、章节 workspace、正文、artifact、review、fact 和 learning 查询；活动运行统一轮询，终态执行一次完整读模型刷新。API/Worker 健康响应和请求响应头提供非敏感 runtime fingerprint，用于发现浏览器、API、Worker、数据库和对象存储不属于同一实例。

数据库迁移文件是已应用 SQL 的不可变历史。`pnpm novel:v2:migrations audit` 只读检查缺失、未知、重复/退休别名和 checksum 漂移；正常启动遇到未知历史或 checksum 漂移直接停止。当前数据库保留历史 `014_migrate_v1_skills.sql` 别名，`020_foreshadowing_narrative_order.sql` 只通过显式兼容性校验后归档当前 checksum。

章节修订将已批准/episodic 事实作为 required，背景记忆和 narrative rhythm 作为可按预算淘汰的 normal/soft sections；`sourceArtifactId` 只用于 provenance，不用于语义去重。未知 Skill execution point 保留诊断并阻断实际 resolution。

迁移源文件原则上保持已应用历史不变；确需修复已应用 SQL 的通用兼容行为时，必须在 migration-manifest.json 登记完整旧 checksum 和原因。017_migrate_v1_skills.sql 的 checksum alias 只兼容旧的覆盖式 seed，不把未声明的 checksum 漂移视为可接受历史。

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
