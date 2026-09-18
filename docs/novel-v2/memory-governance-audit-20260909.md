# 记忆治理审计：事实与人物数据的重复成因与规避方案（2026-09-09）

> 审计对象：当前活跃小说项目（第 1-20 章已定稿，360 条 memory_claims，16 个实体）。
> 方法：直接对 PostgreSQL 真源做 SQL 量化取证 + 逐条回溯写入路径源码（`src/novel-v2/`）。
> 定位：诊断文档，不是修复规格；修复遵循 AGENTS.md「根因分析与迭代改进」，见 §5-§6。
> 相关契约：[workflow-map.md](./workflow-map.md) §4（上下文编译/事实抽取）、§7（修订、事实与学习）。

## 1. 结论摘要

1. 事实账本中**约 82% 的同章事实共现对来自两条独立提取管道对同一章正文的重复劳动**（1158 对共现、473 对共享主体），且两管道的身份键、谓词体系、哈希体系互不兼容，存储层与检索层双重去重全部失效。
2. 人物身份解析只覆盖 character-enrichment 一条路径；fact-extraction 路径的主体 ID 完全由模型自由生成，同一人物在 `subject_refs` 中出现 2-4 种键形态，**任何按主体键聚合/过滤/图遍历的下游都失明**。
3. Foundation 每次 approve 都追加一条整段投影 claim 且 `supersedes` 硬编码为空，**56 条 Foundation 投影全部 active**（project-positioning 17 个版本、characters 15、worldview 12…），检索层把它们当作 56 份独立长期记忆竞争。
4. "重复事实"不表现为 content_hash 精确重复（0 组）——**精确哈希防线是有效的**；重复全部发生在语义层（同义改写、跨管道、跨章重述），而现有防线（批内 dedupe、LIMIT 200 摘要、模型 novelty 自评）对语义层重复系统性失明。
5. 规避方案的核心是把**人物身份注册表与事实指纹函数下沉为所有写路径的共享契约**（最低共享层），并把**跨管道语义等价判定交给外部 LLM 审核通道**——机械层已证明无法可靠判定同义改写，这正是外部编排模式的用武之地。

## 2. 数据现状量化（取证快照 2026-09-09）

### 2.1 memory_claims 构成（active 345 条）

| 写入管道 | 条数 | identity_hash | 判定依据 |
| --- | --- | --- | --- |
| fact-extraction（`claim:{projectId}:{valueHash24}`） | 145 | 145/145 有 | 结构化哈希（`fact-extraction/fingerprint.ts`） |
| character-enrichment（`claim:knowledge:{revisionId}:{hash16}`） | 142 | **0/142 有** | 字符串哈希（`character-enrichment/index.ts` L250），无 identity 概念 |
| Foundation 投影（`foundation:{artifactId}`） | 56 | 0/56 有 | `foundation-memory.ts`，`supersedes: []` 硬编码 |
| chapter-memory rollup | 2 | — | 正常 |

- content_hash 精确重复：**0 组**（唯一索引 `memory_claims_project_content_scope` 生效）。
- identity_hash 共享组：12 组 / 112 条（最大组 40 条 `楚衡|知晓`、29 条 `执事弟子|知晓`、15 条 `楚衡|持有`）——它们是**不同事实共享同一 identity 槽位**（identity=subject+predicate，设计如此），但检索层合并键无法利用这一点。
- 近重复语义对（trigram similarity>0.25、同章、共享主体）：**473 对**；top 谓词组合：`知晓×character-knows` 194、`状态变化×character-knows` 140、`持有×character-knows` 71、`位于×character-knows` 24。

### 2.2 主体键碎片化（subject_refs 值域）

| 人物 | 实际出现的键形态（条数） |
| --- | --- |
| 主角 | `char_chu_heng`(217)、`楚衡`(18)、`chu_heng`(4) |
| 内门来客 | `齐姓人`(6)、`char_qi`(4)、`inner_disciple_qi-char_chu_heng`(1) |
| 周姓师兄 | `周师兄`(4)、`char_zhou_xiong_shi`(2) |
| 刘管事 | `char_liu_guan_shi`(2)、`刘管事`(2)、`管事`(2) |
| 赵虎 | `char_zhao`(12)、`赵虎`(1) |
| 非人物主体 | 老槐树、天枢峰、引气诀、宗门等全部为自由字符串，无实体注册 |

### 2.3 人物实体（entities 16 条）

