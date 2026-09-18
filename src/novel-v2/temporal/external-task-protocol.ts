/**
 * 外部模型任务等待协议——单一真源（Temporal workflow bundle 安全的叶子模块）。
 *
 * 根因：这套"等 signal → 窗口超时 → expire → 回退"的机制此前在 workflows.ts 里
 * 有 7 份手写副本，且分裂成两种回退语义：
 * - 预算推进型（章节主循环 / creative run / 章节审校）：超时无人认领即消耗一档预算，
 *   超过 MAX_EXTERNAL_FALLBACK_ADVANCES 转 manual-review-required 并抛
 *   ExternalFallbackBudgetExhaustedError，由外层 catch 保住 DB 态不被覆写 failed；
 * - 候选推进型（弧规划 / 审核 / 修订 / 作品简介 / 书名 / 章节命名）：超时或失败即
 *   expire 并 `candidateStartIndex = task.candidateIndex + 1` 换下一候选。
 * 副本分叉的实际代价：弧学习评估（runStoryArcLearning）落在主 try 内且没有回退分支，
 * 一次外部任务超时就把**已经定稿入库的弧**整个 run 打成 failed——业务性失败伪装成
 * 基础设施失败，正是 terminal-outcome 要消除的那类形状。
 *
 * 泛化边界：本模块只定义"等待与归一化"，**不替调用方选择回退策略**——两条出路
 * （换候选 / 花预算）由工作流按所在阶段的语义决定，因为同一工作流内不同阶段的
 * 正确出路本就不同。策略选择留在调用点，机制只此一份。
 *
 * 确定性：不读 env、不用 Date/random、不 import node 内置——窗口与预算都是纯常量，
 * 与 workflow 沙箱要求一致。condition() 由调用方注入，因此本模块可直接单测执行
 * （此前"沙箱代码难以单测"只能用源码文本断言兜）。
 */
import type { ModelTaskRecord } from "../model-routing";

/**
 * 等待窗口：与外部执行者（dsh / 人工）的认领节奏对齐——租约与心跳按分钟级设计，
 * 15 分钟无 signal 即视为本轮无人接手（同 workflow-map 的 model-task.expired 契约）。
 * TODO 可配置：窗口应随部署形态（本机 agent vs 远程编排者）可调，现先具名集中。
 */
export const EXTERNAL_TASK_WAIT_WINDOW = "15 minutes";

/**
 * 预算档位上限：一次生成链（draft + 3 审 + revision + learning…）单任务通常 1-2 档
 * 内被认领，6 档 = 90 分钟无认领即视为"外部执行者缺位"而非慢，继续轮询只烧墙钟。
 * 形态对齐 revision-policy 的 DEFAULT_MAX_AUTO_REVISIONS——workflow 沙箱纯常量，不读 env。
 */
export const MAX_EXTERNAL_FALLBACK_ADVANCES = 6;

export class ExternalFallbackBudgetExhaustedError extends Error {
  constructor(readonly advances: number, readonly modelTaskId: string) {
    super(`外部回退预算耗尽（${advances} 档超时无人认领），已转 manual-review-required`);
    this.name = "ExternalFallbackBudgetExhaustedError";
  }
}

/** 注入的 condition——workflow 侧传 `(predicate) => condition(predicate, 窗口)`。 */
export type ExternalSignalWaiter = (predicate: () => boolean) => Promise<boolean>;

export type ExternalWaitOutcome =
  /** 外部执行者交付了结果；value 即 materialize 消费的结果体（缺失时为 undefined）。 */
  | { status: "resolved"; value: Record<string, unknown> | undefined }
  /** 窗口内无人认领（调用方决定：换候选 or 记一档预算）。 */
  | { status: "unclaimed" }
  /** 外部执行者显式失败。 */
  | { status: "rejected" };

