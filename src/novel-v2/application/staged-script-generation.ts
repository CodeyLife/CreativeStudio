/**
 * 短剧脚本两阶段生成契约（规划 → 分批片段撰写）。
 *
 * 根因：不限时长（durationMode=auto）与大预算 fixed 目标的单次结构化输出可达
 * 36 段 × 六段字段（数千 token 级），实测（2026-09-07）模型在该体量下生成
 * segments 数组结构性断裂的 JSON（片段对象漏写开括号，summary/retentionAnalysis
 * 等字段裸露在数组层级），且 temperature 恒定时修复循环逐字节复现同一非法输出，
 * 三次重试全部失败；中转链路（Cloudflare ~100s 超时窗口）也会在长生成下超时。
 *
 * 机制：把「拆分段落骨架」（决策密度高、体量小）与「逐段六段字段撰写」（结构
 * 重复、体量大）拆成多次小输出调用——规划调用输出 creativeStrategy（吸引力设计）+
 * styleLine + plotBeats + characters + segmentPlan（每段仅节拍与时长），随后按批
 * （每批 SEGMENTS_PER_BATCH 段）撰写完整片段。单次输出体量与生成时长均压回中转超时
 * 窗口以内；分段决策在规划阶段一次完成，片段批次只做结构重复的正文撰写。
 *
 * 刻意不覆盖：段数 ≤ SINGLE_SHOT_SEGMENT_LIMIT 的小预算脚本沿用单次生成（输出
 * 体量小、历史行为稳定，两阶段只增加调用次数）；章节剧本链路（chapter-script-h3）
 * 暂不接入，需要时复用本模块的 schema/prompt 组装模式。
 */
import {
  ChapterScriptCharacterSheet,
  CHAPTER_SCRIPT_H3_SCHEMA,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  PlotBeat,
} from "./chapter-script-h3";

/** 总时长与目标时长的容差窗口：分段为 5-15s 整数粒度，任意合法目标可精确拼出；窗口用于吸收模型的近似分配。 */
export const SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS = 10;

/**
 * 主吸引引擎（吸引力设计契约，skill v1.9.0）：一支短剧必须承诺唯一主引擎。
 * awe=宏大与崇高（震撼奇观：巨构/天体/生灵/现象/空间法则）、humor=搞笑与错位
 * （喜剧机制契约）、conflict=剧情张力（既有剧作契约承接）。三值是通用情绪机制，
 * 不绑定任何题材。
 * TODO P2: 引擎族是跨题材经验分类（后续或扩怪诞/温情族），宜随剧本契约版本化并入配置。
 */
export const SHORT_SCRIPT_HOOK_ENGINES = ["awe", "humor", "conflict"] as const;
export type ShortScriptHookEngine = (typeof SHORT_SCRIPT_HOOK_ENGINES)[number];

/** 创意策略：承诺"观众为什么停下来、看完、转发"——主引擎、预期→反转、唯一记忆镜头。 */
export interface ShortScriptCreativeStrategy {
  hookType: ShortScriptHookEngine;
  /** 观众的题材模板预期 → 本片如何推翻或升级它（一句话） */
  subversion: string;
  /** 全片唯一记忆镜头的具体可见画面状态（一句话，3-5 秒可转述瞬间） */
  signatureMoment: string;
}

/** creativeStrategy 的 schema 片段：三属性全 required、无组合器，满足原生结构化输出约束。 */
export function buildCreativeStrategySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["hookType", "subversion", "signatureMoment"],
    properties: {
      hookType: { type: "string", enum: [...SHORT_SCRIPT_HOOK_ENGINES] },
      subversion: { type: "string", minLength: 8, maxLength: 300 },
      signatureMoment: { type: "string", minLength: 8, maxLength: 300 },
    },
  };
}

/**
 * 零阻断归一化：模型未承诺或字段非法时不拒产物，只出人工复核提示。
 * 与既有零阻断契约一致（2026-08-31 用户指令：产物不做任何校验直接显示）；
 * schema 层已强制三字段，这里是 provider 非严格模式降级时的观察兜底。
 */
