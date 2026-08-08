import { randomUUID } from "node:crypto";
import type { Artifact, ExecutionBlueprint, MemoryBundle, Review, ReviewIssue, SkillBundle, SkillExecutionPoint, StageGoalContract, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, memoryClaimPriority, renderChapterExecutionContract, renderNarrativeRhythm, renderSerialContext } from "./chapter-planning-context";
import { compileStageContext } from "../stage-context";
import { reviewerSchema } from "./schemas";
import type { ReviewerOutput } from "./schemas";
import { buildSkillContextSections, skillPromptSection } from "../skill-runtime";
import { normalizeReviewIssueReaderEvidence, READER_RECONSTRUCTION_CONTRACT } from "../reader-reconstruction";

export type ReviewerRole = "structure-reviewer" | "character-reviewer" | "prose-reviewer";

export const REVIEW_ROLE_EXECUTION_POINTS: Record<ReviewerRole, SkillExecutionPoint> = {
  "structure-reviewer": "chapter.review.structure",
  "character-reviewer": "chapter.review.character",
  "prose-reviewer": "chapter.review.prose",
};

const DEFAULT_REVIEW_FOCUS: Record<ReviewerRole, string> = {
  "structure-reviewer": "覆盖 D1 世界观与 D2 故事性：以冻结事实、规划上下文和正文证据审视章节功能、目标/阻力/选择/代价/结果、世界规则与制度压力、时间线、人物知识边界、伏笔/承诺证据和选择后果。区分可验证的连续性或因果问题与审美偏好，不要求每章重复设定、反转或不可逆变化。当「跨章序列证据」显示连续同类功能章节（≥3）或同一状态/物件跨章以相近措辞重述且无恶化、愈合、消耗、转移等可观察增量时，检查是否因此缺少压力推进或回报；只有序列证据与正文共同支持时才报告节奏疲劳或状态重述，不把单个安静章或单次状态保持当作问题。",
  "character-reviewer": "覆盖 D3 群像与 D4 感情线：检查人物是否有独立欲望和能动选择，行动与对白是否符合处境、价值、恐惧和知识边界，声部是否可区分，关系是否通过互动、边界、误解、让步、伤害、照料或共同后果承载。只在正文实际承担相关内容且存在具体问题时报告，不要求每章安排关系变化或感情结论。当「跨章序列证据」显示同一配角连续多章出现但离开主角没有独立欲望、关系、秘密、工作或代价增量时，检查是否只是功能声部；只有证据成立时才报告群像单薄，不要求配角每章都有戏份。",
  "prose-reviewer": `覆盖 D2 故事性中的体验承载与 D5 幽默：以正文证据审视场景是否可感、语言是否具体、叙述距离和 POV 是否稳定、关键情绪/选择是否被摘要跳过、句式与节奏是否形成疲劳、幽默是否来自人物/处境且保留后果。${READER_RECONSTRUCTION_CONTRACT} 专业化、制度化或理论化术语可以构成人物声部，但当连续抽象表达替代身体、环境或即时判断时，检查它是否拉开叙事距离。对技术认知做删除测试：如果删掉某个技术标签后，人物的动作、即时选择、因果结果和不可替代的世界观信息都没有损失，且它只是在给同一体验重新命名，就应报告为局部冗余表达；即使动作仍可复原，这仍然是正文质量问题，readerReconstruction 的 impact 应填 none。相反，单个术语若确实改变当前选择、暴露角色独有认知或承担不可替代的世界观功能，应保留，不要仅因陌生而报告。当「跨章序列证据」显示同一抽象命名（技术/制度比喻）跨章重复出现、且本次出现未承担新选择/新因果/新世界观信息时，报告跨章重复命名，不要为单个陌生术语重复报告。只报告已经造成空泛、重复、跳跃、声部不一致或阅读阻滞的问题，不用固定句式、关键词、字数或章尾形式判定。`,
};

