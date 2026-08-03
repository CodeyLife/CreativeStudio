# MCP 工具扩展：Workflow 状态查询 + 返回值修正 + Catalog 精简

## Context

Agent 在推进章节生成时，遇到一个效率瓶颈：`novel_chapter_generate` 返回 `workflowId` 和 `runId`，但没有任何 MCP 工具能用这些 ID 查询生成状态。唯一路径是调用 `novel_catalog_get`（返回 32KB+ 全量数据），手动解析嵌套 JSON 提取 `latestRuns`。

根因是 3 个架构缺口：
1. **`novel_run_get` 查 `creative_runs` 表，但章节生成写入 `workflow_runs` 表**——两张表不相交，永远查不到
2. **`novel_chapter_generate` 返回的 `runId` 是 Temporal 内部 ID**——无 MCP 工具接受它
3. **`novel_catalog_get` 无精简参数**——每次返回全量 project + documents + creativeRuns

repository 层已有 `getWorkflowRunByTemporalId()` 和 `listProjectRuns()` 方法，只是未通过 MCP 暴露。

## 修改文件清单

| # | 文件 | 修改 |
|---|------|------|
| 1 | `src/novel-v2/postgres-repository.ts` | `listProjectRuns` 加可选 `workflowType` 参数 |
| 2 | `src/novel-v2/mcp/tool-definitions.ts` | TOOL_NAMES + TOOL_DEFINITIONS 加 2 个工具；catalog inputSchema 加 `compact`/`documentStatus` |
| 3 | `src/novel-v2/mcp/handlers.ts` | 加 2 个 handler；改 `novel_chapter_generate`/`novel_chapter_review` 返回值；改 `novel_catalog_get` handler；注册 TOOL_HANDLERS |
| 4 | `src/novel-v2/mcp/tool-metadata.ts` | SHORT_LABELS + TOOL_GROUPS 加 2 项 |
| 5 | Trae 侧 `tools/novel_workflow_get.json` | 新建 |
| 6 | Trae 侧 `tools/novel_workflow_list.json` | 新建 |
| 7 | Trae 侧 `tools/novel_catalog_get.json` | 加 compact/documentStatus 参数 |
| 8 | Trae 侧 `tools/novel_chapter_generate.json` | description 加返回值说明 |

> `validator.ts`、`index.ts`、`types.ts` **无需修改**——validator 自动从 TOOL_DEFINITIONS 编译 schema；index.ts 的启动期契约校验自动覆盖新工具。

## 步骤 1：repository 层 — 扩展 listProjectRuns

文件：`src/novel-v2/postgres-repository.ts` (L1635)

现有签名 `listProjectRuns(projectId, limit=20)` 不支持 workflowType 过滤。扩展为可选第三参数：

```typescript
async listProjectRuns(
  projectId: string,
  limit = 20,
  workflowType?: string,
): Promise<WorkflowRunRecord[]> {
  const sql = workflowType
    ? "SELECT ... FROM workflow_runs WHERE project_id=$1 AND workflow_type=$2 ORDER BY updated_at DESC LIMIT $3"
    : "SELECT ... FROM workflow_runs WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2";
  const params = workflowType ? [projectId, workflowType, limit] : [projectId, limit];
  // ...
}
```

向后兼容：`getProjectDetail` 调用 `listProjectRuns(projectId, 5)` 不传第三参数，行为不变。

## 步骤 2：tool-definitions.ts — 新增 2 工具 + 修改 catalog schema

### 2a. TOOL_NAMES 数组

在 Catalog 组后加新分组：
```typescript
// Workflow 查询（2，新增）
"novel_workflow_get",
"novel_workflow_list",
```

### 2b. TOOL_DEFINITIONS — novel_workflow_get

```typescript
{
  name: "novel_workflow_get",
  description: "按 workflowId 查询单个 workflow run 状态（章节生成/章节审校/故事弧规划）。返回 workflow_runs 记录 + Temporal 运行时状态。workflowId 来自 novel_chapter_generate / novel_chapter_review 的返回值。",
  inputSchema: {
    type: "object",
    properties: {
      workflowId: { type: "string", minLength: 1 }
    },
    required: ["workflowId"],
    additionalProperties: false,
  },
},
```

### 2c. TOOL_DEFINITIONS — novel_workflow_list

```typescript
{
  name: "novel_workflow_list",
  description: "按 projectId 列出最新 workflow runs，按 updatedAt DESC 排序。支持 workflowType 过滤。轻量替代 novel_catalog_get 查章节生成历史。",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      workflowType: { type: "string", description: "可选。常见值: novel-intent(章节生成)、chapter-review(章节审校)、story-arc-planning(故事弧规划)" }
    },
    required: ["projectId"],
    additionalProperties: false,
  },
},
```

