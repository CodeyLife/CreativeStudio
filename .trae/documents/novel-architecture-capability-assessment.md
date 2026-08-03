# 小说创作架构能力评估报告

> 本报告基于对 `src/novel-v2/` 全量代码的探索,评估当前架构在「事实记忆 / 高水平网文创作 / LLM 创作最佳流程」三方面的能力,并与开源项目对照。报告**不包含实施步骤**,仅作为后续改进决策的依据。

---

## 一、当前架构总览

### 1.1 架构骨架(已落地)

```
入口: scripts/novel-v2-api.ts (HTTP) / scripts/novel-v2-worker.ts (Temporal Worker)
      scripts/novel-v2-mcp-server.mjs (MCP)
核心: src/novel-v2/
  ├── protocol.ts              全领域类型协议(无依赖)
  ├── cognition.ts             纯函数认知编排(preflight/memory/skills/blueprint)
  ├── temporal/workflows.ts    3 个 Temporal workflow
  ├── temporal/activities.ts   21 个 activity
  ├── prompts/                 章节草稿/审校 prompt + writer-rules 硬约束
  ├── fact-extraction/         事实提取(去重 11 类失败 + 风险分类)
  ├── commit-service.ts        双门提交(internal + independent)
  ├── learning-assessment.ts   运行时学习评估
  ├── craft-rule/              craft rule 候选演进(7 函数)
  ├── evaluation/              评估闭环(snapshot→experiment→iteration→promote)
  ├── creative/                CreativeRun / WorkItem / ReviewGate
  ├── qdrant-memory.ts         向量记忆(Qdrant)
  ├── postgres-repository.ts   Postgres 持久化(26 张表)
  ├── object-store.ts          S3/本地对象存储
  ├── model-gateway.ts         LiteLLM 网关(13 purpose 路由)
  └── mcp/                     23 个 MCP 工具
```

### 1.2 章节生成主流程(`novelIntentWorkflow`)

```
loadProjectSnapshot
  → createPreflight           (taskClass 分类: foundation/planning/drafting/review/revision/memory-maintenance)
  → retrieveMemory            (双轨:Qdrant 语义 + Postgres 词法,narrativeCutoff 防未来泄漏)
  → resolveSkills             (按 taskClass + capabilities + memoryKinds 匹配,检测冲突)
  → compileBlueprint          (4 task: retrieve→draft→review→commit,高风险缺记忆维度直接抛错)
  → draft                     (buildChapterDraftPrompt,15 段 prompt 拼装)
  → runAllReviewers           (5 种 reviewer 并行:plot/continuity/style/character/reader)
  → [多轮 revision loop]      (maxAutoRevisions=2,改善度阈值 0.15)
  → extractFacts              (LLM 结构化 → 11 类去重 → 风险分类 → 写 memory_claims + Qdrant)
  → assessLearning            (conclusion: no-shared-learning / propose-improvement)
  → commit                    (双门证据校验 + 乐观锁)
```

### 1.3 三大闭环已实现

| 闭环 | 入口 | 状态 |
|---|---|---|
| 章节生成闭环 | `novelIntentWorkflow` | ✅ 完整 |
| 章节审校闭环 | `chapterReviewWorkflow` | ✅ 严格复用正式闭环(AGENTS.md 契约) |
| 经验沉淀闭环 | `recordLearning → createCraftRuleCandidate → promoteCraftRuleCandidate` | ✅ 自动触发,带回归验证 |
| 评估闭环 | `runClosedLoop` | ⚠️ 步骤 4(实验 schema 内触发章节工作流)为 TODO |

---

## 二、事实记忆能力评估

### 2.1 ✅ 已具备的能力