export function reviewExecutionPoint(role: ReviewerRole): SkillExecutionPoint {
  return REVIEW_ROLE_EXECUTION_POINTS[role];
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
    "## 当前审核角色",
    input.role,
    "",
    "## 输出契约",
    "只输出一个对象，键只能是 verdict、score、issues。verdict 必须是字符串 passed、revise 或 blocked：没有实际问题时用 passed；存在已经影响正文的可修复问题时用 revise；只有审核无法继续或存在硬阻塞时用 blocked。score 必须是 0 到 5 的数字，不要输出 passed 布尔字段，也不要把分数写入 verdict。issues 必须是数组。每个 issue 的 severity 只能是 warning、major 或 blocker：warning 表示局部且不阻塞提交的质量问题，major 表示已经实质影响当前章节并需要修订的问题，blocker 表示违反事实、因果、POV 或硬执行合同而不能接受的问题；不要使用 medium、minor、critical 等其他等级。",
    "先判断本角色负责的质量维度在当前章节是否适用；不适用或已经有效时不要为了凑覆盖制造问题。每个 issue 都应提供能说明问题的 excerpt/evidence，并尽量给出最小 revisionRanges；excerpt/evidence 是审校说明，不要求与当前正文逐字一致，也不得因为无法逐字匹配而删除 issue。revisionRanges 的 start/end 是从 1 开始计数的正文段落编号，不是字符位置、token 位置或字节偏移。若描述的是重复或连续机制，revisionRanges 必须覆盖每一处承载同一机制且可安全修改的范围，不能只给一个代表段再把局部修订当作全局修复。description 说明实际损害，rule 描述通用问题机制，suggestion 只给修复方向，不写改写示例。",
    "若问题涉及普通读者无法复原现场，readerReconstruction 必须填写 impact、missingEvidence 和 blockedQuestion；impact 只能原样使用 core/local，missingEvidence 只能原样使用 body/space/object/action/consequence/relationship，不要创造近义标签。blockedQuestion 要说明读者无法判断的具体动作、空间、因果、情绪或关系问题，不能只写‘不通俗’。不涉及该机制时 impact 必须填 none，missingEvidence 留空数组，blockedQuestion 留空字符串（输出 null 会被 schema 拒绝）。core 表示已经影响当前场景的关键行动、选择或结果，severity 至少使用 major；local 才可以使用 warning。",
    "对 prose-reviewer，readerReconstruction 与正文质量问题是两个独立判断：技术标签即使没有阻断动作复原，也可以因为删除后不损失事实、选择、因果或世界观功能而报告局部 warning；不要为了填写 readerReconstruction 把所有文风问题夸大成读者理解阻断。",
    "技术认知不能成为当前动作的唯一主语、唯一动因或唯一后果。同一局部节拍中连续用多个技术模型重新命名同一身体感觉、动作或意志时，保留必要的角色判断，删除不改变行动的重复标签；不要把它们互换成另一组抽象词。",
    "叙事语言降噪检查（prose-reviewer 主责，其他角色可补充）：主角的独特认知（职业思维、专业训练、天赋等）是设定来源——解释他为何能看出常人看不到的规律——不是叙事语言。若正文把机制层概念以职业黑话原词作为叙事主导，连续用专业术语解说身体感觉、动作或意志（叙述者以专业系统比喻重新命名现象、把身体或情绪状态描述为专业故障），属于叙事语言污染，判为 major 并要求转译为题材通用表达或普通读者可读的类比；只有当单个术语承担不可替代的世界观揭示或角色独有认知时才保留，且不能是当前动作的唯一载体。开篇一次性交代主角出身背景是允许的，但不得以此授权全篇技术解说。",
    "结构角色优先寻找状态/因果/功能/世界规则/知识边界证据；人物角色优先寻找欲望、能动性、声部、关系行为和情感变化证据；文风角色优先寻找 POV、具体细节、场景承载、节奏疲劳和幽默后果证据。不要把同一偏好复制成三个 issue。",
    "不要把篇幅、章节必须有新事件、固定钩子、反转、主题、感情线或幽默的出现与否单独当作问题。",
    "",
    "关系、生活、背景、内省或余波章节可以通过过程、理解、关系温度或语言体验成立；只检查当前章节合同和事实边界，不要求每章发生不可逆变化，不提前消费后续规划。",
  ];
  if (input.stageGoal) lines.push("", "## 本轮阶段目标", input.stageGoal.authorInstruction || "无额外作者要求", "验收点：" + (input.stageGoal.acceptanceCriteria.join("；") || "按本角色职责判断"), "允许范围：" + input.stageGoal.allowedChangeScope);
  if (memory.claims.length) lines.push("", "相关冻结事实数量：" + memory.claims.length + "；只以这些来源和正文证据为准。");
  return lines.join("\n");
}

