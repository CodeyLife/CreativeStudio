# 现状梳理与质量核查（2026-10-13）

对象：项目 `novel-spirit-code-rev-create-20260806-v1`（《程序员也穿越了》）、其事实记忆层、架构支撑层与技能层。
方法：只读取证（运行库 / Qdrant / 对象存储 / 上下文收据 / 技能表）+ 自动化门复核；所有数字均来自本轮实测查询，非文档转述。
本轮先完成只读取证，再按作者裁决落地两项修复：**A 事实时效性排序**（§3.5）与 **B 开放伏笔按静默账过滤**（§4.6），并补上一个只读健康门（§5）。取证阶段未改任何生成行为，理由见 §6。
后续（同日）落地 **主体碎片治理**（§3.6 选项 a）、**篇幅契约的写作侧半段与声明侧下限**（§7 第 4 项），并以复测**关闭**了"重复提取不退役"这一初判（§3.4 与 §7 第 3 项：非系统性缺陷，不需代码改动）。

---

## 1. 结论摘要

| 面 | 状态 | 关键事实 |
|---|---|---|
| 章节产出 | 已完结但质量分层 | 168 章全部 `final`，ordinal 1..168；文学合格 143 / 边缘 8 / 不合格 17（精修前口径） |
| 章长 | **退化（声明侧已修）** | 前 40 章均值 3125 字 → 120-159 章均值 2293 字，最短 1297 字（第 153 章）；根因=声明侧无下限，已落地项目级下限 3000 字（§7 第 4 项），已定稿章不回溯 |
| 章名 | **退化（指引侧已修）** | 15 个章名 ≤2 字，后段坍缩为单字隐语（098「行」、139「可」、168「慢半步」）；根因=命名 skill 执行点错位（`chapter.title` 无自动触发者）+ 蓝图 schema 下限弱于项目自有契约，见 §7 第 4 项（已修，已定稿章不回溯） |
| 事实记忆 | **结构性缺陷（时效性已修；重复提取经复测排除）** | 2096 条 active 断言，点态快照永久累积；2026-10-13 已落地状态类谓词的槽位内时效排序（§3.5）。"重复提取只累积不退役"的初判已被复测推翻——203/372 个提取工件已被退役、active 代际 >1 的文档全书仅 1 个（§3.4） |
| 上下文注入 | **单源垄断（已修）** | 第 167 章 98K 记忆预算中 69,845 token（71.3%）被 425 条开放伏笔占满；2026-10-13 已改为只注入静默项（79 条 / 12,138 token，§4.6） |
| 架构 | 自洽，信号已闭环 | 休眠信号原只接进弧规划、**未接进正文起草注入**；本轮已接入起草面（§4.6） |
| 技能层 | 曾漂移 13 天，已修 | `narrative-continuity` seed 1.1.0 / 库 1.0.2；本轮同步并补自动化门 |
| 自动化门 | 全绿 | `npm run lint` 干净；`npm run test` 139 文件 / 1258 用例全过（含本轮新增 20 例） |

---

## 2. 章节与产出质量

- 168 章全部 `final`，`current_revision=363`；正文经 `manuscript_documents.current_revision_id → manuscript_revisions.content_hash → content_blobs.object_key` 定位（`chapters` 表无正文列）。
- 最后正文推进停在 2026-09-17；2026-09-22 之后只有 31 个新 revision，覆盖 001-024 与 070/071/074-076/080，即**后 88 章自 09-22 起未再精修**。
- 质量分层（`docs/novel-v2/chapter-quality-bands-20260922.md`，12 批逐章精读，168/168 解析成功，口径为 9-18 精修前文本）：合格线 = 文笔≥4 且剧情≥4。
  - 连续合格带：015-045（31 章）、080-098（19 章）、**099-127（29 章，全书最强）**、155-167（13 章）。
  - 不合格 17 章：003/004/007/008（**已精修**）、011（未处理）、046/050/055/079、128/140/142/145/150/153（剧情 3：单章推进薄 / 低外部事件慢烧）、146（已精修）、147（P0 元叙述句已删）。
  - 边缘 8 章：009、014、059、064、067、070、129、168（其中 009/014/070/168 已改善）。
- 叠加商业追读标准后，两头都不合格集中在 001-014 的 003/004/007/008/011；**049-060 零回报兑付**、**051-080 对白密度 0.33 段/千字**（文档称"死亡象限"）是最集中的两处商业缺口。
- 本轮独立复测的正文对白密度（脚本 `tmp/state-audit/measure-dialogue-density.mts`，确定性、零模型调用；口径＝引号内有效字 / 有效字）：分段均值 001-020 **6.78%** → 021-040 5.38% → 041-060 1.97% → **061-080 0.67%** → 081-100 0.90% → 101-120 1.77% → 121-140 3.87% → 141-160 1.42% → 161-168 0.67%；全书 2.74%。**14 章无任何含引号段落**（026/037/052/070/085/087/111/113/114/140/146/153/167，另 061/098 仅 0.04%）。⇒ 崩落约 10×，与上文"死亡象限"吻合，且末段回到最低点；**该维度在代码中无任何测量通道**（详见 §7 第 5 项）。
- 本轮独立复测的章长（数据源 `.novel-bench/baselines/spiritcode-r363/chapters/*.txt`，与 DB revision 363 一致，例：168 号文件 6400 字节 = DB `byte_length` 6400）：
  - 全书均值 2749 字，min 1297，max 5376。
  - 分段均值：0-39 章 3125 / 40-79 章 2811 / 80-119 章 2806 / **120-159 章 2293** / 160-168 章 2619。
  - 最短 12 章：153(1297)、49(1397)、151(1465)、32(1472)、146(1609)、148(1633)、137(1640)、149(1672)、136(1698)、147(1750)、135(1782)、138(1789)。

---

## 3. 事实记忆层：状态类断言永久累积（最高severity）

### 3.1 现象

`memory_claims` 共 2126 行，其中 **active 2096 / staged 30**。同一 `identity_hash` 下存在多个 active 且 `value_hash` 不同的断言，按谓词分布：

| 谓词 | 槽位数 | active 条数 | 单槽最大 |
|---|---|---|---|
| 知晓 | 20 | 1091 | 976 |
| 状态变化 | 29 | 448 | 322 |
| 持有 | 1 | 165 | 165 |
| 使用策略 | 1 | 104 | 104 |
| （空谓词） | 1 | 61 | 61 |
| 位于 | 4 | 24 | 18 |
| 身份 | 5 | 18 | 8 |
| 给予 | 2 | 10 | 7 |
| 背负期限 | 1 | 7 | 7 |
| 状态 | 2 | 7 | 4 |
| 其余（约定/规则/认知/记录/传话/承诺/推测/rollup） | 各 1 | 2-9 | 2-9 |

`知晓` 的 976 条高基数是**设计使然**（见 §3.3），但 `持有` / `位于` / `状态变化` 的高基数是**真缺陷**。

### 3.2 实证：`持有` 槽位是互斥的章节库存快照

`char_chu_heng` 的 `持有` 槽有 165 条 active 断言，逐章覆盖且互相矛盾：

- 第 1 章：两块下品灵石 + 《引气诀》手抄本 / 储物袋因灵力不足无法使用 / "仅有的财产是两块下品灵石、一本缺了两页口诀解释的二手《引气诀》和一个无法催动的储物袋"
- 第 3 章：仅持有一块刘管事发的劣质灵石作为全部补给
- 第 5 章（approved）：任务玉简、精铁小铲、一块下品灵石、狼耳、狼牙、狼皮
- 第 6 章：半块干硬杂粮饼 / 铁背狼两颗獠牙、一张完整背皮和背骨
- 第 11 章：一块作为领任务凭证的杂役木牌
- 第 16 章：三片云纹草残叶与半截草根 / 全部家当折算不足两块灵石

**全部同时 active。** 起草第 168 章时它们都在候选池里。因为排序链**先按 authority**（`approved` 4 > `author` 3 > `derived` 2），槽位配额 3 个名额会被第 2/5/6 章的 approved 条目占满——即模型会被告知主角持有 160 章前就已消耗掉的任务材料。

`位于` 槽同理：18 条 active 位置快照（第 1 章破木屋、第 4 章破庙 approved、第 5 章黑风林边缘、第 34 章调至外缘消息哨 approved、第 89 章功德司西跨院查档屋、第 134 章堂侧记录位、第 156 章东柱内侧旁位、第 163 章白纸原位未动），全部同时有效。

### 3.3 根因：全链无"状态类 vs 持久类"谓词语义

代码内**不存在**任何谓词分类机制（对 `durable|state-like|状态类|point-in-time|瞬时|时效` 全仓检索，命中仅为散文注释与测试 fixture，如 `src/novel-v2/__tests__/v2-cognition.test.ts:124-131` 的"持续事实"/"有界持续事实"）。

排序与去重链（`src/novel-v2/cognition.ts`）：

- `compareCandidates` 于 `src/novel-v2/cognition.ts:28-35`：`authorityRank` → `score` → `confidence` → tokenCost → id。**没有任何"越新越优先"的平局判定**，也没有叙事邻近度分量。
- `authorityRank` 于 `src/novel-v2/cognition.ts:24-26`：approved 4 / author 3 / derived 2 / candidate 1 / rejected 0。
- 可见性 `isMemoryClaimVisibleAtCutoff` 于 `src/novel-v2/cognition.ts:54-62`：只要 `narrativeRange.start <= cutoff` 就可见——这回答的是"某时刻是否为真"，而**不回答"现在是否仍为真"**。对点态状态断言，两者不等价。
- 去重键为 `value:${identityHash}:${valueHash ?? contentHash}`（`src/novel-v2/cognition.ts:242-244`）：不同取值不去重，故互斥快照会并存进入候选。
- 槽位配额 `MAX_PER_IDENTITY_SLOT = 3` 于 `src/novel-v2/cognition.ts:269`（自带 TODO：应移入运行时可配），但配额只在最终 ranked-fill 循环（`src/novel-v2/cognition.ts:307`）生效，**截断的是已按 authority 排好的队**，因此截出来的 3 条与"当前状态"无关。
- 检索分本身也不含时间分量：`src/novel-v2/qdrant-memory.ts:52` 的 `search`，`score` 取 rerank 分（`:174`）或 Qdrant 原始分（`:115`）；`narrativeCutoff` 只作 Qdrant 过滤条件（`:68-71`）。

**这是一处真实的架构级缺口，直接损害实际产出质量**：模型在起草第 168 章时会收到 100+ 章前的库存与位置事实，且它们与权威的叙事状态账本（pinned，见 §4）冲突。

### 3.4 重复提取：初判为系统性缺陷，实测推翻（2026-10-13 第二轮取证）

**初判**（保留原文以供对照）：第 1 章有 38 条 active 断言来自 4 个不同 `source_artifact_id`，含互相矛盾的死因；
全书 372 个 fact-extraction 工件对应 168 章（约 2.2 次/章），据此推断"重复提取只累积、不退役旧行"。

**实测推翻了"系统性"这一层**。四条判据：

| 判据 | 实测值 | 说明 |
| --- | --- | --- |
| fact-extraction 工件总数 / **无任何 source 的** | 372 / **203** | 退役靠**删除 `memory_claim_sources` 行**（不是写 `supersedes` 边），203 个被退役的工件正是证据 |
| **active fact-extraction 代际 >1 的文档数** | **1**（仅第 1 章，3 代） | 全书 168 章里只有 1 章存在多代累积 |
| active source 总数 / 其中 `revision_id <> 当前 revision` | 2005 / 611 | 按工件 kind 分解：fact-extraction 326、revision 191、draft 94 |
| 仅经"陈旧 source"存活的断言 | 611 | 与上一行同集：这些断言的最新来源指向更早的 revision |

