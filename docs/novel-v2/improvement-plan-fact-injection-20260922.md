# 事实检索注入与新事实验证 — 改进计划（2026-09-22）

- 依据：用户对流水线现状的元层质疑——"事实表（当前好像已经有了）应如何按创作方向检索注入、并在审核时验证新产生的事实"，以及本会话 018–025 逐章严苛读者验收中暴露的跨章硬矛盾（020 账册日期、021 交易条款推翻、024 玉牌归属）。
- 目标：把 CONTEXT.md 已定义的完整事实系统（叙事事实 / 事实断言 EAV / 时间锚点 / 事实截止点 / 上下文层级 / 视角边界 / 信息视角 / 待复核事实 / 影响标记）从"设计完备"推进到"生成与审核双闭环真正落地"。
- 定位：**不重复建设**。`src/novel-v2` 的事实表（`memory_claims` EAV）、检索原语（`searchMemory` facets）、提取流水线（`fact-extraction`）与审校三审都已存在且工程扎实。本计划只补两道**设计与执行之间的落差缝**，并正面回应"会不会变成没有限制的垃圾注入"的担忧。
- 与 `improvement-plan-20260922.md`（craft 级信号：收束轮换 / 半X 克制 / 对白配额 / 章长）是**互补关系**，本文不重复那张表的条目。

---

## 〇、审计结论：事实系统"设计完备、落地待缝"

| 能力（设计层已存在） | 真实代码位置 | 现状 |
|---|---|---|
| 事实表 / EAV 断言（subject\|predicate → value，含 `subject_refs`/`thread`/`knowledge_scope`/`authority`/`lifecycle_status`/`supersedes`） | `memory_claims` 表 + `fact-extraction/index.ts`（`normalizeFactSubjectId` 身份归一、`existingClaimsIndex` 屏蔽被覆盖版本） | ✅ 真源已建，去重/归一已做 |
| 检索原语（可按 facet 主题/实体/线程定向、按 `narrativeCutoff` 封时间边界） | `postgres-repository.ts:949` `searchMemory({projectId, facets, narrativeCutoff?, povCharacterId?})` | ✅ 原语可用，**但未接入章节创作方向** |
| 提取流水线（风险分级 `classifyFactCandidates` + 时间边界 `scopeClaimsToChapter`） | `fact-extraction/` | ✅ 提取侧已建 |
| 上下文装配（预算 `ranked-fill` + `identity-slot-quota` + 冻结事实注入） | `cognition.ts` `buildMemoryBundle` | ✅ 装配已建，**但检索是被动 ranked-fill，无方向驱动** |
| 章节创作方向信号 | `chapter_production_specs.chapter_goal` + 蓝图 `participants`/线程 + 弧 `threadResponsibilities` | ✅ 信号已采集，**但未用于派生检索 facet** |
| 跨章序列证据（资产数量账本等） | `asset-ledger.ts` + `SerialContextSnapshot.assetSpans` | ✅ 已落地（实证根因：ch1/ch2 灵石、ch13/ch14 云纹草漂移） |
| 新事实×冻结表矛盾核验 | `getFactExtractionContext` 返回 `claimsIndex`（subject\|predicate → 声明）`postgres-repository.ts:7423`；`MemoryBundle.conflicts` 字段 | ⚠️ **原语在，但缺值级矛盾生产者**——`cognition.ts:321` 现已从 `supersedes` 产出非阻断冲突（`blocking:false`，覆盖确认提示），但"同键不同值"的确定性矛盾核验仍无生产者；专用 `memory-grooming` MCP 已撤除（2026-09-24，零调用） |

