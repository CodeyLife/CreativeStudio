import { createHash } from "node:crypto";

import { MAX_CHAPTER_HINTS, MAX_EXPECTED_CHAPTER_COUNT, MAX_STORY_ARC_BATCH_WINDOW } from "./story-arc-limits";

// 浏览器安全叶子模块 story-arc-limits 持有常量；这里 re-export 维持既有引用方兼容。
export { MAX_CHAPTER_HINTS, MAX_EXPECTED_CHAPTER_COUNT, MAX_STORY_ARC_BATCH_WINDOW } from "./story-arc-limits";

export type ArcPlanningStatus = "generating" | "awaiting-review" | "approved" | "stale" | "failed";
export type ArcExecutionStatus = "planned" | "active" | "completed" | "abandoned";

export interface StoryArcThreadResponsibility {
  threadRef: string;
  responsibility: string;
  nextAdvance: string;
  /**
   * 本条线在本弧承担的伏笔（**只能取弧级 foreshadowingRefs 中已出现的引用**，不新增账目）。
   * 伏笔账的 thread_id 归属以此为唯一证据来源：弧级 foreshadowingRefs 是扁平账，实测一条弧
   * 并行 4-7 条线，从"同弧共现"推断具体归属等于伪造关联（旧启发式因此恒不命中，
   * 见 docs/novel-v2/product-audit-20260910.md §五 2026-09-19 复测）。
   */
  foreshadowingRefs?: string[];
}

/**
 * 外部剧情编排（由外部大模型或用户提供，系统完善）。
 *
 * 设计依据：mcp-orchestrator.md 阶段 1 模式 B——外部模型/作者给方向
 * （objective 必填，其余为可选的弧级设计意图），系统负责把它完善为规范
 * 蓝图：对照冻结事实与叙事状态账本做事实梳理，补全场景因果、章节状态转换、
 * 连续性约束与章节蓝图，再走正式弧审核→修订闭环。编排是设计意图基线，
 * 权威低于已定稿事实与作者边界；编排与事实冲突时以事实为准。
 */
export interface StoryArcPlotOutline {
  /** 本弧创作目的 / 核心读者问题（必填） */
  objective: string;
  /** 弧标题建议 */
  title?: string;
  entryState?: string;
  centralConflict?: string;
  /** 发展阶梯：子问题链，每项承接前项并引出下一项 */
  development?: string[];
  resolution?: string;
  exitState?: string;
  threadResponsibilities?: StoryArcThreadResponsibility[];
  expectedChapterCount?: number;
  phases?: StoryArcPhase[];
  /** 逐章提示（最多与单个批次窗口一致的 16 条，仅作为章节设计意图） */
  chapterHints?: string[];
  /** 自由剧情编排说明：人物安排、伏笔、关系进展、信息释放节奏等 */
  plotNotes?: string;
}

/**
 * 解析外部剧情编排。结构错误（非对象、objective 缺失、责任/阶段条目畸形、
 * 章节数越界）直接抛错，不让调用方误以为编排已接受；字符串字段裁剪空白。
 */
