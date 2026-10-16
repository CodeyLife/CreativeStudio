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

### 8.3 复核轮 round 4（2026-10-14）："观测面报的病，它开的药方治不了"

以工程师视角复查 doctor `memory-index-drift`（欠灌行 76 / 陈旧点 42 / 脏索引项目 1）的
**处方链**，发现告警与修复路径脱节。三层取证（`tmp/state-audit/verify-stale-points.mts`、
`verify-stale-point-consequences.mts`、`verify-stale-point-recall-budget.mts`，均只读）：

**① 先问"告温是不是真的"**——42 个陈旧点索引时刻全是 `active`（derived 27 / approved 15，
全部 `kind=episodic`），没有一个能对上当前可见行 id。按 payload.claim.id 回库分类：
**行已删 15 / 行 active 但携带 supersedes 10 / 行 active 被可见杀手退役 12 / 行 staged 5**。
⇒ 基线谓词没错，告温为真。

**② 再问"后果有多实"**——`wouldBeRecalledAsLive = 0`：42 个点的 payload.claim.id
**全部不在当前可见集**，召回侧 `filterIndexableMemoryRowIds` 会把它们全部丢弃。
⇒ **不是正确性缺陷**（不会把退役内容当现行事实），这一条必须如实记录，不能夸成"读到假事实"。

**③ 但代价是真的**——42 个点**全部会通过 Qdrant 服务端过滤器**（`lifecycleStatus=active`
∧ `authority ∈ 可见集` 读的是**索引时刻的载荷副本**），于是真的进入 `limit: 64` 的
top-K 召回窗，只在应用层才被丢弃。**名额是在服务端检索阶段就被占掉的，应用层丢弃救不回那 64 个位置。**
叙事分布：41/42 的 `narrativeStart ≤ 139`，集中在第 1-32 章。⇒ 后果是"近期真事实被挤出召回窗"，
与"读到假事实"是另一条路径（一个是读不到真的，一个是读到假的），量级小但方向真实。

**④ 根因：处方链断裂**——doctor 的 detail 明写"陈旧点会把已退役内容当现行事实召回，走
POST /v2/projects/:id/memory/rebuild 重建"，而该路由（`scripts/novel-v2-api.ts`）**只做补灌**：
它 upsert 全部可见行，而 `upsertClaims` 只删**被本次 upsert 的行 supersedes** 的点——
对"行已删 / 已 staged / 已被此后行退役"而点仍在索引里的陈旧点完全无动作。
**⇒ doctor 报的正是 rebuild 修不了的那个方向**：补灌能修欠灌（76 条），陈旧点（42 个）一个都修不掉。
这是"不抛错、不影响任何科目通过、只是让告警长期挂着无人能解"的又一件。

**修复（最低共享层）**：
- `memory-index-drift.ts` 新增 `staleMemoryPointIds(baseline, indexed)`：把"单项目陈旧点差集"
  从 `detectMemoryIndexDrift` 的多项目对账里抽出，**与 doctor 共用同一判据**（不写第二套集合差）；
  `indexed === null`（点集不可得）返回空——拿不到实有集合就不能安全删。
- `memory/rebuild` 路由补上清理：基线取 `listIndexableMemoryRowIds`（与 doctor **同一函数**），
  翻页走完才删（半个集合会把未翻到的现行点当陈旧点盲删），删点失败只 warn 不阻断
  （PostgreSQL 是权威真源 + 召回侧有 filterLiveRowIds 兜底）；`completeMemoryRebuild`
  增 `removedStalePoints` 计数，经 outbox 事件带出。
- **为何按点 id 直删而不是走 `deleteClaims`**：后者的契约是"行 id → 内部散列"，
  而陈旧点的行通常已不在基线里（这正是它成为陈旧点的原因），拿不到行 id。

**运行库实修**（`tmp/state-audit/verify-stale-point-cleanup.mts`，会写 Qdrant）：
陈旧点 **42 → 0**；索引内可见点 **2089 → 2089（零误删）**；欠灌 76 条留给 rebuild 补灌侧。
二次运行 0 → 0（幂等）。doctor 复跑：`陈旧点 0 个（脏索引项目 0 个）`。
**本条最需留意的判据**：误删判据不能说"expected 里的点不在 after 里就是丢了"——
欠灌的 76 条本来就不在索引里，把它们算成丢失是验证脚本自己的假红（首版即如此，已修）；
正确判据是"清理前在索引里的可见点，清理后必须还在"。

**回归锁**（`prompt-execution-retention.test.ts` 新增 2 例）：① `staleMemoryPointIds`
与 `detectMemoryIndexDrift` 的 `extraPointIds` **逐项相等**（同一判据），点集不可得返空、
干净集返空；② 源码级路由锁——rebuild 段内必须出现 `staleMemoryPointIds` 与
`listIndexableMemoryRowIds`，不得内联集合差，删除必须走 `qdrant.delete`。
**反向实测**：把 rebuild 路由摘回"只补灌"形态，路由锁判红（已跑）。

### 8.5 复核轮 round 5（2026-10-14）：欠灌 76 条的净缺口只有 13，根因是"库写了、索引没写、无人记账"

round 4 清光陈旧点后，doctor 只剩"欠灌行 76 条"。三层只读取证
（`tmp/state-audit/verify-under-indexed-rows.mts` / `-attribution.mts` / `-reachable.mts`）：

**① 不是正常异步窗口**：76 条里最新的一条也有 **713 小时（≈30 天）**——写入与索引间的
瞬时窗口不可能跨月，是漏索引。构成：52 claims + 24 chapter memories，全为
`episodic`/`hierarchical`，45 approved + 7 derived，集中在第 1-40 章。

**② 处方这次是自洽的**：rebuild 的补灌侧枚举覆盖全部 76 条（`notCoveredByRebuild: 0`）。
与 round 4 正好相反——那条是"观测面报的病、药方治不了"，这条是"药方对，但没人开"。

**③ 按语义分层，净缺口只有 13 条**（这步不能省，否则会把 76 都当缺口去补）：

| 类别 | 条数 | 性质 |
|---|---|---|
| 净不可达：claims（identity_hash 无已索引同槽行） | **7** | 真缺口 |
| 净不可达：章记忆（revision 仍是 current） | **6** | 真缺口 |
| 同槽已被索引（identity_hash 撞已索引行） | 45 | 非缺口：该身份槽当前值已可召回 |
| 陈旧 revision 的章记忆（该章后来重写过） | 18 | 非缺口：新版摘要已索引 |

**根因（写路径机制缺口）**：`chapter-memory/index.ts` 的 `persistChapterMemoryOutput`
是**先写库、后写索引**的顺序，索引失败按"不阻塞 commit"契约只 `console.warn`，
并挂着一句 `TODO P2`（本该接 learning 闭环，从未做）。于是库里那一行此后在
**一切查询里都显得完全活着**（可见性谓词认它、基线枚举含它、authority 正常），
只有语义检索永远召不回它。没有任何科目因此变红，唯一的暴露途径是 doctor 的漂移检查，
而它按设计"只报不修/不自动触发"——**一次瞬时 Qdrant 故障可以这样静默数周**。
6 条 current-revision 章记忆正是这个形态。

**修复（保留不阻塞契约，补耐久痕迹）**：
- `postgres-repository.ts` 新增 `recordMemoryIndexWriteFailure({projectId, rowIds, reason, stage})`：
  落 `audit_records`（action=`memory.index-write-failed`，**行 id 与条数进载荷**——
  只有一句 reason 等于没记，运维仍不知道去补哪些行）+ outbox 域事件；
  自身失败也只 warn（观测路径不能把生产路径带崩）。
- `persistChapterMemoryOutput` 的 catch 接通它；`ChapterMemoryRepositoryAccess` 等三条能力类型
  加该方法（tsc 随即指出另两条消费方——正是能力清单设计的用途）。
- **不改写入顺序、不阻断 commit**：瞬时 Qdrant 故障不该拦住作者创作；补救仍是 rebuild 补灌侧。

**回归锁（`chapter-memory-order.test.ts` 新增 2 例）**：① 方法行为双向（失败落审计 + outbox
且载荷带行 id 清单；空行集不写噪声）；② **接线锁**——swallow 站点必须真的调用
`recordMemoryIndexWriteFailure` 且不得抛出。接线锁是必需的：首版只有用例①，
反向摘除 catch 里的调用后**用例①照样全绿**（方法存在但没人调，正是本仓反复清理的
"谓词恒假的守卫"同族），补了源码级接线断言后才判红（本轮已实测双向）。
**探针脚本的一个副产品发现**：`recordMemoryIndexWriteFailure` 对不存在的 projectId 会因
`audit_records_project_id_fkey` 静默失败（被内部 catch 吞掉）——这正是该内部 catch 的设计目的，
但也意味着**调用方传错 projectId 时观测会静默失效**。首版探针即如此，已改用真实项目复验。

**本轮明确不做**：不跑 rebuild 补灌那 13 条（补灌会 upsert 全部 2165 条可见行、
触发全量 embedding 调用，属运行时操作而非代码修复，应由服务启动路径或作者显式触发）；
doctor 的欠灌提示已具名到行 id，定向补灌的条件已具备。

### 8.6 复核轮 round 7（2026-10-14）：八处"先写库后写索引"收口到一个包膜，站点级锁又抓出一处漏网

round 5 修的是 chapter-memory 一处；本轮按同一判据把**全部**索引写入点扫一遍，
发现缺陷面比一处大得多，且形态各自演进。

**扫出三处同族缺陷（五种互不相认的失败处理形态）**：

| 位置 | 原形态 | 后果 |
|---|---|---|
| `commit-service.ts` 事实索引同步 | 只 `console.warn` | 修订切换成功而事实没进索引 ⇒ 该章事实此后不出现在任何语义召回 |
| `character-enrichment/index.ts` 知识边界 | 只 `console.warn` | 角色知识边界漏进索引 ⇒ POV 过滤静默漏掉这一条，模型看不到该角色的知识边界 |
| `activities.ts` `approveFactClaims` | 只 `console.warn` | **最隐蔽**：裁决已生效（库里 authority=approved），但没有向量点 ⇒ 该事实从此不出现在任何召回里，而所有查询都显示它已被批准 |
| `activities.ts` foundation-memory ×2 | 只 `console.warn` | 规划事实只落库没进索引 ⇒ 后续章节的事实召回永久看不到这一条规划约束 |
| `activities.ts` `retrieveMemory` 的 foundation 补写 | 只 `console.warn` | 这一处是**站点级锁抓出来的漏网之鱼**（人工 grep 漏了它）：`ensureFoundationMemoryClaims` 是补偿性补写，补写成功而索引没写上 = 补偿没发生 |
| `mcp/handlers.ts` | 返回 `vectorSyncError` | 同步可见，**有意不覆盖**（调用方能立刻看到并重试） |
| `chapter-state-rebuild.ts` | 落 `projection_failures` | 八处里唯一做对的，但形状是手写的 |

**根因不是"忘了写 catch"，而是没有共享形状**：每个站点自己决定失败后怎么办，于是各自演进。
三处此前只 warn 的站点，与同一函数内另外两个失败点（narrative-elements /
narrative-state-snapshot）**不同形**——后者早已正确落 `projection_failures`。

**修复（最低共享层 = 一个包膜）**：`writeMemoryIndexWithTrace`
（`memory-index-drift.ts`）收口三件事：① 不抛（主路径继续）；② 落耐久账
（投影失败面，带 upsert 与重试计数）；③ **记账自身失败也不抛**——若没有这层内层 catch，
一次索引故障会升级成一次写入失败，把"降级静默"换成"连带崩溃"，比原缺陷更坏。
七处站点全部改走包膜；round 5 的一次性方法 `recordMemoryIndexWriteFailure` 随之撤掉
（同一职责两份实现必再分叉）。

**回归锁（`memory-index-write-trace.test.ts` 新增 3 例）**：① **站点级**扫描——
每个 `.upsertClaims(` / `.deleteClaims?.(` 调用前 600 字符内必须出现包膜调用；
② 包膜自身三件事齐全（两层 catch）；③ 不得有第二个同义实现。
**站点级而不是文件级是必需的**：首版按文件断言，反向把 `activities.ts` 三处里的一处
退回裸 try/catch 后**锁照样全绿**（文件里还有另两处包膜调用）。改为站点级后判红（已实测）。

**验证**：lint 干净；141 files / 1302 tests 全绿（新增 3 例 + 改造 2 例）。

### 8.7 复核轮 round 8（2026-10-14）：起手侧零覆盖——全书九族扫描找出"章尾同形"的另一半

前七轮都是工程师视角。本轮回到**读者视角**，并把 round 2 的做法推广：不再只精读样本章，
而是对全书 168 章做**九族机械测量**（`tmp/state-audit/measure-reader-scan.mts`，确定性、
零模型调用），先出分布再逐族判断值不值得动刀。

**九族扫描结论（全书口径）**：叙述者总结句式 **0 处**（该族早已治住，round 13 的诊断仍然有效）；
抽象名词后缀 0.29/千字、对白标签 0.17/千字、比喻 0.48/千字、无引号章 8%、末句短促章 23%、
段长 cv 均值 0.74——均无全书级病灶。**只有一族出现集中峰值**：首段以时间标记起头的章
占全书 31%，**41-60 章一段达 0.55（11/20）**。

**直读定位病灶（机械读数只是线索，定性靠读）**：41-43 连续三章的开头是同一个三槽模板——
「时间标记（第三日/卯时/卯时）+ 环境细节 + 视角人物已经在/才…」，三章互为改写。
对照 81-84 带：感官醒来 / 带物动作 / 时间标记后接意图 / 环境后接身姿，四章开头形态互不相同。
⇒ 读者读完 41、42 就能预测 43 的开头。这不是"章节常以时间开头"的中性习惯，是**起手模板**。

**为何这是缺陷而不是风格**：本书的"冰山式克制"是风格，风格的特征是**形状多样**；
模板的特征是**形状可预测**。同形 run 的判据照搬已校准的章尾判据（`ENDING_RITUAL_POLICY`
的窗口思想）：单章以时间起头完全合法（81 章"天没亮透，楚衡先醒了"正是真声音），
**连续 ≥3 章同一槽位序列**才是惯性。

**结构性缺口**：章尾收束仪式化（38/168）早有生成契约 + 审核面 + 实测校准，而**起手侧
此前零覆盖**——无契约、无审核项、无测量通道。同一 failure class 只治了一半。

**修复（与章尾完全同构，三面）**：
- 生成契约 `起手形态轮换契约`（`prompts/story-arc.ts`）：本批 ≥2/3 章的起手不落在该模板上；
  给出至少五种替换起手（正在进行的动作 / 一句对白或他人话语 / 物件状态变化 / 身体感受 /
  即将被打断的意图）；不得连续三章同一槽位序列；跨章可复用时间意象但首句句式必须变体；
  **明示"以时间起头合法的章不受此约束"**（防止下一个人把时间标记本身判成病）。
- 审核面 `起手形态分布检查`：判据同上，落在 planningRationale 声明的起手形态上（语义判断，
  不做句式黑名单）。
- 重基线不注入（历史章保真），与收束轮换一致。

**验证**：lint 干净；142 files / 1304 tests 全绿（新增 1 例，三面接线 + 反例）；
**反向实测**——摘除生成契约该行，三面接线用例判红（已跑）。
**刻意不覆盖**：不改已定稿章（不回溯原则）；不做结构性测量门（判据依赖"哪几个槽位"的
语义判断，做词表即违反 AGENTS.md 的 case-specific 禁令，且"有效起手"与"模板起手"的区分
属语义层——与 round 2 清点惯性的分层理由相同）。

### 8.8 复核轮 round 9（2026-10-14）：事实记忆层全书对账（洁净）+ 一次取证脚本的自我纠正

前八轮全是"机制是否活、账是否留痕、形态是否可预测"，**没有一次核对过事实记忆层
说了什么与正文实际写了什么是否一致**。本轮补这个方向，六项只读核验
（`tmp/state-audit/verify-*.mts`）：

**① 状态槽时效排序仍生效**（round 2 的修复是否还管用）：`持有` 槽（char_chu_heng）
可见 active 68 条，最后三条是 ch168/167/165——**最新的在前**。"模型被告知主角持有
160 章前材料"的缺陷确实已消除，且半年后依然成立。

**② 召回侧对退役行 100% 过滤**：抽样 40 条"active 但已被可见杀手退役"的行，
`filterIndexableMemoryRowIds` **全部拒绝**（accepted 0 / rejected 40）。
源码确认 qdrant-memory 的 search 与 graph 检索都走该函数 ⇒ 无正确性风险。

**③ 基线与召回可见集零差**：`baselineSize 2165 == recallVisibleSize 2165`，
`recallOnlyWouldBeJudgedStale 0 / baselineOnlyNotRecallable 0 / trueStale 0`
⇒ 不存在"写侧 upsert 的点被误判成陈旧点而反复增删"的震荡风险（该风险曾被论证为可能）。

**④ §3.6 主体键碎片化已解决**：`multiKeyCharacters: 0`——没有任何角色在注册表里
对应多个 subject_refs 键形态。round 2 的键等价阶梯 + pendingEnrichment 登记确实收住了。

**⑤ 静默账与伏笔注入通道存活**：168 章定稿全可读 ⇒ 账可得，435 条 open 伏笔算出
atRisk 89（silent 66 / neverMentioned 15 / running 346 / silentBands 7）；
端到端注入集 **81 条**（= atRisk ∩ cutoff 内候选）。与 round 2 修复时的 79 条同量级。
⇒ round 1 发现的"信号在运行库空转"没有复发。