export function normalizeCreativeStrategy(value: unknown): { strategy?: ShortScriptCreativeStrategy; hint?: string } {
  const raw = value as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") {
    return { hint: "产物缺少创意策略（creativeStrategy 未输出，吸引力设计未落字段，供人工复核）" };
  }
  const hookType = raw.hookType;
  const subversion = typeof raw.subversion === "string" ? raw.subversion.trim() : "";
  const signatureMoment = typeof raw.signatureMoment === "string" ? raw.signatureMoment.trim() : "";
  if (!(SHORT_SCRIPT_HOOK_ENGINES as ReadonlyArray<string>).includes(hookType as string) || !subversion || !signatureMoment) {
    return { hint: "产物创意策略不完整（hookType/subversion/signatureMoment 存在缺失或非法值，供人工复核）" };
  }
  return { strategy: { hookType: hookType as ShortScriptHookEngine, subversion, signatureMoment } };
}

/** 吸引力设计行（两阶段规划与批次共用）：把已承诺的策略压成一行不可偏离的撰写约束。 */
export function formatShortScriptStrategyLine(strategy: ShortScriptCreativeStrategy): string {
  const engineLabel: Record<ShortScriptHookEngine, string> = { awe: "震撼崇高", humor: "搞笑错位", conflict: "剧情张力" };
  return `全片吸引力设计（已承诺，不可偏离）：主引擎=${strategy.hookType}（${engineLabel[strategy.hookType]}）；反转点=${strategy.subversion}；记忆镜头=${strategy.signatureMoment}。承载记忆镜头的片段须把该帧写成其峰值镜头或出口镜头，全片节拍或为其铺垫或为其引爆收束。`;
}

/** 跨作品反同质注入条数上限：过多回避条目会稀释注意力预算。TODO P2: 魔法值，宜并入运营配置。 */
export const SHORT_SCRIPT_AVOID_MOTIF_LIMIT = 12;

/** 一部剧情注入的公用参考素材（素材库 → 生成提示词的 Ref2VA 参考帧）。 */
export interface ShortScriptReferenceMaterial {
  /** 提示词内固定编号参考帧标签（H3 Ref2VA <Subject N>，编号 1 起）。 */
  subjectTag: string;
  /** 简短素材描述，模型须在片段 subjectDefinitions 中对齐引用。 */
  description: string;
}

/**
 * 公用参考素材块（单次与两阶段规划/批次共用）：把本剧情选入的素材映射为
 * H3 Ref2VA 全参考模式的 <Subject N> 参考帧。ref2va 模式下，这些编号对应
 * 实际喂给视频生成器的参考图片；文本侧要求模型在片段 subjectDefinitions 中
 * 以固定编号引用并对齐描述，保证「素材图片 ↔ 文本提示」二者对应。
 * 无素材时返回空串（不输出该段）。
 */
export function buildShortScriptMaterialLine(materials: ReadonlyArray<ShortScriptReferenceMaterial>): string {
  const refs = materials
    .map((material) => `${material.subjectTag}：${material.description}`)
    .join("\n");
  if (!refs) return "";
  return [
    "公用参考素材（本剧情已选入的 Ref2VA 参考帧，<Subject N> 编号固定，务必在片段 subjectDefinitions 中引用并对齐其描述；同一帧只定义一次，后续片段直接用编号复用，不要再定义同一主体）：",
    refs,
  ].join("\n");
}

/**
 * 近期已用母题回避清单（跨次反同质）：注入的是历史输入本身而非固定短语黑名单
 * （符合 AGENTS.md 泛化约束——"什么算像"的判定交给模型，代码不猜）。
 */
