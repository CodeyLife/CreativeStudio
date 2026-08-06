#!/usr/bin/env node
/**
 * novel-v2 MCP server CLI 管理器。
 *
 * 通过 PID 文件管理常驻的 HTTP 模式 MCP server，支持 CLI 重启：
 *   npm run novel:mcp:start
 *   npm run novel:mcp:stop
 *   npm run novel:mcp:restart
 *   npm run novel:mcp:status
 *   npm run novel:mcp:logs
 *
 * 固定端口：NOVEL_MCP_HTTP_PORT 或默认 7654。
 * OpenCode 通过 type=remote 连接 http://127.0.0.1:7654/mcp。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

const PID_DIR = process.env.NOVEL_MCP_PID_DIR ?? join(homedir(), ".novel-v2-mcp");
const PID_FILE = join(PID_DIR, "server.pid");
const LOG_FILE = process.env.NOVEL_MCP_LOG_FILE ?? join(PID_DIR, "server.log");
const PORT = Number(process.env.NOVEL_MCP_HTTP_PORT) || 7654;

function readPid() {
  if (!existsSync(PID_FILE)) return undefined;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  return raw ? Number(raw) : undefined;
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writePid(pid) {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), "utf8");
}

function clearPid() {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

function log(message) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] ${message}\n`);
}

function stopServer() {
  const pid = readPid();
  if (!pid) {
    log("no pid file found, nothing to stop");
    return false;
  }
  if (!isRunning(pid)) {
    log(`pid ${pid} not running, clearing stale pid`);
    clearPid();
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    log(`sent SIGTERM to pid ${pid}`);
  } catch (error) {
    log(`failed to stop pid ${pid}: ${error.message}`);
    return false;
  }
  // 等待退出（最多 3 秒）
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isRunning(pid)) {
    // busy wait
  }
  if (isRunning(pid)) {
    log(`pid ${pid} still running after SIGTERM`);
    return false;
  }
  clearPid();
  log(`stopped pid ${pid}`);
  return true;
}

/**
 * 启动常驻 HTTP 模式 MCP server。
 * detached + stdio 全 ignore + unref，确保父进程立即退出、子进程独立存活。
 * stderr 通过重定向写入日志文件（用 fs.openSync 提供 fd）。
 */
function startServer() {
  if (isRunning(readPid())) {
    log(`already running (pid=${readPid()}, port=${PORT})`);
    return;
  }
  mkdirSync(PID_DIR, { recursive: true });
  const serverPath = join(ROOT, "scripts", "novel-v2-mcp-server.mjs");
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn("node", ["--import", "tsx", serverPath, "--http", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", logFd],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);
  writePid(child.pid ?? process.pid);
  log(`started MCP server pid=${child.pid ?? "unknown"} port=${PORT} log=${LOG_FILE}`);
  // 立即退出，不等待子进程
  process.exit(0);
}

function printStatus() {
  const pid = readPid();
  if (!pid) {
    log("MCP server: not running (no pid file)");
    return;
  }
  if (isRunning(pid)) {
    log(`MCP server: RUNNING pid=${pid} port=${PORT}`);
  } else {
    log(`MCP server: not running (stale pid=${pid})`);
  }
  if (existsSync(LOG_FILE)) {
    log(`log: ${LOG_FILE}`);
  }
}

function printLogs() {
  if (!existsSync(LOG_FILE)) {
    log("no log file yet");
    return;
  }
  const size = statSync(LOG_FILE).size;
  const tailBytes = 8192;
  const start = Math.max(0, size - tailBytes);
  const content = readFileSync(LOG_FILE, "utf8");
  process.stdout.write((start > 0 ? content.slice(start) : content) + "\n");
}

const command = process.argv[2] ?? "status";
switch (command) {
  case "start":
    startServer();
    break;
  case "stop":
    stopServer();
    break;
  case "restart":
    stopServer();
    startServer();
    break;
  case "status":
    printStatus();
    break;
  case "logs":
    printLogs();
    break;
  default:
    log(`unknown command: ${command} (expected start|stop|restart|status|logs)`);
    break;
}
