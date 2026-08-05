import type { MemoryBundle, ReviewIssue, SkillBundle, StageGoalContract, StagePromptPackage } from "../protocol";
import type { ChapterPlanningContext } from "../application/story-arc";
import { dedupeNarrativeRhythmMemory, memoryClaimPriority, renderChapterExecutionContract, renderExecutionMemoryClaim, renderNarrativeRhythm } from "./chapter-planning-context";
import { compileStageContext } from "../stage-context";
import { buildSkillContextSections } from "../skill-runtime";

export interface RevisionWindow {
  start: number;
  end: number;
  issues: ReviewIssue[];
}

export interface TargetedRevisionReplacement {
  start: number;
  end: number;
  text: string;
}

export class TargetedRevisionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetedRevisionContractError";
  }
}

type RevisionWindowPromptInput = {
  text: string;
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
  revisionHistory?: RevisionAttempt[];
};

/**
 * 前序修订尝试记录。用于打破修订循环：当同一章节经过多轮修订仍未改善时，
 * 将历史尝试注入提示词，让 LLM 知道哪些策略已经失败，避免重复。
 *
 * 根因：修订 LLM 每轮只看到当前稿 + 当前 issues，不知道前序尝试了什么、
 * 为什么失败。当质量回退导致 draft 和 issues 与上一轮完全相同时，
 * 提示词哈希相同 → LLM 返回相同响应 → 死循环。
 *
 * 修复：注入修订历史改变提示词内容（打破缓存循环），同时引导 LLM
 * 尝试不同策略（打破策略重复）。
 */
export interface RevisionAttempt {
  /** 修订轮次（1-based） */
  iteration: number;
  /** 修订结果 */
  outcome: "accepted" | "reverted-degradation" | "reverted-no-improvement";
  /** 本轮修订针对的 issue 标题列表 */
  targetedIssueTitles: string[];
  /** 基线综合分数（首轮修订时可能为 undefined，因为原始定稿未在本工作流中评分） */
  baselineScore?: number;
  /** 修订后综合分数（回退时为修订稿的分数，非基线分数） */
  revisedScore: number;
  /** 修订尝试的方向摘要（从 authorInstruction / issues 推导） */
  approachSummary: string;
}

export function splitChapterParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
}

/**
 * 清理修订 LLM 输出中的指令文本泄漏。
 *
 * 根因：部分修订模型在生成时会将 system prompt 或 instruction 中的
 * 指令结构回显到正文开头，例如短角色前缀、指令说明和冒号组成的非叙事行。
 * 这些前缀不是小说正文，必须剥离，否则会污染提交的章节文本。
 *
 * 清理策略（按顺序应用）：
 * 1. 剥离 Markdown 代码围栏（```...```）
 * 2. 逐行扫描开头：用结构化启发式判断是否为元注释/指令回显（而非精确短语匹配），
 *    跳过所有被判定为非正文的行，直到遇到第一个正文行
 * 3. 剥离残留的行内指令前缀
 * 4. 再次剥离可能因前缀清理暴露的 Markdown 围栏
 *
 * 设计原则：基于行的结构特征（长度、标点模式、冒号位置）判断是否为元注释，
 * 而非匹配特定短语。这样可跨 prompt、genre、指令措辞通用。
 * 如果无法确定前缀边界，保守地保留原文，避免误删正文。
 */

/**
 * 基于结构特征判断一行是否为元注释/指令回显，而非正文。
 *
 * 启发式规则（按优先级）：
 * - Markdown 标题行（# 开头）
 * - 短行以冒号结尾（元注释标题模式）
 * - 冒号分隔的短前缀且前缀不含叙事标点（指令回显模式）
 * - 极短行以句号结尾且不含叙事内容（角色确认模式）
 *
 * 这些规则基于元注释的通用结构形态，不依赖特定短语，
 * 因此可跨 prompt 版本、genre 和指令措辞复用。
 *
 * TODO P3: 阈值（30/18/10/5）基于经验校准，未来可提取为可配置参数。
 */
