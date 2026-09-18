---
name: novel-mcp-orchestration
description: >-
  External-LLM orchestration flow for the novel-v2 MCP server: run the full
  Chinese long-form fiction creation pipeline as orchestrator, reviewer,
  driver, editor, and iteration optimizer. Maps every stage of the workflow
  (project creation, 5-stage foundation planning, story arc planning incl.
  the orchestrated plot-outline mode, chapter generation, three-reviewer
  chapter review, targeted revision, fact extraction, commit, closed-loop
  learning) to the concrete novel_v2 MCP tools, with decision rules for gates,
  review verdicts, revision targeting, and skill promotion. Use when acting as
  the external LLM driving CreativeStudio's MCP workflow, when asked to
  orchestrate 小说创作 MCP 流程, 编排剧情, 审核推进章节, 或迭代沉淀创作规则.
metadata:
  audience: external LLM agents and human authors driving the novel-v2 MCP server
  scope: process reference tied to the CreativeStudio MCP tool set; craft
    judgment lives in novel-writing
---

# 小说创作 MCP 编排流程（外部大模型作为治理者）

> 当前工具面：49（= 代码 `TOOL_COUNT`，由 `src/novel-v2/__tests__/mcp-tool-face-single-source.test.ts` 校验本文件与 spec 的声明）。本文出现的一切工具名都必须真实存在于注册表——外部编排者按本文行动，写到不存在的工具会直接造成调用失败与重试死循环。

## 你是谁：外部编排者

系统内部模型负责**产出**（规划、蓝图、正文、审核、修订）。你负责**治理**：
编排任务、审核产出、推进流程、下达编辑指令、驱动迭代优化。你**不直接写正文、
不改蓝图、不绕过质量门**——所有治理动作通过 MCP 工具落库，走正式工作流。

职责 → 工具族：

| 职责 | 工具 |
| --- | --- |
| 编排 | novel_project_create、novel_bootstrap_run、novel_story_arc_start、novel_story_arc_orchestrate、novel_chapter_generate、novel_run_create / novel_action_execute(work.enqueue) |
| 审核 | novel_workflow_get/list、novel_artifact_get/list、novel_story_arc_review、novel_action_execute(review.request/review.submit)、novel_review_submit、novel_chapter_review_decision |
| 推进 | novel_action_execute(work.accept/retry/recover/run.pause/resume/cancel)、novel_chapter_review_decision(approve)、novel_story_arc_batch_start |
| 编辑 | novel_chapter_review_issue_add、novel_chapter_review(mode=targeted)、novel_chapter_review_decision(revise+feedback)、novel_action_execute(work.revise)、novel_story_arc_orchestrate |
| 迭代优化 | novel_closed_loop_run、novel_rule_candidate_create/get、novel_rule_evidence_submit、novel_rule_foundation_evaluate、novel_rule_review_submit、novel_rule_promote、novel_rule_rollback |
| 派生产物 | novel_chapter_script_h3（定稿章节 → MiniMax H3 Ref2VA 短剧剧本提示词）。核心创意 → 短剧脚本已不走 MCP（见阶段 2.5 的 09-17 浏览器化说明），跨引擎候选发散由编排者自行完成后逐个调 REST |
| 查询 | novel_catalog_get、novel_context_get、novel_artifact_list、novel_story_arc_get、novel_workflow_get/list |

## 全流程各阶段

### 阶段 0 项目创建与宏观规划

```
novel_project_create(premise, genre?, creativeBrief?, reviewGate=manual|auto, progression=automatic|user-driven)
  → 自动启动 foundation 5 阶段（project-positioning → architecture / characters / worldview → plot-design）
novel_bootstrap_run(projectId, reviewGate)   # 已存在项目补规划
novel_catalog_get(projectId, compact)        # 确认规划状态
```

- 你可以在 creativeBrief 里写清读者承诺、主角欲望/矛盾、核心对抗、结局包络，
  系统会把它投影进每个规划阶段。
