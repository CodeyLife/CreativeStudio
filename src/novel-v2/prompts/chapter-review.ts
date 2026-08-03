import { randomUUID } from "node:crypto";
import type { Artifact, ExecutionBlueprint, MemoryBundle, Review, ReviewIssue, SkillBundle, SkillExecutionPoint, StageGoalContract, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, renderChapterExecutionContract, renderNarrativeRhythm } from "./chapter-planning-context";
import { compileStageContext } from "../stage-context";
import { reviewerSchema } from "./schemas";
import type { ReviewerOutput } from "./schemas";
import { buildSkillContextSections, skillPromptSection } from "../skill-runtime";

export type ReviewerRole = "structure-reviewer" | "character-reviewer" | "prose-reviewer";

export const REVIEW_ROLE_EXECUTION_POINTS: Record<ReviewerRole, SkillExecutionPoint> = {
  "structure-reviewer": "chapter.review.structure",
  "character-reviewer": "chapter.review.character",
  "prose-reviewer": "chapter.review.prose",
};

const DEFAULT_REVIEW_FOCUS: Record<ReviewerRole, string> = {
  "structure-reviewer": "覆盖 D1 世界观与 D2 故事性：以冻结事实、规划上下文和正文证据审视章节功能、目标/阻力/选择/代价/结果、世界规则与制度压力、时间线、人物知识边界、伏笔/承诺证据和选择后果。区分可验证的连续性或因果问题与审美偏好，不要求每章重复设定、反转或不可逆变化。",
  "character-reviewer": "覆盖 D3 群像与 D4 感情线：检查人物是否有独立欲望和能动选择，行动与对白是否符合处境、价值、恐惧和知识边界，声部是否可区分，关系是否通过互动、边界、误解、让步、伤害、照料或共同后果承载。只在正文实际承担相关内容且存在具体问题时报告，不要求每章安排关系变化或感情结论。",
  "prose-reviewer": "覆盖 D2 故事性中的体验承载与 D5 幽默：以正文证据审视场景是否可感、语言是否具体、叙述距离和 POV 是否稳定、关键情绪/选择是否被摘要跳过、句式与节奏是否形成疲劳、幽默是否来自人物/处境且保留后果。只报告已经造成空泛、重复、跳跃、声部不一致或阅读阻滞的问题，不用固定句式、关键词、字数或章尾形式判定。",
};

export function reviewExecutionPoint(role: ReviewerRole): SkillExecutionPoint {
  return REVIEW_ROLE_EXECUTION_POINTS[role];
}

function normalizeReviewText(value: string): string {
  return value.replace(/\s+/gu, "").replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

export function groundReviewerIssues<T extends { excerpt?: string; evidence?: string }>(issues: T[], text: string): { issues: T[]; discardedCount: number } {
  const normalizedText = normalizeReviewText(text);
  const grounded = issues.filter((issue) => {
    const evidence = (issue.excerpt ?? issue.evidence ?? "").trim();
    if (normalizeReviewText(evidence).length < 4) return false;
    const fragments = evidence.split(/(?:…{2,}|\.{3,})/gu).map(normalizeReviewText).filter((fragment) => fragment.length >= 4);
    return fragments.length > 0 && fragments.every((fragment) => normalizedText.includes(fragment));
  });
  return { issues: grounded, discardedCount: issues.length - grounded.length };
}

export function groundReviewForText(review: Review, text: string): Review {
  const grounded = groundReviewerIssues(review.issues, text);
  if (grounded.discardedCount === 0) return review;
  return { ...review, issues: grounded.issues, ...(grounded.issues.length === 0 ? { verdict: "passed" as const, score: undefined } : {}) };
}

export function getReviewFocus(role: ReviewerRole, skills?: SkillBundle): string {
  const base = DEFAULT_REVIEW_FOCUS[role];
  const executionPoint = skills?.executionPoint ?? reviewExecutionPoint(role);
  const additions = (skills?.skills ?? [])
    .map((skill) => skillPromptSection(skill, executionPoint))
    .filter((section): section is string => Boolean(section?.trim()));
  return additions.length ? base + "\n\n## 已解析的审校技能\n" + additions.join("\n\n") : base;
}

export interface ReviewPromptInput {
  role: ReviewerRole;
  artifact: Artifact;
  text: string;
  blueprint: ExecutionBlueprint;
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  stageGoal?: StageGoalContract;
  instructionsOnly?: boolean;
}

export function selectReviewerSkills(skills: SkillBundle | undefined, role: ReviewerRole, _limit = 6): SkillBundle | undefined {
  if (!skills) return undefined;
  const expected = reviewExecutionPoint(role);
  if (skills.executionPoint && skills.executionPoint !== expected) {
    throw new Error("审核 Skill 执行点不匹配：role=" + role + "，expected=" + expected + "，actual=" + skills.executionPoint);
  }
  return { ...skills, id: skills.id + ":" + role };
}

export function selectReviewerMemory(memory: MemoryBundle, role: ReviewerRole): MemoryBundle {
  const claims = memory.claims.filter((claim) => {
    const facets = new Set([claim.matchedFacet, ...(claim.matchedFacets ?? [])]);
    if (role === "structure-reviewer") return facets.has("fact") || facets.has("timeline") || facets.has("foreshadowing") || facets.has("thread") || claim.authority === "approved" || claim.authority === "author";
    if (role === "character-reviewer") return facets.has("entity") || facets.has("relation") || claim.subjectRefs.length > 0;
    return facets.has("style") || facets.has("author-preference") || facets.has("chapter-memory") || claim.kind === "author";
  });
  return { ...memory, id: memory.id + ":" + role, claims };
}

function buildNumberedDraft(text: string): string {
  return text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean).map((paragraph, index) => "### 段落 " + (index + 1) + "\n" + paragraph).join("\n\n");
}

