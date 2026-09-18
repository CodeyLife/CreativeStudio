# 外部大模型编排的小说创作 MCP 工作流

> 活动契约：2026-08-06。本文定义「外部大模型作为任务编排、审核、推进、编辑与迭代优化者」参与小说创作全流程的 MCP 工作流。代码行为以 [workflow-map.md](./workflow-map.md) 与源码为准，本文是流程与工具映射参考。
>
> 当前工具面：49（真值 `src/novel-v2/mcp/tool-metadata.ts` 的 `TOOL_COUNT`；本文与各 skill 声明的数字由 `src/novel-v2/__tests__/mcp-tool-face-single-source.test.ts` 强制对齐，改工具必须同批改这里）。

## 1. 核心设计

系统内部模型负责**产出**（规划、蓝图、正文、审核、修订），外部大模型（本机 Agent，或用户）负责**治理**：编排任务、审核产出、推进流程、下达编辑指令、驱动迭代优化。外部模型不直接改正文或绕过质量门，所有治理动作都通过 MCP 工具落库、走正式工作流与门禁。

外部编排者的五个职责，对应 MCP 工具族：

| 职责 | 含义 | 工具 |
| --- | --- | --- |
| 编排 | 规划任务链、指定创作目标与剧情方向、创建运行 | `novel_project_create`、`novel_bootstrap_run`、`novel_story_arc_start`、`novel_story_arc_orchestrate`（剧情编排）、`novel_chapter_generate`、`novel_run_create` / `novel_action_execute(work.enqueue)` |
| 审核 | 读取产出、出具独立意见、决定通过/修订/否决 | `novel_workflow_get/list`、`novel_artifact_get/list`、`novel_story_arc_review`、`novel_action_execute(review.request/review.submit)`、`novel_review_submit`、`novel_chapter_review_decision` |
| 推进 | 接受产出、重试、暂停/恢复/取消、启动下一环节 | `novel_action_execute(work.accept/retry/recover/run.pause/resume/cancel)`、`novel_chapter_review_decision(approve)`、`novel_story_arc_batch_start`、`novel_story_arc_review` |
| 编辑 | 下达编辑指令、追加审校意见、定向修订、剧情编排 | `novel_chapter_review_issue_add`、`novel_chapter_review(mode=targeted)`、`novel_chapter_review_decision(revise+feedback)`、`novel_action_execute(work.revise)`、`novel_story_arc_orchestrate` |
| 迭代优化 | 沉淀经验、提出规则候选、实验验证、晋升/回滚 | `novel_closed_loop_run`、`novel_rule_candidate_create/get`、`novel_rule_evidence_submit`、`novel_rule_foundation_evaluate`、`novel_rule_review_submit`、`novel_rule_promote`、`novel_rule_rollback` |

治理动作与系统产出解耦：外部模型给**方向与意见**（instruction / issue / outline / review verdict），系统在正式工作流内**完善与执行**（事实梳理、蓝图补全、正文修订、质量门、事实提取与 commit）。

## 2. 全流程阶段 × 工具

### 阶段 0 项目创建与宏观规划

```
novel_project_create(premise, genre, creativeBrief, reviewGate=manual|auto)
  → 自动启动 foundation 5 阶段（project-positioning → architecture / characters / worldview → plot-design）
  → 阶段审核门禁（manual：等待外部审核；auto：自动判定）
novel_catalog_get(projectId, compact)            # 确认规划状态
novel_bootstrap_run(projectId, reviewGate)        # 已存在项目补规划
novel_context_get(projectId)                      # 读取宏观规划摘要 + 叙事状态（外部编排依据）
```

外部模型在阶段间职责：
- 阅读各 foundation artifact（`novel_artifact_get`）与目录状态；
- manual 门禁下用 `novel_action_execute(review.submit, reviewer=independent|human)` 对 work item 出具审核并推进；
- 对规划方向不满时用 `novel_action_execute(work.revise, instruction)` 下达修订指令。

**manual-gate 推进协议**：manual reviewGate 下每个 foundation 阶段走「生成 → 审核 → 作者确认 → accept」：

