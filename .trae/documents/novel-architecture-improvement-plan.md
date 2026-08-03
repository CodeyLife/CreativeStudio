# 小说创作架构改进计划方案

> 基于 [novel-architecture-capability-assessment.md](file:///f:/GitHubProject/Ymcp/web/.trae/documents/novel-architecture-capability-assessment.md) 的评估结论,制定分阶段改进计划。
> 评估综合评分 ⭐⭐⭐⭐ (4/5):工程骨架业界领先,但有 3 类明确短板——契约债务(characterEnrichment/chapter memory 未实现)、创作智能层(rerank/reflection/long-context 缺失)、网文特化(爽点/套路无设计)。
> 本计划遵循 AGENTS.md「reusable contracts over case-specific rules」「root-cause analysis」「章节审校复用正式闭环」契约。

---

## 〇、当前实施进度跟踪(2026-07-27 更新)

> 本节随实施进展滚动更新,标识每个子任务的完成度与关键缺口。

### Phase 1:契约债务补齐

| 任务 | 完成度 | 关键产物 | 缺口/风险 |
|---|---|---|---|
| **1.1 characterEnrichmentStageHandler** | 🟢 95% | `character-enrichment/index.ts`、`prompt.ts`、`prompts/schemas.ts:characterEnrichmentSchema`、`activities.ts:enrichCharacters/materializeExternalEnrichment`、**`workflows.ts:novelIntentWorkflow` + `chapterReviewWorkflow` commit 后接入 `runEnrichCharacters`**(P0-1/P0-2 完成) | `closed-loop.ts` 步骤 4 仍需 ExperimentSchemaRepository 架构(Phase 1.3 专项) |
| **1.2 chapter memory 创建** | 🟢 100% | `protocol.ts:ChapterMemory`、`deploy/postgres/006_chapter_memory.sql`、`chapter-memory/index.ts`、`commit-service.ts`(已注入 ChapterMemoryDeps + **失败时接入 learning 闭环** P1-1 完成)、`qdrant-memory.ts`(chapter-memory facet 已识别)、`cognition.ts:facetsFor`(chapter-memory facet 已加) | 无 |
| **1.3 experiment workspace 章节工作流** | 🟡 20% | `evaluation/closed-loop.ts` TODO 注释已更新,明确实现路径(ExperimentSchemaRepository wrapper + 实验 schema 内启动 chapterReviewWorkflow) | 完整实现需 ExperimentSchemaRepository 架构设计,阻塞 craft rule 回归验证契约 |

### Phase 2:创作智能层提升

| 任务 | 完成度 | 关键产物 | 缺口/风险 |
|---|---|---|---|
| **2.1 启用 rerank** | 🟢 100% | `qdrant-memory.ts:applyRerank`(Qdrant 召回后调 gateway.rerank,top-64 → top-32,失败降级) | 无 |
| **2.2 lexicalRank/graphRank 三轨融合** | 🔴 0% | — | 词法检索填充 lexicalRank、GraphMemoryProvider 基于 relations 表 BFS/DFS 填充 graphRank、三轨加权融合 |
| **2.3 动态上下文预算** | 🟢 100% | `cognition.ts:computeTokenBudget`(foundation/planning=24K、drafting/revision 按 totalChapters 分档 32K/48K/64K)、`activities.ts:retrieveMemory` 查询 document count 并传入 | 无 |
| **2.4 reflection 机制** | 🟢 100% | `prompts/chapter-reflection.ts`、`prompts/schemas.ts:reflectionSchema`、`activities.ts:reflectOnDraft/materializeExternalReflection`、`workflows.ts:novelIntentWorkflow` draft 后接入 `runReflection` + autoRevise(1 次,不计入 maxAutoRevisions) | chapterReviewWorkflow 不接入 reflection(已有定稿,无需前置反思,符合计划) |

### Phase 3-4:全部 🔴 0% 未开工

### 本轮完成情况(2026-07-27)

1. ✅ **P0-1 完成**:`novelIntentWorkflow` 在两个 commit 分支(正常 + manualReviewRequired)后接入 `runEnrichCharacters`,支持 external-mcp 双路径,失败不阻塞 workflow(记录到 `enrichmentError` payload)。
2. ✅ **P0-2 完成**:`chapterReviewWorkflow` 在 commit 后接入 `runEnrichCharacters` 局部函数,严格遵循 AGENTS.md「章节审校复用正式闭环」契约。
3. 🟡 **P0-3 部分完成**:`closed-loop.ts` TODO 注释已更新,反映 characterEnrichmentStageHandler 接入现状。完整实现(ExperimentSchemaRepository)作为 Phase 1.3 专项任务,需独立架构设计。
4. ✅ **P1-1 完成**:`commit-service.ts` chapter memory 创建失败时构造 `RuntimeLearningAssessmentV2(conclusion=no-shared-learning)`,记录 symptom + failingLayer 到 learning 闭环,严格遵循 AGENTS.md「review-stage → learning 通路」契约。
5. ✅ **Phase 2.4 完成**:引入 reflection 机制。新增 `chapter-reflection.ts` prompt、`reflectionSchema`、`reflectOnDraft` activity。`novelIntentWorkflow` draft 后自动反思,若发现 blocker/major 自动调 1 次 `runRevision`(不计入 maxAutoRevisions),reflection 失败不阻塞 workflow。
6. ✅ **Phase 2.1 完成**:启用 rerank。`QdrantMemoryProvider.search` 在 Qdrant 召回后调 `gateway.rerank` 做 cross-encoder 精排,top-64 → top-32,rerank score 覆盖 semanticRank。失败降级为纯 Qdrant score。
7. ✅ **Phase 2.3 完成**:动态上下文预算。新增 `computeTokenBudget(taskClass, totalChapters)`,`retrieveMemory` activity 查询 document count 并传入。foundation/planning=24K、drafting/revision 按 totalChapters 分档(<50=32K、>=50=48K、>=200=64K)。

### 下一阶段优先级

1. **Phase 1.3 完整实现**(P1 阻塞项):设计 ExperimentSchemaRepository(包装 NovelPostgresRepository,拦截 pool.query 添加 schema 前缀),在实验 schema 内启动 chapterReviewWorkflow,解锁 craft rule 回归验证。
2. **Phase 2.2 三轨融合**:词法检索填充 lexicalRank、GraphMemoryProvider 基于 relations 表 BFS/DFS 填充 graphRank、三轨加权融合(0.5*semantic + 0.3*lexical + 0.2*graph)。
3. **Phase 3 网文特化**:激活 foreshadowing/promises/payoffs 表、爽点曲线追踪、网文类型差异化(craft rule 沉淀)。

---

## 一、改进目标与原则

### 1.1 目标

1. **补齐契约债务**:实现 AGENTS.md 已要求但 v2 未实现的 `characterEnrichmentStageHandler` 与 chapter memory 创建。
2. **提升创作智能**:引入 rerank / reflection / 动态上下文预算,让 LLM 创作流程符合度从 75% 提升到 90%+。
3. **构建网文特化能力**:通过 craft rule 沉淀机制(而非骨架内置)补齐爽点曲线、套路识别、类型差异化。
4. **完善长程一致性**:激活已存在但未使用的 `timeline_events`/`foreshadowing`/`plot_threads`/`promises`/`payoffs` 表。

### 1.2 设计原则(来自 AGENTS.md)

- **Reusable contracts over case-specific rules**:网文爽点等特化能力走 craft rule 沉淀,不嵌入骨架 prompt(避免 fixture 污染)。
- **Root-cause analysis**:每个改进必须解释为何覆盖更广的失败类,不允许只针对单个章节/人物/题材打补丁。
- **章节审校复用正式闭环**:新增的 reflection/enrichment 必须接入 `chapterReviewWorkflow`,不允许另起独立修订逻辑。
- **Learning 闭环自动触发**:`propose-improvement` 必须自动构造 `CraftRuleCandidate`,经验沉淀为可复用技能。
- **架构阶段允许破坏性变更**:不兼容 v1 遗留(`facts` 表可删、`commit-service.ts` 可重写)。

---

## 二、分阶段实施计划

### Phase 1:契约债务补齐(P0,2-3 周)

**目标**:实现 AGENTS.md 已要求但 v2 未实现的 3 个核心模块,恢复长程一致性的闭环。

#### 任务 1.1:实现 `characterEnrichmentStageHandler`

**问题**:AGENTS.md 列出的 handler 链 `... → commitStageHandler → characterEnrichmentStageHandler`,v2 仅在 [closed-loop.ts:22-25](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/closed-loop.ts#L22-L25) 作为 TODO 出现,无实现。导致角色声部/动机/知识边界变化无法从定稿章节回写,`character-reviewer` 只能审不能反哺。

**实施方案**:

1. **新建 `src/novel-v2/character-enrichment/index.ts`**:核心函数 `enrichCharactersFromChapter(projectId, documentId, revisionId, deps)`,纯函数 + 依赖注入。
   - 输入:定稿章节正文(`objectStore.getText`)+ 已有 `entities` 表角色快照
   - LLM 结构化提取:声部锚点(句长/词汇/直率度/回避方式)、动机变化、关系变化、知识边界变化(新知道哪些 fact)
   - 输出:`CharacterEnrichmentDelta[]`(每个角色的增量更新)
2. **新建 `src/novel-v2/character-enrichment/prompt.ts`**:`buildCharacterEnrichmentPrompt`,purpose=`facts.extract`(复用现有 model routing),输出 JSON Schema:`{ characters: Array<{ entityId, voiceAnchor, motivationDelta, newKnowledgeFactIds, relationDeltas[] }> }`。
3. **扩展 `postgres-repository.ts`**:
   - 新增 `updateCharacterEnrichment(projectId, deltas)`:UPSERT 到 `entities.payload`(merge voiceAnchor)、INSERT 到 `character_knowledge`(新 fact 关联)、UPSERT 到 `relations`(时效关系)。
4. **新增 activity `enrichCharacters`** in [activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts):在 `commit` activity 之后执行,支持 internal LLM 与 external-mcp 双路径(同其他生成类 activity)。
5. **接入 `novelIntentWorkflow`**:在 [workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts) `commit` 之后增加 `enrichCharacters` 步骤,失败不阻塞 commit(已有 revision 已落库),只记录 learning。
6. **接入 `chapterReviewWorkflow`**:章节审校也复用 `enrichCharacters`(严格遵循 AGENTS.md「章节审校复用正式闭环」契约)。
7. **接入 `closed-loop.ts`**:删除 [closed-loop.ts:22-25](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/closed-loop.ts#L22-L25) 的 TODO,接入真实 handler。

**验收**:
- 定稿一章后,`entities.payload.voiceAnchor` 被更新;`character_knowledge` 表新增该角色知道的事实;`relations.valid_from` 更新。
- `chapterReviewWorkflow` 重审已定稿章节时,角色 enrichment 增量正确应用。
- 单测:输入 fixture 章节(题材无关的通用样例),验证 enrichment delta 结构正确。

**参考**:CHIRON(EMNLP 2024)的角色状态向量思想,但落地为本项目的 `entities` 表 + `character_knowledge` 表,不引入新依赖。

---

#### 任务 1.2:实现 chapter memory 创建

**问题**:[commit-service.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/commit-service.ts) 仅 16 行,只调 `commitRevision` 写 `manuscript_revisions` + 推进 `current_revision`,AGENTS.md 要求的「commit-stage 对新 DocumentRevision 创建 chapter memory」未实现。

**实施方案**:

1. **扩展 `protocol.ts`**:新增 `ChapterMemory` 类型:
   ```ts
   interface ChapterMemory {
     id: string;                    // 格式 `memory:chapter:${revisionId}`
     projectId: string;
     documentId: string;
     revisionId: string;
     narrativeRange: { start: number; end: number };  // 章节顺序号
     summary: string;               // 章节级摘要(200-400 字)
     keyEvents: string[];           // 关键事件列表
     characterStates: Array<{ characterId: string; stateSnapshot: string }>;  // 角色状态快照
     unresolvedThreads: string[];   // 未解决的线索/伏笔
     emotionalArc?: string;         // 情绪弧光简述
     fingerprint: string;
     createdAt: number;
   }
   ```
2. **新增 Postgres 表 `chapter_memories`**(迁移脚本 `deploy/postgres/006_chapter_memory.sql`):字段对齐 `ChapterMemory`,索引 `(project_id, narrative_start)`。
3. **新建 `src/novel-v2/chapter-memory/index.ts`**:核心函数 `createChapterMemoryFromRevision(projectId, revisionId, deps)`:
   - 从 `objectStore` 取章节正文
   - LLM 结构化提取(purpose=`facts.extract`):summary/keyEvents/characterStates/unresolvedThreads/emotionalArc
   - 写入 `chapter_memories` 表
   - 同步 upsert 到 Qdrant(向量索引,kind=`chapter-memory`)
4. **扩展 `commit-service.ts`**:`CommitService.commit` 在 `commitRevision` 成功后,自动调用 `createChapterMemoryFromRevision`。失败不回滚 commit(revision 已落库),只记录 learning。
5. **扩展 `qdrant-memory.ts`**:`QdrantMemoryProvider.search` 增加 `chapter-memory` 类型检索,与 `memory_claims` 并行召回,在 `buildMemoryBundle` 中按 authority 排序融合。
6. **扩展 `cognition.ts`**:`facetsFor` 新增 `chapter-memory` facet,planning/drafting 任务必填。

**验收**:
- 定稿一章后,`chapter_memories` 表有对应记录;Qdrant `chapter-memory` collection 有向量。
- 下一章生成时,`MemoryBundle.claims` 包含前章 chapter memory(可识别为 `kind=chapter-memory`)。
- 单测:输入两章正文,验证第二章的 MemoryBundle 包含第一章的 summary。

**参考**:AI_NovelGenerator 的 `global_summary.txt` + `character_state.txt` 三件套思想,但升级为结构化 `ChapterMemory` + 向量检索。

---

#### 任务 1.3:接入 experiment workspace 章节工作流

**问题**:[closed-loop.ts:123-135](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/closed-loop.ts#L123-L135) 步骤 4 是 TODO,skill 迭代无法在实验 schema 内验证,导致 craft rule promote 后无法做回归验证(违反 AGENTS.md「promote 后必须做回归验证」契约)。

**实施方案**:

1. **扩展 `evaluation/experiment-workspace.ts`**:新增 `runChapterWorkflowInExperiment(experimentSchema, intent)`:在实验 schema 内启动子 Temporal workflow,复用 `novelIntentWorkflow` 但 repository 指向实验 schema。
2. **扩展 `closed-loop.ts`** 步骤 4:替换 TODO,调用 `runChapterWorkflowInExperiment`,产出 `workflowRunId` + `artifactId`。
3. **扩展 `candidate-bundle.ts`**:从实验 schema 的 `artifacts`/`reviews` 表抽取 manuscript + issues,无需 TODO 兜底。
4. **回归验证钩子**:`promoteCraftRuleCandidate` 调用 `evaluateCraftRuleOnFoundation` 已有的 before/after 对比,现接入真实章节工作流输出。

**验收**:
- 触发 `runClosedLoop` 后,实验 schema 内有完整的 workflow 运行记录(artifacts + reviews + manuscript_revisions)。
- `promoteCraftRuleCandidate` 的回归验证使用真实章节工作流输出,非 stub。
- 单测:mock 子 workflow,验证 candidate bundle 归一化正确。

---

### Phase 2:创作智能层提升(P1,3-4 周)

**目标**:补齐 LLM 创作智能层短板,符合度从 75% 提升到 90%+。

#### 任务 2.1:启用 rerank

**问题**:[qdrant-memory.ts:18-32](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/qdrant-memory.ts#L18-L32) 直接返回 Qdrant score,`ModelGateway.rerank` 接口已定义([model-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts))但未调用。

**实施方案**:

1. **扩展 `qdrant-memory.ts`**:`search` 方法在 Qdrant 召回后,若 `gateway.rerank` 可用,对 top-N(N=64)做 cross-encoder rerank,返回 top-K(K=32)。
2. **配置**:通过 `model-routing.ts` 的 `memory.rerank` purpose 路由 rerank 模型;不可用时降级为纯 Qdrant score。
3. **审计**:`ModelInvocationRecorder` 记录 rerank 调用。

**验收**:
- 配置 rerank profile 后,`MemoryBundle.claims` 的顺序与 rerank score 一致。
- 不可用时降级正常,无报错。

---

#### 任务 2.2:补全 lexicalRank / graphRank

**问题**:[protocol.ts:67-74](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts#L67-L74) `MemoryHit` 设计了三维 rank,但实际只有 `semanticRank`,`lexicalRank`/`graphRank` 未填充。

**实施方案**:

1. **扩展 `postgres-repository.ts`**:`searchMemory` 词法检索结果赋予 `lexicalRank`(按 `ts_rank` 或 `ILIKE` 命中数排序)。
2. **新建 `src/novel-v2/graph-memory.ts`**:`GraphMemoryProvider` 基于 `relations` 表做关系图检索(BFS/DFS 2 跳),结果赋予 `graphRank`。
3. **扩展 `cognition.ts`**:`buildMemoryBundle` 三轨融合:semantic + lexical + graph,按 `score = 0.5*semantic + 0.3*lexical + 0.2*graph` 加权(权重可配置)。
4. **去重**:三轨结果按 `claim.id` 去重,保留最高 score。

**验收**:
- 三轨检索结果在 `MemoryBundle.claims` 中混合出现。
- 单测:构造 fixture(已知实体关系图),验证 graphRank 正确。

---

#### 任务 2.3:动态上下文预算

**问题**:[cognition.ts:82](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts#L82) 默认 `tokenBudget=24000`,对百万字长篇裁剪过激。

**实施方案**:

1. **扩展 `cognition.ts`**:`buildMemoryBundle` 接受 `tokenBudget` 参数,由 `compileExecutionBlueprint` 根据 `taskClass` + `snapshot.totalChapters` 动态计算:
   - `foundation`/`planning`:24K(默认)
   - `drafting`/`revision` 且 `totalChapters < 50`:32K
   - `drafting`/`revision` 且 `totalChapters >= 50`:48K
   - `drafting`/`revision` 且 `totalChapters >= 200`:64K
2. **配置**:权重表可由 `model-routing.ts` 的 profile `contextLimit` 推导,不超过模型上下文窗口的 60%。
3. **审计**:`ContextManifest.truncationReason` 记录 `budget` 时附带实际预算值。

**验收**:
- 长篇后期(>200 章)`MemoryBundle.tokenBudget` 自动扩展到 64K。
- 单测:不同 `totalChapters` 下 tokenBudget 计算正确。

---

#### 任务 2.4:引入 reflection 机制

**问题**:LLM 直接生成最终稿,无显式「思考-批评-重写」内省循环,符合 AGENTS.md「root-cause analysis」但缺乏生成时的自我反思。

**实施方案**:

1. **新建 `src/novel-v2/prompts/chapter-reflection.ts`**:`buildChapterReflectionPrompt({draft, blueprint, memory})`,让 LLM 扮演「严苛读者」对自己的草稿做批评,输出 `ReflectionCritique`(issues + 优先级 + 改写建议)。
2. **新增 activity `reflectOnDraft`** in [activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts):在 `draft` 之后、`runAllReviewers` 之前执行,purpose=`review.reader`(复用路由)。
3. **接入 `novelIntentWorkflow`**:`draft → reflectOnDraft → [if critique has blocker/major: autoRevise] → runAllReviewers → ...`。
4. **不绕过正式 review**:reflection 只是 draft 的前置优化,不替代 5 reviewer,不产生 commit 证据。
5. **章节审校复用**:`chapterReviewWorkflow` 不接入 reflection(已有定稿,无需前置反思)。

**验收**:
- `draft` artifact 之后有 `reflection` artifact,包含 `ReflectionCritique`。
- 若 reflection 发现 blocker,`draft` 自动迭代一次(不计入 `maxAutoRevisions`)。
- 单测:mock LLM 返回 critique,验证 workflow 流转。

---

### Phase 3:网文特化能力构建(P2,3-4 周)

**目标**:通过 craft rule 沉淀机制补齐网文爽点/套路/类型差异化,不污染骨架 prompt。

#### 任务 3.1:激活 `foreshadowing`/`promises`/`payoffs` 表

**问题**:[001_novel_v2.sql:208-211](file:///f:/GitHubProject/Ymcp/web/deploy/postgres/001_novel_v2.sql#L208-L211) 表已存在但无 activity 操作,无 handler 把这些结构化数据注入上下文或从正文提取。

**实施方案**:

1. **扩展 `fact-extraction/prompt.ts`**:在 `factExtractionSchema` 新增 `narrativeElements` 字段,提取:
   - `foreshadowing`:伏笔埋设(描述 + 触发关键词 + 预期兑现窗口)
   - `promise`:承诺(谁对谁承诺什么 + 兑现状态)
   - `payoff`:兑现(对应哪个 foreshadowing/promise + 兑现强度 1-5)
2. **扩展 `postgres-repository.ts`**:`recordFactExtraction` 同时写入 `foreshadowing`/`promises`/`payoffs` 表,建立 `payoff.foreshadowing_id` 关联。
3. **扩展 `cognition.ts`**:`facetsFor` 新增 `foreshadowing` facet(已存在,激活),`buildMemoryBundle` 把未兑现的 foreshadowing/promise 注入上下文(高优先级)。
4. **扩展 `prompts/chapter-draft.ts`**:在「冻结上下文」段增加「未兑现伏笔/承诺」子段,提醒 LLM 本章是否应兑现。

**验收**:
- 定稿一章后,若正文埋了伏笔,`foreshadowing` 表有记录。
- 后续章节生成时,`MemoryBundle` 包含未兑现伏笔;若本章兑现,`payoffs` 表有记录并关联 `foreshadowing_id`。
- 单测:fixture 章节(题材无关),验证伏笔提取与关联。

---

#### 任务 3.2:爽点曲线追踪

**问题**:网文核心维度「爽感」完全无设计,无爽点曲线追踪。

**实施方案**(遵循 AGENTS.md「reusable contracts」原则,不内置套路识别):

1. **新增 Postgres 表 `payoff_curve`**(迁移脚本 `007_payoff_curve.sql`):
   ```sql
   CREATE TABLE payoff_curve (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     document_id TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     narrative_order INT NOT NULL,
     payoff_type TEXT NOT NULL,        -- 爽点类型:achievement/recognition/reversal/emotional/mystery
     intensity INT NOT NULL,           -- 1-5
     setup_revision_id TEXT,           -- 对应的铺垫章节
     payoff_description TEXT NOT NULL,
     created_at BIGINT NOT NULL
   );
   ```
2. **扩展 `fact-extraction/prompt.ts`**:LLM 提取本章爽点(`payoff_type` + `intensity` + `setup_revision_id`),走 craft rule 沉淀的「爽点识别规则」(初始为空,通过 learning 闭环沉淀)。
3. **新建 `src/novel-v2/payoff-curve/index.ts`**:`getPayoffCurve(projectId, range)` 返回爽点强度序列,用于:
   - 蓝图编译时提示「最近 5 章无 achievement 型爽点,建议本章安排」
   - reader-reviewer 审校时检查「连续 3 章无爽点,追更体验下降」
4. **不内置爽点套路**:具体什么是「打脸装逼」「废柴逆袭」由 craft rule 沉淀,骨架只提供 `payoff_type` 枚举框架。

**验收**:
- 定稿一章后,`payoff_curve` 表有记录(若本章有爽点)。
- 连续 3 章无爽点时,reader-reviewer 报告 warning。
- 单测:fixture 章节,验证爽点提取与曲线查询。

**实现状态(2026-07-27)**:✅ 已完成
- `deploy/postgres/007_payoff_curve.sql`:payoff_curve 表已建,5 种通用爽感维度(achievement/recognition/reversal/emotional/mystery),非金手指/系统流特化。
- `prompts/schemas.ts`:`factExtractionSchema` 增加 `payoffMoments` 字段,LLM 结构化提取爽点。
- `postgres-repository.ts`:新增 `recordPayoffCurve`(写入)和 `getRecentPayoffStats`(查询最近 N 章爽点统计,含连续无爽点章数)。
- `temporal/activities.ts`:`extractFacts`/`materializeExternalFacts` 在写入 claims/narrativeElements 后调用 `recordPayoffCurve`;`review` activity 对 reader-reviewer 调用 `getRecentPayoffStats` 注入 prompt。
- `prompts/chapter-review.ts`:`buildChapterReviewPrompt` 增加 `payoffStats` 参数,reader-reviewer 专属「爽点曲线检查」段落,基于事实判断(非硬阈值),rule=`chapter.payoff-drought`。
- `temporal/workflows.ts`:`runReview`/`runFactExtraction` 传入 `narrativeOrder`/`documentId`(两个 workflow 均更新)。

---

#### 任务 3.3:网文类型差异化(craft rule 沉淀)

**问题**:[handlers.ts:519](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L519) TODO,`premise`/`genre` 未写入 metadata;无题材特化的 craft rule 注入。

**实施方案**:

1. **扩展 `handlers.ts:519`**:`ensureProject` 接受 `premise`/`genre` 参数,写入 `novel_projects.metadata`。
2. **扩展 `protocol.ts`**:`PreflightProjectSnapshot` 增加 `premise`/`genre` 字段。
3. **扩展 `cognition.ts`**:`resolveSkillBundle` 优先选择 `applicableGenres` 包含当前 `genre` 的 skill。
4. **预置 craft rule 种子**(不走骨架,走 `craft_rule_candidates` 表):为玄幻/都市/言情/系统流各预置 1-2 条通用 craft rule(如「玄幻章节应每 3 章安排 1 次境界突破或法宝获得」「都市章节应避免古语典故」),作为 learning 闭环的起点。
5. **不内置题材特化 prompt**:`writer-rules.ts` 保持题材无关,所有题材特化走 craft rule。

**验收**:
- 创建项目时可指定 `genre=玄幻`;生成章节时,`SkillBundle` 包含玄幻相关 craft rule。
- 单测:不同 `genre` 下 `resolveSkillBundle` 选择不同 skill。

**实现状态(2026-07-27)**:✅ 已完成(简化版,未预置系统流特化种子)
- 用户决策:「网文特化不用特别强调金手指,但是爽感剧情还是要有」——不预置金手指/系统流特化 craft rule 种子,保留题材通用差异化机制。
- `deploy/postgres/008_skill_genres.sql`:skill_definitions 增加 `applicable_genres` 列(空数组表示题材无关)。
- `protocol.ts`:`SkillDescriptor` 增加 `applicableGenres?`,`PreflightProjectSnapshot` 增加 `genre?`/`premise?`(不内置固定题材枚举)。
- `postgres-repository.ts`:`ensureProject` 第三参数支持 metadata 写入;`getProjectSnapshot` 从 metadata 读取 genre/premise;`listSkills` 返回 `applicableGenres`。
- `cognition.ts`:`resolveSkillBundle` 增加 `genre?` 参数,软偏好匹配(无匹配时回退题材无关 skill)。
- `mcp/handlers.ts`+`mcp/tool-definitions.ts`:`novel_project_create` 接受 `genre`/`premise` 写入 metadata。
- `temporal/activities.ts`+`workflows.ts`:`resolveSkills` activity 接收 `genre` 并传入 `resolveSkillBundle`。
- 未预置 craft rule 种子:题材特化规则由 learning 闭环沉淀(`craft_rule_candidates` 表),骨架不内置。

---

### Phase 4:长程一致性增强(P3,2-3 周,可选)

**目标**:激活已存在但未使用的 `timeline_events`/`plot_threads` 表,引入 multi-agent debate,实现记忆压缩。

#### 任务 4.1:timeline / plot_thread 显式管理

**实施方案**:
1. 扩展 `fact-extraction` 提取 `timeline_events`(时间线事件)和 `plot_threads`(剧情线进展)。
2. 扩展 `cognition.ts`:`facetsFor` 新增 `timeline`/`plot-thread` facet(已存在 kind,激活)。
3. 扩展 `prompts/chapter-draft.ts`:注入「时间线最近事件」「活跃剧情线状态」。

#### 任务 4.2:multi-agent debate(可选)

**实施方案**:
1. 5 reviewer 并行后,若存在分歧(verdict 不一致),增加 1 轮 debate:每个 reviewer 看到其他 reviewer 的 issues,可更新自己的 verdict。
2. 不强制收敛,只记录 debate 过程到 `reviews.metadata.debateRound`。

#### 任务 4.3:记忆压缩/搬运(可选)

**实施方案**:
1. 长篇后期(>200 章),对 100 章前的 `chapter_memories` 做压缩:LLM 把 10 章的 summary 压缩为 1 段「弧光摘要」。
2. `buildMemoryBundle` 优先使用弧光摘要,细节 chapter memory 按需召回。

---

## 三、依赖关系图

```
Phase 1(契约债务,必须先做):
  1.1 characterEnrichment ──┐
  1.2 chapter memory ────────┤── 互相独立,可并行
  1.3 experiment workspace ──┘

Phase 2(创作智能,依赖 Phase 1):
  2.1 rerank ─────────────────── 独立
  2.2 lexical/graph rank ─────── 独立
  2.3 动态上下文预算 ──────────── 依赖 1.2(chapter memory 占用预算)
  2.4 reflection ──────────────── 独立

Phase 3(网文特化,依赖 Phase 1+2):
  3.1 foreshadowing/promises/payoffs ── 依赖 1.2
  3.2 爽点曲线 ──────────────────────── 依赖 3.1
  3.3 类型差异化 ────────────────────── 依赖 1.3(experiment workspace 验证 craft rule)

Phase 4(可选,依赖 Phase 1-3):
  4.1 timeline/plot_thread ─── 独立
  4.2 multi-agent debate ───── 独立
  4.3 记忆压缩 ──────────────── 依赖 1.2 + 2.3
```

---

## 四、风险与权衡

### 4.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| characterEnrichment LLM 提取不准 | 角色状态被污染 | authority=candidate,需人工 review 后升级 approved;`character_knowledge` 表保留 `certainty` 字段 |
| chapter memory 增加延迟 | 每章 commit 多一次 LLM 调用 | 失败不阻塞 commit;异步执行;缓存 |
| 动态预算超出模型窗口 | LLM 报错 | `contextLimit` 配置硬上限,不超过模型窗口 60% |
| reflection 增加迭代次数 | 章节生成变慢 | reflection 只在 draft 后做 1 次,不迭代;autoRevise 最多 1 次 |
| 网文 craft rule 污染 | 题材特化规则渗透到骨架 | 严格走 `craft_rule_candidates` 表,`writer-rules.ts` 保持题材无关 |
| experiment workspace 章节工作流复杂 | 实验成本高 | 支持dryRun;只对 propose-improvement 的 candidate 跑,不对所有 review 跑 |

### 4.2 权衡

- **不引入外部依赖**:MemGPT/Letta/LangGraph 等不引入,保持架构独立(用户确认)。
- **不破坏现有契约**:章节审校复用正式闭环、learning 自动触发、双门 commit 等契约保持。
- **不内置网文套路**:爽点/打脸/装逼等走 craft rule 沉淀,符合 AGENTS.md「reusable contracts」原则。
- **允许破坏性变更**:`facts` 表(v1 遗留)可删除,`commit-service.ts` 可重写。

---

## 五、验收标准(整体)

完成 Phase 1-3 后,应满足:

1. **事实记忆闭环完整**:定稿一章后,`memory_claims` + `chapter_memories` + `entities`(enriched) + `character_knowledge` + `foreshadowing`/`promises`/`payoffs` + `payoff_curve` 全部更新。
2. **长程一致性**:第 50 章生成时,`MemoryBundle` 包含前 49 章的 chapter memory summary + 未兑现伏笔 + 角色当前状态 + 时间线最近事件。
3. **网文爽感**:连续 3 章无爽点时 reader-reviewer 报 warning;`payoff_curve` 表可查询爽点强度序列。
4. **LLM 创作流程符合度 90%+**:有 reflection、rerank、三轨检索、动态预算、character enrichment。
5. **章节审校复用**:`chapterReviewWorkflow` 接入 enrichment + chapter memory,与正式闭环一致。
6. **learning 闭环**:experiment workspace 验证 skill 迭代效果,craft rule promote 有回归证据。

---

## 六、关键文件变更清单

### 新建文件

- `src/novel-v2/character-enrichment/index.ts` — characterEnrichment 核心函数
- `src/novel-v2/character-enrichment/prompt.ts` — enrichment prompt
- `src/novel-v2/chapter-memory/index.ts` — chapter memory 核心函数
- `src/novel-v2/graph-memory.ts` — GraphMemoryProvider
- `src/novel-v2/payoff-curve/index.ts` — 爽点曲线查询
- `src/novel-v2/prompts/chapter-reflection.ts` — reflection prompt
- `deploy/postgres/006_chapter_memory.sql` — chapter_memories 表
- `deploy/postgres/007_payoff_curve.sql` — payoff_curve 表

### 修改文件

- `src/novel-v2/protocol.ts` — 新增 `ChapterMemory`/`ReflectionCritique`/`PayoffEntry` 类型,扩展 `PreflightProjectSnapshot`
- `src/novel-v2/cognition.ts` — 动态 tokenBudget,新增 `chapter-memory`/`timeline`/`plot-thread` facet,三轨融合
- `src/novel-v2/postgres-repository.ts` — `updateCharacterEnrichment`/`createChapterMemory`/`recordPayoffCurve`,词法检索填充 `lexicalRank`
- `src/novel-v2/qdrant-memory.ts` — 启用 rerank,新增 chapter-memory 向量索引
- `src/novel-v2/commit-service.ts` — 扩展为 commit + chapter memory 创建
- `src/novel-v2/temporal/workflows.ts` — `novelIntentWorkflow` 增加 `reflectOnDraft` + `enrichCharacters`,`chapterReviewWorkflow` 增加 `enrichCharacters`
- `src/novel-v2/temporal/activities.ts` — 新增 `reflectOnDraft`/`enrichCharacters`/`createChapterMemory` activity
- `src/novel-v2/fact-extraction/prompt.ts` — 扩展提取 `foreshadowing`/`promises`/`payoffs`/`payoff_curve`/`timeline_events`/`plot_threads`
- `src/novel-v2/fact-extraction/dedupe.ts` — 新增 narrativeElements 去重规则
- `src/novel-v2/prompts/chapter-draft.ts` — 注入「未兑现伏笔」「角色当前状态」「时间线最近事件」
- `src/novel-v2/prompts/chapter-review.ts` — reader-reviewer 检查爽点曲线
- `src/novel-v2/evaluation/closed-loop.ts` — 接入 experiment workspace 章节工作流,删除 TODO
- `src/novel-v2/evaluation/candidate-bundle.ts` — 从实验 schema 抽取真实 artifact
- `src/novel-v2/mcp/handlers.ts` — `ensureProject` 接受 `premise`/`genre`
- `src/novel-v2/learning-assessment.ts` — 爽点相关 issue 触发 craft rule candidate

### 删除文件/字段

- `deploy/postgres/001_novel_v2.sql:204` 的 `facts` 表(v1 遗留,被 `memory_claims` 取代)—— 架构阶段允许破坏性变更,但需确认无 v1 残留代码引用

---

## 七、实施建议

### 7.1 推荐顺序

1. **Week 1-2**:Phase 1 任务 1.2(chapter memory)—— 基础设施,解锁长程一致性
2. **Week 3**:Phase 1 任务 1.1(characterEnrichment)—— 依赖 chapter memory 的角色状态快照
3. **Week 4**:Phase 1 任务 1.3(experiment workspace)—— 解锁 craft rule 回归验证
4. **Week 5-6**:Phase 2 任务 2.1-2.4(创作智能层)—— 可并行
5. **Week 7-8**:Phase 3 任务 3.1-3.3(网文特化)—— 依赖 Phase 1+2
6. **Week 9+**:Phase 4(可选)

### 7.2 测试策略

- 每个 task 完成后,用题材无关的 fixture 章节做单测(遵循 AGENTS.md「reusable contracts」)。
- Phase 1 完成后,跑端到端:连续生成 3 章,验证 chapter memory + character enrichment + foreshadowing 闭环。
- Phase 3 完成后,跑网文 fixture:连续生成 5 章,验证爽点曲线 + 伏笔兑现。
- 所有改进通过 learning 闭环沉淀,不直接打补丁(遵循 AGENTS.md「经验沉淀」契约)。

### 7.3 回归验证

- 每个 Phase 完成后,用 craft rule candidate 的 `evaluateCraftRuleOnFoundation` 跑基础任务回归,确保不回退。
- Phase 1.3 接入后,所有 craft rule promote 必须有 experiment workspace 回归证据。