- manual 门禁：每阶段生成后等你的 `novel_action_execute(action=review.submit,
  reviewer=independent|human, verdict=passed|revise, issues[], summary)`
  才会推进。auto 门禁由系统按 foundation review + score 自动判定。
- 规划级审核契约（2026-08-06 起）：系统内部 Foundation / Story Arc 审核为
  文本意见契约——通过只输出单行 `PASSED`，不通过输出可执行审核意见
  （verdict 只保留 passed/revise，意见会作为重新生成的 instruction 回流）。
  你作为外部审核者提交 review 时，用 verdict=passed|revise + summary/issues
  承载意见即可；`work.revise` 的 instruction 会被注入重新生成 prompt。
- 对规划方向不满：`novel_action_execute(work.revise, workItemId, instruction)`。

### 阶段 0.5 foundation manual-gate 推进协议（实战验证）

manual reviewGate 下，bootstrap 的 5 个 foundation 阶段每阶段都要走"生成 → 审核 →
作者确认 → accept"。标准序列（approve 与 passed review 顺序不敏感）：

```
1. 生成后先读 artifact（novel_artifact_get）细读评估；放行前必须核对：
   语言契约（表层有无英文/技术原词，卷名/章节名是重点）、揭示物分层、
   跨产物一致性（卷数/实体关系/势力命名/地点）。
2. approve section（作者确认）：novel_action_execute(action=plan.approve,
   runId, workItemId)。等价于 repository 的 approveProjectPlanSection
   （actor=author），落库后发 reviewSubmitted 信号唤醒 workflow。
3. 提交独立审核：novel_review_submit(reviewer=independent, verdict=passed,
   issues=[跨阶段缺口登记清单])。落库即触发 reviewSubmitted 信号。
4. workflow 醒来 → recheckGate → acceptWork（校验：当前 artifact 存在
   passed independent review + section approved）→ accept → 下游阶段自动启动。
```

关键决策规则：

- **作者确认 ≠ human review**。作者确认 = `project_plan_sections` 该 section
  status=approved 且 sourceArtifactId=当前 artifact。human passed review 只是
  门禁签收之一，不能替代 approve；反之亦然。
- **approve 与 passed review 顺序不敏感**：workflow 对两个条件分别有等待循环
  （foundationAuthorApproved 检查 + reviewSubmittedSignal），二者都落库即自动
  accept；先 approve 或先 review 均不会失败（workflows.ts 的 accept 路径先等待
  作者确认再 accept，manual gate 路径先等待 reviewSubmitted 再 recheckGate）。
- **不必等自动独立审核落库**。自动审核（workflow 内部 reviewFoundationWork）
  落库与否不影响放行：只要 approve + 你的 passed review 就绪，acceptWork 即通过。
  自动审核若之后落库 revise，不会推翻已 accept 的产物（bind 到 artifact）。
- **绝不手动 work.start / work.revise 干扰自动循环**。自动审核给出 revise 后
  系统会自动修订；此时手动 start/revise 会与 workflow 竞态，触发
  "CreativeWorkItem 状态非法" → workflow failed 且不可恢复。
- **跨阶段职责判定**：自动独立审核常把下游阶段职责（能力边界→worldview、
  主题入选择→plot-design、群像横向关系→故事弧）判为 blocker。判定规则：
  本阶段核心职责是否达标 + 缺口是否登记为跨阶段审核清单 → 达标即可放行，
  不必在当阶段解决下游职责；清单在对应阶段审核时核对落地。
- **workflow failed 不可恢复**（Temporal 终态）。常见原因：模型服务 503 /
  状态竞态。缺作者确认不会导致 failed——workflow 会持久等待 approve（或暂停/
  取消时退出等待）。处理：模型服务恢复后 `novel_bootstrap_run` 重启
  （同项目幂等），已批准产物会被新 run 重新生成覆盖。
- **弧批准"引用无法解析"分诊**（弧14/16 两型实证）：先查被引哈希在账真身——
  ①存在但代际/装饰错形（`:anchor:` 双代际、`_ref_unused` 拖挂）：resolver 已有容错，
  直接 `novel_story_arc_review` 重试即过；②账上零存在（planner 幻觉哈希）：**review
  重试无用**（原 bundle 重审撞同一引用门禁），走 `novel_story_arc_start(arcId)` 重生
  成新 bundle，authorIntent 明写"引用一律逐字复制台账现有 id、禁自造哈希"；
  无 documentId 投影章节时谓词已保证走普通重生不误入 rebase。