**第 1 章 revision 时间线**（解释那唯一的例外）：rev 1（2026-08-07，5 条 active）→ rev 2（2026-08-07，6 条）
→ rev 39/48/49/57（0 条）→ rev 65（2026-09-08，15 条 = 8 条 fact-extraction + 7 条知识边界）
→ rev 66/67/68（0 条）。**当前 revision（68）不携带任何 active source。**

**机制与边界**：`commitRevision` 的退役语句是 `DELETE FROM memory_claim_sources WHERE project_id=$1 AND document_id=$2 AND revision_id=$3`
（`src/novel-v2/postgres-repository.ts:7692-7701`，`$3 = previousRevisionId`），且整块被 `if (input.factArtifactId)` 守卫（`:7682`）；
生产侧 `src/novel-v2/temporal/activities.ts:1227` 传的是 `input.factArtifact?.id`，故**润色/定向修订类提交（无新提取）不激活也不退役**——这是正确行为（没有新代际可激活）。
两点边界：① 退役**只扫前一个 revision**，故更早被孤立的 source 永不复查——第 1 章 rev 1/rev 2 的 source 是项目创建次日（2026-08-07）留下的，此后无任何提交会再触及它们；
② 611 条"陈旧 source"绝大多数是**合法溯源**：文档在提取之后又经过润色，断言仍是最新认知，`memory_claim_sources.revision_id` 记的是提取出处而非时效。

**结论：不构成系统性缺陷，不需要代码改动。** 不宜按"每文档只留最新 fact-extraction 代际"做一刀切清扫——最新代际并非旧代际的超集
（第 1 章 rev 1 代的 `身份`、rev 2 代的 `环境`/`身体状态` 在新代际中并无逐条对应），盲目退役会丢事实；正确治理是**语义合并**，
即 `docs/novel-v2/memory-governance-audit-20260909.md` §5.5 规定的外部事实梳理边界（该审核通道已于 2026-09-24 随 memory-grooming MCP 撤除）。
残余：第 1 章 2 个被取代代际共 11 条断言仍 active，属有界历史残留，已记入 §7 第 3 项。

### 3.5 已落地的修复：状态类槽位的槽位内时效排序（2026-10-13）

**决策形态**：不改 `identity_hash` 归一规则、不引入模糊匹配，而是在 `buildMemoryBundle` 的
`ordered` 上增加一个**槽位内重排**，并把"哪些谓词是单值状态维度"作为显式分类放在事实层。

| 项 | 落地位置 | 说明 |
| --- | --- | --- |
| 谓词分类 | `src/novel-v2/fact-extraction/fingerprint.ts` `isStateLikePredicate` | 覆盖规范谓词 `持有` / `位于` / `状态变化`；经 `canonicalizeFactPredicate`，故"拥有"/"身处"等别名同样命中 |
| 槽位内重排 | `src/novel-v2/cognition.ts` `orderStateLikeSlotsByRecency` | 在去重排序之后、配额之前作用于 `ordered` |
| 接线 | `src/novel-v2/cognition.ts:262` | `const ordered = orderStateLikeSlotsByRecency([...deduplicated.values()].sort(compareCandidates));` |

**为什么是"槽位占位重填"而不是"改全局比较器"**：保留该槽位在 `ordered` 中占据的位置集合，
只把这批位置按 `narrativeRange.start` 降序重新分配给槽位成员，跨槽位名次完全不变。若写
"同槽位比叙事位置、跨槽位比 authority"的比较器，该关系不满足严格弱序（A、B 同槽且 A 新，
B、C 同槽且 B 新，而 A、C 跨槽时可能反向），`Array.sort` 在非传递比较器下次序不可预测。

**边界（刻意不覆盖）**：只认 `PRESET_PREDICATE_ALIASES` 的规范谓词——项目自定谓词
（`身份`/`状态`/`使用策略`/`约定`…）是开放词表，用固定清单枚举它们等于把个案固化成规则，
未归类即保持既有排序行为；`知晓` 累积（知道 A 与知道 B 并存）、`给予` 是离散历史事件
（第 23/27 章交付、第 34/41/49 章递交），均不重排；无 `narrativeRange.start` 的成员按最旧处理。

**验证（双向 + 真实数据）**：

- 单元：`v2-cognition.test.ts` 新增三例——状态类槽位入选最新值、累积型槽位仍 authority 优先、
  别名与无叙事位置边界。**撤除重排后前两处判红，累积型对照两向皆绿**（证明不是同义反复）。
- 真实数据：取运行库 `char_chu_heng` 的"持有"槽全部 165 条 active 断言跑真实 `buildMemoryBundle`
  （`narrativeCutoff=167`）。修复前 3 个名额落在 **ch27 / ch97 / ch31** 的 `approved` 旧快照
  （床底暗格丹药、门框内侧私人记号、两夜震颤草纸）；修复后落在 **ch167 / ch165 / ch164** 的当前库存
  （学字人留下的空纸、拆不动草纸入存形录夹层、旧竹签放回卷宗封皮内侧）。
- 联合端到端（A+B 同一份 bundle，`tmp/state-audit/verify-combined-ab.mts`）：见 §4.6——"持有"槽经
  生产 `retrieveMemory` 的配额入选 ch167/165/164 三条，同时伏笔降至 79 条 / 12.4%。
  **生效边界**：方向强注钉住该槽位时 pinned 会先占满配额，重排对该槽位不再生效（§4.6 末段）。
- 全量：`npm run lint` 干净；`npm run test` **136 文件 / 1238 用例全过**（基线 1235 + 新增 3）；叠加 §4.6 与 §3.6 后为 **137 文件 / 1249 用例**。

**顺序依赖已解除**：本修复只保证"事实层内部入选的是当前值"，端到端效果原本还受伏笔份额约束
——第 167 章 98K 记忆预算中 425 条开放伏笔占 71.3%，事实层入选仅 2 条（§4）。§4.6 的伏笔过滤
已把该约束移除（伏笔 79 条 / 12,138 token，释放约 57.7K），两项修复现在共同生效。

---

### 3.6 主体 id 碎片化：同一人物多种键形态（2026-10-13 补充取证）

**现象**：active 2096 条断言共出现 171 个不同 `subject_refs` 值，其中只有 39 个能命中人物身份
索引（`buildCharacterIdentityIndex` 注册 `canonicalId`/`displayName`/`entity.id`/`entity.name`），
**132 个（77%）永不命中**。排除两个按设计的规划标记（`facet:fact` 与 `foundation:<taskKey>`，
共 6 个 id / 122 条，见 `src/novel-v2/foundation-memory.ts:57`），仍有 **194 条 active 断言
（占 9.3%）至少引用一个不可解析主体**：机器 id 变体 15 个 id / 40 条，中文名与物件/地点
111 个 id / 199 条（后者按 id 计数，同一断言含多个碎片会重复计入）。

**主角自身即碎片化**：`char_chu_heng`（1621 条）/ `楚衡`（9 条，即 9 条 chapter-memory rollup）/
`chu_heng`（4 条）。互斥死因分属两个槽：

| identity_hash 前缀 | subject_refs | 内容 | predicate / start / authority |
| --- | --- | --- | --- |
| `0a70ecce32b0…` | `{char_chu_heng}` | 原主在灵田守夜受风寒高烧身亡，程序员楚衡的意识进入其身体 | 状态变化 / 1 / derived |
| `e5f209b48842…` | `{chu_heng}` | 楚衡（原身死因）强行修炼《引气诀》导致经脉逆流身亡，现被现代程序员魂穿接管身体 | 状态变化 / 1 / derived |

**后果（三重）**：
1. 2026-09-29 落地的确定性矛盾核验按 `identityHash` 对账，而 `identityHash` 含主体
   （`factIdentityPayload = {subject, predicate, knowledgeScope}`，`fact-extraction/fingerprint.ts:52-58`）
   —— 主体键不同则核验**看不见**这对硬矛盾，正是该计划（`improvement-plan-fact-injection-20260922.md`）
   要防的失败类。
2. §3.5 的槽位内时效重排按 `identityHash` 分槽，两个碎片槽各占自己的配额（`MAX_PER_IDENTITY_SLOT=3`），
   于是模型会**同时**收到两条互斥死因——时效排序无法替它裁决。
3. 所有按主体过滤的消费方（图检索、实体工作台、`memory_claims_subjects` GIN 索引）对碎片键失明。

**根因与边界**：`normalizeFactSubjectId`（`src/novel-v2/fact-extraction/index.ts:189-195`）只在原始 id
**精确命中**注册表别名时重写，未命中一律原样保留——这是 `memory-governance-audit-20260909.md` §M2/§5.1.1
的有意边界（"不在共享层发明新实体或猜测映射"，语义等价判定交给"外部事实梳理审核"）。但：
- 该审核通道（专用 `memory-grooming` MCP）已于 2026-09-24 撤除（零调用）；
- `memory-governance-audit-20260909.md:163` 当时已把 `char_qi`(4)/`chu_heng`(4) 标为"属 §5.5 机械边界，
  交外部事实梳理"；此后 `char_qi` 反而从 4 条涨到 **11 条**（2026-09-11～09-15 创建），即延期项没有承接方。

**放大器：注册表自身 id 约定不一致**。57 个实体里只有 7 个用 `char_*` 机器 id
（`char_chu_heng`/`char_zhao`/`char_liu_guan_shi`/`char_fan_zhu_shi`/`char_lao_li`/`char_xuan_ji_zi`/`char_ye_qing_mei`），
其余 50 个直接把中文名当 `canonicalCharacterId`（`齐姓人`/`文书吏`/`学字人`/`灰袍人`…）。
模型对后者更容易自造拼音 id（`char_qi`），是碎片化的直接来源。

**边界说明（避免误判）**：chapter-memory rollup 的 `subject_refs` 来自
`characterStates[].characterId`，而 `src/novel-v2/chapter-memory/prompt.ts:38` 明确要求
characterId 用"正文中的角色名"——所以 rollup 携带显示名主体是**按设计**的，不算提取漂移；
它们同时也是回填脚本 `subject_refs 归一` 的目标（见 §3.7）。

**未落地的三个选项（需作者裁决）**：
- (a) 补全 §5.5 提案里未实现的另一半：未命中时按 `pendingEnrichment` 规则登记新实体，
  "不允许发明第三种键形态"（现状只做了"命中则重写"）；
- (b) 重建外部事实梳理审核通道（撤除前的 `memory-grooming` MCP 形态）；
- (c) 接受为已知边界并文档化，不再处理。

**作者裁决与落地（2026-10-13，选项 a）**：

落地位置：
| 改动 | 位置 | 作用 |
| --- | --- | --- |
| 人物判别位 | `src/novel-v2/prompts/schemas.ts:105`（subject.kind enum 增 `character`）+ `src/novel-v2/fact-extraction/prompt.ts:55-56` | 让提取侧能区分人物与地点/物件——原 `entity` 同时覆盖"人物名、地点名"，无法据以决定该不该登记 |
| 指纹折叠 | `src/novel-v2/fact-extraction/fingerprint.ts`（`normalizeSubjectKind`，`character`→`entity`） | 判别位只服务登记决策、不参与身份哈希，否则新旧数据会因 kind 写法不同再分槽 |
| 主体键归一（键等价阶梯） | `src/novel-v2/fact-extraction/index.ts:198-232`（`SubjectKeyIndex`/`buildSubjectKeyIndex`/`resolveCanonicalSubjectId`） | 精确别名命中之外，增加"NFKC+去空白+分隔符与大小写折叠"等价，以及 `char_x`/`char-x` 与裸名 `x` 的等价 |
| 未命中键收集 | 同文件 `:260-289`（`UnregisteredSubject`） | **只收 `kind='character'`**（地点/物件用 `entity`/`scene`，登记它们会把"补发房""玉牌""门框"混进角色名册与知识工作台），按 id 去重 |
| 待补全实体登记 | `src/novel-v2/postgres-repository.ts:5802-5846`（`registerPendingSubjects`） | `INSERT ... ON CONFLICT(id) DO NOTHING`，`kind='character'`，`payload.pendingEnrichment=true` |
| 两条提取路径接线 | `src/novel-v2/temporal/activities.ts:1085` 段（内部）与 `:1113` 段（外部 MCP） | 登记失败只 warn，不阻塞事实落库 |

