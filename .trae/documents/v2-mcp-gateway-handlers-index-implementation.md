# V2 MCP 工具网关：handlers.ts + index.ts 实现计划

## 摘要

在 `f:\GitHubProject\Ymcp\web\src\novel-v2\mcp\` 目录下完成 V2 MCP 工具网关的最后两个文件：
- `handlers.ts`：实现 23 个工具的 handler 函数
- `index.ts`：统一导出 + `executeTool` 入口（校验 → 路由 → 包装 McpToolResponse）

架构阶段，不兼容 v1 IndexedDB 实现。所有 handler 基于 `NovelPostgresRepository` + 已实现的 `creative/` 和 `evaluation/` 模块。最后运行 `pnpm exec tsc --noEmit` 验证无 TypeScript 错误。

---

## 当前状态分析

### 已完成文件
| 文件 | 状态 | 内容 |
|------|------|------|
| `mcp/types.ts` | ✅ 完成 | `ToolContext`（repository + 可选 model）、`ToolDefinition`、`ToolHandler`、`McpToolResponse` |
| `mcp/tool-definitions.ts` | ✅ 完成 | 23 个工具的 `TOOL_NAMES` 常量 + JSON Schema 定义（部分工具标记 TODO P2） |
| `mcp/validator.ts` | ✅ 完成 | `validateToolArgs` + `createValidator`（AJV，allErrors:true, strict:false） |

### 待创建文件
| 文件 | 内容 |
|------|------|
| `mcp/handlers.ts` | 23 个 `ToolHandler` 实现 + 辅助函数 + `HANDLERS` 注册表 |
| `mcp/index.ts` | 统一导出 + `executeTool(toolName, args, ctx)` 入口 + `listTools()` |

### 可用基础设施（Phase 1 探索结论）

**creative/ 模块导出**（`src/novel-v2/creative/index.ts`）：
- `createCreativeRun(repository, {projectId, mode, policy?, payload?})` → `CreativeRun`
- `getCreativeRun(repository, runId)` → `CreativeRun | null`
- `listCreativeRuns(repository, projectId)` → `CreativeRun[]`
- `pauseCreativeRun` / `resumeCreativeRun` / `cancelCreativeRun`
- `enqueueCreativeWork(repository, runId, {kind, taskKey?, targetId?, instruction, dependsOn?, parameters?})` → `CreativeWorkItem`
- `getWorkItem` / `listWorkItems` / `startWork` / `acceptWork` / `reviseWork` / `retryWork` / `recoverWork` / `failWork` / `attachArtifact`
- `submitReview(repository, workItemId, review)` → `CreativeReview`
- `listReviews` / `evaluateReviewGate` / `checkGate`
- `executeCreativeCommand(repository, command & {runId})` → `CreativeActionResult`（内建幂等检查）
- `getRunSnapshot(repository, runId, afterSequence?)` → `CreativeRunSnapshot | null`

**evaluation/ 模块**：
- `runClosedLoop({repository, model, projectId, documentId, instruction?, experimentId?, codeRevision?, authorId?, dryRun?})` → `ClosedLoopResult`
- 注意：`runClosedLoop` 必填 `model: ModelGateway`（ToolContext.model 是可选的，handler 需校验）

**NovelPostgresRepository 方法**：
- `ensureProject(projectId, title?)` — ON CONFLICT DO UPDATE，幂等
- `listProjects()` — 返回项目摘要数组（含 latestRunStatus）
- `getProjectDetail(projectId)` — 返回 `NovelProjectDetail`（含 documents + latestRuns）
- `deleteProject(projectId)` — 级联删除，返回 `{deleted, projectId}`
- `listProjectRuns(projectId, limit?)` — 返回 `WorkflowRunRecord[]`
- `getRecord(table, id)` — 通用记录查询（artifacts 表可用）
- `pool` — 暴露的 `pg.Pool` 实例，可直接查询 skill_definitions / promotion_receipts 等表

**protocol.ts 关键类型**：
- `CreativeCommand` 联合类型：work.start/revise/retry/recover/accept、review.request/submit、run.pause/resume/cancel
- `CreativeRunSnapshot`：`{run, workItems, reviews, events}`（注意：v2 不含 nextActions/reviewGates，需在 handler 派生）
- `CreativeRunPolicy`：`{maxRetries, reviewGate, autoAcceptThreshold?}`

**已确认不存在的模块**：
- v2 无 craft-rule 模块 → 7 个 craft rule 工具标记 TODO P2，handler 返回结构化错误
- v2 无 artifact 专用查询 → `novel_artifact_get` 用 `getRecord("artifacts", id)` 实现基础版
- v2 无 chapter-review temporal workflow 入口 → `novel_chapter_review` 标记 TODO P2

**数据库表**（来自 `deploy/postgres/002_evaluation_and_creative.sql`）：
- `promotion_receipts`：id, candidate_id, project_id, status, result(JSONB), failure_reason, created_at
- `creative_runs` / `creative_work_items` / `creative_reviews` / `creative_run_events`
- `skill_definitions`：skill_id, version, capabilities, applicable_tasks, required_memory_kinds, quality_gates, prompt_sections

---

## 提议变更

### 文件 1：`src/novel-v2/mcp/handlers.ts`

#### 1.1 模块结构

```typescript
// 顶部导入
import type { ToolContext, ToolHandler } from "./types";
import type { CreativeCommand, CreativeRunSnapshot, CreativeWorkItem, CreativeReview, CreativeRunPolicy, CreativeReviewInput, ReviewIssue } from "../protocol";
import {
  createCreativeRun, getCreativeRun, listCreativeRuns,
  pauseCreativeRun, resumeCreativeRun, cancelCreativeRun,
  enqueueCreativeWork, getWorkItem, listWorkItems,
  executeCreativeCommand, getRunSnapshot,
  submitReview, listReviews, checkGate,
} from "../creative";
import { runClosedLoop } from "../evaluation/closed-loop";
```

#### 1.2 辅助函数（模块私有）

```typescript
// 字段提取（与 v1 requiredString 同模式，但 v2 ajv 已校验类型，这里只做空值兜底）
function requiredString(args: Record<string, unknown>, key: string): string
function optionalString(args: Record<string, unknown>, key: string): string | undefined
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined
function optionalBoolean(args: Record<string, unknown>, key: string, defaultValue?: boolean): boolean | undefined

