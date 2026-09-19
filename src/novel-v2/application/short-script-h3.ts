/**
 * 核心创意短剧脚本提示词生成（MiniMax H3 Ref2VA 全参考模式）。
 *
 * 与 chapter-script-h3 的分工：章节剧本以定稿正文为唯一事实源；本模块以作者
 * 提供的核心创意为起点，自拟剧情节拍并完成一个自洽的简短短剧（如单支
 * 垂屏短视频），无定稿正文可回读。两者共享同一六段式片段契约、结构特征
 * 校验与运行时 skill（h3-video-prompt，执行点 short.script）。
 *
 * 独立性（契约 v2 起）：创作不依赖任何小说项目——projectId 可选，缺省为
 * 独立短剧；填写时产物关联该作品（衍生短剧），仅用于项目标题注入 prompt
 * 与列表过滤。产物**不落服务端库**（stateless：无 repository/objects 依赖），由前端存本地
 *  IndexedDB；曾用的服务端表已随迁移 093 删除。
 *
 * 流程：
 * 1. 校验创意输入与时长模式（fixed=固定目标时长预算，按预算推导分段数上下限，
 *    仅作为 prompt 预算注入；auto=不限时长，总时长与片段数由模型依据核心创意
 *    自行编排，仅保留段数硬顶保护输出预算）
 * 2. resolveStageSkillBundle(short.script) 注入 skill 指引 → generateStructured 调模型
 * 3. 复用 normalizeChapterScriptOutput 做零阻断组装（2026-08-31 起，用户指令：
 *    产物不做任何校验直接显示）——节拍覆盖、呈现手段、标签、时序、对白标记
 *    与总时长窗口全部降级为 hints 供人工复核，不回灌 repair、不阻止落库
 * 4. 六段按固定顺序组装成最终提示词，直接回传给调用方（服务端零持久化）
 *
 * 幂等键：作用域（projectId ?? "independent"）+ idea + instruction + 时长维度
 * （fixed=目标时长数值，auto="auto" 占位）+ 契约版本，同输入重放复用既有产物；
 * 改创意、切换时长模式、切换关联作用域或推进契约版本后自然失效重生成。
 */
import { createHash, randomUUID } from "node:crypto";
import type { SkillProvider } from "../protocol";
import type { ModelRoutingSnapshot } from "../model-routing";
import { ExternalMcpRequiredError } from "../model-routing";
import type { ModelGateway } from "../model-gateway";
import { buildSkillContextSections, resolveStageSkillBundle } from "../skill-runtime";
import { compileStageContext } from "../stage-context";
import {
  AssembledChapterScriptSegment,
  ChapterScriptCharacterSheet,
  CHAPTER_SCRIPT_H3_SCHEMA,
  computeCinematicHints,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  normalizeChapterScriptOutput,
  PlotBeat,
} from "./chapter-script-h3";
import {
  buildShortScriptBatchPrompt,
  buildShortScriptBatchSchema,
  buildShortScriptPlanPrompt,
  buildShortScriptPlanSchema,
  buildCreativeStrategySchema,
  buildShortScriptAvoidMotifLine,
  buildShortScriptMaterialLine,
  normalizeCreativeStrategy,
  shortScriptDurationBudgetLine,
  SHORT_SCRIPT_AVOID_MOTIF_LIMIT,
  SHORT_SCRIPT_SEGMENTS_PER_BATCH,
  SHORT_SCRIPT_BOUNDARY_CONTRACT,
  SHORT_SCRIPT_COVERAGE_CONTRACT,
  SHORT_SCRIPT_DESCRIPTION_VOLUME_CONTRACT,
  SHORT_SCRIPT_PRESENTATION_CONTRACT,
  SHORT_SCRIPT_PLAN_MAX_TOKENS,
  SHORT_SCRIPT_BATCH_MAX_TOKENS,
  SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS,
  ShortScriptPlan,
  ShortScriptPreviousSegment,
  sliceShortScriptBatchRanges,
  usesShortScriptStagedGeneration,
  type ShortScriptCreativeStrategy,
  type ShortScriptReferenceMaterial,
} from "./staged-script-generation";

/** 一部剧情选中的公用素材引用快照（material_refs：materialId + 描述 + <Subject N> 参考帧标签）。
 * 独立短剧存浏览器 IndexedDB，此快照随脚本落前端 store；前端从创作台素材解析后直传。 */
export interface ShortDramaMaterialRef {
  materialId: string;
  description: string;
  subjectTag: string;
}

/** 吸引力设计（creativeStrategy）的类型与工具对外从本模块导出（short.script 专属契约的应用层入口）。 */
export {
  SHORT_SCRIPT_HOOK_ENGINES,
  buildCreativeStrategySchema,
  buildShortScriptAvoidMotifLine,
  normalizeCreativeStrategy,
  type ShortScriptCreativeStrategy,
  type ShortScriptHookEngine,
} from "./staged-script-generation";

/** 短剧产物类型标识（语义标签；独立短剧本版本存浏览器 IndexedDB，服务端不留行）。 */
export const SHORT_SCRIPT_KIND = "short-script";
export const SHORT_SCRIPT_EXECUTION_POINT = "short.script" as const;

