/**
 * 章节短剧剧本提示词生成（MiniMax H3 Ref2VA 全参考模式）。
 *
 * 设计依据：AGENTS.md 创作支撑层基线 —— 正文定稿后的辅助派生产物，不进正文质量门；
 * 指引层由 chapter.script 执行点上的运行时 Skill（h3-video-prompt）注入 H3 方法论，
 * 本模块只负责结构化契约、结构特征校验与确定性格式组装。
 *
 * 契约：每条片段提示词自包含六段（subject_definitions → non_diegetic_music），
 * 顶层 characters 提供跨片段一致的英文外观基线；模型逐片段书写 subjectDefinitions，
 * 统一性由 prompt 输入端的人物设定摘要与 skill 指引约束，不做章节级定义抽象复用。
 *
 * 流程：
 * 1. getFinalDocumentContentRef 加载已定稿章节正文
 * 2. 从角色规划与实体注册表构建人物事实输入
 * 3. resolveStageSkillBundle(chapter.script) 注入 skill 指引 → generateStructured 调模型
 * 4. 结构特征校验（标签解析、切点时序、对话标记、任务前缀），失败进入 repair 循环
 * 5. 六段按固定顺序组装成最终提示词，落 artifacts(kind=chapter-script)
 */
import { createHash, randomUUID } from "node:crypto";
import type { Artifact, SkillProvider } from "../protocol";
import type { ModelRoutingSnapshot } from "../model-routing";
import type { ModelGateway } from "../model-gateway";
import type { ObjectStoreAdapter } from "../object-store";
import { NovelPostgresRepository } from "../postgres-repository";
import { buildSkillContextSections, resolveStageSkillBundle } from "../skill-runtime";
import { compileStageContext } from "../stage-context";

/** TODO P2: 分段时长上下限与数量上限是运营参数，应来自项目级配置而非硬编码。 */
export const MIN_SEGMENT_SECONDS = 5;
export const MAX_SEGMENT_SECONDS = 10;
export const MAX_SEGMENTS_PER_CHAPTER = 20;
export const MAX_SCRIPT_CHARACTERS = 12;
export const MIN_SEGMENTS_PER_CHAPTER = 6;
/**
 * 剧情覆盖预算：按正文字数推导片段数下限的单段承载字数。
 * 根因：无覆盖契约时模型自由收敛为少数高光片段，章节叙事信息块（背景记忆、
 * 伏笔、期限任务、人物信念转折）会被整块省略；字数→片段数是题材无关的
 * 覆盖性推导，单段承载量属魔法值，宜改为项目级可配置。
 */
export const CHARACTERS_PER_SEGMENT = 350;

export const CHAPTER_SCRIPT_ARTIFACT_KIND = "chapter-script";
export const SCRIPT_EXECUTION_POINT = "chapter.script" as const;

/**
 * 剧本来源不可用错误：携带建议 HTTP 状态码，供 REST/MCP 网关直接映射，
 * 网关不得嗅探错误文案（文案是实现细节，状态码才是跨层契约）。
 */
export class ChapterScriptSourceError extends Error {
  constructor(readonly statusCode: 404 | 409, message: string) {
    super(message);
    this.name = "ChapterScriptSourceError";
  }
}

/**
 * 剧本生成契约版本：参与幂等键。
 * 根因：幂等键只绑定定稿内容哈希时，覆盖/结构契约升级不会使旧产物失效，
 * 同一定稿会永远复用旧契约的片段集合。契约演进（如新增剧情覆盖下限）时递增此值，
 * 同源产物自动失效并按新契约重新生成。
 * v2：剧情覆盖下限（deriveMinSegments + 节拍映射）。
 * v3：plotBeats 节拍清单结构化 + 信息呈现手段校验——背景/设定/钩子类节拍必须用
 *    闪回画面 [Flashback]、台词 <d>（含画外音）或屏幕可读文字承载，
 *    仅靠抱头/颤抖等反应动作不构成呈现（否则观众无法理解剧情）。
 * v4：影视镜头语言契约（方法论沉淀自 .agents/skills/short-drama-writing）——
 *    每镜头四要素（景别/角度/运镜/光线氛围）、片段节奏范式（峰+刹车）、
 *    signature shot 引导（不强制）、题材视觉特效具体化；运行时 skill v1.1.0 同步。
 *    旧产物按此版本号自动失效，重新生成即按新标准。
 * v5：剧集剧作层契约（方法论沉淀自 .agents/skills/short-drama-writing/references/dramaturgy.md）
 *    ——开场即冲突（3 秒钩子形态）、情绪节点节奏（每 2-4 片段一个节点）、
 *    片段出口即钩子（末段冲击瞬间切卡）、台词密度三功能、反转须有已呈现伏笔、
 *    人物经济（核心三角）；属提示层契约，不新增结构校验（节奏类问题无跨题材
 *    可靠结构特征，堆 heuristic 违反泛化优先）；运行时 skill v1.3.0 同步。
 */
export const SCRIPT_CONTRACT_VERSION = "5";

/** 剧情节拍种类：memory/setup/hook 属"信息承载必需"类，需要显式呈现手段。 */
export const PLOT_BEAT_KINDS = ["event", "dialogue", "memory", "setup", "hook", "decision"] as const;
export type PlotBeatKind = (typeof PLOT_BEAT_KINDS)[number];
/** 这些种类的节拍携带观众理解剧情所需的信息，禁止只用反应动作呈现。 */
export const PRESENTATION_REQUIRED_BEAT_KINDS: ReadonlyArray<PlotBeatKind> = ["memory", "setup", "hook"];

export interface PlotBeat {
  id: string;
  kind: PlotBeatKind;
  summary: string;
}

/**
 * 按定稿正文字数推导本章最少片段数：所有承载剧情信息量的节拍都必须映射到片段，
 * 下限只随篇幅伸缩，不引用任何特定章节或题材样本。
 */