**⑥ 承诺通道无条件注入的成本估算准确**：`activities.ts:459-460` 的注释称
"全库 open 承诺实测仅 15 条 / 约 1K token，不构成预算风险"。本轮复核该理由是否仍成立：
条数 15（一致）、实测 **1009 token**（对得上）、单条最大 82（statement 最长 57 字）、
占 98K 预算 **1.03%**。⇒ 无条件注入的裁决成立，无需改为按静默过滤。

**一次必须记录的自我纠正（本轮最重要的产出）**：第一版槽位诊断脚本用
`lifecycle_status='active' AND authority IN (...)` 数高基数槽，**漏了
retiredByVisibleKillerSql**，得出"持有槽 155 条 active / 可见仅 73"。
那是**取证脚本自身的缺陷**：active 但已退役的行不进基线、不进索引、不进召回
（②已证），把它们算进"模型会看到几条"即虚高。正确数字是 **68**；
project 级恒等式实测成立：`1987 naive = 155 retired + 1832 correct`，
错谓词**多算 155 行**。与 round 4"把 76 条欠灌算成误删"是同一族错误——
**用错谓词的取证脚本报出假数字**；区别是 round 4 的假红在验证脚本里（会被反向实测抓到），
本轮的假数字在诊断脚本里（**没有任何机制会发现**），若不纠正就会以"运行库实测"的
身份写进文档，成为后续所有判断的地基。

**修复**：把诊断脚本改为正确谓词，并补一道源码锁
`取证脚本查 active 行必须带退役谓词`（`prompt-execution-retention.test.ts`）：
凡查 memory_claims 且命中 active 谓词的语句，其 600 字符内必须出现杀手谓词
（`NOT EXISTS ... supersedes` 或共享 `retrievalVisibleClaimsSql`）。
**反向实测**：摘掉脚本里的杀手谓词，锁判红（已跑）。
锁的范围只覆盖 `tmp/state-audit/` 下的三个诊断脚本——**不覆盖新脚本**
（这个局限如实记录：锁按文件名枚举，新增诊断脚本时须同步登记，否则它就是漏网的）。
更彻底的做法是让锁扫描整个 `tmp/` 目录，但 tmp/ 里还有大量与本判据无关的脚本，
按目录扫会把"为什么锁这个文件"的理由摊薄成噪声，故选择显式枚举。
**验证**：lint 干净；142 files / 1305 tests 全绿（新增 1 例）；诊断脚本复跑数字与锁一致。

### 8.9 复核轮 round 9 下半（2026-10-14）：三处既有 FAIL 的根因——必要上下文随启用技能数无界增长

round 9 上半做事实记忆层全书对账（洁净 + 一次自我纠正）时，收尾跑全量测试发现 **3 个 FAIL
先于本轮改动存在**（`git stash` 后于 clean HEAD 6811035 复现确认）：`evaluation.test.ts` 的
skill-iteration / closed-loop 三例报 `StageContextBudgetError: 必要上下文需要 120653 tokens，
可用输入预算 108379`。

**定位路径（三层，每层都先证伪自己的假设）**：
1. 先假设"computeTokenBudget 的阶梯回退"——**证伪**：该函数现值正确（50 章以上钳到 98K），
   且 skill-iteration 路径从不走它（`maxInputTokens: 128_000` 写死在调用点）。
2. 再假设"skills 段落随启用技能数膨胀"——**部分证实**：`buildIterationPrompt` 确实把每个启用
   技能的完整 promptSections 全量塞进必要上下文；但首测只量 public 库（12 技能 / 27K），
   够不到 120K，一度误判为"假设不成立"。
3. 换测 **ymcp_test**（workspace clone 的真源）后定位：**633 个 enabled 技能**，其中 621 是
   跨套件污染（123 `test-craft-patch-skill-*` + 123 `../evil-skill-*` + 375 其他测试技能）。
   skills 段单独 **109,774 token**，加 schema 11,483 ⇒ 121,297，与报错 120,653 吻合；
   **隔离到 12 个真实技能后仅 27,897**，回落到预算内。

**根因（两层，都要修）**：近因是共享测试库被跨套件污染，fixture 成本随别人跑了什么而膨胀；
**远因是生产侧真缺陷**——`buildIterationPrompt` 的 skills 段无预算上限，成本随启用技能数
线性无界增长。生产库 12 个技能时 27K 正常，上一个量级同样顶穿。判据是
"必要上下文不得随启用技能数无界增长"。

**修复（段级预算）**：`buildIterationPrompt` 增 `maxSkillsSectionTokens`（默认 40_000）：
按**渲染后整块 token** 从大到小裁整条技能，段实测进预算（不是按各块之和——估算粒度不同，
首两版分别超 523/374 token，故末版收敛循环按整段实测退最小者）；大者优先（prompt 越长越可能
有可复用规则可提炼）；**至少留一条**（全裁空会让 iteration 无对象可迭代，比超预算更糟）。

**回归锁（`evaluation.test.ts` 新增 1 例，四向）**：少则全留且顺序不变；多则裁到显式封顶；
默认封顶同样生效；单条超大技能仍保留。**这个锁的三次自我纠错比锁本身更值得记**：
① 首版夹具整段仅 **204 token**，两个断言恒真；② 修正切片边界后 340 token 仍恒真——因为我把
`## Skill:` 当段起点，而每个技能头部也是 `\n## Skill:`，切片只切到第一个技能；③ 放大到 200 条后
"skill-0 必在"断言又错——封顶规则是**大者优先**，skill-0 不是最大的那个。
三条教训：**夹具必须大到让断言咬得住**、**段边界不能与段内元素同形**、
**断言要测规则而不是测我心目中的那个 id**。
**反向实测**：默认封顶改成 40M ⇒ 71,695 > 40,000 判红（已跑）；修复后三例 FAIL 全绿。

### 8.10 复核轮 round 10（2026-10-14）：skill 集合体检 + 撤回 round 2 的一处误判

目标明写"包括正文、相关事实记忆、skill 等"，但前九轮只深审过 prose-craft 一处。
本轮把 skill 作为一层单审，并对前几轮自己落地的契约做**反向可达性验证**。

**① 技能集合生产侧体检（`tmp/state-audit/verify-skill-set-coherence.mts`，全部洁净）**：
`skill_definitions` 47 行 / **12 enabled**（其余是 V1 遗留与历史晋升轨，未启用不注入）；
启用集与 workspace seed **12↔12 完全一致**（onlyInWorkspace/onlyInDatabase 均空）；
`contentDrift: []`（DB 模式真源与 seed 无漂移）；`unsourcedEnabled: [] / orphanedEnabled: []`
（skill-hygiene 两条判据在生产库实测通过）；`enabledConflictPairs: []`（无互指 conflicts）；
四类已确诊失败模式的措辞扫描 `antiPatternHits: []`。
（脚本一处自我纠正：首版把裸 SQL 行（snake_case）直接喂给 hygiene 函数，
它读 `skillId` 得不到值而返回 12 个 `null`，看着像"12 个无来源行"的假 alarming——字段名先对齐。）

**② fact-extraction 执行点的技能合成（`verify-fact-extraction-skill-composition.mts`）**：
`narrative-continuity`（value-slot 契约：novelty=update 显式声明覆盖）与 `fact-memory`
（provenance / 一次性描写不泛化）**两种实参形态下都在 bundle 里**，且
`hasValueSlotContract: true` ⇒ 事实层长程一致性的 prompt 侧指引确实到达模型，
不是只活在代码里。

**③ 本轮最重要的产出：撤回 round 2 的一处误判（`verify-contract-achievability.mts`）**。

前几轮的契约都只做过**反向**验证（撤销即判红），从未验证**可实现性**——契约若定在
本书任何章节都达不到的位置，比没有契约更坏（`commercial-benchmark-review` 的教训：
门槛无人能达到，等于逼人在 planningRationale 里撒谎）。用 §2 的四个连续合格带做正向样本：

| 族 | 全书均值 | 015-045 | 080-098 | **099-127（最强）** | 155-167 | 判定 |
|---|---|---|---|---|---|---|
| 道具盘点 | 2.16 | 4.71 | 1.27 | **0.95** | 0.25 | 契约可达 ✓ |
| 温度判定 | 0.78 | 1.09 | 0.68 | **0.34** | 0.12 | 契约可达 ✓ |
| 数数收尾 | 0.60 | 0.46 | 0.63 | **0.75** | 0.37 | **round 2 误判** ✗ |

**数数与章节强度正相关而非负相关**：四个合格带均值 **0.57** > 含不合格的混合带 **0.44**；
全书最强的 099-127 带 **0.75 为各带最高**；质量最差的 001-014 带仅 **0.05**。
直读最强带样本（`verify-counting-idiom-signal.mts`）确认数数常是章的核心意象与认知过程本身：
ch124《四十七步》「他数着自己的步子，又数着笔声的拍子，两套拍子叠在一起」——数数就是章名与
核心画面；ch110「把那三个字在心里重新说了一遍／第一遍：他可以答"不认得"」——数数是认知过程；
ch123「翻出一串数字，四十七…答案不是新路，答案是旧路／惊就惊在旧」——**数数即揭示本身**。

⇒ round 2 把"以数数收束一章"与清点惯性并列为同族病（原措辞"一处是留白，多处是模板"）
是**把有效声音误判成瑕疵**。本书的克制底色很大程度就建立在这种节律上；若不撤回，
规则会命令作者与审核面去"修"一个本该保留的特征。这与 AGENTS.md"禁止把个案固化成硬门"
同族，且是**自己这几轮引入的**那一类。

**修复（`skills/novel-v2/prose-craft.yaml` 1.5.0 → 1.6.0，写作/审核两面）**：
写作侧改判"数数不是同族惯性"并给出数据方向（不是只说"撤回了"）；审核侧改判
"不得仅因又出现数数而报"，只在同一章内反复以同一动作收尾且不带新信息时才报。
**回归锁**（`skill-runtime.test.ts` 新增 1 例）：写作侧须含"数数不是同族惯性"与
"与章节强度正相关"；审核侧须含"不得仅因"；反向两条——round 2 的频率判据措辞
（"一处是留白，多处是模板"）与"以数数收束一章而在近章已反复出现"不得回来。
**反向实测**：把写作侧改回 round 2 措辞 ⇒ 判红（已跑，双向）。

**本条最可复用的判据**：**自己上一轮引入的规则，下一轮要用同样的严苛度审它**。
前九轮的审计强度足以发现别人的缺陷，但对自己刚落地的契约会下意识地"确认它对"——
可达性验证（拿本书最强带当正向样本）是打破这个偏差的最低成本手段：它不问你
"规则是否合理"，只问"本书做得到吗、最强处是否正在做"。

### 8.11 复核轮 round 11/12（2026-10-14）：起手契约的 run 判据被批界切断——门对全书唯一的病灶失明

承接 §8.10 的判据（自己上一轮的契约要用同样严苛度审），本轮审 round 8 的**起手轮换契约**。
四步取证（`tmp/state-audit/verify-opening-*.mts`，均只读、零模型调用）：

**① 可达性（契约能达成吗）**：用 §2 的四个连续合格带做正向样本，strict 判据下
最强带 099-127 的模板命中率 **0.000**、病灶带 041-060 **0.35**，完全分离
⇒ 契约可达且判据有区分度。顺带确认判据不该放宽：宽松版（把单字"夜/晨"也算时间标记）
会把 ch99「夜里翻第一个身的时候，楚衡就觉出不对」误判成模板——那是**从动作切进去**的
合法起手；strict 版（时辰牌 + POV + 位置副词）不误伤它。契约措辞本身已写明
"跨章复用时间意象可以""轮换针对的是同形模板，不是时间标记本身"，故措辞无需改。

**② 配额判据的牙齿**：契约的份额条款（"≥2/3 章不落模板" ⇔ 批内命中率 ≤1/3）
按 6 章批次滚动，**28 批零违反**——连病灶带 41-60 都不违反。`hasTeeth: false`。
（另测 4/8/10/12/20 章批次：违反数分别为 2/1/1/0/1，零星且与批次对齐强相关，
说明份额判据本身对批界敏感。）

**③ run 判据的牙齿**：全书只有 **1 个** ≥3 连续命中，正是 **ch41-43**（病灶带）；
最强带 0 个。⇒ **契约的载荷全在 run 判据上**，份额条款是方向性引导而非可执行判据。

**④ 本轮真正的缺陷（用生产库真实批界验证，非推测对齐）**：
两条判据的措辞都带"**本批次**"限定，而生产批次是 **7 章一弧**——
实测批界：`弧6=35-42 / 弧7=43-49`。全书唯一的真实 run（ch41-43）恰好跨在这个边界上：
弧6 只拿到 41、42（连续 **2**，run 判据不触发），弧7 只拿到 43（连续 **1**）。
⇒ **门一直在，对全书唯一的病灶恰好失明。** 这是"谓词恒真的守卫"同族，
且是**我自己在 round 8 引入的**（当时只做了三面接线 + 反向撤销验证，没验过跨批适用性）。
（取证脚本首版按 `payload->'chapters'` 取批界，该键不存在 ⇒ `productionBatches: 0`，
而"跨批"结论是空数组比较的假结论；按真实键 `startChapterIndex` 重取后才成立。
与 round 4/9 同族：**用错取数的脚本报出假数字**，本轮的教训是"结论对了也要核对它是不是
从空数据里推出来的"。）

**修复（跨章判据必须由调用方喂入前章语境，照搬章末仪式化的既有形态）**：
- `manuscript-structure.ts` 增 `extractChapterOpening`（与 `extractChapterEnding` 完全对称，
  取段口径仍只有一个定义处）；
- `activities.ts` 增 `loadPriorChapterOpenings`（与 `loadNarrativeDormancy` 同形：
  失败/缺章返回 undefined、null 哨兵缓存、只取前两章首段）；
- `StoryArcPromptInput` 增 `priorChapterOpenings?: string[]`，渲染进 `arc-context-recent`
  段（它就是"已定稿章节的现场事实"，不新开段、不新增 fingerprint 键；缺省不注入）；
- 契约措辞改为跨批："**连续三章同槽位起头是跨批的**：本批首章要与上文给出的前章开头
  衔接看——若前两章已连用该模板，本批首章必须换形（判据是本批首章与前两章的衔接，
  不是只看本批内部）"；三个调用点全部接线。

**端到端实测**：cutoff=42 时 loader 取到的正是 ch41/ch42，且两句**确实是**模板开头
（`第三日的日头落下去时，楚衡已经在…` / `卯时的梆子敲过第三声，楚衡已经在…`），
两句都进到弧规划上下文（`containsBothOpenings: true`）⇒ 规划弧7 时规划器能看到
前两章已连用该模板，契约要求本批首章换形，run 被切断。

**回归锁**（`prompts.test.ts` 新增 1 例 + 改造 1 例）：① 措辞须含"连续三章同槽位起头是跨批的"，
且**不得**退回"同一批次内不得有连续三章"；② 传入 `priorChapterOpenings` 时内容真的出现在
上下文里，缺省/空数组时整行不出现。**反向实测**：改回 round 8 批次内措辞 ⇒ 判红（已跑）。

**同轮附带的对照发现（记录，不动手）**：sibling 的**收束契约**（2026-09-22）同样只有批内份额
条款（"≥1/3 章不落静收束" ⇔ 批内静收束 ≤2/3）。按生产批界实测：**24 批零违反**，
最大批占比 0.571 < 0.667，全书静收束占比 0.226 ⇒ **两条轮换契约的份额条款都不触发**。
这不构成缺陷（份额是**生成侧的方向性引导**，其价值在约束未来生成而非校验存量；且收紧阈值
等于"为通过已知样本调参"，AGENTS.md 明禁），但须记录清楚：**两条契约里真正可执行的部分
分别是起手侧的 run 判据（已修跨批）与收束侧的结构通道 `manuscript.ending-ritual`
（带 `priorEndings`，实测 20 章命中）**。后人不得把份额条款当门来"修"。

### 8.12 复核轮 round 13（2026-10-14）：按类别扫全部批级条款，找出第二处同族盲区

round 12 修的是**一个实例**（起手 run 判据）。本轮按 round 7 的做法**扫全部同类**：
枚举 story-arc 契约里所有批级限定条款（`grep 本批次章节窗口|每批至多|整批不得|同一批次内`），
共 5 处，逐一判断是否属"批界会切断"的类别：

| 条款 | 形态 | 是否同族 |
|---|---|---|
| 群像配额"≥1/3 章两人同场" | 批内份额 | 否（份额无 run 语义） |
| **群像"纯独处章每批至多一章"** | **批内计数（run 类）** | **是** |
| 篇幅"同一批次内各章目标不得全等" | 批内份额 | 否 |
| 篇幅"整批不得过半低于下限" | 批内份额 | 否 |
| 收束"≥1/3 章不落静收束" | 批内份额 | 否 |

⇒ 只有**独处章配额**与起手 run 判据同族（都是"批内计数限制"）。

**真库实测（生产批 7 章一弧，`verify-solo-quota-boundary-blindness.mts`）**：
全书 **60/168 章为纯独处**（35.7%，与 ai-taint F4 的"60 章 36%"**逐字吻合** ⇒ 口径一致）；
存在 **5 处**"上一批末章独处 ∧ 本批首章独处"——`7|8`、`49|50`、`98|99`、`119|120`、`140|141`
——批内"至多一章"判据**全看不见**。全书最长独处游程 5 章（ch97-101）。

**与本条相关的一个必须澄清的读数**：批内"至多一章"在 **16/24 批**被违反，看着像"契约失效"；
但分段趋势（`verify-solo-trend-by-band.mts`）表明相反：

| 带 | 01-20 | 21-40 | 41-60 | 61-80 | 81-100 | 101-120 | 121-140 | **141-168** |
|---|---|---|---|---|---|---|---|---|
| 纯独处占比 | 0.35 | 0.35 | 0.35 | 0.45 | **0.55** | 0.50 | 0.30 | **0.11** |

