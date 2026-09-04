# 外部大模型编排的小说创作 MCP 工作流

> 活动契约：2026-08-06。本文定义「外部大模型作为任务编排、审核、推进、编辑与迭代优化者」参与小说创作全流程的 MCP 工作流。代码行为以 [workflow-map.md](./workflow-map.md) 与源码为准，本文是流程与工具映射参考。

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
- 创意短剧脚本：`novel_short_script_h3(idea, instruction?, targetDurationSeconds?, projectId?)` 从一个核心创意生成短剧脚本提示词，`projectId` 可选（缺省为独立短剧，填则关联该作品作衍生短剧；见阶段 2.5）。

### 阶段 2.5 短剧剧本提示词（章节派生与核心创意两条路径）

```
novel_chapter_script_h3(projectId, documentId, instruction?)   # 定稿正文 → Ref2VA 分镜提示词
novel_short_script_h3(idea, instruction?, targetDurationSeconds?, projectId?)   # 核心创意 → 短剧脚本提示词（projectId 缺省=独立短剧，不依赖任何小说项目）
novel_artifact_list(projectId, kind="chapter-script")           # 历史章节剧本产物
novel_artifact_list(projectId, kind="short-script")             # 仅迁移前历史产物（v2 起新产物落 short_scripts 表，经 REST /v2/short-script-h3 读取）
novel_artifact_get(artifactId)                                  # 完整章节剧本
```

对已 commit 的 final 章节，外部编排者可调用该工具产出短剧剧本提示词：按场景节拍拆分为多个 10-15 秒片段，每片段一条自包含的 MiniMax H3 全参考模式（Ref2VA）六段提示词（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music），片段内可含多镜头；顶层 characters 提供外观基线，各片段 subjectDefinitions 复用同一外形描述，对白保留中文原文。生成时系统自动注入 workspace 运行时 skill `h3-video-prompt@1.4.4(chapter.script)` 指引（影视镜头语言四要素 + 节奏范式 + signature shot 范式 + 剧集剧作层契约 + 描述体量契约——detailed_description 每片段约 350-500 英文词或等体量中文、四要素写全、宁详勿简；冲击场面细节契约——宏大场景写规模参照、战斗写物理反馈；片段时长分布契约——宏大/战斗片段取上沿 12-15s；schema 描述下限同步抬升，方法论沉淀于 `.agents/skills/short-drama-writing/`，输出语法规范见 h3-prompt-writing）；返回携带 `cinematicHints`（缺少运镜/景别描述的镜头清单与风格类时序观察，提示级）；同一定稿内容幂等复用既有产物（键含 定稿哈希+共享定义哈希+契约版本），改稿或契约升级后重新生成。该产物是正文的只读派生（kind=chapter-script），不改正文、不进质量门；编排者可直接把各片段 promptText 送入 H3 视频生成。改编方法论详见 `.agents/skills/short-drama-writing/`。

也可脱离章节与小说项目，直接用 `novel_short_script_h3` 从一个核心创意生成短剧脚本（如抖音短视频）：`idea` 须写清谁、何处、什么（人物冲突或场景奇观均可，≥10 字符——类型由创意意图忠实性契约判定：剧情型走冲突导向剧作模式，展示型走视觉展示模式），`targetDurationSeconds` 可选（10-180s，默认 30s，超界收敛到边界；各片段 10-15s），`projectId` 可选（契约 v2 起完全独立：缺省为独立短剧，不依赖任何小说项目；填写时产物关联该作品作衍生短剧，填错仍报 404；v3 起叠加描述体量契约，v4 起片段时长上限 15s、描述语言放开中文并叠加冲击场面细节契约，v5 起片段时长按信息密度分布——宏大/战斗片段取上沿 12-15s，v6 起区间收紧 10-15s 并叠加创意意图忠实性契约——展示型创意禁止自行注入追击/战斗等对抗事件，旧产物指纹失效）。片段数下限按时长推导（全部按最长单段 15s 承载仍需的段数），总时长须落在目标 ±10s 容差内（`SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS`，吸收模型近似分配）。生成走 `short.script` 执行点的 `h3-video-prompt@1.4.4` 指引（与 chapter.script 共享导演层、剧作层、描述体量契约、冲击场面细节契约与时长分布契约，另含创意模式专属指引：节拍为设计而非穷举、开场即冲突、末段切在钩子上——冲突导向规则仅对剧情型创意生效，展示型按空间巡游/规模递进组织）。产物落独立表 `short_scripts`（迁移 050，`project_id` 可空；artifacts 中 kind=short-script 历史行保留审计），payload 记录 idea 与 instruction 来源；幂等键绑定作用域（projectId 缺省为 `independent` 占位）+idea+instruction+目标时长+契约版本，同一作用域同一创意输入复用既有产物；REST 对应项目无关端点 `GET/POST /v2/short-script-h3`、`GET /v2/short-script-h3/:scriptId`、`GET /v2/short-script-h3/list?projectId=`（可选按作品过滤），项目级旧端点 `/v2/projects/:id/short-script-h3` 保留兼容（改读新表并校验项目归属）；Web 前端在左侧主导航「剧本创作」独立板块（路由 `/script-studio`，与小说创作平级）提供创意短剧创作与历史回看入口，顶部「关联作品」选择器可选——未选即独立模式（章节派生入口在章节工作台弹窗）。