export function parseStoryArcPlotOutline(value: unknown): StoryArcPlotOutline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("plotOutline 必须是对象");
  }
  const source = value as Record<string, unknown>;
  const objective = typeof source.objective === "string" ? source.objective.trim() : "";
  if (!objective) throw new Error("plotOutline.objective 必填且非空：外部编排必须说明本弧讲什么、要解决什么读者问题");

  const rawResponsibilities = source.threadResponsibilities;
  let threadResponsibilities: StoryArcThreadResponsibility[] | undefined;
  if (rawResponsibilities !== undefined) {
    if (!Array.isArray(rawResponsibilities)) throw new Error("plotOutline.threadResponsibilities 必须是数组");
    threadResponsibilities = rawResponsibilities.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`plotOutline.threadResponsibilities 第 ${index + 1} 项必须是对象`);
      const item = entry as Record<string, unknown>;
      const threadRef = typeof item.threadRef === "string" ? item.threadRef.trim() : "";
      const responsibility = typeof item.responsibility === "string" ? item.responsibility.trim() : "";
      const nextAdvance = typeof item.nextAdvance === "string" ? item.nextAdvance.trim() : "";
      if (!threadRef || !responsibility || !nextAdvance) {
        throw new Error(`plotOutline.threadResponsibilities 第 ${index + 1} 项必须同时包含非空的 threadRef/responsibility/nextAdvance`);
      }
      const rawThreadForeshadowing = item.foreshadowingRefs;
      if (rawThreadForeshadowing !== undefined && (!Array.isArray(rawThreadForeshadowing) || rawThreadForeshadowing.some((ref) => typeof ref !== "string" || !ref.trim()))) {
        throw new Error(`plotOutline.threadResponsibilities 第 ${index + 1} 项的 foreshadowingRefs 必须是非空字符串数组（本条线承担的伏笔引用）`);
      }
      const threadForeshadowingRefs = strings(rawThreadForeshadowing).map((ref) => ref.trim());
      return { threadRef, responsibility, nextAdvance, ...(threadForeshadowingRefs.length ? { foreshadowingRefs: threadForeshadowingRefs } : {}) };
    });
  }

  const rawPhases = source.phases;
  let phases: StoryArcPhase[] | undefined;
  if (rawPhases !== undefined) {
    if (!Array.isArray(rawPhases)) throw new Error("plotOutline.phases 必须是数组");
    phases = rawPhases.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`plotOutline.phases 第 ${index + 1} 项必须是对象`);
      const item = entry as Record<string, unknown>;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const phaseObjective = typeof item.objective === "string" ? item.objective.trim() : "";
      if (!title || !phaseObjective) throw new Error(`plotOutline.phases 第 ${index + 1} 项必须同时包含非空的 title/objective`);
      return { title, objective: phaseObjective, ...parsePhaseChapterOrdinals(item.chapterOrdinals) };
    });
  }

  const expectedChapterCount = source.expectedChapterCount;
  if (expectedChapterCount !== undefined && (!Number.isInteger(expectedChapterCount) || Number(expectedChapterCount) < 1 || Number(expectedChapterCount) > MAX_EXPECTED_CHAPTER_COUNT)) {
    throw new Error(`plotOutline.expectedChapterCount 必须是 1..${MAX_EXPECTED_CHAPTER_COUNT} 的整数`);
  }

  const rawChapterHints = source.chapterHints;
  if (rawChapterHints !== undefined && (!Array.isArray(rawChapterHints) || rawChapterHints.length > MAX_CHAPTER_HINTS || rawChapterHints.some((item) => typeof item !== "string"))) {
    throw new Error(`plotOutline.chapterHints 必须是字符串数组且不超过 ${MAX_CHAPTER_HINTS} 条`);
  }

  const title = typeof source.title === "string" ? source.title.trim() : undefined;
  const entryState = typeof source.entryState === "string" ? source.entryState.trim() : undefined;
  const centralConflict = typeof source.centralConflict === "string" ? source.centralConflict.trim() : undefined;
  const resolution = typeof source.resolution === "string" ? source.resolution.trim() : undefined;
  const exitState = typeof source.exitState === "string" ? source.exitState.trim() : undefined;
  const plotNotes = typeof source.plotNotes === "string" ? source.plotNotes.trim() : undefined;
  const development = strings(source.development);

  return {
    objective,
    ...(title ? { title } : {}),
    ...(entryState ? { entryState } : {}),
    ...(centralConflict ? { centralConflict } : {}),
    ...(development.length ? { development } : {}),
    ...(resolution ? { resolution } : {}),
    ...(exitState ? { exitState } : {}),
    ...(threadResponsibilities?.length ? { threadResponsibilities } : {}),
    ...(expectedChapterCount !== undefined ? { expectedChapterCount: Number(expectedChapterCount) } : {}),
    ...(phases?.length ? { phases } : {}),
    ...(rawChapterHints?.length ? { chapterHints: strings(rawChapterHints) } : {}),
    ...(plotNotes ? { plotNotes } : {}),
  };
}

/**
 * 校验外部剧情编排有实质信息增量：只有 objective 的空编排不产生任何
 * 设计意图（等价于普通模式），拒绝它让调用方明确失败边界。
 */
export function validateStoryArcPlotOutline(outline: StoryArcPlotOutline): void {
  const hasSubstance = Boolean(
    outline.entryState ||
    outline.centralConflict ||
    outline.development?.length ||
    outline.resolution ||
    outline.exitState ||
    outline.threadResponsibilities?.length ||
    outline.expectedChapterCount ||
    outline.phases?.length ||
    outline.chapterHints?.length ||
    outline.plotNotes,
  );
  if (!hasSubstance) {
    throw new Error("plotOutline 只有 objective 没有编排内容；请至少提供 entryState/centralConflict/development/resolution/exitState/threadResponsibilities/chapterHints/plotNotes 之一，否则请使用 novel_story_arc_start 普通模式");
  }
  if (outline.threadResponsibilities) {
    const refs = new Set(outline.threadResponsibilities.map((item) => item.threadRef));
    if (refs.size !== outline.threadResponsibilities.length) throw new Error("plotOutline.threadResponsibilities 的 threadRef 不能重复");
  }
}

export const CHAPTER_NARRATIVE_FUNCTIONS = ["setup", "development", "relationship", "discovery", "confrontation", "payoff", "aftermath", "transition", "reflection"] as const;
export type ChapterNarrativeFunction = (typeof CHAPTER_NARRATIVE_FUNCTIONS)[number];
export const CHAPTER_EXECUTION_CONTRACT_VERSION = "reader-grounded-v1";

/**
 * PL-6（product-audit-20260910）：阶段与章节的归属是**规划事实**，不是可推算量。
 * 旧的 `floor(localIndex/expected*phases.length)` 算术在"期望章数≠实际落籍章数"
 * 时静默失真（弧 2 按 15 除实际 8 章 → 第 5 章之后阶段全错）。现在只认
 * `chapterOrdinals`（弧内 1-based 落籍序号）的数据绑定；未绑定时不猜阶段。
 */
export interface StoryArcPhase {
  title: string;
  objective: string;
  /** 本阶段覆盖的弧内章节序号（1-based，相对弧内首章）。 */
  chapterOrdinals?: number[];
}

/**
 * 阶段归属解析：唯一的"章 → 阶段"真源。绑定缺失/越界一律返回 undefined，
 * 由调用方呈现"阶段未绑定"，禁止回落到等分猜测（宁缺毋伪）。
 */
/**
 * 阶段绑定解析：只接受正整数数组（去重升序）；非数组/含非法项 → 视为未绑定
 * （返回 {}），宁缺毋伪——错误绑定比没有绑定更糟。
 */
