# 小说创作架构审核与重构方案

## Summary

本项目是面向百万字长篇小说的 AI 创作系统，采用 **v1 IndexedDB 客户端 + v2 Postgres+Qdrant+Temporal+S3 服务端** 双栈并行架构。整体由"工作流编排 + 事实账本 + 分层记忆 + 技能/规则迭代"四层闭环构成，领域语言（[CONTEXT.md](file:///f:/GitHubProject/Ymcp/web/CONTEXT.md)）设计成熟，[AGENTS.md](file:///f:/GitHubProject/Ymcp/web/AGENTS.md) 四类契约（迭代改进、章节审校复用、经验沉淀、IndexedDB 删除）有明确实现。

本次审核基于 [AGENTS.md](file:///f:/GitHubProject/Ymcp/web/AGENTS.md) 契约与「架构阶段开发准则」，结论为：**v1 客户端实现完整但存在 12 个巨型文件与三份重复逻辑；v2 服务端架构设计干净但 activities 是 stub 级实现，无法替代 v1**。明确 v2 为目标架构后，需要：(1) 把 v1 的领域知识（prompt 工程、learning 评估、事实提取规则）回填到 v2；(2) 拆解 v1 巨型文件以便迁移；(3) 统一双栈类型与上下文构建逻辑；(4) 清理死代码与已知契约违反点。

本计划给出 P0/P1/P2/P3 全量重构方案与 v1→v2 迁移路径，可直接按章节执行。

## Current State Analysis

### 架构拓扑

```
src/
├── features/novel/           v1 客户端实现（IndexedDB）
│   ├── workflow.ts           工作流入口（24KB）
│   ├── workflow-stages.ts    Stage/Approval handler 接口（5.6KB）
│   ├── workflow-shared.ts    工作流共享工具（7.8KB）
│   ├── workflow-stages/      12 个 stage handler 实现
│   ├── types.ts              全领域类型（43KB）
│   ├── db.ts + db-schema.ts  Dexie schema（57KB + 21KB，26 个版本）
│   ├── generation.ts         14 生成任务定义（256KB ← 红线）
│   ├── skills.ts             内置技能 prompt（129KB ← 红线）
│   ├── ai.ts                 LLM 网关 + 13 角色 prompt（43KB）
│   ├── prose-prompts.ts      章节生成 prompt 模板（41KB）
│   ├── craft-rule-evolution.ts 规则迭代全生命周期（63KB）
│   ├── learning.ts + runtime-learning.ts 审校经验沉淀（16.7KB + 3.5KB）
│   ├── quality.ts            确定性质量检查（35KB）
│   ├── memory.ts + memory-service.ts + retrieval.ts 分层记忆 + 检索
│   ├── facts.ts              事实账本（43KB）
│   ├── creative-execution.ts 创意执行框架（54KB，与 workflow 双轨）
│   ├── creative-tool-gateway.ts MCP 工具网关（34KB）
│   ├── collaboration.ts + sync.ts + persistence.ts 协作/同步
│   ├── evaluation/           闭环评估
│   └── WorkflowCenter.tsx + AIWorkbench.tsx  UI 入口
└── novel-v2/                 v2 服务端实现（Postgres+Temporal）
    ├── protocol.ts           v2 协议类型（7.4KB）
    ├── cognition.ts          纯函数认知编排（11.4KB）
    ├── postgres-repository.ts Postgres 持久化（27KB）
    ├── temporal/workflows.ts Temporal 工作流（8.2KB）
    ├── temporal/activities.ts Activity 实现（10.2KB ← stub）
    ├── model-gateway.ts      LiteLLM 网关（3.1KB）
    ├── object-store.ts       S3/文件存储（3.7KB）
    ├── qdrant-memory.ts      向量记忆（2.7KB）
    └── commit-service.ts     双门提交（1.1KB）
```

### 关键数据

- **DB schema 演进**：26 个版本，RECORD_SCHEMA_VERSION=8，迁移函数 9 个分散在 [db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts)
- **领域类型**：单文件 43KB，60+ interface/type，覆盖 8 个子域
- **生成任务**：14 个（project-positioning / architecture / story-bible / characters / relations / worldview / plot-threads / foreshadowing / timeline / story-control / chapter-plan / scene-design / chapter-draft / review）
- **Stage handler**：12 个（context / blueprint / blueprint-approval / draft / deterministic-check / review / revision / manuscript-approval / fact-extraction / fact-approval / commit / character-enrichment）
- **内置技能**：9 项（story-facts-invariant / chapter-blueprint / embodied-prose / serial-rhythm / continuity-audit / style-specificity-audit / plot-pacing-audit / reader-audit / fact-delta-extraction）
- **测试**：v1 有 50+ 测试文件，v2 `__tests__/` 目录为空

## Audit Findings

### 模块级发现

#### 1. 工作流编排

##### 1.1 [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) — 调度器入口

**优点**：调度循环清晰（`for guard < 20`），handler 注册表模式可扩展，[startChapterReviewWorkflow](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts#L277) 严格落地 AGENTS.md「章节审校工作流复用」契约。

**问题**：
- **F-002 契约违反（TODO P1）**：[findReusableChapterBlueprint](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts#L122-L141) 的 fallback 路径用占位字符串伪造 `beats`/`startingState` 字段，违反 AGENTS.md「产物回填契约·保留 ChapterBlueprint 不存储的字段」要求。
- **TODO P2**：[workflow.ts:261](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts#L261) review-only 模式下 commit-stage 跳过 `createChapterMemory` 的去重策略未补充。
- **隐式契约破坏**：[startChapterReviewWorkflow 内部直接改写 prompt artifact](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts#L374-L377) 绕过 `saveArtifact` 抽象。
- **硬编码魔法值**：调度循环上限 20、stageIndex 计算依赖 `BUILTIN_CHAPTER_WORKFLOW.stages.indexOf`（O(n) 查找）。

##### 1.2 [workflow-stages/index.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/index.ts) + [workflow-stages.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages.ts) + [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts) — 三文件分裂

**优点**：注释显式说明是为打破 `workflow.ts ↔ workflow-stages/*.ts` 循环依赖。

**问题**：
- **`ArtifactInput` 重复定义**：在 [workflow-stages.ts:17](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages.ts#L17) 与 [workflow-shared.ts:189](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts#L189) 各一份，无编译期同步保证。
- 三文件分裂后职责割裂：常量在 shared、类型在 stages、入口在 workflow，定位成本高。

##### 1.3 stage handlers（[workflow-stages/*.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/)）

**问题**：
- **[deterministic-check-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/deterministic-check-stage.ts) 是死代码**：仅 480B，新流程不进入，仅在旧 run 恢复时被命中。
- **review-stage 与 revision-stage 重复段落编号逻辑**：`splitParagraphs` + `【第N段】` 编号各自实现。
- **issues 注入契约分层不一致**：`formatReviewIssuesForInstruction` 不在 stage 层（在 service.ts），revision-stage 只做段落级局部替换。AGENTS.md「review→revise→regenerate 闭环 issues 注入契约」分层脆弱。
- stage handler 通过共享模块（prose-prompts/quality/skills/context/memory-service/ai）隐式耦合，单测 mock 成本高。

#### 2. 类型系统 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts)（43KB）

**问题**：
- **巨型文件**：60+ interface/type 集中一处，未按子域拆分。
- **schema 演进包袱**：大量字段带"旧项目可缺省"注释（如 [ArchitecturePowerCenter.kind?](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts#L189)、[ArchitecturePhase.romanceProgress?](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts#L178)），违反架构阶段"允许破坏性变更"准则。
- **死枚举**：`WorkflowStage` 包含 `deterministic-check`（已废弃）。
- **重复枚举**：`NovelGenerationTaskKey`（14 项）与 `FoundationEvaluationTaskKey`（6 项）语义重叠。
- **`CraftRuleCandidate` 字段冗余**：`replay` 与 `replays`、`sourceReportIds` 与 `issueIds` 语义重叠。

#### 3. 数据库 schema

##### 3.1 [db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts)（21KB）

**问题**：
- **23 个版本快照噪音**：V4→V26 全 spread 叠加，V7/V11/V12/V13/V14/V16 是空 spread（仅"无变更"注释）。
- **迁移函数命名不统一**：`reset*` / `migrate*` / `cleanup*` 三种前缀，无注册表。
- **数据修复脚本混入**：`cleanupApprovalMetaPollution`、`cleanupPollutedMemorySummaries` 本质是修复脚本，与 schema 定义混在一处。

##### 3.2 [db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts)（57KB）

**问题**：
- **职责混杂**：Dexie schema + 40+ CRUD + `normalizeArchitecturePayload`（LLM 输出修复）+ formal mutation committer 注入 + 记忆失效传播，5 类职责混在一处。
- **循环依赖**：[db.ts → retrieval.ts → db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts#L57)（db 导入 `upsertEmbedding`，retrieval 又导入 `novelDb`）。
- **TODO P3 静默吞错**：db.ts 中 3 处 embedding 更新失败 `.catch(() => {})`（违反"失败应记录"原则）。
- **normalization 跨边界**：`normalizeArchitecturePayload` 在 db.ts 实现，被 generation.ts 在校验前调用，跨越了 db/generation 边界。

#### 4. 记忆体系

##### 4.1 [memory.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory.ts)（12.8KB）

**问题**：
- **反向依赖**：[memory.ts → memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory.ts)（底层模型依赖上层 service 的 `scheduleMemoryJob`），方向反了。
- **性能隐患**：`invalidateMemoryAncestors` BFS 传播 stale 状态，O(n²) 复杂度，大型项目（数百章节×多层记忆）可能成为瓶颈。

##### 4.2 [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts)（59KB）

**问题**：
- **巨型文件 + 6 类职责混杂**：协作对话线程 + brief CRUD + 检索候选构建 + 混合检索算法 + 任务证据 LLM 评估 + job 队列 worker。
- **`buildCandidates` 与 [context.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context.ts) 的 `compileNovelContext` 高度重叠**：都遍历 entities/relations/documents/threads/foreshadowing/facts/memories 构建候选源，是同一逻辑两份实现。
- **job worker 无 lease 续期**：`startMemoryJobWorker` 用 `setInterval` 轮询，但 `NovelMemoryJob` schema 有 `leaseOwner`/`leaseExpiresAt` 字段未使用。

##### 4.3 [retrieval.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/retrieval.ts)（5.9KB）

**优点**：小巧聚焦。

**问题**：`hybridScore` 默认权重 `keyword:0.4/vector:0.6` 硬编码，无项目级配置入口。

#### 5. 事实账本 [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts)（43KB）

**问题**：
- **反向依赖 generation.ts**：导入 `normalizedCreate`，是 generation.ts 难以拆分的根因之一。
- **脆弱字段镜像**：`PreparedFactCandidates` 含 11 个丢弃计数字段，在 fact-extraction-stage.ts 与 commit-stage.ts L67-84 重复展开。
- **职责混杂**：`createWorkflowSnapshot` 与事实提交混在同一文件。

#### 6. 文风/技能

##### 6.1 [skills.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/skills.ts)（129KB）

**问题**：
- **129KB 中绝大部分是 `BUILTIN_NOVEL_SKILLS` 常量 prompt 文本**，真正代码 < 10KB。应抽到独立 YAML 资源文件。
- **热点函数无缓存**：`resolveNovelSkills` 每次调用都重新查 db + 解析 YAML + 按版本排序，被几乎所有 stage 调用。
- **与 [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 隐式耦合**：promote 后通过 `nextPatchVersion` 更新 prompt，但 skills.ts 不知道这是规则迭代产物。

##### 6.2 [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts)（63KB）

**问题**：
- **反向依赖 generation.ts**：导入 `getGenerationTask`。
- **架构阶段阻塞点**：候选评测需 `requireCrossScenarioEvidence`（3 组对照/3 任务/3 场景），架构阶段无法满足。约束硬编码在 gate 评估中，无项目阶段感知。
- 单文件 63KB 承载规则迭代全部逻辑。

##### 6.3 [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts)（41KB）

**问题**：
- 41KB 几乎全是模板字符串，与 skills.ts 同样"代码+大段文本"混杂。
- 与 `BUILTIN_NOVEL_SKILLS` prompt 文本语义重叠，边界不清：哪些指导放技能 prompt、哪些放 prose-prompts？无明确契约。

#### 7. 审核闭环

##### 7.1 [learning.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/learning.ts)（16.7KB）

**优点**：落地 AGENTS.md「经验沉淀」契约完整。

**问题**：
- **F-004/F-005 lost-update 修复痕迹明显**：并发控制逻辑散落多个函数，无统一封装。
- **TODO P2**：[learning.ts:270](file:///f:/GitHubProject/Ymcp/web/src/features/novel/learning.ts#L270) `LEARNING_STALENESS_MS = 120_000` 与评估超时耦合，应集中到 config。
- **prompt 超预算风险**：`assessQualityReportLearning` 把 skill 完整 prompt 全文塞入 targetCatalog，对长技能 prompt 会超 token 预算，无显式截断。

##### 7.2 [quality.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality.ts)（35KB）

**问题**：
- `runDeterministicQualityChecks` 单函数承担 8 维度机械模式检测。
- `QUALITY_SCORING_VERSION=3` 版本管理散落在 quality.ts 与 review-stage.ts 两处。

##### 7.3 [manuscript-review.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/manuscript-review.ts)（12.3KB）

**问题**：`applyManuscriptChanges` 内联正则 wordCount 与 `quality.ts` 的 `countNovelWords` 重复实现。

#### 8. 协作/同步

##### 8.1 [collaboration.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/collaboration.ts) + [sync.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/sync.ts) + [persistence.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/persistence.ts)

**问题**：
- **IndexedDB 删除契约散落**：`closeProposal`/`rejectProposal`/`deleteLocalProject`/`removeProject` 实际散布在 [bootstrap.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/bootstrap.ts)、[OutlineProposalReview.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/OutlineProposalReview.tsx)、[generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts)，未集中审计。
- [sync.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/sync.ts) WebSocket 订阅无重连/心跳/错误处理。
- [persistence.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/persistence.ts) 4 个独立小工具无强关联，`requestDurableBrowserStorage` 是浏览器 API 包装应放共享工具层。

#### 9. AI 网关

##### 9.1 [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts)（43KB）

**问题**：
- **`ROLE_PROMPTS` 13 角色 prompt 硬编码**（L20-105），与 skills.ts/prose-prompts.ts 构成三处 prompt 源，无统一治理。
- **`NovelConversationContext` 接口 260+ 行定义在文件中部**，与 ai.ts 主职责不匹配。
- 重试次数/退避策略硬编码（3-5 次 + 3s/5s/8s/12s/15s），无配置入口。
- `DEFAULT_NOVEL_TEXT_MODEL = "gpt-5-5"` 硬编码（用户偏好）。

##### 9.2 [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts)（256KB） — **最大架构红线**

**问题**：
- **256KB 单文件**包含 14 个生成任务的 schema + validator + prompt 拼装 + audit 循环 + proposal CRUD，必须拆分。
- **`normalizedCreate` 被外部模块导入**（facts.ts、craft-rule-evolution.ts），是耦合根因。
- **TODO P2**：L473/L517 update 路径只校验 `minProperties:1`，未校验内部结构。
- **TODO P3**：L2189 诊断临时文件写入残留。
- 直接 import `node:fs`/`node:os`/`node:path` 写文件，浏览器环境会报错（除非 polyfill），暗示部分功能只能在 Node 环境（service worker / MCP server）运行。

##### 9.3 [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts)（54KB）

**问题**：
- **与 [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) 职责重叠**：实现了另一套 `CreativeRun`/`CreativeWorkItem` 状态机，与 `WorkflowRun` 平行，是架构阶段最大的双轨问题。
- `buildChapterEvaluationContextSnapshot` 150+ 行，与 memory-service.ts `buildCandidates` 又一轮重叠。
- `defaultReviewer` 单函数 250+ 行，承载内门+外门+issues 聚合+gate 决策。

##### 9.4 [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts)（34KB）

**问题**：34KB 单文件承载所有 MCP 工具分发，每新增工具就要改此文件。应改为注册表模式。

#### 10. 服务端 v2 [src/novel-v2/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/)

##### 10.1 [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) — 设计干净

**问题**：与 [src/features/novel/types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 完全独立，两套类型系统无共享基础。`MemoryClaim`(v2) vs `FactAssertion`/`DerivedMemory`(v1) 语义重叠但字段不同；`Review`(v2) vs `QualityReport`/`CreativeReview`(v1) 同样。

##### 10.2 [cognition.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts) — 设计干净

**问题**：
- `classify` 用正则匹配意图文本（`/审核|审校/`），脆性识别。
- `buildMemoryBundle` token 预算 24_000 硬编码。

##### 10.3 [postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts)（27KB）

**问题**：
- **`recordFactExtraction` 是玩具级实现**：按标点分句、取前 12 条、confidence 固定 0.62。与 v1 `prepareFactCandidates` 11 类去重/校验严重不对等。
- **`listSkills` 忽略 `_projectId` 参数**（L141），所有项目共享技能表，与 v1 项目级 skill binding 不一致。
- 无内置 outbox poller，需调用方处理投递。

##### 10.4 [temporal/activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts) — **stub 级实现，最大 v2 红线**

**问题**：
- **`assessLearning` 是 stub**（L56-79）：blocking issues > 0 就硬编码 "propose-improvement" + 模板化 `afterText`，不调用 LLM。**违反 AGENTS.md「learning.underlyingMechanism/affectedInputClass 在 conclusion=propose-improvement 时必填」契约**——stub 里 mechanism 是固定字符串。
- `draft`/`review`/`revise` activity 的 prompt 极简，与 v1 [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) 41KB 精心设计不在一个量级。
- `review` schema 是 `{ verdict: [...], issues: [] }`，无 issue severity/evidence 字段约束，LLM 输出无校验。

##### 10.5 [temporal/workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)

**问题**：修订只跑 1 轮（L61-67），无 v1 `shouldAutoRevise` 改善度判断与多轮迭代，与 v1 `maxAutoRevisions=2` 不对等。

##### 10.6 [model-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts)

**问题**：
- `generateStructured` 把 schema 拼到 prompt 末尾让 LLM 返回 JSON 再 `JSON.parse`，无 strict-mode JSON schema 支持，与 v1 ajv 严格校验能力不对等。
- 全文 `any` 类型，无类型安全。
- 与 v1 [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) 完全独立，无共享重试/限流/model 选择。

##### 10.7 v2 测试缺失

[src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 目录为空，v2 全栈无单元测试，与其"目标架构"地位严重不匹配。

#### 11. UI 入口

##### 11.1 [WorkflowCenter.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/WorkflowCenter.tsx)（20KB）

**问题**：单组件承载工作流全部 UI，应按 stage 拆分；直接调用业务函数，无 ViewModel 层。

##### 11.2 [AIWorkbench.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/AIWorkbench.tsx)（8KB）

**问题**：
- `MarkdownContent` 通用渲染组件却从 AIWorkbench 导出供 WorkflowCenter 使用，应抽独立文件。
- `scope` props 死参数。
- `useEffect(() => startMemoryJobWorker(projectId), [projectId])` 无 cleanup，多实例切换会泄漏。

### 跨模块架构问题汇总

#### A. 双栈架构分裂（v1 vs v2）

- **现象**：[src/features/novel/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/) 与 [src/novel-v2/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/) 是两套完整实现，类型不共享、逻辑不对等、prompt 量级差异巨大。
- **根因**：v2 是服务端重写，但 v1 未废弃，两者并行演进。
- **影响**：维护成本翻倍；v2 activities 是 stub 级实现，无法替代 v1；新功能要双写。

#### B. 巨型文件（12 个 > 30KB）

| 文件 | 大小 | 主要内容 |
|------|------|----------|
| [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts) | 256KB | 14 任务的 schema+validator+prompt+audit |
| [skills.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/skills.ts) | 129KB | 内置技能 prompt 文本 |
| [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) | 63KB | 规则候选全生命周期 |
| [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) | 59KB | 检索+对话+job worker |
| [db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts) | 57KB | schema+CRUD+normalizer+committer |
| [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) | 54KB | 创意执行框架 |
| [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) | 43KB | 事实候选全流程 |
| [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) | 43KB | 全部领域类型 |
| [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) | 43KB | LLM 调用+角色 prompt |
| [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) | 41KB | prompt 模板 |
| [quality.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality.ts) | 35KB | 确定性检查 |
| [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) | 34KB | MCP 工具分发 |

#### C. 三处 prompt 源无统一治理

- [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) 的 `ROLE_PROMPTS`（13 角色 prompt）
- [skills.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/skills.ts) 的 `BUILTIN_NOVEL_SKILLS`
- [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) 模板

三者语义重叠（都涉及写作风格指导），无明确边界契约。

#### D. 上下文构建逻辑三份实现

- [context.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context.ts) 的 `compileNovelContext`
- [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) 的 `buildCandidates` + `hybridRetrieve`
- [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) 的 `buildChapterEvaluationContextSnapshot`

三者都遍历 entities/relations/documents/threads/foreshadowing/facts/memories 构建候选源，是同一逻辑的演进副本。

#### E. 反向依赖巨型文件

- [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) → [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts)（`normalizedCreate`）
- [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) → [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts)（`getGenerationTask`）
- [memory.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory.ts) → [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts)（`scheduleMemoryJob`）

这些反向依赖是 generation.ts 难以拆分的主要原因。

#### F. 双轨状态机（CreativeRun vs WorkflowRun）

- [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) 的 `WorkflowRun` + 12 个 stage handler
- [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) 的 `CreativeRun` + `CreativeWorkItem` 命令路由

两者都管理"生成→审核→修订→提交"闭环，但用了不同术语和不同 db 表。

#### G. AGENTS.md 契约符合度

| 契约 | 符合度 | 说明 |
|------|--------|------|
| 迭代改进与根因分析 | ✅ | runtime-learning.ts 严格校验 underlyingMechanism 必填 |
| 章节审校工作流复用 | ⚠️ | startChapterReviewWorkflow 复用正确，但 F-002 TODO P1 degraded blueprint 占位字段违反「产物回填契约」 |
| 经验沉淀与技能/提示词迭代 | ⚠️ | v1 链路完整，但 **v2 activities.assessLearning 是 stub，违反同一契约** |
| IndexedDB 删除/关闭契约 | ⚠️ | API 散布在 bootstrap/OutlineProposalReview/generation，未集中审计 |

#### H. TODO 标注合规

抽查发现 TODO 标注整体合规，但 generation.ts 256KB 文件本身的拆分未被标注为 TODO，应补充。

## Proposed Changes（全量重构方案）

> 重构顺序遵循"先解耦、再迁移、后清理"原则。每个阶段独立可验证，不破坏现有 v1 功能。

### 阶段 P0：解耦红线 + v2 能力补齐（4-6 周）

#### P0-1 拆分 [generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts) 256KB 巨型文件

**目标**：按任务拆为 14 个独立模块 + 抽出公共工具，消除 facts.ts/craft-rule-evolution.ts 的反向依赖。

**目标文件结构**：

```
src/features/novel/generation/
├── index.ts                    # 导出 NOVEL_GENERATION_TASKS + getGenerationTask + tasksForScope
├── types.ts                    # GenerationTaskDefinition + RefinementSnapshot
├── proposal-utils.ts           # normalizedCreate + updateProposalItemPayload（被 facts.ts/craft-rule-evolution.ts 导入）
├── proposal-service.ts         # rejectProposal + regenerateProposalItem + applyProposalItems
├── refinement-snapshot.ts      # fingerprintRefinementSnapshot + buildRefinementSnapshot
├── payload-contract.ts         # PAYLOAD_CONTRACT_BY_TABLE + buildPayloadContract
├── naming-constraint.ts        # NAMING_LITERARY_CONSTRAINT 常量
├── tasks/
│   ├── project-positioning.ts
│   ├── architecture.ts         # 含 validateArchitectureHardConstraints
│   ├── plot-design.ts          # 含 validatePlotDesignItems + runPlotDesignTask
│   ├── story-bible.ts
│   ├── characters.ts
│   ├── relations.ts
│   ├── worldview.ts
│   ├── plot-threads.ts
│   ├── foreshadowing.ts
│   ├── timeline.ts
│   ├── story-control.ts
│   ├── chapter-plan.ts
│   ├── scene-design.ts
│   ├── chapter-draft.ts
│   └── review.ts
├── audit/
│   ├── plot-segment-audit.ts   # runPlotSegmentAudit + retainGroundedPlotAuditIssues
│   └── shared.ts               # auditIssueSchema + hasMajorOrBlocker + formatAuditFindingsForRerun
└── run.ts                      # runGenerationTask + runRefinementTask（编排各 task）
```

**迁移步骤**：

1. 创建 `src/features/novel/generation/` 目录
2. 抽出 `proposal-utils.ts`：把 `normalizedCreate`、`updateProposalItemPayload` 等被外部导入的工具移入；原 generation.ts 重新导出以保持向后兼容
3. 抽出 `audit/shared.ts`：把 [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts) 中 audit 相关常量（`auditIssueSchema`、`hasMajorOrBlocker`、`formatAuditFindingsForRerun`）迁移过来（保留 workflow-shared.ts 重新导出避免破坏现有导入）
4. 按 14 个任务拆分 `tasks/*.ts`：每个文件包含该任务的 schema、validator、prompt 拼装
5. 抽出 `audit/plot-segment-audit.ts`：architecture/plot-design 任务的 audit 循环
6. 修改 [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) 导入路径：`from "./generation"` → `from "./generation/proposal-utils"`
7. 修改 [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 导入路径：`from "./generation"` → `from "./generation"`
8. 删除原 generation.ts，[generation/index.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation/index.ts) 重新导出所有公共 API
9. 运行 `pnpm test` 验证全部测试通过
10. 移除 generation.ts 中 `node:fs`/`node:os`/`node:path` import（迁移诊断临时文件到 dev-only 脚本）

**验证**：
- `pnpm lint` 通过
- `pnpm test` 全部通过
- 单文件最大 < 50KB
- facts.ts 与 craft-rule-evolution.ts 不再 import 自 `./generation`（而是 `./generation/proposal-utils` 或 `./generation`）

#### P0-2 v2 activities 落地真实逻辑

**目标**：把 v1 的领域知识回填到 [temporal/activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts)，使其达到 v1 等级。

**子任务**：

##### P0-2a 修复 `assessLearning` stub（契约违反）

- **当前**：[activities.ts:56-79](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts#L56-L79) blocking issues > 0 硬编码 "propose-improvement"
- **目标**：调用真实 LLM 评估，校验 `underlyingMechanism`/`affectedInputClass` 必填
- **实现**：
  1. 把 [runtime-learning.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/runtime-learning.ts) 的 `parseRuntimeLearningAssessment` 函数迁移到 [src/novel-v2/cognition.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/cognition.ts)
  2. 把 [learning.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/learning.ts) 的 `assessQualityReportLearning` prompt 模板迁移到 [src/novel-v2/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/) 下新文件 `learning-assessment.ts`
  3. activities.assessLearning 调用 modelGateway.generateStructured + parseRuntimeLearningAssessment
  4. 校验失败时返回 `no-shared-learning` 而非硬编码 propose-improvement

##### P0-2b 升级 `draft`/`review`/`revise` prompt

- **当前**：[activities.ts:34-49](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts#L34-L49) prompt 极简
- **目标**：复用 v1 [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) 的 prompt 模板
- **实现**：
  1. 把 prose-prompts.ts 的 `buildChapterDraftPrompt`、`buildChapterReviewPrompt` 迁移到 [src/novel-v2/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/) 下新文件 `prompts/chapter-draft.ts`、`prompts/chapter-review.ts`
  2. activities.draft/review/revise 调用这些函数构造 prompt
  3. review activity 的 schema 改为复用 [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts) 的 `reviewerSchema`

##### P0-2c 升级 `extractFacts` 到 v1 等级

- **当前**：[postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts) 的 `recordFactExtraction` 是按标点分句的玩具实现
- **目标**：复用 v1 [facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts) 的 11 类去重/校验逻辑
- **实现**：
  1. 把 facts.ts 的 `prepareFactCandidates`、`classifyFactRisk`、`dedupeCharacterFactCandidates` 等纯函数迁移到 [src/novel-v2/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/) 下新文件 `fact-extraction/`
  2. activities.extractFacts 调用 LLM 提取 + 这些纯函数处理
  3. recordFactExtraction 改为接受已处理的 FactClaim[]，不再做分句

##### P0-2d 升级 `review` 多轮修订

- **当前**：[workflows.ts:61-67](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts#L61-L67) 修订只跑 1 轮
- **目标**：复用 v1 `shouldAutoRevise` 改善度判断，支持 `maxAutoRevisions=2`
- **实现**：在 workflows.ts 中加入循环 + shouldAutoRevise 判断

##### P0-2e 升级 [model-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts)

- **目标**：支持 strict-mode JSON schema
- **实现**：
  1. `generateStructured` 改为传入 schema 给 LiteLLM 的 `response_format` 参数（OpenAI 兼容）
  2. 移除 `any` 类型，改为泛型 `<T>`
  3. 加入 ajv 校验 + 失败重试（与 v1 [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) 一致）

**验证**：
- 新增 [src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 测试目录
- assessLearning 测试：mock LLM 返回 → 验证 mechanism 必填校验
- draft/review/revise 测试：mock LLM → 验证 prompt 拼装
- extractFacts 测试：mock LLM → 验证 11 类去重
- 多轮修订测试：mock review verdict 变化 → 验证 shouldAutoRevise 判断

#### P0-3 统一 v1/v2 共享类型

**目标**：消除 [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) 与 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 的类型分裂。

**实现**：

1. 创建 [src/novel-v2/shared-types/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/shared-types/) 目录
2. 抽出共享类型（按子域）：
   - `shared-types/fact.ts`：`FactAssertion`、`KnowledgeAssertion`、`FactCandidate`、`ExtractedFact`（v2 `MemoryClaim` 改为引用此处的 `FactAssertion`）
   - `shared-types/memory.ts`：`DerivedMemory`、`NarrativeUnit`、`MemoryJob`
   - `shared-types/review.ts`：`QualityReport`、`QualityIssue`、`ReviewerFinding`、`Review`（v2 `Review` 改为引用此处的 `QualityReport` 子集）
   - `shared-types/skill.ts`：`NovelSkillManifest`、`SkillDescriptor`、`SkillBundle`
   - `shared-types/artifact.ts`：`WorkflowArtifact`、`Artifact`（统一为 `Artifact`）
   - `shared-types/workflow.ts`：`WorkflowRun`、`WorkflowStage`、`NovelStage`（统一枚举）
3. v1 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 重新导出 shared-types
4. v2 [protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts) 重新导出 shared-types
5. 删除 v2 `MemoryClaim`/`Review`/`MemoryHit` 等重复定义

**验证**：
- `pnpm lint` 通过
- v1 与 v2 类型可互相赋值（编译期校验）
- 不再有两套 `Review`/`FactAssertion` 定义

### 阶段 P1：合并重复逻辑 + 拆分巨型文件（4-6 周）

#### P1-1 统一上下文构建逻辑

**目标**：合并三份重复实现（context.ts / memory-service.ts / creative-execution.ts）为单一服务。

**实现**：

1. 创建 [src/features/novel/context-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context-service.ts)（新文件，< 30KB）
2. 把 [context.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context.ts) 的 `compileNovelContext` 主体逻辑迁移过来
3. 把 [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) 的 `buildCandidates` 合并进来（删除原函数，调用方改用 context-service）
4. 把 [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) 的 `buildChapterEvaluationContextSnapshot` 合并进来
5. 保留 context.ts 中角色权限白名单（`ROLE_SOURCE_KINDS`、`FOUNDATION_TASK_SOURCE_WHITELIST`）作为 context-service 的配置
6. 三个原文件保留 re-export shim 不破坏导入

**验证**：
- 现有 50+ 测试全部通过
- 新增 context-service.test.ts 覆盖 3 类场景（章节生成 / 协作对话 / 闭环评估）

#### P1-2 统一 prompt 治理

**目标**：把三处 prompt 源统一到独立资源目录。

**实现**：

1. 创建 [src/features/novel/prompts/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prompts/) 目录
2. 抽出资源文件（YAML 格式，便于版本控制与 diff）：
   - `prompts/roles/*.yaml`：13 个角色 prompt（从 [ai.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ai.ts) `ROLE_PROMPTS` 抽出）
   - `prompts/skills/*.yaml`：9 个内置技能 prompt（从 [skills.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/skills.ts) `BUILTIN_NOVEL_SKILLS` 抽出）
   - `prompts/prose/draft.ts`、`prompts/prose/review.ts`：从 [prose-prompts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prose-prompts.ts) 抽出（保留 TypeScript 因为有模板逻辑）
3. 创建 `prompts/loader.ts`：统一加载 + 缓存机制
4. 三个原文件保留导出，但改为从 prompts/ 加载
5. 在 [AGENTS.md](file:///f:/GitHubProject/Ymcp/web/AGENTS.md) 追加「Prompt 边界契约」章节，明确：
   - 角色 prompt（roles/）：定义 agent 身份与职责边界
   - 技能 prompt（skills/）：定义可迭代的创作规则
   - prose 模板（prose/）：定义章节生成/审核的具体模板

**验证**：
- 所有 prompt 文本可被独立 diff（YAML 格式）
- skills.ts 文件 < 20KB（仅保留加载/解析逻辑）
- ai.ts 文件 < 30KB（仅保留 LLM 调用）
- prose-prompts.ts 文件 < 15KB

#### P1-3 拆分 [db.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db.ts) 57KB

**目标**：把 schema / CRUD / normalizer / mutation-committer 分离。

**实现**：

1. 创建 [src/features/novel/db/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db/) 目录
2. 拆分：
   - `db/index.ts`：NovelDatabase 类 + novelDb 单例（< 10KB）
   - `db/schema.ts`：从 [db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts) 迁移（保留原文件作为 re-export）
   - `db/migrations/`：每个迁移函数独立文件（`reset-planning-hierarchy.ts`、`migrate-outline-node.ts` 等）+ `migrations/registry.ts` 注册表
   - `db/repository.ts`：40+ CRUD 函数
   - `db/normalizers.ts`：`normalizeArchitecturePayload`、`normalizeArchitecturePhases` 等 LLM 输出修复
   - `db/mutation-committer.ts`：`setFormalMutationCommitter`、`commitThroughRuntime`
3. 修复 `db.ts → retrieval.ts → db.ts` 循环依赖：retrieval.ts 不再导入 `novelDb`，改为接受 `NovelDatabase` 参数
4. 修复 TODO P3 静默吞错：3 处 `.catch(() => {})` 改为 `.catch((err) => console.warn("embedding update failed", err))`

**验证**：
- db/index.ts < 10KB
- db/repository.ts < 30KB
- 无循环依赖（`pnpm lint` 通过）
- 3 处 TODO P3 移除

#### P1-4 合并 CreativeRun 与 WorkflowRun 双轨状态机

**目标**：消除 [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) 与 [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) 的双轨。

**实现**：

1. 评估两者职责：
   - WorkflowRun：标准章节工作流（context → blueprint → draft → review → revision → commit）
   - CreativeRun：闭环评估/外部 LLM 协同（work.start/recover/retry/revise/commit）
2. 把 CreativeRun 的命令路由（start/recover/retry/revise）合并为 WorkflowRun 的高级命令（保留原有 stage handler）
3. CreativeWorkItem 改为 WorkflowArtifact 的子类型（kind: "creative-work"）
4. CreativeReview 改为 QualityReport 的子类型
5. 删除 [creative-execution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-execution.ts) 中的状态机部分，保留 `buildChapterEvaluationContextSnapshot`（已在 P1-1 迁出）
6. [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) 改为调用 workflow.ts API

**注意**：这是破坏性变更，需要更新所有调用方（UI、MCP 工具网关、测试）。

**验证**：
- 仅一套 WorkflowRun 状态机
- creative-tool-gateway.ts 调用 workflow.ts API
- 所有现有测试通过（更新测试以使用新 API）

#### P1-5 拆分 [memory-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/memory-service.ts) 59KB

**目标**：按职责拆为 4 个文件。

**实现**：

1. `memory-service.ts`（< 15KB）：接口 + 工厂 + DexieNovelMemoryService/HttpNovelMemoryService
2. `retrieval-service.ts`（< 20KB）：`buildCandidates` + `hybridRetrieve` + RRF 融合（候选构建部分在 P1-1 已部分迁移到 context-service）
3. `memory-job-worker.ts`（< 10KB）：`scheduleMemoryJob` + `runPendingMemoryJobs` + `startMemoryJobWorker` + lease 续期
4. `conversation-service.ts`（< 15KB）：协作对话线程 + brief CRUD
5. 修复 `memory.ts → memory-service.ts` 反向依赖：`scheduleMemoryJob` 下沉到 memory-job-worker.ts，memory.ts 改为导入 memory-job-worker
6. `startMemoryJobWorker` 加入 lease 续期机制（使用 `NovelMemoryJob.leaseOwner`/`leaseExpiresAt`）

**验证**：
- 单文件 < 20KB
- memory.ts 不再反向依赖 memory-service
- job worker 有 lease 续期

#### P1-6 拆分 [craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 63KB

**目标**：按子域拆分。

**实现**：

1. `craft-rule/chapter-eval.ts`：`evaluateCraftRuleOnChapter` + `supportsChapterRuleEvaluation`
2. `craft-rule/foundation-eval.ts`：`evaluateCraftRuleOnFoundation` + `supportsFoundationRuleEvaluation` + `FOUNDATION_EVALUATION_TASKS`
3. `craft-rule/promotion.ts`：`promoteCraftRuleCandidate` + `evaluateCraftRuleGate` + `evaluateCraftRuleObservationGate`
4. `craft-rule/rollback.ts`：`rollbackCraftRuleCandidate`
5. `craft-rule/capture.ts`：`captureChapterRuleReplay` + `captureFoundationRuleReplay` + `createCraftRuleCandidateFromLearning`
6. `craft-rule/index.ts`：重新导出
7. 加入"项目阶段感知"：`evaluateCraftRuleGate` 接受 `projectPhase: "architecture" | "drafting"` 参数，架构阶段放宽 `requireCrossScenarioEvidence`

**验证**：
- 单文件 < 20KB
- 架构阶段项目可 promote 候选（不再被 cross-scenario 阻塞）

#### P1-7 拆分 [creative-tool-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/creative-tool-gateway.ts) 34KB

**目标**：改为注册表模式。

**实现**：

1. 创建 [src/features/novel/tools/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/tools/) 目录
2. 每个工具独立文件：`tools/novel-create.ts`、`tools/novel-change-patch.ts`、`tools/novel-blueprint-run.ts` 等
3. 每个工具导出 `defineCreativeTool({ name, scope, execute })`
4. `tools/index.ts` 自动注册所有工具
5. creative-tool-gateway.ts 改为 < 10KB 的 thin dispatcher

**验证**：
- 新增工具只需创建一个文件
- creative-tool-gateway.ts < 10KB

### 阶段 P2：清理死代码 + 修复契约违反（2-3 周）

#### P2-1 删除 [deterministic-check-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/deterministic-check-stage.ts) 死代码

**实现**：
1. 删除文件
2. 从 [workflow-stages/index.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/index.ts) 移除注册
3. 从 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) `WorkflowStage` 枚举移除 `"deterministic-check"`
4. 在 [db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts) 新增 V27 迁移：把所有 `currentStage === "deterministic-check"` 的 WorkflowRun 迁移到 `"review"`
5. 从 [workflow-shared.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-shared.ts) `BUILTIN_CHAPTER_WORKFLOW.stages` 移除

**验证**：
- 现有测试通过
- 旧 run 恢复后正确进入 review 阶段

#### P2-2 修复 F-002 TODO P1 契约违反

**实现**：
1. 在 [db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts) 新增 V27 迁移：把所有 `document.blueprint` 补全 `beats`/`startingState` 字段（从历史 blueprint artifact 读取并持久化）
2. 修改 [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) `findReusableChapterBlueprint` fallback 路径：不再用占位字符串，改为从 `document.blueprint.beats`/`startingState` 读取（V27 迁移保证字段存在）
3. 删除 `DEGRADED_PLACEHOLDER` 常量与相关 TODO P1 注释
4. 修改 [blueprint-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/blueprint-stage.ts)：生成 blueprint 时把 `beats`/`startingState` 写入 `document.blueprint`（目前只存在 artifact 中）

**验证**：
- `pnpm test` 全部通过
- 不再有 TODO P1 标注
- degraded 模式下 reviewer 拿到真实 beats/startingState

#### P2-3 修复 [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) TODO P2

**实现**：
1. 在 [commit-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/commit-stage.ts) 加入 review-only 模式检测（`run.conversationThreadId === undefined && run.contextPacketId`）
2. review-only 模式下 `createChapterMemory` 调用 `novelty` 字段去重，避免重复创建
3. 移除 TODO P2 注释

#### P2-4 集中 IndexedDB 删除契约 API

**实现**：
1. 创建 [src/features/novel/lifecycle.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/lifecycle.ts)（新文件）
2. 集中导出：`closeProposal`、`rejectProposal`、`deleteLocalProject`、`removeProject`、`deleteCollaborativeDocument`
3. 修改 [bootstrap.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/bootstrap.ts)、[OutlineProposalReview.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/OutlineProposalReview.tsx)、[generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts) 改为从 lifecycle.ts 导入
4. 在 [AGENTS.md](file:///f:/GitHubProject/Ymcp/web/AGENTS.md) 「IndexedDB 删除/关闭契约」章节追加："所有删除/关闭 API 必须从 lifecycle.ts 导出，禁止散落实现"
5. 加入集中测试：覆盖 legacyReadOnly 模式 + runtime 不可达场景

**验证**：
- 全项目 grep `closeProposal`/`rejectProposal`/`deleteLocalProject`/`removeProject` 仅在 lifecycle.ts 中定义
- 测试覆盖 AGENTS.md 全部 4 条删除契约子项

#### P2-5 修复 issues 注入契约分层

**实现**：
1. 把 `formatReviewIssuesForInstruction` 从 service.ts 迁移到 [revision-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/revision-stage.ts)
2. revision-stage 在调用 LLM 修订前显式注入 issues 到 instruction
3. 加入测试：验证 revision-stage 调用 LLM 时 instruction 包含完整 issues 列表

#### P2-6 v2 测试补齐

**目标**：[src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 至少覆盖核心路径。

**实现**：
1. `cognition.test.ts`：preflight/memory-bundle/context-manifest/skill-bundle/blueprint 编排
2. `activities.test.ts`：mock LLM → 验证 draft/review/revise/extractFacts/assessLearning/commit
3. `postgres-repository.test.ts`：用 testcontainers 起 Postgres → 验证 CRUD + 幂等提交 + outbox
4. `workflows.test.ts`：Temporal integration test → 验证多轮修订 + 信号处理

**验证**：
- v2 测试覆盖率 > 60%

### 阶段 P3：长期清理（持续）

#### P3-1 拆分 [types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts) 43KB

**实现**：按子域拆分到 [src/features/novel/types/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types/) 目录：
- `types/project.ts`、`types/architecture.ts`、`types/document.ts`、`types/workflow.ts`、`types/fact.ts`、`types/memory.ts`、`types/skill.ts`、`types/craft-rule.ts`、`types/canvas.ts`、`types/sync.ts`
- `types/index.ts` 重新导出
- 收敛"旧项目可缺省"字段（架构阶段允许破坏性变更）

#### P3-2 拆分 [quality.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality.ts) 35KB

**实现**：按维度拆分到 [src/features/novel/quality-rules/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality-rules/) 目录：
- `quality-rules/summary-telling.ts`、`quality-rules/template-language.ts`、`quality-rules/hook-pressure.ts` 等
- `quality-rules/index.ts` 注册表
- `quality.ts` 仅保留 `aggregateQuality`、`saveQualityReport`、`countNovelWords`

#### P3-3 统一 wordCount 实现

**实现**：
- [manuscript-review.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/manuscript-review.ts) 的内联正则 wordCount 改为调用 [quality.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality.ts) 的 `countNovelWords`

#### P3-4 UI 拆分

**实现**：
- [WorkflowCenter.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/WorkflowCenter.tsx) 20KB 按 stage 拆为 `BlueprintApprovalPanel`/`ManuscriptApprovalPanel`/`FactApprovalPanel`/`QualityReportPanel`
- 抽出 `MarkdownContent.tsx` 独立文件
- 删除 AIWorkbench 的 `scope` 死参数
- 修复 `useEffect(() => startMemoryJobWorker(projectId), [projectId])` 无 cleanup 问题

#### P3-5 移除 [persistence.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/persistence.ts)

**实现**：
- `createManuscriptPersistenceGuard`、`shouldApplyStoredManuscriptContent` 合并到 [ChapterCollaboration.tsx](file:///f:/GitHubProject/Ymcp/web/src/features/novel/ChapterCollaboration.tsx)
- `requestDurableBrowserStorage` 移到 [src/shared/](file:///f:/GitHubProject/Ymcp/web/src/shared/)

#### P3-6 v1 → v2 完整迁移

**前置条件**：P0-2、P0-3、P1 全部完成。

**实现**：
1. v2 activities 达到 v1 等级后，UI 改为调用 v2 API（通过 [sync.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/sync.ts) HttpNovelSyncAdapter）
2. IndexedDB 降级为缓存层（仅缓存当前分卷 + 近期章节）
3. 删除 v1 stage handlers（保留 [workflow.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow.ts) 作为 v2 API 的客户端 wrapper）
4. 删除 v1 大文件：generation/skills/craft-rule-evolution/facts/quality/memory-service 的 v1 实现部分（保留类型定义与 prompt 资源）
5. 在 [CONTEXT.md](file:///f:/GitHubProject/Ymcp/web/CONTEXT.md) 「Current implementation boundary」章节更新：v2 成为权威存储

**验证**：
- 完整章节生成流程跑通（v2 activities 编排）
- 离线模式仍可工作（IndexedDB 缓存 + 离线操作队列）
- 项目归档包导入导出兼容

## v1 → v2 迁移路径

### 阶段 1（P0 完成后）：v2 单功能可投产

- v2 activities 的 draft/review/revise/extractFacts/assessLearning 达到 v1 等级
- v2 类型与 v1 共享
- v2 测试覆盖核心路径
- **可投产场景**：通过 MCP 工具或 CLI 触发的单次创作任务（不依赖 UI）

### 阶段 2（P1 完成后）：v2 全功能可投产

- v1 巨型文件拆分完成，逻辑可迁移
- 上下文构建统一
- prompt 治理统一
- **可投产场景**：UI 切换到 v2 API，v1 IndexedDB 降级为缓存

### 阶段 3（P2 完成后）：v1 标记废弃

- 死代码清理
- 契约违反修复
- v2 测试补齐
- **可投产场景**：v2 成为主路径，v1 进入维护模式（仅修严重 bug）

### 阶段 4（P3-6 完成后）：v1 删除

- v1 实现代码删除（保留类型与 prompt 资源）
- IndexedDB 仅作缓存层
- [CONTEXT.md](file:///f:/GitHubProject/Ymcp/web/CONTEXT.md) 更新

## Assumptions & Decisions

### Assumptions

1. **v2 是目标架构**：用户明确选择，v1 逐步废弃
2. **架构阶段允许破坏性变更**：DB schema 可大版本升级（V27+），类型可重构，API 可改
3. **prompt 是核心资产**：迁移过程中 prompt 文本必须完整保留，不可丢失
4. **测试是迁移的安全网**：v1 现有 50+ 测试必须在 P0/P1 重构后继续通过
5. **不阻塞日常创作**：重构期间 v1 保持可用，v2 按阶段投产

### Decisions

1. **不重写 v1**：v1 拆分而非重写，保留领域知识与测试
2. **v2 activities 复用 v1 逻辑**：prompt/learning/事实提取等纯函数从 v1 迁移到 v2，不重新实现
3. **类型统一优先于逻辑统一**：P0-3（类型统一）必须在 P1-1（上下文构建统一）之前完成
4. **CreativeRun 合并到 WorkflowRun**：而非反向，因为 WorkflowRun 的 stage handler 模式更成熟
5. **prompt 抽出为 YAML 资源**：而非保留 TypeScript 字符串，便于 diff 与版本控制
6. **DB schema 升级到 V27**：用于 P2-1（删除 deterministic-check）和 P2-2（修复 F-002）

### Tradeoffs

- **v2 重写 vs 渐进迁移**：选择渐进迁移，代价是 P0/P1 期间双栈并存维护成本高
- **类型统一 vs 独立演进**：选择类型统一，代价是 P0-3 需要修改大量调用方
- **prompt YAML 化 vs 保留 TS**：选择 YAML，代价是失去 TypeScript 类型检查（但可通过 schema 校验补偿）

## Verification Steps

### 阶段验证（每个 P 完成后）

1. `pnpm lint` 通过
2. `pnpm test` 全部通过
3. `pnpm build` 通过
4. 手动跑一次完整章节生成流程（v1）
5. （P0-2 完成后）手动跑一次 v2 章节生成流程
6. 文件大小审计：单文件 < 50KB（除 prompt 资源文件外）

### 契约验证（每个 P 完成后）

7. AGENTS.md 四类契约自查清单通过
8. TODO P1/P2/P3 标注审计：新增 TODO 必须按规则标注
9. 双栈类型一致性检查（P0-3 完成后）：`ts-node scripts/check-type-unification.ts`

### 迁移验证（P3-6 完成后）

10. 章节生成端到端测试（v2 主路径）
11. 离线模式测试（IndexedDB 缓存 + 离线队列）
12. 项目归档包导入导出测试（v1 与 v2 互导）
13. v1 代码删除后 `pnpm build` 通过

### 持续验证

14. 每次 commit 运行 `pnpm test`
15. 每次 PR 运行 `pnpm lint` + `pnpm test` + `pnpm build`
16. 每周运行 v2 章节生成冒烟测试（`pnpm novel:v2:smoke`）

## 文件清单（按改动顺序）

### P0-1 新增/修改
- 新增：[src/features/novel/generation/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation/) 目录（17 个文件）
- 删除：[src/features/novel/generation.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/generation.ts)
- 修改：[src/features/novel/facts.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/facts.ts)、[src/features/novel/craft-rule-evolution.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule-evolution.ts) 导入路径

### P0-2 新增/修改
- 新增：[src/novel-v2/learning-assessment.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/learning-assessment.ts)
- 新增：[src/novel-v2/prompts/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/prompts/) 目录
- 新增：[src/novel-v2/fact-extraction/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/fact-extraction/) 目录
- 修改：[src/novel-v2/temporal/activities.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/activities.ts)、[src/novel-v2/temporal/workflows.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/temporal/workflows.ts)、[src/novel-v2/model-gateway.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/model-gateway.ts)、[src/novel-v2/postgres-repository.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/postgres-repository.ts)

### P0-3 新增/修改
- 新增：[src/novel-v2/shared-types/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/shared-types/) 目录（6 个文件）
- 修改：[src/novel-v2/protocol.ts](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/protocol.ts)、[src/features/novel/types.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types.ts)

### P1-1 ~ P1-7
- 新增：[src/features/novel/context-service.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/context-service.ts)
- 新增：[src/features/novel/prompts/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/prompts/) 目录
- 新增：[src/features/novel/db/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db/) 目录
- 新增：[src/features/novel/craft-rule/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/craft-rule/) 目录
- 新增：[src/features/novel/tools/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/tools/) 目录
- 修改/删除：creative-execution.ts、memory-service.ts、creative-tool-gateway.ts 等大文件

### P2-1 ~ P2-6
- 删除：[src/features/novel/workflow-stages/deterministic-check-stage.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/workflow-stages/deterministic-check-stage.ts)
- 新增：[src/features/novel/lifecycle.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/lifecycle.ts)
- 新增：[src/novel-v2/__tests__/](file:///f:/GitHubProject/Ymcp/web/src/novel-v2/__tests__/) 目录
- 修改：[src/features/novel/db-schema.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/db-schema.ts)（V27 迁移）

### P3-1 ~ P3-6
- 新增：[src/features/novel/types/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/types/) 目录
- 新增：[src/features/novel/quality-rules/](file:///f:/GitHubProject/Ymcp/web/src/features/novel/quality-rules/) 目录
- 删除：[src/features/novel/persistence.ts](file:///f:/GitHubProject/Ymcp/web/src/features/novel/persistence.ts)
- 删除：v1 实现代码（P3-6 完成后）

## 执行建议

- **优先级**：P0-1（generation.ts 拆分）→ P0-2（v2 activities 落地）→ P0-3（类型统一）→ P1 → P2 → P3
- **并行度**：P0-1 与 P0-2 可并行（不同文件）；P0-3 必须在 P1-1 之前；P2 各子项可并行
- **每阶段独立 PR**：便于 review 与回滚
- **测试先行**：每个子任务先写测试再重构
