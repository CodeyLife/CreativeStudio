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
 * 与列表过滤。产物落 short_scripts 独立表（迁移 050），不再走 artifacts。
 *
 * 流程：
 * 1. 校验创意输入与目标时长预算（分段数上下限，仅作为 prompt 预算注入）
 * 2. resolveStageSkillBundle(short.script) 注入 skill 指引 → generateStructured 调模型
 * 3. 复用 normalizeChapterScriptOutput 做零阻断组装（2026-08-31 起，用户指令：
 *    产物不做任何校验直接显示）——节拍覆盖、呈现手段、标签、时序、对白标记
 *    与总时长窗口全部降级为 hints 供人工复核，不回灌 repair、不阻止落库
 * 4. 六段按固定顺序组装成最终提示词，落 short_scripts 表
 *
 * 幂等键：作用域（projectId ?? "independent"）+ idea + instruction +
 * targetDuration + 契约版本，同输入重放复用既有产物；改创意、切换关联
 * 作用域或推进契约版本后自然失效重生成。
 */
import { createHash, randomUUID } from "node:crypto";
import type { SkillProvider } from "../protocol";
import type { ModelRoutingSnapshot } from "../model-routing";
import type { ModelGateway } from "../model-gateway";
import type { ObjectStoreAdapter } from "../object-store";
import { NovelPostgresRepository, type StoredShortScript } from "../postgres-repository";
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

/** 短剧产物类型标识：v2 起存储于 short_scripts 独立表，kind 仅作语义标签（迁移数据沿用 artifacts id）。 */
export const SHORT_SCRIPT_KIND = "short-script";
export const SHORT_SCRIPT_EXECUTION_POINT = "short.script" as const;

/** TODO P2: 短剧本时长/分段运营参数应来自项目级配置而非硬编码。 */
export const DEFAULT_SHORT_SCRIPT_TARGET_SECONDS = 30;
export const MIN_SHORT_SCRIPT_TARGET_SECONDS = 10;
/** 上限取 3 分钟：36 段 × ~500 token/段的六段结构 promptText 约 18k 输出 token，在 32k 预算内可控；更长剧情需分幕生成（独立契约演进项）。 */
export const MAX_SHORT_SCRIPT_TARGET_SECONDS = 180;
/** 180s ÷ 最短单段 5s = 36：段数 cap 与目标时长上限自洽。 */
export const MAX_SHORT_SCRIPT_SEGMENTS = 36;
/** 总时长与目标时长的容差窗口：分段为 5-15s 整数粒度，任意合法目标可精确拼出；窗口用于吸收模型的近似分配。 */
export const SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS = 10;
/** 核心创意输入最小长度：低于该长度无法承载"谁想要什么、什么阻止他"的最小创意单元。 */
export const MIN_IDEA_LENGTH = 10;

export interface ShortScriptRecord {
  /** 关联作品（衍生短剧）；undefined = 独立短剧，不依赖任何小说项目。 */
  projectId?: string;
  scriptId: string;
  sourceFingerprint: string;
  /** true = 同一创意输入已生成过，本次复用既有产物 */
  reused?: boolean;
  /** 本次产物的创意来源（历史列表语义展示与幂等审计依据） */
  idea?: string;
  instruction?: string;
  targetDurationSeconds: number;
  /** 模型穷举的剧情节拍清单（审计与覆盖校验依据） */
  plotBeats: PlotBeat[];
  /** 影视镜头语言提示（提示级，不阻断）：缺少运镜/景别描述的镜头清单 */
  cinematicHints: string[];
  characters: ChapterScriptCharacterSheet[];
  segments: AssembledChapterScriptSegment[];
}

/**
 * 创意短剧本契约版本：与章节剧本契约独立演进。
 * v2 = 独立存储契约（short_scripts 表、projectId 可选、幂等作用域含 independent 占位）；
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
 */
export const SHORT_SCRIPT_CONTRACT_VERSION = "9";

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

/** 短剧本 schema：结构复用章节剧本 schema，分段数量上下限按目标时长预算收窄。 */
export function buildShortScriptSchema(targetDurationSeconds: number): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(CHAPTER_SCRIPT_H3_SCHEMA)) as {
    properties: { segments: { minItems: number; maxItems: number } };
    [key: string]: unknown;
  };
  schema.properties.segments.minItems = deriveShortScriptMinSegments(targetDurationSeconds);
  schema.properties.segments.maxItems = deriveShortScriptMaxSegments(targetDurationSeconds);
  return schema;
}