export function deriveMinSegments(plainText: string): number {
  const cjkCount = countScriptableCharacters(plainText);
  return Math.max(MIN_SEGMENTS_PER_CHAPTER, Math.min(MAX_SEGMENTS_PER_CHAPTER, Math.ceil(cjkCount / CHARACTERS_PER_SEGMENT)));
}

/** 与 word-count 的中文计数保持一致的轻量副本口径：仅统计 CJK 表意字符。 */
function countScriptableCharacters(text: string): number {
  return (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
}

export interface SharedSubjectPreset {
  /** 逐行定义文本（已剥离可选的 subject_definitions: 头行），每行 `<Subject N> ...` */
  lines: string[];
  /** 共享定义的最大编号；片段新增主体从 maxLabel+1 起续接编号 */
  maxLabel: number;
}

const SHARED_LINE_RE = /^<Subject\s+(\d+)>/u;

/**
 * 解析用户预设的项目级共享定义文本（自由文本域输入）：
 * - 空文本合法（回退到无共享的现状行为）；
 * - 非空时剥离可选的 `subject_definitions:` 头行，逐行校验 `<Subject N>` 行首
 *   且编号从 1 连续递增；错误信息可读，供 REST 400 与前端提示复用。
 */
export function parseSharedSubjectPreset(text: string | undefined): SharedSubjectPreset {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { lines: [], maxLabel: 0 };
  const bodyText = trimmed.replace(/^subject_definitions:\s*/iu, "").trim();
  const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { lines: [], maxLabel: 0 };
  const issues: string[] = [];
  let previous = 0;
  for (const line of lines) {
    const match = SHARED_LINE_RE.exec(line);
    if (!match) {
      issues.push(`行必须以 <Subject N> 开头：${line.slice(0, 40)}`);
      continue;
    }
    const label = Number(match[1]);
    if (label !== previous + 1) issues.push(`编号必须从 1 连续递增：期望 <Subject ${previous + 1}>，实际 <Subject ${label}>`);
    previous = Math.max(previous, label);
  }
  if (issues.length) throw new Error(`共享定义格式校验失败：\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  return { lines, maxLabel: previous };
}

/** 共享定义库的独立导出块（片段不含共享行，由编排者在 H3 生成时前置提供）。 */
export function buildSharedSubjectLibraryText(shared: SharedSubjectPreset): string {
  if (!shared.lines.length) return "";
  return `subject_definitions:\n${shared.lines.join("\n")}`;
}

export interface ChapterScriptCharacterSheet {
  name: string;
  appearanceEn: string;
}

/** 片段六段字段；组装顺序与 Ref2VA 规范一致（subject_definitions → non_diegetic_music）。 */
export interface ChapterScriptSectionFields {
  subjectDefinitions: string;
  summary: string;
  retentionAnalysis: string;
  detailedDescription: string;
  overallSoundscape: string;
  nonDiegeticMusic: string;
}

export interface ChapterScriptSegmentFields extends ChapterScriptSectionFields {
  title: string;
  synopsis: string;
  durationSeconds: number;
  /** 本段承载的剧情节拍（引用顶层 plotBeats 的 id） */
  beatIds: string[];
}

export interface AssembledChapterScriptSegment extends ChapterScriptSegmentFields {
  index: number;
  promptText: string;
}

export interface ChapterScriptModelOutput {
  plotBeats: PlotBeat[];
  characters: ChapterScriptCharacterSheet[];
  segments: ChapterScriptSegmentFields[];
}

export interface ChapterScriptRecord {
  projectId: string;
  documentId: string;
  artifactId: string;
  revisionId?: string;
  sourceFingerprint: string;
  /** true = 同一定稿已生成过，本次复用既有产物 */
  reused?: boolean;
  /** 按正文字数推导的剧情覆盖下限（本次生成使用的值） */
  minSegments?: number;
  /** 模型穷举的剧情节拍清单（审计与覆盖校验依据） */
  plotBeats: PlotBeat[];
  /** 影视镜头语言提示（提示级，不阻断）：缺少运镜/景别描述的镜头清单 */
  cinematicHints: string[];
  /** 本次生成使用的项目级共享定义（独立块文本 + 最大编号）；definitionText 空串表示无共享 */
  sharedSubjects: { definitionText: string; maxLabel: number };
  characters: ChapterScriptCharacterSheet[];
  segments: AssembledChapterScriptSegment[];
}

const SECTION_FIELDS: ReadonlyArray<{ key: keyof ChapterScriptSectionFields; label: string }> = [
  { key: "subjectDefinitions", label: "subject_definitions" },
  { key: "summary", label: "summary" },
  { key: "retentionAnalysis", label: "retention_analysis" },
  { key: "detailedDescription", label: "detailed_description" },
  { key: "overallSoundscape", label: "overall_soundscape" },
  { key: "nonDiegeticMusic", label: "non_diegetic_music" },
];

const REFERENCE_LABEL_RE = /<(Subject|Picture|Video|Audio)\s+(\d+)>/gu;
const LABEL_DEFINITION_LINE_RE = /^<(Subject|Picture|Video|Audio)\s+(\d+)>/u;
const SUMMARY_TASK_PREFIX_RE = /^\[[a-z][a-z ]+( \+ [a-z][a-z ]+)*\]/iu;
const DIALOGUE_PAIR_RE = /<d>([\s\S]*?)<\/d>/gu;
const CODE_FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n?```$/u;

// TODO P2: 以下结构契约阈值（plotBeats maxItems=40、beatIds maxItems=12、id 长度 2-24、
// summary 6-120、appearanceEn 10-600、title 1-24、synopsis≥4、summary≥20、
// detailedDescription≥80、retention/soundscape/music≥1、segments 数组上下限除外——
// 后两者已具名常量）均为魔法值，宜随剧本契约版本化一并改为可配置；
// 当前取值依据 Ref2VA 指南的描述体量（detailed_description 350-500 英文词）
// 与 MCP/REST 单响应约束设定。
export const CHAPTER_SCRIPT_H3_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plotBeats", "characters", "segments"],
  properties: {
    plotBeats: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "summary"],
        properties: {
          id: { type: "string", minLength: 2, maxLength: 24, pattern: "^[A-Za-z0-9_-]+$" },
          kind: { type: "string", enum: [...PLOT_BEAT_KINDS] },
          summary: { type: "string", minLength: 6, maxLength: 120 },
        },
      },
    },
    characters: {
      type: "array",
      maxItems: MAX_SCRIPT_CHARACTERS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "appearanceEn"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 40 },
          appearanceEn: { type: "string", minLength: 10, maxLength: 600 },
        },
      },
    },
    segments: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SEGMENTS_PER_CHAPTER,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "synopsis",
          "durationSeconds",
          "beatIds",
          "subjectDefinitions",
          "summary",
          "retentionAnalysis",
          "detailedDescription",
          "overallSoundscape",
          "nonDiegeticMusic",
        ],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 24 },
          synopsis: { type: "string", minLength: 4 },
          durationSeconds: { type: "integer", minimum: MIN_SEGMENT_SECONDS, maximum: MAX_SEGMENT_SECONDS },
          beatIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 2, maxLength: 24 } },
          // subjectDefinitions 允许为空串：存在共享预设且本段无新增主体时合法
          //（共享行不进片段文本）；非空性由 normalize 按共享状态条件校验。
          subjectDefinitions: { type: "string" },
          summary: { type: "string", minLength: 20 },
          retentionAnalysis: { type: "string", minLength: 1 },
          detailedDescription: { type: "string", minLength: 80 },
          overallSoundscape: { type: "string", minLength: 1 },
          nonDiegeticMusic: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

