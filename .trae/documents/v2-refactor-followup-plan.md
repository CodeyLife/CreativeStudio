# V2 重构后续计划（C 阶段）

## 概述

基于对当前 v2 代码的全面审核，识别出三大类问题：
- **P0 架构断裂**：v2 mcp 模块（600+ 行）未接入实际 MCP server；`scripts/novel-mcp-server.mjs`（v1，工具集 `novel_intent_submit` 等）与 v2 `executeTool`（23 工具）完全不重叠；`scripts/novel-v2-mcp-server.mjs` 未被 package.json 引用。
- **P1 功能缺口**：craft-rule 7 工具全 `NotImplementedError`（阻塞 AGENTS.md 经验沉淀闭环）；`novel_chapter_review` 未实现（阻塞章节审校复用）；`defaultReviewer` 抛错；`TOOL_HANDLERS` 启动校验缺失。
- **P2 质量缺口**：`temporal/workflows.ts`（523 行）零测试；`NovelV2Studio.tsx` 主页面零测试；5 个文件超 500 行；约 50 个 v1 测试文件默认不运行。

**执行策略**：全部分批推进，按 P0→P1→P2 顺序，每批完成后验证。章节审校工作流采用 **v2 重新实现** 策略（不桥接 v1）。

## 审核进度（2026-07-27 第二轮复核）

### C-1 架构清理 — ✅ 完成

| 检查项 | 状态 | 证据 |
|---|---|---|
| `package.json` `novel:mcp:v2` 指向 v2 server | ✅ | `package.json:15` → `node --import tsx scripts/novel-v2-mcp-server.mjs` |
| v1 `scripts/novel-mcp-server.mjs` 已删除 | ✅ | Glob `scripts/novel*.mjs` 仅返回 v2 文件 |
| `scripts/novel-v2-mcp-server.mjs` 实现完整 | ✅ | 116 行，JSON-RPC 2.0 + tsx 加载器 + 信号处理 |
| `mcp/index.ts` 启动期 TOOL_NAMES/HANDLERS 校验 | ✅ | `mcp/index.ts:24-36` 缺失/多余即抛错 |

### C-2 功能补全 — ⚠️ 部分完成（4 个缺口 + 1 个架构边界待澄清）

| 子任务 | 状态 | 证据 / 缺口 |
|---|---|---|
| C-2.1 craft-rule 7 函数骨架 | ✅ | `src/novel-v2/craft-rule/index.ts`（399 行）7 函数全到位 |
| C-2.1 craft-rule handler 接入 | ✅ | `mcp/handlers.ts:388-492` 7 handler 全接入 |
| C-2.1 `004_craft_rule.sql` schema | ✅ | 30 行，含 CHECK 约束 + 外键 + 索引 |
| C-2.3 defaultReviewer LLM 接入 | ✅ | `command-router.ts:127-208` LLM 调用 + 失败降级 |
| C-2.4 chapterReview 4 个数据加载 activity | ✅ 代码完成 | `activities.ts:207/238/283/293` 4 个 activity 已实现 |
| C-2.4 chapterReviewWorkflow 闭环接入 | ✅ 代码完成 | `workflows.ts:550-776` review→revision→fact→commit→learning 全接入 |
| C-2.4 类型检查通过 | ❌ 3 个错误 | 详见下方"C-2.4 类型修复子任务" |
| C-2.5 evaluateCraftRuleOnFoundation | ⚠️ 占位 | `craft-rule/index.ts:239-272` 不跑 LLM 对比 |
| C-2.5 promote/rollback | ⚠️ 架构边界 | `craft-rule/index.ts:329-332` 注释明确 CandidateBundle 格式不兼容，需重新设计 |
| C-2.6 defaultReviewer 完整 prompt | ⚠️ 简化 | `command-router.ts:152-161` 单角色 reader，未注入 blueprint/memory |
| C-2.7 system-prompt target | ✅ 完成 | `005_prompt_templates_versioning.sql` + `craft-rule/index.ts` createCraftRuleCandidate 分支 + `promotion-service.ts` promote/rollback 分支；tsc 编译通过 |

### C-2.4 类型修复子任务（阻塞 C-2 验证）

当前 `pnpm tsc --noEmit` 报 3 个错误，全部源于 C-2.4 实现：

1. **`activities.ts:300` MemoryBundle 缺字段**
   - 错误：`Type '{ id; projectId; preflightId; claims; fingerprint; createdAt }' is missing: conflicts, missingFacets, tokenBudget, sourceRevisionIds`
   - 修复：补全空 bundle 默认值（`conflicts: []`, `missingFacets: []`, `tokenBudget: 0`, `sourceRevisionIds: []`）

2. **`workflows.ts:722` IntentSource 缺 "chapter-review"**
   - 错误：`Type '"chapter-review"' is not assignable to type 'IntentSource'`
   - 修复：扩展 `protocol.ts:9` `IntentSource` 联合类型，新增 `"chapter-review"`（语义：v2 内部触发的章节重审源）

