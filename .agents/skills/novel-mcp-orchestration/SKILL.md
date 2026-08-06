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
  reviewer=independent|human, verdict=passed|revise|blocked, issues[], summary)`
  才会推进。auto 门禁由系统按 foundation review + score 自动判定。
- 对规划方向不满：`novel_action_execute(work.revise, workItemId, instruction)`。

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
