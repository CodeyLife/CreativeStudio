# 迁移与重构进度审核报告

## Summary

本报告对照 [novel-architecture-audit-and-refactor.md](file:///f:/GitHubProject/Ymcp/web/.trae/documents/novel-architecture-audit-and-refactor.md) 中的 P0/P1/P2/P3 全量重构方案，审核截至 2026-07-27 的实际进度。

**核心结论**：原计划的重构任务完成度约 **5%（仅 P0-2a 完成）**，但计划外完成了大量功能性迭代（v2 runtime cutover、UI 管理、契约修复、schema 优化、story-bible 闭环）。当前处于 **"v2 已切换为主路径但能力不足，v1 仍是后备但未拆分"** 的危险中间态——v2 activities 仍是 stub 级实现，但 v1 巨型文件原封未动，双栈维护成本持续累积。

**关键风险**：v2 已被切为主路径（commit `c072d31 Complete novel V2 runtime cutover`），但 v2 的 `draft`/`review`/`revise` prompt 极简、`extractFacts` 是按标点分句的玩具实现、`model-gateway` 无 strict-mode JSON schema 校验、修订只跑 1 轮。这意味着日常创作实际仍依赖 v1 路径兜底，而 v1 的 12 个巨型文件（generation.ts 256KB、skills.ts 129KB、craft-rule-evolution.ts 63KB 等）未拆分，迁移阻塞点原封未动。

## Current State Analysis

### 计划内任务进度（按原方案 P0→P3 排序）

#### P0-1 拆分 generation.ts 256KB 巨型文件 — ❌ 未启动

- [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts) 仍为 256,577 字节单文件
- 12 个巨型文件全部原状未动：

| 文件 | 计划目标 | 实际大小 | 状态 |
|------|----------|----------|------|
| [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts) | 拆为 14 任务模块 + 公共工具 | 256KB | ❌ 未拆 |
| [skills.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/skills.ts) | 抽到 YAML 资源 | 129KB | ❌ 未拆 |
| [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) | 按子域拆 6 文件 | 63KB | ❌ 未拆 |
| [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) | 拆 4 文件 | 59KB | ❌ 未拆 |
| [db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts) | schema/CRUD/normalizer 分离 | 57KB | ❌ 未拆 |
| [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) | 合并到 WorkflowRun | 54KB | ❌ 未拆 |
| [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) | 按子域拆 10 文件 | 43KB | ❌ 未拆 |
| [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) | ROLE_PROMPTS 抽出 | 43KB | ❌ 未拆 |
| [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) | 解耦 generation.ts | 43KB | ❌ 未拆 |
| [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) | 与 skills 边界明确 | 41KB | ❌ 未拆 |
| [quality.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality.ts) | 按维度拆 | 35KB | ❌ 未拆 |
| [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) | 注册表模式 | 34KB | ❌ 未拆 |

- `src/features/novel/generation/`、`db/`、`craft-rule/`、`tools/`、`prompts/`、`types/`、`quality-rules/` 目录均**不存在**
- `src/features/novel/context-service.ts`、`lifecycle.ts` **不存在**

#### P0-2 v2 activities 落地真实逻辑 — 部分完成（1/5）

| 子任务 | 状态 | 证据 |
|--------|------|------|
| P0-2a 修复 `assessLearning` stub | ✅ 已完成 | [learning-assessment.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/learning-assessment.ts) 落地，[activities.ts:57-63](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts#L57-L63) 调用 `assessRuntimeLearningWithModel`，校验 `underlyingMechanism`/`affectedInputClass` 必填，模型未配置时返回 `no-shared-learning` 而非硬编码 propose-improvement |
| P0-2b 升级 draft/review/revise prompt | ❌ 未启动 | [activities.ts:35-50](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts#L35-L50) 仍是极简 prompt（"你是长篇小说写作 Worker。只写当前任务..."），未复用 v1 [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) 41KB 精心设计的模板 |
| P0-2c 升级 extractFacts 到 v1 等级 | ❌ 未启动 | [postgres-repository.ts:340-357](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts#L340-L357) 仍是按标点分句、取前 12 条、confidence 固定 0.62 的玩具实现，与 v1 [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) 11 类去重/校验严重不对等 |
| P0-2d 升级 review 多轮修订 | ❌ 未启动 | [workflows.ts:61-67](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts#L61-L67) 修订仍只跑 1 轮，无 v1 `shouldAutoRevise` 改善度判断与 `maxAutoRevisions=2` |
| P0-2e 升级 model-gateway strict-mode | ❌ 未启动 | [model-gateway.ts:21](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts#L21) `generateStructured` 仍是把 schema 拼到 prompt 末尾让 LLM 返回 JSON 再 `JSON.parse`，无 `response_format` 支持、无 ajv 校验、全文 `any` 类型 |

#### P0-3 统一 v1/v2 共享类型 — ❌ 未启动

- `src/novel-v2/shared-types/` 目录**不存在**
- v1 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 43KB 与 v2 [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) 仍完全独立
- v2 `MemoryClaim` vs v1 `FactAssertion`/`DerivedMemory`、v2 `Review` vs v1 `QualityReport`/`CreativeReview` 仍重复定义

#### P1-1 ~ P1-7 — ❌ 全部未启动

- P1-1 无 `context-service.ts`，三份上下文构建逻辑（[context.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context.ts) / [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) / [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) `buildChapterEvaluationContextSnapshot`）仍重复
- P1-2 无 `prompts/` 目录，三处 prompt 源（[ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) `ROLE_PROMPTS` / [skills.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/skills.ts) `BUILTIN_NOVEL_SKILLS` / [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts)）仍无统一治理
- P1-3 [db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts) 57KB 未拆，schema/CRUD/normalizer/committer 仍混杂，`db.ts → retrieval.ts → db.ts` 循环依赖未修
- P1-4 CreativeRun 与 WorkflowRun 双轨状态机仍并存（[workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) + [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts)）
- P1-5 [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) 59KB 未拆，6 类职责仍混杂，`memory.ts → memory-service.ts` 反向依赖未修
- P1-6 [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 63KB 未拆，架构阶段 `requireCrossScenarioEvidence` 阻塞点未修
- P1-7 [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) 34KB 未改为注册表模式

#### P2-1 ~ P2-6 — 几乎全部未启动（1/6 部分）

- P2-1 ❌ [deterministic-check-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/deterministic-check-stage.ts) 死代码仍存在
- P2-2 ❌ F-002 TODO P1 契约违反未修复（[workflow.ts:122-141](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts#L122-L141) `findReusableChapterBlueprint` fallback 仍用占位字符串）
- P2-3 ❌ [workflow.ts:261](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts#L261) TODO P2 未修复
- P2-4 ❌ 无 `lifecycle.ts`，IndexedDB 删除契约 API 仍散布在 bootstrap/OutlineProposalReview/generation
- P2-5 ❌ `formatReviewIssuesForInstruction` 仍在 service.ts（不在 revision-stage.ts）
- P2-6 ⚠️ 部分：v2 测试以 `v2-cognition.test.ts` / `v2-commit-service.test.ts` / `v2-learning-assessment.test.ts` / `v2-repository-management.test.ts` 形式存在于 [src/features/novel/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/__tests__/)，但 [src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 目录仍为空（与原计划位置不符）

#### P3-1 ~ P3-6 — ❌ 全部未启动

- 类型拆分、quality 拆分、wordCount 统一、UI 拆分、persistence 移除、v1 完整迁移均未启动

### 计划外完成的功能性迭代（非原方案内容）

以下进展不在原 P0-P3 方案中，但对项目实际可用性至关重要：

1. **V2 runtime cutover**（commit `c072d31`）— v2 已切换为运行时主路径
2. **V2 runtime persistence slice**（commit `983c7ed`）— v2 持久化分片
3. **V2 runtime learning assessment**（commit `99245dd`）— 对应 P0-2a
4. **V2 management UI**（commit `00f2259`）— v2 管理 UI 扩展
5. **Chapter review workflow + externalDraft** — `startChapterReviewWorkflow` 支持 externalDraft 参数（用于章节正文重写）
6. **MCP 工具描述增强** — `novel_change_patch` / `novel_change_review` 工具描述更新引导外部 LLM 选择工作方法
7. **buildCandidateEvidence 异常修复** — Loop 6 修复（project_memory 第47条）
8. **架构 accept 闭环** — Layer 15/16 修复（internalGate 解耦 + normalizeArchitecturePayload 前置，project_memory 第48条）
9. **story-bible 闭环** — Layer 5 schema minItems HARD constraint（project_memory 第52条）
10. **Class A/B/C 需求分类执行框架** — project_memory 第49条
11. **schema required 驱动字段填充** — Layer 10（project_memory 第41条）
12. **两阶段拆分生成模式** — story-bible 候选 b51b76db 已 accept（project_memory 末条）

### 双栈实际状态

```
┌─────────────────────────────────────────────────────────────────┐
│  UI 层（v1 + v2 管理界面并存）                                    │
├─────────────────────────────────────────────────────────────────┤
│  v2 runtime 主路径（cutover 完成）                                │
│  ├─ activities 仍是 stub 级（draft/review/revise prompt 极简）    │
│  ├─ extractFacts 按标点分句（玩具级）                             │
│  ├─ model-gateway 无 strict-mode                                 │
│  └─ 修订只跑 1 轮                                                │
├─────────────────────────────────────────────────────────────────┤
│  v1 IndexedDB 后备路径（仍可用）                                  │
│  ├─ 12 个巨型文件未拆分（generation.ts 256KB ...）               │
│  ├─ 三处 prompt 源未统一                                          │
│  ├─ 三份上下文构建逻辑重复                                        │
│  ├─ CreativeRun/WorkflowRun 双轨                                  │
│  └─ deterministic-check-stage.ts 死代码                           │
├─────────────────────────────────────────────────────────────────┤
│  v1/v2 类型系统完全独立（无 shared-types）                        │
└─────────────────────────────────────────────────────────────────┘
```

## Audit Findings

### 风险 1：v2 主路径能力不足，实际依赖 v1 兜底

- **现象**：v2 已 cutover 为主路径，但 [activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts) 的 draft/review/revise prompt 是一句话级别，extractFacts 是玩具实现，model-gateway 无 strict-mode
- **影响**：日常创作质量实际仍依赖 v1 IndexedDB 路径，但 v1 被标记为"后备"，未来迭代优先级会被压低
- **后果**：v2 输出质量不可控（无 schema 校验、无多轮修订、无事实去重），v1 维护成本持续累积

### 风险 2：迁移阻塞点原封未动

- **现象**：原方案 P0-1（generation.ts 拆分）的根因——`facts.ts`/`craft-rule-evolution.ts` 反向依赖 `generation.ts` 的 `normalizedCreate`/`getGenerationTask`——完全未修复
- **影响**：即使现在启动 v2 activities 升级，也无法把 v1 的领域知识（prompt 工程、learning 评估、事实提取规则）迁移到 v2，因为 v1 模块边界混乱无法抽离纯函数
- **后果**：v2 activities 升级被 v1 拆分阻塞，形成"v2 等待 v1 拆分，v1 拆分等待 v2 activities 升级"的潜在死锁

### 风险 3：双栈类型分裂持续恶化

- **现象**：v1 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 43KB 与 v2 [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) 完全独立，`MemoryClaim`/`FactAssertion`/`DerivedMemory`、`Review`/`QualityReport`/`CreativeReview` 重复定义
- **影响**：每次 v1 或 v2 单边演进都会扩大类型鸿沟，未来统一成本指数级上升
- **后果**：v1→v2 完整迁移（P3-6）将遥遥无期

### 风险 4：契约违反持续累积

- F-002 TODO P1（degraded blueprint 占位字段）未修复，违反 AGENTS.md「产物回填契约」
- v1 `formatReviewIssuesForInstruction` 仍在 service.ts（不在 revision-stage.ts），issues 注入契约分层脆弱
- IndexedDB 删除契约 API 散布在 bootstrap/OutlineProposalReview/generation，未集中审计
- `deterministic-check-stage.ts` 死代码仍存在

### 风险 5：v2 测试覆盖严重不足

- [src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 目录为空
- v2 测试以 `v2-*.test.ts` 形式混在 v1 测试目录，位置与原计划不符
- v2 postgres-repository / temporal workflows 无集成测试
- 与 v2"目标架构"地位严重不匹配

### 符合度汇总

| 维度 | 计划完成度 | 实际状态 |
|------|-----------|----------|
| P0-1 generation.ts 拆分 | 0% | 256KB 单文件未动 |
| P0-2 v2 activities 落地 | 20%（1/5） | 仅 assessLearning 修复 |
| P0-3 类型统一 | 0% | 双栈独立 |
| P1-1~P1-7 重复逻辑合并 + 巨型文件拆分 | 0% | 全部未启动 |
| P2-1~P2-6 死代码清理 + 契约修复 | ~15%（1/6 部分） | 仅 v2 测试部分覆盖 |
| P3-1~P3-6 长期清理 + v1 删除 | 0% | 全部未启动 |
| **整体重构完成度** | **~5%** | **仅 P0-2a** |

## Proposed Changes（重新排定优先级）

> 鉴于 v2 已 cutover 为主路径但能力不足，且 v1 巨型文件未拆分阻塞 v2 activities 升级，建议按"先补 v2 能力短板 → 再拆 v1 阻塞点 → 后做长期清理"顺序推进。

### Phase A：紧急补齐 v2 能力短板（最高优先级，2-3 周）

> 目标：让 v2 主路径达到 v1 等级，消除"v2 主路径但实际依赖 v1 兜底"的危险状态。

#### A-1 升级 [model-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts) strict-mode

- `generateStructured` 改为传入 schema 给 LiteLLM 的 `response_format` 参数（OpenAI 兼容）
- 移除 `any` 类型，改为泛型 `<T>`
- 加入 ajv 校验 + 失败重试（与 v1 [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) 一致）
- **为什么最高优先级**：v2 所有 LLM 调用都经过 model-gateway，没有 strict-mode 就没有 schema 校验保障，是 v2 能力短板的根因

#### A-2 升级 [activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts) draft/review/revise prompt

- 把 v1 [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) 的 `buildChapterDraftPrompt`、`buildChapterReviewPrompt` 迁移到 [src/novel-v2/prompts/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/) 下
- activities.draft/review/revise 调用这些函数构造 prompt
- review activity 的 schema 改为复用 [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts) 的 `reviewerSchema`
- **为什么紧急**：v2 draft/review prompt 是一句话级别，输出质量完全不可控

#### A-3 升级 [workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts) 多轮修订

- 复用 v1 `shouldAutoRevise` 改善度判断，支持 `maxAutoRevisions=2`
- **为什么紧急**：单轮修订无法收敛质量问题

#### A-4 升级 [postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts) recordFactExtraction

- 把 v1 [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) 的 `prepareFactCandidates`、`classifyFactRisk`、`dedupeCharacterFactCandidates` 等纯函数迁移到 [src/novel-v2/fact-extraction/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/fact-extraction/)
- activities.extractFacts 调用 LLM 提取 + 这些纯函数处理
- recordFactExtraction 改为接受已处理的 FactClaim[]，不再做分句
- **为什么紧急**：当前按标点分句、confidence 固定 0.62 的实现会污染事实账本

### Phase B：拆分 v1 阻塞点（高优先级，4-6 周）

> 目标：消除 v2 activities 升级的反向依赖阻塞，让 v1 领域知识可被抽离到 v2。

#### B-1 拆分 [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts) 256KB（原 P0-1）

- 按 14 任务拆为 `src/features/novel/generation/tasks/*.ts`
- 抽出 `proposal-utils.ts`：把 `normalizedCreate`、`updateProposalItemPayload` 等被外部导入的工具移入
- 修复 [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) / [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 的反向依赖
- 删除 generation.ts 中 `node:fs`/`node:os`/`node:path` import（迁移诊断临时文件到 dev-only 脚本）

#### B-2 统一 v1/v2 共享类型（原 P0-3）

- 创建 [src/novel-v2/shared-types/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/shared-types/) 目录
- 抽出共享类型（按子域）：`fact.ts`、`memory.ts`、`review.ts`、`skill.ts`、`artifact.ts`、`workflow.ts`
- v1 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 与 v2 [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) 重新导出 shared-types
- 删除 v2 `MemoryClaim`/`Review`/`MemoryHit` 等重复定义

#### B-3 统一上下文构建逻辑（原 P1-1）

- 创建 [src/features/novel/context-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context-service.ts)
- 合并三份重复实现：[context.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context.ts) `compileNovelContext` + [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) `buildCandidates` + [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) `buildChapterEvaluationContextSnapshot`

### Phase C：契约修复 + 死代码清理（中优先级，2-3 周，原 P2）

#### C-1 修复 F-002 TODO P1 契约违反（原 P2-2）
#### C-2 删除 [deterministic-check-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/deterministic-check-stage.ts) 死代码（原 P2-1）
#### C-3 集中 IndexedDB 删除契约 API（原 P2-4）— 创建 [src/features/novel/lifecycle.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/lifecycle.ts)
#### C-4 修复 issues 注入契约分层（原 P2-5）— `formatReviewIssuesForInstruction` 迁移到 revision-stage.ts
#### C-5 v2 测试补齐（原 P2-6）— 创建 [src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 目录，覆盖 cognition/activities/postgres-repository/workflows

### Phase D：长期清理（低优先级，持续，原 P1 剩余 + P3）

- D-1 统一 prompt 治理（原 P1-2）— 抽到 `prompts/` YAML 资源
- D-2 拆分 [db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts) 57KB（原 P1-3）
- D-3 合并 CreativeRun 与 WorkflowRun 双轨（原 P1-4）
- D-4 拆分 [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) 59KB（原 P1-5）
- D-5 拆分 [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 63KB（原 P1-6）
- D-6 拆分 [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) 34KB（原 P1-7）
- D-7 拆分 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 43KB（原 P3-1）
- D-8 拆分 [quality.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality.ts) 35KB（原 P3-2）
- D-9 UI 拆分（原 P3-4）
- D-10 v1 → v2 完整迁移 + v1 代码删除（原 P3-6）

## Assumptions & Decisions

### Assumptions

1. **v2 是目标架构**：用户在原计划中已明确，v1 逐步废弃
2. **v2 cutover 已成既定事实**：commit `c072d31` 已合并，不可回退
3. **v1 领域知识是核心资产**：prompt 工程、learning 评估、事实提取规则必须迁移到 v2，不可重新实现
4. **测试是迁移的安全网**：v1 现有 50+ 测试必须在 Phase B 重构后继续通过

### Decisions

1. **优先级调整**：原方案 P0-1（generation.ts 拆分）→ P0-2（v2 activities）→ P0-3（类型统一）的顺序，调整为 **Phase A（v2 能力补齐）→ Phase B（v1 拆分 + 类型统一）**
   - **理由**：v2 已 cutover 为主路径，能力短板是当下最紧迫的风险；v1 拆分是为了支撑 v2 升级，应排在 v2 能力补齐之后
2. **Phase A 不依赖 v1 拆分**：A-1/A-2/A-3/A-4 都是 v2 内部升级，可独立推进；prompt 迁移可从 v1 文件直接拷贝（不需要 v1 拆分完成）
3. **Phase B 顺序保持**：B-1（generation.ts 拆分）→ B-2（类型统一）→ B-3（上下文合并）与原方案一致
4. **Phase D 可并行**：D-1~D-9 之间无强依赖，可根据精力并行推进

### Tradeoffs

- **先补 v2 能力 vs 先拆 v1**：选择先补 v2 能力，代价是 v1 巨型文件维护成本持续累积一段时间，但避免"v2 主路径能力不足导致日常创作退化"
- **prompt 直接拷贝 vs 等待 v1 拆分**：选择直接拷贝，代价是 v1/v2 暂时存在重复 prompt 文本，但能快速补齐 v2 能力
- **类型统一提前 vs 滞后**：放在 Phase B（v1 拆分之后），与原方案一致，避免类型统一被 v1 拆分破坏

## Verification Steps

### Phase A 验证（每个子任务完成后）

1. `pnpm lint` 通过
2. `pnpm test` 全部通过
3. 新增 v2 测试覆盖：model-gateway strict-mode / draft prompt / 多轮修订 / fact-extraction 11 类去重
4. 手动跑一次 v2 章节生成流程，验证输出质量与 v1 等级
5. 文件大小审计：v2 单文件 < 30KB

### Phase B 验证

6. `pnpm lint` 通过
7. `pnpm test` 全部通过（v1 现有 50+ 测试不退化）
8. 单文件最大 < 50KB（除 prompt 资源文件外）
9. v1 与 v2 类型可互相赋值（编译期校验）
10. facts.ts 与 craft-rule-evolution.ts 不再 import 自 `./generation`（而是 `./generation/proposal-utils` 或 `./generation`）

### Phase C 验证

11. 全项目 grep `closeProposal`/`rejectProposal`/`deleteLocalProject`/`removeProject` 仅在 lifecycle.ts 中定义
12. 不再有 TODO P1 标注
13. `deterministic-check-stage.ts` 文件不存在
14. v2 测试覆盖率 > 60%

### 持续验证

15. 每次 commit 运行 `pnpm test`
16. 每次 PR 运行 `pnpm lint` + `pnpm test` + `pnpm build`
17. 每周运行 v2 章节生成冒烟测试（`pnpm novel:v2:smoke`）

## 执行建议

- **立即启动 Phase A**：v2 能力短板是当下最高风险，建议本周内启动 A-1（model-gateway strict-mode）
- **Phase A 完成后启动 Phase B**：v1 拆分需要相对完整的时间块，建议作为下个迭代主线
- **Phase C 可与 Phase B 并行**：契约修复和死代码清理独立性强，可分配给不同人/不同时段
- **Phase D 持续推进**：长期清理无紧迫性，可按精力零散推进
- **每阶段独立 PR**：便于 review 与回滚
- **测试先行**：每个子任务先写测试再重构

## 文件清单（按 Phase A 改动顺序）

### Phase A 新增/修改
- 修改：[src/novel-v2/model-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts)（strict-mode + ajv）
- 新增：[src/novel-v2/prompts/chapter-draft.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-draft.ts)、[src/novel-v2/prompts/chapter-review.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/chapter-review.ts)
- 修改：[src/novel-v2/temporal/activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts)（draft/review/revise prompt 升级）
- 修改：[src/novel-v2/temporal/workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)（多轮修订）
- 新增：[src/novel-v2/fact-extraction/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/fact-extraction/) 目录
- 修改：[src/novel-v2/postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts)（recordFactExtraction 升级）
- 新增：[src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 目录（4 个测试文件）

### Phase B 新增/修改
- 新增：[src/features/novel/generation/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation/) 目录（17 个文件）
- 删除：[src/features/novel/generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts)
- 新增：[src/novel-v2/shared-types/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/shared-types/) 目录（6 个文件）
- 新增：[src/features/novel/context-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context-service.ts)

### Phase C 新增/修改
- 删除：[src/features/novel/workflow-stages/deterministic-check-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/deterministic-check-stage.ts)
- 新增：[src/features/novel/lifecycle.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/lifecycle.ts)
- 修改：[src/features/novel/db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts)（V27 迁移）
- 修改：[src/features/novel/workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts)（F-002 修复）
- 修改：[src/features/novel/workflow-stages/revision-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/revision-stage.ts)（issues 注入）

## 与原方案差异说明

| 维度 | 原方案 | 本审核报告 | 理由 |
|------|--------|-----------|------|
| P0-1 顺序 | 第一优先级 | 移至 Phase B | v2 已 cutover，v2 能力短板更紧迫 |
| P0-2 完成度 | 全部未做 | 仅 P0-2a 完成（20%） | 实际进度核查 |
| Phase A 新增 | 无 | 紧急补齐 v2 能力 | 应对 v2 cutover 后的能力不足风险 |
| 优先级 | P0→P1→P2→P3 | A→B→C→D | 基于 v2 已 cutover 的实际状态调整 |
| 总体完成度 | — | ~5% | 实际进度核查 |
