# Novel V2 当前流程审核

> 审核基线：2026-08-04。本文记录当前代码、prompt、schema 和 workflow 的活动契约；旧版本问题作为历史背景保留在版本控制中，不作为新运行规则。

数据连续性与文学质量证明是两个独立门禁：固定卷、正式工作流唯一入口和 prompt/Skill/artifact 追溯属于可靠性要求；只有真实跨场景 A/B 文本与工作流转换通过后，才能声称文学质量提升。恢复和盲评操作契约见 [data-recovery-quality-validation.md](./data-recovery-quality-validation.md)。

## 1. 结论

本次重构需要区分两类根因：正文质量下降主要来自编辑性字段、重复上下文和固定章节合规检查叠加；全书架构质量不足则来自 Foundation 只保存主题/功能摘要，未形成卷间状态、长线责任、人物能动性、规则代价和跨阶段引用契约。前一类才由正文 workflow 处理，后一类必须在 Foundation/Story Arc 层修复，不能用章节润色掩盖。

当前活动链路：

~~~text
5 Foundation
  -> Story Arc causal/state blueprint
  -> retrieval and context compilation
  -> draft
  -> structure / character / prose review
  -> targeted revision
  -> manuscript approval
  -> fact extraction and novelty dedupe
  -> commit and chapter memory
  -> learning and skill iteration
~~~

新运行不再有 reflection stage，也不再使用五角色 × 14 维度评分矩阵。

## 2. 阶段契约审核

### 2.1 Foundation

活动 taskKey：

- project-positioning
- architecture
- characters
- worldview
- plot-design

旧 relations、plot-threads、foreshadowing、timeline、story-control 已折入核心阶段的可选结构，不再独立生成、审核或计数。所有 Foundation artifact 仍有 source artifact、fingerprint、作者确认、stale 级联和审计记录。

### 2.1.1 当前全书架构审计契约

`GET /v2/projects/:projectId/architecture/health` 现在除基础完整性 `issues` 外，返回独立的 `fullBookArchitecture` 报告。该报告以结构数据为输入，诊断：

- 卷级 entryState、pressures、exitState、promiseWindows 是否完整；
- 重要人物是否有 fear/限制，以及 `independentAction.desire`、`choice`、`cost`、`knowledgeBoundary`；
- 每条世界规则是否同时有 statement、cost、boundary；
- characterDestinations 是否解析到唯一规范人物 ID；
- 长线是否有负责卷、下一次责任和交汇/退出/转化条件；
- hidden、notDesigned、open 信息是否被区分。

它不检查正文句式、章节长度、事件数量或文学风格。故事弧蓝图只通过 `threadResponsibilities[].threadRef` 承载剧情线引用、本弧责任和下一次可验证推进；这不是逐章兑现清单。架构问题的修复顺序是 Foundation 编辑/作者确认 → 活动 Story Arc rebase → 弧级审核；只有局部正文证据仍失败时，才进入正式 chapterReviewWorkflow。

重基线审校使用符合当前契约的 `approvedArc`、历史章节提交包和事实证据。旧批准记录若缺少 `threadResponsibilities`，迁移后标记为 stale，不能被运行时静默补全，需显式重新生成和审核。章节冻结证据仍由 revision、`chapterMemory` 和 authoritative facts 提供。

本次项目运行 `novel-create-wanfa-20260801` 的架构审计结果：6 卷、估计 670 章、6 名核心人物、3 条长线，`passed=true` 且结构问题为空。四个被补强的 Foundation section 已完成独立审核和作者确认；原有 6 个 final 章节未被该修复重写。迁移后的正式 rebase、Story Arc 审核与作者确认均已完成：当前 blueprint 为 `85957d3f-20c1-473e-bddb-a892d33767d5`，review artifact 为 `9855c6e0-e316-4bcc-a4b3-4ab2f96921f1`，弧级审核 `passed` 且无 blocking issue，当前弧为 `approved/active`。

弧级审核证据账本区分历史规划与当前架构：`frozenEvidence` 只说明历史批准蓝图的冻结边界，`candidateClaims` 由当前候选蓝图确定性投影，二者不是同一份正文快照；定稿事实以 `chapterMemory`、`authoritativeFacts` 和正文 revision 为权威。这样可以修正陈旧的章节规划而不把规划修正误报为正文修订，也不让模型回显动态路径的遗漏伪装成完整审核。

### 2.2 Story Arc

ChapterBlueprint 的活动字段：

- index、title、narrativeFunction、povCharacterId；
- stateTransition.before/after/evidence；
- scenes；
- continuityConstraints；
- unresolvedAtClose。

Scene 的活动字段：

- title、participants、situation、observableActions；
- 可为空的 opposition、decision、cost；
- outcome。

已删除的活动编辑字段包括章节 summary、readerExperience、thematicTreatment、romanceTreatment、humorTreatment、narrativeScale、固定开场/章尾力量、setup/payoff 引用和旧 goal/turn。历史 JSONB 不重写。

### 2.3 Context