- **learning 记录**：review 落库后按 AGENTS.md 汇总 issue 模式；可复用机制
  沉淀走 novel_rule_candidate_create（scope 四件套）。

### 治理者纪律（2026-08-06 起，实战沉淀）

- **契约核对前置**：下达修订指令 / 编排 / 审批前，先核对目标产物的 schema 契约、
  人物 ID 规范（characters 阶段使用 `char_` 前缀 ID，如 `char_chu_heng`）与下游
  消费方（foundation-contract 校验、full-book-architecture 审计）对字段格式的要求。
  给错误 ID 或错误格式的指令会让模型产出再次违约，拖长返工链。
- **优先 review.submit 驱动修订**：需要修订 foundation / 弧时，首选
  `review.submit(verdict=revise, issues=[意见])`（意见自动作为 instruction 回流）；
  `work.revise` 仅用于携带自定义指令，落库后不要再手动 `work.start`（修复后的
  workflow 会自动拾取 pending）。
- **修复后做端到端验证**：修改系统代码（超时、解析、校验、prompt）后，用真实数据
  验证整条链（如用真实审核文本验证 `parseTextReview`、用 `auditFullBookArchitecture`
  验证审计通过），再继续流程；不要等下一次流程暴露。
- **工具调用纪律**：工具参数必须是严格的 JSON 键值；一个消息只发格式正确的
  工具调用，不要把分析文本混入参数，不要输出畸形的调用块。
- **叙事基调核对（视角降噪）**：审核 foundation / 故事弧蓝图 / 正文时，检查主角的
  特殊视角（职业思维、专业训练、天赋等）是否被写成**叙事语言主导**：① 声部锚点是否要求
  "用职业黑话/专业隐喻描述现象"（应改为"理性、观察入微、善用类比"等可感特质）；
  ② 章节设计（标题/场景/决策/结果）是否直接使用职业黑话原词（应转译为题材通用表达，
  机制只在 planningRationale 说明）；③ 正文是否以专业思维解说代替动作与场景（应通过观察、
  判断、行动与结果体现认知优势）。发现即修：规划层约束 + 正文修订，确保正文是
  普通读者可读的叙事，专业设定只作能力来源。项目特有的黑话转译示例放在该项目
  creativeBrief 或项目级 skill，不写入共享提示词层。

### 阶段 1 故事弧规划（两种模式）

**模式 A 系统自规划**：`novel_story_arc_start(projectId, authorIntent?)`
→ `novel_story_arc_get` 查看蓝图 → 审核/推进：
- `novel_story_arc_review(projectId, arcId, reviewPolicy=manual|auto)` 恢复/重审
- `novel_story_arc_decision(projectId, arcId, decision, feedback?)` 人工门放行（reviewPolicy=manual 且工作流停在 manual-review-required 时）：`approve` 批准当前蓝图——**审核 verdict=revise 时会被门禁正当拒绝，不要硬批**；`revise` + feedback 把作者修订指令送进等待中的门，系统合并审核意见走定向修订→重审→再入门（feedback 写"改什么、怎么改、不许动什么"三件套，点名蓝图字段与不许消费的边界）
- `novel_story_arc_batch_start(projectId, arcId, retryFailed?)` 推进下一批章节。**批次窗口由系统分配**：单批章数 = 弧内剩余未规划章数（上限 16），prompt 注入、内部/外部提交守卫与修订面同契约，外部编排方提交 chapters bundle 时章数必须恰等于该窗口——多与少都会被拒绝进审核，不要按"少出几章更稳"自行缩窗

**模式 B 外部编排（你提供剧情编排，系统完善）**：