/** TODO P2: 短剧本时长/分段运营参数应来自项目级配置而非硬编码。 */
export const DEFAULT_SHORT_SCRIPT_TARGET_SECONDS = 30;
export const MIN_SHORT_SCRIPT_TARGET_SECONDS = 10;
/** 上限取 3 分钟：36 段 × ~500 token/段的六段结构 promptText 约 18k 输出 token，在 32k 预算内可控；更长剧情需分幕生成（独立契约演进项）。 */
export const MAX_SHORT_SCRIPT_TARGET_SECONDS = 180;
/** 180s ÷ 最短单段 5s = 36：段数 cap 与目标时长上限自洽。 */
export const MAX_SHORT_SCRIPT_SEGMENTS = 36;
/** 总时长与目标时长的容差窗口：常量移至 staged-script-generation（两阶段/单次共享同一文本），此处保持原导出路径兼容。 */
export { SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS } from "./staged-script-generation";
/** 核心创意输入最小长度：低于该长度无法承载"谁想要什么、什么阻止他"的最小创意单元。 */
export const MIN_IDEA_LENGTH = 10;

/**
 * 短剧本时长模式：
 * - fixed（默认）：作者给定目标时长（10-180s），分段数上下限与总时长窗口按预算推导；
 * - auto（不限时长）：总时长与片段数由模型依据核心创意自行编排，节拍覆盖完整优先于
 *   时长配额——创意需要多少节拍就交付多少片段，只受段数硬顶（MAX_SHORT_SCRIPT_SEGMENTS）
 *   与单段时长区间约束，保护输出 token 预算并兼容 H3 片段生成。
 */
export const SHORT_SCRIPT_DURATION_MODES = ["fixed", "auto"] as const;
export type ShortScriptDurationMode = (typeof SHORT_SCRIPT_DURATION_MODES)[number];

/** 时长模式规范化：非法值收敛到 fixed（输入为运营参数级，超界收敛而非拒绝）。 */
export function normalizeShortScriptDurationMode(mode: string | undefined): ShortScriptDurationMode {
  return (SHORT_SCRIPT_DURATION_MODES as ReadonlyArray<string>).includes(mode ?? "") ? (mode as ShortScriptDurationMode) : "fixed";
}

/** 时长维度的幂等键表示：fixed 取目标时长数值，auto 取模式占位——两种模式产物互不复用。 */
export function shortScriptDurationKey(input: { durationMode: ShortScriptDurationMode; targetDurationSeconds: number }): string {
  return input.durationMode === "auto" ? "auto" : String(input.targetDurationSeconds);
}

/** auto（不限时长）模式的输出预算：段数硬顶沿用 MAX_SHORT_SCRIPT_SEGMENTS，
 * 硬顶推导口径（180s ÷ 最短单段 10s = 36）保证 auto 产物的输出 token 上界与
 * fixed 模式 180s 目标一致，不需要放宽 reservedOutputTokens/maxTokens。
 */
export const AUTO_DURATION_SEGMENT_CAP = MAX_SHORT_SCRIPT_SEGMENTS;

/** 参考素材去重：按 subjectTag 去重（同一参考帧只注入一次，保序保留首个）。
 * 键取「提示词参考帧编号」而非 description：素材来自 resolveMaterialRefs 时编号唯一递增、
 * 内容已按 content_hash 在素材层去重，故此处对内部路径为防御性无操作；仅当外部调用方以
 * 重复编号构造 referenceMaterials 时按编号保留首个，避免同一 <Subject N> 注入两次。 */
function dedupeShortScriptMaterials(materials: ReadonlyArray<ShortScriptReferenceMaterial>): ShortScriptReferenceMaterial[] {
  const seen = new Set<string>();
  const result: ShortScriptReferenceMaterial[] = [];
  for (const material of materials) {
    if (material && material.subjectTag && !seen.has(material.subjectTag)) {
      seen.add(material.subjectTag);
      result.push(material);
    }
  }
  return result;
}

export interface ShortScriptRecord {
  /** 该剧情手动选中素材的快照（material_refs），供素材引入审计与 Ref2VA 参考帧。 */
  materialRefs?: ShortDramaMaterialRef[];
  scriptId: string;
  sourceFingerprint: string;
  /** 本次产物的创意来源（历史列表语义展示与幂等审计依据） */
  idea?: string;
  instruction?: string;
  /** 时长模式：fixed=固定目标时长（targetDurationSeconds 生效）；auto=不限时长（由模型编排） */
  durationMode: ShortScriptDurationMode;
  /** fixed 模式的目标时长；auto 模式回填产物实际总时长（sum of durationSeconds），保证历史展示与排序可用 */
  targetDurationSeconds: number;
  /** 模型穷举的剧情节拍清单（审计与覆盖校验依据） */
  plotBeats: PlotBeat[];
  /** 吸引力设计承诺（契约 v10）：主引擎/反转点/记忆镜头；旧产物与外部 submit 缺省为 undefined */
  creativeStrategy?: ShortScriptCreativeStrategy;
  /** 影视镜头语言提示（提示级，不阻断）：缺少运镜/景别描述的镜头清单 */
  cinematicHints: string[];
  characters: ChapterScriptCharacterSheet[];
  segments: AssembledChapterScriptSegment[];
}

