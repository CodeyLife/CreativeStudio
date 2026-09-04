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
 * 4. 零阻断组装（2026-08-31 起，用户指令：产物不做任何校验，直接显示）——
 *    结构观察（标签解析、切点时序、对话标记、任务前缀）全部降级为 hints
 *    供人工复核，不回灌 repair、不阻止组装落库
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
// 下限 10s（2026-08-31 起由 5s 抬升）：用户要求片段统一落在 10-15s 区间，
// 避免模型取区间中下沿产出碎片化短片段；片段数下限推导与总时长容差随之适配。
export const MIN_SEGMENT_SECONDS = 10;
// 上限 15s（2026-08-31 起由 10s 放宽）：H3 单片段可承载更长镜头叙事，
// 用户要求片段最长可到 15s（含）。
export const MAX_SEGMENT_SECONDS = 15;
/**
 * 零阻断契约下的时长回退值（区间中点）：模型返回非法 durationSeconds 时
 * 收敛到此值而非拒绝片段，保证产物可展示、总时长统计可用。
 * TODO P2: 回退值是魔法值，宜与分段时长上下限一同并入项目级配置。
 */
export const FALLBACK_SEGMENT_SECONDS = 12;
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
  constructor(readonly statusCode: 404 | 409 | 400, message: string) {
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
 * v6：描述体量契约——schema 描述字段下限抬升（summary 20→40、detailedDescription
 *    80→600、retentionAnalysis/overallSoundscape 1→20 字符）+ 运行时 skill v1.4.0
 *    字段级体量要求（detailed_description 350-500 英文词、四要素写全、宁详勿简）。
 *    根因：旧下限过低且无体量目标，模型贴下限交付概要化产物，无法支撑视频生成。
 * v7：时长与语言契约——片段时长上限 10s→15s（H3 单片段可承载更长镜头叙事，
 *    用户需求）；描述字段语言放开中文（H3 对中文提示词兼容，用户需求）；
 *    运行时 skill v1.4.2 同步（另补冲击场面细节指引：宏大场景与战斗反馈
 *    需写规模参照与物理反馈，避免生成平淡）。
 * v8：片段时长分布契约——时长按信息密度取值，宏大/战斗片段取上沿 12-15s，
 *    禁止整体贴下限（根因：v7 实测模型把 5-15s 区间理解为均匀中值，
 *    冲击场面画面无法充分展开；skill v1.4.3 同步）。
 * v9：片段时长区间收紧 10-15s（MIN 5→10，用户要求统一区间）；
 *    创意意图忠实性契约（short.script 专属，skill v1.4.4）——展示型创意
 *    （场景/世界观/氛围展示，无人物对抗）按视觉展示模式组织节拍，
 *    不强行注入追击/战斗等对抗事件；冲突导向剧作契约仅对剧情型创意生效
 *    （根因：实测展示型创意被套进冲突模板，产出追兵/迎敌剧情）。
 * v10：震撼强度契约（skill v1.5.0）——宏大/冲击/展示镜头必须执行强度层：
 *     单镜主视觉焦点、动态张力（蓄力→爆发，禁全程匀速慢镜）、尺度对比句
 *     （渺小锚点 vs 巨物）、光效反差（逆光剪影/强光柱/明暗爆发）、冲击时间感
 *     （根因：v9 产物细节充分但生成画面仍平淡，震撼缺失源于镜头缺强度——
 *     动态、尺度、光效、冲击四变量全弱，而非细节不足）。
 * v11：画面设计层契约（skill v1.6.0）——镜头四要素扩为六要素，补上构图设计
 *     （主体在画框的位置、前景遮挡、引导线、层次分割、框中框、负空间）与色彩
 *     设计（每场主色 + 强调色、色彩随情绪与时空转场）；新增反平庸默认态清单
 *     （裸中景 / 平光 / 中性色彩 / 匀速运镜四条，逐镜自检命中即重写）；开场
 *     风格句升级为可复原的具体参照（画幅焦段 / 介质质感 / 光影体系 / 色彩基调）。
 *     根因：v10 的四个强度变量（动态、尺度、光效、冲击）全在事件层面——镜头里
 *     发生了什么；而"平平无奇"是画面层面的问题——画框里怎么安排、色彩怎么设计，
 *     这一层全库关键词命中为 0。居中构图与无色彩设计恰是视频模型的默认出片态，
 *     故 v10 加了强度仍平淡。
 *     配套减负：代码侧删除与 skill 指引重复 27%（8-gram 实测）的剧作段与体量段
 *     ——重复段挤占注意力预算，长指引被模型做词汇层合规（换大词、加 violent）
 *     而非真正执行；去重后新增的画面设计层才有预算落地。
 * v12：画面层三处细化（skill v1.6.1，与 short 契约 v9 同源）——针对 v11 实测仍偏
 *      "廉价震撼"的三类问题：① 天光改为受控明暗雕塑，禁止硬爆白 god-ray
 *      （veiled through haze），去掉生硬刺目纯白刀光；② 动态张力须服务沉浸，
 *      禁止无铺垫猛拽/急甩/瞬切（whiplash/snap），展示型奇观优先缓慢庄严连续
 *      运动与优雅涌起；③ 宏大场景除尺度对比外，逼模型把建筑本身设计得崇高
 *      （垂直拔升/无尽重复韵律/超验尺度/标志轮廓/表面密度/主导画框）。根因：
 *      这三项在 v11 由契约明文主张（blinding god-ray、violent 猛冲、仅"小人
 *      对比"交代尺度），模型照抄，故产物出现刺目天光、出戏快镜、建筑空旷。
 */
export const SCRIPT_CONTRACT_VERSION = "12";

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
  /** 提示级观察（不阻断）：切点时序问题（开场带时间戳/缺切点/超时长/非递增）与结构观察清单 */
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
// summary 6-120、appearanceEn 10-600、title 1-24、synopsis≥4、
// summary≥40、detailedDescription≥600、retention/soundscape≥20、segments 数组上下限除外——
// 后两者已具名常量）均为魔法值，宜随剧本契约版本化一并改为可配置。
// 描述体量下限依据：视频生成器仅凭文字复原画面，贴着旧下限（summary 20 /
// detailedDescription 80 字符）交付的概要化产物无法生成可看视频；新下限仍远低于
// Ref2VA 指南体量（detailed_description 350-500 英文词 ≈ 2000+ 字符），作为
// 硬门兜底，体量目标由运行时 skill（h3-video-prompt v1.4.0 描述体量契约）驱动。
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
          summary: { type: "string", minLength: 40 },
          retentionAnalysis: { type: "string", minLength: 20 },
          detailedDescription: { type: "string", minLength: 600 },
          overallSoundscape: { type: "string", minLength: 20 },
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
  // 切点配对采用最近邻规则：`At MM:SS.mmm` 与它前后最近的 [Shot N] 标记配对。
  // 同时覆盖两种行业惯例写法（泛化要求：不针对特定 provider 的措辞）：
  //   后缀式 `[Shot 2] At 00:02.000, ...`（时间戳属于其后镜头，本契约的规范写法）
  //   前缀式 `At 00:02.000 cut to [Shot 2] ...`（切换时刻写在被切镜头标记之前）
  // 旧实现只认后缀式，前缀式会被错配给前一个镜头，产生「开场镜头携带时间戳 +
  // 末镜头缺切点」的伪错误并连锁污染节拍覆盖校验。
  const markers = [...description.matchAll(/\[Shot\s+(\d+)\]/gu)].map((marker) => ({
    shotNumber: Number(marker[1]),
    start: marker.index!,
    end: marker.index! + marker[0].length,
  }));
  const cuts = [...description.matchAll(/\bAt\s+(\d{1,2}):(\d{2})\.(\d{3})\b/gu)].map((cut) => ({
    ms: (Number(cut[1]) * 60 + Number(cut[2])) * 1000 + Number(cut[3]),
    pos: cut.index!,
  }));
  // 切点视角配对：每个 At 只归属距离最近的一个镜头标记（后缀式自然贴近其后镜头，
  // 前缀式贴近其前镜头）；多个切点落到同一镜头时保留最近的一个。按镜头顺序贪心
  // 会让早期镜头抢走全局最近的切点（或一个切点被多个镜头重复认领），必须以切点
  // 为分配主体且一一归属。
  const assignment = new Map<number, { ms: number; distance: number }>();
  cuts.forEach((cut) => {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    markers.forEach((marker, markerIndex) => {
      const distance = cut.pos < marker.start ? marker.start - cut.pos : cut.pos - marker.end;
      if (distance < bestDistance) { bestDistance = distance; bestIndex = markerIndex; }
    });
    if (bestIndex < 0) return;
    const current = assignment.get(bestIndex);
    if (!current || bestDistance < current.distance) assignment.set(bestIndex, { ms: cut.ms, distance: bestDistance });
  });
  return markers.map((marker, markerIndex) => ({ shotNumber: marker.shotNumber, cutMs: assignment.get(markerIndex)?.ms ?? null }));
}