// TODO P2 工具统一错误构造
function notImplemented(toolName: string, reason: string): never  // throw Error

// 从 run snapshot 派生可执行 action 列表（v2 getRunSnapshot 不返回 nextActions）
function deriveActions(snapshot: CreativeRunSnapshot): string[]
```

**deriveActions 逻辑**（基于 run.status + workItems 状态）：
- run.status === "running" → 可 `run.pause` / `run.cancel`
- run.status === "paused" → 可 `run.resume` / `run.cancel`
- run.status ∈ {pending, running} → 可 `work.enqueue`
- 每个 pending work item（dependsOn 全 accepted）→ 可 `work.start`
- 每个 running work item → 可 `work.accept` / `work.revise` / `work.recover` / `review.request` / `review.submit`
- 每个 accepted work item → 可 `work.revise`
- 每个 failed work item → 可 `work.retry` / `work.recover`

#### 1.3 Bootstrap 任务链常量

复用 v1 `BOOTSTRAP_TASK_CHAIN` + `BOOTSTRAP_TASK_DEPENDENCIES`（10 个任务，硬编码在 handler 中，因 v2 无 generation 模块）：

```typescript
const BOOTSTRAP_TASK_CHAIN = [
  "project-positioning", "architecture", "characters", "relations", "worldview",
  "plot-threads", "foreshadowing", "timeline", "story-control", "plot-design",
] as const;

