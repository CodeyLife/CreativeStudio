/**
 * 资产/物品数量账本（确定性扫描，2026-09-08）。
 *
 * 实证根因（逐章顺序阅读）：主角持有的可数资产在各章间漂移——ch1 结尾怀里两块
 * 灵石，ch2 开头变"床角那块"（单数），ch11 期限要求三块时读者已无法从正文追踪
 * 存量；云纹草 ch13 交出一株、ch14 回述两株。审校上下文没有资产数量对照输入，
 * reviewer 靠记忆无法追踪这类跨章账本。
 *
 * 机制：确定性正则扫描（数字词+量词+名词），零模型调用；按章分组后投影进
 * 序列证据，供 draft/review/revision 对照"同一实体在各章的数量是否连续一致
 * （获得/消耗是否有交代）"。
 *
 * 边界（刻意不覆盖）：
 * - 量词后带修饰/后续谓语时名词捕获可能吞尾字（如"两块灵石装在袋里"捕获"灵石装"），
 *   分组键为尾 2 字会与裸名词形态（"灵石"）不归并——账本以裸名词提及为主，
 *   该局限在 hints 级投影下可接受（TODO P2: 接入分词提升精度）；
 * - 只做"提及登记"不做"状态解算"——正文说"三块"就登记三块，不推理存量加减；
 *   一致性判断由 reviewer 依对照指令作出；
 * - 名词边界无分词，量词后捕获可能带修饰语或吞尾字，按中心语后置取尾 2 字归并、
 *   展示取组内最短形态（TODO P2: 接入中文分词可提升精度）；
 * - 泛化红线：量词表是功能词表（汉语常用量词），停用词表是身份泛称（弟子/人），
 *   不嵌入题材词、角色名或特定物品名。
 */

/** 汉语数字词 → 数值（用于排序与漂移比对；"几/些"等模糊量保持原样）。 */
const NUMERALS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };

/** 常用汉语量词（功能词表；覆盖常见可数资产，未收录量词不参与登记）。 */
const MEASURE_WORDS = "块株颗根枚张瓶包把条片粒卷页滴缕丝份座间位名盏碗只台扇";

/** 身份泛称停用词（人物类名词是关系账本的对象，不是资产账本的对象）。 */
const SUBJECT_STOPLIST = new Set(["弟子", "人", "跟班", "路人", "同门", "师傅", "师叔", "师兄", "师弟", "杂役", "修士"]);

const ASSET_PATTERN = new RegExp(
  `([一两二三四五六七八九十半几那这\\d]+)([${MEASURE_WORDS}])((?:[\\u4e00-\\u9fa5]{0,4}的)?[\\u4e00-\\u9fa5]{1,4})`,
  "gu",
);

/** 名词捕获可能吞进下一个数量段（如"灵石一本"）或尾部虚词（如"灵石已经"），修剪之。 */
const TRAILING_FUNCTION_WORDS = /(已经|正在|就是|也是|还是|都是|和|与|或|被|把|了|着|在|是|有)+$/u;
const TRAILING_QUANTITY = /[一两二三四五六七八九十半几那这\d]+[块株颗根枚张瓶包把条片粒卷页滴缕丝份座间位名盏碗只台扇]+$/u;

export interface AssetMention {
  /** 实体名（量词后核心名词，含修饰时取"的"后段）。 */
  subject: string;
  /** 数量+量词的原文形态（如"两块""三块""几块""那块"）。 */
  quantity: string;
  /** 数值（模糊/回指量词为 null）。 */
  value: number | null;
}

export function extractAssetMentions(text: string): AssetMention[] {
  const mentions: AssetMention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ASSET_PATTERN)) {
    const [, numeral, measure, captured] = match;
    const noun0 = captured.includes("的") ? captured.split("的").pop() ?? captured : captured;
    const trimmed = noun0.replace(TRAILING_QUANTITY, "").replace(TRAILING_FUNCTION_WORDS, "");
    const subject = trimmed || noun0;
    if (SUBJECT_STOPLIST.has(subject)) continue;
    const key = `${match.index}:${subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const numeric = [...numeral].reduce((sum, character) => sum + (NUMERALS[character] ?? 0), 0);
    mentions.push({ subject, quantity: `${numeral}${measure}`, value: numeric > 0 ? numeric : null });
  }
  return mentions;
}

/** 实体数量跨度：同一实体在 ≥2 章被提及数量 → 漂移对照信号。 */
export interface AssetEntitySpan {
  subject: string;
  entries: Array<{ narrativeOrder: number; quantity: string; value: number | null }>;
  /** 组内最短实体形态（通常是裸名词），供渲染展示。 */
  display: string;
}

/**
 * 把各章的资产提及按实体分组，只保留出现在 ≥2 章的实体（单章提及无漂移对照价值，
 * 与 subjectSpans 的 HAVING ≥2 口径一致）。每章同一实体取首次提及。
 * 分组键取 subject 尾 2 字（汉语中心语后置：下品灵石→灵石），跨修饰形态归并同实体；
 * 展示形态取组内最短 subject（通常是裸名词）。
 */
export function groupAssetSpans(perChapter: Array<{ narrativeOrder: number; mentions: AssetMention[] }>): AssetEntitySpan[] {
  const bySubject = new Map<string, Array<{ narrativeOrder: number; quantity: string; value: number | null; display: string }>>();
  for (const { narrativeOrder, mentions } of perChapter) {
    const seenInChapter = new Set<string>();
    for (const mention of mentions) {
      if (seenInChapter.has(mention.subject)) continue;
      seenInChapter.add(mention.subject);
      const key = mention.subject.slice(-2);
      const entries = bySubject.get(key) ?? [];
      entries.push({ narrativeOrder, quantity: mention.quantity, value: mention.value, display: mention.subject });
      bySubject.set(key, entries);
    }
  }
  return [...bySubject.entries()]
    .filter(([, entries]) => entries.length >= 2)
    .sort((left, right) => right[1].length - left[1].length)
    .map(([key, entries]) => ({
      subject: key,
      entries: entries.map(({ narrativeOrder, quantity, value }) => ({ narrativeOrder, quantity, value })),
      display: entries.map((entry) => entry.display).reduce((shortest, current) => (current.length < shortest.length ? current : shortest)),
    }));
}