function isLikelyMetaAnnotation(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Markdown 标题
  if (/^#{1,3}\s+\S/.test(trimmed)) return true;

  // 短行以冒号结尾（元注释标题：≤30 字符）
  if (trimmed.length <= 30 && /[:：]\s*$/.test(trimmed)) return true;

  // 冒号分隔的指令回显：前缀短且不含叙事标点（句号/感叹号/省略号/破折号）
  const colonMatch = trimmed.match(/^([^\n:：]{2,24})[:：]\s*(.*)$/);
  if (colonMatch) {
    const prefix = colonMatch[1];
    if (prefix.length <= 18 && !/[。！？…—]/.test(prefix)) return true;
  }

  return false;
}

export function sanitizeRevisionOutput(text: string): string {
  let cleaned = text;

  // 1. 剥离 Markdown 代码围栏
  cleaned = cleaned.replace(/^```[^\n]*\n?/u, "").replace(/\n?```\s*$/u, "");

  // 2. 逐行检查：用结构化启发式判断开头若干行是否为元注释
  const lines = cleaned.split("\n");
  let firstContentLineIndex = 0;
  const maxPrefixLines = Math.min(5, lines.length);
  for (let index = 0; index < maxPrefixLines; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      firstContentLineIndex = index + 1;
      continue;
    }
    if (isLikelyMetaAnnotation(line)) {
      firstContentLineIndex = index + 1;
      continue;
    }
    // 遇到第一个正文行，停止扫描
    break;
  }

  if (firstContentLineIndex > 0) {
    cleaned = lines.slice(firstContentLineIndex).join("\n").trimStart();
  }

  // 3. 剥离残留的行内指令前缀（冒号分隔的短前缀 + 空行/换行）
  cleaned = cleaned.replace(/^[^\n:：]{2,18}[:：]\s*\n?/u, "");

  // 4. 再次剥离可能因前缀清理暴露的 Markdown 围栏
  cleaned = cleaned.replace(/^```[^\n]*\n?/u, "").replace(/\n?```\s*$/u, "");

  // 局部修订模型有时会把相邻原文段落重复回显。只折叠相邻的完全重复段落，
  // 保留非连续或有实际变化的复沓，避免用作品/提示词短语黑名单干预正常修辞。
  const paragraphs = cleaned.split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const deduplicated: string[] = [];
  for (const paragraph of paragraphs) {
    const previous = deduplicated.at(-1);
    if (previous && previous.replace(/\s+/gu, " ") === paragraph.replace(/\s+/gu, " ")) continue;
    deduplicated.push(paragraph);
  }
  cleaned = deduplicated.join("\n\n");

  return cleaned.trim();
}

function locatedRanges(issue: ReviewIssue, paragraphs: string[]): Array<{ start: number; end: number }> {
  if (issue.revisionRanges?.length) {
    const ranges = issue.revisionRanges
      .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 1 && range.end >= range.start && range.end <= paragraphs.length)
      .map((range) => ({ start: range.start - 1, end: range.end - 1 }));
    if (ranges.length) return ranges;
  }
  if (typeof issue.paragraph === "number" && issue.paragraph >= 1 && issue.paragraph <= paragraphs.length) {
    return [{ start: issue.paragraph - 1, end: issue.paragraph - 1 }];
  }
  // Excerpt/evidence is descriptive only; without an explicit range, let the caller choose full-chapter or manual handling.
  return [];
}

export function planRevisionWindows(text: string, issues: ReviewIssue[]): RevisionWindow[] {
  const paragraphs = splitChapterParagraphs(text);
  const candidates = issues.flatMap((issue) => locatedRanges(issue, paragraphs).map((range) => ({ ...range, issue })));
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const windows: RevisionWindow[] = [];
  for (const candidate of candidates) {
    const previous = windows.at(-1);
    if (previous && candidate.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, candidate.end);
      if (!previous.issues.includes(candidate.issue)) previous.issues.push(candidate.issue);
    } else {
      windows.push({ start: candidate.start, end: candidate.end, issues: [candidate.issue] });
    }
  }
  return windows;
}

export function revisionWindowsCoverAllIssues(windows: RevisionWindow[], issues: ReviewIssue[]): boolean {
  const covered = new Set(windows.flatMap((window) => window.issues));
  return issues.every((issue) => covered.has(issue));
}

export function shouldUseRevisionWindows(input: { requiresFullRevision: boolean; authorInstruction?: string }): boolean {
  return !input.requiresFullRevision;
}

function isContinuityIssue(issue: ReviewIssue): boolean {
  const haystack = [issue.rule, issue.title].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes("continuity") || haystack.includes("连续性") || haystack.includes("一致性");
}