- 同一人物双实体：`entity:…:character:char_liu_guan_shi`（已富化，声部/动机完整）与 `entity:…:character:刘管事`（`autoCreatedFrom: relation`、`pendingEnrichment: true`、早期章节独立富化过、声部历史与前者**不同步**）。
- 16 个实体只覆盖人物；地点/物件/功法/组织（subject_refs 中的非人物主体）**完全没有实体层**，永远无法参与图检索。

### 2.4 relations

111 行 / 79 个 distinct (subject,predicate,object)。行数 > 语义数是版本化设计（id 含 revisionId），但**没有"当前有效关系"投影**，图遍历会重复计数。

## 3. 重复是如何产生的：六条机制

### M1 双管道对同一章正文重复提取，语义重叠区无人对账

- **机制**：正式链路 `extractFacts → commit → enrichCharacters` 中，fact-extraction 从正文提取全局事实（含"角色知识变化"，谓词=知晓），character-enrichment 随后又从**同一章正文**提取 `newKnowledge` 写成 episodic claim（谓词=`character-knows`）。同一"谁知道什么"被两条管道各记一次。
- **证据**：同章共现 1158 对；实例——同一章中 fact-extraction 写入"功德司执事在楚衡转身离开时叫住他点名警告：名册上再欠就直接排守夜"，enrichment 写入"听闻名册上再欠就直接排守夜"；"齐姓人提出交易"同时以 `claim:novel…` 与 `claim:knowledge…` 两种 id、两套主体键（`char_qi` vs `齐姓人`）落库。
- **为什么防线没拦住**：dedupe（`fact-extraction/dedupe.ts` 11 类）只覆盖**批内**与**精确 contentHash**；两管道的 id 前缀、subject 键、谓词、哈希函数完全不同，唯一索引 `memory_claims_project_content_scope` 前缀就不同，永远不冲突。

### M2 人物身份注册表不是共享契约，主体键由模型即兴生成

- **机制**：`character-identity.ts` 的 `buildCharacterIdentityIndex`/`resolveCharacterIdentity` 只在 character-enrichment 路径被调用；`buildFactExtractionPrompt`（`fact-extraction/prompt.ts`）**不注入任何规范人物名册**，只要求"subject.id 必须是正文中可指认的对象"。模型有时自造稳定 ID（char_chu_heng）、有时写显示名（楚衡）、有时写拼音转写（chu_heng），写入时 `classify.ts` 直接 `subjectRefs: [fact.subject.id]`，不做归一。
- **证据**：§2.2 碎片化表；同一事实因主体键不同而获得不同 identityHash，跨章去重与 novelty 判定全部失真。
- **连带伤害**：`knowledgeScope.characterId` 过滤、按 POV 主体的记忆检索、GraphMemoryProvider 的图遍历，凡按主体键匹配处都会漏。

### M3 检索层合并键对两条管道双双失明

- **机制**：`cognition.ts` L215-236 的去重键是 `value:${identityHash}:${valueHash}`，缺 identityHash 时退化为 `id:${claim.id}`。enrichment 的 142 条全部无 identityHash → **每条独立，永不合并**；fact-extraction 条有 identityHash，但与 enrichment 条的谓词/主体键不同 → 键也不同构。
- **后果**：同章同事件的双份记忆一起进入 draft/review/revision 的 ranked-fill，挤占预算并制造微矛盾。

### M4 Foundation 全历史投影常驻 active

- **机制**：`foundationArtifactToMemoryClaim` 的 `supersedes: []` 硬编码；Foundation 每 approve 一次（本项目累计 56 个 foundation artifact，characters/worldview 反复修订重生成）就追加一条整段投影（含最多 12KB 结构化数据转储），旧版本不退役。
- **证据**：`foundation:project-positioning` 17 条、`[foundation:characters]` 系列 15 条（含"主要人物档案/关系网络/群像生态位"等 6 种标题的多个代际）全部 active；它们都携带 `facet:fact` 主体引用，在 required-facet 选择时与真实章节事实竞争。
- **边界澄清**：`project_plan_sections` 只保留最新 approve 版本（工作台读取不受污染）；污染只发生在 memory_claims 与 Qdrant 检索层。

### M5 novelty 判定的输入窗口不足且不可靠

