# novel-v2 全链路产物审核（2026-09-10）

> 审核方法：五层并行审核（创作指引 / 全局规划 / 事实记忆 / 正文内容 / 项目调度），全部结论基于对权威库（PostgreSQL/MediaTek 容器实查）、REST 只读接口、Temporal CLI、代码与 `tmp/audit/` 数据导出（44 份表快照 + 21 章正文）的实测；关键 P0 结论由父会话独立复核（复核记录见各条"✅已复核"）。
> 分层原始报告：正文 `tmp/audit/review-ch01-21-20260910.md`（PR-*）；其余四层结论以本报告编号为准（SK-* 指引 / PL-* 规划 / FM-* 记忆 / OR-* 调度）。
> 前序关联文档：`novel-quality-review-20260907.md`、`chapter-review-20260908.md`、`docs/novel-v2/memory-governance-audit-20260909.md`、`docs/novel-v2/pipeline-audit.md`。

---

## 一、总体结论

**系统骨架是健康的**：执行点投影无孤儿、Temporal 无重试风暴放大、content_hash 精确去重有效、记忆治理 9/9 修复方向正确、21 章 ch16–21 单章文笔已达可发布线（均分 4.47/5）。

**但存在一条贯穿五层的主因果链，它解释了本轮正文审核中"跨章账本失控"的全部现象：**

```
指引层晋升通道断裂（promote 写 DB、运行时读 yaml，0/26 晋升）
  ⇒ 规则改进只能手改 yaml，无回归、无旧章处置回路
      ↓
上下文供给失真（退役只管检索一条路径：起草 bundle 仍带 20–29 条 stale 规划投影；
  候选事实"盲杀"可见事实：32 条 derived 被 candidate 整槽退役；
  fact facet 里规划:真事实 ≈ 97:3，ch21 起草 64K 预算中事实层仅 379 token）
  ⇒ 写作者与三审拿到的是同一份残缺、方向错误的账本
      ↓
正文跨章事实失控（条款互斥、道具五说、时间三套账、能力来历四版本——
  单章文笔在进步，章间接缝每接必崩，三审结构性无拦截面）
      ↓
学习信号产生但无出口（137 评估 → 26 候选 → 0 promote；守卫触发不可观测；
  16.5% 调用失败中 64.6% 是静态死路由配置产物）
  ⇒ 成本与质量决策都缺依据，闭环只进不出
```

规划层自身另有两枚独立 P0：**弧完成判定量纲错误**（弧 2 缺 7 章仍被判 completed）与**引用字符串自我放大**（4 条影子剧情线正以 `kind:"fact"` 逐轮嵌套扩散进全书状态快照）。

**一句话**：单点能力（文笔、审校、重试、去重）普遍达标，**接缝与流通**（版本退役、候选审批、执行点映射、晋升回流、跨章账本）系统性断裂。本轮优化应全部落在"流通机制"，不应落在任何个案规则。

---

## 二、做对了的（防偏颇基线）

1. **指引投影架构完整**：16 个执行点逐一验证有真实消费方，role/genre/conflicts 校验齐备，bundle 指纹全链路可追溯；h3 剧本 skill 与小说阶段隔离严密（无互注入）。
2. **Temporal 重试设计正确**：模型传输错误列入 nonRetryable，弧模型活动 `maximumAttempts:1`；实测 294 条死路由失败按任务键聚合 290/294 键仅 1 行——**没有**重试风暴放大 provider 故障。
3. **文本审核契约（单行 PASSED）落地后 schema 失败收敛**：全表 213 条中当前窗口仅 69；解析基于结构特征，符合泛化纪律。修复循环抬温可量化：2 次尝试键 90.8% 最终成功。
4. **9/9 记忆治理实效可证**：同章近重复对 473→49；content_hash 零全等；裸"楚衡"主体归一清零；Foundation 检索侧 56→5；enrichment 防误伤与谓词归一均落地。
5. **章节记忆与文笔纪律产出真实质量**：85/85 chapter_memories 非空、emotional_arc 21 章零重复、三章人工对账无幻觉；ch16–20 章尾全部收敛为"吹灯/一句确认"式收束，例供主线在 ch16–19 完成"盘点→救草→卖草→反抢→缴清"兑现闭环。
6. **验收策略多层**：structuralPassed > blocker > major > 最低分 > 均分的候选序 + `MAX_REVIEWER_SCORE_DROP=0.5` 局部退化守卫，且有作者据此真实回退的留痕。

---

## 三、合并发现清单（P0 优先；跨层互证标注）

### A. 上下文供给正确性 —— 本轮最重要根因簇

**A1｜FM-1（P0，✅已复核）候选事实"盲杀"可见事实，资产账本逆反**
- 提取器 novelty=update 时 classify 按 `subject|predicate` 整槽清扫 supersedes；事件累积型谓词（知晓/状态变化）与值槽型（持有/位于）不分。检索退役规则 `NOT EXISTS(newer.supersedes)` 不检查杀手自身 authority/可见性 → **candidate 行杀死 derived 行后两者双双不可见**。
- 实测：32 条 active derived 被 candidate 杀手退役（不同口径 77–83 条边）；实证链——ch19「缴清三块灵石欠项」(`b33a6d5f`) 被 ch21「旁路当前状态：略宽于初开辟」(`6dc18371`，完全不同主题、仅同 `char_chu_heng|状态变化` 槽) 退役；全书检索可见的灵石持有事实**只剩 ch1「持有两块下品灵石」**。
- 互证：这正是正文 PR-2（云纹草五章五说、资产回述漂移）与 PR-1（条款互斥）在机制层的直接解释——**模型不是不记得，是账本被删改后喂给它的就是错的**。
- 修复（机制级）：① supersedes 目标须提取器显式点名，且只对"值槽白名单"谓词（持有:某物/位于/修为）允许整槽清扫，事件累积型禁止；② 立泛化不变量"只有检索可见的声明才能执行退役"——四处退役口径（searchMemory/listIndexable/grooming/getFactExtractionContext）抽同一物化视图定义，并传递性检查杀手自身未被退役；③ 一次性可见性回归诊断（被不可见行退役的 active 行→回激活或转待审）。
- 回归风险：放宽退役会复活旧冲突值，必须与①同批落地。

**A2｜PL-3 + FM-6（P0，✅已复核）已批准大纲以"冻结事实"名义占满正文上下文，且 stale 代际仍进 bundle**
- 9/9 的"56→5 退役"只在 `searchMemory` 一条路径生效；弧 3 六章起草 preflight 实测每次包含 foundation claim 22–32 条，其中 **20–29 条是被取代的旧代际**。foundation 投影平均 2,170 字符/条，按 score 截断时反吃真事实预算。
- `prompts/chapter-draft.ts:105` 把每条 claim 冠 `冻结事实：<title>` 注入，规划投影复用 `kind:"fact"`——直接违反 CONTEXT.md"已批准大纲属创作契约，不属叙事事实"。后果可测：`books.title=灵气程序员`（17 个 positioning 旧版本里 16 个仍写旧书名），现行书名是"程序员也穿越了"；characters 15 个历史版本（含已被明令删除"内门弟子/直接管事"表述的旧卡）同时在场。
- facet 构成实测：draft/review/revision 的 fact facet 纳入 claim 中 foundation 投影 885 次 vs 真章节事实 26 次（≈97:3）；ch21 起草 64K 预算用 61.8K，其中 foundation 33.7K、伏笔 11.5K、事实层 379 token（0.6%）。
- 修复：① foundation claim 身份改段级单例 `foundation:<projectId>:<taskKey>`，新版本 upsert + supersedes，旧行置 superseded 终态（当前"lifecycle 仍 active、靠引用排除"是语义债）；**所有**上下文装配路径共用同一物化视图；② stage-context 增 `contract` kind，"冻结事实："前缀只留给真事实通道；③ 派生名（书名/卷名）从现行段重算，加单一派生函数与重批钩子。
- 边界：回溯旧版本须显式 `includeSuperseded`；kind 变更同步 `requiredMemoryKinds` 与 skill 定义。

**A3｜FM-2（P0）高风险事实人工确认整本书零运转，候选=事实坟场**
- 83 条 candidate（79 active+4 staged）人工裁决 0 条（decided_by 全部 runtime）；分布恰在中后期资产/伤势/认知高危章（ch6/16/21）。候选未泄入生成上下文（实测 123 bundles 交集=0，契约字面守住），但正式事实供给被抽走近半，且经 A1 反向破坏活账本。
- 修复：候选/待审队列升为 MCP 一等公民（按章聚合积压率）；memory-gate 增"候选积压率"facet（可配置阈值非硬门）；staged 重建残骸与同槽 active 新行自动 Dice 对账（grooming 已有能力缺触发）。

**A4｜PL-2（P0，✅已复核）引用字符串自我放大 + 无标题/字段卫生层**
- 弧 3 threadRef 值为 `<完整threadId> <slug>` 复合串 → `normalizeStoryArcReferences` 按"未知名"auto-create 4 条影子剧情线（title=输入串原样）；85/85 全书快照 openThreads 携带复合串，其中 20/85 已二重嵌套，且以 `kind:"fact"` 回灌上下文；`architecture/health` 对全部引用报 resolved（自己审批自己新建的行，永久失明）。弧 3 标题 `弧3：…` 回显污染；arc3 entryState 内联 `promise:5f6af0ca7b95`、`ch11` 等内部码；全仓无任何标题净化/卫生函数（grep 0 命中）。
- 修复：① 引用字段 schema 收敛 canonicalId enum 白名单（原生 json_schema 强制），上下文里 id 与显示名分行呈现，从源头消灭"可复制复合串"；② 取消未知名静默 auto-create，改 blocking `unresolved-reference` 回流 planner；③ 通用结构净化：前导序号标签剥离（`^弧\d+[:：]` 类形态规则，非词表）、自由文本内联 id 形态检测报 issue 交作者、行尾孤立标点残片截断；④ health 区分 `resolved-existing`/`resolved-newly-created`，title 含 hex/projectId 形态直接 major。
- 回归风险：须留显式"新建线"通道；序号剥离限定"序号+冒号"前缀防误吃"第一章"合法标题；存量影子行一次性 re-index。

### B. 规划产物治理

**B1｜PL-1（P0，✅已复核）弧完成判定量纲错误：全局章序 vs 弧内期望直接比较**
- `postgres-repository.ts:566-576` 以 `b.end_chapter_index >= expectedChapterCount` 判完成。弧 2：expected=15（弧内）、batch end=15（全局序）、实际仅 8 章（ch8–15）、`complete=false` 仍被置 completed——**缺 7 章、4 个 phase 设计意图腰斩，无 rebase/abandon 记录**；弧 1 巧合正确、弧 3 恒真。`story-arc.ts:305` 已有"completed 弧 expected=实际章数"不变式但只在 rebase 入口生效。
- 修复：单一派生量 `arcLocalChapterCount`（end−start+1 或 COUNT 实际章节）统一所有弧长比较；"completed 但 expected≠实际"升为可诊断 issue 强制 rebase 回写；不变式加双向测试（缺章不得 completed、人工 complete=true 优先）。
- 907 报告"弧 2 resolution 缺口"的根因至此找到：不是收口审核没拦（收口候选已在排队），而是**弧被算术 bug 提前宣告完成**，收口核对根本没机会在弧内跑。

**B2｜PL-5（P0）伏笔账本账面失真，作为追读决策依据不可用**
- 138 行实测：thread_id 关联 0/138（与 8 条剧情线完全脱钩）；3 条 fulfilled 无兑现修订；窗口为 24 种自由文本（6 种不可解析），按自身窗口上界 31 条已超期而 health 零报告；payoffs 表仅 2 行且全为 promise——33 条 fulfilled 伏笔在兑现账里一条没有；重复登记：Dice≥0.5 共 16 簇/41 行（登记身份=描述文本哈希，每轮重抽取换措辞即多一行）；回收间隔 median=1 章、2 条"兑现章=埋设章"、长程窗口 0 兑现；弧级物化 6 行 open 无绑定，2 行成孤儿。
- 修复：① 窗口结构化 `{scope, from, to}` schema 强制；② fulfilled 只能由 payoffs 记录同事务驱动（单一兑现入口）；③ 登记身份改锚点键 `(document_id, normalized_anchor)`，多轮重抽取按锚点归并（union keywords，保留 mergedFrom）；④ thread_id 由弧 `threadResponsibilities↔foreshadowingRefs` 共现回填；⑤ health 增 overdue/unbound/fulfilled-without-payoff/arc-orphan/cross-chapter-duplicate 五类计数。

**B3｜PL-8（P1）Foundation 契约校验在批准路径缺席；"作者秘密"只有散文没有对象**
- 批准只做状态翻转，不跑 `validateFoundationTaskContract`（校验只在生成重试循环）：键名漂移（`hiddenInformation` vs 契约要求 `hidden`）、integer 数组装 "V1"、二层同名容器包裹——5 个 approved 段全部带病通过。`doNotConsumeBefore` 4 条无消费方；`src/novel-v2` grep"作者秘密"0 命中；快照 `prohibitedEarlyConsumption` 只是整段 exitState 文本的转储。
- 修复：批准路径强制跑 exact-keys 契约校验（先做旧键别名迁移）；段带 `contractVersion`，health 报 `approved-but-stale-contract`；秘密对象化（id/claim/未揭示窗口/揭示载体），弧规划与蓝图注入"未揭示秘密清单"，弧审核加一条通用检查"本弧是否消费了未揭示秘密"。

