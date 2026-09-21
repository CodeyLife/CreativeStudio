# Novel V2 Runtime

Novel V2 is the direct replacement for the previous browser/SQLite novel runtime. Web is a presentation client; durable state lives in PostgreSQL, long-running work is owned by Temporal, object content is stored through the object-store seam, and memory retrieval is PostgreSQL lexical plus optional Qdrant semantic recall.

## Standard Local Stack

1. Copy `.env.example` to a local ignored file if you need real model keys. Do not commit real keys.
2. Use the single development entrypoint. It starts Docker infrastructure only, then waits for migrations, API, Worker, MCP (HTTP), and Vite:

```powershell
pnpm dev
```

`pnpm dev` supplies one absolute-path configuration for PostgreSQL, Temporal, Qdrant, MinIO/S3, API, Worker, MCP, migrations, and Vite. The runtime fingerprint includes the migration files and manifest, so a schema subtraction cannot silently reuse an old API or Worker process. It reuses an existing service only when the runtime fingerprint matches; an occupied port with an unknown or different identity is a hard failure. The MCP health endpoint (`GET http://127.0.0.1:7654/`) reports the same fingerprint header, so a stale MCP instance cannot be silently reused either. The V2 API listens on `http://127.0.0.1:4770` and Vite proxies `/v2/*` to it. Model providers are configured only through `config/model-providers.local.yaml` or the settings API; a missing local file means external-MCP-only execution.

进程内监督自愈（2026-09-13 起，`scripts/stack-supervisor.ts`）：`pnpm dev` 持有其启动的每个服务句柄，监听 exit 事件按指数退避自动重启；连续快速崩溃触发熔断（停止重启、日志升级给人），崩溃前存活超过稳定窗口则重置熔断计数（决策规则住叶子纯模块 `src/novel-v2/stack-restart-policy.ts`，双向单测覆盖）。仅监督本进程启动的实例；外部实例只按指纹复用、其崩溃不自动重启（日志明示）。前身是计划任务 watchdog（`scripts/watch-v2-stack.ps1`，已删除）：交互会话下必然闪现控制台窗口，且端口探测对启动即崩溃的进程无条件永远重启。契约原则：自愈能力不得依赖会弹窗影响用户体验的 CLI 窗口——监督器只在用户已拥有的终端内输出日志，任何路径不产生自发窗口。

所有结构化调用统一使用 provider 原生 JSON Schema envelope：Responses 使用 `text.format`，Chat Completions 使用 `response_format.json_schema`。Gateway 会在发送前拒绝 optional properties、动态 object、空 object、`additionalProperties: true` 和不稳定组合关键字；失败分类为 schema incompatibility，只切换下一个原生 API 候选，不把 schema 注入 prompt，也不回退到 prompt 模式。原生响应仍经过 AJV 和业务语义校验/修复循环。

修复循环契约（2026-09-08）：首轮请求沿用请求方/路由默认 temperature；修复轮（repair ≥ 1）固定以 `REPAIR_TEMPERATURE=0.7` 重发（`model-gateway.ts`）——确定性 provider 在修复轮原样重发会逐字节复现同一非法输出，修复退化为空转（实测三次响应完全相同），抬温打破确定性，对所有 purpose 通用。解析失败报错保真：结构化输出完全无法 JSON 解析（全文/围栏块/平衡对象候选全部失败）时，错误信息为 `JSON 无法解析（<parse 错误>@position N，含附近原文）`，不再对 undefined 做 AJV 校验产生误导性的缺字段错误；仅当输出可解析但不满足 schema 时沿用 AJV 错误文本。

模型路由契约（2026-09-07 机制调整）：候选链只承载 API provider 候选，外部 MCP 不再是调用位置的可选执行者，而是所有文本/结构化调用链的隐式链尾兜底——显式 API 候选全部失败（或链为空）时，gateway 在虚拟兜底位（`candidateIndex = candidates.length`）执行路由级预算检查并记录 `waiting-external`，随后抛出 `ExternalMcpRequiredError` 交由 activity 物化为可认领的外部模型任务。历史运行快照中的显式外部候选按原语义继续执行；新配置（含设置页）不允许再写入显式外部候选，空候选链即「未配置 API 模型、全部由外部 MCP 兜底」。`memory.embed / memory.rerank` 向量链路没有外部任务物化路径，兜底不适用，候选耗尽后按原样失败。

Story Arc 的模型输出契约只包含当前需要的弧、批次和章节字段；剧情线引用只存在于 `threadResponsibilities[].threadRef`，`authorIntent` 仅作为规划输入，不写入弧模型，`thematicQuestions` 与 `phases[].exitCondition` 已从输出契约删除。弧规划先请求 `arc+batch`，再请求 `chapters`，两段都通过 schema 与业务校验后才组装 artifact。draft/review/revision 统一通过 `StagePromptPackage` 编译，三类 reviewer 并行启动；定向正文修订在同一上下文契约下按窗口或全文执行，失败结果不会创建 artifact。

Do not run `docker compose up -d` for the full stack alongside `pnpm dev`. The default Compose invocation starts infrastructure only. API, Worker, and Web are under the `container` profile and are started by `pnpm novel:v2:compose` with isolated `creative_studio_container_*` volumes and a separate MinIO bucket.

## Environment

Required local defaults are already provided by `scripts/dev-v2.mjs` and `docker-compose.v2.yml`:

- `DATABASE_URL=postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp`
- `TEMPORAL_ADDRESS=127.0.0.1:7233`
- `QDRANT_URL=http://127.0.0.1:6333`
- `NOVEL_OBJECT_BACKEND=s3`
- `S3_ENDPOINT=http://127.0.0.1:9000`
- `S3_BUCKET=ymcp-novel`

