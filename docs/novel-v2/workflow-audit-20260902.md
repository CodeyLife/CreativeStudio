# novel-v2 小说创作 & 短剧创作流程审核报告

> 审核范围：`src/novel-v2`（Temporal 编排 + 应用层 + 持久化）以及短剧脚本两条生成链路。

**状态（2026-09-19 复核，逐条对照代码后归档）**：本报告的**行号已漂移**（如 `novelIntentWorkflow` 现在 `temporal/workflows.ts:220`），且三条 P0 现均不成立：P0-1 短剧链路被 09-17 的无状态 `POST /v2/short-script-h3` 取代；P0-2 短剧**按设计**没有 Temporal 工作流（`workflows.ts` 零命中，产物由前端 IndexedDB 留痕，见 `.trae/documents/短剧板块浏览器本地存储实施方案.md`）；P0-3 `storyArc` 不属于 Foundation 计划段——`PROJECT_PLAN_STAGES` 只有 5 个 taskKey（`application/project-plan.ts:26-32`），故事弧另有独立工作流与工具面，`REQUIRED_APPROVED_PLAN_TASK_KEYS` 列全这 5 项即为正确。保留本报告作为当时取证记录，不再作为待办来源。
> 审核目标：定位**潜在问题**与**可优化点**，按严重程度（P0/P1/P2）排序，每条均附 `file:line` 证据。
> 日期：2026-09-02

---

## 一、流程全景（先对齐，再找问题）

### 1. 小说创作管线（走 Temporal 持久化执行）
入口 `novelIntentWorkflow`（`temporal/workflows.ts:203`）：
`loadProjectSnapshot → createPreflight → retrieveMemory → resolveSkills → listFoundationArtifacts`
→ **前置门** `assertRequiredPlanApproved`(`:252`) + `assertChapterGenerationAllowed`(`:254`)
→ `compileBlueprint` → `runDraft` → `runChapterLifecycle`（`application/chapter-lifecycle.ts:66`）。

章节生命周期（`chapter-lifecycle.ts:66`）：`inspect(结构校验) → review(3 审并行) → revise(≤2 轮) → extractFacts → approveFacts → commit → enrich(角色富化) → assessLearning`。
质量门：`evaluateCommitGate`（`temporal/revision-policy.ts:103`），阈值 `MIN_AUTOMATIC_COMMIT_SCORE=4.0`、`MIN_REVIEWER_SCORE=3.5`、最大自动修订 `DEFAULT_MAX_AUTO_REVISIONS=2`。

规划阶段由 `creativeRunWorkflow`（`workflows.ts:965`）编排 `project_plan_sections`（定位/架构/人物/世界观/情节设计），门控键 `REQUIRED_APPROVED_PLAN_TASK_KEYS`（`application/project-plan.ts:64`）。

故事弧 `storyArcPlanningWorkflow`（`workflows.ts:780`）是**独立工作流**，有专属锁 `withStoryArcWorkflowLock`（`postgres-repository.ts:427`）。

### 2. 短剧/分镜脚本管线（**不走 Temporal**，直接应用层 + MCP 调用）
- **章节剧本** `generateChapterScriptH3`（`application/chapter-script-h3.ts:817`）：以**已定稿章节正文**为唯一事实源，产物落 `artifacts(kind=chapter-script)`。触发点：`src/pages/novel-v2/ChapterScriptModal.tsx`、MCP `novel_chapter_script_h3`（`mcp/handlers.ts:1192`）、HTTP `scripts/novel-v2-api.ts:716`。
- **创意短剧** `generateShortScriptH3`（`application/short-script-h3.ts:268`）：以**核心创意**为起点，**不依赖小说项目**（`projectId` 可选），产物落 `short_scripts` 独立表（迁移 050）。触发点：MCP `novel_short_script_h3`（`mcp/handlers.ts:1240`）、HTTP `:768/:819`。

两条脚本链共享同一六段式 schema 与 `h3-video-prompt` skill，但均为**直接函数调用**，没有 Temporal workflow 包裹。

---

## 二、潜在问题（按优先级）

### 🔴 P0-1：两个脚本生成器存在幂等竞态，会白白烧掉 LLM 成本

**证据**
- short-script：`findShortScriptByFingerprint`（`:313-317`）先于生成检查；落库用 `ON CONFLICT(source_fingerprint) DO NOTHING`（`postgres-repository.ts:4695`）。并发同创意时两者都查不到 → 都去调 LLM（~32k 输出 token）→ 仅一个插入成功，另一个**已付费的产物被静默丢弃**（注释也承认这一点，`:4691`）。
- chapter-script：先查 `existingArtifact`（`:851-858`），再 `recordArtifact` 用 `ON CONFLICT(id) DO NOTHING`（`:2462`），而 `id` 是 `randomUUID`（`:801`）。并发同章节生成会**插入两条不同 id 的脚本产物**——没有 `(document_id, source_fingerprint, contractVersion)` 唯一约束，重复脚本会累积。

