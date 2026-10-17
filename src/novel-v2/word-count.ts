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
 * 判据形态（校准记录见 docs/novel-v2/cross-chapter-quality-engineering-20260918.md §3.1）：
 * **「末段末句短促」这一结构信号在滑窗内的占比超阈值才告警**。
 *
 * 根因：原「末段字符二元组 Jaccard」判据属"字面仪器测语义病"——同族异形句
 * （如 `吹灯。` / `吹了灯。`）字面相似度为零，任何阈值命中数都为 0，无法发现目标缺陷。
 * 长度本身也不是病：实测"末段总长"类指标会把正常的短段落大量误报为仪式。
 * 真正的缺陷形态是**末句被压成短促断章**，故判据落在那一个结构特征上。
 *
 * - `window`：滑窗章数。取值 6 的依据是"惯性"的观测尺度——连续 6 章内的比例
 *   已足以区分"利落笔法"与"收尾惯性"；窗口过大（>10）会把全书的收束底色误判为仪式。
 * - `shortSentenceMax`：末段**末句**有效字数 ≤ 此值即命中「短促收尾」信号。
 * - `minRatio`：窗口内命中占比 ≥ 此值即告警。
 *
 * **为什么只用这一个信号**：同日对多个候选判据做过对照（以人工精修记录为 ground truth，
 * 对照表与命中区间见上述校准文档）。结论有两条可复用的形式：
 * ① 要求"整段就是一句"的合取判据召回过低——实测仪式主要以"多句铺陈 + 末句短促"表达；
 * ② "末段总长"类指标会把早期正文大量误报，精确率不达标。
 *
 * TODO: 三者均为首批语料校准值，应随语料进 output-policy 配置化（当前为显式常量，
 * 参数化入口已由 InspectManuscriptInput 预留，但尚未接线到配置层）。
 */
export const ENDING_RITUAL_POLICY = {
  window: 6,
  shortSentenceMax: 8,
  minRatio: 0.5,
} as const;

/**
 * 章长漂移与内容稀疏信号的计量口径（唯一事实源）。
 *
 * 住叶子纯模块的理由同 ENDING_RITUAL_POLICY：getStoryArcPlanningInput（仓储层）
 * 与 prompts 渲染两侧共用，workflow bundle 只允许无 node 依赖的纯导入链。
 *
 * 判据形态（校准记录见 docs/novel-v2/improvement-plan-20260922.md §2E，其中同时是
 * "局部漂移门被推翻"的取证）：
 * **章长只做描述性统计（近窗口均长 / 低于下限计数），不做正文结构门**。
 * - 退役考古：`manuscript.length` 已退役，长度约束由提交门 `length-under-target`
 *   （revision-policy.ts，对蓝图声明目标的 60% 兑现率）承担——"绝对字数"不是病，
 *   "对声明目标欠账"才是，新门不得与该语义竞争。
 * - 候选"局部漂移门"（单章 < sparseFloor 且 < 前 N 章均长 × 系数）被实测推翻：局部短章
 *   在任何位置都呈"大跌幅"且全书散布（含早期章），合取判据收不住；绝对下限同样散布。
 *   两者精确率都不达标。判据形态因此只做计数口径，不做门。
 * - `sparseFloor` 的定位因此只是 serial-signals 段的**计数口径**（多少章低于此线），
 *   配合"连续低量 + 蓝图延续低声明才报"的审核语义判断，不是逐章门。
 * - 取值依据：商业口径"连续 3 章合计不足 5000 字判内容稀疏"折算单章均值 ≈1667，
 *   取 1800 略偏保守（宁多提示不漏带）。该商业口径是**外部行业经验值**，与本书语料无关。
 *
 * TODO: 应随语料进 output-policy 配置化。
 */
export const LENGTH_DRIFT_POLICY = {
  window: 6,
  sparseFloor: 1800,
} as const;

/**
 * 篇幅欠量门的兑现率下限（唯一事实源）。
 *
 * 原为 `temporal/revision-policy.ts` 的局部常量。上移到本叶子模块的理由：项目级声明下限
 * 必须由"门按声明的百分之几执法"与"项目自身的稀疏线"两个既有常量推导，而
 * revision-policy 的导入链含 application/*（Temporal bundle 只允许无 node 依赖的纯导入链），
 * 比率留在那里，推导就只能写成注释里的魔数。
 *
 * 语义：正文有效字符数 < 声明目标 × 此比率 ⇒ 判 `length-under-target`（拦而不杀：
 * 作者通道仍可批准）。
 *
 * TODO 可配置意图：0.6 为连载章对声明目标的最小可接受兑现率，按题材/发布节奏可调。
 */