| 能力 | 实现 | 评价 |
|---|---|---|
| **结构化事实模型** | `MemoryClaim` 含 subject(8 类)/predicate/object(5 类)/polarity/truthStatus(4 类)/narrativeRange/knowledgeScope/authority(4 级)/confidence/sourceRevisionIds/supersedes | **业界领先**,比 RecurrentGPT 的 short/long memory 二分法精细得多 |
| **双轨检索** | Qdrant 向量语义 + Postgres GIN 词法兜底 | ✅ 可用,但 `MemoryHit` 的 `lexicalRank`/`graphRank` 字段未填充,实际只有 `semanticRank` |
| **narrative cutoff** | `claim.narrativeRange.start <= targetDocumentOrder - 1`,Qdrant + Postgres + buildMemoryBundle 三层过滤 | ✅ 严格防未来泄漏 |
| **视角知识边界** | `MemoryClaim.knowledgeScope = "author" \| { characterId }`,POV 章节只检索该角色知道的事实 | ✅ 避免「角色说出不该知道的信息」 |
| **11 类去重** | `dedupeFactCandidates` 覆盖同义改写/重复 subject+predicate/重复 evidence/低置信/短证据/代词主语/空对象/内容哈希冲突等 | ✅ 工程化程度高 |
| **权威分级** | `approved > author > derived > candidate`,排序+裁剪+注入 prompt 全链路一致 | ✅ |
| **冲突检测** | `MemoryConflict` 从 `supersedes` 推导,高风险任务 `missingFacets` 直接抛错 | ✅ |
| **审计可复现** | `ContextManifest` 记录每个 claim 是否进入 prompt、为何被排除(budget/future-cutoff/authority-conflict) | ✅ 业界少有 |
| **持久化分层** | Postgres(结构化 + GIN 索引) + Qdrant(向量) + S3/文件(正文 sha256 寻址) | ✅ |

### 2.2 ❌ 缺失或未实现

| 缺失项 | 影响 | 证据 |
|---|---|---|
| **`characterEnrichmentStageHandler` 完全未实现** | 角色声部/动机/知识边界变化无法从定稿章节回写到 `entities` 表;`character-reviewer` 只能审不能反哺 | grep `characterEnrichment` 仅在 `closed-loop.ts:22-25` 作为 TODO 出现;AGENTS.md 列出的 handler 链中此项无实现 |
| **`chapter memory` 创建未实现** | AGENTS.md 要求「commit-stage 对新 DocumentRevision 创建 chapter memory」,但 `commit-service.ts` 仅 16 行,只调 `commitRevision` 写 `manuscript_revisions` + 推进 `current_revision`,无 chapter memory 创建 | `commit-service.ts:9-15` |
| **`facts` 表与 `memory_claims` 表并存** | v1 遗留 `facts` 表仍在 schema 中,但 v2 fact-extraction 实际写入 `memory_claims`,过渡状态 | `deploy/postgres/001_novel_v2.sql:204` vs `:44-60` |
| **rerank 未调用** | `ModelGateway.rerank` 接口已定义,但 `QdrantMemoryProvider.search` 直接返回 Qdrant score,未做 rerank | `qdrant-memory.ts:18-32` |
| **lexicalRank / graphRank 未填充** | `MemoryHit` 三维 rank 设计存在,但 Postgres 词法检索结果未赋予 `lexicalRank`,无图检索 | `protocol.ts:67-74` vs `postgres-repository.ts:264-279` |
| **timeline / foreshadowing / plot_thread 无显式管理** | 表存在(`timeline_events`/`foreshadowing`/`plot_threads`/`promises`/`payoffs`),但无对应 handler 把这些结构化数据注入上下文或从正文提取 | `001_novel_v2.sql:206-211` 仅表结构,无 activity 操作 |
| **上下文 token 预算偏小** | `buildMemoryBundle` 默认 `tokenBudget=24000`,对百万字长篇(可能上千条 claim)裁剪过激 | `cognition.ts:82` |
| **experiment workspace 章节工作流未接入** | `runClosedLoop` 步骤 4 是 TODO,无法在实验 schema 内跑章节工作流验证 skill 迭代效果 | `closed-loop.ts:123-135` |

### 2.3 事实记忆能力总评

**结论:模型设计业界领先,但闭环不完整。**

- **数据模型**:优于 RecurrentGPT(二分法)、AI_NovelGenerator(文件系统)、NovelAI Lorebook(关键词触发)
- **检索能力**:接近 MemGPT 的分层思想,但 rerank 未启用,lexical/graph rank 未填充,实际只是单轨向量检索 + 词法兜底
- **闭环完整性**:**不如 AI_NovelGenerator**——AI_NovelGenerator 虽然原始,但 `character_state.txt`/`plot_arcs.txt`/`global_summary.txt` 三件套在每次 finalize 时**自动增量更新**,而本项目的 character enrichment 和 chapter memory 都是 TODO
- **长程一致性**:依赖 `narrativeCutoff` + `knowledgeScope` + `authority` 三层,理论上强,但因 chapter memory 缺失,跨章节的事实演进链断裂

---

