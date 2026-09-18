import { describe, expect, it } from "vitest";
import {
  createRestartPolicy,
  DEFAULT_RESTART_POLICY_OPTIONS,
} from "../stack-restart-policy";

/**
 * 双向覆盖（AGENTS.md 守卫规则）：
 *   - 熔断计数限内：重启被接受且退避延迟按指数增长；
 *   - 熔断计数超限：重启被拒绝（halt），杜绝无限重启风暴；
 *   - 稳定窗口重置：长生命周期崩溃清零计数，恢复重启预算；
 *   - 延迟封顶：指数增长不超过 maxDelayMs。
 */
describe("stack-restart-policy", () => {
  it("限内快速崩溃：接受重启且延迟指数退避", () => {
    const policy = createRestartPolicy({ baseDelayMs: 100, maxDelayMs: 10_000, stableUptimeMs: 1000, maxConsecutiveFastCrashes: 3 });
    expect(policy.decide(10)).toMatchObject({ action: "restart", consecutiveFastCrashes: 1, delayMs: 100 });
    expect(policy.decide(10)).toMatchObject({ action: "restart", consecutiveFastCrashes: 2, delayMs: 200 });
    expect(policy.decide(10)).toMatchObject({ action: "restart", consecutiveFastCrashes: 3, delayMs: 400 });
  });

  it("超限快速崩溃：熔断拒绝重启（退化超限被拒绝方向）", () => {
    const policy = createRestartPolicy({ baseDelayMs: 100, maxConsecutiveFastCrashes: 2 });
    policy.decide(10);
    policy.decide(10);
    const verdict = policy.decide(10);
    expect(verdict.action).toBe("halt");
    expect(verdict.delayMs).toBe(0);
    expect(verdict.consecutiveFastCrashes).toBe(3);
  });

  it("崩溃前已稳定运行：视为瞬态失败重置计数，恢复完整重启预算", () => {
    const policy = createRestartPolicy({ baseDelayMs: 100, maxConsecutiveFastCrashes: 2, stableUptimeMs: 1_000 });
    policy.decide(10);
    policy.decide(10);
    // 存活 60s ≥ 稳定窗 1s → 非启动即崩溃形状，计数清零重新开始
    const afterStable = policy.decide(60_000);
    expect(afterStable).toMatchObject({ action: "restart", consecutiveFastCrashes: 0 });
    expect(afterStable.delayMs).toBe(100); // 基线延迟重新开始
    // 清零后再次快速崩溃重新获得限内预算
    expect(policy.decide(10)).toMatchObject({ action: "restart", consecutiveFastCrashes: 1 });
  });

  it("退避延迟不超过上限", () => {
    const policy = createRestartPolicy({
      baseDelayMs: DEFAULT_RESTART_POLICY_OPTIONS.baseDelayMs,
      maxDelayMs: 4_000,
      maxConsecutiveFastCrashes: 10,
    });
    policy.decide(10);
    policy.decide(10);
    const third = policy.decide(10); // 1000*2^2=4000 恰好到顶
    expect(third.delayMs).toBe(4_000);
    expect(policy.decide(10).delayMs).toBe(4_000); // 继续增长被封顶
  });

  it("默认阈值序贯：第五次快速崩溃仍在限内，第六次熔断", () => {
    const policy = createRestartPolicy();
    const delays: number[] = [];
    let last;
    for (let i = 0; i < 6; i++) {
      last = policy.decide(5);
      if (last.action === "restart") delays.push(last.delayMs);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(last!.action).toBe("halt");
  });
});