function definedSubjectLabel(line: string): string | undefined {
  const match = LABEL_DEFINITION_LINE_RE.exec(line.trim());
  return match ? `<${match[1]} ${match[2]}>` : undefined;
}

/**
 * 片段级结构观察分级（2026-08-31 零阻断改造，用户指令：产物不做任何校验，直接显示）：
 * - blocking/hints 两级结果均只进 cinematicHints 供人工复核，不再回灌 repair、
 *   不阻止组装落库；分级保留是为了在 hints 面板中区分「H3 语义必需项观察」
 *   （原阻断级：悬空标签、<Video/Audio> 条目、[Shot N] 标记、<d> 配对、时长区间）
 *   与「风格与剧作层观察」（定义行格式、共享重复、summary 前缀、语言标注等）。
 * 根因：实测展示型创意被「setup 必须台词/闪回」硬校验阻塞，模型在
 * 指引（展示型禁台词）与校验（必须有台词）的矛盾中反复 repair 至失败；
 * 弱化（仅降级）后仍有语义必需项阻断把可展示产物整批拒掉，遂按用户指令
 * 收敛为零阻断——质量由 prompt/skill 指引层保证，结构问题交人工复核。
 */
interface SegmentValidation {
  blocking: string[];
  hints: string[];
}

function verifyReferenceLabels(fields: ChapterScriptSegmentFields, shared: SharedSubjectPreset): SegmentValidation {
  const blocking: string[] = [];
  const hints: string[] = [];
  // 合法定义集 = 共享预设（<Subject 1>..maxLabel）∪ 本段新增行（编号必须从 maxLabel+1 起连续递增）。
  const defined = new Set<string>();
  for (let label = 1; label <= shared.maxLabel; label += 1) defined.add(`<Subject ${label}>`);
  const localLabels: number[] = [];
  for (const line of fields.subjectDefinitions.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const label = definedSubjectLabel(trimmed);
    if (!label) {
      hints.push(`subject_definitions 中存在非 <Subject N> 开头的行：${trimmed.slice(0, 40)}——注意 <Subject N> 不限于人物，纯环境奇观（无人物）也必须把环境/建筑/自然现象定义为环境主体标签（如 <Subject 1> is the floating immortal mountain），禁止只写描述清单不建标签`);
      continue;
    }
    const number = Number(label.replace(/\D+/gu, ""));
    if (number <= shared.maxLabel) {
      hints.push(`${label} 与共享定义重复：共享主体不得在片段中重复定义，请直接引用同编号或删除该行`);
      continue;
    }
    if (defined.has(label)) hints.push(`subject_definitions 中 ${label} 定义重复`);
    defined.add(label);
    localLabels.push(number);
  }
  const sortedLocal = [...localLabels].sort((left, right) => left - right);
  sortedLocal.forEach((number, position) => {
    const expected = shared.maxLabel + 1 + position;
    if (number !== expected) hints.push(`新增主体编号必须从 <Subject ${shared.maxLabel + 1}> 起连续递增：出现 <Subject ${number}>`);
  });
  const bodyLabels = new Set([...`${fields.summary}\n${fields.retentionAnalysis}\n${fields.detailedDescription}`.matchAll(REFERENCE_LABEL_RE)].map((item) => item[0]));
  for (const label of bodyLabels) {
    if (!defined.has(label)) blocking.push(`未在 subject_definitions 定义的引用标签出现在正文中：${label}（共享库或本段新增定义均可）`);
  }
  for (const number of localLabels) {
    const label = `<Subject ${number}>`;
    if (!bodyLabels.has(label)) hints.push(`subject_definitions 中新增定义的标签未被 summary / retention_analysis / detailed_description 使用：${label}`);
  }
  if ([...fields.subjectDefinitions.split("\n")].some((line) => /^<(Video|Audio)\s+\d+>/u.test(line.trim()))) {
    blocking.push("未提供源视频或音频参考资产，不得创建 <Video N> / <Audio N> 独立条目");
  }
  return { blocking, hints };
}

