# 《程序员也穿越了》产出质量审核报告

**归档注记（2026-09-19）**：09-07 的产出面审核记录，其工具面/契约结论仍可在代码中核对（如 `novel_story_arc_orchestrate` 在 `mcp/tool-definitions.ts`、`authorDecision` 在仓储与 `author-decision.test.ts`），但文中引用的 commit（27e3d4a、6621078 等）因本地历史重建已不可解析；其问题清单已由 `product-audit-20260910.md`、`memory-governance-audit-20260909.md` 与 09-16/09-18 各轮审核接续，冲突处以更晚的审核为准。

- 审核对象：项目 `novel-spirit-code-rev-create-20260806-v1`（当前叙事进度：第 15 章，卷一）
- 审核方式：读取 foundation 五阶段产物、两条故事弧蓝图与审核记录、叙事状态账本（伏笔/承诺/线程），抽样细读定稿正文 6 章（第 1、6、9、10、11、15 章，覆盖两条弧、最高分/最低分/最新修订章），并核对章节审校工作流记录
- 审核日期：2026-09-07
- 章节评分概况：15 章均分约 4.39/5；最高第 10 章（5.0），最低第 8 章（3.83）；全部 final、无阻断 issue

---

## 一、总体结论

**整体质量良好，可以按现有流程继续推进；但存在 1 处跨章连续性硬伤、1 处弧级收束缺口和若干规划层一致性漂移，建议在开启下一条故事弧之前修复。**

工程化骨架（三层信息分级、四条长线线程、伏笔/承诺账本、章节状态转移+证据）是这套产出最强的部分；正文声部降噪（去"程序员黑话"）已真实落地。当前的主要质量风险不在单章文笔，而在**跨章时间线、弧级闭环、规划产物多版本一致性、账本卫生**这四类"章与章之间"的接缝上。

---

## 二、全局规划（foundation 五阶段）

### 做得好的

1. **project-positioning**：叙事基调完成视角降噪（"冷静理性、观察入微"替代"程序员视角"），建立"表面事实 / 异常现象 / 底层真相"三级揭示分层并明确"严禁开篇消费底层真相"，附概念译名表。creativeBrief 完整（读者承诺、主角矛盾、结局包络、六条 nonNegotiables）。
2. **plot-design**（当前生效版）：人物终点使用规范 `char_` 前缀（char_chu_heng / char_ye_qing_mei / char_xuan_ji_zi）；四条长线线程（tech-revolution / sect-suppression / spirit-anomaly / mortal-rise）均带 closureCondition、doNotConsumeBefore、责任卷分布与失败代价；endingEnvelope 区分 mustResolve / allowedOpen / multiPathArrival。
3. **worldview**：冻结"灵气潮汐是客观周期现象，人为大规模扰动触发区域性天灾"，为技术革命提供了真实的隐性代价来源。
4. **跨阶段职责分工清晰**：characters 阶段的声部锚点已统一为"理性、观察入微、善用类比"，不要求职业黑话入文。

### 问题（按影响排序）

1. **【major】characters 阶段同一 run 内存在三个相互矛盾的产物版本**（run 5990323d，"running"未收口）：
   - `d9d852ce`：宗门名"青云宗"（错误）、玄机子=青云宗掌律长老；
   - `51170d76`：修正为"中州灵网宗"，但玄机子身份变为"执事"，关系字段用对象键 `XuanJiZi`；
   - `9b81a281`（最新，已被上下文投影采用）：灵网宗、玄机子=宗门长老，关系键又变为 `Xuan_Jizi`。
   三个版本宗门名、身份、关系字段格式各自漂移，靠"再生成一版"收敛而非单一权威版本，说明 characters 阶段缺少跨 attempt 的命名/身份一致性校验门。
2. **【major】char_zhao（赵师兄）人物卡与正文及弧蓝图不符**：规划卡写"内门弟子、主角的直接管事"；而正文（第 6 章）与弧蓝图中的压迫者是**外门弟子赵虎**，"直接管事"是**刘管事**。正文自洽，规划卡未随正文修订同步，后续阶段若再消费该卡会二次引入漂移。
3. **【warning】概念译名表三处不一致**：positioning（死循环→功法死症、编译→灵物构筑）、characters（死循环→功法走火入魔、编译→圆融贯通）、plot-design（死循环→功法死症、无编译项）。正文目前未踩雷（全部用通用语），但同一机制三个"标准译名"是明确的契约漏洞。
4. **【warning】plot-design 修复版的信息分层丢失消费窗口**：旧版（06520614）的 informationBoundaries 带 consumeLimit（V1/V2/V3），当前生效版（4c1244bc）只有 levelOne/Two/Three 的类型与内容，窗口约束只剩线程上的 doNotConsumeBefore 兜底。
5. **【ops】运行卫生**：denoise run（5990323d）自 8/7 起状态停留在 running，但其产物已被上下文投影采用；更早的多个 bootstrap run 停在 running/pending/failed。run 生命周期与"产物已生效"脱钩。

