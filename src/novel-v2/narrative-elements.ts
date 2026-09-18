import { createHash } from "node:crypto";

/**
 * 叙事元素（伏笔/承诺）内容键与去重纯函数。

 * 根因：recordNarrativeElements 曾以 `sha256(artifact.id + 描述)` 生成元素 ID，
 * 同一伏笔/承诺在每个新修订（新 artifact）被重新提取时都会生成新 ID 重复入库，
 * 导致开放伏笔账本膨胀并稀释后续弧规划对"哪些伏笔必须兑现"的判断。
 *
 * 修复分层：
 * - 写入层：ID 改为纯内容派生（规范化描述/陈述文本），同一内容跨修订复用同一行，
 *   由 ON CONFLICT 自然合并（首次埋设的 planted_revision_id / narrative_order 保留）。
 * - 读取层：getOpenForeshadowingAndPromises 对存量重复行按规范化文本去重（保留最早），
 *   使历史数据无需迁移即可让所有消费方（记忆注入、弧规划 prompt）看到干净账本。
 *
 * 边界（刻意不覆盖）：LLM 对同一观察的同义改写描述不参与机械去重（无法可靠判定），
 * 由弧规划阶段的事实梳理与人工审核处理，避免误合并语义不同的伏笔。
 * 标准化约定与 fact-extraction/dedupe.ts 的 evidenceFingerprint 保持一致。
 */

const NARRATIVE_TEXT_STRIP = /[\s\u3000。，！？；：、""''（）()\[\]【】《》〈〉·—…～]/gu;

/** 规范化叙事文本：去空白与常见标点，转小写。仅用于内容键，不用于展示。 */
export function narrativeTextKey(text: string): string {
  return (text ?? "").replace(NARRATIVE_TEXT_STRIP, "").toLowerCase();
}

/** 伏笔内容键：规范化描述的内容哈希（12 hex），不含来源 artifact/修订信息。 */
export function foreshadowingContentKey(description: string): string {
  return createHash("sha256").update(narrativeTextKey(description), "utf8").digest("hex").slice(0, 12);
}