/**
 * 创意短剧本契约版本：与章节剧本契约独立演进。
 * v2 = 独立存储契约（projectId 可选、幂等作用域含 independent 占位；当时产物落服务端表，
 *      该表与 13 行存量已随迁移 093 删除，现由前端 IndexedDB 承担）；
 * v3 = 描述体量契约（skill v1.4.0 体量要求 + schema 描述下限抬升），旧简短产物指纹失效重生成；
 * v4 = 时长与语言契约（片段上限 10s→15s、描述字段放开中文、skill v1.4.2 冲击场面细节指引）；
 * v5 = 片段时长分布契约（skill v1.4.3：时长按信息密度取值，宏大/战斗片段取上沿
 *      12-15s，禁止整体贴下限——根因：v4 实测模型把 5-15s 区间理解为均匀中值，
 *      30s 目标交付 [8,7,9]，冲击场面画面无法充分展开）；
 * v6 = 片段时长区间收紧 10-15s（MIN 5→10）+ 创意意图忠实性契约（skill v1.4.4：
 *      展示型创意按视觉展示模式组织节拍，不强行注入对抗事件；冲突导向剧作
 *      契约仅对剧情型创意生效——根因：实测「展示修仙界山河」创意被套进
 *      冲突模板，产出追兵/迎敌剧情）；
 * v7 = 震撼强度契约（skill v1.5.0）——宏大/冲击/展示镜头必须执行强度层：
 *      单镜主视觉焦点、动态张力（蓄力→爆发，禁全程匀速慢镜）、尺度对比句
 *      （渺小锚点 vs 巨物）、光效反差（逆光剪影/强光柱/明暗爆发）、冲击时间感
 *      （根因：v6 产物细节充分但生成画面仍平淡，震撼缺失源于镜头缺强度——
 *      动态、尺度、光效、冲击四变量全弱，而非细节不足）。
 * v8 = 画面设计层契约（skill v1.6.0，与章节剧本契约 v11 同源）——镜头四要素
 *      扩为六要素，补上构图设计（主体位置 / 前景遮挡 / 引导线 / 层次分割 /
 *      框中框 / 负空间）与色彩设计（每场主色 + 强调色、色彩随情绪与时空转场）；
 *      新增反平庸默认态清单（裸中景 / 平光 / 中性色彩 / 匀速运镜，命中即重写）；
 *      风格句升级为可复原的具体参照。
 *      根因同章节 v11：v7 的四个强度变量全在事件层面（镜头里发生什么），
 *      而"平平无奇"是画面层面问题（画框里怎么安排、色彩怎么设计），这一层
 *      全库关键词命中为 0，且居中构图与无色彩设计正是视频模型默认出片态。
 *      配套减负：代码侧删除与 skill 指引重复的类型判定段与剧作段（重复段挤占
 *      注意力预算，长指引被模型做词汇层合规而非真正执行），只保留运行时事实。
 * v1 产物由迁移 050 带入新表，读取层零转换（payload 结构一致）。
 * v9 = 画面层三处细化（skill v1.6.1，与章节剧本契约 v12 同源）——针对 v8 实测
 *      仍偏"廉价震撼"的三类问题：① 天光改为受控明暗雕塑，禁止硬爆白 god-ray
 *      （veiled through haze），去掉生硬刺目纯白刀光；② 动态张力须服务沉浸，
 *      禁止无铺垫猛拽/急甩/瞬切（whiplash/snap），展示型奇观优先缓慢庄严连续
 *      运动与优雅涌起；③ 宏大场景除尺度对比外，逼模型把建筑本身设计得崇高
 *      （垂直拔升/无尽重复韵律/超验尺度/标志轮廓/表面密度/主导画框）。根因：
 *      这三项在 v8 由契约明文主张（blinding god-ray、violent 猛冲、仅"小人对比"
 *      交代尺度），模型照抄，故产物出现刺目天光、出戏快镜、建筑空旷。
 * 不限时长模式（durationMode=auto，skill v1.7.0 同批）：新增输入维度而非既有
 *      行为契约变更——fixed 路径的 prompt、schema 与指纹逐字节不变，故契约版本
 *      不递增（递增会让全部既有产物无谓失效重生成）；auto 输入在幂等键时长槽位
 *      记 "auto" 与 fixed 数值隔离，旧产物读取层按 payload.durationMode 缺省
 *      fixed 兼容。
 * v10 = 吸引力设计契约（skill v1.9.0；1.9.1/迁移 080 微修选型判据——引擎选择依据
 *      "创意靠什么让观众看完"而非表面题材元素，悬疑反转型不得因超自然背景误归 awe，
 *      schema 与契约语义不变；1.9.2/迁移 081 风格句移除画幅项——用户反馈产物每段都
 *      描述长宽比 9:16：指引层原把「画幅与焦段」列为风格句必含项且示例锚定 9:16，而
 *      两阶段规划的 styleLine 又被逐字复用到每一段，一次锚定即全片复读；比例由生成
 *      参数决定、写进提示词不改变画面，故必含项改为「焦段与镜头感」并明文禁止画幅与
 *      朝向进任何字段，schema 与契约语义不变）——schema 顶层新增 creativeStrategy
 *      （hookType=awe/humor/conflict + subversion + signatureMoment，三字段强制承诺、
 *      随 payload 落库）；short.script 指引新增「吸引力设计契约」「喜剧机制契约」，
 *      反原型支点从「必须是巨构」放宽为引擎相关视觉/空间载体并删除具象母题示例。
 *      根因（用户反馈：独立短剧缺乏创意和新意）：① 全部契约只服务震撼一条线，
 *      搞笑/反差零指引，吸引类型单一化；② 创意决策（观众为什么看完、哪一帧值得
 *      转发）无显式产出槽位，模型按模板走流程；③ 契约示例自教默认母题（倒悬巨钟）。
 *      schema 强制承诺 + 落库审计是本版核心，指引层与 brainstorm 跨引擎升级同批。
 */