function formatIssues(issues: ReviewIssue[]): string {
  return issues.map((issue, index) => {
    const continuity = isContinuityIssue(issue);
    const typeLabel = continuity ? "一致性约束" : "待修复";
    const lines = [`${index + 1}. [${issue.severity}][${typeLabel}] ${issue.title}`];
    if (issue.rule) lines.push(`问题机制：${issue.rule}`);
    lines.push(
      `问题说明：${issue.description ?? issue.evidence}`,
      `原文证据：${issue.excerpt ?? issue.evidence}`,
      `修订要求：${issue.suggestion ?? "根据证据修复问题，同时保留原段承担的叙事功能。"}`,
    );
    if (continuity) {
      lines.push(
        "⚠️ 一致性约束修订方向：此问题要求文本与已建立设定保持一致，不是更换为新值。",
        "真值确认流程（按优先级）：",
        "  1. 先从「事实与背景边界」中查找已冻结的设定值；",
        "  2. 再从规划上下文、前序章节摘要和记忆库中交叉验证；",
        "  3. 从原文本身的线索（如隐语、角色台词、刻字描写）推断最原始的值；",
        "  4. 若以上均无法确认，保持原文中当前使用的值不变，而非替换为审核者建议的值。",
        "⚠️ 重要警告：审核者描述的'已建立设定值'本身可能是错误的（审核者也可能幻觉）。",
        "  不得直接信任审核者给出的值——必须通过上述真值确认流程独立验证。",
        "  如果审核者说'恢复为X'，但你在事实边界和规划上下文中找不到X的任何记录，X可能是审核者的误判。",
        "不得创造新名称、新事实或新设定来「修复」一致性问题。",
      );
    }
    lines.push("执行边界：必须自行完成实际改写；审核者示例仅供审计，不作为候选正文输入。");
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * 审核问题解读指引：桥接文学批评语言到具体修订动作。
 *
 * 根因：reviewer 用"POV越界""工具化""行动质地"等文学批评术语描述问题，
 * 但修订 LLM 需要从抽象批评推导出具体改法。尤其在窗口修订模式下，
 * LLM 只看到局部文本，更难理解批评背后的文本机制。
 *
 * 解决方案：在提示词中注入解读指引，帮助 LLM 将抽象批评翻译为具体文本机制，
 * 并根据 dimension 字段判断是局部措辞问题还是需要调整叙事策略。
 */
function renderRevisionInterpretationGuide(strictWindows: boolean): string {
  return [
    "审核问题描述的是可核对的文本问题，不是需要逐项遵守的文学公式。",
    "先根据 evidence、excerpt 和 revisionRanges 定位问题机制，再决定改变哪些文本。",
    "修订必须解决问题本身，同时保留原段承担的事实、因果、人物选择和有效表达；不要用抽象解释、无关润色或新增设定替代修复。",
    "若问题涉及现场感、抽象表达或叙述距离，先检查候选是否提供至少两类相互独立的可观察锚点：具体身体/感官状态，以及接触、阻力、空间关系或动作后的状态变化。抽象判断可以保留为 POV 声部，但不能独自承担体验或选择；技术认知应建立在已经发生的感官或动作之上，并导向下一步即时判断。",
    "修订完成后按窗口自检：读者能否仅凭正文复原人物身处何处、身体或物件发生了什么、这如何改变下一步动作？若不能，继续补足现场证据，而不是再换一组抽象词。",
    "章末未解列表是冻结边界：局部修订不得删除、回答或合并其中的问题；若目标段承载未解线索，只能在保留其未解状态的前提下具象化表达。",
    "如果审核者给出的事实或动机与冻结事实、规划上下文或原文线索冲突，优先核对来源；无法确认时保持原文事实，不创造新值。",
    ...(strictWindows ? [
      "",
      "窗口修订只在给定范围内改善问题；若根因超出窗口，不通过新增设定或改写无关段落强行解决。",
    ] : []),
  ].join("\n");
}

/**
 * 渲染前序修订历史，帮助 LLM 避免重复失败策略。
 *
 * 设计原则：
 * - 只记录关键信息（轮次、结果、分数变化、尝试方向），不注入完整正文
 * - 明确告知 LLM "必须尝试不同策略"，打破策略重复
 * - 历史为空时返回空字符串，不影响首次修订
 */
function renderRevisionHistory(history: RevisionAttempt[]): string {
  if (!history.length) return "";
  const lines: string[] = [
    "## 前序修订记录（避免重复策略）",
    "",
    "以下前序修订尝试均未成功改善质量。本轮修订必须尝试与前序轮次根本不同的策略。",
    "如果前序修订因「质量退化」回退，说明修订引入了新问题或丢失了原文有效内容——",
    "本轮应缩小改动范围或改变改动方向，而非重复同样的修改逻辑。",
    "",
  ];
  for (const attempt of history) {
    const outcomeLabel = attempt.outcome === "accepted"
      ? "已采纳"
      : attempt.outcome === "reverted-degradation"
        ? "因质量退化回退"
        : "因无改善回退";
    lines.push(`### 第 ${attempt.iteration} 轮修订 — 结果：${outcomeLabel}`);
    const scoreLine = attempt.baselineScore !== undefined
      ? `- 分数变化：${attempt.baselineScore.toFixed(2)} → ${attempt.revisedScore.toFixed(2)}`
      : `- 修订后分数：${attempt.revisedScore.toFixed(2)}（基线分数未知：原始定稿未在本工作流中评分）`;
    lines.push(scoreLine);
    if (attempt.targetedIssueTitles.length) {
      lines.push(`- 针对的问题：${attempt.targetedIssueTitles.join("、")}`);
    }
    if (attempt.approachSummary) {
      lines.push(`- 尝试方向：${attempt.approachSummary}`);
    }
    lines.push("");
  }
  lines.push("**本轮策略要求**：分析前序回退的原因，选择不同的修订路径。例如：");
  lines.push("- 若前序做了大范围重写导致退化 → 本轮尝试局部精准修改");
  lines.push("- 若前序只做了局部修改无法解决结构性问题 → 本轮调整叙事策略");
  lines.push("- 若前序添加了新内容导致新问题 → 本轮不新增内容，只重组现有信息");
  return lines.join("\n");
}

function renderAuthorDirectedMemory(memory: MemoryBundle): string {
  const projected = dedupeNarrativeRhythmMemory(memory);
  const factual = projected.claims.filter((claim) => claim.authority === "approved" || claim.kind === "episodic");
  const background = projected.claims.filter((claim) => !factual.includes(claim));
  return [
    "### 必须保持的已发生事实",
    factual.map((claim) => {
      const projected = renderExecutionMemoryClaim(claim);
      return `- [${claim.authority}/${claim.kind}] ${projected.title}: ${projected.text}`;
    }).join("\n") || "- 无额外事实约束",
    "### 宏观背景索引（软参考）",
    background.map((claim) => `- ${claim.title}`).join("\n") || "- 无",
    "宏观背景只用于避免方向冲突，不要求保留原文的具体表达、对白、场景组织或修辞。",
  ].join("\n");
}

function renderAuthorDirectedPlanningContext(context: ChapterPlanningContext): string {
  return renderChapterExecutionContract(context);
}

function renderRevisionMemorySections(memory: MemoryBundle, authorInstruction?: string): { hard: string; soft: string; hardRefs: string[]; softRefs: string[] } {
  const projected = dedupeNarrativeRhythmMemory(memory);
  const hardClaims = projected.claims.filter((claim) => authorInstruction?.trim()
    ? claim.authority === "approved" || claim.kind === "episodic"
    : memoryClaimPriority(projected, claim) === "required" || claim.authority === "approved" || claim.kind === "episodic");
  const hardIds = new Set(hardClaims.map((claim) => claim.id));
  const softClaims = projected.claims.filter((claim) => !hardIds.has(claim.id));
  const renderClaims = (claims: typeof projected.claims) => claims.map((claim) => {
    const rendered = renderExecutionMemoryClaim(claim);
    return `- [${claim.authority}/${claim.kind}] ${rendered.title}: ${rendered.text}`;
  }).join("\n") || "（无）";
  return {
    hard: renderClaims(hardClaims),
    soft: renderClaims(softClaims),
    hardRefs: hardClaims.flatMap((claim) => [claim.id, ...claim.sourceRevisionIds]),
    softRefs: softClaims.flatMap((claim) => [claim.id, ...claim.sourceRevisionIds]),
  };
}

function renderRevisionPlanningContext(context: ChapterPlanningContext | undefined, authorInstruction?: string): string {
  if (!context) return "## 冻结章节规划上下文\n（历史章节无规划快照。）";
  return authorInstruction?.trim() ? renderAuthorDirectedPlanningContext(context) : renderChapterExecutionContract(context);
}

function renderRevisionRhythm(memory: MemoryBundle): string {
  return [
    "## 连续章节叙事节奏",
    renderNarrativeRhythm(memory.narrativeRhythm),
  ].join("\n");
}

export interface AuthorRevisionAlignment {
  satisfied: boolean;
  summary: string;
  unmetRequirements: string[];
  evidence: string[];
}

export const authorRevisionAlignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["satisfied", "summary", "unmetRequirements", "evidence"],
  properties: {
    satisfied: { type: "boolean" },
    summary: { type: "string", minLength: 1 },
    unmetRequirements: { type: "array", items: { type: "string", minLength: 1 } },
    evidence: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export function buildAuthorRevisionAlignmentPrompt(input: { original: string; candidate: string; authorInstruction: string }): string {
  return [
    "判断候选正文是否实质响应了作者本轮修改要求。作者要求是自然语言目标，需要结合原文和候选的实际阅读效果判断，不做关键词匹配，也不把意见机械解释成绝对禁令。",
    "只有候选在相关叙事选择、人物呈现或表达效果上出现可感知变化，才可判定 satisfied=true；仅修复无关审校问题、删除一处重复或做同义替换不算完成。",
    "若未满足，unmetRequirements 要说明仍未落实的目标及其在候选中的具体表现；evidence 引用或概括可核对的文本证据。",
    "## 作者要求",
    input.authorInstruction.trim(),
    "## 修订前正文",
    input.original,
    "## 候选正文",
    input.candidate,
  ].join("\n\n");
}

function renderAuthorRevisionRepairPrompt(input: {
  original: string;
  candidate: string;
  authorInstruction: string;
  alignment: AuthorRevisionAlignment;
  memory: MemoryBundle;
  planningContext?: ChapterPlanningContext;
}): string {
  return [
    "候选正文未充分响应作者要求。根据独立对齐检查继续修订，输出必须且只能是完整修订后正文。不要解释过程。",
    "## 作者要求",
    input.authorInstruction.trim(),
    "## 未满足项",
    input.alignment.unmetRequirements.map((item, index) => `${index + 1}. ${item}`).join("\n") || input.alignment.summary,
    "## 检查证据",
    input.alignment.evidence.map((item) => `- ${item}`).join("\n") || "- 参照作者要求重新比较原文与候选",
    "## 原始正文（用于确认本轮需要发生的变化）",
    input.original,
    "## 当前候选（在此基础上继续修订）",
    input.candidate,
    "## 事实边界",
    renderAuthorDirectedMemory(input.memory),
    renderRevisionPlanningContext(input.planningContext, input.authorInstruction),
    renderRevisionRhythm(input.memory),
    "完成后自行重新核对作者要求；不要用修复其他问题代替本轮目标。",
  ].join("\n\n");
}

/** Preserve author feedback as natural-language intent; interpretation belongs to the revision model. */
export function buildAuthorRevisionBrief(authorInstruction?: string): string {
  const instruction = authorInstruction?.trim();
  if (!instruction) return "（无作者补充取舍；按审核问题逐项修订即可。）";

  return [
    "## 作者原话（最高优先级）",
    instruction,
    "",
    "## 执行决策",
    "1. 先理解作者想改变的阅读效果、叙事选择和保留边界，不要用关键词表替作者归类，也不要把意见机械改写成绝对禁令。",
    "2. 将作者要求与审校证据合并判断：审校意见指出已知缺陷，作者要求决定本轮方向；两者冲突时以作者明确取舍为准。",
    "3. 自行判断受影响范围。若达到作者目标需要联动多个段落，可以调整所有必要段落，但必须保持冻结事实、章节规划、人物关系、POV 和既定因果。",
    "4. 生成前先形成内部修改计划，生成后逐项核对作者原话；正文必须出现可感知的实质变化，不能只做同义替换。不要输出分析、计划或核对过程。",
  ].join("\n");
}

export function buildFullChapterRevisionPromptPackage(input: {
  projectId: string;
  workflowId: string;
  system: string;
  sourceArtifactId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  goal?: StageGoalContract;
  text: string;
  issues: ReviewIssue[];
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
  authorInstruction?: string;
  revisionHistory?: RevisionAttempt[];
}): StagePromptPackage {
  const contract = [
    "修订下面整章正文，输出必须且只能是完整修订后正文，不使用 Markdown，不解释过程。",
    "逐项落实审核问题；根据问题决定必要改动范围，不得用无关润色或同义替换冒充完成。",
    "保持原文已有的文学品质、文风节奏和有效细节；修订是改善而非重写，未被问题触及的段落应保持原貌。",
    "保留已发生事实、人物关系、POV、章节功能与既定因果，不新增冻结来源没有依据的事实。",
    "最小改动原则：只改动与审核问题直接相关的句子，不重写未触及的段落。修复一个问题时不得引入新问题。",
    "一致性约束处理：审核问题中标注为[一致性约束]的问题，修订方向是确保文本与已建立设定一致（统一为正确值），不是创造新值或更换名称。审核者给出的值可能不准确，必须通过真值确认流程独立验证（事实边界 > 规划上下文 > 原文线索 > 保持原值不变）。",
    "输出前按实际阅读效果核对修订是否实质改善了问题；不要输出分析、计划或核对过程。",
  ].join("\n");
  const historyText = renderRevisionHistory(input.revisionHistory ?? []);
  const memorySections = renderRevisionMemorySections(input.memory, input.authorInstruction);
  return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: "writing.revision",
    stage: "revision",
    system: input.system,
    goal: input.goal,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    skillManifest: input.skills?.resolution,
    sections: [
      { id: "revision-contract", kind: "goal", title: "整章修订契约", text: contract, priority: "critical", provenanceRefs: [input.goal?.id ?? input.sourceArtifactId] },
      ...(input.authorInstruction?.trim() ? [{ id: "author-instruction", kind: "goal" as const, title: "作者原始修改要求", text: input.authorInstruction.trim(), priority: "critical" as const, provenanceRefs: [input.goal?.id ?? input.sourceArtifactId] }] : []),
      { id: "source-manuscript", kind: "manuscript", title: "修订前正文", text: input.text, priority: "critical", provenanceRefs: [input.sourceArtifactId], sourceArtifactId: input.sourceArtifactId },
      { id: "revision-interpretation-guide", kind: "review", title: "审核问题解读指引", text: renderRevisionInterpretationGuide(false), priority: "required", provenanceRefs: ["interpretation-guide"] },
      { id: "review-issues", kind: "review", title: "本轮审核问题", text: formatIssues(input.issues) || "（无结构化审核问题）", priority: input.issues.length ? "required" : "soft", provenanceRefs: input.issues.map((_, index) => `issue:${index}`) },
      ...(historyText ? [{ id: "revision-history", kind: "review" as const, title: "前序修订记录", text: historyText, priority: "required" as const, provenanceRefs: input.revisionHistory!.map((_, index) => `revision-attempt:${index}`) }] : []),
      { id: "revision-facts-hard", kind: "fact", title: "必须保持的事实边界", text: memorySections.hard, priority: "required", provenanceRefs: memorySections.hardRefs.length ? memorySections.hardRefs : [input.memory.id] },
      { id: "revision-facts-soft", kind: "background", title: "宏观背景与软参考", text: memorySections.soft, priority: "normal", provenanceRefs: memorySections.softRefs.length ? memorySections.softRefs : [input.memory.id] },
      ...(input.planningContext ? [{ id: "revision-planning", kind: "planning" as const, title: "冻结章节规划边界", text: renderRevisionPlanningContext(input.planningContext, input.authorInstruction), priority: "required" as const, provenanceRefs: [input.planningContext.fingerprint] }] : []),
      { id: "revision-rhythm", kind: "planning", title: "连续章节叙事节奏", text: renderNarrativeRhythm(input.memory.narrativeRhythm), priority: "normal", provenanceRefs: [input.memory.narrativeRhythm?.fingerprint ?? input.memory.id] },
      ...buildSkillContextSections(input.skills ?? { skills: [] }, "chapter.revision", "修订 Skill"),
    ],
  });
}

export function buildAuthorRevisionRepairPromptPackage(input: {
  projectId: string;
  workflowId: string;
  system: string;
  sourceArtifactId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  goal?: StageGoalContract;
  original: string;
  candidate: string;
  authorInstruction: string;
  alignment: AuthorRevisionAlignment;
  memory: MemoryBundle;
  skills?: SkillBundle;
  planningContext?: ChapterPlanningContext;
}): StagePromptPackage {
  return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: "writing.revision",
    stage: "revision",
    system: input.system,
    goal: input.goal,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    skillManifest: input.skills?.resolution,
    sections: [
      { id: "author-alignment-repair", kind: "manuscript", title: "作者目标未满足项、证据与待修正文", text: renderAuthorRevisionRepairPrompt(input), priority: "critical", provenanceRefs: [input.sourceArtifactId, input.memory.id, input.goal?.id ?? ""] },
      ...buildSkillContextSections(input.skills ?? { skills: [] }, "chapter.revision", "修订 Skill"),
    ],
  });
}