export const MIN_LENGTH_RATIO = 0.6;

/**
 * 蓝图声明目标的项目级下限（2026-10-13，docs/novel-v2/state-audit-20261013.md §7 第 4 项）。
 *
 * **不取经验值，由项目已有两个常量推导**：提交门按 `MIN_LENGTH_RATIO`(0.6) × 声明目标
 * 执法，而项目自身的内容稀疏线是 `LENGTH_DRIFT_POLICY.sparseFloor`(1800)。二者必须相容——
 * 否则"声明一个较低目标"会把门限压到项目自己的稀疏线之下，即**声明比不声明更宽松**：
 * 未声明章回落 `DEFAULT_TARGET_WORD_COUNT` ⇒ 门限 = 3500 × 0.6；声明 2400 ⇒ 门限 1440。
 * 根因即"同一目标三个数"（编排者手写声明值 / 写作契约播报回落值 / 门按声明值执法），
 * 存量数据形态与复算见 docs/novel-v2/state-audit-20261013.md §7 第 4 项。
 *
 * 故 `floor = ceil(sparseFloor / MIN_LENGTH_RATIO)` = 3000：声明目标不得低到让提交门的
 * 下限跌破项目自己的稀疏线。**推导只用两个既有常量，不引入任何语料实测值。**
 *
 * 边界（刻意不覆盖）：
 * - 这是**声明侧**判据，不是新的正文门——低于下限的声明由弧审核面按可执行意见退回
 *   （个别功能静章可在 planningRationale 声明理由），不与 `length-under-target` 竞争。
 * - schema 的结构下限仍为 500：结构性护栏与语义判断分层，不把审美阈值写成硬门。
 * - 未声明章不判低声明（回落系统默认值本身即项目标准）。
 *
 * TODO: 应随语料进 output-policy 配置化。
 */
export const LENGTH_DECLARATION_POLICY = {
  floor: Math.ceil(LENGTH_DRIFT_POLICY.sparseFloor / MIN_LENGTH_RATIO),
  /**
   * 批次级"系统性低声明"判据：已声明章中低于 `floor` 的占比 ≥ 此值即判系统性。
   * 取 0.5 的理由：单章低声明可能是功能性静章（schema 明示"安静章可低于推进章"），
   * 只有**过半**才说明蓝图整体在下调标准；未过半时逐章仍有 planningRationale 可依。
   * TODO: 应随语料进 output-policy 配置化。
   */
  systematicRatio: 0.5,
} as const;

/** 单章声明侧篇幅信号的输入形态（结构化，避免叶子模块依赖 story-arc 类型）。 */
export interface LengthDeclarationInput {
  /** 章序，用于在审核意见里指认章节。 */
  index: number;
  targetWordCount?: number;
}

/** 批次声明侧篇幅信号（确定性统计，供蓝图生成契约与弧审核面共用）。 */
export interface LengthDeclarationReport {
  /** 批内章数。 */
  total: number;
  /** 声明值 ≥ 项目下限的章序。 */
  anchored: number[];
  /** 声明值低于项目下限的章序。 */
  underDeclared: number[];
  /** 未声明目标的章序（回落系统默认，不判低声明）。 */
  undeclared: number[];
  /** 已声明章的声明均值；无声明时为 undefined。 */
  averageDeclared: number | undefined;
  /** 项目级下限（= LENGTH_DECLARATION_POLICY.floor）。 */
  floor: number;
  /** 是否构成"系统性低声明"（已声明章中 underDeclared 占比 ≥ systematicRatio）。 */
  systematic: boolean;
}

/**
 * 统计一批章蓝图的声明侧篇幅信号（确定性、零模型调用）。
 *
 * 与 `inspectStoryArcEnsemble` 同族：把"可推导事实"前移成显式信号，判断留给审核面——
 * "蓝图整体在下调标准"这件事逐章审查看不出来（每章都合法），只有批级占比能测到。
 */