function buildReviewerContext(memory: MemoryBundle): string {
  if (!memory.claims.length) return "- 暂无检索到的相关事实。";
  return memory.claims.map((claim) => "- [" + claim.authority + "/" + claim.kind + "] " + (claim.subjectRefs.join(",") || "未绑定主体") + ": " + claim.title + " - " + claim.content).join("\n");
}

export function buildBlueprintSummary(blueprint: ExecutionBlueprint, planningContext?: ChapterPlanningContext): string {
  const tasks = blueprint.tasks.map((task) => "- " + task.kind + "/" + task.role + " (" + task.queue + ")").join("\n") || "- 无额外任务";
  return [
    "执行蓝图 " + blueprint.id + "，基线修订 " + blueprint.baseRevision + "，提交策略 " + blueprint.commitPolicy,
    planningContext ? "规划上下文指纹 " + planningContext.fingerprint : "未提供规划上下文快照",
    "工作流任务：",
    tasks,
  ].join("\n");
}

function reviewInstruction(input: ReviewPromptInput, memory: MemoryBundle): string {
  const lines = [
    "你是长篇小说的章节审校者。先理解当前章节的执行边界，再阅读正文；只报告已经发生且可以由正文或冻结来源证明的问题。",
    "",
    "## 当前职责",
    getReviewFocus(input.role),
    "",
    "## 输出契约",
    "给本角色负责的整体质量打 0-5 分。没有可定位的问题时返回 passed 和空 issues；问题只在确实影响当前章节功能、事实可靠性或阅读体验时报告。",
    "先判断本角色负责的质量维度在当前章节是否适用；不适用或已经有效时不要为了凑覆盖制造问题。每个 issue 必须引用当前正文中的逐字 excerpt，并给出最小 revisionRanges；无法安全定位时不要报告。description 说明实际损害，rule 描述通用问题机制，suggestion 只给修复方向，不写改写示例。",
    "结构角色优先寻找状态/因果/功能/世界规则/知识边界证据；人物角色优先寻找欲望、能动性、声部、关系行为和情感变化证据；文风角色优先寻找 POV、具体细节、场景承载、节奏疲劳和幽默后果证据。不要把同一偏好复制成三个 issue。",
    "不要把篇幅、章节必须有新事件、固定钩子、反转、主题、感情线或幽默的出现与否单独当作问题。",
    "",
    "关系、生活、背景、内省或余波章节可以通过过程、理解、关系温度或语言体验成立；只检查当前章节合同和事实边界，不要求每章发生不可逆变化，不提前消费后续规划。",
  ];
  if (input.stageGoal) lines.push("", "## 本轮阶段目标", input.stageGoal.authorInstruction || "无额外作者要求", "验收点：" + (input.stageGoal.acceptanceCriteria.join("；") || "按本角色职责判断"), "允许范围：" + input.stageGoal.allowedChangeScope);
  if (memory.claims.length) lines.push("", "相关冻结事实数量：" + memory.claims.length + "；只以这些来源和正文证据为准。");
  return lines.join("\n");
}

