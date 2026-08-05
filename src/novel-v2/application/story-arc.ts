import { createHash } from "node:crypto";

export type ArcPlanningStatus = "generating" | "awaiting-review" | "approved" | "stale" | "failed";
export type ArcExecutionStatus = "planned" | "active" | "completed" | "abandoned";

export interface StoryArcThreadResponsibility {
  threadRef: string;
  responsibility: string;
  nextAdvance: string;
}

export const CHAPTER_NARRATIVE_FUNCTIONS = ["setup", "development", "relationship", "discovery", "confrontation", "payoff", "aftermath", "transition", "reflection"] as const;
export type ChapterNarrativeFunction = (typeof CHAPTER_NARRATIVE_FUNCTIONS)[number];

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
  phases: Array<{ title: string; objective: string }>;
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
  scenes: ChapterSceneBlueprint[];
  continuityConstraints: string[];
  unresolvedAtClose?: string[];
}

export {
  ARC_PLAN_CHECK_DIMENSIONS,
  CHAPTER_PLAN_CHECK_DIMENSIONS,
  compileChapterPlanValidationReport,
} from "./story-arc-review-policy";
export type {
  ArcPlanCheckDimension,
  ArcPlanValidationCheck,
  ChapterPlanCheckDimension,
  ChapterPlanValidationCheck,
  ChapterPlanValidationReport,
} from "./story-arc-review-policy";

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
      const plannedBlueprint = !targetChapter?.revisionId && !targetChapter?.chapterMemory
        ? targetChapter.plannedBlueprint
        : undefined;
      const isHistoricalTarget = Boolean(targetChapter?.revisionId || targetChapter?.chapterMemory);
      const committedBlueprint = isHistoricalTarget ? targetChapter.committedBlueprint : undefined;
      const candidate = plannedBlueprint
        ? { ...plannedBlueprint, index: chapter.index }
        : committedBlueprint
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
    return threadRef && responsibility && nextAdvance ? [{ threadRef, responsibility, nextAdvance }] : [];
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
      return phaseTitle && phaseObjective ? [{ title: phaseTitle, objective: phaseObjective }] : [];
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
      scenes: rawScenes.map((scene, sceneIndex) => {
        const item = scene && typeof scene === "object" && !Array.isArray(scene) ? scene as Record<string, unknown> : {};
        return {
          title: typeof item.title === "string" ? item.title : `场景 ${sceneIndex + 1}`,
          participants: strings(item.participants),
          situation: typeof item.situation === "string" ? item.situation : "",
          observableActions: strings(item.observableActions),
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
      return title && objective ? [{ title, objective }] : [];
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
  return { ...withoutFingerprint, fingerprint: typeof source.fingerprint === "string" ? source.fingerprint : planningContextFingerprint(withoutFingerprint) };
}

export function canGenerateNextStoryArcBatch(input: { plannedInBatch: number; finalizedInBatch: number; batchStatus: StoryArcBatchRecord["status"] }): boolean {
  if (input.batchStatus !== "approved" || input.plannedInBatch <= 0) return false;
  return input.finalizedInBatch / input.plannedInBatch >= 0.7;
}

export function planningContextFingerprint(value: Omit<ChapterPlanningContext, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