function parsePhaseChapterOrdinals(value: unknown): { chapterOrdinals?: number[] } {
  if (!Array.isArray(value) || !value.length) return {};
  const ordinals = new Set<number>();
  for (const item of value) {
    if (!Number.isInteger(item) || Number(item) < 1) return {};
    ordinals.add(Number(item));
  }
  return { chapterOrdinals: [...ordinals].sort((left, right) => left - right) };
}

export function resolveArcPhase(phases: readonly StoryArcPhase[] | undefined, arcLocalOrdinal: number): StoryArcPhase | undefined {
  if (!phases?.length) return undefined;
  if (!Number.isInteger(arcLocalOrdinal) || arcLocalOrdinal < 1) return undefined;
  return phases.find((phase) => phase.chapterOrdinals?.includes(arcLocalOrdinal));
}

export interface StoryArcPlan {
  title: string;
  objective: string;
  entryState: string;
  centralConflict: string;
  development: string[];
  resolution: string;
  exitState: string;
  threadResponsibilities: StoryArcThreadResponsibility[];
  foreshadowingRefs: string[];
  expectedChapterCount: number;
  phases: StoryArcPhase[];
}
export type NarrativeArcPlan = StoryArcPlan;

export interface StoryArcBatchPlan {
  batchIndex: number;
  startChapterIndex: number;
  complete: boolean;
}

export interface StoryArcBatchRecord extends StoryArcBatchPlan {
  id: string;
  arcId: string;
  projectId: string;
  endChapterIndex: number;
  status: "generating" | "awaiting-review" | "approved" | "failed";
  entryFingerprint: string;
  sourceArtifactId?: string;
  approvedAt?: string;
}

export interface ChapterSceneBlueprint {
  title: string;
  participants: string[];
  situation: string;
  observableActions: string[];
  /** Planner-only reasoning; excluded from the writer-facing execution contract. */
  planningRationale?: string;
  opposition?: string;
  decision?: string;
  outcome: string;
  cost?: string;
}

export interface ChapterSceneExecution {
  situation: string;
  observableActions: string[];
  outcome: string;
  opposition?: string;
  decision?: string;
  cost?: string;
}

export interface ChapterExecutionProjection {
  narrativeFunction?: ChapterNarrativeFunction;
  povCharacterId?: string;
  stateTransition: { before: string; after: string; evidence: string };
  unresolvedAtClose: string[];
  continuityConstraints: string[];
  scenes: Array<ChapterSceneExecution & { title: string; participants: string[] }>;
}

export function projectChapterForExecution(chapter: Pick<ChapterBlueprint, "narrativeFunction" | "povCharacterId" | "stateTransition" | "unresolvedAtClose" | "continuityConstraints" | "scenes">): ChapterExecutionProjection {
  return {
    narrativeFunction: chapter.narrativeFunction,
    povCharacterId: chapter.povCharacterId,
    stateTransition: chapter.stateTransition,
    unresolvedAtClose: [...(chapter.unresolvedAtClose ?? [])],
    continuityConstraints: [...chapter.continuityConstraints],
    scenes: chapter.scenes.map((scene) => ({
      title: scene.title,
      participants: [...scene.participants],
      situation: scene.situation,
      observableActions: [...scene.observableActions],
      ...(scene.opposition ? { opposition: scene.opposition } : {}),
      ...(scene.decision ? { decision: scene.decision } : {}),
      outcome: scene.outcome,
      ...(scene.cost ? { cost: scene.cost } : {}),
    })),
  };
}

export interface ChapterBlueprint {
  id?: string;
  index: number;
  title: string;
  stateTransition: { before: string; after: string; evidence: string };
  narrativeFunction?: ChapterNarrativeFunction;
  povCharacterId?: string;
  /** 建议性目标篇幅（正文产出时的创作指引，非硬性上限；缺省回退默认值）。 */
  targetWordCount?: number;
  scenes: ChapterSceneBlueprint[];
  continuityConstraints: string[];
  unresolvedAtClose?: string[];
}

export { storyArcAuthorityPaths } from "./story-arc-review-policy";

export interface StoryArcBundle {
  arc: NarrativeArcPlan;
  batch: StoryArcBatchPlan;
  chapters: ChapterBlueprint[];
}

export interface StoryArcRebaseTargetChapter {
  chapterId: string;
  documentId: string;
  globalOrder: number;
  title: string;
  revisionId?: string;
  /**
   * A chapter with no revision is a forward plan, not committed history. Keep
   * the last approved blueprint as its execution contract during a rebase.
   */
  plannedBlueprint?: ChapterBlueprint;
  /**
   * A committed chapter keeps its last approved blueprint as the planning
   * baseline; rebase may enrich its execution scale but may not rewrite it.
   */
  committedBlueprint?: ChapterBlueprint;
  chapterMemory?: {
    summary: string;
    keyEvents: string[];
    characterStates: Array<{ characterId: string; stateSnapshot: string }>;
    unresolvedThreads: string[];
    emotionalArc?: string;
  };
  authoritativeFacts: Array<{
    title: string;
    content: string;
    predicate?: string;
    subjectRefs: string[];
  }>;
}

export interface StoryArcRebaseTarget {
  arcId: string;
  executionStatus: ArcExecutionStatus;
  approvedArc: NarrativeArcPlan;
  batchIndex: number;
  startChapterIndex: number;
  chapters: StoryArcRebaseTargetChapter[];
}