function revisionWindowSharedSections(input: RevisionWindowPromptInput): string[] {
  const memory = dedupeNarrativeRhythmMemory(input.memory).claims.map((claim) => {
    const projected = renderExecutionMemoryClaim(claim);
    return `- [${claim.authority}/${claim.kind}] ${projected.title}: ${projected.text}`;
  }).join("\n") || "（无冻结事实）";
  const historySection = renderRevisionHistory(input.revisionHistory ?? []);
  return [
    "## 审核问题解读指引",
    renderRevisionInterpretationGuide(true),
    ...(historySection ? [historySection] : []),
    "## 作者补充修改要求",
    buildAuthorRevisionBrief(input.authorInstruction),
    "## 冻结事实（只读）",
    memory,
    input.planningContext ? renderChapterExecutionContract(input.planningContext) : "## 冻结章节执行合同\n（历史章节无规划快照。）",
    renderRevisionRhythm(input.memory),
    "## 局部修订契约",
    [
      "1. 保留目标段落承担的事件、信息、POV 和因果；若作者反馈要求减少对白或解释，可把信息改由动作、物象、环境反应或主角观察承载。",
      "2. 必须实际改写问题证据，不得原样返回；根据问题机制自行组织文字，不得套用审核者拟写的句子。",
      "3. 不得新增原文、冻结事实和相邻段落中都不存在的人物、物件、关系、线索或事件。",
      "4. 不得重写或复述相邻段落，不得解释修订过程，不得输出标题、编号、Markdown 或评语。",
      "5. 用至少两类相互独立的可观察证据承载体验：具体身体/感官状态，加上接触、阻力、空间关系或动作后的状态变化。保持自然中文韵律和原有叙述距离。若问题涉及专业化、制度化或理论化抽象表达过密，保留人物的认知特色，但让重复的抽象解释收束为当前身体反应、环境阻力或即时行动依据，不要只把一组术语替换成另一组术语。",
      "6. 作者反馈用于明确本轮取舍；不得借反馈越过目标段落或新增未建立事实。",
      "7. 章末未解列表是冻结边界：不得因局部修订删除、回答或合并其中的问题；若目标段承载未解线索，只能在保留未解状态的前提下具象化表达。",
      "8. 最小改动原则：只改动与审核问题直接相关的句子。标注为[一致性约束]的问题，修订方向是统一为已建立设定值，不是创造新值或更换名称。审核者给出的值可能不准确，必须通过真值确认流程独立验证（事实边界 > 规划上下文 > 原文线索 > 保持原值不变）。",
    ].join("\n"),
  ];
}

