# V2 评估闭环模块 - TypeScript 编译验证计划

## Summary

验证 `f:\GitHubProject\Ymcp\web\src\novel-v2\evaluation\` 目录下已创建的 6 个 TypeScript 文件能通过 `pnpm lint` 编译检查。这是 Phase B-1.3 重构计划的收尾验证步骤。

## Current State Analysis

### 已完成的文件（6 个）

1. **project-snapshot.ts** - 项目快照捕获/校验，计算 ProjectHead
2. **experiment-workspace.ts** - Postgres schema 隔离的实验环境管理（已修复 QueryResultRow 泛型约束）
3. **candidate-bundle.ts** - 从实验 schema 提取候选包并校验完整性
4. **promotion.ts** - 候选包晋升服务，原子事务+幂等+回滚（已删除未使用的 PoolClient 导入）
5. **skill-iteration.ts** - LLM 驱动的 skill prompt 迭代
6. **closed-loop.ts** - 闭环编排器（已删除未使用的 ExperimentWorkspaceHandle 导入）

### 依赖验证（Phase 1 探索结果）

所有依赖项已确认存在且接口匹配：

- **protocol.ts**（行 308-467）：定义了 `ProjectHead`、`ProjectSnapshotBundle`、`ExperimentWorkspace`、`IteratedSkill`、`PromotableFact`、`CandidateBundle`、`PromotionReceipt`、`AuthorDecision` 等全部评估闭环类型 ✓
- **postgres-repository.ts**（行 67-68）：`NovelPostgresRepository` 暴露 `readonly pool: Pool` ✓
- **model-gateway.ts**（行 26-31）：`ModelGateway` 接口含 `generateStructured<T>` 方法 ✓
- **learning-assessment.ts**：定义 `RuntimeLearningAssessmentV2` 类型与 `runtimeLearningAssessmentSchema` ✓
- **deploy/postgres/002_evaluation_and_creative.sql**：定义 `project_snapshots`、`experiment_workspaces`、`iterated_skills`、`candidate_bundles`、`promotion_receipts` 表 ✓
- **deploy/postgres/001_novel_v2.sql**：定义基础表（含 `commit_records`）✓

### 潜在编译风险点（代码审查）

经逐文件审查，已修复的问题（见 Current State）之外，未发现明显的编译错误：

- **类型导入**：所有跨模块导入均使用 `import type` 或纯类型导入，符合 `isolatedModules: true` ✓
- **泛型约束**：`ExperimentWorkspaceHandle.query<T extends QueryResultRow>` 已修复 ✓
- **未使用导入**：`closed-loop.ts` 和 `promotion.ts` 已清理 ✓
- **`as` 断言**：`project-snapshot.ts` 行 370 的 `as ProjectSnapshotBundle["payload"]` 断言合法（源类型是目标类型的超集，结构兼容）✓
- **`let currentHead;`**（promotion.ts 行 128）：隐式 `any` 类型，但 TypeScript 的 `noImplicitAny` 不标记未初始化的 `let` 声明（仅标记参数和 `this`），应通过 ✓
- **循环依赖**：6 个文件之间无循环导入 ✓

## Proposed Changes

### 步骤 1：运行 `pnpm lint` 验证编译

执行命令：
```bash
pnpm lint
```

该命令实际执行 `tsc --noEmit && tsc -p tsconfig.runtime.json`（见 package.json 行 11），对 `src/**/*.ts` 和 `src/novel-v2/**/*.ts` 做类型检查。

### 步骤 2：如有错误，按类型修复

若编译报错，按错误类型采取不同策略：

- **TS2304（找不到名称）/ TS2307（找不到模块）**：检查导入路径拼写
- **TS2322（类型不可赋值）**：检查 `as` 断言是否需要调整，或补充类型注解
- **TS6133（声明但未使用）**：删除未使用的导入/变量
- **TS2345（参数类型不匹配）**：补充类型断言或调整签名

### 步骤 3：报告结果

汇报编译结果（通过/失败 + 错误清单 + 修复内容）。

## Assumptions & Decisions

1. **不修改 6 个文件的功能逻辑**：仅修复编译错误，不重构或调整架构
2. **不创建测试文件**：原始任务只要求创建 6 个实现文件，测试不在本次范围
3. **不创建 index.ts 桶文件**：当前 `closed-loop.ts` 用直接文件路径导入，无需桶导出
4. **保留 TODO 标记**：`closed-loop.ts` 步骤 4（章节工作流接入）的 TODO 是预期的，不视为编译问题
5. **`noUnusedLocals` 边界**：`closed-loop.ts` 的 `ClosedLoopOptions.instruction` 字段未在函数体内使用，但作为接口属性不触发 `noUnusedLocals`（该规则只针对局部变量）

## Verification Steps

1. `pnpm lint` 退出码为 0
2. 无 TypeScript 编译错误输出
3. 6 个评估闭环文件均通过类型检查