export function buildChapterReviewPromptPackage(input: ReviewPromptInput & { workflowId: string; system: string }): StagePromptPackage {
  const memory = selectReviewerMemory(dedupeNarrativeRhythmMemory(input.memory), input.role);
  const skills = selectReviewerSkills(input.skills, input.role);
  const sections = [
    { id: "review-instruction", kind: "review" as const, title: "审校职责与证据规则", text: reviewInstruction(input, memory), priority: "required" as const, provenanceRefs: ["reviewer:" + input.role] },
    { id: "manuscript", kind: "manuscript" as const, title: "正文", text: buildNumberedDraft(input.text), priority: "critical" as const, provenanceRefs: [input.artifact.id], sourceArtifactId: input.artifact.id },
    ...(input.planningContext ? [{ id: "execution-contract", kind: "planning" as const, title: "章节执行合同", text: renderChapterExecutionContract(input.planningContext), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
    ...(memory.narrativeRhythm ? [{ id: "narrative-rhythm", kind: "planning" as const, title: "连续章节位置", text: renderNarrativeRhythm(memory.narrativeRhythm), priority: "normal" as const, provenanceRefs: [memory.narrativeRhythm.fingerprint] }] : []),
    ...(memory.serialContext ? [{ id: "serial-context", kind: "planning" as const, title: "跨章序列证据", text: renderSerialContext(memory.serialContext), priority: "normal" as const, provenanceRefs: [memory.serialContext.fingerprint] }] : []),
    ...memory.claims.map((claim) => ({ id: "memory:" + claim.id, kind: "fact" as const, title: "相关事实：" + claim.title, text: claim.content, priority: memoryClaimPriority(memory, claim), provenanceRefs: [claim.id, ...claim.sourceRevisionIds] })),
    ...buildSkillContextSections(skills ?? { skills: [] }, skills?.executionPoint ?? reviewExecutionPoint(input.role), "审校 Skill"),
  ];
  const purpose = ({ "structure-reviewer": "review.structure", "character-reviewer": "review.character", "prose-reviewer": "review.prose" } as const)[input.role];
  // review 复用已固化 blueprint 的 maxInputTokens（不追溯 computeTokenBudget 新值）。
  // 修订阶段才需要更高预算（正文+记忆+规划+审核意见，见 activities.ts revise 的 96K 下限）；
  // review 实测上下文低于旧 32K 档，复用旧 blueprint 值不会触发 context-budget-exceeded。
  return compileStageContext({ projectId: input.artifact.projectId, workflowId: input.workflowId, purpose, stage: "review", system: input.system, schema: reviewerSchema, maxInputTokens: input.blueprint.budget.maxInputTokens, reservedOutputTokens: input.blueprint.budget.maxOutputTokens, goal: input.stageGoal, skillManifest: skills?.resolution, sections });
}

export function toReview(params: { artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; output: ReviewerOutput }): Review {
  const issues: ReviewIssue[] = params.output.issues.map((issue) => {
    const normalized = normalizeReviewIssueReaderEvidence(issue);
    return { severity: normalized.severity, title: normalized.title, description: normalized.description, evidence: normalized.excerpt ?? normalized.description, excerpt: normalized.excerpt, paragraph: normalized.paragraph ?? normalized.revisionRanges[0]?.start, revisionRanges: normalized.revisionRanges, rule: normalized.rule, sourceId: normalized.sourceId, suggestion: normalized.suggestion, readerReconstruction: normalized.readerReconstruction };
  });
  return { id: randomUUID(), projectId: params.artifact.projectId, artifactId: params.artifact.id, reviewerId: params.identity + "-" + params.role, identity: params.identity, role: params.role, verdict: params.output.verdict, issues, score: params.output.score, createdAt: Date.now(), artifactFingerprint: params.artifact.fingerprint };
}