```
1. novel_artifact_get(artifactId) 细读评估（语言契约、揭示物分层、跨产物一致性）；
2. novel_action_execute(action=plan.approve, runId, workItemId)   # 作者确认，等价 approveProjectPlanSection(actor=author)
3. novel_review_submit(reviewer=independent, verdict=passed, issues=[跨阶段缺口登记清单], summary)
4. workflow 收到信号 → recheckGate → acceptWork（passed 审核 + section approved 都就绪）→ 下游阶段自动启动
```

- approve 与 passed review **顺序不敏感**：workflow 对两个条件各有等待循环，二者都落库即自动 accept。
- 作者确认 ≠ human review：approve 只批准 section 定稿，不替代独立审核签收。
- **外部修订驱动（2026-08-06 起修复）**：
  - `review.submit(verdict=revise)` 在 manual gate 下会正确触发自动修订（workflow 的"作者确认等待"循环收到信号后重新 checkGate，未通过即 reviseWork，审核意见作为重新生成的 instruction 回流）；
  - `work.revise` / `work.start` / `work.retry` 落库后也会唤醒 workflow 重判（processWorkItem 检测到状态已变更即退出当前实例，主循环重新扫描），不再出现"外部命令改状态但 workflow 永久等待"的卡死；
  - 首选 `review.submit(verdict=revise, issues=[意见])` 驱动修订（意见自动回流）；仅当需要注入自定义指令（如"只恢复某角色定位、保留其他内容"）时才用 `work.revise(instruction)`，且等待系统进入修订循环后不要再手动 start。

### 阶段 1 故事弧规划（两种创作模式）

**模式 A：系统自规划（默认）**

```
novel_story_arc_start(projectId, authorIntent?)   # 依据宏观规划 + 已定稿状态生成下一弧
novel_story_arc_get(projectId, arcId?)            # 查看弧与章节蓝图
novel_story_arc_review(projectId, arcId, reviewPolicy=manual|auto)
novel_story_arc_decision(projectId, arcId, decision=approve|revise, feedback?)
                                                    # 人工门放行：approve=批准当前蓝图（审核未过会被正当拒绝）；
                                                    # revise=作者修订指令入门→定向修订→重审→再入门
novel_story_arc_batch_start(projectId, arcId)     # 当前弧推进下一批章节
```

**模式 B：外部编排（新增，`novel_story_arc_orchestrate`）**

```
novel_story_arc_orchestrate(projectId, plotOutline, reviewPolicy, authorIntent?)
  plotOutline = {
    objective（必填）, title?, entryState?, centralConflict?,
    development[]?, resolution?, exitState?,
    threadResponsibilities[]?, expectedChapterCount?, phases[]?,
    chapterHints[]?, plotNotes?   # 自由剧情编排说明
  }
  authorIntent? = 作者整体意图说明（并入规划上下文，权威低于已定稿事实）
```

外部大模型（或用户）提供**剧情编排**（本弧讲什么、核心冲突、发展阶梯、终点、责任线、逐章提示），系统负责**完善**：把编排对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、连续性约束与章节蓝图，再走正式弧审核 → 修订闭环。编排是设计意图基线，权威低于已定稿事实与作者边界；编排与事实冲突时以事实为准，编排未覆盖的部分由规划器按正式契约生成。外部编排会作为 section 注入规划/审核/修订 prompt，并写入蓝图 artifact 的 provenance。

### 阶段 2 正文生成与审核闭环

```
novel_chapter_generate(projectId, documentId?, instruction?)   # 生成 + 正式闭环
  review（structure / character / prose 三审）→ targeted revision
  → manuscriptApproval → extractFacts → approveFacts → commit → enrichCharacters
novel_workflow_get(workflowId)                    # 轮询进度
novel_workflow_list(projectId, workflowType)      # 历史
novel_chapter_review_decision(workflowId, artifactId, decision=approve|revise|reject|abandon, feedback?, revisionBase?)
```