export function validateStoryArcRebaseBundle(bundle: StoryArcBundle, target: StoryArcRebaseTarget): void {
  if (bundle.batch.batchIndex !== target.batchIndex || bundle.batch.startChapterIndex !== target.startChapterIndex) {
    throw new Error(`重基线结果必须保持原批次位置：batchIndex=${target.batchIndex}, startChapterIndex=${target.startChapterIndex}`);
  }
  if (bundle.chapters.length !== target.chapters.length) {
    throw new Error(`重基线结果必须逐章对应 ${target.chapters.length} 个已定稿文档，实际为 ${bundle.chapters.length} 章`);
  }
  if (target.executionStatus === "completed" && bundle.arc.expectedChapterCount !== target.chapters.length) {
    throw new Error(`已完成故事弧的 expectedChapterCount 必须保持为已定稿章节数 ${target.chapters.length}`);
  }
  if (target.executionStatus === "completed" && bundle.batch.complete !== true) {
    throw new Error("已完成故事弧的重基线批次必须标记 complete=true");
  }
  bundle.chapters.forEach((chapter, index) => {
    const targetChapter = target.chapters[index];
    const expectedUnresolved = targetChapter?.chapterMemory?.unresolvedThreads ?? targetChapter?.plannedBlueprint?.unresolvedAtClose;
    if (expectedUnresolved && JSON.stringify(chapter.unresolvedAtClose ?? []) !== JSON.stringify(expectedUnresolved)) {
      throw new Error(`第 ${chapter.index} 章的 unresolvedAtClose 必须保持冻结章节规划或已提交章节记忆中的未解边界`);
    }
    if (!targetChapter?.revisionId && !targetChapter?.chapterMemory && !targetChapter?.plannedBlueprint) {
      throw new Error(`第 ${chapter.index} 章缺少已批准的未来蓝图，不能在重基线中凭空生成未创作章节`);
    }
  });
}

export function normalizeStoryArcRebaseBundle(bundle: StoryArcBundle, target: StoryArcRebaseTarget): StoryArcBundle {
  return {
    ...bundle,
    chapters: bundle.chapters.map((chapter, index) => {
      const targetChapter = target.chapters[index];
      const isHistoricalTarget = Boolean(targetChapter?.revisionId || targetChapter?.chapterMemory);
      // committed 章节（已有定稿正文或记忆账本）：正文已冻结，蓝图严格对齐已提交版本，只修正 index。
      const committedBlueprint = isHistoricalTarget ? targetChapter.committedBlueprint : undefined;
      // planned 章节（只有已批准的未来蓝图、尚无正文）：蓝图读者可见字段允许随模型新生成内容
      // 更新（标题/场景/证据以新内容为准，供叙事语言等审核修订传导），但未解边界必须保留自已批准
      // 蓝图，防止修订悄悄改变跨章承诺；validateStoryArcRebaseBundle 仍要求该章节有 plannedBlueprint。
      const plannedBlueprint = !isHistoricalTarget ? targetChapter?.plannedBlueprint : undefined;
      const candidate = committedBlueprint
        ? { ...committedBlueprint, index: chapter.index }
        : chapter;
      return {
        ...candidate,
        unresolvedAtClose: targetChapter?.chapterMemory
          ? [...targetChapter.chapterMemory.unresolvedThreads]
          : [...(plannedBlueprint?.unresolvedAtClose ?? candidate.unresolvedAtClose ?? [])],
      };
    }),
  };
}

export function validateStoryArcExecutionContracts(bundle: StoryArcBundle): void {
  validateStoryArcPlanContracts(bundle.arc);
  for (const chapter of bundle.chapters) {
    validateChapterExecutionContract(chapter);
  }
}

export function validateStoryArcPlanContracts(arc: NarrativeArcPlan): void {
  const responsibilities = arc.threadResponsibilities;
  for (const responsibility of responsibilities) {
    if (!responsibility.threadRef.trim()) throw new Error("故事弧的剧情线阶段责任必须包含 threadRef");
    if (!responsibility.responsibility.trim()) throw new Error("故事弧的剧情线阶段责任必须包含 responsibility");
    if (!responsibility.nextAdvance.trim()) throw new Error("故事弧的剧情线阶段责任必须包含 nextAdvance");
  }
  const refs = new Set(responsibilities.map((item) => item.threadRef));
  if (refs.size !== responsibilities.length) throw new Error("故事弧的剧情线阶段责任不能重复");
  // PL-6 校验面（与生成面 prompt 契约对齐——c9a7b07 的教训：只有生成面没有校验面
  // =错误绑定静默生效，"错误绑定比没有绑定更糟"）：绑定语义是"要么不绑（旧弧，
  // 留给 health warning），要么全量互斥覆盖 1..expectedChapterCount"。
  const bound = new Map<number, string>();
  for (const phase of arc.phases) {
    for (const ordinal of phase.chapterOrdinals ?? []) {
      if (ordinal > arc.expectedChapterCount) throw new Error(`阶段“${phase.title}”的 chapterOrdinals 越界：${ordinal} > expectedChapterCount ${arc.expectedChapterCount}`);
      const owner = bound.get(ordinal);
      if (owner) throw new Error(`chapterOrdinals 阶段间重叠：第 ${ordinal} 章同时属于“${owner}”与“${phase.title}”`);
      bound.set(ordinal, phase.title);
    }
  }
  if (bound.size && bound.size !== arc.expectedChapterCount) {
    const missing = Array.from({ length: arc.expectedChapterCount }, (_, i) => i + 1).filter((ordinal) => !bound.has(ordinal));
    throw new Error(`chapterOrdinals 必须全量覆盖 1..${arc.expectedChapterCount}（部分绑定=阶段归属半真源，比不绑更危险），缺失：${missing.join("、")}`);
  }
}

