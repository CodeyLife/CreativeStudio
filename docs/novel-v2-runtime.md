# Novel V2 Runtime

Novel V2 is the direct replacement for the previous browser/SQLite novel runtime. Web is a presentation client; durable state lives in PostgreSQL, long-running work is owned by Temporal, object content is stored through the object-store seam, and memory retrieval is PostgreSQL lexical plus optional Qdrant semantic recall.

## Standard Local Stack

1. Copy `.env.example` to a local ignored file if you need real model keys. Do not commit real keys.
2. Use the single development entrypoint. It starts Docker infrastructure only, then waits for migrations, API, Worker, and Vite:

```powershell
pnpm dev
```

`pnpm dev` supplies one absolute-path configuration for PostgreSQL, Temporal, Qdrant, MinIO/S3, API, Worker, migrations, and Vite. The runtime fingerprint includes the migration files and manifest, so a schema subtraction cannot silently reuse an old API or Worker process. It reuses an existing service only when the runtime fingerprint matches; an occupied port with an unknown or different identity is a hard failure. The V2 API listens on `http://127.0.0.1:4770` and Vite proxies `/v2/*` to it. Model providers are configured only through `config/model-providers.local.yaml` or the settings API; a missing local file means external-MCP-only execution.

所有结构化调用统一使用 provider 原生 JSON Schema envelope：Responses 使用 `text.format`，Chat Completions 使用 `response_format.json_schema`。Gateway 会在发送前拒绝 optional properties、动态 object、空 object、`additionalProperties: true` 和不稳定组合关键字；失败分类为 schema incompatibility，只切换下一个原生候选或外部 MCP，不把 schema 注入 prompt，也不回退到 prompt 模式。原生响应仍经过 AJV 和业务语义校验/修复循环。

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
- `POST /v2/commits` is guarded by `CommitService` and requires both current internal and independent review evidence for the artifact fingerprint; chapter workflows also pass applicable blueprint dimensions so missing D1-D5 evidence cannot bypass the final commit check.
- `GET/PUT /v2/model-config` reads or atomically replaces the masked global provider and purpose routing configuration.
- `GET /v2/model-tasks` and the claim/heartbeat/submit/fail routes back external MCP execution without calling a model API.

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