function normalizeMultilineText(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.trim();
  const fenced = CODE_FENCE_RE.exec(text);
  if (fenced) text = fenced[1].trim();
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

interface ShotTimelineEntry {
  shotNumber: number;
  /** null 表示开场镜头（[Shot 1] 不允许携带时间戳）。 */
  cutMs: number | null;
}

function collectShotTimeline(description: string): ShotTimelineEntry[] {
  const markers = [...description.matchAll(/\[Shot\s+(\d+)\]/gu)];
  return markers.map((marker, position) => {
    const segmentStart = marker.index! + marker[0].length;
    const segmentEnd = position + 1 < markers.length ? markers[position + 1].index! : description.length;
    const cutMatch = /\bAt\s+(\d{1,2}):(\d{2})\.(\d{3})\b/u.exec(description.slice(segmentStart, segmentEnd));
    return {
      shotNumber: Number(marker[1]),
      cutMs: cutMatch ? (Number(cutMatch[1]) * 60 + Number(cutMatch[2])) * 1000 + Number(cutMatch[3]) : null,
    };
  });
}

function definedSubjectLabel(line: string): string | undefined {
  const match = LABEL_DEFINITION_LINE_RE.exec(line.trim());
  return match ? `<${match[1]} ${match[2]}>` : undefined;
}

function verifyReferenceLabels(fields: ChapterScriptSegmentFields, shared: SharedSubjectPreset): string[] {
  const issues: string[] = [];
  // 合法定义集 = 共享预设（<Subject 1>..maxLabel）∪ 本段新增行（编号必须从 maxLabel+1 起连续递增）。
  const defined = new Set<string>();
  for (let label = 1; label <= shared.maxLabel; label += 1) defined.add(`<Subject ${label}>`);
  const localLabels: number[] = [];
  for (const line of fields.subjectDefinitions.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const label = definedSubjectLabel(trimmed);
    if (!label) {
      issues.push(`subject_definitions 中存在非 <Subject N> 开头的行：${trimmed.slice(0, 40)}`);
      continue;
    }
    const number = Number(label.replace(/\D+/gu, ""));
    if (number <= shared.maxLabel) {
      issues.push(`${label} 与共享定义重复：共享主体不得在片段中重复定义，请直接引用同编号或删除该行`);
      continue;
    }
    if (defined.has(label)) issues.push(`subject_definitions 中 ${label} 定义重复`);
    defined.add(label);
    localLabels.push(number);
  }
  const sortedLocal = [...localLabels].sort((left, right) => left - right);
  sortedLocal.forEach((number, position) => {
    const expected = shared.maxLabel + 1 + position;
    if (number !== expected) issues.push(`新增主体编号必须从 <Subject ${shared.maxLabel + 1}> 起连续递增：出现 <Subject ${number}>`);
  });
  const bodyLabels = new Set([...`${fields.summary}\n${fields.retentionAnalysis}\n${fields.detailedDescription}`.matchAll(REFERENCE_LABEL_RE)].map((item) => item[0]));
  for (const label of bodyLabels) {
    if (!defined.has(label)) issues.push(`未在 subject_definitions 定义的引用标签出现在正文中：${label}（共享库或本段新增定义均可）`);
  }
  for (const number of localLabels) {
    const label = `<Subject ${number}>`;
    if (!bodyLabels.has(label)) issues.push(`subject_definitions 中新增定义的标签未被 summary / retention_analysis / detailed_description 使用：${label}`);
  }
  if ([...fields.subjectDefinitions.split("\n")].some((line) => /^<(Video|Audio)\s+\d+>/u.test(line.trim()))) {
    issues.push("未提供源视频或音频参考资产，不得创建 <Video N> / <Audio N> 独立条目");
  }
  return issues;
}

function verifySegmentTiming(fields: ChapterScriptSegmentFields): string[] {
  const issues: string[] = [];
  if (!SUMMARY_TASK_PREFIX_RE.test(fields.summary.trim())) {
    issues.push(`summary 必须以方括号任务类型前缀开头（如 [reference generation]）：${fields.summary.slice(0, 40)}`);
  }
  const timeline = collectShotTimeline(fields.detailedDescription);
  if (!timeline.length) return [...issues, "detailed_description 缺少 [Shot N] 镜头标记"];
  timeline.forEach((entry, position) => {
    if (entry.shotNumber !== position + 1) issues.push(`镜头编号必须从 1 连续递增，第 ${position + 1} 个标记实际是 [Shot ${entry.shotNumber}]`);
    const isOpeningShot = position === 0;
    if (isOpeningShot && entry.cutMs !== null) issues.push("[Shot 1] 是开场镜头，不得携带 At MM:SS.mmm 时间戳");
    if (!isOpeningShot && entry.cutMs === null) issues.push(`[Shot ${entry.shotNumber}] 缺少 At MM:SS.mmm 切点`);
    if (entry.cutMs === null) return;
    if (entry.cutMs > fields.durationSeconds * 1000) issues.push(`[Shot ${entry.shotNumber}] 的切点 ${entry.cutMs}ms 超出片段时长 ${fields.durationSeconds}s`);
    const previous = timeline[position - 1];
    if (!isOpeningShot && previous && previous.cutMs !== null && previous.cutMs >= entry.cutMs) {
      issues.push(`切点必须严格递增：[Shot ${previous.shotNumber}] ${previous.cutMs}ms ≥ [Shot ${entry.shotNumber}] ${entry.cutMs}ms`);
    }
  });
  return issues;
}

function verifyDialogueMarkup(detailedDescription: string): string[] {
  const issues: string[] = [];
  const openTags = detailedDescription.split("<d>").length - 1;
  const closeTags = detailedDescription.split("</d>").length - 1;
  if (openTags !== closeTags) issues.push(`<d> 标签不配对：开标签 ${openTags} 个、闭标签 ${closeTags} 个`);
  for (const match of detailedDescription.matchAll(DIALOGUE_PAIR_RE)) {
    if (!/^\s*\[[^\]]+\]/u.test(match[1])) issues.push(`对白必须保留原语言并带语言标注，如 <d>[中文] ……</d>：${match[1].slice(0, 30)}`);
  }
  return issues;
}