export function buildShortScriptAvoidMotifLine(motifs: ReadonlyArray<string>): string {
  const unique = [...new Set(motifs.map((motif) => motif.trim()).filter(Boolean))].slice(0, SHORT_SCRIPT_AVOID_MOTIF_LIMIT);
  if (!unique.length) return "";
  return [
    "跨作品反同质（近期已产出短剧的核心创意，回避清单）：",
    ...unique.map((motif) => `- ${motif.slice(0, 120)}`),
    "- 本片的核心意象、材质、构成逻辑与引擎组合不得与上述任何一条同质（同质=换皮重复同一画面构思）；这是差异化要求，不是内容禁用。",
  ].join("\n");
}

/** 单次生成段数上限：maxSegments 超过该值时切换两阶段。TODO P2: 阈值宜随运营参数可配置。 */
export const SHORT_SCRIPT_SINGLE_SHOT_SEGMENT_LIMIT = 6;
/** 分批撰写每批段数：实测（2026-09-08）4 段批生成时长方差 54-190s，中转链路（Cloudflare）在 ~190s 出现 524 超时且重试同批大小无法自愈，2 段批单批输出减半稳落窗口内；总批次增加由 auto 长任务预期吸收。TODO P2: 批大小宜随运营参数/provider 速度可配置。 */
export const SHORT_SCRIPT_SEGMENTS_PER_BATCH = 2;
/** 规划调用输出预算：骨架（节拍/人物/分段表）远小于完整脚本。 */
export const SHORT_SCRIPT_PLAN_MAX_TOKENS = 8_000;
/** 单批片段撰写输出预算：4 段 × 六段字段（detailedDescription 350-500 词）。 */
export const SHORT_SCRIPT_BATCH_MAX_TOKENS = 12_000;
/**
 * 规划阶段分配优先指引（两阶段规划 prompt 专用）：时长分配发生在撰写之前——
 * 先按节拍的口播量（一句台词约 2-4 秒）与镜头动作量（一个完整动作与运镜约 3-5 秒）
 * 估算节拍所需时长，再把节拍分到装得下它的段。根因：规划阶段只定 beatIds+时长、
 * 批次阶段按语义写台词，两次决定互不对账时口径只能是"先定时长再填内容"，内容
 * 装不下就溢出（实测 13s 段塞 31s 口播）。该行与 skill v1.8.2「分配优先」总原则
 * 同源；折算常数是跨题材经验值（魔法值），TODO P2 并入项目级配置。
 */
export const SHORT_SCRIPT_PLAN_ALLOCATION_GUIDE =
  "- 分配优先：为每个节拍先估算所需时长——对白密集的节拍按台词句数（一句约 2-4 秒）加画面反应时间估算，动作/奇观节拍按镜头动作量（一个完整动作与运镜约 3-5 秒）估算；把节拍分到装得下它的段，语音与镜头都须分到足时，装不下就多拆一段，不要先定短时长再往里塞。对白密集与宏大场面分配 12-15s，纯画面节拍可 10-12s。";

/** 两阶段触发判定：由分段数上限决定，与时长模式解耦（auto 恒为 36 段上界 → 恒两阶段）。 */
export function usesShortScriptStagedGeneration(maxSegments: number): boolean {
  return maxSegments > SHORT_SCRIPT_SINGLE_SHOT_SEGMENT_LIMIT;
}

/**
 * 语音预算折算（代码侧运行时事实，两阶段批次撰写专用）：规划阶段已把每段
 * durationSeconds 定死，代码按此把 skill 语音层（口播守恒）的语速规则直接换算成
 * 模型可执行的每段数字——"≤N 字（≈M 句）"。根因：LLM 在流式生成时无法按字数
 * 自检（没有字数计数器），按句计数是模型可执行的最小计量单位（一句台词约
 * 2-4 秒）；折算数字依赖每段时长，属于 skill 指引不掌握的运行时事实，不算重复。
 * TODO P2: 折算常数（中文约 4-5 字/秒取保守下沿 4、一句台词约 2-4 秒取中值 3s）
 * 是跨题材经验值（魔法值），宜随剧本契约版本化并入项目级配置，与运行时 skill
 * v1.8.x 语音层（口播守恒）口径保持一致。
 */
