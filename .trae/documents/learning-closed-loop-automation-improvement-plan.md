# 经验沉淀闭环自动化改进方案

## 1. 当前状态分析

### 现有流程

```
章节审校 → assessLearning (LLM) → RuntimeLearningAssessmentV2
                                                      ↓
                                         recordLearning (activities.ts:115)
                                              ├─ recordLearningAssessment (写 learning_assessments 表 + outbox)
                                              └─ createCraftRuleCandidate (写入 craft_rule_candidates, status=proposed)
                                                                                      ↓
                                                                              ✗ 卡在 proposed 状态
```

### 已实现的环节

| 环节 | 文件 | 状态 |
|------|------|------|
| 学习评估（LLM 分析问题→propose-improvement） | `activities.ts:632` → `learning-assessment.ts` | ✅ 正常 |
| 候选创建（写入 craft_rule_candidates 表） | `activities.ts:123` → `craft-rule/index.ts:178` | ✅ 正常 |
| 证据记录（recordCraftRuleEvidence） | `craft-rule/index.ts:289` | ✅ 可实现但未自动触发 |
| 基础任务评分（evaluateCraftRuleOnFoundation） | `craft-rule/index.ts:400` | ✅ 可实现但未自动触发 |
| 审校提交（submitCraftRuleReview） | `craft-rule/index.ts:472` | ✅ 可实现但未自动触发 |
| 晋升+回归验证（promoteCraftRuleCandidate） | `craft-rule/index.ts:556` | ✅ 可实现但未自动触发 |
| 技能迭代（runSkillIteration） | `evaluation/skill-iteration.ts:236` | ✅ 仅实验闭环路径调用 |
| outbox 事件（learning.propose-improvement） | `postgres-repository.ts:4155` | ✅ 写入但无消费者 |

### 断点

1. **无 outbox consumer**：`learning.propose-improvement` 事件写入 `outbox_events` 表，但没有进程轮询并处理这些事件。
2. **无自动 evidence→review→promote 编排**：candidate 创建后，没有自动流程驱动 `evidencing → reviewing → promoted` 的状态流转。
3. **`runSkillIteration` 不可从生产路径调用**：它需要 `ExperimentWorkspaceHandle`（实验 schema），仅限 `evaluation/closed-loop.ts` 实验闭环使用。
4. **`runChapterLifecycle` 的 `learningMode` 仅控制 learning 调用时机**，不控制 candidate 创建后的后续处理。

---

## 2. 改进方案

### 方案选择：Temporal workflow 驱动（推荐）

在现有 Temporal 基础设施上新增一个专用 workflow，由 outbox 事件触发，编排 evidence→review→promote→skillIteration 全链路。不引入新的事件总线或作业队列。

### 架构图

```
learning.propose-improvement outbox 事件
                    ↓
     LearningPromotionWorkflow（新 Temporal workflow）
         ├─ 1. 收集证据（evaluateCraftRuleOnFoundation）
         │   ├─ 原失败场景（source-failure）
         │   └─ 异构场景（cross-scenario，至少 1 个）
         ├─ 2. 提交 LLM 审校（submitCraftRuleReview）
         ├─ 3. 晋升+回归验证（promoteCraftRuleCandidate）
         └─ 4. 触发 skill iteration（新 runSkillIterationOnProduction）
              └─ 写入 iterated_skills + 更新生产 skill_definitions
```

### 详细设计

#### 2.1 新增 `LearningPromotionWorkflow`（`src/novel-v2/temporal/workflows.ts`）

```typescript
export async function learningPromotionWorkflow(input: {
  projectId: string;
  assessmentId: string;
  candidateId: string;
}): Promise<void>
```

**职责**：
1. 加载 `CraftRuleCandidate` 和 `RuntimeLearningAssessmentV2`
2. 收集证据：对 candidate 的 `scope.affectedInputClass` 自动选择 1-2 个基础任务类型，调用 `evaluateCraftRuleOnFoundation` 生成 baseline vs candidate 评分
3. 提交 LLM 审校：构造审校 prompt，调用 `submitCraftRuleReview` 写入 `reviewing` 状态
4. 晋升+回归验证：调用 `promoteCraftRuleCandidate`（含自动回归验证，失败自动 rollback）
5. 触发技能迭代：调用 `runSkillIterationOnProduction` 更新生产环境 `skill_definitions`

**容错**：
- 证据收集失败 → 重试 2 次，仍失败则记录 candidate 状态为 `rejected` 并标注失败原因
- 审校 verdict=rejected → 记录 candidate 状态为 `rejected`，不阻塞后续 workflow
- 晋升回归验证失败 → 自动 rollback（`promoteCraftRuleCandidate` 已内置）
- 技能迭代失败 → 不阻塞晋升（promote 已成功），记录 warning

#### 2.2 新增 `runSkillIterationOnProduction`（`src/novel-v2/evaluation/skill-iteration.ts`）

**问题**：现有 `runSkillIteration` 需要 `ExperimentWorkspaceHandle`，而生产路径只能访问 `NovelPostgresRepository`。

**方案**：新增一个生产兼容的入口，直接操作公共 `skill_definitions` 表而非实验 schema。

```typescript
export async function runSkillIterationOnProduction(input: {
  repository: NovelPostgresRepository;
  model: ModelGateway;
  candidate: CraftRuleCandidate;
  reviews: Review[];
  learningAssessment: RuntimeLearningAssessmentV2;
}): Promise<IteratedSkill[]>
```

