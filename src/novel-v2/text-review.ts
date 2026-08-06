import type { ReviewIssue } from "./protocol";

/**
 * 规划级审核文本契约（Foundation 与故事弧共用）。
 *
 * 设计依据：规划级审核的产出本质是「通过」或「可执行指导意见」，
 * 强结构化枚举（verdict/scores/issues/consistencyChecks）依赖 provider
 * 真正执行 strict json_schema，第三方中转站可能忽略该字段导致模型自由发挥、
 * 修复循环 3 次仍失败。文本契约对任何 provider 零依赖：
 * - 通过 → 只输出单行 PASSED
 * - 不通过 → 输出审核意见全文，意见本身即「不通过」信号
 *
 * 解析基于结构特征（单行标记/围栏提取），可跨 prompt 版本、题材与模型复用，
 * 不识别任何特定内容。
 */
export interface TextReviewOutput {
  verdict: "passed" | "revise";
  opinion: string;
}

/** 通过标记：模型通过审核时必须只输出这一行（不区分大小写，允许空白）。 */
export const TEXT_REVIEW_PASSED_MARKER = "PASSED";

/** 意见为空时的兜底说明，保证 revise 永远有可回流的意见文本。 */
export const TEXT_REVIEW_EMPTY_OPINION_FALLBACK = "审核未通过，但未提供具体意见。";

function extractFencedContent(content: string): string | undefined {
  const match = content.match(/```(?:json|text|markdown)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function stripInstructionEcho(content: string): string {
  // 模型偶尔回显「审核意见：」等注入前缀；按行首冒号结构剥离第一处标签。
  // TODO P3: {1,12} 为魔法值（行首标签长度上限），未来可配置化。
  const lines = content.split(/\r?\n/);
  const first = lines[0]?.trim();
  if (first && /^[A-Za-z\u4e00-\u9fa5]{1,12}[：:]\s*$/.test(first)) return lines.slice(1).join("\n").trim();
  return content;
}

function stripPassedPrefix(content: string): string {
  // 模型在输出意见时回显「PASSED」标记前缀（单独一行，或后跟冒号）；该前缀是
  // 标记回显而非意见内容，剥离后剩余部分才是意见，避免污染回流到重新生成的指令。
  const lines = content.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  if (lines.length > 1 && /^PASSED[：:\s.,。]*$/i.test(first)) return lines.slice(1).join("\n").trim();
  if (/^PASSED[：:]\s*/i.test(content)) return content.replace(/^PASSED[：:]\s*/i, "").trim();
  return content;
}

/**
 * 解析规划级审核文本。
 *
 * 判定规则（结构特征，非内容匹配）：
 * - 提取代码围栏内容（若存在）作为正文
 * - 正文（去空白）等于 PASSED → passed
 * - 其余任何内容（含空输出）→ revise，意见为正文全文（剥离 PASSED 标记回显与
 *   指令回显前缀）；仅当正文为空时使用兜底文案，保证意见非空
 */
export function parseTextReview(raw: string): TextReviewOutput {
  const content = (extractFencedContent(raw) ?? raw).trim();
  // 通过标记允许尾部标点（模型在单行 PASSED 后追加句号是常见行为），
  // 与 stripPassedPrefix 的标点容忍集合保持一致，避免带标点的通过被误判为 revise。
  if (/^PASSED[：:\s.,。]*$/i.test(content)) return { verdict: "passed", opinion: "" };
  const opinion = stripPassedPrefix(stripInstructionEcho(content)) || TEXT_REVIEW_EMPTY_OPINION_FALLBACK;
  return { verdict: "revise", opinion };
}

/**
 * 从外部任务回填值中提取审核文本：兼容 string 与 { text } 两种形态，
 * 其余对象退化为 JSON 序列化（保持可诊断性）。
 */
export function extractReviewText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text;
  return JSON.stringify(value);
}

/**
 * 将审核意见投影为单条 major issue，供 creative submitReview / learning 等
 * 结构化消费方使用（gate 的 score 由 issues 派生）。
 */
export function opinionToReviewIssue(opinion: string, evidence: string): ReviewIssue {
  return {
    severity: "major",
    title: "规划审核意见",
    description: opinion,
    evidence,
    suggestion: opinion,
  };
}