**核心落差（两条缝）：**
1. **生成前检索不按"创作方向"主动拉取**：现有检索是"预算竞价 + 截止点过滤"的被动模式。模型要写"翻账/账册"章（020）、"交易条款定版"章（021）、"玉牌流转"章（024）时，相关权威冻结断言没有因"本章方向"被强制注入——它们可能在预算竞价中落选，于是模型凭记忆重写，制造与既有事实冲突的软接缝。这正是三类硬矛盾漏进基线的根因。
2. **审核时新事实无确定性验证**：新章提取出的事实只在 commit 后走 `extractFacts → approveFacts`，没有一道"拿新事实对照冻结表（在 `narrativeCutoff` 之前）做矛盾/一致核验"的确定性门。`structure-reviewer` 的"事实/因果/世界规则"只是 LLM 通用指令，对 020/021/024 这类**已在表中、只是被草稿改写**的矛盾视而不见。（`cognition.ts:321` 的 supersedes 型冲突只覆盖"显式声明覆盖"这一形态，且 `blocking:false`，不构成值级矛盾门。）

**正面回答"垃圾注入"担忧**：方向驱动检索**不会**变成无限制垃圾注入，理由有四——① 检索只读 `active`/`approved` 且经 `supersedes` 退役过滤的**已审定**断言，注入的是已被 vet 的事实而非噪声；② 方向派生 facet 必须**限定在章节计划实际涉及的实体/线程**内（见计划 3 护栏），不开放主题自由扩展；③ 预算 `tokenBudget` + `identity-slot-quota`（每 identityHash ≤3）+ `narrativeCutoff` 三重硬限仍在；④ 新事实仍走 `extractFacts → classify(风险分级) → approveFacts → 事实候选队列` 的晋升门，**不经人工/候选队列确认不进真源**。计划 3 再补一道"注入审计可见性"使强制注入不静默。

---

## 迭代 1：生成前"按创作方向检索注入"事实（P0，最高优先）

### 1.1 缺口与根因
- 实证：020 账册两笔日期（初九戌时 / 十一日午时）是已冻结事实，但 020 草稿把"十一日…二十九日"写成"初九…十一日"——相关账册断言没被拉进本章程的强制上下文。021 交易条款定版（月例翻倍 + 丹药按内门杂役份例）在 021 被草稿推翻为"月供减半折丹药"。024 玉牌归属（阅字牌=偏殿钥匙、取还流程）在 024 被写错归属。
- 根因：检索由 `buildMemoryBundle` 的 `ranked-fill` 决定取哪些 claim，**没有一步把"本章要写什么方向"翻译成"必须带上哪些实体/线程的冻结断言"**。

### 1.2 改动（落在现有装配链路，不新建表）
> 2026-09-29 复核：注入机制本身已存在——`buildMemoryBundle`（`cognition.ts:222`）签名已含 `pinnedClaims?: MemoryHit[]`，pinned 先于配额选择（reason=`pinned-narrative`），且有调用先例（`activities.ts:460` 传 `pinnedClaims: narrativeHits`）。本迭代真正的净新增只有**派生函数**与**调用点接线**两项。
1. 在章节生产规格 / 蓝图编译处新增**事实检索计划（fact retrieval plan）**纯函数：
   - 输入：蓝图 `participants`/`beats` 涉及的实体 + 本章程所属弧的 `threadResponsibilities.threadRef`（及其 `foreshadowingRefs`）。**只从结构化字段派生**；`chapter_goal` 为自由文本，仅用于人工"该章应带哪些事实"清单的吻合度核对，**不作派生主源**（防噪声实体混入）。
   - 产出：`RetrievalFacet[]`，每个 `kind:"fact"`、`query` = 实体名/线程引用、`required:true`；并按 `subject_refs` 收敛（汉语中心语后置同 `asset-ledger.groupAssetSpans` 的尾 2 字归并口径）。
   - **派生集合上限（自迭代 3 前移，P0）**：派生实体数超过魔法值上限（对齐 `identity-slot-quota` 的 `TODO 可配置` 约定）即截断并记 `enhancementWarnings`。理由：pinned 超预算在 `cognition.ts:289` 是**硬 throw**（"不能静默丢弃 pinned 内容"），派生过宽会使章节生成直接失败，护栏必须与注入同步上线，不能等迭代 3。
2. 在 `buildMemoryBundle` 调用前，先用这些 facet 调 `searchMemory({projectId, facets, narrativeCutoff})` 取回命中，作为 **`pinnedClaims`（required 预算）** 注入——保证即使预算竞价落选，方向相关权威断言也强制在场。接线点与 `activities.ts:460` 既有 narrativeHits 同形。
3. `renderChapterExecutionContract` / 正文 draft prompt 增加一个**"本章方向冻结事实"段**（priority=required/critical，非 ranked-fill 候选），渲染对照指令："以下为与本章方向直接相关的已冻结事实，须严格遵循，不得改写其数值/归属/时间"。