export function assembleSegmentPromptText(fields: ChapterScriptSegmentFields): string {
  // 片段 subjectDefinitions 只承载新增主体；存在共享预设且本段无新增时，
  // 该段省略 subject_definitions 区块（五段交付），共享库由独立块前置提供。
  const definitions = normalizeMultilineText(fields.subjectDefinitions);
  const blocks: string[] = [];
  if (definitions) blocks.push(`subject_definitions:\n${definitions}`);
  for (const { key, label } of SECTION_FIELDS) {
    if (key === "subjectDefinitions") continue;
    blocks.push(`${label}:\n${normalizeMultilineText(fields[key])}`);
  }
  return blocks.join("\n\n");
}

export function validateChapterScriptSegment(fields: ChapterScriptSegmentFields, shared: SharedSubjectPreset): string[] {
  return [
    ...verifyReferenceLabels(fields, shared),
    ...verifySegmentTiming(fields),
    ...verifyDialogueMarkup(fields.detailedDescription),
  ];
}

/**
 * 影视镜头语言提示（提示级，不阻断、不回灌 repair）。
 * 方法论来源：.agents/skills/short-drama-writing（镜头四要素：景别/角度/运镜/光线氛围）。
 * 逐 [Shot N] 检查运镜或景别词覆盖；缺失的镜头输出可读提示，供前端与编排者参考。
 */
export function computeCinematicHints(segments: ReadonlyArray<AssembledChapterScriptSegment>): string[] {
  const hints: string[] = [];
  for (const segment of segments) {
    const description = segment.detailedDescription;
    const markers = [...description.matchAll(/\[Shot\s+(\d+)\]/gu)];
    markers.forEach((marker, position) => {
      const shotStart = marker.index! + marker[0].length;
      const shotEnd = position + 1 < markers.length ? markers[position + 1].index! : description.length;
      const shotText = description.slice(shotStart, shotEnd);
      const hasCamera = /\b(camera|push(?:es)? in|pull(?:s)? out|pan(?:s)?|truck(?:s)?|tilt(?:s)?|pedestal|zoom(?:s)?|arc shot|tracking shot|static shot|shake(?:s)?|roll(?:s)?|POV)\b/iu.test(shotText);
      const hasFraming = /\b(extreme close-up|close-up|medium close-up|medium shot|medium-wide|medium wide|wide shot|extreme wide|low-angle|low angle|high-angle|high angle|overhead|dutch|over-the-shoulder)\b/iu.test(shotText);
      if (!hasCamera && !hasFraming) {
        hints.push(`片段 ${segment.index} [Shot ${marker[1]}] 缺少运镜或景别描述——建议补写镜头四要素（景别/角度/运镜/光线氛围），参见 short-drama-writing 技能`);
      }
    });
  }
  return hints;
}

/**
 * 解析并校验模型输出为可落库的片段集合。
 * 全部拒绝原因一次性收集返回给调用方（repair 循环 / 最终错误信息共用）。
 * minSegments 是按正文字数推导的剧情覆盖下限；不足视为剧情省略并回灌 repair。
 */
