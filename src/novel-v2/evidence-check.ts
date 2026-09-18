/**
 * Evidence 正文包含性校验与 targeted 修订机器核对清单。
 *
 * 独立模块的原因：Temporal workflow 沙箱禁用 node:crypto，而
 * chapter-review-snapshot.ts 顶层使用 createHash（指纹计算）——workflow 内
 * 需要证据核对（buildTargetedIssueMachineCheck），必须从无 crypto 依赖的
 * 模块导入（2026-09-08 实证：workflows.ts 引入含 crypto 的模块导致 worker
 * webpack 打包失败）。
 */

import type { ReviewIssue } from "./protocol";

/**
 * 校验 issue 的 evidenceQuote 是否出现在给定正文中。
 *
 * 规则（保守）：把 evidence 与正文都做同口径剥除（空白+常见标点，含全角/半角
 * 引号——evidence 常为编辑摘录，标点形态与正文不完全一致，单侧剥除会漏匹配）；
 * evidence 去除常见省略符（……/…/...）后若长度 ≥ 6 且正文不包含其任意 24 字
 * 窗口，判定为未命中。短 evidence（< 6 字）不做判定（可能是通用指代，误报率高）。
 * 设计依据：evidence 不是逐字引文（pipeline-audit §2.5），因此只做包含性软校验，
 * 不要求逐字匹配；命中与否由调用方决定用途。
 */
export function isEvidencePresentInText(evidence: string | undefined, plainText: string | undefined): boolean | undefined {
  if (!evidence || !plainText) return undefined;
  const strip = (value: string) => value.replace(/\s+/gu, "").replace(/[。，、；：？！""''""'']/gu, "");
  const compactText = strip(plainText);
  if (!compactText) return undefined;
  const segments = strip(evidence)
    // 省略符形态覆盖 U+2026（…、……、………）与 ASCII 点号（...、......）。
    .split(/…+|\.{3,}/u)
    .filter((segment) => segment.length > 0)
    .sort((left, right) => right.length - left.length);
  const best = segments[0];
  if (!best || best.length < 6) return undefined;
  if (compactText.includes(best)) return true;
  const window = best.slice(0, 24);
  if (window.length >= 6 && compactText.includes(window)) return true;
  return false;
}

/**
 * Evidence 闭环校验（2026-09-08）：targeted 修订三个时点的机器核对。
 *
 * 实证根因（ch15 互斥结局 blocker）：合同变更只登记了新结局的修订窗口，被取代的
 * 旧结局段落在窗口外，三轮评审与作者批准都没有机器核对口诀——「逐行 diff 无删改」
 * 在合同变更场景下恰恰是失败信号。本函数把「该删的删了吗」交给机器，批准者只对
 * 机器无法判定的语义部分负责。
 *
 * - consume（消费时）：证据已不在当前正文 → evidenceStale=true（过报/陈旧意见，
 *   不应作为修订窗口直接执行——采纳将复现已修复的时序矛盾）；
 * - resolve（解决时，修订后候选正文）：evidence 仍在候选中 → evidenceStillPresent=true
 *   （问题很可能未被修改，或修改放错位置——首轮候选放置错误即可由本项拦截）。
 *
 * 边界：只做包含性软核对，不判定语义是否修对；suggestion 是给修订模型的指令语气，
 * 字面不出现在正文中，故不做短语匹配（实测指令措辞与成文措辞天然不同，短语匹配
 * 恒假）——语义是否落地由评审与批准者判断。
 */
export interface TargetedIssueMachineCheck {
  /** 修订窗口（issue 登记的 revisionRanges，供批准者核对改动分布）。 */
  revisionRanges: Array<{ start: number; end: number }>;
  /** 消费时核对：证据已不在当前（修订前）正文。 */
  evidenceStale?: boolean;
  /** 解决时核对：证据仍留在修订后候选中（疑似未修或改错位置）。 */
  evidenceStillPresent?: boolean;
}

export function buildTargetedIssueMachineCheck(
  issue: Pick<ReviewIssue, "evidence" | "excerpt" | "revisionRanges">,
  input: { textBefore: string; textAfter: string },
): TargetedIssueMachineCheck {
  const evidence = issue.excerpt ?? issue.evidence;
  const check: TargetedIssueMachineCheck = { revisionRanges: issue.revisionRanges ?? [] };
  const presentBefore = isEvidencePresentInText(evidence, input.textBefore);
  if (presentBefore === false) check.evidenceStale = true;
  const presentAfter = isEvidencePresentInText(evidence, input.textAfter);
  if (presentAfter === true) check.evidenceStillPresent = true;
  return check;
}

/**
 * 汇总 targeted 修订全部 issue 的机器核对结论，供批准门禁 payload 使用。
 * 全部通过时 ok=true（evidenceStale/evidenceStillPresent 均未出现）。
 */
export function summarizeTargetedMachineChecks(checks: TargetedIssueMachineCheck[]): { ok: boolean; checks: TargetedIssueMachineCheck[] } {
  const ok = checks.every((check) => !check.evidenceStale && !check.evidenceStillPresent);
  return { ok, checks };
}

/**
 * 用 evidenceQuote 反查其在正文中的全部命中段落号（1-based 非空行序）。
 *
 * 实证根因（ch15 定向修订放置错误）：编辑器行号（含空行）与系统段落号（非空行序）
 * 错位，登记时手填 paragraph/revisionRanges 指到错误窗口——修订模型按窗口执行，
 * 改写插到了无关段落。本函数以证据分段（isEvidencePresentInText 同口径）在各段
 * 定位，调用方（REST/MCP issue 创建入口）用定位结果校正调用方传入值。
 *
 * 边界：evidence 分段（省略号分隔）跨段引用时按各段独立定位；无法定位返回空数组
 * （此时保留调用方传入值并依赖人工核对）。
 */
export function locateEvidenceParagraphs(plainText: string | undefined, evidenceQuote: string | undefined): number[] {
  if (!plainText || !evidenceQuote) return [];
  const strip = (value: string) => value.replace(/\s+/gu, "").replace(/[。，、；：？！""''""'']/gu, "");
  const segments = strip(evidenceQuote)
    .split(/…+|\.{3,}/u)
    .filter((segment) => segment.length >= 6)
    .sort((left, right) => right.length - left.length);
  if (!segments.length) return [];
  const paragraphs = plainText.split(/\n+/u);
  const hits: number[] = [];
  paragraphs.forEach((paragraph, index) => {
    const stripped = strip(paragraph);
    if (!stripped) return;
    if (segments.some((segment) => stripped.includes(segment))) hits.push(index + 1);
  });
  return hits;
}