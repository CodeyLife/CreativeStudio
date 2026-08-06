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
- 已定稿章节重审：`novel_chapter_review(projectId, documentId)`（full 模式）。

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
5. **学习候选要完整 scope**：`observedSymptom / failingLayer / underlyingMechanism / affectedInputClass` 必填，`boundaries / regressionRisks` 建议填写；promote 前必须有原失败场景 + 异构场景回归证据。
6. **串行约束**：同项目章节审校互斥（`projectActiveReviewWorkflowId`），外部模型必须等当前审校完成后启动下一个。
7. **编排权威顺序**：已定稿事实 / 叙事状态账本 / 作者边界 > 外部剧情编排 > 模型自行发挥；编排只给方向，不给假事实。

## 4. 工具清单（35 个）

| 组 | 工具 |
| --- | --- |
| Run / Action（7） | novel_run_create、novel_run_get、novel_action_list、novel_action_execute、novel_artifact_get、novel_review_submit、novel_run_complete |
| Catalog / Receipt（3） | novel_catalog_get、novel_receipt_get、novel_rule_target_get |
| Craft Rule 演进（7） | novel_rule_candidate_create、novel_rule_candidate_get、novel_rule_evidence_submit、novel_rule_foundation_evaluate、novel_rule_review_submit、novel_rule_promote、novel_rule_rollback |
| 项目生命周期（3） | novel_project_create、novel_project_list、novel_project_delete |
| 规划与创作（9） | novel_bootstrap_run、novel_story_arc_start、novel_story_arc_get、novel_story_arc_review、novel_story_arc_batch_start、novel_story_arc_orchestrate、novel_chapter_review、novel_chapter_review_issue_add、novel_chapter_generate |
| 评估闭环（1） | novel_closed_loop_run |
| Workflow 查询（2） | novel_workflow_get、novel_workflow_list |
| Workflow 决策（1） | novel_chapter_review_decision |
| 上下文与产物查询（2，新增） | novel_context_get、novel_artifact_list |

## 5. 与 skill 的关系

- `.agents/skills/novel-mcp-orchestration/SKILL.md`：外部编排者的流程参考（本流程的 skill 化表达），回答「什么阶段该调哪个工具、外部模型应该做什么、不该做什么」。
- `.agents/skills/novel-writing/SKILL.md`：创作方法论（工程化 × 文学质量），回答「什么算好故事、怎么审、怎么修」。
- `skills/novel-v2/*.yaml`：运行时注入的 execution-point skill，是系统内部各阶段的创作规则，外部模型不直接编辑（通过 craft-rule 候选演进）。