独处占比在 81-100 达峰 0.55，随后**降到 141-168 的 0.11（5× 改善）**⇒ 群像契约确实起了作用。
**"违反 16 批"与"契约有效"并存的原因是同一契约里两条不同档的条款**：宽松的"≥1/3 章两人同场"
（⇔ 独处 ≤2/3）容易满足，严格的"每批至多一章"（⇔ 独处 ≤1/7 ≈ 14%）只有末档真正达到。
**严格那条正是驱动改善的那条**，故它的批界盲区值得修（不是打磨一个不工作的门）。
另注：ai-taint F4 记 141-168 为"43% 无人类对手"，与本轮测得的"11% 纯独处章"**并不矛盾**
——前者量的是 `opposition` 是否指向人类意志（第二意志契约治的那一面），后者量的是蓝图
参与者数；该文档已明确二者是"解耦事实"，此处两份读数正好各自印证。

**修复（措辞层，边界不需要新管线）**：与起手那条不同，独处配额的跨批判据**所需数据规划器
已经收到**——群像信号段本就渲染近窗口的 `soloOnlyOrders` 与 `longestSoloRun`。故两处措辞改为：
契约段"**纯独处章至多一章，且这一限制跨批**：本批首章若也是纯独处，就与前一批末章连成两连
——群像信号段已列出近窗口的独处章序与最长连续独处游程，分配本批时先看那里"；
信号段"**纯独处章至多一章且跨批**（若上表最后一章已是独处，本批首章不得再是，否则成两连）"。

**回归锁**（`prompts.test.ts` 新增 1 例）：契约段须含"纯独处章至多一章，且这一限制跨批"
且不得含"纯独处章每批至多一章"；信号段须含"纯独处章至多一章且跨批"与可执行判据
"本批首章不得再是"，且同样不得退回批内措辞。**反向实测**：两处都退回批内 ⇒ 判红（已跑）。

**本轮可复用判据**：**修一个实例之后要按类别扫全部同类**（round 7 的判据在契约层同样成立）。
round 12 修了起手 run 判据就收工，会把同族的独处配额留在同一缺陷里；扫一遍只多花一次
枚举 + 一次真库测量，却把"这一类还有没有"从猜测变成清单。

### 8.13 复核轮 round 14（2026-10-14）：段改名而审核面指路没跟着改——一条检查被静默跳过

承接 round 12/13 的"批界"线索去查审核面是否与生成面同步（round 12 只改了生成侧措辞），
先把上下文到达路径走通，再对"审核面按段名指路"这一层做对账。

**① 上下文到达路径（先排除"审核面拿不到上下文"这个假设）**：
`activities.reviewStoryArcBundle` 里 `buildStoryArcReviewPrompt(input.bundle, "", rebaseTarget)`
的第二参是**空串**，看着像"上下文忘了传"。但同处第 2070 行 `buildStoryArcPlanningContextSections(planning)`
产出的 `contextSections` 与 prompt 一起交给 `compileSinglePrompt`，而该函数把
`input.prompt` 与 `input.contextSections` **都放进 `sections`** 由 `compileStageContext`
渲染进 instruction ⇒ **上下文确实到达审核模型**，`contextText` 只是个服务于"内联进正文"用法的
死参数（生产传空）。**这一条按"不是缺陷"记录**，但补了函数级文档说明现状——现场看起来像漏传，
若有人据此把 planning context 再传一遍，同一批段会渲染两次（浪费预算 + 模型看到重复信号）。

**② 真正的缺陷：审核面的段名指路与真实段标题失联**。
审核 prompt 多处用"以上下文『X』段为准（**无该段时跳过**）"指路段。把全部 `『X』` 段引用
与 `buildStoryArcPlanningContextSections` 实际产出的段标题逐一对账，发现：

| 引用 | 真实段标题 | 结果 |
|---|---|---|
| 人物登记表 | 人物登记表（POV 与参与者的权威名册） | ✓ 子串 |
| 未揭示作者秘密 | 未揭示作者秘密 | ✓ 精确 |
| 篇幅信号 | 跨章序列信号（…篇幅与对白密度信号） | △ 非连续子串，但关键词可检索到 |
| 正文对白密度 | 同上 | △ 同上 |
| **到期与老化伏笔账** | **窗口上界已过的伏笔账** | **✗ 任何段文本都搜不到该关键词** |

最后一条是**结构性失联**：该段在 2026-09-18 的 P1 修正时**刻意改了名**（措辞纪律要求
"不说超期/欠债"，见 `renderStoryArcDueLedger` 的头注释），但审核面的指路没跟着改。
配合"（无该段时跳过）"，审核员会去找一个**不存在**的段、然后**跳过整条到期账处置检查**
——而账其实就在上下文里。**"仪器说自己有、实际没有"同族，只是发生在自然语言指路这一层，
没有任何门会报。**

**修复**：三处引用改为可解析到真实标题——『到期与老化伏笔账』→『窗口上界已过的伏笔账』；
『篇幅信号』/『正文对白密度』→『跨章序列信号』段中的篇幅信号 / 对白密度信号（既保留信号
特指、又让段名可解析）。

**回归锁**（`prompts.test.ts` 新增 1 例）：抽出源码**代码本体**（剥注释——解释这段历史的
注释本身会引用旧名）里所有 `『X』` 段引用，逐个与真实段标题对账，必须能互相包含。
**反向实测**：把引用改回旧名 ⇒ 判红并指名"到期与老化伏笔账"（已跑）。

**本轮可复用判据**：**段改名是一次跨面变更，不是文案润色**。本仓已有多条"同一契约不留两处
口径"的不变量（如可见性谓词、指纹键），但**自然语言指路**这一层此前无人对账——
它的失效形态恰好是"静默跳过"，比报错更难发现。凡给审核/规划面写"以上下文『X』段为准"，
X 就必须是真实段标题；段改名时把引用一起改，并由锁保证。

### 8.14 复核轮 round 15（2026-10-14）：按类别扫"名字解析"这一层，补上 promptSections 错键的守卫

承接 round 14 的类别（**名字解析不到真实目标时静默失效**），本轮把它扫到技能侧，
并顺带把 round 14 的锁覆盖面查清。

**① 扫"『X』段"这一类是否只在 story-arc**：全仓 `grep 上下文[中里]?的?[『「]…[』」]`
只命中 `prompts/story-arc.ts`（4 处，round 14 已全部修好并加锁）。⇒ 该类无其他实例。
顺带确认 `buildStoryArcRevisionPrompt` 与 review 同状（`contextText` 生产传空串、
上下文由 `contextSections` 进 instruction），且它**不引用任何具名段**，故无段名失联风险——
补了对称的函数级文档，避免后人看到空串就"补传"（会把同一批段渲染两次）。

**② 技能侧的同类：`promptSections` 的键**。渲染口径是
`skillPromptSection = promptSections[executionPoint] ?? promptSections[coarse]`
（skill-runtime.ts:235-238），而 `normalizePromptSections` 把**所有**字符串键原样收下、
不校验键名。故一个既不是执行点、也不是 coarse 阶段的键（典型是拼写错）
**永远不会被任何执行点查到 ⇒ 那段指引静默丢失，且无人报**。
既有的"该执行点无 prompt 内容就抛"（`:343`）**盖不住它**：只要同技能另有一个 coarse 键
兜底，该执行点就有内容、不抛，错键就藏在后面。

**③ 真源体检结论（洁净）**：12 个启用技能的全部原始键逐一对照真实键空间
（17 个执行点 ∪ 6 个 coarse 阶段），**死键 0、未声明点的有效键 0**。
⇒ 生产技能没有这个问题，但**守卫缺失**是真的。

**④ 修复（分档：检出 + 常态面报告，不升级成停摆）**：新增 `invalidPromptSectionKeys`
（`protocol.ts` 诊断字段 + `skill-runtime.ts` 判定），判定**必须在归一化之前**读原始键
——`normalizePromptSections` 自己会为每个已声明执行点补 coarse 别名，拿归一化后的键判会把
别名误判成非法；**解析处刻意不抛**（与 `invalidExecutionPoints` 分档）：执行点无效 ⇒
技能挂不上任何阶段、是硬错；promptSections 错键 ⇒ 技能照常工作、只少一段指引。
分档不是猜测——首版按同族处置在解析处抛，**立刻打断三例与技能迭代无关的用例**
（共享测试库里 `test-craft-skill` 这个启用态遗留行用了不存在的中间名 `chapter.review`）；
在解析处抛等于让一个历史夹具行把内容缺陷升级成流水线停摆。故错键走**两个报告面**：
skills CLI 的 `check`（`invalid-prompt-section-keys` 状态，抛错）与 doctor 的 `skill-drift`
（常态健康门，具名列出、不参与 ok 判据）。

**⑤ 首跑即抓到真实实例（守卫有效的证据）**：共享测试库的 `test-craft-skill@1.0.0`
`promptSections` 用了 **`chapter.review`**——它**既不是执行点也不是 coarse 阶段**
（合法的是 `chapter.review.structure/character/prose` 与 coarse 的 `review`），
渲染口径永远查不到它，那段"审核规则"指引从未进过任何 prompt。
来源是 `craft-rule.test.ts` 的夹具（`:247`），且**每次跑都用 ON CONFLICT 写回共享库**，
故它不是一次性残留。已把夹具改用真实执行点 `chapter.review.prose`（含断言同步），
复跑后测试库 678 个启用技能**死键 0**。生产库（ymcp）12 个技能本就 0 死键。
（`migration-compatibility.test.ts` 也写 `chapter.review`，但带 `enabled=false`，
不进入启用集，属惰性 payload，不改。）

**⑥ 本轮的一处取证脚本自我纠正（同类错误第三次出现）**：诊断脚本首版用
`normalizeSkillDescriptor(row)` **之后**的键做分类，把归一化补出的 coarse 别名当成死键，
报出"11/12 个技能有死键"的假结论。与 round 4/9（错谓词）、round 12（空数据推结论）同族：
**用错对象的脚本报出假数字**。本版只取 DB 行的**原始** `prompt_sections` 键后才得真值。
⇒ 三次同族错误说明这不是偶发：**凡"某集合是否包含某名字"的判定，先确认拿到的名字来自
哪一层（原始输入 / 归一化产物 / 渲染产物）**。

**回归锁**（`skill-runtime.test.ts` 新增 1 例，四向）：① 命中面——coarse 兜底在场时错键
仍须被检出，且**解析照常成功**（不升级成停摆），并断言错键内容确实没进 prompt
（证明它是真死键而非"其实渲染了"）；② 反例一——合法键（执行点 + coarse）不得被误报；
③ 反例二——归一化补出的 coarse 别名不得被判非法（即"判定必须在归一化之前"）；
④ 反例三——生产技能真源体检零错键。**反向实测**：撤掉检出 ⇒ 判红（已跑）。

### 8.15 复核轮 round 16（2026-10-14）：role 是开放词表，只能靠临时扫源码回答——把词表变成契约

承接 round 14/15 的类别（**名字解析不到目标时静默失效**），本轮查 role 这一维，
结果**先撞上自己的取证错误**，而那个错误本身才是本轮真正的产出。

**① 首次取证得出错误结论（本会话第四次"枚举不全 ⇒ 假结论"）**：脚本扫 6 个源文件抽
`role: "..."` 字面量，得出 `character-reviewer` / `prose-reviewer` / `skill-iterator`
三个 role"声明了但无调用点会传"。**三个都是活的**，只是形态不同：
- 审校三面经 `prompts/chapter-review.ts` 的 `ReviewerRole` 联合类型 +
  `REVIEW_ROLE_EXECUTION_POINTS` 映射传入（`activities.ts:664` `reviewExecutionPoint(input.role)`）
  ⇒ **不以字面量出现**，脚本抽不到；
- `skill-iterator` 在 `evaluation/skill-iteration.ts:356` 传入 ⇒ 该文件不在脚本的扫描清单里。

⇒ 与 round 4/9（错谓词）、round 12（空数据推结论）、round 15（拿归一化产物当原始键）同族。
**四次的共同点不是"写错正则"，而是"回答一个全称问题（这个 role 有没有人用）却只看了部分证据"。**

**② 根因不是我的脚本，而是 role 没有权威词表**：role 此前是**开放字符串**——
调用点写字面量、审校面走联合类型、技能侧在 YAML 自行声明，**没有任何一处声明"合法 role 有哪些"**。
故"某个 role 是不是活的"只能靠临时扫源码回答，**扫漏就必然得出错结论**，
而这个错误对任何人都可复现（不是个人疏忽）。这正是 AGENTS.md 说的"应优先使用可复用契约、
数据建模、校验"而非临时脚本的场景。

**③ 修复（数据建模 + 校验，两侧闭合）**：
- `skill-runtime.ts` 新增 `SKILL_ROLES`（11 个 role 的权威词表）+ `SkillRole` 类型；
- `normalizeSkillDescriptor` 新增 `invalidRoles`（声明了词表外的 role ⇒ 该技能在那个
  (执行点, 角色) 组合下被 `skill.roles.includes(input.role)` **静默排除**；若那是它在该
  执行点的唯一绑定，指引永不抵达该阶段，而 `direct` 通常仍有别的技能命中、**不会抛错**）；
- 与 round 15 同处置：检出 + 两个常态报告面（skills CLI `check` 的 `invalid-roles`、
  doctor `skill-drift` 的 `invalidRoles`），**不在解析处抛**（不把内容缺陷升级成停摆）。

**④ 把枚举固化成锁（关键：让"再犯"不可能静默）**：`skill-runtime.test.ts` 新增
「role 词表闭合」一例，三条判据同时成立才算闭合——
① 技能声明的 role ⊆ 词表；② 生产调用点传的 role ⊆ 词表（**显式枚举三种形态**：
字面量、`ReviewerRole` 联合类型成员、`reviewExecutionPoint` 映射表键）；③ 词表 ⊆ 调用点实参
（每个词条都必须真有人传，否则是死词条）。
判据③是防再犯的核心：**将来新增调用点形态时它会判红**，逼作者把该形态纳入枚举。

**⑤ 反向实测（两例，且第一版脚本本身也错了）**：
- 反例 A（**复现本轮自己的错**）：从调用点清单里删掉 `skill-iteration.ts` ⇒ 判红
  `词表里有调用点从不使用的 role（死词条）: expected [ 'skill-iterator' ]`。
  ⇒ **锁能抓住"枚举不全"这个失败模式本身**，这是对判据③设计的最强验证。
- 反例 B：给 `prose-craft.yaml` 的 roles 加拼错的 `prose-reviewr` ⇒ 判红
  `技能声明了词表外的 role（该角色下会被静默排除）: expected [ 'prose-reviewr' ]`。
- **反向脚本首版给出假阴性**：两例都报"通过（未判红）"。原因是脚本按 `\n` 做替换，
  而这两个文件是 **CRLF**，替换根本没发生（测试从未被触发）；反例 B 还把 role 插到了
  `executionPoints` 段而非 `roles` 段。改用 edit 工具（按读到的原文替换）后两例都正确判红。
  ⇒ 与本轮①同族的第二类：**"验证没判红"要先确认验证真的跑到了，再当作结论**。

**⑥ 词表两侧对账结果（洁净）**：11 个 role 全部既有技能声明、又有调用点会传；
技能声明的 role 无一在词表外；调用点传的 role 无一在词表外。⇒ 生产无缺陷，**守卫与锁是补的**。

### 8.16 复核轮 round 17（2026-10-14）：同一判据两处相反兜底——题材匹配在生产路径是硬门

承接 round 16 的判据（开放词表 ⇒ 只能临时扫源码 ⇒ 扫漏即假结论），本轮把技能描述符里
剩下的字段扫完，在 `applicableGenres` 上找到一处**真缺陷**。

**① 先排除两个"看着像缺陷、实则不是"的**（避免把设计当缺陷改）：
- `capabilities`：它**不是**封闭词表——`resolveStageSkillBundle` 把
  `input.requestedCapabilities` 并入要求集，故调用方可以请求自定义标签，技能声明自定义
  capability 是**有意的扩展点**。生产里 `narrative-continuity` 声明了词表外的 `continuity`，
  但它从未被任何调用点请求过（全仓 grep 无命中）⇒ 是**惰性元数据**，无害。
  （顺带核到：12/12 个技能都显式声明了 `priority`，故 `priorityOf` 的能力兜底在生产上
  **从不触发**，"拼错 capability 导致优先级静默降级"这条路径实际不成立。）
- `requiredMemoryKinds`：类型是封闭联合 `MemoryKind`（5 个）而归一化处是**纯 cast 零校验**，
  拼错会让记忆门永不触发（required 技能会抛，normal/optional 则静默放行）。但生产
  **12 个技能一个都没声明**该字段 ⇒ 门整条未被使用，属**预防性**缺口，记录不动手。

**② 真缺陷：同一判据在两处实现成相反兜底**。`applicableGenres` 的匹配在两个解析路径里
都出现，但对"**调用方没传 genre**"的兜底方向相反：

| 路径 | 代码 | 未传 genre 时 |
|---|---|---|
| `cognition.resolveSkillBundle`（计划路径） | `input.genre ? includes(genre) : **true**` | **保留**；且全被过滤时 `genreMatched.length ? genreMatched : selected` **回退到全集** |
| `skillRuntime.resolveStageSkillBundle`（**生产路径**） | `input.genre ? includes(genre) : **false**` | **排除**；全被过滤即 `throw "没有可用于 X 的 Skill"` |

而 cognition 的 Phase 3.3 注释**已经写明契约**："genre 匹配是**软偏好**：若无匹配 genre 的
skill，仍回退到题材无关的 skill"。⇒ 生产路径把它实现成了**硬门**，与该契约相反。
后果不是理论问题：学习闭环**能**把题材相关规则晋升为 skill（`promotion-service` 持久化
`applicable_genres`，learning 提示词还明确要求模型"若改进只适用于特定题材，填写题材标签数组"），
而章节级阶段从不传 genre ⇒ **晋升出来的题材规则永不生效**。