**B4｜PL-4（P1）正文零出场人物拥有"正文来源"的关系事实**
- 叶轻眉/玄机子正文 0 命中，但 relations 挂着绑定 ch7/ch11/ch20 修订的"警惕/未知"关系；enrichment 名册（entities ∪ Foundation characters）不区分"已出场/未出场"，模型把泛指映射到规划专名；谓词 111 行/66 种不受控（含"未知"）；descriptor 当人名（"高瘦的""圆脸弟子"）。
- 修复："正文可指认"结构门——canonicalId 主/客体的 relation/fact 仅当正文命中 displayName/aliases 才允许绑 `valid_from` 入事实库，否则落"规划候选"通道；未出场人物在名册注入时显式标注；谓词受控枚举 + `其他:<标签>` 逃生。

**B5｜PL-6（P1）连载排期失控与 phase 算术均分**
- 弧 2 完成（08-10）→弧 3 批准（09-09）**30 天断更**；弧 3 六章 63 分钟批量生成；story-arc-planning 业务事实 16 失败/5 通过（见 C7 状态掩盖）；phase 归属用 `floor(localIndex/expected*phases)` 推算，弧 2 按 15 除实际 8 章 → ch12 之后全部失真。
- 修复：弧 schema 增 `phases[].chapterOrdinals` 数据绑定删算术推断；health 增跨弧空窗天数/规划失败重试数（连载健康度指标，不限制单批章数——批量是合法模式）；"expected≠实际的 completed 弧"列 major（与 B1 同通道）。

**B6｜PL-9（P2）三套译名权威并存零消费者**：worldview 无表、positioning 5 条、plot-design 10 条且引入新值；`conceptTranslationTable` 在 src 0 消费者、11 个 surfaceName 正文 0 命中；health 对 `coupling:{object}` 判空假阳性。修复：注册表单一 owner（positioning）其余引用；review.prose 按注册表反查"未转译机制原词上浮"（结构反查非词表）；存在性判定统一 value-present 语义。

**B7｜PL-7（P2）蓝图场景退化与字段夹带**：17/21 章单场景；`planningRationale` 写执行指令但该字段被剥离（指令永不生效）；跨章引用手写章号且写错（ch18 指"第5章"实际 ch20/21）。修复：拆 `executionNotes`（进执行合同）与 rationale（解释）；跨章引用改结构化 `setupRefs` 系统渲染；单场景占比/弧内字数分布作为描述性统计入弧审核上下文（不设硬门，单场景安静章合法）。

### C. 指引层增长通道（与正文互证）

**C1｜SK-2 + OR-F1（P0，✅已复核）学习闭环"晋升端"断裂：promote 写 DB、运行时读 yaml，0/26 晋升**
- 候选实测状态 proposed 25 / evidencing 1 / promoted 0 / rejected 0；`experiment_workspaces`/`promotion_receipts`/`candidate_bundles`/`skill_versions` 全 0 行。实际规则演进全走"手改 yaml + sync"（workflow-map 明文记载 prose-craft v1.4.0 即此路径），且 `craft-rule/promotion-service.ts:134` 晋升只 UPDATE DB、sync 的 ON CONFLICT 会整体覆盖——**一旦晋升后再 sync 即回滚**。僵尸实证：`crc-1788959069599` afterText 与 yaml 1.4.0 现文几乎同义（规则已在目标版本、候选仍排队）。
- 后果已被正文层直接观测：**PR-6——prose-craft v1.4.0"章尾必查"停在 proposed，ch16–20 收束达标靠人肉，ch21 回潮（明喻密度 6.4/千字、逐字命中 CRAFT 反例句）无人拦、旧章不回改**。"沉淀≠修复"是本轮最大流程警示。
- 修复：确立单向真源（promote 成功原子导出 yaml patch/生成 sync SQL，DB 作镜像；或 promote 直接产出待审 patch）；候选创建时"afterText 与当前目标版本指纹重合→自动 rejected(superseded-by-manual)"；把排队的两个真实候选（弧收口核对 + prose-craft 1.4.1）**走完双回归与 promote**，并对受影响旧章走正式工作流处置。
- AGENTS.md 把 learning→candidate→promote 定为 skill 唯一增长通道；当前该通道净产出为 0——这是指引层最优先修复项。

**C2｜SK-1（P0，✅已复核）35 条遗留/测试 skill 行使 database 模式投影不可用**
- 46 行中 35 行无 source_ref（v1 迁移+测试残留，含 4 条 test-* enabled=t），execution_points 空派生为全点命中：foundation.book-plan 模拟选中 21 条（9 条缺点文本→硬抛）、chapter.drafting 18 条（12 条注入过时 v1 指引 + 2 条硬抛）；`sync` 只 upsert 不清理、`checkDatabase` 不查 DB 多出行。
- 修复：幂等 migration 将非 yaml 清单行 enabled=FALSE；checkDatabase 增反向检查；test-* 隔离。回归：database 模式若真被消费，bundle 指纹变化致 script 幂等失效一次（可接受）；先确认无历史项目在消费。

**C3｜SK-3（P1）候选队列无聚合无关闭**：同一机制（技术黑话/认知入表层）prose-craft `1.3.1→1.3.2` 重复提出 17 条；dedup 仅按 assessmentId；evidencing 候选停滞 32 天。修复：learning prompt 注入 pending 候选摘要要求引用既有 id 聚合；`proposed` 超 N 天证据不足发 `craft-rule.candidate-stale` 事件（模板=memory-gate.blocked）+ 三态积压入项目总览。

**C4｜SK-4（P1）foundation-planning.yaml 违反泛化红线**：译名示例对（死循环→功法死症等）与"江湖化"字样固化进共享 skill，与自家编排文档"题材示例放项目层"矛盾；与 prose-craft"技术认知可为声部"构成蓝图侧/正文侧口径冲突。修复：机制结构保留、示例对删；表层禁令与声部许可互写边界句（已有泛化候选可直提）。

**C5｜SK-5（P1）chapter.blueprint 执行点错位**：全库唯一消费该点的 LLM 任务是 generateChapterTitle；逐章蓝图字段生成实际注入 arc.plan——2.5KB 蓝图契约花在了起标题上。修复：storyArcChapters 改绑 chapter.blueprint，标题任务轻量点分离。

**C6｜SK-6/7/9/10/11（P2）**：八项 vs 十项双载体漂移；编排文档 `revisionBase` 三值枚举 vs 代码两值（未知值静默降级为 current——应报错）；工具计数 47 vs 文档 46/41/40/37 四处漂移；`skill_versions` 死表、skill.iteration 接线未运转；承接契约写作侧/审核侧口径张力（reviewer 对"明确承接"从严 vs skill 对作者不禁必填，安静章易误伤）。修复：量化指标以代码为唯一口径加断言测试；单一权威载体规则。

### D. 正文质量与审核面（产物侧证据；多数为 A/B/C 的下游表现）

**D1｜PR-1（P0）交易条款互斥且三审零拦截**：ch20「月例翻倍、丹药按内门份例」→ ch21 成交「月供减半折算两枚凝气丹」（✅已复核原文），且"月供减半=省一块灵石开销"混用收入/支出；ch21 passed 4.5。条款类命题不在任何账本（openPromises 只有"期限"类）。修复：交换/契约类命题结构化槽位进上下文（与 A1 值槽机制同层），review 增"复述条款与建立章 diff（含增↔减方向反转）"通用维度——商战/权谋/婚恋同病，跨题材。

**D2｜PR-2（P0）道具回述五章五说**：云纹草 ch13 扔地→ch14"怀里夺走+残叶"→ch16"整株抢走+偷偷截留"→ch17"搜走的一模一样分量"（✅已复核 ch13/14/16 原文）；星屑砂从未在场获得；ch19"卖了两株"实为四株。修复：物品账（获得/易手/容器/持有者按章登记，与 A1 值槽白名单 `持有:某物` 同源）；reviewer 对"他想起/那日/上次"回述句逐条 diff 被引章原文。

**D3｜PR-3/4（P1）时间线三套账与"第一次发现"四版本**：ch2 初五锚定 vs ch11"穿越一个月"（实际在场链≈10 天）vs ch20 账目日期；首次改道 ch1"按住念头"→ch2/3/4 各造一版"已试过"；ch4 全章居所变"破庙"。修复：章↔故事日映射槽 + 绝对/相对/资历三表互查；能力/知识类事实带"首次获得章"锚，"本章声称已经会"必须有在场证据。

**D4｜PR-5（P1）POV 修一漏三**：ch3"此时的楚衡并不知道…冰山一角"、ch6"但他不知道的是"（✅已复核）与已修的"总结他人心理"同族不同判。与 FM-5 互证：**机制层同样无钩子**——character_knowledge 0 行、fe 管线的他人认知全部 author-scope 入账、检索 POV 过滤单边、审核复用草稿同一 bundle（审核者与作者共享残损视野）。修复：POV 契约扩为"不进入 POV 不可感知/不可知的任何信息与时间截面"，切镜头豁免须显式例外条款；得知/误以为成 claims 显式关系语义；审核 bundle 独立重检索。

**D5｜PR-6/7/10（P1，章尾/词域/情感契约）**：章尾纪律覆盖不稳见 C1；叙述层现代比喻（阈值扫描/显微镜/豆腐渣/俄罗斯轮盘赌）——上轮"语言契约完好"只查了英文词，校验面缺"时代词域"；"群像温度"情感契约 21 章零进展（有名配角全部只向主角输出压力/交易，笑点仅主角独白）——emotionalContract 是软文本无任何执行点消费。修复：喻体"经验来源挂靠点"结构判定随世界观开关；story-arc 执行点把契约短语列入"承载章指派"；reader-emotion 增"近 N 章存在性暖场/对手戏笑点"软查（安静章可豁免）。

**D6｜PR-8/9/11（P2）文本卫生/同质化/体量错配**：ch7 正文现 `**加粗**`（规划格式泄漏，全书唯一）；相邻段逐字重复 1 处；"夜色如墨"开章 4 次、无风叶颤 5 次、"走出院子混入人流佝偻背影"收章镜头 8 次；高潮前 ch16–19 四连最短章（2087–3167 字符）；文档 words 与实文差 12–20%。修复：净化层整行强调标记结构通删；"相邻非空段相等"提交前确定性拒收；序列证据注入上一章开收尾段+近 5 章章尾类型清单；review 结构指纹重合度（同功能拍子重合≥4 报 fatigue）；修字数统计口径。

**D7｜已修复验证**（8 项点名通过：ch1 期限 blocker、ch6 三段 POV、158 引号、ch10 内嵌标题、ch15 互斥结局、例供悬置已兑现、错字、译名统一）；**修 A 引 B 4 项**中最大一条是 ch11"早就耗尽+攒了这一个月"兜底补丁反造时间悖论——旧章处置必须在跨章 diff 到位后才可批量启动，否则继续"打补丁产生新洞"。

### E. 调度可靠性与可观测性

**E1｜OR-A1（P0）两个章节评审员首选是 100% 死路由：31% 模型墙钟烧在永不成功的候选上**
- `review.prose`/`review.character` 候选 0=`prof-ceb3918d`（gpt-web）分别 100%/98% 失败（502/413），其余 15 purpose 首选 glm 正常；候选 1（glm）0% 失败。340 条死路由调用烧 **8.73h**（全窗口模型墙钟 28h 的 31%）；token 损失小（3.7%）。"16.5% 调用失败率"的 64.6% 是静态配置产物。
- 修复（机制非个案）：跨 purpose 候选健康度诊断——按 `(purpose,candidate_index,model)` 聚合，样本≥阈值且 100% 失败→设置页标注"从未成功，建议摘除"；把"失败等待墙钟"提为常规聚合指标。运维动作（挪路由）与机制（健康度诊断）分开，防"改完配置又腐烂"。

**E2｜OR-A2（P1）业务失败伪装 completed**：story-arc 21 run 中 11 failed + completed 里 5 条 reason="最大修订次数未过审"；audit_records 实为 16 失败/5 通过；重驱动 12 次无运行侧留痕。修复：终态子类型 `terminalOutcome`（payload 固定键，status 枚举不动）；弧审核超时/外部等待窗/活动 StartToClose 三种失败出口统一规则。

