import { estimateTokens, HARD_GATE_TOKEN_BASIS } from "../novel-v2/token-estimate";

const detectedContextWindows = new Map<string, number>();

export function recordModelContextWindow(model: string, value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (model && Number.isFinite(parsed) && parsed > 0) detectedContextWindows.set(model, Math.floor(parsed));
}

export function resolveModelContextWindow(model: string, override?: number) {
  if (override && override > 0) return override;
  return detectedContextWindows.get(model);
}

// 硬上限闸取悲观口径（HARD_GATE basis：CJK 系数刻意高于留痕侧的实测校准值），因为这里
// 的失败模式是"必带资料被 provider 截断"，宁可早报错。除系数外与单一真源共用同一实现。
export function estimateTextTokens(text: string) {
  return estimateTokens(text, HARD_GATE_TOKEN_BASIS);
}

export function assertModelContextLimit(params: { model: string; text: string; override?: number; outputReserve?: number }) {
  const limit = resolveModelContextWindow(params.model, params.override);
  if (!limit) return;
  const inputEstimate = Math.ceil(estimateTextTokens(params.text) * 1.15);
  const outputReserve = params.outputReserve ?? 4096;
  if (inputEstimate + outputReserve > limit) {
    throw new Error(`本次完整上下文预计需要 ${inputEstimate.toLocaleString()} tokens，并需为输出保留 ${outputReserve.toLocaleString()} tokens，超过模型 ${params.model} 的 ${limit.toLocaleString()} tokens 硬上限。系统没有截断必带资料，请缩小任务范围或切换更大上下文模型。`);
  }
}

export const estimateNovelTokens = estimateTextTokens;