**③ 取证口径的一处自我纠正（本会话第六次"枚举不全 ⇒ 假结论"）**：首版用**按行** grep 抽
调用点，报"11 个调用点一个都不传 genre"。改为**按配对括号**切完整实参后实测：
**21 个调用点，2 个传 genre**（`activities.ts:612`、`:2232`，都是 foundation 路径），
**19 个不传**——章节级阶段（drafting/review/revision/fact-extraction/character-enrichment/
arc.plan/chapter.blueprint/arc.review/arc.revision/chapter.title）全不传。
结论方向没变（生产基本不传），但数字全错。⇒ 与 round 16 同族：**按行匹配多行实参必然漏**。

**④ 修复（两处，均在最低共享层）**：
- `skill-runtime.ts`：把题材匹配改回**软偏好**——未知题材不排除（"不知道"≠"不匹配"），
  全被题材过滤掉时回退到未过滤集（不再抛错）。与 cognition 同一契约。
- `activities.ts`：新增 `loadProjectGenre`（按既有 loader 同形缓存，null 为"无题材"哨兵），
  `resolveCurrentSkills` 在调用方未显式传 genre 时回落到**项目题材**
  （生产项目实测 `metadata.genre = "仙侠/科幻"`）。**一处修复覆盖全部 19 个调用点**，
  而不是逐个补参。

**⑤ 今日影响为零、机制由死转活**：生产 12 个技能**无一**声明 `applicableGenres`，
故两处改动当前都是 no-op；改的是"晋升出题材规则后能否生效"这条路径。
这与 round 15/16 同类：**修的是被静默堵死的通路，不是当下的错值**。

**回归锁**（`skill-runtime.test.ts` 新增 1 例，四向）：① 未知题材 ⇒ 保留；
② 题材命中 ⇒ 保留；③ 题材不匹配且存在题材无关替代 ⇒ 排除特化技能（**防过度纠正**：
软偏好不等于永不过滤）；④ 全被题材过滤掉 ⇒ 回退而非抛错。
**反向实测**：把兜底改回 `: false` + 去掉回退 ⇒ 判红（已跑）。

### 8.17 复核轮 round 18（2026-10-14）：预算挤掉的段只记不报——上下文可静默变薄

前几轮查的是"名字解析不到目标"，本轮换一个面：**装配期被丢弃的内容**。

**① 机制**（`stage-context.ts`）：段按优先级排序装配；`critical`/`required` 装不下 ⇒
**抛 `StageContextBudgetError`**（响亮）；`normal`/`soft` 装不下 ⇒
`receipt(section, "excluded", "budget")`，**静默丢弃**，只把条数记进 manifest 的
`budgetExcludedSectionCount`。

**② 缺陷：这个计数没有任何生产读取方**。全仓 grep `budgetExcludedSectionCount` 只有 4 处——
类型声明（`protocol.ts:359`）、计算处（`stage-context.ts:155`）、两处测试断言。
**没有 doctor 检查、没有日志、没有指标。** ⇒ 上下文静默变薄、无人知。
危害不是"少一段背景"：审核面多处按"以上下文『X』段为准（**无该段时跳过**）"引用
**normal 优先级**的段（跨章序列信号、开放线索、机制反馈等），被挤掉后那些检查会
**静默失效**——报告上看起来"检查通过"，实际是"没检查"。

**③ 修复（日志侧，刻意不动 manifest）**：在丢弃点报出被挤掉的段 id 与优先级、可用/已装 tokens。
**为什么不能加成 manifest 字段**：`manifestBase` 参与 fingerprint，而 fingerprint 会与
`contextRefs` 一起哈希进**外部任务的幂等键**（见 `estimatedInputTokensAuditBasis` 的既有注释）
——给纯观测值加字段等于给在途运行换任务 id。故观测走日志，零指纹影响。

**④ 诚实的量级实测（避免把小风险说成大风险）**：生产 33 个外部任务的
`budgetExcludedSectionCount` **全为 0**；章节起草阶段实测技能段仅 **928 tokens**
（4 个技能各一段，prose-craft 占 720），而可用预算约 **106,517**（128,000 − 10,000 输出预留
− 11,483 schema 参照）⇒ 技能段占 **0.9%**，要涨到约 **115×** 才会吃满。
⇒ **本轮补的是被静默堵死的通路，不是当下的错值**；风险是"学习闭环持续晋升技能后
上下文开始悄悄掉段"，当前距离很远。如实记录，不夸大。

**⑤ 本会话第七次"枚举/口径不全 ⇒ 假结论"**：本轮自查脚本首版报"4 个技能全部
'解析到了但没渲染'"，看似又一个静默丢失。实际是我只拼了 `section.text` 去找 skillId，
而 `buildSkillContextSections` 把 id 放在**段标题**里（`id: skill:<id>@<version>`）。
逐段打印后 4 段齐全、合计 928 tokens。⇒ 同一族：**先确认"我量的东西是不是我以为的那个"。**
（顺带纠正一个跨轮口径混淆：round 10 的"12 技能 27,897 tokens"是**全执行点全技能各段之和**，
不是单个阶段 bundle 的占用；本轮的 928 才是预算口径。）

**回归锁**（`stage-context.test.ts` 扩既有用例）：被挤掉的段必须报出且含段 id 与"预算挤掉"字样；
**反例**：全部装得下时不得报警（否则日志被噪声淹没＝等于没报）。
**反向实测**：去掉告警 ⇒ 判红（已跑）。

### 8.18 复核轮 round 19（2026-10-14）：面部表情是弱章的独立标记——排除混杂后才写指引

前四轮都在装配/接线层，本轮回到**读者轴**，测 round 10 未覆盖的族：微动作与生理反应。

**① 筛查六族（`tmp/state-audit/measure-gesture-idioms.mts`）**：用 round 10 确立的
"合格带 vs 混合带"判据（不引入新评分）逐族算密度比。三族看着有信号
（面部微表情 2.83×、呼吸 4.52×、心中一X 2.59×），但**必须看基数**：

| 族 | 全书原始计数 | 合格带 | 混合带 | 比值 | 判断 |
|---|---|---|---|---|---|
| **面部微表情** | **115** | 0.21 | **0.58** | **2.83** | **真信号（基数足够）** |
| 呼吸 | 25 | 0.04 | 0.20 | 4.52 | 基数太小（26 处），噪声 |
| 心中一X | 7 | 0.01 | 0.03 | 2.59 | 基数 7，纯噪声 |
| 停顿沉默 | 104 | 0.26 | 0.23 | 0.90 | 无信号 |
| 手指动作 | 594 | 1.45 | 1.52 | 1.05 | 无信号 |
| 喉结吞咽 | 73 | 0.24 | 0.11 | 0.46 | 方向相反 |

⇒ 只有**面部微表情**（嘴角/眉头/眉心/眼神/眼底/眼皮）值得继续。

**② 分带与直读**：001-014（含 5 章不合格）**0.80**/千字 → 015-045 0.44 → 041-060 0.43
→ 080-098 0.15 → 155-167 0.08 → **099-127（全书最强）0.05**；全书均值 0.27。
直读峰值章确认形态是**小句级**的"表情 + 一句解释它的含义"：
ch13「眼神里浮起一丝惊惶」、ch21「眯了眯眼，目光在他脸上刮了一遍。**那眼神里没有同情，
只有权衡**」——每个情绪节拍都由一个表情标签承担，并紧跟一句说明它意味着什么。

**③ 排除混杂（本轮的关键一步）**：round 13 实测独处章占比在中期带达 0.55，
而**独处章没有第二张脸可写** ⇒ "晚期强章面部描写少"可能只是独处占比的镜像。
用真库蓝图参与者数分层重算（`verify-gesture-confounded-by-solo.mts`）：

| 层 | 章数 | 合格带 | 混合带 | 比值 |
|---|---|---|---|---|
| 全部章 | 168 | 0.21 | 0.58 | 2.83 |
| **非独处章（有≥2 参与者的场景）** | 108 | **0.27** | **0.77** | **2.82** |
| 纯独处章 | 60 | 0.10 | 0.29 | 2.93 |

**差距在非独处层内不消失**（2.82×），且最强带的非独处章仅 0.04/千字 ⇒ 该族是
**独立于独处占比的弱章标记**，不是代理。这是本轮敢写指引的前提。

**④ 与既有指引的分工（避免重复）**：prose-craft 已有"叙述者不替读者论证……不追加
**解释性段落**替读者说明动机或意义"——那条治**段落级**；本轮实测的形态是**小句级**
（表情标签 + 半句释义），既有条款的"段落"口径**盖不住**它。故按同一"默认承载物"家族
补一条，而不是新立一类。

**⑤ 落地的指引（`skills/novel-v2/prose-craft.yaml` 1.6.0 → 1.7.0，三面同步）**：
写作侧给**可执行判据**——"先问这段情绪能否由动作、选择、对白内容或后果承担；能则由后者
承担，表情只保留它承载了动作与对白承载不了的信息的那一次"，判据是"**这次表情是否不可替代**"，
并明确"**表情本身完全合法**"（不做词表禁用）；审核侧列入必查项且要求"说明它挤掉了什么"；
修订侧给修法"不是删表情，而是保留动作、删掉那半句解释，或改成本章真正缺的那次交锋里的
一句对白；只有当表情本身承载了不可替代的信息（人物刻意掩饰、表情是唯一裂缝）时才保留"。
实测数据写进写作侧（与 round 2/10 同例），供后续复核。

**回归锁**（`skill-runtime.test.ts` 新增 1 例）：三面都须含"面部表情"；写作侧须含
可执行判据"这次表情是否不可替代"与反例句"表情本身完全合法"；审核侧须含
"面部表情本身合法"。**反向实测**：撤掉写作侧该段 ⇒ 判红（已跑）。

**⑥ 附带的实证**：本轮跑测试时 round 18 新加的预算告警**真的报了**
（`[context] drafting/writing.draft 有 1 段被预算挤掉：skill:optional@1.0.0(soft)；可用 70 tokens，已装 32`）
⇒ 上一轮的观测面在实际装配路径上确实可达，不是死代码。

### 8.19 复核轮 round 20（2026-10-14）：分解层也受"基数纪律"约束——强比值几乎都是小样本

round 19 建立了族级筛选的五步法（比值 → 核基数 → 排混杂 → 可达性 → 指引）。
本轮把该法**用到自己的分解步骤上**，结果推翻了自己刚写的一批"醒目结论"。

**① 先复核 round 19 的机制描述（可能只对了一半）**：round 19 说该族的形态是
"表情 + 一句说明它意味着什么"。逐条读嘴角样本发现**不完全**——眼皮的用法大量是
"眼皮耷拉着""眼皮一压"这类**单一个标记草草收尾**，没有后续释义。（机制分类脚本本身
是坏的：窗口错位导致 0 归类，已废弃；改为直接读样本。）⇒ 形态应覆盖两种。

**② 分解层的强比值几乎全是小样本噪声**：子族分解初看有多个比族整体更强的信号
（嘴角 6.99、眼角 5.29、眼底 8.66）。核基数后（`verify-face-subfamily-bases.mts`）：

| 子族 | 全书原始 | 合格 | 混合 | 比值 | 判定 |
|---|---|---|---|---|---|
| 眼皮 | **57** | 22 | 26 | 3.25 | ✓ 承载结论 |
| 眼神 | **34** | 19 | 12 | 1.72 | ✓ 承载结论（弱于族） |
| 面部族全体 | **115** | 48 | 51 | 2.83 | ✓ 族级结论 |
| 嘴角 | 12 | 3 | 8 | 6.99 | ✗ 噪声 |
| 眼角 | 10 | 2 | 4 | 5.29 | ✗ 噪声 |
| 眉头_眉心 | 10 | 4 | 4 | 2.23 | ✗ 噪声 |
| 眼底 | 2 | 0 | 1 | 8.66 | ✗ 噪声 |
| **眉眼** | **0** | 0 | 0 | — | ✗ **全书零出现** |

⇒ **round 19 的族级结论因此被加强而非削弱**：移除零出现词"眉眼"后族比值 2.83 → **2.93**；
而唯一两个够基数的成分中，眼皮 3.25 比族整体还强。**族级信号不是某一个稀有词撑起来的。**

**③ 修正一处自己的死词**：`measure-gesture-idioms.mts` 的面部族原含"眉眼"，
实测全书零出现——它会让分解表多一个恒零项、并使"留一"检验里出现一次空操作。
已移除并复测确认族结论不变。

**④ 顺带筛了一个新族：比喻密度（`measure-simile-density-by-band.mts`）**：
严格比较词（好像/仿佛/如同/恰似/宛如/好似/像是/跟…一样）密度 合格带 **0.58**/千字 vs
混合带 **1.34**（比值 **2.30**，原始计数 **290** ⇒ 基数充足）；宽口径（含裸"像"）1.14
（裸"像"大量用于非比喻，稀释信号）；**段内比较词峰值 ≥3 的章占比** 4.3% vs **14.7%**
（比值 **3.42**）——即"堆叠"这一**稀疏结构事件**的质量关联比平均密度更强，
与 round 12 的 run 判据同构（全书仅 1 处却完美诊断）。
**混杂排除**（`verify-simile-confounded-by-dialogue.mts`）：剔除引号内对白后
0.610 vs 1.409 ⇒ 比值 **2.31**，与未控制时 2.30 几乎不变；且两带引号字占比均为 ~3%，
"弱章对白更少"这个假设在本口径下**不成立**。⇒ 独立信号。
**结论**：prose-craft 现有的"同章同义比喻堆叠"规则**对准了真机制**（堆叠形 3.42×），
**不需要新指引**；但平均密度 2.30× 说明既有规则只管住了堆叠那一半。
按 AGENTS.md"不设固定阈值"的纪律，**不**为此加量化门。

**⑤ 落地的修正（prose-craft.yaml 1.7.0 → 1.8.0）**：把 round 19 指引的形态描述
补上"或由**单一个表情标记草草收尾**"，并把可执行判据加强一句"至少问一句：删掉这个表情，
读者是会失去一个可观察的线索，还是只失去一个标签"；实测依据段补入"**分解时必须与基数
一起看**"与眼皮/眼神 vs 嘴角/眼角/眼底的对照。**回归锁同步加强**（多断言一个形态覆盖项）。
**反向实测**：撤掉新增形态覆盖 ⇒ 判红（已跑）。

**本轮可复用判据**：**"比值必须与基数一起看"这条纪律要一路用到分解层**。
族级筛选用它否掉了噪音（round 19 的呼吸/心中一X），但分解时最容易忘——
因为分解天然产生更多、更醒目的比值，而每个比值背后的计数更小。
判据的落地形态：**任何汇报比值的表格都必须带一列原始计数**，否则读者（包括自己）
会把小样本抖动当成机制。

### 8.20 复核轮 round 21（2026-10-14）：事实记忆的 supersedes 链完整性——删 claim 不清引用

前四轮都在技能/读者轴，本轮回到**事实记忆层**，验一个此前没验过的结构性质：
`memory_claims.supersedes` 链的完整性。

**① 取证脚本首版又栽在"没确认类型"上（本会话第 N 次同族）**：按标量 `text` 读
`supersedes`，得出"**2126 行全部悬空**"的惊悚结论。真型是 **`text[]`**：pg 驱动把空数组
返回成 `[]`，而 `[]` 作为对象**是 truthy** ⇒ `if (!row.supersedes) continue` 全不跳过；
`byId.has(数组)` 恒 false ⇒ "全部悬空"。实测只有 **62 行**真有 supersedes，
且每行可覆盖**多个** id。修正后真实数字是 **34 个 killer、94 条悬空引用**。
（`psql` 里 `jsonb_typeof(supersedes)` 报 "function does not exist" 就是第一次提示列不是标量。）

**② 三个"问题"里两个是我判据的假前提**（差点又报错）：
- `lifecycle_status='retired'` **全库 0 行**，且**没有任何代码路径写它**（grep 无结果）。
  退役**只**由可见性谓词表达：`retiredByVisibleKillerSql` = "存在一个可见的 killer，
  其 supersedes 数组含我"。故我设的"③ retired 无 killer"与"④ active 却被覆盖"中，
  ④ **是设计机制本身**——被覆盖的行保持 `active`、但在检索中不可见。实测 211 处，
  正是该机制在发挥作用（`155 + 1832 = 1987` 的算术闭环验证了这一点）。
- 真正成立的只有 **① 悬空引用**。

**③ 根因在代码，不在数据**：`postgres-repository.ts` 的 `deleteStoryArc` 里有**两处**
`DELETE FROM memory_claims`（`:3925` 按"来源全非 active"删、`:3941` 删 rollup），
两处都**只删行、不清引用**——别的行 `supersedes` 里指向该行的死引用永久留存，且数组只增不减。
悬空引用**不影响检索正确性**（`alias.id = ANY(killer.supersedes)` 匹配不到任何行），
但任何走 supersedes 链的核查/统计都会看到幽灵目标（我的取证脚本首版的假惊悚结论，
根源正是这些幽灵 + 我的类型错误）。

**④ 修复（最低共享层）**：在同一事务内、两处删除之后加一次统一清理
（`UPDATE memory_claims survivor SET supersedes = (… WHERE entry <> ALL($2::text[]))`，
条件是 `supersedes && $2::text[]` 的存活行）。**放在事务内**是关键——删除与清理必须原子，
否则事务回滚会把"删了行、引用已清"的不一致固化。

**⑤ 存量数据已修复**：`tmp/state-audit/heal-dangling-supersedes.mts` 按与修复处
**完全相同**的 SQL 口径执行 dry-run（94 条悬空 / 75 个死目标 / 34 行）后 apply：
**34 行清理完毕，悬空引用归零**；仍存的 353 条 supersedes 引用**全部指向存在的行**；
总行数 2126 不变（只改数组、不删行），可见 claim 数 1832 与修复前一致
（1987 − 155，与该谓词的设计闭环吻合）⇒ **清理未改变任何一行的可见性**。