/**
 * 批次窗口分配（纯函数，生成面/校验面/推进门槛三面共用）。窗口 = 弧内剩余
 * 未规划章数，按 MAX_STORY_ARC_BATCH_WINDOW 截断；expected 缺失（旧弧 0）
 * 返回 0=无声明窗口，调用方据此跳过契约与守卫。
 */
export function storyArcBatchWindow(input: { expectedChapterCount: number | undefined; plannedBeforeInArc: number }): number {
  const expected = input.expectedChapterCount ?? 0;
  if (!expected) return 0;
  return Math.min(Math.max(expected - input.plannedBeforeInArc, 0), MAX_STORY_ARC_BATCH_WINDOW);
}

/**
 * 批次窗口校验（根因：正常批次模式下窗口章数此前完全由模型裁量——arc5 实证
 * 模型把"保留后续发展的空间"读作"本批只出 1 章"，7 章弧静默坍缩为单章批次，
 * 无任何机制拦截；弧 1-4 全弧一批是既有惯例）。批次窗口是系统分配的事实，
 * 生成侧只填充不裁量——与重基线的逐章覆盖契约同一原则。
 */
export function assertStoryArcBatchWindow(input: { expectedChapterCount: number | undefined; plannedBeforeInArc: number; chaptersCount: number }): void {
  const windowChapters = storyArcBatchWindow(input);
  if (!windowChapters) return;
  if (input.chaptersCount !== windowChapters) {
    const expected = input.expectedChapterCount ?? 0;
    throw new Error(`本批次章节窗口由系统定为 ${windowChapters} 章（弧内期望 ${expected} - 已规划 ${input.plannedBeforeInArc}，窗口上限 ${MAX_STORY_ARC_BATCH_WINDOW}），生成结果 ${input.chaptersCount} 章——窗口章数不得由生成侧缩减或扩张`);
  }
}

export function validateChapterExecutionContract(chapter: ChapterBlueprint): void {
  if (!chapter.stateTransition || [chapter.stateTransition.before, chapter.stateTransition.after, chapter.stateTransition.evidence].some((value) => !value.trim())) {
    throw new Error(`第 ${chapter.index} 章的 stateTransition 不完整`);
  }
    if (!chapter.scenes.length) throw new Error(`第 ${chapter.index} 章至少需要一个可执行场景`);
    chapter.scenes.forEach((scene, sceneIndex) => {
      if (!scene.situation.trim() || !scene.observableActions.length || !scene.outcome.trim()) {
        throw new Error(`第 ${chapter.index} 章场景 ${sceneIndex + 1} 缺少处境、可观察行动或结果`);
      }
    });
}

export interface StoryArcRecord {
  id: string;
  projectId: string;
  volumeId: string;
  ordinal: number;
  planningStatus: ArcPlanningStatus;
  executionStatus: ArcExecutionStatus;
  arc: NarrativeArcPlan;
  chapters: ChapterBlueprintRecord[];
  batches: StoryArcBatchRecord[];
  sourceArtifactId?: string;
  blueprintArtifactId?: string;
  contextFingerprint?: string;
  reviewArtifactId?: string;
  reviewFingerprint?: string;
  editRevision: number;
  approvedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
  updatedAt: string;
}

export interface ChapterBlueprintRecord extends ChapterBlueprint {
  id: string;
  arcId: string;
  projectId: string;
  documentId?: string;
  globalOrder: number;
  status: string;
  sourceArtifactId?: string;
  blueprintRevision: number;
}

export interface ChapterPlanningContext {
  projectId: string;
  arcId: string;
  chapterBlueprintId: string;
  arc: NarrativeArcPlan;
  chapter: ChapterBlueprintRecord;
  neighbors: Array<Pick<ChapterBlueprintRecord, "id" | "globalOrder" | "title" | "narrativeFunction" | "stateTransition" | "unresolvedAtClose">>;
  sourceArtifactIds: string[];
  fingerprint: string;
}

export interface StoryArcContextReceipt {
  narrativeCutoff?: number;
  sourceArtifactIds: string[];
  sourceRevisionIds: string[];
  sectionFingerprints: Record<string, string>;
  fingerprint: string;
  legacy: boolean;
}