```
novel_story_arc_orchestrate(projectId, plotOutline, reviewPolicy=auto)
  plotOutline = {
    objective（必填：本弧讲什么、解决什么读者问题）,
    title?, entryState?, centralConflict?, development[]?, resolution?,
    exitState?, threadResponsibilities[]?, expectedChapterCount?, phases[]?,
    chapterHints[]?, plotNotes?
  }
```

- 系统负责**完善**：对照冻结事实与叙事状态账本做事实梳理，补全场景因果、
  章节状态转换、连续性约束与章节蓝图，再走正式弧审核 → 修订闭环。
- 编排权威顺序：已定稿事实 / 叙事状态账本 / 作者边界 > 你的编排 > 模型自行发挥。
  编排与事实冲突时系统以事实为准，你不需要预先消化全部事实——但**先调用
  `novel_context_get` 做事实梳理**，能显著减少修订轮次。
- 编排被拒绝的边界：没有 objective；只有 objective 没有实质编排内容
  （至少给 development / plotNotes / entryState / chapterHints 之一）；
  threadResponsibilities 条目缺字段或 threadRef 重复；expectedChapterCount 越界。

### 阶段 2 正文生成与审核闭环

```
novel_chapter_generate(projectId, documentId?, instruction?)
  → review（structure / character / prose 三审）→ targeted revision
  → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters
novel_workflow_get(workflowId)    # 轮询进度；temporal 字段反映真实运行状态
novel_chapter_review_decision(workflowId, artifactId, decision, feedback?, revisionBase?)
```

作为编辑者的正确做法：
0. `novel_chapter_generate` 不带 documentId 时自动选弧内最早 planned 章——**instruction 必须
   与该章匹配**：先确认选章结果（返回体 documentId 与章号）或显式传 documentId，再把指令投出
   （2026-09-12 实证：编排者把 ch39 观测章指令投给自动选中的 ch38 服丹章，候选稿撞蓝图被审校
   拦进门，reject→重出一次收敛——错在自己时 reject 通道同样有效，作废理由写进 feedback 留审计）。
   0b. **生成指令标准四件**（弧12 实证：七章全零门直通，指令质量=门停靠率的唯一变量）：
    0c. **串行时序两戒**（弧16 两踩实证）：①approve/带痕批准后必须轮询到该章 final 再投下一章——提交是异步链（事实提取→enrich），固定 sleep 会撞'正式稿基线已变化'竞态整 run 报废；②显式 documentId 不豁免①：前章未落定时投新 run 同样吃基线锁——节奏=批准→轮询 final→再发。
   ①每拍字数配额（"三大拍各≥650字"优于整章带宽——骨架稿只在无逐拍配额时出现）。
     ①b **配额必须不等量**（2026-09-17 全量复扫确诊，docs/novel-v2/ai-taint-diagnosis-20260917.md F1）：
     等量配额（"六段各≥550字""每段 220-280 字"）的最省力满足方式，是把每段写到配额线附近——
     于是全章段长趋同、无长段造压也无短段落刀，读起来像工序表逐格填满（实测：141-168 的段长
     变异系数降到全书最低 0.62，ch167 仅 0.07）。配额要写成**带重量差**的形态：给最重的一拍
     一个显著更大的配额（如"题眼拍≥900字，其余三拍各 300-450 字"），并显式留出**独立短段**
     （"至少两处让一句话单独成段，收刀用"）。判据是"段长有重量差"，不是"段段达标"。
   ②outcome 可蕴含锁（凡涉他人心理/系统意图的结论，当场写明"只记行为不记心意"级
   的合法落点，越界措辞列为禁区并给替代表述）；③机制论断视角化（世界观机制的解释
   禁止以叙述者断言出现，给"旧规矩里有过这种改法"一类的角色内视角示例）；
   ④动作-结论间补一拍身体过渡（推定/确认/被看见类结论前必须有落眼、停息、扫视等
   物理证据动作——弧规划门 28 条微修的绝大多数即此型，前置一句省一轮门）。
1. 读候选稿与三份审核：`novel_workflow_get(workflowId)` 拿 artifactId →
   `novel_artifact_get(artifactId)` 读正文与审校 issue。