外部模型在正文环节的编辑职责：
- 阅读候选稿与三份审核（`novel_workflow_get` + `novel_artifact_get`）；
- `novel_chapter_review_issue_add(projectId, documentId, severity, title, evidenceQuote, revisionRanges)` 追加作者意见 → `novel_chapter_review(mode=targeted, targetIssueIds)` 走正式定向修订；
- `novel_chapter_review_decision(revise, feedback, revisionBase)` 带指令继续修订；
- 已定稿章节重审：`novel_chapter_review(projectId, documentId)`（full 模式）；
- 短剧剧本派生：`novel_chapter_script_h3(projectId, documentId, instruction?)` 为已定稿章节生成 MiniMax H3 Ref2VA 提示词（见阶段 2.5）。
- 创意短剧脚本：**不走 MCP 工具**——2026-09-17 起独立短剧改浏览器本地存储，仅剩单个 stateless 端点 `POST /v2/short-script-h3`（生成不落库，产物由前端存 IndexedDB；见阶段 2.5 与 workflow-map §8.2 的 09-17 更正条目）。外部编排者需要产出短剧脚本时调该端点，不要调用 `novel_short_script_h3*`（该组工具已随浏览器化移除）。

### 阶段 2.5 短剧剧本提示词（章节派生与核心创意两条路径）

```
novel_chapter_script_h3(projectId, documentId, instruction?)   # 定稿正文 → Ref2VA 分镜提示词
# 核心创意 → 短剧脚本：2026-09-17 浏览器化后只经 REST，不在 MCP 工具面内
#   POST /v2/short-script-h3   body: { idea, instruction?, durationMode?(fixed|auto), targetDurationSeconds?, projectId?, materialRefs?, avoidMotifs? }
#     单个 stateless 端点：生成即返回，不落库、不复读 DB 幂等（`generateShortScriptH3` deps 收窄为 model/skillProvider）。
#     projectId 缺省=独立短剧（不依赖任何小说项目）；durationMode=auto 不限时长；
#     返回含 creativeStrategy 主引擎承诺（awe 震撼 / humor 搞笑 / conflict 剧情，三选一）。
#     产物与历史由前端存 IndexedDB（src/lib/shortDramaStore.ts，按 localKey 去重），无服务端读回端点。
#   跨引擎候选发散（原 brainstorm 工具）当前无实现面：反同质由前端把近期核心创意作为
#     avoidMotifs 数组随请求直传；需要多样候选时给多个 idea 各调一次该端点。
novel_artifact_list(projectId, kind="chapter-script")           # 历史章节剧本产物
novel_artifact_list(projectId, kind="short-script")             # 仅迁移前历史产物（09-17 起新产物只进浏览器 IndexedDB，服务端不再登记）
novel_artifact_get(artifactId)                                  # 完整章节剧本
```

对已 commit 的 final 章节，外部编排者可调用该工具产出短剧剧本提示词：按场景节拍拆分为多个 10-15 秒片段，每片段一条自包含的 MiniMax H3 全参考模式（Ref2VA）六段提示词（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），片段内可含多镜头；顶层 characters 提供外观基线，各片段 subjectDefinitions 复用同一外形描述，对白保留中文原文。生成时系统自动注入 workspace 运行时 skill `h3-video-prompt@1.9.1(chapter.script)` 指引（影视镜头语言六要素 + 片段时间预算分配契约——分配优先（拆段前按节拍口播量/镜头动作量定段时长）+ 节拍层/镜头层/语音层口播守恒（按句自检：一句台词约 2-4 秒）+ 节奏范式 + 高光时刻范式 + 剧集剧作层契约 + 描述体量契约——detailed_description 每片段约 350-500 英文词或等体量中文、六要素写全、宁详勿简；冲击场面细节契约——宏大场景写规模参照、战斗写物理反馈；片段时长分布契约——宏大/战斗片段取上沿 12-15s；schema 描述下限同步抬升，方法论沉淀于 `.agents/skills/short-drama-writing/`，输出语法规范见 h3-prompt-writing）；返回携带 `cinematicHints`（切点时序观察与语音口播预算观察——台词口播估算超出段时长即提示，提示级）；同一定稿内容幂等复用既有产物（键含 定稿哈希+共享定义哈希+契约版本），改稿或契约升级后重新生成。该产物是正文的只读派生（kind=chapter-script），不改正文、不进质量门；编排者可直接把各片段 promptText 送入 H3 视频生成。改编方法论详见 `.agents/skills/short-drama-writing/`。