**为何需要一个判别位（本轮的自我纠正）**：初版实现直接登记所有未命中的 `entity` 主体，随后发现
prompt 第 56 行明示 `entity` 覆盖"人物名、地点名"，而运行库里未命中的键恰恰有大量地点与物件
（`杂役区存形录` 15、`补发房` 11、`玉牌` 5、`门框` 5、`老槐树` 2、`差房后头灰砖墙巷子尽头屋子` 5）。
把这些登记为 `kind='character'` 会让它们出现在角色名册的待补全列表与知识工作台（
`src/novel-v2/postgres-repository.ts:2320-2342` 会为 `kind='characters'` 的查询列出所有未归并实体），
是语义错误。故补一个 `character` 判别位，并把它折叠出指纹（见上表第二行）——否则"新增判别位"
本身就会制造新的碎片化。

**为何"键归一"是键等价而非语义匹配**：折叠的只有 Unicode 形式、空白、`-`/`_` 与大小写——这些
都是同一标识符的书写变体，不是语义判断。`char_chu_heng` 与 `chu_heng` 的等价关系来自**注册表
自身**（规范 ID 去前缀后的裸名），不是猜测。刻意不做拼音/近义/模糊匹配：`qi` ≡ `齐姓人` 需要
语义判断，超出共享层职责（审计 §5.5 明确交外部事实梳理）。

**为何登记必须 `kind='character'`**：所有生产加载器都过滤 `kind='character'`
（`src/novel-v2/character-enrichment/index.ts:65`、`src/novel-v2/postgres-repository.ts:933`/`:2323`/
`:3125`/`:4311`、`src/novel-v2/application/chapter-script-h3.ts:793`）。用其它 kind 登记等于
登记了也解析不到，无法消除碎片化。`status` 由 `payload.pendingEnrichment` 决定，故这些行不会进入
prompt 的规范名册（名册只列 `status='identified'`），也不会被当作已富化角色消费——与
character-enrichment 的"关系目标实体"占位（`src/novel-v2/character-enrichment/index.ts:379-389`）
完全同构，并沿用同一条引用完整性边界（`DO NOTHING`，绝不覆盖已富化档案）。

**真实数据验证（`tmp/state-audit/verify-subject-normalization.mts`，只读）**：
真实注册表 = `entities` 56 行 + Foundation characters 5 条（别名键 172、归一键 177）。
运行库 active 断言的 171 个 subject 键：**旧路径命中 38 → 新路径命中 39**。
新增可解析的只有 `chu_heng → char_chu_heng`（4 条断言）——即审计 §M2 记录的那对互斥死因
（`char_chu_heng` vs `chu_heng`）从此落进同一 identity 槽，矛盾核验与槽位时效重排都能看见它们。

**必须如实记录的边界（键归一只解决了小头）**：171 个键里仍有 **132 个未命中**（361 条断言），
其中 124 个键 / 232 条断言**属可登记命名空间**（`杂役区存形录` 15、`补发房` 11、`char_qi` 11、
`送草的孩子` 9、`传信少年` 7、`话房人` 6、`old_huai_tree` 6、`无面黑影` 5、
`差房后头灰砖墙巷子尽头屋子` 5、`玉牌` 5、`门框` 5、`验格程式辑要` 4、`char_fan_zhu_shi` 4、
`太齐案卷宗` 4 …），另有 8 个键 / 129 条断言属系统命名空间（`facet:fact`、`foundation:*`、
`relation_*`，按设计不登记）。这些是**存量**碎片，本次改动只在**新提取**时登记，
不会自动回填；回填需在 `scripts/novel-v2-memory-governance-backfill.ts` 增一步
"按 active 断言的可登记主体键批量登记"，属另案。**注意该回填不可照搬上述 124 个键**：它们是
按"旧契约（`entity` 兼指人物与地点）"提取的，无法区分人物与地点，直接登记会把地点物件写进角色
名册——回填必须先取得该键在提取时的 subject.kind，而 fact-extraction 工件不保存提取输出
（`artifacts.payload` 只有 `{sourceArtifactId}`），故回填要么重跑提取、要么由外部事实梳理裁决，
不能机械执行。
另需注意：`char_qi`(11)/`char_fan_zhu_shi`(4)/`char_zhou_xiong_shi`(2) 这类"看起来规范但注册表里
没有"的键，登记后会与既有中文名实体（`齐姓人`、`繁主事`、`周师兄`）**并存为两个实体**——
消歧需要语义判断，是 §5.4 非人物主体注册 P2 与外部事实梳理的范畴，本次不处理。

### 3.7 治理工具与存储设计脱节：回填脚本的 Foundation 步已失效（2026-10-13 已修复）

**现象**：`scripts/novel-v2-memory-governance-backfill.ts` 的"Foundation 代际退役"步在 dry-run 里
报告"5 组 / 退役 11 条"，但它选的存活行是 **pre-singleton 的 per-artifact 形态**
`foundation:<artifactId>`（脚本原 `latestClaimId = \`foundation:${artifactId}\``）。

**为什么错**：段级单例化（`src/novel-v2/postgres-repository.ts:5697-5700`，
`foundationClaimId = foundation:<projectId>:<taskKey>`，见 `src/novel-v2/foundation-memory.ts:23-31`）
之后，`recordFoundationClaim` 对非最新 artifact **不再落投影行**（同文件 `:5714-5718` 直接 `return []`）。
实测：脚本对 plot-design 选中的目标行 `foundation:43db1f97-…` **根本不存在**（`target_row_exists = false`），
`UPDATE … WHERE id=$1` 命中 0 行、静默无操作；其余四个 taskKey 选中的是**已被单例 supersedes 的陈旧行**
（如 architecture 选中 `foundation:6346ec34`，创建于 08-06），即便命中也是把代际方向写反。

**修复**：改为以单例 id（`foundationClaimId(projectId, taskKey)`）为目标，并在单例行不存在时跳过。
复跑 dry-run：**"Foundation 代际退役：0 组"** —— 与实测一致（56 条存量 per-artifact 行**全部**已被
5 条单例行的 `supersedes` 覆盖，未被覆盖数 = 0），即单例机制早已完成退役，脚本此前的"11 条"是假计划。

**顺带验证（该步无产出的真实原因不是缺陷）**：单例行 `supersedes` 长度分别为
architecture 6 / characters 15 / plot-design 6 / project-positioning 17 / worldview 12 = 56，
与存量 per-artifact 行数一致；第 167 章 manifest 的 `includedClaimIds` 中 foundation 类条目
**为 0 条**，证实读路径的可见性口径确实把陈旧代际挡住了。

---

## 4. 上下文注入：开放伏笔垄断 71% 记忆预算

### 4.1 收据实证

取最新 `context_manifests` 收据 `context:preflight:9100715a-a48c-4e9a-a372-ca7093aa9818`（`narrativeCutoff=167`，`tokenBudget=98000`，`estimatedTokens=97999`，`truncationReason="budget"`，included 470 / excluded 44）。按 included 的 claimId 前缀统计：

| 前缀 | 条目数 | tokenCost | 占比 |
|---|---|---|---|
| `foreshadowing:` | 425 | **69,845** | **71.3%** |
| `narrative-state:` | 2 | 19,473 | 19.9% |
| `chapter-memory:` | 1 | 4,613 | 4.7% |
| `pinned:` | 4 | 1,346 | 1.4% |
| `promise:` | 15 | 1,009 | 1.0% |
| `memory:`（真事实层） | 2 | 1,002 | 1.0% |
| `graph-thread:` | 7 | 545 | 0.6% |
| `graph:` | 13 | 143 | 0.1% |
| `claim:` | 1 | 23 | 0.0% |

### 4.2 增长曲线（每 cutoff 取最早一份收据）

| cutoff | 伏笔条数 | 伏笔 token | 事实层 token |
|---|---|---|---|
| 1 | 2 | 214 | 730 |
| 10 | 20 | 2,636 | 4,068 |
| 30 | 138 | 19,886 | 7,906 |
| 60 | 144 | 22,619 | **16,615** |
| 100 | 204 | 33,187 | 15,056 |
| 130 | 323 | 52,555 | 2,456 |
| 150 | 371 | 60,797 | 900 |
| 167 | 425 | **69,845** | **1,535** |

两个反向趋势：伏笔 token 增长 **327 倍**（214 → 69,845）；真事实层 token 在**第 60 章达峰 ~16.6K 后崩落到 ~1.5K**（10 倍下降）。第 143-167 章每一章的 `truncationReason` 都是 `budget`。

### 4.3 根因：注入时把"开放"当作最高相关

`src/novel-v2/temporal/activities.ts:404-451`：取全部开放伏笔/承诺（`:407` 的 `getOpenForeshadowingAndPromises`），然后**逐条**映射为 MemoryHit 并硬写 `score: 1.0`、`semanticRank: 1.0`：

- 伏笔：`authority: "derived"`、`confidence: 0.9`、`score: 1.0`（`activities.ts:422`）、`reason: "open-foreshadowing-injection"`（`:425`）
- 承诺：`score: 1.0`（`activities.ts:441`）、`reason: "open-promise-injection"`（`:444`）

`score: 1.0` 等于断言"每一条开放伏笔都与当前章最大相关"，于是 425 条按同一分数灌满预算，把真事实层挤到 1%。

这与既定 spec 意图冲突——`docs/novel-v2/workflow-map.md:166` 明写："开放伏笔/承诺是可排序候选；它们仍可被检索和回收，但**不会因为'开放'就全部挤占 pinned 预算或把局部正文变成清单执行**"。全仓检索"预算份额 / per-source / 每源配额 / facet 配额"只命中该句与 `workflow-map.md:191` 的槽位配额说明，即**不存在任何按来源/面的预算份额机制**。

该问题**早有记录且已恶化 6 倍**：`docs/novel-v2/product-audit-20260910.md:63` 已记"ch21 起草 64K 预算用 61.8K，其中 foundation 33.7K、伏笔 11.5K、事实层 379 token（0.6%）"。本轮实测第 20 章伏笔 11,530 token，与当时一致。

### 4.4 架构自洽性：休眠信号已算出，但没接进起草面

`src/novel-v2/narrative-dormancy.ts`（176 行）已实现精确的休眠判据：

- 头注释记录：427 条开放伏笔中 `overdue`（窗口上界已过）244 条，但用触发词扫描正文后发现 **238/244 仍在推进**（后续 20+ 章持续提及）。故 `overdue` 衡量的是"窗口过了但线还在跑"——长篇连载的正常形态，不是欠账。
- 真正的缺陷形态是"**曾活跃、后沉默**"：全书 66 条（占开放 15%），且高度集中在最后提及章 120-159（53/66）。
- `DORMANCY_POLICY`（`narrative-dormancy.ts:31-42`）：`silentWindow: 20`（TODO(magic-value)：首轮语料标定，应移入连载健康配置；168 章实测 20 章 ≈ 全书 12% ≈ 读者回忆上限；取 10 会让沉默数翻倍，取 30 只剩约 40 条）。
- `assessNarrativePresence`（`:65`）确定性字符串扫描，状态 `never-mentioned | silent | running | unmeasurable`；`summarizeDormancy`（`:130`）产出 `silent`（按 silentFor 降序）、`silentBands`（`BAND_WIDTH = 20`）。
- 刻意不覆盖：只判"是否被提及"，不判语义兑现；关键词为空或 <2 字判 `unmeasurable`；不内置任何题材词表或角色/物品名。