/**
 * 一个工作流运行内的外部任务收发箱：signal 落账与等待归一化。
 * 每个 workflow 函数持有一个实例（工作流局部状态，随 history 重放一致）。
 */
export class ExternalTaskInbox {
  private readonly results = new Map<string, Record<string, unknown>>();
  private readonly failures = new Map<string, Record<string, unknown>>();
  private advances = 0;

  /**
   * artifact signal 记账——所有工作流的信号载荷用同一判据取 modelTaskId
   * （此前 7 处各自手写 typeof 判定，新增信号面时最容易漏）。
   */
  deliver(payload: unknown): void {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") this.results.set(body.modelTaskId, body);
  }

  reject(payload: unknown): void {
    const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (typeof body.modelTaskId === "string") this.failures.set(body.modelTaskId, body);
  }

  /** 已落定的外部任务数（预算/留痕用）。 */
  get budgetAdvances(): number {
    return this.advances;
  }

  /**
   * 纯等待：把"窗口超时 / 显式失败 / 已交付"归一化成三态。
   *
   * 只有 `unclaimed`（无人认领）才 expire——那正是"任务发了没人领、行会永远停在
   * waiting-external"的形态，expire 负责关行并发 `model-task.expired` 留痕。
   * `rejected` 不 expire：外部执行者显式失败时 `failModelTask` 已把任务行与该 attempt
   * 落成 failed 并写入真实 reason，再调 expire 对任务行是空转（WHERE 只认
   * pending/claimed/running），却会给同任务下的其他死租约盖上 `expired:true`，
   * 把"干过活但干砸了"污名为"没人领"。回退策略仍由调用方决定。
   */
  async wait(
    task: ModelTaskRecord,
    wait: ExternalSignalWaiter,
    expire: (modelTaskId: string, reason: string) => Promise<void>,
    reasonPrefix: string,
  ): Promise<ExternalWaitOutcome> {
    const settled = await wait(() => this.results.has(task.id) || this.failures.has(task.id));
    if (!settled) {
      await expire(task.id, `${reasonPrefix}等待超时`);
      return { status: "unclaimed" };
    }
    if (this.failures.has(task.id)) {
      this.failures.delete(task.id);
      return { status: "rejected" };
    }
    const payload = this.results.get(task.id) ?? {};
    this.results.delete(task.id);
    const result = payload.result;
    return { status: "resolved", value: result && typeof result === "object" ? result as Record<string, unknown> : undefined };
  }

  /**
   * 预算型等待：超时无人认领记一档预算，超过 MAX_EXTERNAL_FALLBACK_ADVANCES 先让
   * 调用方落 manual-review-required 留痕（onExhausted），再抛预算耗尽错误。
   * 显式失败不消耗预算——那是外部执行者干过活但干砸了，属候选推进的范畴。
   */
  async waitWithinBudget(
    task: ModelTaskRecord,
    wait: ExternalSignalWaiter,
    expire: (modelTaskId: string, reason: string) => Promise<void>,
    onExhausted: (advances: number, modelTaskId: string) => Promise<void>,
    reasonPrefix = "外部模型任务",
  ): Promise<ExternalWaitOutcome> {
    const outcome = await this.wait(task, wait, expire, reasonPrefix);
    if (outcome.status !== "unclaimed") return outcome;
    this.advances += 1;
    if (this.advances > MAX_EXTERNAL_FALLBACK_ADVANCES) {
      await onExhausted(this.advances, task.id);
      throw new ExternalFallbackBudgetExhaustedError(this.advances, task.id);
    }
    return outcome;
  }
}

/**
 * 交付值取出并归一化：materialize 类活动一律吃 `value` 字段。
 * 缺失/非对象回落空对象——保持与旧内联 `payload.result ?? {}` 同形（非阻断装配语义）。
 */
export function externalDeliveryValue(outcome: ExternalWaitOutcome): Record<string, unknown> {
  return outcome.status === "resolved" && outcome.value ? outcome.value : {};
}
