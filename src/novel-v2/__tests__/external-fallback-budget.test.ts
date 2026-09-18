import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_TASK_WAIT_WINDOW,
  ExternalFallbackBudgetExhaustedError,
  ExternalTaskInbox,
  MAX_EXTERNAL_FALLBACK_ADVANCES,
  externalDeliveryValue,
  type ExternalWaitOutcome,
} from "../temporal/external-task-protocol";
import type { ModelTaskRecord } from "../model-routing";

/**
 * OR-B3（product-audit-20260910 E3）外部回退预算与等待协议的行为测试。
 *
 * 协议此前住在 workflows.ts，"workflow 沙箱代码难以单测"只能用源码文本断言兜底；
 * 现在机制收在 ./external-task-protocol（condition 由调用方注入），因此这里能真正
 * 执行预算/超时/失败三条路径，文本断言退居为"接线完整性"锁。
 */
const task = (id: string, candidateIndex = 0): ModelTaskRecord => ({ id, candidateIndex } as ModelTaskRecord);

/** 可控的 condition 替身：delivery 决定信号是否/以何载荷到达。 */
function makeHost(options: { settle: boolean; payload?: Record<string, unknown>; failure?: Record<string, unknown> } = { settle: true }) {
  const inbox = new ExternalTaskInbox();
  const expired: Array<[string, string]> = [];
  const wait = vi.fn(async (predicate: () => boolean) => {
    if (options.failure) inbox.reject({ modelTaskId: pendingId, ...options.failure });
    else if (options.payload) inbox.deliver({ modelTaskId: pendingId, result: options.payload });
    return options.settle ? predicate() : false;
  });
  const expire = vi.fn(async (modelTaskId: string, reason: string) => { expired.push([modelTaskId, reason]); });
  let pendingId = "";
  return {
    inbox,
    expired,
    wait,
    expire,
    async budget(taskInput: ModelTaskRecord, onExhausted = vi.fn(async () => undefined)): Promise<{ outcome?: ExternalWaitOutcome; onExhausted: ReturnType<typeof vi.fn>; error?: unknown }> {
      pendingId = taskInput.id;
      try {
        return { outcome: await inbox.waitWithinBudget(taskInput, wait, expire, onExhausted), onExhausted };
      } catch (error) {
        return { onExhausted, error };
      }
    },
    async bare(taskInput: ModelTaskRecord, prefix = "外部模型任务"): Promise<ExternalWaitOutcome> {
      pendingId = taskInput.id;
      return inbox.wait(taskInput, wait, expire, prefix);
    },
  };
}

