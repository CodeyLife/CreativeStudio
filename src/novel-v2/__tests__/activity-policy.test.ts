import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEAVY_MODEL_ACTIVITY_POLICY, NON_RETRYABLE_MODEL_ERROR_TYPES, STANDARD_ACTIVITY_POLICY } from "../temporal/activity-policy";

/**
 * 活动重试策略表守卫。
 *
 * 根因：策略此前内联在 workflows.ts 的 4 个 proxyActivities 调用里，`creativeRunWorkflow`
 * 那份漏了 `nonRetryableErrorTypes`——模型传输错误因此被重试 3 次，而候选链耗尽的调用
 * 重试不会自愈，只拉长墙钟并重复物化外部任务。漏一项没有编译器会提醒，所以这里锁住
 * "任何档位都必须带非重试错误清单"与"workflows.ts 不得再自带策略字面量"。
 */
describe("活动重试策略表", () => {
  const policies = [
    ["STANDARD_ACTIVITY_POLICY", STANDARD_ACTIVITY_POLICY] as const,
    ["HEAVY_MODEL_ACTIVITY_POLICY", HEAVY_MODEL_ACTIVITY_POLICY] as const,
  ];

  it.each(policies)("%s 具备完整活动策略字段且必带非重试错误清单", (_name, policy) => {
    expect(typeof policy.startToCloseTimeout).toBe("string");
    expect(policy.retry).toBeDefined();
    expect(policy.retry?.maximumAttempts).toBeGreaterThanOrEqual(1);
    // 反例面（历史缺陷形状）：档位存在但没声明哪些错误不该重试。
    expect(policy.retry?.nonRetryableErrorTypes).toEqual([...NON_RETRYABLE_MODEL_ERROR_TYPES]);
  });

  it.each(policies)("%s 的两种错误拼写都在列（Temporal 可能按构造器名序列化）", (_name, policy) => {
    const listed = policy.retry?.nonRetryableErrorTypes ?? [];
    expect(listed).toContain("NonRetryableModelTransportError");
    expect(listed).toContain("ModelTransportError");
  });

  it("重任务档比标准档窗口更宽且不自我重试", () => {
    expect(HEAVY_MODEL_ACTIVITY_POLICY.startToCloseTimeout).not.toBe(STANDARD_ACTIVITY_POLICY.startToCloseTimeout);
    expect((HEAVY_MODEL_ACTIVITY_POLICY.retry?.maximumAttempts ?? 0))
      .toBeLessThan(STANDARD_ACTIVITY_POLICY.retry?.maximumAttempts ?? 0);
  });
});

describe("活动策略接线锁", () => {
  const source = readFileSync(join(process.cwd(), "src", "novel-v2", "temporal", "workflows.ts"), "utf8");

  it("workflows.ts 不再自带策略字面量", () => {
    expect(source).not.toMatch(/startToCloseTimeout\s*:/);
    expect(source).not.toMatch(/nonRetryableErrorTypes\s*:/);
    expect(source).not.toMatch(/maximumAttempts\s*:/);
  });

  it("每个 proxyActivities 调用都取自策略表；3 标准档 + 1 重任务档", () => {
    const calls = [...source.matchAll(/proxyActivities<[^>]+>\(([A-Z_]+)\)/g)].map((match) => match[1]);
    expect(calls.sort()).toEqual([
      "HEAVY_MODEL_ACTIVITY_POLICY",
      "STANDARD_ACTIVITY_POLICY",
      "STANDARD_ACTIVITY_POLICY",
      "STANDARD_ACTIVITY_POLICY",
    ]);
  });
});