export const VOICE_BUDGET_CJK_CHARS_PER_SECOND = 4;
export const VOICE_BUDGET_SECONDS_PER_SENTENCE = 3;

/** 把段时长换算成可执行语音预算行："语音预算：台词（含画外音）合计 ≤N 字（≈M 句台词）"。 */
export function shortScriptVoiceBudgetLine(durationSeconds: number): string {
  const chars = Math.floor(durationSeconds * VOICE_BUDGET_CJK_CHARS_PER_SECOND);
  const sentences = Math.max(1, Math.floor(durationSeconds / VOICE_BUDGET_SECONDS_PER_SENTENCE));
  return `语音预算：台词（含画外音）合计 ≤${chars} 字（≈${sentences} 句台词）`;
}

/** 全片分段骨架的一项：只承载节拍引用与时长，正文留待批次撰写。 */
export interface ShortScriptPlanSegment {
  beatIds: string[];
  durationSeconds: number;
}

/** 规划阶段产物：吸引力策略 + 整片风格句 + 节拍清单 + 人物外观基线 + 分段骨架。 */
export interface ShortScriptPlan {
  /** 未知形态交由 normalizeCreativeStrategy 零阻断归一（provider 非严格模式可能回显异常值） */
  creativeStrategy?: unknown;
  styleLine: string;
  plotBeats: PlotBeat[];
  characters: ChapterScriptCharacterSheet[];
  segmentPlan: ShortScriptPlanSegment[];
}

/** 批次切片：把全片 segmentPlan 按每批 perBatch 段切成连续区间。 */
export function sliceShortScriptBatchRanges(total: number, perBatch: number): Array<{ start: number; count: number }> {
  const ranges: Array<{ start: number; count: number }> = [];
  for (let start = 0; start < total; start += perBatch) {
    ranges.push({ start, count: Math.min(perBatch, total - start) });
  }
  return ranges;
}

/**
 * 规划阶段 schema：复用章节剧本 schema 的 plotBeats/characters 子树（避免两处
 * 漂移），新增 styleLine 与 segmentPlan 骨架。全部属性 required、无组合器，
 * 满足原生结构化 schema 静态约束（native-schema）。
 */
export function buildShortScriptPlanSchema(minSegments: number, maxSegments: number): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(CHAPTER_SCRIPT_H3_SCHEMA)) as {
    properties: { plotBeats: unknown; characters: unknown };
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["creativeStrategy", "styleLine", "plotBeats", "characters", "segmentPlan"],
    properties: {
      creativeStrategy: buildCreativeStrategySchema(),
      styleLine: { type: "string", minLength: 10, maxLength: 400 },
      plotBeats: base.properties.plotBeats,
      characters: base.properties.characters,
      segmentPlan: {
        type: "array",
        minItems: Math.max(1, minSegments),
        maxItems: maxSegments,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["beatIds", "durationSeconds"],
          properties: {
            beatIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 2, maxLength: 24 } },
            durationSeconds: { type: "integer", minimum: MIN_SEGMENT_SECONDS, maximum: MAX_SEGMENT_SECONDS },
          },
        },
      },
    },
  };
}

/** 批次撰写 schema：只要求本批 segments，段数与规划切片严格一致（分段决策已定，批次不得增删改划分）。 */
export function buildShortScriptBatchSchema(plannedSegmentCount: number): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(CHAPTER_SCRIPT_H3_SCHEMA)) as {
    properties: { segments: Record<string, unknown> };
  };
  const segments = base.properties.segments as { minItems: number; maxItems: number };
  segments.minItems = plannedSegmentCount;
  segments.maxItems = plannedSegmentCount;
  return {
    type: "object",
    additionalProperties: false,
    required: ["segments"],
    properties: { segments },
  };
}

// —— 与单次生成共享的契约文本块（自 buildShortScriptPrompt 原文提取，措辞逐字保持）——