**接线缺口**：`summarizeDormancy` 在 `src/novel-v2/temporal/activities.ts:212`（`loadNarrativeDormancy`）计算，并已接进**故事弧规划 prompt**（`src/novel-v2/prompts/story-arc.ts:261`，导入见 `:6`，说明文字见 `:164`）——但**起草面的记忆注入（`activities.ts:404-451`）完全没用它**，仍是无差别注入全部开放项并硬写 `score: 1.0`。

即：项目已经算出可操作的信号（66 条真沉默 + 分带统计），却只在规划阶段使用，在最需要它的逐章起草阶段弃用。

---

### 4.5 量纲缺陷：人造 1.0 与真实检索分同池竞价（2026-10-13 补充取证）

上表说明了"伏笔占了多少"，本节说明**为什么它必然占这么多**——根因不是份额参数，而是**两套量纲混用**。

第 167 章同一份收据里，被 `budget` 排除的 44 条候选构成：

| 前缀 | 条目 | tokenCost | 平均检索分 |
| --- | --- | --- | --- |
| `chapter-memory:` | 8 | 31,888 | 0.170 |
| `memory:`（真事实层） | **24** | **13,047** | **0.148** |
| `graph:` | 12 | 189 | 0.000 |

即：**24 条真事实断言因为预算耗尽被排除**，而 425 条开放伏笔以人造 `score: 1.0` 占住 69,845 token。
两者的分数不在同一量纲上——真实检索分实测在 0.00–0.17 区间，人造分固定 1.0，于是**排序结果与相关性无关，
只由"是否属于被无条件注入的家族"决定**。`ranked-fill` 入选 463 条中 425 条是伏笔，其余 38 条才是检索候选。

代码位置：`src/novel-v2/temporal/activities.ts:422`（伏笔）与 `:441`（承诺）的 `score: 1.0`、
`semanticRank: 1.0`。这两处与 `cognition.ts:225-227` 的注释自相矛盾——注释声明 additionalClaims
"available for ranking…do not become unconditionally frozen"，而人造满分使它们**事实上等价于冻结**，
只是走 ranked-fill 通道占位，从而绕过了 pinned 的预算硬校验（`cognition.ts:289`）。

> 注意口径：它们进的是 `additionalClaims`（`activities.ts:485`），**不是** `pinnedClaims`，
> 故 workflow-map.md:166 关于"不挤占 **pinned** 预算"的字面要求是满足的；被违反的是同一句的后半段
> "不把局部正文变成清单执行"。

### 4.6 已落地的修复：开放伏笔按静默账过滤（2026-10-13）

**作者裁决形态**：不做份额参数，而是**只注入已沉默的开放伏笔**——复用库内已有的确定性信号。

| 项 | 落地位置 | 说明 |
| --- | --- | --- |
| 风险集 | `src/novel-v2/narrative-dormancy.ts` `DormancyLedger.atRiskIds` | 在模块内就地汇总 `silent` + `never-mentioned` + `unmeasurable`，调用方不重算分类 |
| 注入过滤 | `src/novel-v2/temporal/activities.ts` 注入块 | `atRisk` 命中才映射为 hit；账不可得则**不注入任何伏笔**（只 warn） |
| 量纲归零 | 同上 | 伏笔/承诺 hit 的 `score` 与 `semanticRank` 由人造 `1.0` 改为 `0` |
| 接线缺口 | `activities.ts` `loadNarrativeDormancy` | 记忆化键由 `projectId` 改为 `${projectId}:${currentOrder}`，缓存判定移到取定稿集之后 |

**为什么归零而不是给个中间分**：注入项不是检索命中、没有相关度证据；给任何正分都只是把"人造优势"
调小，仍然让无证据条目与有证据条目同池比大小。归零后它们在 ranked-fill 里排在证据排序的候选之后，
不再抢在真事实之前占预算——同时仍受预算约束，不会因为"静默"就无条件冻结（保住 `cognition.ts:225-227`
注释声明的语义）。

**边界（刻意不覆盖）**：承诺不按静默过滤（静默账只登记伏笔的触发关键词，承诺没有可比信号；全库
open 承诺 15 条 / 约 1K token，不构成风险）；不引入 per-source 预算份额或百分比阈值（信号驱动，
无魔法比例）；静默账不可得时选择"不注入"而非"全量注入"，因为无判定即全量注入正是被修的缺陷形态。

**线索连续性兜底**：`chapter-memory` 是 drafting 的 required facet，每章记忆带 `unresolvedThreads`，
20 章 rollup 再汇总一次（上限 80 条，`postgres-repository.ts` 的 `refreshChapterMemoryRollup`），
故注入项被过滤/淘汰不等于线索丢失。

**验证（单元 + 真实数据端到端）**：

- 单元：新增 `foreshadowing-injection-dormancy.test.ts` 三例——running 不进注入、注入项 score 为 0、
  无账不注入；`narrative-dormancy.test.ts` 增 `atRiskIds` 守恒断言。撤除过滤后第一例判红。
  **踩坑记录**：`assessNarrativePresence` 只扫描 plant 章**之后**的章节
  （`narrative-dormancy.ts:77` `if (chapter.narrativeOrder <= plantedOrder) continue;`），
  首版夹具把关键词放在 plant 章内，导致三条线索全判 `never-mentioned`。
- 真实数据：`tmp/state-audit/verify-injection-e2e.mts` 连运行库跑**生产** `retrieveMemory`
  （第 168 章 drafting / cutoff 167）。注入集与"生产静默账 `atRisk` ∩ cutoff 内候选"**完全相等**：
  79 条，越权 0、漏注 0。伏笔 token 由 69,845 降到 **12,138（71.3% → 12.4%，5.75×）**。
- 口径教训：静默账的 `currentOrder` 取**最新定稿章（168）**，不是计划的 `narrativeCutoff`（167）。
  按 167 复算会得到 6 条假"漏注"；端到端脚本首版即因此误报。

**释放出的预算去了哪**：本通道腾出的 **57,707 token**（69,845 − 12,138）大于第 167 章被 `budget`
排除的全部候选体量（**44 条 / 45,124 token**：`chapter-memory:` 8/31,888、`memory:` 24/13,047、
`graph:` 12/189），故这批**此前因预算耗尽而落选的真事实与章记忆现在全部进得来**。

**A+B 联合端到端验证**（`tmp/state-audit/verify-combined-ab.mts`）：把运行库"持有"槽的 165 条真实断言
经 provider 喂进生产 `retrieveMemory`，同一份 bundle 里同时检验两项修复：

| 通道 | 条数 | token |
| --- | --- | --- |
| `pinned-narrative-state` | 5 | 20,714 |
| `open-foreshadowing-injection` | 79 | 12,138 |
| `open-promise-injection` | 15 | 1,009 |
| `semantic-retrieval`（"持有"槽，经配额） | 3 | 42 |
| **合计** | **102** | **33,903（34.6% of 98K，`truncationReason=none`）** |

- 修复 A：入选的 3 条正是 cutoff 内最新的 3 个快照（ch167/165/164），配额上限 3 生效。
- 修复 B：伏笔 12,138 token / 12.4%，较修复前同章实测 69,845 / 71.3% 降 5.75×。
- 端到端后果：记忆段由"顶穿预算"（97,999/98,000，`truncationReason=budget`）变为 **34.6% 占用**，
  余量 64,097 token > 此前被排除候选的 45,124 token ⇒ 那 44 条确实进得来（此前的算术推论现获直接证据）。

**验证边界（已探明的一处交互）**：`retrieveMemory` 会先用**同一 provider** 跑方向检索并把命中当
`pinnedClaims`，而 `select()` 对 pinned 也计入槽位（`cognition.ts:308-311`：pinned/required 先占位，
同槽后续条目为其让位）。故若方向强注钉住了某个状态类槽位，该槽位的配额已被 pinned 占满，**修复 A
的重排对该槽位不再产生效果**。首版联合脚本正是如此（桩对方向 facet 也返回这 165 条 → 24 条以
`direction-pinned` 身份占满槽位，ranked-fill 全被 `identity-slot-quota` 排除），故最终脚本按 facet
文本区分两条通道。这是既有设计（硬上下文优先），不是缺陷，但它是"修复 A 生效范围"的边界。

---

## 5. 技能层：一次静默 13 天的漂移（已修复 + 已补门）

### 5.1 发现的漂移

`pnpm novel:skills:check --target database --project novel-spirit-code-rev-create-20260806-v1` 报错：

```
Skill database drift:
{ "skillId": "narrative-continuity",
  "reason": "content-or-version-drift",
  "workspace": { "version": "1.1.0", "contentFingerprint": "40322ecc…" },
  "database":  { "version": "1.0.2", "contentFingerprint": "578d2ab3…" } }
```

### 5.2 根因

seed 只在**服务启动**时由 `migrate()` 尾的 `seedWorkspaceSkills` 灌库（`docs/novel-v2/workflow-map.md:398`）。而 2026-09-19 的修复（`workflow-map.md:442`）刻意让观测命令**不得** migrate——否则"比对发生在写入之后"，漂移被命令自己抹平。两者叠加产生可见性缺口：**seed 已改 + 库没重灌 + 服务没重启**时漂移静默。

本轮正是该形态：`narrative-continuity` seed 由提交 `1983837`（2026-09-29）抬到 1.1.0，库仍是 1.0.2；唯一会报它的 `novel:skills:check` 没有任何自动化调用点（本仓无 CI 目录，`scripts/novel-v2-doctor.ts` 也没有技能面），漂移静默 **13 天**。且它与"服务没在跑"是同一前提——本轮盘查时 API(4770)/Worker 均未启动（无 migrate 发生），即漂移在**最需要被看见的场合恰好最不容易被看见**。

### 5.3 本轮修复

1. **消除现存漂移**：`pnpm novel:skills:sync --target database --project novel-spirit-code-rev-create-20260806-v1` → `skippedStaleSeed: []`（seed 未试图覆盖任何晋升领先行）；复跑 check → `{"target":"database","status":"ok","checked":12}`。库内 `narrative-continuity` version=1.1.0、`updated_at` 2026-10-12T16:18:34Z。
2. **补常态化健康门**：`scripts/novel-v2-doctor.ts` 新增 `skill-drift` 检查，复用 `src/novel-v2/skill-hygiene.ts` 的纯函数 `compareSkillProjections`（同一判据不留第二份）。只读不写。`drift` 非空判 `ok:false` 并把补救命令写进 detail；`promotionAhead`（学习闭环晋升领先）按既有方向护栏不算漂移。该表主键是 `skill_id`、`listSkills(_projectId)` 的 projectId 参数本就忽略，故技能漂移与项目无关，检查不按项目分片。
3. **双向真跑验证**：修前 `workspace 12 / database 12；漂移 0`；把 seed 临时抬到 1.1.1 后 doctor 报 `ok:false` 且具名 `narrative-continuity / content-or-version-drift`；还原后复归 `ok:true`，且 seed 文件 `git diff` 为空（确证测试无残留）。
4. spec 已同步：`docs/novel-v2/workflow-map.md` 增补"技能漂移进常态健康门"一节。

### 5.4 技能面现况

- workspace seed 12 个：chapter-naming、character-ensemble、fact-memory、foundation-planning、h3-video-prompt、learning-loop、narrative-continuity、plot-causality、prose-craft、reader-emotion、review-gate、story-arc-design。
- `skill_definitions` 全局 47 行（历史累积，含 v1 遗留技能轨），无 project_id 列。
- 早前撤除的 `memory-grooming` MCP（2026-09-24，零调用）与当前 20 个工具的 MCP 面一致。

---

## 6. 本轮为什么只修技能门、不改生成行为