const BOOTSTRAP_TASK_DEPENDENCIES: Record<string, string[]> = {
  "project-positioning": [],
  "architecture": ["project-positioning"],
  "characters": ["architecture"],
  "relations": ["characters"],
  "worldview": ["architecture"],
  "plot-threads": ["architecture", "characters", "relations"],
  "foreshadowing": ["plot-threads"],
  "timeline": ["architecture", "plot-threads"],
  "story-control": ["plot-threads", "foreshadowing", "timeline"],
  "plot-design": ["plot-threads", "foreshadowing", "timeline"],
};
```

#### 1.4 23 个 Handler 实现

**Run / Action 主体（7）**

| # | 工具 | 实现要点 |
|---|------|----------|
| 1 | `novel_run_create` | `createCreativeRun(ctx.repository, {projectId, mode, policy, payload: {objective?}})`。mode 从 args.mode 取（ajv 已校验 enum），policy 可选（缺省由 createCreativeRun 填默认值）。返回 `{run}` |
| 2 | `novel_run_get` | `getRunSnapshot(ctx.repository, runId, afterSequence)`。snapshot 为 null 时抛错。返回 `{snapshot}` |
| 3 | `novel_action_list` | `getRunSnapshot` → `deriveActions(snapshot)`。返回 `{run, actions, workItems}` |
| 4 | `novel_action_execute` | 见下方 1.4.1 详解 |
| 5 | `novel_artifact_get` | TODO P2：先尝试 `ctx.repository.getRecord("artifacts", artifactId)`，若不存在抛错。返回 `{artifact}` |
| 6 | `novel_review_submit` | 构造 `CreativeCommand` `{type:"review.submit", workItemId, review, idempotencyKey}` + `{runId}` → `executeCreativeCommand`。返回 `{result}` |
| 7 | `novel_run_complete` | `getRunSnapshot` → 校验所有 workItems.status === "accepted" → 校验无 blocker issue（聚合所有 reviews 的 issues）→ 返回 `{snapshot, completed: true}` |

**1.4.1 novel_action_execute 实现详解**

```typescript
// 伪代码
const { runId, action, idempotencyKey } = args;
if (action === "work.enqueue") {
  // work.enqueue 不走 executeCreativeCommand（无幂等事件），直接 enqueueCreativeWork
  const work = await enqueueCreativeWork(ctx.repository, runId, {
    kind: args.work.kind,
    taskKey: args.work.taskKey,
    targetId: args.work.targetId,
    instruction: args.work.instruction,
    dependsOn: args.work.dependsOn,
    parameters: args.work.parameters,
  });
  return { work, snapshot: await getRunSnapshot(ctx.repository, runId) };
}