export const SHORT_SCRIPT_COVERAGE_CONTRACT = [
  "剧情覆盖契约（先于拆分执行，输出为顶层 plotBeats + 各片段 beatIds 引用）：",
  "- 第一步：从核心创意穷举剧情节拍，输出为 plotBeats 数组，每项 {id, kind, summary}。kind 取值：event=动作事件、dialogue=对话交换、memory=背景记忆与身份处境、setup=关键设定与伏笔、hook=期限任务与钩子、decision=信念转折与决策判断。summary 必须写出该节拍携带的具体信息点（谁、何处、什么事），不得只写情绪词。",
  "- 第二步：拆分片段，每个片段用 beatIds 声明它承载的节拍；所有节拍都必须被某个片段承载，不得整块省略。",
].join("\n");

export const SHORT_SCRIPT_PRESENTATION_CONTRACT = [
  "信息呈现手段（硬性规则，剧情型创意适用；展示型创意的 setup 类节拍以画面本身呈现——奇观即信息，无需台词或闪回）：",
  "- memory / setup / hook 类节拍的承载片段，必须把具体信息呈现给观众，手段三选一：[Flashback] 闪回镜头（写出闪回画面里谁在何处做什么，2-4 个镜头）；台词 <d>（含画外音 voice-over，直接说出关键信息点）；屏幕可读文字。",
  "- 抱头、颤抖、喘息等反应动作只能表达「有信息涌入」这一事件，不能替代信息内容本身；只写反应动作会被判定为呈现缺失。",
].join("\n");

export const SHORT_SCRIPT_DESCRIPTION_VOLUME_CONTRACT =
  "描述体量：视频生成器只能依据文字复原画面，凡未写出的细节在成片中不存在。detailedDescription 每片段约 350-500 英文词或等体量中文，逐镜头写全 skill 指引的镜头六要素（景别角度/构图设计/运镜/光线氛围/色彩设计/状态变化）与主体外观；summary、retentionAnalysis、overallSoundscape 的写法见 skill 指引。禁止概要化、清单化或以一词带过。";

export const SHORT_SCRIPT_BOUNDARY_CONTRACT =
  "边界：忠实于核心创意给定的设定、冲突与人物关系，可以合理补全细节，不得新增与创意冲突的设定、人物或结局走向；创意点名的核心意象（标志性移动/驾驭方式、点名景观、标志性场面）属于不得替换范畴——专有概念必须在描述中展开为其文化语境的标准物理呈现（姿态、接触点、构图与地理形态），不得用字面直译、近似动作或模板化场景顶替；无对白来源约束时台词自拟，但语义须与节拍承载的信息一致。";

/** 时长预算行（fixed/auto 两种形态），单次与规划共用。 */
export function shortScriptDurationBudgetLine(input: { targetDurationSeconds: number | null; minSegments: number; maxSegments: number }): string {
  if (input.targetDurationSeconds === null) {
    return `- 时长编排（不限时长模式）：本次不设目标总时长。先为这条创意选择恰当的时长体量（简短钩子短片可数十秒，多幕递进的宏大叙事可更长），再据此拆分片段——体量须与创意的信息量相称：不为省事砍掉叙事必需的节拍，也不为凑长注水重复；各片段 durationSeconds 之和即为本片总时长，片段总数不得超过 ${input.maxSegments} 段。每段仍为 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s：宏大场面、战斗交锋与冲击性瞬间取区间上沿（约 12-15 秒）让画面充分展开；对话交锋与反应镜头也至少 10 秒，用镜头细节与氛围填充而非快切。`;
  }
  return `- 时长预算：目标时长 ${input.targetDurationSeconds} 秒；片段数须落在 ${input.minSegments}-${input.maxSegments} 个之间（每段 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s），各片段 durationSeconds 之和须落在目标 ±${SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS}s 容差内。片段时长禁止贴下限：宏大场面、战斗交锋与冲击性瞬间取区间上沿（约 12-15 秒）让画面充分展开；对话交锋与反应镜头也至少 10 秒，用镜头细节与氛围填充而非快切。`;
}

