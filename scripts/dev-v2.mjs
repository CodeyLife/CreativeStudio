import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { childRuntimeEnv } from "./runtime-env.mjs";

const { resolveNovelRuntimeConfig } = await import("../src/novel-v2/runtime-config.ts");

const root = resolve(import.meta.dirname, "..");
const env = childRuntimeEnv(root);
env.NOVEL_PROJECT_ROOT = root;
const runtime = resolveNovelRuntimeConfig(env);
env.NOVEL_RUNTIME_FINGERPRINT = runtime.runtimeFingerprint;
const children = [];
let stopping = false;

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

function run(command, args, label) {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true, cwd: root, env, shell: false });
  children.push(child);
  child.once("exit", (code) => { if (!stopping && code) stop(code); });
  child.once("error", (error) => { if (!stopping) { console.error(`${label} 启动失败`, error); stop(1); } });
  return child;
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

async function ensureService(url, label, args) {
  const current = await probeJson(url);
  if (current.reachable) {
    runtimeMatches(current, label);
    if (current.status >= 300) {
      await waitFor(url, label, { healthy: label === "Worker", timeoutMs: 180_000 });
    }
    console.log(`[dev] 复用健康 ${label}`);
    return false;
  }
  run(process.execPath, ["--import", "tsx", ...args], label);
  return true;
}

await new Promise((resolveRun, rejectRun) => {
  const docker = spawn(process.platform === "win32" ? "docker.exe" : "docker", [
    "compose", "-f", resolve(root, "docker-compose.v2.yml"), "--project-name", "creative-studio", "up", "--wait", "--wait-timeout", "120", "postgres", "temporal", "temporal-ui", "minio", "qdrant",
  ], { stdio: "inherit", windowsHide: true, cwd: root, env, shell: false });
  docker.once("error", rejectRun);
  docker.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Docker Compose exited with ${code}`)));
});

const apiStarted = await ensureService("http://127.0.0.1:4770/live", "API", ["scripts/novel-v2-api.ts"]);
if (apiStarted) await waitFor("http://127.0.0.1:4770/live", "API", { timeoutMs: 120_000 });
const workerStarted = await ensureService("http://127.0.0.1:4771/ready", "Worker", ["scripts/novel-v2-worker.ts"]);
if (workerStarted) await waitFor("http://127.0.0.1:4771/ready", "Worker", { healthy: true, timeoutMs: 180_000 });
await waitFor("http://127.0.0.1:4770/ready", "API", { healthy: true, timeoutMs: 180_000 });

const vite = await probeJson("http://127.0.0.1:5173/v2/projects");
if (vite.reachable) {
  runtimeMatches(vite, "Vite");
  console.log("[dev] 复用健康 Vite");
} else {
  run(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"], "Vite");
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill();
  setTimeout(() => process.exit(code), 100).unref();
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