3. **`workflows.ts:732` SkillBundle 拼写错误**
   - 错误：`'descriptors' does not exist in type 'SkillBundle'`
   - 修复：改为 `skills: []`（`SkillBundle.skills` 字段，类型为 `Array<Pick<SkillDescriptor, "skillId"|"version"|"qualityGates">>`）

### C-2.5 架构边界澄清（新发现）

`craft-rule/index.ts:329-332` 注释指出原计划"完整接入 PromotionService"不可行：

> CandidateBundle 需要 manuscript / dependencyHead / baseSnapshot 等字段，
> 而 craft-rule 只迭代 skill prompt，不产生 manuscript，格式不兼容。

**重新设计选项**：

| 选项 | 描述 | 评估 |
|---|---|---|
| A. 扩展 PromotionService 支持纯 skill 迭代 | 在 `evaluation/promotion.ts` 新增 `promoteSkillOnly(bundle)` 方法，跳过 manuscript 验证 | 改动评估闭环核心，影响面大 |
| B. 新建 CraftRulePromotionService | 独立模块，复用 promotion 的 receipt + rollback 原子事务模式，但不要求 CandidateBundle | 边界清晰，符合单一职责 |
| C. 保留简化版 + 补回归验证 | 直接 UPDATE skill_definitions + 用 evidenceCases 重跑回归 | 最小改动，但仍绕过 PromotionService |

**推荐方案 B**：craft-rule 的语义是"用 evidenceCases A/B 对比驱动 skill prompt 迭代"，与评估闭环"用 manuscript 验证候选 bundle"是不同的演进路径。强行套用 CandidateBundle 会引入冗余字段（manuscript/dependencyHead 在 craft-rule 场景无意义）。

需要用户确认选哪个方案后再细化 C-2.5 实现。

### C-3 质量加固起点 — 待启动

| 检查项 | 当前状态 |
|---|---|
| `src/novel-v2/__tests__/` 测试文件 | 8 个（缺 craft-rule/command-router/workflows/activities/chapter-review/postgres-repository） |
| 5 个超 500 行文件合计 | 3052 行（workflows 641 / handlers 678 / protocol 567 / postgres-repository 590 / novel-v2-api 576） |
| `src/features/novel/__tests__/` v1 残留 | 44 个非 v2- 前缀测试 + bench/ 目录 |
| `src/features/novel/__tests__/v2-*.test.ts` | 4 个待迁移到 `src/novel-v2/__tests__/` |
| `src/pages/NovelV2Studio.tsx` | 247 行，零测试 |

---

## Phase C-2 补全：功能闭环

**目标**：补齐 AGENTS.md 四大契约的 v2 闭环，消除 5 个功能缺口。

### C-2.4 chapterReviewWorkflow 数据加载 activities

**修改文件**：
- `src/novel-v2/temporal/activities.ts`（新增 4 个 activity）
- `src/novel-v2/temporal/workflows.ts`（替换 L598-600 抛错，接入 activities）
- `src/novel-v2/temporal/types.ts`（扩展 `NovelWorkflowActivities` 接口）

**为什么**：AGENTS.md 要求章节审校工作流复用 `reviewStageHandler → revisionStageHandler → manuscriptApprovalHandler → factExtractionStageHandler → factApprovalHandler → commitStageHandler → characterEnrichmentStageHandler`。当前 `chapterReviewWorkflow` 启动即抛错，契约不可用。

**怎么做**：

1. 在 `activities.ts` 新增 4 个独立 activity（与 `novelIntentWorkflow` 的 activities 风格一致）：

```typescript
// activities.ts 新增
async function loadHistoricalBlueprint(params: {
  projectId: string;
  documentId: string;
}): Promise<{ blueprint: ChapterBlueprint; artifactId: string }> {
  // 查 artifacts 表，找 documentId 关联的、kind="chapter-blueprint" 的最新 artifact
  // 解析 artifact.structuredData 为 ChapterBlueprint
  // 若不存在则抛错（前置条件：必须存在历史 blueprint）
}

async function loadDocumentPlainText(params: {
  projectId: string;
  documentId: string;
}): Promise<{ plainText: string; contentHtml: string; wordCount: number }> {
  // 查 documents 表，返回 plainText/contentHtml/wordCount
  // 校验 document.status === "final"（前置条件）
}

async function getDefaultRoutingSnapshot(params: {
  projectId: string;
  documentId: string;
}): Promise<RoutingSnapshot> {
  // 查 creative_runs + creative_work_items，返回当前 routing 配置
  // 用于 review activity 的 reviewer 路由
}

async function retrieveMemoryForReview(params: {
  projectId: string;
  documentId: string;
  blueprint: ChapterBlueprint;
}): Promise<MemoryBundle> {
  // 调 qdrant-memory 检索与 blueprint 相关的 memory
  // 复用 novelIntentWorkflow 的 retrieveMemory 逻辑，但 query 用 blueprint 的 beats/characters
}
```

