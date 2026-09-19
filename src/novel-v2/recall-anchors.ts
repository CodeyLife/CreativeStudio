import { narrativeTextKey } from "./narrative-elements";
import { textBigramDice } from "./memory-grooming";

/**
 * 回述对照诊断（product-audit-20260910 §四 19 的 D2 项）。
 *
 * 根因：正文里的"他想起 / 那日 / 上次"这类回述句从未与被引章原文对照——章节三审只做
 * 本章内部互证，跨章账本（物品数量、期限、谁说过什么、谁见过什么）最容易在回述处漂移
 * （审计实证：云纹草 ch13 扔地 → ch14"怀里夺走 + 残叶" → ch16"整株抢走 + 偷偷截留"
 * → ch17"搜走的一模一样分量"，五章五说）。审校者拿不到被引章的原句时只能凭上下文
 * 印象判断，等于没有判据；而"逐条 diff 被引章原文"这件事人做扛不动、模型做会虚构出处。
 *
 * 机械层做：抽取本章回述句 → 在近窗各章的句子库里按字符二元组重叠取最相似的原句，
 * 附章号与相似度降序呈现。
 * 机械层不做：不判定"是否矛盾"（语义判断，归审校者与外部编排者）、不以任何未做语料
 * 校准的相似度阈值下结论（只排序不设门槛，避免把判据变成随机行为）、不改正文、不阻断
 * 提交链路。逐字复述（相似度 1.0）是跨章复读的最强信号，因此不排除与回述句完全相同的
 * 候选——调用方不得把被检章自身当近窗章传入。零相似度的候选不输出（那是噪声而非"无据"，"无据"由读者看到空列表自行判断）。
 *
 * 泛化红线：cue 词表是汉语时间/记忆指示功能词，不含题材词、角色名、物品名；
 * 窗长、句数、候选数属体量参数，逐条标注可配置意图。
 */

/**
 * 回述触发词（功能词表：记忆与过去时间指示；换题材无需改动）。
 *
 * 刻意不收"之前"：真实正文实测它大量用作**前瞻性**连接词（"要在被人抓住之前把自己
 * 洗清"并非回忆），假阳性直接把审校注意力耗在无效对照上；回述语义已由表内其余词覆盖。
 * 同理不收裸"前"/"回"这类单字片段——必须成词才登记。
 */
export const RECALL_CUES = [
  "想起", "记起", "记得", "那日", "那天", "当日", "前日", "几日前", "数日前",
  "上次", "上回", "那回", "那一回", "当初", "从前", "早前", "先前", "那晚", "当晚",
] as const;

export const RECALL_REPORT_POLICY = {
  /** 参与对照的前章数（近窗）。TODO 可配置：与跨章序列证据窗口同源调整。 */
  window: 12,
  /** 单章报告最多列出的回述句数，避免长章刷屏。TODO 可配置：按章体量缩放时应改为比例。 */
  maxSentences: 12,
  /** 每条回述句附带的候选原句数。TODO 可配置：审校者反馈"看不出哪条"时优先调这里。 */
  maxSources: 3,
  /** 短于此长度的句子不参与（"他记得。"这类无事件信息可比对）。TODO 可配置：与语速/句长分布相关。 */
  minSentenceChars: 6,
} as const;

export interface RecallSource {
  /** 被引章的叙事序（与 manuscript_documents.narrative_order 同量纲）。 */
  narrativeOrder: number;
  documentId?: string;
  /** 该章中与回述句最相似的原句。 */
  sentence: string;
  /** 字符二元组重叠度（narrativeTextKey 归一后），仅供排序参考，非"矛盾概率"。 */
  similarity: number;
}

export interface RecallAnchor {
  sentence: string;
  cue: string;
  /** 降序候选；为空表示近窗内无可比对内容（由审校者判"回述无据"，机械层不下结论）。 */
  sources: RecallSource[];
}

const SENTENCE_BOUNDARY = /[。！？；\n]+/;

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_BOUNDARY).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

/** 抽取回述句：按出现顺序，每句只取第一个命中的 cue（同句多 cue 不重复列）。 */
export function extractRecallSentences(text: string, minSentenceChars: number = RECALL_REPORT_POLICY.minSentenceChars): Array<{ sentence: string; cue: string }> {
  const anchors: Array<{ sentence: string; cue: string }> = [];
  for (const sentence of splitSentences(text ?? "")) {
    if (sentence.length < minSentenceChars) continue;
    let matched: string | undefined;
    let matchedAt = Number.POSITIVE_INFINITY;
    for (const cue of RECALL_CUES) {
      const at = sentence.indexOf(cue);
      if (at >= 0 && at < matchedAt) {
        matched = cue;
        matchedAt = at;
      }
    }
    if (matched) anchors.push({ sentence, cue: matched });
  }
  return anchors;
}

/**
 * 构建回述对照：每条回述句在近窗各章里取相似度降序的前 N 条原句。
 * 相似度用与记忆梳理同一套 `narrativeTextKey` + 字符二元组 Dice（共享层，不再造轮子）。
 */
export function buildRecallAnchors(
  input: { text: string; priorChapters: Array<{ narrativeOrder: number; documentId?: string; text: string }> },
  policy: Pick<RECALL_REPORT_POLICY_TYPE, "maxSentences" | "maxSources"> = RECALL_REPORT_POLICY,
): RecallAnchor[] {
  const anchors = extractRecallSentences(input.text).slice(0, policy.maxSentences);
  const chapterSentences = input.priorChapters.map((chapter) => ({
    narrativeOrder: chapter.narrativeOrder,
    documentId: chapter.documentId,
    sentences: splitSentences(chapter.text ?? "").map((sentence) => ({ sentence, key: narrativeTextKey(sentence) })),
  }));
  return anchors.map((anchor) => {
    const anchorKey = narrativeTextKey(anchor.sentence);
    const scored: RecallSource[] = [];
    for (const chapter of chapterSentences) {
      for (const candidate of chapter.sentences) {
        if (!candidate.key) continue;
        const similarity = textBigramDice(anchorKey, candidate.key);
        if (similarity <= 0) continue;
        scored.push({ narrativeOrder: chapter.narrativeOrder, ...(chapter.documentId ? { documentId: chapter.documentId } : {}), sentence: candidate.sentence, similarity });
      }
    }
    scored.sort((left, right) => right.similarity - left.similarity || left.narrativeOrder - right.narrativeOrder);
    return { ...anchor, sources: scored.slice(0, policy.maxSources).map((source) => ({ ...source, similarity: Math.round(source.similarity * 100) / 100 })) };
  });
}

type RECALL_REPORT_POLICY_TYPE = typeof RECALL_REPORT_POLICY;