export function inspectLengthDeclarations(chapters: readonly LengthDeclarationInput[]): LengthDeclarationReport {
  const anchored: number[] = [];
  const underDeclared: number[] = [];
  const undeclared: number[] = [];
  const declaredValues: number[] = [];
  for (const chapter of chapters) {
    const declared = chapter.targetWordCount;
    if (typeof declared !== "number" || !Number.isFinite(declared)) {
      undeclared.push(chapter.index);
      continue;
    }
    declaredValues.push(declared);
    if (declared < LENGTH_DECLARATION_POLICY.floor) underDeclared.push(chapter.index);
    else anchored.push(chapter.index);
  }
  return {
    total: chapters.length,
    anchored,
    underDeclared,
    undeclared,
    averageDeclared: declaredValues.length
      ? Math.round(declaredValues.reduce((sum, value) => sum + value, 0) / declaredValues.length)
      : undefined,
    floor: LENGTH_DECLARATION_POLICY.floor,
    systematic: declaredValues.length > 0
      && underDeclared.length / declaredValues.length >= LENGTH_DECLARATION_POLICY.systematicRatio,
  };
}

/**
 * 对白引号对（中文直角引号、中文双直角引号、中文全角双引号、半角双引号）。
 *
 * 只认成对包裹的引号：单侧引号（未闭合）不计入对白，避免把排版噪声算成台词。
 */
const DIALOGUE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ['"', '"'],
];

/**
 * 正文对白字符数：引号对内、引号本身不计的 `\p{L}\p{N}` 字符数。
 *
 * 与 `countNovelCharacters` 同一字符口径，因此"对白字占比 = countDialogueCharacters / countNovelCharacters"
 * 是一个可跨章、跨题材比较的纯结构量，不含任何词表或题材假设。
 *
 * 跨对嵌套（如 `「他说『好』」`）会同时命中「」与『』两对，故先收集所有成对区间再**合并重叠区间**，
 * 同一字符最多计一次。逐对累加会把内层内容算两遍——该形态在正文里真实存在，会让密度虚高。
 * 未闭合的引号不构成区间（不猜边界）。
 */
export function countDialogueCharacters(text: string): number {
  const spans: Array<[number, number]> = [];
  for (const [open, close] of DIALOGUE_QUOTE_PAIRS) {
    let index = 0;
    while (index < text.length) {
      const start = text.indexOf(open, index);
      if (start < 0) break;
      const end = text.indexOf(close, start + open.length);
      if (end < 0) break;
      spans.push([start + open.length, end]);
      index = end + close.length;
    }
  }
  if (!spans.length) return 0;
  spans.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let total = 0;
  let coveredUntil = -1;
  for (const [start, end] of spans) {
    const from = Math.max(start, coveredUntil);
    if (end <= from) continue;
    total += countNovelCharacters(text.slice(from, end));
    coveredUntil = end;
  }
  return total;
}

/**
 * 正文对白密度漂移信号（2026-10-13，docs/novel-v2/state-audit-20261013.md §7 第 5 项）。
 *
 * 判据形态与 `LENGTH_DRIFT_POLICY` 完全同型：**近窗口定稿章只做描述性统计，不做正文门**。
 * 为什么需要这条信号：上游（蓝图层）的 `soloOnlyOrders` / `longestSoloRun` 只能看见
 * "蓝图参与者数"，看不见"正文实际对白"——生成面与审核面都看不到产出正在把对手戏
 * 挤出正文。**该维度在引入本信号前没有任何通道测量**（结构通道里与引号相关的只有
 * 码位级的半角直引号配对检查，不是密度）。
 * 存量实测口径与崩落幅度见 docs/novel-v2/state-audit-20261013.md §7 第 5 项。
 *
 * 刻意不覆盖：不设绝对密度下限、不做逐章门、不引入"应有对白"的题材假设。安静章、
 * 余波章、内省章以低对白成立是合法形态（skills/novel-v2/reader-emotion.yaml 明示
 * "不要为了制造追更感机械添加危险、反转、悬念问句或情绪宣言"），故只呈现窗口统计与
 * "零对白章"清单（结构事实），判断留给弧审核面。
 *
 * window 与 `LENGTH_DRIFT_POLICY.window` 取同值：两者都是"近若干章"的连载窗口概念，
 * 该跨度约等于一个弧内跨度，足够看出趋势又不至于把单个功能章当漂移。
 *
 * TODO: 应随语料进 output-policy 配置化。
 */
