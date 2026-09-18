import { describe, expect, it } from "vitest";
import { createStackSupervisor } from "../../../scripts/stack-supervisor";

/**
 * 真实子进程回归：验证监督器胶水（exit→退避→respawn、熔断 halt、stopAll 抑制）。
 * 决策规则的完整矩阵在 stack-restart-policy.test.ts，这里刻意用毫秒级小阈值，
 * 只证明"监督器确实按策略执行"，不重复阈值语义。
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`超时：${label}`);
}

const testSupervisor = () => createStackSupervisor({ root: process.cwd(), env: process.env });

describe("stack-supervisor", () => {
  it("崩溃环：指数退避重启，连续快速崩溃超限后熔断", { timeout: 20_000 }, async () => {
    const supervisor = testSupervisor();
    const svc = supervisor.startManaged({
      label: "Crasher",
      execArgs: ["-e", "process.exit(3)"],
      policyOptions: { baseDelayMs: 50, maxDelayMs: 400, stableUptimeMs: 60_000, maxConsecutiveFastCrashes: 2 },
    });
    const start = Date.now();
    await waitUntil(() => svc.halted, 15_000, "崩溃环未在时限内熔断");
    // 初次 + 2 次限内重启 = 3 次 spawn；第 3 次快速崩溃触发 halt
    expect(svc.spawnCount).toBe(3);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150); // 50+100ms 退避确实发生
  });

  it("被杀进程自动重启；stopAll 后 exit 不再触发重启且不真正杀宿主", { timeout: 20_000 }, async () => {
    let capturedExit: number | null = null;
    const supervisor = createStackSupervisor({ root: process.cwd(), env: process.env, exit: (code: number) => { capturedExit = code; } });
    const svc = supervisor.startManaged({
      label: "LongLived",
      execArgs: ["-e", "setTimeout(() => process.exit(7), 600000)"],
      policyOptions: { baseDelayMs: 100, maxConsecutiveFastCrashes: 5 },
    });
    await waitUntil(() => svc.child !== null, 5_000, "子进程未启动");
    const firstChild = svc.child;
    if (!firstChild) throw new Error("子进程句柄缺失");
    firstChild.kill();
    await waitUntil(() => svc.spawnCount >= 2, 10_000, "崩溃后未自动重启");
    supervisor.stopAll(0);
    await waitUntil(() => capturedExit === 0, 5_000, "stopAll 未触发 exit 钩子");
    await new Promise((resolve) => setTimeout(resolve, 800));
    // stopAll 抑制重启：第二个子进程被 kill 后不得再有第三次 spawn
    expect(svc.spawnCount).toBe(2);
  });
});
