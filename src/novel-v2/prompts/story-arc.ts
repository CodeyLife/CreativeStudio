import { CHAPTER_NARRATIVE_FUNCTIONS, type StoryArcBundle, type StoryArcContextReceipt, type StoryArcRebaseTarget } from "../application/story-arc";
import { ARC_PLAN_CHECK_DIMENSIONS, CHAPTER_PLAN_CHECK_DIMENSIONS, storyArcAuthorityPaths, type StoryArcReviewOutput } from "../application/story-arc-review-policy";
import type { NarrativeStateSnapshot } from "../protocol";

export { validateStoryArcReview } from "../application/story-arc-review-policy";
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
    threadResponsibilities: { type: "array", items: { type: "object", additionalProperties: false, required: ["threadRef", "responsibility", "nextAdvance"], properties: { threadRef: { type: "string", minLength: 1 }, responsibility: { type: "string", minLength: 1 }, nextAdvance: { type: "string", minLength: 1 } } } },
    foreshadowingRefs: { type: "array", items: { type: "string" } },
    expectedChapterCount: { type: "integer", minimum: 1, maximum: 80 },
    phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "objective"], properties: { title: { type: "string" }, objective: { type: "string" } } } },
  },
} as const;

const storyArcBatchSchema = {
  type: "object", additionalProperties: false, required: ["batchIndex", "startChapterIndex", "complete"],
  properties: { batchIndex: { type: "integer", minimum: 1 }, startChapterIndex: { type: "integer", minimum: 1 }, complete: { type: "boolean" } },
} as const;