也可脱离章节与小说项目，直接用 `novel_short_script_h3` 从一个核心创意生成短剧脚本（如抖音短视频）：`idea` 须写清谁、何处、什么（人物冲突或场景奇观均可，≥10 字符——类型由创意意图忠实性契约判定：剧情型走冲突导向剧作模式，展示型走视觉展示模式），时长两档可选：`durationMode` 缺省 `fixed` 时按 `targetDurationSeconds`（10-180s，默认 30s，超界收敛到边界；各片段 10-15s）固定目标时长，`durationMode="auto"` 时不限时长——总时长与片段数由模型依据核心创意自行编排（节拍覆盖完整优先于时长配额，只受段数硬顶 36 与单段 10-15s 约束；产物 `targetDurationSeconds` 回填实际总时长，payload `durationMode=auto`），`projectId` 可选（契约 v2 起完全独立：缺省为独立短剧，不依赖任何小说项目；填写时产物关联该作品作衍生短剧，填错仍报 404；v3 起叠加描述体量契约，v4 起片段时长上限 15s、描述语言放开中文并叠加冲击场面细节契约，v5 起片段时长按信息密度分布——宏大/战斗片段取上沿 12-15s，v6 起区间收紧 10-15s 并叠加创意意图忠实性契约——展示型创意禁止自行注入追击/战斗等对抗事件，v7 起叠加震撼强度契约，v8/v9 起叠加画面设计层契约及其细化，v10 起叠加吸引力设计契约——顶层 `creativeStrategy` schema 必填（主引擎 hookType=awe/humor/conflict 三选一 + 一处预期→反转 subversion + 唯一记忆镜头 signatureMoment），生成时自动注入近期已产出短剧核心创意作跨作品反同质回避清单，缺失/非法只进 cinematicHints 不阻断，旧产物指纹失效）。fixed 模式片段数下限按时长推导（全部按最长单段 15s 承载仍需的段数），总时长须落在目标 ±10s 容差内（`SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS`，吸收模型近似分配）；auto 模式无目标时长，总时长窗口观察跳过。生成走 `short.script` 执行点的 `h3-video-prompt@1.9.1` 指引（与 chapter.script 共享导演层、剧作层、片段时间预算分配契约、描述体量契约、冲击场面细节契约、时长分布契约与反原型支点（v1.9.0 泛化为「视觉/空间载体」五族：巨构/天体/巨形生灵/自然现象/空间法则），另含创意模式专属指引：节拍为设计而非穷举、末段切在钩子/记忆镜头上、吸引力设计契约与喜剧机制契约（错位三型/一本正经/setup→payoff/包袱落镜头/音画错位）——剧作层冲突导向规则（开场即冲突等）仅对主引擎 conflict 生效，humor 引擎靠错位不靠威胁、禁注入对抗事件）。产物落独立表 `short_scripts`（迁移 050，`project_id` 可空；artifacts 中 kind=short-script 历史行保留审计），payload 记录 idea、instruction 来源与顶层 `creativeStrategy`（record/MCP 返回与 REST 详情回显）；幂等键绑定作用域（projectId 缺省为 `independent` 占位）+idea+instruction+时长模式槽位（fixed=目标时长数值 / auto=`auto` 占位，两种模式产物互不复用）+契约版本，同一作用域同一创意输入复用既有产物；REST 对应项目无关端点 `GET/POST /v2/short-script-h3`、`GET /v2/short-script-h3/:scriptId`、`GET /v2/short-script-h3/list?projectId=`（可选按作品过滤），项目级旧端点 `/v2/projects/:id/short-script-h3` 保留兼容（改读新表并校验项目归属）；Web 前端在左侧主导航「剧本创作」独立板块（路由 `/script-studio`，与小说创作平级）提供创意短剧创作与历史回看入口，顶部「关联作品」选择器可选——未选即独立模式（章节派生入口在章节工作台弹窗）。

