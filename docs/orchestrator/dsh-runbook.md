# dsh 编排运行手册（runbook）

面向操作者的日常运行与故障排查。架构与决策背景见 [dsh-integration.md](./dsh-integration.md)。

## 服务栈全景

```
dsh headless（编排 agent，gpt-5.6-sol @ gpt-relay 主路由）
  │ HTTPS 直连            sub2api.yujin8.top（编排模型中转）
  │
  │ （仅备用路由 glm-relay 需要：stream-bridge 17890 → glm2.yujin8.top）
  │
  │ MCP 7654           novel-v2 MCP server（41 工具）
  │                        │
  ├────────────────────────┤
  │                        ├── Temporal 7233（workflow 引擎）
  │                        │     └── novel-v2 worker（4771，taskQueue novel-v2）
  │                        │           └── novel-v2 系统内部模型（创作产出）
  │                        └── SQLite / Qdrant / S3（存储）
  │
  └── REST 4770         novel-v2 API（产物读取：短剧脚本等）
```

| 服务 | 启动命令 | 端口 | 健康检查 |
| --- | --- | --- | --- |
| Temporal server | （docker 或本地安装，一次性启动） | 7233 | `Test-NetConnection 127.0.0.1 -Port 7233` |
| novel-v2 worker | `npm run novel:v2:worker` | 4771 | `curl http://127.0.0.1:4771/ready` |
| novel-v2 API | `npm run novel:v2:api` | 4770 | `curl http://127.0.0.1:4770/v2/projects` |
| novel-v2 MCP server | `npm run novel:mcp:v2:http` | 7654 | `curl -X POST http://127.0.0.1:7654/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"1.0\"}}}'` |
| stream-bridge | `node orchestrator/dsh/stream-bridge.mjs` | 17890 | 启动日志 `[stream-bridge] ...` |
| dsh | 见下节 | — | `dsh plugin --profile headless list` |

## Web 常驻编排台（推荐形态）

配置已迁移到 `$DSH_HOME` 用户层，**`dsh web` 裸启动（不带 --patch）即具备完整编排能力**：

| 能力 | 用法 |
| --- | --- |
| 编排工具 | web profile 用户 patch（`$DSH_HOME/profiles/web/cordis.patch.yml`）自动注册 41 个 `mcp__novel__*` 工具 |
| 编排模型 | `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers`（gpt-relay 含 gpt-5.6-sol、glm-relay/glm-5.2）；GUI 模型选择器**按会话随时切换**，无需重启 |
| 任务安排 | 直接对 agent 说目标 → 按 `novel-autopilot` 协议 + goal 工具自主推进；GUI 的 goal / 轨迹 / Jobs 面板可视 |
| 进度查询 | 会话内对 agent 说「查进度」（agent 直调 `novel_catalog_get` / `novel_workflow_list`，秒回）；或终端跑 `pwsh orchestrator/dsh/status.ps1` |
| 密钥 | `$env:GPT_RELAY_API_KEY` / `$env:GLM_RELAY_API_KEY`（glm 路由另需 stream-bridge:17890） |

注意事项：
- 改 `$DSH_HOME/profiles/web/cordis.patch.yml` 需**重启 `dsh web`** 才生效（插件在启动时加载）；改 `settings.yaml` 的模型列表对模型选择器疑似热生效。
- web profile patch 与项目 `orchestrator/dsh/cordis.patch.yml` 的 mcp-novel 段是**手工同步**关系（$DSH_HOME 不受 git 管理），改一处记得另一处。
- settings.yaml 原始备份：`$DSH_HOME/settings.yaml.bak`（2026-09-07 配置迁移时留存）。

## Headless 形态：标准启动顺序与模型选择

（Web 常驻形态见上节；headless 适合无人值守定时任务。）

1. Temporal server（若未运行，Docker Desktop 拉起 creative-studio-temporal-1 等容器）
2. `npm run novel:v2:worker`（终端 1）
3. `npm run novel:mcp:v2:http`（终端 2；`novel:v2:api` 仅读产物时需要，worker 内嵌同源配置但 API 是独立服务）

### 编排模型选择与任务启动（推荐方式）

编排模型不在 `cordis.patch.yml` 里钉死。`cordis.patch.yml` 只声明 provider 路由
（基础设施层），默认模型由选择层 patch 提供，`--patch` 可重复、后者覆盖前者：

| 选择层 | 路由 | 前置 |
| --- | --- | --- |
| `patches/model-gpt-relay.patch.yml` | gpt-relay / gpt-5.6-sol（默认主路由） | `GPT_RELAY_API_KEY` |
| `patches/model-glm-relay.patch.yml` | glm-relay / glm-5.2（备用） | `GLM_RELAY_API_KEY` + stream-bridge（17890） |

新增路由：在 `cordis.patch.yml` 加 provider 声明，再新建一个 `patches/model-*.patch.yml`。

**方式 A：启动脚本（推荐）**——自动预检端口/密钥、后台运行、日志落盘
`.logs/orchestrator/`（已 gitignore）：

