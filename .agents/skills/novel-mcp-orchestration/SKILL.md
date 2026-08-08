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
- `novel_story_arc_batch_start(projectId, arcId, retryFailed?)` 推进下一批章节

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
1. 读候选稿与三份审核：`novel_workflow_get(workflowId)` 拿 artifactId →
   `novel_artifact_get(artifactId)` 读正文与审校 issue。
2. 追加你的意见：`novel_chapter_review_issue_add(projectId, documentId,
   severity, title, evidenceQuote, paragraph|revisionRanges, suggestion?)`
   —— 只写 pending issue，不改正文；同机制多处必须用 revisionRanges 一次覆盖。
3. 定向修订：`novel_chapter_review(projectId, documentId, mode=targeted,
   targetIssueIds=[...])` 走正式修订闭环（仍是完整审核 → 事实提取 → commit）。
4. 或者在工作流等待处 `novel_chapter_review_decision(revise, feedback, revisionBase=current|previous)`。
5. approve 前检查：有 blocker/major 而你要 approve，必须给 feedback 理由。

### 阶段 3 事实梳理与记忆（编排/编辑前必做）

```
novel_context_get(projectId, sections?)
  sections: foundation / recent-chapters / narrative-state / open-elements / planning-feedback
novel_catalog_get(projectId, documentStatus=["final"])
novel_artifact_list(projectId, kind?, workflowId?, limit?)
```

- 编排剧情前读 narrative-state + open-elements（开放线索/伏笔/承诺）+ recent-chapters。
- 定位审校对象时用 novel_artifact_list 拿 artifactId。

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
| 追进度 | novel_workflow_get(workflowId) |
| 人工定稿/修订 | novel_chapter_review_decision(approve/revise/feedback) |
| 追加编辑意见 | novel_chapter_review_issue_add → novel_chapter_review(mode=targeted) |
| 沉淀经验 | novel_closed_loop_run / novel_rule_candidate_create → … → novel_rule_promote |
