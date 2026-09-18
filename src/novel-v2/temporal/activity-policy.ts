import type { ActivityOptions } from "@temporalio/workflow";

/**
 * Temporal 活动重试策略表——单一真源。
 *
 * 根因：策略此前以字面量内联在每个 workflow 函数里（4 处），分叉已经发生实际危害：
 * `creativeRunWorkflow` 的策略缺 `nonRetryableErrorTypes`，于是模型传输错误在那里
 * 会被重试 3 次——而章节主循环同一位置的注释早就写明了为什么不能重试
 * （"accept both forms so an exhausted model route reaches the durable failure state
 * instead of lingering in retry"）。重试一个已经耗尽候选链的调用不会自愈，只会
 * 拉长墙钟、重复物化外部任务、并让对账窗口里的 run 看起来仍在推进。
 *
 * 泛化边界：本表只收"活动执行策略"（超时/重试/错误类型），不收业务阶段语义。
 * 两种形态的差别是**任务体量**而非阶段特权：弧的 generate/review/revise 在单个
 * activity 内串行跑 arc plan + chapters 两次模型调用，10 分钟对长弧重基线不够
 * （曾触发 StartToClose timeout 使弧卡在 failed），所以它放宽超时并**关掉重试**
 * （重试等于把两次模型调用再跑一遍）；其余工作流走标准档。
 *
 * 约束：新增 proxyActivities 必须从这里取策略；要加新档位就在本文件里加并说明
 * 它覆盖的是哪类任务体量——不允许在 workflow 里就地凑一份。
 */

/**
 * 模型传输错误不重试。Temporal 可能按 Error 子类的构造器名而非自定义 `name` 序列化，
 * 两种拼写都要列上，否则候选链耗尽的调用会留在重试里而非落到持久失败态。
 */
export const NON_RETRYABLE_MODEL_ERROR_TYPES: string[] = ["NonRetryableModelTransportError", "ModelTransportError"];

/** 标准档：轻活动（读写库、单步模型调用），10 分钟窗口、最多 3 次尝试。 */
export const STANDARD_ACTIVITY_POLICY: ActivityOptions = {
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: [...NON_RETRYABLE_MODEL_ERROR_TYPES],
  },
};

/** 重任务档：单活动内串行多次模型调用（整弧生成/审核/修订），放宽窗口、禁自我重试。 */
export const HEAVY_MODEL_ACTIVITY_POLICY: ActivityOptions = {
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: 1,
    nonRetryableErrorTypes: [...NON_RETRYABLE_MODEL_ERROR_TYPES],
  },
};