**影响**：同一请求并发触发（UI 重复点击 / MCP 重试 / 多端）会重复生成、重复计费；chapter-script 还会留下孤儿 artifact。
**建议**：
1. short-script 改为「先 `INSERT ... ON CONFLICT(source_fingerprint) DO NOTHING` → 若冲突再 `SELECT` 读回」，把"生成"放到唯一约束之后；或生成前对 fingerprint 取 `pg_advisory_xact_lock(hashtext(fp))`。
2. chapter-script 增加唯一索引 `ux_chapter_script_unique(document_id, source_fingerprint, contract_version)`，并对 `recordArtifact` 改用冲突回读，避免 randomUUID 绕过去重。

### 🔴 P0-2：短剧生成完全绕过 Temporal 编排（无持久化/可恢复/可观测）

**证据**：`generateShortScriptH3` / `generateChapterScriptH3` 只被 HTTP handler（`scripts/novel-v2-api.ts:716/768/819`）与 MCP handler（`mcp/handlers.ts:1192/1240`）直接调用；`NovelWorkflowActivities` 接口（`workflows.ts:51-131`）中**没有**这两个 activity。整个 `novelIntentWorkflow` 有 `updateWorkflowStatus` 状态机、signal 等待、`condition` 超时、候选链重试，脚本链一概没有。

**影响**：
- API/Worker 进程在模型生成中途崩溃 → 任务丢失，**无法从断点恢复**，用户看到超时，LLM 成本已花。
- 没有 `workflow_runs` 记录 → 脚本生成**不可观测**（无法在 pipeline 看板追踪、无法审计耗时/成本）。
- 重试完全依赖 `model-gateway` 的 3 候选链（`model-gateway.ts:588`），没有编排层兜底。

**建议**：将脚本生成收敛为一个轻量 Temporal workflow（或至少复用 `recordWorkflowStatus` + 入 `workflow_runs` + 失败可重试），与小说章节管线对齐；MCP/HTTP 只发 signal/启动 workflow。

### 🔴 P0-3：故事弧（story arc）未纳入章节生成的前置门

**证据**：章节生成前置门 `assertRequiredPlanApproved`（`postgres-repository.ts:2780`）只校验 `REQUIRED_APPROVED_PLAN_TASK_KEYS = [project-positioning, architecture, characters, worldview, plot-design]`（`project-plan.ts:64`）。`storyArc` 不在其中；`novelIntentWorkflow` 也仅在 `taskClass==drafting/revision` 时调 `assertRequiredPlanApproved` + `assertChapterGenerationAllowed`，**没有任何 story-arc 校验**。且 Explore 确认"story-arc 重基线不影响已定稿章节重审"。

**影响**：章节可以在**故事弧尚未规划/批准**的情况下生成；弧批准后若再改（rebase），已定稿章节不会级联回算，出现"章节内容与最新弧冲突"的隐性不一致。
**建议**：明确产品语义——若 story arc 为必选，应加入 `REQUIRED_APPROVED_PLAN_TASK_KEYS` 或独立的 `assertStoryArcApproved`；若其为可选，应在文档/UI 明示"章节不保证遵循最新弧"，并提供"按弧重基线重审章节"的操作入口。

---

### 🟠 P1-1：章节生成缺少「按文档」的并发锁

**证据**：`assertChapterGenerationAllowed`（`postgres-repository.ts:4751`）仅当 `status==='final' || current_revision_id !== null` 时拒绝（即"已定稿/已提交"不可再生成）。对仍为 `planned` 的章节，两个**不同 intent.id** 的 `novel_chapter_generate` 会**同时通过**该校验；Temporal 仅按 `workflowId = novel-intent-${intent.id}` 去重，不同 id 即两个 workflow，各自 commit 不同 `idempotencyKey` → 可能写出两个 final revision。对比 story arc 已有 `withStoryArcWorkflowLock`（`postgres-repository.ts:427`）。

**影响**：并发触发的章节生成可能双写最终稿。
**建议**：在生成入口加 `withChapterGenerationLock(projectId, documentId)`（advisory lock），或在 `commit` 侧对"document 处于 generating"加唯一/状态约束。

### 🟠 P1-2：脚本产物「零阻断契约」= 完全不做输出校验

**证据**：`generateStructured` 调用**未传 `extraValidate`**（`short-script-h3.ts:352-365`、`chapter-script-h3.ts:900-913`）；`normalizeChapterScriptOutput` 注释写明"零阻断组装"，结构问题（节拍覆盖缺失、片段数超预算、总时长漂移、缺运镜/景别）全部降级为 `cinematicHints`/人工复核提示（`observeShortScriptTotalDuration` `:122`）。这是 2026-08-31 用户指令，但存在质量与体验风险。

