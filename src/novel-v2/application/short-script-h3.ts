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
 * 1. 校验创意输入与目标时长预算（分段数上下限 + 总时长窗口）
 * 2. resolveStageSkillBundle(short.script) 注入 skill 指引 → generateStructured 调模型
 * 3. 复用 normalizeChapterScriptOutput 做结构特征校验（节拍覆盖、呈现手段、
 *    标签、时序、对白标记），失败进入 repair 循环；另加短剧本时长窗口校验
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
/** 总时长与目标时长的容差窗口：分段按 5-10s 粒度切分，窗口须大于单段跨度。 */
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
 * v1 产物由迁移 050 带入新表，读取层零转换（payload 结构一致）。
 */
export const SHORT_SCRIPT_CONTRACT_VERSION = "2";

/** 目标时长 clamp：超出上下限时收敛到边界而非拒绝（运营参数级输入）。 */
export function clampShortScriptTargetSeconds(target: number | undefined): number {
  if (typeof target !== "number" || !Number.isFinite(target)) return DEFAULT_SHORT_SCRIPT_TARGET_SECONDS;
  return Math.min(MAX_SHORT_SCRIPT_TARGET_SECONDS, Math.max(MIN_SHORT_SCRIPT_TARGET_SECONDS, Math.round(target)));
}

/** 分段数下限：目标时长全部按最长单段（10s）承载时仍需要的片段数。 */
export function deriveShortScriptMinSegments(targetDurationSeconds: number): number {
  return Math.max(1, Math.ceil(targetDurationSeconds / MAX_SEGMENT_SECONDS));
}

/** 分段数上限：目标时长全部按最短单段（5s）承载时的片段数，封顶常量上限。 */
export function deriveShortScriptMaxSegments(targetDurationSeconds: number): number {
  return Math.min(MAX_SHORT_SCRIPT_SEGMENTS, Math.max(1, Math.ceil(targetDurationSeconds / MIN_SEGMENT_SECONDS)));
}

/**
 * 短剧本时长窗口校验：总时长须落在 target ± 容差内。
 * 根因：分段按 5-10s 粒度切分，无窗口约束时模型可交付 5 段 × 5s = 25s 的
 * "60 秒短视频"，创意承诺的体量与产物体量脱节。窗口大于单段跨度，
 * 保证任意合法分段组合都存在可满足的落点。
 */