### 1.3 边界
- 只强制**方向相关**实体/线程，不把整张事实表灌入；`tokenBudget`/`identity-slot-quota` 仍约束总量。
- 仅注入 `narrativeCutoff` 之前、未被 `supersedes` 退役的声明；视角边界（`povCharacterId`/`knowledge_scope`）照常过滤。
- 不替代 `serialContext` 的跨章序列信号，二者叠加。

### 1.4 验证三件套（项目既有的"真实通道回放 + 人工吻合 + 分母诚实"）
- 取 020/021/024 三章及同类"方向明确但曾漂移"章（含资产账本 ch1/ch2/ch13/ch14）做真实通道回放：断言方向 facet 命中的冻结断言在 `buildMemoryBundle` 输出中**必为 pinned 且出现在 draft prompt 段**。
- 与人工"该章应带哪些事实"清单对齐。
- 分母诚实：报告全 168 章中"方向 facet 触发强制注入"的章占比，避免把"无明确方向"的安静章也算作命中。

---

## 迭代 2：审核时"新事实确定性验证"（P0，与 1 对称）

### 2.1 缺口与根因
- `getFactExtractionContext(projectId, narrativeCutoff)` 已返回 `claimsIndex: Map<subject|predicate, 声明[]>`，本应用于"新事实对照冻结表"——但它现在只服务于**提取去重上下文**（`fact-extraction` 用），审核链路没有消费它做矛盾核验。
- `MemoryBundle.conflicts` 字段已定义，且 `cognition.ts:321` 已从 `supersedes` 产出非阻断冲突（覆盖确认提示）——但"同键不同值"的**值级矛盾生产者**仍缺失。专用 `memory-grooming` MCP（唯一的事实梳理审核通道）已于 2026-09-24 撤除——新事实验证的确定性能力**实际退化**为纯 LLM 判断。

### 2.2 改动（接在 `extractFacts` 之后、`approveFacts`/commit gate 之前）
1. 新增**事实一致性核验活动** `verifyChapterFacts`（纯函数 + 活动）：
   - 输入：本章程 `extractFacts` 产出的新事实（已 `normalizeFactSubjectId` 归一、已 `scopeClaimsToChapter` 封时间边界）+ `getFactExtractionContext(projectId, narrativeCutoff)` 的冻结 `claimsIndex`。
   - 判定（确定性，零模型调用）：
     - 同 `subject|predicate`、值不同 → 若新事实**未携带合法 `supersedes`** 指向该既有声明（且该声明在 `narrativeCutoff` 之前、`lifecycle_status=active`）→ 记为 **`fact-contradiction`** 冲突；
     - 同 `subject|predicate`、值相同但表述异 → 归去重（已被指纹处理，不报）；
     - `subject|predicate` 在冻结表中无记录 → 正常新登记，不报。
   - 输出：**独立的事实核验工件（fact verification artifact）**，含结构化冲突清单。⚠️ 修订（2026-09-29）：原方案"填充 `MemoryBundle.conflicts`"存在时序错位——`MemoryBundle` 产于 draft 之前（preflight 装配，`cognition.ts:321` 的 supersedes 冲突即在此生成），而 `verifyChapterFacts` 跑在 extractFacts 之后，两者生命周期对不上，不做回填；该工件独立落库、随审批链路流转。
2. 把核验工件接入 **commit gate / structure-reviewer 证据**：`fact-contradiction` 作为 `blocker`/`major` issue 进入审批链路，要求作者在 `approveFacts` 前显式裁决（确认是合法的"状态演化 update"并补 `supersedes`，还是草稿误改需回修）。接线模式复用既有先例 `application/chapter-lifecycle.ts:91` 的 `factApprovalBlocked` 阻断通道。
3. 同步 `narrative-continuity.yaml` 的 `chapter.fact-extraction` 执行点：明确"提取后须跑确定性矛盾核验，冲突未裁决不得 promote"。