**影响**：结构破损/时长严重不足的脚本会**以"可用"形态直接展示**给用户；即便 `hints` 里有提示，前端若不强提示则用户难察觉。
**建议**：UI 侧把 `cinematicHints` 作为**醒目警告横幅**呈现；提供 opt-in 的自动 repair（重跑失败片段）开关；对时长/节拍覆盖缺失给出量化评分。

### 🟠 P1-3：人工审校循环没有迭代上限

**证据**：`novelIntentWorkflow` 的 `while (!lifecycle.commitResult)`（`workflows.ts:438`）每次收到 `humanSignal` 的 `revise` 决策就**重新跑整轮 `runChapterLifecycle`**（`:463-479`：再 draft + 3 审 + revise + 3 审 + 事实 + 富化）。自动修订有上限 2（`DEFAULT_MAX_AUTO_REVISIONS`），但人工循环**无上限**。

**影响**：作者反复"微调重生成"会线性放大 LLM 成本，且无冷却/告警。
**建议**：增加人工修订上限（如 `MAX_HUMAN_REVISIONS`），超限转交人工队列并提示；或在每次循环累加成本并告警。

### 🟠 P1-4：章节重定稿后旧脚本产物成为孤儿

**证据**：chapter-script 指纹含 `contentHash + sourceRevisionId`（`:850`），章节每重定稿都生成**新 artifact**；旧 artifact 无 `superseded` 标记，前端永远 `ORDER BY created_at DESC LIMIT 1`（`:852-857`）只看最新，旧记录长期堆积。

**影响**：`artifacts` 表随改稿次数线性增长，且历史脚本无法区分"有效/过期"。
**建议**：落库时标记上一版为 `superseded`；或加保留策略（仅保最近 N 版）。

---

### 🟡 P2（优化/健壮性）
- **P2-1 专名漂移检测只告警不拦截**：`detectNamedEntityDrift`（`revision-policy.ts:263`）注释"不自动拒绝修订"，结果未接入 commit 门。高严重度漂移（角色名被改）应至少置为人工确认。
- **P2-2 记忆门硬抛失败整章**：`enforceMemoryCoverage` 连续缺失超阈值直接 `throw`（`workflows.ts:261`）使整章 workflow 失败，无降级路径；建议提供"降级草稿 + 告警"而非整章失败。
- **P2-3 外部 MCP 路径占用 workflow 槽 15 分钟**：`condition(..., "15 minutes")`（`workflows.ts:268`）在外部任务卡住时长时间占用；高并发下需监控 worker 负载。
- **P2-4 两条脚本链近重复代码**：`chapter-script-h3.ts`(943 行) 与 `short-script-h3.ts`(398 行) 共用 schema/skill 但逻辑各自一份，易产生行为漂移；建议抽出共享 driver（仅事实源/落库表不同）。

---

## 三、可优化点汇总（价值导向）

| 方向 | 现状 | 优化建议 | 优先级 |
|---|---|---|---|
| 脚本生成可靠性 | 直接调用，无持久化/可恢复 | 包成 Temporal workflow 或加 `workflow_runs`+状态回写 | P0-2 |
| 脚本去重 | 查后生成，竞态烧钱；chapter-script 无唯一约束 | 先插后读 / advisory lock；chapter-script 加唯一索引 | P0-1 |
| 规划→章节一致性 | 故事弧未门控 | 明确必选并加门 / 否则明示+提供重基线重审 | P0-3 |
| 章节并发 | 仅 final 才拦 | 加按文档 advisory lock | P1-1 |
| 脚本质量 | 零阻断、无评分 | UI 醒目提示 hints + opt-in auto-repair + 量化评分 | P1-2 |
| 成本控制 | 人工重生成无上限 | 人工修订上限 + 成本告警 | P1-3 |
| 数据卫生 | 旧脚本孤儿 | superseded 标记 / 保留策略 | P1-4 |
| 一致性拦截 | 漂移仅告警 | 高严重度漂移置人工确认 | P2-1 |
| 降级韧性 | 记忆缺失整章失败 | 降级草稿路径 | P2-2 |
| 代码复用 | 双脚本链重复 | 抽共享 driver | P2-4 |

---

## 四、结论

管线在**小说章节创作**一侧设计相当成熟（三审并行容错、best-draft 回退、质量门、命名漂移检测、稳定幂等键、专名锁），但**短剧脚本侧明显是"后接入的轻量链路"**：既绕过了 Temporal 的持久化/可恢复/可观测能力，又在幂等去重上存在真实的竞态与计费浪费。最该优先处理的是 **P0-1（脚本竞态计费）**、**P0-2（脚本无编排可恢复性）** 与 **P0-3（故事弧与章节的一致性缺口）**。

> 注：本报告基于静态代码审阅（含 `file:line` 引用），未运行端到端测试；涉及并发/竞态的结论建议在预发环境用并发压测验证后再落地修复。