---

## 三、故事弧

### 做得好的

1. **弧 1「异世初醒·外门求生」（第 1-7 章，completed）**：承诺-验证-觊觎三段结构完整；development 以问题链书写（每一问都有承接与反问）；每章状态转移带 evidence、场景带可观察动作/决策/代价/continuityConstraints；伏笔因果有支撑（第 5 章"衣角一闪"→第 6 章赵虎质疑，蓝图中明确补证据的 planningRationale）。
2. **弧 2「觊觎与立足」（第 8-15 章）**：线程责任明确（spirit-anomaly 只埋微观端倪、mortal-rise 休眠、sect-suppression 潜伏）；第 10 章作为 discovery 章与"粉末/蓝光/地下脉动"伏笔链衔接紧密。
3. **两条弧对 foundation 契约的消费正确**：未提前揭示灵气本质，玄机子/叶轻眉按规划"本弧不正面登场"，与信息分层一致。

### 问题

1. **【major】弧 2 的 resolution/exitState 在正文中未兑现，弧仍标记 completed**：
   - 弧 2 resolution 写明"化解赵虎的直接影响……完成了例供任务获取了立足资源……赵虎威胁暂时解除"；
   - 实际第 15 章结束时：例供期限**仅剩不到两天仍未解决**（承诺账本中 promise 仍开放），赵虎摊牌（ch13 被劫之后）**无下文**；最后一章（ch15）是 development 功能章而非 payoff 章；
   - 即弧的核心冲突缺少收束章，"completed"是账面状态而非叙事事实。
2. **【warning】弧 2 `expectedChapterCount: 15` 与实际 8 章（全局 8-15 章）语义混乱**，疑似把卷一级"15 章总量"带进了弧级字段，会干扰后续"弧是否规划完"的判定。

---

## 四、正文（抽样 6 章细读）

### 做得好的

1. **声部降噪真实落地**：全部样本无计算机术语入文；主角的理性通过动作与题材内类比呈现（ch1"宽阔官道/崎岖土路"、ch10"绷紧在深水里的琴弦/沉睡的心脏"）；刘管事、执事弟子的对白有市井烟火气，符合 stylePreferences。
2. **场景承载与博弈逻辑扎实**：ch6 威慑戏建立在"信息不对称 + 战斗后经脉紊乱的生理残留"上，虚张声势有物理依据；ch10 的地下脉动感知层层递进，且全程守住"伪装废人"的行为纪律（分心感知被呵斥、用擦地动作掩护）。
3. **压力线与钩子稳定**：ch11"三块灵石、三天期限"→ch12 药田小胜→ch13 被劫→ch14 发现监控→ch15 得知守夜恐怖，章末钩子与信息释放节奏整体在线。
4. **账本回写充分**：15 章的叙事状态（开放线索/伏笔/承诺）持续沉淀，ch15 的"影子/修养室/罚金"等新伏笔均登记在案。

### 问题（证据 + 定位）

1. **【blocker｜跨章连续性】第 1 章出现"三天灵石期限"，与第 11 章的时间线矛盾**：
   - ch1（rev 48，2026-09-07 定稿）末段："眼下最要紧的不是练功，而是先活下来——**三天之内凑齐三块下品灵石**的事还悬在头顶上""先活过这三天再说"；
   - ch11 第 31 行："他当然知道例供的事——**穿越过来这一个月**……"；第 33-37 行执事弟子**当日才宣布**"一共三块下品灵石……**三天内**，三天后若凑不齐，取消本月月俸，罚去黑风林外围守夜"；
   - 承诺账本中该 promise 仅在 ch11 登记。穿越第 1 天不可能存在该期限。该矛盾未被 9/7 的 ch1 全量三审拦截（workflow 结论"所有 reviewer 通过"）——章节级审核天然看不到跨章时间线，属于流程盲区而非单次模型失误。
