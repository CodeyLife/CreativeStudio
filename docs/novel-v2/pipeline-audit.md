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

它不检查正文句式、章节长度、事件数量或文学风格。故事弧蓝图通过 `threadResponsibilities` 承载每条 `plotThreadRefs` 在本弧的责任和下一次可验证推进；这不是逐章兑现清单。架构问题的修复顺序是 Foundation 编辑/作者确认 → 活动 Story Arc rebase → 弧级审核；只有局部正文证据仍失败时，才进入正式 chapterReviewWorkflow。

重基线审校使用三类弧级输入：当前待审 `currentArc`/蓝图、经过兼容投影的 `approvedArc`，以及旧批准记录缺少新字段时的 `legacyArcContractGaps`。后者只表示 schema 演进造成的证据缺口；审核必须检查当前蓝图自己的 `plotThreadRefs`/`threadResponsibilities` 覆盖，不能把旧记录的空数组直接解释成当前弧或正文的退化。兼容投影只影响弧级对照视图，不覆盖章节冻结证据。

本次项目运行 `novel-create-wanfa-20260801` 的架构审计结果：6 卷、估计 670 章、6 名核心人物、3 条长线，`passed=true` 且结构问题为空。四个被补强的 Foundation section 已完成独立审核和作者确认；原有 6 个 final 章节未被该修复重写。迁移后的正式 rebase、Story Arc 审核与作者确认均已完成：当前 blueprint 为 `85957d3f-20c1-473e-bddb-a892d33767d5`，review artifact 为 `9855c6e0-e316-4bcc-a4b3-4ab2f96921f1`，弧级审核 `passed` 且无 blocking issue，当前弧为 `approved/active`。

弧级审核证据账本区分历史规划与当前架构：`frozenEvidence` 只说明历史批准蓝图的冻结边界，`candidateClaims` 由当前候选蓝图确定性投影，二者不是同一份正文快照；定稿事实以 `committedMemory`、`authoritativeFacts` 和正文 revision 为权威。这样可以修正陈旧的章节规划而不把规划修正误报为正文修订，也不让模型回显动态路径的遗漏伪装成完整审核。

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

reviewer schema 只输出 verdict、score、issues。issue 必须有当前正文 evidence/excerpt 和 revisionRanges；rewriteExample、dimensionScores 和 applicableReviewDimensions 不再是活动输出。

REVIEW_COVERAGE 作为内部映射覆盖 D1 世界观、D2 故事性、D3 群像、D4 感情线、D5 幽默，但模型不被要求逐项填表。

### 2.6 Revision / Commit

修订以 grounded evidence 为入口，只修改目标范围；人物的专业化/制度化/理论化认知可以保留，但若连续抽象表达替代身体、环境或即时判断，修订必须回到可观察依据，而不是只替换术语。revision policy 保留：

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
- draft → review → revision → facts → commit → memory smoke。
- 已定稿正文与故事弧蓝图状态投影一致性：历史 `chapters.status='planned'` 必须由迁移/读取派生纠正，commit、手工保存、版本恢复和受保护 rebase 均不得重新产生该不一致。

## 7. 源码索引

| 能力 | 实现 |
| --- | --- |
| Foundation 阶段 | src/novel-v2/application/project-plan.ts |
| 章节蓝图 | src/novel-v2/application/story-arc.ts |
| 上下文合同 | src/novel-v2/prompts/chapter-planning-context.ts |
| 正文 prompt | src/novel-v2/prompts/chapter-draft.ts、writer-rules.ts |
| 审核 prompt/schema | src/novel-v2/prompts/chapter-review.ts、schemas.ts |
| 正式 workflow | src/novel-v2/temporal/workflows.ts、activities.ts |
| 修订和 commit gate | src/novel-v2/temporal/revision-policy.ts、commit-service.ts |
| Learning | src/novel-v2/learning-assessment.ts、evaluation/skill-iteration.ts |