发现的两处事实层缺陷（§3 状态类累积、§4 伏笔垄断）**互相耦合**，不宜单独修补：

1. **修 §4 会让 §3 变糟**：把伏笔降权、腾出预算给真事实层，意味着模型会收到**更多**事实——而当前事实池里混着 165 条互斥库存快照与 38 条含矛盾死因的第 1 章断言。先修注入份额而不修事实时效性，等于把更多陈旧状态喂给模型。
2. **排序改动需要设计裁决**：要让"当前库存"胜过"160 章前的 approved 库存"，必须让叙事邻近度**越过** authority 排序，或引入谓词类别（状态类 vs 持久类）。两者都改变事实层语义契约，属 AGENTS.md 要求先回答"增强哪一层、对哪些输入生效、边界在哪"的决策，不应由审计单方面落地。
3. 故本轮遵循"把问题变成可核对的事实"，仅落地了判据明确、零生成行为影响、且能防复发的技能健康门。

> **后续（2026-10-13 同日，作者裁决）**：作者选定"先修事实时效性排序"（即本条 §6 第 1 项所担心的
> 顺序问题的**前一半**）。落地方式回应了本节的顾虑：① 不动注入份额，故模型收到的事实**数量不变**，
> 不存在"把更多陈旧状态喂给模型"的风险；② 排序改动只作用于**同槽位内部**的次序，且分类是显式
> 谓词白名单而非模糊匹配，跨槽位名次与 `identity_hash` 归一规则都不变；③ 第 2 项（伏笔份额）仍是
> 必要条件，见 §3.5 末段与 §7 第 2 项。
>
> **再后续（同日后半段）**：A 落地并验证后，作者在同一决策路径上选定 B 的形态为"只注入已沉默的
> 开放伏笔"（§4.6），于是 §6 第 1 项担心的顺序问题按"先 A 后 B"闭合——事实池的**入选顺序**已先修好，
> 再放开被伏笔占用的预算，交给模型的是**当前的**事实而非陈旧快照。本节的三条理由因此从"暂不改"
> 变为"分两步改"：取证阶段不改，裁决后按依赖顺序改。

---

## 7. 待裁决的改进项（按证据强度排序）

1. ~~**引入状态类谓词语义**（§3）~~ → **已于 2026-10-13 落地**（§3.5）：分类落在 `isStateLikePredicate`（覆盖 `持有`/`位于`/`状态变化`），重排落在 `orderStateLikeSlotsByRecency`，取"槽位占位重填"而非改全局比较器（后者不满足严格弱序）。刻意不覆盖项目自定谓词、`知晓`、`给予`。**遗留**：`状态变化` 槽最多 322 条，其语义实为"角色处境账本"，是否需要在提取侧拆分谓词（处境 vs 变化）留待观察。
2. ~~**限制开放伏笔的注入份额**（§4）~~ → **已于 2026-10-13 落地**（§4.6）：形态不是份额参数，而是"只注入静默项"——复用 `summarizeDormancy` 的 `atRiskIds` 过滤注入集，并把注入项的 `score`/`semanticRank` 由人造 `1.0` 归零，使其退回证据排序之后。真实数据端到端验证：注入集与"静默账 `atRisk` ∩ cutoff 内候选"完全相等（79 条，越权 0、漏注 0），伏笔 token 69,845 → 12,138（71.3% → 12.4%）。**遗留**：静默账不可得时不注入任何伏笔（含承诺），线索连续性此时只靠 `chapter-memory.unresolvedThreads` 兜底；承诺通道仍未受静默治理。
3. ~~**重复提取的退役**（§3.4）~~ → **已于 2026-10-13 实测关闭：不构成系统性缺陷，无需代码改动**。初判（372 个工件 / 168 章 ⇒ 重复运行只累积）被四项实测推翻：① 372 个 fact-extraction 工件中 **203 个无任何 source**——退役靠删除 `memory_claim_sources` 行，这 203 个正是被退役的工件（初判援引的"仅 62 条 `supersedes` 边"是看错了机制，退役不走 `supersedes`）；② **active fact-extraction 代际 >1 的文档全书仅 1 个**（第 1 章，3 代）；③ 2005 条 active source 中 611 条 `revision_id` 早于当前 revision，按工件 kind 分解为 fact-extraction 326 / revision 191 / draft 94，属**合法溯源**（文档在提取后又润色，断言仍是最新认知）；④ 第 1 章的例外有明确来历：rev 1（2026-08-07）与 rev 2（2026-08-07）的 source 在退役代码生效前就被孤立，而退役语句是 revision 作用域的 `DELETE ... WHERE revision_id = previousRevisionId`（`src/novel-v2/postgres-repository.ts:7692-7701`），只扫紧邻前一个 revision，故更早的孤儿永不复查。**不采纳"每文档只留最新代际"的一刀切清扫**：最新代际并非旧代际的超集（第 1 章 rev 1 代的 `身份`、rev 2 代的 `环境`/`身体状态` 在新代际中无逐条对应），盲目退役会丢事实；正确治理是语义合并，属 `memory-governance-audit-20260909.md` §5.5 的外部事实梳理边界。**遗留**：第 1 章 2 个被取代代际共 11 条断言仍 active（有界历史残留，无正确性影响）。
4. **章长与章名退化**（§2）：120-159 章均值 2293 字、15 个章名 ≤2 字。**2026-10-13 根因取证 + 声明侧下限已落地（选项 A，见下）**：
   已定稿章节的重写属独立工作，需作者裁决范围（本轮未做）。

   **根因：篇幅契约在"写作侧"与"执法侧"长期错位（"同一目标三个数"）。** 实测链路：
   - `chapters.payload->>'targetWordCount'`：168 章里仅 **32 章**声明（2600×24、2800×3、2400×3、3000×1、3200×1），
     其余 **136 章无声明** → 回落 `DEFAULT_TARGET_WORD_COUNT = 3500`（`src/novel-v2/word-count.ts:19`）。
     声明集中在 120 章之后（1-119 章 0 声明；120-159 章 17/40 未声明；160-168 章 0/9 未声明），
     与 `story-arc.ts:474-478` 记录的 schema 变更时点（2026-09-17 之前 `targetWordCount` 只在 TS 类型里）吻合。
   - **写作侧**：`chapter_planning_contexts` 实测 **226 行，携带 `targetWordCount` 的为 0 行**——
     按章节对齐可见 `gate_sees = 2400/3200/3000/2800/2600` 而 `writer_sees = NULL`。即正文写作契约
     读到的是回落值 3500（`src/novel-v2/prompts/chapter-draft.ts:111` → `:90`），
     且措辞为"建议性目标…不因凑字或压字牺牲内容，也不设硬性上限"。
   - **执法侧**：提交门按声明值的 `MIN_LENGTH_RATIO = 0.6` 执法（`src/novel-v2/temporal/revision-policy.ts:165-169`），
     对声明 2600 的章只要求 ≥1560、对 2400 只要求 ≥1440，而对未声明章按 3500 要求 ≥2100。
   ⇒ 写作侧被告知 3500、执法侧按 1560 验收；声明值又系统性低于回落值（2400-3200 < 3500），
   **低声明本身即可自我授权短章**。这正是 `ai-taint-diagnosis-20260917.md` F1/§四-3 命名的
   "同一目标三个数"（编排者手写 2600 / 写作契约 3500 / 门执法 2100）。

   **该缺陷上游已于 2026-09-17 修复**（`postgres-repository.ts:340` 的 `chapterBlueprintFromRow`
   开始读 `payload.targetWordCount`；`:4896` 的 planning context 构造复用该函数），故**当前代码**下
   写作侧与执法侧读同一个数。168 章全部成稿于修复之前，且 226 行 planning context 均为存量，
   属"修复前产出的历史数据"，重新起草时会写带目标的新行（`id` 为执行蓝图 id，不复用旧行）。

   **残留缺口（本轮已补测）**：修复的**写作侧半段**此前无回归测试——`prompts.test.ts` 只覆盖 schema 与
   arc 侧契约，`postgres-repository.test.ts:67` 只覆盖映射。若 `chapter-draft.ts:111` 改读别处或重新内联
   回落值，全书会静默退回错位。已新增 `src/novel-v2/__tests__/length-contract-single-source.test.ts`
   （3 例：声明 2600 时播报 2600 且不得同时出现 3500；无蓝图时回落 3500；写作契约与执行合同对同一声明同数），
   并做反向验证——把 `chapter-draft.ts:111` 改成传 `undefined` 后正向例立即判红，恢复后复绿。

   **已落地的修复（2026-10-13，作者裁决选项 A：架构/指引层修根因，不重写正文，只对新章生效）**：
   蓝图 `targetWordCount` 的 schema 边界仍是 `minimum: 500`（结构性护栏），但新增**声明侧项目级下限**，
   由项目已有两个常量推导而非取经验值——`LENGTH_DECLARATION_POLICY.floor = ceil(sparseFloor / MIN_LENGTH_RATIO)`
   = `ceil(1800 / 0.6)` = **3000 字**（`src/novel-v2/word-count.ts`）。推导的语义判据：
   **声明目标不得低到让提交门的欠量下限跌破项目自己的稀疏线**——否则"声明比不声明更宽松"
   （未声明回落 3500 ⇒ 门限 2100；声明 2400 ⇒ 门限 1440），即本项根因。
   - 单源整理：`MIN_LENGTH_RATIO` 原为 `revision-policy.ts` 局部常量，上移到 `word-count.ts`
     唯一事实源（该叶子模块是长度类常量的既有归处；`revision-policy` 的导入链含 `application/*`，
     Temporal bundle 只允许无 node 依赖的纯导入链，比率留在那里推导就只能写成注释魔数）。
   - 生成面：`prompts/story-arc.ts` 的目标篇幅契约播报下限数值与推导（规划模型可据此合规）。
   - 审核面：`inspectLengthDeclarations`（确定性、零模型调用，与 `inspectStoryArcEnsemble` 同族）
     按批统计声明侧信号，`buildStoryArcReviewPrompt` 渲染为可执行审核意见——**已声明章中过半低于下限
     即按 major 报告并指认章号**；未过半只记信号并显式声明"不据此判 revise"（避免把审美阈值退化成硬门）。
     未声明章不计入占比（回落系统默认值本身即项目标准）。
   - 真实数据复算（`tmp/state-audit/verify-declaration-floor.mts`，只读）：24 个弧中 **6 个**会被判
     系统性低声明，且全部落在 132-168 章——`候验`(138-140)、`网的上游`(132)、`不半`(141-147)、
     `做局`(148-153)、`落位`(155-161)、`谁先说话`(162-168)，正是章长衰减带；**修复前为 0 个**
     （逐章都合法，批级下调在审核面不可见）。
   - 双向测试 `src/novel-v2/__tests__/length-declaration-floor.test.ts`（6 例：推导与语义判据、
     未声明章不计分母、占比边界恰好半数、正向 major 报告并指认章号、反例不判 revise、生成面播报下限）。
     回归捕获验证：把 `systematic` 判据改为恒假后 2 例立即判红，恢复后复绿。
   - 边界（刻意不覆盖）：这是**声明侧**判据，不是新的正文门，不与 `length-under-target` 竞争；
     已定稿章节不回溯（属重写工作，需作者单独裁决）；仅 1 章声明且低于下限的批次也会被判系统性
     （占 1/1）——有意的保守取向，让审核问一句而非静默通过。
   **另**：作者通道 `commitAuthorApproved`（`src/novel-v2/commit-service.ts:81-92`）不调用
   `evaluateCommitGate`，故 60% 下限亦可被批准绕过——此为**记录在案的设计**（`revision-policy.ts:162`
   "拦而不杀：作者通道仍可批准"），本轮不改；实测 `approval_evidence` 有 201 条 `approve`。

   **章名退化的根因（2026-10-13 第二轮取证）：命名指引在自动路径不可达，且两条路径的结构下限不一致。**

   三条硬证据：

   ① **`chapter.title` 执行点没有任何自动触发者。** `skills/novel-v2/chapter-naming.yaml` 原只声明
   `executionPoints: [chapter.title]`，而该执行点仅由 `generateChapterTitle`（`src/novel-v2/temporal/activities.ts:1815-1884`）
   消费；其触发者 `chapterTitleWorkflow`（`src/novel-v2/temporal/workflows.ts:745-804`）只由 UI 的
   "AI 更名"按钮发起（`src/pages/NovelV2Studio.tsx:473`），刻意不在 `TASK_CLASS_POINTS`
   （`src/novel-v2/skill-runtime.ts:33`）里，故不进自动编排。DB 实测：`workflow_runs` 按 type 分组只有
   `book-synopsis` / `chapter-review` / `creative-run` / `novel-intent` / `story-arc-planning`，
   **没有任何 `chapter-title` 类型的运行**；`outbox_events` 的 44 个 `event_type` 里也没有
   `chapter.title-generated`，且不存在 manuscript-document 聚合 ⇒ `persistGeneratedChapterTitle` 从未被调用。
   **168 个标题没有一个出自这条路径。**

   ② **标题的真实产出点是蓝图，而蓝图 schema 对标题只有 `minLength: 1`。**
   `src/novel-v2/prompts/story-arc.ts:63` 的 `chapters[].title` 是 `{ type: "string", minLength: 1 }`，
   且 `chapters[].title` 在 `:61` 的 `required` 里；而项目**自有**的更严契约 `CHAPTER_TITLE_SCHEMA`
   （`src/novel-v2/application/chapter-title.ts`：`minLength: 2` / `maxLength: 16` / 必含 CJK）只被
   UI 更名路径使用。两条路径对同一个字段的结构下限不一致，弱的那个才是唯一在跑的。
   （DB 佐证：`chapters.payload->>'title'` 与 `chapters.title` 逐行相等，标题确由蓝图带出。）

   ③ **命名 skill 从未接进蓝图的 skill 投影。** `chapter.blueprint` 执行点已注入 3 个 skill
   （`foundation-planning.yaml:7`、`plot-causality.yaml:8`、`story-arc-design.yaml:7`），并已接进故事弧生成
   （`src/novel-v2/temporal/activities.ts:1928-1929` 的 `resolveCurrentSkills({ executionPoint: "chapter.blueprint" })`
   → `buildStoryArcChaptersPrompt`），但 `chapter-naming` 不在其中。此前 SK-5/C5 的修复
   （`workflow-map.md:450`）把蓝图契约从"只被更名任务消费"改成"被故事弧生成消费"，却把命名 skill 留在了
   只有手动更名才走的那一侧——**指引存在，执行点却错**。

   **已落地的修复（2026-10-13）**：
   - `skills/novel-v2/chapter-naming.yaml` `1.0.0 → 1.1.0`：`executionPoints` 增 `chapter.blueprint`
     并新增 `chapter.blueprint` 的 `promptSections`（沿用该 skill 既有指引文本，不新写题材化规则）；
     `chapter.title` 保留给 UI 更名路径，两处共用同一段指引。
   - `src/novel-v2/prompts/story-arc.ts:63` 的 `title` 下限 `1 → 2`，对齐 `CHAPTER_TITLE_SCHEMA`，
     使蓝图这条**唯一在跑**的路径具备与项目自有契约相同的结构下限。
   - 双向测试：`skill-runtime.test.ts` 的 SK-5/C5 用例扩展为同时断言 `chapter.blueprint` 上下文
     既含 `chapter-naming` skill、又含其指引文本；`native-schema.test.ts` 新增一例断言
     `chapters.items.properties.title` 与 `CHAPTER_TITLE_SCHEMA.properties.title` 同下限。
     回归捕获验证：分别撤回上述两处改动，对应用例立即判红；恢复后全绿。
   - 技能库同步：`pnpm novel:skills:sync --target database` → `skippedStaleSeed: []`；
     `pnpm novel:skills:check` → `{ "status": "ok", "checked": 12 }`。
   - **端到端验证（运行库口径，非单测）**：`tmp/state-audit/verify-naming-e2e.mts` 用 `createDatabaseSkillProvider`
     走**运行库**技能行解析——`chapter.blueprint` 来源 `database`，解析出 `chapter-naming@1.1.0,
     foundation-planning@1.0.3, narrative-continuity@1.1.0, plot-causality@1.1.0, story-arc-design@1.0.0`，
     指令文本含命名技艺；`chapter.title` 仍只挂 `chapter-naming` 且不含蓝图契约。7 项判据全通过（exit 0）。
     这证明修复在生产（database）路径生效，而不只是 workspace seed。

   **边界（刻意不覆盖）**：① 不回溯改写已定稿 15 章的标题——那是内容工作（且 098「行」、139「可」、
   147「省写」在正文语境中可能成立），需作者单独裁决；② 不新增"标题长度"提交门——结构下限只留在
   schema 层，避免把审美判断退化成硬门；③ 不引入题材词表或禁用词表。
   **遗留**：15 个已定稿短章名保持原样：`8 杂音`、`9 盯梢`、`60 照册`、`72 顺路`、`74 照办`、`76 独走`、
   `80 练错`、`95 递式`、`98 行`、`108 并看`、`111 顿笔`、`122 回条`、`125 白怕`、`139 可`、`147 省写`。

