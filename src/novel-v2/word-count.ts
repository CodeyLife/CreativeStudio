/**
 * Count visible textual characters in a manuscript.
 *
 * Letters and numbers from every Unicode script count as characters. Punctuation,
 * whitespace, emoji, formatting controls, and other symbols do not.
 */
export function countNovelCharacters(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/**
 * 单章建议性目标篇幅（字符数）的唯一事实源。
 *
 * 住叶子纯模块的原因（弧8 提交即炸 worker 的实证）：Temporal workflow bundle 经
 * webpack 编译，只允许无 node 依赖的纯导入链——常量原住 prompts/chapter-planning-context
 * （值导入链经 application/story-arc 触发不兼容模块），workflows.ts 从那里取用后
 * worker 构建失败、task queue 停摆。draft prompt 与篇幅欠量 commit 门两侧各自导入本模块。
 */
export const DEFAULT_TARGET_WORD_COUNT = 3500;

/**
 * 章蓝图 `targetWordCount` 的量纲判据（唯一事实源）。
 *
 * 此前同一判据在三处各自内联（`chapterBlueprintFromRow`、`parseStoryArcBundle`、
 * `getChapterTargetWordCount`）：正整数 ∧ 有限 ∧ >0 ∧ Math.round。复制三份的后果不是
 * 风格问题——任何一处放宽（例如把 `> 0` 写成 `>= 0`）只会让**那一条路径**读到脏目标，
 * 而"蓝图声明的目标 → 写作契约播报 → 提交门执法"是三跳链路，中间任一跳判据不同，
 * 门拦的就是模型没见过的标准（09-17 的"同一目标三个数"即该形态的前一次现形）。
 *
 * 住 leaf 模块的理由同 `DEFAULT_TARGET_WORD_COUNT`：规划解析轨（application/story-arc）
 * 在 Temporal bundle 的导入链上，不能为一个大仓储文件把 node:crypto 拖进来。
 */
export function normalizeTargetWordCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/**
 * 有效目标篇幅：门与写作契约共用的那一个数（蓝图声明优先，缺省回落系统默认）。
 *
 * 单源的理由：draft prompt 对模型播报的就是这个数，而篇幅欠量门按它的 60% 执法。两侧
 * 各自写 `?? DEFAULT_TARGET_WORD_COUNT` 时，"回落值"与"播报值"是两处裁量，改一处即分裂。
 */
export function effectiveTargetWordCount(declared: number | undefined): number {
  return declared ?? DEFAULT_TARGET_WORD_COUNT;
}

/**
 * 章末仪式化判据（manuscript.ending-ritual）的跨章校准值，唯一事实源。
 *
 * 住叶子纯模块的理由同 DEFAULT_TARGET_WORD_COUNT：workflows.ts 需要引用窗口值
 * 去调 loadPriorChapterEndings，而 workflow bundle 只允许无 node 依赖的纯导入链。
 *
 * 判据形态（2026-09-18 用 168 章实测校准，见 docs/novel-v2/cross-chapter-quality-engineering-20260918.md §3.1）：
 * **「末段末句短促」这一结构信号在滑窗内的占比超阈值才告警**。
 * 原「末段字符二元组 Jaccard」判据已废弃——实测全书两两最高相似度仅 0.294，
 * 任何阈值命中数都为 0（同族异形句如 `吹灯。`/`吹了灯。` 相似度为 0.000），
 * 属"字面仪器测语义病"，无法发现目标缺陷。
 *
 * - `window`：滑窗章数。取值 6 的依据是"惯性"的观测尺度——连续 6 章内的比例
 *   已足以区分"利落笔法"与"收尾惯性"；窗口过大（>10）会把全书的收束底色误判为仪式。
 * - `shortSentenceMax`：末段**末句**有效字数 ≤ 此值即命中「短促收尾」信号。
 * - `minRatio`：窗口内命中占比 ≥ 此值即告警。
 *
 * **为什么只用这一个信号**（同日对 6 个候选判据做了对照，以人工 12 批次精修记录为 ground truth）：
 * | 候选 | 精确率 | 召回率 | F1 | 前 45 章误报 |
 * |---|---|---|---|---|
 * | **末句≤8 占比 ≥0.5（采用）** | **1.00** | **0.58** | **0.73** | **0** |
 * | 末句≤8 且句数≤2 | 1.00 | 0.20 | 0.33 | 0 |
 * | 末段整段≤20 字占比 | 0.24 | 0.20 | 0.21 | 18 |
 * | 末段≤20 字占比 ≥0.5 | 0.24 | 0.20 | 0.21 | 18 |
 * 曾设计的"两信号合取"（短句 ∧ 动作句断章）召回仅 0.20——实测仪式主要以
 * "多句铺陈 + 末句短促"表达，要求整段就是一句会漏掉大多数情况。
 * 而"末段总长"类指标精确率仅 0.24，且会把用户认可的早期正文大量误报（18 章）——
 * 长度本身不是病，**末句被压成短促断章**才是。
 *
 * 168 章实测：命中 38/168（23%），**前 45 章零命中**；窗口命中区间
 * `053-055 / 070-092 / 113-118 / 131-136 / 166-168` 与逐章精修人工标记逐一吻合。
 * 段落边缘章（如 048-052）不命中是窗口判据的固有行为——它在一段口癖的**内部**触发，
 * 而非在蔓延的第一章触发。
 *
 * TODO: 三者均为首批语料校准值，应随语料进 output-policy 配置化（当前为显式常量，
 * 参数化入口已由 InspectManuscriptInput 预留，但尚未接线到配置层）。
 */
export const ENDING_RITUAL_POLICY = {
  window: 6,
  shortSentenceMax: 8,
  minRatio: 0.5,
} as const;