作者可经前端（或 `GET/PUT /v2/projects/:id/script-h3/subject-preset`）预设**项目级共享 subject_definitions**（`<Subject N>` 行格式）：生成时片段直接复用共享主体（不重写），片段内只写新增主体（编号从共享最大编号 +1 续接），无新增时片段省略 subject_definitions 区块；共享库以独立块随产物导出供 H3 前置拼接。该预设管理不经 MCP（前端/REST 专属），但编排触发的生成会读取同一份项目级预设；修改预设后需对章节点重新生成。

### 2.6 短剧脚本外部产出（外部 MCP 接手内容创作）

短剧脚本是定稿正文的**只读派生产物**（`kind=chapter-script`），**不进正文质量门**，因此外部编排者可在不违反「治理与产出解耦」原则的前提下**接手内容产出**——系统仍掌握组装、结构观察、契约版本与持久化，外部 MCP 负责实际创作。这构成与系统内部生成的**双轨模式**：

| 工具 | 角色 | 产出方 |
| --- | --- | --- |
| `novel_chapter_script_h3` | 定稿章节 → 短剧剧本 | 系统内部模型 |
| `novel_chapter_script_h3_submit` | 提交外部产出的模型形态 JSON 落库 | **外部 MCP** |
| `novel_skill_get(executionPoint)` | 读取运行时 Skill 指引文本（如 `short.script` 的 h3-video-prompt 方法论） | 系统解析、外部消费 |

创意短剧（核心创意 → 脚本）一轨自 2026-09-17 起不在 MCP 工具面内：`novel_short_script_h3` 与它的 submit 双轨随"独立短剧改浏览器本地存储"移除，服务端不再登记外部提交，外部产出方直接消费 `short.script` 指引自行组装提示词（或走 stateless REST，见阶段 2.5）。上表的章节派生双轨不受影响。

外部 MCP 接手短剧产出的标准流程：

1. `novel_skill_get(executionPoint="short.script")` 读取已解析的 h3-video-prompt 方法论（`skillText` 注入外部模型 prompt），并借 `availableSkills[].executionPoints` 发现合法执行点；
2. 外部模型按方法论，依据定稿章节正文（或核心创意）、时长模式（`durationMode`；fixed 配合 `targetDurationSeconds`，auto 不限时长自行编排）等参数自行产出**模型形态剧本 JSON**（契约 v10 起建议携带顶层 `creativeStrategy`——`hookType`(awe/humor/conflict)+`subversion`+`signatureMoment`，与 system 内部生成的吸引力设计契约同形态；缺失合法只影响回显、非法进 hints 不阻断，且计入 ext 内容指纹）：`creativeStrategy?` / `plotBeats` / `characters` / 每段六段字段 `subjectDefinitions`·`summary`·`retentionAnalysis`·`detailedDescription`·`overallSoundscape`·`nonDiegeticMusic`；
3. `novel_chapter_script_h3_submit(projectId, documentId, payload)` 提交章节派生产物，系统复用 `normalizeChapterScriptOutput` 做**零阻断组装**（`promptText`、结构提示、契约版本）并落库；`origin` 标记为 `external-*`，指纹前缀 `ext:` 与系统内部输入指纹区分，同内容幂等复用。创意短剧侧无对应 submit 工具（见上）。

边界：外部 MCP 产出的是脚本提示词（H3 Ref2VA 六段），**不是小说正文**；章节派生门禁与内部一致（章节须为定稿，否则 `ChapterScriptSourceError(409)`）。该能力仅放开「短剧派生产物」的产出权，正文/蓝图等仍受「外部模型直接改正文、直接改 blueprint 无对应工具」约束。

### 阶段 3 事实梳理与记忆

```
novel_context_get(projectId, sections?)                    # 叙事状态账本 / 章节记忆 / 开放线索 / 伏笔 / 承诺
novel_catalog_get(projectId, documentStatus=["final"])      # 定稿清单
```

外部模型在编排剧情、下达编辑指令前，先用 `novel_context_get` 做事实梳理（开放线索、角色状态、未解事项），避免编排与已定稿事实冲突。

### 阶段 4 学习闭环与经验沉淀

