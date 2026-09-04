# dsh × novel-v2 编排集成 — PoC 结论（Phase 0）

状态：**可行，已打通全链路**。dsh（DeepSeek Harness）可作为自主编排运行时，通过 MCP 桥接驱动 novel-v2 创作工作流。

日期：2026-09-04
配置资产：[orchestrator/dsh/cordis.patch.yml](../../orchestrator/dsh/cordis.patch.yml)、[orchestrator/dsh/stream-bridge.mjs](../../orchestrator/dsh/stream-bridge.mjs)、[orchestrator/dsh/settings/llm.example.yaml](../../orchestrator/dsh/settings/llm.example.yaml)

## 目标架构

```
用户/TRAE（人工治理：方向决策、最终审核）
        │ 任务下发
        ▼
dsh headless profile（自主编排：规划推进、审核、编辑、迭代）
  ├─ 编排模型：glm-5.2（经 stream-bridge 桥接）
  ├─ MCP 客户端插件：@deepseek-ai/dsh-mcp-client
  │     └─ mcp__novel__<toolName> × 40
  └─ skill 发现：.agents/skills（novel-mcp-orchestration 等）
        │ MCP (Streamable HTTP, 端口 7654)
        ▼
novel-v2 MCP server（正式工作流 + 质量门 + 落库）
        │
        ▼
CreativeStudio 产物（规划/正文/审校/修订/短剧脚本）
```

## PoC 验证结果

| 项 | 结论 | 说明 |
|---|---|---|
| dsh 安装 | ✅ | `npm install -g @deepseek-ai/dsh --registry=https://registry.npmmirror.com`（官方源慢，走国内镜像） |
| novel-v2 MCP HTTP 模式 | ✅ | `npm run novel:mcp:v2:http`，端口 7654，40 工具加载，initialize 握手正常 |
| dsh 插件桥接 | ✅ | `@deepseek-ai/dsh-mcp-client` 装入 headless profile，40 工具以 `mcp__novel__<name>` 注册 |
| MCP 工具调用 | ✅ | 实测 `novel_skill_get`（返回 h3-video-prompt@1.6.9 技能内容）、`novel_project_list`（返回项目真实数据）均正确 |
| 编排模型路由 | ✅ | hand-declared `glm-relay` 路由（OpenAI completions 兼容），经 stream-bridge |
| skill 发现 | ✅ | dsh-skill-filesystem 默认扫描 `.agents/skills`，项目内 SKILL.md 兼容（会话 catalog 可见 novel-mcp-orchestration 等 20 个技能） |

## 关键发现

### 1. cordis patch 语法：insert vs id 定位

- **顶层 `id:` 条目**只能覆盖 dsh-base 已有 row 的 config（如 `llm-pi-ai`、`agent-default-model`），对不存在的 id **静默无效**。
- **新增插件**（如 mcp-client）必须用 `- insert:` 列表语法，否则插件不加载且无报错。
- 这是 Phase 0 排查耗时最长的坑：模型路由生效但 MCP 工具不出现，原因即在此。

### 2. glm2 中转的流式 tool calling 缺陷与 stream-bridge 方案

**症状**：dsh 发起的工具调用以乱码文本 `<|DSML|invoke ...>` 泄漏到 content，无法解析执行。

**根因**（实验定位）：
- 中转的非流式 tool calling 稳定正常（标准 `tool_calls` 响应）；
- 流式 tool calling 按后端节点随机故障——部分节点把 DeepSeek 内部 DSML 协议 token 当文本泄漏（glm-5.2 约 25-50% 故障率，glm-5.1/glm-4.7-flash 接近 100%）；
- dsh/pi-ai **强制流式**请求，compat 配置无禁用流式的开关。

**方案**：`orchestrator/dsh/stream-bridge.mjs` 本地桥接代理（端口 17890）——拦截 dsh 流式请求，降级为非流式发给中转，将完整响应组装为单批 SSE chunk 返回。dsh 侧零改动，工具调用稳定。

**备选端点盘点**（当时均不可用，原因留档）：
- DeepSeek 官方：余额不足（Insufficient Balance）；
- sub2api.yujin8.top：502 服务不可用；
- gpt.eromaa.com：上游 chatgpt.com 连接失败。