**E3｜OR-B1/B2/B3（P1）跨项目数据卫生与外部任务链路不自洽**
- `model_tasks` 15 行 100% 孤儿（属已删项目；deleteProject 逐表列举漏表 + 该表无 project_id 列）；`listModelTasks` 无项目过滤——外部编排者会领到幽灵任务。
- 外部 MCP claim/heartbeat/submit **从未真正跑通**：task_attempts 300/300 lease 字段 NULL、0 条 sha256 键（claim 写路径与业务 task_id 语义冲突，reopen join 恒空、心跳必 0 行）；138 条 running 挂 completed run 上；waiting-external 34 次、0 claim 0 submit。外部回退 `while(true)` 无人认领即 15 分钟一档空转至候选越界才终止。
- Temporal Retention=24h、无卷 → 157/165 run 事后无从核对；9/7 手工收割的 `zombieReaped` 代码全仓 0 命中（机制不存在），creative_runs 又累积 11 条非终态（✅已复核）。
- 修复：① 所有间接归属表补 `project_id` + deleteProject 防漏断言测试（防类别不防单表）；② task_attempts 增显式 `model_task_id` 关联列，"无 owner 却 running"设为不可能状态；③ 外部回退改显式预算 `MAX_EXTERNAL_FALLBACK_ADVANCES`（形态对齐 DEFAULT_MAX_AUTO_REVISIONS），超限走 manual-review-required；waiting-external 超时发 outbox 事件；④ 周期对账活动（按 workflowType 取时长上限，Temporal 历史过期→abandoned+reasonCode 落判据）。

**E4｜OR-C1/C2（P1）守卫与循环不可观测、人工微修主导**：`revision-reverted` 在 run payload 0 命中系"后写覆盖"非未发生（progress 只写最后一 stage）——**无法回答阈值 0.15/0.5 挡下过什么**，违反 AGENTS.md"守卫须双向测试、阈值有据"。98 条 chapter-review 里 29 条黑话降噪 + 8 条引号/错别字 + 6 条 dedupe——机械微修也走全量三审+事实抽取+学习评估（≈8–10 次调用），4.77 轮/章的均值被人工噪声主导，自动收敛效率不可分离。修复：有语义 progress 事件（revision-decision/revision-reverted/manual-review-required）双写持久事件表；intent 增 `changeScope: mechanical-format|local-text|narrative`，preflight 据此调评审面宽度（契约化为"不改变语义"类，保留结构校验，非后门）。

**E5｜OR-D2/D3（P1）嵌入幂等与用量观测**：embed 1877 次仅占成本 1.2% 但 100% 不可归属（run/task 全 NULL）+ 337 次内容全等重复嵌入；估算 vs provider 上报差最高 76 倍、context_manifests 仅 25 份对 1523 次调用——上下文膨胀不可见。修复：`prompt_fingerprint` 幂等短路；embed 带归属；结构化调用按 purpose 采样关联 context_manifest_id；估算/上报比值按 purpose 只读报表。

**E6｜OR-E1（P0）三个 MCP 只读工具恒抛或恒静默**（✅已复现）：`novel_prompt_inspect`/`novel_invocation_list` SELECT 不存在列（provider/request_tokens/mi.project_id）→ 原样执行 `ERROR: column "provider" does not exist`；`novel_context_get` 同类增强包裸 `catch{}` 静默丢字段。长期无人发现的根因正是编排 skill 未收录这 5 个工具（文档-代码互盲）。修复：枚举 TOOL_HANDLERS 的只读工具 smoke 契约测试（固定 fixture）；禁止裸吞，降级显式化 `enhancementErrors[]`。

**E7｜OR-E3（P1）facts 双真源静默无效**：`facts` 表 0 行但 REST 写路径活着（KnowledgeFormKind 含 facts），生成/检索/向量三处均不读——作者在工作台写"事实"200 OK 但对后续章节零影响无告警。趁 0 行收口：移除该 kind 或改 claims 别名路由 + 一条迁移。同类死表清理：`quality_gates`/`skill_bindings`/`timeline_events`/`project_snapshots`/`memory_snapshots`（0 行 0 读或 0 写）逐个定性"待接线/废弃"并在 spec 标注，`outbox_events.published_at` 12962 行全 NULL——要么实现 publisher 要么更名 `domain_events`。

**E8｜OR-C3/B4/E4（P2）**：prose 均分 4.10 贴着自动 commit 门线 4.0（且恰是最重死路由的一路）；structural-validator 105/105 恒过零分数（恒真校验=无校验，需审计其检查项是否空转）；memory-gate 零样本零留痕、chapter-review 不经该门（二选一显式化）；诊断压缩仅 32/165；`workflow_run_summaries` 覆盖率作积压指标。

---

## 四、迭代路线图（按根因层分批，均可独立验收）

> 遵守 AGENTS.md：以下全部为机制/契约/数据建模层改动，无一条例外是"针对某章某弧某词"的硬门；个案数据修复一律走正式工作流或治理通道（grooming/审批队列），不直接 UPDATE 业务表。

**Batch 0 · 数据卫生（1 天内，低风险，为后续解阻）**
1. SK-1：35 条遗留 + 4 条 test-* skill 行 enabled=FALSE；checkDatabase 反向检查。
2. OR-E3：facts 写路径收口（0 行时机）；死表定性清单入 spec。
3. OR-B1：model_tasks/outbox 幽灵清理；三张遥测表补 `project_id` 列 + deleteProject 防漏测试。
4. PL-2 存量：弧 3 标题/内部码经 `novel_story_arc` 治理通道重净化；4 条影子 thread 合并回规范线并回填引用（不手改）。

**Batch 1 · 上下文供给正确性（最高优先，解锁正文与审校质量）**
5. FM-1 退役不变量 + 值槽白名单 + 可见性回归诊断（A1）。
6. PL-3/FM-6 foundation 段级单例 + 全装配路径共用退役视图 + `contract` kind 分轨（A2）。
7. FM-2 候选审批队列一等公民化 + memory-gate 积压 facet（A3）。
8. PL-2 引用 enum 白名单 + 取消 auto-create + 结构净化层（A4）。
   **验收**：重放 ch1–21 起草上下文（影子 preflight），"冻结事实"块中 foundation:真章节事实 token 比从 ~97:3 降至规划投影 ≤15%，stale 投影进 bundle = 0；可见灵石链完整（持有→克扣→缴清逐级可投影）。

**Batch 2 · 账本与校验（规划层可信）**
9. PL-1 `arcLocalChapterCount` 不变式 + completed/expected 一致性诊断 + 双向测试（B1）。
10. PL-5 伏笔五件套：窗口结构化/兑现单入口/锚点身份/thread 回填/health 五计数（B2）。
11. PL-8 批准路径跑契约 + contractVersion + 秘密对象化（B3）；PL-4 正文可指认门（B4）；PL-6 phase 数据绑定 + 排期指标（B5）。
    **验收**：`architecture/health` 对弧 2 类缺陷报 major；138 条伏笔重复簇/超期/无兑现修订全部可见可处置；五个 approved 段过 exact-keys 校验。

**Batch 3 · 指引层闭环打通（与 Batch 1/2 并行可做）**
12. SK-2 单一真源（promote→yaml 导出或 patch 产物）+ 重合自动 rejected（C1）。
13. **立即行动**：排队的弧收口核对与 prose-craft 1.4.1 两候选走双回归 + promote；对受影响旧章（ch3/6 全知句、ch14/ch21 章尾、ch4 破庙、ch11 时间悖论、ch20/21 条款）逐条登记正式工作流处置——**这是 ch21 回潮类问题的止损**。
14. SK-3 候选聚合 + candidate-stale 事件 + 三态积压入总览（C3）；SK-4 foundation-planning 去题材化（借道 Batch 3.12 晋升）；SK-5 执行点改绑（C5）。
    **验收**：首次端到端 promote + receipt + 自动重放回归；proposed 队列净减；"同机制 17 份重复"降为 1。

**Batch 4 · 调度可观测与审校面补装**
15. OR-A1 候选健康度诊断 + 失败墙钟聚合指标（E1）；运维顺手摘除死路由（作为动作非代码）。
16. OR-C1 守卫事件双写 → 阈值调参从"凭感觉"变为"有分布"（E4）；changeScope 变换意图通道。
17. OR-B2/B3 租约模型修正 + 外部回退预算 + 周期 Temporal 对账（E3）。
18. OR-E1 MCP 只读工具 smoke 测试 + 禁裸 catch（E6）；terminalOutcome（E2）；embed 幂等 + 用量报表（E5）。
19. 审校面新增三维度（依赖 Batch 1 供给修复后才有弹药）：条款/物品/回述一致性 diff、章尾类型强制枚举、喻体词域结构判定（D1/D2/D3/D5/D6）。
    **验收**：死路由墙钟归零；守卫触发可查询；外部链路首次真实 claim→heartbeat→submit 演练；新审校维度在异构题材反例上双向测试（prose 报告§五的 10 项抽查清单为验收用例）。

**Batch 5 · 连载节奏（创作管理侧）**
20. 弧 4 启动即验证收口候选实效；跨弧空窗 ≤14 天入 health 指标；emotionalContract"承载章指派"落地（D5）；21 章 ≈3 周存稿量的节奏决策留给作者。

---

## 五、与前序审计的状态对账

| 前序记录 | 现状 | 证据 |
|---|---|---|
| 907§五.1 ch1 时间线 blocker | ✅ 已修复并验证 | 现稿尾段仅剩例供旧账 |
| 907§五.2 弧 3 承接 resolution 缺口 | ✅ 已兑现（ch16–19 闭环）；但暴露真根因=PL-1 弧 2 提前 completed（本轮新证） | batch/代码实查 |
| 907§五.4 伏笔账本卫生 | 部分：重复簇 16→1（残留簇修复面结构性看不见，见下"2026-09-19 复测"，本轮收口）；"超期 31→244"不成立为债务——09-18 P1 已把该字段语义改为中性事实"窗口上界已过"（238/244 仍在正文推进）；thread_id 0/717 未变，但根因已定位并收口（判据惰性→改线程显式认领，新弧起生效；存量 437 条仍需语义分流） | getArchitectureHealth 实跑 + 代码逐条 |
| 907§五.5 学习闭环沉淀（两候选） | ❌ 排队现状不变（09-19 实测 proposed 23 / rejected 18 / promoted 1、promotion_receipts 1）→ 工程侧无可推进部分，promote 是作者裁决 | ledger-debt 只读实测 |
| 908 六 Seam 问题 6 条 | 部分修复（ch1/ch2 资产已验）；星屑砂容器/ch11 装置/ch5→6 战利品仍在 | D 组 |
| 9/9 治理 §8 六项 | 3 修复/3 部分（退役只管一径、方案A 仍 23 条漏出、配额未获生产检验） | FM §三逐条 |
| 9/9"Foundation 56→5 检索可见" | 属实但**不完整**：bundle/preflight 路径仍带 20–29 条 stale → 本轮 A2 | manifest 实算 |

**2026-09-19 复测与根因（goal 迭代收口轮，读数取自 `getArchitectureHealth` 对运行库的实跑，非重算 SQL）**：total 717 / open 437 / fulfilled 63 / 窗口上界已过 244 / 未绑线程 437 / 兑现账缺失 0 / 弧孤儿 0 / 重复簇 1。四条结论（第 4 条是本轮顺带闭环的前序疑问，不属伏笔账本）：