**回归锁**（`memory-visibility.test.ts` 新增 2 例）：① **接线锁**——清理语句必须存在、
必须用"排除被删 id 后重聚合"的口径、必须出现在删除语句**之后**（即同事务内）；
② **SQL 语义锁**（真实库）——删掉 doomed 后 killer 的 supersedes 里该死引用被摘、
活引用保留，且被删行确实不在了。**反向实测**：删掉整个清理块 ⇒ 判红（已跑）。

**本轮可复用判据**：**划定"删除边界"时必须同时划定"引用边界"**。系统里用
`id = ANY(array)` 做关联时，删"被指向方"就要同步删"指向方"数组里的元素——
这类悬空不会报错、不影响主路径，只会让一切走该链的核查失真。
另外两条附带判据：**"该列是不是我想的型"要用一次真实查询确认**
（`jsonb_typeof` 不存在的报错就是第一次提示）；**判定前先确认那个状态量是否真被写过**
（`retired` 0 行 ⇒ 我关于它的两条判据根本不成立）。











- 读者视角附记（本轮精读 049/051/056/059/062/064/067 等章）：主线文字质量为"冰山式克制"，问题不在句子而在**重复的可感知结构**——主角反复以同一套动作清点随身物件（废石/玉牌/丹/碎角/左膝/回执/草图，各配一次"凉"）、以指节敲纸排列日期、以"数呼吸/数天色"收尾。机械测量（`tmp/state-audit/measure-narrative-idioms.mts`，确定性、零模型调用）：道具盘点词族全书 862 处 / 每千字 2.16，最高 032 章 15.56/千字；"凉"族 317 处 / 每千字 0.78，最高 062 章 7.18/千字；数数收尾族 221 处 / 每千字 0.60。**分段均值揭示两族峰值都落在商业基准确诊的"死亡象限"内**：道具盘点族 21-40 章 5.30/千字（全书 6.6× 的 2.16）、41-60 章 4.79、61-80 章 3.81；温度族 61-80 章 1.52/千字（全书近 2× 的 0.78）。⇒ 与 §7 第 5 项的对白崩落**同源**：对手戏缺席，章节以物件清点与内省填充。该形态**不是单章缺陷而是跨章惯性**，属生成面指引问题而非事实记忆问题；已定稿章不回溯，故不动正文。
- **本轮落地的生成面指引**（`skills/novel-v2/prose-craft.yaml` 1.4.0 → 1.5.0，三面同步）：写作侧要求"本章这次清点必须与以往任何一次不同——带来新信息（某件位置/状态真的变了）、新选择（据此决定下一步）或新代价（清点本身有风险），三者都不成立时改为写清点之后的那一个动作"，并把"以数数收束一章"并列为同类惯性（一处是留白，多处是模板）；审核侧列为必查项，且**要求报告指明它挤掉了什么**（本章缺的那次交锋、那次变化），把动刀理由钉在"该有的现场没发生"而非"这个动作出现太多次"；修订侧给出修法"不是删清单，而是给这次清点安上它缺失的功能"。判据用通用叙事模式描述（随身物件清点 + 同类温度/质感判定 + 数数收尾），不含任何本书专有物件名，跨题材复用。测试：`skill-runtime.test.ts` 新增一例，三面接线 + 写作侧三条件 + 审核侧"挤掉了什么"均在场；反向摘除写作侧该段即判红（本轮已实测）。

### 8.21 复核轮 round 22（2026-10-14）：按"删除边界=引用边界"扫全库——数组引用列的第三次悬空

round 21 修了 `memory_claims.supersedes`。本轮按同原则**扫全库**（112 处 DELETE 与
全部数组列交叉），把这类"删被指向方不清指向方"的形态一次扫清。

**① 扫出的候选与结论**（`tmp/state-audit/scan-array-reference-columns.mts`、`verify-other-array-refs.mts`）：

| 数组列 | 指向 | 悬空数 | 结论 |
|---|---|---|---|
| `memory_claims.supersedes` | memory_claims | **94 → 0**（round 21 已修） | ✅ |
| `memory_claims.source_revision_ids` | manuscript_revisions | 0 | ✅ 早已维护（`memory-visibility.ts:84` 投影里 COALESCE 重算） |
| **`memory_bundles.payload.sourceRevisionIds`** | — | **454 行含 `null`** | ❌ **本轮真缺陷** |
| `context_manifests.source_revision_ids` | manuscript_revisions | 222 行含 `null` + 1183 条已删 rev | ❌ 传播下游 + 档案语义 |
| `chapter_planning_contexts.source_artifact_ids` | artifacts | 0 | ✅ |
| `creative_work_items.artifact_refs` | artifacts | 0 | ✅ |

**② 真缺陷：`[null]` 被写进 claim 的 sourceRevisionIds**。逐层溯源
（`trace-null-revision-ids.mts`、`find-null-claims.mts`）：
- `memory_claims.source_revision_ids`：**0 行含 null**（干净）
- `memory_bundles.payload.sourceRevisionIds`：454 行含 null ⇒ **null 的出生地**
- `context_manifests`：222 行 ⇒ 传播下游
- 再往里挖：受影响 bundle 的 claims 里 `sourceRevisionIds == null` 的正是
  **`foreshadowing:<project>:<hash>`（kind=working, matchedFacet=foreshadowing）**这一族
- 根因：`activities.ts` 的开放伏笔注入写 `sourceRevisionIds: [f.plantedRevisionId]`，
  而 `foreshadowing.planted_revision_id` **可为空**（生产实测 717 条里 **41 条为空**）
  ⇒ 数组里出现 `null`。

**③ 后果分级**：null 元素让 `= ANY(array)` 永远匹配不到该元素、`unnest` 出的 null 让
**悬空统计虚高**（本轮自己的取证脚本就被它误导：一度把 222 条 NULL 当成"空串"报错）。
另需与档案语义分开：`context_manifests` 里那 **1183 条 uuid 形态**悬空指向"装配时用过、
其后被删"的 revision，是**档案语义、不该清**（该列无生产读者，只有 INSERT）。

**④ 修复（最低共享层 + 存量已清）**：
- 新增 `sourceRevisionIdsOf(...ids)`（`memory-visibility.ts`，与 claim 来源真址同层）：
  滤掉 null/undefined/空串、去重、**全空时返回 `[]` 而不是 `[null]`**；
- 五个组装点全部改用它（activities 的伏笔/承诺/替换 revision、postgres-repository 的
  快照/POV/章记忆三处）。
- 存量：`heal-null-revision-ids.mts` dry-run 后 apply ⇒ memory_bundles **454 行**、
  context_manifests **403 行**修净，残留 null **0**；合法 id 全部保留
  （bundle 48,743 个、manifest 29,326 个 id 元素一个没少）⇒ **只删 null，未动合法值**。

**⑤ 回归锁 2 例（含一个"锁必须能咬人"的自检）**：
- helper 单测：全空 ⇒ `[]`（不是 `[null]`/`[""]`）、合法 id 保留去重、混合输入顺序保持；
- 接线锁：两文件都不得残留 `[x.…RevisionId]` 直写、且必须真的用了 helper。
  **首版正则有洞**：只写 `\w+\.revisionId`，于是 `[f.plantedRevisionId]`、
  `[p.sourceRevisionId]` **漏网**——反向复跑显示"未判红"，才发现锁根本不咬人。
  改为 `[\w.]+[Rr]evisionId` 并**在测试里对三种历史形态做自检**
  （`DIRECT_WRITE.test(...)` 必须为 true），否则等于没锁。

**本轮可复用判据**：**"比值/结论"类的正则与判据，必须先证明它能抓住已知的反例再上线**。
锁的失效形态不是"写错"，而是"**看起来覆盖了、实际有条形洞**"——本次若无反向复跑，
一个从不判红的锁会被当成保护留存下去。

### 8.22 复核轮 round 23（2026-10-14）：把"锁必须能咬人"固化成注册表——并纠正两次自己的审计方法错误

round 22 的判据是"正则必须先证明能抓住已知反例"。本轮把它**推广到全仓负向锁**，
过程中纠正了自己两次方法错误。

**① 第一版审计脚本是错的**：想用"正则匹配我拼的样本"判定咬合，构造
`前缀${字面量}后缀` 当探针，报出"**24/33 个锁不咬人**"。但该探针**不满足正则的其余结构**
——`/estimateTokens\(/` 要求紧跟左括号而样本没有 ⇒ 把**好锁**全判成死锁。
**教训：判定"X 是否匹配 R"不能用自拟样本，除非样本满足 R 的全部约束。**

**② 第二版换成可靠判据**：把每个正则里的字面量片段拿去**真实源码**里找。
⇒ 22 个锁的禁形在源码中真实存在（正在压制真实形态）；7 个锁的禁形只在自己的
测试文件与文档里出现。

**③ 那 7 个不是死锁，但验证方式不同**：禁形不在生产源码中 ⇒ "改回去看是否判红"
**走不通**（没有可改回去的东西）。唯一办法是**注入**。逐个注入后 **7/7 全部咬人**
（workflows.ts 本地等待实现 ×2、092 迁移 CONCURRENTLY、章节清理读摘要面/探文档、
prompt_executions 清理删行、技能段标题残留、plainTextLength 用 draft.text.length）。
其中 CONCURRENTLY 一例还暴露我漏了 `ddlOnly` 剥注释口径——**复刻原测试的取段口径
必须连它的过滤一起复刻**，否则基线假命中。

**④ 落地产出：负向锁咬合力注册表**（`negative-lock-bite-registry.test.ts`，9 个断言）。
对每个"禁形不在生产源码中"的锁记录基线取法、禁形注入样本、被测正则，
并断言两条不变量：① 咬合（基线不命中 + 注入后命中）；② 同源（`originalLiteral`
必须仍原样出现在原测试文件里）。

**⑤ 注册表首版也有洞（本轮最值得记的一条）**：注册表自己抄了一份正则，
于是把 evaluation 那条锁改窄后，**注册表仍用正确副本、照样全绿** ⇒ 抓不住最该抓的
"原锁退化"。反向复跑发现后补上"同源"不变量：原正则字面量不在原文件里即判红。
修正后反向复跑确认判红（`原测试 … 里已找不到 … 原锁正则已被改动，请复核注册表`）。

**四条可复用判据**：
1. **判定"是否匹配"不能用自拟样本，要在真实目标上试**——自拟样本几乎必然漏掉正则的
   一部分约束，从而把好锁判死（24/33 假阳性即由此来）。
2. **"禁形不存在"的锁，验证手段必须换成注入**——没有可回退的 defect。
3. **复刻某个断言的取段口径时，要连它的过滤一起复刻**（`ddlOnly` 剥注释、方法体切片）。
4. **薄壳注册表若不与原锁同源，就抓不住原锁退化**——凡"复制一份来守护"的设计，
   都要加一条同源不变量。

### 8.23 复核轮 round 24（2026-10-14）：正向锁的镜像失效——"守副本"，以及两次自己的判据错误

round 23 审完负向锁（禁形不在生产源码中 ⇒ 需注入验证）。本轮审**正向锁**的镜像形态，
结论是**零缺陷**——但过程中两次栽在自己的判据上，且促成了注册表的合并。

**① 首版判据用错对象 ⇒ 291 条假阳性**：拿"字面量是否在生产源码里出现"去判所有
`expect(x).toContain("Y")`，报出 291 条"守副本"。错在**绝大多数正向锁的断言对象是
运行时产物**（模型生成的 prompt、JSON payload、对象字段值），本来就不该出现在源码里。
**这是本会话第 N 次同族错误**：判据覆盖了一大类根本不适用它的对象。
修正：只在判据有意义的那一格工作——**断言对象确实是某个源码文件的文本**
（同文件里有 `readFileSync(...)`/`repo(...)` 定义被测变量）。

**② 次版又有两处覆盖不全**：
- 没排除 `.not.toContain(...)` ⇒ 把 `outbox-retention` 的一条**负向**锁误判成"守副本"；
- 路径解析只支持 `readFileSync("字面量")` 与 `repo("字面量")`，漏了
  `readFileSync(fileURLToPath(new URL("...")))` 与 `join(process.cwd(), "...")`
  ⇒ 17 条全部落成"断言对象是源码文本"而无法判定。
补齐后：**24 条正向源码锁，全部与被测源码一致，零守副本**（041 迁移 7 条 +
`getChapterPlanningContext` 委托 1 条 + `LENGTH_DRIFT_POLICY.sparseFloor` 常量化 1 条等）。

**③ 为何还要给正向上注册表**：正向锁表面上是"目标漂移就会判红"（自响），
但那只在**钉的是真源**时成立；一旦钉成测试文件里的副本，它就退化成"永真断言"——
比没有锁更坏，因为它占着一个"已验证"的位置。本轮虽零缺陷，注册表让它**持续**被复核。

**④ 合并注册表**：`lock-bite-registry.test.ts` 同时收负向（7 条，注入验证 + 同源）
与正向（10 条，字面量在被测源码中真实存在 + 同源）两侧，并加一个**反向哨兵**断言
（判据本身会响：探针字面量确实不存在、注册表首条确实命中）。原 round 23 的
`negative-lock-bite-registry.test.ts` 已删除（内容全量折入）。

**⑤ 反向复跑的第一次也是无效的**：把 `sparseFloor` 改名成 `sparseFloorRenamed` ——
而后者**仍包含子串** `sparseFloor`，所以锁继续为真、反例"通过"。**这不是锁的洞，
是我的反例没造成漂移**。改成真正替换（`sparseFloor` → `sparseLimit`）后正确判红。
⇒ 又一次印证 round 23 的教训：**反例必须先证明它确实制造了失效，再用来验证锁**。

**本轮可复用判据**：
1. **给一大类对象套判据前，先确认这类对象都适用该判据**——本轮 291 条假阳性全源于
   "运行时产物"与"源码文本"被混为一类。
2. **判据只覆盖目标的一部分形态时，那一部分会整批空转**（17 条无法判定）。
3. **正向上锁的价值不在"会响"，而在"钉的是真源"**——否则它就是永真断言。
4. **反例必须先自证它制造了失效**（改名要连子串一起改掉），否则你在验证一个没发生的故障。

### 8.24 复核轮 round 25（2026-10-14）：盲杀不变式在真库上的对抗验证——谓词正在保护 85 条事实

前几轮都在"锁/引用"层。本轮回到**事实记忆的语义正确性**，验一个此前只在
**单元测试层面**验证过的不变量：`memory-visibility.ts` 声称修掉的"盲杀"。

**① 声称 vs 验证的缺口**：头注释说 candidate/rejected 行不能把可见事实逐出检索面
（round 3 历史病例：ch19「缴清灵石」derived 被 ch21「旁路状态」candidate 退役）。
代码侧只有**锁 SQL 形状**的测试（含 `lifecycle_status`、`authority IN` 字样），
**没有一个测试在真实数据上验证该谓词确实在挡住盲杀**。缺口有两面且都可能藏问题：
谓词可能因"本库没有这种病例"而**空转**，也可能因写反而**漏杀**——两者都看不出。

**② 对抗验证（真库 2,126 行）**：
- **算术闭环**：检索面可见 **1,832** + 被可见 killer 退役 **155** = **1,987**
  = `active ∧ 可见 authority` 总数。左右恰好相等 ⇒ **无漏杀**
  （任何"被覆盖却仍可见"的行都会让左边变小）。这个证明比直接查漏杀更硬——
  首版想直接查，SQL 报了 `lifecycle_status is ambiguous`（别名写错），改用算术闭环后反而更强。
- **盲杀防护真实存在**：被**任意** killer 覆盖 **203** 行，被**可见** killer 覆盖 **155** 行，
  差 **48** 行 ⇒ 谓词正在挡住这些行不被未裁决的候选杀掉。
- **病例身份**：**86 个 (victim, killer) 对**，其中 **85 对正是 round 3 记录的历史形态**
  （`active/derived` victim 被 `active/candidate` killer 覆盖），另有 1 对
  `staged/approved` killer 覆盖 `active/approved` victim。⇒ 谓词**不是空转的装饰**。

**③ 落地：`blind-kill-live.test.ts`（4 例）**把该验证固化成测试：
- ① 算术闭环（跨环境稳定的无漏杀证明）
- ② 盲杀口径 ≥ 可见口径 + 可见口径不超过总数（**只做方向断言**，不依赖真库有病例，
  否则新建环境会假红）
- ③ 谓词方向（反向锁：不得退化成"任意 killer"）
- ④ **自证**：在本测试内构造最小病例（derived + candidate），验证候选杀不掉它、
  批准后才能杀掉它——不依赖真库既有数据

**④ 反向实测两例**：A 把自证用例的期望改成"盲杀已发生" ⇒ 判红
（`expected '1' to be '0'`，证明它真在验盲杀）；B 把谓词方向断言改成不存在的形态
（模拟 killer 可见性检查被移除）⇒ 判红。

**本轮可复用判据**：
1. **"声称修了 X"与"验了 X"是两件事**——lock the SQL shape 只证明"写成了某个样子"，
   不证明"在实际数据上起作用"。谓词类不变量必须有**真库对抗验证**，且要能看出空转。
2. **算术闭环比直接查漏更强**：`可见 + 被覆盖 = 应可见总数` 一次同时证明"没漏杀"
   与"没多杀"，且不依赖枚举违规行（首版枚举的方向还写错了）。
3. **跨环境稳定的断言只做方向**：真库有没有病例随环境变化，所以
   "盲杀口径 ≥ 可见口径"可以恒定断言，"差值 > 0"不能。

### 8.25 复核轮 round 26（2026-10-14）：测试复刻了被测逻辑——比"守副本"更危险的"守复刻"

