/**
 * 栈服务崩溃重启策略（叶子纯模块：无 IO、无定时器、无 child_process，决策由调用方执行）。
 *
 * 根因背景：旧 scripts/watch-v2-stack.ps1 是计划任务驱动的外部端口探测 watchdog，
 * 有两个已被实证推翻的缺陷——(1) 交互会话下控制台交接必然闪窗，破坏用户体验；
 * (2) 端口探测对"启动即崩溃"的进程会无条件永远重启（同 revision-policy.test.ts
 * 对端口探测重启缺陷的记录）。改为进程内监督后，重启决策必须自带：
 *   1. 指数退避：吸收端口未释放、依赖组件刚就绪、瞬时资源竞争类失败；
 *   2. 快速崩溃熔断：连续短命崩溃说明故障是永久性而非瞬态，停止重启并把
 *      排查升级给人，杜绝无限重启风暴；
 *   3. 稳定运行重置：崩溃前存活超过稳定窗口，则该崩溃视为新的瞬态失败，
 *      熔断计数清零，避免长生命周期服务的偶发崩溃被历史计数误熔断。
 *
 * 刻意不覆盖：
 *   - 不退出进程的慢化劣化（重启无帮助，需要健康检查语义而非本策略）；
 *   - 外部启动的实例（监督者无进程句柄，只能探测复用，不负责其崩溃）；
 *   - 启动期就绪超时（属启动流程失败，由 dev-v2.mjs 抛错路径处理）。
 *
 * 边界说明：崩溃前总是存活超过稳定窗口的服务会永远重启、永不熔断，这是
 * 刻意设计——它已反复证明自身可用，持续重启正是自愈想要的行为。
 *
 * TODO(configurable)：阈值目前是代码内默认值，应开放为运行时配置覆盖。
 * 取值依据是"瞬态失败恢复窗口（秒级）vs 重启风暴代价（分钟级人工排查）"的
 * 数量级区分，不是针对某个具体服务样本调出来的。
 */

export interface RestartPolicyOptions {
  /** 首次重启延迟：秒级，覆盖端口释放、依赖瞬时抖动。 */
  baseDelayMs?: number;
  /** 退避延迟上限：防止指数增长到分钟级导致服务长时间缺位。 */
  maxDelayMs?: number;
  /** 稳定窗口：崩溃前存活超过该时长即不算"启动即崩溃"形状，重置熔断计数。 */
  stableUptimeMs?: number;
  /** 熔断上限：连续快速崩溃超过该次数后不再重启。 */
  maxConsecutiveFastCrashes?: number;
}

export interface RestartDecision {
  action: "restart" | "halt";
  /** action=restart 时监督者应等待的毫秒数；halt 时为 0。 */
  delayMs: number;
  /** 当前连续快速崩溃计数（决策后快照，供日志与测试断言）。 */
  consecutiveFastCrashes: number;
  /** 人类可读的决策依据，监督者直接打日志。 */
  reason: string;
}

export const DEFAULT_RESTART_POLICY_OPTIONS = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  stableUptimeMs: 120_000,
  maxConsecutiveFastCrashes: 5,
} as const;

export function createRestartPolicy(options: RestartPolicyOptions = {}) {
  const { baseDelayMs, maxDelayMs, stableUptimeMs, maxConsecutiveFastCrashes } = {
    ...DEFAULT_RESTART_POLICY_OPTIONS,
    ...options,
  };
  let consecutiveFastCrashes = 0;
  return {
    /**
     * 对一次子进程退出事件做出决策。
     * @param uptimeMs 子进程从 spawn 到 exit 的存活时长。
     */
    decide(uptimeMs: number): RestartDecision {
      if (uptimeMs >= stableUptimeMs) {
        consecutiveFastCrashes = 0;
      } else {
        consecutiveFastCrashes += 1;
      }
      if (consecutiveFastCrashes > maxConsecutiveFastCrashes) {
        return {
          action: "halt",
          delayMs: 0,
          consecutiveFastCrashes,
          reason: `连续快速崩溃已超过 ${maxConsecutiveFastCrashes} 次，判定为永久性故障而非瞬态失败，熔断停止自动重启`,
        };
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, consecutiveFastCrashes - 1));
      return {
        action: "restart",
        delayMs,
        consecutiveFastCrashes,
        reason: consecutiveFastCrashes === 0
          ? "崩溃前已稳定运行，按瞬态失败处理，立即退避重启"
          : `第 ${consecutiveFastCrashes} 次连续快速崩溃，处于瞬态失败假设内，退避后重启`,
      };
    },
  };
}