function verifySegmentTiming(fields: ChapterScriptSegmentFields): SegmentValidation {
  const blocking: string[] = [];
  const hints: string[] = [];
  if (!SUMMARY_TASK_PREFIX_RE.test(fields.summary.trim())) {
    hints.push(`summary 必须以方括号任务类型前缀开头（如 [reference generation]）：${fields.summary.slice(0, 40)}`);
  }
  const timeline = collectShotTimeline(fields.detailedDescription);
  if (!timeline.length) return { blocking: [...blocking, "detailed_description 缺少 [Shot N] 镜头标记"], hints };
  timeline.forEach((entry, position) => {
    if (entry.shotNumber !== position + 1) blocking.push(`镜头编号必须从 1 连续递增，第 ${position + 1} 个标记实际是 [Shot ${entry.shotNumber}]`);
  });
  return { blocking, hints };
}

function verifyDialogueMarkup(detailedDescription: string): SegmentValidation {
  const blocking: string[] = [];
  const hints: string[] = [];
  const openTags = detailedDescription.split("<d>").length - 1;
  const closeTags = detailedDescription.split("</d>").length - 1;
  if (openTags !== closeTags) blocking.push(`<d> 标签不配对：开标签 ${openTags} 个、闭标签 ${closeTags} 个`);
  for (const match of detailedDescription.matchAll(DIALOGUE_PAIR_RE)) {
    if (!/^\s*\[[^\]]+\]/u.test(match[1])) hints.push(`对白必须保留原语言并带语言标注，如 <d>[中文] ……</d>：${match[1].slice(0, 30)}`);
  }
  return { blocking, hints };
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

