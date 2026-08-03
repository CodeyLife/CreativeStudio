# V2 能力扩展重构计划

## Summary

本计划在 Phase A（model-gateway strict-mode、prompt 升级、多轮修订、extractFacts）已完成的基础上，推进三个能力域的补齐：(1) 评估闭环（双循环迭代体系）、(2) 创意执行抽象 + MCP 工具网关、(3) 前端 UI 补全。v1 代码保留作为参考与迁移源，仅删除明确死代码。本计划遵循 AGENTS.md 的迭代改进与根因分析原则，所有新能力必须复用 v2 已有契约（protocol.ts、model-gateway、postgres-repository、temporal workflow），不允许另起独立离线逻辑。

## Current State Analysis

### 已完成（Phase A）

| 模块 | 状态 | 关键文件 |
|------|------|----------|
| model-gateway strict-mode + ajv + 2 轮自动修复 | ✅ | `src/novel-v2/model-gateway.ts` |
| draft/review/revise prompt 升级 | ✅ | `src/novel-v2/prompts/{chapter-draft,chapter-review,writer-rules,schemas}.ts` |
| 多轮修订循环（maxAutoRevisions=2、改善度阈值 0.15） | ✅ | `src/novel-v2/temporal/{workflows,revision-policy}.ts` |
| extractFacts LLM + 11 类去重 + 风险分类 | ✅ | `src/novel-v2/fact-extraction/{index,dedupe,classify,prompt}.ts` |
| v2 单元测试覆盖（54 用例） | ✅ | `src/novel-v2/__tests__/{model-gateway,revision-policy,fact-extraction,prompts}.test.ts` |

### 能力缺口（本计划覆盖）

| 缺口 | v1 对应 | v2 现状 | 优先级 |
|------|---------|---------|--------|
| 评估闭环 | `features/novel/evaluation/`（closed-loop/candidate-bundle/experiment-workspace/promotion/skill-iteration） | 仅有 `learning-assessment.ts`（单循环）+ `requestLearningPromotion`（仅登记事件） | P0 |
| 创意执行抽象 | `features/novel/creative-execution.ts`（CreativeRun/CreativeWorkItem 状态机） | 仅有单章节线性 Temporal workflow | P1 |
| MCP 工具网关 | `features/novel/creative-tool-gateway.ts`（24 个工具） | 无 | P1 |
| 前端 UI | `features/novel/{WorkflowCenter,AIWorkbench,FactLedger,SkillCenter}.tsx` | `NovelV2Studio.tsx` 仅 207 行，只展示 artifact fingerprint | P2 |

### v2 内部薄弱点（本计划顺带修复）

- `temporal/workflows.ts:145-147` blocker 抛错会被 Temporal 重试 3 次（`retry: { maximumAttempts: 3 }`），应改为 `ApplicationFailure` 标记 non-retryable
- `qdrant-memory.ts:22,25` 多处 `any` 类型，应补强类型
- `cognition.ts:34-41` 正则识别意图脆性、`cognition.ts:82` tokenBudget 硬编码 24000

## Assumptions & Decisions

1. **v1 保留作为参考**：`features/novel/` 整体保留，仅删除 `deterministic-check-stage.ts`（audit 报告明确为死代码）。v1 的 `evaluation/`、`creative-execution.ts`、`creative-tool-gateway.ts` 作为迁移源码参考。
2. **v2 评估闭环基于 Postgres 而非 IndexedDB**：v1 用 Dexie 实现实验库隔离，v2 改用 Postgres schema 隔离（`CREATE SCHEMA experiment_<id>`）或独立 database（`experiment_<id>`）。选择 schema 隔离，因为更轻量、连接池复用。
3. **MCP 工具网关复用 v2 HTTP API**：v1 的 `creative-tool-gateway.ts` 直接读 IndexedDB，v2 改为通过 `novel-v2-api.ts` 的 HTTP API 间接访问，工具层只做参数校验和调用编排。
4. **章节审校半截启动（startChapterReviewWorkflow）暂不在本轮**：用户未选择此能力域，但 AGENTS.md 明确要求复用。本轮在 protocol.ts 预留 `NovelIntent.requestedStage = "review"` 入口，后端逻辑下一轮实现。前端 UI 预留审批按钮但不接后端。
5. **人工审批门暂不在本轮**：同上，本轮只在前端预留 signal API 调用入口，不实现 blueprint-approval/manuscript-approval/fact-approval 的后端 gate 逻辑。
6. **不兼容旧数据**：遵循架构阶段准则，直接设计最优 schema，旧 v1 数据不迁移。

