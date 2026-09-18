# P1 调研与落地：伏笔账本真实状态（2026-09-18，结论版）

> 数据来源：真实库 `ymcp@127.0.0.1:5432/ymcp`，项目 `novel-spirit-code-rev-create-20260806-v1`（168 章定稿）。
> 脚本：`tmp/p1-survey.mts`、`tmp/p1-note-anatomy.mts`、`tmp/p1-features.mts`、`tmp/p1-shapes.mts`、
> `tmp/p1-gap.mts`、`tmp/p1-shared.mts`、`tmp/p1-rootcause.mts`、`tmp/p1-silent.mts`、
> `tmp/p1-dormancy.mts`（模块验证）、`tmp/p1-e2e.mts`（端到端）。

**这份文档记录了两次被真实数据推翻的假设。两次证伪都保留在案，因为它们比结论本身更有复用价值。**

---

## 一、账本规模（推翻 P1 方案的三处前提）

| 指标 | 实测值 |
|---|---|
| foreshadowing 总数 | **717** |
| open | **427** |
| merged / abandoned | 111 / 106 |
| fulfilled | **63**（不是 0） |
| 有 `expectedPayoffWindow` | 707 / 717 |
| 可算出 chapter horizon | 494 |
| horizon < 当前章（168），旧口径报"过期" | **465** |
| open 且"过期" | **244** |

| P1 原假设 | 实测 | 影响 |
|---|---|---|
| "`openPromises` 只是投影给模型看，需新建账本" | 已有 `foreshadowing` 独立账本 + `parsePayoffWindow` 谓词 + overdue 判定 + `dueLedger` 回流规划面 + `triageForeshadowing` 分流工具 | P1 方案 1/2/4 条**基本已实现** |
| "需要给伏笔加到期日字段" | **字段早已存在**（`expectedPayoffWindow.to`/`count`），707/717 已填 | 加字段是**错的解法** |
| "001-014 钩子全无落定" | 方向对但不精确，见 §四 | 目标需重新表述 |

---

## 二、假设一（被证伪）：**"期限是抽取模型编造的"**

### 2.1 当初的证据看起来很强

`horizon - 埋设章` 的差值分布（494 条可判定）：

| delta（章） | 条数 | 占比 |
|---|---|---|
| **10** | **160** | 32% |
| **5** | **75** | 15% |
| 15 | 34 | 7% |
| 20 | 20 | 4% |

delta∈{5,10} 合计 **47%**；且 `horizon=120` 一族（63 条）的埋设章横跨 ch2→ch92。
一条 ch2 埋的与一条 ch92 埋的共享同一 horizon，看起来只能是"按弧预算取整"的产物。

### 2.2 据此写了判据 `assessHorizonCredibility`——**实测命中 0 条**

判据形态：「`note` 为空 **且** `count` 落在取整档 {5,10,15,20,30,50,100}」→ 判为编造。

`tmp/p1-effect.mts` 结果：**`overdueOld=244 overdueNew=244 fabricated=0`**。

原因在 `tmp/p1-note-anatomy.mts`（717 条形态解剖）里一目了然：

| note 与 count 的关系 | 条数 |
|---|---|
| note **复述**了 count 的数字（如 `{"count":5,"note":"5章内"}`） | 143 |
| note 未复述 count（真实叙事短语，如 `"验格时丙册去向"`） | 297 |
| note 为空/缺失 | 167 |

**假设的前提（note 空缺）根本不存在**——真实 payload 大多填了 note，只是这个 note
经常是**同义反复**（复述数字）而非正文引用。判据在第一个条件上就短路了。

### 2.3 更关键的证据：那个"编造的期限"其实是对的

`tmp/p1-groupverify.mts` 用 `triggerKeywords` 在 plant 章之后的正文里做提及扫描：

| 分组 | 条目 | 平均后续被提及章数 | 后续零提及 |
|---|---|---|---|
| `win=92..120` | 46 | **31.1** | **0 条（0%）** |
| `win=120..148` | 39 | **30.5** | **0 条（0%）** |
| `count=10` | 72 | 9.2 | 5 条（7%） |

被怀疑"批量编造"的 `92..120`/`120..148` 组，**是全书最活跃的长线**——
平均被后续 31 章提及、无一条死亡。假设二就此彻底翻案。

---

## 三、假设二（也被证伪）：**"`overdue` 度量的是该兑现没兑现"**

### 3.1 244 条 overdue 的活跃度分层

`tmp/p1-rootcause.mts`（活跃度 = 关键词在 plant 后被提及的章数；"末20章仍提及" = 末 20 章内出现过）：