1. **重复簇 16→1，残留 1 簇暴露"检测面-修复面判据不对称"**。检测面（`getArchitectureHealth`）跨全部行、按 `narrativeTextKey` 归一后字符二元组 Dice≥0.85 聚簇；修复面（`repairForeshadowingLedgerDuplicates`，migrate 尾）`WHERE status='open' AND narrative_order IS NOT NULL` 且按章分桶、CJK-only 归一、阈值 0.24。两条差异叠加使残留簇**结构性不可达**：其实质是 2 条 `narrative_order IS NULL` 的规划期伏笔（"宗门高层（玄机子）对外门异常迹象的例行忽视"与去括注版，Dice 0.92），修复面 SQL 把它们整批排除在外。同桶共 10 条 NULL 序 open 行，用修复面同一判据（0.24 并查集）实测只成两簇（该对 0.92 + 经脉感知对 0.56）、七条单例，无传递闭包吞并——故本轮把 NULL 序行纳入修复面（独立桶，不伪装成"第 0 章"），warning 由机制清零而非人工删行。
2. **thread_id 全表 0 绑定是判据惰性，不是漏接线**。PL-5④ 的写入口确在（`postgres-repository.ts:3451`），但判据要求"本弧**恰好一条**线程责任"才绑（多线弧不从共现推断归属，宁缺毋伪）；实测本项目 24 条弧的 `threadResponsibilities` 全部为 4–7 条线程 ⇒ eligible 弧 0 条，机制永不触发。根因不在 binder 而在**契约没有归属表达**：`threadResponsibilities` 只有 threadRef/responsibility/nextAdvance 三字段，弧级 `foreshadowingRefs` 是扁平账，模型即便心里有线也没有可写的位置（现在只被 prompt 要求把续线/保持责任写进自由文本 `responsibility`，机器不可判定）。修复形态=弧蓝图线程责任增加可选 `foreshadowingRefs`（**必须是弧级同名字段的子集**，越界即 blocking 回流，禁止发明关联），binder 按线程落 `thread_id`；同一条伏笔被多线认领时不猜承担者，改在审计 `story-arc.references-normalized` 的 `threadBindingAmbiguous` 里留痕（静默跳过与静默失败同罪）。**本轮已实施**，契约类型 / 两处解析（外部编排 + 模型输出面）/ 生成面 JSON schema / 外部工具 schema / 编排技能文档五面同批登记（教训③），旧弧与无认领输出零回归。落地中被自家守卫纠一处：生成面 schema 里字段先按"可选"写，被 `native-schema.test.ts`（`assertNativeJsonSchema` 禁止对象出现未列入 required 的 property）判不兼容，改为进 required、以空数组表达"本条线不承担伏笔"，解析面仍按可选处理。生效代价如实登记：故事弧规划的响应 schema 变了 → 该阶段 prompt 指纹变 → 部署重启时在飞的外部弧规划任务会换幂等键重开，故落位窗口应选在无在飞弧规划任务时。437 条存量 open 未绑无论如何都需要语义判定（文本等值命中 0、plot_threads 仅 7 条、伏笔 payload 无线程键——机械回填等于伪造），维持"随弧分流"现状。
3. **学习闭环排队不变**：proposed 23 / rejected 18 / promoted 1、promotion_receipts 1。候选生成与拒绝留痕两条通道均在正常工作，卡点是作者的 promote 裁决；工程侧本轮无可推进部分（不新增自动晋升，晋升门必须是人的判断）。
4. **前序疑问"必投材料不被截断的硬门未接线"已验结论：门在，只是不在那个文件里**。`src/lib/model-capabilities.ts` 的 `assertModelContextLimit` / `estimateTextTokens` / `resolveModelContextWindow` 实测零调用点，且它的限额来源是**进程内** `detectedContextWindows` Map（只由浏览器侧 `listChatModels` 经 `recordModelContextWindow` 写入），服务端永远拿不到 ⇒ 即便接线也是空转。同一保证实际由三处显式抛错承担：`stage-context.ts` 的 `StageContextBudgetError`（critical|required 段被预算剔除即抛，非静默降级）、`cognition.ts` 的 pinned/required-facet 溢出抛错、`model-gateway.ts` 的 `ModelContextBudgetError`；越预算的唯一兜底是定向修订按窗分批重试（设计行为，不是截断）。部署面实测（09-19）：`prompt_executions` 9,243/9,243 全部携带含 `maxInputTokens` 的 context manifest，而 7/7 provider 配置无 `contextWindow`、22/22 路由 budget 未设 `maxInputTokens` ⇒ 网关那条 `profile.contextWindow ? … : Number.MAX_SAFE_INTEGER` 的放开分支在本部署从未走到。故本项的处置不是"补接线"而是：① 该死导出建议删除并同步 spec（删除动作待作者批准，不擅自动手）；② 若将来要让 profile/route 承担限额，必须同时把"检测到的上下文窗"持久化到服务端配置，否则写侧与读侧仍在两个进程。

**方法论教训（沉淀候选，走闭环）**：① 修复声明的验证必须覆盖**全部消费路径**（退役只验检索侧、"候选不泄入"只验字面契约都会漏掉真洞）；② 一次性人工收割不产生机制（zombie 收割 9 天复发）；③ 文档不声明的工具面无人使用、无人踩雷（坏 SQL 存活）——spec/工具/技能三者要同批登记。

---

## 六、附录：数据与口径

- 证据导出：`tmp/audit/db/`（44 份，psql→JSON）、`tmp/audit/text/`（21 章，REST 拉取）、`tmp/audit/extract*.sql`。
- 复核脚本：正文层 `%TEMP%\fmem\*.js`（记忆层）、`tmp/audit/review-ch01-21-20260910.md`（正文层完整取证）。
- 2026-09-19 复测取证面（对 `ymcp` 只读）：`tmp/ledger-debt.cjs`（账本与学习队列计数）、`tmp/health-recheck.ts`（直接实例化仓储跑 `getArchitectureHealth`，权威读数）、`tmp/dup-cluster.ts` 与 `tmp/null-order.ts`（重复簇成员与无锚点桶逐对相似度）、`tmp/foreshadow-recheck*.ts`（thread_id 绑定率与弧线程形态计数）、`tmp/gate-exposure.cjs` + `tmp/routing-audit*.cjs`（上下文预算门的部署面读数）。
- 关键统计口径：检索可见集=active∧authority∈{derived,approved,author}∧不被任何 active 行 supersedes；成本归属仅计 run→project 可 join 的 1523 次调用（73 次/章），禁止表总量÷章数。
- 未决疑问（不立案）：76 倍估算/上报比值成因、弧审核意见是否见过标题污染、生产 database 模式真实消费、面板 7→3 收缩的变更记录缺失——见各分层报告"未验证的疑问"。
- 规划层疑问 1（弧 2 completed 写入者）已闭环：audit_records 显示弧 2 于 08-08 由 external-reviewer 批准、生成审计即 `chapterCount:8` 与 `expectedChapterCount:15` 当场矛盾（审批时无"expected=计划章数"校验，PL-1 修复需同时补此入口）；completed 时刻 08-10 04:23:47 无任何 story-arc.* 动作，仅同秒的 ch15 commit `fact-approval.policy-applied`——即完成判定 SQL 在提交管线中静默翻转，零审计留痕。修复建议补充：弧完成状态变更必须写 `story-arc.completion-reconciled` 审计动作。

## 七、实施进度台账（goal-843ebea0，Batch 0–4）

### Batch 0 数据卫生 — ✅ 完成（2026-09-10）

| 项 | 实现 | 验证 |
| --- | --- | --- |
| SK-1 遗留 skill 禁用 | 迁移 `082_skill_projection_hygiene.sql`：按溯源（source_ref IS NULL）结构性禁用，不列 id 清单；幂等 | 运行库：无溯源 enabled 行 35→0；11 个 yaml 投影行全部保留；h3 `database:` 种子不受影响 |
| SK-1 反向检查（持续防线） | 新增 `src/novel-v2/skill-hygiene.ts`（纯函数：unsourced/orphaned 判定）；`novel:skills:check` 增加反向卫生门（此前只查 workspace→database 单向漂移） | `check --target database` 通过；`skill-hygiene.test.ts` 4 双向用例 |
| E3 facts 双真源收口 | `MutableKnowledgeRecordKind`/REST 两处路由白名单/前端表单 schema/kind 元数据移除 facts；repository 三个 facts 读写分支改为显式抛错（信息指向 claims）；commit 回滚的遗留清理 DELETE 保留 | knowledge-records 测试新增拒绝用例；`knowledge-workbench-records.test` 的 "不读 FROM facts" 守卫保持通过 |
| OR 遥测项目归属 | 迁移 `083_telemetry_project_attribution.sql`：model_tasks/model_invocations/prompt_executions/outbox_events 加 project_id + 回填（两种 run id 形态 + payload 派生）+ 幽灵清理 + ON DELETE CASCADE FK + 索引；recordModelInvocation/createModelTask/recordPromptExecution/appendOutbox(×4 路径) 写入时归属 | 运行库：invocations 归因 1523 行（其余为历史已删项目，已随幽灵清理）、dead-ref 0、model_tasks 113→0 幽灵；`telemetry-attribution.test.ts` 5 用例含**类别守卫**（所有带 project_id 的表必须级联或登记豁免，当前豁免仅 short_scripts） |
| deleteProject 防漏 | 按 run 引用兜底清除遥测三表 + outbox 按列清除 | 集成测试：删项目后三表与 outbox 0 残留 |
| listModelTasks 项目过滤 | 新增可选 projectId 参数（MCP/REST 消费侧接线属 Batch 4/E1） | 集成测试含跨项目不可见断言 |
| spec 同步 | workflow-map.md §11 新增三段契约（归属/卫生门/facts 收口） | 全量 `vitest run`：98 files / 840 passed 零回归；`tsc --noEmit` 干净；迁移 audit ok；API health healthy |

说明：运行库 schema 与数据已生效（服务重启不再必需，归属列由旧进程写入为 NULL 属预期，重启后新写入自带归属）；一次性 `tmp/migrate-once.ts` 属 tmp 工具不入库。

### Batch 1 上下文供给正确性 — ✅ 完成（2026-09-10；运行面回放验证并入最终重启项）

| 项 | 实现 | 验证 |
| --- | --- | --- |
| FM-1 盲杀退役 | 新模块 `memory-visibility.ts` 单一定义可见性（active + authority∈{approved,author,derived} + 未被可见杀手退役）；5 个检索面统一口径（searchMemory/indexable/countIndexable/knowledge-claims/fact-extraction 目标侧）+ Qdrant 服务端 authority 过滤 + upsert 杀手侧 + grooming 杀手侧；写入侧 supersedes 只填值槽谓词（classify `isValueSlotPredicate`，未列入=事件累积安全默认） | `memory-visibility.test.ts` 6 用例含**双向**盲杀不变量（candidate 杀手 inert：listIndexable+searchMemory 两面；批准后边生效）；`fact-extraction.test.ts` 事件槽负例；真实 PG 集成 |
| FM-6/PL-3 foundation 段级单例 + 契约轨分离 | `foundationClaimId(projectId,taskKey)` 单例 id；recordFoundationClaim 原位覆盖+代际 supersedes 收编（历史原文只存 artifacts）；ensureFoundationMemoryClaims 按 latest-per-taskKey 收敛；migrate 尾 `repairFoundationClaimSingletons` 幂等；draft/revision/review 三处渲染从冻结事实剥离 foundation 行、合并为只读"创作契约"段（priority normal，防预算硬失败；事实冲突以正文为准） | `memory-visibility.test.ts` 单例用例（legacy 行归档、重复 ensure 幂等、三代重生成原位刷新）；运行库：5 个 taskKey 全部单例、检索可见=5 单例、56 旧行退役归档 |
| FM-2 候选队列一等公民 | MCP 新工具 `novel_fact_candidate_queue`（积压面板：分章 pending/账龄/占比/样例/staged 残骸）+ `novel_fact_candidate_decide`（批量裁决、单条已处理→skipped 整批幂等、向量 best-effort 同步带 vectorSyncError）；`getFactCandidateBacklog`/`getMemoryClaimById` repository 支撑；`memoryGate.candidateBacklog` facet（阈值 env 默认 10，活动层非阻塞查询）；REST decision 路由补同款向量同步；MCP server 注入 memoryIndex（探测失败降级 DB-only）；staged 精确同文残骸由 rebuild 尾 `reconcileStagedClaimDebris` 自动清理 | gateway 单测 2 新用例（面板投影、批量幂等+单次 upsert）；TOOL_NAMES/handlers/metadata 三方一致性守卫（47→49） |
| PL-2 弧引用自我放大 | 取消静默 auto-create：未解析引用→blocking 错误（可执行审核意见文本）回流 planner；显式 `new:<名称>` 新建通道（explicitNew 标记+原始表达登记别名）；`resolveNamedReference` 复合串 `"<id> <名>"` 自愈取 id；`sanitizeReferenceToken` 剥 `弧N：/Arc N:/N、` 序号前缀（防误吃小数与中文标题）；`findEmbeddedInternalIdentifiers` 机器记号形态检测；弧 schema threadRef/foreshadowingRefs 形态 pattern；prompt id/名称分行+引用契约规则；health 分类 resolvedExisting/resolvedNewlyCreated + `embedded-identifier` blocking；migrate 尾 `repairStoryArcReferenceHygiene`（重定向+合并+删影子，幂等） | `story-arc-integrity.test.ts` +7 用例（净化双向、DB 集成四态）；运行库：4 影子线删除、3 弧 12 处 threadRef 收敛到 4 真线、二次运行 no-op |
| spec 同步 | workflow-map §11 四段契约；mcp-orchestrator.md 工具清单 46→49+两工具用法与策略行 | 全量 `vitest run`：99 files / 859 passed |

说明：新守卫的生效面（Qdrant 过滤、契约段渲染、backlog facet）在重启前对旧运行进程不生效——列入最终"整体重启 + shadow preflight 回放"验收（stale foundation=0、事实槽占比恢复）。

### Batch 2 账本与校验 — ✅ 完成（2026-09-10；PL-1 ✅；PL-5①②③④⑤ ✅）