/**
 * 群像结构信号（2026-09-16 全量审校确诊的机制端落点）。
 *
 * 根因证据：126 章蓝图 44% 全部场景参与者 ≤1（弧 12-13、15、18 达 5/7），产出正文
 * 对白占比从 6.7% 崩至 0.3%——蓝图层"单人节目单"是正文对手戏崩落的直接上游。
 * 本函数只做**蓝图结构统计**（参与者数量这一可数事实），不做台词判定、不做题材
 * 偏好硬门：独处章合法，但批次的群像配额缺口必须作为确定性信号出现在规划、
 * 审核两面的上下文里（与 serialFunctionRuns 同型：描述性统计前移，判断留给评审）。
 *
 * 配额契约（SKILL⑦ 对齐）：每批次窗口≥1/3 章至少有一个两名及以上参与者互动的
 * 场景；纯独处章每批至多一章。合法静章需在场景 planningRationale 声明功能理由。
 *
 * ── 2026-09-17：第二意志**不做机器判据**（负结果）──
 *
 * 曾试图加一个 "参与者≥2 但无人类阻力" 的判据，两版实现都被实测推翻：
 *   · 版 1（人名 token + 非"格法/旧例/自己的"词表）：实测 tmp/human-opp-calib.txt
 *     缺口 49/108，且**假阴假阳并存**——漏掉 142/144/146/147/150/154/155 全部
 *     （这些章的 opposition 是主角自己的犹疑，不是第二意志），同时把 132/136
 *     这类真第二意志文本判为缺口，只因句中出现子串「规矩」「自己的」。子串黑名单
 *     装在结构式外壳里，违反 AGENTS.md 泛化红线。
 *   · 版 2（在场者名 + 意志动词窗口）：tmp/human-opp-2.mts 实测——对我亲读的 18 章
 *     判对 15，但 3 个错例全部落在"好章"一侧（124/130/158 被误报为缺口），
 *     且这些章的意志写法（「比他更怕出错」「只肯送到」「压手也可能在核他」）
 *     本就不在任何封闭动词集内。**"这一段里有没有另一个人想要什么"是语义判断，
 *     不是可用的机器判据。**
 *
 * 纪律落点：本函数**只统计参与者数量**（可数事实）。第二意志改为在**生成面**给契约
 * （prompts/story-arc.ts 的「第二意志契约」段 + 弧审核 prompt 的核对项），让规划者
 * 一次就把 opposition 写成"谁想要什么、他的行动如何改变对方可选集合"，而不是事后
 * 靠正则猜。这与 AGENTS.md"在拥有错误行为的最低共享层修复"一致：错误行为在生成端。
 */
export interface StoryArcEnsembleReport {
  /** 参与者≥2 的场景所在的章（批次内 index）。 */
  ensembleChapterIndexes: number[];
  /** 全部场景参与者≤1 的章（批次内 index）。 */
  soloOnlyChapterIndexes: number[];
  /** 批次配额下限：ceil(章数/3)；<3 章的批次不设配额。 */
  ensembleQuota: number;
  quotaMet: boolean;
  /** 连续纯独处章的最长游程（批次内）。 */
  longestSoloRun: number;
}

export function inspectStoryArcEnsemble(chapters: Array<{ index: number; scenes?: Array<{ participants?: readonly string[] }> }>): StoryArcEnsembleReport {
  const ensembleChapterIndexes: number[] = [];
  const soloOnlyChapterIndexes: number[] = [];
  for (const chapter of chapters) {
    const scenes = Array.isArray(chapter.scenes) ? chapter.scenes : [];
    const hasEnsembleScene = scenes.some((scene) => new Set((scene?.participants ?? []).map((name) => String(name).trim()).filter(Boolean)).size >= 2);
    if (hasEnsembleScene) ensembleChapterIndexes.push(chapter.index);
    else if (scenes.length > 0) soloOnlyChapterIndexes.push(chapter.index);
  }
  const ensembleQuota = chapters.length >= 3 ? Math.ceil(chapters.length / 3) : 0;
  let longestSoloRun = 0;
  let run = 0;
  for (const chapter of chapters) {
    if (soloOnlyChapterIndexes.includes(chapter.index)) {
      run += 1;
      longestSoloRun = Math.max(longestSoloRun, run);
    } else run = 0;
  }
  return {
    ensembleChapterIndexes,
    soloOnlyChapterIndexes,
    ensembleQuota,
    quotaMet: chapters.length === 0 || ensembleChapterIndexes.length >= ensembleQuota,
    longestSoloRun,
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseThreadResponsibilities(value: unknown): StoryArcThreadResponsibility[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const threadRef = typeof item.threadRef === "string" ? item.threadRef.trim() : "";
    const responsibility = typeof item.responsibility === "string" ? item.responsibility.trim() : "";
    const nextAdvance = typeof item.nextAdvance === "string" ? item.nextAdvance.trim() : "";
    const foreshadowingRefs = strings(item.foreshadowingRefs).map((ref) => ref.trim()).filter(Boolean);
    return threadRef && responsibility && nextAdvance
      ? [{ threadRef, responsibility, nextAdvance, ...(foreshadowingRefs.length ? { foreshadowingRefs } : {}) }]
      : [];
  });
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

export function parseStoryArcPlan(value: unknown): NarrativeArcPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("故事弧计划必须是对象");
  const source = value as Record<string, unknown>;
  const title = typeof source.title === "string" ? source.title.trim() : "";
  const objective = typeof source.objective === "string" ? source.objective.trim() : "";
  if (!title || !objective) throw new Error("故事弧标题和创作目的不能为空");
  return {
    title,
    objective,
    entryState: typeof source.entryState === "string" ? source.entryState : "",
    centralConflict: typeof source.centralConflict === "string" ? source.centralConflict : "",
    development: strings(source.development),
    resolution: typeof source.resolution === "string" ? source.resolution : "",
    exitState: typeof source.exitState === "string" ? source.exitState : "",
    threadResponsibilities: parseThreadResponsibilities(source.threadResponsibilities),
    foreshadowingRefs: strings(source.foreshadowingRefs),
    expectedChapterCount: Number.isInteger(source.expectedChapterCount) ? Number(source.expectedChapterCount) : 0,
    phases: Array.isArray(source.phases) ? source.phases.flatMap((phase) => {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) return [];
      const item = phase as Record<string, unknown>;
      const phaseTitle = typeof item.title === "string" ? item.title.trim() : "";
      const phaseObjective = typeof item.objective === "string" ? item.objective.trim() : "";
      return phaseTitle && phaseObjective ? [{ title: phaseTitle, objective: phaseObjective, ...parsePhaseChapterOrdinals(item.chapterOrdinals) }] : [];
    }) : [],
  };
}