### 2.3 边界与已知召回风险（刻意不覆盖）
- 只做**值级/身份级**矛盾判定；语义等价（同义改写）仍交人工与既有 claim 生命周期（与 `normalizeFactSubjectId` 注释的"语义等价模糊判定交外部事实梳理"同边界）。
- **键对齐召回风险（2026-09-29 新增）**：确定性判定按同 `subject|predicate` 键命中，`normalizeFactSubjectId` 只归一主体、**不归一谓词**——提取侧谓词粒度漂移（如"账册日期" vs "翻账日期"）会直接漏报。这是本门**主要技术风险**；缓解靠 prompt 名册约束提取谓词词表 + 2.4 的漏报分布监控，不引入模糊匹配（那会重新引入 LLM 不确定性）。
- 不把"无冲突"当质量证明；文学质量仍走三审。
- 不新增硬拒绝通道以外的阻断：冲突以 issue 形式进 gate，作者可裁决，不静默丢弃新事实。

### 2.4 验证
- 构造 020/021/024 的"被改写事实"作为新事实输入，断言 `verifyChapterFacts` 能**确定性**报出与冻结表冲突（对照 LLM 当初漏判的反例）。
- 反例：合法"状态演化"（如凝气丹 023合计4→026裂）须**不报**冲突（因其携带 `supersedes`/时间序合法），验证"不误伤"。
- **漏报分布单独列报（2026-09-29 新增）**：真实通道回放不仅报命中数，还须按"漏报原因"分类（谓词粒度漂移 / 主体归一失败 / 提取未产出该键）——验收时漏报类型分布比命中数更能暴露键对齐风险。
- 真实通道回放：全 168 章 commit 前跑一遍，统计冲突命中分布与分母（合法演化占比）。

---

## 迭代 3：垃圾注入护栏与注入可见性（P1，正面回应担忧）

> 2026-09-29 修订：3.1 的派生集合上限已**前移至迭代 1**（pinned 超预算在 `cognition.ts:289` 是硬 throw，护栏必须与注入同步上线）。本迭代剩余内容为注入审计可见性。

### 3.1 方向 facet 限域（已前移至迭代 1，此处保留设计记录）
- `fact retrieval plan` 产出的 facet **仅限**从蓝图实体/本弧线程引用**显式派生**的实体与线程引用；禁止把"章节正文里偶然出现的词"自动扩成检索主题（防主题漂移式灌入）。`chapter_goal` 自由文本不作派生主源（见 1.2）。
- 派生实体集合上限取魔法值（对齐 `identity-slot-quota` 的 `TODO 可配置` 约定），超出截断并记 `enhancementWarnings`。

### 3.2 注入审计可见性（不静默）
- `buildMemoryBundle` 的 manifest 增加一行 `directionPinnedClaims`：记录因"创作方向"被强制注入（而非预算竞价胜出）的 claim id 列表与来源 facet。
- 与既有 `context_manifests` 抽样（`context-manifest-sampling.ts`）同源落库，使"哪些事实是被方向强制拉入的"在审计面可见，杜绝静默强注。

### 3.3 保留既有三道限流
- 明确声明本计划**不削弱** `tokenBudget`（硬）、`identity-slot-quota`（每 identityHash ≤3）、`narrativeCutoff`（时间封口）三道现有约束；方向强注只是把"应带事实"从竞价候选提升为 required，不改变总量上限。

---

## 迭代间共享的验收纪律（沿用项目既定）
1. **任何新判据交付前出三件套**：真实通道回放命中数、与人工判读吻合度、分母诚实（正常运行占比）。
2. **双向测试 + 反例**：命中面取自真实语料病章（020/021/024），反例至少两个形态各异（含合法状态演化章零命中）。
3. **spec 同步**：每个新门/新契约在 `docs/novel-v2/workflow-map.md` §4/§6/§7 记设计意图、输入输出、被证伪的旧方案（防重提）。
4. **门读数 ≠ 文本有病**：新事实核验只在"值级冲突"时报警，不替模型判文学质量。
5. **落库三安全网**：事实真源改动走 `recordMemoryClaims` 既有幂等键 + 事务；强制注入与冲突裁决留痕。