| 项 | 实现 | 验证 |
| --- | --- | --- |
| PL-1 弧完成量纲 | 单一真源谓词 `arcCompletionPredicateSql`（弧内 COUNT 落籍章数 vs expected；人工 complete=true 优先）替换 commit 管线与 migrate repair 两处全局序比较；commit 转移补 `story-arc.completion-reconciled` 审计留痕（RETURNING 驱动）；审批入口新增"末个待审批次 complete=true 时 expected=已落籍章数"一致性拒绝；health 新增 `completion-count-mismatch` blocking | `story-arc-integrity.test.ts` PL-1 describe 三向（弧 2 形态复刻不 completed／人工 complete 优先+审计+诊断可见／期望修正后自动完成）；运行库：弧 2 "期望 15 实际 8"以 blocking 可见（数据处置留作者/rebase） |
| PL-5② 兑现单入口 | 迁移 `084_foreshadowing_payoff_ledger.sql`：payoffs 泛化为单一兑现账（`foreshadowing_id` + `payoffs_exactly_one_target` CHECK + 局部索引 + 历史"只翻 status"行回填，FK 守卫幂等）；recordNarrativeElements 伏笔兑现与 status 同事务落账；回滚路径既有 `DELETE payoffs BY revision_id` 天然覆盖 | foreshadowing-order 集成：兑现落账 + 重放不重复 + `fulfilledWithoutPayoff` 双向（缺账 blocking→补账消解）；运行库：31 行兑现账回填、3 条无证据 fulfilled 保持可见（审计点名缺陷原样命中） |
| PL-5① 窗口结构化（读+写双侧） | 读侧 `parsePayoffWindow` 共享纯函数：相对章数/章范围/章点/卷/书/无界六形态 + 结构化对象统一解析，解析不出归 unknown 不猜。写侧 extraction schema `expectedPayoffWindow` 改结构化对象 `{scope,count,from,to,note}`（strict 契约下"可选"=可空类型联合、properties 全 required——本项目 native-schema 契约实测约束）；读侧投影 `formatPayoffWindow` 把新旧两代统一渲染为短语文本，下游 prompt/面板零感知 | narrative-elements.test 含窗口显示 6 断言；集成：结构化对象落库→open 投影出"6章内"；fact-extraction 42 用例经 strict 校验器全绿 |
| PL-5③ 锚点身份 | extraction 增 `anchor`（承载伏笔的正文载体短词，≤30 字）；登记键 `(document, normalized anchor)`（`foreshadowingLedgerId`，锚点缺失/句子形态保守退回描述内容键）；同键归并在应用层：最早埋设保留、keywords/possiblePayoffs 有序并集、被吸收改写描述进 `mergedFrom` 审计。边界：跨文档同锚点**刻意不并**（词面同≠同一伏笔，误并=丢账，跨章近重复由 health duplicateClusters 交人工） | 单测 5 用例（同锚改写同行/标点归一/跨文档不并/退回内容键/归并双向含同文重放零噪声）；真 PG 集成：两轮改写归并 1 行 + keywords 并集 + mergedFrom + 结构化窗口投影 |
| PL-5④ thread 回填 | normalizeStoryArcReferences 共现回填：本弧唯一线程时绑定其引用的未归属开放伏笔；多线弧不猜 | 运行库 unbound=104 如实可见（章节埋设伏笔不属弧引用域，回填通道在弧再审批时自然触发） |
| PL-5⑤ health 五计数 | `foreshadowingLedger` 块（total/open/fulfilled/overdue/unbound/fulfilledWithoutPayoff/arcOrphan/duplicateClusters）+ 四类 issue；重复簇用字符二元组 Dice≥0.85 保守聚簇（0.5 广谱去重仍归 grooming，语义判定归人） | 运行库投影：138 总/34 超期/3 无账/1 近同文簇 全部可见 |
| PL-5③ 实现补记 | 见上行（锚点身份）；旧行登记于此保持批次序号可追溯 | — |

### Batch 3 指引层闭环 — 🔄 进行中（PL-8 ✅；SK-5 ✅；SK-11 ✅；SK-3 ✅；SK-2 大部分 ✅）

| 项 | 实现 | 验证 |
| SK-2① 重合自动 rejected（C1 僵尸候选） | `createCraftRuleCandidate` 的全字面比对升级为**合并语义重合判定**（`isCraftRuleNoopChange`：skill 补丁 parse→merge 进当前 sections→逐段空白折叠等价且无新段 ⇒ 无净变化）→ 直接落 `status='rejected'` 行 + 系统 review `superseded-by-manual`（进台账不静默丢弃）；幂等 id 按**规范化补丁形态**哈希（换空白写法/键序重放命中同一行） | craft-rule.test 双向集成：等价补丁（含首尾空白变体）→ rejected+溯源 review+重放同 id；实质变体（同段带空白+新增执行点段）→ 不被误杀仍 proposed。边界登记：语义近义改写仍归审核/回归（宁放行不误杀） |
| SK-2② 单一真源方向性护栏 | `compareSkillVersions`（semver 数值段比较，非数值段字典序回退）；`syncDatabase` 拒绝用**更旧 yaml seed 覆盖更新的 DB 晋升行**（skippedStaleSeed 报告）——"一旦晋升后再 sync 即回滚"的双真源竞态结构性封堵；`checkDatabase` 把"DB 超前"分类为 `promotion-ahead`（预期状态+回写 yaml 提示）而非 drift 报警 | skill-runtime.test 版本比较 6 断言（1.10>1.9 数值段、缺段更旧、非数值不崩）；sync/check 为 CLI 路径（无单测面，行为经分类逻辑审查） |
| SK-2 剩余（dev 运行可见性） | ✅ 已于 2026-09-11 收口：`renderPromotedSkillYaml` 晋升后产出待审 sidecar yaml + `skills patch --apply` 落位通道 + `migrate()` 尾 `seedWorkspaceSkills` 新库自举（见"Batch 4 补账"与本文件 workflow-map §11） | `craft-rule.test.ts:836`（sidecar 生成/seed 缺失/无变化三分支）+ `skills check --target database` 现状 ok（12 技能 seed↔DB 对齐，无 promotion-ahead 残留） |
| SK-3① 候选聚合（C3 重复 17 条根因） | learning prompt 新增"排队中的候选"投影段（pending 三态摘要：id/target/拟晋升版本/机制截断 160 字）+ 聚合规则（同机制必填 `candidate.aggregateToCandidateId` 引用既有 id、不同机制填 null）；schema 加可空字段（strict 契约合规）+ parse 归一（空白→无）；`recordLearning` 聚合分支：命中→`aggregateCraftRuleCandidateLearning`（learning_source.aggregateAssessments 追加去重、updated_at 重置停滞计时、outbox `craft-rule.candidate-aggregated` 留痕、不新建行）；**守卫拒绝回退**：幻觉 id/已出队候选→回退正常新建（证据宁可重复不可丢失）。两处 learning 装配（章节+故事弧）与 external 降级路径全接线 | v2-learning-assessment 3 测双向（有队列投影 id／空队列规则句恒在场不虚构条目；parse 字符串透传 vs null/空白归无；activity 聚合命中不触 create 哨兵＋守卫拒绝必达 create 查询）；craft-rule.test PG 集成：追加去重幂等（重放不增长、事件计数=真实追加数）＋三态守卫双向 |
| SK-3② candidate-stale 事件（C3 队列只进不出） | `detectStaleCraftRuleCandidates`：pending 两态 + updated_at 超 30 天（TODO 可配置）+ 零证据 + **该 updated_at 后未发过**（幂等：updated_at 前进才重新计时）→ outbox `craft-rule.candidate-stale`（模板=memory-gate.blocked 的"提醒不判定"语义：不改 status，decisionHint 指晋升/驳回/补证据路径）；触发挂 recordLearning 顺带扫描（随提交自然节拍，无独立调度器；查询失败 warn 跳过） | SQL 条件结构经代码审查（outbox NOT EXISTS 幂等）；事件表为自由 event_type（002 迁移），消费面 generic |
| SK-3③ 三态积压入项目总览 | LearningPanel 总览第四格：未关闭数（拟议/证据/审核分解），数据前端聚合零 API 变更；CSS 3→4 列 | Web 构建验证（见验收行） |

| --- | --- | --- |
| SK-5 蓝图执行点错位（C5） | `storyArcChapters` 段的 skillBundle/skillExecutionPoint 改绑 `chapter.blueprint`（蓝图契约 yaml 早已声明该点却无真实消费者），弧结构段留 `arc.plan`，两段各自 resolve（external 降级路径 skillBundleId 同步用实际 bundle）；新增轻量执行点 `chapter.title`（protocol + SKILL_EXECUTION_POLICIES + COARSE_STAGE），**刻意不进 TASK_CLASS_POINTS**（drafting/planning 类 skill 不得再被推导挂上标题任务——错位根因的防复发结构保证）；配 `chapter-naming` skill（v1.0.0，通用命名技艺：命名"这一章"而非"这一类情节"、可换章标题=失败、不预告未发生后果），标题任务首次拥有专属轻量指引 | skill-runtime.test 14 用例：既有"每执行点必有 required skill"守卫强制开点配 skill；新双向用例——title bundle 含命名指引且**不含** plot-causality 蓝图段、skills 全部显式声明 chapter.title；反向 chapter.blueprint 仍解析出蓝图契约（"选择窗口"）；`generateChapterTitle`/`generateStoryArcBundle` 接线经 tsc+全量绿 |
| SK-11 承接口径统一（C6 点名项） | "章末未解"唯一权威读法常量挂三面共用蓝图解释器（见 Batch 4 表 OR-E1 后行），C6 其余项（八项vs十项载体、revisionBase 枚举、工具计数断言、skill_versions 死表）不属本目标点名范围 | unresolved-threads-contract.test 3 测双向（空清单在场=安静章误伤面、三面同源） |

| PL-8① 契约校验（比审计预期更深的根因） | `validateFoundationTaskContract` 的 Ajv validator **compile 后从未调用**——schema 层校验自落地起为死代码（这才是"5 段全部带病通过"的机制根因，批准路径缺席只是第二层）；修复调用后批准路径（approveProjectPlanSection）强制跑契约、空壳/漂移 payload 直接拒绝 | 死代码守卫双测：requiredPaths 抓不到、只有 schema 层能抓的子结构类型错误（`hidden` 非数组、不可归一卷序装整数数组）必红；command-router/v2-repository-management 两个批准集成 fixture 按契约补全后通过 |
| PL-8① 别名/记法迁移 | 共享归一层：`hiddenInformation→hidden`、`notDesignedYet→notDesigned`、裸字符串秘密→`{claim}` 对象、`"V1"/"卷2"/"第3卷"→` 整数（无损记法）；真内容缺陷（narrativePromises 装错容器、coupling 对象）**刻意不自动拍平**——通过校验的垃圾比可见的缺陷更危险 | 别名/归一/不覆盖（"已规范不被别名改写"）三向单测；运行库实测：4 段 PASS 零噪声，plot-design 5 项真缺陷如实 REJECT |
| PL-8② contractVersion + stale | 批准落契约内容指纹（`foundationContractFingerprint`，无手写版本）；health `stale-foundation-contract` 以"当前契约实时校验"为真相判定（无版本旧段不制造噪声，仅实时失败者入列） | 运行库：`staleContract=["plot-design"]` 精确命中唯一真带病灶（批准时 contractVersion=none 由实时校验兜底） |
| PL-8③ 秘密对象化 + 清单注入 + 审核检查 | plot-design 契约要求 `informationBoundaries.{hidden,notDesigned,open}` 对象数组；弧规划上下文/蓝图 context 注入"未揭示作者秘密"required 段（共享渲染器单一真源）；弧审核加通用"秘密边界检查"（消费需显式揭示安排，无安排泄漏 major，清单空自动跳过）；generation hint 声明规范形态防再漂 | prompts.test 双向（有秘密→段注入+段序先于开放候选；无秘密→段缺席）+ 审核指令在场断言；运行库 `getStoryArcPlanningInput` 实测旧键数据经迁移投影出 2 条 `{claim}` 秘密 |
| 校准记录（与审计文本的偏离） | ① "exact-keys 拒绝未知键"未采用——`additionalProperties:true` 是分层演进的前向兼容面，键名收敛改由"required 规范键 + 别名迁移"强制；② hiddenInformation 别名迁移在归一层完成，无需一次性数据改写（读侧统一规范形态，旧数据经 084 后段重审时自然收敛） | 台账此行即偏离登记 |

### Batch 4 可观测与正文可指认 — ✅（PL-4 ✅；OR-E1 ✅；OR-A1 ✅；OR-A2 ✅；OR-C1 主体 ✅；OR-D2 主体 ✅；OR-B2/B3/B4 ✅；E4-changeScope 与 E5 两观测子项登记）