/** 规划阶段 prompt：小输出骨架，正文撰写交给批次。 */
export function buildShortScriptPlanPrompt(input: {
  projectTitle: string;
  idea: string;
  instruction?: string;
  targetDurationSeconds: number | null;
  minSegments: number;
  maxSegments: number;
  /** 近期已用母题（跨作品反同质，可选）：来自历史短剧产物的核心创意清单。 */
  avoidMotifs?: ReadonlyArray<string>;
  /** 本剧情选入的公用参考素材（素材库 → Ref2VA 参考帧，可选）。 */
  referenceMaterials?: ReadonlyArray<ShortScriptReferenceMaterial>;
}): string {
  const autoDuration = input.targetDurationSeconds === null;
  const taskLine = autoDuration
    ? "任务：把下述核心创意规划为一条自洽的简短短剧脚本（MiniMax H3 全参考模式），总时长不设上限——由你依据核心创意的信息量与叙事节奏自行决定。"
    : `任务：把下述核心创意规划为一条自洽的简短短剧脚本（MiniMax H3 全参考模式），目标总时长 ${input.targetDurationSeconds} 秒左右。`;
  const stagedLine = [
    "分阶段生成说明（本阶段只做规划，不写片段正文）：",
    "- creativeStrategy：先按 skill「吸引力设计契约」承诺全片创意策略三字段——hookType（awe/humor/conflict 三选一，主引擎全片唯一）、subversion（观众预期→本片如何推翻或升级）、signatureMoment（唯一记忆镜头的具体可见画面）；后续节拍与片段都围绕它组织，承载记忆镜头的节拍须在 plotBeats 的 summary 中写明该帧画面状态。",
    "- styleLine：整片风格句（画面质感、主色调与光效基调，1-2 句；按 skill 的风格句契约不写画幅与朝向），后续每个片段的 detailedDescription 将以其开头逐字复用，须一次写好——这一句里写了什么，全片每一段都会照它复述一遍。",
    "- characters：全部出场人物的 appearanceEn 外观基线（各片段 subjectDefinitions 必须复用同一外形描述；描述性文字中英文均可，H3 对中文提示词兼容）。",
    `- segmentPlan：全片分段骨架，按播放顺序每段仅声明承载节拍（beatIds）与时长（durationSeconds），段数落在 ${input.minSegments}-${input.maxSegments} 的恰当数量。segmentPlan 是后续批次撰写片段正文的不可变更划分依据；本阶段不得输出 title/synopsis/detailedDescription 等任何片段正文字段。`,
  ].join("\n");
  const avoidLine = buildShortScriptAvoidMotifLine(input.avoidMotifs ?? []);
  return [
    `作品名称：${input.projectTitle}`,
    `核心创意：${input.idea.trim()}`,
    taskLine,
    [
      SHORT_SCRIPT_COVERAGE_CONTRACT,
      SHORT_SCRIPT_PRESENTATION_CONTRACT,
      shortScriptDurationBudgetLine({ targetDurationSeconds: input.targetDurationSeconds, minSegments: input.minSegments, maxSegments: input.maxSegments }),
      SHORT_SCRIPT_PLAN_ALLOCATION_GUIDE,
    ].join("\n"),
    stagedLine,
    buildShortScriptMaterialLine(input.referenceMaterials ?? []),
    avoidLine,
    SHORT_SCRIPT_BOUNDARY_CONTRACT,
    input.instruction?.trim() ? `作者指令（优先遵守其与格式规范相容的部分）：${input.instruction.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

/** 前序段落摘要（跨批连续性依据）。 */
export interface ShortScriptPreviousSegment {
  index: number;
  title: string;
  synopsis: string;
}

/** 批次撰写 prompt：承载跨批一致性的全部上下文（吸引力策略/风格句/人物基线/全片规划/前序段落）。 */
export function buildShortScriptBatchPrompt(input: {
  projectTitle: string;
  idea: string;
  instruction?: string;
  /** 规划阶段已承诺的创意策略（非法形态已在调用前零阻断归一，非法则省略）。 */
  creativeStrategy?: ShortScriptCreativeStrategy;
  styleLine: string;
  characters: ChapterScriptCharacterSheet[];
  plotBeats: PlotBeat[];
  segmentPlan: ShortScriptPlanSegment[];
  batchStartIndex: number;
  batchPlan: ShortScriptPlanSegment[];
  previousSegments: ShortScriptPreviousSegment[];
  /** 本剧情选入的公用参考素材（素材库 → Ref2VA 参考帧，可选）。 */
  referenceMaterials?: ReadonlyArray<ShortScriptReferenceMaterial>;
}): string {
  const total = input.segmentPlan.length;
  const totalSeconds = input.segmentPlan.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const first = input.batchStartIndex + 1;
  const last = input.batchStartIndex + input.batchPlan.length;
  const taskLine = `任务：按已定全片分段规划撰写第 ${first}-${last} 段（全片共 ${total} 段、规划总时长约 ${totalSeconds}s）的完整分镜片段。每段 detailedDescription 以整片风格句开头逐字复用：${input.styleLine}`;
  const beatLine = input.plotBeats.map((beat) => `${beat.id}（${beat.kind}）：${beat.summary}`).join("\n");
  const characterLine = input.characters.map((character) => `${character.name}：${character.appearanceEn}`).join("\n");
  const overviewLine = `全片分段规划（不可变更，共 ${total} 段）：${input.segmentPlan.map((segment, index) => `第 ${index + 1} 段 ${segment.durationSeconds}s`).join("；")}`;
  const batchSpec = input.batchPlan.map((segment, position) => {
    const globalIndex = input.batchStartIndex + position + 1;
    const beats = segment.beatIds.map((id) => {
      const beat = input.plotBeats.find((item) => item.id === id);
      return beat ? `${id}（${beat.kind}：${beat.summary}）` : id;
    }).join("；");
    return `- 第 ${globalIndex} 段：时长 ${segment.durationSeconds}s；${shortScriptVoiceBudgetLine(segment.durationSeconds)}；承载节拍：${beats}`;
  }).join("\n");
  const previousLine = input.previousSegments.length
    ? `前序段落摘要（保持叙事与画面连续，不重置主体定义与风格句）：\n${input.previousSegments.map((segment) => `第 ${segment.index} 段《${segment.title}》：${segment.synopsis}`).join("\n")}`
    : "";
  const outputLine = "只输出符合 JSON Schema 的本批 segments 数组：每段含 title、synopsis、durationSeconds、beatIds 与完整六段字段（subjectDefinitions / summary / retentionAnalysis / detailedDescription / overallSoundscape / nonDiegeticMusic）。";
  return [
    `作品名称：${input.projectTitle}`,
    `核心创意：${input.idea.trim()}`,
    taskLine,
    input.creativeStrategy ? formatShortScriptStrategyLine(input.creativeStrategy) : "",
    [
      "全片剧情节拍清单：",
      beatLine,
      "",
      "人物外观基线（各片段 subjectDefinitions 必须复用同一外形描述）：",
      characterLine,
    ].join("\n"),
    [
      overviewLine,
      "本批逐段撰写要求（按顺序逐段输出，不得增删段落、不得更改规划时长与节拍归属；台词落在各段语音预算内，超出的台词压缩、改屏幕可读文字或移交相邻段）：",
      batchSpec,
    ].join("\n"),
    previousLine,
    buildShortScriptMaterialLine(input.referenceMaterials ?? []),
    SHORT_SCRIPT_PRESENTATION_CONTRACT,
    SHORT_SCRIPT_DESCRIPTION_VOLUME_CONTRACT,
    SHORT_SCRIPT_BOUNDARY_CONTRACT,
    outputLine,
    input.instruction?.trim() ? `作者指令（优先遵守其与格式规范相容的部分）：${input.instruction.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}