export function parseChapterSceneExecution(value: unknown): ChapterSceneExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const situation = typeof item.situation === "string" ? item.situation.trim() : "";
  const observableActions = strings(item.observableActions).map((action) => action.trim()).filter(Boolean);
  const outcome = typeof item.outcome === "string" ? item.outcome.trim() : "";
  const opposition = typeof item.opposition === "string" ? item.opposition.trim() : undefined;
  const decision = typeof item.decision === "string" ? item.decision.trim() : undefined;
  const cost = typeof item.cost === "string" ? item.cost.trim() : undefined;
  if (!situation || !observableActions.length || !outcome) return undefined;
  return { situation, observableActions, ...(opposition ? { opposition } : {}), ...(decision ? { decision } : {}), outcome, ...(cost ? { cost } : {}) };
}

export function parseStoryArcBundle(value: unknown): StoryArcBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("故事弧蓝图必须是对象");
  const root = value as Record<string, unknown>;
  const rawArc = root.arc;
  if (!rawArc || typeof rawArc !== "object" || Array.isArray(rawArc)) throw new Error("故事弧缺少 arc");
  const parsedArc = parseStoryArcPlan(rawArc);
  const rawChapters = Array.isArray(root.chapters) ? root.chapters : [];
  if (!rawChapters.length) throw new Error("故事弧至少需要一个章节蓝图");
  const chapters = rawChapters.map((raw, offset): ChapterBlueprint => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`第 ${offset + 1} 个章节蓝图格式错误`);
    const chapter = raw as Record<string, unknown>;
    const chapterTitle = typeof chapter.title === "string" ? chapter.title.trim() : "";
    if (!chapterTitle) throw new Error(`第 ${offset + 1} 个章节蓝图缺少标题`);
    const rawScenes = Array.isArray(chapter.scenes) ? chapter.scenes : [];
    const rawStateTransition = chapter.stateTransition && typeof chapter.stateTransition === "object" && !Array.isArray(chapter.stateTransition)
      ? chapter.stateTransition as Record<string, unknown>
      : undefined;
    const stateTransition = rawStateTransition && typeof rawStateTransition.before === "string" && typeof rawStateTransition.after === "string" && typeof rawStateTransition.evidence === "string"
      ? { before: rawStateTransition.before, after: rawStateTransition.after, evidence: rawStateTransition.evidence }
      : undefined;
    return {
      id: typeof chapter.id === "string" ? chapter.id : undefined,
      index: offset + 1,
      title: chapterTitle,
      stateTransition: stateTransition ?? { before: "", after: "", evidence: "" },
      narrativeFunction: enumValue(chapter.narrativeFunction, CHAPTER_NARRATIVE_FUNCTIONS),
      povCharacterId: typeof chapter.povCharacterId === "string" && chapter.povCharacterId.trim() ? chapter.povCharacterId : undefined,
      targetWordCount: typeof chapter.targetWordCount === "number" && Number.isFinite(chapter.targetWordCount) && chapter.targetWordCount > 0 ? Math.round(chapter.targetWordCount) : undefined,
      scenes: rawScenes.map((scene, sceneIndex) => {
        const item = scene && typeof scene === "object" && !Array.isArray(scene) ? scene as Record<string, unknown> : {};
        return {
          title: typeof item.title === "string" ? item.title : `场景 ${sceneIndex + 1}`,
          participants: strings(item.participants),
          situation: typeof item.situation === "string" ? item.situation : "",
          observableActions: strings(item.observableActions),
          planningRationale: typeof item.planningRationale === "string" && item.planningRationale.trim() ? item.planningRationale.trim() : undefined,
          opposition: typeof item.opposition === "string" && item.opposition.trim() ? item.opposition : undefined,
          decision: typeof item.decision === "string" && item.decision.trim() ? item.decision : undefined,
          outcome: typeof item.outcome === "string" ? item.outcome : "",
          cost: typeof item.cost === "string" && item.cost.trim() ? item.cost : undefined,
        };
      }),
      continuityConstraints: strings(chapter.continuityConstraints),
      unresolvedAtClose: strings(chapter.unresolvedAtClose),
    };
  });
  const rawBatch = root.batch && typeof root.batch === "object" && !Array.isArray(root.batch) ? root.batch as Record<string, unknown> : {};
  const batchIndex = Number.isInteger(rawBatch.batchIndex) && Number(rawBatch.batchIndex) > 0 ? Number(rawBatch.batchIndex) : 1;
  const startChapterIndex = Number.isInteger(rawBatch.startChapterIndex) && Number(rawBatch.startChapterIndex) > 0 ? Number(rawBatch.startChapterIndex) : 1;
  return {
    arc: { ...parsedArc, expectedChapterCount: Math.max(chapters.length, parsedArc.expectedChapterCount || chapters.length) },
    batch: { batchIndex, startChapterIndex, complete: rawBatch.complete === true },
    chapters,
  };
}

