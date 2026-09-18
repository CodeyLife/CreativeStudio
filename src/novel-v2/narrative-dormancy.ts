/**
 * 线索静默账本（确定性扫描，P1 2026-09-18）。
 *
 * 实证根因（168 章账本 + 正文对照，见 docs/novel-v2/p1-foreshadowing-survey-20260918.md）：
 * 账本 427 条 open 伏笔中，`overdue`（窗口上界已过）有 244 条，但把每条的
 * triggerKeywords 拿去 plant 章之后的正文里做提及扫描后，**238/244 条仍在活跃推进**
 * （平均被后续 20+ 章提及，末 20 章仍有 71%~92% 被提及）。也就是说：
 *
 *   `overdue` 度量的从来不是「该兑现没兑现」，而是「窗口上界已过而线索仍在跑」。
 *   对连载而言这是**正常且健康**的形态，不是债务。
 *
 * 真正的缺陷形态是另一个：**曾活跃、随后静默终止**。全书扫描得 66 条
 * （占 open 的 15%），且高度聚集于末次提及 ch120-159（53/66）——与人工逐章阅读
 * 独立发现的"齐姓人在 ch60 后再无戏份""树洞/蓝光在 ch34-42 后消失"完全吻合。
 *
 * 机制：确定性字符串包含扫描，零模型调用。逐条把 triggerKeywords 在 plant 之后的
 * 各章正文中查找，得到"提及章序序列"，据此分层为：
 *   never-mentioned（埋了就没再出现，抽取即孤儿）
 *   silent         （曾出现 → 近 N 章完全消失：读者被欠但无人管）
 *   running        （近期仍在推进：正常）
 *
 * 边界（刻意不覆盖）：
 * - 只做"提及登记"不做"语义兑现判定"——关键词出现不等于该伏笔被兑现，也可能只是
 *   擦边复述。兑现与否仍归 reviewer/规划面判断；本账本只回答"这条线还在不在场"。
 * - 关键词为空或全为 <2 字的条目无法扫描，归入 unmeasurable 计数（不猜）。
 * - 泛化红线：不做题材词表、不嵌入角色名或特定物品名；判据只用「(埋设序, 提及序序列)」
 *   这一结构 + 一个章数窗口。窗口值是魔法值，见下方 TODO。
 */

/** 静默判据的窗口参数（跨章校准值）。 */
export const DORMANCY_POLICY = {
  /**
   * 静默窗宽（章）：末次提及距当前章 ≥ 此值即判"静默"。
   * 取 20 的依据：168 章实测下，20 章≈全书的 12%，是读者对一条被埋线索
   * "还能想起来"的经验上限；窗口取 10 时静默数翻倍（把正常的中场歇线也计入），
   * 取 30 时只剩 40 余条（漏掉末期失线的中短线索）。
   * TODO(magic-value): 20 为首批语料校准值，应进连载健康度配置。
   */
  silentWindow: 20,
  /** 关键词最短长度：更短的多为虚词/单字，包含扫描误报率高，不参与登记。 */
  minKeywordLength: 2,
} as const;

/** 一条线索在正文中的在场轨迹。 */
export interface NarrativePresence {
  /** 埋设章序（缺失时为 null，无法扫描） */
  plantedOrder: number | null;
  /** 埋设之后曾提及该线索的章序（升序去重） */
  mentionOrders: number[];
  /** 末次提及章序（从未提及为 null） */
  lastMentionOrder: number | null;
  /** 距当前章的静默章数（从未提及或无法扫描为 null） */
  silentFor: number | null;
  status: "never-mentioned" | "silent" | "running" | "unmeasurable";
}

/**
 * 单条线索的在场状态判定。
 *
 * @param plantedOrder 埋设章序
 * @param keywords 该线索的触发关键词（空/过短则不可测）
 * @param chapterTexts 全书各章正文（无序，按 narrativeOrder 标注）
 * @param currentOrder 当前叙事序（= 最新定稿章）
 */