2. **【major｜连载节奏】例供危机悬置五章无实质进展**：ch11 立期限 → ch12-15 期限内主角资源净损失（ch13 被劫走云纹草），"技术换生存"停留在 ch15 的内心宣言，未发生任何一次变现尝试。期限从"3 天"走到"不足 2 天"，紧迫感被反复消费而回报递延，是 ch8（3.83 分）之后第二个读者留存风险点。
3. **【major｜POV 契约违例】ch6 跳入赵虎内心并替读者拆解主角计策**：
   - 第 77-83 行："**这小子……什么时候有了这种手段？**""**赵虎心中惊疑不定。他自然不知道**楚衡这其实是走投无路下的虚张声势"——违反弧蓝图与架构明写的"楚衡有限视角、读者与楚衡认知同步"契约；
   - 第 95-97 行："**但这恰恰是楚衡的高明之处。**他用'刚打通的路子'暗示……"——叙述者直接讲破本可由读者从对话中推断的博弈，属"讲多演少"。
4. **【warning｜表层痕迹】**：ch1 第 93 行错字"**手碗处**"（应为手腕处）；ch15 第 173 行混入半角引号 `这座名为"修真界"的庞大樊笼`（全章其余为中文引号；该章 targeted 修订时系统已发出命名实体漂移警告，此处是其残留旁证）；ch6 第 197 行"在这个充满了**仙侠与玄学**的世界里"属元题材措辞出戏。
5. **【warning｜伏笔账本卫生】**：开放伏笔 30+ 条，其中至少 6 组为同一伏笔在不同修订下重复登记（如 90de4e9cfe67、88928a6db055、9b9221440253、cc0fe62f6a4d、ef22696c28a4、62b15d95beef 各出现两次以上）；多条"5 章内"窗口已超期（如《引气诀》书页灵气流动，ch7 前后埋设、ch15 仍未兑现）；另有 6 条 `expectedPayoffWindow: 未指定` 的悬空条目。账本只增不清，会稀释后续弧规划对"哪些伏笔必须兑现"的判断。
6. **【minor｜状态投影】5 章（ch2/4/8/9/15）文档级 `reviewVerdict` 为 revise，但状态 final、blockingIssueCount=0 且 targeted 修订已 authorApproved**——文档级判定未随修订通过而更新，容易误读为"仍有未解决问题"。

---

## 五、修复建议（全部走正式工作流，不绕质量门）

1. **ch1 时间线（blocker）**：`novel_chapter_review_issue_add`（severity=blocker，revisionRanges 覆盖 ch1 末两段，evidence 引用上文原句）→ `novel_chapter_review(mode=targeted)`，指令限定"删除三天期限表述，仅保留例供欠缴与原主守夜死因的压力"，修订后核对承诺账本仍只有 ch11 一条。
2. **下一条弧规划前**：用 `novel_story_arc_orchestrate`（或 `novel_story_arc_start` + authorIntent）明确本弧必须先兑现：① ch11 例供承诺（技术换生存的第一次实际变现）；② 赵虎线收束；③ 至少两条超期伏笔（书页灵气流动、膝部旁路扩容）。并在 plotNotes 中把"ch15 不足两天"的剩余期限写进 entryState。
3. **规划层一致性**：对 characters 阶段提交 `review.submit(verdict=revise)`，一次性修正 char_zhao 卡（外门同门恶霸、与刘管事职责分离）、统一三处译名表、恢复 informationBoundaries 的卷级消费窗口。
4. **账本卫生**：合并重复伏笔条目、为未指定窗口的条目补 `expectedPayoffWindow`，可在弧 3 规划的事实梳理环节完成。
5. **沉淀为学习候选（泛化机制，非个案修补）**：以上 blocker/major 暴露的是可复用失败类——"期限/承诺类事实在其建立章之前出现"与"弧 resolution 在末章无对应 payoff 章"。适合走 `novel_closed_loop_run` / `novel_rule_candidate_create`，机制方向：① 全量章节审核的连续性上下文需注入"未兑现承诺/期限类事实 + 建立章 + 剩余窗口"；② 弧收口校验应检查"resolution 中每个核心冲突在末章蓝图中有 payoff 功能章或显式移交下一弧"。
6. **运行卫生**：清理 zombie creative runs；文档级 reviewVerdict 在 targeted 修订 approve 后同步更新或标注"revision-cleared"。

---

## 六、值得保持的优点（后续弧应延续）

- 开篇即处境、以盘点动作代替心理独白的处理（ch1）；
- "可观察动作 + 决策 + 代价"的场景合同在正文中的执行度；
- 压迫者群像的对白质感（刘管事、执事弟子）；
- 主角每次技术动作都附带生理/暴露双代价，符合 nonNegotiables 的"技术不免费"约定。