const storyArcChaptersSchema = {
  type: "array", minItems: 1, maxItems: 16,
  items: {
    type: "object", additionalProperties: false,
    required: ["index", "title", "narrativeFunction", "povCharacterId", "stateTransition", "scenes", "continuityConstraints", "unresolvedAtClose"],
    properties: {
      index: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1 },
      narrativeFunction: { enum: [...CHAPTER_NARRATIVE_FUNCTIONS, "unspecified"] }, povCharacterId: { type: "string" },
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

export const storyArcReviewSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "summary", "issues", "chapterChecks", "arcChecks", "authorityChecks"],
  properties: {
    verdict: { enum: ["passed", "revise", "blocked"] }, summary: { type: "string" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence", "suggestion"], properties: { severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, evidence: { type: "string" }, suggestion: { type: "string" } } } },
    chapterChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["chapterIndex", "dimension", "verdict", "evidence", "reason"], properties: { chapterIndex: { type: "integer" }, dimension: { enum: CHAPTER_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string" }, reason: { type: "string" } } } },
    arcChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["dimension", "verdict", "evidence", "reason"], properties: { dimension: { enum: ARC_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string" }, reason: { type: "string" } } } },
    authorityChecks: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["chapterIndex", "verdict", "unresolvedAtClose", "checkedPaths", "candidateClaims", "frozenEvidence", "certaintyUpgrades", "reason"], properties: { chapterIndex: { type: "integer" }, verdict: { enum: ["passed", "revise", "blocked"] }, unresolvedAtClose: { type: "array", items: { type: "string" } }, checkedPaths: { type: "array", minItems: 1, items: { type: "string" } }, candidateClaims: { type: "array", minItems: 1, items: { type: "string" } }, frozenEvidence: { type: "array", minItems: 1, items: { type: "string" } }, certaintyUpgrades: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidateClaim", "frozenBoundary", "reason"], properties: { candidateClaim: { type: "string" }, frozenBoundary: { type: "string" }, reason: { type: "string" } } } }, reason: { type: "string" } } } },
  },
} as const;

export type StoryArcPromptInput = {
  projectTitle: string;
  authorIntent?: string;
  macro: Array<{ taskKey: string; title: string; summary: string }>;
  recentChapters: Array<{ order: number; summary: string; unresolvedThreads: string[]; emotionalArc?: string }>;
  openThreads: Array<{ id: string; title: string; payload: Record<string, unknown> }>;
  openForeshadowings?: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string; plantedRevisionId: string }>;
  openPromises?: Array<{ id: string; promiser: string; promisee: string; statement: string; sourceRevisionId: string }>;
  planningFeedback?: Array<{ sourceChapterOrder?: number; targetId: string; underlyingMechanism: string; affectedInputClass: string; boundaries?: string; sourceArtifactId?: string }>;
  narrativeState?: NarrativeStateSnapshot;
  contextReceipt?: StoryArcContextReceipt;
};

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
  ].join("\n");
  const open = [
    `开放剧情线：${input.openThreads.map((item) => `${item.id} ${item.title}${renderThreadPayload(item.payload)}`).join("\n") || "无"}`,
    `开放伏笔：${input.openForeshadowings?.map(renderOpenForeshadowing).join("\n") || "无"}`,
    `开放承诺：${input.openPromises?.map((item) => `${item.id} ${item.promiser}->${item.promisee}：${item.statement}`).join("\n") || "无"}`,
  ].join("\n");
  const feedback = [
    input.planningFeedback?.length
      ? `近期可迁移的规划反馈（只作为风险信号，不是新增剧情要求）：${input.planningFeedback.map((item) => `${item.targetId}${item.sourceChapterOrder ? `/第${item.sourceChapterOrder}章` : ""}：机制=${item.underlyingMechanism}；影响输入类=${item.affectedInputClass}${item.boundaries ? `；边界=${item.boundaries}` : ""}`).join("\n")}`
      : "近期可迁移的规划反馈：无",
    input.narrativeState ? `最新叙事状态账本：\n${renderNarrativeState(input.narrativeState)}` : "最新叙事状态账本：无",
  ].join("\n\n");
  const receiptText = receipt
    ? `上下文收据：fingerprint=${receipt.fingerprint}；cutoff=${receipt.narrativeCutoff ?? "legacy"}；来源 artifacts=${receipt.sourceArtifactIds.join("、") || "无"}；来源 revisions=${receipt.sourceRevisionIds.join("、") || "无"}`
    : "上下文收据：legacy context，未提供独立来源收据";
  return [
    { id: "arc-context-macro", kind: "planning" as const, title: "故事弧宏观规划", text: macro, priority: "required" as const, provenanceRefs: sourceRefs(receipt, "macro", receipt?.sourceArtifactIds ?? []) },
    { id: "arc-context-recent", kind: "fact" as const, title: "已定稿章节与叙事截止点", text: recent, priority: "required" as const, provenanceRefs: sourceRefs(receipt, "recent", receipt?.sourceRevisionIds ?? []) },
    { id: "arc-context-open-elements", kind: "planning" as const, title: "开放线索、伏笔与承诺候选", text: open, priority: "normal" as const, provenanceRefs: sourceRefs(receipt, "open-elements") },
    { id: "arc-context-feedback-state", kind: "review" as const, title: "机制反馈与叙事状态", text: feedback, priority: "normal" as const, provenanceRefs: sourceRefs(receipt, "feedback-state", receipt?.sourceRevisionIds ?? []) },
    { id: "arc-context-receipt", kind: "background" as const, title: "上下文来源收据", text: receiptText, priority: "normal" as const, provenanceRefs: receipt ? [receipt.fingerprint] : ["legacy-context"] },
  ];
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

function context(input: StoryArcPromptInput): string {
  return [
    `项目：${input.projectTitle}`,
    input.authorIntent ? `作者要求：${input.authorIntent}` : "",
    `全局规划引用：${input.macro.map((item) => `[${item.taskKey}] ${item.title}: ${item.summary}`).join("\n") || "无"}`,
    `最近章节位置：${input.recentChapters.map((item) => `第${item.order}章 ${item.summary}；未解=${item.unresolvedThreads.join("、") || "无"}`).join("\n") || "无"}`,
    `开放剧情线：${input.openThreads.map((item) => `${item.id} ${item.title}${renderThreadPayload(item.payload)}`).join("\n") || "无"}`,
    `开放伏笔：${input.openForeshadowings?.map(renderOpenForeshadowing).join("\n") || "无"}`,
    `开放承诺：${input.openPromises?.map((item) => `${item.id} ${item.promiser}->${item.promisee}：${item.statement}`).join("\n") || "无"}`,
    input.planningFeedback?.length
      ? `近期可迁移的规划反馈（只作为风险信号，不是新增剧情要求）：${input.planningFeedback.map((item) => `${item.targetId}${item.sourceChapterOrder ? `/第${item.sourceChapterOrder}章` : ""}：机制=${item.underlyingMechanism}；影响输入类=${item.affectedInputClass}${item.boundaries ? `；边界=${item.boundaries}` : ""}`).join("\n")}`
      : "近期可迁移的规划反馈：无",
    input.narrativeState ? `最新叙事状态账本：\n${renderNarrativeState(input.narrativeState)}` : "最新叙事状态账本：无",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcPrompt(input: StoryArcPromptInput): string {
  return [
    "规划一个可滚动推进的故事弧及其第一批连续章节。全书规划只提供承诺、边界和长期方向；故事弧负责把当前状态转成阶段性因果链，章节蓝图只冻结当前因果、状态、事实边界和场景执行材料。",
    "输出必须是 schema 定义的规范蓝图对象：根对象只包含 arc、batch、chapters。场景的 situation、observableActions、opposition、decision、outcome、cost 只填写写作者可转化为现场的处境、动作、阻力、选择、结果和代价；规划器的技术模型、分析步骤或推演理由只能放入 planningRationale，不能混入可观察行动或结果。上下文中的持久化记录、执行状态、文档/修订标识、已批准或已提交的包装对象只是参考证据，不得原样复制到输出。",
    "先写清故事弧入口状态、主要欲望/压力、关键选择、代价、退出状态和新问题；每个阶段都要说明它改变了什么人物选择、关系状态、信息分布、资源条件或读者期待。",
    "主线、支线、人物线、关系线和世界压力线要直接在 threadResponsibilities 中标明本弧责任、交汇/退出条件和未回收承诺，并写清下一推进条件。若某条线本弧暂缓，写清可验证的保持/观察责任和触发条件；没有剧情线时数组为空。不为了填满结构而制造无依据事件，也不提前消费后续答案。",
    "上下文优先级：已定稿事实、叙事状态账本和明确作者边界高于当前故事弧草案；开放线索是待判断的责任与素材，不是本批次必须兑现的事件；规划反馈只用于修复共享机制，不把某一章的表面问题复制成剧情规则。",
    "章节可以推进、停顿、相处、等待、恢复、内省或处理余波，不要求每章新增事件、压力、爽点、主题表达或固定结尾。未指定的表达层由作者自然发挥。",
    "每章填写起始状态、结束状态和可观察证据；状态保持稳定也是合法结果，但必须说明本章承担的体验、关系、理解、条件或余波功能。每个场景填写处境、可观察行动和结果；阻力、选择、代价在自然承担时写清，不用标签代替过程。若需要保留作者侧分析，使用 planningRationale；正文执行上下文不会读取它。没有真实连续性约束时使用空数组，不要为了满足格式虚构内容。",
    "场景设计至少能回答：谁此刻想要什么、什么在阻拦、人物知道什么/不知道什么、有哪些选择与代价、结果如何改变后续；安静场景也要有可感知的注意力、关系温度、理解或处境证据。",
    context(input),
    "只输出 schema 所需 JSON，不输出 Markdown 或解释文字。",
  ].join("\n\n");
}

export function buildStoryArcPlanPrompt(input: StoryArcPromptInput, target?: StoryArcRebaseTarget): string {
  return [
    "只规划故事弧和当前批次，不展开章节。故事弧负责把当前状态转成阶段性因果链，批次只冻结当前章节窗口的位置和是否完成。",
    "输出根对象只包含 arc、batch；上下文中的持久化记录、执行状态、文档/修订标识、已批准或已提交的包装对象只是参考证据，不得原样复制到输出。",
    "先写清故事弧入口状态、主要欲望/压力、关键选择、代价、退出状态和新问题；每个阶段都要说明它改变了什么人物选择、关系状态、信息分布、资源条件或读者期待。",
    "主线、支线、人物线、关系线和世界压力线要直接在 threadResponsibilities 中标明当前责任、交汇/退出条件和未回收承诺。没有剧情线时数组为空，不为了填满结构制造无依据事件，也不提前消费后续答案。",
    "上下文优先级：已定稿事实、叙事状态账本和明确作者边界高于当前故事弧草案；开放线索是待判断的责任与素材，不是本批次必须兑现的事件；规划反馈只用于修复共享机制。",
    `批次位置必须是 batch.batchIndex=${target?.batchIndex ?? 1}、batch.startChapterIndex=${target?.startChapterIndex ?? 1}；${target ? "这是重基线，不能改写目标批次窗口。" : "这是新规划，批次从当前输入上下文确定。"}`,
    context(input),
    target ? `重基线目标（只读）：${JSON.stringify(target)}` : "",
    "只输出 schema 所需 JSON，不输出 Markdown 或解释文字。",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcChaptersPrompt(input: StoryArcPromptInput & { arc: StoryArcBundle["arc"]; batch: StoryArcBundle["batch"] }, target?: StoryArcRebaseTarget): string {
  return [
    `依据故事弧“${input.arc.title}”生成第 ${input.batch.batchIndex} 批章节，叙事序号从 ${input.batch.startChapterIndex} 开始。输出根对象只包含 chapters。`,
    "只展开当前窗口，不把整卷或整本书压缩成章节任务清单；保留后续发展的空间。每章填写起始状态、结束状态和可观察证据；状态保持稳定也是合法结果，但必须说明本章承担的体验、关系、理解、条件或余波功能。",
    "每章都必须完整返回 schema 声明的 index、title、narrativeFunction、povCharacterId、stateTransition、scenes、continuityConstraints、unresolvedAtClose；stateTransition 必须是包含 before、after、evidence 三个非空字符串的对象，不能省略、改名或用摘要替代。narrativeFunction 必须使用 schema 枚举值，不得自造同义标签。",
    "每个场景填写处境、可观察行动和结果；阻力、选择、代价在自然承担时写清，不用标签代替过程。需要保留但不应进入正文的分析方法放入 planningRationale，不要写进 observableActions 或 outcome。没有真实连续性约束时使用空数组，不为了满足格式虚构内容。",
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

export function buildStoryArcBatchPrompt(input: StoryArcPromptInput & { arc: StoryArcBundle["arc"]; batchIndex: number; startChapterIndex: number }): string {
  return buildStoryArcChaptersPrompt({ ...input, batch: { batchIndex: input.batchIndex, startChapterIndex: input.startChapterIndex, complete: false } });
}

export function buildStoryArcReviewPrompt(bundle: StoryArcBundle, contextText: string, rebaseTarget?: StoryArcRebaseTarget): string {
  return [
    "审核故事弧的结构可靠性，不替正文规定审美。先按整弧检查承诺、入口/退出状态、阶段边界、线索责任和终局空间，再逐章检查状态连续、场景因果、人物选择、世界规则压力、知识边界和章节功能。",
    "审核输出必须使用规范枚举值，不使用同义词或自定义标签：verdict 只能是 passed、revise、blocked；issues.severity 只能是 blocker、major、warning；chapterChecks.dimension 只能是 state-continuity、causal-fit、function-fit、authority-boundary；arcChecks.dimension 只能是 arc-boundary、window-rhythm、longform-hierarchy；所有检查 verdict 只能是 passed、revise、blocked。unresolvedAtClose、checkedPaths、candidateClaims、frozenEvidence 必须始终是数组；certaintyUpgrades 的字段必须是 candidateClaim、frozenBoundary、reason。",
    `结构审核必须完整覆盖而不是抽样概括：chapterChecks 对每个章节分别输出四个 dimension，各组合恰好一次（当前为 ${bundle.chapters.length}×${CHAPTER_PLAN_CHECK_DIMENSIONS.length} 条）；arcChecks 对三个 arc dimension 各输出一次；authorityChecks 对每个章节恰好输出一次。authorityChecks 是机器可执行证据账本：请提供每章的 verdict、reason、frozenEvidence 和 certaintyUpgrades；checkedPaths、candidateClaims、unresolvedAtClose 必须存在并按当前蓝图填写，应用层会从候选蓝图确定性归一化这三个覆盖字段，避免动态路径因回显遗漏而丢失。不能用“已检查”或 dimension 摘要代替 authorityChecks，也不能省略任何章节。数量不足或重复都属于审核输出不完整，不等于要求正文增加事件。`,
    "把‘没有事件’与‘没有变化’区分开：安静章节可以通过关系温度、理解、信息分布、资源条件、心理方向或余波完成自身功能；只有在当前功能需要而正文/蓝图没有承载时才报告问题。",
    "检查节奏时看目标、阻力、期待、揭示、结果和余波的波形，以及重复冲突/反转造成的疲劳，不用固定章数、钩子密度、爽点数量或持续升级作为硬标准。",
    "故事弧按批次滚动审核：当 batch.complete=false 或当前章节窗口少于 arc.expectedChapterCount 时，未到达 arc.exitState、后续阶段尚未交汇或长线尚未收束是预期的未决状态，不能仅因未来证据尚未出现而报告 blocker。arcChecks 应检查当前窗口是否与整弧边界、阶段责任和后续空间相容；只有当前窗口改写边界、提前消费答案、破坏责任传递或声称已完成却没有证据时才报告问题。",
    "certaintyUpgrades 只记录证据不足却越过冻结边界的确定性升级，不记录当前章节由 stateTransition、observableActions 或 outcome 直接承载的正常状态推进，也不记录有明确范围和现场证据支持的局部结论。若候选主张被当前章节事实直接支持且没有扩大到人物未知、组织全貌、规则普遍性或未来答案，certaintyUpgrades 必须为空；只有无法由冻结证据和当前可观察材料蕴含的越界主张才填写 candidateClaim、frozenBoundary、reason，并将对应 authority verdict 标为 revise 或 blocked。",
    "对未知物质、装置、痕迹或局部反应执行同一证据边界：湿度、颜色、气味、声音、光亮或接触变化只能支持当下可观察现象，不能单凭一次反应推出用途、成分、机制、追踪/筛选/警示功能或排除某种用途。若蓝图把局部现象写成角色尚未获得的功能结论，必须列为 authority revise，并在修订中保留未知状态。",
    "逆向检查相邻章节的状态：任何跨章节持续的物件、伤势、资源、关系、知识或限制，都必须在前章结束、后章开始和中间转化之间保持同一身份；若后章出现‘没有/重新获得/已经知道’等状态跳变，却没有丢失、转移、消耗、恢复或新证据，按连续性重大问题报告。此规则只约束可验证的状态转化，不要求为每个普通名词建立清单。",
    "检查每个反转、回收和新答案是否有前置证据、行动代价和意义变化；检查每条重要线是否有交汇、退出、暂缓责任或转化原因，避免只在字段中挂名。",
    contextText,
    `故事弧蓝图：${JSON.stringify(bundle)}`,
    `权威路径示例：${bundle.chapters.map((chapter) => storyArcAuthorityPaths(chapter).join("、")).join("；")}`,
    rebaseTarget ? `重基线：${JSON.stringify(rebaseTarget)}` : "",
    rebaseTarget ? "重基线目标中的历史章节可能保留旧版可选场景字段（例如空的 situation 或 observableActions）；这些字段属于冻结兼容数据，不要把它们当作新的正文缺陷或要求虚构补写。对历史章节以 chapterMemory 和 authoritativeFacts 检查状态与事实边界；只有候选蓝图真正新增且没有证据支持的确定性，才报告为问题。" : "",
    "每个问题必须引用实际蓝图字段、章节或场景证据，说明是事实/权威边界、因果承载、章节功能还是审美偏好；只输出 schema JSON。",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcRevisionPrompt(bundle: StoryArcBundle, review: StoryArcReviewOutput, contextText: string, rebaseTarget?: StoryArcRebaseTarget): string {
  return [
    "依据审核证据修订故事弧。先修复承载问题的最低层级：状态和事实边界优先于章节安排，因果与人物选择优先于抽象主题标签，线索责任优先于增加事件。",
    "保留已经成立的人物选择、关系积累、有效证据、未解问题和下层创作空间；不得为了补结构而提前兑现承诺、替人物宣布感情结论、抹平合理未知或覆盖已冻结事实。",
    "不为满足抽象质量标签添加无依据的人物、事件、主题或固定节奏；若问题源于规划缺失，补充可验证的边界、选择、代价、窗口或退出条件，而不是补写正文摘要。",
    "场景的 situation、observableActions、opposition、decision、outcome、cost 只保留写作者可转化为现场的材料；技术模型、分析步骤和推演理由放入 planningRationale，并确保正文执行投影不会消费该字段。",
    contextText,
    `当前蓝图：${JSON.stringify(bundle)}`,
    `审核结果：${JSON.stringify(review)}`,
    rebaseTarget ? `重基线：${JSON.stringify(rebaseTarget)}` : "",
    "只输出完整 schema JSON。",
  ].filter(Boolean).join("\n\n");
}