作者可经前端（或 `GET/PUT /v2/projects/:id/script-h3/subject-preset`）预设**项目级共享 subject_definitions**（`<Subject N>` 行格式）：生成时片段直接复用共享主体（不重写），片段内只写新增主体（编号从共享最大编号 +1 续接），无新增时片段省略 subject_definitions 区块；共享库以独立块随产物导出供 H3 前置拼接。该预设管理不经 MCP（前端/REST 专属），但编排触发的生成会读取同一份项目级预设；修改预设后需对章节点重新生成。

### 2.6 短剧脚本外部产出（外部 MCP 接手内容创作）

短剧脚本是正文/创意的**只读派生产物**（`kind=chapter-script` / 独立表 `short_scripts`），**不进正文质量门**，因此外部编排者可在不违反「治理与产出解耦」原则的前提下**接手内容产出**——系统仍掌握组装、结构观察、契约版本与持久化，外部 MCP 负责实际创作。这构成与系统内部生成的**双轨模式**：

| 工具 | 角色 | 产出方 |
| --- | --- | --- |
| `novel_short_script_h3` | 核心创意 → 短剧脚本 | 系统内部模型（`ToolContext.model`） |
| `novel_short_script_h3_submit` | 提交外部产出的模型形态 JSON 落库 | **外部 MCP** |
| `novel_chapter_script_h3` | 定稿章节 → 短剧剧本 | 系统内部模型 |
| `novel_chapter_script_h3_submit` | 提交外部产出的模型形态 JSON 落库 | **外部 MCP** |
| `novel_skill_get(executionPoint)` | 读取运行时 Skill 指引文本（如 `short.script` 的 h3-video-prompt 方法论） | 系统解析、外部消费 |

外部 MCP 接手短剧产出的标准流程：

1. `novel_skill_get(executionPoint="short.script")` 读取已解析的 h3-video-prompt 方法论（`skillText` 注入外部模型 prompt），并借 `availableSkills[].executionPoints` 发现合法执行点；
2. 外部模型按方法论，依据核心创意（`idea`）、目标时长（`targetDurationSeconds`）等参数自行产出**模型形态剧本 JSON**（`plotBeats` / `characters` / 每段六段字段 `subjectDefinitions`·`summary`·`retentionAnalysis`·`detailedDescription`·`overallSoundscape`·`nonDiegeticMusic`）；
3. `novel_short_script_h3_submit(idea, payload, …)` 或 `novel_chapter_script_h3_submit(projectId, documentId, payload)` 提交，系统复用 `normalizeChapterScriptOutput` 做**零阻断组装**（`promptText`、结构提示、契约版本）并落库；`origin` 标记为 `external-*`，指纹前缀 `ext:` 与系统内部输入指纹区分，同内容幂等复用。

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

## 4. 工具清单（40 个）

| 组 | 工具 |
| --- | --- |
| Run / Action（7） | novel_run_create、novel_run_get、novel_action_list、novel_action_execute、novel_artifact_get、novel_review_submit、novel_run_complete |
| Catalog / Receipt（3） | novel_catalog_get、novel_receipt_get、novel_rule_target_get |
| Craft Rule 演进（7） | novel_rule_candidate_create、novel_rule_candidate_get、novel_rule_evidence_submit、novel_rule_foundation_evaluate、novel_rule_review_submit、novel_rule_promote、novel_rule_rollback |
| 项目生命周期（3） | novel_project_create、novel_project_list、novel_project_delete |
| 规划与创作（14） | novel_bootstrap_run、novel_story_arc_start、novel_story_arc_get、novel_story_arc_review、novel_story_arc_batch_start、novel_story_arc_orchestrate、novel_chapter_review、novel_chapter_review_issue_add、novel_chapter_generate、novel_chapter_script_h3、novel_short_script_h3、novel_skill_get、novel_short_script_h3_submit、novel_chapter_script_h3_submit |
| 评估闭环（1） | novel_closed_loop_run |
| Workflow 查询（2） | novel_workflow_get、novel_workflow_list |
| Workflow 决策（1） | novel_chapter_review_decision |
| 上下文与产物查询（2，新增） | novel_context_get、novel_artifact_list |

## 5. 与 skill 的关系

- `.agents/skills/novel-mcp-orchestration/SKILL.md`：外部编排者的流程参考（本流程的 skill 化表达），回答「什么阶段该调哪个工具、外部模型应该做什么、不该做什么」。
- `.agents/skills/novel-writing/SKILL.md`：创作方法论（工程化 × 文学质量），回答「什么算好故事、怎么审、怎么修」。
- `skills/novel-v2/*.yaml`：运行时注入的 execution-point skill，是系统内部各阶段的创作规则，外部模型不直接编辑（通过 craft-rule 候选演进）。