round 25 的判据（**"声称修了 X"与"验了 X"是两件事**）用到 §3.5 的状态类槽位重排上：
它当年有单元测试，但**没有一个测试在真库数据上复现它要治的场景**。

**① 真库对抗验证证实修法非空转**（`tmp/state-audit/verify-state-slot-recency-on-live.mts`，
2,126 行真库）：状态类槽位 92 个，其中**同槽多值并存 31 个**（成员共 490 条）。
对每个多值槽比较"旧口径（authority 序）"与"新口径（叙事位置降序）"截断前 3 条的入选集合：
**13/31 个槽位的入选集合不同，且无一个反向退化**。差异形态正是 round 3.5 诊断的那个病：

| 槽位 | 成员 | authority 分布 | 旧口径取到的最大叙事位置 | 新口径 |
|---|---|---|---|---|
| `0a70ecce…` | 294 | 50 approved + 244 derived | **6** | **168** |
| `48b90d66…` | 68 | 3 approved + 65 derived | **114** | **168** |
| `118b8b65…` | 13 | 2 approved + 11 derived | **34** | **163** |

⇒ 旧口径下模型读到第 6/114/34 章的旧值，而当前值在第 168/168/163 章
（即"模型读到 160 章前的家当"）。**修法在真实数据上改变了结果，不是空转的装饰。**

**② 但首版测试自己是坏的（本轮最要害的发现）**：首版测试自己复刻了一套
"新旧口径对比"排序来验证重排效果，却**没有调用被测函数** `orderStateLikeSlotsByRecency`。
反向复跑立刻暴露：把复刻逻辑的排序方向改反，测试**照样全绿**——因为我改的东西
从来不是被测对象。这与 round 24 的"守副本"同族，但**更危险：守的是逻辑副本**，
而逻辑副本没有"源"可以比对（字符串副本至少还能 grep 出它在源码里）。

**③ 根因：被测函数是模块私有**。`orderStateLikeSlotsByRecency` 未导出 ⇒ 外部测试
无法直接调用 ⇒ 当初（与本轮首版）都只能复刻逻辑。**"测不到"必然导致"复刻"，
而复刻的测试锁不住被测对象。**

**④ 修复**：
- 导出 `orderStateLikeSlotsByRecency`（纯可见性变更，零行为变更）；
- 测试改为**直接调用被测函数**：`state-slot-recency-live.test.ts`（4 例）——
  ① 真库多值病例存在；② 用真库数据驱动被测函数，断言槽位内叙事位置降序、
  集合不变、**跨槽位次序不被篡改**（"槽位占位重填"的核心承诺）；
  ③ 谓词边界；④ **构造最小病例自证**：ch2 approved / ch50 derived / ch168 derived
  三条 + 两个跨槽位对照，断言最新值排槽位首位、旧 approved 掉到末位、跨槽位次序原样。
- **反向实测改为改生产源码**：把 `cognition.ts` 的重排比较器方向改反
  （`rightStart - leftStart` → `leftStart - rightStart`，即回到"拿最旧值"的旧 bug）
  ⇒ 测试判红 `最新值必须排在槽位首位（旧口径下它是第三名）:
  expected 'claim-old-approved' to be 'claim-new-derived'`。改回后全绿。

**本轮可复用判据**：
1. **测试复刻被测逻辑 = 锁不住被测对象**，且比字符串副本更难发现——它甚至能通过
   "我自己跑一遍是对的"这种自欺验证。判据：**反向复跑必须改生产源码，而不是改测试**。
2. **"测不到"必然导致"复刻"**：模块私有的被测函数会被测试以复刻逻辑的方式绕过。
   可测性是正确性的前提，不是便利性加分项。
3. 复刻型测试即便断言写对了，也只在"复刻与源码一致"时有效——而**没有人保证这一点**；
   一旦源码演进，复刻就成了守着一份过时的副本。

### 8.26 复核轮 round 27（2026-10-14）：把"不得复刻生产逻辑"推广成全仓守卫——并先证明守卫会响

round 26 的根因是"**测不到 ⇒ 复刻**"（模块私有函数逼测试自己写同形逻辑）。
本轮把该教训**按类别扫全仓**并固化成守卫。

**① 全仓扫描结论：零真复刻**（`tmp/state-audit/audit-test-logic-duplication.mts`）。
判据是结构性的（不靠猜）：归一化代码行后，测试 helper 函数体里 ≥2 行在生产源码中也出现、
且占其代码行 ≥50% ⇒ 判为复刻候选。127 个测试文件 / 168 个生产文件 / 21,870 条索引行
⇒ **候选 0 个**。
⇒ round 26 那处是**个案而非类病**（如实记录，不把一说成普遍）。

**② 但"0"必须先证明不是探测器坏了**（本会话已多次栽在"判据失效却报 0/报一堆"上）。
自检方法：拿**已知正例**喂探测器——把 `orderStateLikeSlotsByRecency` 的三行
（含那个被改反过的比较器行）拼成一个人造 helper，探测器**4/4 行全部命中** ⇒ 会响，
上轮的 0 候选可信。

**③ 顺带发现另一类"复刻"**：探测器只覆盖"测试复刻**生产**逻辑"；
`buildActivities` / `makeSlice` 这两个同名 helper **各在 2 个测试文件里重复定义**。
逐一核读后判定为**正当变化**：两者是为不同场景构造 repository 桩
（一个要 40 章 + 伏笔集、一个要 2 章 + 串行快照），共享的是"该桩哪些仓储方法"的骨架，
不是生产逻辑副本。⇒ 记为已复核，不动作。

**④ 落地：`no-test-logic-duplication.test.ts`（4 例）**，把该守卫固化为常态检查：
- ① **人造正例自检**：生产索引里必须能命中探针行 ≥2 行（否则守卫空转）
- ② **病灶行仍在索引**：`if (leftStart !== rightStart) return rightStart - leftStart;`
  必须仍在生产源码中（否则说明 round 26 的修法被回退了）
- ③ **无测试 helper 复刻生产逻辑**（主判据）
- ④ **反向哨兵**：往测试目录临时写一个真复刻 helper，断言判据**必须**判红，
  然后删掉探针文件（`finally` 保证清理）
反向实测：注入复刻 helper ⇒ ③ 判红并列出该 helper；清理后全绿。
（探针文件用 `finally` + 还原原内容，避免把自己的守卫变成脏文件源。）

**本轮可复用判据**：
1. **"扫出 0 个"和"扫出一堆"一样需要自检**——判据失效时两种表现都会出现
   （24 那次是判据过宽报一堆，本次是判据过严可能报 0）。判据是**拿已知正例喂一遍**。
2. **探测器覆盖范围要如实说明**：它只查"复刻生产逻辑"，不查"测试间复刻"——
   后者要单独核（本次核出 2 个同名 helper，均判正当）。
3. **守卫自己也要防脏**：反向哨兵往仓库里写临时文件时，必须 `finally` 还原/删除，
   否则守卫本身会制造出一堆本可避免的差异。

### 8.27 复核轮 round 28（2026-10-14）：长期"欠灌 76 条"的归因修正——以及一次 id 空间错配

`memory-index-drift` 多轮都报"欠灌行 76 条"，round 4/5 修了机制但**数据一直没补**，
记录里写的是"13 条真缺口、其余是同槽已灌或陈旧 revision"。本轮重新核准，发现**记录本身
有两处失真**，真相比记录更小、也更清楚。

**① 首版取证报了个荒谬的数（1,832 条全欠灌）**。原因：我拿 Qdrant **点 id** 与仓储**行 id**
直接比对，而点 id 是 `(projectId, rowId)` 的 sha256 散列（`qdrantPointId`，UUIDv8 形态）——
两者从来不可能相等 ⇒ 2,165 行全部"对不上"。这与 round 12 的"空数据推结论"、round 21 的
"列类型搞错"同族：**没先确认两边的 id 是不是同一个空间**。
修正后数字立即与 doctor 吻合：应索引 2,165、已索引 2,089、**欠灌 76**。

**② 重新归因（用单源可见性口径 + 同槽判定）**：

| 归因 | 条数 | 说明 |
|---|---|---|
| 假缺口·同槽已有更新的可见值入索引 | **42** | 灌旧值会让检索面同时看到新旧两个值 ⇒ **不该灌** |
| **真缺口** | **10** | 该槽位当前值没灌，语义检索找不到它 |

真缺口全部落在 ch13—ch98（赵虎夺草、引气诀缺漏、周师兄审视、木屋歪圈记号……），
是早期设定类事实；**中后期（ch99-168）零真缺口**。

⇒ round 4/5 记录里的"13 条真缺口"实为 **10 条**（当时把 3 条同槽已灌的误判成真缺口）；
而"76 条"里 **24 条 chapter-memory 全部属同槽已灌**（rollup 共享槽位），一条都不是缺口。
**健康信号"欠灌 76"本身就失真**，真实待办只有 10 条。

**③ 定向补灌写好但无法执行（如实记录 blocker）**：`backfill-real-index-gaps.mts` 支持
dry-run / `--apply`，只写这 10 条（不走全量 rebuild——那会 upsert 2,165 条、触发 2,165 次
embedding，其中 2,155 条已在索引里）。**但 `--apply` 失败**：
`Qdrant 集合 novel-memory-current 维度 1024 与 embedding 维度 3 不一致`。
追因：`memory.embed` 路由到 api executor，而 **api 服务未运行**（doctor 的
`api FAIL` 是本轮记录的预期状态），`gateway.embed()` 返回空 embeddings，
provider 拿退化值去比对维度。**这不是代码缺陷，是环境前提缺失**——
定向补灌需要可用的 embedding 端点，故留待服务可用时执行（脚本已就绪、dry-run 结论稳定）。

**④ 归因结论固化为可复跑的取证脚本**（`tmp/state-audit/verify-under-indexed-attribution-v2.mts`），
要点是**点 id 必须先过 `qdrantPointId`**——这条已写进脚本注释，避免下次再犯。

**本轮可复用判据**：
1. **比对两个集合前，先确认它们的 id 是同一个空间**——点 id 常是行 id 的散列，
   直接比会得到"全都不匹配"的荒谬结论，而荒谬本身是最好的警报。
2. **一个长期存在的健康信号也可能是失真的**：doctor 报"欠灌 76"报了很多轮，
   没人质疑过它的口径（它把 42 条本不该灌的行也算作欠灌）。**数字稳定 ≠ 数字正确**。
3. **环境前提缺失时要如实记 blocker**，不要用退化路径绕过（本次没有为了"补灌成功"
   而改低维度或跳过分支——那会污染索引）。

### 8.28 复核轮 round 29（2026-10-14）：语义召回端到端链路不可验证——并给拦过灾的护栏补上锁

round 28 的定向补灌因 `embedding 维度 3 ≠ 集合维度 1024` 失败。本轮查这条链断在哪、
断的时候有没有造成损害。

**① 端到端召回链路此前从未被验证过**：`verify-recall-end-to-end.mts` 用**真库可见 claim**
作正样本（自身作 query、标题关键词作 query）+ 明显不在本书里的词作反例。
**结论是 SKIPPED**——`memory.embed` 端点不可用（`embed()` 返回空，实测维度 0 vs 期望 1024）。
如实跳过，不伪造"召回为空"的结论（round 12 的教训：环境缺失 ≠ 行为为空）。

**② 断点定位**（`diagnose-embedding-auth.mts`）：
- 端点本身**可达**：直接打 `https://api.siliconflow.cn/v1/models` 得 HTTP 401
  （网络通；且本仓 config 里该 profile 的 inline 密钥**有值**）；
- `RoutedModelGateway.embed()` **不抛错但返回空 vectors**；
- 配置从未入库（`git log` 对 `config/model-providers.local.yaml` 为空）⇒ 本地未纳管配置。

**③ 关键结论：护栏起作用了，没有造成损害**。`qdrant-memory.ts:193` 的
`if (vectors.length !== claims.length || …维度 !== this.dimension) throw`
正是 round 28 失败信息的来源——它拦下了一次**退化的 embedding**，
没让空/错维度的向量写进集合。若无这道护栏，错误空间的向量会污染全部后续召回。

**④ 但护栏本身没有测试锁**（本轮真正的产出）。三种失效形态都会让索引进入错误空间：
向量数少于 claim 数（下游 `vectors[index]` 取到 undefined）、维度不一致、护栏被整体移除。
补 `qdrant-collection.test.ts` 三例：数量不匹配 ⇒ 拒绝写入且 `upsert` 未被调用；
维度不一致 ⇒ 拒绝写入且 `upsert` 未被调用（**round 28 实测拦住的正是这一种**）；
反向哨兵（退化 embedding 必须被拒，通过则说明护栏已失效）。
**反向实测**：移除生产护栏 ⇒ **3 例全红**（`promise resolved "undefined" instead of rejecting`）；还原后全绿。

**本轮可复用判据**：
1. **"拦过灾的代码"和"被锁住的代码"是两件事**——护栏救过一次场（round 28）不等于它被验证。
   凡被实测证据证明"起过作用"的守卫，第一优先补锁：价值已被证实，而失效尚无人会发现。
2. **查不可用的链路时，先分清"端点不可达 / 鉴权失败 / 调用不抛错但返回空"**——三者结论完全不同
   （网络 / 密钥 / **最危险的静默退化**）。本轮实测是第三种，而它恰好被下游护栏挡住，
   所以只表现为"补灌失败"而不是"索引污染"。
3. **验证脚本的前置探活要能如实跳过**：embed 探活失败时打印 `SKIPPED_embedding_unavailable`
   并给出实测/期望维度，而不是把"探活失败"读成"召回为空"。

### 8.29 复核轮 round 30（2026-10-14）：轴覆盖自检——正文只有 3/29，而直读最强章差点误判它的核心机制

前 29 轮的提交按目标点名的三个对象归类后：**工程/测试 23、事实记忆 8、生成契约 9、
skill 显式 2、正文只有 3**。正文是实际交付物（"更高质量的小说"）却审得最少，
故本轮转回**读者轴**，并挑"最强带直读"这一最严的做法。

**① 直读最强章 ch103**（一枚缓字）时我注意到一个**差点被误判**的形态：
「数了四十七步…走到第三十二步」「第二遍他已经确认了」「不看第三遍」。
我当时的读感是"用计数代替论证的偷懒"——准备把它列为下一处该治的惯性。

**② 但按 round 20 的判据先问"最强带是否也在用"，结论相反**。
把"数数"按**机制**拆成三种分别测（`tmp/state-audit/measure-counting-mechanisms.mts`，
同一套合格带/混合带判据）：

| 族 | 全书 | 合格带 | 混合带 | **最强带 099-127** | 混合/合格 | 原始计数 |
|---|---|---|---|---|---|---|
| A 节律型（数呼吸/天色/脚步） | 0.13 | 0.12 | 0.09 | 0.12 | 0.82 | 44 |
| **B 分析型（序数作推演编号）** | **0.83** | **0.94** | **0.36** | **1.23** | **0.38** | **326** |
| C 对照·叙事时间戳 | 0.23 | 0.24 | 0.23 | 0.36 | 0.95 | 88 |

分析型在最强带是混合带的 **3.4 倍**，基数 326（非小样本）⇒ **与质量强正相关**。

**③ 直读峰值章 ch123 确认机制**：
「**第一遍，他先走量词的路**／**第二遍，他走另一条路**」是**穷举假设**；
「**第一步到第七步，檐影**…**第八步到第十九步，过井台**」是**带证据的空间复原**。
⇒ 计数**就是论证本身**，是这个人物"靠分段验证来确认"的认知方式。
一次善意的"把序号改成他想了想/反复推敲"的修订，会删掉本书最可靠的严谨感。

**④ 落地：把这条**保护性**指引写进三面（prose-craft 1.8.0 → 1.9.0）**：
写作/审核/修订三面都写明"序数作推演编号是本书最强的正面声音，修订时不得'理顺'掉它"，
并明确禁止的具体改写形态（"他想了想""反复推敲"）；只在同一处重复同一编号而实际
没有那么多段时才报，并要求说明挤掉了什么。
**回归锁**（`skill-runtime.test.ts` 新增 1 例）：三面都须含"序数作推演编号"；
修订侧须含"不得"及被禁止的改写形态。**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **按目标点名的对象做覆盖度自检**——工程轴做得多不等于目标达成了；正文只有 3/29
   这个数字本身就是最该被纠正的偏差（而它不读提交历史是看不见的）。
2. **拆族要按"机制"拆，不按"用词"拆**：round 20 把"数数"当一族并判它正相关，
   但那一族里混着两种机制相反的东西（节律型无关、分析型强正相关）。
   **用词同形不代表机制同形**——这一条直接修正了 round 20 自己的结论粒度。
3. **最强的审法常常是"差点误判好东西"**：直读最强章时产生的"这是毛病"直觉，
   恰恰是最值得追查的信号——追查的结果可能是"确实有毛病"（round 19 的面部表情），
   也可能是"这是我的误判"（本轮）。两条路都必须走数据，不能靠直觉落判。

### 8.30 复核轮 round 31（2026-10-14）：round 30 的判据回头修正 round 19——并族造成的过宽被收窄

round 30 立了"**拆族要按机制拆，不按用词拆**"，并用它修正了 round 20 的结论粒度。
本轮把同一条判据**回头用在 round 19 自己的结论上**——那轮把
`嘴角|眉头|眉心|眼神|眼底|眼皮|眼角` 七面按用词并成一族，判它与章节强度负相关，
并写了"情绪节拍不要默认落在面部表情"的指引。

**① 按机制拆三种**（`tmp/state-audit/split-face-idiom-mechanisms.mts`）：