---

## 七、修复执行记录（2026-09-07，全部走正式工作流）

### 1. ch1 跨章时间线 blocker + 错字 —— ✅ 已定稿（rev 48 → 49）

- 编辑意见：`09377b40`（blocker，时序矛盾，revisionRanges 51-54）、`660bc801`（warning，"手碗处"→"手腕处"，p47）
- 工作流：`chapter-review-8be7521b-...-ch1-timeline-fix-20260907-v1`（targeted，三审全过，4.27 → 4.83，authorApproved）
- 端到端验证：p51 改为承接原主守夜死因的"例供旧账"压力，p54 收束改为"先活下来再说"；全文无"三天/手碗"残留；未引入新期限；承诺账本仍只在建立章登记

### 2. ch6 POV 契约违例 + 元题材措辞 —— ✅ 已定稿（rev 17 → 50）

- 编辑意见：`6271279b`（major，POV 违例，p36-42 + p49）、`1beb1aa0`（warning，"仙侠与玄学"，p99）
- 工作流：`chapter-review-7637b96b-...-ch6-pov-fix-20260907-v1`（targeted，authorApproved；三审因范围外既存段落给 3.6，作者批准理由已记录）
- 命名漂移警告判定为假阳性："刚打通的路子/伤了根基"仍完整保留在对白中，"消失"来自叙述者复述段被删除的频次变化（正是修订目标）
- 端到端验证：赵虎内心独白与"高明之处"拆解段全部移除，改为外部可观察动作与楚衡视角观察；p99 改为"在这个人人把灵气视作天授之物的世界里"；对白完整保留
- 范围外遗留（未越界改动）：p16"让赵虎有些不悦"为基线既存的轻度内心标签，可在后续全量审校时一并处理

### 3. characters 阶段一致性（char_zhao 卡漂移 + 译名表三版本）—— ✅ 已 accept

- 路径：原 work item 卡在 running 且 Temporal 已结束，无法 review.submit → 走 `novel_bootstrap_run(focusedTaskKeys=["characters"], reviewGate=manual)`（run `b9d14b6d`）
- 新产物 `9f5c121c`：① char_zhao 修正为赵虎（外门弟子、楚衡同辈强势同门、底层恶霸，非内门非管事，压迫方式=抢夺/盯梢/言语威慑）；② 新增 char_liu_guan_shi（刘管事：外门杂役管事，月俸克扣与任务分派），与赵虎构成两层压迫链；③ 译名表统一为 project-positioning 权威版（死循环→功法死症/内存溢出→经脉过载/补丁→残卷修订/编译→灵物构筑/算力→神识负荷）；④ 冻结项完整保留（三人身份、voiceAnchor 降噪、下划线规范 ID）
- 门禁：plan.approve（作者确认）+ independent review passed（2 条 warning：plot-design 旧产物译名表未同步的跨阶段核对项、"刘管事独立弧线/赵虎后期投靠势力"待作者后续弧规划时确认）→ work item accepted，run completed

### 4. 未在本轮执行的遗留项

- **弧 2 resolution 缺口**：待下一弧编排时承接（兑现例供承诺、收束赵虎线、兑现超期伏笔），需作者参与方向决策，未擅自启动新弧
- **伏笔账本卫生**（重复条目/超期窗口/未指定窗口）：随下一弧规划的事实梳理环节合并
- **学习闭环沉淀**（期限类事实前置检测、弧收口 payoff 章校验）：可走 `novel_closed_loop_run`，涉及规则 promote 决策，留待作者确认后执行
- **工程卫生**：zombie creative runs 清理、文档级 reviewVerdict 在 targeted 批准后的状态同步——属系统代码层改动，需单独排期

---

## 八、第二轮执行记录（2026-09-07 晚，外部编排 LLM 直接编辑闭环）

### 1. ch15 第 173 行半角引号 —— ✅ 已定稿（rev 46 → 51）

- 编辑意见：`a4fb9471`（warning，p173 标点，evidence 附码位分析：全章 27 对全角引号 U+201C/U+201D 完美配对，仅该行 2 个 U+0022）
- 工作流：`chapter-review-2b5ad534-…-ch15-quote-fix-20260907-r2`（targeted，仅改 2 个标点字符）
- 命名漂移警告人工核对：appearedNames=[修真界] 为假阳性——该名称本就在被改行内，仅引号包裹规范化，disappearedNames 为空；全文逐行 diff 证实唯一改动即两个引号；作者确认后 approve（feedback 附完整证据链）
- 端到端验证：rev 51 全角引号 28 对完美配对、半角引号归零；承诺账本仍单行（内容派生键生效），开放伏笔无重复描述行