/** 语义必需项观察（原阻断级；零阻断契约下仅进 hints 供人工复核，不回灌 repair）。 */
export function validateChapterScriptSegment(fields: ChapterScriptSegmentFields, shared: SharedSubjectPreset): string[] {
  return [
    ...verifyReferenceLabels(fields, shared).blocking,
    ...verifySegmentTiming(fields).blocking,
    ...verifyDialogueMarkup(fields.detailedDescription).blocking,
  ];
}

/** 提示级校验（不阻断产出，进 cinematicHints 供人工复核）。 */
export function collectSegmentHintIssues(fields: ChapterScriptSegmentFields, shared: SharedSubjectPreset): string[] {
  return [
    ...verifyReferenceLabels(fields, shared).hints,
    ...verifySegmentTiming(fields).hints,
    ...verifyDialogueMarkup(fields.detailedDescription).hints,
  ];
}

/**
 * 影视镜头语言提示（提示级，不阻断、不回灌 repair）。
 * 仅做切点时序观察：开场镜头时间戳、缺切点、超时长、非递增。
 * 不做镜头四要素（景别/角度/运镜/光线氛围）覆盖检测——描述语言放开中文后
 * （v1.4.2）英文术语词表无法覆盖中文镜头描述，误报率高、价值低，已移除
 * （根因：中文"大远景主观俯视角/中景弧形环绕"被英文词表判为缺失）。
 */
export function computeCinematicHints(segments: ReadonlyArray<AssembledChapterScriptSegment>): string[] {
  const hints: string[] = [];
  for (const segment of segments) {
    const description = segment.detailedDescription;
    // 提示级时序观察（不阻断）：H3 生成器对切点风格差异兼容性好，
    // 开场镜头时间戳、缺切点、超时长、非递增只在 hints 中提示，不再回灌 repair。
    const timeline = collectShotTimeline(description);
    timeline.forEach((entry, position) => {
      if (position === 0 && entry.cutMs !== null) hints.push(`片段 ${segment.index} [Shot 1] 携带 At 时间戳（开场镜头惯例上不带；H3 可容忍，供人工复核）`);
      if (position > 0 && entry.cutMs === null) hints.push(`片段 ${segment.index} [Shot ${entry.shotNumber}] 缺少 At MM:SS.mmm 切点（H3 可容忍，建议补写以精确控制切镜时刻）`);
      if (entry.cutMs === null) return;
      if (entry.cutMs > segment.durationSeconds * 1000) hints.push(`片段 ${segment.index} [Shot ${entry.shotNumber}] 切点 ${entry.cutMs}ms 超出片段时长 ${segment.durationSeconds}s（H3 会收敛到时长内，供人工复核）`);
      const previous = timeline[position - 1];
      if (position > 0 && previous && previous.cutMs !== null && previous.cutMs >= entry.cutMs) {
        hints.push(`片段 ${segment.index} 切点未严格递增：[Shot ${previous.shotNumber}] ≥ [Shot ${entry.shotNumber}]（供人工复核）`);
      }
    });
  }
  return hints;
}

