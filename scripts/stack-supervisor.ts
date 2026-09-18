/**
 * 栈子进程监督器：进程内崩溃自愈，替代已删除的计划任务 watchdog
 * （scripts/watch-v2-stack.ps1，git 5bcaaf2）。
 *
 * 旧形态两个根缺陷（此模块的存在即是对其的修复）：
 * 1. 计划任务在交互会话下控制台交接必然闪窗——用户原则：自愈能力不得依赖
 *    会弹窗影响用户体验的 CLI 窗口。本监督器是普通子进程的子模块，只在用户
 *    已拥有的终端里输出日志，任何路径都不会自发产生窗口。
 * 2. 外部端口探测 watchdog 对"启动即崩溃"的进程只会无条件永远重启。本监督器
 *    持有子进程句柄、监听 exit 事件，重启决策委托叶子纯模块
 *    src/novel-v2/stack-restart-policy.ts：指数退避 + 连续快速崩溃熔断 +
 *    稳定窗口重置（阈值依据与刻意不覆盖的边界见该模块头注释）。
 *
 * 边界：只监督 startManaged 启动的服务；外部启动的实例无句柄，探测复用后其
 * 崩溃不归本监督器（调用方在复用日志中明示）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRestartPolicy, type RestartPolicyOptions } from "../src/novel-v2/stack-restart-policy.ts";

export interface ManagedServiceSpec {
  label: string;
  execArgs: string[];
  /** 缺省用监督器自身同款 node 二进制。 */
  command?: string;
  policyOptions?: RestartPolicyOptions;
}

export interface ManagedService {
  spec: ManagedServiceSpec;
  halted: boolean;
  child: ChildProcess | null;
  spawnCount: number;
  readonly policy: ReturnType<typeof createRestartPolicy>;
}

export interface StackSupervisor {
  managed: ManagedService[];
  startManaged(spec: ManagedServiceSpec): ManagedService;
  run(command: string, args: string[], label: string, options?: { onFatalExit?: (code: number) => void }): ChildProcess;
  stopAll(code?: number): void;
  readonly stopping: boolean;
}

export function createStackSupervisor(
  { root, env, exit = (code: number) => process.exit(code) }:
  { root?: string; env?: NodeJS.ProcessEnv; exit?: (code: number) => void } = {},
): StackSupervisor {
  const managed: ManagedService[] = [];
  const children: ChildProcess[] = [];
  let stopping = false;

  /** 一次性辅助进程（如 docker compose up --wait）：非零退出交由调用方触发整栈停机。 */
  function run(command: string, args: string[], label: string, { onFatalExit }: { onFatalExit?: (code: number) => void } = {}) {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, cwd: root, env, shell: false });
    children.push(child);
    child.once("exit", (code) => { if (!stopping && code) onFatalExit?.(code); });
    child.once("error", (error) => { if (!stopping) { console.error(`${label} 启动失败`, error); onFatalExit?.(1); } });
    return child;
  }

  function spawnManaged(svc: ManagedService) {
    svc.spawnCount += 1;
    const startAt = Date.now();
    const child = spawn(svc.spec.command ?? process.execPath, svc.spec.execArgs, {
      stdio: "inherit", windowsHide: true, cwd: root, env, shell: false,
    });
    children.push(child);
    svc.child = child;
    let spawnErrored = false;
    child.once("error", (error) => {
      if (stopping) return;
      spawnErrored = true;
      console.error(`[${svc.spec.label}] spawn 失败`, error);
      onManagedExit(svc, "spawn-error", startAt);
    });
    child.once("exit", (code) => { if (!spawnErrored) onManagedExit(svc, code, startAt); });
  }

  function onManagedExit(svc: ManagedService, code: number | null | string, startAt: number) {
    if (stopping || svc.halted) return;
    const uptimeMs = Date.now() - startAt;
    const decision = svc.policy.decide(uptimeMs);
    if (decision.action === "halt") {
      svc.halted = true;
      console.error(`[${svc.spec.label}] 退出（code=${code}，存活 ${Math.round(uptimeMs / 1000)}s）：${decision.reason}。请查看上方日志排查，修复后重新运行 pnpm dev。`);
      return;
    }
    console.warn(`[${svc.spec.label}] 退出（code=${code}，存活 ${Math.round(uptimeMs / 1000)}s）：${decision.reason}，${decision.delayMs}ms 后重启`);
    setTimeout(() => { if (!stopping) spawnManaged(svc); }, decision.delayMs);
  }

  function startManaged(spec: ManagedServiceSpec): ManagedService {
    const svc: ManagedService = {
      spec,
      policy: createRestartPolicy(spec.policyOptions),
      halted: false,
      child: null,
      spawnCount: 0,
    };
    managed.push(svc);
    spawnManaged(svc);
    return svc;
  }

  function stopAll(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (!child.killed) child.kill();
    setTimeout(() => exit(code), 100).unref();
  }

  return { managed, startManaged, run, stopAll, get stopping() { return stopping; } };
}