```
novel_closed_loop_run(projectId, documentId)      # snapshot → experiment → skill-iteration → candidate → promote
novel_rule_candidate_create(targetKind, targetId, afterText, rationale, scope)
novel_rule_evidence_submit(baselineWorkItemId, candidateWorkItemId, scenarioRole)
novel_rule_foundation_evaluate(candidateId, taskKey, scenarioClass, scenarioRole)
novel_rule_review_submit(candidateId, role, reviewerId, reviewRunId, model, verdict, summary, concerns)
novel_rule_promote(candidateId) / novel_rule_rollback(candidateId)
novel_receipt_get(receiptId)
```

## 3. 质量门与决策规则（外部审核者必须遵守）

1. **不绕过门禁**：所有修改必须经过正式工作流（chapter generate/review、story arc planning/review、rule promote）；外部模型直接改正文、直接改 blueprint 都无对应工具。
2. **审核要指向证据**：issue 必须带 evidence / excerpt / revisionRanges（1-based 段落号），同机制多处用 revisionRanges 一次覆盖，避免只修首段。
3. **approve 覆盖严重问题必须给 feedback**：`novel_chapter_review_decision` 在 approve 且审核存在 blocker/major 时需要作者理由。
4. **修订是定向的**：`work.revise` / targeted 审校只修问题机制相关范围；`unresolvedAtClose` 是冻结未解边界，局部修订不得回答或删除。
5. **规划级审核是文本意见契约**：Foundation 与 Story Arc 的模型审核只返回单行 `PASSED`（通过）或可执行审核意见（不通过，verdict=revise），verdict 只保留 passed/revise 二值；意见会作为重新生成的 instruction 回流。外部模型作为审核者提交意见时同样遵守该契约。
6. **学习候选要完整 scope**：`observedSymptom / failingLayer / underlyingMechanism / affectedInputClass` 必填，`boundaries / regressionRisks` 建议填写；promote 前必须有原失败场景 + 异构场景回归证据。
7. **串行约束**：同项目章节审校互斥（`projectActiveReviewWorkflowId`），外部模型必须等当前审校完成后启动下一个。
8. **编排权威顺序**：已定稿事实 / 叙事状态账本 / 作者边界 > 外部剧情编排 > 模型自行发挥；编排只给方向，不给假事实。
9. **外部编排模型直接参与编辑**：外部编排模型既是审核者也是编辑者，不是纯守门人。对**证据明确、修法无争议**的问题（错字/标点混用、账本可查证的跨章时序矛盾、与冻结契约直接冲突的违例段落），直接走完整编辑闭环：`novel_chapter_review_issue_add` → `novel_chapter_review(mode=targeted)` → 核对候选稿实际改动 → `novel_chapter_review_decision(approve, feedback=证据链)`，不必逐条请示作者；**修法涉及取舍**（剧情走向、人物命运、弧级 resolution、风格偏好）时不擅自决定，登记意见并给作者选项。批准 feedback 必须写清目标达成证据、范围外遗留登记与命名漂移警告的核实结论（删除引语/复述段导致的短语频次下降是常见假阳性，≠实体漂移）；命名漂移警告必须人工核对后再批准或打回。

## 4. 工具清单（当前工具面：49 个）

| 组 | 工具 |
| --- | --- |
| Run / Action（7） | novel_run_create、novel_run_get、novel_action_list、novel_action_execute、novel_artifact_get、novel_review_submit、novel_run_complete |
| Catalog / Receipt（3） | novel_catalog_get、novel_receipt_get、novel_rule_target_get |
| Craft Rule 演进（7） | novel_rule_candidate_create、novel_rule_candidate_get、novel_rule_evidence_submit、novel_rule_foundation_evaluate、novel_rule_review_submit、novel_rule_promote、novel_rule_rollback |
| 项目生命周期（3） | novel_project_create、novel_project_list、novel_project_delete |
| 规划与创作（15） | novel_bootstrap_run、novel_story_arc_start、novel_story_arc_get、novel_story_arc_review、novel_story_arc_decision、novel_story_arc_batch_start、novel_story_arc_orchestrate、novel_foreshadowing_list、novel_foreshadowing_triage、novel_chapter_review、novel_chapter_review_issue_add、novel_chapter_generate、novel_chapter_script_h3、novel_skill_get、novel_chapter_script_h3_submit |
| 评估闭环（1） | novel_closed_loop_run |
| Workflow 查询（2） | novel_workflow_get、novel_workflow_list |
| Workflow 决策（1） | novel_chapter_review_decision |
| 上下文与产物查询（2） | novel_context_get、novel_artifact_list |
| 外部 LLM 深度参与（8，2026-09-08；梳理报告 2026-09-09；候选队列 2026-09-10） | novel_memory_query、novel_memory_grooming_report、novel_fact_candidate_queue、novel_fact_candidate_decide、novel_skill_query、novel_prompt_inspect、novel_invocation_list、novel_model_dispatch |