/**
 * Normalize persisted chapter-planning snapshots at the read boundary.
 *
 * Planning contexts are intentionally immutable snapshots, so older rows can
 * legitimately lack fields added by later contracts. Prompt consumers still
 * need the current executable shape; this adapter supplies the same defaults
 * used when a story-arc bundle is parsed without rewriting historical data.
 */
export function normalizeChapterPlanningContext(value: unknown): ChapterPlanningContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const arcSource = source.arc && typeof source.arc === "object" && !Array.isArray(source.arc) ? source.arc as Record<string, unknown> : {};
  const arc: NarrativeArcPlan = {
    title: typeof arcSource.title === "string" ? arcSource.title : "历史故事弧",
    objective: typeof arcSource.objective === "string" ? arcSource.objective : "依据历史章节上下文继续创作",
    entryState: typeof arcSource.entryState === "string" ? arcSource.entryState : "",
    centralConflict: typeof arcSource.centralConflict === "string" ? arcSource.centralConflict : "",
    development: strings(arcSource.development),
    resolution: typeof arcSource.resolution === "string" ? arcSource.resolution : "",
    exitState: typeof arcSource.exitState === "string" ? arcSource.exitState : "",
    threadResponsibilities: parseThreadResponsibilities(arcSource.threadResponsibilities),
    foreshadowingRefs: strings(arcSource.foreshadowingRefs),
    expectedChapterCount: Number.isInteger(arcSource.expectedChapterCount) ? Number(arcSource.expectedChapterCount) : 0,
    phases: Array.isArray(arcSource.phases) ? arcSource.phases.flatMap((phase) => {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) return [];
      const item = phase as Record<string, unknown>;
      const title = typeof item.title === "string" ? item.title : "";
      const objective = typeof item.objective === "string" ? item.objective : "";
      return title && objective ? [{ title, objective, ...parsePhaseChapterOrdinals(item.chapterOrdinals) }] : [];
    }) : [],
  };
  const projectId = typeof source.projectId === "string" ? source.projectId : "";
  const arcId = typeof source.arcId === "string" ? source.arcId : "";
  const contextChapter = source.chapter && typeof source.chapter === "object" && !Array.isArray(source.chapter) ? source.chapter as Record<string, unknown> : undefined;
  if (!contextChapter) return undefined;
  const chapterBundle = (() => {
    try {
      return parseStoryArcBundle({ arc: { title: arc.title, objective: arc.objective }, batch: { batchIndex: 1, startChapterIndex: 1, complete: false }, chapters: [contextChapter] }).chapters[0];
    } catch {
      return undefined;
    }
  })();
  if (!chapterBundle) return undefined;
  const chapter: ChapterBlueprintRecord = {
    ...chapterBundle,
    id: typeof contextChapter.id === "string" ? contextChapter.id : chapterBundle.id ?? `legacy-chapter-${typeof contextChapter.index === "number" ? contextChapter.index : 1}`,
    arcId: typeof contextChapter.arcId === "string" ? contextChapter.arcId : arcId,
    projectId: typeof contextChapter.projectId === "string" ? contextChapter.projectId : projectId,
    documentId: typeof contextChapter.documentId === "string" ? contextChapter.documentId : undefined,
    globalOrder: typeof contextChapter.globalOrder === "number" ? contextChapter.globalOrder : typeof contextChapter.index === "number" ? contextChapter.index : chapterBundle.index,
    status: typeof contextChapter.status === "string" ? contextChapter.status : "planned",
    blueprintRevision: typeof contextChapter.blueprintRevision === "number" ? contextChapter.blueprintRevision : 0,
    index: typeof contextChapter.index === "number" ? contextChapter.index : chapterBundle.index,
  };
  const neighbors = Array.isArray(source.neighbors) ? source.neighbors.flatMap((item, index) => {
    const normalized = normalizeChapterPlanningContext({ projectId, arcId, arc, chapter: item, neighbors: [], sourceArtifactIds: [] })?.chapter;
    if (!normalized) return [];
    return [{ id: normalized.id ?? `legacy-neighbor-${index}`, globalOrder: normalized.globalOrder, title: normalized.title, narrativeFunction: normalized.narrativeFunction, stateTransition: normalized.stateTransition, unresolvedAtClose: normalized.unresolvedAtClose }];
  }) : [];
  const withoutFingerprint = { projectId, arcId, chapterBlueprintId: typeof source.chapterBlueprintId === "string" ? source.chapterBlueprintId : chapter.id ?? "", arc, chapter, neighbors, sourceArtifactIds: strings(source.sourceArtifactIds) };
  // Historical snapshots may carry a fingerprint from an older execution
  // contract. Recompute it at the read boundary so the next workflow sees the
  // current projection version and persists a fresh context when it compiles.
  return { ...withoutFingerprint, fingerprint: planningContextFingerprint(withoutFingerprint) };
}

export function canGenerateNextStoryArcBatch(input: { plannedInBatch: number; finalizedInBatch: number; batchStatus: StoryArcBatchRecord["status"] }): boolean {
  if (input.batchStatus !== "approved" || input.plannedInBatch <= 0) return false;
  return input.finalizedInBatch / input.plannedInBatch >= 0.7;
}

export function planningContextFingerprint(value: Omit<ChapterPlanningContext, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify({ executionContractVersion: CHAPTER_EXECUTION_CONTRACT_VERSION, ...value })).digest("hex");
}