describe("外部任务等待协议（external-task-protocol）", () => {
  it("交付结果：resolved 交出 result，且信号只消费一次", async () => {
    const host = makeHost({ settle: true, payload: { value: { ok: 1 } } });
    const first = await host.bare(task("mt-1"));
    expect(first).toEqual({ status: "resolved", value: { value: { ok: 1 } } });
    expect(externalDeliveryValue(first)).toEqual({ value: { ok: 1 } });

    // 反例面：同一任务的信号被取走后，再等待不得复用旧结果（否则陈旧交付会重复落库）。
    const inbox = new ExternalTaskInbox();
    inbox.deliver({ modelTaskId: "mt-consume", result: { value: 1 } });
    const waiter = async (predicate: () => boolean) => predicate();
    const expire = async () => undefined;
    expect((await inbox.wait(task("mt-consume"), waiter, expire, "外部任务")).status).toBe("resolved");
    expect((await inbox.wait(task("mt-consume"), waiter, expire, "外部任务")).status).toBe("unclaimed");
  });

  it("超时无人认领：expire 留痕后归一化为 unclaimed，不静默轮询", async () => {
    const host = makeHost({ settle: false });
    const outcome = await host.bare(task("mt-2"));
    expect(outcome.status).toBe("unclaimed");
    expect(host.expired).toEqual([["mt-2", "外部模型任务等待超时"]]);
    expect(externalDeliveryValue(outcome)).toEqual({});
  });

  it("显式失败：归一化为 rejected，且不重复 expire（DB 已有真实 reason）", async () => {
    const host = makeHost({ settle: true, failure: {} });
    const outcome = await host.bare(task("mt-3"), "外部书名生成任务");
    expect(outcome.status).toBe("rejected");
    // 反例面：对已 failed 的任务再 expire 只会给同任务下的死租约盖上 expired 标记，
    // 把"干过活但干砸了"污名为"没人领"。
    expect(host.expired).toEqual([]);
  });

  it("预算推进：每档超时记一档，未超限只回 unclaimed", async () => {
    const host = makeHost({ settle: false });
    for (let index = 0; index < MAX_EXTERNAL_FALLBACK_ADVANCES; index += 1) {
      const { outcome, onExhausted } = await host.budget(task(`mt-budget-${index}`));
      expect(outcome?.status).toBe("unclaimed");
      expect(onExhausted).not.toHaveBeenCalled();
    }
    expect(host.inbox.budgetAdvances).toBe(MAX_EXTERNAL_FALLBACK_ADVANCES);
  });

  it("预算耗尽：先让调用方落 manual-review-required 留痕，再抛预算错误", async () => {
    const host = makeHost({ settle: false });
    let last = { onExhausted: undefined as unknown };
    for (let index = 0; index <= MAX_EXTERNAL_FALLBACK_ADVANCES; index += 1) {
      last = await host.budget(task(`mt-exhaust-${index}`));
    }
    expect(last.onExhausted).toBeInstanceOf(Function);
    const exhausted = last as { onExhausted: ReturnType<typeof vi.fn>; error?: unknown };
    expect(exhausted.error).toBeInstanceOf(ExternalFallbackBudgetExhaustedError);
    expect(exhausted.onExhausted).toHaveBeenCalledWith(MAX_EXTERNAL_FALLBACK_ADVANCES + 1, `mt-exhaust-${MAX_EXTERNAL_FALLBACK_ADVANCES}`);
  });

  it("边界双向：交付成功与显式失败都不消耗预算（失败是干过活砸了，不是没人领）", async () => {
    const resolved = makeHost({ settle: true, payload: { value: 1 } });
    await resolved.budget(task("mt-ok"));
    expect(resolved.inbox.budgetAdvances).toBe(0);
    const rejected = makeHost({ settle: true, failure: {} });
    const { outcome, onExhausted } = await rejected.budget(task("mt-rejected"));
    expect(outcome?.status).toBe("rejected");
    expect(rejected.inbox.budgetAdvances).toBe(0);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("信号判据：无 modelTaskId 的载荷不落账（新增信号面不会污染等待集合）", async () => {
    const inbox = new ExternalTaskInbox();
    inbox.deliver({ result: { value: 1 } });
    inbox.reject("not-an-object");
    const host = makeHost({ settle: false });
    // 未落账的任务只能走超时路径
    expect((await inbox.wait(task("mt-x"), host.wait, host.expire, "外部任务")).status).toBe("unclaimed");
  });

  it("窗口与预算常量具名且量级合理", () => {
    expect(EXTERNAL_TASK_WAIT_WINDOW).toBe("15 minutes");
    expect(MAX_EXTERNAL_FALLBACK_ADVANCES).toBeGreaterThan(0);
    expect(MAX_EXTERNAL_FALLBACK_ADVANCES).toBeLessThanOrEqual(20);
    expect(new ExternalFallbackBudgetExhaustedError(7, "mt-1").name).toBe("ExternalFallbackBudgetExhaustedError");
  });
});

/**
 * 接线完整性锁：机制单源之后，workflows.ts 不得再出现第二份等待实现，
 * 且每个预算型等待点都要有保住 DB 态的 catch（业务性失败不得伪装成基础设施失败）。
 */
describe("外部任务协议接线锁", () => {
  const source = readFileSync(join(process.cwd(), "src", "novel-v2", "temporal", "workflows.ts"), "utf8");

  it("workflows.ts 内不再有本地等待实现与本地窗口/预算副本", () => {
    expect(source).not.toMatch(/const externalResults = new Map/);
    expect(source).not.toMatch(/externalAdvances \+= 1;/);
    expect(source).not.toMatch(/"15 minutes"/);
    expect(source).toMatch(/export \{[^}]*MAX_EXTERNAL_FALLBACK_ADVANCES[^}]*\} from "\.\/external-task-protocol"/);
  });

  it("七个等待点全部经协议模块：3 预算型 + 4 候选/降级型", () => {
    expect([...source.matchAll(/externalTasks\.waitWithinBudget\(/g)].length).toBe(3);
    // 3 内联候选推进（简介/书名/章节命名）+ 弧 waitForExternal 实现 + 弧学习降级点。
    expect([...source.matchAll(/externalTasks\.wait\(/g)].length).toBe(5);
    expect([...source.matchAll(/externalTasks = new ExternalTaskInbox\(\)/g)].length).toBe(7);
    // 每个预算型工作流都有对应 catch，DB 态不被覆写 failed。
    expect([...source.matchAll(/if \(error instanceof ExternalFallbackBudgetExhaustedError\)/g)].length).toBeGreaterThanOrEqual(3);
  });
});
