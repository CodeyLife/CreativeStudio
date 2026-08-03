# V2 重构后续计划

> 基于 2026-07-27 实际代码盘点 + 用户决策确认，覆盖剩余重构工作。
> 架构阶段准则：不兼容旧数据、优先最佳实践、允许破坏性变更。

## 一、当前进度盘点（已 vs 未）

### 已完成 ✅

| 模块 | 路径 | 说明 |
|---|---|---|
| 协议类型 | [src/novel-v2/protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) | 评估闭环 + 创意执行全部类型已定义 |
| DB schema | [deploy/postgres/002_evaluation_and_creative.sql](file:///f:/GitHubProject/Ymcp/web/deploy/postgres/002_evaluation_and_creative.sql) | 9 张表已创建 |
| 评估闭环核心 | [src/novel-v2/evaluation/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/) | 6 文件：project-snapshot/experiment-workspace/candidate-bundle/promotion/skill-iteration/closed-loop |
| 评估闭环 API 路由 | [scripts/novel-v2-api.ts](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-api.ts) | 13 组路由（snapshots/experiments/candidates/receipts/closed-loop） |
| 评估闭环测试 | [src/novel-v2/__tests__/evaluation.test.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/evaluation.test.ts) | 6 子模块测试套件 |
| 创意执行核心 | [src/novel-v2/creative/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/creative/) | 6 文件：run-manager/work-item/review-gate/command-router/snapshot/index.ts |
| MCP schema/校验 | [src/novel-v2/mcp/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/) | 3 文件：types/tool-definitions（23 工具）/validator |
| 仓库迁移 | [src/novel-v2/postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts) | migrate() 加载 002 扩展 schema |
| 旧版 Studio UI | [src/pages/NovelV2Studio.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/NovelV2Studio.tsx) | 仅基础工作流（项目/文档/run），无 evaluation/creative/mcp 面板 |

### 未完成（本计划范围）❌

- B-2.2b 剩余：mcp/handlers.ts + mcp/index.ts（工具调用执行器）
- B-2.3：temporal/workflows.ts 新增 creativeRunWorkflow + blocker non-retryable 修复
- B-2.4：创意执行 API 路由（5 组）
- B-2.5：MCP server v2 入口（新建 scripts/novel-v2-mcp-server.mjs）
- B-2.6：creative-execution.test.ts + mcp-tool-gateway.test.ts
- B-3.1~B-3.4：扩展 NovelV2Studio + 3 个新 Panel 组件
- B-3.5：前端 API 路由转发（如需）
- B-3.6：前端测试
- B-4.1：v1 死代码清理（src/features/novel/ + scripts/novel-mcp-server.mjs）
- B-4.2：v2 薄弱点修复
- B-4.3：全局验证

### 关键决策（已确认 ✅）

1. **前端 UI 路径**：扩展 src/pages/NovelV2Studio.tsx + 新建 src/pages/novel-v2/ 下 Panel 组件
2. **v1 死代码清理**：B-4 阶段统一清理（每阶段暂留作参考）
3. **MCP server 入口**：新建 scripts/novel-v2-mcp-server.mjs，v1 共存到 B-4 再删

---

## 二、阶段 B-2：创意执行 + MCP 工具网关收尾

### B-2.2b 新建 mcp/handlers.ts + mcp/index.ts

**新建** [src/novel-v2/mcp/handlers.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts)：

实现 23 个工具的 handler，按工具分组组织：

```typescript
import type { ToolHandler, ToolContext } from "./types";
import * as creative from "../creative";
import * as evaluation from "../evaluation";
import { captureProjectSnapshot, runClosedLoop } from "../evaluation/closed-loop";

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ===== Run / Action 主体（7）=====
  novel_run_create: async (args, ctx) => { /* 调用 creative.createCreativeRun */ },
  novel_run_get: async (args, ctx) => { /* 调用 creative.getRunSnapshot */ },
  novel_action_list: async (args, ctx) => { /* 调用 creative.listWorkItems */ },
  novel_action_execute: async (args, ctx) => { /* 调用 creative.executeCreativeCommand */ },
  novel_artifact_get: async (args, ctx) => { /* 查询 artifacts 表 */ },
  novel_review_submit: async (args, ctx) => { /* 调用 creative.submitReview */ },
  novel_run_complete: async (args, ctx) => { /* 调用 creative.updateRunStatusFromWork */ },

  // ===== Catalog / Receipt（3）=====
  novel_catalog_get: async (args, ctx) => { /* 查询 candidates 列表 */ },
  novel_receipt_get: async (args, ctx) => { /* 查询 promotion_receipts */ },
  novel_rule_target_get: async (args, ctx) => { /* 查询 skill_definitions */ },

  // ===== Craft Rule 候选演进（7）=====
  novel_rule_candidate_create: async (args, ctx) => { /* TODO P1: 接入 craft-rule 模块 */ },
  novel_rule_candidate_get: async (args, ctx) => { /* TODO P1 */ },
  novel_rule_evidence_submit: async (args, ctx) => { /* TODO P1 */ },
  novel_rule_foundation_evaluate: async (args, ctx) => { /* TODO P1 */ },
  novel_rule_review_submit: async (args, ctx) => { /* TODO P1 */ },
  novel_rule_promote: async (args, ctx) => { /* TODO P1: 复用 promotion.createPromotionService */ },
  novel_rule_rollback: async (args, ctx) => { /* TODO P1: 复用 promotion.rollback */ },

  // ===== 项目生命周期（3）=====
  novel_project_create: async (args, ctx) => { /* 调用 repository.ensureProject */ },
  novel_project_list: async (args, ctx) => { /* 调用 repository.listProjects */ },
  novel_project_delete: async (args, ctx) => { /* 调用 repository.deleteProject */ },

  // ===== 一键流程（2）=====
  novel_bootstrap_run: async (args, ctx) => { /* TODO P2: 接入 foundation bootstrap */ },
  novel_chapter_review: async (args, ctx) => { /* TODO P2: 复用 temporal activities.review */ },

  // ===== 评估闭环（1，v2 新增）=====
  novel_closed_loop_run: async (args, ctx) => {
    const { projectId, documentId, instruction, dryRun } = args;
    if (!ctx.model) throw new Error("closed_loop_run 需要 model 上下文");
    return runClosedLoop({
      repository: ctx.repository,
      model: ctx.model,
      projectId: projectId as string,
      documentId: documentId as string,
      instruction: instruction as string,
      dryRun: Boolean(dryRun),
    });
  },
};
```

**新建** [src/novel-v2/mcp/index.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/index.ts)：

```typescript
import { TOOL_NAMES, TOOL_DEFINITIONS } from "./tool-definitions";
import { validateToolArgs } from "./validator";
import { TOOL_HANDLERS } from "./handlers";
import type { McpToolResponse, ToolContext } from "./types";

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResponse> {
  if (!TOOL_NAMES.includes(toolName as never)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `未知工具: ${toolName}` }) }], isError: true };
  }
  const validation = validateToolArgs(toolName, args);
  if (!validation.valid) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `参数校验失败: ${validation.errors?.join("; ")}` }) }], isError: true };
  }
  try {
    const result = await TOOL_HANDLERS[toolName](args, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message, tool: toolName }) }], isError: true };
  }
}

export { TOOL_DEFINITIONS, TOOL_NAMES } from "./tool-definitions";
export { validateToolArgs } from "./validator";
export type { ToolDefinition, ToolHandler, ToolContext, McpToolResponse } from "./types";
```

**依赖**：creative/ 模块已完成（B-2.2）✅
**验收**：每个 handler 能被 executeTool 路由调用；TODO P1 的 craft-rule 工具先抛 NotImplementedError 占位。

---

### B-2.3 扩展 [src/novel-v2/temporal/workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)

#### 任务 1：新增 `creativeRunWorkflow`

```typescript
import { defineSignal, proxyActivities, setHandler, condition } from "@temporalio/workflow";

export const pauseSignal = defineSignal<[void]>("pause");
export const resumeSignal = defineSignal<[void]>("resume");
export const cancelSignal = defineSignal<[void]>("cancel");
export const reviewSubmittedSignal = defineSignal<[unknown]>("reviewSubmitted");

export interface CreativeWorkflowActivities {
  loadRun(input: { runId: string }): Promise<CreativeRun>;
  listPendingWork(input: { runId: string }): Promise<CreativeWorkItem[]>;
  startWork(input: { runId: string; workItemId: string }): Promise<unknown>;
  reviewGate(input: { runId: string; workItemId: string }): Promise<CreativeReviewGate>;
  reviseWork(input: { runId: string; workItemId: string }): Promise<unknown>;
  updateWorkStatus(input: { runId: string; workItemId: string; status: string }): Promise<unknown>;
  recordEvent(input: { runId: string; eventType: string; payload: Record<string, unknown> }): Promise<unknown>;
}

export async function creativeRunWorkflow(runId: string): Promise<void> {
  const activities = proxyActivities<CreativeWorkflowActivities>({ startToCloseTimeout: "10 minutes" });
  let paused = false;
  let cancelled = false;
  setHandler(pauseSignal, () => { paused = true; });
  setHandler(resumeSignal, () => { paused = false; });
  setHandler(cancelSignal, () => { cancelled = true; });

  await activities.recordEvent({ runId, eventType: "workflow.started", payload: {} });

  while (!cancelled) {
    if (paused) {
      await condition(() => !paused || cancelled, "1 minute");
      continue;
    }
    const pending = await activities.listPendingWork({ runId });
    if (pending.length === 0) break;

    for (const work of pending) {
      if (cancelled) break;
      await activities.startWork({ runId, workItemId: work.id });
      // 自动门禁：等待 review 或 manual gate signal
      const gate = await activities.reviewGate({ runId, workItemId: work.id });
      if (!gate.passed) {
        await condition(() => false, "1 minute"); // TODO P2: 等待 reviewSubmittedSignal
      }
      // gate.passed 后接受工作项
      await activities.updateWorkStatus({ runId, workItemId: work.id, status: "accepted" });
    }
  }

  await activities.recordEvent({ runId, eventType: cancelled ? "workflow.cancelled" : "workflow.completed", payload: {} });
}
```

#### 任务 2：修复 blocker non-retryable

**问题根因**：当前 [workflows.ts:146](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts#L146) 中 `finalDecision.hasBlocker` 直接 `throw`，使 workflow 进入 failed 状态。但 `decideRevision` 已经有完整的 blocker 重试逻辑（最多 maxIterations 轮），不应该在循环外再次判断 hasBlocker。

**修复**：
```typescript
// 修复前
const finalDecision = decideRevision({ reviews, iteration, maxIterations, previousScore });
if (!allReviewsPassed(reviews) && finalDecision.hasBlocker) {
  throw new Error(`审核未通过且仍有 blocker，任务进入人工队列：${finalDecision.reason}`);
}

// 修复后
const finalDecision = decideRevision({ reviews, iteration, maxIterations, previousScore });
if (!allReviewsPassed(reviews)) {
  // 已用尽自动修订次数但仍未通过：转入人工队列而非 fail
  await activities.updateWorkflowStatus({
    workflowId,
    status: "completed",  // workflow 本身成功完成（自动阶段），但 artifact 标记需人工
    payload: {
      blueprintId: blueprint.id,
      iterations: iteration,
      finalScore: finalDecision.currentScore,
      manualReviewRequired: true,
      reason: finalDecision.reason,
    },
  });
  await activities.commit({ /* ... */ });  // 仍提交，但 status="review"
  return blueprint;
}
```

**依赖**：无
**验收**：
- 新测试：blocker → revise → passed 路径正常完成
- 新测试：blocker → revise → blocker（maxRetries 用尽）→ workflow 仍 completed + manualReviewRequired=true
- 新测试：creativeRunWorkflow 能循环处理多个 work items

---

### B-2.4 扩展 [scripts/novel-v2-api.ts](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-api.ts) 创意执行路由

新增 5 组路由：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v2/projects/:projectId/creative-runs` | 创建创意 run（mode/policy/payload） |
| GET | `/v2/projects/:projectId/creative-runs` | 列出 run |
| GET | `/v2/creative-runs/:runId` | 获取 run 详情（含 work items + reviews + events） |
| POST | `/v2/creative-runs/:runId/commands` | 提交命令（work.start/accept/revise/retry/recover/review.submit/run.pause/resume/cancel） |
| GET | `/v2/creative-runs/:runId/events?afterSequence=N` | 获取事件流（增量） |

**实现要点**：
- 调用 `creative.createCreativeRun` / `listCreativeRuns` / `getRunSnapshot` / `executeCreativeCommand`
- 命令提交用 `executeCreativeCommand`（已含幂等性）
- 事件流支持 `afterSequence` 增量拉取（来自 [snapshot.ts:140](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/creative/snapshot.ts#L140)）

**依赖**：B-2.2 已完成 ✅

---

### B-2.5 新建 [scripts/novel-v2-mcp-server.mjs](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-mcp-server.mjs)

stdio JSON-RPC 2.0 协议，加载 v2 的 23 个工具：

```javascript
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository.ts";
import { LiteLlmGateway } from "../src/novel-v2/model-gateway.ts";
import { TOOL_DEFINITIONS, executeTool } from "../src/novel-v2/mcp/index.ts";

const repository = new NovelPostgresRepository();
await repository.migrate();
const model = new LiteLlmGateway();
const ctx = { repository, model };

// JSON-RPC 2.0 over stdio
process.stdin.on("data", async (chunk) => {
  const message = JSON.parse(chunk.toString().trim());
  const { id, method, params } = message;
  try {
    let result;
    if (method === "initialize") {
      result = { serverInfo: { name: "novel-v2-mcp", version: "2.0" }, capabilities: { tools: {} } };
    } else if (method === "tools/list") {
      result = { tools: TOOL_DEFINITIONS.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })) };
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      result = await executeTool(name, args ?? {}, ctx);
    } else {
      throw new Error(`未知方法: ${method}`);
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }) + "\n");
  }
});
```

**依赖**：B-2.2b 完成
**验收**：可被 `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node scripts/novel-v2-mcp-server.mjs` 调用返回工具列表。

---

### B-2.6 测试

**新建** [src/novel-v2/__tests__/creative-execution.test.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/creative-execution.test.ts)：
- `run-manager`：创建/查询/状态转换（pending → running → completed/cancelled）
- `work-item`：enqueue/start/accept/revise/retry/recover 状态机；idempotency 校验
- `review-gate`：manual/auto/none 三种模式；autoAcceptThreshold 边界
- `command-router`：所有命令类型路由正确；幂等键命中返回 cached result
- `snapshot`：getRunSnapshot 并行查询正确；afterSequence 增量拉取

**新建** [src/novel-v2/__tests__/mcp-tool-gateway.test.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/mcp-tool-gateway.test.ts)：
- 23 个工具的 inputSchema 校验（无效参数返回 isError=true）
- happy path：核心工具（project_create/run_create/closed_loop_run）至少一个成功调用
- 错误处理：项目不存在 / run 不存在 / 命令冲突
- executeTool 路由：未知工具返回 isError=true

**AGENTS.md 合规**：
- 测试必须覆盖跨场景 counterexample（如幂等键命中应返回 cached）
- 测试必须验证 review-gate 的 boundary condition（score 恰好等于 threshold）

---

## 三、阶段 B-3：前端 UI 补全

### B-3.1 扩展 [src/pages/NovelV2Studio.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/NovelV2Studio.tsx)

在现有项目/文档/run tab 基础上，新增 3 个 tab：

```typescript
// 在 NovelV2Studio 顶部 tabs 新增
const tabs = [
  { key: "documents", label: "章节", children: <DocumentsTab /> },        // 现有
  { key: "runs", label: "工作流", children: <RunsTab /> },                // 现有
  { key: "evaluation", label: "评估闭环", children: <EvaluationPanel projectId={projectId} /> },  // 新增
  { key: "creative", label: "创意执行", children: <CreativeRunPanel projectId={projectId} /> },    // 新增
  { key: "mcp", label: "MCP 工具", children: <McpToolGatewayPanel /> },   // 新增
];
```

**API client 复用**：现有 `readJson` 函数已封装 `/v2/*` 路由，无需新建 api-client.ts。

---

### B-3.2 新建 [src/pages/novel-v2/EvaluationPanel.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/EvaluationPanel.tsx)

评估闭环可视化面板，4 个区块：

1. **快照列表**：表格展示 id/hash/createdAt，操作按钮「捕获快照」「查看 payload」
2. **实验工作区列表**：表格展示 id/schemaName/status/createdAt，操作按钮「创建实验」「关闭」「删除」
3. **候选包详情**：选中 candidate 后展示 manuscript 预览（plainText）+ acceptedFacts 列表 + iteratedSkills diff（before/after）
4. **晋升管理**：候选包列表 + 「晋升」按钮（弹窗确认 AuthorDecision）+ 收据列表（status 颜色标识 promoted/rolled-back/failed）

**IndexedDB 契约合规**（AGENTS.md）：实验工作区删除按钮必须始终可用，不被 `legacyReadOnly` 短路（v2 无 legacyReadOnly，但 UI 仍需保证删除路径可达）。

---

### B-3.3 新建 [src/pages/novel-v2/CreativeRunPanel.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/CreativeRunPanel.tsx)

创意执行控制台：

- **run 列表**：表格展示 id/mode/status/createdAt，操作按钮「创建 run」「查看详情」
- **run 详情**：work items 时间线（pending → running → accepted/revised/retried/failed）+ reviews 列表
- **命令提交表单**：选择 work item + 选择命令类型（work.start/accept/revise/retry/recover）+ 提交
- **review 提交表单**：verdict 选择 + issues 编辑器（severity/title/evidence/suggestion）+ summary
- **事件流**：实时刷新（轮询 `/v2/creative-runs/:runId/events?afterSequence=N`），最新事件置顶

---

### B-3.4 新建 [src/pages/novel-v2/McpToolGatewayPanel.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/McpToolGatewayPanel.tsx)

MCP 工具调用面板：

- **工具卡片网格**：23 个工具按分组（Run/Action/Catalog/Rule/Project/Bootstrap/ClosedLoop）展示
- **工具调用弹窗**：点击工具后弹窗，根据 inputSchema 动态生成表单（string/number/boolean/array/object）
- **调用结果展示**：JSON viewer（react-json-view 或自实现）
- **历史调用记录**：最近 10 次调用，可重新执行

**简化策略**：inputSchema 动态表单可先用 `<Input.TextArea>` 接收 JSON 字符串，避免复杂的 schema-driven 表单（TODO P2）。

---

### B-3.5 前端 API 路由转发（如需）

**评估**：当前 NovelV2Studio 直接 fetch `/v2/*`，dev-v2.mjs 启动 4770 端口。生产环境需通过 Next.js API Routes 代理。

**实施**：仅在需要部署到生产时新增 `src/app/api/novel-v2/[...path]/route.ts`，开发阶段跳过。

---

### B-3.6 前端测试

新建 [src/pages/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/__tests__/)：

- `EvaluationPanel.test.tsx`：快照创建 / 候选晋升流程 / 删除路径可达
- `CreativeRunPanel.test.tsx`：命令提交 / review 流程
- `McpToolGatewayPanel.test.tsx`：工具调用 / 错误展示

**测试基础设施**：复用 [src/features/novel/__tests__/setup.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/__tests__/setup.ts)，使用 vitest + @testing-library/react。

---

## 四、阶段 B-4：清理与验证

### B-4.1 v1 死代码清理

架构阶段准则允许破坏性变更。以下 v1 模块已被 v2 取代，整体删除：

| 删除路径 | 替代 v2 路径 |
|---|---|
| [src/features/novel/evaluation/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/evaluation/) | [src/novel-v2/evaluation/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/) |
| [src/features/novel/creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) | [src/novel-v2/creative/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/creative/) |
| [src/features/novel/creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) | [src/novel-v2/mcp/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/) |
| [src/features/novel/ClosedLoopPanel.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ClosedLoopPanel.tsx) | [src/pages/novel-v2/EvaluationPanel.tsx](file:///f:/GitHubProject/Ymcp/web/src/pages/novel-v2/EvaluationPanel.tsx) |
| [src/features/novel/__tests__/bench/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/__tests__/bench/) 全部 v1 bench 测试 | 由 [src/novel-v2/__tests__/evaluation.test.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/evaluation.test.ts) 替代 |
| [src/features/novel/__tests__/creative-execution.test.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/__tests__/creative-execution.test.ts) | 由 v2 creative-execution.test.ts 替代 |
| [src/features/novel/__tests__/creative-tool-gateway.test.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/__tests__/creative-tool-gateway.test.ts) | 由 v2 mcp-tool-gateway.test.ts 替代 |
| [src/features/novel/__tests__/ClosedLoopPanel.test.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/__tests__/ClosedLoopPanel.test.tsx) | 由 v2 EvaluationPanel.test.tsx 替代 |
| [scripts/novel-mcp-server.mjs](file:///f:/GitHubProject/Ymcp/web/scripts/novel-mcp-server.mjs) | [scripts/novel-v2-mcp-server.mjs](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-mcp-server.mjs) |
| [scripts/novel-bench/](file:///f:/GitHubProject/Ymcp/web/scripts/novel-bench/) v1 bench 脚本 | 由 v2 测试替代 |

**清理策略**：
1. 先用 Grep 确认无外部引用（除 v1 自身测试）
2. 删除源码 + 对应测试文件
3. 跑 `pnpm lint` 确认无 dangling import
4. 跑 `pnpm test` 确认无失败测试

**保留的 v1 模块**（暂不删，但需评估）：`src/features/novel/AIWorkbench.tsx`、`ArchitectureDataEditor.tsx` 等 UI 组件 —— 它们可能与 v2 Studio 重叠，但功能更完整，B-3 完成后再评估。

---

### B-4.2 v2 薄弱点修复

预期热点（基于代码 review）：

1. **[experiment-workspace.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/experiment-workspace.ts) 的 `query()` 正则替换可能误改 SQL**
   - 问题：`text.replace(/FROM\s+([a-z_]+)/g, ...)` 会匹配 SQL 中所有 FROM 子句，包括子查询
   - 修复：改为 schema-qualified 查询（在建表时就用 `${schemaName}.table_name`，而非运行时替换）

2. **[promotion.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/promotion.ts) 的 `arraysEqual` 对 finalDocumentHashes 顺序敏感**
   - 问题：finalDocumentHashes 按 narrativeOrder 排序，但实验期间可能改变顺序
   - 修复：排序后比较（`[...a].sort().join("|") === [...b].sort().join("|")`）

3. **[skill-iteration.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/evaluation/skill-iteration.ts) 的 `JSON.parse(skill.afterPrompt)` 失败时静默跳过**
   - 问题：第 329 行 `try { JSON.parse(...) } catch { ... }` 静默降级，未记录到 events
   - 修复：在 catch 中调用 `writeRunEvent` 记录 `skill.iteration.fallback` 事件

4. **B-2.3 修复后回归测试**：确保 blocker 路径修复不破坏现有 revision-policy 测试

---

### B-4.3 全局验证

```bash
pnpm lint                              # ESLint + TypeScript 严格检查
pnpm test                              # 全量测试套件
pnpm test src/novel-v2                 # 仅 v2 子集
pnpm test src/pages/novel-v2           # 前端测试
```

**文件大小审计**：
- 每个 v2 模块单文件 < 500 行（超出则拆分）
- 测试文件 < 1000 行
- 前端组件 < 400 行（超出则拆分子组件）

**AGENTS.md 合规最终检查**：
- [ ] 章节审校工作流复用：creative run 的章节生成必须复用 `novelIntentWorkflow`，不允许另起一套
- [ ] 经验沉淀：review/commit 后必须触发 `RuntimeLearningAssessment` → `proposeImprovement` → `createCraftRuleCandidate`
- [ ] IndexedDB 删除契约：UI 必须始终提供删除/关闭路径
- [ ] TODO 标记：未实现/临时方案/硬编码/性能隐患必须标 TODO（P1/P2/P3）

---

## 五、执行顺序与依赖

```
B-2.2b (mcp handlers) ──┐
B-2.3 (temporal) ───────┤
B-2.4 (API 路由) ────────┤
B-2.5 (MCP server) ──────┤
B-2.6 (测试) ────────────┤
                         ├──→ B-4 (清理与验证)
B-3.1 (Studio 扩展) ─────┤
B-3.2 (Eval Panel) ──────┤
B-3.3 (Creative Panel) ──┤
B-3.4 (MCP Panel) ───────┤
B-3.6 (前端测试) ────────┘
```

**并行机会**：
- B-2.2b 与 B-2.3 可并行（mcp handlers 与 temporal workflow 互不依赖）
- B-2.4 与 B-2.5 可并行（API 路由与 MCP server 都依赖 B-2.2 已完成）
- B-3.1~B-3.4 可并行（4 个 UI 组件互相独立）
- B-4.1 与 B-4.2 可并行（清理与修复互不依赖）

**推荐执行批次**：
1. **批次 1**（B-2 收尾）：B-2.2b → B-2.3 → B-2.4 → B-2.5 → B-2.6
2. **批次 2**（B-3 前端）：B-3.1 → (B-3.2 + B-3.3 + B-3.4 并行) → B-3.6
3. **批次 3**（B-4 清理）：B-4.1 + B-4.2 → B-4.3

---

## 六、AGENTS.md 合规要点

每个阶段必须满足：

1. **根因分析**：测试失败时先识别 failingLayer / underlyingMechanism / affectedInputClass，不允许只改 fixture 让单 sample 通过
2. **章节审校工作流复用**：creative run 的章节生成必须复用 `novelIntentWorkflow`，不允许另起一套
3. **经验沉淀**：review/commit 后必须触发 `RuntimeLearningAssessment` → `proposeImprovement` → `createCraftRuleCandidate`
4. **IndexedDB 删除契约**：UI 必须始终提供删除/关闭路径（v2 用 Postgres，但 UI 仍需保证 experiment/run 的删除按钮可达）
5. **架构阶段准则**：不兼容旧数据、不保留 v1 折中、允许破坏性变更
6. **TODO 标记**：未实现/临时方案/硬编码/性能隐患必须标 TODO（P1/P2/P3）