2. 追加你的意见：`novel_chapter_review_issue_add(projectId, documentId,
   severity, title, evidenceQuote, paragraph|revisionRanges, suggestion?)`
   —— 只写 pending issue，不改正文；同机制多处必须用 revisionRanges 一次覆盖。
3. 定向修订：`novel_chapter_review(projectId, documentId, mode=targeted,
   targetIssueIds=[...])` 走正式修订闭环（仍是完整审核 → 事实提取 → commit）。
4. 或者在工作流等待处 `novel_chapter_review_decision(revise, feedback, revisionBase=current|previous)`。
   修订残留（收束区/个别措辞反复改不净是修订模型的稳定弱点，弧5 ch32/弧7 ch49/弧8 ch51
   三实证）时，升级为**令牌级指令**：逐字引用原句 + 给出替换句全文 + 声明"其余零改动"；
   一轮即净。分层判据（ch58 实证）：**词级/句级替换**令牌法一轮可救；**场景插入**
   （合同要求的整拍缺失）令牌法一轮不中即别再耗——直接 reject 重出，重出指令把
   硬指标置顶编号（A 篇幅带 B 必含场景及其在章内位置），缺失场景写"实时在场，
   不是回忆不是暗示"。结构性漂移（分数递减+同区三轮不修）同样 reject 重出，
   冻结账本逐日写死。令牌法两条铁律（ch64 实证）：引用原文必须**逐字**（意会式引文
   会让修订模型静默不执行而回 accepted）；每轮结果以**目标短语在现稿中的存续计数**
   验证，不看 accepted——修订环还有"回滚保留原候选"路径，accepted+文未变=没救到，
   连续两轮未救到即转 approve 权衡或 reject 重出。修订动词分界（ch58/65/74/94 五例实证收口）：定向修订对**替换/删除**类指令可靠（词级句级一轮即净），对**添加/插入**类系统性不可靠（分段加料与逐字锚点插针均不落地，且易自造尾部议论引入新伤被正当回退）——需要加厚/插拍时跳过定向环，直接 reject 重出并在重出指令里逐拍配额。
    ④b 定向环单发纪律（2026-09-16 ch102 四轮全灭实证补刀）：删除/替换类虽属可靠族，但**一个候选内多处并发**时模型只改首处并连带把目标所在整句删坏（两段双删指令、全段替换令、纯誊写令三种表述均复现同一路径依赖失败）。纪律：一处 issue 只锁一个段落一个目标；多处即拆多轮单发（每轮候选差异段=1、保留句在位双验证再批）；同章同型失败两轮即 abandon 入带痕池等重出窗口，不烧轮。
    ⑤跨时段结构防缩骨（ch115 三稿实证：缩骨七例复盘）：指令若让模型写'三天/连续多日'的编年结构，首稿必压成目录——对策不是加字数令，是重构为**单日主场特写+其余降为晨昏短拍**（每拍给逐刻动作清单）；重出两次仍薄即改结构，第三次再 reject 是浪费。
    ⑥反 tic 预算（2026-09-16 全语料扫描入册，防生成端再染）：每章指令默认带——对比句'不是A是B'≤2、'X息'计时词≤2、禁'这层/一层'类层语进正文（编排术语不出现在散文）、场景收梢隔章限一次格言位、明喻预算放宽为一处+允许暗喻替代（旧'比喻限两处'压枯了健康比喻——预算令要留生长空间）；身体讯族（后颈/手心/耳壳/喉结/指腹）同族每章≤2 且跨章轮换部位。
    ⑦对手戏配额（2026-09-16 结构扫描确诊：对白密度弧8-10 崩至 1.68/千字、四章零对白——逐拍内心节目单式编排的根因）：每弧蓝图≥1/3 章必须有'非主角意志驱动的事件'进场（他人有欲望有代价地行动，不是道具）；每章指令默认含'≥2 段活对白且对白改变处境'（寒暄/复述型对白不计）；静是合法章功能但每弧至多一章纯静，写静章前先答'这章的静在跟谁说话'。
    ⑦b 最小场景合同（ch121 实证：对白指令在缩骨稿中被整体蒸发——对白是最先被砍的'可选'形态）：凡要求对白，必须把对话写成在场锁四件套——'[对白合同] 谁（带欲望的具名差称）/为何在场（他不出现本章有损失）/≥N 轮且每轮改变处境/说完各自去哪'，并列入'缺失即拒'清单与拍配额同级；只写'加一段对话'无效。
    ⑦c 重出无上稿（ch122 双踩实证）：reject→generate 是**从蓝图+指令全新起草**，不存在承接的上稿——'其余与上稿全保/只改X'类增量指令对重出无效（对白与角色会再蒸发）；要承接旧稿优点必须把旧稿的可保内容整段转写进新指令（自足化），或改走 gate 内 revise（有 previous draft 在场）。同一章重出两次仍薄，第三次一律走'自足全量指令'。