---

## 排期与依赖

| 迭代 | 依赖 | 建议顺序 |
|---|---|---|
| 1 方向检索注入（含 facet 限域护栏） | 无（纯装配侧，复用 `searchMemory` facets + `buildMemoryBundle` 既有 `pinnedClaims` 参数，`cognition.ts:222`） | 最优先，直接堵 020/021/024 类复发 |
| 2 新事实确定性验证 | 无（复用 `getFactExtractionContext` + 独立核验工件；gate 接线复用 `factApprovalBlocked` 模式） | 与 1 并行，对称补审核缝 |
| 3 注入审计可见性 | 1 落地后（依赖 `fact retrieval plan` 的 facet 集合与 manifest 扩展点；限域护栏已前移至 1） | 1 之后 |

**止损条款**：若方向 facet 在真实回放中触发率过低（说明章节计划实体标注稀疏），则先补"蓝图实体/线程标注"的规划纪律，再上线 1；不为覆盖率强行放开主题扩展（那正是要防的垃圾注入）。

---

## 执行状态（2026-09-29 实施完成）
| 项 | 状态 | 落点 |
|---|---|---|
| 1 方向检索注入（含 facet 限域护栏） | ✅ 已落地 | `fact-retrieval.ts`（buildFactRetrievalPlan/capDirectionPinnedClaims/上限护栏）+ `activities.ts` retrieveMemory 接线 + `chapter-draft.ts` 「本章方向冻结事实」段 |
| 2 新事实确定性验证 | ✅ 已落地（落点优于原案） | `fact-extraction/classify.ts` 确定性矛盾核验（claimsIndex+valueHashById 对账，矛盾强制 candidate 走既有晋升门）；核验清单随 `ExtractFactsResult.verification` 上浮、activity 落 `factArtifact.structuredData.verification`；三条提取路径同参覆盖 |
| 3 注入审计可见性 | ⏳ 部分 | `reason="direction-pinned"` 审计标记已挂；`context_manifests` 的 `directionPinnedClaims` 字段化待后续 |
| 测试 | ✅ | `fact-injection-verification.test.ts` 16 用例全绿（派生/归并/截断/封顶、pinned 装配双向、021/024 命中 + 四类反例、draft prompt 分轨） |
| spec 同步 | ✅ | `workflow-map.md` §4/§7 + `skills/novel-v2/narrative-continuity.yaml` v1.1.0（chapter.fact-extraction 执行点） |

> 注：本计划与 `improvement-plan-20260922.md`（craft 信号）互补，二者均建立在"事实系统/质量系统已存在"的判断上，核心是**补设计与执行的落差缝**，而非从零建造。

---

## 2026-09-29 可行性复核修订记录
1. **审计结论修正**：`conflicts` 非恒空——`cognition.ts:321` 已产出 supersedes 型非阻断冲突；缺的是值级矛盾生产者（§〇表、§2.1 同步更新）。
2. **迭代 1 工作量下修**：`buildMemoryBundle` 已支持 `pinnedClaims` 且有调用先例（`activities.ts:460`），净新增仅派生函数 + 接线（§1.2）。
3. **护栏前移**：派生集合上限自迭代 3 移入迭代 1（pinned 超预算硬 throw，`cognition.ts:289`）（§1.2、§3.1、排期表）。
4. **派生源收紧**：facet 仅从结构化字段（蓝图实体 / threadRef）派生，`chapter_goal` 自由文本仅用于人工吻合度核对（§1.2、§3.1）。
5. **迭代 2 输出结构修正**：不回填 `MemoryBundle.conflicts`（preflight 与提取后时序错位），改走独立核验工件；gate 接线复用 `chapter-lifecycle.ts:91` 的 `factApprovalBlocked` 模式（§2.2）。
6. **新增键对齐召回风险**：`normalizeFactSubjectId` 不归一谓词，谓词粒度漂移会漏报；缓解为提取谓词词表约束 + 漏报原因分布监控，不引入模糊匹配（§2.3、§2.4）。
