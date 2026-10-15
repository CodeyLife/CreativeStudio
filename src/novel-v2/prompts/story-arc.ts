import { CHAPTER_NARRATIVE_FUNCTIONS, MAX_CHAPTER_HINTS, MAX_EXPECTED_CHAPTER_COUNT, inspectStoryArcEnsemble, storyArcAuthorityPaths, STORY_ARC_CONTEXT_SECTION_IDS, type StoryArcBundle, type StoryArcContextReceipt, type StoryArcPlotOutline, type StoryArcRebaseTarget } from "../application/story-arc";
import type { StoryArcReviewOutput } from "../application/story-arc-review-policy";
import { TEXT_REVIEW_PASSED_MARKER } from "../text-review";
import type { NarrativeStateSnapshot } from "../protocol";
// 线索静默账类型与窗口参数（叶子纯模块，无 node 依赖——workflow bundle 可安全引用）。
import { DORMANCY_POLICY, type DormancyLedger } from "../narrative-dormancy";
import { DEFAULT_TARGET_WORD_COUNT, LENGTH_DECLARATION_POLICY, LENGTH_DRIFT_POLICY, MIN_LENGTH_RATIO, inspectLengthDeclarations } from "../word-count";

export type { StoryArcReviewOutput } from "../application/story-arc-review-policy";

const sceneSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "participants", "situation", "observableActions", "planningRationale", "opposition", "decision", "outcome", "cost"],
  properties: {
    title: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    situation: { type: "string", minLength: 1 },
    observableActions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    planningRationale: { type: "string", description: "仅供规划器保存的分析理由；无分析理由时使用空字符串。正文、审校和修订执行合同不会消费该字段" },
    opposition: { type: "string" },
    decision: { type: "string" },
    outcome: { type: "string", minLength: 1 },
    cost: { type: "string" },
  },
} as const;

const storyArcPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "objective", "entryState", "centralConflict", "development", "resolution", "exitState", "threadResponsibilities", "foreshadowingRefs", "expectedChapterCount", "phases"],
  properties: {
    title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, entryState: { type: "string" }, centralConflict: { type: "string" },
    development: { type: "array", items: { type: "string" } }, resolution: { type: "string" }, exitState: { type: "string" },
    // PL-2 修复①（引用字段形态门）：形如 `kind:token` 的 id 后不得拖尾其他文本——
    // 历史上 "<threadId> <slug>" 复合串被逐轮复制放大成影子对象。中文登记名（无冒号
    // 前缀）不受影响；确需新建用显式 new:<名称>（new: 前缀后是名称不是 id，形态合法）。
    // 线程级伏笔认领（PL-5④ 判据收口，2026-09-19）：thread_id 是单值列，归属只能是声明；
    // 弧级 foreshadowingRefs 是扁平账而一条弧实测并行 4-7 条线，共现推断恒不可判定。
    // 该字段进 required 是原生结构化门的硬约束（assertNativeJsonSchema 要求对象
    // properties 全部出现在 required），"无人承担"以空数组表达；解析面仍按可选处理，
    // 旧弧与旧载荷零回归。
    threadResponsibilities: { type: "array", items: { type: "object", additionalProperties: false, required: ["threadRef", "responsibility", "nextAdvance", "foreshadowingRefs"], properties: { threadRef: { type: "string", minLength: 1, pattern: "^(?!\\S*:[\\w.-]+\\s)" }, responsibility: { type: "string", minLength: 1 }, nextAdvance: { type: "string", minLength: 1 }, foreshadowingRefs: { type: "array", items: { type: "string", pattern: "^(?!\\S*:[\\w.-]+\\s)" }, description: "本条线在本弧承担的伏笔引用，只能取 arc.foreshadowingRefs 中已出现的值；本条线不承担伏笔时给空数组" } } } },
    foreshadowingRefs: { type: "array", items: { type: "string", pattern: "^(?!\\S*:[\\w.-]+\\s)" } },
    expectedChapterCount: { type: "integer", minimum: 1, maximum: MAX_EXPECTED_CHAPTER_COUNT },
    // PL-6：阶段必须显式绑定弧内章节序号（1-based，覆盖本弧全部计划章节、互不重叠）——
    // 阶段归属是规划事实，系统不再按期望章数等分推算（期望≠实际时静默失真）。
    phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "objective", "chapterOrdinals"], properties: { title: { type: "string" }, objective: { type: "string" }, chapterOrdinals: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } } } } },
  },
} as const;

const storyArcBatchSchema = {
  type: "object", additionalProperties: false, required: ["batchIndex", "startChapterIndex", "complete"],
  properties: { batchIndex: { type: "integer", minimum: 1 }, startChapterIndex: { type: "integer", minimum: 1 }, complete: { type: "boolean" } },
} as const;