5. approve 前检查：有 blocker/major 而你要 approve，必须给 feedback 理由。

### 阶段 2.5 短剧剧本提示词（章节派生与核心创意两条路径，只读派生）

```
novel_chapter_script_h3(projectId, documentId, instruction?)
  → artifacts(kind=chapter-script)，返回各片段 promptText

# 核心创意 → 短剧脚本：2026-09-17 起不在 MCP 工具面内（`novel_short_script_h3`、
# `_brainstorm`、`_submit` 三个工具随"独立短剧改浏览器本地存储"一并移除，见
# docs/novel-v2/workflow-map.md §8.2 末 09-17 更正条目）。现行入口是后端单个
# stateless 端点，不走 MCP：
#   POST /v2/short-script-h3
#     body: idea, instruction?, durationMode?(fixed|auto), targetDurationSeconds?,
#           projectId?, materialRefs?, avoidMotifs?
#     → 生成即返回、不落库、不复读服务端幂等；产物与历史存浏览器 IndexedDB
#       （src/lib/shortDramaStore.ts，按 localKey 去重）
#     → 返回含 creativeStrategy（主引擎承诺：hookType awe/humor/conflict + subversion + signatureMoment）
```

**候选奇观发散（原 brainstorm 工具已移除，由编排者自行完成）**：
- 为什么仍要做：开放命题直接喂给生成会因缺具体承诺而塌缩到该题材的默认母题
  （同类创意每次同款、且与自己的历史作品换皮重复）。
- 现行做法：编排者自己以「创意策划」视角穷举 N（2-6，建议 3）个彼此明显不同的
  可拍候选，count≥3 时保证至少两候选分属不同主引擎（震撼 / 搞笑 / 剧情），每个候选
  写清 wonder（可直接作 `idea` 的具体奇观）、主引擎标签、相对其它候选的差异点；
  挑定后逐个调用上面的 stateless 端点。
- 反同质：把近期已产出短剧的核心创意清单作为 `avoidMotifs` 数组随请求传入
  （前端面 `listShortDramaRecentIdeas` 提供同一份清单）——这是差异化要求，不是内容禁用。
- 需要精细控制节拍/结构时，编排者自行产出模型形态 JSON 后按端点契约提交；
  原 `*_submit` 双轨不再有 MCP 工具承载。

**路径 A（章节派生）**：
- 仅适用于已有正式 revision 的 final 章节；是正文的只读派生，不走工作流、
  不进质量门，也不影响后续编排。
- 输出为 MiniMax H3 全参考模式（Ref2VA）提示词：一章拆多个 10-15 秒片段，
  每片段一条自包含六段提示词（含 subject_definitions），片段内可含多镜头；
  人物外观基线由顶层 characters 统一，对白保留中文原文。
- 同一定稿内容幂等复用既有产物；要重新生成先让正文重新修订产生新 revision。