export function buildRevisionWindowPromptPackage(input: RevisionWindowPromptInput & {
  window: RevisionWindow;
  projectId: string;
  workflowId: string;
  system: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  goal?: StageGoalContract;
}): StagePromptPackage {
  return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: "writing.revision",
    stage: "revision",
    system: input.system,
    goal: input.goal,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    skillManifest: input.skills?.resolution,
    sections: [{ id: `revision-window:${input.window.start + 1}-${input.window.end + 1}`, kind: "manuscript", title: "局部修订任务、约束与正文", text: renderRevisionWindowPrompt(input), priority: "critical", provenanceRefs: [input.memory.id] }, ...buildSkillContextSections(input.skills ?? { skills: [] }, "chapter.revision", "修订 Skill")],
  });
}

function revisionWindowLocalSections(input: RevisionWindowPromptInput, window: RevisionWindow): string[] {
  const paragraphs = splitChapterParagraphs(input.text);
  const source = paragraphs.slice(window.start, window.end + 1).join("\n\n");
  const before = window.start > 0 ? paragraphs[window.start - 1] : "（无）";
  const after = window.end + 1 < paragraphs.length ? paragraphs[window.end + 1] : "（无）";
  return [
    `修订目标：原章第 ${window.start + 1}-${window.end + 1} 段。你的输出将直接替换这些段落。`,
    "## 必须处理的问题",
    formatIssues(window.issues),
    "## 上一段（只读，不得复述）",
    before,
    "## 待替换段落",
    source,
    "## 下一段（只读，不得复述）",
    after,
  ];
}

