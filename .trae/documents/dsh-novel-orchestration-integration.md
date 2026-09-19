# 基于 DeepSeek Harness 二次开发：小说/短剧自主编排集成计划

**状态（2026-09-19）**：Phase 0/1 已落地，运行期细节现由**已跟踪**的 `docs/orchestrator/dsh-integration.md` 与 `dsh-runbook.md` 承载，本文保留为当初的规划记录。文中量化口径已过时：MCP 工具面现为 50（`mcp/tool-definitions.ts` 的 `TOOL_NAMES`，由 `mcp-tool-face-single-source.test.ts` 与代码/注册表/两份 spec/三份 skill 五面对账），本文写作时为 40；技能数亦非 4（`skills/novel-v2/` 与 `.agents/skills/` 现各成体系）。以代码为准。

> 创建：2026-09-04。目标：以 DeepSeek Harness（dsh）为自主编排运行时，二次开发创作编排插件与技能，最终集成进 CreativeStudio 产品，覆盖小说创作与短剧创作两条工作流。

## 1. 背景与核心结论

### 1.1 Token 可行性结论（用户首要疑问，已调查确认）

**「用 TRAE CN 订阅模型驱动 dsh 白嫖 token」官方不可行**：TRAE CN 不提供把订阅模型暴露为 OpenAI 兼容 API 的能力（只支持把外部 API 配置进 TRAE，不支持反向输出）。社区 trae2api 类反向代理属灰色方案（ToS 风险高、不稳定），不作为架构基础。

**已确认的替代路径（混合模式，用户已选定）**：
- dsh 编排引擎：免费/便宜 OpenAI 兼容端点（GLM 免费额度 bigmodel.cn、DeepSeek 官方 API、本地 Ollama）
- TRAE 保留为人工治理驾驶舱：方向性决策、最终审核、发布（继续沿用现有 `.agents/skills/novel-mcp-orchestration` 模式）
- 分工依据：编排（治理）token 量远小于产出 token；高频自主推进（章节循环、审核回流、短剧生成）用便宜模型，关键决策留给 TRAE/人工

### 1.2 技术可行性（已验证的关键事实）

| 事实 | 结论 |
| --- | --- |
| dsh 原生 `@deepseek-ai/dsh-mcp-client` 插件 | 一条配置即可桥接 MCP server，工具注册为 `mcp__<serverName>__<tool>`，支持 stdio 与 streamable-http |
| novel-v2 MCP server | 已支持 Streamable HTTP（`npm run novel:mcp:v2:http`，默认端口 7654，POST /mcp），零改动可直接接入 |
| dsh 自定义模型 provider | `settings.yaml` 的 `llm-pi-ai.providers` 块：`api: openai-completions` + `baseURL` + `apiKeyEnv` + `models` + `compat` 开关，任意 OpenAI 兼容端点可用 |
| 本机 Node | v24.14.1，满足 dsh 要求（^22.19 或 ≥24） |
| dsh 形态 | Web UI（本地 3080）/ headless 一次性任务 / ACP JSON-RPC / Python SDK，产品化有接入路径 |
| dsh 版本状态 | 0.1.0-rc.x Developer Preview，破坏性变更预期 → 必须 pin 版本 |

## 2. 现状分析

### 2.1 CreativeStudio 现有架构

- **产出层（系统内部）**：`src/novel-v2/`，PostgreSQL（结构化真源）+ Temporal（durable execution）+ 对象存储 + Qdrant（可重建索引）
- **工作流**：Foundation 5 阶段规划 → Story Arc → 事实检索/上下文编译 → 正文生成 → 三类审校 → 质量门 → 事实提取 → commit → learning 闭环 → skill 晋升（详见 `docs/novel-v2/workflow-map.md`）
- **MCP 工具面**：40 个工具（`src/novel-v2/mcp/tool-definitions.ts`），入口 `scripts/novel-v2-mcp-server.mjs`（stdio / HTTP 7654）
- **外部编排契约**（`docs/novel-v2/mcp-orchestrator.md`）：外部模型五职责（编排/审核/推进/编辑/迭代优化），治理动作全部走 MCP 工具，不绕质量门
- **短剧创作**：`novel_chapter_script_h3` / `novel_short_script_h3` / 外部提交双轨（`src/novel-v2/application/chapter-script-h3.ts`、`short-script-h3.ts`）
- **技能层**：`.agents/skills/` 下 4 个 SKILL.md 格式技能（novel-writing、novel-mcp-orchestration、h3-prompt-writing、short-drama-writing）
- **产品层**：React 19 + AntD + Vite 前端（`src/pages`），Koa API + Temporal worker（`npm run novel:v2:api` / `novel:v2:worker`）