## 三、高水平网文创作能力评估

### 3.1 网文情感维度对照

用户关心的六个维度:**悬念 / 幽默 / 伤感 / 浪漫 / 意境 / 爽感**。

| 维度 | 当前支持 | 评估 |
|---|---|---|
| **悬念** | ✅ 章尾钩子十型(信息遮断/倒计时/抉择时刻/认知反转等) + reader-reviewer 检查「跳读区」「信息到达时机」 | **较强**,但有钩子库无悬念强度曲线追踪 |
| **幽默** | ❌ 无显式设计,走通用「潜台词优先」「声音指纹」规则 | **弱**,幽默是网文重要调剂,完全依赖 LLM 自发 |
| **伤感** | ⚠️ 通用规则「情感重场戏让环境替角色说话」「2-3 个环境意象承载情绪」 | **中**,有原则无量化 |
| **浪漫** | ❌ 无显式设计,关系进展走 `relations` 表的 `valid_from/to` 时效,但不注入 prompt | **弱** |
| **意境** | ✅ `WRITER_LANGUAGE_AND_LENGTH` 明确鼓励「意象化表达、对偶句式、典故化用」「章尾余韵」 | **较强** |
| **爽感** | ❌ **完全无设计**——无金手指/系统流/废柴逆袭/打脸装逼等网文套路识别,无爽点曲线,无「装逼-打脸-反转」节奏控制 | **缺失**,这是网文核心维度 |

### 3.2 网文类型差异化

| 网文类型 | 当前支持 |
|---|---|
| 玄幻/仙侠 | ❌ 无功法/境界/灵根/法宝等结构化字段 |
| 都市 | ❌ 无职场/商战/社交场景特化 |
| 言情 | ❌ 无 CP 弧光/关系阶段/暧昧张力曲线 |
| 系统/穿越/重生 | ❌ 无系统流套路识别 |
| 历史/架空 | ⚠️ 通用「时代语言」「典故化用」规则覆盖 |

**结论:架构是「题材无关」的通用文学创作系统,不是网文特化系统。** AGENTS.md 明确要求「reusable contracts over case-specific prompt prohibitions」,这是有意的设计选择,但也意味着网文爽点能力需要靠 craft rule 沉淀,而非骨架内置。

### 3.3 高水平网文能力总评

**结论:文学性骨架优秀,网文爽感内核缺失。**

- **文学性维度(意境/悬念/单 POV/潜台词/章尾钩子)**:✅ 接近 Sudowrite/NovelCrafter 水准,某些方面(如「禁止作者式心理结论句」7 类范式)甚至更细致
- **网文爽感维度(爽点/打脸/装逼/金手指/套路)**:❌ 完全无设计,需要靠 craft rule 沉淀,但 craft rule 闭环的 experiment workspace 未接入,无法快速沉淀
- **追更体验**:✅ `reader-reviewer` 角色明确为「严苛追更读者」,检查「跳读区」「卖点兑现」「章尾驱动力」
- **节奏控制**:⚠️ 有「铺陈/相处/蓄势/行动/余波/兑现」六型章节功能识别,但无跨章节节奏曲线
- **角色一致性**:❌ 因 characterEnrichment 未实现,角色声部/弧光只能靠 `character-reviewer` 单点审校,无回写无累积

---

## 四、LLM 创作最佳流程符合度

### 4.1 ✅ 符合最佳实践

| 最佳实践 | 实现 |
|---|---|
| **分阶段 workflow** | Temporal durable execution,preflight→memory→skill→blueprint→draft→review→revision→fact→learning→commit |
| **artifact-based** | 所有中间产物都是 artifact(`artifacts` 表,kind=draft/review/revision/fact-extraction/summary),带 `artifactFingerprint` 防篡改 |
| **structured output** | JSON Schema + AJV 严格校验 + `maxRepairAttempts=2` 修复 |
| **model routing** | 13 个 purpose(planning/writing/review/facts/learning/skill/memory),每个 purpose 多候选链 + external-mcp 兜底 |
| **多模型支持** | LiteLLM 网关聚合 OpenAI/Anthropic 等;Chat Completions + Responses API 双协议 |
| **流式输出** | SSE 支持(`responseMode: "sse"`) |
| **task-chain 续接** | `previousResponseId` 续接上一轮对话(writing.* purpose 限定) |
| **审计 provenance** | `ModelInvocationRecorder` 记录 workflowRunId/taskId/purpose/configRevision/candidateIndex/executor/profileId/protocol/model/status/tokens/latency/promptFingerprint/responseId |
| **幂等性** | `idempotency_keys` 表 + `Intent.idempotencyKey` |
| **乐观锁** | `commitRevision` 用 `SELECT ... FOR UPDATE` + `current_revision === baseRevision` 校验 |
| **外部 MCP 兜底** | 每个生成类 activity 都有 `ExternalMcpRequiredError` 捕获分支,创建 `model_task` 等待外部提交 |
| **review/revision 闭环** | 5 reviewer 并行 + 多轮修订(改善度阈值防无限循环) |
| **learning 闭环** | propose-improvement 自动触发 craft rule candidate,带回归验证 |
| **prompt 版本化** | `005_prompt_templates_versioning.sql` + `prompt_templates` 表 |