2. 在 `workflows.ts` `chapterReviewWorkflow` 替换 L598-600 抛错：

```typescript
// 替换 throw new Error(...)
const [blueprintArtifact, documentState, routingSnapshot, memoryBundle] = await Promise.all([
  activities.loadHistoricalBlueprint({ projectId, documentId }),
  activities.loadDocumentPlainText({ projectId, documentId }),
  activities.getDefaultRoutingSnapshot({ projectId, documentId }),
  activities.retrieveMemoryForReview({ projectId, documentId, blueprint: blueprintArtifact.blueprint }),
]);
```

3. 实现 review→revision→fact-extraction→commit→learning 闭环（复用 `novelIntentWorkflow` 的 activities）：

```typescript
// 把 documentState.plainText 包装为 draft artifact
const draftArtifact = { kind: "chapter-draft", structuredData: { text: documentState.plainText } };

// review（5 reviewer 并行，复用 review activity）
const reviewResult = await activities.review({
  projectId, documentId, draftArtifact, blueprint: blueprintArtifact.blueprint,
  memoryBundle, routingSnapshot,
});

// 多轮修订循环（复用 decideRevision 逻辑）
let currentDraft = draftArtifact;
let revisionRound = 0;
const MAX_REVISION_ROUNDS = 3;
while (revisionRound < MAX_REVISION_ROUNDS) {
  const decision = decideRevision(reviewResult);
  if (decision.action === "accept") break;
  currentDraft = await activities.revise({ projectId, documentId, draft: currentDraft, review: reviewResult, blueprint: blueprintArtifact.blueprint });
  revisionRound++;
}

// 事实提取（用 novelty 字段去重）
const facts = await activities.extractFacts({ projectId, documentId, draft: currentDraft, blueprint: blueprintArtifact.blueprint });

// commit（更新 document.plainText/contentHtml，对新 DocumentRevision 创建 chapter memory）
await activities.commit({ projectId, documentId, draft: currentDraft, facts });

// learning（汇总 issue 模式为 RuntimeLearningAssessment）
await activities.assessLearning({ projectId, documentId, review: reviewResult, draft: currentDraft });
```

4. 不设置 `conversationThreadId/creativeBriefId`，review-stage 走 `contextPacketId` 路径。

**约束**：
- 4 个 activity 必须独立，不与 `loadProjectSnapshot` 合并（单一职责）
- 复用 `novelIntentWorkflow` 的 review/revise/commit activities，不重写
- 前置条件校验：`document.status === "final"`、无活跃工作流、存在历史 blueprint artifact
- 幂等性：通过 `workflowId` 保证

### C-2.5 craft-rule promote/rollback 完整接入 + 回归验证

**修改文件**：
- `src/novel-v2/craft-rule/index.ts`（重写 `promoteCraftRuleCandidate` / `rollbackCraftRuleCandidate` / `evaluateCraftRuleOnFoundation`）
- 复用 `src/novel-v2/evaluation/promotion.ts` 的 `createPromotionService`

**为什么**：AGENTS.md 硬要求"promote 后必须做回归验证（用新版本重跑失败场景），不允许只看 A/B 分数提升就 promote"。当前简化实现直接 UPDATE skill_definitions，绕过 PromotionService，无回归验证。

**怎么做**：

1. **`evaluateCraftRuleOnFoundation` 完整实现**（替换 L239-272 占位）：

```typescript
export async function evaluateCraftRuleOnFoundation(
  repository: NovelPostgresRepository,
  model: ModelGateway,
  input: { projectId, candidateId, taskKey, scenarioClass, instruction? },
): Promise<CraftRuleCandidate> {
  const candidate = await inspectCraftRuleCandidate(repository, input.projectId, input.candidateId);
  
  // 1. 用 beforeText 跑一次 LLM（baseline）
  const baselineResult = await runFoundationTaskWithPrompt({
    model, taskKey: input.taskKey, promptText: candidate.beforeText,
    instruction: input.instruction, scenarioClass: input.scenarioClass,
  });
  
  // 2. 用 afterText 跑一次 LLM（candidate）
  const candidateResult = await runFoundationTaskWithPrompt({
    model, taskKey: input.taskKey, promptText: candidate.afterText,
    instruction: input.instruction, scenarioClass: input.scenarioClass,
  });
  
  // 3. 对比 quality score，记录 evidence case
  const evidenceCase: CraftRuleEvidenceCase = {
    caseId: generateId(),
    scenarioClass: input.scenarioClass,
    scenarioSignature: hashScenario(input.scenarioClass, input.taskKey),
    scenarioProfile: { taskKey: input.taskKey },
    baselineWorkItemId: baselineResult.workItemId,
    candidateWorkItemId: candidateResult.workItemId,
    baselineScore: baselineResult.qualityScore,
    candidateScore: candidateResult.qualityScore,
    blockerDelta: candidateResult.blockerCount - baselineResult.blockerCount,
    majorDelta: candidateResult.majorCount - baselineResult.majorCount,
    recordedAt: Date.now(),
  };
  
  candidate.evidenceCases.push(evidenceCase);
  candidate.status = "evidencing";
  candidate.updatedAt = Date.now();
  candidate.revision += 1;
  await repository.upsertCraftRuleCandidate(candidate);
  return candidate;
}
```