5. **商业面缺口**（§2）：049-060 零回报兑付、051-080 对白密度 0.33 段/千字。
   **2026-10-13 机制复核（发现一处可见性缺口；同日已落地，见本项末）**：

   **上游病灶自 2026-09-16 起已有确定性信号且已接线**：`inspectStoryArcEnsemble`（`src/novel-v2/application/story-arc.ts:528`）
   的 `soloOnlyOrders` / `longestSoloRun`（"全部场景参与者 ≤1 的章"与"最长连续独处游程"），以及
   `payoffRhythm` 账（`src/novel-v2/postgres-repository.ts:4420-4450`，证据句「061-091 共 31 章结清 0 笔」），
   都由 `renderStoryArcEnsembleSignal` 与 payoff rhythm 渲染进**弧规划面与弧审核面两侧**
   （`src/novel-v2/prompts/story-arc.ts:354` 结构化上下文段、`:403-407` 纯文本上下文），
   审核面还有独立的「第二意志缺口检查」子句（`src/novel-v2/prompts/story-arc.ts:530`）。
   即"蓝图层单人节目单是正文对手戏崩落的直接上游"这一根因，已有机器可判的信号在把关。

   **但正文侧的对白密度至今没有任何通道测量**：全仓 `对话|引号|dialogue` 共 44 处命中，全部是
   prompt 文本（`chapter-draft.ts` / `story-arc.ts` 的审核子句）、H3 短片节拍、`structured-json.ts` 的
   JSON 引号修复，以及 `src/novel-v2/temporal/revision-policy.ts:281-314` 的"引号内专名漂移检测"——
   **没有一处统计正文的对白量**。`src/novel-v2/application/manuscript-structure.ts` 的 8 个结构通道
   （重复段/碎片化/段落坍缩/呼吸扁平/引号配对/内嵌标题/口癖族/章末仪式）里，与引号相关的只有
   `manuscript.quote-pairing`（半角直引号奇数配对，码位级检查），不是密度。`style_contracts` 表 0 行，
   故含 `dialogueRatio` 维度的文风契约（`src/novel-v2/style-contract/index.ts:21`）在本项目从未实例化。
   ⇒ **上游信号只能看见"蓝图参与者数"，看不见"正文实际对白"**；两者之间没有任何回读。

   **本轮实测（确定性，零模型调用）**：脚本 `tmp/state-audit/measure-dialogue-density.mts` 扫
   `.novel-bench/baselines/spiritcode-r363/chapters/` 全 168 章（与 DB revision 363 一致），
   口径①"对白字占比"＝引号（`「」『』“”"`）内有效字 / 有效字，口径②"对白段占比"＝含引号段落 / 总段落。
   分段均值（口径①）：001-020 **6.78%** → 021-040 5.38% → 041-060 1.97% → **061-080 0.67%** →
   081-100 0.90% → 101-120 1.77% → 121-140 3.87% → 141-160 1.42% → 161-168 0.67%；
   全书均值 **2.74%**（口径② 17.3%，均 3.37 段/千字）。⇒ 与 `chapter-quality-bands-20260922.md` 的
   "051-080 死亡象限"和 2026-09-16 全书复盘的"对白占比 6.7% → 0.3%"吻合（6.78% 正是首段实测值），
   **崩落幅度约 10×，且末段（161-168）回到 0.67% 的最低点**。
   **14 章正文中没有任何一段含引号**：026、037、052、070、085、087、111、113、114、140、146、153、167
   （另 061、098 仅 0.04%）。最低的 ch153 只有 6 个段落、1133 有效字。

   ~~**待裁决**：是否新增"正文对白密度"串行信号~~ → **2026-10-13 已落地（作者裁决选项 A）**：
   新增"正文对白密度"串行信号——与 `LENGTH_DRIFT_POLICY` 同型：确定性统计、
   取最近 N 章定稿、只作**描述性信号**渲染进弧规划与弧审核两面、不做硬门。
   **权衡**：`skills/novel-v2/reader-emotion.yaml` 明确要求"不要为了制造追更感机械添加危险、反转、
   悬念问句或情绪宣言"，也允许"安静、相处、恢复和余波以自身功能成立"——新增对白信号有被模型读成
   "补对白"指令的风险；但现状是这条维度**完全不可见**，生成面与审核面都无法看到产出正在把对手戏
   挤出正文。**边界（若实施）**：只报告窗口统计与"零对白章"清单（结构事实，无审美阈值），
   不设绝对下限、不做逐章门；是否设下限属另案。

   **落地实形（2026-10-13；本条与 workflow-map 的回填由复核轮补齐）**：
   - 统计：`src/novel-v2/word-count.ts` 的 `countDialogueCharacters`（与 `countNovelCharacters` 同一字符口径）、
     `DIALOGUE_DRIFT_POLICY`、`inspectDialogueDrift`（窗口不足 `minWindow` 时返回 `undefined`，不产出信号）。
   - 两面渲染：`src/novel-v2/prompts/story-arc.ts` 类型声明 `:188-195`、纯文本渲染 `renderStoryArcDialogueDrift`
     `:259-265`、结构化上下文段 `:383`、弧审核面 `:437`；零对白章以清单形式给出（`silentOrders`）。
   - 取数：`src/novel-v2/postgres-repository.ts:4403`（近窗口定稿章的对白字数），并入 `serial-signals` 指纹 `:4601`。
   - 迁移：`deploy/postgres/098_content_blob_dialogue_characters.sql`（`content_blobs` 增列）。
   - 测试：`src/novel-v2/__tests__/dialogue-density-signal.test.ts`。

   **部署面空转与修复（2026-10-14 复核轮实测，本项最严重的一处）**：以上链条在**代码层全通**，
   但在运行库上**完全不可见**。实测（`tmp/state-audit/verify-dialogue-signal-liveness.mts`，只读）：
   `content_blobs` 424 行中 `dialogue_characters IS NULL` 的有 **424 行**（同表 `word_count` 为 0 行 NULL），
   近窗口 6 章（163-168）可测章数 **0** ⇒ `inspectDialogueDrift` 恒返回 `undefined` ⇒
   `renderStoryArcDialogueDrift` 恒返回空串 ⇒ 本信号的规划面与弧审核面**从未收到过任何数字**。
   同批实测：`schema_migrations` 无 098 行（列与约束已存在，账本行缺失），doctor `migrations` FAIL。
   **根因（部署层，非算法层）**：`backfillMissingContentWordCounts` 本身正确且有测试，但其唯一调用点
   挂在 `scripts/novel-v2-api.ts` 的启动代码里；`scripts/novel-v2-worker.ts` 同样调 `migrate()`、
   同样经 `getStoryArcPlanningInput` 消费该信号，却**永远不回填**。而"观测命令不得 migrate"
   （skill-drift 同款设计纪律）使 doctor 也不会顺手补上它。这与 §5 的技能漂移是同一形态：
   **seed 已改、库没重灌、服务没重启 ⇒ 新机制静默空转**。
   **为什么单测全绿而机制是死的**：`inspectDialogueDrift` 与渲染层的每个单测都自带
   `dialogueCharacters`，没有一个用例走到"库里这一列是 NULL"这条真实路径；NULL 分支只有
   `row.dialogue_characters === null → return []` 一行，属"不可测即排除"的正确实现，
   没有任何断言覆盖"整库皆 NULL 时信号应当缺席"这件事。
   **修复**：回填归位到 `migrate()` 尾（API 与 worker 唯一共同经过的启动路径，与既有 6 条
   启动修复同层），`migrate(dir, objects?)` 第二参可选——调用方缺省不传即保持既有行为
   （测试库不接对象存储）。两个入口都改为传 `objectStore`。
   **修复后实测**：424/424 回填成功（失败 0）；`schema_migrations` 补上 098 行
   （`ALTER TABLE … IF NOT EXISTS` 幂等，migrate 自愈）；doctor `migrations` 与 `skill-drift`
   均由 FAIL 转 OK；近窗口信号 = `{windowSize:6, avgRatio:0.85%, silentOrders:[167], minRatio:0}`——
   **低于 `hintBelowRatio`(1%) 且含一章零对白，"对白密度提示"自此会真的触发**。
   同窗口用 `.novel-bench` 基线语料按 `countDialogueCharacters` 独立复算，与库内值**逐位相等**
   ⇒ 口径无偏，回填写进去的就是准则函数会算出的数。
   **回归锁**（`src/novel-v2/__tests__/serial-context-db.test.ts` 新增一例）：用真库行驱动，
   断言"列为 NULL 时信号缺席（不是报假零对白）"与"回填后信号在场、窗口 6 章全可测、
   均占比落在 (0,1) 开区间"；反向摘除 migrate 尾的调用即判红（本轮已实测双向）。

   **边界的裁决与落地（2026-10-14，作者裁选项 ①，已实施）**：本节原写"边界：只报告窗口统计与
   "零对白章"清单（结构事实，无审美阈值），不设绝对下限、不做逐章门"，而实现里 `story-arc.ts`
   有一个**渲染层触发阈值** `avgRatio < 0.01`，决定是否追加"对白密度提示"那段文案。
   **裁决：承认该阈值为合法的渲染触发，理由是它不属 spec 禁的那一类**——它不拦停、不逐章门、
   不决定 revise；同一触发条件里已有 `silentOrders.length >= 2`（零对白章数，纯结构量）覆盖结构面，
   而"每章都有一两句、整体几乎为零"落在 0 与零对白之间，这个区间真实存在，换任何比例判据仍属阈值。
   另有一条把它记成"违反 spec"则是判错了类：该禁的是把阈值写成**门**，不是决定"要不要多说一句"。
   **随之修掉的两处实现缺陷**（属 AGENTS.md 的魔法值与双写，不是阈值本身）：
   ① 阈值原为字面量 `0.01` 且无命名常量，已抽为 `DIALOGUE_DRIFT_POLICY.hintBelowRatio`，
   并经 `DialogueDriftReport.hintBelowRatio` 随报告带出，渲染层与审核层都从报告取这条线；
   ② 弧审核子句原写死"不足 1%"，与渲染层同一阈值**双写**，已改为"低于密度提示线"。
   **本项边界据此订正为：不设绝对下限、不做逐章门、不拦停；有一处渲染触发阈值决定是否追加提示。**