| 机制 | 原始计数 | 全书 | 合格带 | 混合带 | **最强带** | 混合/合格 |
|---|---|---|---|---|---|---|
| **A 表情 + 一句释义** | **27** | 0.065 | 0.055 | 0.186 | **0.000** | **3.40** |
| B 单一个标记、不解释 | 76 | 0.182 | 0.133 | 0.278 | 0.051 | 2.09 |
| C 表情捆在肢体动作里 | 22 | 0.051 | 0.027 | 0.166 | **0.000** | 6.05 |
| 合计（七面并族） | 125 | 0.298 | 0.215 | 0.630 | 0.051 | 2.93 |

**② 逐章核 A 的分布后结论更硬**：A 的 27 处**全部落在 ch2—ch72**，
**ch73 以后一处都没有**；而 B 在 ch73 后仍有 26 处、合格带 30 处 vs 混合带 27 处
（基本持平）。⇒ A 是**早期被作者自己写掉的习性**，是本族里唯一确凿的病灶；
B 是**贯穿全书、密度与质量无关的稳定手艺**。

直读 A 的样本也印证机制差异：`那眼神不像在看人，像在看一样已经归他名下的东西`、
`眼神逐渐变得深邃`——都是"替读者把表情翻译一遍"；而 B 的 `眼皮耷拉着`、`嘴角撇了一下`
是把线索交给读者自己读。

**③ 修正（prose-craft 1.9.0 → 1.10.0，三面同步）**：把指引从"面部表情"（七面并族）
**收窄到机制 A**，并显式声明**B 与 C 不报**：
- 写作侧：病灶是"表情 + 一句释义"，判据是"这段情绪能否由动作/选择/对白后果承担"，
  删掉时问"读者是会失去一个可观察的线索，还是只失去一个标签"
- 审核侧：只报"表情 + 解释其含义"，**单标记与肢体捆绑的表情都不报**
- 修订侧：**不得因为"又一个表情标记"而删表情**（旧措辞正是这么要求的）
旧依据（合计密度、混杂排除）仍成立，但它**只支撑 A 这一种机制**。

**④ 回归锁**：新增 1 例锁收窄（三面都只针对"表情+一句释义"，且写作侧须写明
单标记/肢体捆绑不是病）；改造 1 例——原 round-20 那条断言"单一个表情标记草草收尾"
是必查形态，与收窄后的判据**直接冲突**，已按其新前提改写。
**反向实测**：插入必然失败的断言 ⇒ 判红（已跑）。

**本轮可复用判据**：
1. **新立的判据要立刻回头检验它打算修正的旧结论**——round 30 用"按机制拆"修正了
   round 20，本轮再用它修正 round 19。若只往前用，旧的过宽结论会一直留在指引里。
2. **"并族"的代价是过宽，而过宽的指引会主动摧毁好东西**：旧措辞要求"不得因又一个表情
   标记而保留"，照做会删掉 B（76 处、ch73 后仍稳定的手艺）——**这类删除比漏报更贵**。
3. **逐章核分布比看聚合比值更能定性**：A 的 3.40 倍只是"与弱章同现"，
   而"27 处全在 ch2—ch72、之后为零"才说明它是**被作者自己写掉的习性**——
   前者是相关，后者是历史事实，后者的证据强度高一个量级。









### 8.31 复核轮 round 32（2026-10-14）：第三次机制拆分——清点条款被**确认**校准准确

round 30/31 用"按机制拆族"修正了"数数"、收窄了"面部表情"。本轮复查 round 2
最早指控、也一直没被拆过的**道具盘点**族——结论是**确认而非推翻**，
而且是最硬的一种确认。

**① 按机制拆三种**（tmp/state-audit/split-inventory-mechanisms.mts）：

| 机制 | 原始计数 | 全书 | 合格带 | 混合带 | **最强带** | 混/合 | ch73 后 |
|---|---|---|---|---|---|---|---|
| **A 清点即情报**（点名后紧跟状态/位置变化） | **127** | 0.33 | 0.31 | 0.51 | 0.18 | 1.65 | **21 章** |
| B 清点即存在感（只摸不报变化） | 53 | 0.13 | 0.15 | 0.21 | **0.000** | 1.44 | 6 章 |
| **C 温度判定**（配一次"凉/冷"） | **317** | 0.78 | 0.63 | 1.25 | 0.34 | **1.97** | — |
| 合计（物件名并族） | 862 | 2.16 | 2.18 | 2.99 | 0.95 | 1.37 | — |

**② 最强带直读是最硬的证据**：该带 29 章里 **A 型 15 处、B 型 0 处**。
读样本确认机制：ch99「玉牌贴着右肋，凉的」紧接着 ch103「把回执展开…夹层里，
**多了一枚圈**」——**清点本身就是发现**。

⇒ 最好的章只用 A、从不用 B。所以 round 2 那条"必须带来新信息/新选择/新代价"
**不是限制，而是本书最好手法的定义式**。

**③ C 是这一族里基数最大、信号最强的一族**（317 处、1.97 倍），且 round 10 的
可达性结论仍成立（最强带 0.34 vs 全书 0.78，低 2.3 倍）⇒ 条款要治的那半确实是 C，
而条款**已经**在治它。

**④ 落地**：把机制拆分依据补进清点条款（prose-craft 1.10.0 → 1.11.0），
明确写出"A 是定义式 / B 在最强带为零 / C 是本族最强信号"，
防止后续修订把判据放宽回"可以清点"（那会放回 B）。
**回归锁**新增 1 例：断言三族依据 + "定义式"结论 + 判据三条件仍在。
**反向实测**：插入必然失败的断言 ⇒ 判红（已跑）。

**本轮可复用判据**：
1. **同一判据连用三轮，三次结论分别是"推翻 / 收窄 / 确认"**——机制拆分不是用来
   找茬的，是用来**定性**的；老结论也可能是对的，而且能被加固。
2. **"最强带里 A 有 15 处、B 有 0 处"这种对立计数比任何比值都更能说明问题**：
   它直接给出"最好的做法是什么、最坏的做法是什么"，而不只是"与弱章同现"。
3. **把确认写进指引和把修正写进去同样重要**——只写修正会让后来者以为这条判据
   一直被怀疑；写清"已被机制拆分确认"才能防止它被下一轮"优化"掉。

### 8.32 复核轮 round 33（2026-10-14）：第四次机制拆分——章尾纪律确认，且防一个读窄风险

round 30/31/32 拆了三族我**当初 flagged 过**的惯用语（数数/面部表情/道具盘点），
结论依次是推翻/收窄/确认。本轮换对象：审 round 2 写入、此后一直没被单独取过证的
**章尾收束纪律**——结论又是**确认**，且带一个必须防的读窄风险。

**① 按机制拆三种收束**（`tmp/state-audit/split-ending-mechanisms.mts`）：

| 机制 | 原始计数 | 全书 | 合格带 | 混合带 | **最强带** | 混/合 |
|---|---|---|---|---|---|---|
| **A 短句收尾（末句 ≤8 字）** | 38 | 0.226 | 0.228 | 0.176 | **0.276** | **0.77** |
| B 长句收尾 | 130 | 0.774 | 0.772 | 0.824 | 0.724 | 1.07 |
| **C 问句收尾（悬念钩子）** | **0** | 0 | 0 | 0 | 0 | — |

短句收尾在**最强带最高（比混合带高 1.6 倍）且越往后越多**（ch72 前 10 章 → ch73 后 28 章）；
C 全书零处——168 章一个悬念问句钩子都没有。

**② 再按"宣告 vs 单拍"分类，防读窄**（`classify-short-endings.mts`）：
**最强带 8 处短句收尾全部是"单拍落点"、零宣告**——
ch112「他没挪。」、ch127「两个字入册。」、ch124「他走出巷口，雾散了。」
它们是**把一个决定性的动作当作事件收章**，与"连续短句宣告同一结论"正好相反。

⇒ 纪律禁止的是**宣告**，不是**短**。若后续有人把它读窄成"不得短句收尾"，
会禁掉本书的标志性手法。

**③ 落地**：把机制拆分依据写进章尾纪律（prose-craft 1.11.0 → 1.12.0），
写明"最强带 0.276 / 问句全书 0 处 / 最强带全是单拍零宣告 / 禁止宣告而非禁止短 /
不得因短句结尾而报"。**回归锁**新增 1 例：断言三条硬事实 + 结论方向。
**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **"确认"类结论要连它的读窄风险一起写**——round 32 已立"把确认写进指引很重要"，
   本轮补上后半句：**确认的同时要指出它最容易被怎么读错**。章尾纪律的读窄方向
   是"把'短'也禁掉"，而短句单拍正是标志性手法。
2. **"零计数"本身就是有力证据**：问句收尾全书 0 处，说明这条禁令**从未被触发过**——
   它保护的是一个从未被误用的形态。记录零值比只报非零值更能说明纪律的真实边界。

### 8.33 复核轮 round 35（2026-10-14）：群像判据取证——是已守住的基线，不是区分质量的杠杆

round 30-33 拆了四族**我当初 flagged 过**的惯用语。本轮转向 round 33 末指出的方向：
**从没被单独取证过的 round 2 老判据**。第一个是
"有随从、同伴在场的对手戏，每个具名角色都要有至少一个独立于主角观察的可观察反应"。

**① 首版测量用错对象**（本会话第 N 次同族）：手写 8 个配角名，只覆盖 15/168 章、
**最强带 0 章**——覆盖不够则无从判断。修正方式：从 `memory_claims.subject_refs`
取**真实活跃主体名**（21 个：吴姓杂役 / 繁主事 / 话房人 / 文书吏 / 灰衣杂役 / 圆脸弟子…），
覆盖率升到 **144/168 章（86%）**，最强带 23 章。

**② 实测结果**（`measure-ensemble-reaction-space-v2.mts`，判据=配角充当句子主语的句数占比）：

| 带 | 章数 | 配角色数 | 独立反应句 | 主角框定句 | **独立占比** |
|---|---|---|---|---|---|
| 合格带 | 75 | 2.81 | 3.31 | 2.85 | 0.537 |
| 混合带 | 33 | 2.97 | 5.70 | 4.06 | 0.584 |
| **最强带** | 23 | 2.74 | **2.65** | 2.17 | **0.550** |

**占比基本持平**（最强带的绝对句数更低只因它更短，不是群像更塌）。

**③ 直读确认机制真实**：ch116「来接的还是话房人。」「"存注，"繁主事开口了，声音不高」——
都是配角自己发起动作与开口，不是被主角叙述带过。

**④ 定性比数值更重要**：这条是**已守住的基线，不是区分质量的杠杆**。
要盯的是**占比掉下去**（塌成主角视角回声），不是它有多高。
**⑤ 落地**：把实测与这一定性写进判据（prose-craft 1.12.0 → 1.13.0），
明确"不必为'提高占比'而给配角加戏"。**回归锁**新增 1 例：
断言实测占比（0.550）+ "基线而非杠杆"结论 + "盯下降不盯升高"。
**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **判据要"发现缺陷"，也要能"证明基线已守住"**——后者的价值是防止后人为了
   "改进"它而把已经对的做坏（本例：为提占比给配角加戏会稀释主线）。
2. **判定一个质量指标时先问"它与质量相关吗"**：不相关（本例持平）的指标只该当
   **基线守卫**（掉了才报），不该当优化目标。把持平指标当杠杆是无效投入。
3. **"真实主体名"要从数据层取，不手写**——手写 8 个名字只覆盖 9% 的章，
   等于用错对象；从 subject_refs 取才覆盖 86%。

### 8.34 复核轮 round 36（2026-10-14）：复原判据取证——总结连接词全书绝迹，而反向代理被证失败

round 30-35 拆了五族判据（数数/面部表情/道具盘点/章尾/群像）。本轮取 round 2 起反复出现、但从未单独取过证的**"叙述者替读者论证 / 普通读者复原现场"**。

**① 连接词口径：这本书几乎从不由叙述者下结论**（tmp/state-audit/measure-reconstruction-density.mts）：
"因此/所以/总之/说到底/这意味着/这便是/可见"这类总结连接词全书 168 章共 **32 处（0.07/千字，约每 5 章 1 处）**，四个合格带 0.10 vs 混合带 0.08、最强带 0.09——**密度极低且与质量无关** ⇒ 这条禁令**从未被真正触发过**（与 round 33 的"问句收尾全书 0 处"同族的零计数发现）。

**② 反向代理失败，且失败原因比以往更细**：想用"可观察要素密度"（身体部位 + 物件接触 + 空间方位）测"现场是否由证据承载"，得到全书 **102/千字**、四带比值 **0.92**，**毫无区分度**。原因是取词层选错：单字"左右/上下/里外/前后/中间"在中文任何散文里都高频（空间方位一族就占 21,577 处 / 可观察合计 39,609），信号被通用成分淹没 ⇒ 本会话第 N 次"判据用错对象"，但学到更细的一条：**即使概念选对了，取词层选错（用常用单字而非可区别的复合线索）同样让测量失效**。

**③ 落地**：把实测与两点结论写进判据（prose-craft 1.13.0 → 1.14.0）——总结连接词 32 处（从未触发）、**不可据此认为"可以写总结段"**、反向代理已证失败、**本条的可靠执行面仍是语义判断，不得改成可计算的密度门**。**回归锁**新增 1 例：断言零值 + "不可据此认为" + "反向代理" + "不得立密度门"。**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **零计数发现要说清它的口径边界**——"总结连接词 32 处"只覆盖连接词口径，不等于"这本书没有替读者论证"；必须显式写"不可据此认为可以写总结段"，否则零计数会被读成许可（round 31 的"禁止宣告而非禁止短"是同一防御动作的镜像）。
2. **判据失效有两种，不只是"没选对概念"**：概念选错（本会话多次）之外，**取词层选错**同样能让测量失效——常用单字做的密度指标会被通用成分淹没，得出"哪里都差不多"的假持平。落地前要看**基数构成**（本例空间方位占可观察合计的一半以上）。
3. **代理失败也要写进 spec**：记录"试过用 X 测 Y、结果 0.92 无区分度"，后人就不会再花一轮造同一个密度门——失败的代理与成功的判据同等值得留痕。

### 8.35 复核轮 round 37（2026-10-14）：收窄说明不得穿插在必查项列表里——同一条指令内部的“两处口径”

round 30-36 在**内容**上把五族判据收了窄/撤了禁/加了保护。本轮回头查这些修改的
**落点形态**，发现一个此前没注意到的结构缺陷。

**① 缺陷**：收窄说明原先**穿插在必查项列表内部**——
`…、**情绪节拍由"表情 + 一句解释它意味着什么"承担（…）而该节拍本可由动作、选择或
对白后果承担**（round 31 窄化：…）、独处章以逐件清点…`
审阅者按顺序读列表时，**先读到的是收窄前的宽表述**，窄化说明作为括注出现在其后——
**括注在注意力上输给主句**。这是同一条指令内部的"两处口径"（round 14 跨面同族）：
宽表述在被执行的那一份（列表）里，窄表述在被跳过的那一份（括注）里。

**② 顺带暴露的第二个问题**：同一条指令里有**三处**窄化说明（表情 round 31、
数数 round 10、序数 round 30），各自以不同形式嵌在不同位置——
一处是括注、一处是独立句、一处是另一句的括注。**没有统一的“边界段”**，
读者（与后续维护者）要靠通读才能拼出完整边界。

**③ 修复（prose-craft 1.14.0 → 1.15.0，仅重构不改语义）**：
把三条窄化说明从列表内**移到列表之后集中的边界段**，列表项只保留收窄后的短形式
+ 一句指路（"只报这一种，见下方边界①"），边界段以"**下面是上面各项的边界，
逐条照做，不要越过**"起头并用①②③编号。语义零变更，可执行性与可读性都改善。

**④ 回归锁**（`skill-runtime.test.ts` 新增 1 例）：断言集中的边界段在场；
三条边界各带编号；并**反向断言列表段内不得出现未收窄宽表述**
（取"是必查项："到"这些机制已造成"之间的列表段做 `not.toContain`）。
**反向实测**：把窄化说明塞回列表内部 ⇒ 判红（已跑）。

**本轮可复用判据**：
1. **收窄一条规则时，要连它的落点形态一起改**——只在括注里加说明，
   宽表述仍留在会被执行的位置（round 14 跨面同族，这次是**指令内部**的同族）。
2. **同类边界要有统一落点**：三条窄化说明分散在三处形态里，读者拼不出完整边界；
   集中成带编号的“边界段”后，边界才是可查的。
3. **反向断言要能定位“执行的那一份”**——本锁把列表段切出来单独断言，
   而不是只断言边界段存在（那挡不住列表里仍有宽表述）。
### 8.36 复核轮 round 38（2026-10-14）：fact-memory 承诺了数据模型交付不了的保证

round 37 修的是指令内部的落点形态。本轮转向三轴里最久没动的那轴：
`fact-memory.yaml` 只有 22 行、两个执行点各一句，是"相关事实记忆"的**生成面唯一
指引**，从 1.0.1 起从未被单独审过覆盖度。

**① 覆盖度审计（`tmp/state-audit/audit-fact-memory-guidance-coverage.mts`）的失败**：
原想测六类失败模式在真库的发生量，其中"无逐字证据"一类的代理是
"content 里取 ≥6 连续汉字、在正文语料里找子串"——结果 **1623/1832（89%）命中"无证据"**。
这个数荒谬到本身就是警报：实测 `memory_claims` **没有 evidence 列**，
`memory_claim_sources` 也没有引文列。content 本就是**结构化转述**
（"楚衡 的信息边界（第1章）""楚衡持有木屋门框内侧开闩处的歪圈…"），
从来不是逐字引文；用"content 是否在正文中出现"测证据，是拿错误的字段当证据字段。
（本会话第 N+1 次同族，且这次暴露的是**字段层面的错配**。）