2. **`promoteCraftRuleCandidate` 完整接入 PromotionService**（替换 L305-362 简化实现）：

```typescript
export async function promoteCraftRuleCandidate(
  repository: NovelPostgresRepository,
  model: ModelGateway,
  input: { projectId, candidateId },
): Promise<{ receiptId: string; regressionVerified: boolean }> {
  const candidate = await inspectCraftRuleCandidate(repository, input.projectId, input.candidateId);
  
  // 1. 校验 status=reviewing 且至少 1 条 verdict=passed
  const gate = evaluateCraftRuleGate(candidate);
  if (!gate.ready) throw new Error(`候选未通过晋升门禁: ${gate.reasons.join("; ")}`);
  
  // 2. 校验 target 版本未漂移
  const currentSkill = await repository.getSkillDefinition(input.projectId, candidate.targetId);
  if (currentSkill.version !== candidate.beforeVersion) {
    throw new Error(`目标版本已漂移: expected ${candidate.beforeVersion}, got ${currentSkill.version}`);
  }
  
  // 3. 构造 CandidateBundle，调用 PromotionService
  const promotionService = createPromotionService(repository, model);
  const candidateBundle: CandidateBundle = {
    candidateId: candidate.id,
    projectId: input.projectId,
    targetKind: candidate.targetKind,
    targetId: candidate.targetId,
    beforeVersion: candidate.beforeVersion,
    proposedVersion: candidate.proposedVersion,
    beforeText: candidate.beforeText,
    afterText: candidate.afterText,
    evidenceCases: candidate.evidenceCases,
    reviews: candidate.reviews,
  };
  
  const promotionResult = await promotionService.promote(candidateBundle);
  
  // 4. 回归验证：用新版本重跑失败场景
  const regressionVerified = await runRegressionVerification({
    repository, model, candidate, newVersion: candidate.proposedVersion,
  });
  
  if (!regressionVerified.passed) {
    // 回归失败，自动 rollback
    await promotionService.rollback(promotionResult.receiptId);
    throw new Error(`回归验证失败: ${regressionVerified.reasons.join("; ")}, 已自动回滚`);
  }
  
  // 5. 更新候选状态
  candidate.status = "promoted";
  candidate.promotionReceiptId = promotionResult.receiptId;
  candidate.updatedAt = Date.now();
  candidate.revision += 1;
  await repository.upsertCraftRuleCandidate(candidate);
  
  return { receiptId: promotionResult.receiptId, regressionVerified: true };
}
```

3. **`rollbackCraftRuleCandidate` 完整接入**（替换 L366-399 简化实现）：

```typescript
export async function rollbackCraftRuleCandidate(
  repository: NovelPostgresRepository,
  model: ModelGateway,
  input: { projectId, candidateId },
): Promise<{ receiptId: string; rolledBack: boolean }> {
  const candidate = await inspectCraftRuleCandidate(repository, input.projectId, input.candidateId);
  if (candidate.status !== "promoted") throw new Error("只能回滚已晋升的候选");
  if (!candidate.promotionReceiptId) throw new Error("缺少晋升收据 ID");
  
  const promotionService = createPromotionService(repository, model);
  const rollbackResult = await promotionService.rollback(candidate.promotionReceiptId);
  
  candidate.status = "rolled-back";
  candidate.updatedAt = Date.now();
  candidate.revision += 1;
  await repository.upsertCraftRuleCandidate(candidate);
  
  return { receiptId: candidate.promotionReceiptId, rolledBack: true };
}
```

4. **`runRegressionVerification` 辅助函数**：用新版本重跑 candidate 的 evidenceCases 中的 scenarioClass，对比 quality score 不回退。

**约束**：
- 必须复用 `evaluation/promotion.ts` 的 `createPromotionService`，不直接 UPDATE skill_definitions
- 回归验证失败必须自动 rollback
- `promoteCraftRuleCandidate` 签名扩展为 `(repository, model, input)`，需同步更新 `mcp/handlers.ts` 传参

### C-2.6 defaultReviewer 完整 prompt（注入 blueprint/memory）

**修改文件**：`src/novel-v2/creative/command-router.ts`（替换 L124-126 简化注释 + L152 简化 prompt）

**为什么**：当前 `defaultReviewer` 只用 review.reader 单角色简化 prompt，未注入 blueprint/memory，审核质量不足。