export function normalizeChapterScriptOutput(raw: unknown, options: { minSegments?: number; shared?: SharedSubjectPreset } = {}): { plotBeats: PlotBeat[]; characters: ChapterScriptCharacterSheet[]; segments: AssembledChapterScriptSegment[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型没有返回有效的剧本对象");
  const value = raw as Partial<ChapterScriptModelOutput>;
  const rawSegments: unknown[] = Array.isArray(value.segments) ? [...value.segments] : [];
  if (!rawSegments.length) throw new Error("模型没有返回任何剧本片段");
  const { minSegments, shared = { lines: [], maxLabel: 0 } } = options;

  const parsed = new Array<{ suffix: string; segment?: AssembledChapterScriptSegment }>(rawSegments.length);
  const issueLines: string[] = [];
  const rawBeats: unknown[] = Array.isArray(value.plotBeats) ? [...value.plotBeats] : [];
  if (!rawBeats.length) throw new Error("模型没有返回剧情节拍清单（plotBeats）");
  const beats = new Map<string, PlotBeat>();
  for (const entry of rawBeats) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const kind = record.kind as PlotBeatKind;
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!id || !summary || beats.has(id)) continue;
    if (!PLOT_BEAT_KINDS.includes(kind)) continue;
    beats.set(id, { id, kind, summary });
  }
  if (!beats.size) throw new Error("plotBeats 中没有有效的剧情节拍（需要 id/kind/summary）");

  rawSegments.forEach((segment, index) => {
    const suffix = `片段 ${index + 1}`;
    parsed[index] = { suffix };
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      issueLines.push(`- ${suffix}: 结构不是对象`);
      return;
    }
    const candidate = segment as Record<string, unknown>;
    const durationSecondsRaw = typeof candidate.durationSeconds === "number" ? Math.round(candidate.durationSeconds) : NaN;
    const beatIds = Array.isArray(candidate.beatIds) ? candidate.beatIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
    const fields: ChapterScriptSegmentFields = {
      title: typeof candidate.title === "string" ? candidate.title.trim() : "",
      synopsis: normalizeMultilineText(candidate.synopsis),
      durationSeconds: durationSecondsRaw,
      beatIds,
      subjectDefinitions: normalizeMultilineText(candidate.subjectDefinitions),
      summary: normalizeMultilineText(candidate.summary),
      retentionAnalysis: normalizeMultilineText(candidate.retentionAnalysis),
      detailedDescription: normalizeMultilineText(candidate.detailedDescription),
      overallSoundscape: normalizeMultilineText(candidate.overallSoundscape),
      nonDiegeticMusic: normalizeMultilineText(candidate.nonDiegeticMusic),
    };
    if (!fields.title || fields.title.length > 24) issueLines.push(`- ${suffix}: title 无效或超过 24 字`);
    // subjectDefinitions 允许为空的条件：存在共享预设（本段只复用共享主体）；
    // 无共享时仍须至少定义一个本段主体（否则引用标签全部悬空）。
    const requiredTextFields: ReadonlyArray<keyof ChapterScriptSectionFields | "synopsis"> = [
      "synopsis", "summary", "retentionAnalysis", "detailedDescription", "overallSoundscape", "nonDiegeticMusic",
    ];
    const localIssues = requiredTextFields.filter((key) => !String(fields[key]).trim()).map((key) => `- ${suffix}: 字段为空：${key}`);
    if (!fields.subjectDefinitions.trim() && shared.maxLabel === 0) {
      localIssues.push(`- ${suffix}: 字段为空：subjectDefinitions（无共享定义时必须在本段定义主体）`);
    }
    if (!fields.beatIds.length) localIssues.push(`- ${suffix}: beatIds 为空，请声明本段承载的剧情节拍`);
    for (const beatId of new Set(fields.beatIds)) {
      if (!beats.has(beatId)) localIssues.push(`- ${suffix}: beatIds 引用了不存在的节拍 ${beatId}`);
    }
    if (new Set(fields.beatIds).size !== fields.beatIds.length) localIssues.push(`- ${suffix}: beatIds 存在重复引用`);
    if (!Number.isFinite(durationSecondsRaw) || durationSecondsRaw < MIN_SEGMENT_SECONDS || durationSecondsRaw > MAX_SEGMENT_SECONDS) {
      localIssues.push(`- ${suffix}: durationSeconds 必须落在 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s（实际 ${String(candidate.durationSeconds)}）`);
    }
    localIssues.push(...(Number.isFinite(durationSecondsRaw)
      ? validateChapterScriptSegment(fields, shared)
      : ["durationSeconds 非法，跳过结构校验"]
    ).map((issue) => `- ${suffix}: ${issue}`));
    issueLines.push(...localIssues);
    // 仅在校验通过的片段上执行确定性组装：避免未受控异常掩盖结构问题清单。
    if (!localIssues.length) {
      parsed[index].segment = { ...fields, index: index + 1, promptText: assembleSegmentPromptText(fields) };
    }
  });

  const characters = Array.isArray(value.characters)
    ? value.characters.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const appearanceEn = typeof item.appearanceEn === "string" ? item.appearanceEn.trim() : "";
      return name && appearanceEn ? [{ name, appearanceEn }] : [];
    }).slice(0, MAX_SCRIPT_CHARACTERS)
    : [];

  if (typeof minSegments === "number" && Number.isFinite(minSegments) && rawSegments.length < minSegments) {
    issueLines.push(`- 覆盖不足：片段数 ${rawSegments.length} 少于本章剧情覆盖所需下限 ${minSegments}（按正文字数推导）。请重新穷举剧情节拍，把被省略的叙事信息块（背景记忆、关键设定、期限任务、信念转折）映射进片段。`);
  }

  // 剧情节拍覆盖 + 信息呈现手段校验（结构特征，可回灌 repair）：
  // 每个节拍至少被一段承载；memory/setup/hook 节拍的承载段必须用
  // 闪回画面 [Flashback]、台词 <d>（含画外音）或屏幕可读文字承载信息内容，
  // 仅抱头/颤抖等反应动作不构成呈现，否则观众无法理解剧情。
  const segmentsAssembled = parsed.map((item) => item.segment!).filter(Boolean);
  const coveredBeats = new Set(segmentsAssembled.flatMap((segment) => segment.beatIds));
  for (const beat of beats.values()) {
    if (!coveredBeats.has(beat.id)) issueLines.push(`- 剧情节拍未被任何片段承载：[${beat.kind}] ${beat.summary}（id=${beat.id}）`);
  }
  for (const segment of segmentsAssembled) {
    const carriedRequired = segment.beatIds.map((id) => beats.get(id)).filter((beat): beat is PlotBeat => Boolean(beat) && PRESENTATION_REQUIRED_BEAT_KINDS.includes(beat!.kind));
    if (!carriedRequired.length) continue;
    const hasDialogue = segment.detailedDescription.includes("<d>");
    const hasFlashback = /\[Flashback\]/iu.test(segment.detailedDescription);
    const hasOnScreenText = /<\/?text>|屏幕字|字幕|on-screen text/iu.test(segment.detailedDescription);
    if (!hasDialogue && !hasFlashback && !hasOnScreenText) {
      const kinds = carriedRequired.map((beat) => beat.id).join(", ");
      issueLines.push(`- 片段 ${segment.index}: 承载的信息节拍（${kinds}）没有呈现手段。背景/设定/钩子类内容必须用 [Flashback] 闪回镜头、台词 <d>（含画外音）或屏幕可读文字把具体信息呈现给观众；仅靠抱头、颤抖等反应动作只表达了"有信息涌入"，观众无法理解剧情。`);
    }
  }

  if (issueLines.length) throw new Error(`剧本结构校验失败：\n${issueLines.join("\n")}`);
  return { plotBeats: [...beats.values()], characters, segments: segmentsAssembled };
}

