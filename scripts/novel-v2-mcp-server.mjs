#!/usr/bin/env node
/**
 * V2 MCP Server：stdio JSON-RPC 2.0 协议（默认）或 Streamable HTTP 常驻模式。
 *
 * 设计依据：AGENTS.md 架构阶段 + Phase C-1.1 MCP server 入口统一。
 *
 * V2 MCP 直接调用模式：MCP → executeTool → repository/Temporal。
 *
 * 本文件是 v2 mcp 模块（src/novel-v2/mcp/）的生产入口，让 executeTool 从"仅测试引用"变为"生产接入"。
 *
 * 协议规范：
 * - stdio 传输（默认）：每行一个 JSON-RPC 2.0 消息
 * - HTTP 传输（--http [port]，默认 7654）：SDK StreamableHTTPServerTransport，POST /mcp
 *
 * 支持：
 * - initialize / tools/list / tools/call 三个方法
 * - 不支持 resources/prompts（v2 当前未实现）
 *
 * 启动（npm 与 OpenCode 共用同一入口，行为一致）：
 *   npm run novel:mcp:v2                                           # stdio（OpenCode type=local）
 *   node --import tsx scripts/novel-v2-mcp-server.mjs --http       # HTTP 默认端口 7654
 *   node --import tsx scripts/novel-v2-mcp-server.mjs --http 9000  # HTTP 指定端口
 *
 * 环境：进程启动即加载 .env.example/.env.local 到 process.env（loadRuntimeEnv），
 * 因此无论经 npm 脚本、OpenCode 直接 spawn 还是命令行直连，运行时配置（DATABASE_URL、
 * TEMPORAL_ADDRESS、模型 API key、NOVEL_* 等）都一致，无需依赖外层 shell 预注入。
 */
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository.ts";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime.ts";
import { TOOL_DEFINITIONS, executeTool } from "../src/novel-v2/mcp/index.ts";
import { loadRuntimeEnv } from "./runtime-env.mjs";

// ===== 运行时环境加载（必须先于任何 process.env 读取） =====
// 与 novel-v2-api/worker 同源：.env.example 作基线、.env.local 覆盖、外层 shell 环境变量最高。
// src/novel-v2 各模块仅在构造/调用时读取 process.env（无模块顶层读取），在此注入后生效。
Object.assign(process.env, loadRuntimeEnv(resolve(import.meta.dirname, "..")));

// ===== 初始化 repository + model =====
// 复用 createRuntimeModelGateway（与 novel-v2-api/worker 一致），
// 构造 RoutedModelGateway 并接好 ModelConfigStore + audit recorder。
const repository = new NovelPostgresRepository();
await repository.migrate();
const { gateway: model } = await createRuntimeModelGateway(repository);
const temporalConnection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
const temporal = new Client({ connection: temporalConnection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "novel-v2";
const ctx = { repository, model, temporal, taskQueue };

// ===== 工具回调（stdio 与 HTTP 共用） =====

async function handleToolCall(name, args) {
  const result = await executeTool(name, args, ctx);
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
  };
}

// ===== JSON-RPC 2.0 协议（stdio 模式） =====

function sendResult(id, result) {
  if (id === null || id === undefined) return; // notification，不响应
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  if (id === null || id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "novel-v2-mcp", version: "2.0.0" },
        capabilities: { tools: {} },
      };

    case "tools/list":
      return {
        tools: TOOL_DEFINITIONS.map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.inputSchema,
        })),
      };

    case "tools/call": {
      if (!params || typeof params.name !== "string") {
        throw Object.assign(new Error("params.name 必须为字符串"), { code: -32602 });
      }
      const args = (params.arguments && typeof params.arguments === "object") ? params.arguments : {};
      return await handleToolCall(params.name, args);
    }

    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

async function shutdown() {
  try {
    await repository.close();
    await temporalConnection.close();
  } catch (error) {
    // TODO P2: shutdown 错误处理策略（目前只记录不阻塞）
    console.error(`[novel-v2-mcp] shutdown error: ${error.message}`);
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// ===== 模式分发 =====

const httpArgIndex = process.argv.indexOf("--http");
const httpMode = httpArgIndex !== -1;
if (httpMode) {
  // ===== Streamable HTTP 常驻模式（stateless：每请求独立 Server + transport） =====
  const port = Number(process.argv[httpArgIndex + 1]) || Number(process.env.NOVEL_MCP_HTTP_PORT) || 7654;
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET") {
      // health check / readiness
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "novel-v2-mcp", tools: TOOL_DEFINITIONS.length }));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    // 每请求新建 Protocol + transport：SDK 要求一个 Server 实例只能 connect 一个 transport。
    // stateless 模式下不维护会话状态（工具调用本身无状态依赖）。
    const mcpServer = new Server(
      { name: "novel-v2-mcp", version: "2.0.0" },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS.map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
      })),
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      return handleToolCall(request.params.name, request.params.arguments ?? {});
    });

    // stateless：不生成 session id（SDK 1.x 中设置 sessionIdGenerator 会启用
    // stateful 校验——非 initialize 请求要求本 transport 已完成初始化且带匹配
    // 的 Mcp-Session-Id；每请求新建 transport 导致该校验恒失败返回 400）。
    // stateless 模式下 SDK 不校验 session，且要求每请求新建 transport（本实现已满足）。
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`[novel-v2-mcp] HTTP mode ready on http://127.0.0.1:${port}/mcp, ${TOOL_DEFINITIONS.length} tools loaded`);
  });

  httpServer.on("close", async () => {
    await shutdown();
  });
} else {
  // ===== stdio 模式（默认，OpenCode type=local 兼容） =====
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let id = null;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      sendError(null, -32700, `Parse error: ${error.message}`);
      return;
    }

    id = parsed.id ?? null;
    try {
      const result = await handleRequest(id, parsed.method, parsed.params);
      sendResult(id, result);
    } catch (error) {
      const code = error.code ?? -32603;
      sendError(id, code, error.message ?? String(error));
    }
  });

  console.error(`[novel-v2-mcp] stdio ready, ${TOOL_DEFINITIONS.length} tools loaded`);
}