## 4.1 外部 LLM 深度参与策略

2026-09-08 新增 5 个工具，让外部编排 LLM 从"黑盒指挥官"升级为"可透视、可调度的参与者"：

### 主动查询（先看懂再动手）
1. **novel_memory_query(projectId, documentId?, narrativeCutoff?, compact?)**：查询指定章节/purpose 的 MemoryBundle（冻结事实 claims、跨章序列证据 openPromises/assetSpans/characterSpans/subjectSpans、叙事节奏摘要 narrativeRhythm）。在故事弧规划、章节蓝图或正文创作**前**调用，精确了解模型将收到哪些记忆注入。compact=true 时只返回摘要。
2. **novel_skill_query(projectId, executionPoint, role?)**：查询指定 execution point 的 SkillBundle（哪些 skill 加载了、promptSections 完整文本）。用于判断"这段指引是否覆盖了我要检查的方面"。
3. **novel_prompt_inspect(workflowId, taskId)**：审计指定模型调用的完整 prompt（system+instruction+manifest）和模型响应。用于质量诊断和 prompt 优化。
4. **novel_invocation_list(projectId, workflowId?)**：列出项目或工作流最近的模型调用审计记录。

### 子 agent 调度
5. **novel_model_dispatch(purpose, prompt, system?, maxTokens?)**：主动调度一个 API 模型执行子任务（purpose 白名单限定为 writing.draft / writing.revision）。不进工作流、不落 artifact、不触发审核——外部 LLM 拿到结果后自行决定是否启动正式工作流。用途：前置草稿预生成、段落改写实验、审核意见预分析。

### 观测与恢复事件契约（2026-09-10 审计整改 Batch 3/4，无新增工具）

编排者消费面出现以下新事件/字段，均经 outbox 与既有查询工具暴露，工具总数保持 49：

- **`workflow.progress.<stage>`**：任何带 `payload.stage` 的状态写入都追加 outbox 事件——轮询 run 时守卫历史可逐条回放（run payload 的 stage 仅是后写覆盖的展示位）。
- **`payload.terminalOutcome`**：completed/failed/cancelled 终态必带固定键（`succeeded` / `business-revision-exhausted` / `external-wait-timed-out` / `abandoned-stale-run` / `infrastructure-failed` / `cancelled` 等）；业务性失败与基础设施失败自此可分流，重试策略不应再看 status 单字段。
- **`model-task.expired`**：外部任务 15 分钟等待超时（无人认领）发事件；同 run 累计超时超过 `MAX_EXTERNAL_FALLBACK_ADVANCES`（=6）后 run 转 `manual-review-required`（reason `external-fallback-budget-exhausted`）——此时应调度执行者认领或改路由，而非等待自愈。外部租约现走显式 `task_attempts.model_task_id` 关联（claim/heartbeat/submit 全链路）。
- **`workflow.reconciled-abandoned`**：`POST /v2/maintenance/reconcile-runs` 周期对账收编僵尸 run（running 超 6h / waiting-external 超 24h Temporal retention 窗；`manual-review-required`/`paused` 等人态不收编）。
- **`craft-rule.candidate-aggregated` / `craft-rule.candidate-stale`**：候选聚合（同机制学习并入既有候选）与 30 天零证据停滞提醒；候选队列经 novel_rule_candidate 工具组演进，`aggregateToCandidateId` 为学习评估 candidate 的可选聚合引用。
- **`novel_model_dispatch` / REST `/v2/routing/candidate-health`**：路由候选健康度聚合（窗口内样本≥5 且零成功 = `neverSucceeded`），用于"摘除或降权死路由"决策；配置界面已展示同口径告警。