export function buildChapterScriptCharacterDigests(rows: Array<Record<string, unknown>>): Array<{ name: string; digest: string }> {
  // TODO P2: 人物摘要截断长度是上下文预算魔法值，宜并入整体 token 预算计算。
  const DIGEST_LIMIT = 200;
  const primitiveKeys = ["role", "motivation", "voiceAnchor", "arc", "appearance", "look", "description"] as const;
  return rows.flatMap((row) => {
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
    if (!name) return [];
    const parts = primitiveKeys.filter((key) => typeof row[key] === "string" && String(row[key]).trim()).map((key) => `${key}: ${String(row[key]).trim()}`);
    return [{ name, digest: parts.join("；").slice(0, DIGEST_LIMIT) }];
  }).slice(0, MAX_SCRIPT_CHARACTERS);
}

export function buildChapterScriptPrompt(input: {
  projectTitle: string;
  chapterTitle: string;
  narrativeOrder: number;
  plainText: string;
  characters: Array<{ name: string; digest: string }>;
  instruction?: string;
  minSegments: number;
  shared: SharedSubjectPreset;
}): string {
  const sharedBlock = input.shared.lines.length
    ? [
        `章节共享引用定义（用户预设，全章唯一定义，直接复用）：`,
        `subject_definitions:`,
        input.shared.lines.map((line) => line).join("\n"),
        [
          `以上 <Subject 1>~<Subject ${input.shared.maxLabel}> 已由作者预设定义：`,
          `- 片段中直接以同编号引用，禁止重写、改述或补充其描述；`,
          `- 各片段的 subjectDefinitions 只写本段新增主体，编号从 <Subject ${input.shared.maxLabel + 1}> 起连续递增；`,
          `- 本段没有新增主体时，subjectDefinitions 返回空字符串。`,
        ].join("\n"),
      ].join("\n")
    : "";
  return [
    `作品名称：${input.projectTitle}`,
    `章节序号：第 ${input.narrativeOrder} 章《${input.chapterTitle}》`,
    "任务：把本章正文改写为短剧分镜剧本提示词（MiniMax H3 全参考模式）。先给出本章出场人物的 appearanceEn 英文外观基线（各片段 subjectDefinitions 必须复用同一外形描述），再拆分片段。",
    ...(sharedBlock ? [sharedBlock] : []),
    [
      "剧情覆盖契约（先于拆分执行，输出为顶层 plotBeats + 各片段 beatIds 引用）：",
      "- 第一步：通读正文，穷举本章剧情节拍，输出为 plotBeats 数组，每项 {id, kind, summary}。kind 取值：event=动作事件、dialogue=对话交换、memory=背景记忆与身份处境、setup=关键设定与伏笔、hook=期限任务与钩子、decision=信念转折与决策判断。summary 必须写出该节拍携带的具体信息点（谁、何处、什么事），不得只写情绪词。",
      "- 第二步：拆分片段，每个片段用 beatIds 声明它承载的节拍；所有节拍都必须被某个片段承载，不得整块省略。相邻的纯氛围过渡可并入相邻片段。",
      [
        "信息呈现手段（硬性规则）：",
        "- memory / setup / hook 类节拍的承载片段，必须把具体信息呈现给观众，手段三选一：[Flashback] 闪回镜头（写出闪回画面里谁在何处做什么，2-4 个镜头）；台词 <d>（含画外音 voice-over，直接说出关键信息点）；屏幕可读文字。",
        "- 抱头、颤抖、喘息等反应动作只能表达「有信息涌入」这一事件，不能替代信息内容本身；只写反应动作会被判定为呈现缺失。",
      ].join("\n"),
      `- 片段数量下限：本章至少拆出 ${input.minSegments} 个片段（按正文篇幅推导），不足即视为剧情省略。`,
    ].join("\n"),
    [
      "剧集剧作契约（提示层，与剧情覆盖契约配合执行）：",
      "- 开场即冲突：第 1 个片段的第一个镜头落在冲突现场或其临界点，开场 3 秒内呈现钩子形态之一（直接冲突、强悬念、极致反差、身份落差、倒计时压力）；本章的核心冲突、对立双方、主角即时目标须在前 10 秒内可见或可闻。铺垫性开场（日常流程、纯环境交代先行）视为失败。",
      "- 情绪节点节奏：每 2-4 个片段落一个情绪节点（对话冲突、动作冲突或信息揭示），前 1/3 的片段内完成第一次小反转；连续 3 个片段无节点视为节奏断裂。",
      "- 出口即钩子：每个片段的出口状态抛出问题或抬高压（未揭的身份、被推翻的假设、逼近的危险、两难抉择、逼近的期限）；末片段在冲击瞬间切卡（揭示、接触或决定发生的一刻），不在余韵处收尾——观众应带着未解的钩子离开。",
      "- 台词密度：每句台词至少承担身份/关系确认、冲突引爆、后果陈述之一，纯填充性寒暄压缩掉；关键情绪节拍静音可读（表情、动作或屏幕可读文字）。对白语义仍受上方忠实性边界约束。",
      "- 反转须有伏笔：每个反转必须对应正文前文已呈现过的伏笔（plant → overlook → detonate）；正文未铺垫的反转不得新增，伏笔应经插入镜头、台词或可读细节在早期片段中可见。",
      "- 人物经济：镜头内出场人物围绕核心三角（主角、对手、助力者）加少量配角组织；人物标签靠稳定的视觉锚点（标志道具、服饰、特征）跨片段复用同一外形。",
    ].join("\n"),
    input.characters.length
      ? `人物设定摘要（事实参照）：\n${input.characters.map((character) => `- ${character.name}${character.digest ? `：${character.digest}` : ""}`).join("\n")}`
      : "人物设定摘要：（无；请依据正文自行给出 appearanceEn 基线）",
    input.instruction?.trim() ? `作者指令（优先遵守其与格式规范相容的部分）：${input.instruction.trim()}` : "",
    "边界：忠实于正文已发生的事实、因果与对白语义，不新增情节、角色或结局改动；叙述性心理描写转为可观察的表情、动作或选择。",
    "章节正文：",
    input.plainText.trim(),
  ].filter(Boolean).join("\n\n");
}