export const DIALOGUE_DRIFT_POLICY = {
  window: LENGTH_DRIFT_POLICY.window,
  /** 少于该章数不产出信号（样本不足以判断趋势，与 lengthDrift 的 >= 3 同口径）。 */
  minWindow: 3,
  /**
   * 触发"对白密度提示"渲染的窗口均对白字占比下限。
   *
   * 取 0.01（1%）的理由：`silentOrders.length >= 2` 只覆盖"整章零对白"这一档，
   * 而"每章都有一两句、整体几乎为零"落在 0 与零对白之间——这个区间是真实存在的，
   * 换任何比例判据（占比过线、均值过线）都仍然是阈值，故直接用一个显式常量，
   * 不藏在字面量里。
   *
   * **这不是门**：不拦停、不逐章判、不决定 revise。它只决定"是否多说一句提示"——
   * 安静章/余波章/内省章以低对白成立是合法形态（reader-emotion.yaml 明示），
   * 故无论是否触发提示，都不因此判定任何一章有问题。
   *
   * TODO: 应随语料进 output-policy 配置化。
   */
  hintBelowRatio: 0.01,
  /**
   * "衰减"判据：近半窗均值低于首半窗的这个比例，即读作对手戏在**相对退场**。
   *
   * 为什么需要相对判据（state-audit-20261013.md §7 第 5 项的存量实测）：绝对均值
   * 看不见全书最严重的病灶。该书首段均值 6.78%、061-080 段 0.67%，**崩落约 10×**；
   * 而一个自始至终就低对白运行的安静型作品，绝对均值同样低，两者性质完全不同——
   * 前者是把已经交付过的东西收走，后者是题材形态。绝对阈值无法区分二者，
   * 相对衰减可以：它判的是"本书自己退了多少"，与任何外部基准无关。
   *
   * 取 0.5（近半窗不足首半窗一半）的理由：分段数据里 041-160 各段相对 001-020 的
   * 比值分布在 0.10-0.57，取 0.5 恰好只圈住"衰减过半"的区段，不圈住波动。
   *
   * 这仍是**描述性信号**而非门：不拦停、不判 revise、不逐章执法，只让弧审核面
   * 看见"退场"这件事。安静型作品（首半窗本就低）不会命中，因为分母同样小。
   *
   * TODO: 应随语料进 output-policy 配置化。
   */
  decayBelowRatio: 0.5,
} as const;

/** 单章对白密度信号的输入形态（结构化，避免叶子模块依赖 story-arc 类型）。 */
export interface DialogueDriftInput {
  /** 章序，用于在信号里指认章节。 */
  order: number;
  /** 该章有效字符数（`countNovelCharacters`）。 */
  characters: number;
  /** 该章引号内有效字符数（`countDialogueCharacters`）。 */
  dialogueCharacters: number;
}

/** 近窗口对白密度信号（确定性统计，供弧规划面与弧审核面共用）。 */
export interface DialogueDriftReport {
  /** 窗口内可测章数。 */
  windowSize: number;
  /** 窗口均对白字占比（0..1，按章等权平均）。 */
  avgRatio: number;
  /** 触发"密度提示"的均占比下限（`DIALOGUE_DRIFT_POLICY.hintBelowRatio`）——渲染给调用方引用，避免各处重写字面量。 */
  hintBelowRatio: number;
  /** 窗口内对白字为 0 的章序（升序）——结构事实，无审美阈值。 */
  silentOrders: number[];
  /** 窗口内最低对白字占比。 */
  minRatio: number;
  /**
   * 相对衰减读数：近半窗均值 / 首半窗均值。
   *
   * 与 `avgRatio` 互补——`avgRatio` 是绝对水平（会被安静的题材形态永久压低），
   * `decayRatio` 是**跟自己比**的退场程度。窗口可均分时为两半窗之比；不可均分   * （奇数章）时首半窗少一章（floor），即"越早的样本代表越长的观察期"。
   *
   * 两半窗任一的全体成员对白字皆为 0 时记 `undefined`（0/0 无意义：那类书
   * 从头到尾没有对白，属题材形态而非衰减），渲染侧据此不渲染该读数。
   *
   * 精确边界：只有**首半窗**为 0 才记 undefined（分母为 0，无从谈比值）。
   * 后半窗为 0 是有判据意义的读数——那正是"彻底退场"，比值记 0 且判衰减。
   */
  decayRatio?: number;
  /** 是否命中衰减判据（近半窗 < 首半窗 × `DIALOGUE_DRIFT_POLICY.decayBelowRatio`）。有界退化无此读数为 false。 */
  decayed: boolean;
}

