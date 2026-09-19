/**
 * Token 估算——单一实现 + 具名口径。
 *
 * 根因：同一个量纲此前散落 **7 份实现、3 种互不相容的口径**。flat
 * `Math.ceil(text.length / 2)` 出现在 5 处（cognition 记忆装配的本地函数、
 * stage-context 的 `estimateStageTokens`、model-gateway 调用前预算闸×2、
 * activities 的记忆选择收据），model-gateway 的用量留痕侧另有一份 CJK 感知估算，
 * `src/lib/model-capabilities` 的硬上限闸又有第三份（CJK 系数 1.1）。重复的代价
 * 不是"代码冗余"，而是**同一字段承载多种口径**：`selectionReceipts[].tokenCost` 由
 * cognition 与 activities 两条路径用不同公式各写一遍（一处含 `\n` 分隔、一处不含），
 * `estimated_input_tokens` 一列里既有 0.5 token/字的行也有 0.75 token/字的行——而
 * "估算↔provider 实测比值"报表（workflow-map E5）正是暴露估算器系统性偏差的唯一通道，
 * 分母口径混杂时它会把"两处估算本来就不一样"误读成"provider 上报异常"。
 *
 * 本文件把实现收敛为一个（CJK 判定、空白判定、下限 1、拉丁档折算只有一份代码），
 * 口径差异收敛为 3 个具名 basis。**刻意没有合并成单一口径**，原因是预算侧的口径与
 * 预算常数是"共同标定的一对"：`computeTokenBudget` 的阶梯（24K/64K→96K→128K，
 * 见 cognition 内 ch125 顶穿实证注释）与 `maxInputTokens` 配置都是在 flat 口径下
 * 对着实测"必要上下文"数字调出来的，只换口径不换常数等于把这轮标定作废，会让已上线
 * 的长篇运行在边界章节上批量抛 `context-budget-exceeded`。
 *
 * 合并条件（需要证据，不接受拍脑袋调参）：在一次真实长篇运行里同时留下 flat 口径与
 * AUDIT 口径的估算值，并用 provider 实测 input_tokens 校准二者的实际偏差，再按测得
 * 比值整批重标预算常数——届时删掉 BUDGET basis，本文件只剩一份口径。**存量库数据不能
 * 替代该前置**（2026-09-19 全量取证，详见 workflow-map §4 E5）：两条 BUDGET 预算闸都在文本
 * `invoke` 路径上，而文本 purpose 的 provider 上报有 95%–100% 落在占位 usage 非测量带；可测
 * 样本 93% 是 `memory.embed`，走向量路径、根本不消费本口径。缺的是新数据，不是分析方法。
 *
 * 残留已知偏差：调用前预算闸拒绝的行仍把 BUDGET 口径写进 `estimated_input_tokens`
 * （闸判据与错误文本要引用同一个数，拆开会让报错自相矛盾）。这些行没有 provider
 * 上报，被比值报表的 `provider_input_tokens IS NOT NULL` 条件天然排除；但按
 * `usage_source='estimated'` 汇总用量时须同时按 status 过滤，否则两种口径会相加。
 */

export interface TokenEstimateBasis {
  readonly cjkTokensPerChar: number;
  readonly latinCharsPerToken: number;
}

/**
 * 留痕/审计口径：CJK 感知，已被 provider 实测校准（E5 报表 memory.embed/rerank
 * p50≈1.04/1.52 即此口径跑出的分布）。写入 `estimated_input_tokens` 的唯一口径。
 */
export const AUDIT_TOKEN_BASIS: TokenEstimateBasis = { cjkTokensPerChar: 0.75, latinCharsPerToken: 4 };

/**
 * 预算/淘汰口径：flat 0.5 token/字（CJK 与拉丁同系数，故 cjk*a + other*a == len*a）。
 * TODO 可配置：与 `computeTokenBudget` 阶梯及各 purpose `maxInputTokens` 配置共同标定，
 * 改动此口径必须同批重derive 全部预算常数，否则边界章节会批量顶穿。
 */
export const BUDGET_TOKEN_BASIS: TokenEstimateBasis = { cjkTokensPerChar: 0.5, latinCharsPerToken: 2 };

/**
 * 硬上限闸口径：对 CJK 取悲观系数，失败模式是"必带资料被 provider 截断"，宁可早报错。
 * TODO 可配置：仅 `assertModelContextLimit` 一类"绝不截断"的闸使用。
 */
export const HARD_GATE_TOKEN_BASIS: TokenEstimateBasis = { cjkTokensPerChar: 1.1, latinCharsPerToken: 4 };

// 统一表意文字（含扩展 A 与兼容表意区）。补充平面（扩展 B 及以后）落进"非 CJK"一档，
// 按 UTF-16 代理对计 2 字符 → 低估；生僻字入名的场景偏差方向是低估，故留此注记而非静默。
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/gu;

/** 空/纯空白 → 0；非空结果下限 1 token。默认审计口径，预算侧须显式传 basis。 */
export function estimateTokens(text: string, basis: TokenEstimateBasis = AUDIT_TOKEN_BASIS): number {
  if (!text.trim()) return 0;
  const cjk = (text.match(CJK_PATTERN) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk * basis.cjkTokensPerChar + other / basis.latinCharsPerToken));
}

/** 预算/段落淘汰侧的口径别名（cognition、stage-context、调用前预算闸）。 */
export function estimateBudgetTokens(text: string): number {
  return estimateTokens(text, BUDGET_TOKEN_BASIS);
}