ChapterPlanningContext 只投影当前执行合同、状态边界、场景执行信息、相邻章节边界和事实 provenance。它不把完整宏观规划重复塞入 draft/review/revision。

renderChapterExecutionContract 是 draft、review、revision 共享的单一蓝图解释器。NarrativeRhythmEntry 只保留 documentId、revisionId、narrativeOrder、title、narrativeFunction。

### 2.4 Draft

正文 prompt 的硬约束：

1. 只输出正文；
2. 遵守事实、POV 和人物知识边界；
3. 完成当前因果与状态合同；
4. 不回显指令或元注释；
5. 自然收束。

已移除固定字数、3000 字、最小段落、篇幅等级、固定钩子、强制新贡献、持续施压、逐章主题/感情/幽默/卖点要求。

### 2.5 Review

| role | identity | execution point |
| --- | --- | --- |
| structure-reviewer | internal | chapter.review.structure |
| character-reviewer | independent | chapter.review.character |
| prose-reviewer | independent | chapter.review.prose |

reviewer schema 只输出 verdict、score、issues。issue 必须有 evidence/excerpt 说明和 revisionRanges；evidence/excerpt 不与当前正文做逐字匹配校验，也不会因无法匹配而从审核结果中删除。rewriteExample、dimensionScores 和 applicableReviewDimensions 不再是活动输出。

REVIEW_COVERAGE 作为内部映射覆盖 D1 世界观、D2 故事性、D3 群像、D4 感情线、D5 幽默，但模型不被要求逐项填表。

跨章序列证据（`MemoryBundle.serialContext`）作为 planning section 注入 draft/review/revision（priority=normal，可被预算淘汰），只提供描述性统计（角色状态跨度、连续同功能游程 ≥3、物件/主题跨度），不是短语黑名单；"母题还是疲劳"由 reviewer 依正文证据判断。三个 reviewer 的 focus 扩展跨章机制检查（状态重述/节奏疲劳、群像单薄、跨章重复命名），全部以"有序列证据与正文共同支持才报告"为边界，不要求每章变化、不嵌词表。

### 2.6 Revision / Commit

修订以审核 evidence 和明确目标范围为入口，只修改目标范围；人物的专业化/制度化/理论化认知可以保留，但若连续抽象表达替代身体、环境或即时判断，修订必须回到可观察依据，而不是只替换术语。revision policy 保留：

章节蓝图把规划器分析与写作者执行材料分开：`planningRationale` 只保存技术模型、推演理由等作者侧内容，在完整蓝图和规划上下文读取投影中保留，但不进入 draft、prose review 或 revision 的执行合同。正文遵循读者复原契约，要求普通读者能从上下文复原当前经历、行动原因和行动结果，但不要求所有术语立即解释或所有段落使用同样的现场证据。读者复原问题通过现有 `prose-reviewer` 的 `readerReconstruction` 证据记录，不新增独立审核角色；该证据只用于诊断和修订，不改变 issue 稳定身份。

- blocker/major 阻断；
- 总体改善阈值；
- 单 reviewer 局部下降上限；
- 无 blocker 优先、同类最高分优先的最佳稿回退。

这些是质量回退保护，不是创作内容约束。commit 仍要求当前 artifact 的三个 reviewer、全部 passed、结构检查通过、没有 blocker/major，并更新正文、facts、chapter memory 和审计来源。

## 3. Reflection 删除核验

新代码中不存在：

- reflectOnDraft activity；
- runReflection workflow branch；
- chapter-reflection prompt/schema；
- reflection artifact 持久化或新运行读取；
- reflection 作为 commit 证据的兼容分支。

历史 reflection artifact 仍可作为只读数据存在，避免历史审计和回放数据损坏。

## 4. Learning 闭环核验

review/commit 后聚合 issue 模式为 RuntimeLearningAssessment。结论为 propose-improvement 时必须记录：

- underlyingMechanism；
- affectedInputClass；
- boundaries；
- regressionRisks；
- candidate scope。

learning 评估聚合跨章模式：`getRecentReviewIssueClusters` 按 rule/title 聚类近 N=6 章的章节审核 issue（同规则类 ≥2 章），并注入 `serialContext` 序列信号。同 rule 类近 N 章重复 ≥2 次，或连续同类功能章节缺少压力推进时，即使当前章无 blocker/major 也触发 propose-improvement 评估；状态/主题跨度只作为有 issue 时的持续模式证据注入 prompt（在场统计无判别力，不参与零 issue 触发）。连续低行动/观察型章节密度类问题 failingLayer 优先定位 story-arc planning 层，candidate 指向规划类 skill 的 planning 执行点，不只在 drafting 修。skill iteration 触发门禁与 learning 打通：blocker/major 或 propose-improvement 任一存在即运行迭代，两者都没有才跳过。

成功章节只允许在 commit/enrich 后执行一次持久化 learning；事实审批挂起不得提前创建候选。质量门失败可保存一次原始失败 learning，不能用同一 artifact 的后续 assessment 覆盖候选而不重新生成候选内容。