export function buildChapterReviewPrompt(input: ReviewPromptInput): string {
  const memory = selectReviewerMemory(dedupeNarrativeRhythmMemory(input.memory), input.role);
  const sections = [reviewInstruction(input, memory)];
  if (input.instructionsOnly) return sections.join("\n");
  sections.push(
    "",
    "## 当前章节执行合同",
    input.planningContext ? renderChapterExecutionContract(input.planningContext) : "未提供章节合同；只依据冻结事实和正文审校，不猜测缺失规划。",
    "",
    "## 连续章节位置",
    renderNarrativeRhythm(memory.narrativeRhythm),
    "",
    "## 工作流蓝图",
    buildBlueprintSummary(input.blueprint, input.planningContext),
    "",
    "## 正文（段落编号仅用于定位）",
    buildNumberedDraft(input.text),
    "",
    "## 相关事实",
    buildReviewerContext(memory),
  );
  return sections.join("\n");
}

export function buildChapterReviewPromptPackage(input: ReviewPromptInput & { workflowId: string; system: string }): StagePromptPackage {
  const memory = selectReviewerMemory(dedupeNarrativeRhythmMemory(input.memory), input.role);
  const skills = selectReviewerSkills(input.skills, input.role);
  const sections = [
    { id: "review-instruction", kind: "review" as const, title: "审校职责与证据规则", text: reviewInstruction(input, memory), priority: "required" as const, provenanceRefs: ["reviewer:" + input.role] },
    { id: "manuscript", kind: "manuscript" as const, title: "正文", text: buildNumberedDraft(input.text), priority: "critical" as const, provenanceRefs: [input.artifact.id], sourceArtifactId: input.artifact.id },
    ...(input.planningContext ? [{ id: "execution-contract", kind: "planning" as const, title: "章节执行合同", text: renderChapterExecutionContract(input.planningContext), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
    ...(memory.narrativeRhythm ? [{ id: "narrative-rhythm", kind: "planning" as const, title: "连续章节位置", text: renderNarrativeRhythm(memory.narrativeRhythm), priority: "normal" as const, provenanceRefs: [memory.narrativeRhythm.fingerprint] }] : []),
    ...memory.claims.map((claim) => ({ id: "memory:" + claim.id, kind: "fact" as const, title: "相关事实：" + claim.title, text: claim.content, priority: "required" as const, provenanceRefs: [claim.id, ...claim.sourceRevisionIds] })),
    ...buildSkillContextSections(skills ?? { skills: [] }, skills?.executionPoint ?? reviewExecutionPoint(input.role), "审校 Skill"),
  ];
  const purpose = ({ "structure-reviewer": "review.structure", "character-reviewer": "review.character", "prose-reviewer": "review.prose" } as const)[input.role];
  return compileStageContext({ projectId: input.artifact.projectId, workflowId: input.workflowId, purpose, stage: "review", system: input.system, schema: reviewerSchema, maxInputTokens: input.blueprint.budget.maxInputTokens, reservedOutputTokens: input.blueprint.budget.maxOutputTokens, goal: input.stageGoal, skillManifest: skills?.resolution, sections });
}

export function toReview(params: { artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; output: ReviewerOutput; text?: string }): Review {
  const grounded = params.text === undefined ? { issues: params.output.issues, discardedCount: 0 } : groundReviewerIssues(params.output.issues, params.text);
  const issues: ReviewIssue[] = grounded.issues.map((issue) => ({ severity: issue.severity, title: issue.title, description: issue.description, evidence: issue.excerpt ?? issue.description, excerpt: issue.excerpt, paragraph: issue.paragraph, revisionRanges: issue.revisionRanges, rule: issue.rule, sourceId: issue.sourceId, suggestion: issue.suggestion }));
  return { id: randomUUID(), projectId: params.artifact.projectId, artifactId: params.artifact.id, reviewerId: params.identity + "-" + params.role, identity: params.identity, role: params.role, verdict: grounded.discardedCount > 0 && issues.length === 0 ? "passed" : params.output.verdict, issues, score: grounded.discardedCount > 0 && issues.length === 0 ? undefined : params.output.score, createdAt: Date.now(), artifactFingerprint: params.artifact.fingerprint };
}