**路径 B（核心创意，独立于小说项目）**：
- `idea` 写清谁/何处/什么（人物冲突或场景奇观均可，≥10 字符）。两层承诺并存：
  **吸引力设计契约**（契约 v10）：产物顶层 `creativeStrategy` 承诺主引擎
  （awe 震撼奇观 / humor 搞笑反差 / conflict 剧情冲突）+ 一处预期→反转 + 唯一
  记忆镜头，节拍非铺垫即引爆、末段切在记忆镜头上；生成时自动注入近期产物的
  核心创意作跨作品反同质回避清单。**创意意图忠实性契约**按创意文本判定类型：
  剧情型走冲突导向剧作模式；展示型（只描述场景/世界观/氛围/视觉奇观或荒诞反差）
  走视觉展示/喜剧错位模式——禁止自行注入追击、战斗等对抗事件，搞笑靠错位不靠
  威胁）。时长两档：`durationMode` 缺省
  `fixed` 时按 `targetDurationSeconds` 10-180s（默认 30s，各片段 10-15s）固定
  目标时长；`durationMode="auto"` 时不限时长——总时长与片段数由模型依据创意
  自行编排（节拍完整优先，段数硬顶 36、每段仍 10-15s），产物 `targetDurationSeconds`
  回填实际总时长；`projectId` 可选——缺省为独立短剧
  （完全不需要小说项目），填写时产物关联该作品作衍生短剧。
- 产物存 `short_scripts` 独立表（契约 v2），经 REST `GET /v2/short-script-h3/:scriptId`
  读取（详情含 creativeStrategy 回显）；同作用域同创意输入幂等复用。
- 两条路径共享六段式结构与结构特征校验；创意模式专属指引：节拍为设计而非
  穷举、末段切在钩子/记忆镜头上（开场即冲突等冲突导向规则仅对主引擎 conflict
  生效）。
- 写作方法论见 h3-prompt-writing skill（SKILL.md + references/base-en.txt +
  references/ref-en.txt）；系统生成时已自动注入对应运行时 Skill 指引。

### 阶段 3 事实梳理与记忆（编排/编辑前必做）

```
novel_context_get(projectId, sections?)
  sections: foundation / recent-chapters / narrative-state / open-elements / planning-feedback
novel_catalog_get(projectId, documentStatus=["final"])
novel_artifact_list(projectId, kind?, workflowId?, limit?)
```

- 编排剧情前读 narrative-state + open-elements（开放线索/伏笔/承诺）+ recent-chapters。
- 定位审校对象时用 novel_artifact_list 拿 artifactId。
- **弧收口伏笔对账（必做）**：`novel_foreshadowing_list(projectId, status=open, limit=400)`
  取全量开放伏笔与 overdue 判定，逐条三选一：本弧 digest（把 id 写进编排的
  foreshadowingRefs/phase 目标）、改窗续期（`novel_foreshadowing_triage` action=rewrite-window，
  弧尾章之后新窗口）、放弃（action=abandon）——放弃是作者终局决定，reason 必须写"为什么
  正文不会再承接"，不许用 rewrite-window 无限展期逃避对账（展期两次以上就该兑现或放弃）。
  兑现不经此门：正文写出来由事实提取的 payoffs 账自动翻 fulfilled。
  **id 必须逐字用 list 返回的全值**（存在 `:anchor:` 三段形态，截尾哈希会整批静默
  skip）；"正文已兑现但 payoffs 漏联"的行按 abandon 出账并在 reason 里注明漏联。

### 阶段 4 学习闭环与经验沉淀

```
novel_closed_loop_run(projectId, documentId, dryRun?)
novel_rule_candidate_create(targetKind=skill|system-prompt, targetId, afterText, rationale, scope)
novel_rule_evidence_submit(candidateId, scenarioClass, scenarioRole, baselineWorkItemId, candidateWorkItemId)
novel_rule_foundation_evaluate(candidateId, taskKey, scenarioClass, scenarioRole)
novel_rule_review_submit(candidateId, role, reviewerId, reviewRunId, model, verdict, summary, concerns)
novel_rule_promote(candidateId) / novel_rule_rollback(candidateId)
```

- scope 四件套必填：observedSymptom / failingLayer / underlyingMechanism /
  affectedInputClass；建议补 boundaries / regressionRisks。
- promote 前必须有原失败场景 + 异构场景两份回归证据（scenarioRole 分别
  source-failure / cross-scenario），promote 后系统自动重跑证据，失败自动回滚。