// 其他 action 走 executeCreativeCommand（内建幂等检查）
const command = buildCreativeCommand(action, args, idempotencyKey);
const result = await executeCreativeCommand(ctx.repository, { ...command, runId });
return { result };
```

`buildCreativeCommand` 映射（基于 protocol.ts `CreativeCommand` 联合类型）：
- `run.pause` / `run.resume` / `run.cancel` → `{type: action, idempotencyKey}`
- `work.start` / `work.accept` / `review.request` → `{type: action, workItemId, idempotencyKey}`
- `work.revise` → `{type: "work.revise", workItemId, instruction?, idempotencyKey}`
- `work.retry` → `{type: "work.retry", workItemId, idempotencyKey}`
- `work.recover` → `{type: "work.recover", workItemId, force?, idempotencyKey}`
- `review.submit` → `{type: "review.submit", workItemId, review, idempotencyKey}`

**Catalog / Receipt（3）**

| # | 工具 | 实现要点 |
|---|------|----------|
| 8 | `novel_catalog_get` | `Promise.all`：`getProjectDetail(projectId)` + `listCreativeRuns(projectId)` + `pool.query("SELECT skill_id, version, capabilities, applicable_tasks FROM skill_definitions")`。返回 `{project, documents, creativeRuns, skills}` |
| 9 | `novel_receipt_get` | `ctx.repository.pool.query("SELECT id, candidate_id, project_id, status, result, failure_reason, created_at FROM promotion_receipts WHERE id=$1", [receiptId])`。无行抛错。返回 `{receipt}` |
| 10 | `novel_rule_target_get` | TODO P2：`notImplemented("novel_rule_target_get", "v2 craft-rule 模块未实现")` |

**Craft Rule 候选演进（7）** — 全部 TODO P2

| # | 工具 | 实现 |
|---|------|------|
| 11 | `novel_rule_candidate_create` | `notImplemented(...)` |
| 12 | `novel_rule_candidate_get` | `notImplemented(...)` |
| 13 | `novel_rule_evidence_submit` | `notImplemented(...)` |
| 14 | `novel_rule_foundation_evaluate` | `notImplemented(...)` |
| 15 | `novel_rule_review_submit` | `notImplemented(...)` |
| 16 | `novel_rule_promote` | `notImplemented(...)` |
| 17 | `novel_rule_rollback` | `notImplemented(...)` |

错误消息统一：`"novel_rule_* 工具未实现：v2 craft-rule 模块待开发（TODO P2）"`

**项目生命周期（3）**

| # | 工具 | 实现要点 |
|---|------|----------|
| 18 | `novel_project_create` | `idempotencyKey` 作为 projectId（tool-definitions.ts 契约）：`ensureProject(idempotencyKey, title)` → `getProjectDetail(idempotencyKey)`。premise 写入 metadata。返回 `{project}` |
| 19 | `novel_project_list` | `listProjects()`。返回 `{projects}` |
| 20 | `novel_project_delete` | `deleteProject(projectId)`。返回删除结果 |

**一键流程（2）**

| # | 工具 | 实现要点 |
|---|------|----------|
| 21 | `novel_bootstrap_run` | 见下方 1.4.2 详解 |
| 22 | `novel_chapter_review` | TODO P2：`notImplemented("novel_chapter_review", "需接入 temporal workflow startChapterReviewWorkflow（TODO P2）")` |

**1.4.2 novel_bootstrap_run 实现详解**

```typescript
const { projectId, idempotencyKey } = args;
const objective = optionalString(args, "objective") ?? `Bootstrap foundation+planning for project ${projectId}`;
const includeChapterPlan = optionalBoolean(args, "includeChapterPlan", false);

// 1. 创建 CreativeRun（mode: "chapter"）
const run = await createCreativeRun(ctx.repository, {
  projectId, mode: "chapter", payload: { objective, bootstrap: true },
});

// 2. 按链顺序 enqueue，依赖映射为同 run 内 work item id
const taskToWorkId = new Map<string, string>();
const chain = [...BOOTSTRAP_TASK_CHAIN];
if (includeChapterPlan) chain.push("chapter-plan");

for (const taskKey of chain) {
  const deps = taskKey === "chapter-plan"
    ? [taskToWorkId.get("plot-design")].filter(Boolean) as string[]
    : BOOTSTRAP_TASK_DEPENDENCIES[taskKey] ?? [];
  const dependsOn = deps
    .map((dep) => taskToWorkId.get(dep))
    .filter((id): id is string => Boolean(id));
  const work = await enqueueCreativeWork(ctx.repository, run.id, {
    kind: "generation",
    taskKey,
    instruction: `${taskKey} — ${objective}`,
    dependsOn,
  });
  taskToWorkId.set(taskKey, work.id);
}