### 2d. 修改 novel_catalog_get 的 inputSchema

在现有 `projectId` 基础上加两个可选参数：
- `compact: boolean` — true 时省略 documents 与 creativeRuns，只返回项目元数据 + latestRuns
- `documentStatus: string[]` — 按 status 过滤 documents（仅 compact=false 时生效）

## 步骤 3：handlers.ts — 新增 handler + 修改 3 个现有 handler

### 3a. novel_workflow_get handler

```typescript
const novel_workflow_get: ToolHandler = async (args, ctx) => {
  const workflowId = asString(args.workflowId);
  if (!workflowId) throw new Error("workflowId 必填");
  const run = await ctx.repository.getWorkflowRunByTemporalId(workflowId);
  if (!run) throw new Error(`WorkflowRun 不存在：${workflowId}`);
  // 附加 Temporal 运行时状态（真实执行状态，DB status 可能滞后）
  let temporal: { status: string; closeTime?: string } | undefined;
  if (ctx.temporal) {
    try {
      const handle = ctx.temporal.workflow.getHandle(workflowId);
      const info = await handle.describe();
      temporal = { status: info.status.name, closeTime: info.closeTime?.toISOString() };
    } catch { /* Temporal 不可达或 workflow 不存在，留空 */ }
  }
  return { run, temporal };
};
```

### 3b. novel_workflow_list handler

```typescript
const novel_workflow_list: ToolHandler = async (args, ctx) => {
  const projectId = asString(args.projectId);
  if (!projectId) throw new Error("projectId 必填");
  const limit = asNumber(args.limit) ?? 20;
  const workflowType = asString(args.workflowType) || undefined;
  const runs = await ctx.repository.listProjectRuns(projectId, limit, workflowType);
  return { runs };
};
```

### 3c. 修改 novel_chapter_generate 返回值 (L746-752)

```typescript
// 修正前
return { workflowId, runId: handle.firstExecutionRunId, documentId, intentId, status: "accepted" };
// 修正后
return {
  workflowId,
  temporalRunId: handle.firstExecutionRunId,  // Temporal 内部 ID，仅供日志
  documentId,
  intentId,
  status: "accepted",
  nextAction: "调用 novel_workflow_get({ workflowId }) 查询生成进度",
};
```

### 3d. 修改 novel_chapter_review 返回值 (L778)

同样将 `runId` 改为 `temporalRunId` + 加 `nextAction`。

### 3e. 修改 novel_catalog_get handler (L413-427)

加 `compact` 和 `documentStatus` 参数处理逻辑：
- `compact=true`：只调 `getProjectDetail`，清空 documents，不查 creativeRuns
- `documentStatus`：在 handler 层过滤 documents

### 3f. TOOL_HANDLERS 注册

在 TOOL_HANDLERS 对象中加：
```typescript
novel_workflow_get,
novel_workflow_list,
```

> **关键**：步骤 2（TOOL_NAMES）和步骤 3f（TOOL_HANDLERS）必须同步完成，否则 index.ts 的启动期契约校验会崩溃。

## 步骤 4：tool-metadata.ts

- SHORT_LABELS 加：`novel_workflow_get: "查询 Workflow 状态"`, `novel_workflow_list: "列出 Workflow Runs"`
- TOOL_GROUPS 加：`{ key: "workflow", title: "Workflow 查询", tools: ["novel_workflow_get", "novel_workflow_list"] }`

## 步骤 5：Trae 侧 JSON 文件

在 `c:\Users\admin\.trae-cn\mcps\s_web-226fa94e\solo_agent\mcp_novel-v2\tools\` 目录下：
- 新建 `novel_workflow_get.json`（name/description/arguments 与 tool-definitions 对齐）
- 新建 `novel_workflow_list.json`
- 修改 `novel_catalog_get.json` 加 compact/documentStatus
- 修改 `novel_chapter_generate.json` description 加返回值说明

## 验证

1. **启动期契约校验**：`node --import tsx scripts/novel-v2-mcp-server.mjs`，期望 `[novel-v2-mcp] ready, 28 tools loaded`（26 + 2）
2. **tools/list**：确认返回 28 个工具，含 `novel_workflow_get` / `novel_workflow_list`
3. **缺口 1 闭环**：`novel_chapter_generate` → 取 `workflowId` → `novel_workflow_get({ workflowId })` 返回 run + temporal 状态
4. **缺口 2**：`novel_chapter_generate` 返回值无 `runId`，有 `temporalRunId` + `nextAction`
5. **缺口 3**：`novel_catalog_get({ projectId, compact: true })` 响应 < 3KB；`novel_catalog_get({ projectId, documentStatus: ["planned"] })` 只返回 planned 章节
6. **回归**：`novel_catalog_get({ projectId })` 无新参数时行为与原来一致