/**
 * 解析模型输出为可落库的片段集合（零阻断契约：产物不做任何校验，直接组装显示）。
 *
 * 用户指令（2026-08-31）：任何结构问题都不再阻止组装与落库——原阻断级
 * （H3 语义必需项）与提示级观察全部降级为 hints 供人工复核，不回灌 repair。
 * 仅当模型完全没有返回可展示的片段（segments 缺失/为空/全部非对象）时才失败，
 * 因为此时没有产物可显示。时长做容错收敛而非拒绝：非法值回退区间中点、
 * 越界值夹回界内，保证 UI 时长展示与总时长统计可用。
 * minSegments 是按正文字数推导的剧情覆盖下限；不足为提示级观察。
 */
export function normalizeChapterScriptOutput(raw: unknown, options: { minSegments?: number; shared?: SharedSubjectPreset } = {}): { plotBeats: PlotBeat[]; characters: ChapterScriptCharacterSheet[]; segments: AssembledChapterScriptSegment[]; hints: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型没有返回有效的剧本对象");
  const value = raw as Partial<ChapterScriptModelOutput>;
  const rawSegments: unknown[] = Array.isArray(value.segments) ? [...value.segments] : [];
  if (!rawSegments.length) throw new Error("模型没有返回任何剧本片段");
  const { minSegments, shared = { lines: [], maxLabel: 0 } } = options;

  const hintLines: string[] = [];
  // plotBeats 容错解析：缺失或全无效时为空数组并提示，不阻止展示。
  const rawBeats: unknown[] = Array.isArray(value.plotBeats) ? [...value.plotBeats] : [];
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
  if (!rawBeats.length) hintLines.push("- plotBeats 缺失（零阻断契约：不阻止展示，供人工复核）");
  else if (!beats.size) hintLines.push("- plotBeats 中没有有效的剧情节拍（需要 id/kind/summary；零阻断契约：不阻止展示，供人工复核）");

  const segments: AssembledChapterScriptSegment[] = [];
  rawSegments.forEach((segment, index) => {
    const suffix = `片段 ${index + 1}`;
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      hintLines.push(`- ${suffix}: 结构不是对象，已跳过该片段（零阻断契约）`);
      return;
    }
    const candidate = segment as Record<string, unknown>;
    const durationSecondsRaw = typeof candidate.durationSeconds === "number" ? Math.round(candidate.durationSeconds) : NaN;
    // 时长容错收敛（非校验）：非法回退中点、越界夹回界内，原始值问题进 hints。
    let durationSeconds = durationSecondsRaw;
    if (!Number.isFinite(durationSecondsRaw)) {
      durationSeconds = FALLBACK_SEGMENT_SECONDS;
      hintLines.push(`- ${suffix}: durationSeconds 非法（${String(candidate.durationSeconds)}），已回退为 ${FALLBACK_SEGMENT_SECONDS}s`);
    } else if (durationSecondsRaw < MIN_SEGMENT_SECONDS || durationSecondsRaw > MAX_SEGMENT_SECONDS) {
      durationSeconds = Math.min(MAX_SEGMENT_SECONDS, Math.max(MIN_SEGMENT_SECONDS, durationSecondsRaw));
      hintLines.push(`- ${suffix}: durationSeconds ${durationSecondsRaw}s 超出 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s 区间，已收敛为 ${durationSeconds}s`);
    }
    const beatIds = Array.isArray(candidate.beatIds) ? candidate.beatIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
    const fields: ChapterScriptSegmentFields = {
      title: typeof candidate.title === "string" ? candidate.title.trim() : "",
      synopsis: normalizeMultilineText(candidate.synopsis),
      durationSeconds,
      beatIds,
      subjectDefinitions: normalizeMultilineText(candidate.subjectDefinitions),
      summary: normalizeMultilineText(candidate.summary),
      retentionAnalysis: normalizeMultilineText(candidate.retentionAnalysis),
      detailedDescription: normalizeMultilineText(candidate.detailedDescription),
      overallSoundscape: normalizeMultilineText(candidate.overallSoundscape),
      nonDiegeticMusic: normalizeMultilineText(candidate.nonDiegeticMusic),
    };
    // 结构观察（零阻断契约：以下全部只进 hints，不再回灌 repair、不阻止组装）。
    if (!fields.title || fields.title.length > 24) hintLines.push(`- ${suffix}: title 无效或超过 24 字`);
    const requiredTextFields: ReadonlyArray<keyof ChapterScriptSectionFields | "synopsis"> = [
      "synopsis", "summary", "retentionAnalysis", "detailedDescription", "overallSoundscape", "nonDiegeticMusic",
    ];
    hintLines.push(...requiredTextFields.filter((key) => !String(fields[key]).trim()).map((key) => `- ${suffix}: 字段为空：${key}`));
    if (!fields.subjectDefinitions.trim() && shared.maxLabel === 0) {
      hintLines.push(`- ${suffix}: 字段为空：subjectDefinitions（无共享定义时主体定义缺失）`);
    }
    if (!fields.beatIds.length) hintLines.push(`- ${suffix}: beatIds 为空，请声明本段承载的剧情节拍`);
    for (const beatId of new Set(fields.beatIds)) {
      if (!beats.has(beatId)) hintLines.push(`- ${suffix}: beatIds 引用了不存在的节拍 ${beatId}`);
    }
    if (new Set(fields.beatIds).size !== fields.beatIds.length) hintLines.push(`- ${suffix}: beatIds 存在重复引用`);
    hintLines.push(...validateChapterScriptSegment(fields, shared).map((issue) => `- ${suffix}: ${issue}`));
    hintLines.push(...collectSegmentHintIssues(fields, shared).map((issue) => `- ${suffix}: ${issue}`));
    segments.push({ ...fields, index: index + 1, promptText: assembleSegmentPromptText(fields) });
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
    hintLines.push(`- 覆盖不足：片段数 ${rawSegments.length} 少于剧情覆盖所需下限 ${minSegments}，可能有叙事信息块被省略，建议复核。`);
  }

  // 剧情节拍覆盖 + 信息呈现手段观察（提示级，零阻断契约：不阻塞、不回灌 repair）：
  // 展示型创意的 setup 节拍以画面本身呈现（奇观即信息），无台词/闪回是合法形态，
  // 硬性阻断会与指引层的展示型契约自相矛盾（见 contractVersion 9 段）。
  if (!segments.length) throw new Error("模型没有返回任何可展示的剧本片段");
  const coveredBeats = new Set(segments.flatMap((segment) => segment.beatIds));
  for (const beat of beats.values()) {
    if (!coveredBeats.has(beat.id)) hintLines.push(`- 剧情节拍未被任何片段承载：[${beat.kind}] ${beat.summary}（id=${beat.id}）`);
  }
  for (const segment of segments) {
    const carriedRequired = segment.beatIds.map((id) => beats.get(id)).filter((beat): beat is PlotBeat => Boolean(beat) && PRESENTATION_REQUIRED_BEAT_KINDS.includes(beat!.kind));
    if (!carriedRequired.length) continue;
    const hasDialogue = segment.detailedDescription.includes("<d>");
    const hasFlashback = /\[Flashback\]/iu.test(segment.detailedDescription);
    const hasOnScreenText = /<\/?text>|屏幕字|字幕|on-screen text/iu.test(segment.detailedDescription);
    if (!hasDialogue && !hasFlashback && !hasOnScreenText) {
      const kinds = carriedRequired.map((beat) => beat.id).join(", ");
      hintLines.push(`- 片段 ${segment.index}: 承载的信息节拍（${kinds}）没有台词/闪回/屏幕文字呈现手段。若为剧情型创意，背景/设定/钩子类内容需用 [Flashback]、台词 <d> 或屏幕文字把信息呈现给观众；展示型创意以画面呈现（奇观即信息）则可忽略。`);
    }
  }

  return { plotBeats: [...beats.values()], characters, segments, hints: hintLines };
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
    "任务：把本章正文改写为短剧分镜剧本提示词（MiniMax H3 全参考模式）。先给出本章出场人物的 appearanceEn 外观基线（各片段 subjectDefinitions 必须复用同一外形描述；描述性文字中英文均可，H3 对中文提示词兼容），再拆分片段。",
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
      `片段时长统一落在 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s 区间，按信息密度取值（分配口径见 skill 指引，此处不重复）。`,
    ].join("\n"),
    // 剧集剧作层（开场即冲突 / 情绪节点节奏 / 出口即钩子 / 台词密度 / 反转须有伏笔 /
    // 人物经济）与镜头层（六要素 / 反平庸默认态 / 震撼强度 / 冲击细节 / 描述体量）均由
    // 运行时 skill（h3-video-prompt，priority=required）注入，此处不再重复。
    // 根因：两者此前重复 27%（8-gram 实测），重复段挤占注意力预算，导致长指引被
    // 模型做词汇层合规（换大词、加 violent）而非真正执行；去重后新增的画面设计层
    // 才有预算落地。代码侧仅保留 skill 不掌握的运行时事实（节拍映射、共享主体、边界）。
    input.characters.length
      ? `人物设定摘要（事实参照）：\n${input.characters.map((character) => `- ${character.name}${character.digest ? `：${character.digest}` : ""}`).join("\n")}`
      : "人物设定摘要：（无；请依据正文自行给出 appearanceEn 基线）",
    input.instruction?.trim() ? `作者指令（优先遵守其与格式规范相容的部分）：${input.instruction.trim()}` : "",
    "边界：忠实于正文已发生的事实、因果与对白语义，不新增情节、角色或结局改动；正文中的专有概念（移动/驾驭方式、器物、礼仪、景观类型）必须在描述中展开为其文化语境的标准物理呈现（姿态、接触点、构图与地理形态），不得用字面直译、近似动作或模板化场景顶替；叙述性心理描写转为可观察的表情、动作或选择。",
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
  /** 产出来源标记：系统内部生成=chapter-script-h3，外部 MCP 接手产出=external-chapter-script-h3。 */
  origin?: string;
}): Promise<string> {
  const artifactText = context.segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n");
  const object = await objects.putText(artifactText);
  const structuredData: Record<string, unknown> = {
    origin: context.origin ?? "chapter-script-h3",
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

  // 幂等键绑定章节定稿内容 + 共享定义内容 + skill 版本（documentId + revision 内容哈希
  // + 共享文本哈希 + skill 版本串）：同一定稿、共享定义与 skill 指引重放复用既有产物；
  // 改稿、修改共享定义或更新 skill 后自然失效重生成（与 short-script-h3 同机制）。
  const sharedHash = createHash("sha256").update(shared.lines.join("\n")).digest("hex");
  const workflowId = `chapter-script:${input.documentId}:${randomUUID()}`;
  const skillBundle = await resolveStageSkillBundle({
    projectId: input.projectId,
    provider: deps.skillProvider,
    executionPoint: SCRIPT_EXECUTION_POINT,
    preflightId: workflowId,
  });
  const skillVersionPart = skillBundle.skills.map((skill) => `${skill.skillId}@${skill.version}`).sort().join("+");
  const sourceFingerprint = createHash("sha256").update(`${input.documentId}:${source.contentHash}:${source.sourceRevisionId}:${sharedHash}:${skillVersionPart}`).digest("hex");
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
    // 零阻断契约：不传 extraValidate——结构观察不回灌 repair，产物直接组装显示。
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
    cinematicHints: [...normalized.hints, ...computeCinematicHints(normalized.segments)],
    sharedSubjects: { definitionText: buildSharedSubjectLibraryText(shared), maxLabel: shared.maxLabel },
    characters: normalized.characters,
    segments: normalized.segments,
  };
}

