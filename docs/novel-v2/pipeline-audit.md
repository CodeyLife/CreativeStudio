# Novel V2 当前流程审核

> 审核基线：2026-08-03。本文记录当前代码、prompt、schema 和 workflow 的活动契约；旧版本问题作为历史背景保留在版本控制中，不作为新运行规则。

## 1. 结论

本次重构的根因判断是：正文质量下降主要来自编辑性字段、重复上下文和固定章节合规检查叠加，而不是缺少“每章必须推进”的规则。系统现在把可靠性边界集中在事实、因果、状态、证据和 durable workflow，把文学选择留给全局规划、故事弧和模型。

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

修订以 grounded evidence 为入口，只修改目标范围。revision policy 保留：

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

skill iteration 的 prompt 注入机制分析而非只注入症状。promote 后重新运行失败场景，验证候选没有扩大到无关题材、角色、章节号或固定短语。

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
- 不重写历史 artifact、旧 review 或旧数据库 JSONB。

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
