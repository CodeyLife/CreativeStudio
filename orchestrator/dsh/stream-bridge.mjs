// dsh 编排链路的 stream→non-stream 桥接代理。
//
// 背景：glm2.yujin8.top 中转的流式 tool calling 存在后端节点缺陷——部分节点把
// DeepSeek 内部 DSML 工具调用 token 当文本泄漏到 content（表现为乱码
// `<|DSML|invoke ...>`，工具调用无法解析），非流式路径则始终返回标准
// tool_calls。dsh/pi-ai 强制流式请求且无禁用开关，故在本地加一层桥接：
// 拦截 dsh 的流式请求，改写为非流式发给上游，再将完整响应包装成 SSE
// chunk 返回，dsh 侧零改动。
//
// 用法：node orchestrator/dsh/stream-bridge.mjs
// 环境变量：
//   STREAM_BRIDGE_UPSTREAM  上游 baseUrl（默认 https://glm2.yujin8.top）
//   STREAM_BRIDGE_PORT      监听端口（默认 17890）
//   STREAM_BRIDGE_HOST      监听地址（默认 127.0.0.1）
//
// 设计依据：docs/orchestrator/dsh-integration.md（PoC 阶段结论）。
// TODO: 若中转修复流式 tool calling 或更换稳定端点，本桥接可直接下线（删 baseURL 指向即可）。

import http from 'node:http';

const UPSTREAM = process.env.STREAM_BRIDGE_UPSTREAM ?? 'https://glm2.yujin8.top';
const PORT = Number(process.env.STREAM_BRIDGE_PORT ?? 17890);
const HOST = process.env.STREAM_BRIDGE_HOST ?? '127.0.0.1';

const upstreamBase = new URL(UPSTREAM);

/** 将非流式完整响应组装为 OpenAI 兼容的 SSE 流 */
function toSse(payload) {
  const chunks = [];
  const choice = payload.choices?.[0];
  if (choice) {
    const delta = { role: 'assistant' };
    if (choice.message?.content != null) delta.content = choice.message.content;
    if (choice.message?.reasoning_content != null) delta.reasoning_content = choice.message.reasoning_content;
    if (choice.message?.tool_calls?.length) {
      delta.tool_calls = choice.message.tool_calls.map((call, index) => ({
        index,
        id: call.id,
        type: call.type ?? 'function',
        function: call.function,
      }));
    }
    chunks.push({
      id: payload.id,
      object: 'chat.completion.chunk',
      created: payload.created,
      model: payload.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    chunks.push({
      id: payload.id,
      object: 'chat.completion.chunk',
      created: payload.created,
      model: payload.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }],
      ...(payload.usage ? { usage: payload.usage } : {}),
    });
  } else {
    // 无 choices 的异常响应：整体作为单 chunk 透传，保留错误可见性
    chunks.push(payload);
  }
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** 转发请求到上游；流式请求改写为非流式 */
async function forward(req, res, body) {
  let parsed = null;
  if (body && req.headers['content-type']?.includes('application/json')) {
    try { parsed = JSON.parse(body); } catch { parsed = null; }
  }

  const isStream = parsed?.stream === true;
  if (isStream) {
    delete parsed.stream;
    delete parsed.stream_options;
  }

  const headers = { ...req.headers, host: upstreamBase.host };
  delete headers['content-length'];
  delete headers['transfer-encoding'];

  const upstreamRes = await fetch(upstreamBase.origin + req.url, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) || !body
      ? undefined
      : (isStream ? JSON.stringify(parsed) : body),
  });

  // 非流式请求直接透传（模型列表等）
  if (!isStream) {
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
    });
    if (upstreamRes.body) for await (const chunk of upstreamRes.body) res.write(chunk);
    res.end();
    return;
  }

  // 流式请求：桥接为非流式 → 单批 SSE
  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    res.writeHead(upstreamRes.status, { 'content-type': 'application/json' });
    res.end(text);
    return;
  }
  let payload;
  try { payload = JSON.parse(text); } catch {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`stream-bridge: upstream returned non-JSON payload: ${text.slice(0, 500)}`);
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  res.end(toSse(payload));
}

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    await forward(req, res, body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`stream-bridge error: ${err?.stack ?? err}`);
  }
});

server.listen(PORT, HOST, () => {
  console.error(`[stream-bridge] http://${HOST}:${PORT} -> ${UPSTREAM} (stream calls downgraded to non-stream)`);
});