export const SHORT_SCRIPT_CONTRACT_VERSION = "10";

/** 目标时长 clamp：超出上下限时收敛到边界而非拒绝（运营参数级输入）。 */
export function clampShortScriptTargetSeconds(target: number | undefined): number {
  if (typeof target !== "number" || !Number.isFinite(target)) return DEFAULT_SHORT_SCRIPT_TARGET_SECONDS;
  return Math.min(MAX_SHORT_SCRIPT_TARGET_SECONDS, Math.max(MIN_SHORT_SCRIPT_TARGET_SECONDS, Math.round(target)));
}

/** 分段数下限：目标时长全部按最长单段（15s）承载时仍需要的片段数。 */
export function deriveShortScriptMinSegments(targetDurationSeconds: number): number {
  return Math.max(1, Math.ceil(targetDurationSeconds / MAX_SEGMENT_SECONDS));
}

/** 分段数上限：目标时长全部按最短单段（10s）承载时的片段数，封顶常量上限。 */
export function deriveShortScriptMaxSegments(targetDurationSeconds: number): number {
  return Math.min(MAX_SHORT_SCRIPT_SEGMENTS, Math.max(1, Math.ceil(targetDurationSeconds / MIN_SEGMENT_SECONDS)));
}

/**
 * 短剧本时长窗口观察（零阻断契约：不再阻断产出，仅保留给调用方做人工复核提示）。
 * 根因：无窗口约束时模型可交付远低于目标的碎片化产物，创意承诺的体量与产物
 * 体量脱节；但硬校验会把可展示产物整批拒掉（2026-08-31 用户指令：产物不做
 * 任何校验，直接显示），故窗口只作为 prompt 预算约束与人工复核观察存在。
 */
export function observeShortScriptTotalDuration(segments: ReadonlyArray<{ durationSeconds: number }>, targetDurationSeconds: number): string | null {
  const total = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  if (Math.abs(total - targetDurationSeconds) > SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS) {
    return `总时长 ${total}s 偏离目标 ${targetDurationSeconds}s 超过 ±${SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS}s 容差（零阻断契约：不阻止展示，供人工复核）`;
  }
  return null;
}

/**
 * 短剧本 schema：结构复用章节剧本 schema，分段数量上下限按目标时长预算收窄；
 * targetDurationSeconds=null（不限时长模式）时无预算可推导，放开为 1 段 - 段数
 * 硬顶（AUTO_DURATION_SEGMENT_CAP=36），总时长与片段数由模型依据创意自定。
 * v10 起顶层叠加 creativeStrategy（吸引力设计承诺）——只在短剧 schema 叠加，
 * 章节剧本 schema 不继承（章节派生不创作故事，创意决策属于正文侧）。
 */
export function buildShortScriptSchema(targetDurationSeconds: number | null): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(CHAPTER_SCRIPT_H3_SCHEMA)) as {
    required: string[];
    properties: { segments: { minItems: number; maxItems: number }; [key: string]: unknown };
  };
  schema.properties.segments.minItems = targetDurationSeconds === null ? 1 : deriveShortScriptMinSegments(targetDurationSeconds);
  schema.properties.segments.maxItems = targetDurationSeconds === null
    ? AUTO_DURATION_SEGMENT_CAP
    : deriveShortScriptMaxSegments(targetDurationSeconds);
  schema.properties.creativeStrategy = buildCreativeStrategySchema();
  if (!schema.required.includes("creativeStrategy")) schema.required.push("creativeStrategy");
  return schema;
}

