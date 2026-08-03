import { CHAPTER_NARRATIVE_FUNCTIONS, type StoryArcBundle, type StoryArcRebaseTarget } from "../application/story-arc";
import { ARC_PLAN_CHECK_DIMENSIONS, CHAPTER_PLAN_CHECK_DIMENSIONS, storyArcAuthorityPaths, type StoryArcReviewOutput } from "../application/story-arc-review-policy";
import type { NarrativeStateSnapshot } from "../protocol";

export { validateStoryArcReview } from "../application/story-arc-review-policy";
export type { StoryArcReviewOutput } from "../application/story-arc-review-policy";

const sceneSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "participants", "situation", "observableActions", "opposition", "decision", "outcome", "cost"],
  properties: {
    title: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    situation: { type: "string", minLength: 1 },
    observableActions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    opposition: { type: "string" },
    decision: { type: "string" },
    outcome: { type: "string", minLength: 1 },
    cost: { type: "string" },
  },
} as const;

export const storyArcBundleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["arc", "batch", "chapters"],
  properties: {
    arc: {
      type: "object",
      additionalProperties: false,
      required: ["title", "objective", "entryState", "centralConflict", "development", "resolution", "exitState", "plotThreadRefs", "foreshadowingRefs", "expectedChapterCount", "phases", "thematicQuestions"],
      properties: {
        title: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 }, entryState: { type: "string" }, centralConflict: { type: "string" },
        development: { type: "array", items: { type: "string" } }, resolution: { type: "string" }, exitState: { type: "string" },
        plotThreadRefs: { type: "array", items: { type: "string" } }, foreshadowingRefs: { type: "array", items: { type: "string" } },
        expectedChapterCount: { type: "integer", minimum: 1, maximum: 80 }, authorIntent: { type: "string" },
        phases: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "objective", "exitCondition"], properties: { title: { type: "string" }, objective: { type: "string" }, exitCondition: { type: "string" } } } },
        thematicQuestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "question", "opposingPressures", "resolutionWindow"], properties: { id: { type: "string" }, question: { type: "string" }, opposingPressures: { type: "string" }, resolutionWindow: { type: "string" } } } },
      },
    },
    batch: { type: "object", additionalProperties: false, required: ["batchIndex", "startChapterIndex", "complete"], properties: { batchIndex: { type: "integer", minimum: 1 }, startChapterIndex: { type: "integer", minimum: 1 }, complete: { type: "boolean" } } },
    chapters: {
      type: "array", minItems: 1, maxItems: 16,
      items: {
        type: "object", additionalProperties: false,
        required: ["index", "title", "stateTransition", "narrativeFunction", "povCharacterId", "scenes", "continuityConstraints", "unresolvedAtClose"],
        properties: {
          index: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1 },
          narrativeFunction: { enum: CHAPTER_NARRATIVE_FUNCTIONS }, povCharacterId: { type: "string" },
          stateTransition: { type: "object", additionalProperties: false, required: ["before", "after", "evidence"], properties: { before: { type: "string", minLength: 1 }, after: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 } } },
          scenes: { type: "array", minItems: 1, items: sceneSchema },
          continuityConstraints: { type: "array", items: { type: "string" } }, unresolvedAtClose: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export const storyArcReviewSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "summary", "issues", "chapterChecks", "arcChecks", "authorityChecks"],
  properties: {
    verdict: { enum: ["passed", "revise", "blocked"] }, summary: { type: "string" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "title", "evidence", "suggestion"], properties: { severity: { enum: ["blocker", "major", "warning"] }, title: { type: "string" }, evidence: { type: "string" }, suggestion: { type: "string" } } } },
    chapterChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["chapterIndex", "dimension", "verdict", "evidence", "reason"], properties: { chapterIndex: { type: "integer" }, dimension: { enum: CHAPTER_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string" }, reason: { type: "string" } } } },
    arcChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["dimension", "verdict", "evidence", "reason"], properties: { dimension: { enum: ARC_PLAN_CHECK_DIMENSIONS }, verdict: { enum: ["passed", "revise", "blocked"] }, evidence: { type: "string" }, reason: { type: "string" } } } },
    authorityChecks: { type: "array", items: { type: "object", additionalProperties: false, required: ["chapterIndex", "verdict", "unresolvedAtClose", "checkedPaths", "candidateClaims", "frozenEvidence", "certaintyUpgrades", "reason"], properties: { chapterIndex: { type: "integer" }, verdict: { enum: ["passed", "revise", "blocked"] }, unresolvedAtClose: { type: "array", items: { type: "string" } }, checkedPaths: { type: "array", items: { type: "string" } }, candidateClaims: { type: "array", items: { type: "string" } }, frozenEvidence: { type: "array", items: { type: "string" } }, certaintyUpgrades: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidateClaim", "frozenBoundary", "reason"], properties: { candidateClaim: { type: "string" }, frozenBoundary: { type: "string" }, reason: { type: "string" } } } }, reason: { type: "string" } } } },
  },
} as const;

type StoryArcPromptInput = {
  projectTitle: string;
  authorIntent?: string;
  macro: Array<{ taskKey: string; title: string; summary: string }>;
  recentChapters: Array<{ order: number; summary: string; unresolvedThreads: string[]; emotionalArc?: string }>;
  openThreads: Array<{ id: string; title: string; payload: Record<string, unknown> }>;
  narrativeState?: NarrativeStateSnapshot;
};

function context(input: StoryArcPromptInput): string {
  return [
    `项目：${input.projectTitle}`,
    input.authorIntent ? `作者要求：${input.authorIntent}` : "",
    `全局规划引用：${input.macro.map((item) => `[${item.taskKey}] ${item.title}: ${item.summary}`).join("\n") || "无"}`,
    `最近章节位置：${input.recentChapters.map((item) => `第${item.order}章 ${item.summary}；未解=${item.unresolvedThreads.join("、") || "无"}`).join("\n") || "无"}`,
    `开放线索：${input.openThreads.map((item) => `${item.id} ${item.title}`).join("、") || "无"}`,
    input.narrativeState ? `叙事状态：${JSON.stringify(input.narrativeState)}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcPrompt(input: StoryArcPromptInput): string {
  return [
    "规划一个可滚动推进的故事弧及其第一批连续章节。全书规划只提供承诺、边界和长期方向；故事弧负责把当前状态转成阶段性因果链，章节蓝图只冻结当前因果、状态、事实边界和场景执行材料。",
    "先写清故事弧入口状态、主要欲望/压力、关键选择、代价、退出状态和新问题；每个阶段都要说明它改变了什么人物选择、关系状态、信息分布、资源条件或读者期待。",
    "主线、支线、人物线、关系线和世界压力线要标明当前责任、交汇/退出条件和未回收承诺；不为了填满结构而制造无依据事件，也不提前消费后续答案。",
    "章节可以推进、停顿、相处、等待、恢复、内省或处理余波，不要求每章新增事件、压力、爽点、主题表达或固定结尾。未指定的表达层由作者自然发挥。",
    "每章填写起始状态、结束状态和可观察证据；状态保持稳定也是合法结果，但必须说明本章承担的体验、关系、理解、条件或余波功能。每个场景填写处境、可观察行动和结果；阻力、选择、代价在自然承担时写清，不用标签代替过程。",
    "场景设计至少能回答：谁此刻想要什么、什么在阻拦、人物知道什么/不知道什么、有哪些选择与代价、结果如何改变后续；安静场景也要有可感知的注意力、关系温度、理解或处境证据。",
    context(input),
    "只输出 schema 所需 JSON，不输出 Markdown 或解释文字。",
  ].join("\n\n");
}

export function buildStoryArcRebasePrompt(input: StoryArcPromptInput & { target: StoryArcRebaseTarget }): string {
  return [
    "在不改写已定稿事实、因果结果、状态边界和未解事项的前提下，重建故事弧蓝图。历史章节只允许复用冻结数据，未来章节可以补充尚未冻结的执行细节。",
    buildStoryArcPrompt(input),
    `重基线目标：${JSON.stringify(input.target)}`,
  ].join("\n\n");
}

export function buildStoryArcBatchPrompt(input: StoryArcPromptInput & { arc: StoryArcBundle["arc"]; batchIndex: number; startChapterIndex: number }): string {
  return [
    `为故事弧“${input.arc.title}”生成第 ${input.batchIndex} 批章节，叙事序号从 ${input.startChapterIndex} 开始。`,
    "只展开当前窗口，不把整卷或整本书压缩成章节任务清单；保留后续发展的空间。",
    buildStoryArcPrompt(input),
  ].join("\n\n");
}

export function buildStoryArcReviewPrompt(bundle: StoryArcBundle, contextText: string, rebaseTarget?: StoryArcRebaseTarget): string {
  return [
    "审核故事弧的结构可靠性，不替正文规定审美。先按整弧检查承诺、入口/退出状态、阶段边界、线索责任和终局空间，再逐章检查状态连续、场景因果、人物选择、世界规则压力、知识边界和章节功能。",
    "把‘没有事件’与‘没有变化’区分开：安静章节可以通过关系温度、理解、信息分布、资源条件、心理方向或余波完成自身功能；只有在当前功能需要而正文/蓝图没有承载时才报告问题。",
    "检查节奏时看目标、阻力、期待、揭示、结果和余波的波形，以及重复冲突/反转造成的疲劳，不用固定章数、钩子密度、爽点数量或持续升级作为硬标准。",
    "检查每个反转、回收和新答案是否有前置证据、行动代价和意义变化；检查每条重要线是否有交汇、退出、暂缓责任或转化原因，避免只在字段中挂名。",
    contextText,
    `故事弧蓝图：${JSON.stringify(bundle)}`,
    `权威路径示例：${bundle.chapters.map((chapter) => storyArcAuthorityPaths(chapter).join("、")).join("；")}`,
    rebaseTarget ? `重基线：${JSON.stringify(rebaseTarget)}` : "",
    "每个问题必须引用实际蓝图字段、章节或场景证据，说明是事实/权威边界、因果承载、章节功能还是审美偏好；只输出 schema JSON。",
  ].filter(Boolean).join("\n\n");
}

export function buildStoryArcRevisionPrompt(bundle: StoryArcBundle, review: StoryArcReviewOutput, contextText: string, rebaseTarget?: StoryArcRebaseTarget): string {
  return [
    "依据审核证据修订故事弧。先修复承载问题的最低层级：状态和事实边界优先于章节安排，因果与人物选择优先于抽象主题标签，线索责任优先于增加事件。",
    "保留已经成立的人物选择、关系积累、有效证据、未解问题和下层创作空间；不得为了补结构而提前兑现承诺、替人物宣布感情结论、抹平合理未知或覆盖已冻结事实。",
    "不为满足抽象质量标签添加无依据的人物、事件、主题或固定节奏；若问题源于规划缺失，补充可验证的边界、选择、代价、窗口或退出条件，而不是补写正文摘要。",
    contextText,
    `当前蓝图：${JSON.stringify(bundle)}`,
    `审核结果：${JSON.stringify(review)}`,
    rebaseTarget ? `重基线：${JSON.stringify(rebaseTarget)}` : "",
    "只输出完整 schema JSON。",
  ].filter(Boolean).join("\n\n");
}