const SCRIPT_SYSTEM_BASE = "你是短剧分镜剧本提示词改写器。只依据给定正文与指令输出符合 JSON Schema 的剧本：顶层 plotBeats 是穷举的剧情节拍清单，characters 是出场人物外观基线，segments 是按播放顺序排列的片段数组（用 beatIds 引用节拍）。";

async function loadProjectTitle(repository: NovelPostgresRepository, projectId: string): Promise<string> {
  const result = await repository.pool.query<{ title: string }>("SELECT title FROM novel_projects WHERE id=$1", [projectId]);
  return result.rows[0]?.title ?? "";
}

async function loadChapterCast(projectId: string, repository: NovelPostgresRepository): Promise<Array<{ name: string; digest: string }>> {
  const [foundation, entities] = await Promise.all([
    repository.pool.query<{ characters: unknown }>(
      "SELECT payload->'structuredData'->'characters' AS characters FROM project_plan_sections WHERE project_id=$1 AND task_key='characters'",
      [projectId],
    ),
    repository.pool.query<{ name: string; payload: Record<string, unknown> | null }>(
      // TODO P2: 角色实体读取上限 50 是上下文预算魔法值，超限项目会静默丢角色；宜并入整体 token 预算计算。
      "SELECT name, payload FROM entities WHERE project_id=$1 AND kind='character' ORDER BY name ASC LIMIT 50",
      [projectId],
    ),
  ]);
  const foundationRows = Array.isArray(foundation.rows[0]?.characters) ? foundation.rows[0].characters as Array<Record<string, unknown>> : [];
  const digests = new Map(buildChapterScriptCharacterDigests(foundationRows).map((item) => [item.name, item.digest]));
  for (const entity of entities.rows) {
    if (!entity.name || digests.has(entity.name)) continue;
    const identity = entity.payload && typeof entity.payload === "object"
      ? entity.payload.identity ?? entity.payload.summary ?? entity.payload.description
      : undefined;
    // TODO P2: 实体描述截断长度与人物摘要一致，应纳入统一预算。
    digests.set(entity.name, typeof identity === "string" ? identity.slice(0, 200) : "");
  }
  return [...digests.entries()].map(([name, digest]) => ({ name, digest }));
}

async function readStoredChapterScript(repository: NovelPostgresRepository, artifactId: string): Promise<ChapterScriptRecord | undefined> {
  const result = await repository.getArtifact(artifactId);
  if (!result?.structuredData || result.kind !== CHAPTER_SCRIPT_ARTIFACT_KIND) return undefined;
  const data = result.structuredData as Record<string, unknown>;
  const segments = Array.isArray(data.segments) ? data.segments as AssembledChapterScriptSegment[] : [];
  if (!segments.length) return undefined;
  return {
    projectId: result.projectId,
    documentId: typeof data.documentId === "string" ? data.documentId : "",
    artifactId: result.id,
    revisionId: typeof data.revisionId === "string" ? data.revisionId : undefined,
    sourceFingerprint: typeof data.sourceFingerprint === "string" ? data.sourceFingerprint : "",
    minSegments: typeof data.minSegments === "number" ? data.minSegments : undefined,
    plotBeats: Array.isArray(data.plotBeats) ? data.plotBeats as PlotBeat[] : [],
    cinematicHints: [],
    sharedSubjects: typeof data.sharedSubjectsText === "string" ? { definitionText: data.sharedSubjectsText, maxLabel: parseSharedSubjectPreset(data.sharedSubjectsText).maxLabel } : { definitionText: "", maxLabel: 0 },
    characters: Array.isArray(data.characters) ? data.characters as ChapterScriptCharacterSheet[] : [],
    segments,
  };
}

async function persistChapterScriptArtifact(repository: NovelPostgresRepository, objects: ObjectStoreAdapter, context: {
  projectId: string;
  documentId: string;
  revisionId: string;
  revision: number;
  narrativeOrder: number;
  sourceFingerprint: string;
  minSegments: number;
  shared: SharedSubjectPreset;
  plotBeats: PlotBeat[];
  characters: ChapterScriptCharacterSheet[];
  segments: AssembledChapterScriptSegment[];
  workflowId: string;
}): Promise<string> {
  const artifactText = context.segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n");
  const object = await objects.putText(artifactText);
  const structuredData: Record<string, unknown> = {
    origin: "chapter-script-h3",
    documentId: context.documentId,
    revisionId: context.revisionId,
    narrativeOrder: context.narrativeOrder,
    mode: "ref2va",
    sourceFingerprint: context.sourceFingerprint,
    contractVersion: SCRIPT_CONTRACT_VERSION,
    minSegments: context.minSegments,
    // 共享定义是本次生成的输入快照（产物不随后续预设编辑变化）
    sharedSubjectsText: buildSharedSubjectLibraryText(context.shared),
    plotBeats: context.plotBeats,
    characters: context.characters,
    segments: context.segments,
  };
  const artifact: Artifact = {
    id: randomUUID(),
    projectId: context.projectId,
    taskId: `${context.workflowId}:script`,
    attemptId: `${context.workflowId}:script:attempt-1`,
    kind: CHAPTER_SCRIPT_ARTIFACT_KIND,
    contentHash: createHash("sha256").update(artifactText).digest("hex"),
    objectKey: object.key,
    baseRevision: context.revision,
    fingerprint: createHash("sha256").update(`${context.sourceFingerprint}:${context.workflowId}`).digest("hex"),
    structuredData,
    createdAt: Date.now(),
  };
  await repository.recordArtifact(artifact);
  return artifact.id;
}