- **机制**：`getFactExtractionContext` 用 `LIMIT 200` 行（narrative_start DESC）拼 claimsDigest 交给模型自评 novelty。第 19 章之后累计 active claim 已达 287 条（其中 234 条在叙事截止内）→ **每章提取都有约 1/6 的历史事实被静默截断**，模型对更早章节的事实重复完全无感；contentHash 精确匹配又对同义改写天然无效。
- **证据**：主角"宗门监控机制"认知在 8/24 与 9/8 两次提取中以不同措辞各存一条；40 条 `楚衡|知晓` 中多组跨章语义重合（如"爆发触发监测/共振"与"大殿红光同步/监控警报机制"）。
- **连带**：`novelty=update` 的 supersedes 填充依赖 `subject.id|predicate` 精确匹配（M2 的键碎片化使其大面积失配），supersede 链形同虚设。

### M6 人物实体的创建与归并不对称

- **机制**：`persistCharacterEnrichment` 对 relation 目标做幂等 UPSERT（entityId 经身份解析）；但**历史上**（以及身份解析 miss 时）`resolveCharacterIdentity` 的 fallback 会以"显示名即 canonicalId"创建实体（`entity:…:character:刘管事`）；Foundation 再生改变人物 ID 后，旧行不合并、`pendingEnrichment` 实体没有对账机制，两条实体各自累积声部历史。
- **证据**：§2.3 双实体；两条 `刘管事` 的 voiceAnchor.history 内容已经分叉。

## 4. 影响面（谁在消费，怎么受伤）

| 消费方 | 受伤方式 |
| --- | --- |
| draft/review/revision 记忆注入（buildMemoryBundle ranked-fill） | 双管道重复 + 12 组 identity 聚簇 + 56 份 Foundation 投影共同挤占 64-128K 预算；重复事实制造微矛盾，reviewer 可能把重复视为"状态重述"误报 |
| required-facet 选择 | `facet:fact` 被 56 条 Foundation 投影共享，Foundation 内容可能挤掉真实章节事实成为 fact facet 的代表 |
| 弧规划/叙事状态账本 | subject 键碎片化 → `characterSpans`/`subjectSpans` 统计失真，资产对照（asset-ledger）分组键取"名词尾 2 字"时被多形态键进一步打散 |
| 角色知识边界 | `knowledgeScope.characterId` 与 subject_refs 键不一致时，人物"知道/不知道"过滤漏判，直接威胁连续性 |
| GraphMemoryProvider | entities 覆盖不全（非人物主体无实体）+ subject_refs 键不匹配 entity id → 图检索召回残缺 |
| learning/审计 | digest 截断使跨章模式信号（如状态重述）在源头就缺失证据 |

## 5. 规避方案（按层，泛化设计）

> 每项先回答：增强哪一层、对哪些输入生效、边界在哪。全部为机制层修复，不引入专名/词表/题材规则。

### 5.1 写入层（P0，最低共享层）

1. **身份注册表成为所有提取路径的强制注入与出口归一**：
   - `buildFactExtractionPrompt` 注入与 character-enrichment 同源的"规范人物名册"（canonicalId + displayName 对，复用 `uniqueCharacterIdentities`）；schema 端 subject.id 契约改为"命中名册 id，或显式声明 new-entity（首次出场）"。
   - `recordMemoryClaims`（所有写路径唯一入口）在落库前对 subject_refs 做身份归一：命中注册表别名 → 重写为 canonicalId；未命中 → 按 `pendingEnrichment` 规则登记新实体，**不允许发明第三种键形态**。
   - 覆盖输入类：fact-extraction、character-enrichment、author 编辑、foundation 投影四条写路径全部生效；边界：非人物主体（地点/物件）本轮仍为自由字符串，可后续再引入实体注册（见 5.4）。
2. **统一事实指纹函数**：enrichment 与 foundation 投影改用（或补齐）`fact-extraction/fingerprint.ts` 的 identityHash/valueHash 体系；enrichment 的 knowledge claim 的 identityHash 用 `(canonicalSubject, character-knows, knowledgeScope)`，使检索层 `value:` 合并键对双管道生效。同一章的两份"谁知道什么"至少在 identity 槽位上对齐，供 5.3 的对账消费。

### 5.2 双管道职责收敛（P0/P1，机制选择）