### 事实梳理审核（记忆治理，2026-09-09）
6. **novel_memory_grooming_report(projectId)**：只读诊断投影——把 active 事实账本按（规范化主体 × 规范谓词）身份槽位分组，组内给出近重复候选对（字符二元组 Dice 相似度排序）。外部编排 LLM 作为**事实梳理审核者**消费：机械层只做候选排序，语义等价判定交给你。建议挂在弧批次边界（弧 approve 后对本弧涉及主体跑一次），输出遵循文本意见契约：
   - 通过时只输出单行 `PASSED`；
   - 不通过时输出可执行梳理意见，逐条注明：哪对是**语义重复**（建议新 claim supersedes 旧 claim）、哪对是**状态演化**（保留为 update，不是重复）、哪对是**误提取**（建议 rejected）、哪条主体键是历史别名（建议归一）。
   - 意见经**作者确认**后由作者在既有 claim 生命周期（事实审批/知识工作台）执行；本工具不提供任何改库能力，外部模型不得要求绕过作者确认直接修改账本。

### 事实候选队列裁决（FM-2，2026-09-10）
7. **novel_fact_candidate_queue(projectId)**：只读积压面板——按叙事位置分组返回 pending candidate 数、最老账龄、占可见事实比例、每组样例行与 staged 残骸计数。候选不再"只进不出"：积压比例或账龄异常会进入 blueprint 的 `memoryGate.candidateBacklog` facet 供下游感知。
8. **novel_fact_candidate_decide(projectId, claimIds(≤50), decision=approve|reject, reason, actorId?)**：批量裁决通道。逐条结果 `decided / skipped（已处理，整批可安全重放）/ failed`；approve 派生 approved、reject 派生 rejected，并 best-effort 同步 Qdrant（approve upsert / reject 删除；向量失败只报告 `vectorSyncError`，PostgreSQL 决定保持权威）。语义等价裁决前先跑 novel_memory_grooming_report 排查重复；裁决依据须来自正文证据或作者意图，reason 必填留痕。外部模型可代作者执行**证据明确**的裁决（重复提取、与冻结事实同义的派生行）；涉及事实取舍（多版本冲突、是否承认新状态）时先给作者选项清单。

### 使用策略
- 弧规划前：novel_memory_query → 了解冻结事实与开放伏笔/承诺 → novel_story_arc_orchestrate
- 章节蓝图前：novel_skill_query(chapter.blueprint) → 了解创作指引 → novel_memory_query → 了解前章事实 → novel_story_arc_orchestrate
- 正文创作前：novel_memory_query(chapter.drafting) → novel_skill_query(chapter.drafting) → novel_model_dispatch(writing.draft, 自组装 prompt) → 预生成草稿 → novel_chapter_generate 启动正式工作流
- 审核后：novel_invocation_list → 诊断模型调用情况 → novel_prompt_inspect → 审计 prompt 质量
- 弧批次边界（记忆治理）：novel_memory_grooming_report → 输出梳理意见 → 作者确认后走 claim 生命周期
- 弧批次边界（候选清账）：novel_fact_candidate_queue → 证据明确的批量 novel_fact_candidate_decide → 存疑条目回报作者

## 5. 与 skill 的关系

- `.agents/skills/novel-mcp-orchestration/SKILL.md`：外部编排者的流程参考（本流程的 skill 化表达），回答「什么阶段该调哪个工具、外部模型应该做什么、不该做什么」。
- `.agents/skills/novel-writing/SKILL.md`：创作方法论（工程化 × 文学质量），回答「什么算好故事、怎么审、怎么修」。
- `skills/novel-v2/*.yaml`：运行时注入的 execution-point skill，是系统内部各阶段的创作规则，外部模型不直接编辑（通过 craft-rule 候选演进）。