**与 `runSkillIteration` 的区别**：
- 不依赖 `ExperimentWorkspaceHandle`，直接查询 `skill_definitions` 表
- 写入 `iterated_skills` 表（同 `runSkillIteration`）
- 更新 `skill_definitions` 的 `prompt_sections` 和 `version`
- 使用 `createCraftRulePromotionService` 的版本管理逻辑确保并发安全

#### 2.3 新增 outbox consumer（`src/novel-v2/outbox-consumer.ts`）

**问题**：当前 `outbox_events` 表只有写入，没有消费者。

**方案**：新增一个轻量级 outbox consumer，作为 Temporal 的外部触发源。

```typescript
export class OutboxConsumer {
  async poll(): Promise<void> {
    // 轮询 outbox_events 表，查找未处理的事件
    // 对 learning.propose-improvement 事件，启动 LearningPromotionWorkflow
    // 幂等：以 assessmentId 作为 workflow id，避免重复启动
  }
}
```

**工作方式**：
- 轮询 `outbox_events` 表中 `event_type = 'learning.propose-improvement'` 且未被处理的事件
- 调用 Temporal Client 启动 `learningPromotionWorkflow`，workflow id = `learning-promotion-{assessmentId}`
- 记录处理状态到 `outbox_consumer_offsets` 表（可选，或直接用 outbox_events 的 id 做游标）
- 轮询间隔可配置（默认 30 秒），避免空转

#### 2.4 新增数据库表

```sql
-- outbox 消费游标（可选，简化实现可以用 outbox_events.id 做游标）
CREATE TABLE IF NOT EXISTS outbox_consumer_offsets (
  consumer_group TEXT PRIMARY KEY,
  last_event_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### 2.5 修改点汇总

| 文件 | 变更 |
|------|------|
| `src/novel-v2/temporal/workflows.ts` | 新增 `learningPromotionWorkflow` 定义 |
| `src/novel-v2/temporal/activities.ts` | 新增与 `learningPromotionWorkflow` 配套的 activities（loadCandidate, collectEvidence, submitReview, triggerSkillIteration） |
| `src/novel-v2/evaluation/skill-iteration.ts` | 新增 `runSkillIterationOnProduction` 函数 |
| `src/novel-v2/outbox-consumer.ts` | **新文件**：outbox 事件轮询消费者 |
| `src/novel-v2/postgres-repository.ts` | 新增 `listUnprocessedOutboxEvents`、`markOutboxEventProcessed` 方法 |
| `src/novel-v2/application/chapter-lifecycle.ts` | 无需修改（candidate 创建后由 outbox consumer 异步处理） |

### 2.6 不修改的模块

| 模块 | 原因 |
|------|------|
| `craft-rule/index.ts` | 核心函数（evaluate/promote/rollback）已完善，无需修改 |
| `craft-rule/promotion-service.ts` | 晋升服务已完善，无需修改 |
| `learning-assessment.ts` | 学习评估 prompt 已完善，无需修改 |
| `chapter-lifecycle.ts` | candidate 创建后异步处理，不阻塞生命周期 |

---

## 3. 工作流时序

```
novelIntentWorkflow / chapterReviewWorkflow
  │
  ├─ ... review → revise → commit ...
  │
  └─ assessLearning → recordLearning
       ├─ INSERT learning_assessments
       ├─ INSERT craft_rule_candidates (status=proposed)
       └─ INSERT outbox_events (event_type='learning.propose-improvement')
                                    │
                          ┌─────────┘
                          ▼
               OutboxConsumer.poll()
                    │
                    ├─ SELECT unprocessed outbox_events
                    └─ TemporalClient.start(learningPromotionWorkflow, {
                         workflowId: 'learning-promotion-{assessmentId}'
                       })
                                    │
                          ┌─────────┘
                          ▼
               learningPromotionWorkflow
                    │
                    ├─ 1. loadCraftRuleCandidate
                    ├─ 2. collectEvidence (evaluateCraftRuleOnFoundation)
                    │    ├─ source-failure scenario
                    │    └─ cross-scenario (auto selected)
                    ├─ 3. submitCraftRuleReview (LLM review)
                    │    └─ if verdict=rejected → mark rejected, return
                    ├─ 4. promoteCraftRuleCandidate
                    │    └─ if regression fails → auto rollback, return
                    └─ 5. runSkillIterationOnProduction
                         └─ UPDATE skill_definitions.prompt_sections
```

---

## 4. 边界情况与容错

| 场景 | 处理 |
|------|------|
| candidate 已被手动晋升 | `promoteCraftRuleCandidate` 幂等检查，跳过 |
| 证据收集 LLM 失败 | 重试 2 次，失败后标记 candidate=rejected |
| 回归验证失败 | `promoteCraftRuleCandidate` 自动 rollback，candidate 保留 `rolled-back` 状态 |
| 技能迭代失败 | 不阻塞晋升（promote 已成功），记录 warning |
| 同一 assessment 的 workflow 重复启动 | 以 `learning-promotion-{assessmentId}` 为 workflow id，Temporal 保证幂等 |
| outbox 消费重复 | 以 `outbox_events.id` 做游标，确保 at-least-once 语义 |
| 并发 promote 冲突 | `promotion-service.ts` 的 `stale-target-version` 检测防止并发覆盖 |

---

## 5. 验证步骤

1. 单元测试：`LearningPromotionWorkflow` 各阶段函数
2. 集成测试：outbox consumer 轮询 + Temporal workflow 启动
3. 回归测试：promote 后回归验证逻辑（复用 `craft-rule.test.ts`）
4. 端到端测试：章节审校 → learning assessment → candidate 创建 → outbox → workflow → promote → skill 迭代