- **方案 A（推荐，源头消除）**：把"角色知识边界"从 fact-extraction 的提取范围中移除（prompt 的提取规则已有"角色知识变化"类目，收紧为只提取非认知类事实），知识边界单一来源 = character-enrichment。消除语义重叠区，两管道各管一层，去重需求归零。
- **方案 B（保守，保留双管道）**：保留双提取，但 enrichment 写入时若 identity 槽位已有同章 fact claim（M5.1 对齐后可判定），降级为 candidate 并标记 `duplicate-of`，由事实审批门裁决。
- 边界：方案 A 改变提取契约，需回归验证知识边界召回不回退；方案 B 不减信息量但依赖外部/人工裁决产能。

### 5.3 摘要与退役（P1）

1. **Foundation 投影按 taskKey 退役**：新投影落库时把同 `foundation:<taskKey>` 旧 active 投影置 staged（或填 supersedes），保持"每 taskKey 恰一个 active 投影"；历史数据用一次性维护脚本清理。存档价值由 artifacts 表承担（56 个 foundation artifact 本来就全量保留），memory 层只服务检索。
2. **digest 窗口化补全**：`getFactExtractionContext` 在 LIMIT 200 近期行之外，追加按 (canonicalSubject, predicate) 聚合的长期摘要行（每槽位一条最近值 + 计数），让 novelty 判定看到全史而不放大 token。截断行为不再静默：被截断条数写进 digest 头部提示模型"更早历史不可见，无法判 duplicate 时输出 new 而非 duplicate"。
3. **同槽位预算公平**：检索 ranked-fill 对同 identity_hash 聚簇按"每槽位 top-k"配额（k 与阈值标注 TODO 可配置意图），防止 40 条知晓垄断主角预算。

### 5.4 实体与关系治理（P1/P2）

1. **实体归并对账**：后续富化命中 `pendingEnrichment` 实体且注册表已有规范身份时，合并 payload（voiceAnchor history 拼接、motivation 取新）并退役旧行；提供一次性维护脚本处理存量（双 `刘管事` 类）。
2. **非人物主体注册**（P2）：地点/物件/功法引入与人物同构的实体登记（kind 扩展），subject_refs 归一后图检索才能覆盖"老槐树/天枢峰/引气诀"类主体。
3. **relations 当前值投影**：为图遍历提供 (subject,predicate,object) → 最新 valid_from 的视图或查询投影，替代全量行扫描。

### 5.5 外部 LLM 深度参与记忆治理（对齐外部编排模式）

机械层已证明：同义改写的语义等价**无法**可靠机械判定（AGENTS.md 与 workflow-map §7 对 narrative-elements 去重的边界结论一致）。这正是外部编排模式（`.agents/skills/novel-mcp-orchestration`）的切入点——外部大模型作为**事实梳理审核者**参与，意见回流正式工作流，不绕过质量门：

1. **事实梳理审核（fact-grooming review，文本意见契约）**：
   - 新增只读诊断投影（MCP 工具或 REST）：按 (canonicalSubject, predicate) 输出 active claim 分组账本，每组内按相似度排序 + 标注候选重复对（复用 `novel_memory_query` 可先行人工验证价值）。
   - 外部 LLM 按"通过时单行 `PASSED`，不通过时输出可执行梳理意见"的文本契约（`text-review.ts` 既有解析，provider 零依赖）审阅：判定哪些对是语义重复、哪些是状态演化需 supersedes、哪些是误提取。
   - 意见经作者确认后走**既有 claim 生命周期**（candidate → approved/rejected、supersedes 填充），不提供直接改库工具——对齐"外部模型只给方向与意见"的编排边界。
2. **提取阶段的重复预筛**：extractFacts 是结构化调用链的一部分，可在 external 兜底任务的 instruction 中附"近期同槽位事实清单"（M5.3 的聚合摘要），让执行提取的外部模型在生成时直接避免重复——比事后清理便宜一个数量级。
3. **人物档案合并审核**：`pendingEnrichment` 实体与规范实体的合并建议（含声部历史冲突点）作为梳理意见的一部分由外部 LLM 给出，作者批准后执行 5.4.1 的归并。
4. **节奏**：事实梳理不必逐章做；建议挂在弧批次边界（弧 approve 后对本弧涉及主体跑一次），与 serialContext 的窗口语义对齐。

## 6. 验证计划（修复落地时）