### 4.2 ❌ 不符合或缺失

| 缺失 | 影响 |
|---|---|
| **双门 commit 强制可能阻塞迭代** | 高风险任务必须 internal + independent 双 passed,创作早期迭代成本高 |
| **maxAutoRevisions=2 偏保守** | 复杂章节可能需要 3-5 轮,但被强制进入人工队列 |
| **无 chain-of-thought / reflection** | LLM 直接生成最终稿,无显式「思考-批评-重写」内省循环 |
| **无 multi-agent debate** | 5 reviewer 是并行独立审,无相互辩论/收敛机制 |
| **上下文 24K 预算偏小** | 长篇后期记忆累积大,24K 裁剪过激;无动态预算调整 |
| **无 rerank** | 检索结果直接用 Qdrant score,未做 cross-encoder rerank |
| **无显式 long-context 管理** | 没有 MemGPT 式 RAM/Disk 分层,无「记忆压缩」「记忆搬运」机制 |
| **character enrichment 缺失** | 角色弧光无法累积,长篇后期角色容易扁平化 |
| **experiment workspace 未接入** | skill 迭代无法在实验 schema 内验证,closed-loop 步骤 4 是 TODO |

### 4.3 LLM 创作最佳流程总评

**结论:工程化程度业界领先,但创作智能层有短板。**

- **工程化**(workflow/artifact/audit/routing/idempotency/乐观锁):✅ 优于所有调研的开源项目
- **创作智能**(reflection/debate/long-context/character enrichment):❌ 不如 RecurrentGPT 的三件套输出哲学,不如 MemGPT 的分层记忆,不如学术项目的 controller/reranker
- **整体**:符合度约 **75%**,工程骨架达标,创作智能层需要补齐

---

## 五、开源参考库对照

### 5.1 直接对标项目

