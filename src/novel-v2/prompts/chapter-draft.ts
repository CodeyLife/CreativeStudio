import type { Artifact, ExecutionBlueprint, MemoryBundle, NovelIntent, SkillBundle, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, renderChapterExecutionContract, renderExecutionMemoryClaim, renderNarrativeRhythm } from "./chapter-planning-context";
import { buildBlueprintSummary } from "./chapter-review";
import { compileStageContext } from "../stage-context";
import { buildSkillContextSections, skillPromptSection } from "../skill-runtime";

export interface DraftPromptInput {
  intent: NovelIntent;
  blueprint: ExecutionBlueprint;
  memory: MemoryBundle;
  skills: SkillBundle;
  planningContext?: ChapterPlanningContext;
  /** 历史调用可继续传入；新的正文提示词不消费全书规划全文。 */
  foundationArtifacts?: Artifact[];
  instructionsOnly?: boolean;
}

function renderFoundationValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return JSON.stringify(value);
}

function renderFoundationProjection(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const characters = Array.isArray(data.characters) ? data.characters : [];
  for (const item of characters) {
    if (!item || typeof item !== "object") continue;
    const character = item as Record<string, unknown>;
    if (typeof character.name === "string") lines.push(`人物：${character.name}`);
    const voice = character.voiceAnchor;
    if (voice && typeof voice === "object") lines.push(`声部锚点：${Object.entries(voice).map(([key, value]) => `${key}=${renderFoundationValue(value)}`).join("；")}`);
    const action = character.independentAction;
    if (action && typeof action === "object") lines.push(`独立行动：${Object.entries(action).map(([key, value]) => `${key}=${renderFoundationValue(value)}`).join("；")}`);
  }
  const positioning = data.positioning && typeof data.positioning === "object" ? data.positioning as Record<string, unknown> : undefined;
  const brief = data.creativeBrief && typeof data.creativeBrief === "object" ? data.creativeBrief as Record<string, unknown> : undefined;
  if (positioning?.targetReader) lines.push(`目标读者：${renderFoundationValue(positioning.targetReader)}`);
  const themeQuestion = positioning?.themeQuestion;
  if (themeQuestion && typeof themeQuestion === "object") {
    const value = themeQuestion as Record<string, unknown>;
    lines.push(value.notApplicable === true ? `主题问题：不适用；理由：${renderFoundationValue(value.rationale)}` : `主题问题：${renderFoundationValue(value)}`);
  }
  const emotionalContract = positioning?.emotionalContract;
  if (emotionalContract && typeof emotionalContract === "object") {
    const value = emotionalContract as Record<string, unknown>;
    lines.push(value.notApplicable === true ? `情感契约：不适用；理由：${renderFoundationValue(value.rationale)}` : `情感契约：${renderFoundationValue(value)}`);
  }
  if (brief?.worldAnchor) lines.push(`研究世界锚点：${renderFoundationValue(brief.worldAnchor)}`);
  if (Array.isArray(brief?.researchNeeds)) lines.push(`研究需求：${brief.researchNeeds.map(renderFoundationValue).join("、")}`);
  if (Array.isArray(brief?.nonNegotiables)) lines.push(`简报不可违背项：${brief.nonNegotiables.map(renderFoundationValue).join("；")}`);
  if (brief?.endingEnvelope) lines.push(`结局边界：${renderFoundationValue(brief.endingEnvelope)}`);
  return lines;
}

/** 供规划审计和历史查看使用的轻量投影，不参与正文提示词。 */
export function buildFoundationContextMarkdown(foundationArtifacts: Artifact[]): string {
  if (!foundationArtifacts.length) return "- 暂无全书规划产出。";
  return foundationArtifacts.map((artifact) => {
    const data = artifact.structuredData ?? {};
    const taskKey = typeof data.taskKey === "string" ? data.taskKey : artifact.taskId;
    const title = typeof data.title === "string" ? data.title : taskKey;
    const summary = renderFoundationValue(data.summary);
    return [`### ${taskKey}：${title}`, summary, ...renderFoundationProjection(data), `artifactId=${artifact.id}`].filter(Boolean).join("\n");
  }).join("\n\n");
}

function renderMemory(memory: MemoryBundle): string {
  const projected = dedupeNarrativeRhythmMemory(memory);
  if (!projected.claims.length) return "- 暂无冻结记忆。";
  return projected.claims.map((claim) => {
    const source = claim.sourceRevisionIds.length ? ` 来源：${claim.sourceRevisionIds.join(",")}` : "";
    return `- [${claim.authority}/${claim.kind}] ${renderExecutionMemoryClaim(claim).title}：${renderExecutionMemoryClaim(claim).text}${source}`;
  }).join("\n");
}