**② 顺着这个错配查出的真问题**：逐层追 `evidence` 字段的实际去向——
- `fact-extraction/prompt.ts:70`：`evidence 必须引用正文逐字证据（不少于 8 字），不得概括`
- `fact-extraction/dedupe.ts:99`：`evidence.length < 8` ⇒ **丢弃**
- `fact-extraction/dedupe.ts:127`：按 evidence 指纹**去重**
- `postgres-repository.ts:6114 recordMemoryClaims`：写入 `memory_claims` 与
  `memory_claim_sources`，**两处都不含 evidence**（列清单实测确认）

⇒ evidence 是**写入前的过滤与去重凭据**，落库即弃。
而 `fact-memory.yaml` 原措辞是"每条事实都要有正文逐字证据、来源段落和 novelty 判断"
——读起来像**持久保证**。这是 round 15 的同族：**"不阻塞主路径"与"不留痕迹"是两件事**；
过滤做了，痕迹没留。后果是提取模型会以为"证据已存档、事后可查"，
从而在不该泛化处泛化（一次性描写 → 永久规则）却无人能在事后核对。

**③ 修复（`fact-memory.yaml` 1.0.1 → 1.1.0，两个执行点同步）**：
把"要求有证据"改写为"**证据的边界**"——说明它只是写入前凭据、不被持久化、
落库后无法回溯核对（能回溯的只有 revision/工件来源），并给出可执行的替代约束：
"写证据时按**将来不可核对**的标准自我约束：宁可少沉淀一条，也不要沉淀一条
自己都找不到原文支撑的"；来源链接必须真实（记忆可见性谓词依赖它）。

**④ 回归锁**（`skill-runtime.test.ts` 新增 1 例）：spec 须含"不被持久化"、
"无法回溯核对"、"将来不可核对"；**反向**不得再出现
"每条事实都要有正文逐字证据"这种听起来像持久保证的措辞；人物增量的同一边界也要在。
**反向实测**：改成"被完整存档、随时可核对" ⇒ 判红（已跑）。

**本轮可复用判据**：
1. **spec 的措辞要与数据模型一致**——spec 说"要留痕迹"，就得确认那痕迹**真的在库里有一列**；
   否则 spec 是在承诺一个交付不了的保证，而读者（模型）会按保证行事。
2. **追一个字段的去向，比追一个流程的去向更能发现问题**："流程对不对"要跑全链，
   "这个字段最后落在哪"只要 grep 落库语句；本轮的真问题就是在 grep 落库 SQL 时撞见的。
3. **代理指标失效时，先问"我测的是不是我以为的那个字段"**——89% 这种荒谬命中率
   通常不是"问题很严重"，而是"我测错了对象"。
### 8.37 复核轮 round 39（2026-10-14）：把 round 38 的缺陷类别扫全仓——无新增，但把扫描固化为守卫

round 38 用"**追一个字段的去向**"在 `fact-memory.yaml` 抓到一处 spec 承诺了
数据模型交付不了的保证。本轮把该类别**扫全部 12 个 skill**。

**① 扫描**（`tmp/state-audit/audit-skill-promises.mts`）：判据是结构性的——
抓含承诺动词（要/必须/须/不得/禁止）+ 机制词（落库/存档/留痕/校验/拦截/计入…）的句子，
再对照是否有对应落点。12 个 skill、304 个生产源文件 ⇒ 9 个承诺句、6 个候选。

**② 人工判读 6 个候选，结论是"无新增同类缺陷"**：
- `fact-memory` 的证据边界——round 38 **已刻意澄清**过（不再是承诺）；
- `narrative-continuity` 的"报告为证据越界"——**承诺可交付**：审核 issue 的 `rule` 字段
  落库到 `chapter_review_snapshot`（`chapter-review-snapshot.ts:58/116`），可回溯；
- "叙述者与视角人物的知识量不得超过正文已呈现的证据"——行为要求，非持久保证；
- `prose-craft` 的"不可据此认为可以写总结段"——行为要求；
- "序数不得被理顺"——行为要求，round 30 已给实测依据。

⇒ round 38 那处是**个案而非类病**（如实记录，不把一说成普遍——同 round 32 的处置）。

**③ 落地：把扫描固化为常态守卫**（`skill-runtime.test.ts` 新增 1 例）：
对 7 个执行点断言——不得出现 round 38 那种"逐字证据 + 来源段落"的组合措辞；
且一旦提到"逐字证据"，必须同段说明其边界（不被持久化 / 无法回溯 / 将来不可核对）。
**反向实测**判红（已跑）。
审计脚本也把人工判读结果写进注释，后续 spec 增改后重跑即可看候选是否变多。

**本轮可复用判据**：
1. **一次个案发现要立刻问"这是类病吗"**——扫完得到"无新增"同样是有价值的结论，
   它把"担心类病"变成"已核实过"，且扫描脚本可复用。
2. **判"承诺可交付"要找到具体落点，而不是凭语感**：narrative-continuity 那条
   看起来也像"系统会留痕"，但追到 `chapter_review_snapshot` 的 `rule` 列才确认它真能。
3. **固化守卫时要抓"措辞组合"而不是单个词**：只抓"逐字证据"会误伤合法用法
   （round 38 的澄清段落自己也含这个词）；抓"每条事实都要有…来源段落"这个
   **完整承诺句式**才不会自我误伤。
### 8.38 复核轮 round 40（2026-10-14）：reader-emotion 首次取证——零值确认 + 代理边界

Round 37-39 把 skill 轴的**落点形态**与**承诺可交付性**扫干净了。本轮回到
"12 个 skill 里只有 2 个有实测"这个最大缺口，取 `reader-emotion.yaml`
（三面共用、required，从 1.1.0 起从未单独取证）取证它最关键的一条：
**情绪由承载物给出还是由宣告词给出**。

**① 实测**（`tmp/state-audit/measure-emotion-carry-vs-announce.mts`，
判定=情绪词所在句及其前后句是否含承载物/抽象名词）：

| 指标 | 全书 | 合格带 | 混合带 | **最强带** |
|---|---|---|---|---|
| 情绪词（每千字） | 0.054 | 0.041 | 0.167 | 0.012 |
| **宣告型**（每千字） | 0.001 | **0** | 0.007 | **0** |

宣告型**全书仅 1 处**，合格带 0、**最强带 0**。⇒ 与 round 33 的问句收尾、
round 36 的总结连接词同族的**零值确认**：**这条禁令从未被真正触发过**——
本书本来就不宣布情绪。

**② 代理边界必须一起写**（round 36 的同族教训）：情绪词基数只有 **27 处**，
因为本书的情绪主要由动作、物件、空间承担（正是本条要求的），
所以"以情绪词做分母"的密度指标**没有分辨力**。
不写这条，后人会误读成"情绪浓度低＝缺情绪推进"——
而真相是它靠承载推进，且最强带宣告为零。

**③ 顺带厘清一个口径冲突**：章内疑问句 0.566/千字
（最强带 0.275、混合带 1.048）**是有的**，与 round 33 的"章尾问句全书 0 处"
**不矛盾**——禁的是**收尾**问句钩子，不是章内疑问。两个口径必须分开陈述，
否则同一份 spec 里会出现自相矛盾的指示。

**④ 落地**：实测与代理边界写进 reader-emotion（1.1.0 → 1.2.0）；
回归锁新增 1 例，钉住"零值实测 + 没有分辨力 + 不得读成情绪越少越好 + 两个口径区分"。
**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **"零值确认"与"代理失效"要同时报**——只报前者会让后人以为该禁令可无限收紧，
   只报后者会显得这轮没结论；两者一起才构成完整的取证报告。
2. **同一指标的两个口径必须显式区分**——章内疑问 vs 章尾问句、总结连接词 vs
   总结段，都是"看起来同类、实则不同"的口径；不区分就会在 spec 里留下自相矛盾的指示。
3. **skill 轴的覆盖面可以用"有实测的 skill 数"量化**（本轮 2/12 → 3/12），
   这比"审了多少轮"更直接地说明还剩多少没做。
### 8.39 复核轮 round 41（2026-10-14）：review-gate 十项核验——承诺兑现，但 skill 清单落后 prompt 两项

Round 40 把 skill 轴实测覆盖推到 3/12。本轮取 `review-gate.yaml`
（管控全部五个审核执行点的 required skill，1.0.0 起从未取证），
核它分量最重的承诺：foundation 审核的**八项读者向检查是"检查方向而非硬门"**。

**① 首版核验方法错在先（本会话第 N+1 次同族）**：用**字面子串**比对 skill 措辞与
审核 prompt 措辞，得出"8 项只到 2 项"——这是错的。prompt 用了**不同标题表达同一内容**：

| skill 措辞 | prompt 标题 |
|---|---|
| 欲望-阻力-选择-代价闭环 | **最小动力闭环** |
| 配角独立欲望与关系网络 | **群像独立** |
| 世界观规则改变人物可选集合 | **世界观压力系统** |
| 感情线靠行动累积而非宣言 | **感情线行动累积** |
| 重复与升级是否改变层级/意义/代价 | **疲劳管理** |
| 读者不确定性是否有可推断证据 | **留白证据** |

改为**语义对应**后：**8/8 全部兑现**（`verify-review-gate-eight-items.mts`）。
⇒ 又一次"判据用错对象"：**规格与实现的措辞不同不代表内容不同**，
字面比对会把"换了个说法"误判成"没做"。

**② 硬门边界也核了（承诺的另一半）**：八项只出现在审核 prompt 的检查方向段
（`foundation-review.ts:14` 明写"不是必须全部成立的硬门…不因缺少某项扣分"），
而 `foundation-contract` 的 error 级门只有**结构契约字段**（entryState/exitState/
pressures/promiseWindows/povStrategy/timeSpan）⇒ "该软的软、该硬的硬"成立。

**③ 但反向核出一个真缺口**：prompt 有 10 个检查项，skill 只登记 8 个——
**表层大众化**与**揭示物分层**两项 prompt 早在跑、skill 从未登记。
这是 round 38 的同族（spec 落后于代码/提示词），但方向相反：
那次是 spec 承诺了交付不了的，这次是**交付了却没写进 spec**。
后果是维护者看 skill 会以为只有八项，改 prompt 时也不会想到同步 skill。

**④ 修复（review-gate 1.0.0 → 1.1.0）**：八项补齐为**十项**，并写明
**口径对应关系**（skill 措辞 ↔ prompt 标题），附"口径对应已核验"的取证路径。
**回归锁**新增 1 例，**双向**都钉：skill 须含两项新增与十项措辞、
须写明口径对应；**反向**断言 prompt 里十个锚点都在（防 skill 单方面膨胀）。
**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **规格与实现的对应要按语义核，不按字面核**——否则"换了说法的同一件事"
   会被判成缺失（假阴性），而真正缺的两项反而被 8:2 的噪声盖住。
2. **同步性要两个方向都查**：spec 超前于实现（round 38：承诺了没有的）与
   spec 落后于实现（本轮：实现了没写的）都会造成维护误判，
   后者更隐蔽——因为功能是好的，只是没人知道它已成契约。
3. **"软/硬边界"值得单独取证**：一个 skill 说"这不是硬门"时，
   要真的去数 error 级门里有几项、是不是只有该硬的那几项。
### 8.40 复核轮 round 42（2026-10-14）：反向同步缺口扫到维度纪律型——抓到一条有实证历史的未登记纪律

Round 41 用"同步性要两个方向都查"抓到 review-gate 落后 prompt 两项（列表型检查项）。
本轮把该类别扫到 **chapter-review 的维度纪律型**检查项。

**① 首版审计报了个假零**：抽取规则只认 `- 标题：` 形态，而 `chapter-review.ts` 的
检查项是 `DEFAULT_REVIEW_FOCUS` 里的**维度型长句**（D1 世界观 / D2 故事性 / D3 群像 /
D4 感情线 / D5 幽默 + 具名纪律）。首版只覆盖 foundation-review ⇒ "0 未登记"只测了一半。
**自检当场证明它坏了**：往 `chapter-review.ts` 注入一条任何 skill 都不登记的探针项，
审计**没有报出来**（两版探针都不响）。这正是 round 27 那条判据（"扫出 0 个"和
"扫出一堆"一样需要自检）第二次救场。

**② 补上第二种形态后拿到真数据**：抽出 **31** 个检查项（列表型 2 个 prompt 文件 +
维度纪律型 3 个执行点），其中 14 项"完全未登记"。**人工按职责边界判一次**后：
- **真缺口 2 项，且都属于 `review-gate`**：
  - **验收点核实纪律**——prompt 早在跑（`chapter-review.ts` 的 `lines.push`），
    而且**有实证历史**：2026-09-11 修订轮评审把上一轮问题当作结论复述、摘录引用修订前文本，
    **导致连续多轮 revise**。而 `review-gate.yaml` 里对该纪律 **0 处提及**
    （"验收点/待核实/复述/修订目标"全部 0 命中）——**一条带事故史的审核纪律
    完全没进 skill**。
  - **跨章序列证据**——同为 review-gate 的审核判据（含"安静章不是缺陷"的边界），未登记。
- **假阳性 12 项**：prose 专属纪律（读者现场复原契约、技术标签删除测试、术语降噪、
  跨章重复命名）被我的角色无关清单按到了 character/structure 角色上——
  它们确实已在 `prose-craft.yaml` 里，不该进 character skill。
  ⇒ **角色边界要人工判，不能只靠脚本**。

**③ 修复（review-gate 1.1.0 → 1.2.0）**：把两条纪律登记进
`chapter.review.structure` 段（含"逐条对照当前正文重新核实""不得沿用历史摘录"
"不把单个安静章当作问题"这些可执行边界），并写清其历史依据。
**回归锁**新增 1 例：skill 须含这两条纪律与关键边界；**反向**断言 prompt 里真在跑
（防 skill 单方面膨胀）。**反向实测**判红（已跑）。

**本轮可复用判据**：
1. **一种抽取规则覆盖不了多种形态**：检查项在代码里有"列表型"与"维度纪律型"两种写法，
   只按一种写抽取器就会得到**假零**——而假零比假阳性更危险（它看起来像"没问题"）。
2. **探针自检要打到"真的读不到的那种形态"上**：往列表型 prompt 注入探针可能仍然不响
   （因为读不到维度型），要分别对两种形态各注入一次。本轮正是第二次注入才暴露真相。
3. **带事故史的纪律必须进 spec**：验收点核实纪律背后是"连续多轮 revise"的真实事故，
   它却只存在于 prompt 字符串里——**spec 缺席的纪律，在维护者改 prompt 时最容易被删掉**。
### 8.41 复核轮 round 43（2026-10-14）：复核 round 42 判读——自证式验证挡住了一次"六项假推翻"

Round 42 判了 14 项反向同步缺口中 12 项为角色错配假阳性、2 项为真缺口（已补）。
本轮**复核那次人工判读**是否成立——结果自证式验证当场挡下了一次会把 6 条正确登记
**改坏**的误操作。

**① 复核脚本连报两轮"6 条全推翻"**（含我明知已登记的"验收点核实纪律"，
round 42 刚写进 review-gate.yaml L44）。两轮的原因分别是**两个独立的脚本 bug**：
1. **自检词错**：用中文"版本"做读取自检，而这些 yaml 用的是 `version:` 字段名
   ⇒ 自检报"读取失败"，连带把 6 条全判成推翻；
2. **map 键错**：`skills` 以带扩展名的文件名（`review-gate.yaml`）为键，
   而查询用不带扩展名（`review-gate`）⇒ `get()` 返回 `undefined` → `?? ""` → 空串 → 全不命中。
   **一个键名不一致，就把"全部正确"翻转成"全部错误"**。

**② 逐字比对证明文件没问题**：用独立脚本对同一文件做逐字扫描，
`验收点核实纪律` 在位置 **1694** 命中、`includes` 也返回 true；map 路径与直读路径
**长度 2278、内容、命中位置完全一致** ⇒ 文件与读取都对，错的全在比对脚本。

**③ 修正后结论**（`re-verify-round42-judgments.mts`，自证式：每条都打出逐字命中位置）：

| 项 | 归属 | 命中候选词 |
|---|---|---|
| 读者现场复原契约 | prose-craft | 上下文复原 / 读者是会失去一个可观察的线索 |
| 技术标签删除测试 | prose-craft | 删掉技术句后 / 删去多余部分 |
| 术语降噪（局部冗余） | prose-craft | 删去多余部分 / 不保留它 |
| 跨章重复命名 | prose-craft | 多个比喻重命名 / 重命名 |
| 验收点核实纪律 | review-gate | 验收点核实纪律 / 逐条对照当前正文 |
| 跨章序列证据 | review-gate | 跨章序列证据 / 连续同类功能章节 |

⇒ **round 42 的人工判读全部成立**：这些项确已用别的措辞登记，不是缺口。

**④ 真正的教训不是"脚本有 bug"，而是"错误的复核会指向反方向"**：
如果按那两轮输出行事，我会去给 6 条已正确登记的判据**补写重复内容**——
而"同一条判据写两遍"恰是 round 37 整治过的"同一契约两处口径"隐患。
**一个读起来很确定的假阴性（"6 条全未登记"），比"0 条"更危险，
因为它会驱动实际改动。**

**本轮可复用判据**：
1. **复核工具也要先自证**：用一个**已知答案**的条目（round 42 刚补的纪律）
   跑一遍复核脚本——第一轮就该发现"连这条都报未命中"是不对的。
   **已知答案的对照组，是任何复核工具的最低配置。**
2. **map 键不一致是最隐蔽的翻转源**：`get(k)` 失败返回 `undefined`，
   经 `?? ""` 兜底后**不报错、不告警**，只安静地给出空结果——
   所有"全未命中"的结论都要先排除这一类静默兜底。
3. **"全部推翻"本身就是警报**：与"全部通过"一样，"全推翻"意味着判据或工具
   大概率有问题（真实缺陷通常分布不均）。**极端一致的结果要先怀疑工具。**











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