1. **回归用例（原失败类）**：同一章双管道提取 → 修复后 enrichment 侧不再产生与 fact 侧同槽位的独立 active 行（方案 A）或被标记 candidate（方案 B）；主角跨章同义改写 → 第二次提取被 digest 聚合行命中。
2. **反例（防过度去重）**：同主体同谓词但值真实变化的状态演化（伤势恶化、持有物易主）必须保留为 update 而非被判重；安静章的合法复述（无新事实）不因聚合行存在而被迫产出行。
3. **跨场景**：换题材项目重跑提取验证身份名册注入与指纹统一不依赖专名。
4. **量化验收**：重放存量提取路径后，同章共享主体共现对中语义重复对占比、identity 聚簇 top1 条数、Foundation 投影 active 数（应= taskKey 数）三项指标下降；draft 预算花销分布对比。
5. **产物检查**：按 AGENTS.md 要求检查实际生成章节的记忆注入 manifest，而非只看脚本分数。

## 7. 实证记录（本文档允许保留项目专名的范围）

- 双管道同章重复实例：`claim:novel-…:74228264…`（"功德司执事…名册上再欠就直接排守夜"）× `claim:knowledge:7c6f24fa…:8df5c232…`（"听闻守夜是宗门对未完成例供杂役弟子的惩罚…"）。
- 跨章同义改写实例：`claim:novel-…:78584592…`（2026-08-24，"楚衡推测自己刚才的爆发触动了天枢峰的某种监测手段，并与异常灵光产生了共振"）× `claim:novel-…:5f386c10…`（2026-09-08，"楚衡观察到天枢峰大殿闪过红光且与灵气逆流时间精确同步，推断宗门存在针对异常灵气波动的监控与警报机制"）。
- 双实体实例：`entity:…:character:char_liu_guan_shi`（声部已富化）× `entity:…:character:刘管事`（pendingEnrichment，声部历史分叉）。
- Foundation 投影代际实例：`[foundation:characters]` 系列下"主要人物档案 / 主要人物档案与关系网络规划 / 主要人物档案（修订版：赵虎身份修正与译名统一）"多代并存，最后一代标题本身即是在修人物身份混乱——**身份治理债务已经反噬规划层**。

## 8. 实施记录（2026-09-09）

P0/P1 机制层修复已落地，机制契约同步至 [workflow-map.md](./workflow-map.md) §4「人物身份注册表共享契约与事实指纹统一」「Foundation 投影代际退役」两段：

- **身份归一 + 名册注入**：`fact-extraction/prompt.ts`（规范人物名册段）、`fact-extraction/index.ts`（`projectFactExtractionOutput` 在指纹与批内去重前按身份索引归一主体）、`temporal/activities.ts` 与 `application/chapter-state-rebuild.ts`（extractFacts / materializeExternalFacts / 状态重建三条路径同契约，注册表读取失败降级为无归一）。实施取归一位置在 classify 前的更优解，未改 `recordMemoryClaims` 入口——归一必须先于哈希计算，落库层归一会造成 identity_hash 与 subject_refs 失配。
- **指纹统一**：`fact-extraction/fingerprint.ts` 放宽为最小输入形状（`FactIdentitySource`/`FactValueSource`），`character-knows` 纳入"知晓"别名集；`character-enrichment/index.ts` 的 knowledge claim 补 identityHash/valueHash、谓词落规范形式。
- **Foundation 退役**：`postgres-repository.recordFoundationClaim`（同 taskKey 最新 artifact 投影 active + supersedes，旧代际回填 staged；内部生成、external 物化、ensure 回填三处同契约）；`listIndexableMemoryClaims`/`countIndexableMemoryClaims` 同口径排除被退役行（可索引集 = 检索可见集）。
- **digest 槽位聚合**：`getFactExtractionContext` 增加同主体同谓词历史槽位（累计条数 + 最近值）与明细截断提示（截断时指示模型对不可判历史输出 new 而非猜测 duplicate）。
- **存量回填**：`scripts/novel-v2-memory-governance-backfill.ts`（`pnpm novel:v2:memory:backfill`，dry-run 默认 / `--apply` 写回，幂等已验证）。当前项目实测：subject 归一 19 行（`楚衡`→`char_chu_heng` 等）、knowledge 指纹回填 142 行、fact identity 重算 17 行、Foundation 退役 5 组 51 条（56 → 5 条检索可见）。剩余碎片 `char_qi`(4)/`chu_heng`(4) 为模型自造 ID，属 §5.5 机械边界，交外部事实梳理。
- **验证**：tsc 双配置通过；novel-v2 全量 82 文件 749 测试通过；幂等重跑计划为零。
- **待办（2026-09-09 第二批实施，见 §8.1）**：① 双管道职责收敛方案 A 已实施；② 实体归并与 pendingEnrichment 对账已实施；③ 同槽位 top-k 检索配额已实施；④ Qdrant 全量重建已执行（零停机别名切换）；⑤ 外部事实梳理审核通道已实施（MCP 只读工具 + 文档契约）。