export function verifyShortScriptTotalDuration(segments: ReadonlyArray<{ durationSeconds: number }>, targetDurationSeconds: number): string | null {
  const total = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  if (Math.abs(total - targetDurationSeconds) > SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS) {
    return `总时长 ${total}s 偏离目标 ${targetDurationSeconds}s 超过 ±${SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS}s 容差；请按目标时长重新分配各片段 durationSeconds（每段 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s）`;
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
    `任务：把上述核心创意扩展为一条自洽的简短短剧脚本（MiniMax H3 全参考模式），共 ${input.targetDurationSeconds} 秒左右。先给出出场人物的 appearanceEn 英文外观基线（各片段 subjectDefinitions 必须复用同一外形描述），再拆分片段。`,
    [
      "剧情覆盖契约（先于拆分执行，输出为顶层 plotBeats + 各片段 beatIds 引用）：",
      "- 第一步：从核心创意穷举剧情节拍，输出为 plotBeats 数组，每项 {id, kind, summary}。kind 取值：event=动作事件、dialogue=对话交换、memory=背景记忆与身份处境、setup=关键设定与伏笔、hook=期限任务与钩子、decision=信念转折与决策判断。summary 必须写出该节拍携带的具体信息点（谁、何处、什么事），不得只写情绪词。",
      "- 第二步：拆分片段，每个片段用 beatIds 声明它承载的节拍；所有节拍都必须被某个片段承载，不得整块省略。",
      [
        "信息呈现手段（硬性规则）：",
        "- memory / setup / hook 类节拍的承载片段，必须把具体信息呈现给观众，手段三选一：[Flashback] 闪回镜头（写出闪回画面里谁在何处做什么，2-4 个镜头）；台词 <d>（含画外音 voice-over，直接说出关键信息点）；屏幕可读文字。",
        "- 抱头、颤抖、喘息等反应动作只能表达「有信息涌入」这一事件，不能替代信息内容本身；只写反应动作会被判定为呈现缺失。",
      ].join("\n"),
      `- 时长预算：目标时长 ${input.targetDurationSeconds} 秒；片段数须落在 ${input.minSegments}-${input.maxSegments} 个之间（每段 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s），各片段 durationSeconds 之和须落在目标 ±${SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS}s 容差内。`,
    ].join("\n"),
    [
      "剧集剧作契约（提示层，与剧情覆盖契约配合执行）：",
      "- 开场即冲突：第 1 个片段的第一个镜头落在冲突现场或其临界点，开场 3 秒内呈现钩子形态之一（直接冲突、强悬念、极致反差、身份落差、倒计时压力）；创意的核心冲突、对立双方、主角即时目标须在前 10 秒内可见或可闻。铺垫性开场（日常流程、纯环境交代先行）视为失败。",
      "- 情绪节点节奏：每 2-4 个片段落一个情绪节点（对话冲突、动作冲突或信息揭示），前 1/3 的片段内完成第一次小反转；连续 3 个片段无节点视为节奏断裂。",
      "- 出口即钩子：每个片段的出口状态抛出问题或抬高压（未揭的身份、被推翻的假设、逼近的危险、两难抉择、逼近的期限）；单条短剧也须在情绪闭环完成后的最强钩子瞬间收尾——观众应带着未解的钩子或余震离开，不在平淡余韵处结束。",
      "- 台词密度：每句台词至少承担身份/关系确认、冲突引爆、后果陈述之一，纯填充性寒暄压缩掉；台词口语化、短句、可念出口；关键情绪节拍静音可读（表情、动作或屏幕可读文字）。",
      "- 反转须有伏笔：每个反转必须对应前文片段已呈现过的伏笔（plant → overlook → detonate）；伏笔应经插入镜头、台词或可读细节在早期片段中可见。",
      "- 人物经济：出场人物围绕核心三角（主角、对手、助力者）加少量配角组织；人物标签靠稳定的视觉锚点（标志道具、服饰、特征）跨片段复用同一外形。",
    ].join("\n"),
    "边界：忠实于核心创意给定的设定、冲突与人物关系，可以合理补全细节，不得新增与创意冲突的设定、人物或结局走向；无对白来源约束时台词自拟，但语义须与节拍承载的信息一致。",
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
}): Promise<string> {
  const scriptText = context.segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n");
  const object = await objects.putText(scriptText);
  const payload: Record<string, unknown> = {
    origin: "short-script-h3",
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

  // 幂等键绑定创意输入全量（作用域 + idea + instruction + target）+ 契约版本：
  // 同输入重放复用既有产物；改创意、切换关联作用域或契约升级后自然失效重生成。
  // 作用域占位 "independent" 隔离独立/关联两种产物（同一创意不跨作用域误复用）。
  const sourceFingerprint = createHash("sha256").update(
    `${projectId ?? "independent"}:${idea}:${input.instruction?.trim() ?? ""}:${targetDurationSeconds}:${SHORT_SCRIPT_CONTRACT_VERSION}`,
  ).digest("hex");
  const existing = await deps.repository.findShortScriptByFingerprint(sourceFingerprint);
  if (existing) {
    const stored = storedShortScriptToRecord(existing);
    if (stored) return { ...stored, reused: true };
  }

  const projectTitle = await loadProjectTitle(deps.repository, projectId);
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
    extraValidate: (value: unknown) => shortScriptIssueSummary(value, { minSegments, targetDurationSeconds }),
  });

  const normalized = normalizeChapterScriptOutput(generated.value, { minSegments, shared: { lines: [], maxLabel: 0 } });
  if (normalized.segments.length > maxSegments) {
    throw new Error(`片段数 ${normalized.segments.length} 超过目标时长预算上限 ${maxSegments}（每段至少 ${MIN_SEGMENT_SECONDS}s）；请合并相邻片段`);
  }
  const totalIssue = verifyShortScriptTotalDuration(normalized.segments, targetDurationSeconds);
  if (totalIssue) throw new Error(`短剧剧本时长校验失败：\n- ${totalIssue}`);
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
    cinematicHints: computeCinematicHints(normalized.segments),
    characters: normalized.characters,
    segments: normalized.segments,
  };
}

/** repair 循环契约校验：把结构问题压缩成模型可读的错误列表。 */
function shortScriptIssueSummary(value: unknown, options: { minSegments: number; targetDurationSeconds: number }): string[] {
  try {
    const { segments } = normalizeChapterScriptOutput(value, { minSegments: options.minSegments, shared: { lines: [], maxLabel: 0 } });
    if (!segments.length) return ["segments 为空"];
    const totalIssue = verifyShortScriptTotalDuration(segments, options.targetDurationSeconds);
    return totalIssue ? [totalIssue] : [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