export function buildShortScriptPrompt(input: {
  projectTitle: string;
  idea: string;
  instruction?: string;
  /** 固定目标时长（fixed 模式）；null = 不限时长模式（auto），总时长与片段数由模型编排。 */
  targetDurationSeconds: number | null;
  minSegments: number;
  maxSegments: number;
  /** 近期已用母题（跨作品反同质，可选）：来自历史短剧产物的核心创意清单。 */
  avoidMotifs?: ReadonlyArray<string>;
  /** 本剧情选入的公用参考素材（素材库 → Ref2VA 参考帧，可选）。 */
  referenceMaterials?: ReadonlyArray<ShortScriptReferenceMaterial>;
}): string {
  const autoDuration = input.targetDurationSeconds === null;
  const strategyLine = "先按 skill「吸引力设计契约」输出顶层 creativeStrategy（主引擎 hookType=awe/humor/conflict 三选一、反转点 subversion、唯一记忆镜头 signatureMoment），再据此穷举节拍、拆分片段——全片节拍或为记忆镜头铺垫或为其引爆收束。";
  const taskLine = autoDuration
    ? `任务：把上述核心创意扩展为一条自洽的简短短剧脚本（MiniMax H3 全参考模式），总时长不设上限——由你依据核心创意的信息量与叙事节奏自行决定。先给出出场人物的 appearanceEn 外观基线（各片段 subjectDefinitions 必须复用同一外形描述；描述性文字中英文均可，H3 对中文提示词兼容），再拆分片段。${strategyLine}`
    : `任务：把上述核心创意扩展为一条自洽的简短短剧脚本（MiniMax H3 全参考模式），共 ${input.targetDurationSeconds} 秒左右。先给出出场人物的 appearanceEn 外观基线（各片段 subjectDefinitions 必须复用同一外形描述；描述性文字中英文均可，H3 对中文提示词兼容），再拆分片段。${strategyLine}`;
  // 时长预算行与覆盖/呈现/体量/边界契约块抽到 staged-script-generation 共享（两阶段
  // 规划/批次 prompt 复用同一文本），此处保持原拼接顺序与措辞，fixed 单次路径逐字节不变。
  const durationLine = shortScriptDurationBudgetLine({
    targetDurationSeconds: input.targetDurationSeconds,
    minSegments: input.minSegments,
    maxSegments: input.maxSegments,
  });
  const avoidLine = buildShortScriptAvoidMotifLine(input.avoidMotifs ?? []);
  return [
    `作品名称：${input.projectTitle}`,
    `核心创意：${input.idea.trim()}`,
    taskLine,
    [
      SHORT_SCRIPT_COVERAGE_CONTRACT,
      SHORT_SCRIPT_PRESENTATION_CONTRACT,
      durationLine,
      SHORT_SCRIPT_DESCRIPTION_VOLUME_CONTRACT,
    ].join("\n"),
    // 创意意图忠实性（剧情型 / 展示型判定）与剧集剧作层（开场即冲突 / 情绪闭环 / 出口即
    // 钩子 / 台词密度 / 反转须有伏笔 / 人物经济）均由运行时 skill（h3-video-prompt，
    // priority=required）注入，此处不再重复。与章节链路同因：重复段此前挤占注意力预算，
    // 长指引被模型做词汇层合规（换大词、加 violent）而非真正执行；去重后新增的画面
    // 设计层才有预算落地。代码侧仅保留 skill 不掌握的运行时事实（时长预算、节拍映射、边界）。
    avoidLine,
    buildShortScriptMaterialLine(input.referenceMaterials ?? []),
    SHORT_SCRIPT_BOUNDARY_CONTRACT,
    input.instruction?.trim() ? `作者指令（优先遵守其与格式规范相容的部分）：${input.instruction.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

const SHORT_SCRIPT_SYSTEM_BASE = "你是短剧分镜剧本提示词创作器。只依据给定的核心创意与指令输出符合 JSON Schema 的剧本：顶层 creativeStrategy 是全片吸引力设计承诺（主引擎 hookType、反转点 subversion、唯一记忆镜头 signatureMoment，先于节拍承诺、全片执行不可偏离），plotBeats 是穷举的剧情节拍清单，characters 是出场人物外观基线，segments 是按播放顺序排列的片段数组（用 beatIds 引用节拍）。";

/** 独立短剧不再关联小说项目（浏览器本地存储），项目标题固定占位。 */
function independentProjectTitle(): string {
  return "独立短剧";
}

/** 创意输入校验错误：携带建议 HTTP 状态码（与 ChapterScriptSourceError 同契约模式）。 */
export class ShortScriptInputError extends Error {
  constructor(readonly statusCode: 400 | 404, message: string) {
    super(message);
    this.name = "ShortScriptInputError";
  }
}

export async function generateShortScriptH3(input: {
  /** 本剧情选入的公用参考素材（素材库 → Ref2VA 参考帧），注入提示词并用幂等键约束。 */
  referenceMaterials?: ReadonlyArray<ShortScriptReferenceMaterial>;
  /** 该剧情选素材的历史快照（material_refs；随脚本落前端 IndexedDB）。 */
  materialRefs?: ShortDramaMaterialRef[];
  /** 跨作品反同质回避清单（前端从本地历史近期创意传入，可选）。 */
  avoidMotifs?: ReadonlyArray<string>;
  idea: string;
  instruction?: string;
  /** 时长模式：fixed（默认）=固定目标时长；auto=不限时长，由模型依据创意编排总时长与片段数。 */
  durationMode?: string;
  targetDurationSeconds?: number;
}, deps: {
  model: ModelGateway;
  skillProvider: SkillProvider;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
}): Promise<ShortScriptRecord> {
  const idea = input.idea?.trim() ?? "";
  if (idea.length < MIN_IDEA_LENGTH) {
    throw new ShortScriptInputError(400, `核心创意过短：至少 ${MIN_IDEA_LENGTH} 个字符，须写清谁、何处、什么冲突`);
  }
  // 参考素材去重（同帧只注入一次）。
  const referenceMaterials = dedupeShortScriptMaterials(input.referenceMaterials ?? []);
  const materialRefs = input.materialRefs && input.materialRefs.length ? input.materialRefs : undefined;
  const durationMode = normalizeShortScriptDurationMode(input.durationMode);
  // auto（不限时长）：schema/prompt 以 null 传"无目标时长"；fixed 沿用原 clamp 预算推导。
  const budgetSeconds = durationMode === "auto" ? null : clampShortScriptTargetSeconds(input.targetDurationSeconds);
  const minSegments = budgetSeconds === null ? 1 : deriveShortScriptMinSegments(budgetSeconds);
  const maxSegments = budgetSeconds === null ? AUTO_DURATION_SEGMENT_CAP : deriveShortScriptMaxSegments(budgetSeconds);

  const workflowId = `short-script:${randomUUID()}`;
  const skillScopeId = "";
  const skillBundle = await resolveStageSkillBundle({
    projectId: skillScopeId,
    provider: deps.skillProvider,
    executionPoint: SHORT_SCRIPT_EXECUTION_POINT,
    preflightId: workflowId,
  });
  const skillSections = buildSkillContextSections(skillBundle, SHORT_SCRIPT_EXECUTION_POINT);

  // 幂等指纹（浏览器端幂等依据，stateless 不再落库/不复读 DB）：scope(independent) + idea
  // + instruction + 时长维度 + 契约版本 + skill 版本 + 参考素材(mat: 段)；前端按
  // sourceFingerprint / 本地键在 IndexedDB 内去重。
  const skillVersionPart = skillBundle.skills.map((skill) => `${skill.skillId}@${skill.version}`).sort().join("+");
  const materialsPart = referenceMaterials.map((material) => `${material.subjectTag}:${material.description}`).join("|");
  const fingerprintSuffix = materialsPart ? `:mat:${materialsPart}` : "";
  const sourceFingerprint = createHash("sha256").update(
    `independent:${idea}:${input.instruction?.trim() ?? ""}:${shortScriptDurationKey({ durationMode, targetDurationSeconds: budgetSeconds ?? DEFAULT_SHORT_SCRIPT_TARGET_SECONDS })}:${SHORT_SCRIPT_CONTRACT_VERSION}:${skillVersionPart}${fingerprintSuffix}`,
  ).digest("hex");

  // 跨作品反同质（契约 v10）：回避清单由前端从本地历史近期创意传入（浏览器端管理历史），
  // 剔除与当前 idea 相同条目后注入 prompt。零阻断（空清单即不注入）。
  const avoidMotifs = [...new Set((input.avoidMotifs ?? []).map((motif) => motif.trim()).filter((motif) => motif && motif !== idea))].slice(0, SHORT_SCRIPT_AVOID_MOTIF_LIMIT);

  const projectTitle = independentProjectTitle();

  // 大预算脚本（maxSegments 超过单次阈值：auto 恒为 36 段上界、fixed ≥70s）走
  // 两阶段生成：规划骨架一次小输出 + 分批片段撰写。根因与机制见 staged-script-generation
  // 模块注释——单次 36 段六段字段输出实测结构性断裂，且修复循环在恒温下逐字节复现失败。
  if (usesShortScriptStagedGeneration(maxSegments)) {
    const plan = await generateShortScriptStaged({
      workflowId,
      projectTitle,
      idea,
      instruction: input.instruction,
      budgetSeconds,
      minSegments,
      maxSegments,
      avoidMotifs,
      referenceMaterials,
      skillBundle,
      skillScopeId,
      deps,
    });
    const normalized = normalizeChapterScriptOutput(
      { plotBeats: plan.plotBeats, characters: plan.characters, segments: plan.segments },
      { minSegments, shared: { lines: [], maxLabel: 0 } },
    );
    return finalizeShortScriptRecord({
      materialRefs,
      idea,
      instruction: input.instruction?.trim() || undefined,
      durationMode,
      budgetSeconds,
      maxSegments,
      sourceFingerprint,
      normalized,
      creativeStrategy: plan.creativeStrategy,
      strategyHint: plan.strategyHint,
    });
  }

  const schema = buildShortScriptSchema(budgetSeconds);
  const promptPackage = compileStageContext({
    projectId: skillScopeId,
    workflowId,
    purpose: "writing.script",
    stage: "drafting",
    system: SHORT_SCRIPT_SYSTEM_BASE,
    schema,
    maxInputTokens: 128_000,
    // 32k 输出预算：180s 时长上限下最多 36 段 × ~500 token/段的六段结构 promptText。
    reservedOutputTokens: 32_000,
    skillManifest: skillBundle.resolution,
    sections: [
      {
        id: "short-script-task",
        kind: "manuscript",
        title: "短剧脚本创作任务与核心创意",
        text: buildShortScriptPrompt({
          projectTitle,
          idea,
          instruction: input.instruction,
          targetDurationSeconds: budgetSeconds,
          minSegments,
          maxSegments,
          avoidMotifs,
          referenceMaterials,
        }),
        priority: "critical",
        provenanceRefs: ["input:idea:independent"],
      },
      ...skillSections,
    ],
  });

  const generated = await deps.model.generateStructured({
    purpose: "writing.script",
    system: promptPackage.system ?? SHORT_SCRIPT_SYSTEM_BASE,
    prompt: promptPackage.instruction,
    schema,
    schemaName: "short-script-h3",
    maxTokens: 32_000,
    routingSnapshot: deps.routingSnapshot,
    candidateStartIndex: deps.candidateStartIndex,
    workflowRunId: workflowId,
    taskId: `${workflowId}:script`,
    promptContext: promptPackage.manifest,
    // 零阻断契约：不传 extraValidate——结构观察不回灌 repair，产物直接组装显示。
  });

  const normalized = normalizeChapterScriptOutput(generated.value, { minSegments, shared: { lines: [], maxLabel: 0 } });
  const strategy = normalizeCreativeStrategy((generated.value as { creativeStrategy?: unknown } | null)?.creativeStrategy);
  return finalizeShortScriptRecord({
    materialRefs,
    idea,
    instruction: input.instruction?.trim() || undefined,
    durationMode,
    budgetSeconds,
    maxSegments,
    sourceFingerprint,
    normalized,
    creativeStrategy: strategy.strategy,
    strategyHint: strategy.hint,
  });
}

/** 两阶段/单次共用的收尾：零阻断观察 → 实际总时长回填 → 落库 → 组装 record。 */
async function finalizeShortScriptRecord(context: {
  materialRefs?: ShortDramaMaterialRef[];
  idea: string;
  instruction?: string;
  durationMode: ShortScriptDurationMode;
  budgetSeconds: number | null;
  maxSegments: number;
  sourceFingerprint: string;
  normalized: ReturnType<typeof normalizeChapterScriptOutput>;
  /** 吸引力设计承诺（已零阻断归一；非法/缺失时 undefined + strategyHint 进观察） */
  creativeStrategy?: ShortScriptCreativeStrategy;
  strategyHint?: string;
}): Promise<ShortScriptRecord> {
  const { materialRefs, idea, instruction, durationMode, budgetSeconds, maxSegments, sourceFingerprint, normalized, creativeStrategy, strategyHint } = context;
  // 零阻断契约：段数与总时长偏离只作为人工复核提示，不再抛错阻止落库展示。
  // 不限时长模式（auto）没有外部目标时长：总时长窗口观察不适用（模型自定即其目标），
  // 仅保留段数硬顶观察；产物 targetDurationSeconds 记为模型交付的实际总时长。
  const hints = [...normalized.hints];
  if (strategyHint) hints.unshift(`- ${strategyHint}`);
  if (normalized.segments.length > maxSegments) {
    hints.push(`- 片段数 ${normalized.segments.length} 超过时长预算上限 ${maxSegments}（每段至少 ${MIN_SEGMENT_SECONDS}s）；供人工复核`);
  }
  const totalSeconds = normalized.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  if (budgetSeconds !== null) {
    const totalIssue = observeShortScriptTotalDuration(normalized.segments, budgetSeconds);
    if (totalIssue) hints.push(`- ${totalIssue}`);
  }
  const recordTargetSeconds = budgetSeconds ?? totalSeconds;
  const scriptId = randomUUID();
  return {
    ...(materialRefs ? { materialRefs } : {}),
    scriptId,
    sourceFingerprint,
    idea,
    instruction,
    durationMode,
    targetDurationSeconds: recordTargetSeconds,
    plotBeats: normalized.plotBeats,
    ...(creativeStrategy ? { creativeStrategy } : {}),
    cinematicHints: [...hints, ...computeCinematicHints(normalized.segments)],
    characters: normalized.characters,
    segments: normalized.segments,
  };
}

/** 生成依赖的公共形状（generateShortScriptH3 deps 的子集 + 两阶段复用）。stateless：无 repository/objects。 */
interface ShortScriptGenerationDeps {
  model: ModelGateway;
  skillProvider: SkillProvider;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
}

/**
 * 两阶段生成执行器：阶段 1 规划骨架（creativeStrategy/styleLine/plotBeats/
 * characters/segmentPlan），阶段 2 按 SHORT_SCRIPT_SEGMENTS_PER_BATCH 段一批撰写
 * 完整片段并按全局序号拼接。
 * 任一批候选链耗尽即整体失败，不落半成品；批 prompt 携带全片规划、风格句、人物
 * 基线与前序段落摘要，保证跨批连续性与外观一致性。审计留痕按阶段拆分 taskId
 * （:plan / :segments:N），prompt_executions 与 model_invocations 可逐批回读。
 */
async function generateShortScriptStaged(context: {
  workflowId: string;
  projectTitle: string;
  idea: string;
  instruction?: string;
  budgetSeconds: number | null;
  minSegments: number;
  maxSegments: number;
  avoidMotifs: ReadonlyArray<string>;
  referenceMaterials?: ReadonlyArray<ShortScriptReferenceMaterial>;
  skillBundle: Awaited<ReturnType<typeof resolveStageSkillBundle>>;
  skillScopeId: string;
  deps: ShortScriptGenerationDeps;
}): Promise<{
  plotBeats: PlotBeat[];
  characters: ChapterScriptCharacterSheet[];
  segments: Array<Record<string, unknown>>;
  creativeStrategy?: ShortScriptCreativeStrategy;
  strategyHint?: string;
}> {
  const { workflowId, projectTitle, idea, instruction, budgetSeconds, minSegments, maxSegments, avoidMotifs, referenceMaterials, skillBundle, skillScopeId, deps } = context;
  const provenanceRefs = ["input:idea:independent"];

  const planSchema = buildShortScriptPlanSchema(minSegments, maxSegments);
  const planPackage = compileStageContext({
    projectId: skillScopeId,
    workflowId,
    purpose: "writing.script",
    stage: "drafting",
    system: SHORT_SCRIPT_SYSTEM_BASE,
    schema: planSchema,
    maxInputTokens: 128_000,
    reservedOutputTokens: SHORT_SCRIPT_PLAN_MAX_TOKENS,
    skillManifest: skillBundle.resolution,
    sections: [
      {
        id: "short-script-plan",
        kind: "manuscript",
        title: "短剧脚本规划任务与核心创意",
        text: buildShortScriptPlanPrompt({
          projectTitle,
          idea,
          instruction,
          targetDurationSeconds: budgetSeconds,
          minSegments,
          maxSegments,
          avoidMotifs,
          referenceMaterials,
        }),
        priority: "critical",
        provenanceRefs,
      },
      ...skillSectionsOf(skillBundle),
    ],
  });
  const planResult = await deps.model.generateStructured<ShortScriptPlan>({
    purpose: "writing.script",
    system: planPackage.system ?? SHORT_SCRIPT_SYSTEM_BASE,
    prompt: planPackage.instruction,
    schema: planSchema,
    schemaName: "short-script-h3-plan",
    maxTokens: SHORT_SCRIPT_PLAN_MAX_TOKENS,
    routingSnapshot: deps.routingSnapshot,
    candidateStartIndex: deps.candidateStartIndex,
    workflowRunId: workflowId,
    taskId: `${workflowId}:plan`,
    promptContext: planPackage.manifest,
  });
  const plan = planResult.value;
  if (!Array.isArray(plan?.segmentPlan) || !plan.segmentPlan.length) {
    throw new Error("两阶段规划没有返回任何分段骨架（segmentPlan 为空）");
  }
  // 吸引力设计在规划阶段一次承诺，批次逐段兑现（零阻断：非法只出复核提示）。
  const strategy = normalizeCreativeStrategy(plan.creativeStrategy);

  const batchRanges = sliceShortScriptBatchRanges(plan.segmentPlan.length, SHORT_SCRIPT_SEGMENTS_PER_BATCH);
  const assembledSegments: Array<Record<string, unknown>> = [];
  const previousSegments: ShortScriptPreviousSegment[] = [];
  for (const [batchIndex, range] of batchRanges.entries()) {
    const batchPlan = plan.segmentPlan.slice(range.start, range.start + range.count);
    const batchSchema = buildShortScriptBatchSchema(batchPlan.length);
    const batchPackage = compileStageContext({
      projectId: skillScopeId,
      workflowId,
      purpose: "writing.script",
      stage: "drafting",
      system: SHORT_SCRIPT_SYSTEM_BASE,
      schema: batchSchema,
      maxInputTokens: 128_000,
      reservedOutputTokens: SHORT_SCRIPT_BATCH_MAX_TOKENS,
      skillManifest: skillBundle.resolution,
      sections: [
        {
          id: "short-script-batch",
          kind: "manuscript",
          title: "短剧脚本片段批次撰写任务",
          text: buildShortScriptBatchPrompt({
            projectTitle,
            idea,
            instruction,
            creativeStrategy: strategy.strategy,
            styleLine: plan.styleLine,
            characters: plan.characters,
            plotBeats: plan.plotBeats,
            segmentPlan: plan.segmentPlan,
            batchStartIndex: range.start,
            batchPlan,
            previousSegments,
            referenceMaterials,
          }),
          priority: "critical",
          provenanceRefs,
        },
        ...skillSectionsOf(skillBundle),
      ],
    });
    let batchSegments: Array<Record<string, unknown>>;
    try {
      const batchResult = await deps.model.generateStructured<{ segments: Array<Record<string, unknown>> }>({
        purpose: "writing.script",
        system: batchPackage.system ?? SHORT_SCRIPT_SYSTEM_BASE,
        prompt: batchPackage.instruction,
        schema: batchSchema,
        schemaName: "short-script-h3-batch",
        maxTokens: SHORT_SCRIPT_BATCH_MAX_TOKENS,
        routingSnapshot: deps.routingSnapshot,
        candidateStartIndex: deps.candidateStartIndex,
        workflowRunId: workflowId,
        taskId: `${workflowId}:segments:${batchIndex}`,
        promptContext: batchPackage.manifest,
      });
      batchSegments = Array.isArray(batchResult.value?.segments) ? batchResult.value.segments : [];
    } catch (error) {
      // 外部 MCP 兜底等待保持原异常类型上抛（API 层按类型映射 503；包装会吞掉类型）。
      if (error instanceof ExternalMcpRequiredError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`短剧分批生成失败（第 ${batchIndex + 1}/${batchRanges.length} 批，全片第 ${range.start + 1}-${range.start + batchPlan.length} 段）：${detail}`);
    }
    if (batchSegments.length !== batchPlan.length) {
      throw new Error(`两阶段批次 ${batchIndex + 1}/${batchRanges.length} 返回段数 ${batchSegments.length} 与规划 ${batchPlan.length} 不一致`);
    }
    for (const [position, segment] of batchSegments.entries()) {
      const raw = segment as Record<string, unknown>;
      // 全局段序号与 promptText 由 normalizeChapterScriptOutput 统一回填（批次模型输出无序号字段）。
      assembledSegments.push(raw);
      previousSegments.push({
        index: range.start + position + 1,
        title: typeof raw.title === "string" ? raw.title : "",
        synopsis: typeof raw.synopsis === "string" ? raw.synopsis : "",
      });
    }
  }
  return { plotBeats: plan.plotBeats, characters: plan.characters, segments: assembledSegments, creativeStrategy: strategy.strategy, strategyHint: strategy.hint };
}

/** 两阶段各调用共用的 skill 注入段（与单次路径同一 bundle，不重复解析）。 */
function skillSectionsOf(skillBundle: Awaited<ReturnType<typeof resolveStageSkillBundle>>) {
  return buildSkillContextSections(skillBundle, SHORT_SCRIPT_EXECUTION_POINT);
}