Runtime object storage is fail-closed. `NOVEL_OBJECT_BACKEND` must be explicitly set to `s3` or `file`; S3 requires a complete endpoint, bucket, and credential set, while file storage requires an absolute `NOVEL_OBJECT_ROOT`. The API and Worker bind the selected storage identity to PostgreSQL and refuse to start if another endpoint, bucket, or file root is later used with the same database. They also verify every current final manuscript object before accepting work.

Use `pnpm dev`, `pnpm novel:v2:api`, or `pnpm novel:v2:worker` so both services receive the same local runtime configuration. Invoking the TypeScript entrypoints directly also loads the same `.env.example`/`.env.local` precedence and absolute migration/model paths.

Before troubleshooting a page or service, run:

```powershell
pnpm novel:v2:doctor
pnpm novel:v2:migrations audit
```

Migrations that drop a table or column (`093`/`095`/`096`/`097`) are applied by `migrate()` at new-code startup, so the old processes must be gone before the new build starts: a still-running older process keeps its own copy of the now-invalid SQL and fails on that business path (worst case the commit transaction), not at boot. `novel:v2:doctor` reports the mismatch as the `dropped-face-writers` check — for each applied drop migration it derives the removed tables/columns, then greps the running api/worker `codeRevision` for statements still writing them. It is report-only (never changes the exit status); a failed git lookup is the only FAIL.

Normal startup blocks on checksum drift or unknown applied migrations. The one-time current-data repair is explicit:

```powershell
pnpm novel:v2:migrations repair-compatible
```

## HTTP surface

- `GET /health` checks API/PostgreSQL reachability.
- `GET /v2/projects` lists V2 projects.
- `POST /v2/projects` creates or updates a V2 project.
- `POST /v2/projects` accepts an optional versioned `creativeBrief`; omitted briefs remain compatible with premise-only clients.
- Foundation bootstrap defaults to `reviewGate=manual`; core planning sections require the current artifact review plus explicit author confirmation before downstream work unlocks. `reviewGate=none` is reserved for tests/debugging.
- `GET /v2/projects/:projectId` returns project detail plus manuscript document targets.
- `POST /v2/projects/:projectId/documents` creates a target manuscript document.
- `POST /v2/intents` submits a durable intent and starts `novelIntentWorkflow`.
- `GET /v2/runs/:workflowId` returns Temporal plus persisted workflow status.
- `GET /v2/runs/:workflowId/events` returns project-filtered outbox events; `Accept: text/event-stream` streams the same events.
- `POST /v2/commits` is guarded by `CommitService` and requires both current internal and independent review evidence for the artifact fingerprint; chapter workflows additionally pass the applicable target word count into the same gate (`length-under-target` blocks the auto path); D1-D5 dimension scores are **not** a commit prerequisite — `putReview` writes `dimension_scores: {}` and `evaluateCommitGate` takes no dimensions argument, so the reviewer-level scoring stays advisory by design (见 workflow-map 的 D1-D5 与篇幅门条目).
- `GET/PUT /v2/model-config` reads or atomically replaces the masked global provider and purpose routing configuration.
- `GET /v2/model-tasks` and the claim/heartbeat/submit/fail routes back external MCP execution without calling a model API.
- 同步链路的外部 MCP 兜底（2026-09-08）：进程内同步调用（创意短剧 `POST /v2/short-script-h3`、章节剧本直出等 REST 直返路径）没有外部任务物化通道；API 候选全部失败触发 `ExternalMcpRequiredError` 冒泡时，顶层错误通道经 `syncExternalMcpHttpStatus` 返回 **503**（可行动文案：补充 API 候选或由外部编排者走章节剧本派生的 `novel_chapter_script_h3_submit` 双轨；创意短剧轨 09-17 起无 MCP 工具，改由编排者自行组装后走 stateless REST），不再以裸 500（系统内部错误语义）暴露。

## Live smoke

With Docker running:

```powershell
docker compose -f docker-compose.v2.yml config --quiet
pnpm novel:v2:doctor
pnpm novel:v2:smoke
```

The smoke command is run against the already started standard stack. Do not mix it with the isolated `container` profile unless the target URL and data source are intentionally changed.

## Data authority and runtime identity

- PostgreSQL is the structured source of truth for projects, workflow projections, approvals, revisions, facts, and learning records.
- MinIO/S3 stores正文 objects referenced by PostgreSQL; its endpoint, bucket, and credentials are bound to the database runtime identity.
- Qdrant is a rebuildable semantic index. Its alias, collection dimension, and embedding revision must match the runtime configuration.
- IndexedDB/localStorage are client-only state: visual tool blobs/history, MCP call history, and UI preferences. They are never Novel V2 business truth.
- API and Worker expose the same non-sensitive runtime fingerprint through health responses and response headers. Secrets are never sent to the browser.

Then create a project and chapter target through Web or HTTP, submit a planning/drafting intent, and verify:

- `workflow_runs` contains accepted/running/completed or failed status.
- Outbox contains workflow and blueprint/artifact events for the project.
- Planning intents produce preflight, memory bundle, skill bundle, and execution blueprint records.
- Drafting without configured API providers creates durable external MCP tasks and waits without silently producing empty artifacts.
- A Foundation smoke test must also verify semantic-contract rejection, `review.foundation` evidence with the current artifact fingerprint, and the author-confirmation transition for the five core sections.

## Direct replacement boundary

The old `/v1/projects` runtime, `novelRuntimeClient`, SQLite runtime scripts, and legacy NovelStudio pages are not compatibility targets. Any reintroduction of those names should be treated as a regression unless it appears only in migration notes describing their removal.