6. ~~**30 条无来源断言**（§3.4）~~ → **2026-10-13 复核：纯存量，当前代码不再产生**。
   30 条的构成：19 条 `episodic/知晓/derived`（角色富化的知识边界，`title` 形如「楚衡 的信息边界（第1章）」，
   带 `source_document_id` 但无 `source_artifact_id`）、9 条 `hierarchical/chapter-memory-rollup/derived`
   （「第1-20章长期记忆汇总」，无 `identity_hash`，聚合产物）、2 条 `episodic/状态变化/author`（narrative_start=91，作者裁定）。
   创建时间全部落在 2026-08-07 … 2026-09-16，**此后零新增**：按 `predicate='知晓'` 分日统计，
   2026-09-09 起每天的 `source_artifact_id IS NULL` 计数恒为 0（09-11 85/0、09-12 161/0、09-13 139/0、
   09-14 127/0、09-15 333/0、09-16 131/0、09-17 11/0）——即
   `character-enrichment/index.ts:326-334` 把 `artifact` 传给 `recordFactExtraction` 之后，该路径已正常归属。
   结论：不需要代码改动；这 30 条属历史遗留，可用既有 `memory-governance-backfill` 思路补归属或退役，**无正确性影响**
   （19 条仍可经 `source_document_id` 溯源到章）。