```powershell
# 启动（默认 gpt 路由）并跟随日志；Ctrl+C 只退出跟随，不影响任务
pwsh orchestrator/dsh/run-task.ps1 -Task "自主推进小说《程序员也穿越了》，把第一个故事弧推进到定稿" -Watch

# 切换 glm 备用路由（脚本自动校验 stream-bridge 与密钥）
pwsh orchestrator/dsh/run-task.ps1 -Task "..." -Model glm

# 续接会话 / 查看可续接会话 / 只看将执行的命令
pwsh orchestrator/dsh/run-task.ps1 -Task "继续推进" -Session <session-id>
pwsh orchestrator/dsh/run-task.ps1 -ListSessions
pwsh orchestrator/dsh/run-task.ps1 -Task "..." -DryRun
```

启动后手动查看进度：

```powershell
Get-Content .logs\orchestrator\<日志名>.log -Wait -Tail 40   # 跟随
Get-Process -Id (Get-Content <日志名>.log.pid)                # 是否仍在运行
```

**方式 B：手工命令**（与脚本等价）：

```powershell
$env:GPT_RELAY_API_KEY = "<key>"
dsh --profile headless --patch orchestrator/dsh/cordis.patch.yml `
    --patch orchestrator/dsh/patches/model-gpt-relay.patch.yml "<任务描述>"
```

注：主编排路由 `gpt-relay`（gpt-5.6-sol @ sub2api）流式 tool calling 稳定，
**直连即可，stream-bridge 非必需**。仅当切回备用路由 `glm-relay`（glm-5.2）
时才需启动 `node orchestrator/dsh/stream-bridge.mjs`（17890）并设置
`GLM_RELAY_API_KEY`——glm2 中转的流式缺陷未修复前不可直连。

任务描述示例：
- 小说推进：`自主推进小说《程序员也穿越了》，把第一个故事弧的章节推进到定稿`
- 短剧创作：`把这个创意做成短剧脚本：散修少年在万丈剑崖初试御剑飞行，足踏青锋掠过云海群山`

相关 skill（dsh 自动发现于 `.agents/skills/`）：
- `novel-autopilot`——小说自主推进协议（决策表、等待策略、异常上报）
- `short-drama-autopilot`——短剧自主编排协议（类型判定、自检清单、迭代规则）
- `novel-mcp-orchestration`——全流程工具映射（被上两者引用）
- `novel-writing` / `short-drama-writing` / `h3-prompt-writing`——创作方法论

## 常见故障排查

### dsh 输出乱码 `<|DSML|invoke ...>`

**症状**：模型回复里出现 DSML 特殊 token 文本，工具调用不执行。

**原因**：glm2 中转的流式 tool calling 缺陷（详见 dsh-integration.md「关键发现 2」）。
**排查**：确认 stream-bridge 在 17890 运行、`cordis.patch.yml` 的 `baseURL` 指向
`http://127.0.0.1:17890/v1`（不是直连中转）。

### MCP 工具不出现（`mcp__novel__*` 缺失）

**排查**：
1. `dsh plugin --profile headless list` 确认 `@deepseek-ai/dsh-mcp-client` 在列。
2. `cordis.patch.yml` 里 mcp-novel 条目必须用 **`- insert:` 列表语法**——顶层
   `id:` 定位条目只能覆盖 dsh-base 已有 row，对新增插件静默无效。
3. novel-v2 MCP server 在 7654 且 41 tools loaded（看服务日志）。

### 工具调用超时

- novel-v2 生成类工具（章节生成、审校）触发 Temporal workflow，耗时数分钟正常；
  patch 里 `toolCallTimeoutMs: 600000`（10 分钟）已放宽。
- 超时先查 worker 健康（4771/ready）与 Temporal（7233）。

### 编排模型请求失败（PI_AI_ERROR / 余额）

- `$env:GLM_RELAY_API_KEY` 是否设置（缺失时报 MISSING_CREDENTIAL）。
- 中转密钥余额/有效性；DeepSeek 官方备选需充值后改 `settings/llm.example.yaml`
  模板的路由（deepseek 官方端点不需要 stream-bridge，`baseURL` 直连即可）。

### workflow failed（Temporal 终态）

不可恢复。记录 runId 与原因；`novel_bootstrap_run` 可同项目幂等重启（会重新
生成覆盖已批准产物），由人决策后执行。

### 短剧产物读取 404

- novel-v2 API 服务是否运行（4770）。
- `GET http://127.0.0.1:4770/v2/short-script-h3/list` 确认 scriptId 存在。

## 会话管理

- headless 单次任务无交互；多步推进在任务描述里写全目标，或依赖 skill 的
  goal 工具协议（`novel-autopilot` 内置）。
- `dsh --profile headless --resume <session>` 可续接会话（会话列表见
  `$DSH_HOME/sessions/`）。

## 安全提醒

编排 agent 的落库动作必须走 MCP 工具（正式工作流与质量门）；`cordis.patch.yml`
刻意不扩文件系统/shell 授权。不要为图省事给 dsh 开 danger-full-access。