function renderRevisionWindowPrompt(input: RevisionWindowPromptInput & { window: RevisionWindow }): string {
  return [...revisionWindowSharedSections(input), ...revisionWindowLocalSections(input, input.window)].join("\n\n");
}

export const targetedRevisionBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["replacements"],
  properties: {
    replacements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "text"],
        properties: {
          start: { type: "integer", minimum: 1 },
          end: { type: "integer", minimum: 1 },
          text: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

function renderTargetedRevisionBatchPrompt(input: RevisionWindowPromptInput & { windows: RevisionWindow[] }): string {
  const outputExample = {
    replacements: input.windows.map((window) => ({
      start: window.start + 1,
      end: window.end + 1,
      text: "该原章范围的替换正文",
    })),
  };
  return [
    "只返回 JSON。逐个修订下列目标窗口，不得合并、扩展或修改原章段号。每项 text 只包含该窗口的替换正文。",
    "## 共享修订上下文（所有窗口共用）",
    ...revisionWindowSharedSections(input),
    ...input.windows.map((window, index) => `## 窗口 ${index + 1}\n${revisionWindowLocalSections(input, window).join("\n\n")}`),
    "## 输出格式",
    `start/end 必须使用上文标明的原章段号，并完整返回以下所有范围：${input.windows.map((window) => `${window.start + 1}-${window.end + 1}`).join("、")}。`,
    JSON.stringify(outputExample),
  ].join("\n\n");
}

export function buildTargetedRevisionBatchPromptPackage(input: RevisionWindowPromptInput & {
  windows: RevisionWindow[];
  projectId: string;
  workflowId: string;
  system: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  goal?: StageGoalContract;
}): StagePromptPackage {
  return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: "writing.revision",
    stage: "revision",
    system: input.system,
    goal: input.goal,
    schema: targetedRevisionBatchSchema as unknown as Record<string, unknown>,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    skillManifest: input.skills?.resolution,
    sections: [{ id: "targeted-revision-batch", kind: "manuscript", title: "共享上下文与局部修订窗口", text: renderTargetedRevisionBatchPrompt(input), priority: "critical", provenanceRefs: [input.memory.id] }, ...buildSkillContextSections(input.skills ?? { skills: [] }, "chapter.revision", "修订 Skill")],
  });
}