/** 承诺内容键：规范化（承诺者+受诺者+陈述）的内容哈希（12 hex）。 */
export function promiseContentKey(promiser: string, promisee: string, statement: string): string {
  return createHash("sha256")
    .update([narrativeTextKey(promiser), narrativeTextKey(promisee), narrativeTextKey(statement)].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * 伏笔锚点身份（PL-5③，product-audit-20260910 B2）。
 *
 * 症状：description 内容键把"模型改写措辞"直接暴露为身份漂移——同一伏笔多轮重抽取
 * （修订重跑/补偿重试）产出近义不同文描述 → 新行 → 账本膨胀（运行库 138 条含跨章近同文簇）。
 * 机制：anchor 是承载伏笔的正文载体短词（实物/话语/异象名），跨轮改写语义下稳定，
 * 是比整句描述更合适的身份层。
 * 契约：同文档 + 规范化锚点 → 同一行；归并按"锚点稳定、细节累积"——
 * 描述/修订/窗口保留最早埋设，keywords 与可能兑现方向做有序并集，被吸收的改写
 * 描述进 mergedFrom 供审计回溯。
 * 边界：anchor 缺失（旧输出）或形态不像短词载体（超长文本）时退回内容键身份，宁保守不猜；
 * 跨文档的同锚点不合并（不同文档的载体词面相同不代表同一伏笔，误并=丢账，
 * 跨章近重复由 health duplicateClusters 可见性交人工裁决）。
 */
// TODO(magic-value): 30 为"载体短词 vs 句子"的形态分界经验位（与 narrative 呈现预算同阶），需语料校准。
const ANCHOR_MAX_LENGTH = 30;

/** 窗口原始形态：历史自由文本或 PL-5① 结构化对象。 */
export type PayoffWindowRaw = string | { scope?: unknown; count?: unknown; from?: unknown; to?: unknown; note?: unknown };

export interface ForeshadowingLedgerPayload {
  description: string;
  anchor?: string;
  triggerKeywords: string[];
  expectedPayoffWindow: PayoffWindowRaw;
  readerQuestion?: string;
  possiblePayoffs?: string[];
  meaningDelta?: string;
  cost?: string;
  evidence: string;
  artifactId?: string;
  mergedFrom?: string[];
}

/** 伏笔登记行身份：锚点键优先（document + normalized anchor），否则退回描述内容键。 */
export function foreshadowingLedgerId(projectId: string, documentId: string, item: Pick<ForeshadowingLedgerPayload, "description" | "anchor">): string {
  const anchor = narrativeTextKey(item.anchor ?? "");
  if (anchor && anchor.length <= ANCHOR_MAX_LENGTH) {
    const key = createHash("sha256").update(`${documentId}\u0000${anchor}`, "utf8").digest("hex").slice(0, 12);
    return `foreshadowing:${projectId}:anchor:${key}`;
  }
  return `foreshadowing:${projectId}:${foreshadowingContentKey(item.description)}`;
}

const MERGE_TEXT_FIELDS = ["readerQuestion", "meaningDelta", "cost"] as const;

/** 同身份归并：最早埋设信息保留，列表字段有序并集，被吸收描述进 mergedFrom。 */
export function mergeForeshadowingLedgerPayload(existing: ForeshadowingLedgerPayload, incoming: ForeshadowingLedgerPayload): ForeshadowingLedgerPayload {
  const union = (a?: string[] | null, b?: string[] | null): string[] => [...new Set([...(a ?? []), ...(b ?? [])])];
  const merged: ForeshadowingLedgerPayload = {
    ...existing,
    description: existing.description || incoming.description,
    anchor: existing.anchor || incoming.anchor,
    expectedPayoffWindow: existing.expectedPayoffWindow || incoming.expectedPayoffWindow,
    evidence: existing.evidence || incoming.evidence,
    triggerKeywords: union(existing.triggerKeywords, incoming.triggerKeywords),
    possiblePayoffs: union(existing.possiblePayoffs, incoming.possiblePayoffs),
  };
  for (const field of MERGE_TEXT_FIELDS) {
    if (!merged[field]) merged[field] = incoming[field] ?? merged[field];
  }
  const absorbed = [...(existing.mergedFrom ?? [])];
  for (const description of [incoming.description, ...((incoming.mergedFrom ?? []).filter((item) => !absorbed.includes(item) && item !== existing.description))]) {
    if (description && description !== existing.description && !absorbed.includes(description)) absorbed.push(description);
  }
  if (absorbed.length) merged.mergedFrom = absorbed;
  return merged;
}

/**
 * 读取层去重：按规范化文本保留首条（调用方已按叙事顺序排序，首条即最早埋设）。
 * 元素形状由调用方决定（伏笔/承诺结构不同），本函数只依赖 textOf 提取比较文本。
 * 规范化后为空的条目不参与合并（各自保留，交给上游校验处理）。
 */
export function dedupeByNarrativeText<T>(
  items: readonly T[],
  textOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    const key = narrativeTextKey(textOf(item));
    if (!key) {
      kept.push(item);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

/**
 * 伏笔兑现窗口解析（product-audit-20260910 B2/PL-5 修复①的读取面）。
 *
 * 账本历史窗口是自由文本（实测 24 种形态），health 无法判断超期。这里按**通用形态**
 * （数字+章单位、范围连接符、卷/书边界词、结构化对象）归一为 horizon；解析不出
 * horizon 的窗口归 unbounded/unknown——不猜。写侧 schema 结构化（{scope,from,to}）
 * 落地后，本函数是新旧两代数据的统一读入口。
 */
export interface PayoffWindow {
  /** chapter=明确章数/章序上界；volume/book=更大边界（horizon 未知但意图有界）；unbounded=长期；unknown=不可解析 */
  kind: "chapter" | "volume" | "book" | "unbounded" | "unknown";
  /** 绝对叙事序上界（仅 kind=chapter 且可换算时非空） */
  horizonOrder: number | null;
}

const WITHIN_CHAPTERS_PATTERN = /(\d+)\s*章\s*(?:之?内|以内|之内|内)/u;
const CHAPTER_RANGE_PATTERN = /第?\s*(\d+)\s*(?:[-–—~〜到至])\s*(?:第\s*)?(\d+)\s*章/u;
const CHAPTER_POINT_PATTERN = /第\s*(\d+)\s*章(?:末|底|之内|内)?/u;
const VOLUME_WORDS = ["本卷", "卷末", "卷底", "全卷", "该卷", "this volume"];
const BOOK_WORDS = ["全书", "长篇", "后期", "结局", "结尾", "终章", "大结局", "跨卷"];
const UNBOUNDED_WORDS = ["无", "不限", "任意", "待定", "未定", "optional"];

/**
 * 兑现窗口的显示形态（PL-5① 读侧）：结构化对象渲染为人类可读短句，历史自由文本透传。
 * prompt 注入与面板展示统一走本函数，避免 JSON 串直接混入创作上下文。
 */
export function formatPayoffWindow(raw: unknown): string {
  if (typeof raw === "string") return raw.trim() || "未指定";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as { scope?: unknown; count?: unknown; from?: unknown; to?: unknown; note?: unknown };
    if (typeof value.note === "string" && value.note.trim()) return value.note.trim();
    const count = typeof value.count === "number" ? value.count : null;
    const from = typeof value.from === "number" ? value.from : null;
    const to = typeof value.to === "number" ? value.to : null;
    if (to !== null && from !== null) return `第${from}-${to}章`;
    if (to !== null) return `第${to}章`;
    if (count !== null) return `${count}章内`;
    const scope = typeof value.scope === "string" ? value.scope : "";
    if (scope === "volume") return "本卷内";
    if (scope === "book") return "全书内";
    if (scope === "unbounded") return "未定窗口";
    return "未指定";
  }
  return "未指定";
}

export function parsePayoffWindow(raw: unknown, plantedOrder: number | null | undefined): PayoffWindow {
  // 结构化新形态（写侧 ① 的目标形状）：{scope, from?, to?, count?}
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    const to = typeof value.to === "number" ? value.to : null;
    const count = typeof value.count === "number" ? value.count : null;
    if (count !== null && plantedOrder != null) return { kind: "chapter", horizonOrder: plantedOrder + count };
    if (to !== null) return { kind: "chapter", horizonOrder: to };
    const scope = typeof value.scope === "string" ? value.scope.toLowerCase() : "";
    if (["volume", "arc"].includes(scope)) return { kind: "volume", horizonOrder: null };
    if (["book", "series"].includes(scope)) return { kind: "book", horizonOrder: null };
    if (["unbounded", "none"].includes(scope)) return { kind: "unbounded", horizonOrder: null };
    return { kind: "unknown", horizonOrder: null };
  }
  if (typeof raw !== "string" || !raw.trim()) return { kind: "unknown", horizonOrder: null };
  const text = raw.trim();
  const within = text.match(WITHIN_CHAPTERS_PATTERN);
  if (within && plantedOrder != null) return { kind: "chapter", horizonOrder: plantedOrder + Number(within[1]) };
  if (within) return { kind: "chapter", horizonOrder: null };
  const range = text.match(CHAPTER_RANGE_PATTERN);
  if (range) return { kind: "chapter", horizonOrder: Number(range[2]) };
  const point = text.match(CHAPTER_POINT_PATTERN);
  if (point) return { kind: "chapter", horizonOrder: Number(point[1]) };
  if (VOLUME_WORDS.some((word) => text.includes(word))) return { kind: "volume", horizonOrder: null };
  if (BOOK_WORDS.some((word) => text.includes(word))) return { kind: "book", horizonOrder: null };
  if (UNBOUNDED_WORDS.some((word) => text.includes(word))) return { kind: "unbounded", horizonOrder: null };
  return { kind: "unknown", horizonOrder: null };
}

/*
 * 已废弃：`assessHorizonCredibility`（2026-09-18 当日新增，同日证伪并移除）。
 *
 * 原假设：抽取 LLM 为填满必填字段而编造期限，故"note 为空且 count 落在取整档"即判可疑。
 * 对 717 条真实账本实测：**命中 0 条**——真实 payload 大多填了 note（如
 * `{"count":5,"note":"5章内"}`），note 是**复述数字**而非空缺，判据的前提不成立。
 *
 * 更关键的是，后续正文对照否定了整个"期限造假"命题：244 条 overdue 中
 * **238 条仍在活跃推进**（其 triggerKeywords 平均被后续 20+ 章提及，末 20 章
 * 仍有 71%~92% 被提及），只有 6 条真沉睡。所谓"到期"其实是「窗口上界已过而线索
 * 仍在跑」——`parsePayoffWindow` 把窗口上界 `to` 当作死线、丢弃下界 `from` 所致，
 * 属读侧语义问题，不是写侧造假。
 *
 * 真正的缺陷形态是"曾活跃→静默终止"，判据见 `narrative-dormancy.ts`。
 * 依据：docs/novel-v2/p1-foreshadowing-survey-20260918.md。
 */
