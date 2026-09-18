/**
 * POV 同类残留启发式扫描（2026-09-08，hints 级——不阻断）。
 *
 * 实证根因（ch6 POV 修复）：targeted 修订按窗口只改登记段落，同类违例在窗口外
 * 存活（『那感觉，像一头……疯狗』），直到下一轮人工审核才被发现。本扫描在修订
 * commit 后按「非视角人物名 + 内心动词」同句共现列出候选清单，供编辑者把同类
 * 位置一次登记完（与"同机制多处必须用 revisionRanges 一次覆盖"的审核纪律配套）。
 *
 * 边界（泛化红线）：
 * - 内心动词表是功能词表（汉语常用内心动词），不嵌题材词、角色名或特定短语；
 * - 共现不等于违例（视角人物本人可观察他人表情），只列候选供复核，不设硬门；
 * - 视角人物名由调用方传入（blueprint/chapters 的 povCharacterId 或人物表），
 *   本模块不推断谁是谁。
 */

/** 汉语常用内心/情绪动词（功能词表）。 */
const INTERIORITY_MARKERS = ["不悦", "心中", "心里", "暗想", "暗惊", "惊疑", "忌惮", "贪婪", "气焰", "觉得", "感到", "意识到", "心中暗", "心里想", "心中一", "暗自", "心底"];

export interface PovResidualHit {
  /** 段落序号（非空行序，1-based）。 */
  paragraph: number;
  /** 命中的内心标记词。 */
  marker: string;
  /** 非视角人物名。 */
  character: string;
  /** 命中句（截断）。 */
  excerpt: string;
}

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[。！？…])/u).map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * 扫描正文中「非视角人物名 + 内心标记词」同句共现的候选位置。
 * @param text 全章正文
 * @param povCharacterIds 视角人物名集合（这些人物出现的内心描写是合法的）
 * @param otherCharacterNames 其他在场人物名集合（来自人物表/蓝图参与者）
 */
export function scanPovResiduals(text: string, povCharacterIds: readonly string[], otherCharacterNames: readonly string[]): PovResidualHit[] {
  const pov = new Set(povCharacterIds.filter(Boolean));
  const others = otherCharacterNames.filter((name) => name && !pov.has(name));
  if (!others.length) return [];
  const hits: PovResidualHit[] = [];
  const paragraphs = text.split(/\n+/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of splitSentences(paragraph)) {
      for (const character of others) {
        if (!sentence.includes(character)) continue;
        const marker = INTERIORITY_MARKERS.find((candidate) => sentence.includes(candidate));
        if (marker && !pov.has(character)) {
          hits.push({ paragraph: paragraphIndex + 1, marker, character, excerpt: sentence.slice(0, 120) });
        }
      }
    }
  });
  return hits;
}