## Proposed Changes

### Phase B-1: 评估闭环（P0）

#### B-1.1 扩展 protocol.ts 类型

文件：`src/novel-v2/protocol.ts`

新增类型（参考 v1 `evaluation/types.ts` 但适配 v2 数据模型）：

```typescript
// 候选包：实验产物归一化为可晋升的 bundle
export interface CandidateBundle {
  formatVersion: 2;
  id: string;
  experimentId: string;
  sourceProjectId: string;
  baseSnapshotId: string;
  baseSnapshotHash: string;
  dependencyHead: ProjectHead; // 项目当前 revision + 最终章节列表 hash
  target: { documentId: string; baseRevision: number; baseContentHash: string };
  manuscript: { title: string; plainText: string; contentHtml: string; wordCount: number; contentHash: string; sourceArtifactId?: string };
  acceptedFacts: PromotableFact[]; // 从 MemoryClaim 投影
  iteratedSkills: IteratedSkill[]; // 实验期间 skill prompt 变更
  qualityEvidence: { reviewIds: string[]; scores: Record<string, number>; issueSummary: Record<string, number> };
  provenance: { codeRevision: string; createdAt: number; workflowRunId: string };
}

export interface IteratedSkill {
  skillId: string;
  beforePrompt: string; // 实验前 prompt_sections
  afterPrompt: string;  // 实验后 prompt_sections
  rationale: string;
  triggeredByIssueIds: string[];
  learningMechanism?: string; // 来自 RuntimeLearningAssessmentV2.underlyingMechanism
}

export interface PromotionReceipt {
  id: string; // promote:<candidateId>
  candidateId: string;
  projectId: string;
  status: "promoted" | "rolled-back" | "failed";
  result: { revisionId?: string; skillUpdates?: string[]; factIds?: string[] };
  failureReason?: string;
  createdAt: number;
}

export interface ProjectHead {
  projectRevision: number;
  finalDocumentHashes: string[]; // 按 narrativeOrder 排序的最终章节 contentHash
}
```

#### B-1.2 扩展 Postgres schema

文件：`deploy/postgres/002_evaluation_and_creative.sql`（新建）