export async function generateChapterScriptH3(input: {
  projectId: string;
  documentId: string;
  instruction?: string;
}, deps: {
  repository: NovelPostgresRepository;
  objects: ObjectStoreAdapter;
  model: ModelGateway;
  skillProvider: SkillProvider;
  /** 项目级共享 subject_definitions 预设文本（用户手动编辑，生成前预设）；空串表示无共享。 */
  sharedSubjectsText?: string;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
}): Promise<ChapterScriptRecord> {
  const shared = parseSharedSubjectPreset(deps.sharedSubjectsText);
  const source = await deps.repository.getFinalDocumentContentRef(input.projectId, input.documentId);
  if (!source) throw new ChapterScriptSourceError(404, "章节不存在");
  if (source.status !== "final" || !source.sourceRevisionId || !source.objectKey || !source.contentHash) {
    throw new ChapterScriptSourceError(409, "只能为已有正式 revision 的定稿章节生成剧本提示词");
  }

  // 幂等键绑定章节定稿内容 + 共享定义内容（documentId + revision 内容哈希 + 共享文本哈希）：
  // 同一定稿与同一共享定义重放复用既有产物；改稿或修改共享定义后自然失效重生成。
  const sharedHash = createHash("sha256").update(shared.lines.join("\n")).digest("hex");
  const sourceFingerprint = createHash("sha256").update(`${input.documentId}:${source.contentHash}:${source.sourceRevisionId}:${sharedHash}`).digest("hex");
  const existingArtifact = await deps.repository.pool.query<{ id: string }>(
    "SELECT id FROM artifacts WHERE project_id=$1 AND kind=$2 AND payload->>'sourceFingerprint'=$3 AND payload->>'contractVersion'=$4 ORDER BY created_at DESC LIMIT 1",
    [input.projectId, CHAPTER_SCRIPT_ARTIFACT_KIND, sourceFingerprint, SCRIPT_CONTRACT_VERSION],
  );
  if (existingArtifact.rowCount) {
    const stored = await readStoredChapterScript(deps.repository, existingArtifact.rows[0].id);
    if (stored) return { ...stored, reused: true, cinematicHints: computeCinematicHints(stored.segments) };
  }

  const [plainText, cast, projectTitle] = await Promise.all([
    deps.objects.getText(source.objectKey),
    loadChapterCast(input.projectId, deps.repository),
    loadProjectTitle(deps.repository, input.projectId),
  ]);
  const minSegments = deriveMinSegments(plainText);

  const workflowId = `chapter-script:${input.documentId}:${randomUUID()}`;
  const skillBundle = await resolveStageSkillBundle({
    projectId: input.projectId,
    provider: deps.skillProvider,
    executionPoint: SCRIPT_EXECUTION_POINT,
    preflightId: workflowId,
  });
  const skillSections = buildSkillContextSections(skillBundle, SCRIPT_EXECUTION_POINT);
  const promptPackage = compileStageContext({
    projectId: input.projectId,
    workflowId,
    purpose: "writing.script",
    stage: "drafting",
    system: SCRIPT_SYSTEM_BASE,
    schema: CHAPTER_SCRIPT_H3_SCHEMA as unknown as Record<string, unknown>,
    maxInputTokens: 128_000,
    reservedOutputTokens: 16_000,
    skillManifest: skillBundle.resolution,
    sections: [
      {
        id: "chapter-script-task",
        kind: "manuscript",
        title: "短剧剧本改写任务与章节正文",
        text: buildChapterScriptPrompt({
          projectTitle,
          chapterTitle: source.title,
          narrativeOrder: source.narrativeOrder,
          plainText,
          characters: cast,
          instruction: input.instruction,
          minSegments,
          shared,
        }),
        priority: "critical",
        provenanceRefs: [source.sourceRevisionId, ...(source.artifactId ? [source.artifactId] : [])],
      },
      ...skillSections,
    ],
  });

  const generated = await deps.model.generateStructured<ChapterScriptModelOutput>({
    purpose: "writing.script",
    system: promptPackage.system ?? SCRIPT_SYSTEM_BASE,
    prompt: promptPackage.instruction,
    schema: CHAPTER_SCRIPT_H3_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "chapter-script-h3",
    maxTokens: 16_000,
    routingSnapshot: deps.routingSnapshot,
    candidateStartIndex: deps.candidateStartIndex,
    workflowRunId: workflowId,
    taskId: `${workflowId}:script`,
    promptContext: promptPackage.manifest,
    extraValidate: (value) => structuralIssueSummary(value, minSegments, shared),
  });

  const normalized = normalizeChapterScriptOutput(generated.value, { minSegments, shared });
  const artifactId = await persistChapterScriptArtifact(deps.repository, deps.objects, {
    projectId: input.projectId,
    documentId: input.documentId,
    revisionId: source.sourceRevisionId,
    revision: source.revision,
    narrativeOrder: source.narrativeOrder,
    sourceFingerprint,
    minSegments,
    shared,
    plotBeats: normalized.plotBeats,
    characters: normalized.characters,
    segments: normalized.segments,
    workflowId,
  });
  return {
    projectId: input.projectId,
    documentId: input.documentId,
    artifactId,
    revisionId: source.sourceRevisionId,
    sourceFingerprint,
    minSegments,
    plotBeats: normalized.plotBeats,
    cinematicHints: computeCinematicHints(normalized.segments),
    sharedSubjects: { definitionText: buildSharedSubjectLibraryText(shared), maxLabel: shared.maxLabel },
    characters: normalized.characters,
    segments: normalized.segments,
  };
}

/** repair 循环契约校验：把结构问题压缩成模型可读的错误列表。 */
function structuralIssueSummary(value: ChapterScriptModelOutput, minSegments?: number, shared?: SharedSubjectPreset): string[] {
  try {
    const { segments } = normalizeChapterScriptOutput(value, { minSegments, shared });
    return segments.length ? [] : ["segments 为空"];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
