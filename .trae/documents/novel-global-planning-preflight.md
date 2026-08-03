# 小说创作全局规划前置改造计划

## 背景与根因

用户反馈:新小说开始创作时,应先进行严谨完整的全书规划,再开始章节书写。当前 v2 重构后效果不好,章节生成没有消费全书规划产出。

**根因分析**(遵循 AGENTS.md「root-cause analysis」契约):

| 维度 | 说明 |
|---|---|
| 症状 | 章节生成不基于全书规划,效果不好 |
| failingLayer | `novel_bootstrap_run` 与 `novelIntentWorkflow` 之间的衔接层 |
| underlyingMechanism | v2 重构后存在三重断裂:(1) MCP 工具层无章节生成入口;(2) foundation artifacts 未被 `compileBlueprint` 消费;(3) 无全书规划前置检查 |
| affectedInputClass | 所有新项目的章节生成路径 |
| 边界 | 不需要复刻 v1 的 12 stage handler 链或人工审批门禁,只需要在 v2 架构内实现"规划产出→章节消费"的数据流衔接 |

## 当前状态分析

### v2 现状(基于 [workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)、[handlers.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts)、[cognition.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts) 探索)

1. **全书规划入口存在但产出孤立**:`novel_bootstrap_run` ([handlers.ts:547-627](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L547-L627)) 会 enqueue 10 个 foundation work items,产出 `kind="foundation"` 的 artifacts 存入 `artifacts` 表。但这些 artifacts **从未被章节生成流程读取**。