### 2.2 缺口（本计划要补的）

1. 外部编排目前靠人在 TRAE 里手动逐工具驱动，无自主循环、无持久会话、无轨迹回放
2. 无可编程的编排 Agent 运行时（dsh 可补：会话 fork/resume、轨迹审计、headless 自动化）
3. 产品内无"自主创作 Agent"能力（Phase 3 目标）

## 3. 目标架构

```
┌─────────────────────────────────────────────────────┐
│ 治理层（人工/TRAE，方向与终审）                          │
│   TRAE CN（novel-mcp-orchestration skill，现状保留）     │
└──────────────────────┬──────────────────────────────┘
                       │ MCP（HTTP 7654，同一工具面）
┌──────────────────────▼──────────────────────────────┐
│ 自主编排层（新增）：DeepSeek Harness 运行时              │
│   ├ dsh-mcp-client 桥接 novel-v2 40 工具               │
│   ├ @creative-studio/dsh-novel-orchestrator（二次开发） │
│   │   ├ 工具分组按阶段注册（token 优化）                  │
│   │   ├ 受限模式：无文件写/shell（防绕质量门）              │
│   │   └ 治理辅助工具（workflow 状态决策视图）              │
│   ├ dsh skills：novel-orchestration / short-drama-*    │
│   └ 编排模型：GLM 免费 / DeepSeek / Ollama（可插拔）      │
└──────────────────────┬──────────────────────────────┘
                       │ MCP（不变）
┌──────────────────────▼──────────────────────────────┐
│ 产出层（现状不动）：novel-v2 + PostgreSQL/Temporal        │
└─────────────────────────────────────────────────────┘
```

关键原则：
- **零侵入**：产出层与 MCP 工具面零改动，dsh 只是新的 MCP 客户端
- **不 fork dsh**：以官方推荐的插件 + skill + preset 形式二次开发，可随 dsh 升级；仅当必须改 Agent Loop 核心时才考虑 fork
- **门禁安全**：编排 agent 不注册文件写/shell 工具，所有落库走 MCP 工具（延续"不提供绕过质量门的直接改正文工具"契约）
- **新架构独立目录**：`orchestrator/` 顶层目录（用户偏好：便于迁移）

## 4. 分阶段实施计划

### Phase 0 — 可行性 PoC（本地，验证技术路线）

**目标**：dsh Web UI 中通过自然语言成功调用 novel-v2 MCP 工具。

步骤：
1. 安装 dsh：`npm install -g @deepseek-ai/dsh`（或 npx 按需）
2. 启动 novel-v2 MCP server：`npm run novel:mcp:v2:http`（确认 7654 端口可用）
3. 配置 dsh 编排模型（Web UI Settings → Models → Add a custom provider，或 `$DSH_HOME/settings.yaml`）：
   ```yaml
   llm-pi-ai:
     providers:
       glm-free:
         apiKeyEnv: GLM_API_KEY
         api: openai-completions
         baseURL: https://open.bigmodel.cn/api/paas/v4
         models:
           - id: glm-4-flash
   ```
   （备用：DeepSeek 官方端点 `https://api.deepseek.com/v1`；本地 Ollama `http://127.0.0.1:11434/v1`）
4. 配置 dsh-mcp-client（项目级 `cordis.patch.yml`）：
   ```yaml
   - id: mcp-novel
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       serverName: novel
       transport: streamable-http
       url: http://127.0.0.1:7654/mcp
   ```
5. 验证：dsh 会话中让 agent 调用 `mcp__novel__novel_skill_get`、`mcp__novel__novel_catalog_get`、`mcp__novel__novel_workflow_get`
6. 验证 dsh 项目级 skill 目录发现机制（确认 dsh 读取 `.agents/skills/` 还是自有路径，以及 SKILL.md 格式兼容性）— TODO PoC 确认，这是 Phase 1 的前置

