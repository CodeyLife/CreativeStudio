import { resolve } from "node:path";
import { childRuntimeEnv } from "./runtime-env.mjs";
import { createStackSupervisor } from "./stack-supervisor.ts";

const { resolveNovelRuntimeConfig } = await import("../src/novel-v2/runtime-config.ts");
const { codeRevision } = await import("../src/novel-v2/code-revision.ts");

const root = resolve(import.meta.dirname, "..");
const env = childRuntimeEnv(root);
env.NOVEL_PROJECT_ROOT = root;
const runtime = resolveNovelRuntimeConfig(env);
env.NOVEL_RUNTIME_FINGERPRINT = runtime.runtimeFingerprint;
// 代码版本可见性（2026-09-16 审核轮 3）：fingerprint 只哈希配置身份，代码改了它不变——
// 复用旧进程时"修复已合入但静默不生效"曾整轮发生。复用前对比 HEAD 短哈希，滞后即显式警告。
const headRevision = codeRevision(root);
const staleServices = new Set();
function checkCodeRevision(result, label) {
  const live = result.fingerprint === undefined ? undefined : (result.body?.runtime?.codeRevision ?? result.body?.codeRevision);
  if (live === undefined) {
    staleServices.add(label);
    console.warn(`[dev] ⚠ ${label} 复用实例未上报 codeRevision（进程早于版本戳上线）：其运行的是旧代码，本次会话的 src 改动不会生效；需要生效请重启该服务。`);
    return;
  }
  if (live !== headRevision) {
    staleServices.add(label);
    console.warn(`[dev] ⚠ ${label} 复用实例代码版本滞后：运行中 ${live}，当前 HEAD ${headRevision}；src 改动未生效，需要生效请重启该服务。`);
  }
}
const supervisor = createStackSupervisor({ root, env });

async function probeJson(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
    return { reachable: true, status: response.status, body, fingerprint: response.headers.get("x-novel-runtime-fingerprint") };
  } catch (error) {
    return { reachable: false, error };
  }
}

function runtimeMatches(result, label) {
  const fingerprint = result.fingerprint ?? result.body?.runtime?.fingerprint;
  if (fingerprint === undefined) throw new Error(`${label} 已占用端口但没有运行时身份，拒绝复用旧实例`);
  if (fingerprint !== env.NOVEL_RUNTIME_FINGERPRINT) throw new Error(`${label} 已占用端口但运行时 fingerprint 不一致：${String(fingerprint).slice(0, 12)} != ${String(env.NOVEL_RUNTIME_FINGERPRINT).slice(0, 12)}`);
  return true;
}

async function waitFor(url, label, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let last;
  while (Date.now() < deadline) {
    last = await probeJson(url);
    if (last.reachable && last.status < 300 && (!options.healthy || last.body.status === "healthy")) {
      runtimeMatches(last, label);
      return last;
    }
    if (last.reachable && options.rejectUnknown && last.body?.runtime?.fingerprint === undefined) runtimeMatches(last, label);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`${label} 未在 ${options.timeoutMs ?? 120_000}ms 内就绪：${JSON.stringify(last?.body ?? last?.error ?? {})}`);
}

// 缺失即启动并纳入监督自愈；健康实例只复用（监督边界见 stack-supervisor.mjs 头注释）。
async function ensureService(url, label, execArgs) {
  const current = await probeJson(url);
  if (current.reachable) {
    runtimeMatches(current, label);
    checkCodeRevision(current, label);
    if (current.status >= 300) {
      await waitFor(url, label, { healthy: label === "Worker", timeoutMs: 180_000 });
    }
    console.log(`[dev] 复用健康 ${label}（非本监督者启动，崩溃不会自动重启）`);
    return false;
  }
  supervisor.startManaged({ label, execArgs });
  return true;
}

await new Promise((resolveRun, rejectRun) => {
  const docker = supervisor.run(process.platform === "win32" ? "docker.exe" : "docker", [
    "compose", "-f", resolve(root, "docker-compose.v2.yml"), "--project-name", "creative-studio", "up", "--wait", "--wait-timeout", "120", "postgres", "temporal", "temporal-ui", "minio", "qdrant",
  ], "Docker", { onFatalExit: (code) => supervisor.stopAll(code) });
  docker.once("error", rejectRun);
  docker.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Docker Compose exited with ${code}`)));
});

const apiStarted = await ensureService("http://127.0.0.1:4770/live", "API", ["--import", "tsx", "scripts/novel-v2-api.ts"]);
if (apiStarted) await waitFor("http://127.0.0.1:4770/live", "API", { timeoutMs: 120_000 });
const workerStarted = await ensureService("http://127.0.0.1:4771/ready", "Worker", ["--import", "tsx", "scripts/novel-v2-worker.ts"]);
if (workerStarted) await waitFor("http://127.0.0.1:4771/ready", "Worker", { healthy: true, timeoutMs: 180_000 });
await waitFor("http://127.0.0.1:4770/ready", "API", { healthy: true, timeoutMs: 180_000 });
// MCP 常驻 HTTP 服务（7654）纳入同一编排与监督：旧形态依赖已删除的 watchdog 补启。
// 其健康端点携带运行时指纹头，复用检测与 API/Worker 同一契约。
const mcpStarted = await ensureService("http://127.0.0.1:7654/", "MCP", ["--import", "tsx", "scripts/novel-v2-mcp-server.mjs", "--http"]);
if (mcpStarted) await waitFor("http://127.0.0.1:7654/", "MCP", { timeoutMs: 180_000 });

const vite = await probeJson("http://127.0.0.1:5173/v2/projects");
if (vite.reachable) {
  runtimeMatches(vite, "Vite");
  console.log("[dev] 复用健康 Vite（非本监督者启动，崩溃不会自动重启）");
} else {
  supervisor.startManaged({ label: "Vite", execArgs: [resolve(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"] });
}

process.once("SIGINT", () => supervisor.stopAll(0));
process.once("SIGTERM", () => supervisor.stopAll(0));