const storyArcChaptersSchema = {
  type: "array", minItems: 1, maxItems: MAX_CHAPTER_HINTS,
  items: {
    type: "object", additionalProperties: false,
    required: ["index", "title", "narrativeFunction", "povCharacterId", "targetWordCount", "stateTransition", "scenes", "continuityConstraints", "unresolvedAtClose"],
    properties: {
      index: { type: "integer", minimum: 1 },
      // 2026-10-13（docs/novel-v2/state-audit-20261013.md §7 第 4 项「章名退化」）：下限由 1 抬到 2，
      // 与项目自己的命名契约对齐——CHAPTER_TITLE_SCHEMA（application/chapter-title.ts:22）要求
      // minLength 2，normalizeChapterTitle（同文件 :66）对不足 2 字直接抛错。此前蓝图侧允许 1 字，
      // 于是同一条产物（manuscript_documents.title）有两条生产路径、两种结构下限：实测 168 章里
      // 有 2 章落成单字标题，而命名路径会直接拒绝这种输出。
      // 这是结构性对齐，不是文学阈值：二字仍是合法下限，辨识度由 chapter-naming skill 的
      // chapter.blueprint 段指引承担（本轮同步把该执行点接上），不在此处变成硬检查表。
      title: { type: "string", minLength: 2 },
      narrativeFunction: { enum: [...CHAPTER_NARRATIVE_FUNCTIONS, "unspecified"] }, povCharacterId: { type: "string" },
      // 2026-09-17 根因修复（docs/novel-v2/ai-taint-diagnosis-20260917.md F1/§四）：
      // 本字段此前**只存在于 TypeScript 类型**（ChapterBlueprint.targetWordCount），
      // 从未进入 schema。因为 additionalProperties:false 且不在 properties 里，规划模型
      // 在结构上**不可能**输出它——实测 chapter_planning_contexts 226 行全为空，
      // 与"制度补录"台账记载相反（补录写的是 chapters.payload，不是这里）。
      //
      // 后果是一条三方数字断裂（同一目标，三个数）：
      //   · 正文写作契约读 planningContext.chapter.targetWordCount，缺字段回落到
      //     DEFAULT_TARGET_WORD_COUNT = 3500，于是对模型说"本章目标篇幅约 3500 字"；
      //   · 编排者在 instruction 里手写"2600-3000，硬底线 2600"补偿；
      //   · 篇幅欠量门用 3500 × 0.6 = 2100 执法。
      // 写作端拿不到权威数字，才会被等量段配额代偿——这正是 F1"节拍器呼吸"的上游。
      // 补回字段后，规划者一次就把目标写进蓝图，三面同源。
      targetWordCount: { type: "integer", minimum: 500, maximum: 12000, description: "本章建议目标篇幅（可见字符数）。按本章的信息量与场景数给出，允许章间有差异；安静章可低于推进章。缺省时系统回落默认值" },
      stateTransition: { type: "object", additionalProperties: false, required: ["before", "after", "evidence"], properties: { before: { type: "string", minLength: 1 }, after: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 } } },
      scenes: { type: "array", minItems: 1, items: sceneSchema },
      continuityConstraints: { type: "array", items: { type: "string" } }, unresolvedAtClose: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export const storyArcPlanBatchSchema = {
  type: "object", additionalProperties: false, required: ["arc", "batch"],
  properties: { arc: storyArcPlanSchema, batch: storyArcBatchSchema },
} as const;

export const storyArcChaptersOutputSchema = {
  type: "object", additionalProperties: false, required: ["chapters"],
  properties: { chapters: storyArcChaptersSchema },
} as const;

export const storyArcBundleSchema = {
  type: "object", additionalProperties: false, required: ["arc", "batch", "chapters"],
  properties: { arc: storyArcPlanSchema, batch: storyArcBatchSchema, chapters: storyArcChaptersSchema },
} as const;

export type StoryArcPromptInput = {
  projectTitle: string;
  authorIntent?: string;
  macro: Array<{ taskKey: string; title: string; summary: string }>;
  recentChapters: Array<{ order: number; summary: string; unresolvedThreads: string[]; emotionalArc?: string }>;
  openThreads: Array<{ id: string; title: string; payload: Record<string, unknown> }>;
  openForeshadowings?: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string; plantedRevisionId: string }>;
  openPromises?: Array<{ id: string; promiser: string; promisee: string; statement: string; sourceRevisionId: string }>;
  /**
   * 未揭示作者秘密（PL-8③，product-audit-20260910 B3）：从 plot-design
   * informationBoundaries.hidden 规范对象（claim/未揭示窗口/载体）投影。规划侧据此把
   * "提前消费秘密"变成可检查的边界，审核侧据此核对候选弧是否泄漏尚未揭示的真相。
   * 只投影已对象化的秘密；散文式旧数据经别名迁移进入 claim，不发明新内容。
   */
  undisclosedSecrets?: Array<{ claim: string; revealWindow?: string; carrier?: string }>;
  planningFeedback?: Array<{ sourceChapterOrder?: number; targetId: string; underlyingMechanism: string; affectedInputClass: string; boundaries?: string; sourceArtifactId?: string }>;
  narrativeState?: NarrativeStateSnapshot;
  contextReceipt?: StoryArcContextReceipt;
  /** 外部剧情编排（模式 B）：由外部大模型/作者提供，规划器负责完善为规范蓝图 */
  plotOutline?: StoryArcPlotOutline;
  /**
   * 近 N 章连续同类功能游程（连续 ≥3 章同 narrativeFunction）。
   * 设计依据：AGENTS.md「问题要在机制层解决」——连续低行动/观察型章节密度的根因
   * 在规划批准了被动功能序列；把信号前移到 arc.plan 让规划器在分配 narrativeFunction
   * 时就能看到疲劳风险，主动轮换压力类型。只作描述性统计，不是短语黑名单。
   */
  serialFunctionRuns?: Array<{ narrativeFunction: string; narrativeOrders: number[] }>;
  /**
   * 人物登记表（2026-09-16 全书确诊的根因修复）：povCharacterId 出现四种漂移形态
   * （char_chu_heng/chu-heng/char_chu/char_hu_cheng）的直接原因是规划上下文从未给出
   * 合法 id 名册，模型只能幻觉；漂移让 POV 作用域的记忆召回与状态钉挂在部分章节
   * 静默失效。名册同时是群像素材的供给面——规划者看得见有谁可用，才会把人写进场。
   */
  cast?: Array<{ id: string; name: string }>;
  /**
   * 近窗口群像信号（确定性统计，serialFunctionRuns 同型）：全部场景参与者≤1 的章
   * 与最长独处游程。只呈现事实，配额判断走规划指引与审核契约，不做硬门。
   *
   * 注：第二意志（"人在场却无人交锋"）**没有**机器判据——两版正则实现都被实测
   * 推翻（见 application/story-arc.ts 的负结果记录）。它是语义判断，只在生成面
   * 以契约形式出现（本文件 buildStoryArcChaptersPrompt 与弧审核 prompt）。
   */
  ensembleSignal?: { soloOnlyOrders: number[]; longestSoloRun: number; windowSize: number };
  /**
   * 窗口上界已过的伏笔账（P1，2026-09-16 起，2026-09-18 修正语义）。
   *
   * 原名 overdue（超期），但实测 244 条"上界已过"中 238 条仍在活跃推进——对连载
   * 而言，长线伏笔的兑现窗口上界过期而线索仍在跑是**常态，不是债务**。旧语义把
   * 它报成欠账，指挥作者去处理 238 条不存在的问题。
   *
   * 故：`windowElapsedCount` = 窗口上界已过的可判定条目数（中性事实）；
   * agedOpen = 埋设久远但窗口不可判定的汇总数（不发明 deadline）。
   * 真正需要行动的"曾活跃→静默终止"由 dormancy 通道单独注入（见 narrativeDormancy）。
   */
  dueLedger?: { currentOrder: number; windowElapsedCount: number; agedOpenCount: number; items: Array<{ id: string; description: string; horizonOrder: number; plantedOrder: number | null }> };
  /**
   * 线索静默账（P1，2026-09-18）：曾活跃、现已静默的伏笔/线索。
   *
   * 这是"读者被欠但无人管"的真实形态——全书 427 条 open 中 66 条曾活跃后静默
   * （占 15%），且 53/66 集中在末次提及 ch120-159，与人工逐章阅读独立发现的
   * "齐姓人在 ch60 后再无戏份""树洞/蓝光在 ch34-42 后消失"吻合。
   * 规划面据此决定：续线、兑现、或显式放弃（而不是继续静默）。
   *
   * 直接复用 DormancyLedger（单一真源，不投影成平行结构——平行结构会各自漂移）；
   * silentWindow 由渲染侧从 DORMANCY_POLICY 取。
   */
  narrativeDormancy?: DormancyLedger;
  /**
   * 前若干章的开头首段（供起手轮换契约的 run 判据跨批生效）。
   *
   * 为什么需要（2026-10-14 复核轮 round 11/12 实测）：起手轮换契约的 run 判据
   * （"不得有连续三章以同一槽位序列起头"）此前只在本批次内生效，而生产批次是
   * 7 章一弧（弧6=35-42 / 弧7=43-49）——全书唯一的真实 run（ch41-43）恰好跨在
   * 弧6/弧7 边界上，两条批次限定判据都看不见它。**门一直在，对全书唯一的病灶失明。**
   *
   * 与 `ENDING_RITUAL_POLICY` 的 `priorEndings` 同形：跨章判据由调用方喂入前章语境。
   * 缺省（undefined/空）时契约退回批次内措辞，既有调用方零影响。
   */
  priorChapterOpenings?: string[];
  /**
   * 跨弧回报节奏（P5，2026-09-16 审核确诊"31 章结清 0 笔"的可见性落点）：近几弧
   * 定稿章数 vs 兑付笔数。密度是题材判断不设硬门；连续零兑付必须成为规划数字。
   */
  payoffRhythm?: Array<{ arcOrdinal: number; title: string | null; finalChapters: number; payoffCount: number }>;
  /**
   * 章长漂移/内容稀疏信号（2026-09-22 商业基准对照确诊）：近窗口定稿章的字数统计。
   * 只做描述性统计（判据校准与"不做结构门"的边界见 word-count.ts LENGTH_DRIFT_POLICY）；
   * "连续低量 + 蓝图延续低声明"的判断归审核面。
   */
  lengthDrift?: { windowSize: number; avgChars: number; sparseCount: number; minChars: number };
  /**
   * 正文对白密度信号（2026-10-13，state-audit-20261013.md §7 第 5 项，作者裁决选项 A）：
   * 近窗口定稿章的"引号内有效字 / 有效字"统计 + 零对白章清单。
   *
   * 补的是上游 `ensembleSignal` 的盲区——它只能看见蓝图参与者数，看不见正文实际对白。
   * 只做描述性统计（判据边界见 word-count.ts DIALOGUE_DRIFT_POLICY）；不设绝对下限、
   * 不做逐章门，判断归审核面。
   */
  dialogueDrift?: { windowSize: number; avgRatio: number; hintBelowRatio: number; silentOrders: number[]; minRatio: number };
};

/**
 * 渲染外部剧情编排为可注入的上下文文本。
 *
 * 设计依据：编排是设计意图基线，权威低于已定稿事实与叙事状态账本；
 * 渲染内容只陈述"外部想讲什么"，不把编排字段当作必须逐字兑现的清单。
 */
export function renderStoryArcPlotOutline(outline: StoryArcPlotOutline): string {
  const lines = [
    `objective：${outline.objective}`,
    outline.title ? `标题建议：${outline.title}` : "",
    outline.entryState ? `入口状态：${outline.entryState}` : "",
    outline.centralConflict ? `核心冲突：${outline.centralConflict}` : "",
    outline.development?.length ? `发展阶梯：${outline.development.map((item, index) => `${index + 1}. ${item}`).join("；")}` : "",
    outline.resolution ? `解决：${outline.resolution}` : "",
    outline.exitState ? `退出状态：${outline.exitState}` : "",
    outline.threadResponsibilities?.length ? `编排责任线：${outline.threadResponsibilities.map((item) => `${item.threadRef}：${item.responsibility}；下一次推进=${item.nextAdvance}${item.foreshadowingRefs?.length ? `；本弧承担伏笔=${item.foreshadowingRefs.join("、")}` : ""}`).join("\n")}` : "",
    outline.expectedChapterCount ? `期望章节数：${outline.expectedChapterCount}` : "",
    outline.phases?.length ? `阶段：${outline.phases.map((item) => `${item.title}（${item.objective}）`).join("；")}` : "",
    outline.chapterHints?.length ? `逐章提示：${outline.chapterHints.map((item, index) => `第${index + 1}章：${item}`).join("\n")}` : "",
    outline.plotNotes ? `编排说明：${outline.plotNotes}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** 人物登记表渲染（规划段与蓝图上下文共用，单一真源）。 */
export function renderStoryArcCast(cast: StoryArcPromptInput["cast"]): string {
  if (!cast?.length) return "";
  return `人物登记表（POV 与场景参与者的权威名册）：povCharacterId 只能填下列 id 的精确值（单独一个值，不附名称、不自造变体、不截短）；场景 participants 填显示名；确需新 named 群演用具体称谓（如『守夜的老杂役』）但不作为 POV。登记表为空时 povCharacterId 填精确值需先补登人物。\n${cast.map((item) => `- id: ${item.id}\n  显示名: ${item.name}`).join("\n")}`;
}

/** 群像信号渲染（描述性统计+契约说明，不做审美硬门）。 */
export function renderStoryArcEnsembleSignal(signal: StoryArcPromptInput["ensembleSignal"]): string {
  if (!signal || signal.windowSize < 3) return "";
  if (!signal.soloOnlyOrders.length) return `近 ${signal.windowSize} 章群像信号：全部章节都含两名及以上参与者的互动场景，无独处游程。`;
  return `近 ${signal.windowSize} 章群像信号（确定性统计）：${signal.soloOnlyOrders.length} 章的全部场景参与者≤1（第${signal.soloOnlyOrders.join("、")}章），最长连续独处游程 ${signal.longestSoloRun} 章。连续独处不等于问题，但逐拍内心节目单式编排会把对白与对手戏挤出正文预算（实证：独处蓝图批次产出的正文对白密度崩落）——本批次若再整体独处将延续该失败形态；分配章节时保持每批≥1/3 章有两名及以上参与者互相施加代价的场景（对方有欲望、行动改变处境，不是道具或背景板）；纯独处章每批至多一章，且在该场景 planningRationale 写明这章的静在与不在场的谁对话。安静章两人同场依然合法——静≠独。`;
}

/**
 * 章长漂移/内容稀疏信号渲染（描述性统计；判据边界见 word-count.ts LENGTH_DRIFT_POLICY）。
 *
 * 措辞纪律：不设字数硬门（`manuscript.length` 已退役，执法面是提交门对声明目标的
 * 兑现率）；提示只针对"连续低量"这一**批的形态**，单个功能静章不构成问题。
 */
export function renderStoryArcLengthDrift(drift: StoryArcPromptInput["lengthDrift"]): string {
  if (!drift || drift.windowSize < 3) return "";
  // 稀疏线取策略常量，不写字面量：判据（`sparseCount` 的计数）在仓储侧同一个常量上算，
  // 渲染侧若另抄一个 1800，改策略时只会改一边——读者看到的下限与真实计数口径分叉，
  // 而这类分叉不报错、只是悄悄说错话（AGENTS.md"量化指标失准"的同类）。
  const lines = [`近 ${drift.windowSize} 章篇幅信号（确定性统计）：均章 ${drift.avgChars} 字，最短 ${drift.minChars} 字${drift.sparseCount ? `，${drift.sparseCount} 章低于单章下限 ${LENGTH_DRIFT_POLICY.sparseFloor} 字` : "，无低于单章下限的章"}。`];
  if (drift.sparseCount >= 2) {
    lines.push("篇幅信号提示：近窗口出现连续低量章——逐章对声明目标达标不等于全书内容密度合格（'拆事件凑章数'会让每章都过门而读者看到的是碎片化）。本批次声明 targetWordCount 时回到各章信息量的诚实估计；除非个别章功能确需短章（planningRationale 声明），不得系统性延续低声明。");
  }
  return lines.join("\n");
}

/**
 * 正文对白密度信号渲染（描述性统计；判据边界见 word-count.ts DIALOGUE_DRIFT_POLICY）。
 *
 * 措辞纪律（与 reader-emotion 的"不要为了制造追更感机械添加情绪宣言"一致）：
 * 本信号**不是"补对白"指令**。它只把"正文里还有多少人在说话"这个此前完全不可见的
 * 事实摆到台面——上游群像配额管的是蓝图参与者数，管不到正文实际把对手戏写没写出来。
 * 因此提示只针对"整窗口对白稀薄"这一**批的形态**，并显式承认安静章/余波章以低对白
 * 成立；判断（哪一章该有对手戏）留给审核面与规划者。
 */
export function renderStoryArcDialogueDrift(drift: StoryArcPromptInput["dialogueDrift"]): string {
  if (!drift || drift.windowSize < 3) return "";
  const avg = `${(drift.avgRatio * 100).toFixed(2)}%`;
  const min = `${(drift.minRatio * 100).toFixed(2)}%`;
  const lines = [`近 ${drift.windowSize} 章正文对白密度（确定性统计）：均对白字占比 ${avg}（引号内有效字 / 有效字），最低 ${min}${drift.silentOrders.length ? `，其中 ${drift.silentOrders.length} 章全章没有任何含引号的段落（第${drift.silentOrders.join("、")}章）` : "，每章都有对白"}。`];
  if (drift.silentOrders.length >= 2 || drift.avgRatio < drift.hintBelowRatio) {
    lines.push("对白密度提示：对手戏是读者追读的主引擎，而本信号的度量面是**正文实际写出来的台词**——上游群像配额只约束蓝图参与者数，写不写得出交锋仍取决于本章的编排。近窗口对白稀薄时，逐章审查通常各自达标（每章都能自证其静），只有窗口统计能看出整批正在把对手戏挤出正文。分配章节时回到'这一章谁在向谁要东西'：让有欲望、有代价的第二意志进场并把代价落到对白上。安静章、余波章、内省章以低对白成立是合法形态（本信号不是补对白指令，不为凑密度加台词）。");
  }
  return lines.join("\n");
}

/**
 * 窗口上界已过的伏笔账渲染（规划段与蓝图上下文共用，单一真源；空账不注入）。
 *
 * 措辞纪律（2026-09-18 P1 修正）：**不说"超期/欠债"**。实测 244 条上界已过中
 * 238 条仍在活跃推进，长线伏笔越过自声明窗口上界而继续运行是连载常态。
 * 本账只陈述"窗口上界已过"这一事实并要求作者**显式决定窗口是否续期**，
 * 不再暗示这些线索都有兑现义务（那会指挥作者处理 238 条不存在的问题）。
 */
export function renderStoryArcDueLedger(ledger: StoryArcPromptInput["dueLedger"]): string {
  if (!ledger) return "";
  const lines = [
    `窗口上界已过的伏笔账（确定性账期统计，当前第 ${ledger.currentOrder} 章）：${ledger.windowElapsedCount} 条 open 伏笔的兑现窗口上界已过${ledger.agedOpenCount ? `；另有 ${ledger.agedOpenCount} 条埋设 40+ 章但窗口不可判定（需作者把窗口定为可判定形态或分流）` : ""}。`,
    "读法契约：窗口上界已过**不等于**欠债。长线伏笔越过自声明窗口而继续运行是连载常态（实测此类条目绝大多数仍在被正文持续推进）。本账要求的是**显式决定**：本弧确认继续持有的，在 threadResponsibilities 写明续期后的新窗口与触发条件；确认转入兑现的，安排进某章的场景因果与结果；确认不再承担的，经作者分流通道放弃。真正指示『读者被欠』的信号是静默账（下一段），不是本账。",
  ];
  if (ledger.items.length) lines.push(`窗口上界最早已过的清单（按上界升序，至多 12 条）：\n${ledger.items.map((item) => `- ${item.id}｜埋于第${item.plantedOrder ?? "?"}章｜窗口上界第${item.horizonOrder}章｜${item.description}`).join("\n")}`);
  return lines.join("\n");
}

/**
 * 线索静默账渲染（2026-09-18 P1）：曾活跃、现已静默的线索。
 * 这是"读者被欠但无人管"的规格化形态——全书 427 条 open 中 66 条属此，
 * 且 53/66 集中于末次提及 ch120-159（成片失线，更可能是规划层结构性遗漏）。
 */
export function renderStoryArcNarrativeDormancy(dormancy: StoryArcPromptInput["narrativeDormancy"]): string {
  if (!dormancy) return "";
  const silentCount = dormancy.silent.length;
  const neverCount = dormancy.neverMentioned.length;
  if (!silentCount && !neverCount) return "";
  const lines = [
    `线索静默账（确定性正文提及扫描，当前第 ${dormancy.currentOrder} 章；静默 = 末次提及距当前 ≥ ${DORMANCY_POLICY.silentWindow} 章）：${silentCount} 条线索**曾活跃、现已静默**${neverCount ? `；另有 ${neverCount} 条埋设后从未被正文再提及（抽取即孤儿，需核对是否误抽）` : ""}。对照：仍在推进 ${dormancy.running} 条。`,
    "处置契约：静默线索是本弧必须显式处理的账——读者已经投入过注意力，静默终止即未兑现的读者契约。三选一：本弧安排续线（给出让读者重新记起它的具体场景钩子）或兑现（进入场景因果与结果）；经作者分流通道放弃（分流落账，从此不再注入）；暂缓也必须在 threadResponsibilities 写明预定释放点与触发条件。",
  ];
  if (dormancy.silentBands.length) {
    lines.push(`静默带（按末次提及章分桶）：${dormancy.silentBands.map((band) => `第${band.fromOrder}-${band.toOrder}章 ${band.count}条`).join("；")}——某段之后集中断线比零散失线更可能是规划层的结构性遗漏，优先核对最集中的那一段。`);
  }
  if (dormancy.silent.length) {
    lines.push(`静默最久的清单（按沉默章数降序，至多 12 条）：\n${dormancy.silent.slice(0, 12).map((item) => `- ${item.id}｜埋于第${item.plantedOrder ?? "?"}章｜末次提及第${item.lastMentionOrder ?? "?"}章｜已静默 ${item.silentFor ?? "?"} 章｜${item.description}`).join("\n")}`);
  }
  return lines.join("\n");
}

/** 跨弧回报节奏渲染（确定性账目；空账不注入）。 */
export function renderStoryArcPayoffRhythm(rhythm: StoryArcPromptInput["payoffRhythm"]): string {
  if (!rhythm?.length) return "";
  const zeroStreak = (() => {
    let streak = 0;
    for (const arc of [...rhythm].reverse()) { if (arc.payoffCount === 0) streak += 1; else break; }
    return streak;
  })();
  const lines = [`跨弧回报节奏（确定性账目：定稿章数→兑付笔数）：${rhythm.map((arc) => `弧${arc.arcOrdinal}${arc.title ? `《${arc.title.replace(/^弧\d+[:：]?/, "")}》` : ""} ${arc.finalChapters}章/${arc.payoffCount}笔兑付`).join("；")}。`];
  if (zeroStreak >= 2) lines.push(`已连续 ${zeroStreak} 弧零兑付——兑付密度本身是题材判断，不设数值硬门；但读者在弧尺度上的契约已被静默透支：本弧应至少安排一次读者可感知的兑付（任意规模——旧账结清、阶段回报、认知落差兑现），或把长静默作为有意设计在 threadResponsibilities 登记理由与预定释放点。`);
  return lines.join("\n");
}

function sourceRefs(receipt: StoryArcContextReceipt | undefined, section: string, fallback: string[] = []): string[] {
  const fingerprint = receipt?.sectionFingerprints[section];
  return [...fallback, ...(fingerprint ? [`story-arc-section:${section}:${fingerprint}`] : [])];
}

export function buildStoryArcPlanningContextSections(input: StoryArcPromptInput) {
  const receipt = input.contextReceipt;
  const macro = [
    `项目：${input.projectTitle}`,
    input.authorIntent ? `作者要求：${input.authorIntent}` : "",
    `全局规划引用：${input.macro.map((item) => `[${item.taskKey}] ${item.title}: ${item.summary}`).join("\n") || "无"}`,
  ].filter(Boolean).join("\n");
  const recent = [
    receipt?.narrativeCutoff === undefined ? "叙事截止点：未记录（legacy context）" : `叙事截止点：第 ${receipt.narrativeCutoff} 章已定稿内容`,
    `最近章节位置：${input.recentChapters.map((item) => `第${item.order}章 ${item.summary}；未解=${item.unresolvedThreads.join("、") || "无"}`).join("\n") || "无"}`,
    // 前章开头（起手轮换契约的跨批判据输入，2026-10-14 round 11/12）。
    // 住本段而非新开一段：它就是"已定稿章节"的现场事实之一（与叙事截止点同族），
    // 且不新增 fingerprint 键。空数组/undefined 时整行不出现（既有调用方零影响）。
    ...(input.priorChapterOpenings?.length
      ? [`最近定稿章的开头首段（起手轮换契约据此判定跨批衔接，按时间先后排列）：\n${input.priorChapterOpenings.map((opening, index) => `- 倒数第${input.priorChapterOpenings!.length - index}章：${opening.slice(0, 80)}`).join("\n")}`]
      : []),
  ].join("\n");
  const open = [
    // PL-2 修复①（呈现面）：id 与显示名分行——同一行空格拼接的 "<id> <名>" 曾被模型
    // 原样复制进引用字段并逐轮放大（复合串自我复制的源头）。
    `开放剧情线（threadRef 只能填下列 id 的精确值、不带名称；确需新建剧情线用“new:<名称>”显式表达）：\n${input.openThreads.map((item) => `- id: ${item.id}\n  名称: ${item.title}${renderThreadPayload(item.payload)}`).join("\n") || "无"}`,
    `开放伏笔：${input.openForeshadowings?.map(renderOpenForeshadowing).join("\n") || "无"}`,
    `开放承诺：${input.openPromises?.map((item) => `${item.id} ${item.promiser}->${item.promisee}：${item.statement}`).join("\n") || "无"}`,
  ].join("\n");
  const feedback = [
    input.planningFeedback?.length
      ? `近期可迁移的规划反馈（只作为风险信号，不是新增剧情要求）：${input.planningFeedback.map((item) => `${item.targetId}${item.sourceChapterOrder ? `/第${item.sourceChapterOrder}章` : ""}：机制=${item.underlyingMechanism}；影响输入类=${item.affectedInputClass}${item.boundaries ? `；边界=${item.boundaries}` : ""}`).join("\n")}`
      : "近期可迁移的规划反馈：无",
    input.narrativeState ? `最新叙事状态账本：\n${renderNarrativeState(input.narrativeState)}` : "最新叙事状态账本：无",
  ].join("\n\n");
  const serialSignals = input.serialFunctionRuns?.length
    ? `连续同类功能游程（近 N 章连续 ≥3 章同 narrativeFunction）：${input.serialFunctionRuns.map((run) => `${run.narrativeFunction}×${run.narrativeOrders.length}（第${run.narrativeOrders.join("、")}章）`).join("；")}；连续同类功能不等于问题，但如果本批次再分配相同功能会延续疲劳——检查是否需要轮换压力类型或在该功能内提供可感知的新回报。`
    : "连续同类功能游程：近 N 章无连续同类功能游程。";
  // PL-8③：未揭示秘密清单——把"作者秘密"从散文变成规划/审核两侧可核对的结构边界。
  const secretsText = renderUndisclosedSecrets(input.undisclosedSecrets);
  const receiptText = receipt
    ? `上下文收据：fingerprint=${receipt.fingerprint}；cutoff=${receipt.narrativeCutoff ?? "legacy"}；来源 artifacts=${receipt.sourceArtifactIds.join("、") || "无"}；来源 revisions=${receipt.sourceRevisionIds.join("、") || "无"}`
    : "上下文收据：legacy context，未提供独立来源收据";
  const outlineSection = input.plotOutline
    ? {
      id: "arc-context-plot-outline" as const,
      kind: "planning" as const,
      title: "外部剧情编排（由作者/外部模型提供，规划器负责完善）",
      text: renderStoryArcPlotOutline(input.plotOutline),
      priority: "required" as const,
      provenanceRefs: ["orchestrated-plot-outline"],
    }
    : undefined;
  const castText = renderStoryArcCast(input.cast);
  const dueLedgerText = renderStoryArcDueLedger(input.dueLedger);
  const dormancyText = renderStoryArcNarrativeDormancy(input.narrativeDormancy);
  const base = [
    ...(castText ? [{ id: STORY_ARC_CONTEXT_SECTION_IDS.cast.id, kind: "fact" as const, title: "人物登记表（POV 与参与者的权威名册）", text: castText, priority: "required" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.cast.fingerprintKey) }] : []),
    { id: STORY_ARC_CONTEXT_SECTION_IDS.macro.id, kind: "planning" as const, title: "故事弧宏观规划", text: macro, priority: "required" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.macro.fingerprintKey, receipt?.sourceArtifactIds ?? []) },
    { id: STORY_ARC_CONTEXT_SECTION_IDS.recent.id, kind: "fact" as const, title: "已定稿章节与叙事截止点", text: recent, priority: "required" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.recent.fingerprintKey, receipt?.sourceRevisionIds ?? []) },
    ...(secretsText ? [{ id: STORY_ARC_CONTEXT_SECTION_IDS.secrets.id, kind: "planning" as const, title: "未揭示作者秘密", text: secretsText, priority: "required" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.secrets.fingerprintKey) }] : []),
    ...(dueLedgerText ? [{ id: STORY_ARC_CONTEXT_SECTION_IDS.dueLedger.id, kind: "planning" as const, title: "窗口上界已过的伏笔账", text: dueLedgerText, priority: "required" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.dueLedger.fingerprintKey) }] : []),
    ...(dormancyText ? [{ id: STORY_ARC_CONTEXT_SECTION_IDS.dormancy.id, kind: "planning" as const, title: "线索静默账（曾活跃、现已静默）", text: dormancyText, priority: "required" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.dormancy.fingerprintKey) }] : []),
    { id: STORY_ARC_CONTEXT_SECTION_IDS.openElements.id, kind: "planning" as const, title: "开放线索、伏笔与承诺候选", text: open, priority: "normal" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.openElements.fingerprintKey) },
    { id: STORY_ARC_CONTEXT_SECTION_IDS.feedbackState.id, kind: "review" as const, title: "机制反馈与叙事状态", text: feedback, priority: "normal" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.feedbackState.fingerprintKey, receipt?.sourceRevisionIds ?? []) },
    // 五个串行信号共用这一段（不拆段：它们同族、都是"近窗口确定性统计"，拆开只会
    // 稀释优先级并让读者在五段之间跳）。指纹也按段登记（见仓储侧 sectionFingerprints
    // 与 STORY_ARC_CONTEXT_SECTION_IDS 的说明）——原实现把 payoffRhythm 单独登一个键
    // 却无读点，而共享键又挂在条件上，造成"非空段零 provenance"。
    { id: STORY_ARC_CONTEXT_SECTION_IDS.serialSignals.id, kind: "review" as const, title: "跨章序列信号（功能游程、群像独处游程、回报节奏、篇幅与对白密度信号）", text: [serialSignals, renderStoryArcEnsembleSignal(input.ensembleSignal), renderStoryArcPayoffRhythm(input.payoffRhythm), renderStoryArcLengthDrift(input.lengthDrift), renderStoryArcDialogueDrift(input.dialogueDrift)].filter(Boolean).join("\n\n"), priority: "normal" as const, provenanceRefs: sourceRefs(receipt, STORY_ARC_CONTEXT_SECTION_IDS.serialSignals.fingerprintKey) },
    { id: "arc-context-receipt", kind: "background" as const, title: "上下文来源收据", text: receiptText, priority: "normal" as const, provenanceRefs: receipt ? [receipt.fingerprint] : ["legacy-context"] },
  ];
  return outlineSection ? [outlineSection, ...base] : base;
}

function renderNarrativeState(state: NarrativeStateSnapshot): string {
  return [
    `账本章节：第${state.narrativeOrder}章；弧阶段：${state.arcPhase || "未记录"}`,
    `开放线索：${state.openThreads.join("；") || "无"}`,
    `开放伏笔 ID（详情见开放伏笔段）：${state.openForeshadowings.map((item) => item.id).join("、") || "无"}`,
    `开放承诺 ID（详情见开放承诺段）：${state.openPromises.map((item) => item.id).join("、") || "无"}`,
    `已兑现节点：${state.fulfilledNodes.join("；") || "无"}`,
    `不可提前消费：${state.prohibitedEarlyConsumption.join("；") || "无"}`,
    `连续性边界：${state.continuityConstraints.join("；") || "无"}`,
  ].join("\n");
}

function renderOpenForeshadowing(item: { id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string }): string {
  const parts = [
    `${item.id} ${item.description}`,
    `触发=${item.triggerKeywords.join("、") || "未指定"}`,
    `窗口=${item.expectedPayoffWindow}`,
  ];
  if (item.readerQuestion) parts.push(`读者问题=${item.readerQuestion}`);
  if (item.possiblePayoffs?.length) parts.push(`可行兑现方向=${item.possiblePayoffs.join("、")}`);
  if (item.meaningDelta) parts.push(`意义增量=${item.meaningDelta}`);
  if (item.cost) parts.push(`代价=${item.cost}`);
  return parts.join("；");
}

function renderThreadPayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean" || (Array.isArray(value) && value.every((item) => typeof item === "string")))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("、") : String(value)}`);
  return entries.length ? `（${entries.join("；")}）` : "";
}

/** 未揭示作者秘密清单渲染（PL-8③，规划段与蓝图上下文共用，单一真源）。 */
function renderUndisclosedSecrets(items: StoryArcPromptInput["undisclosedSecrets"]): string {
  if (!items?.length) return "";
  return `未揭示作者秘密（以下内容尚未向读者揭示：本弧的 objective/exitState/阶段结论与各章要点不得消费这些论断；确需在本弧揭示某条时，必须在规划中显式写明揭示的触发事件与代价）：\n${items.map((item) => `- ${item.claim}${item.revealWindow ? `（揭示窗口：${item.revealWindow}）` : ""}${item.carrier ? `（载体：${item.carrier}）` : ""}`).join("\n")}`;
}

function context(input: StoryArcPromptInput): string {
  return [
    `项目：${input.projectTitle}`,
    input.authorIntent ? `作者要求：${input.authorIntent}` : "",
    renderStoryArcCast(input.cast),
    renderStoryArcEnsembleSignal(input.ensembleSignal),
    renderStoryArcDueLedger(input.dueLedger),
    renderStoryArcNarrativeDormancy(input.narrativeDormancy),
    renderStoryArcPayoffRhythm(input.payoffRhythm),
    renderStoryArcLengthDrift(input.lengthDrift),
    renderStoryArcDialogueDrift(input.dialogueDrift),
    `全局规划引用：${input.macro.map((item) => `[${item.taskKey}] ${item.title}: ${item.summary}`).join("\n") || "无"}`,
    `最近章节位置：${input.recentChapters.map((item) => `第${item.order}章 ${item.summary}；未解=${item.unresolvedThreads.join("、") || "无"}`).join("\n") || "无"}`,
    `开放剧情线（threadRef 只能填下列 id 的精确值、不带名称；确需新建剧情线用“new:<名称>”显式表达）：\n${input.openThreads.map((item) => `- id: ${item.id}\n  名称: ${item.title}${renderThreadPayload(item.payload)}`).join("\n") || "无"}`,
    `开放伏笔：${input.openForeshadowings?.map(renderOpenForeshadowing).join("\n") || "无"}`,
    `开放承诺：${input.openPromises?.map((item) => `${item.id} ${item.promiser}->${item.promisee}：${item.statement}`).join("\n") || "无"}`,
    renderUndisclosedSecrets(input.undisclosedSecrets),
    input.planningFeedback?.length
      ? `近期可迁移的规划反馈（只作为风险信号，不是新增剧情要求）：${input.planningFeedback.map((item) => `${item.targetId}${item.sourceChapterOrder ? `/第${item.sourceChapterOrder}章` : ""}：机制=${item.underlyingMechanism}；影响输入类=${item.affectedInputClass}${item.boundaries ? `；边界=${item.boundaries}` : ""}`).join("\n")}`
      : "近期可迁移的规划反馈：无",
    input.narrativeState ? `最新叙事状态账本：\n${renderNarrativeState(input.narrativeState)}` : "最新叙事状态账本：无",
    input.serialFunctionRuns?.length
      ? `连续同类功能游程（近 N 章连续 ≥3 章同 narrativeFunction）：${input.serialFunctionRuns.map((run) => `${run.narrativeFunction}×${run.narrativeOrders.length}（第${run.narrativeOrders.join("、")}章）`).join("；")}；连续同类功能不等于问题，但如果本批次再分配相同功能会延续疲劳——检查是否需要轮换压力类型或在该功能内提供可感知的新回报。`
      : "连续同类功能游程：近 N 章无连续同类功能游程。",
    input.plotOutline ? `外部剧情编排（由作者/外部模型提供，规划器负责完善）：\n${renderStoryArcPlotOutline(input.plotOutline)}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcPrompt(input: StoryArcPromptInput): string {
  return [
    "规划一个可滚动推进的故事弧及其第一批连续章节。全书规划只提供承诺、边界和长期方向；故事弧负责把当前状态转成阶段性因果链，章节蓝图只冻结当前因果、状态、事实边界和场景执行材料。",
    "输出必须是 schema 定义的规范蓝图对象：根对象只包含 arc、batch、chapters。场景的 situation、observableActions、opposition、decision、outcome、cost 只填写写作者可转化为现场的处境、动作、阻力、选择、结果和代价；规划器的技术模型、分析步骤或推演理由只能放入 planningRationale，不能混入可观察行动或结果。上下文中的持久化记录、执行状态、文档/修订标识、已批准或已提交的包装对象只是参考证据，不得原样复制到输出。",
    "先写清故事弧入口状态、主要欲望/压力、关键选择、代价、退出状态和新问题；每个阶段都要说明它改变了什么人物选择、关系状态、信息分布、资源条件或读者期待。",
    "每个阶段（phase）用 chapterOrdinals 显式列出它覆盖的弧内章节序号（1-based，从 1 开始连续覆盖到 expectedChapterCount，阶段之间不重叠、不遗漏）：系统按这份绑定呈现章节所属阶段，不做任何等分推算。chapterOrdinals 只填弧内序号、绝不填全书流水章号——弧第一章=1，即使全书已连续八十多章也不例外。",
    "主线、支线、人物线、关系线和世界压力线要直接在 threadResponsibilities 中标明本弧责任、交汇/退出条件和未回收承诺，并写清下一推进条件。若某条线本弧暂缓，写清可验证的保持/观察责任和触发条件；没有剧情线时数组为空。不为了填满结构而制造无依据事件，也不提前消费后续答案。",
    "伏笔归属写在线上：本弧 foreshadowingRefs 里的每条伏笔，把它的引用同时填进实际承担它的那条线的 threadResponsibilities[].foreshadowingRefs（取值必须是弧级 foreshadowingRefs 中已出现的那个值，不能新增账目）；一条伏笔只能由一条线承担，本条线不承担伏笔时该数组给空，暂无承担者的伏笔交作者分流，不要为清空而摊派。",
    REFERENCE_FIELD_CONTRACT,
    "上下文优先级：已定稿事实、叙事状态账本和明确作者边界高于当前故事弧草案；开放线索是待判断的责任与素材，不是本批次必须兑现的事件；规划反馈只用于修复共享机制，不把某一章的表面问题复制成剧情规则。",
    "外部剧情编排（如有）是设计意图基线，不是逐字清单：规划器负责把它完善为规范蓝图——对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、连续性约束与责任承接。编排与已定稿事实冲突时以已定稿事实为准；编排未覆盖的部分按本提示词其余规则生成；不得为了贴合编排而虚构事实、提前消费后续答案或改写人物知识边界。",
    "章节可以推进、停顿、相处、等待、恢复、内省或处理余波，不要求每章新增事件、压力、爽点、主题表达或固定结尾。未指定的表达层由作者自然发挥。",
    "近 N 章连续同类功能游程（见上下文序列信号）是疲劳风险提示，不是硬门：连续同类功能本身合法，但如果本批次再分配相同功能会延续疲劳，应检查是否可以轮换压力类型，或在该功能内提供可感知的新回报（关系温度、理解修正、余波承载、独立体验）。不要为了打破连续而强行安排无依据事件。",
    "弧应先按问题阶梯设计再展开章节：主线推进弧的核心读者问题在 development 中逐级被回答并升级，各阶段（phase）之间有承接关系；关系、铺垫和余波弧以关系温度或理解变化为推进方式，同样成立。推进型弧结束时相对入口应有身份、资源、知识、关系或威胁级别中的可感知变化；铺垫/过渡弧的出口可保持稳定，但必须说明本弧承担的静态功能。本弧在 objective 中承诺的读者体验（解决问题、关系升温、世界揭秘、认知落差、情绪确认）应在 exitState 中得到交付，弧的读者回报与入口期待匹配。",
    "每章填写起始状态、结束状态和可观察证据；状态保持稳定也是合法结果，但必须说明本章让读者获得了什么可感知的新东西——体验、关系、理解、条件、余波或情绪确认；确认规则的陈述若改变了角色后续选择或风险判断，即算功能；若只是认知登记且无后续影响，则并入相邻章节。每个场景填写处境、可观察行动和结果；阻力、选择、代价在自然承担时写清，不用标签代替过程。若需要保留作者侧分析，使用 planningRationale；正文执行上下文不会读取它。没有真实连续性约束时使用空数组，不要为了满足格式虚构内容。",
    "场景设计至少能回答：谁此刻想要什么、什么在阻拦、人物知道什么/不知道什么、有哪些选择与代价、结果如何改变后续；安静场景也要有可感知的注意力、关系温度、理解或处境证据。一个场景的 outcome 应成为下一场景 situation 的触发条件；不推动外部因果的场景必须承担关系温度、理解修正、余波承载或独立体验功能，而不是只作为过程流水。",
    context(input),
    "只输出 schema 所需 JSON，不输出 Markdown 或解释文字。",
  ].join("\n\n");
}

const REFERENCE_FIELD_CONTRACT = "引用字段契约：threadRef 与 foreshadowingRefs 只允许填上下文中给出的 id 精确值（单独一个值，不得附带名称、序号或说明文字）；确需新建剧情线或伏笔时填“new:<名称>”。正文、状态、责任等自由文本字段一律用人类可读名称，不得内嵌 id、hex 片段或内部编号——内部记号一旦进入创作文本就会被后续每一轮原样复制。";

export function buildStoryArcPlanPrompt(input: StoryArcPromptInput, target?: StoryArcRebaseTarget): string {
  return [
    "只规划故事弧和当前批次，不展开章节。故事弧负责把当前状态转成阶段性因果链，批次只冻结当前章节窗口的位置和是否完成。",
    "输出根对象只包含 arc、batch；上下文中的持久化记录、执行状态、文档/修订标识、已批准或已提交的包装对象只是参考证据，不得原样复制到输出。",
    "先写清故事弧入口状态、主要欲望/压力、关键选择、代价、退出状态和新问题；每个阶段都要说明它改变了什么人物选择、关系状态、信息分布、资源条件或读者期待。",
    "每个阶段（phase）用 chapterOrdinals 显式列出它覆盖的弧内章节序号（1-based，覆盖到 expectedChapterCount，阶段之间不重叠、不遗漏）：系统按这份绑定呈现章节所属阶段，不做任何等分推算。chapterOrdinals 只填弧内序号、绝不填全书流水章号——弧第一章=1，即使全书已连续八十多章也不例外。",
    "主线、支线、人物线、关系线和世界压力线要直接在 threadResponsibilities 中标明当前责任、交汇/退出条件和未回收承诺。没有剧情线时数组为空，不为了填满结构制造无依据事件，也不提前消费后续答案。",
    "伏笔归属写在线上：本弧 foreshadowingRefs 里的每条伏笔，把它的引用同时填进实际承担它的那条线的 threadResponsibilities[].foreshadowingRefs（取值必须是弧级 foreshadowingRefs 中已出现的那个值，不能新增账目）；一条伏笔只能由一条线承担，本条线不承担伏笔时该数组给空，暂无承担者的伏笔交作者分流，不要为清空而摊派。",
    REFERENCE_FIELD_CONTRACT,
    "上下文优先级：已定稿事实、叙事状态账本和明确作者边界高于当前故事弧草案；开放线索是待判断的责任与素材，不是本批次必须兑现的事件；规划反馈只用于修复共享机制。",
    "外部剧情编排（如有）是设计意图基线，不是逐字清单：规划器负责把它完善为规范蓝图——对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、连续性约束与责任承接。编排与已定稿事实冲突时以已定稿事实为准；编排未覆盖的部分按本提示词其余规则生成；不得为了贴合编排而虚构事实、提前消费后续答案或改写人物知识边界。",
    `批次位置必须是 batch.batchIndex=${target?.batchIndex ?? 1}、batch.startChapterIndex=${target?.startChapterIndex ?? 1}；${target ? "这是重基线，不能改写目标批次窗口。" : "这是新规划，批次从当前输入上下文确定。"}`,
    context(input),
    target ? `重基线目标（只读）：${JSON.stringify(target)}` : "",
    "只输出 schema 所需 JSON，不输出 Markdown 或解释文字。",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcChaptersPrompt(input: StoryArcPromptInput & { arc: StoryArcBundle["arc"]; batch: StoryArcBundle["batch"]; windowChapters?: number }, target?: StoryArcRebaseTarget): string {
  return [
    target
      // 重基线契约（根因修复）：此前 rebase 走本函数却只在尾部附只读 envelope，
      // "只展开当前窗口"指令使模型合法地输出单章/子集，validate 的逐章对应硬门
      // 必炸（arc2 重生成实证）。契约必须出现在生成面而非仅校验面。
      ? `这是重基线，不是下一批次生成：chapters 必须与文末"重基线目标"逐章对应，数量必须等于 ${target.chapters.length}，序号按目标 chapters[].globalOrder 顺序完整覆盖（${target.chapters.map((chapter) => chapter.globalOrder).join("、")}），不得只输出单章或窗口子集。历史已定稿章节的蓝图会由系统按冻结版本保真，你仍须为其各返回一章对应条目。`
      // 正常批次窗口契约（arc5 根因修复，与重基线同型）：窗口章数是系统分配的
      // 事实（弧内剩余按窗口上限截断），模型无裁量权——"保留后续发展的空间"
      // 曾使模型把 7 章弧的批次坍缩成单章，且校验面无拦截。
      : [
        `依据故事弧“${input.arc.title}”生成第 ${input.batch.batchIndex} 批章节，叙事序号从 ${input.batch.startChapterIndex} 开始。输出根对象只包含 chapters。`,
        input.windowChapters ? `本批次窗口由系统定为 ${input.windowChapters} 章：chapters 必须完整覆盖序号 ${input.batch.startChapterIndex} 至 ${input.batch.startChapterIndex + input.windowChapters - 1}，每个序号各一条，不得少于或多于该窗口——"保留后续发展的空间"指叙事设计的余地，不是缩减本批次章节窗口。` : "",
      ].filter(Boolean).join("\n\n"),
    target ? "输出根对象只包含 chapters。" : "",
    "只展开当前窗口，不把整卷或整本书压缩成章节任务清单；保留后续发展的空间。每章填写起始状态、结束状态和可观察证据；状态保持稳定也是合法结果，但必须说明本章让读者获得了什么可感知的新东西——体验、关系、理解、条件、余波或情绪确认；确认规则的陈述若改变了角色后续选择或风险判断，即算功能；若只是认知登记且无后续影响，则并入相邻章节。",
    "每章都必须完整返回 schema 声明的 index、title、narrativeFunction、povCharacterId、stateTransition、scenes、continuityConstraints、unresolvedAtClose；stateTransition 必须是包含 before、after、evidence 三个非空字符串的对象，不能省略、改名或用摘要替代。narrativeFunction 必须使用 schema 枚举值，不得自造同义标签。povCharacterId 必须逐字使用『人物登记表』中的 id 精确值。",
    // 2026-09-17：targetWordCount 此前只在 TS 类型里、不在 schema，规划模型结构上
    // 无法输出——写作端因此拿不到权威篇幅，只能靠 instruction 手写等量段配额代偿，
    // 产出全书段长趋同（cv 0.62，ch167 仅 0.07）。此契约要求**逐章给出并允许有差异**：
    // 篇幅是本章信息量的函数，不是全弧的常数。
    `目标篇幅契约：每章都要给出 targetWordCount（可见字符数，整数）。它是**本章**信息量与场景数的函数，不是全弧常数——推进章、对峙章、高潮章可以更长；安静章、余波章、过渡章可以更短。同一批次内若各章目标完全相等，说明没有按章估量，应重估。给出后，正文写作与提交门会共用这个数字（缺省才回落系统默认值），因此不要写明显偏离本章实际承载能力的数。篇幅信号显示近窗口连续低量时（见上下文篇幅信号段），除非个别章功能确需短章（planningRationale 声明），不得系统性延续低声明——逐章达标不等于全书内容密度合格。项目级下限：每章 targetWordCount 不得低于 ${LENGTH_DECLARATION_POLICY.floor} 字（提交门按声明目标的 ${Math.round(MIN_LENGTH_RATIO * 100)}% 执法，该下限保证门限不跌破项目单章稀疏线 ${LENGTH_DRIFT_POLICY.sparseFloor} 字）；个别章功能确需更短时在 planningRationale 声明理由并如实给出目标，但整批不得过半低于此下限。`,
    target ? "" : "群像配额（蓝图结构契约，先于正文存在）：本批次章节窗口中至少三分之一（向上取整）的章节要包含两名及以上参与者互相作用的场景——对方有自己的欲望与代价、其行动改变彼此处境，不是道具或背景板；纯独处章每批至多一章，且该场景的 planningRationale 必须写明这章的静在与不在场的谁对话。安静、余波、内省章两人同场依然合法——静不等于独。",
    target ? "" : "第二意志契约（2026-09-17 全量复扫确诊：参与者计数与\"有人可交锋\"是两个解耦事实——全书 108 章参与者≥2，其中 52 章的 opposition 全指向\"格法/旧例/环境/他自己的判断\"，人在场却只执行工序、彼此不索取任何东西，正文因此读成一个人对着制度做分析）：凡某章场景参与者≥2，该章至少一个场景的 opposition 必须写清**谁**（具名或具体差称）**想要什么**、**他的行动如何改变对方的可选集合**。只写\"格法不许\"\"旧例如此\"\"他不能问\"\"两人都不能明说\"不算第二意志——那仍是环境压力。对手的欲望可以是小的、日常的、甚至出于善意的（想早点收工、不想担责、想保一个人），但必须是他自己的、且与主角的意图不完全一致。单人静章不受此约束。",
    // 收束形态轮换契约（2026-09-22 商业基准对照确诊，docs/novel-v2/commercial-benchmark-review-20260922.md）：
    // 章末仪式窗口命中 38/168 章且集中成段——批级"同形落点"是**批的属性**，逐章判据
    // 测不到（与群像游程同构），故契约与配额都放在蓝图生成面。判据是"同一动作帧的
    // 近似句式复现"，不是"静收束"本身——余波章、安静章的静落点合法。
    target ? "" : "收束形态轮换契约（2026-09-22 全书复盘确诊：章末反复以同一动作帧收束——如回到居所、静场清点、留白悬置——在 168 章中 38 章落入可预测同形落点，连续 20 余章以同一形态收尾，读者第三天就能预测落点）：本批次章节窗口中至少三分之一（向上取整）的章节，其收束不落在『回到居所/静场收尾/留白悬置』这类静收束动作帧上——改用外部小事件、他人动作或闲话、或直接切在动作与对话中间。同一收束动作帧跨章可以复用意象，但表层句式必须变体，不得以近似句式复现；每章的收束形态选形理由写入 planningRationale。安静章、余波章以静收束合法——轮换针对的是跨章可预测的同形落点，不是静本身。",
    // 起手形态轮换契约（2026-10-14 全书扫描确诊，docs/novel-v2/state-audit-20261013.md §8.7）：
    // 与上一条是**同一 failure class 的另一半**——章尾同形已有契约与实测校准（38/168），
    // 而起手侧此前**零覆盖**（无契约、无审核项、无测量通道）。全书实测：首段以时间标记
    // （时辰/日序/天色）起头的章占 31%，41-60 章一段达 55%（11/20），且 41-43 连续三章
    // 落入同一个「时间标记 + 视角人物已经/才…」的三槽模板（同形 run，实测数据见上述文档）。
    // 直读对比证实病灶：该带三章开头互为改写，而 81-84 带的四章开头形态互不相同
    // （感官醒来 / 带物动作 / 时间标记后接意图 / 环境后接身姿）。
    //
    // 判据取"同形态连续复现"，与 ENDING_RITUAL_POLICY 的窗口判据同族：单章以时间起头
    // 完全合法（本书真声音的一部分），**连续 ≥3 章同一模板**才是惯性。
    //
    // 2026-10-14 复核轮 round 11/12 实测修正（本条是**契约自身的缺陷**，不是正文的）：
    // 两条判据原先都写"本批次"，而生产批次是 7 章一弧（实测弧6=35-42 / 弧7=43-49）——
    // 全书唯一的真实 run（ch41-43）恰好跨在弧6/弧7 边界上：弧6 只拿到 41、42（连续 2，
    // run 判据不触发），弧7 只拿到 43（连续 1）。**门一直在，对全书唯一的病灶失明。**
    // 量化取证（tmp/state-audit/verify-opening-*.mts）：6 章批次 + ≤1/3 配额 ⇒ 28 批
    // **零违反**（连病灶带都不违反，配额判据是恒真的）；strict 判据下全书只有 1 个 run，
    // 正是 ch41-43。⇒ 载荷全在 run 判据上，而它被批界切断了。
    // 修法照搬章末仪式化的既有形态：跨章判据由调用方喂入前章语境（priorChapterOpenings，
    // 与 ENDING_RITUAL_POLICY.priorEndings 同路）。措辞据此改为跨批衔接。
    target ? "" : "起手形态轮换契约（与收束轮换同族，治的是另一半）：本批次章节窗口中至少三分之二（向上取整）的章节，其起手不落在『时间标记 + 环境细节 + 视角人物已经在/才…』这一模板上——可用的替换起手至少包括：从一个正在进行的动作切进去、从一句对白或他人话语切进去、从一个物件的状态或变化切进去、从身体感受切进去、从本章即将被打断的意图切进去。**连续三章同槽位起头是跨批的**：本批首章要与上文给出的前章开头衔接看——若前两章已连用该模板，本批首章必须换形，不得把同一模板延续成三连（判据是本批首章与前两章的衔接，不是只看本批内部）。跨章复用时间意象可以，但首句的句式必须变体（不得都把人物钉在『已经/才』的位置上）。每章的起手形态选形理由写入 planningRationale。以时间起头合法的章不受此约束——轮换针对的是跨章可预测的同形模板，不是时间标记本身。",
    "每个场景填写处境、可观察行动和结果；阻力、选择、代价在自然承担时写清，不用标签代替过程。需要保留但不应进入正文的分析方法放入 planningRationale，不要写进 observableActions 或 outcome。没有真实连续性约束时使用空数组，不为了满足格式虚构内容。",
    "章节术语降噪（叙事语言）：章节标题、场景标题、处境/可观察行动/结果/决策/代价等设计字段一律使用题材通用表达，不得直接使用主角职业/专业黑话原词。主角的特殊认知是能力的设定来源，通过'发现规律''看出异常'这类可感观察体现，不通过章节设计里的专业术语表达；机制层面的专业概念如需向作者说明，放在 planningRationale（正文执行上下文不读取它）。",
    `当前故事弧：${JSON.stringify(input.arc)}`,
    `当前批次：${JSON.stringify(input.batch)}`,
    context(input),
    target ? `重基线目标（只读）：${JSON.stringify(target)}` : "",
    "只输出 schema 所需 JSON，不输出 Markdown 或解释文字。",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcRebasePrompt(input: StoryArcPromptInput & { target: StoryArcRebaseTarget }): string {
  return [
    "这是重基线，不是下一批次生成：在不改写已定稿事实、因果结果、状态边界和未解事项的前提下，重建故事弧蓝图。历史章节只允许复用冻结数据，未来章节可以补充尚未冻结的执行细节。",
    `输出必须保持重基线位置：batch.batchIndex=${input.target.batchIndex}，batch.startChapterIndex=${input.target.startChapterIndex}，chapters 必须与输入目标逐章对应且数量为 ${input.target.chapters.length}。不得把目标中的未来/持久化章节包装改成新的批次，也不得生成目标范围之外的章节。`,
    "重基线目标是只读输入 envelope；将其中的 approvedArc、章节提交包和存储元数据投影为规范 schema，而不是把 envelope 当作输出 schema。approvedArc 必须已经符合当前故事弧契约，历史章节权威仍只来自章节提交包、chapterMemory 和 authoritativeFacts；当前输出 bundle.arc 仍必须完整返回 threadResponsibilities。缺少当前契约的旧批准记录由迁移标记为 stale，不能在提示词或运行时补全。",
    buildStoryArcPrompt(input),
    `重基线目标：${JSON.stringify(input.target)}`,
  ].join("\n\n");
}

export function buildStoryArcReviewPrompt(bundle: StoryArcBundle, contextText: string, rebaseTarget?: StoryArcRebaseTarget): string {
  const ensemble = inspectStoryArcEnsemble(bundle.chapters);
  const ensembleReport = bundle.chapters.length >= 3
    ? `群像结构信号（确定性统计，非审美判定）：本批 ${ensemble.ensembleChapterIndexes.length}/${bundle.chapters.length} 章含两名及以上参与者互动场景（配额 ≥${ensemble.ensembleQuota} 章）；纯独处章${ensemble.soloOnlyChapterIndexes.length ? `：第${ensemble.soloOnlyChapterIndexes.join("、")}章` : "无"}；最长连续独处游程 ${ensemble.longestSoloRun} 章。`
    : "";
  // 声明侧篇幅信号（2026-10-13，state-audit-20261013.md §7 第 4 项）：与群像配额同族——
  // "整批在下调标准"是批的属性，逐章审查看不出来（每章都合法），只有批级占比能测到。
  // 判据常量住 word-count.ts（LENGTH_DECLARATION_POLICY），此处只渲染信号，判断留给审核面。
  //
  // **刻意不设批内章数闸门**（与上面 ensembleReport 的 `>= 3` 不同，不是漏改）：
  // 该 spec 明写"仅 1 章声明且低于下限的批次也会被判系统性（占 1/1）——有意的保守取向，
  // 让审核问一句而非静默通过"。`inspectLengthDeclarations` 对 1/1 即判 systematic，
  // 若在此处按章数吞掉整段信号，小批次就重新变成静默通过，与该取向相反。
  const declarations = inspectLengthDeclarations(bundle.chapters);
  const declaredCount = declarations.anchored.length + declarations.underDeclared.length;
  const declarationReport = `声明侧篇幅信号（确定性统计，非审美判定）：本批 ${bundle.chapters.length} 章中 ${declarations.undeclared.length} 章未声明目标（回落系统默认 ${DEFAULT_TARGET_WORD_COUNT} 字），已声明 ${declaredCount} 章${declarations.averageDeclared === undefined ? "" : `均声明 ${declarations.averageDeclared} 字`}；其中 ${declarations.underDeclared.length} 章低于项目下限 ${declarations.floor} 字${declarations.underDeclared.length ? `：第${declarations.underDeclared.join("、")}章` : ""}。`;
  return [
    "审核故事弧的结构可靠性，不替正文规定审美。先按整弧检查承诺、入口/退出状态、阶段边界、线索责任和终局空间，再逐章检查状态连续、场景因果、人物选择、世界规则压力、知识边界和章节功能。逐章逐项检查，不要抽样概括：当前批次共 " + bundle.chapters.length + " 章，每章都要覆盖状态连续、场景因果、章节功能与权威边界。",
    ...(ensembleReport ? [`${ensembleReport}审核契约：独处编排是正文对白崩落的上游病灶（已实证），当配额未满足或最长独处游程≥4 时，检查是否复现"单人内心节目单"形态——本弧承诺的读者体验是否因缺对手戏而受损；受损则报告节奏问题，并指出最小修改：把哪一章的独处解码事件改造为一名有欲望有代价的第二意志进场的交锋。个别功能静章（planningRationale 已声明与谁对话）不构成问题。**第二意志缺口检查（独立于配额）**：凡某章场景参与者≥2，至少一个场景的 opposition 必须写清谁（具名或具体差称）想要什么、他的行动如何改变对方的可选集合；若该章的 opposition 全部指向"格法不许/旧例如此/环境/他自己的判断"，即使参与者数达标，也按 major 报告并给出最小修改：为哪一章补一名带着自身目的进场的对手（欲望可以小、可以善意，但必须是他自己的、且与主角意图不完全一致）。另核对每章 povCharacterId 是否精确命中『人物登记表』中的 id——变体名（截短、改拼、用显示名）会导致 POV 作用域的记忆召回静默失效，按 major 报告并给出登记表中的正确 id。`] : []),
    ...(declarationReport ? [`${declarationReport}审核契约：单章低于项目下限可能是功能性静章（schema 明示"安静章可低于推进章"），不单独判问题；但已声明章中过半低于下限时，蓝图整体在下调标准——提交门按声明目标的 ${Math.round(MIN_LENGTH_RATIO * 100)}% 执法，低声明会把欠量下限一并下移，逐章达标不等于内容密度合格。${declarations.systematic ? `本批已构成系统性低声明（${declarations.underDeclared.length}/${declaredCount} 章低于下限）：按 major 报告，逐条指出哪些章应提高声明，或说明该章 planningRationale 已声明的功能理由为何成立。` : "本批未构成系统性低声明，仅作信号记录，不据此判 revise。"}`] : []),
    "把‘没有事件’与‘没有变化’区分开：安静章节可以通过关系温度、理解、信息分布、资源条件、心理方向或余波完成自身功能；只有在当前功能需要而正文/蓝图没有承载时才报告问题。",
    "检查节奏时看目标、阻力、期待、揭示、结果和余波的波形，以及重复冲突/反转造成的疲劳，不用固定章数、钩子密度、爽点数量或持续升级作为硬标准。同时按弧设计契约检查（契约是检查方向，不是必须全部成立的硬门）：development 各阶段是否呈承接的子问题链而非并列步骤，场景 outcome 是否成为下一场景 situation 的触发条件或承担独立体验/理解修正功能，安静章是否让读者获得可感知的新东西（关系温度/风险判断/物品易主/理解修正/情绪确认/余波承载），推进型弧的退出状态相对入口是否有身份、资源、知识、关系或威胁级别中的可感知变化。安静、关系、背景、铺垫和余波弧与行动弧同样合法，只要其功能有可感知证据；只有契约缺失且确实损害了本弧承诺功能的证据时才报告 major。",
    // 收束形态分布检查（2026-09-22 章末仪式 38/168 章窗口命中的审核面落点）：
    // 蓝图层没有正文末段可统计，判断落在 planningRationale 声明的收束形态上——
    // 语义判断归审核，不做句式黑名单。
    "收束形态分布检查（通用，语义判断）：依据各章 planningRationale 与末场景结果，核对本批各章的收束形态是否呈现轮换——连续 ≥3 章计划以同一动作帧收束（如回屋清点、静场留白、仪式化收尾）而 planningRationale 未声明理由时，按节奏问题报告，并给出最小修改：指出哪几章改用外部事件、他人动作或切在动作中间收束，其余保留。个别安静章的静收束不构成问题；轮换压力针对的是跨章可预测的同形落点。",
    // 起手形态分布检查（2026-10-14，state-audit §8.7）：收束轮换的同族另一半。
    // 蓝图层同样没有正文首段可统计，判断落在 planningRationale 声明的起手形态上。
    // 语义判断归审核，不做句式黑名单；判据是"连续 ≥3 章同一槽位序列"。
    "起手形态分布检查（通用，语义判断）：依据各章 planningRationale 与首场景的切入方式，核对本批各章的起手是否呈现轮换——连续 ≥3 章计划以同一槽位序列起头（典型形态：时间标记 + 环境细节 + 视角人物已经在/才…）而 planningRationale 未声明理由时，按节奏问题报告，并给出最小修改：指出哪几章改用一个正在进行的动作、一句对白或他人话语、一个物件的状态变化、身体感受、或一个即将被打断的意图起头，其余保留。以时间起头合法的章不构成问题；轮换压力针对的是跨章可预测的同形模板，不是时间标记本身。",
    // 内容稀疏检查（2026-09-22 章长漂移确诊的审核面落点；判据边界见 LENGTH_DRIFT_POLICY）：
    // 逐章对声明目标达标 ≠ 全书内容密度合格——"拆事件凑章数"（一个事件拆三日内心戏
    // 三章的实证病例 ch121）每章都过 length-under-target 门而读者看到碎片化。
    "内容稀疏检查（通用，语义判断）：以上下文『篇幅信号』段为准（无该段时跳过）——近窗口连续低量章，且本批蓝图 targetWordCount 又延续低声明、而各章承载的仍是单个可并置事件或单次内心解码时，检查是否复现'拆事件凑章数'形态；是则按节奏问题报告并给出最小修改：合并哪些章，或为哪几章补充实际承载（第二人进场、事件推进、可感知回报）。个别功能静章（planningRationale 已声明）与安静章不构成问题；章长本身不是病，碎片化才是。",
    // 对白密度检查（2026-10-13 商业面缺口确诊的审核面落点；判据边界见 DIALOGUE_DRIFT_POLICY）：
    // 上游群像配额管的是蓝图参与者数，管不到正文实际写没写出交锋——本段是两者之间
    // 唯一的回读。逐章都能自证其静，只有窗口统计看得见整批把对手戏挤出正文。
    "对白密度检查（通用，语义判断）：以上下文『正文对白密度』段为准（无该段时跳过）——近窗口对白稀薄（多章无含引号段落，或均对白字占比低于密度提示线）时，检查本批蓝图是否延续同一形态：各章虽有参与者，但 opposition 全是环境/旧例/他自己的判断，或场景只写主角独自解码。是则按节奏问题报告，并给出最小修改：指出哪一章应当让一名有欲望、有代价的第二意志进场，并把代价落到对白上。安静章、余波章、内省章以低对白成立是合法形态，单章低对白不单独判问题；本检查不是补对白指令，不得为凑密度要求添加台词或情绪宣言。",
    "以目标读者视角检查本弧的读者回报：entryState/objective 承诺了什么体验（解决问题、关系升温、世界揭秘、认知落差、情绪确认），exitState 与 development 是否真的交付了这种体验；若弧结束时读者只经历了过程而没有获得解决、成长、理解、情绪或新问题中的任何回报，报告为节奏问题。安静弧的回报可以是理解修正或关系温度，不要求每弧交付事件性高潮。",
    "故事弧按批次滚动审核：当 batch.complete=false 或当前章节窗口少于 arc.expectedChapterCount 时，未到达 arc.exitState、后续阶段尚未交汇或长线尚未收束是预期的未决状态，不能仅因未来证据尚未出现而报告问题。只有当前窗口改写边界、提前消费答案、破坏责任传递或声称已完成却没有证据时才报告。",
    "对未知物质、装置、痕迹或局部反应执行同一证据边界：湿度、颜色、气味、声音、光亮或接触变化只能支持当下可观察现象，不能单凭一次反应推出用途、成分、机制、追踪/筛选/警示功能或排除某种用途。若蓝图把局部现象写成角色尚未获得的功能结论，必须列为问题并要求修订保留未知状态。",
    "逆向检查相邻章节的状态：任何跨章节持续的物件、伤势、资源、关系、知识或限制，都必须在前章结束、后章开始和中间转化之间保持同一身份；若后章出现‘没有/重新获得/已经知道’等状态跳变，却没有丢失、转移、消耗、恢复或新证据，按连续性重大问题报告。此规则只约束可验证的状态转化，不要求为每个普通名词建立清单。",
    "检查每个反转、回收和新答案是否有前置证据、行动代价和意义变化；检查每条重要线是否有交汇、退出、暂缓责任或转化原因，避免只在字段中挂名。",
    "秘密边界检查（通用，不依赖特定措辞）：对照上下文中的『未揭示作者秘密』清单逐条核对——本弧 objective/exitState/阶段结论或某章要点若消费了清单中的论断，检查规划是否显式安排了该秘密的揭示（触发事件+代价）；显式揭示合法，无安排的泄漏报告为 major 并指出泄漏所在字段，修复方向是从字段剥离该论断而非改写秘密。清单为空时跳过本检查。",
    "到期账处置检查（通用）：以上下文『到期与老化伏笔账』段为准（无该段时跳过）——清单中每条到期伏笔，核对本弧是否给出三选一处置：安排兑现（能指向承担兑现的场景因果/章节结果）、显式移交保持（threadResponsibilities 登记保持责任与触发条件）、或已由作者分流改窗/放弃。既无兑现安排又无保持登记的到期项，按线索责任缺失报告 major 并列出条目 id；不要要求本弧兑现全部到期账——不分担但已登记保持责任的条目合法。",
    "悬念续费检查（通用，语义判断不逐字匹配）：跨章序列信号与逐章 unresolvedAtClose 中，同一未解问题（语义同一即算，换措辞不换账）连续多章挂起而既无一分推进、也无一寸代价或信息增量，本弧又未登记承担它的场景，读者体验为『高潮被挪用为悬念续费』（实证病例：铺垫数章的『看一眼』在兑现前一瞬断章、后续章永久回避所见内容）。检查本弧是否把此类高潮性悬念的兑现安排进窗口；确属长线合法等待（有保持责任与触发条件）不报，缺失推进且损害读者回报时按节奏问题报告。",
    "叙事语言降噪检查：章节标题、场景标题、处境/可观察行动/结果/决策/代价等读者可见字段若直接使用主角职业/专业黑话原词，属于叙事语言污染——它会把专业思维解说传导到正文。若蓝图把机制层概念以黑话原词写进读者可见字段，列为 major 并要求转译为题材通用表达；主角的独特认知只能通过'发现规律''看出异常'这类可感观察体现，不通过专业术语表达。",
    "对每章按其权威路径逐一核对证据边界（路径清单见下），确认状态转化、场景处境/行动/结果和未解事项是否由蓝图字段直接承载；只有蓝图断言超出其字段可蕴含的范围时才报告越界。",
    contextText,
    `故事弧蓝图：${JSON.stringify(bundle)}`,
    `权威路径清单：${bundle.chapters.map((chapter) => `第${chapter.index}章：${storyArcAuthorityPaths(chapter).join("、")}`).join("；")}`,
    rebaseTarget ? `重基线：${JSON.stringify(rebaseTarget)}` : "",
    rebaseTarget ? "重基线目标中的历史章节可能保留旧版可选场景字段（例如空的 situation 或 observableActions）；这些字段属于冻结兼容数据，不要把它们当作新的正文缺陷或要求虚构补写。对历史章节以 chapterMemory 和 authoritativeFacts 检查状态与事实边界；只有候选蓝图真正新增且没有证据支持的确定性，才报告为问题。" : "",
    "每个问题必须引用实际蓝图字段、章节或场景证据，说明是事实/权威边界、因果承载、章节功能还是审美偏好；按严重度排序，并给出最小修复方向。不要输出 JSON、Markdown 代码块或 Schema。",
    "跨阶段职责判定：你只对本故事弧可决定的范围负责（入口/退出状态、本弧章节、线索的本弧责任）。凡属于下游规划阶段才落地的细节——后续批次章节的未决状态、全书级长线在更晚窗口的收束、由其他弧承担的责任——只要本弧已登记为预期的未决状态或责任传递，即视为已尽责，不得作为判 revise 的依据。",
    "判定纪律（收敛）：规划级审核的默认倾向是放行。每条意见判为 major 前先自问：此项缺失是否会让本弧无法推进，或让读者在本弧承诺的体验上直接受损？能在后续批次或正文中兑现的改进建议属于非阻断项，不得触发 revise。修订循环要收敛：上一轮主要问题已处理、本轮仅剩新增的非阻断建议时，应判 PASSED。",
    "意见回流卫生：你的意见会作为指令回流到修订阶段，因此只针对本弧可修复的问题给出最小修复方向；不输出 Markdown 列表、代码围栏或 JSON 结构；示例值使用中文直角引号『』或描述性语言，禁止使用中文全角引号（“”）包裹示例，防止模型在 JSON 输出中回显污染。",
    `## 输出约定\n若故事弧蓝图通过审核，只输出一行：${TEXT_REVIEW_PASSED_MARKER}\n若存在问题，输出审核意见（不输出 PASSED 标记）：只列必须修订的问题（阻断或重大缺陷），每个问题一句话说明现象、涉及章节与蓝图字段、影响机制和最小修复方向。审核意见会作为指令回流到修订阶段，因此必须精简、可执行：不要逐章复述'没有问题'的通过项，不要输出冗长分析或思考过程。`,
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcRevisionPrompt(bundle: StoryArcBundle, review: StoryArcReviewOutput, contextText: string, rebaseTarget?: StoryArcRebaseTarget): string {
  return [
    "依据审核意见修订故事弧。先修复承载问题的最低层级：状态和事实边界优先于章节安排，因果与人物选择优先于抽象主题标签，线索责任优先于增加事件。",
    "保留已经成立的人物选择、关系积累、有效证据、未解问题和下层创作空间；不得为了补结构而提前兑现承诺、替人物宣布感情结论、抹平合理未知或覆盖已冻结事实。",
    "不为满足抽象质量标签添加无依据的人物、事件、主题或固定节奏；若问题源于规划缺失，补充可验证的边界、选择、代价、窗口或退出条件，而不是补写正文摘要。",
    "场景的 situation、observableActions、opposition、decision、outcome、cost 只保留写作者可转化为现场的材料；技术模型、分析步骤和推演理由放入 planningRationale，并确保正文执行投影不会消费该字段。",
    "章节术语降噪（叙事语言）：章节标题、场景标题、处境/可观察行动/结果/决策/代价等读者可见字段一律使用题材通用表达，不得直接使用主角职业/专业黑话原词。主角的特殊认知是能力的设定来源，通过'发现规律''看出异常'这类可感观察体现，不通过章节设计里的专业术语表达；机制层面的专业概念如需向作者说明，放在 planningRationale（正文执行上下文不读取它）。审核意见即使未提及叙事语言，修订时也应一并降噪读者可见字段。",
    contextText,
    `当前蓝图：${JSON.stringify(bundle)}`,
    `审核意见：${review.opinion}`,
    rebaseTarget ? `重基线：${JSON.stringify(rebaseTarget)}` : "",
    rebaseTarget ? `修订后 chapters 仍必须与重基线目标逐章对应：数量等于 ${rebaseTarget.chapters.length}，序号按目标 chapters[].globalOrder 完整覆盖，不得缩减为子集（历史章节内容由系统按冻结版本保真）。` : "",
    "只输出完整 schema JSON。",
  ].filter(Boolean).join("\n\n");
}