/**
 * 统计近窗口的对白密度信号（确定性、零模型调用）。
 *
 * 有效字为 0 的章（空章/读取异常）不进分母，避免把缺失算成 0% 对白。
 * 窗口内可测章数不足 `minWindow` 时返回 undefined（宁缺勿伪）。
 */
export function inspectDialogueDrift(chapters: readonly DialogueDriftInput[]): DialogueDriftReport | undefined {
  const measured = chapters
    .filter((chapter) => Number.isFinite(chapter.characters) && chapter.characters > 0)
    .sort((left, right) => left.order - right.order);
  if (measured.length < DIALOGUE_DRIFT_POLICY.minWindow) return undefined;
  const ratios = measured.map((chapter) => chapter.dialogueCharacters / chapter.characters);
  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

  /**
   * 两半窗均值。先按章序切开再各自取均值（不是先算全书均值再切）——"首半窗均值"
   * 要回答的是"这本书开头交付了多少对白"，按章序分组才对得上这个语义。
   */
  const splitAt = Math.floor(measured.length / 2);
  const earlyRatios = ratios.slice(0, splitAt);
  const recentRatios = ratios.slice(splitAt);
  const earlyMean = mean(earlyRatios);
  const recentMean = mean(recentRatios);
  /**
   * 只有**分母为 0**（首半窗全体零对白）时比值无意义——那类作品从头到尾没有对白，
   * 属题材形态而非衰减，无从谈"退了多少"。
   *
   * 后半窗为 0 不在此列：那正是"彻底退场"，比值 0 且判衰减，是有判据意义的读数。
   * （首版把两侧皆零都排除，实测把"前半有对白、后半归零"这一最纯粹的退场形态也一起
   * 排除了，属误伤。）
   */
  const allEarlyZero = earlyRatios.every((ratio) => ratio <= 0);
  const decayRatio = allEarlyZero ? undefined : recentMean / earlyMean;

  return {
    windowSize: measured.length,
    avgRatio: mean(ratios),
    hintBelowRatio: DIALOGUE_DRIFT_POLICY.hintBelowRatio,
    silentOrders: measured.filter((chapter) => chapter.dialogueCharacters <= 0).map((chapter) => chapter.order),
    minRatio: ratios.reduce((min, ratio) => Math.min(min, ratio), Number.MAX_SAFE_INTEGER),
    decayRatio,
    decayed: decayRatio !== undefined && recentMean < earlyMean * DIALOGUE_DRIFT_POLICY.decayBelowRatio,
  };
}

/**
 * 上游蓝图独处 × 下游正文零对白的交集章（2026-10-17，state-audit §7 第 5 项的闭环缺口）。
 *
 * **这是本模块里唯一把两个信号接起来的判据**，补的正是那条"没有回读"的缝：
 * 弧审核面此前同时拿到 `ensembleSignal`（蓝图参与者数，上游）与 `dialogueDrift`
 * （正文对白，下游），但两者各报各的——审阅者要自己把两份清单在心里求交集。
 * 交集才是病灶的真形：**蓝图就写成单人节目单，正文又真的零对白**，即上游计划
 * 与下游产出相互印证，而不是"安静型作品本就如此"。
 *
 * 判据是**可数事实的交集**，不含任何语义判定：
 *  - 上游侧取"全部场景参与者 ≤1"的章（`soloOnlyChapterIndexes` 已是结构事实）；
 *  - 下游侧取"正文对白字为 0"的章（`silentOrders` 同理）。
 * 两者取交，按章序升序返回。任一侧缺信号（undefined）即返回空数组——
 * 缺一侧时既不能断言交集存在、也不能断言不存在，**宁缺勿伪**。
 *
 * 刻意不覆盖：不判"是否该加对白"（那是题材/审美判断，两版语义判据已在
 * `inspectStoryArcEnsemble` 注释里被实测推翻）；不设配额；只呈现交集章清单，
 * 判断留给弧审核面。因此这里不引入 `soloOnly`/`silent` 之外的任何条件。
 */
export function intersectSoloSilentOrders(
  ensemble: { soloOnlyChapterIndexes?: readonly number[] } | undefined,
  dialogue: { silentOrders?: readonly number[] } | undefined,
): number[] {
  const solo = ensemble?.soloOnlyChapterIndexes;
  const silent = dialogue?.silentOrders;
  if (!solo?.length || !silent?.length) return [];
  const silentSet = new Set(silent);
  return [...new Set(solo)].filter((order) => silentSet.has(order)).sort((left, right) => left - right);
}