**怎么做**：

1. 复用 `prompts/chapter-review.ts` 的 `buildChapterReviewPrompt`（如不存在则新建）：

```typescript
// command-router.ts 修改 defaultReviewer
export async function defaultReviewer(
  repository: NovelPostgresRepository,
  workItemId: string,
  model: ModelGateway,
): Promise<CreativeReviewInput> {
  // 1. 查 work item artifact_refs → 取最新 artifact → 提取 draftText
  const workResult = await repository.pool.query<{ artifact_refs: string[] }>(
    "SELECT artifact_refs FROM creative_work_items WHERE id = $1",
    [workItemId],
  );
  if (!workResult.rowCount) throw new Error(`Work item 不存在：${workItemId}`);
  const artifactRefs = workResult.rows[0].artifact_refs ?? [];
  if (!artifactRefs.length) throw new Error(`Work item ${workItemId} 无关联 artifact`);
  const latestArtifactId = artifactRefs[artifactRefs.length - 1];
  
  const artifact = await repository.getArtifact(latestArtifactId);
  const draftText = artifact.structuredData?.text ?? "";
  
  // 2. 加载 blueprint（从 artifact.structuredData.blueprint 或查历史 blueprint artifact）
  const blueprint = artifact.structuredData?.blueprint ?? await repository.loadHistoricalBlueprint({
    projectId: artifact.projectId,
    documentId: artifact.documentId,
  });
  
  // 3. 加载 memory bundle（调 qdrant-memory 检索）
  const memoryBundle = await retrieveMemoryForReview({
    projectId: artifact.projectId,
    documentId: artifact.documentId,
    blueprint,
  });
  
  // 4. 构造完整 review prompt（注入 blueprint + memory）
  const reviewPrompt = buildChapterReviewPrompt({
    draftText,
    blueprint,
    memoryBundle,
    reviewerRoles: ["plot-editor", "character-editor", "prose-editor", "long-form-editor", "review.reader"],
  });
  
  // 5. 调用 LLM 生成审核
  const reviewSchema = { /* verdict/issues/summary schema */ };
  const reviewResult = await model.generateStructured<LlmReviewResult>({
    prompt: reviewPrompt,
    schema: reviewSchema,
  });
  
  return {
    subjectArtifactId: latestArtifactId,
    reviewer: "internal",
    verdict: reviewResult.verdict,
    issues: reviewResult.issues,
    summary: reviewResult.summary,
  };
}
```

2. 若 `prompts/chapter-review.ts` 不存在 `buildChapterReviewPrompt`，新建该函数，支持多 reviewer 角色。

**约束**：
- 失败时不抛错，返回 verdict="revise" + issue="LLM 审核失败"（保持现有降级逻辑）
- reviewer identity = "internal"
- 不阻塞 `review.request` 命令主流程

### C-2.7 system-prompt target 支持

**修改文件**：
- `src/novel-v2/craft-rule/index.ts`（移除 L172-173、L325-326 的"暂未支持"抛错）
- `src/novel-v2/postgres-repository.ts`（新增 `getPromptTemplateVersion` / `upsertPromptTemplateVersion` 方法）
- `deploy/postgres/005_prompt_templates_versioning.sql`（新建，若 `prompt_templates` 表无版本管理字段）

**为什么**：craft-rule 当前 `system-prompt` target 全部抛错"暂未支持"，AGENTS.md 要求 `targetKind` 支持 `skill | system-prompt`。

**怎么做**：

1. 检查 `prompt_templates` 表是否有 `version` 字段（若无，新增 migration `005_prompt_templates_versioning.sql`）：

```sql
-- 005_prompt_templates_versioning.sql
ALTER TABLE prompt_templates 
  ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
```

2. 在 `postgres-repository.ts` 新增方法：

```typescript
async getPromptTemplateVersion(projectId: string, templateId: string): Promise<{
  templateId: string;
  version: string;
  content: string;
  stages: string[];
}> {
  const result = await this.pool.query(
    "SELECT template_id, version, content, stages FROM prompt_templates WHERE project_id = $1 AND template_id = $2",
    [projectId, templateId],
  );
  if (!result.rowCount) return null;
  return result.rows[0];
}

async upsertPromptTemplateVersion(projectId: string, templateId: string, content: string, version: string): Promise<void> {
  await this.pool.query(
    "UPDATE prompt_templates SET content = $3, version = $4, updated_at = NOW() WHERE project_id = $1 AND template_id = $2",
    [projectId, templateId, content, version],
  );
}
```

3. 修改 `craft-rule/index.ts` 的 `createCraftRuleCandidate` 支持 system-prompt：

```typescript
// 替换 L172-173 抛错
if (input.targetKind === "system-prompt") {
  const template = await repository.getPromptTemplateVersion(input.projectId, input.targetId);
  if (!template) throw new Error("目标系统 Prompt 不存在");
  beforeVersion = template.version;
  beforeText = template.content;
  targetStages = template.stages as NovelSkillStage[];
}
```

