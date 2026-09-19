---
name: novel-autopilot
description: >-
  Autonomous driving protocol for an agent (dsh) advancing the novel-v2
  creation pipeline without a human in the loop: a perceive-decide-act loop
  over project state, Temporal workflow waiting without busy-polling,
  autonomous review + author-approve under manual gates, completion criteria,
  and failure escalation rules. Process details (tool mapping, gate rules,
  stage protocols) live in the novel-mcp-orchestration skill — load it first.
  Use when told to 自主推进小说, autopilot 小说创作, 自动推进章节,
  无人值守推进项目, or to drive the novel pipeline unattended.
metadata:
  audience: autonomous orchestrator agents (dsh headless runs) driving novel-v2
  scope: driving protocol only; process reference is novel-mcp-orchestration,
    craft judgment is novel-writing
---

# 小说创作自主推进协议（autopilot）

> 当前工具面：50（= 代码 `src/novel-v2/mcp/tool-metadata.ts` 的 `TOOL_COUNT`，由 `src/novel-v2/__tests__/mcp-tool-face-single-source.test.ts` 校验本文件与 spec 声明一致）。阶段/工具映射的细则在 novel-mcp-orchestration，本文件只写决策规则；改工具面后两处都要跟上。

## 定位与加载顺序

1. **先加载 `novel-mcp-orchestration` skill**：全流程工具映射、质量门规则、
   阶段推进协议（尤其阶段 0.5 manual-gate 序列与治理者纪律）都在那里，
   本 skill 不重复。
2. 创作质量判断（什么是好故事、怎么审、怎么修）按需加载 `novel-writing` skill。
3. 本 skill 只定义自主运行模式的**驱动协议**：怎么感知、怎么决策、怎么等待、
   什么时候停。

## 自主驱动循环（感知 → 决策 → 执行 → 等待）

每一轮开始先感知项目状态，再按决策表行动：

```
感知：novel_catalog_get(projectId, compact=true)
     + novel_context_get(projectId, sections=["narrative-state","open-elements"])
```

| 项目状态 | 动作 |
| --- | --- |
| foundation 未完成（bootstrap 进行中或中断） | `novel_bootstrap_run`（同项目幂等重启）→ 走阶段 0.5 逐阶段推进 |
| foundation 某阶段已生成、待审核 | 读 artifact 评估 → approve + 提交 independent review（见下节） |
| foundation 完成、无故事弧 | `novel_story_arc_start`；任务要求剧情编排时 `novel_story_arc_orchestrate`（编排前先 `novel_context_get` 事实梳理） |
| 弧蓝图待审 | `novel_story_arc_review` 读蓝图 → 审核/推进 |
| 弧完成、章节可推进 | `novel_story_arc_batch_start` |
| 章节生成 workflow 进行中 | 等待（见下节等待策略），完成后读产物决策 |
| 章节候选稿待决策 | 读三审 + 正文 → 自主审校决策（见下节） |
| 目标章节全部定稿（final） | 任务完成 → 汇报 |

## manual gate 下的自主审核

自主模式下你同时充当**独立审核者**与**作者确认**，但审核标准不降：

1. 读 artifact 全文细读评估，核对语言契约（表层无英文/技术原词）、揭示物分层、
   跨产物一致性（卷数/实体/势力/地点）——这些是 novel-mcp-orchestration
   阶段 0.5 的放行核对项。
2. 达标：`novel_action_execute(action=plan.approve, runId, workItemId)` +
   `novel_review_submit(reviewer=independent, verdict=passed, issues=[跨阶段缺口清单])`。
   两者顺序不敏感，都落库即自动 accept。
3. 不达标：`novel_review_submit(verdict=revise, issues=[可执行意见])` 驱动重新生成，
   **不要**手动 work.start / work.revise（会与自动修订竞态导致 workflow failed）。
4. 跨阶段职责判定遵循既有规则：本阶段核心职责达标即可放行，下游职责登记为
   跨阶段审核清单。

## 章节候选稿的自主审校决策

1. `novel_workflow_get(workflowId)` 拿 artifactId → `novel_artifact_get` 读正文与三审。
2. 无 blocker/major：`novel_chapter_review_decision(approve)`。
3. 有问题但可定向修：追加 issue（带 evidenceQuote + 段落号）→
   `novel_chapter_review(mode=targeted, targetIssueIds=[...])`。
4. 严重问题：`novel_chapter_review_decision(revise, feedback, revisionBase)`。
   approve 带 blocker/major 时必须给 feedback 理由。
5. 同项目章节审校互斥：`projectActiveReviewWorkflowId` 存在时等待，不并发启动。

## 等待策略（Temporal workflow，数分钟量级）

章节生成/审校/修订是 Temporal workflow，耗时以分钟计。**不要忙轮询**
（每回合反复调 novel_workflow_get 空转），用后台 job 等待：MCP server 的
streamable-http 端点支持无会话直调，pwsh 后台 job 里用 curl 循环查询即可。

```
# pwsh 后台 job 模板（workflow 终态后退出，dsh 收到 job 完成通知）
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  $resp = curl -s -X POST http://127.0.0.1:7654/mcp `
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" `
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"novel_workflow_get","arguments":{"workflowId":"<id>"}}}'
  if ($resp -match '"status":"(completed|failed)"' -or $resp -match '"latestStatus":"(COMPLETED|FAILED)"') { break }
  Start-Sleep -Seconds 30
}
```

- 状态字段名以 novel_workflow_get 实际返回为准（temporal 字段反映真实运行状态），
  模板中的匹配模式是兜底；首次调用后按真实响应调整匹配。
- 短等待（<2 分钟）可接受一次同步轮询脚本（上限 2 分钟）。
- 连续多章推进时，等待期间不要并发启动同项目的互斥操作。

## 完成与停止判定

- **明确目标**（如"推进到第 N 章"）：目标达成即完成，汇报章节列表与关键质量指标。
- **开放目标**（如"继续推进"）：完成一个有意义的里程碑（一章定稿 / 一个弧阶段
  通过）后停下汇报，等待下一步指示——不要无限续航。
- **需要人类决策**（题材方向、大纲级取舍、创意输入不足）：停下汇报并给出
  选项，不要替用户猜。
- 长任务（连续 ≥3 章）建议用 goal 工具建目标跟踪，每章定稿后更新进度。

## 异常上报（不盲目重试）

| 异常 | 处理 |
| --- | --- |
| workflow failed（Temporal 终态，不可恢复） | 记录原因与影响范围，停下汇报。可建议 `novel_bootstrap_run` 重启（会覆盖已批准产物），由用户决定 |
| 单个工具调用失败 | 重试 1 次；再失败停下汇报（可能是模型服务/端点问题） |
| 连续 2 轮 revise 后仍存在 major 问题 | 停下汇报审校意见与你的分析，不要无限修订循环 |
| 端点限流/配额类错误 | 立即停下汇报，不要重试放大消耗 |

## 纪律继承

novel-mcp-orchestration 的全部质量门规则对自主模式同样生效且**更加严格**：
自主运行没有人在环兜底，任何"绕过门禁省时间"的冲动都是事故源。不确定时
选择停下汇报，而不是猜一个方向推进。