```sql
-- 评估闭环
CREATE TABLE IF NOT EXISTS project_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  payload JSONB NOT NULL, -- 完整快照（documents + memory_claims + skills + entities）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiment_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  schema_name TEXT NOT NULL UNIQUE, -- experiment_<id>
  base_snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id),
  status TEXT NOT NULL DEFAULT 'active', -- active | closed | deleted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS candidate_bundles (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, -- 完整 CandidateBundle
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotion_receipts (
  id TEXT PRIMARY KEY, -- promote:<candidateId>
  candidate_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- promoted | rolled-back | failed
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iterated_skills (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment_workspaces(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  before_prompt JSONB NOT NULL, -- prompt_sections 快照
  after_prompt JSONB NOT NULL,
  rationale TEXT NOT NULL,
  triggered_by_issue_ids TEXT[] NOT NULL DEFAULT '{}',
  learning_mechanism TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 创意执行
CREATE TABLE IF NOT EXISTS creative_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES novel_projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, -- chapter | segment-auto
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | paused | completed | cancelled
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creative_work_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES creative_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- generation | revision | review
  task_key TEXT,
  target_id TEXT,
  instruction TEXT NOT NULL,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | accepted | revised | retried | recovered
  artifact_refs TEXT[] NOT NULL DEFAULT '{}',
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creative_reviews (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES creative_work_items(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL, -- passed | revise | blocked
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creative_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES creative_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### B-1.3 新建 evaluation 模块

文件结构：

```
src/novel-v2/evaluation/
├── project-snapshot.ts      # 捕获/恢复/校验项目快照
├── experiment-workspace.ts  # Postgres schema 隔离的实验工作区
├── candidate-bundle.ts      # 候选包组装/校验/序列化
├── promotion.ts             # 晋升服务（原子事务 + 幂等 + 回滚）
├── skill-iteration.ts       # LLM 驱动的 skill prompt 迭代
└── closed-loop.ts           # 闭环编排器
```

**`project-snapshot.ts`**（参考 v1 `evaluation/project-snapshot.ts`）：
- `captureProjectSnapshot(repository, projectId): Promise<ProjectSnapshotBundle>` — 查询 documents + memory_claims + skill_definitions + entities + relations，序列化为 JSON
- `computeProjectHead(repository, projectId): Promise<ProjectHead>` — 只读 documents + projects，计算 final 章节哈希列表
- `verifyProjectSnapshot(bundle, expectedHash): { valid: boolean; reason?: string }`

**`experiment-workspace.ts`**（v1 用 Dexie 实例隔离，v2 用 Postgres schema 隔离）：
- `createExperimentWorkspace(repository, bundle, experimentId): Promise<ExperimentWorkspace>`
  - `CREATE SCHEMA experiment_<id>`
  - 在实验 schema 内创建必要表的影子表（novel_projects, manuscript_documents, memory_claims, skill_definitions, artifacts, reviews 等）
  - `restoreProjectSnapshot` 将 bundle 写入实验 schema
- `ExperimentWorkspace.close()` — 标记 `experiment_workspaces.status = 'closed'`，保留数据用于诊断
- `ExperimentWorkspace.delete()` — `DROP SCHEMA experiment_<id> CASCADE` + 删除 `experiment_workspaces` 记录

**`candidate-bundle.ts`**（参考 v1 `evaluation/candidate-bundle.ts`）：
- `extractCandidateBundle(workspace, workflowRunId): Promise<CandidateBundle>` — 从实验 schema 读取 manuscript revision + accepted facts + iterated skills + review scores，组装为 CandidateBundle
- `verifyCandidateBundle(bundle): { valid: boolean; issues: string[] }` — 校验 contentHash、必填字段、prompt 长度
- `computeManuscriptContentHash(plainText, contentHtml): string`

**`promotion.ts`**（参考 v1 `evaluation/promotion.ts`，v2 用 Postgres 事务）：
- `createPromotionService(repository): PromotionService`
- `PromotionService.promote(candidate, decision): Promise<PromotionReceipt>`
  - 幂等检查：`SELECT * FROM promotion_receipts WHERE candidate_id=$1`，已有则返回
  - 依赖头校验：`recomputeDependencyHead` 与 `candidate.dependencyHead` 比对，不一致抛 `stale-baseline`
  - contentHash 校验：重算 manuscript hash，不一致抛 `content-hash-mismatch`
  - 单事务写入：BEGIN → INSERT manuscript_revisions → INSERT memory_claims（去重）→ UPDATE skill_definitions.prompt_sections → INSERT commit_records → INSERT promotion_receipts → COMMIT
  - 失败回滚 + 写 failed receipt
- `PromotionService.rollback(receiptId): Promise<void>` — 根据 receipt 回滚（删除 revision + 恢复 skill prompt）

**`skill-iteration.ts`**（参考 v1 `evaluation/skill-iteration.ts`，AGENTS.md 要求 buildIterationPrompt 追加 learning 段落）：
- `runSkillIteration(input: { workspace; reviews; learningAssessment; skills; model }): Promise<IteratedSkill[]>`
  - 构造 `buildIterationPrompt`：列出当前 skills + review issues + **learning.underlyingMechanism**（AGENTS.md 强制要求，非仅 issue 症状）
  - 调用 `model.generateStructured<SkillIterationOutput>` with `skillIterationSchema`
  - 校验 `afterPrompt` 能与 skill 元数据组合成完整 manifest
  - 写入 `iterated_skills` 表

**`closed-loop.ts`**（参考 v1 `evaluation/closed-loop.ts`）：
- `runClosedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult>`
  - 步骤：captureSnapshot → createExperimentWorkspace → runChapterWorkflowInExperiment → runSkillIteration → extractCandidateBundle → inspect → promote（非 dryRun）
  - 复用 v2 的 `temporal/workflows.ts` 在实验 schema 内执行章节工作流（通过 activity 注入实验 repository）

#### B-1.4 扩展 postgres-repository.ts

文件：`src/novel-v2/postgres-repository.ts`

新增方法：
- `captureSnapshot(projectId): Promise<ProjectSnapshotBundle>`
- `createExperimentWorkspace(bundle, experimentId): Promise<ExperimentWorkspace>`
- `dropExperimentWorkspace(experimentId): Promise<void>`
- `extractCandidateBundle(experimentId, workflowRunId): Promise<CandidateBundle>`
- `recordPromotionReceipt(input): Promise<PromotionReceipt>`
- `getPromotionReceipt(candidateId): Promise<PromotionReceipt | null>`
- `recordIteratedSkill(input): Promise<void>`
- `listIteratedSkills(experimentId): Promise<IteratedSkill[]>`

#### B-1.5 扩展 API 路由

文件：`scripts/novel-v2-api.ts`

新增路由：
- `POST /v2/projects/:id/snapshots` — 捕获快照
- `POST /v2/projects/:id/experiments` — 创建实验工作区
- `GET/DELETE /v2/experiments/:id` — 查看/删除实验
- `POST /v2/experiments/:id/workflows` — 在实验内启动工作流
- `POST /v2/experiments/:id/candidates` — 提取候选包
- `POST /v2/candidates/:id/promote` — 晋升候选包
- `POST /v2/candidates/:id/rollback` — 回滚晋升
- `GET /v2/projects/:id/promotions` — 列出晋升历史

#### B-1.6 测试

文件：`src/novel-v2/__tests__/evaluation.test.ts`

覆盖：
- `captureProjectSnapshot` + `computeProjectHead` 稳定性
- `createExperimentWorkspace` schema 隔离（实验数据不污染正式库）
- `extractCandidateBundle` 字段完整性 + contentHash 校验
- `promotion.promote` 幂等性（重复调用返回同一 receipt）
- `promotion.promote` stale-baseline 拒绝
- `promotion.promote` content-hash-mismatch 拒绝
- `promotion.rollback` 恢复 skill prompt
- `runSkillIteration` 追加 learning.underlyingMechanism（AGENTS.md 契约）
- `runClosedLoop` 端到端 dryRun（不 promote）

---

### Phase B-2: 创意执行抽象 + MCP 工具网关（P1）

#### B-2.1 扩展 protocol.ts 类型

文件：`src/novel-v2/protocol.ts`

新增类型（参考 v1 `creative-execution.ts` 但适配 v2）：

```typescript
export type CreativeRunMode = "chapter" | "segment-auto";
export type CreativeRunStatus = "pending" | "running" | "paused" | "completed" | "cancelled";
export type CreativeWorkKind = "generation" | "revision" | "review";
export type CreativeWorkStatus = "pending" | "running" | "accepted" | "revised" | "retried" | "recovered";