任一端点恢复后，改 `cordis.patch.yml` 的 `baseURL` 直连即可（stream-bridge 可下线，见其文件头 TODO）。

### 3. 模型选择

编排路由固定 `glm-5.2`。glm-5.3 在该中转上流式工具调用可靠性最差（且不在 /models 列表中，疑为别名映射），glm-5.1/glm-4.7-flash 更差。

## 运行方式（速查）

```powershell
# 1. 启动 novel-v2 MCP server（终端 1）
npm run novel:mcp:v2:http

# 2. 启动 stream-bridge（终端 2）
node orchestrator/dsh/stream-bridge.mjs

# 3. 运行编排任务（终端 3）
$env:GLM_RELAY_API_KEY = "<key>"
dsh --profile headless --patch orchestrator/dsh/cordis.patch.yml "<任务描述>"
```

## 已知限制与风险

- **单点依赖中转质量**：glm2 中转非流式目前稳定，但属第三方服务；stream-bridge 是围绕其流式缺陷的补偿层，端点更换后应重估。
- **无持久编排会话**：headless 单次任务模式；多轮推进（Phase 1 skill 将定义）需要 session resume 或任务内闭环。
- **审批策略 ask**：headless 默认 workspace-write + ask；自主运行中无应答者时会 fail-closed。Phase 1 需按安全契约评估——编排 agent 的落库必须走 MCP 工具（质量门内），文件系统授权维持最小化。
- **工具 token 开销**：40 MCP 工具 + 26 内置工具的 schema 每请求约 110KB，对上下文窗口有持续压力；Phase 2 可评估按任务裁剪工具面。

## Phase 1 计划（下一步）

1. **dsh 版 novel-orchestration skill**：改编 `.agents/skills/novel-mcp-orchestration`（治理流程不变，调整触发与工具映射描述以适配 dsh 会话形态）。
2. **dsh 版 short-drama-orchestration skill**：短剧创作编排（novel_short_script_h3 / novel_chapter_script_h3 / submit 工具链）。
3. **运行手册** `docs/orchestrator/dsh-runbook.md`：启动顺序、常见故障（含本页关键发现速查）、会话恢复。

## Phase 1 验收结论（2026-09-04）

交付物：
- `.agents/skills/novel-autopilot/SKILL.md`——小说自主推进协议（感知-决策-执行循环、
  manual-gate 自主审核、Temporal 等待策略（后台 job + MCP 直调轮询模板）、
  完成与异常上报规则；流程细节引用 novel-mcp-orchestration，不重复维护）。
- `.agents/skills/short-drama-autopilot/SKILL.md`——短剧自主编排协议（类型判定、
  生成路径选择、REST 读回（4770）与六项自检清单、幂等迭代规则）。
- `docs/orchestrator/dsh-runbook.md`——运行手册（服务栈全景、启动顺序、故障排查）。

端到端验证（短剧生成实测）：
- 基础设施全链路（dsh → stream-bridge → 中转 → MCP → novel-v2 → 系统内部模型）
  **可靠**：直接工具调用 `novel_short_script_h3` 一次成功，产出 28s 双片段脚本，
  御剑双足踏剑意象保真、单长镜头多段运镜、<Subject N> 跨镜头引用、REST 读回
  全部达标。
- **已知限制**：glm-5.2 编排模型在多步自主任务（加载 skill → 分析 → 选择路径 →
  调用 → 读回 → 自检 → 汇报的完整链）中可靠性不足——两次实测均在工具调用前
  中断为纯文本输出；单步指令任务 100% 成功。编排协议内容本身被正确加载遵循
  （类型判定、硬约束应用均准确）。
- **缓解措施**（按优先级）：① 任务拆解为单步指令序列下发（runbook 已指导）；
  ② 编排模型升级（DeepSeek 官方充值后切换，或 glm-5.3 流式缺陷修复后回归）；
  ③ 评估 dsh goal/ralph 循环对中断回合的重试覆盖。

## Phase 2+ 待办

- dsh 自定义插件（替代通用 mcp-client + 手工 patch：工具分级超时、按任务裁剪
  工具面、编排专用 system prompt）。
- CreativeStudio 产品化集成：编排任务面板、进度可视化、产物预览。
- 稳定编排模型路由（DeepSeek 官方 / 新中转）替换 stream-bridge 补偿层。