4. 同理修改 `promoteCraftRuleCandidate` / `rollbackCraftRuleCandidate` 的 system-prompt 分支，调 `upsertPromptTemplateVersion`。

**约束**：
- `validateSkillPrompt` 仅适用于 skill，system-prompt 跳过该校验
- 版本递增用 `nextPatchVersion(beforeVersion)`

### C-2.8 验证

- `pnpm tsc --noEmit` 通过
- 新建 `src/novel-v2/__tests__/craft-rule.test.ts`（7 工具 happy path + 错误路径 + 回归验证 mock）
- 新建 `src/novel-v2/__tests__/chapter-review-workflow.test.ts`（activity mock 测试）
- 新建 `src/novel-v2/__tests__/command-router.test.ts`（defaultReviewer 完整 prompt 测试）
- `pnpm vitest run` 全部通过

---

## Phase C-3：质量加固

**目标**：补全测试盲区、拆分大文件、清理 v1 残留。

### C-3.1 测试补全（6 个新测试文件）

**新建文件**：
- `src/novel-v2/__tests__/craft-rule.test.ts`
- `src/novel-v2/__tests__/command-router.test.ts`
- `src/novel-v2/__tests__/workflows.test.ts`
- `src/novel-v2/__tests__/activities.test.ts`
- `src/novel-v2/__tests__/chapter-review-workflow.test.ts`
- `src/novel-v2/__tests__/postgres-repository.test.ts`

**为什么**：`src/novel-v2/__tests__/` 仅 8 个测试，缺关键模块覆盖。workflows.ts（641 行）+ activities.ts（195 行）是生产关键路径零测试。

**怎么做**：

1. **`workflows.test.ts`**（使用 Temporal `TestWorkflowEnvironment` mock activities）：
   - `novelIntentWorkflow` happy path（preflight → draft → review → commit）
   - `novelIntentWorkflow` blocker non-retryable（转入人工队列）
   - `creativeRunWorkflow` 暂停/恢复/取消信号
   - `creativeRunWorkflow` review gate（manual/auto/none）
   - `chapterReviewWorkflow` 从 review 阶段启动（C-2.4 完成后）

2. **`activities.test.ts`**：
   - 18 个 activity 各一个 happy path 测试
   - `draft` activity 的 `ExternalMcpRequiredError` 分支
   - `review` activity 的 5 种 reviewer 角色路由
   - 4 个新数据加载 activity（C-2.4 完成后）

3. **`craft-rule.test.ts`**：
   - 7 工具 happy path（create → inspect → evidence → evaluate → review → promote → rollback）
   - 错误路径（scope 缺字段 / afterText 过短 / status 不符 / 版本漂移）
   - promote 回归验证失败自动 rollback
   - system-prompt target 支持（C-2.7 完成后）

4. **`command-router.test.ts`**：
   - `defaultReviewer` 完整 prompt（注入 blueprint/memory）
   - `defaultReviewer` LLM 失败降级
   - `executeCreativeCommand` 各 action 分支

5. **`chapter-review-workflow.test.ts`**：
   - 从 review 阶段启动 happy path
   - 前置条件校验失败（document.status !== "final"）
   - 多轮修订循环
   - fact-extraction novelty 去重

6. **`postgres-repository.test.ts`**：
   - 主要 CRUD 方法测试
   - `loadHistoricalBlueprint` / `loadDocumentPlainText` 等新方法

**约束**：
- 不依赖真实 Temporal server，全 mock
- 不依赖真实 Postgres，用 `pg-mem` 或 mock repository
- 集成测试（需真实 DB）用 `TEST_DATABASE_URL` 环境变量门控

### C-3.2 NovelV2Studio.tsx 测试

**新建文件**：`src/pages/__tests__/NovelV2Studio.test.tsx`

**为什么**：主页面包含章节 CRUD + Intent 提交 + 3 秒轮询 + SSE 事件流，零测试。

**怎么做**：
1. 复用现有 Panel 测试模式（SSR + jsdom）
2. 测试用例：
   - 4 个 tab 渲染（studio/evaluation/creative/mcp）
   - 章节列表初始渲染
   - 创建章节 Modal 打开/关闭
   - fetch 失败时 Alert 展示
   - 轮询触发（用 `vi.useFakeTimers`）

### C-3.3 文件拆分（5 个超 500 行文件）

**目标**：5 个文件拆分到 < 500 行，合计从 3052 行降到目标 < 2500 行。