// 3. 返回 run snapshot
const snapshot = await getRunSnapshot(ctx.repository, run.id);
return { snapshot };
```

注意：`idempotencyKey` 在 tool-definitions.ts 是必填，但 `createCreativeRun` 当前不接受 idempotencyKey 参数（幂等性由 `executeCreativeCommand` 在 command 层处理）。bootstrap 的幂等性在架构阶段暂不强制（TODO P2：未来可在 creative_runs 表加 idempotencyKey 唯一索引）。

**评估闭环（1）**

| # | 工具 | 实现要点 |
|---|------|----------|
| 23 | `novel_closed_loop_run` | 校验 `ctx.model` 存在（不存在抛错）→ `runClosedLoop({repository: ctx.repository, model: ctx.model, projectId, documentId, dryRun, instruction?})`。返回 `{result}` |

#### 1.5 HANDLERS 注册表

```typescript
export const HANDLERS: Record<string, ToolHandler> = {
  novel_run_create: novelRunCreateHandler,
  novel_run_get: novelRunGetHandler,
  // ... 23 个
};
```

命名约定：handler 函数用 camelCase（`novelRunCreateHandler`），key 用 snake_case（与 TOOL_NAMES 一致）。

---

### 文件 2：`src/novel-v2/mcp/index.ts`

#### 2.1 统一导出

```typescript
export type { ToolContext, ToolDefinition, ToolHandler, McpToolResponse } from "./types";
export { TOOL_NAMES, TOOL_DEFINITIONS } from "./tool-definitions";
export type { ToolName } from "./tool-definitions";
export { validateToolArgs, createValidator } from "./validator";
export { HANDLERS } from "./handlers";
```

#### 2.2 `executeTool` 入口

```typescript
import type { McpToolResponse, ToolContext } from "./types";
import { TOOL_DEFINITIONS } from "./tool-definitions";
import { validateToolArgs } from "./validator";
import { HANDLERS } from "./handlers";

/**
 * 执行 MCP 工具。
 *
 * 流程：
 * 1. 校验 args（ajv）
 * 2. 查找 handler
 * 3. try/catch 执行 handler，包装为 McpToolResponse
 *
 * 错误处理：
 * - 校验失败 → isError=true，content 含错误列表
 * - 未知工具 → isError=true
 * - handler 抛错 → isError=true，content 含错误消息
 * - 成功 → isError=false（省略），content 含 JSON.stringify(result)
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<McpToolResponse> {
  // 1. 校验
  const validation = validateToolArgs(toolName, args);
  if (!validation.valid) {
    return {
      content: [{ type: "text", text: `参数校验失败：${validation.errors?.join("; ") ?? ""}` }],
      isError: true,
    };
  }

  // 2. 查找 handler
  const handler = HANDLERS[toolName];
  if (!handler) {
    return {
      content: [{ type: "text", text: `未知工具：${toolName}` }],
      isError: true,
    };
  }

  // 3. 执行
  try {
    const result = await handler(args, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `工具执行失败：${message}` }],
      isError: true,
    };
  }
}

/**
 * 列出所有可用工具定义（供 MCP server 注册）。
 */