function renderSkills(skills: SkillBundle): string {
  if (!skills.skills.length) return "- 无额外写作技能。";
  return skills.skills.map((skill) => {
    const section = skillPromptSection(skill, "chapter.drafting");
    return section ? `### ${skill.skillId}@${skill.version}\n${section}` : "";
  }).filter(Boolean).join("\n\n") || "- 无额外写作技能。";
}

function renderIntent(intent: NovelIntent): string {
  return [
    `创作目标：${intent.objective.trim() || "完成当前章节"}`,
    intent.constraints?.length ? `作者明确边界：${intent.constraints.join("；")}` : "",
  ].filter(Boolean).join("\n");
}

function buildWritingContract(): string {
  return [
    "只输出连续的小说正文，不输出标题、Markdown、作者说明、审核意见、指令回显或元注释。",
    "遵守冻结事实、当前 POV、人物知识边界和已确定的因果状态；未知信息只能通过正文中真实发生的告知、观察或推断获得。",
    "完成当前章节执行合同，但把它转化为自然的场景、行动、对白和体验，不逐条复述规划，也不添加合同外的事实。",
    "状态可以保持稳定；关系、理解、情绪、资源、知识或处境的细微变化同样可以构成章节完成感。",
    "在体验自然完成的位置收束，保留必要的铺陈、内省和余波，不按固定字数、段落数量、钩子类型或节奏公式停笔。",
  ].join("\n");
}

export function buildChapterDraftPrompt(input: DraftPromptInput): string {
  const sections = [
    buildWritingContract(),
    "",
    "## 当前章节执行合同",
    input.planningContext ? renderChapterExecutionContract(input.planningContext) : "未提供章节合同；只依据冻结事实和作者目标写作。",
    "",
    "## 工作流蓝图引用",
    buildBlueprintSummary(input.blueprint, input.planningContext),
  ];
  if (input.instructionsOnly) return sections.join("\n");
  sections.push(
    "",
    "## 作者目标",
    renderIntent(input.intent),
    "",
    "## 冻结事实与记忆",
    renderMemory(input.memory),
    "",
    "## 连续章节位置",
    renderNarrativeRhythm(input.memory.narrativeRhythm),
    "",
    "## 写作技能",
    renderSkills(input.skills),
  );
  return sections.join("\n");
}

export function dedupeDraftMemory(input: DraftPromptInput): MemoryBundle {
  const rhythmMemory = dedupeNarrativeRhythmMemory(input.memory);
  const directArtifactIds = new Set((input.foundationArtifacts ?? []).map((artifact) => artifact.id));
  const claims = rhythmMemory.claims.filter((claim) => !claim.sourceArtifactId || !directArtifactIds.has(claim.sourceArtifactId));
  if (claims.length === rhythmMemory.claims.length) return rhythmMemory;
  return { ...rhythmMemory, id: `${input.memory.id}:draft-projection`, claims };
}

export function buildChapterDraftPromptPackage(input: DraftPromptInput & { workflowId: string; system: string }): StagePromptPackage {
  const memory = dedupeDraftMemory(input);
  const instruction = buildWritingContract();
  const sections = [
    { id: "draft-contract", kind: "goal" as const, title: "正文写作契约", text: instruction, priority: "critical" as const, provenanceRefs: [input.intent.id] },
    ...(input.planningContext ? [{ id: "execution-contract", kind: "planning" as const, title: "章节执行合同", text: renderChapterExecutionContract(input.planningContext), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
    { id: "blueprint", kind: "blueprint" as const, title: "工作流蓝图引用", text: buildBlueprintSummary(input.blueprint, input.planningContext), priority: "normal" as const, provenanceRefs: [input.blueprint.id] },
    ...memory.claims.map((claim) => ({ id: `memory:${claim.id}`, kind: "fact" as const, title: `冻结事实：${claim.title}`, text: renderExecutionMemoryClaim(claim).text, priority: claim.authority === "approved" || claim.authority === "author" ? "required" as const : "normal" as const, provenanceRefs: [claim.id, ...claim.sourceRevisionIds] })),
    ...(memory.narrativeRhythm ? [{ id: "narrative-rhythm", kind: "planning" as const, title: "连续章节位置", text: renderNarrativeRhythm(memory.narrativeRhythm), priority: "normal" as const, provenanceRefs: [memory.narrativeRhythm.fingerprint] }] : []),
    ...buildSkillContextSections(input.skills, "chapter.drafting", "写作 Skill"),
  ];
  return compileStageContext({
    projectId: input.intent.projectId,
    workflowId: input.workflowId,
    purpose: "writing.draft",
    stage: "drafting",
    system: input.system,
    maxInputTokens: input.blueprint.budget.maxInputTokens,
    reservedOutputTokens: input.blueprint.budget.maxOutputTokens,
    skillManifest: input.skills.resolution,
    sections,
  });
}