| 文件 | 当前行数 | 拆分方案 |
|---|---|---|
| `postgres-repository.ts` | 590 | 拆为 `postgres-repository/index.ts` + `project.ts` + `artifact.ts` + `review.ts` + `learning.ts` + `outbox.ts` + `craft-rule.ts` |
| `mcp/handlers.ts` | 678 | 拆为 `handlers/index.ts` + `project-handlers.ts` + `creative-handlers.ts` + `evaluation-handlers.ts` + `craft-rule-handlers.ts` + `one-click-handlers.ts` |
| `protocol.ts` | 567 | 拆为 `protocol/index.ts` + `intent.ts` + `artifact.ts` + `review.ts` + `learning.ts` + `evaluation.ts` + `creative.ts` |
| `temporal/workflows.ts` | 641 | 拆为 `workflows/index.ts` + `novel-intent-workflow.ts` + `creative-run-workflow.ts` + `chapter-review-workflow.ts` |
| `scripts/novel-v2-api.ts` | 576 | 拆为 `novel-v2-api/index.ts` + `project-routes.ts` + `creative-routes.ts` + `evaluation-routes.ts` + `admin-routes.ts` |

**怎么做**：
1. 每个文件创建同名子目录 + `index.ts` barrel re-export
2. 按域拆分子模块，保持导出兼容
3. 每次拆分后 `pnpm tsc --noEmit` 验证
4. 拆分顺序：`protocol.ts`（纯类型，风险最低）→ `postgres-repository.ts` → `mcp/handlers.ts` → `temporal/workflows.ts` → `scripts/novel-v2-api.ts`

**约束**：
- 保持导出兼容（barrel `index.ts` re-export）
- 不改变运行时行为
- 不改变测试引用路径

### C-3.4 v1 残留清理

**目标**：删除 v1 死代码，迁移沉默测试。

**怎么做**：

1. **删除 44 个 v1 残留测试 + bench/ 目录**（删除前 Grep 确认无 v2 引用）：
   - `src/features/novel/__tests__/` 下非 `v2-` 前缀的 44 个 `.test.ts` / `.test.tsx` 文件
   - `src/features/novel/__tests__/bench/` 整个目录

2. **迁移 4 个 v2-*.test.ts** 到 `src/novel-v2/__tests__/`（去除 `v2-` 前缀）：
   - `v2-cognition.test.ts` → `cognition.test.ts`
   - `v2-commit-service.test.ts` → `commit-service.test.ts`
   - `v2-learning-assessment.test.ts` → `learning-assessment.test.ts`
   - `v2-repository-management.test.ts` → `repository-management.test.ts`
   - 更新 import 路径（从 `../../features/novel/...` 改为 `../...`）

3. **删除 v1 已被 v2 取代的源码**（C-2 完成后）：
   - `src/features/novel/craft-rule-evolution.ts`（v2 `craft-rule/index.ts` 已取代）
   - `src/features/novel/CraftRuleGovernance.tsx`（v2 UI 待评估是否保留）
   - `src/features/novel/workflow.ts` 的 `startChapterReviewWorkflow`（v2 `chapterReviewWorkflow` 已取代）
   - `src/features/novel/evaluation/project-snapshot.ts`（v2 已有等价模块）

4. **删除前验证**：
   - `pnpm tsc --noEmit` 通过
   - `pnpm vitest run` 通过
   - Grep 确认无外部引用

**约束**：
- 每次删除前 Grep 确认无 v2 引用
- 删除后 `pnpm tsc --noEmit` + `pnpm vitest run` 验证
- v1 源码删除需在 C-2.4/C-2.5/C-2.6/C-2.7 全部完成后进行

### C-3.5 验证

- `pnpm tsc --noEmit` 通过
- `pnpm vitest run` 全部通过（含新增 6+1 个测试）
- 文件大小审计：所有文件 < 500 行
- AGENTS.md 合规检查：
  - `RuntimeLearningAssessment` 在 review/commit 后触发 ✓
  - `chapterReviewWorkflow` v2 完整实现（review→revision→fact-extraction→commit→learning）✓
  - `createCraftRuleCandidate` 闭环 + promote 回归验证 ✓
  - `defaultReviewer` 完整 prompt 注入 blueprint/memory ✓
  - `system-prompt` target 支持 ✓
  - IndexedDB 删除契约 ✓

---

## 假设与决策

### 假设
1. Postgres 测试环境可通过 `TEST_DATABASE_URL` 提供（集成测试）
2. Temporal `TestWorkflowEnvironment` 可在 vitest 中运行（已验证依赖 `@temporalio/workflow`）
3. v1 craft-rule-evolution.ts 的业务逻辑可作为 v2 重写参考（不直接复用代码，复用设计）
4. `evaluation/promotion.ts` 的 `createPromotionService` 接口与 CandidateBundle 兼容（需 C-2.5 验证）
5. `prompts/chapter-review.ts` 存在 `buildChapterReviewPrompt` 或可新增（需 C-2.6 验证）