## 质量门与决策规则（必须遵守）

1. **不绕过门禁**：没有"直接改正文"的工具；一切修改走正式工作流。
2. **审核指向证据**：issue 必须带 evidence / excerpt 和 revisionRanges
   （1-based 段落号）；不要写没有证据的审美意见。
3. **局部退化守卫**：commit gate 有"总体改善 + 单 reviewer 局部下降上限"，
   你的审核意见应给出可定位的范围，而不是"整章重写"。
4. **串行约束**：同项目章节审校互斥；`projectActiveReviewWorkflowId` 存在时
   等待其完成，不要并发启动。
5. **unresolvedAtClose 是冻结未解边界**：局部修订不得删除/回答/合并其中的问题。
6. **修订是定向的**：targeted 模式只修 targetIssueIds；完整审核的其他意见
   不会自动扩展进本轮。
7. **学习候选要泛化**：机制描述不得包含特定书名、角色名、章节号或短语；
   审核它的人按"是否覆盖失败类 + 是否误伤异构场景"判断。
8. **编排只给方向**：不在 plotOutline 里伪造事实、替人物宣布感情结论、
   或要求提前兑现伏笔——那是审校会挡回的内容。
9. **LLM 编排者直接参与编辑**：外部编排模型既是审核者也是编辑者，不是纯守门人。
   对**证据明确、修法无争议**的问题（错字/标点混用、账本可查证的跨章时序矛盾、
   与冻结契约直接冲突的违例段落），直接走完整编辑闭环：
   `novel_chapter_review_issue_add` → `novel_chapter_review(mode=targeted)` →
   核对候选稿实际改动 → `novel_chapter_review_decision(approve, feedback=证据链)`，
   不必逐条请示作者；**修法涉及取舍**（剧情走向、人物命运、弧级 resolution、
   风格偏好）时不擅自决定，登记意见并给作者选项。批准 feedback 必须写清：
   目标达成证据、范围外遗留登记、命名漂移警告的核实结论
   （删除引语/复述段导致的短语频次下降是常见假阳性，≠实体漂移）。
   命名漂移警告必须人工核对后再批准或打回。

## 与创作方法论的分工

- 本 skill 是**流程参考**：什么阶段调什么工具、外部模型该做什么不该做什么。
- 创作质量判断（什么是好故事、怎么审、怎么修）用 `novel-writing` skill。
- 系统内部各阶段的创作规则（skills/novel-v2/*.yaml）由运行时注入，你通过
  craft-rule 候选演进影响它，不直接编辑。

## 快速参考：常见场景的首选工具

| 场景 | 首选工具 |
| --- | --- |
| 开新书 | novel_project_create（带 creativeBrief + reviewGate=manual 精细控制） |
| 补全书规划 | novel_bootstrap_run |
| 看项目现状 | novel_catalog_get(compact) / novel_context_get |
| 有剧情想法想交给系统完善 | novel_story_arc_orchestrate |
| 常规推进故事弧 | novel_story_arc_start → novel_story_arc_get → novel_story_arc_batch_start |
| 生成下一章 | novel_chapter_generate |
| 定稿章节转短剧剧本（H3 视频提示词） | novel_chapter_script_h3 → 产物 kind=chapter-script；方法论见 h3-prompt-writing skill |
| 从核心创意直接写短剧（无需小说项目） | 无 MCP 工具（09-17 浏览器化移除）：`POST /v2/short-script-h3` stateless 生成，产物存浏览器 IndexedDB |
| 开放创意方向要多个非默认母题候选 | 编排者自行穷举跨主引擎候选（见阶段 2.5「候选奇观发散」）→ 逐个带 avoidMotifs 调同一端点 |
| 追进度 | novel_workflow_get(workflowId) |
| 人工定稿/修订 | novel_chapter_review_decision(approve/revise/feedback) |
| 追加编辑意见 | novel_chapter_review_issue_add → novel_chapter_review(mode=targeted) |
| 沉淀经验 | novel_closed_loop_run / novel_rule_candidate_create → … → novel_rule_promote |