## 8.1 第二批实施记录（2026-09-09，同日）

1. **方案 A（双管道职责收敛）**：`buildFactExtractionPrompt` 移除"角色知识变化"提取类目并新增边界说明（认知事实由 character-enrichment 单一来源按 knowledgeScope={characterId} 落库）；`character-knows`→"知晓"谓词别名保留供历史数据对账。前置验证：enrichment 覆盖本章所有有戏份角色的知识边界。
2. **实体归并**：`persistCharacterEnrichment` 主体回写时归并别名实体行（`mergeRetiredEntityPayload`：声部历史拼接去重、动机兜底）并标记 `mergedInto` 退役；`buildCharacterIdentityIndex` 跳过退役行；知识工作台与 H3 角色基线读取同谓词排除。回填脚本新增实体归并步骤——存量双 `刘管事` 已归并（legacy 行 mergedInto → `char_liu_guan_shi`，payload 含合并声部历史）。
3. **检索槽位配额**：`buildMemoryBundle` ranked-fill 每 identityHash 最多 3 条（TODO 可配置），pinned/required 先于配额占位；超限按新 `identity-slot-quota` 原因写排除回执。
4. **Qdrant 全量重建**：零停机路径——重建至新集合 `novel-memory-bge-m3-v2`（267 点 = 可索引 claims 182 + chapter memories，脚本内建计数校验通过）后切别名 `novel-memory-current`；旧物理集合 `novel-memory-bge-m3-v1` 保留待手动清理。
5. **外部事实梳理审核通道**：新模块 `src/novel-v2/memory-grooming.ts`（槽位分组 + 字符二元组 Dice 候选排序，纯 TS 无扩展依赖）+ MCP 只读工具 `novel_memory_grooming_report`（real-data 冒烟：`char_chu_heng|知晓` 槽位 128 条、近重复候选对已浮出）；编排契约与意见回流路径写入 `mcp-orchestrator.md` §4.1。
6. **验证**：全量测试通过（含新增：实体归并、槽位配额、梳理模块 3 组用例）；spec 同步至 `workflow-map.md` §4 与 `mcp-orchestrator.md` §4.1。
7. **勘误（2026-09-15 实测核对）**：§8.1-4 描述的别名切换已不是当前实况。2026-09-11 又以默认目标集合 `novel-memory-bge-m3-v1` 重跑过一次 `pnpm novel:v2:memory:reindex`（`runtime_configuration.embedding-index` 记录 371 点、`completedAt` 2026-09-11），别名 `novel-memory-current` 回到 **v1**；v2（339 点）成了未晋升的孤儿代。即"待手动清理"的对象已反转：v1 是在用索引，v2 与版本化改造前的 0 点旧壳 `novel-memory` 才是可删派生数据，二者已于 2026-09-15 删除（含 `embedding-reindex:novel-memory-bge-m3-v2` 进度行，避免 `reindex-novel-memory.ts:23` 读到假"completed"跳过重建）。删除后 `GET /ready` 的 `qdrant.ok` 与 `embedding.ok` 仍为 true。**结论：清理 Qdrant 集合前必须以 `/aliases` 实况为准，不得照本节原文照搬。**
8. **复审修复（2026-09-09 审核）**：① `replaceCommittedChapterFactSources` staging 范围收窄——幸存 revision 的富化声明（挂在 commit artifact 上）不再被状态重建 staged，修复"章节重建后角色知识边界从检索消失"的缺口（方案 A 后知识单一来源，此缺口会被放大；回归测试加入 fact-revision-lifecycle）；② 回填脚本补 predicate 列归一（142 行 character-knows → 知晓，存储层与指纹自洽），已应用并验证幂等。复审同时确认：Foundation 投影"最新代际 active"规则与 `projectPlanSections` 的最新生成语义一致（5 个 taskKey 的 active 投影与批准基线逐一对齐）；正常 re-commit 链路经 commitRevision 的 source 删除 + claim 清理，无重复/残留。