### 决策
1. **章节审校**：v2 重新实现 `chapterReviewWorkflow`，不桥接 v1（用户确认）
2. **MCP server**：删除 v1 `novel-mcp-server.mjs`，统一用 `novel-v2-mcp-server.mjs`（已完成）
3. **craft-rule 模块**：基于 Postgres 重写，复用 `evaluation/promotion.ts` 的晋升逻辑（用户确认完整接入）
4. **promote 回归验证**：promote 后必须用新版本重跑失败场景，失败自动 rollback（用户确认）
5. **文件拆分**：用 barrel `index.ts` re-export 保持导出兼容
6. **v1 测试清理**：直接删除 44 个沉默测试 + bench/ 目录（用户确认）
7. **system-prompt target**：本期支持，新增 `prompt_templates` 版本管理 migration（用户确认）
8. **数据加载 activities**：新增 4 个独立 activity，不与 `loadProjectSnapshot` 合并（用户确认）

## 验证步骤

每个 Phase 完成后执行：
1. `pnpm tsc --noEmit` — 类型检查
2. `pnpm vitest run` — 全量测试
3. 文件大小审计 — `Get-ChildItem | Measure-Object -Line`
4. AGENTS.md 合规 Grep — TODO P1/P2/契约关键词

最终验证：
- 23 个 MCP 工具全部可调用（无 NotImplementedError）
- `chapterReviewWorkflow` v2 完整实现可触发（review→revision→commit→learning 闭环）
- `createCraftRuleCandidate` 闭环 + promote 回归验证可走通
- `defaultReviewer` 完整 prompt 注入 blueprint/memory
- `system-prompt` target 支持
- 所有文件 < 500 行
- v1 残留模块全部清理
- 新增 6+1 个测试全部通过

## 执行顺序

```
[已完成] C-1.1 MCP server 入口统一 ──┐
[已完成] C-1.2 TOOL_HANDLERS 启动校验 ┤── C-1 验证 ✅
                                      │
[已完成] C-2.1 craft-rule 7 函数骨架 ─┤
[已完成] C-2.1 craft-rule handler 接入┤
[已完成] C-2.1 004_craft_rule.sql ────┤
[已完成] C-2.3 defaultReviewer LLM接入┤
                                      │
[代码完成] C-2.4 4 个数据加载 activity ┤
[代码完成] C-2.4 workflow 闭环接入 ────┤
[已完成]   C-2.4 修复 3 个类型错误 ────┤── C-2.4 验证（tsc 通过）✅
                                      │
[已完成] C-2.5 CraftRulePromotionService┤  ← 方案 B 已落地
[已完成] C-2.5 evaluateFoundation 完整 ─┤
[已完成] C-2.5 promote/rollback 完整 ───┤── C-2.5 验证 ✅
                                      │
[已完成] C-2.6 defaultReviewer 完整prompt┤
[已完成] C-2.7 system-prompt target ────┤  ← prompt_templates 版本管理
[已完成] C-2.8 craft-rule 测试 ─────────┘── C-2 验证 ✅
                                      │
[已完成] C-3.1 craft-rule.test.ts ─────┤  ← 13 测试通过
[已完成] C-3.1 command-router.test.ts ──┤  ← 5 测试通过（defaultReviewer）
[待办]   C-3.1 workflows.test.ts ──────┤  ← Temporal mock 复杂
[待办]   C-3.1 activities.test.ts ─────┤
[待办]   C-3.1 chapter-review-workflow ┤
[待办]   C-3.1 postgres-repository ────┤── C-3.1 部分完成
                                      │
[待办] C-3.2 NovelV2Studio 测试 ─────┤
[待办] C-3.3 5 个文件拆分 ────────────┤── C-3 验证
[待办] C-3.4 v1 残留清理 ─────────────┤
[待办] C-3.5 最终验证 ────────────────┘
```

**C-2 阶段全部完成** ✅（2026-07-27）
- C-2.4 类型修复 + chapterReviewWorkflow 闭环接入
- C-2.5 方案 B：CraftRulePromotionService 独立服务（不共用 CandidateBundle）
- C-2.6 defaultReviewer 接入 LLM + blueprint/memory 注入
- C-2.7 system-prompt target 支持（migration + create/promote/rollback 分支）
- C-2.8 craft-rule.test.ts 13 测试通过（含 system-prompt target 验证 + 回归验证失败自动 rollback）

**C-3 阶段进度**：
- C-3.1 已完成 2/6 测试文件（craft-rule + command-router），剩余 4 个待补
- 完整测试套件 10 文件 118 passed + 37 skipped（Postgres 不可用）通过

**剩余任务优先级**（待用户决策）：
1. C-3.1 剩余 4 个测试文件（workflows/activities/chapter-review-workflow/postgres-repository）- 工作量大，需 Temporal mock
2. C-3.3 文件拆分（5 个超 500 行文件）- 重构性改动
3. C-3.4 v1 残留清理（44 个测试 + v1 源码）- 删除性改动，需谨慎
4. C-3.2 NovelV2Studio.tsx 测试 - React 组件测试
5. C-3.5 最终验证