export function applyRevisionWindows(text: string, replacements: Array<{ window: RevisionWindow; text: string }>): string {
  const paragraphs = splitChapterParagraphs(text);
  for (const replacement of [...replacements].sort((left, right) => right.window.start - left.window.start)) {
    const replacementParagraphs = splitChapterParagraphs(sanitizeRevisionOutput(replacement.text));
    if (!replacementParagraphs.length) continue;
    paragraphs.splice(replacement.window.start, replacement.window.end - replacement.window.start + 1, ...replacementParagraphs);
  }
  return paragraphs.join("\n\n");
}

export function applyTargetedRevisionReplacements(text: string, windows: RevisionWindow[], replacements: TargetedRevisionReplacement[]): string {
  if (!windows.length) throw new TargetedRevisionContractError("目标意见无法解析出安全修订窗口");
  const allowed = new Map(windows.map((window) => [`${window.start + 1}:${window.end + 1}`, window]));
  const seen = new Set<string>();
  const accepted: Array<{ window: RevisionWindow; text: string }> = [];
  for (const replacement of replacements) {
    const key = `${replacement.start}:${replacement.end}`;
    const window = allowed.get(key);
    if (!window || seen.has(key)) throw new TargetedRevisionContractError(`返回内容不属于目标修订窗口：${replacement.start}-${replacement.end}`);
    seen.add(key);
    if (replacement.text.trim()) accepted.push({ window, text: replacement.text });
  }
  if (seen.size !== allowed.size) throw new TargetedRevisionContractError("AI 未返回全部目标修订窗口");
  if (!accepted.length) throw new TargetedRevisionContractError("AI 未返回有效的目标段落修改");
  const revised = applyRevisionWindows(text, accepted);
  if (revised === text) throw new TargetedRevisionContractError("AI 未实际修改目标段落");
  return revised;
}