export interface CreativeRun {
  id: string;
  projectId: string;
  mode: CreativeRunMode;
  status: CreativeRunStatus;
  policy: CreativeRunPolicy; // maxRetries, reviewGate, autoAcceptThreshold
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreativeWorkItem {
  id: string;
  runId: string;
  kind: CreativeWorkKind;
  taskKey?: string;
  targetId?: string;
  instruction: string;
  dependsOn: string[];
  status: CreativeWorkStatus;
  artifactRefs: string[];
  parameters: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreativeReview {
  id: string;
  workItemId: string;
  reviewer: "internal" | "independent" | "human";
  verdict: "passed" | "revise" | "blocked";
  issues: ReviewIssue[];
  summary: string;
  createdAt: number;
}

export type CreativeCommand =
  | { type: "work.start"; workItemId: string; idempotencyKey: string }
  | { type: "work.revise"; workItemId: string; instruction?: string; idempotencyKey: string }
  | { type: "work.retry"; workItemId: string; idempotencyKey: string }
  | { type: "work.recover"; workItemId: string; force?: boolean; idempotencyKey: string }
  | { type: "work.accept"; workItemId: string; idempotencyKey: string }
  | { type: "review.request"; workItemId: string; idempotencyKey: string }
  | { type: "review.submit"; workItemId: string; review: CreativeReviewInput; idempotencyKey: string }
  | { type: "run.pause" | "run.resume" | "run.cancel"; idempotencyKey: string };
```

#### B-2.2 新建 creative 模块

文件结构：

```
src/novel-v2/creative/
├── creative-execution.ts  # CreativeRun 状态机
├── creative-segment.ts    # segment-auto 多章节编排
└── mcp/
    ├── tool-gateway.ts    # MCP 工具注册和调用
    ├── tool-registry.ts   # 工具元数据
    └── tools/             # 各工具实现
        ├── run-tools.ts        # novel_run_create/get/complete
        ├── action-tools.ts     # novel_action_list/execute
        ├── artifact-tools.ts   # novel_artifact_get
        ├── review-tools.ts     # novel_review_submit
        ├── catalog-tools.ts    # novel_catalog/receipt_get
        ├── rule-tools.ts       # novel_rule_candidate_create/get/promote/rollback
        ├── project-tools.ts    # novel_project_create/list/delete
        └── chapter-review.ts   # novel_chapter_review（半截启动，预留）
```

**`creative-execution.ts`**（参考 v1 `creative-execution.ts`）：
- `createCreativeRun(repository, input): Promise<CreativeRun>`
- `enqueueCreativeWork(repository, runId, input): Promise<CreativeWorkItem>`
- `executeCreativeCommand(repository, model, command): Promise<CreativeActionResult>`
  - 状态机：work.start → running → review.request → review.submit → accepted/revised/retried
  - work.revise：调用 `activities.revise`
  - work.recover：失败恢复（force 时跳过依赖检查）
  - run.pause/resume/cancel：更新 run status
- `inspectCreativeRun(repository, runId): Promise<CreativeRunSnapshot>`

**`creative-segment.ts`**（参考 v1 `creative-segment.ts`）：
- `runSegmentAuto(repository, model, input): Promise<CreativeRun>`
  - 自动编排多章节 CreativeRun：为每个章节创建 work item，按 dependsOn 串行执行
  - 复用 `temporal/workflows.ts` 的 `novelIntentWorkflow` 作为单章节执行器

**`mcp/tool-gateway.ts`**（参考 v1 `creative-tool-gateway.ts`，v2 改为 HTTP API 调用）：
- `registerTools(server, deps)` — 注册所有 MCP 工具
- 每个工具：参数 schema 校验 → 调用 `creative-execution.ts` 或 HTTP API → 返回结构化结果
- 区分 MUTATING_TOOLS 和 READONLY_TOOLS（权限校验）

#### B-2.3 扩展 temporal/workflows.ts

文件：`src/novel-v2/temporal/workflows.ts`

新增 `creativeRunWorkflow`：
- 接收 `runId`，从 repository 加载 CreativeRun + work items
- 按 dependsOn 拓扑排序执行 work items
- 每个 work item：调用 `novelIntentWorkflow`（chapter mode）或直接调 activity（revision/review mode）
- 支持 signal：pause/resume/cancel
- 修复 blocker 抛错重试问题：用 `ApplicationFailure.nonRetryable` 替代 `throw new Error`

#### B-2.4 扩展 API 路由

文件：`scripts/novel-v2-api.ts`

新增路由：
- `POST /v2/projects/:id/creative-runs` — 创建 CreativeRun
- `GET /v2/creative-runs/:id` — 查看 run 状态
- `POST /v2/creative-runs/:id/command` — 执行 CreativeCommand
- `GET /v2/creative-runs/:id/snapshot` — 查看 run 快照
- `POST /v2/creative-runs/:id/segment-auto` — 启动 segment 自动化

#### B-2.5 MCP server 入口

文件：`scripts/novel-v2-mcp-server.ts`（新建，参考 v1 `scripts/novel-mcp-server.mjs`）

- 加载 `src/novel-v2/creative/mcp/tool-gateway.ts`
- 通过 stdio 或 SSE 暴露 MCP 协议
- 配置：`NOVEL_V2_API_URL` 指向 `novel-v2-api.ts`

#### B-2.6 测试

文件：
- `src/novel-v2/__tests__/creative-execution.test.ts` — 状态机全分支
- `src/novel-v2/__tests__/mcp-tool-gateway.test.ts` — 工具参数校验 + 调用编排

覆盖：
- CreativeRun 生命周期（create → enqueue → start → review → accept → complete）
- work.revise/retry/recover 分支
- run.pause/resume/cancel
- segment-auto 多章节串行
- MCP 工具参数校验（缺字段/类型错误）
- MUTATING_TOOLS 权限校验
- novel_chapter_review 工具预留（不实际调用）

---

### Phase B-3: 前端 UI 补全（P2）

#### B-3.1 扩展 NovelV2Studio.tsx

文件：`src/pages/NovelV2Studio.tsx`

新增面板（基于已有 `/v2/*` API）：
- **Reviewer Issues 面板**：调 `GET /v2/runs/:id/artifacts` + `GET /v2/reviews?artifactId=:id`，渲染 severity/dimension/title/evidence/rewriteExample
- **质量分数雷达图**：从 reviews 的 scores 字段渲染 8 维度雷达图（用 SVG 或轻量库）
- **章节正文阅读**：调 `GET /v2/runs/:id/artifacts` 取 objectKey，再调 `GET /v2/objects/:objectKey`（新增路由）读取正文
- **Fact Ledger 查看**：调 `GET /v2/projects/:id/memory-claims`（新增路由）渲染事实列表
- **人工审批按钮**（预留）：调 `POST /v2/workflows/:wfId/tasks/:taskId/signal`，本轮按钮可见但不接后端 gate 逻辑

#### B-3.2 新建 NovelV2SkillCenter.tsx

文件：`src/pages/NovelV2SkillCenter.tsx`（新建）

- 调 `GET /v2/skills`（新增路由）列出 skill_definitions
- 显示 skill 元数据 + prompt_sections
- 调 `GET /v2/projects/:id/iteratations`（新增路由）查看 iterated_skills 历史
- 调 `POST /v2/candidates/:id/promote` 触发晋升（依赖 Phase B-1）

#### B-3.3 新建 NovelV2ClosedLoop.tsx

文件：`src/pages/NovelV2ClosedLoop.tsx`（新建）

- 调 `POST /v2/projects/:id/snapshots` 捕获快照
- 调 `POST /v2/projects/:id/experiments` 创建实验
- 调 `POST /v2/experiments/:id/workflows` 启动实验工作流
- 调 `POST /v2/experiments/:id/candidates` 提取候选包
- 调 `POST /v2/candidates/:id/promote` 晋升
- 渲染闭环进度（capture → experiment → workflow → iterate → candidate → promote）

#### B-3.4 新建 NovelV2CreativeRun.tsx

文件：`src/pages/NovelV2CreativeRun.tsx`（新建）

- 调 `POST /v2/projects/:id/creative-runs` 创建 run
- 调 `GET /v2/creative-runs/:id` 轮询状态
- 调 `POST /v2/creative-runs/:id/command` 发送 CreativeCommand
- 渲染 work items 列表 + 审批按钮

#### B-3.5 新增 API 路由（前端所需）

文件：`scripts/novel-v2-api.ts`

新增路由：
- `GET /v2/projects/:id/memory-claims` — 列出项目记忆
- `GET /v2/objects/:objectKey` — 读取对象存储内容
- `GET /v2/skills` — 列出 skill_definitions
- `GET /v2/projects/:id/iterations` — 列出 iterated_skills

#### B-3.6 测试

文件：
- `src/pages/__tests__/NovelV2Studio.test.tsx`（新建）
- `src/pages/__tests__/NovelV2ClosedLoop.test.tsx`（新建）

覆盖：
- Reviewer Issues 面板渲染（severity 颜色、rewriteExample 折叠）
- 质量分数雷达图数据映射
- 章节正文阅读（objectKey 解析 + 文本渲染）
- 闭环面板交互流程（capture → experiment → promote）

---

### Phase B-4: v1 死代码清理（顺手）

#### B-4.1 删除明确死代码

文件：`src/features/novel/workflow-stages/deterministic-check-stage.ts`（删除）

audit 报告明确标记为死代码，无任何引用。

#### B-4.2 修复 v2 内部薄弱点

文件：`src/novel-v2/temporal/workflows.ts`

- `workflows.ts:145-147`：将 `throw new Error(...)` 改为 `ApplicationFailure.nonRetryable(...)`，避免 blocker 被 Temporal 重试 3 次

文件：`src/novel-v2/qdrant-memory.ts`

- `qdrant-memory.ts:22,25`：替换 `any` 为 Qdrant SDK 类型

文件：`src/novel-v2/cognition.ts`

- `cognition.ts:82`：`tokenBudget = 24_000` 改为从环境变量 `NOVEL_TOKEN_BUDGET` 读取，默认 24000

## Verification Steps

### Phase B-1 验证

1. `pnpm exec vitest run src/novel-v2/__tests__/evaluation.test.ts` — 全部通过
2. 手动 smoke：`docker compose -f docker-compose.v2.yml up -d` → `pnpm run dev:v2` → `ts-node scripts/novel-v2-smoke.ts` 验证快照/实验/晋升流程
3. 验证幂等性：同一 candidateId 重复 promote 返回同一 receipt
4. 验证 schema 隔离：实验 schema 内的写入不污染正式 schema

### Phase B-2 验证

1. `pnpm exec vitest run src/novel-v2/__tests__/creative-execution.test.ts src/novel-v2/__tests__/mcp-tool-gateway.test.ts` — 全部通过
2. 手动 smoke：`ts-node scripts/novel-v2-mcp-server.ts` 启动 MCP server，用 MCP client 调用 `novel_run_create` → `novel_action_execute` → `novel_review_submit` → `novel_run_complete`
3. 验证 segment-auto：创建 3 章节的 segment run，验证按 dependsOn 串行执行
4. 验证 blocker non-retryable：构造 blocker 场景，确认 workflow 不重试直接进人工队列

### Phase B-3 验证

1. `pnpm exec vitest run src/pages/__tests__/NovelV2*.test.tsx` — 全部通过
2. 手动 UI 验证：`pnpm dev` → 打开 `/novels/:projectId` → 检查 reviewer issues 面板、质量分数雷达图、章节正文阅读、fact ledger
3. 验证闭环面板：capture → experiment → workflow → candidate → promote 全流程可见

### 全局验证

1. `pnpm lint` — 无错误
2. `pnpm test` — 全部通过（含已有 95 用例 + 新增用例）
3. 文件大小审计：无单文件超过 500 行（postgres-repository.ts 可能需要拆分）
4. AGENTS.md 契约检查：
   - learning.underlyingMechanism 在 propose-improvement 时必填 ✅
   - buildIterationPrompt 追加 learning 段落 ✅
   - promotion 后回归验证 ✅
   - 无独立离线修订逻辑 ✅

## 实施顺序

1. **B-1.1 ~ B-1.2**：扩展 protocol.ts 类型 + 新建 SQL schema（基础）
2. **B-1.3 ~ B-1.4**：实现 evaluation 模块 + 扩展 postgres-repository（核心逻辑）
3. **B-1.5**：扩展 API 路由（接口暴露）
4. **B-1.6**：编写 evaluation 测试（验证）
5. **B-2.1 ~ B-2.3**：扩展 protocol.ts + 实现 creative 模块 + 扩展 workflows（创意执行核心）
6. **B-2.4 ~ B-2.5**：扩展 API 路由 + MCP server 入口（接口暴露）
7. **B-2.6**：编写 creative + MCP 测试（验证）
8. **B-3.1 ~ B-3.5**：前端 UI 补全（依赖 B-1/B-2 后端 API）
9. **B-3.6**：前端测试（验证）
10. **B-4**：v1 死代码清理 + v2 薄弱点修复（顺手）
11. **全局验证**：lint + test + 文件大小审计

## 不在本轮范围

- **章节审校半截启动**（startChapterReviewWorkflow）：AGENTS.md 明确要求复用，但用户未选。本轮在 protocol.ts 预留 `requestedStage = "review"` 入口，下一轮实现。
- **人工审批门**（blueprint/manuscript/fact approval）：同上，前端预留按钮但不接后端。
- **v1 巨型文件拆分**（generation.ts 256KB 等）：用户选择保留 v1 作为参考，不拆分。
- **v1/v2 类型统一**（shared-types/ 目录）：不在本轮，v2 保持自包含。
- **前端本地缓存**（IndexedDB）：v2 保持纯 API 消费者架构。
- **离线/浏览器内模型**：v2 保持服务端网关架构。