| 活跃度 | 条数 | 占比 | 末 20 章仍提及 |
|---|---|---|---|
| 沉睡（0 章） | 6 | 2% | 3（50%） |
| 弱（1-4 章） | 21 | 9% | 13（62%） |
| 中（5-19 章） | 102 | 42% | 76（75%） |
| **强（≥20 章）** | **115** | **47%** | **108（94%）** |

按形态分：

| 形态 | 条数 | 平均后续提及 | 末 20 章仍提及 |
|---|---|---|---|
| from..to 窗口 | 117 | **35.3** | 83（71%） |
| count 窗口 | 127 | **21.7** | 117（92%） |

**244 条"过期"里，238 条仍在活跃推进；真正沉睡的只有 6 条。**

### 3.2 真正根因：`parsePayoffWindow` 把窗口上界当死线

`narrative-elements.ts:180` 的 `parsePayoffWindow` 对 `{from, to}` 形态：

```ts
const to = typeof value.to === "number" ? value.to : null;
if (count !== null && plantedOrder != null) return { kind: "chapter", horizonOrder: plantedOrder + count };
if (to !== null) return { kind: "chapter", horizonOrder: to };   // ← 丢弃 from，把上界当唯一期限
```

而全部 4 处消费方都把它当**死线**用（`currentNarrativeOrder > window.horizonOrder` → overdue）。

**`to` 是窗口的结束点，不是该条线索的到期日。** 对连载而言，
"长线伏笔越过自声明窗口上界而继续运行"是**正常且健康**的形态，不是欠债。
旧语义把它报成 warning 并要求作者"兑现/改写/放弃"，等于指挥作者去处理 238 条不存在的问题。

对照 `tmp/p1-shared.mts`：118 条 from..to 里，98 条（83%）的窗口值被 ≥6 个条目共用，
其中 `92..120`（46 条）与 `120..148`（39 条）两个巨簇占 72%——**这些是按弧统一标注的窗口**，
本就不该按"该条伏笔的私人死线"解读。

### 3.3 落地：拆成两个诚实的字段

| 字段 | 含义 | 性质 |
|---|---|---|
| `windowElapsedCount`（原 `overdueCount`） | 窗口上界已过的可判定条目数 | **中性事实**，不报为 issue |
| `narrativeDormancy.silent` | 曾活跃、现已在近 N 章消失 | **需要行动**的信号 |

`foreshadowing-overdue` 这条 warning 被移除（改用中性字段陈述）；
`foreshadowing-fabricated-horizon` 与 `assessHorizonCredibility` 一并删除。

---

## 四、真正的缺陷形态：**曾活跃 → 静默终止**

### 4.1 判据（`src/novel-v2/narrative-dormancy.ts`）

确定性字符串包含扫描，零模型调用。逐条把 `triggerKeywords` 在 plant 章之后的各章正文中查找，
得"提及章序序列"，据此分层：

- `never-mentioned`：埋设后从未再出现（抽取即孤儿）
- `silent`：曾出现 → 末次提及距今 ≥ `DORMANCY_POLICY.silentWindow`（20 章）
- `running`：近期仍在推进
- `unmeasurable`：无埋设章序 / 关键词为空或全为单字（不猜）

泛化红线：不用题材词表、不嵌角色名；判据只用「(埋设序, 提及序序列)」这一结构 + 一个章数窗口。

### 4.2 全书实测结果

`tmp/p1-silent.mts`（手写实现）与 `tmp/p1-dormancy.mts`（真实模块）**逐数一致**：

| 状态 | 条数 | 占 open |
|---|---|---|
| never-mentioned | 15 | 4% |
| **silent** | **66** | **15%** |
| running | 346 | 81% |

静默带分布（按末次提及章分桶）——**53/66 集中在末次提及 ch120-159，是"成片失线"**：

```
20-39    3   40-59    3   60-79    3   80-99    2   100-119  2
120-139 37 #####################################
140-159 16 ################
```

### 4.3 与人工阅读 ground truth 的吻合

静默最久的清单与本次会话早前**人工逐章阅读**独立发现的完全一致：

| 埋设 | 末次提及 | 静默 | 线索 |
|---|---|---|---|
| ch3 | ch22 | 146 | 引气诀折返缺陷是功法固有缺陷（十二正经/奇经八脉冗余） |
| ch20 | ch30 | 138 | 齐姓人的气息遮蔽（"和一块石头没有区别"） |
| ch34 | ch42 | 126 | 树洞内淡蓝色微光对齐姓人有感应 |
| ch14 | ch46 | 122 | 《引气诀》的"致命缺陷"可能是监控机制 |
| ch27 / ch36 | ch60 | 108 | 齐姓人朝老槐树瞥的那一眼；界碑告发词来源 |