skill iteration 的 prompt 注入机制分析而非只注入症状。promote 后重新运行失败场景，验证候选没有扩大到无关题材、角色、章节号或固定短语。章节异构回归必须携带历史蓝图派生的 ScenarioProfile，不能仅以不同 documentId 作为跨场景证据；旧 foundation evidence 仍可读，但不能伪装成章节异构证据。

Skill database check 必须报告未知 execution point；运行时不能静默删除失效点。context manifest 必须能审计 Story Arc 的 narrative cutoff、section provenance 和 fingerprint；章节修订的软背景与节奏上下文可被预算淘汰，定稿事实不能静默丢失。

## 5. 通用性与回归边界

本次修复覆盖的输入类别：

- 安静关系章、行动章、世界观展开章、不同 POV；
- 有或无 opposition、decision、cost 的场景；
- 有事实问题、人物问题、语言问题或无 issue 的正文；
- 内部模型、外部 MCP 和 durable retry；
- 新活动数据与旧历史 JSONB。

本次不做：

- 不设置章节字数下限或软性字数目标；
- 不要求每章新事件、强钩子、反转、爽点、主题、感情线或幽默；
- 不把参考手册的文学原则变成 schema；
- 不通过精确短语黑名单修补 LLM 输出；
- 不重写已完成的历史 artifact、旧 review 或旧数据库 JSONB；不兼容的活动审核运行直接终止并标记 abandoned，未提交候选不进入新 workflow，定稿 revision 保持不变。

## 6. 验证矩阵

应持续运行：

~~~text
pnpm exec vitest run src/novel-v2/__tests__
pnpm exec tsc --noEmit
pnpm lint
pnpm build
git diff --check
~~~

重点测试：

- 五个 Foundation 阶段和旧阶段拒绝；
- 新旧蓝图解析、rebase 和 authority paths；
- 三类 reviewer schema、总分、证据净化和缺失角色门禁；
- blocker/major、总体改善和局部退化守卫；
- reflection 不进入新 workflow；
- prompt 不出现固定字数、narrativeScale、强制新贡献、固定钩子和章节级主题/感情/幽默必填；
- 伏笔账本富化字段（readerQuestion/possiblePayoffs/meaningDelta/cost）从 fact-extraction 经 recordNarrativeElements 写入、经 getOpenForeshadowingAndPromises 与 narrative state snapshot 投影后仍保留，且不作为逐章必填；
- 卷级 promiseWindows 内容软诊断：缺引用或窗口的条目报 `promise-window-ungrounded` warning，有引用+窗口的条目不误报；
- 长线耦合软诊断：缺 coupling/mergePoint/exitPoint/transformPoint 的线报 `long-horizon-thread-coupling-incomplete` warning，有耦合机制或生命周期条件的线不误报；旧数据不因缺可选字段失效；structureType 可选且不产生质量门；
- 世界观压力层软诊断：缺 resourcesAndTechnology 或 valuesAndConflicts 报 `worldview-pressure-layer-incomplete` warning，已结构化两层的条目不误报；旧 worldview 数据不因缺可选层失效；
- 文风契约：十维滑杆经 normalize 落库、激活后经 retrieveMemory 以 style facet 注入 draft/review/revision（可被预算淘汰），渲染为对照参考而非逐章清单；无契约或缺失维度时静默降级，不阻断生成；
- 跨章序列证据：`getSerialContextSnapshot` 从 chapter_memories/chapters/memory_claims 确定性投影最近 N 章的角色状态跨度、连续同功能游程（≥3）与物件/主题跨度；渲染为描述性统计且不输出硬性要求；learning 的 issue 聚类能识别同 rule 跨 ≥2 章并触发 propose-improvement，单章偶发不误报；skill iteration 在无 blocker/major 但 propose-improvement 时仍运行，无任何信号时跳过；
- draft → review → revision → facts → commit → memory smoke。
- 已定稿正文与故事弧蓝图状态投影一致性：历史 `chapters.status='planned'` 必须由迁移/读取派生纠正，commit、手工保存、版本恢复和受保护 rebase 均不得重新产生该不一致。

## 7. 源码索引

| 能力 | 实现 |
| --- | --- |
| Foundation 阶段 | src/novel-v2/application/project-plan.ts |
| 章节蓝图 | src/novel-v2/application/story-arc.ts |
| 上下文合同 | src/novel-v2/prompts/chapter-planning-context.ts |
| 正文 prompt | src/novel-v2/prompts/chapter-draft.ts（StagePromptPackage） |
| 审核 prompt/schema | src/novel-v2/prompts/chapter-review.ts、schemas.ts |
| 跨章序列证据 | src/novel-v2/postgres-repository.ts（getSerialContextSnapshot / getRecentReviewIssueClusters）、chapter-planning-context.ts（renderSerialContext） |
| 正式 workflow | src/novel-v2/temporal/workflows.ts、activities.ts |
| 修订和 commit gate | src/novel-v2/temporal/revision-policy.ts、commit-service.ts |
| Learning | src/novel-v2/learning-assessment.ts、evaluation/skill-iteration.ts |