7. ~~**主体 id 碎片化**（§3.6，2026-10-13 新发现）~~ → **代码侧已于 2026-10-13 落地（选项 a）**：
   出口归一补齐了"命中则重写"之外的两半——键等价阶梯（NFKC/空白/`-`_`/大小写折叠 + `char_x` 与裸名 `x` 等价）
   与未命中侧的 `pendingEnrichment` 实体登记（`kind='character'`，`ON CONFLICT DO NOTHING`），
   内部与外部 MCP 两条提取路径共用。真实数据验证：171 个 active subject 键的解析命中数 38 → 39，
   主角那对互斥死因（`char_chu_heng` vs `chu_heng`）自此落进同一 identity 槽。
   **遗留（两项，均为存量/语义范畴，属另案）**：① 键归一只解决小头——132 个键仍未命中，
   其中 124 个键 / 232 条断言属可登记命名空间，本次改动只对**新提取**生效，存量需回填脚本新增
   "按 active 断言的可登记主体键批量登记"一步；② `char_qi`/`char_fan_zhu_shi`/`char_zhou_xiong_shi`
   这类"看似规范但注册表没有"的键登记后会与既有中文名实体（`齐姓人`/`繁主事`/`周师兄`）并存为两个实体，
   消歧需语义判断（§5.4 P2 + 外部事实梳理）。附带放大器仍在：实体注册表自身 id 约定不一致
   （56 个实体里 7 个用 `char_*`、49 个用中文名当 canonical id）。
8. ~~**治理工具与存储设计脱节**（§3.7）~~ → **已于 2026-10-13 修复**：回填脚本的 Foundation 代际退役步
   仍按 pre-singleton 的 `foundation:<artifactId>` 取目标行，dry-run 报的"退役 11 条"是假计划
   （实测 5 组里 4 组选中已被单例 `supersedes` 的陈旧行、1 组目标行根本不存在，`UPDATE` 命中 0 行静默无操作）。
   改为以 `foundationClaimId(projectId, taskKey)` 单例为目标后，dry-run 复归"0 组"——与"56 条存量行
   已全部被 5 条单例覆盖"的实测一致。**遗留**：同脚本的 `subject_refs 归一` 步仍有 9 行待应用
   （全是 chapter-memory rollup 的显示名主体，改写只动 `subject_refs` 不动 `content`，无提示词回归）。

---

## 8. 架构复核结果（本轮验证为健康）

- `npm run lint`（`tsc --noEmit && tsc -p tsconfig.runtime.json`）→ 干净，无输出（含 §3.7 的脚本修复）。
- `npm run test`（`vitest run`）→ **Test Files 139 passed (139)，Tests 1259 passed (1259)**（含 §3.5 新增 3 例、§4.6 新增 3 例、§3.6 新增 8 例、§7 第 4 项篇幅写作侧 3 例 + 声明侧 6 例 + 章名 2 例；基线为 1235）。
- `pnpm novel:v2:doctor` → `skill-drift` / `temporal` / `postgres` / `qdrant` / `memory-index-drift` 等通过；`api`/`worker` 因本轮未启动服务而 FAIL（预期，非缺陷）。
- Docker 基础设施 5 容器在跑：postgres(5432)、temporal(7233)、temporal-ui(8088)、minio(9000/9001)、qdrant(6333)。Novel V2 API(4770) 与 Worker 未运行。
- 工作区既有未提交改动（与本轮无关）：`CONTEXT.md`、`README.md`、`src/lib/imageStore.ts`、`src/stores/asset.ts`、`src/stores/history.ts`，新增 `src/lib/cappedList.ts` 及三个测试文件。

### 8.1 复核轮（2026-10-14）：一处"代码全通而机制空转"的部署缺陷

本轮以严苛读者 + 工程师双视角复查上表全部行，重点验证"已落地"的机制是否**真的在运行库上生效**（而非仅代码层正确），发现并修复 §7 第 5 项对白密度信号的部署面空转（详见该节末段：424/424 派生列全 NULL ⇒ 窗口可测章数 0 ⇒ 信号恒 undefined ⇒ 规划面与弧审核面从未收到任何数字）。

| 项 | 修复前 | 修复后 |
|---|---|---|
| `content_blobs.dialogue_characters IS NULL` | 424 / 424 | 0 / 424 |
| 近窗口（163-168）可测章数 | 0 | 6 |
| `inspectDialogueDrift` 实得 | `undefined` | `{windowSize:6, avgRatio:0.85%, silentOrders:[167], minRatio:0}` |
| "对白密度提示"是否触发 | 从不 | 均占比 0.85% < 1% 且含一章零对白 ⇒ 触发 |
| `schema_migrations` 098 行 | 缺失 | 已在（migrate 幂等自愈） |
| doctor `migrations` / `skill-drift` | FAIL / FAIL | OK / OK |
| 库内值 vs 基线语料独立复算 | 无值可比 | 逐位相等 |

- 改动：`migrate(dir, objects?)` 增可选对象存储参，派生指标回填归位 migrate 尾；`scripts/novel-v2-api.ts` 与 `scripts/novel-v2-worker.ts` 均传 `objectStore`（worker 此前完全不回填，是本缺陷的直接成因）。
- 读者视角落地：`skills/novel-v2/prose-craft.yaml` 1.4.0 → 1.5.0，跨章清点/温度判定/数数收尾三类惯性进写作、审核、修订三面（详见文末读者视角附记）。
- 验证（两批合计）：`npm run lint` 干净；`npm run test` → **142 files / 1292 tests 全绿**（新增 3 例：migrate 尾回填写双向、真库信号缺席/在场、清点惯性三面接线）；**反向实测**——摘除 migrate 尾的回填调用后两条新测试同时判红，摘除 prose-craft 写作侧清点段后三面接线用例判红（均已跑）。

### 8.2 复核轮 round 3（2026-10-14）：段 ↔  provenance 映射漂移 + 判据常量双写

以工程师视角复查 §7 第 5 项信号的**收据链**（receipt → sectionFingerprints → 渲染段 provenanceRefs），
发现两处映射缺陷，均不抛错、不影响任何科目的通过与否，只是让上下文**悄悄失去可追溯性**或**悄悄说错数字**：

**缺陷一"非空段零 provenance"**：`arc-context-serial-signals` 段的文本恒非空（`serialSignals`
兜底文案 + ensemble / lengthDrift / dialogueDrift / payoffRhythm 四信号各自渲染），但其指纹登记条件是
`serialFunctionRuns || lengthDrift || dialogueDrift`。三者皆缺而 ensembleSignal / payoffRhythm
在场时（合法输入），段有内容而指纹不在册 ⇒ `sourceRefs` 取不到值 ⇒ **provenanceRefs 为空数组**。
构造性复现实测（`tmp/state-audit/verify-serial-provenance-constructive.mts`）：段 314 字、含两个信号、
引用为空。其余段（macro/recent/open-elements/…）的指纹无条件登记，独此一处是条件的。
真库侧（`tmp/state-audit/verify-serial-section-provenance.mts`）本项目三信号俱全故条件恒真、暂不现形——
**这正是它危险的原因**：缺陷只在合法输入的另一个分支上出现。

**缺陷二"算了没人取的指纹"**：`payoff-rhythm` 指纹单独登记，而"跨弧回报节奏"信号实际渲染在
serial-signals 段**内部**，渲染侧从未有人 `sourceRefs(receipt, "payoff-rhythm")`。指纹算了、
receipt 里带着、没有任何消费方。构造性复现：`payoffRhythmFingerprintConsumedByAnySection: false`。

**根因（同一处）**：**段标识与指纹键各自演进后漂移**——五个信号合成了一个段，指纹却按信号粒度登记
（其中一个还漏了共享入口）。

**修复（最低共享层 = 一张显式对应表）**：新增 `STORY_ARC_CONTEXT_SECTION_IDS`
（`application/story-arc.ts`），左列渲染侧段 id、右列 receipt 指纹键；两侧都从本表取键。
serial-signals 指纹改为**无条件登记**（该段恒非空，故无条件），并把 payoffRhythm 并入其指纹输入；
移除 `payoff-rhythm` 死键；顺带补上 `secrets` 段原先漏登的指纹（该段条件渲染却无键 ⇒ 有段无引用）。
不拆段：五信号同族（都是"近窗口确定性统计"），拆开只会稀释优先级并让读者在五段之间跳。

**附带发现并修复：判据常量双写**（缺陷三）：`renderStoryArcLengthDrift` 把
`LENGTH_DRIFT_POLICY.sparseFloor` 的值抄成字面量 `1800`。计数在仓储侧按常量算、句子在渲染侧按
字面量说 ⇒ 改常量只改一边，提示里报的"低于单章下限 N 字"与真实计数线分叉。已改为取常量，
并加源码级字面量扫描锁（剥注释行后 `prompts/story-arc.ts` 代码本体不得出现该常量值；
反向确认锁没空转：渲染函数确实消费该常量）。

**回归锁（`src/novel-v2/__tests__/prompts.test.ts` 新增 3 例）**：
① 段 ↔ 指纹键对账（每个在场段都取其键、不得残留 `payoff-rhythm` 信号粒度键）；
② 缺陷一显式夹具（段非空而键不入册 ⇒ 必须报零引用，**不造悬空引用**——零引用是可观测的
"可追溯性缺失"，指向不存在指纹的引用是"假可追溯"，比原缺陷更坏）；
③ 条件段无指纹时不给悬空 provenance 且空段不注入；
④ 判据常量双写锁。
**反向实测**：把 serial 段改取 `payoff-rhythm` 键（缺陷二形态）→ 对账用例判红；
把 `${LENGTH_DRIFT_POLICY.sparseFloor}` 改回字面量 1800 → 双写锁判红（均已跑）。
真库复验：`payoff-rhythm` 键消失、`serial-signals` 键恒在、`secrets` 补登、serial 段带真实引用。
- 读者视角附记（本轮精读 049/051/056/059/062/064/067 等章）：主线文字质量为"冰山式克制"，问题不在句子而在**重复的可感知结构**——主角反复以同一套动作清点随身物件（废石/玉牌/丹/碎角/左膝/回执/草图，各配一次"凉"）、以指节敲纸排列日期、以"数呼吸/数天色"收尾。机械测量（`tmp/state-audit/measure-narrative-idioms.mts`，确定性、零模型调用）：道具盘点词族全书 862 处 / 每千字 2.16，最高 032 章 15.56/千字；"凉"族 317 处 / 每千字 0.78，最高 062 章 7.18/千字；数数收尾族 221 处 / 每千字 0.60。**分段均值揭示两族峰值都落在商业基准确诊的"死亡象限"内**：道具盘点族 21-40 章 5.30/千字（全书 6.6× 的 2.16）、41-60 章 4.79、61-80 章 3.81；温度族 61-80 章 1.52/千字（全书近 2× 的 0.78）。⇒ 与 §7 第 5 项的对白崩落**同源**：对手戏缺席，章节以物件清点与内省填充。该形态**不是单章缺陷而是跨章惯性**，属生成面指引问题而非事实记忆问题；已定稿章不回溯，故不动正文。
- **本轮落地的生成面指引**（`skills/novel-v2/prose-craft.yaml` 1.4.0 → 1.5.0，三面同步）：写作侧要求"本章这次清点必须与以往任何一次不同——带来新信息（某件位置/状态真的变了）、新选择（据此决定下一步）或新代价（清点本身有风险），三者都不成立时改为写清点之后的那一个动作"，并把"以数数收束一章"并列为同类惯性（一处是留白，多处是模板）；审核侧列为必查项，且**要求报告指明它挤掉了什么**（本章缺的那次交锋、那次变化），把动刀理由钉在"该有的现场没发生"而非"这个动作出现太多次"；修订侧给出修法"不是删清单，而是给这次清点安上它缺失的功能"。判据用通用叙事模式描述（随身物件清点 + 同类温度/质感判定 + 数数收尾），不含任何本书专有物件名，跨题材复用。测试：`skill-runtime.test.ts` 新增一例，三面接线 + 写作侧三条件 + 审核侧"挤掉了什么"均在场；反向摘除写作侧该段即判红（本轮已实测）。

---

## 9. 取证路径备查

- 章节正文：`.novel-bench/baselines/spiritcode-r363/chapters/001-异世醒转废柴身.txt` … `168-慢半步.txt`（168 章，与 revision 363 一致），可直接读取。重新导出：`node --import tsx scripts/export-novel-quality-baseline.ts --project-id <id> --output <dir>`（要求输出目录为空；MinIO 为 xl.meta 内联格式，须走 S3 SDK）。
- DB：`postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp`；MinIO user `ymcp` / pass `ymcp-minio-local`，bucket `ymcp-novel`。
- 数据规模（ymcp 库）：chapter_memories 333、chapter_planning_contexts 226、chapter_review_snapshots 168、entities 57、foreshadowing 717、manuscript_documents 168、manuscript_revisions 400、memory_bundles 465、memory_claims 2126、memory_gate_states 1、narrative_state_snapshots 333、plot_threads 7、project_plan_sections 5、promises 31、relations 389、reviews 2252、scenes 227、skill_bundles 466、skill_definitions 47、story_arc_batches 24、volumes 1。
- 既有评估文档：`docs/novel-v2/` 下 `chapter-quality-bands-20260922.md`、`improvement-plan-fact-injection-20260922.md`、`commercial-benchmark-review-20260922.md`、`product-audit-20260910.md`、`memory-governance-audit-20260909.md`、`ai-taint-diagnosis-20260917.md`（F1/§四-3 为篇幅错位的一手诊断）、`p1-foreshadowing-survey-20260918.md`、`workflow-map.md` 等。
- 章长取证 SQL（§7 第 4 项）：`SELECT c.ordinal, c.title, c.payload->>'targetWordCount' AS gate_sees, (cpc.payload->'chapter'->>'targetWordCount') AS writer_sees FROM chapters c LEFT JOIN chapter_planning_contexts cpc ON cpc.document_id=c.document_id WHERE c.project_id='novel-spirit-code-rev-create-20260806-v1' ORDER BY c.ordinal`（`gate_sees` 非空而 `writer_sees` 为空即错位形态）。
- 重复提取复测 SQL（§3.4）：① 被退役的提取工件 `SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM memory_claim_sources s WHERE s.artifact_id=a.id)) AS no_sources, count(*) AS total FROM artifacts a WHERE a.project_id='<id>' AND a.kind='fact-extraction'`；② 多代际文档 `SELECT s.document_id FROM memory_claim_sources s JOIN artifacts a ON a.id=s.artifact_id WHERE s.project_id='<id>' AND s.lifecycle_status='active' AND a.kind='fact-extraction' GROUP BY s.document_id HAVING count(DISTINCT s.artifact_id)>1`；③ 陈旧来源按工件 kind 分解 `... JOIN manuscript_documents d ON d.id=s.document_id WHERE s.lifecycle_status='active' AND s.revision_id IS DISTINCT FROM d.current_revision_id GROUP BY a.kind`；④ 单章 revision 时间线 `SELECT r.revision, r.created_at, r.retention_class, (SELECT count(*) FROM memory_claim_sources s WHERE s.revision_id=r.id AND s.lifecycle_status='active') AS active_sources FROM manuscript_revisions r WHERE r.project_id='<id>' AND r.document_id=(SELECT id FROM manuscript_documents WHERE project_id='<id>' AND narrative_order=1) ORDER BY r.revision`。
- 章名取证 SQL（§7 第 4 项）：① 标题长度分布 `SELECT char_length(title) AS len, count(*) FROM chapters WHERE project_id='<id>' GROUP BY 1 ORDER BY 1`；② 短标题清单 `SELECT ordinal, title FROM chapters WHERE project_id='<id>' AND char_length(title) <= 2 ORDER BY ordinal`；③ 标题是否出自蓝图 `SELECT count(*) FILTER (WHERE payload->>'title' = title) AS from_blueprint, count(*) FROM chapters WHERE project_id='<id>'`；④ 更名工作流是否跑过 `SELECT type, status, count(*) FROM workflow_runs GROUP BY 1,2`（查 `chapter-title`）与 `SELECT event_type, count(*) FROM outbox_events GROUP BY 1`（查 `chapter.title-generated`）。
- 对白密度取证（§2 与 §7 第 5 项）：`node --import tsx tmp/state-audit/measure-dialogue-density.mts`（读 `.novel-bench/baselines/spiritcode-r363/chapters/*.txt`，确定性、零模型调用，输出分段对白字/段占比、全书均值与最低/最高 15 章）。判定"是否有测量通道"：`grep -rn "对话|引号|dialogue" src/novel-v2`（44 处，无正文对白统计）+ 读 `src/novel-v2/application/manuscript-structure.ts`（8 个结构通道里引号相关只有 `manuscript.quote-pairing`）+ `SELECT count(*) FROM style_contracts`（0 行 ⇒ 含 `dialogueRatio` 的文风契约未实例化）。
- 对白密度**信号存活**取证（§7 第 5 项的 10-14 复核）：`node --import tsx tmp/state-audit/verify-dialogue-signal-liveness.mts`（只读，零模型调用）——输出 content_blobs 的 NULL 分布、窗口可测章数、`inspectDialogueDrift` 实得报告，以及用 `.novel-bench` 基线语料按 `countDialogueCharacters` **独立复算**的同窗口反事实报告。两者相等即"库内值 = 准则函数值"（口径无偏）。
- 本轮新增/改动脚本与测试：`src/novel-v2/__tests__/length-contract-single-source.test.ts`（篇幅契约单源，3 例）、`src/novel-v2/__tests__/length-declaration-floor.test.ts`（声明侧项目级下限，6 例）、`src/novel-v2/__tests__/skill-runtime.test.ts`（SK-5/C5 用例扩展，+0 例）与 `src/novel-v2/__tests__/native-schema.test.ts`（章名下限对齐，+1 例）；`tmp/state-audit/verify-declaration-floor.mts`（按弧复算声明侧信号，只读）、`tmp/state-audit/verify-injection-e2e.mts`、`tmp/state-audit/verify-combined-ab.mts`、`tmp/state-audit/verify-subject-normalization.mts`、`tmp/state-audit/verify-holding-slot.mts`、`tmp/state-audit/verify-dormancy-filter.mts`（均为只读取证脚本）。