export function assessNarrativePresence(
  plantedOrder: number | null,
  keywords: readonly string[],
  chapterTexts: ReadonlyArray<{ narrativeOrder: number; text: string }>,
  currentOrder: number,
): NarrativePresence {
  const usable = keywords.filter((keyword) => typeof keyword === "string" && keyword.trim().length >= DORMANCY_POLICY.minKeywordLength);
  if (plantedOrder === null || usable.length === 0) {
    return { plantedOrder, mentionOrders: [], lastMentionOrder: null, silentFor: null, status: "unmeasurable" };
  }
  const mentionOrders: number[] = [];
  for (const chapter of chapterTexts) {
    if (chapter.narrativeOrder <= plantedOrder) continue;
    if (usable.some((keyword) => chapter.text.includes(keyword))) mentionOrders.push(chapter.narrativeOrder);
  }
  mentionOrders.sort((left, right) => left - right);
  if (!mentionOrders.length) {
    return { plantedOrder, mentionOrders, lastMentionOrder: null, silentFor: null, status: "never-mentioned" };
  }
  const lastMentionOrder = mentionOrders[mentionOrders.length - 1]!;
  const silentFor = currentOrder - lastMentionOrder;
  return {
    plantedOrder,
    mentionOrders,
    lastMentionOrder,
    // 负值（提及章晚于当前序）在数据正常时不会出现；保守归为 running，不制造假静默。
    silentFor,
    status: silentFor >= DORMANCY_POLICY.silentWindow ? "silent" : "running",
  };
}

/** 账本级静默汇总（供连载健康度与规划面注入）。 */
export interface DormancyLedgerEntry {
  id: string;
  description: string;
  plantedOrder: number | null;
  lastMentionOrder: number | null;
  silentFor: number | null;
}

export interface DormancyLedger {
  /** 参与扫描的 open 条目数（不含 unmeasurable） */
  measured: number;
  /** 埋设后从未被提及的条目数 */
  neverMentioned: DormancyLedgerEntry[];
  /** 曾活跃、现已静默的条目（按沉默章数降序） */
  silent: DormancyLedgerEntry[];
  /** 仍在推进的条目数 */
  running: number;
  /** 关键词缺失/过短、无法扫描的条目数 */
  unmeasurable: number;
  /**
   * 静默带：以 20 章为桶统计"末次提及章"的分布，用于识别**成片失线**
   * （某一段之后集中断线，比零散失线更可能是规划层的结构性遗漏）。
   */
  silentBands: Array<{ fromOrder: number; toOrder: number; count: number }>;
  currentOrder: number;
}

const BAND_WIDTH = 20; // TODO(magic-value): 静默带分桶宽度，应进连载健康度配置。

/**
 * 汇总整本账本的线索在场状态。
 * 只接受 open 条目（已兑现/已放弃的条目不参与"被欠"统计）。
 */
export function summarizeDormancy(
  items: ReadonlyArray<{ id: string; description: string; plantedOrder: number | null; keywords: readonly string[] }>,
  chapterTexts: ReadonlyArray<{ narrativeOrder: number; text: string }>,
  currentOrder: number,
): DormancyLedger {
  const neverMentioned: DormancyLedgerEntry[] = [];
  const silent: DormancyLedgerEntry[] = [];
  let running = 0;
  let unmeasurable = 0;

  for (const item of items) {
    const presence = assessNarrativePresence(item.plantedOrder, item.keywords, chapterTexts, currentOrder);
    const entry: DormancyLedgerEntry = {
      id: item.id,
      description: item.description.slice(0, 80),
      plantedOrder: presence.plantedOrder,
      lastMentionOrder: presence.lastMentionOrder,
      silentFor: presence.silentFor,
    };
    if (presence.status === "unmeasurable") unmeasurable += 1;
    else if (presence.status === "never-mentioned") neverMentioned.push(entry);
    else if (presence.status === "silent") silent.push(entry);
    else running += 1;
  }

  silent.sort((left, right) => (right.silentFor ?? 0) - (left.silentFor ?? 0));

  const bandCounts = new Map<number, number>();
  for (const entry of silent) {
    if (entry.lastMentionOrder === null) continue;
    const band = Math.floor(entry.lastMentionOrder / BAND_WIDTH) * BAND_WIDTH;
    bandCounts.set(band, (bandCounts.get(band) ?? 0) + 1);
  }
  const silentBands = [...bandCounts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([fromOrder, count]) => ({ fromOrder, toOrder: fromOrder + BAND_WIDTH - 1, count }));

  return {
    measured: items.length - unmeasurable,
    neverMentioned,
    silent,
    running,
    unmeasurable,
    silentBands,
    currentOrder,
  };
}