### 2. 工程卫生：审校判定语义厘清 —— ✅ 已提交（27e3d4a）

- 本报告【minor｜状态投影】项（ch2/4/8/9/15 "verdict=revise 但 final"）的根因是**消费方把 reviewer 判定与作者裁决混为一谈**：审校快照 verdict 本就随定向修订刷新（hash 与当前修订一致），作者批准覆盖是另一个独立事实（approval_evidence）
- 修复：项目详情/章节工作区投影按当前内容哈希对齐 approval_evidence 暴露 `authorDecision`；工作台在 verdict=revise 且 authorDecision=approve 时以"分数✓"覆盖标记呈现；verdict 语义不被作者批准改写（审校记录与作者裁决分轨留痕）
- 实测：5 章 authorDecision=approve 与 verdict=revise 并存，与报告记载完全一致；spec 同步至 `docs/novel-v2/workflow-map.md`

### 3. 工程卫生：集成测试库假阳性根除 —— ✅ 已提交（27e3d4a）

- ymcp_test 库 050 草稿校验和导致迁移审计失败 → 依赖该库的集成测试此前**静默跳过**（假阳性通过）；按 manifest 017/020 先例归档别名后，伏笔账本集成测试真库执行并暴露 2 处测试数据与内容派生 ID 契约的冲突，已修（测试数据隔离，生产代码无改动）

### 4. 仍未执行（与 §7.4 一致）

- 弧 2 resolution 缺口、学习闭环沉淀（待作者确认 promote）、zombie creative runs 清理；另：检测到工作区存在并发的「两阶段脚本生成」重构（staged-script-generation 等 8 个文件），未代为提交，留待该工作流自行收口

---

## 九、第三轮执行记录（2026-09-08，基础设施收口与学习闭环落地）

### 1. 并发工作包审查、spec 同步与代提交 —— ✅ 已提交（6621078）

- 两阶段脚本生成（staged-script-generation：规划骨架 + 每批 4 段撰写，阈值 6 段，fixed ≤60s 不变）、网关修复轮抬温（REPAIR_TEMPERATURE=0.7，根因：确定性 provider 修复轮逐字节复现同一非法输出）、解析失败保真诊断（区分解析失败与 Schema 失败，报位置与附近原文）、同步链路 ExternalMcpRequiredError 映射 503、设置页锚点导航重设计
- 本会话代为修复其中的明确简单错误（5 个未使用导入致 lint 失败），spec 同步至 workflow-map.md 第 6/8.2 节后整体提交

### 2. zombie creative runs 清理 —— ✅ 已完成

- 前置核对：Temporal `tctl wf list --open` 为空、4 个 run payload 无 pendingHumanDecision/externalTask；经 repository 正规通道（updateWorkflowRunStatus，outbox 留痕）标记 abandoned，payload 记录收割依据
- 结果：项目 running 状态归零（66 completed / 26 failed / 7 abandoned / 2 cancelled）

### 3. 学习候选①机制层落地：序列证据注入开放承诺账本 —— ✅ 已提交（e6c67cd）

- `SerialContextSnapshot.openPromises`：开放承诺按建立章序投影进 draft/review/revision/learning 的序列证据（不随窗口截断、孤儿修订如实标 null），渲染层给对照指令（引用不早于建立章、时限不得矛盾）而非硬禁令
- 主库实测：灵石期限承诺正确投影「建立于第 11 章」——本报告 §四.1 的跨章盲区在数据供给层消除

### 4. 学习候选②注册：弧收口核对 —— ✅ 已注册（crc-1788800435018-a44d0f62，proposed）

- story-arc-design arc.review 执行点补第 8 项「弧收口核对」（resolution 承诺的解决 ↔ 靠后章节蓝图功能承载或显式移交；安静弧按功能证据核对，不设事件性硬门）
- scope 四件套 + boundaries + regressionRisks 按泛化纪律撰写（无书名/角色名/章节号）；**待两份回归证据（原失败 + 异构场景）与作者确认后 promote**——promote 后系统自动重跑证据，失败自动回滚

### 5. 仍未执行（下一弧编排时处理）

- 弧 2 resolution 缺口承接（候选② promote 后弧审核将自动携带收口核对）、伏笔账本合并（随下一弧事实梳理）、候选②的证据提交与作者 promote 决策
