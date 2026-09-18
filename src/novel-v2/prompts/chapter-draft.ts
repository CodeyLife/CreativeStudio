import type { Artifact, ExecutionBlueprint, MemoryBundle, NovelIntent, SkillBundle, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, DEFAULT_TARGET_WORD_COUNT, memoryClaimPriority, renderChapterExecutionContract, renderExecutionMemoryClaim, renderNarrativeRhythm, renderSerialContext } from "./chapter-planning-context";
import { buildBlueprintSummary } from "./chapter-review";
import { compileStageContext } from "../stage-context";
import { buildSkillContextSections } from "../skill-runtime";
import { READER_RECONSTRUCTION_CONTRACT } from "../reader-reconstruction";

export interface DraftPromptInput {
  intent: NovelIntent;
  blueprint: ExecutionBlueprint;
  memory: MemoryBundle;
  skills: SkillBundle;
  planningContext?: ChapterPlanningContext;
  /** 历史调用可继续传入；新的正文提示词不消费全书规划全文。 */
  foundationArtifacts?: Artifact[];
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

function renderIntent(intent: NovelIntent): string {
  return [
    `创作目标：${intent.objective.trim() || "完成当前章节"}`,
    intent.constraints?.length ? `作者明确边界：${intent.constraints.join("；")}` : "",
  ].filter(Boolean).join("\n");
}

function buildWritingContract(targetWordCount?: number): string {
  return [
    "只输出连续的小说正文，不输出标题、Markdown、作者说明、审核意见、指令回显或元注释。",
    "遵守冻结事实、当前 POV、人物知识边界和已确定的因果状态；未知信息只能通过正文中真实发生的告知、观察或推断获得。",
    "完成当前章节执行合同，但把它转化为自然的场景、行动、对白和体验，不逐条复述规划，也不添加合同外的事实。",
    READER_RECONSTRUCTION_CONTRACT,
    "状态可以保持稳定；关系、理解、情绪、资源、知识或处境的细微变化同样可以构成章节完成感。",
    "视角降噪：主角的独特认知（职业思维、专业训练、天赋等）是设定——解释他为何能看出常人看不到的规律，不是叙事语言。认知优势通过观察、判断、行动与结果自然体现（如'他敏锐地发现局势中常人难以察觉的规律'），不以专业思维解说或职业黑话外显代替动作与场景。专业隐喻仅作适度点缀，每次出现须承担新的信息、选择或世界观功能；正文是普通读者可读的叙事，不是技术解说。收束段尤其禁止用专业术语堆叠确认认知收获（如以职业术语宣告任务完成、障碍清除、谜团得解）——应转译为体验层表达（首次达成的行动、走通的路、尚未参透的余韵等抽象层级的完成感）。",
    // 2026-09-17 补（docs/novel-v2/ai-taint-diagnosis-20260917.md F3）：上一条规则查的是
    // **词汇**（是否职业黑话/技术标签），而实测的 AI 味载体是**叙述动作**——用世界观内部
    // 完全合法的语汇，替读者把"为什么非得这样做"论证一整段。词汇表可以全是中文且承担
    // 世界观信息，仍读成讲解腔。因此判据必须落在动作上，与词汇表无关。
    "叙述者不替读者论证：人物的选择、规矩或手法，其正当性由行动的过程与后果承担，不由叙述者解释'为什么要这样做'。若一段文字主要在回答'他为什么非得这样'（逐条说明某动作的必要性、某条规矩为何成立、某个数目的最优性、某处失误的机理），而不是'他正在这样做'，就把它改写为该选择被执行的现场——手、眼、物、时间、对方的反应——理由留给读者从后果中推得。判据是删除测试：删掉论证句后，读者对'人物在做什么、他为此付出什么代价'的理解没有减少，那它只是解释，不是叙事。允许制度、行话、术语作为语汇出现并承担世界观信息；本条限制的是叙述者代替人物论证这个**动作**，不是词汇表。",
    `本章目标篇幅约 ${targetWordCount ?? DEFAULT_TARGET_WORD_COUNT} 字（建议性目标：按情节完整自然展开，不因凑字或压字牺牲内容，也不设硬性上限）。`,
    "在体验自然完成的位置收束，保留必要的铺陈、内省和余波，不按固定字数、段落数量、钩子类型或节奏公式停笔。",
  ].join("\n");
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
  const instruction = buildWritingContract(input.planningContext?.chapter?.targetWordCount);
  const sections = [
    { id: "draft-contract", kind: "goal" as const, title: "正文写作契约", text: instruction, priority: "critical" as const, provenanceRefs: [input.intent.id] },
    { id: "author-intent", kind: "goal" as const, title: "作者目标", text: renderIntent(input.intent), priority: "required" as const, provenanceRefs: [input.intent.id] },
    ...(input.planningContext ? [{ id: "execution-contract", kind: "planning" as const, title: "章节执行合同", text: renderChapterExecutionContract(input.planningContext), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
    { id: "blueprint", kind: "blueprint" as const, title: "工作流蓝图引用", text: buildBlueprintSummary(input.blueprint, input.planningContext), priority: "normal" as const, provenanceRefs: [input.blueprint.id] },
    ...memory.claims.filter((claim) => !claim.id.startsWith("foundation:")).map((claim) => ({ id: `memory:${claim.id}`, kind: "fact" as const, title: `冻结事实：${claim.title}`, text: renderExecutionMemoryClaim(claim).text, priority: memoryClaimPriority(memory, claim), provenanceRefs: [claim.id, ...claim.sourceRevisionIds] })),
    // 创作契约与冻结事实分轨（product-audit-20260910 A2）：foundation 段级投影是
    // 规划边界而非逐字事实清单，混在「冻结事实」名下会诱导把规划摘要当既定事实复述，
    // 且以体量垄断事实预算（实测 fact token 97:3）。分轨后仍全部注入，仅归名与角色不同。
    ...(memory.claims.some((claim) => claim.id.startsWith("foundation:")) ? [{
      id: "creative-contract",
      kind: "planning" as const,
      title: "创作契约（已批准规划投影）",
      text: [
        "以下是已批准的全局规划投影，作为创作边界与方向承诺，不是逐字事实清单：与「冻结事实」冲突时以冻结事实为准；正文不得以任何方式违反契约中的既定规则、人物边界与终局约束，但揭示时机由章节执行合同决定。",
        ...memory.claims.filter((claim) => claim.id.startsWith("foundation:")).map((claim) => {
          const projected = renderExecutionMemoryClaim(claim);
          return `- ${projected.title}: ${projected.text}`;
        }),
      ].join("\n"),
      priority: "normal" as const,
      provenanceRefs: memory.claims.filter((claim) => claim.id.startsWith("foundation:")).map((claim) => claim.id),
    }] : []),
    ...(memory.narrativeRhythm ? [{ id: "narrative-rhythm", kind: "planning" as const, title: "连续章节位置", text: renderNarrativeRhythm(memory.narrativeRhythm), priority: "normal" as const, provenanceRefs: [memory.narrativeRhythm.fingerprint] }] : []),
    ...(memory.serialContext ? [{ id: "serial-context", kind: "planning" as const, title: "跨章序列证据", text: renderSerialContext(memory.serialContext), priority: "normal" as const, provenanceRefs: [memory.serialContext.fingerprint] }] : []),
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