/**
 * 外部 MCP 接手章节派生短剧内容产出：接收外部已生成的「模型形态」剧本 JSON
 * （plotBeats / characters / segments 六段字段），系统负责零阻断组装与落库
 * （artifacts kind=chapter-script）。与 generateChapterScriptH3（系统内部模型生成）
 * 互为双轨。设计依据同 submitExternalShortScriptH3（短剧脚本为只读派生、不进正文质量门）。
 *
 * 门禁与系统内部一致：documentId 对应的章节须为已定稿（有正式 revision），否则抛
 * ChapterScriptSourceError(409)；共享 subject 预设从仓储读取，使引用一致性校验与内部对齐。
 * 幂等：以外部内容哈希（documentId+revisionId+共享哈希+契约版本+归一化内容）为指纹，
 * 同内容重放复用既有产物（前缀 ext: 与系统内部输入指纹区分）。
 */
export async function submitExternalChapterScriptH3(input: {
  projectId: string;
  documentId: string;
  instruction?: string;
  /** 外部模型产出的剧本 JSON：{ plotBeats?, characters?, segments }。 */
  payload: { plotBeats?: unknown; characters?: unknown; segments?: unknown };
}, deps: {
  repository: NovelPostgresRepository;
  objects: ObjectStoreAdapter;
  /** 项目级共享 subject_definitions 预设文本；空串表示无共享（与内部生成对齐）。 */
  sharedSubjectsText?: string;
}): Promise<ChapterScriptRecord> {
  const shared = parseSharedSubjectPreset(deps.sharedSubjectsText);
  const source = await deps.repository.getFinalDocumentContentRef(input.projectId, input.documentId);
  if (!source) throw new ChapterScriptSourceError(404, "章节不存在");
  if (source.status !== "final" || !source.sourceRevisionId || !source.objectKey || !source.contentHash) {
    throw new ChapterScriptSourceError(409, "只能为已有正式 revision 的定稿章节生成剧本提示词");
  }

  const rawSegments = Array.isArray(input.payload.segments) ? input.payload.segments : [];
  if (!rawSegments.length) {
    throw new ChapterScriptSourceError(400, "payload.segments 必填且非空（外部 MCP 产出的模型形态片段数组）");
  }

  // 篇幅推导覆盖下限与内部生成对齐（零阻断提示级，不阻断）。
  const plainText = await deps.objects.getText(source.objectKey);
  const minSegments = deriveMinSegments(plainText);

  const normalized = normalizeChapterScriptOutput(input.payload, { minSegments, shared });

  const workflowId = `chapter-script-external:${input.documentId}:${randomUUID()}`;
  // 内容指纹：外部产出以内容本身为幂等依据（与系统内部输入指纹区分）。
  const sharedHash = createHash("sha256").update(shared.lines.join("\n")).digest("hex");
  const contentFingerprint = createHash("sha256").update(
    `${input.documentId}:${source.sourceRevisionId}:${sharedHash}:${SCRIPT_CONTRACT_VERSION}:`
      + JSON.stringify({
        pb: normalized.plotBeats,
        ch: normalized.characters,
        sg: normalized.segments.map((segment) => ({ ...segment })),
      }),
  ).digest("hex");
  const externalFingerprint = `ext:${contentFingerprint}`;
  const existingArtifact = await deps.repository.pool.query<{ id: string }>(
    "SELECT id FROM artifacts WHERE project_id=$1 AND kind=$2 AND payload->>'sourceFingerprint'=$3 AND payload->>'contractVersion'=$4 ORDER BY created_at DESC LIMIT 1",
    [input.projectId, CHAPTER_SCRIPT_ARTIFACT_KIND, externalFingerprint, SCRIPT_CONTRACT_VERSION],
  );
  if (existingArtifact.rowCount) {
    const stored = await readStoredChapterScript(deps.repository, existingArtifact.rows[0].id);
    if (stored) return { ...stored, reused: true, cinematicHints: computeCinematicHints(stored.segments) };
  }

  const artifactId = await persistChapterScriptArtifact(deps.repository, deps.objects, {
    projectId: input.projectId,
    documentId: input.documentId,
    revisionId: source.sourceRevisionId,
    revision: source.revision,
    narrativeOrder: source.narrativeOrder,
    sourceFingerprint: externalFingerprint,
    minSegments,
    shared,
    plotBeats: normalized.plotBeats,
    characters: normalized.characters,
    segments: normalized.segments,
    workflowId,
    origin: "external-chapter-script-h3",
  });
  return {
    projectId: input.projectId,
    documentId: input.documentId,
    artifactId,
    revisionId: source.sourceRevisionId,
    sourceFingerprint: externalFingerprint,
    minSegments,
    plotBeats: normalized.plotBeats,
    cinematicHints: [...normalized.hints, ...computeCinematicHints(normalized.segments)],
    sharedSubjects: { definitionText: buildSharedSubjectLibraryText(shared), maxLabel: shared.maxLabel },
    characters: normalized.characters,
    segments: normalized.segments,
  };
}
