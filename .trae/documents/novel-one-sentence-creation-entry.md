# 一句话创意创建小说项目入口改造计划

## 背景与目标

用户需求:把创建小说的入口改为 v1 版本的"一句话创意"方式,包括 MCP 的创建入口也要相同。

**v1 设计参考**(`src/features/novel/bootstrap.ts` 已删除,通过探索还原):
- `bootstrapNovelFromCoreIdea(coreIdea)` 函数:入参极简(一个创意字符串),自动派生标题,创建项目(premise=coreIdea),自动触发全书规划
- `provisionalTitle(coreIdea)`:取 coreIdea 第一句前 24 字作为临时标题
- v1 的"一句话创意"只在 Service/UI 层合并,v1 MCP 工具层仍是分离的两个工具

**v2 当前问题**:
- `novel_project_create` 和 `novel_bootstrap_run` 是分离的两个工具,需两次调用
- `novel_project_create` 的 `premise` 可选、`title` 必填,不支持"一句话创意"
- HTTP API 的 POST /v2/projects 完全不接受 premise/genre

## 改造决策(用户已确认)

| 决策点 | 选择 |
|---|---|
| 入口方式 | 修改现有 `novel_project_create`:让 title 可选、premise 必填,新增 autoBootstrap(默认 true) |
| bootstrap 范围 | 完整 10 task + chapter-plan(与 `novel_bootstrap_run` 的 `includeChapterPlan=true` 一致) |

## 当前状态分析

### v2 现状(基于探索)