| 项目 | GitHub | 核心架构 | 与本项目对照 |
|---|---|---|---|
| **AI_NovelGenerator** | [YILING0013/AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) | Python GUI,5 路由 LLM(architecture/chapter_outline/prompt_draft/final_chapter/consistency_review),文件系统 artifact,`global_summary.txt`+`character_state.txt`+`plot_arcs.txt` 三件套,向量检索,`consistency_checker.py` 独立模块 | **最接近的竞品**。优点:三件套自动增量更新(本项目 chapter memory 是 TODO);缺点:无 review/revision 闭环、无 fact-extraction、无 character enrichment、无 learning 沉淀、无 workflow 引擎 |
| **RecurrentGPT** | [aiwaves-cn/RecurrentGPT](https://github.com/aiwaves-cn/RecurrentGPT) | LSTM 类比,每步输出「正文 + 下一段 brief plan + 更新 short/long memory」三件套,human-in-the-loop | **核心思想同源**。本项目的 `ChapterBlueprint.beats` + `contextPacket` + `MemoryBundle` 是 RecurrentGPT 三件套的工程化升级。缺点:RecurrentGPT 已停维护(2024-05) |
| **DOC / doc-storygen-v2** | [yangkevin2/doc-story-generation](https://github.com/yangkevin2/doc-story-generation) / [facebookresearch/doc-storygen-v2](https://github.com/facebookresearch/doc-storygen-v2) | 多层 outline 深度(`--outline-levels 3`),三阶段(plan+outline→main story→controller/reranker),relevance_reranker + coherence_reranker + detailed_controller | **多层 outline 思想可借鉴**(对应 ChapterBlueprint beats 层级)。缺点:学术代码,基于 OPT-175B,工程化程度低 |
| **SillyTavern** | [SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern) | 角色卡(Character Card YAML/JSON),多模型适配器,预设系统,STScript 宏,群聊多角色 | **角色卡思想**对应 character enrichment,但 SillyTavern 是角色扮演非章节生成。200+ 贡献者,极活跃 |
| **novelWriter** | [vkbo/novelWriter](https://github.com/vkbo/novelWriter) | Python+Qt 纯文本编辑器,非 LLM | 仅作写作工具生态参考,**无可比性** |

### 5.2 商业闭源产品(架构可借鉴)

| 产品 | 核心机制 | 可借鉴点 |
|---|---|---|
| **Sudowrite** | Story Bible(手动维护的脑瓜扔+体裁+风格+大纲+角色+概述),Story Engine 场景级散文生成,Muse 微调模型 | Story Bible 结构化思想 → 本项目的 entities/relations/memory_claims 已更优 |
| **NovelCrafter** | Codex(手动世界构建百科),多模型 BYOK,Scene Beats 细粒度场景 | **Scene Beats** 对应 ChapterBlueprint beats,思想接近 |
| **NovelAI** | Lorebook(关键词触发的设定簿),Kayra 自研模型 | Lorebook 关键词触发 → 可借鉴为伏笔触发注入机制 |
| **EPOS-AI** | 112.5K 字全文常驻上下文,3 级 AI 编辑 | 全文常驻思路(对立于 RAG) |

### 5.3 学术记忆/Agent 系统(非小说专用但可借鉴)

| 项目/论文 | 核心机制 | 可借鉴点 |
|---|---|---|
| **MemGPT / Letta** (ICLR 2024) | OS 式虚拟上下文,RAM/Disk/Cold Storage 三层,中断驱动记忆搬运 | 上下文工程分层,解决 24K 预算偏小问题 |
| **Generative Agents** (UIST 2023) | 记忆流 + 反思 + 规划,Recency×Importance×Relevance 检索 | chapter memory 检索排序公式 |
| **Voyager** (NeurIPS 2023) | 可复用代码作为长期记忆(技能库) | 已实现于 skill-iteration / craft rule candidate |
| **Mem0** (2025) | 实体-关系三元组图记忆,渐进式更新 | 知识图谱式角色关系追踪 |
| **CHIRON** (EMNLP 2024) | 长叙事角色表征系统 | 角色「状态向量」化 → character enrichment |
| **FACTTRACK** (NAACL 2024) | 时间感知世界状态追踪 | 「什么在什么时候为真」→ 对应 fact extraction + narrativeCutoff |
| **Agents' Room** (ICLR 2025) | 多智能体协作叙事 | 多角色分工解决复杂叙事一致性 |
| **Narrative Knowledge Weaver** (arXiv 2026) | 叙述中心 RAG | 把通用 RAG 特化到叙事领域 |
| **SCORE** (arXiv 2025) | 检索增强故事连贯性 | 检索提升故事连贯性的系统化方案 |

### 5.4 本项目相对开源项目的差异化优势

**调研发现,目前没有任何开源项目同时具备以下全部特征:**

- ✅ 完整的 `review → revision → approval → fact-extraction → commit` 多阶段闭环(Temporal durable execution)
- ✅ 5 种 reviewer 并行(plot/continuity/style/character/reader),分 internal/independent 双门
- ✅ 章节审校工作流复用(`chapterReviewWorkflow` 从 review 阶段半截启动,严格复用正式闭环)
- ✅ learning 闭环(`propose-improvement` 自动触发 `createCraftRuleCandidate`,带回归验证)
- ✅ artifact-based + ContextManifest 审计可复现
- ✅ 13 purpose 模型路由 + LiteLLM 多供应商 + external-mcp 兜底
- ✅ 11 类事实去重 + 4 级 authority + narrativeCutoff + knowledgeScope

**本项目的独特定位**:在 MCP 工作流 + Temporal + 完整 stage 闭环 + learning 沉淀这四个维度的组合上,**目前没有直接对标的开源项目**。最近的竞品 AI_NovelGenerator 是文件系统 + GUI 桌面应用,无 workflow 引擎、无 review/revision 闭环、无 learning 沉淀。

### 5.5 本项目相对开源项目的劣势

| 劣势 | 对照项目 |
|---|---|
| character enrichment 未实现 | AI_NovelGenerator 的 `character_state.txt` 自动增量更新 |
| chapter memory 未实现 | AI_NovelGenerator 的 `global_summary.txt` 自动增量更新 |
| 无多层 outline 深度 | DOC 的 `--outline-levels 3` |
| 无 rerank | DOC 的 coherence_reranker + relevance_reranker |
| 无 long-context 分层 | MemGPT 的 RAM/Disk/Cold Storage |
| 上下文 24K 预算偏小 | EPOS-AI 的 112.5K 全文常驻 |
| 无显式网文爽点控制 | (无开源对标,但商业产品如 NovelAI 有题材微调模型) |

---

## 六、能力矩阵总评

| 能力维度 | 评分 | 评价 |
|---|---|---|
| **架构骨架**(workflow/闭环/审计) | ⭐⭐⭐⭐⭐ | 业界领先,优于所有开源项目 |
| **事实记忆模型** | ⭐⭐⭐⭐ | 模型设计优秀,但闭环不完整(chapter memory/character enrichment 未实现) |
| **事实检索能力** | ⭐⭐⭐ | 双轨设计存在,但 rerank/lexical/graph rank 未填充,实际单轨 |
| **长程一致性** | ⭐⭐⭐ | narrativeCutoff + knowledgeScope + authority 三层防护,但 chapter memory 缺失导致跨章演进链断裂 |
| **文学性创作** | ⭐⭐⭐⭐ | writer-rules 细致(7 类心理结论范式、单 POV、潜台词优先、章尾钩子十型),接近 Sudowrite 水准 |
| **网文爽感创作** | ⭐⭐ | 完全无设计,需要 craft rule 沉淀,但 experiment workspace 未接入 |
| **角色一致性** | ⭐⭐ | character-reviewer 单点审校,无 enrichment 回写,无累积 |
| **LLM 工程化** | ⭐⭐⭐⭐⭐ | 13 purpose 路由 + LiteLLM + 双协议 + 流式 + 审计 + 幂等 + 乐观锁,业界领先 |
| **LLM 创作智能** | ⭐⭐⭐ | 无 reflection/debate/long-context 分层,符合度约 75% |
| **经验沉淀闭环** | ⭐⭐⭐⭐ | propose→evidence→review→promote→rollback 全生命周期,但 experiment workspace 未接入验证 |

**综合评分:⭐⭐⭐⭐ (4/5)**

**一句话总结:工程骨架业界领先,创作智能层和网文特化能力有明确短板,character enrichment 和 chapter memory 是契约债务(AGENTS.md 已要求但未实现),网文爽感是能力空白(无任何设计)。**

---

## 七、改进方向(仅列举,不实施)

按优先级排序,供后续决策:

### P0 — 契约债务(AGENTS.md 已要求但未实现)

1. **实现 `characterEnrichmentStageHandler`**:从定稿章节提取角色声部/动机/知识边界变化,回写到 `entities` 表 + `character_knowledge` 表。参考 CHIRON 的角色状态向量思想。
2. **实现 chapter memory 创建**:`commit-service.ts` 扩展,为新 `DocumentRevision` 创建 chapter memory(章节级摘要 + 关键事件 + 角色状态快照)。参考 AI_NovelGenerator 的 `global_summary.txt` 三件套。
3. **接入 experiment workspace 章节工作流**:补齐 `closed-loop.ts` 步骤 4,让 skill 迭代能在实验 schema 内验证。

### P1 — 创作智能层短板

4. **引入 rerank**:`ModelGateway.rerank` 已定义,在 `QdrantMemoryProvider.search` 后追加 cross-encoder rerank,提升检索精度。参考 DOC 的 coherence_reranker。
5. **补全 lexicalRank / graphRank**:Postgres 词法检索结果赋予 `lexicalRank`,引入实体关系图检索赋予 `graphRank`,实现真正的三轨融合。
6. **上下文预算动态调整**:按 taskClass + memory size 动态调整 tokenBudget,长篇后期可扩展到 64K+。参考 MemGPT 的 RAM/Disk 分层。
7. **引入 reflection 机制**:在 draft 后、review 前增加「自我反思」步骤,让 LLM 先批评自己的草稿再交 reviewer。

### P2 — 网文特化能力

8. **网文套路识别模块**:识别金手指/系统流/废柴逆袭/打脸装逼等套路,作为 craft rule 沉淀(不走骨架内置,符合 AGENTS.md 的 reusable contracts 原则)。
9. **爽点曲线追踪**:在 `memory_claims` 之上增加 `payoff_curve` 表,追踪伏笔埋设-兑现-爽点强度曲线。参考本项目已有的 `foreshadowing`/`promises`/`payoffs` 表(已存在但未使用)。
10. **网文类型差异化**:按项目 `premise`/`genre` 字段(当前未写入 metadata,见 `handlers.ts:519` TODO)注入题材特化的 craft rule。

### P3 — 长程一致性增强

11. **timeline / foreshadowing / plot_thread 显式管理**:表已存在,需要 activity 把这些结构化数据注入 prompt 上下文,并从正文提取更新。
12. **multi-agent debate**:5 reviewer 之间增加辩论轮次,收敛共识。
13. **记忆压缩/搬运**:参考 MemGPT,长篇后期对旧 chapter memory 做压缩归档,只保留关键事件。

---

## 八、关键文件路径索引

### 架构骨架
- `f:\GitHubProject\Ymcp\web\src\novel-v2\temporal\workflows.ts` — 3 个 Temporal workflow
- `f:\GitHubProject\Ymcp\web\src\novel-v2\temporal\activities.ts` — 21 个 activity
- `f:\GitHubProject\Ymcp\web\src\novel-v2\cognition.ts` — 纯函数认知编排
- `f:\GitHubProject\Ymcp\web\src\novel-v2\protocol.ts` — 全领域类型协议

### 事实记忆
- `f:\GitHubProject\Ymcp\web\src\novel-v2\fact-extraction\index.ts` — `extractFactsFromText`
- `f:\GitHubProject\Ymcp\web\src\novel-v2\fact-extraction\dedupe.ts` — 11 类去重
- `f:\GitHubProject\Ymcp\web\src\novel-v2\fact-extraction\classify.ts` — 风险分类
- `f:\GitHubProject\Ymcp\web\src\novel-v2\qdrant-memory.ts` — 向量检索
- `f:\GitHubProject\Ymcp\web\src\novel-v2\postgres-repository.ts` — Postgres 持久化 + 词法检索
- `f:\GitHubProject\Ymcp\web\deploy\postgres\001_novel_v2.sql` — 26 张表 schema

### 创作质量控制
- `f:\GitHubProject\Ymcp\web\src\novel-v2\prompts\chapter-draft.ts` — 草稿 prompt(15 段)
- `f:\GitHubProject\Ymcp\web\src\novel-v2\prompts\chapter-review.ts` — 5 reviewer prompt
- `f:\GitHubProject\Ymcp\web\src\novel-v2\prompts\writer-rules.ts` — 写作硬约束常量
- `f:\GitHubProject\Ymcp\web\src\novel-v2\commit-service.ts` — 双门提交(仅 16 行,缺 chapter memory)
- `f:\GitHubProject\Ymcp\web\src\novel-v2\temporal\revision-policy.ts` — 修订决策

### 经验沉淀
- `f:\GitHubProject\Ymcp\web\src\novel-v2\learning-assessment.ts` — 运行时学习评估
- `f:\GitHubProject\Ymcp\web\src\novel-v2\craft-rule\index.ts` — 7 函数全生命周期
- `f:\GitHubProject\Ymcp\web\src\novel-v2\craft-rule\promotion-service.ts` — 原子晋升
- `f:\GitHubProject\Ymcp\web\src\novel-v2\evaluation\closed-loop.ts` — 评估闭环(步骤 4 TODO)

### 未实现项证据
- `f:\GitHubProject\Ymcp\web\src\novel-v2\commit-service.ts` — 仅 16 行,无 chapter memory
- `f:\GitHubProject\Ymcp\web\src\novel-v2\evaluation\closed-loop.ts:22-25` — characterEnrichment TODO
- `f:\GitHubProject\Ymcp\web\src\novel-v2\evaluation\closed-loop.ts:123-135` — experiment workspace 章节工作流 TODO
- `f:\GitHubProject\Ymcp\web\src\novel-v2\mcp\handlers.ts:519` — premise/genre 未写入 metadata

### 架构契约
- `f:\GitHubProject\Ymcp\web\AGENTS.md` — 四类契约(迭代改进/章节审校复用/经验沉淀/IndexedDB 删除)
- `f:\GitHubProject\Ymcp\web\.trae\documents\novel-architecture-audit-and-refactor.md` — v1→v2 审计