人工当时的结论是"**齐姓人在 ch60 后再无戏份；树洞/蓝光在 ch34-42 后消失且从未解释**"。
判据精确复现了这两条。**这是该判据最重要的验证证据——它不是自证，而是与独立人工判读对齐。**

### 4.4 端到端（走真实活动路径，不复制逻辑）

`tmp/p1-e2e.mts` 直接 `import` 生产活动工厂，让活动自己读 DB + MinIO：

```
[1] loadNarrativeDormancy 返回：有账
    当前章=168  measured=427
    silent=66  neverMentioned=15  running=346  unmeasurable=10
[2] 记忆化：第二次调用 === 第一次结果引用？是（命中缓存）
[3] 提示词段 arc-context-dormancy：已注入（priority=required，2252 字）
```

段内实际渲染出的静默清单，正是 §4.3 的那几条。**通道通且有效，不是"接线正确但判据静默"。**

（`unmeasurable=10` 是因为活动侧取的是全部 open 行，含 `narrative_order IS NULL` 的 10 条——
与独立脚本用 `narrative_order IS NOT NULL` 过滤后的 0 条差值，属预期口径差异。）

---

## 五、落地清单

| 文件 | 变更 |
|---|---|
| `src/novel-v2/narrative-dormancy.ts` | **新增**。`DORMANCY_POLICY` + `assessNarrativePresence` + `summarizeDormancy`（叶子纯模块，无 node 依赖） |
| `src/novel-v2/narrative-elements.ts` | **删除** `assessHorizonCredibility` / `HorizonCredibility` / `ROUND_HORIZON_COUNTS`，改留废弃说明（记录两次证伪） |
| `src/novel-v2/postgres-repository.ts` | `overdue` → 中性 `windowElapsed`；移除 `foreshadowing-overdue`/`foreshadowing-fabricated-horizon` issue；`dueLedger.overdueCount` → `windowElapsedCount`；**新增** `listFinalChapterContentRefs`、`listOpenForeshadowingPresenceInputs` |
| `src/novel-v2/temporal/activities.ts` | **新增** `loadNarrativeDormancy`（局部 helper + 按 projectId 记忆化，null 哨兵）；三处 `getStoryArcPlanningInput` 消费点附加 `narrativeDormancy` |
| `src/novel-v2/temporal/workflows.ts` | 活动接口新增 `loadNarrativeDormancy` |
| `src/novel-v2/prompts/story-arc.ts` | `narrativeDormancy?: DormancyLedger`（复用单一真源，不做平行投影）；**新增** `renderStoryArcNarrativeDormancy`；`renderStoryArcDueLedger` 文案改为中性（不能说"超期/欠债"） |
| `src/novel-v2/fact-extraction/prompt.ts` | 移除 `例：{"scope":"chapters","count":5,...}` 工作示例；新增"判断不出时机填 unbounded、禁止为填满而编造"指引 |
| `src/novel-v2/prompts/schemas.ts` | `expectedPayoffWindow` 各键 description 明确"须有依据、禁止编造" |
| `src/novel-v2/__tests__/narrative-dormancy.test.ts` | **新增** 13 个测试（含窗口边界双向、乱序、1 字词过滤、假阳性反例） |
| `src/novel-v2/__tests__/prompts.test.ts` | 到期账测试改为中性语义断言（含"不得出现『已超自声明窗口上界』"负向断言）；新增静默账测试 |

prompt/schema 侧（止住编造）保留：即使"期限是伪造的"这一命题被证伪，
"**判断不出时机时应填 unbounded，而非为填满字段取整**"仍然独立正确——
它减少的是无依据的取整值，与 §三 的语义修正互补。

---

## 六、与方法论对照（P0 + P1 的共同教训）

| | P0 ending-ritual | P1 伏笔契约 |
|---|---|---|
| 原方案假设 | "代码已写好，只差接线" | "缺字段/缺告警/缺工具" |
| 第一次实测 | 代码在，但**判据测不到目标**（bigram 相似度峰值 0.294） | 字段/告警/工具**全在** |
| 第二次实测 | 换成"末句短促占比"后与人工标注吻合 | **连"编造期限"这个命题本身也是错的**：244 条 overdue 里 238 条在活跃推进 |
| 共同教训 | **先验证既有机制是否真的在工作，再决定要不要新建** | 同 |

> **三个错误都是同一个形状：把"缺少某个机制"当成了问题，而实际是"机制存在但语义/判据错了"。**
> 并且两次都出现了"判据看着合理、在真实数据上命中 0"——
> 这正是 P0 记录的"**激活但永久静默的通道比显眼的死代码更危险**"。

**推论（已写入 skill）**：凡新增门/判据，必须先用真实语料测出**命中数**与**与人工判读的吻合度**，
二者缺一不算完成；命中 0 不是"语料干净"，而是判据失效的强信号。