产出：
- `orchestrator/dsh/` 目录：`settings/llm.example.yaml`、`cordis.patch.yml` 模板
- PoC 结论文档（写入 `docs/orchestrator/`）

验收标准：agent 成功列出并调用 ≥3 个 novel 工具；skill 目录机制确认。

### Phase 1 — 本地自主编排闭环（小说 + 短剧）

**目标**：dsh agent 在 skill 指引下自主走完小说小闭环与短剧生成。

步骤：
1. 编写 `orchestrator/dsh/skills/novel-orchestration/SKILL.md`：
   - 改编自 `.agents/skills/novel-mcp-orchestration/SKILL.md`（治理协议：五职责、manual-gate 推进协议、`review.submit(revise)` 优先于 `work.revise`、编排权威顺序、规划审核 PASSED 文本契约）
   - 适配 dsh skill 加载方式（按 Phase 0 结论放置/挂载）
2. 编写 `orchestrator/dsh/skills/short-drama-orchestration/SKILL.md`：
   - 短剧编排流程：定稿章节读取 → `novel_chapter_script_h3` / `novel_short_script_h3` → cinematicHints 检查（零阻断原则）→ 外部提交双轨 → 迭代
   - 承载 H3 契约要点（10-15s 段时长、御剑等文化意象保真、空间连续运动单长镜头）的编排侧检查项
3. 小说闭环实测（小项目，≤3 章）：`novel_project_create` → foundation 阶段审核（PASSED/revise 契约）→ `novel_story_arc_start` → `novel_chapter_generate` → 审核修订回流 → commit
4. 短剧闭环实测：取 1 个定稿章节 → H3 剧本生成 → 质量检查 → （如需）外部提交修订
5. 验证会话持久化价值：长会话中途 fork/resume、轨迹视图回放审核决策链
6. 模型能力评估：记录 GLM 免费模型在治理决策上的表现；不足则切换 DeepSeek 端点对比

产出：skills 目录 + `docs/orchestrator/dsh-runbook.md`（运行手册：启动、配置、常见循环模式）

验收标准：
- 小说小项目全链路自主走完（含至少一次 revise 回流）
- 短剧 1 个 H3 剧本生成且核心意象保真
- 会话中断后 resume 可继续

### Phase 2 — dsh 插件二次开发（`@creative-studio/dsh-novel-orchestrator`）

**目标**：从"配置组装"升级为开箱即用插件，做 token 与安全优化。

步骤：
1. 创建插件包 `orchestrator/dsh-plugin/`（Cordis 插件，参考 dsh 插件开发文档的 manifest + 入口结构）：
   - `package.json`（name: `@creative-studio/dsh-novel-orchestrator`）
   - `src/index.ts`：插件入口，注册以下能力
   - `src/mcp-bridge.ts`：内置 novel-v2 MCP client 挂载（streamable-http，端口/URL 可配置，默认 7654），用户免手动配置
   - `src/tool-groups.ts`：**工具分组按阶段注册**（foundation / arc / chapter / short-drama / learning 五组，按当前工作流阶段挂载子集）— 根因：40 工具 schema 每请求全量注入的 token 成本；分组后单请求工具面缩小
   - `src/governance-tools.ts`：治理辅助工具（如 workflow 状态摘要：调用 `novel_workflow_get` 后压缩为决策视图再进上下文，降低上下文膨胀）
   - 受限模式：插件 profile 不注册文件写/shell 工具（防绕过 MCP 质量门）
2. 创作 preset profile：`orchestrator/dsh-plugin/profiles/`（novel-full / short-drama / mixed）
3. npm scripts 集成（根 package.json）：
   - `"dsh:web": "dsh web"`（本地工作台）
   - `"dsh:exec": "dsh exec"`（headless 一次性编排任务）
4. 测试：插件单测（vitest）+ dsh 实测（工具分组切换、MCP 桥接、受限模式生效）

产出：`orchestrator/dsh-plugin/`（完整插件包）+ 使用文档

验收标准：`dsh plugin --profile web add ./orchestrator/dsh-plugin` 后开箱即用；工具分组生效（不同阶段会话工具列表不同）；文件写/shell 工具不可见。

### Phase 3 — 产品化集成（CreativeStudio 内嵌 dsh）