1. **`novel_project_create` 工具定义**([tool-definitions.ts:423-437](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts#L423-L437)):
   - `title` 必填、`premise` 可选、`genre` 可选、`idempotencyKey` 必填
   - 无 autoBootstrap 参数

2. **`novel_project_create` handler**([handlers.ts:513-533](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L513-L533)):
   - 调用 `ensureProject(projectId, title, metadata)`
   - metadata 包含 premise/genre
   - 不触发 bootstrap

3. **`novel_bootstrap_run` handler**([handlers.ts:550-569](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L550-L569)):
   - 调用 `startNovelBootstrap(repository, temporal, { projectId, objective, idempotencyKey, includeChapterPlan, taskQueue })`
   - 依赖项目已创建

4. **`startNovelBootstrap` 实现**([application/bootstrap.ts:31-122](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/application/bootstrap.ts#L31-L122)):
   - `input.objective` 被拼接到每个 task 的 instruction 末尾
   - `FOUNDATION_TASK_CHAIN` 包含 10 个 task
   - `includeChapterPlan` 默认 true,追加 chapter-plan task
   - 支持 `findBootstrapRunId` 幂等复用

5. **HTTP API**([scripts/novel-v2-api.ts:290-295](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-api.ts#L290-L295)):
   - POST /v2/projects 只接受 projectId 和 title,不接受 premise/genre
   - POST /v2/projects/:id/bootstrap 是分离的 bootstrap 入口

6. **Repository**([postgres-repository.ts:365-375](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts#L365-L375)):
   - `ensureProject(projectId, title, metadata)`:幂等 upsert,metadata 用 `||` 合并

7. **`novel_chapter_generate` 前置检查**([handlers.ts:581-599](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L581-L599)):
   - 要求 foundation artifacts 包含 `REQUIRED_FOUNDATION_TASK_KEYS`(architecture/characters/worldview/plot-design/chapter-plan)
   - 合并入口必须跑完整 10 task + chapter-plan,否则后续章节生成会被拒

## 改造方案

### 改动 1:修改 `novel_project_create` 工具定义

**文件**:[tool-definitions.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts)

**做什么**:
修改 `novel_project_create` 工具定义(第 423-437 行):
- `title` 改为可选(自动派生)
- `premise` 改为必填(一句话创意)
- `genre` 保持可选
- 新增 `autoBootstrap`(boolean,默认 true):是否自动启动全书规划
- 新增 `includeChapterPlan`(boolean,默认 true):bootstrap 是否包含章节计划(仅 autoBootstrap=true 时生效)
- 新增 `objective`(string,可选):bootstrap 目标,默认从 premise 派生

**新 inputSchema**:
```typescript
{
  name: "novel_project_create",
  description: "一句话创意创建小说项目。premise 作为创意核心,自动派生标题,默认自动启动全书规划(10 个 foundation task + chapter-plan)。autoBootstrap=false 时仅创建项目不启动规划。",
  inputSchema: {
    type: "object",
    properties: {
      premise: { type: "string", minLength: 1, description: "一句话创意/故事梗概(必填,作为创作核心)" },
      title: { type: "string", description: "可选,项目标题。未提供则从 premise 自动派生(取第一句前 24 字)" },
      genre: { type: "string", description: "可选,题材标签(如 玄幻/都市/言情/科幻/悬疑),用于 skill 题材匹配" },
      autoBootstrap: { type: "boolean", description: "是否自动启动全书规划,默认 true" },
      includeChapterPlan: { type: "boolean", description: "bootstrap 是否包含章节计划,默认 true(仅 autoBootstrap=true 时生效)" },
      objective: { type: "string", description: "可选,bootstrap 目标。未提供则用 premise 作为 objective" },
      idempotencyKey: { type: "string", minLength: 1 },
    },
    required: ["premise", "idempotencyKey"],
    additionalProperties: false,
  },
}
```

**为什么**:这是"一句话创意"入口的核心。premise 必填确保创意核心存在,title 可选让用户只需传一句话。autoBootstrap 默认 true 实现创建+规划一站式。

---

### 改动 2:修改 `novel_project_create` handler

**文件**:[handlers.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts)

**做什么**:
修改 `novel_project_create` handler(第 513-533 行),实现"一句话创意"流程:

1. **参数解析**:
   - `premise`(必填)、`title`(可选)、`genre`(可选)、`autoBootstrap`(默认 true)、`includeChapterPlan`(默认 true)、`objective`(可选)、`idempotencyKey`(必填)

2. **自动派生标题**(参考 v1 `provisionalTitle`):
   ```typescript
   function provisionalTitle(premise: string): string {
     const firstClause = premise.trim().split(/[，。！？!?\n]/, 1)[0]?.trim() ?? "";
     return firstClause.slice(0, 24) || "未命名小说";
   }
   ```
   若 `title` 未提供,用 `provisionalTitle(premise)` 作为标题

3. **创建项目**:
   - `projectId = idempotencyKey`(与现有行为一致)
   - `metadata = { premise, ...(genre ? { genre } : {}) }`
   - 调用 `ensureProject(projectId, title, metadata)`

4. **自动启动 bootstrap**(若 `autoBootstrap` 不为 false):
   - 校验 `ctx.temporal` 存在
   - `objective = asString(args.objective) || premise`(用 premise 作为 objective)
   - 调用 `startNovelBootstrap(ctx.repository, ctx.temporal, { projectId, objective, idempotencyKey, includeChapterPlan, taskQueue: ctx.taskQueue })`
   - 返回结果包含 `project` + `bootstrapRun`

5. **返回值**:
   ```typescript
   return {
     project,
     bootstrapRun: autoBootstrap ? bootstrapResult : undefined,
   };
   ```

**为什么**:handler 是实现"一句话创意"流程的核心。自动派生标题让用户只需传 premise,自动 bootstrap 实现一站式创建+规划。

**怎么做**:
- 把 `provisionalTitle` 函数放在 handler 文件顶部 helper 区(参考 `asString`/`asBoolean` 的位置)
- 引入 `startNovelBootstrap` from `../application/bootstrap`(若未引入)
- 参考 `novel_bootstrap_run` handler(第 550-569 行)的 bootstrap 调用方式

---

### 改动 3:同步修改 HTTP API 入口

**文件**:[scripts/novel-v2-api.ts](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-api.ts)

**做什么**:
修改 POST /v2/projects(第 290-295 行):

1. **接受新参数**:`premise`(必填)、`title`(可选)、`genre`(可选)、`autoBootstrap`(默认 true)、`includeChapterPlan`(默认 true)、`objective`(可选)、`idempotencyKey`(必填)

2. **自动派生标题**:与 handler 一致,未提供 title 时用 `provisionalTitle(premise)`

3. **创建项目**:`ensureProject(projectId, title, metadata)`,metadata 含 premise/genre

4. **自动启动 bootstrap**(若 autoBootstrap 不为 false):
   - 调用 `startNovelBootstrap(repository, temporal, { projectId, objective: objective || premise, idempotencyKey, includeChapterPlan, taskQueue })`
   - 返回 201 状态码(新项目)或 200(幂等复用)

5. **返回值**:包含 project + bootstrapRun

**为什么**:HTTP API 与 MCP 工具应保持入口一致。当前 HTTP API 不接受 premise/genre,是历史遗留,改造后与 MCP 对齐。

**怎么做**:
- 在 `scripts/novel-v2-api.ts` 顶部引入 `startNovelBootstrap`(若未引入)
- 参考 POST /v2/projects/:id/bootstrap(第 350-365 行)的 bootstrap 调用方式
- `provisionalTitle` 函数可在 api.ts 内部定义,或从 common helper 引入(避免重复)

---

### 改动 4:抽取 `provisionalTitle` 到共享 helper

**文件**:新增 `src/novel-v2/application/provisional-title.ts`(或放入现有 `application/bootstrap.ts`)

**做什么**:
```typescript
/**
 * 从一句话创意派生临时标题。
 *
 * 设计依据:v1 bootstrapNovelFromCoreIdea 的 provisionalTitle 函数——
 * 取 coreIdea 第一句前 24 字作为临时标题。
 * project-positioning task 会润色创意生成正式书名,此函数只提供初始标题。
 *
 * AGENTS.md 合规:不内置题材/角色 fixture,只做通用字符串处理。
 */
export function provisionalTitle(premise: string): string {
  const firstClause = premise.trim().split(/[，。！？!?\n]/, 1)[0]?.trim() ?? "";
  return firstClause.slice(0, 24) || "未命名小说";
}
```

**为什么**:handler 和 HTTP API 都需要此函数,抽取到共享 helper 避免重复。放在 `application/` 目录与 `bootstrap.ts` 同级,符合现有架构。

**注意**:若用户倾向不新增文件,也可直接放入 `application/bootstrap.ts` 导出。本计划选择新增独立文件,职责单一。

---

### 改动 5:更新 `novel_bootstrap_run` 工具描述

**文件**:[tool-definitions.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts)

**做什么**:
修改 `novel_bootstrap_run` 工具描述(第 464-478 行),description 加入提示:
"对已存在的项目启动全书规划。若需一站式创建项目+规划,请使用 novel_project_create(带 autoBootstrap=true,默认)。"

**为什么**:`novel_bootstrap_run` 仍保留(用于对已存在项目重新启动规划),但需要引导用户优先使用 `novel_project_create` 的一站式入口。避免用户困惑两个工具的关系。

---

### 改动 6:更新文档

**文件**:[docs/novel-mcp.md](file:///f:/GitHubProject/Ymcp/web/docs/novel-mcp.md)

**做什么**:
更新 `novel_project_create` 工具说明:
- 一句话创意创建项目(premise 必填,title 可选自动派生)
- 默认自动启动全书规划(autoBootstrap=true)
- 与 `novel_bootstrap_run` 的关系:`novel_project_create` 是一站式入口,`novel_bootstrap_run` 用于对已存在项目重新启动规划

**为什么**:保持文档与代码一致,引导用户使用新入口。

## 假设与决策

1. **不删除 `novel_bootstrap_run`**:用户可能对已存在项目重新启动规划(如规划失败后重试),`novel_bootstrap_run` 仍有价值。只修改 `novel_project_create` 成为一站式入口,保留 `novel_bootstrap_run` 作为补充。

2. **`autoBootstrap` 默认 true**:用户需求是"一句话创意创建项目",默认自动启动规划符合预期。若用户只想创建项目不规划,可显式传 `autoBootstrap=false`。

3. **`includeChapterPlan` 默认 true**:与 `novel_bootstrap_run` 的默认值一致(改动 2 的前序改造已将默认值改为 true),且 `chapter-plan` 是 `REQUIRED_FOUNDATION_TASK_KEYS` 的必填项,默认生成避免后续 `novel_chapter_generate` 被拒。

4. **premise 作为 objective**:`startNovelBootstrap` 的 `objective` 会被拼接到每个 task instruction。premise(一句话创意)作为 objective 符合语义——让每个 foundation task 都知道创意核心。用户也可显式传 `objective` 覆盖。

5. **幂等性**:`idempotencyKey` 同时作为 projectId 和 bootstrapKey。`ensureProject` 是 upsert,`startNovelBootstrap` 内部有 `findBootstrapRunId` 幂等复用。重复调用同一 idempotencyKey 不会创建多个项目或多次 bootstrap。

6. **metadata 合并问题**:`ensureProject` 用 `metadata=novel_projects.metadata || EXCLUDED.metadata` 合并。若重复调用传不同 premise,会累积。本方案不修改此行为(幂等场景下 premise 应保持一致),但 handler 内会显式传完整 metadata,确保首次创建时 premise 正确写入。

7. **HTTP API 破坏性变更**:POST /v2/projects 当前只接受 projectId/title,改造后接受 premise/idempotencyKey 等。这是破坏性变更,但 AGENTS.md 架构阶段允许。旧调用方(若有)需更新。

8. **v1 的 project-positioning 润色创意**:v1 的 `bootstrapNovelFromCoreIdea` 依赖 project-positioning stage 润色创意生成正式书名。v2 的 `startNovelBootstrap` 也包含 project-positioning task(FOUNDATION_TASK_CHAIN 第 1 个),会润色创意。但 v2 的 project-positioning 产出存为 artifact,不会自动回写 novel_projects.title。本方案不实现"自动回写正式书名"——保持临时标题,用户可后续手动改 title。若需自动回写,是后续优化。

## 验证步骤

### 单元测试

1. **`provisionalTitle` 函数**:
   - 测试用例:premise="少年得到神秘黑塔,踏上修仙之路" → 标题="少年得到神秘黑塔"
   - 测试用例:premise="这是一个非常非常长的创意字符串,超过 24 字限制,需要截断" → 标题="这是一个非常非常长的创意字符串,超"(24 字)
   - 测试用例:premise="" → 标题="未命名小说"
   - 测试用例:premise="第一句。第二句" → 标题="第一句"

2. **`novel_project_create` handler(仅创建项目)**:
   - 测试用例:传 premise + idempotencyKey + autoBootstrap=false,验证创建项目但不启动 bootstrap
   - 测试用例:传 premise 无 title,验证项目标题为 provisionalTitle(premise)
   - 测试用例:传 premise + title,验证项目标题为传入的 title

3. **`novel_project_create` handler(一站式)**:
   - 测试用例:传 premise + idempotencyKey(默认 autoBootstrap=true),验证创建项目并启动 bootstrap
   - 测试用例:重复调用同一 idempotencyKey,验证幂等复用(不重复创建/启动)

### 集成测试

4. **端到端"一句话创意"流程**:
   - Step 1:调 `novel_project_create`(premise="少年得到神秘黑塔,踏上修仙之路",idempotencyKey="test-1")
   - Step 2:验证返回 project.title 为"少年得到神秘黑塔"
   - Step 3:验证返回 bootstrapRun 包含 CreativeRun 信息
   - Step 4:等待 bootstrap 完成,查询 foundation artifacts,验证包含 11 个 task(project-positioning/architecture/characters/relations/worldview/plot-threads/foreshadowing/timeline/story-control/plot-design/chapter-plan)
   - Step 5:调 `novel_chapter_generate`(projectId="test-1"),验证前置检查通过

5. **HTTP API 一致性**:
   - Step 1:POST /v2/projects(premise="...",idempotencyKey="test-2")
   - Step 2:验证返回 project + bootstrapRun
   - Step 3:与 MCP 工具调用结果结构一致

### 回归验证

6. **`novel_bootstrap_run` 不受影响**:
   - 对已存在项目调 `novel_bootstrap_run`,验证仍能正常启动规划

7. **`autoBootstrap=false` 场景**:
   - 调 `novel_project_create`(autoBootstrap=false),验证只创建项目不启动 bootstrap
   - 后续手动调 `novel_bootstrap_run`,验证可正常启动

## 改动文件清单

| 文件 | 改动类型 | 改动内容 |
|---|---|---|
| [tool-definitions.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts) | 修改工具定义 | `novel_project_create`:title 可选、premise 必填、新增 autoBootstrap/includeChapterPlan/objective;`novel_bootstrap_run` 描述更新 |
| [handlers.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts) | 修改 handler | `novel_project_create`:自动派生标题+创建项目+自动 bootstrap |
| [scripts/novel-v2-api.ts](file:///f:/GitHubProject/Ymcp/web/scripts/novel-v2-api.ts) | 修改 HTTP API | POST /v2/projects:接受 premise+autoBootstrap,一站式创建+规划 |
| `src/novel-v2/application/provisional-title.ts`(新增) | 新增 helper | `provisionalTitle(premise)` 函数 |
| [docs/novel-mcp.md](file:///f:/GitHubProject/Ymcp/web/docs/novel-mcp.md) | 更新文档 | `novel_project_create` 工具说明更新 |

## 实施顺序建议

1. **改动 4**(helper 层):新增 `provisionalTitle` 函数,无副作用,可独立验证
2. **改动 1 + 改动 2**(MCP 工具层):修改工具定义和 handler,核心改动
3. **改动 3**(HTTP API 层):同步修改,与 MCP 对齐
4. **改动 5**(工具描述):更新 `novel_bootstrap_run` 描述
5. **改动 6**(文档):更新 docs/novel-mcp.md
6. **构建验证**:跑 tsc 确保无类型错误