2. **章节生成入口缺失**:MCP 工具层 23 个工具([tool-definitions.ts:92-122](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts#L92-L122))中**没有 `novel_chapter_generate`**,只能通过 HTTP `POST /v2/intents` 触发 `novelIntentWorkflow`。外部 LLM 通过 MCP 无法直接生成章节。

3. **`compileBlueprint` 不读 foundation**:[activities.ts:189-194](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts#L189-L194) 的 `compileBlueprint` activity 签名只接收 `intent/plan/memory/skills/snapshot`,**没有 foundation artifacts 参数**。[cognition.ts:219-237](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts#L219-L237) 的 `compileExecutionBlueprint` 同样不接收规划产出。

4. **章节 draft prompt 无全书规划上下文**:[chapter-draft.ts:30-57](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-draft.ts#L30-L57) 的 `DraftPromptInput` 只有 `intent/blueprint/memory/skills/payoffStats/povCharacterId`,**没有 foundation context**。prompt 里没有架构/人物/世界观/章节计划等全书规划信息。

5. **`novelIntentWorkflow` 无前置检查**:[workflows.ts:148-156](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts#L148-L156) 的 `loadProjectSnapshot` → `createPreflight` → `compileBlueprint` 链路只检查 `taskClass` 是否为 planning/foundation,**不检查项目是否已有 foundation artifacts**。

### v1 设计参考(已删,通过文档还原)

v1 通过 14 个 taskKey(11 全书规划 + 3 章节级)+ 12 stage handler 链 + `blueprint-approval` 审批门 + `findReusableChapterBlueprint` 衔接机制,实现了"先规划再写章节"的强约束。本计划不照搬 v1 代码,只在 v2 架构内复现等价约束。

## 改造决策(用户已确认)

| 决策点 | 选择 |
|---|---|
| 章节生成入口 | 新增 `novel_chapter_generate` MCP 工具 |
| 全书规划约束 | 强制 foundation artifacts 存在(必填 taskKey 清单) |
| 规划任务清单 | 保持现有 10 个 taskKey,只补衔接(不增加 story-bible/scene-design) |
| 审批门禁 | 不引入人工审批门,只做 artifacts 存在性硬检查 |

## 改造方案

### 改动 1:新增 `novel_chapter_generate` MCP 工具入口

**文件**:[tool-definitions.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts)

**做什么**:
- 在 `TOOL_NAMES` 常量(第 92-122 行)的"一键流程"分组下新增 `"novel_chapter_generate"`,工具总数从 23 → 24
- 在 `TOOL_DEFINITIONS` 数组(第 463-493 行附近)新增工具定义,inputSchema:
  - `projectId`(必填)
  - `documentId`(可选,无则自动创建新 document)
  - `chapterTitle`(可选,自动创建 document 时使用)
  - `instruction`(可选,章节生成指令)
  - `idempotencyKey`(必填)

**为什么**:补齐 v2 MCP 工具层的章节生成入口缺口,让外部 LLM 能通过 MCP 触发章节生成,而不是绕道 HTTP API。

**怎么做**:参考 [novel_chapter_review 工具定义](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts#L479-L493) 的结构,description 写"启动章节生成工作流(先校验 foundation artifacts 存在,再启动 novelIntentWorkflow 走完整 5-reviewer 闭环)"。

---

### 改动 2:实现 `novel_chapter_generate` handler

**文件**:[handlers.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts)

**做什么**:
在 `novel_chapter_review` handler(第 629 行附近)之前新增 `novel_chapter_generate` handler,逻辑:

1. **参数解析**:`projectId` / `documentId`(可选) / `chapterTitle`(可选) / `instruction`(可选) / `idempotencyKey`
2. **前置检查 1**:查询 `artifacts WHERE project_id=$1 AND kind='foundation'`,获取所有 foundation artifacts 的 `taskKey` 集合
3. **前置检查 2**:校验必填 taskKey 清单(见改动 3 的 `REQUIRED_FOUNDATION_TASK_KEYS`)都已有 artifact,缺失则抛 `ApplicationFailure.nonRetryable("全书规划未完成,缺失 taskKey: ...")`
4. **document 处理**:
   - 若 `documentId` 未提供:查询 `manuscript_documents` 表的最大 `narrative_order`,新建 document(`narrative_order = max + 1`),`chapterTitle` 默认为"第 N 章"
   - 若 `documentId` 已提供:校验 document 存在且 `status` 非 `final`
5. **创建 NovelIntent**:调 `repository.createIntent` 创建 `target.kind="chapter"` + `target.id=documentId` 的 intent,`objective` 用 `instruction` 或默认"生成章节正文"
6. **落库 WorkflowRun**:调 `repository.putWorkflowRun`,workflowType=`"novel-intent"`,与 `novel_chapter_review` handler(第 662 行注释)对齐
7. **启动 Temporal workflow**:`ctx.temporal.workflow.start("novelIntentWorkflow", { args: [intent], taskQueue, workflowId })`

**为什么**:这是 v1 `startChapterWorkflow` 的 v2 等价物,但在 handler 层加入 foundation 前置检查,实现"先规划再写章节"的强约束。

**怎么做**:参考 [novel_chapter_review handler](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L629-L666) 的结构(putWorkflowRun + workflow.start 模式)。需引入 `ApplicationFailure` from `@temporalium/common`(若已用于其他 handler 则复用)。

---

### 改动 3:定义 `REQUIRED_FOUNDATION_TASK_KEYS` 常量

**文件**:[protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts)

**做什么**:
新增导出常量:

```typescript
/**
 * 全书规划必填 taskKey 清单。
 *
 * 设计依据:AGENTS.md「root-cause analysis」——
 * v2 重构后 novel_bootstrap_run 产出 foundation artifacts 但未被章节生成消费,
 * 导致章节生成不基于全书规划。此清单是章节生成的前置硬约束:
 * 缺失任何一项, novel_chapter_generate handler 拒绝启动 novelIntentWorkflow。
 *
 * 选择这 5 个 taskKey 的理由(对应 v1 全书规划的核心维度):
 * - architecture:叙事结构/章节布局,章节生成必须知道章节在全书中的位置
 * - characters:人物档案/动机,章节生成必须知道人物声部与动机
 * - worldview:世界观规则,章节生成必须遵守设定约束
 * - plot-design:plot 设计与章节规划,章节生成必须知道本章在主线/支线中的角色
 * - chapter-plan:章节标题与摘要,章节生成的直接蓝图
 *
 * 其余 5 个 taskKey(project-positioning/relations/plot-threads/foreshadowing/timeline/story-control)
 * 不在必填清单:它们是重要参考但非阻塞——例如 foreshadowing 可能在章节生成过程中逐步建立,
 * timeline 可由 plot-design 推导。仍会作为上下文注入(见改动 5),只是不阻塞章节生成启动。
 */
export const REQUIRED_FOUNDATION_TASK_KEYS = [
  "architecture",
  "characters",
  "worldview",
  "plot-design",
  "chapter-plan",
] as const;
```

**为什么**:把"必填清单"放在 protocol.ts 而非 handler 内,让 handler 和未来的 workflow 内前置检查(改动 6)共用同一份真相源。

---

### 改动 4:repository 新增 `listFoundationArtifacts` 方法

**文件**:[postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts)

**做什么**:
在 `NovelPostgresRepository` 类中新增方法:

```typescript
/**
 * 列出项目下所有 foundation artifacts,按 taskKey 分组。
 *
 * 设计依据:改动 5/6 需要把全书规划产出注入到章节生成的 blueprint/prompt,
 * 此方法是数据访问层入口。查询 artifacts 表 kind='foundation' 的记录,
 * 返回完整 Artifact[] (含 structuredData),由调用方按 taskKey 分组。
 *
 * 性能:单项目 foundation artifacts 通常 ≤ 11 条(对应 bootstrap_run 的 taskChain),
 * 不需要分页。ORDER BY created_at ASC 保证依赖链顺序(后生成的覆盖先生成的)。
 */
async listFoundationArtifacts(projectId: string): Promise<Artifact[]> {
  const result = await this.pool.query<ArtifactRow>(`
    SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
    FROM artifacts
    WHERE project_id=$1 AND kind='foundation'
    ORDER BY created_at ASC
  `, [projectId]);
  return result.rows.map(artifactFromRow);
}
```

**为什么**:当前 repository 没有按 kind 过滤 artifacts 的方法([postgres-repository.ts:578-589](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts#L578-L589) 的 `listRunArtifacts` 是按 workflowId 过滤)。改动 5/6 需要按 kind+projectId 查询,需要新方法。

---

### 改动 5:`compileBlueprint` activity 消费 foundation artifacts

**文件**:[activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts)

**做什么**:
修改 `compileBlueprint` activity(第 189-194 行):

1. **新增参数**:`foundationArtifacts: Artifact[]`(由 workflow 调用方传入,见改动 6)
2. **传给 `compileExecutionBlueprint`**:把 `foundationArtifacts` 透传到 [cognition.ts:219](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts#L219) 的纯函数
3. **存入 ExecutionBlueprint**:在 `ExecutionBlueprint` 接口([protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts))新增可选字段 `foundationArtifactIds?: string[]`,记录消费了哪些规划产出(供审计/learning 闭环感知上下文质量)

**为什么**:这是衔接全书规划与章节生成的核心数据流改动。foundation artifacts 的 `structuredData`(架构/人物/世界观/章节计划)需要进入 blueprint,再由 draft activity 注入 prompt。

---

### 改动 6:`compileExecutionBlueprint` 纯函数接收 foundation artifacts

**文件**:[cognition.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts)

**做什么**:
修改 `compileExecutionBlueprint`(第 219-237 行)签名:

```typescript
export function compileExecutionBlueprint(
  intent: NovelIntent,
  plan: PreflightPlan,
  memory: MemoryBundle,
  skills: SkillBundle,
  snapshot: PreflightProjectSnapshot,
  context?: ContextManifest,
  foundationArtifacts?: Artifact[],  // 新增
  now = Date.now(),
): ExecutionBlueprint {
  // ... 现有逻辑不变 ...
  const foundationArtifactIds = foundationArtifacts?.map((a) => a.id) ?? [];
  const blueprint: ExecutionBlueprint = {
    // ... 现有字段 ...
    foundationArtifactIds: foundationArtifactIds.length ? foundationArtifactIds : undefined,
  };
  // ...
}
```

**为什么**:纯函数层接收 foundation artifacts,让 blueprint 持有引用;具体如何注入 prompt 由改动 7 的 draft activity 完成。保持纯函数与副作用分离的现有架构。

---

### 改动 7:draft activity 注入全书规划上下文到 prompt

**文件**:[activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts) + [chapter-draft.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-draft.ts)

**做什么**:

**7.1 修改 `draft` activity(第 195-215 行)**:
- 新增参数 `foundationArtifacts: Artifact[]`(由 workflow 传入,见改动 8)
- 透传给 `buildChapterDraftPrompt`

**7.2 修改 `DraftPromptInput`([chapter-draft.ts:30-57](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-draft.ts#L30-L57))**:
- 新增可选字段 `foundationArtifacts?: Artifact[]`

**7.3 修改 `buildChapterDraftPrompt` 函数体**:
- 在 prompt 中新增"全书规划上下文"段落,从 `foundationArtifacts` 的 `structuredData` 提取关键信息:
  - `architecture`:叙事结构、章节布局、视角策略
  - `characters`:主要人物档案、动机、成长弧
  - `worldview`:世界观规则、设定约束
  - `plot-design`:plot 设计、本章在主线中的位置
  - `chapter-plan`:本章标题与摘要(直接蓝图)
  - 其余 taskKey(relations/plot-threads/foreshadowing/timeline/story-control)作为参考上下文
- 段落位置:在现有"MemoryBundle"段之后、"Blueprint"段之前(让 writer 先理解全书规划,再看本章蓝图)

**为什么**:这是用户反馈的核心——让章节生成"基于全书规划"。没有这一步,前面所有改动只是数据流通,LLM 仍看不到规划产出。

**怎么做**:参考现有 `buildBlueprintMarkdown` 函数([chapter-draft.ts:70](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-draft.ts#L70))的模式,新增 `buildFoundationContextMarkdown(foundationArtifacts: Artifact[]): string` 辅助函数。从 `artifact.structuredData` 提取字段时做防御性解构(`structuredData?.architecture ?? "未提供"`),避免 schema 演进导致 prompt 崩溃。

---

### 改动 8:`novelIntentWorkflow` 加载并传递 foundation artifacts

**文件**:[workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)

**做什么**:
修改 `novelIntentWorkflow`(第 122-462 行):

1. **新增 activity 调用**:在 `compileBlueprint`(第 152 行)之前,新增 `activities.listFoundationArtifacts({ projectId: intent.projectId })`
2. **前置检查**:若 `plan.taskClass === "drafting"`,校验 foundation artifacts 包含 `REQUIRED_FOUNDATION_TASK_KEYS` 的所有 taskKey(从 `artifact.taskId` 提取 taskKey,格式为 `${workItemId}:foundation`,需解析);缺失则抛 `ApplicationFailure.nonRetryable`
3. **传递给 compileBlueprint**:把 `foundationArtifacts` 透传给改动 5 后的 `compileBlueprint` activity
4. **传递给 draft**:在 `runDraft`(第 170-181 行)调用 `activities.draft` 时,把 `foundationArtifacts` 透传给改动 7 后的 draft activity

**为什么**:
- workflow 是 v2 的编排层,负责数据装载与传递
- 在 workflow 层加前置检查(而非只在 handler 层)是**双保险**:即使未来有其他入口(HTTP API / 其他 workflow)触发 `novelIntentWorkflow`,也能强制约束
- `ApplicationFailure.nonRetryable` 避免 Temporal 无限重试

**怎么做**:
- 在 [workflows.ts:7-25](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts#L7-L25) 注释的"阶段定义"中,在第 1 步"加载项目快照"后新增"加载全书规划产出"子步骤
- 在 `NovelWorkflowActivities` 接口新增 `listFoundationArtifacts(input: { projectId: string }): Promise<Artifact[]>`
- 前置检查逻辑放在 [workflows.ts:153](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts#L153) 的现有早退判断**之后**(因为 planning/foundation taskClass 本身就是规划任务,不应被自己的前置检查阻塞)

---

### 改动 9:在 workflow 接口与 activities 实现中注册新方法

**文件**:[workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)(接口) + [activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts)(实现)

**做什么**:
- 在 `NovelWorkflowActivities` 接口新增 `listFoundationArtifacts` 方法签名
- 在 `createNovelWorkflowActivities` 返回的对象中新增 `listFoundationArtifacts` 实现,调用 `deps.repository.listFoundationArtifacts(input.projectId)`(改动 4)

**为什么**:Temporal 的 proxyActivities 模式要求接口与实现对称,且通过接口类型约束 workflow 调用。

## 假设与决策

1. **不引入人工审批门**:用户选择"强制 foundation artifacts 存在"而非"LLM/人工审批",所以本方案是硬性存在性检查,不涉及审批流转。未来若需审批门,可在 `novel_chapter_generate` handler 之前新增 `novel_blueprint_approve` 工具,不改本方案。

2. **不增加 foundation taskKey**:用户选择"保持现有 10 个 taskKey"。`novel_bootstrap_run` 的 taskChain 不变,仍是 10 个(可选追加 chapter-plan 为 11 个)。`REQUIRED_FOUNDATION_TASK_KEYS` 的 5 项是这 10 个的子集。

3. **`includeChapterPlan` 默认值**:`novel_bootstrap_run` 当前 `includeChapterPlan` 默认 false([handlers.ts:553](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L553))。由于 `chapter-plan` 在 `REQUIRED_FOUNDATION_TASK_KEYS` 中,需要把默认值改为 true,或在 handler 文档中明确"生成章节前必须 `includeChapterPlan=true`"。本方案选择前者(改默认值为 true),避免用户忘记导致章节生成被阻塞。

4. **foundation artifacts 的 structuredData schema**:依赖现有 [foundation.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/foundation.ts) 的 `foundationSchema`。改动 7 从 structuredData 提取字段时做防御性解构,不强制 schema 演进。

5. **不在 `chapterReviewWorkflow` 加前置检查**:章节审校是对**已定稿章节**的复审([handlers.ts:629-666](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts#L629-L666) 已校验 `status="final"`),此时 foundation artifacts 必然已存在,无需重复检查。

6. **HTTP `/v2/intents` 入口的兼容性**:本方案不修改 HTTP API 入口。若用户通过 HTTP 直接触发 `novelIntentWorkflow`,改动 8 的 workflow 层前置检查仍会生效(拒绝未规划项目的章节生成),保持约束一致性。

## 验证步骤

### 单元测试

1. **`compileExecutionBlueprint` 消费 foundation artifacts**:
   - 测试用例:传入 5 个 foundation artifacts,断言 `blueprint.foundationArtifactIds` 长度为 5
   - 测试用例:不传 foundationArtifacts,断言 `blueprint.foundationArtifactIds` 为 undefined(向后兼容)

2. **`listFoundationArtifacts` repository 方法**:
   - 测试用例:插入 3 个 kind=foundation + 2 个 kind=draft 的 artifacts,断言只返回 3 个
   - 测试用例:空项目返回空数组

3. **`novel_chapter_generate` handler 前置检查**:
   - 测试用例:项目无 foundation artifacts,handler 抛错且错误信息包含缺失的 taskKey
   - 测试用例:项目有 5 个必填 taskKey 的 artifacts,handler 成功启动 workflow

### 集成测试

4. **端到端"先规划再写章节"流程**:
   - Step 1:调 `novel_project_create` 创建项目
   - Step 2:调 `novel_bootstrap_run`(带 `includeChapterPlan=true`)生成 11 个 foundation artifacts
   - Step 3:调 `novel_chapter_generate`,验证成功启动 `novelIntentWorkflow`
   - Step 4:检查 workflow 产出的 draft artifact,验证 prompt 中包含全书规划上下文(可通过 artifact.structuredData.workflowId 反查 model_task 的 prompt)

5. **未规划项目的章节生成被拒绝**:
   - Step 1:调 `novel_project_create` 创建项目
   - Step 2:跳过 `novel_bootstrap_run`,直接调 `novel_chapter_generate`
   - Step 3:验证 handler 抛错,错误信息为"全书规划未完成,缺失 taskKey: architecture, characters, worldview, plot-design, chapter-plan"

6. **HTTP `/v2/intents` 入口的约束一致性**:
   - Step 1:对未规划项目调 `POST /v2/intents` 触发章节生成
   - Step 2:验证 `novelIntentWorkflow` 在前置检查阶段抛 `ApplicationFailure.nonRetryable`,错误信息同上

### 回归验证

7. **现有 `novel_bootstrap_run` 不受影响**:
   - 调 `novel_bootstrap_run` 不带 `chapterTitle`/`documentId`,验证仍只产出 foundation artifacts,不触发章节生成

8. **`novel_chapter_review` 不受影响**:
   - 对已定稿章节调 `novel_chapter_review`,验证审校流程正常启动(前置检查不阻塞审校)

9. **`novel_closed_loop_run` 不受影响**:
   - 调 `novel_closed_loop_run`,验证评估闭环仍能正常运行(它基于已存在 document,不触发新章节生成)

## 改动文件清单

| 文件 | 改动类型 | 改动内容 |
|---|---|---|
| [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) | 新增常量 + 扩展接口 | `REQUIRED_FOUNDATION_TASK_KEYS` 常量;`ExecutionBlueprint.foundationArtifactIds` 可选字段 |
| [postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts) | 新增方法 | `listFoundationArtifacts(projectId)` |
| [cognition.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts) | 修改纯函数 | `compileExecutionBlueprint` 接收 `foundationArtifacts` 参数,写入 `blueprint.foundationArtifactIds` |
| [activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts) | 修改 + 新增 | `compileBlueprint`/`draft` activity 接收 foundationArtifacts;新增 `listFoundationArtifacts` activity 实现 |
| [workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts) | 修改 workflow | `novelIntentWorkflow` 加载 foundation artifacts + 前置检查 + 透传;`NovelWorkflowActivities` 接口新增方法签名 |
| [chapter-draft.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-draft.ts) | 修改 prompt | `DraftPromptInput` 新增 `foundationArtifacts`;`buildChapterDraftPrompt` 注入"全书规划上下文"段;新增 `buildFoundationContextMarkdown` 辅助函数 |
| [tool-definitions.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/tool-definitions.ts) | 新增工具定义 | `novel_chapter_generate` 工具(inputSchema) |
| [handlers.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/mcp/handlers.ts) | 新增 handler + 修改默认值 | `novel_chapter_generate` handler(前置检查 + 启动 workflow);`novel_bootstrap_run` 的 `includeChapterPlan` 默认值改为 true |

## 实施顺序建议

1. **改动 3 + 改动 4**(数据层):新增常量 + repository 方法,无副作用,可独立验证
2. **改动 6 + 改动 5 + 改动 9**(认知层 + activity 层):扩展接口与实现,纯函数可单测
3. **改动 7**(prompt 层):draft activity 与 prompt 函数,可单独跑 prompt 生成测试
4. **改动 8**(workflow 层):前置检查 + 数据传递,需要前面改动就绪
5. **改动 1 + 改动 2**(MCP 工具层):对外入口,放最后,便于前面验证通过后对外暴露

每步完成后跑对应单元测试,全部完成后跑集成测试 4-6。