**目标**：Web 产品内提供"自主创作 Agent"能力。

步骤：
1. 版本锁定：根 package.json / 部署清单固定 dsh 版本（Developer Preview 破坏性变更风险）
2. 后端（Koa api）：新增 `/api/orchestrator/*` 路由
   - `POST /api/orchestrator/sessions`：启动编排会话（spawn dsh headless / ACP 连接，指定 preset、模型、projectId）
   - `GET /api/orchestrator/sessions`、`GET /api/orchestrator/sessions/:id/trajectory`：会话列表与轨迹（转发 dsh SessionEvent 流）
   - `POST /api/orchestrator/sessions/:id/pause|resume|stop`
3. 前端（React）：新增"自主创作"页面（`src/pages/`）
   - 会话列表卡片（preset、模型、项目、状态）
   - 轨迹视图（模型轮次、工具调用、审核决策流，参考 dsh Trajectory 视图语义渲染，遵循"不暴露原始 JSON/全量 UUID"的既有 UI 约定）
   - 启动面板（选 preset / 项目 / 模型端点）
   - 人工介入点：manual-gate 项列出待审列表，跳转现有审核界面
4. spec 文档：`docs/orchestrator/dsh-integration.md`（设计意图、数据流、约束，遵循 AGENTS.md spec 同步演进规则）

产出：后端路由 + 前端页面 + spec 文档

验收标准：产品 UI 启动小说/短剧编排会话、查看轨迹、manual-gate 人工审核介入闭环。

## 5. 关键决策与假设

| 决策 | 理由 |
| --- | --- |
| 不 fork dsh，以插件/skill/preset 二次开发 | dsh 官方推荐路径，可随上游升级；fork 维护成本高，仅当必须改 Agent Loop 核心时再评估 |
| 混合模型策略 | TRAE token 无法官方复用；治理高频动作用便宜端点，方向决策留 TRAE/人工 |
| MCP 传输用 streamable-http（7654） | 已有 `novel:mcp:v2:http` 零改动；stdio 需 dsh spawn tsx 链路复杂且 Windows 兼容差 |
| 编排 agent 无文件写/shell 权限 | 延续"不绕过质量门"契约，防止 agent 直改产物 |
| 新代码全部放 `orchestrator/` 顶层目录 | 用户偏好：新架构独立文件夹便于迁移 |
| 现有 `.agents/skills/` 保持不动，dsh skills 独立副本 | 两套消费方（TRAE 与 dsh）格式可能有差异，独立演进避免互相破坏；成熟后可再统一 |

假设与风险：
1. dsh skill 目录机制与 SKILL.md 格式兼容性 — Phase 0 验证；不兼容则写适配（转换脚本或双格式）
2. dsh 0.1.0-rc 破坏性变更 — pin 版本，锁定所用 API 面（mcp-client、providers、plugin contract）
3. GLM 免费模型治理能力不足 — PoC 实测；降级方案：DeepSeek 端点（成本仍低）或升级 GLM 付费模型仅用于终审
4. Windows 上 dsh PTY 相关能力有限（官方仅 Linux/macOS）— 全程用 Web UI + headless，不依赖 TUI
5. 40 工具 token 成本 — Phase 0/1 全量挂载可接受（编排频次低），Phase 2 工具分组根治

## 6. 验证步骤

每阶段验收见上文。全局回归：
1. 现有测试不受影响：`npm run lint`、`npm test`、`npm run novel:v2:smoke`（dsh 是新增 MCP 客户端，零侵入）
2. 现有 TRAE 编排模式不受影响：`.agents/skills/novel-mcp-orchestration` 契约与 MCP 工具面未改动
3. 端到端抽查：dsh 编排产生的章节/短剧产物在产品 UI 中正常可见（同一 PostgreSQL 真源）
4. 门禁回归：dsh 编排下质量门正常拦截（故意构造审核不通过场景，验证 revise 回流而非绕过）

## 7. 里程碑顺序

Phase 0（PoC）→ Phase 1（本地自主闭环）→ Phase 2（插件化）→ Phase 3（产品化）。每阶段验收通过后进入下一阶段；Phase 1 完成即可获得日常可用价值（本地自主推进小说/短剧），Phase 3 完成达成"集成进 CreativeStudio 产品"的最终目标。