export function buildShortScriptPrompt(input: {
  projectTitle: string;
  idea: string;
  instruction?: string;
  targetDurationSeconds: number;
  minSegments: number;
  maxSegments: number;
}): string {
  return [
    `作品名称：${input.projectTitle}`,
    `核心创意：${input.idea.trim()}`,
    `任务：把上述核心创意扩展为一条自洽的简短短剧脚本（MiniMax H3 全参考模式），共 ${input.targetDurationSeconds} 秒左右。先给出出场人物的 appearanceEn 外观基线（各片段 subjectDefinitions 必须复用同一外形描述；描述性文字中英文均可，H3 对中文提示词兼容），再拆分片段。`,
    [
      "剧情覆盖契约（先于拆分执行，输出为顶层 plotBeats + 各片段 beatIds 引用）：",
      "- 第一步：从核心创意穷举剧情节拍，输出为 plotBeats 数组，每项 {id, kind, summary}。kind 取值：event=动作事件、dialogue=对话交换、memory=背景记忆与身份处境、setup=关键设定与伏笔、hook=期限任务与钩子、decision=信念转折与决策判断。summary 必须写出该节拍携带的具体信息点（谁、何处、什么事），不得只写情绪词。",
      "- 第二步：拆分片段，每个片段用 beatIds 声明它承载的节拍；所有节拍都必须被某个片段承载，不得整块省略。",
      [
        "信息呈现手段（硬性规则，剧情型创意适用；展示型创意的 setup 类节拍以画面本身呈现——奇观即信息，无需台词或闪回）：",
        "- memory / setup / hook 类节拍的承载片段，必须把具体信息呈现给观众，手段三选一：[Flashback] 闪回镜头（写出闪回画面里谁在何处做什么，2-4 个镜头）；台词 <d>（含画外音 voice-over，直接说出关键信息点）；屏幕可读文字。",
        "- 抱头、颤抖、喘息等反应动作只能表达「有信息涌入」这一事件，不能替代信息内容本身；只写反应动作会被判定为呈现缺失。",
      ].join("\n"),
      `- 时长预算：目标时长 ${input.targetDurationSeconds} 秒；片段数须落在 ${input.minSegments}-${input.maxSegments} 个之间（每段 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s），各片段 durationSeconds 之和须落在目标 ±${SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS}s 容差内。片段时长禁止贴下限：宏大场面、战斗交锋与冲击性瞬间取区间上沿（约 12-15 秒）让画面充分展开；对话交锋与反应镜头也至少 10 秒，用镜头细节与氛围填充而非快切。`,
      "描述体量：视频生成器只能依据文字复原画面，凡未写出的细节在成片中不存在。detailedDescription 每片段约 350-500 英文词或等体量中文，逐镜头写全 skill 指引的镜头六要素（景别角度/构图设计/运镜/光线氛围/色彩设计/状态变化）与主体外观；summary、retentionAnalysis、overallSoundscape 的写法见 skill 指引。禁止概要化、清单化或以一词带过。",
    ].join("\n"),
    // 创意意图忠实性（剧情型 / 展示型判定）与剧集剧作层（开场即冲突 / 情绪闭环 / 出口即
    // 钩子 / 台词密度 / 反转须有伏笔 / 人物经济）均由运行时 skill（h3-video-prompt，
    // priority=required）注入，此处不再重复。与章节链路同因：重复段此前挤占注意力预算，
    // 长指引被模型做词汇层合规（换大词、加 violent）而非真正执行；去重后新增的画面
    // 设计层才有预算落地。代码侧仅保留 skill 不掌握的运行时事实（时长预算、节拍映射、边界）。
    "边界：忠实于核心创意给定的设定、冲突与人物关系，可以合理补全细节，不得新增与创意冲突的设定、人物或结局走向；创意点名的核心意象（标志性移动/驾驭方式、点名景观、标志性场面）属于不得替换范畴——专有概念必须在描述中展开为其文化语境的标准物理呈现（姿态、接触点、构图与地理形态），不得用字面直译、近似动作或模板化场景顶替；无对白来源约束时台词自拟，但语义须与节拍承载的信息一致。",
    input.instruction?.trim() ? `作者指令（优先遵守其与格式规范相容的部分）：${input.instruction.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

const SHORT_SCRIPT_SYSTEM_BASE = "你是短剧分镜剧本提示词创作器。只依据给定的核心创意与指令输出符合 JSON Schema 的剧本：顶层 plotBeats 是穷举的剧情节拍清单，characters 是出场人物外观基线，segments 是按播放顺序排列的片段数组（用 beatIds 引用节拍）。";

/** 关联作品标题：仅 projectId 显式提供时校验（404 语义保留——填错仍报错）；独立模式返回占位。 */
async function loadProjectTitle(repository: NovelPostgresRepository, projectId: string | undefined): Promise<string> {
  if (!projectId) return "独立短剧（未关联小说作品）";
  const result = await repository.pool.query<{ title: string }>("SELECT title FROM novel_projects WHERE id=$1", [projectId]);
  const title = result.rows[0]?.title ?? "";
  if (!title) throw new ShortScriptInputError(404, `项目不存在：${projectId}`);
  return title;
}

/** 创意输入校验错误：携带建议 HTTP 状态码（与 ChapterScriptSourceError 同契约模式）。 */
export class ShortScriptInputError extends Error {
  constructor(readonly statusCode: 400 | 404, message: string) {
    super(message);
    this.name = "ShortScriptInputError";
  }
}

/** 从 short_scripts 表读产物（迁移 050 带入的 v1 行 payload 结构一致，零转换读取）。 */
function storedShortScriptToRecord(stored: StoredShortScript): ShortScriptRecord | undefined {
  const data = stored.payload ?? {};
  const segments = Array.isArray(data.segments) ? data.segments as AssembledChapterScriptSegment[] : [];
  if (!segments.length) return undefined;
  return {
    projectId: stored.projectId,
    scriptId: stored.id,
    sourceFingerprint: stored.sourceFingerprint,
    idea: stored.idea || (typeof data.idea === "string" ? data.idea : undefined),
    instruction: stored.instruction ?? (typeof data.instruction === "string" ? data.instruction : undefined),
    targetDurationSeconds: stored.targetDurationSeconds || DEFAULT_SHORT_SCRIPT_TARGET_SECONDS,
    plotBeats: Array.isArray(data.plotBeats) ? data.plotBeats as PlotBeat[] : [],
    cinematicHints: computeCinematicHints(segments),
    characters: Array.isArray(data.characters) ? data.characters as ChapterScriptCharacterSheet[] : [],
    segments,
  };
}

async function persistShortScript(repository: NovelPostgresRepository, objects: ObjectStoreAdapter, context: {
  projectId?: string;
  idea: string;
  instruction?: string;
  targetDurationSeconds: number;
  sourceFingerprint: string;
  plotBeats: PlotBeat[];
  characters: ChapterScriptCharacterSheet[];
  segments: AssembledChapterScriptSegment[];
  workflowId: string;
  /** 产出来源标记：系统内部生成=short-script-h3，外部 MCP 接手产出=external-short-script-h3。 */
  origin?: string;
}): Promise<string> {
  const scriptText = context.segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n");
  const object = await objects.putText(scriptText);
  const payload: Record<string, unknown> = {
    origin: context.origin ?? "short-script-h3",
    mode: "ref2va",
    kind: SHORT_SCRIPT_KIND,
    idea: context.idea,
    ...(context.instruction ? { instruction: context.instruction } : {}),
    targetDurationSeconds: context.targetDurationSeconds,
    sourceFingerprint: context.sourceFingerprint,
    contractVersion: SHORT_SCRIPT_CONTRACT_VERSION,
    plotBeats: context.plotBeats,
    characters: context.characters,
    segments: context.segments,
  };
  const script: StoredShortScript = {
    id: randomUUID(),
    projectId: context.projectId,
    idea: context.idea,
    instruction: context.instruction,
    targetDurationSeconds: context.targetDurationSeconds,
    sourceFingerprint: context.sourceFingerprint,
    contractVersion: SHORT_SCRIPT_CONTRACT_VERSION,
    objectKey: object.key,
    contentHash: createHash("sha256").update(scriptText).digest("hex"),
    workflowId: context.workflowId,
    payload,
    createdAt: Date.now(),
  };
  await repository.recordShortScript(script);
  return script.id;
}

export async function generateShortScriptH3(input: {
  /** 可选关联作品（衍生短剧）；缺省为独立短剧，不依赖任何小说项目。 */
  projectId?: string;
  idea: string;
  instruction?: string;
  targetDurationSeconds?: number;
}, deps: {
  repository: NovelPostgresRepository;
  objects: ObjectStoreAdapter;
  model: ModelGateway;
  skillProvider: SkillProvider;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
}): Promise<ShortScriptRecord> {
  const idea = input.idea?.trim() ?? "";
  if (idea.length < MIN_IDEA_LENGTH) {
    throw new ShortScriptInputError(400, `核心创意过短：至少 ${MIN_IDEA_LENGTH} 个字符，须写清谁、何处、什么冲突`);
  }
  const projectId = input.projectId?.trim() || undefined;
  const targetDurationSeconds = clampShortScriptTargetSeconds(input.targetDurationSeconds);
  const minSegments = deriveShortScriptMinSegments(targetDurationSeconds);
  const maxSegments = deriveShortScriptMaxSegments(targetDurationSeconds);

  const workflowId = `short-script:${randomUUID()}`;
  // skill 解析与 promptContext 对 projectId 无实质依赖（listSkills 不按项目过滤），
  // 独立模式传空串占位。
  const skillScopeId = projectId ?? "";
  const skillBundle = await resolveStageSkillBundle({
    projectId: skillScopeId,
    provider: deps.skillProvider,
    executionPoint: SHORT_SCRIPT_EXECUTION_POINT,
    preflightId: workflowId,
  });
  const skillSections = buildSkillContextSections(skillBundle, SHORT_SCRIPT_EXECUTION_POINT);

  // 幂等键绑定创意输入全量（作用域 + idea + instruction + target）+ 契约版本 + skill 版本：
  // 同输入重放复用既有产物；改创意、切换关联作用域、契约升级或 skill 升级后自然失效重生成。
  // skill 版本纳入幂等键的根因：指引（skill 内容）是产物内容的直接决定因素，纯文本修订
  // （如 v1.5.x 一镜到底契约）虽不改结构契约，但会改变模型生成行为；不纳入则改指引后
  // 同输入永远复用旧产物，无法验证新效果（实测盲点：v1.5.2→v1.5.3 后同创意被幂等挡住）。
  // 作用域占位 "independent" 隔离独立/关联两种产物（同一创意不跨作用域误复用）。
  const skillVersionPart = skillBundle.skills.map((skill) => `${skill.skillId}@${skill.version}`).sort().join("+");
  const sourceFingerprint = createHash("sha256").update(
    `${projectId ?? "independent"}:${idea}:${input.instruction?.trim() ?? ""}:${targetDurationSeconds}:${SHORT_SCRIPT_CONTRACT_VERSION}:${skillVersionPart}`,
  ).digest("hex");
  const existing = await deps.repository.findShortScriptByFingerprint(sourceFingerprint);
  if (existing) {
    const stored = storedShortScriptToRecord(existing);
    if (stored) return { ...stored, reused: true };
  }

  const projectTitle = await loadProjectTitle(deps.repository, projectId);
  const schema = buildShortScriptSchema(targetDurationSeconds);
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
          targetDurationSeconds,
          minSegments,
          maxSegments,
        }),
        priority: "critical",
        provenanceRefs: [`input:idea:${projectId ?? "independent"}`],
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
  // 零阻断契约：段数与总时长偏离只作为人工复核提示，不再抛错阻止落库展示。
  const hints = [...normalized.hints];
  if (normalized.segments.length > maxSegments) {
    hints.push(`- 片段数 ${normalized.segments.length} 超过目标时长预算上限 ${maxSegments}（每段至少 ${MIN_SEGMENT_SECONDS}s）；供人工复核`);
  }
  const totalIssue = observeShortScriptTotalDuration(normalized.segments, targetDurationSeconds);
  if (totalIssue) hints.push(`- ${totalIssue}`);
  const scriptId = await persistShortScript(deps.repository, deps.objects, {
    projectId,
    idea,
    instruction: input.instruction?.trim() || undefined,
    targetDurationSeconds,
    sourceFingerprint,
    plotBeats: normalized.plotBeats,
    characters: normalized.characters,
    segments: normalized.segments,
    workflowId,
  });
  return {
    projectId,
    scriptId,
    sourceFingerprint,
    idea,
    instruction: input.instruction?.trim() || undefined,
    targetDurationSeconds,
    plotBeats: normalized.plotBeats,
    cinematicHints: [...hints, ...computeCinematicHints(normalized.segments)],
    characters: normalized.characters,
    segments: normalized.segments,
  };
}

/**
 * 外部 MCP 接手短剧内容产出：接收外部已生成的「模型形态」剧本 JSON
 * （plotBeats / characters / segments 六段字段），系统负责零阻断组装 promptText、
 * 结构观察、契约版本与落库。与 generateShortScriptH3（系统内部模型生成）互为双轨。
 *
 * 设计依据：mcp-orchestrator.md 外部编排「治理与产出解耦」原则——短剧脚本是正文
 * 的只读派生物（不进正文质量门），故允许外部 MCP 直接产出内容；系统仍掌握
 * 组装、结构观察、契约版本与持久化（来源标记 origin=external-short-script-h3），
 * 不把产出权完全外溢。
 *
 * 幂等：以外部内容哈希（idea+instruction+target+契约版本+归一化内容）为指纹，
 * 同内容重放复用既有产物（前缀 ext: 与系统内部输入指纹区分，避免跨轨误复用）。
 *
 * 入参 payload 只要求 segments 非空（零阻断契约：缺字段进 hints 不阻断）；
 * 外部 MCP 应先经 novel_skill_get 读取 h3-video-prompt 方法论再产出。
 */
export async function submitExternalShortScriptH3(input: {
  /** 可选关联作品（衍生短剧）；缺省为独立短剧。 */
  projectId?: string;
  idea: string;
  instruction?: string;
  targetDurationSeconds?: number;
  /** 外部模型产出的剧本 JSON：{ plotBeats?, characters?, segments }。 */
  payload: { plotBeats?: unknown; characters?: unknown; segments?: unknown };
}, deps: {
  repository: NovelPostgresRepository;
  objects: ObjectStoreAdapter;
}): Promise<ShortScriptRecord> {
  const idea = input.idea?.trim() ?? "";
  if (idea.length < MIN_IDEA_LENGTH) {
    throw new ShortScriptInputError(400, `核心创意过短：至少 ${MIN_IDEA_LENGTH} 个字符，须写清谁、何处、什么冲突`);
  }
  const projectId = input.projectId?.trim() || undefined;
  const targetDurationSeconds = clampShortScriptTargetSeconds(input.targetDurationSeconds);
  const minSegments = deriveShortScriptMinSegments(targetDurationSeconds);

  const rawSegments = Array.isArray(input.payload.segments) ? input.payload.segments : [];
  if (!rawSegments.length) {
    throw new ShortScriptInputError(400, "payload.segments 必填且非空（外部 MCP 产出的模型形态片段数组）");
  }

  // 复用共享零阻断组装：把外部模型形态 JSON 归一化为可落库片段。
  const normalized = normalizeChapterScriptOutput(input.payload, { minSegments, shared: { lines: [], maxLabel: 0 } });
  const hints = [...normalized.hints];
  if (normalized.segments.length > deriveShortScriptMaxSegments(targetDurationSeconds)) {
    hints.push(`- 片段数 ${normalized.segments.length} 超过目标时长预算上限 ${deriveShortScriptMaxSegments(targetDurationSeconds)}（每段至少 ${MIN_SEGMENT_SECONDS}s）；供人工复核`);
  }
  const totalIssue = observeShortScriptTotalDuration(normalized.segments, targetDurationSeconds);
  if (totalIssue) hints.push(`- ${totalIssue}`);

  const workflowId = `short-script-external:${randomUUID()}`;
  // 内容指纹：外部产出以内容本身为幂等依据（与系统内部输入指纹区分）。
  const contentFingerprint = createHash("sha256").update(
    `${projectId ?? "independent"}:${idea}:${input.instruction?.trim() ?? ""}:${targetDurationSeconds}:${SHORT_SCRIPT_CONTRACT_VERSION}:`
      + JSON.stringify({
        pb: normalized.plotBeats,
        ch: normalized.characters,
        sg: normalized.segments.map((segment) => ({ ...segment })),
      }),
  ).digest("hex");
  const externalFingerprint = `ext:${contentFingerprint}`;
  const existing = await deps.repository.findShortScriptByFingerprint(externalFingerprint);
  if (existing) {
    const stored = storedShortScriptToRecord(existing);
    if (stored) return { ...stored, reused: true };
  }

  const scriptId = await persistShortScript(deps.repository, deps.objects, {
    projectId,
    idea,
    instruction: input.instruction?.trim() || undefined,
    targetDurationSeconds,
    sourceFingerprint: externalFingerprint,
    plotBeats: normalized.plotBeats,
    characters: normalized.characters,
    segments: normalized.segments,
    workflowId,
    origin: "external-short-script-h3",
  });
  return {
    projectId,
    scriptId,
    sourceFingerprint: externalFingerprint,
    idea,
    instruction: input.instruction?.trim() || undefined,
    targetDurationSeconds,
    plotBeats: normalized.plotBeats,
    cinematicHints: [...hints, ...computeCinematicHints(normalized.segments)],
    characters: normalized.characters,
    segments: normalized.segments,
  };
}