| 项 | 实现 | 验证 |
| --- | --- | --- |
| PL-4① 正文可指认门（写+读双侧） | 共享层 `character-identity.ts` 新增 `humanMentionNamesFor`（索引别名集滤机器标识/单字/未命名占位）+ `isCharacterMentionedIn`（子串命中，题材无关不依赖分词）。写入面：关系两端都以可指称名命中正文才绑 `valid_from`，任一端未出场→关系仍落库但 `valid_from=NULL`（规划候选通道）+ stub entity 打 `planningCandidate` 标记；无正文证据（chapter-state-rebuild 重放）保守放行不改判。检索面：`searchGraphMemory` 排除"抽取来源且未绑正文位置"行（`NOT (source_revision_id IS NOT NULL AND valid_from IS NULL)`），人工/legacy 关系语义不变；候选行仍可经 listRelations 人工裁决 | 集成级 4 用例三向：双方出场→绑定／客体零出场→NULL+候选标记／无正文重放→保守绑定；谓词归一 5 形态。运行库基线：现状 106 条抽取关系全绑定、69 种谓词（重启后新写入受门收敛，存量处置入作者决策清单） |
| PL-4② 名册出场标注 | enrichment 名册注入对未在正文命中的角色追加`【未出场：本章正文未提及此人名，禁止把泛指人物映射到它】`；prompt 加泛指人物不得映射未出场专名规则（结构判定与规划数据无关，通用） | 标注逻辑随①用例覆盖（同一判定单一真源） |
| PL-4③ 谓词受控枚举 + 其他: 逃生 | `RELATION_PREDICATE_WORDS` 单一真源（19 个跨题材人类关系词，"未知"类占位词刻意排除）→ schema pattern + 写入侧 `normalizeRelationPredicate` 兜底（中转不执行 json_schema 时：白名单外短词无损收进 `其他:<标签>`，句子形态归通用标签不截断） | 归一双测：`信任` 直通、`初遇`→`其他:初遇`、长句→`其他:关系变化`、空→`其他:关系未命名`、`其他:` 通道保留 |
| OR-E1（E6）MCP 只读工具 smoke + 禁裸吞 | 三处坏 SQL 列名修复（`provider`→`provider_label`、`request/response_tokens`→`provider_*_tokens`+补 latency_ms：novel_prompt_inspect/novel_invocation_list/novel_context_get 增强块）；context_get 两块增强独立降级 + `enhancementErrors[]` 显式输出；handlers 全部 5 处裸 `catch {}` 加结构化 warn（signal/describe/locator/digest/discovery）；**结构性枚举 smoke**：`mcp-readonly-smoke.test.ts` 按命名形态 `*_(get|list|query|inspect|queue|report)` 自动圈定只读面（新工具零登记进烟测面），fixture 项目跑全部只读工具断言无 PostgreSQL schema 漂移错误——"文档-代码互盲长期无人发现"的机制封堵 | 24 用例（真 PG 门 + 命名模式双向：历史坏三件必须在面内、写动作工具不得入面）；context_get 增强字段可达断言（旧 bug 恒静默缺字段的反证） |
| OR-A1（E1）候选健康度诊断 | `getRoutingCandidateHealth`：按 `(purpose,candidate_index,executor,profile_id,provider_label,model)` 窗口聚合，**样本≥minSamples(5) 且零成功 ⇒ neverSucceeded**（泛化谓词不点名路由）；`failed_wallclock_ms` 提为常规聚合指标（SUM FILTER status='failed'）；REST `/v2/routing/candidate-health`（只读诊断）；设置页横幅"从未成功，建议摘除或降权"+分钟数+逐条 purpose/候选#/provider/model 明细。运维挪路由与机制诊断分离，防配置再腐烂 | 集成 3 测双向：死路由命中+墙钟 6000ms 精确／健康不误判／2 样本低于默认阈值不判死；minSamples=2 参数化即入名单；sinceDays=0 窗口排除历史 |
| OR-A2（E2）terminalOutcome 终态子类型 | `terminal-outcome.ts` 单一规则：终态（completed/failed/cancelled）写 workflow_runs 必带 payload 固定键 `terminalOutcome`（status 枚举不动），显式业务判定优先、否则派生基础设施默认；弧"最大修订未过审伪装 completed"出口显式标 `business-revision-exhausted`；三种失败出口（弧超时/外部窗/StartToClose）经同一派生规则统一。非终态（running/waiting-external/manual-review-required）不注入=中间态不当结局 | helper 单测双向（注入/不覆盖/非终态原样）+ 集成 2 测（创建无键→completed 派生 succeeded→显式业务子类型保留→failed 派生；直接终态创建也注入） |
| OR-C1（E4 主体）守卫事件双写 | `updateWorkflowRunStatus` 凡 `payload.stage` 非空 ⇒ 双写 outbox `workflow.progress.<stage>`（含 projectId/runId/全 stage payload）——run payload 的 stage 是"后写覆盖"展示位（现状保留），事件表承担追加式守卫历史，阈值调参从"凭感觉"变"有分布"；**泛化规则无阶段白名单**（新阶段零登记自动可审计）。changeScope 意图通道（E4 后半，非后门契约需评审面语义设计）→ 移交作者决策清单 | 集成测 1 进 4 出双向：两条 progress 事件按序精确匹配+iteration 载荷、run payload 覆盖语义不变、无 stage 写入不混入 progress（计数恒 2） |
| OR-D2（E5 主体）嵌入幂等+归属 | **归属**：`ModelInvocationAudit.projectId` 显式通道 + `recordModelInvocation` COALESCE(显式, run 派生)——memory.embed/rerank 三个调用点（search/upsert/rerank）带 projectId，终结"1877 次 embed 100% 不可归属"；**幂等短路**：migration 085 `embedding_cache`（PK=sha256(model+text)，model 入键=向量空间隔离的正确性边界）+ gateway `EmbeddingCachePort` 注入（model-runtime 单点接线）——全命中零 provider 调用、部分命中只嵌去重缺失集并按实际模型回填（fallback 换模型写不同键）、空向量不缓存、**端口故障一律退化直连**（短路是增益不是新失败面）。E5 剩余两子项（结构化调用采样关联 context_manifest_id、估算/上报比值报表）→ 登记待做 | gateway 4 测双向（全命中零 fetch+原序含同批重复、缺失集去重单次调用+回填模型断言、lookup/store 炸均退化、无端口=原行为零回归）+ repo 集成（往返/顺序/模型隔离/DO NOTHING 幂等/引号文本参数化安全）；schema-ownership 守卫自动捕获新表并归类 runtime |
| SK-11（C6）承接契约口径统一 | 未解清单唯一权威读法常量 `UNRESOLVED_THREADS_READING_CONTRACT` 挂在 draft/review/revision 三面共用的蓝图解释器 `renderChapterExecutionContract` 的"章末未解"块（三面逐字同源，禁止第二载体）：未解=冻结边界非逐章必推清单；安静章不触碰合法；可报告问题仅两类（蓝图声明承接而正文未承载／承接与冻结边界冲突） | 双向 3 测：有清单在场／**空清单（安静章，误伤高发面）声明仍在场**／draft+review 包同源携带（漂移即红） |
| OR-B2/B3（E3②③）租约自洽+外部回退预算 | migration 086：`task_attempts.model_task_id` 显式关联列（回填 payload.modelTaskId）+ 僵尸外部租约收编（限 model_task_id 非空，业务 attempt 不误伤）+ CHECK `task_attempts_owner_required`（"无 owner 却 claimed/running"数据层不可能）；claim/heartbeat/submit/fail/reopen 五路径 join 全部改走 model_task_id（claim 写路径与业务 task_id 语义解耦——"从未跑通"根因封堵）；`MAX_EXTERNAL_FALLBACK_ADVANCES=6` 显式预算（workflow 沙箱纯常量对齐 DEFAULT_MAX_AUTO_REVISIONS 形态），三处超时推进型 waitForExternal 超限转 manual-review-required + 专属错误类，三处顶层 catch instanceof 保护不覆写 failed（Temporal 历史态与 DB 业务态分离）；`expireModelTask` 发 `model-task.expired` outbox 事件（waiting-external 超时不再静默，幂等） | 集成 6 测：**claim→heartbeat→submit 全循环首次真正跑通**（租约行 model_task_id/owner 断言＋偷锁 owner 拒绝）；CHECK 双向（无 owner 外部租约拒绝／有 owner 放行／业务 attempt 不受约束）；reopen join 双向（过期回 pending／有效不被抢）；expire 事件幂等；结构契约测 guards==throws==catchGuards==3 接线完整性 |
| OR-B4（E3④）周期对账 | `reconcileStaleWorkflowRuns(nowMs)`：running/accepted 超 6h→failed+`abandoned-stale-run`、waiting-external 超 24h（Temporal retention 对齐）→failed+`external-wait-timed-out`，reasonCode 落判据、`workflow.reconciled-abandoned` 事件、名下未认领外部任务随账清；**manual-review-required/paused 是等人的合法停驻态不收编**；乐观守卫（对账期间 run 自己推进则放弃本行）；creative_runs 同语义镜像收编；触发=REST `/v2/maintenance/reconcile-runs`（对账频率是运维决策，无隐式调度器） | 集成 3 测全矩阵：7d running/25h waiting 收编 + 5h/23h/10d manual/paused 四种保留双向；幂等重放不二次收编；竞态守卫（completed 不被过期判据覆写） |

### Batch 4 补账与偏离更正（2026-09-11/12，goal-3b02cf90 作者裁决项）