export function listTools(): ToolDefinition[] {
  return TOOL_DEFINITIONS;
}
```

---

## 假设与决策

### 决策 1：TODO P2 工具的处理方式
**决策**：handler 内 `throw new Error(...)`，由 `executeTool` 的 try/catch 捕获并包装为 `McpToolResponse` with `isError: true`。
**理由**：与正常 handler 抛错路径一致，统一由 `executeTool` 包装。tool-definitions.ts 已在 description 标注 TODO P2，handler 不重复标注。
**影响工具**：`novel_rule_target_get`、7 个 `novel_rule_*`、`novel_chapter_review`（共 9 个）。

### 决策 2：`novel_artifact_get` 实现程度
**决策**：基础实现，用 `ctx.repository.getRecord("artifacts", artifactId)`。runId 参数可选，仅用于 scope 校验（当前忽略，因 v2 artifacts 表无 run_id 字段）。
**理由**：tool-definitions.ts 虽标 TODO P2，但 `getRecord` 已能返回 artifact 记录，无需抛错。完整版（含 runId scope 校验）留待 TODO P2。

### 决策 3：`novel_receipt_get` 数据源
**决策**：查询 `promotion_receipts` 表（不是 v1 的 creativeToolReceipts）。
**理由**：v2 无 creativeToolReceipts 表（v1 IndexedDB 概念）。v2 幂等性由 `executeCreativeCommand` 的 `command.executed` 事件承担；晋升收据由 `promotion_receipts` 表承担。tool-definitions.ts description 明确"查询 promotion_receipts 表"。

### 决策 4：`novel_action_list` 的 action 派生
**决策**：在 handler 内实现 `deriveActions(snapshot)` 纯函数，因 v2 `getRunSnapshot` 不返回 `nextActions`（v1 `inspectCreativeRun` 返回）。
**理由**：避免修改 creative/snapshot.ts（架构阶段保持 creative 模块稳定）。派生逻辑是 MCP 层职责。

### 决策 5：`novel_bootstrap_run` 的幂等性
**决策**：当前不强制幂等（`createCreativeRun` 不接受 idempotencyKey）。重复调用会创建新 run。
**理由**：v2 `creative_runs` 表无 idempotencyKey 唯一索引。架构阶段暂不扩展 schema。idempotencyKey 参数保留在 schema 中（向前兼容），handler 内暂不使用，添加 TODO P2 注释。

### 决策 6：`novel_project_create` 的 projectId 生成
**决策**：`idempotencyKey` 直接作为 projectId（tool-definitions.ts description 契约）。
**理由**：`ensureProject(idempotencyKey, title)` 的 ON CONFLICT DO UPDATE 保证幂等。重复调用返回同一项目。

### 决策 7：`novel_run_complete` 的终态校验
**决策**：校验所有 workItems.status === "accepted"（v2 终态）+ 聚合所有 reviews 的 issues 无 blocker。
**理由**：v2 work item 终态是 "accepted"（不是 v1 的 "completed"）。tool-definitions.ts description 明确"校验所有 work items 必须为 accepted"。

### 决策 8：`novel_closed_loop_run` 的 model 校验
**决策**：handler 开头校验 `ctx.model` 存在，不存在抛错 `"novel_closed_loop_run 需要 ToolContext.model"`。
**理由**：`runClosedLoop` 必填 model；ToolContext.model 是可选的（其他工具不需要）。

---

## 验证步骤

### 步骤 1：TypeScript 编译验证
```bash
pnpm exec tsc --noEmit
```
预期：无错误。重点检查：
- `handlers.ts` 中 `CreativeCommand` 联合类型的穷尽性
- `index.ts` 导出路径正确
- 无 `noUnusedLocals` / `noUnusedParameters` 违规

### 步骤 2：文件结构验证
```
src/novel-v2/mcp/
├── tool-definitions.ts  (已存在)
├── types.ts             (已存在)
├── validator.ts         (已存在)
├── handlers.ts          (新建)
└── index.ts             (新建)
```

### 步骤 3：导出完整性验证
`index.ts` 应导出：
- 类型：`ToolContext`, `ToolDefinition`, `ToolHandler`, `McpToolResponse`, `ToolName`
- 常量：`TOOL_NAMES`, `TOOL_DEFINITIONS`, `HANDLERS`
- 函数：`validateToolArgs`, `createValidator`, `executeTool`, `listTools`

---

## 实现顺序

1. 创建 `handlers.ts`（先写辅助函数 + 常量，再按分组写 23 个 handler，最后导出 HANDLERS）
2. 创建 `index.ts`（导出 + executeTool + listTools）
3. 运行 `pnpm exec tsc --noEmit` 验证
4. 如有错误，修复后重新验证

## 不在范围内

- 不创建测试文件（任务未要求）
- 不修改 creative/ 或 evaluation/ 模块（架构阶段保持稳定）
- 不实现 craft-rule 模块（TODO P2）
- 不接入 temporal workflow（TODO P2）
- 不修改 tool-definitions.ts / types.ts / validator.ts（已完成）
- 不创建 MCP server 入口（那是 `scripts/novel-mcp-server.mjs` 的职责，本次只做网关核心）