| 项 | 实现 | 验证 |
| --- | --- | --- |
| 台账数字更正：候选队列 | 本审计 §五"proposed 25/排队两候选"为审计时点值；裁决轮**全量台账 33 行 = proposed 14 / rejected 18 / promoted 1**（早期记录"2 queued"低估一个量级；正文别处"32 条"为裁决进行中的瞬时口径，以本行为准）。事实候选队列 91 条待裁决全部经裁决通道处理（approve/reject，`novel_fact_candidate_decide` 批量幂等），此后新提交产生的 candidate 属正常增量 | `craft_rule_candidates` 33 行全量清点 + `memory_claims` 裁决审计 |
| SK-2 晋升实测三案例（偏离更正） | ① `crc-…-f48c8df7` **已晋升**：narrative-continuity **1.0.1→1.0.2**（receipt `promote:crc-…-f48c8df7`=promoted，取代早期"未晋升"记录；该晋升发生在 sidecar 通道上线**前**，receipt result 仅 `{skillUpdates}` 无 yamlPatch 键——seed 已由裁决轮手工回写至 1.0.2 与 DB 对齐，sidecar 链路行为以 `craft-rule.test.ts:836` 为证）；② `crc-…-c680941a` **僵尸候选已 rejected**——near-dup 属语义级判重，按 `tmp/reject-zombie.ts` 裁决留痕为**人工语义判定**（`superseded-by-manual` 标签即人工通道），非 SK-2 合并语义自动判重命中（机械判重只对全字段等值成立），prose-craft 1.4.1 重复提案；③ `crc-…-a44d0f62`（story-arc-design 1.0.1）**作者裁决暂缓**留队——三条取代 Batch 3 表"⏳ 待做"对应旧状态 | promotion_receipts + craft_rule_candidates.status + seed yaml version 实测 |
| E4-changeScope ✅（Batch 4 曾登记移交，本批实施） | intent/blueprint `changeScope: mechanical-format/local-text/narrative`，评审面按档位收窄（两收窄档当前共享"只裁 character"集）、机械门禁任何档不绕过且期望 reviewer 集合与评审面同源（见 workflow-map §6） | change-scope.test：档位投影+非法拒绝+scope×taskClass 守卫双向（`createPreflightPlan` 纯函数层）+快照按档聚合 DB 双向（targeted-chapter-review）；契约测评审面枚举 |
| E5 两观测子项 ✅ | 采样关联 `context_manifest_id`（`NOVEL_CONTEXT_MANIFEST_SAMPLING` 默认 0.05，判定与物化在 `recordPromptExecution` 留痕本体——全消费面同源无绕过面）+ `getEstimatedVsProviderRatio` 分布报表 + 089 观测面索引（见 workflow-map §4） | sampling 命中确定性+哈希键翻转对测 + 降级面（物化失败不阻塞）+ repo 集成聚合形状测 |
| PL-6 阶段绑定 ✅（Batch 0 曾列 B1 关联项，本批收口） | `phases[].chapterOrdinals` 数据绑定、等分推算删除、校验面兜底（互斥/越界/全量覆盖，见 workflow-map §3）、`phase-binding-missing` warning、作者回写通道三重守卫 | story-arc-integrity 绑定解析双向 + story-arc.test 校验面双向（重叠/越界/部分绑定各拒绝）；health 阈值反例（3 天间隔记账不升 issue）；运行库 4 弧 14/14 阶段绑定 |
| 重基线生成面逐章契约 ✅ | arc2 rebase 首跑失败根因修复：chapters/revision prompt rebase 分支注入数量+globalOrder 覆盖硬契约（契约此前只在 validator 与死代码 `buildStoryArcRebasePrompt` 中——文档-代码盲区又一实证，见 workflow-map §3） | prompts.test 新用例双向；重触发 run `story-arc-39a8d918` 8/8 章通过 |
| 卫生历史重放 ✅ | `repairStoryArcReferenceHygiene` 重放审计历史影子、链式传递解析、悬空引用改指终结目标、不可解析影子不删；重放扫描面配 `audit_records(action)` 索引（089）且 seed 值短路消除审计 churn（见 workflow-map §11 PL-2 段） | story-arc-integrity 链式端到端 + 三反例（成环不动/无主不猜/历史重放修悬空）；prod 复跑删 3 死影子、弧引用零 unknown（replay 事件 `replayRedirectedArcs=[arc4]` 留账） |
| 弧 5 实践批（创作推进中抓出的缺陷 ✅） | ① **批次窗口系统分配**：弧 5 首跑（编排 7 章弧）模型输出单章批次静默通过——正常批次面窗口章数完全由模型裁量且"保留后续发展的空间"鼓励缩窗；`storyArcBatchWindow/assertStoryArcBatchWindow` 纯函数 + prompt 注入/内部+外部提交守卫/修订窗口不变量三面接线（窗口上限 16 三处同源收敛，旧弧无声明零回归，见 workflow-map §3）。② **prepareNext 量纲错配**：完成门槛拿全局 end_chapter_index 对照弧内 expectedChapterCount（弧 1 从 1 编号恰好重合，此后多章弧必误报"已达到预计章节数"——PL-1 同型错误推进面实例，弧 5 batch_start 首爆现形），改为弧内已投影章数判定。③ 比值报表非测量剔除（glm 系 998 行级 1/1 占位与只报增量伪测量拉塌 p50，两数量级判据+透明计数，见 workflow-map §4）。④ **FM-2 候选积压面板出生即坏**：`getFactCandidateBacklog` 第三个查询引用 `project_id=$1` 漏传参数，工具带必填参数直 throw "there is no parameter $1"——A3 轮的双向测试打在 gateway mock 层，真实 SQL 面从未执行过；修复+真实 Postgres 集成回归（逐章聚合断言）。教训：repository 契约测试必须有一路打真库，mock 只能测接线不能测 SQL。⑤ **门 payload 篡改门因**：workflows.ts 初版把 lifecycle 的诚实码 targeted-manuscript-approval 覆写成 quality-gate-not-passed（"统一看板"名义），4.83 全绿等批稿被读成质量门未过；且 payload merge 语义下门写入不带 stage 会残留上一 progress 阶段名——收敛为纯函数 `buildChapterGatePayload`（直通真值+显式覆写，双向回归），见 workflow-map 生命周期节。⑥ **complete 旗同族收口**：批次 complete 也是模型自报（弧1 满覆盖漏报 false、弧5 派生 true 存 false），投影处系统覆写 + migrate 尾 `repairStoryArcBatchCompleteFlags` 存量双向回补（无声明旧弧不动），与窗口共一条原则：系统可推导事实不留裁量权 | 弧 5 全批落地复验（本轮完成）：7 章 28-34 全部定稿（评审 4.5-5.0），execution_status 自动 completed；ch32 实证修订漂移家族——定向修订四轮未落地同一处账目残留且分数递减 4.5→3.8（部分应用漂移），**拒绝重出**在冻结事实上下文下一次收敛（缺角 0 次、两粒口径全章一致），作者指令本身也被事实账打回（"三粒丹"违 ch30 服丹事实，三审一致 revise）——质量门对模型与编排者双向拦截；20 条事实候选全量核验批准入向量索引（含 ch20 悬案对正文实锤）。旧弧窗口零回归：弧 1-4 无 expected 声明批次照常放行 |
| 弧 6 实践批（规划门死锁与作者反馈通道 ✅） | 弧6 编排首跑审核 verdict=revise（两条 major 均成立）暴露**人工门单向死锁**：manual 分支只等批准信号、revise verdict 下 approve 被门禁正当拒绝、MCP 无弧级决策工具（与章节门 `novel_chapter_review_decision` 不对称）——作者修订指令无处投递，唯一出路=放弃重建销毁蓝图。修复：`storyArcApproved` 信号扩展 `decision=revise+feedback`（旧载荷零回归）、manual 分支门循环（修订→重投影→重审→再入门，作者指令与审核意见合并）、新 MCP 工具 `novel_story_arc_decision`（49→50，REST 同语义）、源码契约测试三条；**修复上线即在弧6 自身死锁门 LIVE 验证**（三轮反馈环逐轮修净）。派生发现：① **编排输入无修正案通道**（run payload.plotOutline 落库后不可修订，蓝图与编排口径分叉被审核器每轮误报——本轮以弧内 plotNotes 登记偏差绕过，修正案通道列演进项）；② 修订自身会引入新连续性毛边（第3轮"又空了回来"措辞跳变、誊改时间锚点悬空），门循环按需多轮是唯一收敛路径；③ 盯梢契约教训：门间重入 status 不变，watcher 必须比对 reviewArtifactId 轮次而非 status；④ **批准双写竞态实锤**：MCP 工具先落库再信号，唤醒的工作流自行二次 approve 撞"当前状态不可批准"→ catch failStoryArc 把已批准弧打回 planning_status=failed（REST 历史顺序未爆属时序运气）——修复为信号优先单一落库（5ba6cfc），弧6 经正式复审路径恢复（failed 弧+已批准批次=普通复审不重生成，spec 恢复语义按设计兜住自家事故）。恢复环又爆两坑同批收口（6713e8b）：**读侧坐标系分裂**（批次行 start=35 系统派生 vs artifact echo start=1 模型自报，修订物化撞重基线守卫自锁）→ `loadStoryArcBundleArtifact` 读入即对齐批次行（精确匹配/单批唯一兜底/无行不动/多行无匹配不猜，行为面双向测试）；**rebase 谓词与 spec 偏离**（"覆盖已提交章节"实现弱化"挂过 document_id"，approved 批次+全 planned 章节零正文的弧误标 rebase）→ 谓词纠偏+弧6 形态双向用例，既有三用例 fixture 补 status 才暴露它们从未测过真谓词。恢复 run 首轮即 passed+auto 批准（五轮修订终稿过审），approved|active，ch35 开工。**弧6 收口（同日）**：ch35-42 全部定稿（4.40-4.67 均匀带，无 ch32 型漂移）、execution 自动 completed；35 章定稿 3474 字开场立岗棚，36 章把门修来的"回执背面附告发词抄件"锚点写成自然叙事，40 章"头一回替他挡了一下"悬置口径落地，42 章"老槐树三个字"问话戏收弧。资产账两错两拒：ch40 候选"不服丹留更险时辰"全文无丹字（虚构动机）、ch38"省丹备问话"动机误记（正文是夜守震颤+废石提醒），reject 留 reason，其余 27 条候选+4 条 staged 遗留全批（队列清零，含 2026-09-11 旧残留）；**编排指令第二次被事实权威打回**（ch41 投"丹为零"、正文实为一粒底牌——三审按蓝图放行，编排者账本让位于文本，无需 reject 即收敛）；编排者自错一次（ch39 指令误投自动选章的 ch38）经 reject→重出一循环收敛，SKILL.md 补选章-指令匹配纪律。health：blocking 0；warning 4 中 foreshadowing-overdue 69→101（弧6 新章未解项入账，**弧7 规划的第一议题=伏笔对账**）、arc-planning-failures 14/29（本批两新增失败均有修复提交，历史噪声结论不变）。 | workflow-contract 源码扫描三条（信号解析双向/门循环承重/两入口 revise 不落库批准）；弧6 门五轮修订环 LIVE 全过（终局"结构可靠"后收口三处定点）+ 批准竞态恢复环 LIVE 验证；工具数 gateway 50 双向 |
| 弧 7 实践批（知晓者现形 + 篇幅欠量门 ✅） | 弧7 编排（吸收弧6 门五轮教训：口径预冻结、plotNotes 登记偏差）**一次过审 passed**，7 章 43-49 全定稿、execution 自动 completed、批准走信号优先通道零双写（弧6 疤痕不复现）。实践中两抓：① ch47 作者定向修订暴露**memory-coverage/targeted reasonCode 直通已生效**（4dda136 LIVE 首验）+段落级部分应用漂移需第二轮单点补刀；② ch49 三审五 issue 三轮修订收束区纹丝不动（结构分 4.5→3.0 递减，ch32 同型漂移），reject→冻结账重出**一轮全绿**——但重出稿 1397 字静默定稿（目标 3500），与 ch32 重出 1472 字成对：审校面对计划兑现失明是结构性的（prose 契约明令不以字数判定，正确分工但留空档）。根因修复：`evaluateCommitGate` 篇幅欠量下限 length-under-target（0.6×有效目标，与 draft prompt 播报的 DEFAULT_TARGET_WORD_COUNT 同一账；未声明不检查零回归），拦进人工门不杀作者通道；gate reasonCode 优先链扩 qualityFailure/structuralFailure。 | 修订漂移双实证→reject 通道二次验证（冻结指令一轮收敛）；length-gate 双向四例（0.40 拦/floor 放行/未声明跳/blocker 优先级不劫持）+ builder 直通链三例；全套 111 files 1006 passed/27 skipped |
| 弧 8 实践批（两班倒与老位置：门的三连 LIVE 检验 ✅） | 弧8 ch50-56 全定稿、execution completed、编排一次过审、18 条事实候选全批（含抽验）。门的三连实战：① **篇幅门首拦生效即漏网修正**——review 流接线后 ch52 重审拦下 1222 骨架稿并走完"缝隙清单扩充法"重提交 3044 字（修订引擎对抽象"展开"无力的对策：给逐缝隙素材+字数额度+禁动区）；生成流接线补齐靠 ch52 事故回溯（首轮只接 review 流），bundle 方向锁入测。② **门因真值链全活**：blocking-issue（ch54 prose 政策分）、targeted-manuscript-approval（2198ea6 补 lifecycle.commitBlocked 直通后诚实上报）、overall-score（ch55 首触新分类码）逐轮现形，编排者不再对泛语猜门。③ **wrapper 检测误报根因修复**（1145e51）：短引导句形状（"黑屋里没有灯。楚衡…"）被 :95 判包装——形状判据叠加工件指涉词族（真包装必谈论工件），fixture 正反双锁。过程教训入档：作者定向批准二连 warning（ch54 章尾喻族）按判定批准留痕=门的作者通道首用；MCP 决策 actorId 署名纠偏（129fb18，此前审计面一律 web-author）；未部署的 schema 新字段被运行中 MCP 正当拒绝且 ajv 错误在 200 壳内静默——重启窗口与调用参数须对齐。 | length-gate 双向回归+生成流接线锁；structure 误报双向对；门因三分类码 LIVE 样本各≥1；弧8 7 章 2807-5300 字带内（重出后 ch55 5300 过交付） |
| 弧 17 实践批（补证人：缩骨处方成熟+终弧声明窗立法 ✅） | ch113-119 全 final、execution completed、13 候选全批（含 119 双位置账计划内改判核验）、overdue 68→0。**缩骨八例复盘定处方**：ch118 首稿 1728→"砍短拍全喂主场"重出 2438 过门（结构重构第二次验证，与 ch115 单日主场法并列成方）；跨时段/多主场并重的指令是缩骨高发形态。**终弧声明窗立法**：初谜梯族第三次到期滚窗（r10 71-84→r21 99-115→本次）逼出终规矩——44 条一次性入 120-148 终弧窗并在 reason 写死"到期必须兑现或弃账、不再滚窗"；24 条弧17 兑现族按名弃账（验你自己→三验、看一眼→丙册、柜底→空白挂格出处等，逐条给兑现链）。质量线：ch116 3140/118 2438/119 3309；warning-only 作者裁决第 4-6 次（判据零漂移）；缩骨带痕 3 章（114 2391/115 2364/118 2438）入池终章通读。正文最好句：不答的利息八分茶、收名帖式收问、网里最富的时刻是三揖无人看见。 | 账本治理从"滚窗"进化为"终局声明"；缩骨处方双验证成型 |
| 弧 16 实践批（看一眼：基线竞态与在飞门先查候选 ✅） | ch106-112 全 final、execution completed、10 候选全批（含 109→110 留单/取回两步链自洽核验）、overdue 6→0（4 弃全由弧16 兑现回收，2 续 113-126）。运维三则：①基础设施被并行会话重启（容器全 bounce+app 三件套 down），Start-Process 标准通道 20 秒补位，Temporal 持久化令在飞门完整存活零损失；②**基线竞态两踩**：ch110 批准异步未落即投 ch111 吃"正式稿基线已变化"整 run 报废、ch110 首发自动选章撞进 109 提交窗口——两戒入 SKILL 0b（批准→轮询 final→再发；显式 documentId 不豁免前章竞态）；③ch105 泄漏在 r28 在飞候选里早已修净未识别反开二轮——新纪律：**在飞门先查候选再补刀**。质量面：ch108/110 作者裁决连用（ch54 判据第 4-5 次）；ch109 青衣出现超计划配额（warning 级，配额控制入下弧指令模板）。 | SKILL 串行两戒落地；泄漏清偿战闭环（登记→在飞候选识别→批准清账）；全书 112 章 |
| 弧 15 实践批（用字的人：账文并查的两次自我纠错 ✅） | ch99-105 全 final、execution completed、12 候选全批、overdue 22→0（7 弃全给兑现链：歪圈→圈谱系升格、空白格→不是我留的白、第三行次→'带他'单实体等，15 续 106-120）。**对读净收益双样本**：①r22 我退役的"假账"经候选重现逼出三轮复核，终定 92 章内位移链（枕下老地方→章内折窄条贴胸骨左侧），12 候选全批；②r22 我自己补写的"91-98 静态枕下"author 补账经端到端精核证实同样失实（窄条/塞领口/掌压胸口在文，'贴身'字面不在被 regex 误杀过）——用 knowledge/claims upsert 对自家补账走 supersedes 改链为逐章位移史。教训升格：**补进去的账也要过对文关；regex 词组命中≠语义判定，位置类账要端到端读原文**。ch105'第99章'泄漏定向修两投未落地（修订落地率家族第 7-8 例）带痕批准留校置顶。 | 账文并查双向化（查假账亦查补账）；approved 态 author 补账可经 upsert 链改（通道实证） |
| 弧 15 开局 saga（外部兜底空转与孤儿蓝图 rebase 死路 ✅） | 编排四轮失败全谱取证：①首轮 provider 退化期 generate→external-required→15 分钟窗超时→候选推进但 activity 把 candidateStartIndex 钳制回终位=4 秒短路再造外部任务的**零进展死循环**（预算 guard 在位但 8×15min 节奏太慢，最终人工取消）；②取消恢复投 arc_start 撞上**孤儿蓝图死路**：失败尝试遗留的 blueprintArtifactId 触发 rebase 谓词→prepareStoryArcRebase"没有可重基线的已关联章节"三连败（每轮 3 分钟确定性即倒，先误判为环境抖动连查两轮才见真形）。修复 d542fac：rebase 判据收窄只认已投影章节（documentId），孤儿蓝图按普通重生成；tool 描述同步；双向回归例。第四投一次跑完 approved|active（ch99-105 全投影）。教训：失败弧恢复先读 RUNFAIL 消息再定性环境/逻辑，三连败且时长恒定=确定性 bug。 | 谓词收窄双向锁；外部兜底"零进展即抛"候选面治理遗留（见下注） |
| 弧 14 实践批（在岗：自动修订环加厚的极限测试 ✅） | ch92-98 全 final、execution completed、11 候选全批、overdue 59→0（13 弃均给升格/吸收链证据，46 续 99-115）。ch95 新数据点：**自动修订环连跑五轮仍救不回缩骨稿**（1726→仍缺"三则"段）——加厚失败不再限于定向环，reject 重出（指令瘦身 40%）一次到 2502；缩骨三例全部出自最长指令（92/94/95 同型），指令体量与稿件厚度的负相关升格为强怀疑。带痕批准累计 4 项（ch92 复读/ch94 加厚/ch95 三则标签化缺失/来字位置跨章疑点）——收口通读整治批已成规模，弧15 前偿还。弧内大事件：第三方谱系（同家不同手两枚圈）、存注一式入典（私路数→公格式的完整闭环）、《杂役区存形录》开张（护格不护名的账法命名）。 | 修订环加厚极限=自动五轮不中；全读校从"随弧登记"进入"成批偿还"临界 |
| 弧 13 实践批（活账：ch90 三轮收敛与终弧窗治理 ✅） | ch85-91 七章全 final、execution completed、15 候选全批。ch90 成'修订引入新伤'的教科书样本：首稿 3 major（状态线/传心机制/计数失真）→ 修②成而①③半落地且修订自造收束同构双 major（4.27→3.5 分数下探=漂移信号）→ 第三轮两处删净转 failed=0/4.83——'分数下探+新增 issue=停修转裁决'判据首次在本子内完整应验并据此批准。ch89 缩骨稿（1351 字三核心物全无）第二例：reject 重出用'核心物点名一件一个当场段'救回 2300。收章字数上限令（超 3500 返工）把 5125 型超带压到 3557。overdue 治理升级：初谜梯族随弧 11-13 全部到期的现实逼出**终弧地平线窗（92-120）**——16 条已兑现族按'观察目的达成即出清'弃账（颤搬家实证代偿树洞族），42 条长线一次性入终弧预留并作者申报（'第四续窗'话术已弃：静默滚窗与地平线声明的区别就是逃避与规划的区别，此处选择后者并写明）。弧尾'呼吸先于心跳=能做事的身子'与 84 章'直了的半音'成对回环。 | 修订漂移判据首次满环应验；地平线窗=账本机制对超长篇的适配修正 |
| 全读校清单（跨弧 warning/major 残留总账）✅ 结清（二次） | 首批五项结清后弧14 新登记四项再偿还：ch92 完成全程（整治轮一纯删致缩骨 1989→轮二 full reprocess 加厚把位移旧句带回（REPROCESS 修订引擎"加料必带回旧伤"新证据）→轮三逐字 REPLACE 手术落三句→轮四沿革句去历史化一刀→failed=0/2683 全绿重定稿），并揪出**事实层假账**（92 号"抽帖贴身"claim 提取自过程稿、与 91/98 定稿打架且霸占 subject×predicate 槽位挤掉真账）——经知识工作台 upsert 正主（id=假账 id）完成 supersedes 退役+真账重建+Qdrant 面核验，跨章连续性对读→账面对齐全链首次走通；ch95"三则"复扫为标签形式差异（'第一条：疑点存疑不算错'在案）实质已在，销；ch94 加厚项保留（扩展类须重出窗口，随下弧开刀不划算，入终章通读池）。 | 教训入流程：①整治=删除类可用 reprocess、加厚类必须逐字 replace 手术；②过程稿衍生的 approved claim 会抢 identity 槽挤真账，跨章连续性对读要账文并查 | 五项全部出账：ch67 daytime 经 targeted 一轮清除（重定稿 LIVE）；ch77 窗闩双写单删清账（targeted）；ch72×2、ch74×2 复扫定稿文本确认**已随 reject 重出被整段重写覆盖**（结论位唯一/衔接成实体段/门喻落身体），无需再修——教训入流程：带痕批准的登记项在章节其后被重出时应先复扫再排修，避免对已消失病灶开刀（本轮四项中两项即此型）。 | 全读校机制闭环：登记→批量销账→防过度修 |
| 弧 12 实践批（行次与人：审核习得约束前置的全面回报 ✅） |ch78-84 七章**全部零门自动定稿**（连续七章 draft→三审→事实→提交一气呵成，弧级生产首次无一次人工门停靠），全书 84 章。12 候选全批、overdue 16→0（8 弃均给出兑现链证据：空白格→除名的白、歪念头窄巷→'来'字屋子方位、两冷→第三级'无格式单'；8 续 85-98）。编排门一轮 28 条'动作-结论缺物理过渡'微修经合并裁决一次转 passed。工艺直评：ch82 戏眼章玉牌异象额度恰一次、ch84 收章三处'他不知道'即弧13 三引信（白格/膝跳去向/'来'字那头），'私账压官账'姿势收笔。审核习得四条（每拍配额/outcome 可蕴含锁/机制论断视角化/过渡动作补拍）已固化为生成指令标准件——本轮零门即其效果验证。 | 连续七章零门（历史首个满弧直通）；triage 脚本化第三次复用零事故 |
| 弧 11 实践批（半销：保新语义 LIVE 复验 + 全读校首批清账 ✅） | ch71-77 全定稿、execution completed、16 候选全批、overdue 58→0（20 弃含 r10 打错一位哈希漏网的 76b7cce、38 续窗 78-96 分族具因）。工程账：① ch77 完整走过"时序 major→定向修落地但 prose 退化正当回退→reject 重出拍序硬约束置顶→合同达成"全链——回退机制两副面孔（扩展盲区 vs 真实退化）同章同轮集齐，均判据正确；② 全读校整治环开张：ch67 daytime（issue_add→targeted 一词替换→重定稿）与 ch77 窗闩总结句单删（同路径）两项清账，保新/决胜语义 LIVE 复验通过；剩 ch72 两处+ch74 衔接/推论 3 项在列；③ 带痕批准的"债可偿还"首次验证：当初 waive 的登记项经正式闭环批量回收，止损不再是单行道。 | 两项 targeted 重定稿 LIVE；triage 脚本族化（分类 reason 模板+哈希表），58 条一轮清零 |
| 弧 10 实践批（抄房与记名：队列劫持与复读治理 ✅） | ch64-70 全定稿、execution completed、30 条候选全批（跨章污染嫌疑项逐条对文排除：64 柳木签/68 晾纸均为定稿自有内容）。工程四抓：① **typed-id 双代际键悬空**（6ecdeaa）：账本混存 raw-hash 与 `:anchor:` 两代键（117:94 实测），planner 按主导格式拼引用，弧10 批准被自家引用门禁判死（6 处 unresolved、投影成功而批准 failed）——resolveNamedReference 尾段哈希容错重试（唯一命中才解析、多命中仍歧义、无命中不放宽，双向四例），恢复走正式 retry 路径按设计兜住。② **同机双检出共享任务队列劫持**：并行旧检出（F:\ 老迭代）worker 与本仓 worker 同 poll 'novel-v2'，本仓活动被异代码执行（withholding 校验语义不同、review 挂死 30 分钟撞 StartToClose）；env 注入随计划任务被并行 supervisor 接管而失效，代码级默认队列统一 creative-studio-novel-v2（6afd6c7，隔离后同一恢复 2 分钟完成，对照 30 分钟挂死）。③ **质量键 warningCount 终位决胜**（93437ee：ch67 token 级一字修订两轮被"平手即回退"处决——修订稿明明已净仍回滚，warning 级修复在键上失明）。④ **复审摘录在场性机械门禁**（4f6eeb7：复审 prompt 内嵌旧 stageGoal 引文被复读型模型当现行问题再报，形成"落地→复读→回滚"死循环——'excerpt 须摘自当前正文'契约从提示词自觉升级为 toReview 输出机械执行，省略号分段保守判定、verdict 随孤证复读回推，双向四例；LIVE 复验待下个修订环）。过程账：ch64/65 骨架稿两次被生成流篇幅门拦停→reject+硬指标编号重出一轮救回（3217/2306）；ch67 外文稿语修不落地带痕批准止损（daytime 一词挂全读校）；ch58 引语归一（第一轮作者把替换方向修反被双审 major 拦回——修残稿漂移须先查蓝图冻结措辞再定方向，批准理由留痕）。 | 篇幅门生成流首拦×2 LIVE；复读门禁双向四例+全套 1018/27skip；弧10 批准链 anchor↔raw 容错 LIVE 验证；弧10 七章 2306-3475 字带 |
| 弧 9 实践批（带谁去：修订引擎表象陷阱与作者裁决面） | ch57-63 全定稿、execution completed、12 条事实全批（队列清零）。三件新账：① **ch58 场景插入三轮不中**：合同场景两轮 revise 未写入（第二轮 accepted 但'保留原候选'回滚使 artifact 原样——**accepted≠落地**，approve 前必须比对现稿文本），reject 重出指令硬指标置顶编号（A 篇幅带/B 场景与位置+'实时在场不是回忆'）第三稿直接过审；分层判据入 SKILL：词级令牌可救、场景级插入一轮不中即转重出。② **character-reviewer 赢回一次作者指令**：62章'认了不圆'节拍与'复刻不留花样'人设纪律冲突（major），作者先按方向①投修订、读到定稿该拍在门内侧的自洽论证后改判批准并写明边界裁决（门内身份线/对外复刻线分账，入事实账供后续承接）——门作者通道的双向语义（可驳审核亦可驳自己）首次完整行使。③ **fact 对账拦下台词归属错账**：ch58 候选'第二次说出照册走'对文核验为真（场景台词），章内夜念'看着路'系重出前稿残留微瑕（单章引语不一致，审校未抓），批准正确账、瑕疵挂全读校清单不带入事实层。overdue 存量 48 条弧9 前统一分流（8 弃 40 续窗 57-72）。 | 门因真值链再次 LIVE（length-under-target/targeted/blocking-issue 各现形）；三高危候选逐条对文（照册走归属/教话并案对冲/回话推测限知式）；ch63 尾拍自落弧10 钩（'再添一笔先认出那是什么字'） |
| 伏笔账本回补+回退 ✅ | `repairForeshadowingPayoffLedger`（migrate 尾幂等，084 漏账收口）；3 条无锚点"已兑现"作者回退 open（正文考古留审计） | foreshadowing-order 双向守卫；prod fulfilledWithoutPayoff 3→0 |
| books.title 投影修正 ✅ | migrate 尾 `repairBookTitleProjections` 幂等回填 stale `books.title` 投影（运行库实测已一致） | 重启后投影复验 |
| **方法论教训（追加）** | **DB 集成套件禁空过**：`TEST_DATABASE_URL` 缺失即整批 skip 曾被两次用于"全绿"证据（vacuous pass 事故：evaluation 31 用例实跑 20 skip 11）。修正=test-db.ts 响亮失败纪律 + 汇报必须区分"skip≠green"；**测试不得依赖人工外部 sync 的库内容**——v2 技能种子自举进 `migrate()`（`seedWorkspaceSkills`，SK-2 同护栏），evaluation fixture 改为动态选取库内绑定 `chapter.revision` 的启用技能（迭代产物须真正驱动回归对比，旧 fixture 写死 082 已停用的 `longform-continuity` 属腐化） | 全量真跑（TEST_DATABASE_URL 在场）：109 files / 974 passed / 31 skipped（skip 均为显式非 DB 门） |
| **ch20 教训（时长断言须有正文事实背书）** | 弧 3 蓝图 ch20 场景 situation 写"楚衡已用**两夜**想清楚怎么回答"，而正文定稿的章节内时间链（首访→限期→答复日）可数出的夜数与之不合——这是 D3"时间线三套账"在**规划输入面**的表现：读者可追踪的时长断言与账目日期各自漂移，三审只核正文互证从未对照蓝图 situation，蓝图成为第四套隐性时间账。处置：ch20 正式修订轮按正文实际过夜数改写 duration 措辞（走工作流非直改），B7 的"蓝图字段夹带执行/事实断言"边界登记扩展到时长类断言——planningRationale 只解释、situation 措辞不得夹带未经正文背书的计数 | 修订工作流留痕；D3/B7 交叉引用 |
| 剩余（PL-6 / E4-changeScope / E5-采样与比值报表） | ✅ 已于 2026-09-11 全部实施（作者裁决项④），见"Batch 4 补账与偏离更正"表与 workflow-map §3/§4/§6 | 全量真跑绿 + 运行库实测 |
