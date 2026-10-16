import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { foundationArtifactToMemoryClaim, foundationClaimId } from "./foundation-memory";
import { CLAIM_PROJECTION_SET_SQL, retrievalVisibleClaimsSql, retiredByVisibleKillerSql, sourceRevisionIdsOf } from "./memory-visibility";
import { ACTIVE_WORKFLOW_RUN_STATUSES_SQL, HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS, OPEN_WORKFLOW_RUN_STATUSES_SQL, SUCCEEDED_WORKFLOW_RUN_STATUSES_SQL, WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL, terminalOverwriteGuardSql, type WorkflowRunStatus } from "./run-lifecycle";
import { normalizeFoundationStructuredDataFlat, validateFoundationTaskContract } from "./application/foundation-contract";
import { foundationContractFingerprint } from "./application/foundation-contract-fingerprint";
import { serialContextFingerprint } from "./application/serial-context-fingerprint";
import { assertCompleteChapterReviewEvidence } from "./application/chapter-approval";
import { ChapterStateRebuildConflictError } from "./application/chapter-state-rebuild-conflict";
import {
  PROJECT_PLAN_STAGES,
  REQUIRED_APPROVED_PLAN_TASK_KEYS,
  foundationTaskKey,
  transitivePlanDependents,
  approvedProjectBookTitle,
  resolveProjectTitle,
  type ProjectPlanSection,
  type ProjectPlanStatus,
  type ProjectPlanTaskKey,
} from "./application/project-plan";
import type { FactExtractionOutput, FoundationOutput } from "./prompts/schemas";
import { normalizeStyleContractPayload, styleContractFingerprint, type StyleContract, type StyleContractPayload } from "./style-contract";
import type {
  Artifact,
  ApprovalEvidence,
  CandidateBundle,
  ChapterMemory,
  CommitRequest,
  CommitResult,
  ContextManifest,
  ExecutionBlueprint,
  FactApprovalSummary,
  ManuscriptDocumentSummary,
  MemoryBundle,
  MemoryClaim,
  MemoryHit,
  NarrativeRhythmSnapshot,
  NarrativeStateSnapshot,
  NovelIntent,
  NovelProjectDetail,
  PreflightPlan,
  PromptContextManifest,
  ProjectSnapshotBundle,
  PromotionReceipt,
  RecentIssueCluster,
  RetrievalFacet,
  Review,
  ReviewIssue,
  RuntimeLearningAssessmentV2,
  SerialCharacterStateSpan,
  SerialContextSnapshot,
  SerialFunctionRun,
  SerialOpenPromise,
  SerialSubjectSpan,
  SkillBundle,
  SkillDescriptor,
  TaskAttemptRecord,
  WorkflowRunRecord,
} from "./protocol";
import type { ModelInvocationAudit, ModelPromptExecution } from "./model-gateway";
import { iso, workflowFromRow, type WorkflowRunRow } from "./repository/shared";
import { WorkflowRunSlice } from "./repository/workflow-run-slice";
import { ModelTaskSlice } from "./repository/model-task-slice";
import { TelemetrySlice } from "./repository/telemetry-slice";
import type { ModelRoutingConfig, ModelRoutingSnapshot, ModelTaskRecord, ModelWorkPackage } from "./model-routing";
import type { ObjectStoreAdapter } from "./object-store";
import { countDialogueCharacters, countNovelCharacters, effectiveTargetWordCount, inspectDialogueDrift, LENGTH_DRIFT_POLICY, normalizeTargetWordCount } from "./word-count";
import type { ObjectStoreIdentity } from "./object-store";
import { normalizeManuscriptStructuralReview } from "./application/manuscript-structure";
import { arcCompletionPredicateSql, auditEmotionalContractCarriage, auditNamedReferences, auditStoryArcBatchRanges, canonicalReferenceId, findEmbeddedInternalIdentifiers, normalizeThreadResponsibilityReferences, parseExplicitNewReference, planThreadForeshadowingBindings, resolveNamedReference, sanitizeReferenceToken, type NamedReferenceCandidate, type StoryArcIntegrityIssue } from "./application/story-arc-integrity";
import { auditFullBookArchitecture } from "./application/full-book-architecture";
import { CHAPTER_NARRATIVE_FUNCTIONS, canGenerateNextStoryArcBatch, inspectStoryArcEnsemble, MAX_STORY_ARC_BATCH_WINDOW, normalizeChapterPlanningContext, parseStoryArcBundle, parseStoryArcPlan, planningContextFingerprint, resolveArcPhase, STORY_ARC_CONTEXT_SECTION_IDS, validateStoryArcPlanContracts, type ArcPlanningStatus, type ChapterBlueprint, type ChapterBlueprintRecord, type ChapterPlanningContext, type ChapterSceneBlueprint, type NarrativeArcPlan, type StoryArcBatchRecord, type StoryArcBundle, type StoryArcContextReceipt, type StoryArcPlotOutline, type StoryArcRebaseTarget, type StoryArcRecord } from "./application/story-arc";
import type { StoryArcReviewOutput } from "./prompts/story-arc";
import { aggregateChapterReviews, isEvidencePresentInText, markEvidenceUnverified, reviewIssueFingerprint, type ChapterReviewIssueStatus } from "./chapter-review-snapshot";
import {
  bookSynopsisSourceFingerprint,
  bookTitleSourceFingerprint,
  parseBookTitleCandidatesMetadata,
  type BookSynopsisRecord,
  type BookTitleCandidatesRecord,
} from "./application/book-synopsis";
import { chapterTitleSourceFingerprint, type ChapterTitleSource } from "./application/chapter-title";
import { canonicalSha256 } from "./canonical-json";
import { compareSkillVersions, createWorkspaceSkillProvider, listCurrentSkillDescriptors } from "./skill-runtime";
import { canonicalizeFactPredicate, normalizeFactToken } from "./fact-extraction/fingerprint";
import { scopeClaimsToChapter } from "./fact-extraction/narrative-scope";
import { dedupeByNarrativeText, foreshadowingLedgerId, formatPayoffWindow, mergeForeshadowingLedgerPayload, narrativeTextKey, parsePayoffWindow, promiseContentKey, type ForeshadowingLedgerPayload, type PayoffWindowRaw } from "./narrative-elements";
import { buildCharacterRefIndex, type CharacterRefForms } from "./character-ref";
import { textBigramDice } from "./memory-grooming";
import { buildCharacterIdentityIndex, resolveCharacterIdentity, type FoundationCharacter } from "./character-identity";
import { auditMigrations as auditMigrationFiles, formatMigrationAudit, readMigrationFiles, readMigrationManifest, type MigrationAudit } from "./migrations";

export const V1_MIGRATED_SKILL_IDS = [
  "long-form-master-craft",
  "story-facts-invariant",
  "premise-pressure-test",
  "character-desire-engine",
  "character-voice-matrix",
  "world-rule-contract",
  "hierarchical-outline",
  "causal-thread-weaving",
  "foreshadowing-ledger",
  "chapter-blueprint",
  "scene-action-reaction",
  "embodied-prose",
  "serial-rhythm",
  "continuity-audit",
  "style-specificity-audit",
  "plot-pacing-audit",
  "fact-delta-extraction",
  "classic-character-ensemble",
  "classic-narrative-tension",
  "classic-prose-texture",
  "romance-arc-design",
  "imagery-aesthetics",
  "prose-discipline",
  "plot-segment-design",
  "plot-segment-audit",
  "blueprint-audit",
  "prose-audit",
  "reader-audit",
] as const;

export function hasCompatibleV1SkillSet(skillIds: readonly string[]): boolean {
  const available = new Set(skillIds);
  return V1_MIGRATED_SKILL_IDS.every((skillId) => available.has(skillId));
}

export interface NovelProjectSnapshot {
  projectId: string;
  currentRevision: number;
  targetDocumentId?: string;
  targetDocumentOrder?: number;
  targetDocumentStatus?: "planned" | "draft" | "review" | "final";
  targetDocumentRevisionId?: string;
  povCharacterId?: string;
  /**
   * Phase 3.3 题材与前提（可选）。
   *
   * 从 novel_projects.metadata 读取，由项目创建时指定。
   * 不内置固定题材枚举——任何字符串都可作为 genre。
   */
  genre?: string;
  premise?: string;
}

export type MutableKnowledgeRecordKind = "planning" | "worldview" | "characters" | "relations" | "timeline" | "claims" | "skills";
export type KnowledgeRecordKind = MutableKnowledgeRecordKind | "foundation" | "claims" | "chapter-memories" | "project-skills";

export interface LearningAssessmentView {
  assessment: RuntimeLearningAssessmentV2;
  sourceChapter?: { id: string; title: string; narrativeOrder: number; status: string };
  candidate?: { id: string; status: string; targetKind: string; targetId: string; proposedVersion: string };
}

type ProjectRow = { id: string; title: string; current_revision: string | number; metadata: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };
type DocumentRow = { id: string; project_id: string; title: string; narrative_order: string | number; pov_character_id: string | null; current_revision_id: string | null; status: string; created_at: Date | string; updated_at: Date | string; word_count?: string | number | null; latest_revision?: string | number | null; chapter_goal?: string | null; blocking_issue_count?: string | number | null; review_score?: string | number | null; review_verdict?: "passed" | "revise" | "blocked" | null; author_decision?: "approve" | "revise" | "reject" | "abandon" | null; review_stale?: boolean | null; arc_id?: string | null; arc_title?: string | null; arc_planning_status?: string | null };
type ArtifactRow = { id: string; project_id: string; task_id: string; attempt_id: string; kind: Artifact["kind"]; content_hash: string; object_key: string | null; base_revision: string | number; fingerprint: string; payload: Record<string, unknown>; created_at: Date | string };
type ProjectPlanSectionRow = { project_id: string; task_key: string; work_item_id: string | null; source_artifact_id: string | null; status: ProjectPlanStatus; payload: Record<string, unknown>; edit_revision: string | number; approved_at: Date | string | null; created_at: Date | string; updated_at: Date | string };
type ArcRow = { id: string; volume_id: string; project_id: string; title: string; ordinal: string | number; planning_status: StoryArcRecord["planningStatus"]; execution_status: StoryArcRecord["executionStatus"]; payload: NarrativeArcPlan; source_artifact_id: string | null; blueprint_artifact_id: string | null; context_fingerprint: string | null; review_artifact_id: string | null; review_fingerprint: string | null; edit_revision: string | number; approved_at: Date | string | null; completed_at: Date | string | null; abandoned_at: Date | string | null; updated_at: Date | string };
type ChapterBlueprintRow = {
  id: string;
  arc_id: string;
  project_id: string;
  document_id: string | null;
  document_status?: string | null;
  document_current_revision_id?: string | null;
  title: string;
  ordinal: string | number;
  status: string;
  payload: Record<string, unknown>;
  source_artifact_id: string | null;
  blueprint_revision: string | number;
};
type StoryArcBatchRow = { id: string; arc_id: string; project_id: string; batch_index: string | number; start_chapter_index: string | number; end_chapter_index: string | number; status: StoryArcBatchRecord["status"]; entry_fingerprint: string; source_artifact_id: string | null; payload: Record<string, unknown>; approved_at: Date | string | null };

/**
 * "已定稿、可投影的章文档"判据（`d` = `manuscript_documents` 的别名），九处 SQL 共用：序列证据 rhythm 的
 * 窗口过滤、最新定稿章目标解析、序列窗口章行、弧内定稿章计数、前章末段装载，以及三条"章行仍 planned 而
 * 文档已 final"的态收口/对账谓词。
 *
 * 分成多份字面量写是本仓最难归因的静默缺席形态之一（F2）：解析目标的一侧放宽（例如只认
 * `status='final'` 而漏掉 `current_revision_id`），就会出现"目标解析成功 → 快照查询 0 行 → 字段整块
 * 缺席"，两侧各自看都像对的。同一判据在九段 SQL 里靠巧合同文（其中三份还是换行分写的）维持一致，
 * 等于没有约束——锁见 `postgres-repository.test.ts` 的"字面量只出现一次"。
 */
export const PROJECTABLE_FINAL_DOCUMENT_SQL = "d.status='final' AND d.current_revision_id IS NOT NULL";

export function buildNarrativeRhythmSnapshotQuery(): string {
  return `SELECT d.id AS document_id,d.current_revision_id AS revision_id,d.narrative_order,d.title,c.arc_id,c.payload AS chapter_payload
       FROM chapters target
       JOIN chapters c ON c.arc_id=target.arc_id AND c.project_id=target.project_id
       JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
       WHERE target.project_id=$1 AND target.document_id=$2
         AND ${PROJECTABLE_FINAL_DOCUMENT_SQL} AND d.narrative_order<=$3
       ORDER BY d.narrative_order`;
}

export function isTransientPostgresStartupError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (code && new Set(["57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]).has(code)) return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /database system is (starting up|not yet accepting connections)|consistent recovery state has not been yet reached|connection terminated unexpectedly/i.test(message);
}

function documentFromRow(row: DocumentRow): ManuscriptDocumentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    narrativeOrder: Number(row.narrative_order),
    povCharacterId: row.pov_character_id ?? undefined,
    currentRevisionId: row.current_revision_id ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    wordCount: row.word_count === undefined || row.word_count === null ? undefined : Number(row.word_count),
    latestRevision: row.latest_revision === undefined || row.latest_revision === null ? undefined : Number(row.latest_revision),
    chapterGoal: row.chapter_goal ?? undefined,
    blockingIssueCount: row.blocking_issue_count === undefined || row.blocking_issue_count === null ? undefined : Number(row.blocking_issue_count),
    reviewScore: row.review_score === undefined || row.review_score === null ? undefined : Number(row.review_score),
    reviewVerdict: row.review_verdict ?? undefined,
    authorDecision: row.author_decision ?? undefined,
    reviewStale: row.review_stale ?? undefined,
    arcId: row.arc_id ?? undefined,
    arcTitle: row.arc_title ?? undefined,
    arcPlanningStatus: row.arc_planning_status ?? undefined,
  };
}
function artifactFromRow(row: ArtifactRow): Artifact {
  return { id: row.id, projectId: row.project_id, taskId: row.task_id, attemptId: row.attempt_id, kind: row.kind, contentHash: row.content_hash, objectKey: row.object_key ?? undefined, baseRevision: Number(row.base_revision), fingerprint: row.fingerprint, structuredData: row.payload ?? {}, createdAt: new Date(row.created_at).getTime() };
}

function memoryClaimFromRow(row: any): MemoryClaim {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    subjectRefs: row.subject_refs ?? [],
    narrativeRange: {
      start: row.narrative_start === null || row.narrative_start === undefined ? undefined : Number(row.narrative_start),
      end: row.narrative_end === null || row.narrative_end === undefined ? undefined : Number(row.narrative_end),
    },
    knowledgeScope: row.knowledge_scope,
    authority: row.authority,
    confidence: Number(row.confidence),
    sourceRevisionIds: row.source_revision_ids ?? [],
    contentHash: row.content_hash,
    supersedes: row.supersedes ?? [],
    predicate: row.predicate ?? undefined,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
    lifecycleStatus: row.lifecycle_status ?? "active",
    sourceDocumentId: row.source_document_id ?? undefined,
    identityHash: row.identity_hash ?? undefined,
    valueHash: row.value_hash ?? undefined,
  };
}

function narrativeClaimRecord(claim: MemoryClaim, source: "fact-extraction" | "manual-claim"): Record<string, unknown> {
  return {
    id: claim.id,
    kind: claim.kind,
    title: claim.title,
    name: claim.title,
    content: claim.content,
    subjectRefs: claim.subjectRefs,
    narrativeStart: claim.narrativeRange?.start,
    narrativeEnd: claim.narrativeRange?.end,
    knowledgeScope: claim.knowledgeScope,
    authority: claim.authority,
    confidence: claim.confidence,
    sourceRevisionIds: claim.sourceRevisionIds,
    predicate: claim.predicate,
    sourceArtifactId: claim.sourceArtifactId,
    supersedes: claim.supersedes,
    decidedBy: claim.decidedBy,
    decidedAt: claim.decidedAt,
    source,
    readOnly: false,
  };
}
function projectPlanSectionFromRow(row: ProjectPlanSectionRow): ProjectPlanSection {
  return {
    projectId: row.project_id,
    taskKey: row.task_key as ProjectPlanTaskKey,
    workItemId: row.work_item_id ?? undefined,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    status: row.status,
    payload: row.payload ?? {},
    editRevision: Number(row.edit_revision),
    approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function chapterBlueprintFromRow(row: ChapterBlueprintRow): ChapterBlueprintRecord {
  const payload = row.payload ?? {};
  const state = payload.stateTransition && typeof payload.stateTransition === "object" && !Array.isArray(payload.stateTransition)
    ? payload.stateTransition as Record<string, unknown>
    : {};
  return {
    id: row.id,
    arcId: row.arc_id,
    projectId: row.project_id,
    documentId: row.document_id ?? undefined,
    globalOrder: Number(row.ordinal),
    // manuscript_documents owns the lifecycle of the actual prose. Keep the
    // denormalized chapter status for planning/query performance, but derive a
    // final status defensively so historical or failed rebase projections do
    // not make committed chapters look generatable again.
    status: row.document_status === "final" && row.document_current_revision_id ? "final" : row.status,
    sourceArtifactId: row.source_artifact_id ?? undefined,
    blueprintRevision: Number(row.blueprint_revision),
    index: typeof payload.index === "number" ? payload.index : Number(row.ordinal),
    title: typeof payload.title === "string" ? payload.title : row.title,
    stateTransition: {
      before: typeof state.before === "string" ? state.before : "",
      after: typeof state.after === "string" ? state.after : "",
      evidence: typeof state.evidence === "string" ? state.evidence : "",
    },
    narrativeFunction: typeof payload.narrativeFunction === "string" && CHAPTER_NARRATIVE_FUNCTIONS.includes(payload.narrativeFunction as (typeof CHAPTER_NARRATIVE_FUNCTIONS)[number]) ? payload.narrativeFunction as ChapterBlueprintRecord["narrativeFunction"] : undefined,
    povCharacterId: typeof payload.povCharacterId === "string" && payload.povCharacterId.trim() ? payload.povCharacterId : undefined,
    // 2026-09-17 断链修复（docs/novel-v2/ai-taint-diagnosis-20260917.md F1/§四-3）：
    // 本映射此前**不读 payload.targetWordCount**，于是补录进 chapters.payload 的目标篇幅
    // 在这一步被静默丢弃——chapter_planning_contexts 因此 226 行全空，正文写作契约回落到
    // DEFAULT_TARGET_WORD_COUNT(3500)，与编排者手写的 2600、门执法的 3500×0.6=2100
    // 构成"同一目标三个数"。这是 F1（等量段配额代偿→节拍器呼吸）的直接上游。
    // 量纲判据单源（normalizeTargetWordCount，与 parseStoryArcBundle 同一函数）：
    // 正整数才收，非法/缺省一律不注入（回落默认值由 effectiveTargetWordCount 表达）。
    targetWordCount: normalizeTargetWordCount(payload.targetWordCount),
    scenes: Array.isArray(payload.scenes) ? payload.scenes.flatMap<ChapterSceneBlueprint>((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const scene = value as Record<string, unknown>;
      const planningRationale = typeof scene.planningRationale === "string" && scene.planningRationale.trim() ? scene.planningRationale.trim() : undefined;
      return [{
        title: typeof scene.title === "string" ? scene.title : `场景 ${index + 1}`,
        participants: Array.isArray(scene.participants) ? scene.participants.filter((item): item is string => typeof item === "string") : [],
        situation: typeof scene.situation === "string" ? scene.situation : "",
        observableActions: Array.isArray(scene.observableActions) ? scene.observableActions.filter((item): item is string => typeof item === "string") : [],
        ...(planningRationale ? { planningRationale } : {}),
        opposition: typeof scene.opposition === "string" && scene.opposition.trim() ? scene.opposition : undefined,
        decision: typeof scene.decision === "string" && scene.decision.trim() ? scene.decision : undefined,
        outcome: typeof scene.outcome === "string" ? scene.outcome : "",
        cost: typeof scene.cost === "string" && scene.cost.trim() ? scene.cost : undefined,
      }];
    }) : [],
    continuityConstraints: Array.isArray(payload.continuityConstraints) ? payload.continuityConstraints.filter((value): value is string => typeof value === "string") : [],
    unresolvedAtClose: Array.isArray(payload.unresolvedAtClose) ? payload.unresolvedAtClose.filter((value): value is string => typeof value === "string") : [],
  };
}

/**
 * 架构健康度里投影失败明细的取数上限。它只约束**明细页**（整账真数走窗口函数），
 * 取最旧优先——卡得越久的账越需要先处理。
 * TODO 可配置：报表页/运维面板若上线，这个数应与那边的分页参数同源。
 */
const HEALTH_PROJECTION_FAILURE_PAGE = 20;

/**
 * 域事件账本（`outbox_events`）的保留天数。**两个判据共用这一个常数**：
 * `pruneOutboxEvents` 按它删旧行，`detectStaleCraftRuleCandidates` 按它给停滞扫描加上界。
 *
 * 为什么必须同源：停滞通报的去重判据是"这条候选的 `updated_at` 之后有没有发过事件"，被查的
 * 事件必须还在账上。让扫描窗口的上界等于保留期，就有一条不变式成立——被扫的候选其
 * `updated_at` 不早于保留线，任何可能为它去重的事件（`created_at >= updated_at`）也都未被清理。
 * 两边各写一个常数迟早错开，错开的表现是**同一个停滞候选被反复通报**（旧事件已清、判据查无）。
 *
 * 现形差实测为零（`ymcp` 只读，2026-09-20）：可扫候选 23 条，其中 `updated_at` 早于 90 天线的
 * 0 条 ⇒ 加上界不改变今天的扫描结果，只是让保留策略可以安全开跑。
 * TODO 可配置：与 `staleAfterDays` 同属运维节奏参数，应一起进配置面。
 */
export const OUTBOX_RETENTION_DAYS = 90;

/** 单次清理的分批大小与批次上限：长期不重启的部署一次删到底会长时间持大量行锁。 */
const OUTBOX_PRUNE_BATCH_ROWS = 5_000;
const OUTBOX_PRUNE_MAX_BATCHES = 20;

export class NovelPostgresRepository {
  readonly pool: Pool;
  private readonly connectionConfig: PoolConfig;
  /** 第一片物理 slice：workflow_runs 的受控读写；公开面仍由仓储委托（消费方零改动）。 */
  private workflowRunsSlice?: WorkflowRunSlice;
  private modelTasksSlice?: ModelTaskSlice;
  private telemetrySlice?: TelemetrySlice;

  constructor(config: PoolConfig | string = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp") {
    this.connectionConfig = typeof config === "string" ? { connectionString: config } : { ...config };
    this.pool = new Pool(this.connectionConfig);
  }

  private async syncFinalChapterBlueprintStatusTx(client: PoolClient, projectId: string, documentId: string): Promise<void> {
    await client.query(
      `UPDATE chapters c
       SET status='final',updated_at=now()
       FROM manuscript_documents d
       WHERE c.project_id=$1
         AND c.document_id=$2
         AND d.id=c.document_id
         AND d.project_id=c.project_id
         AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
         AND c.status<>'final'`,
      [projectId, documentId],
    );
  }

  /**
   * 懒建而非构造期注入：本仓的 SQL 形状测试用 `Object.create(prototype)` + 覆写 `pool`
   * 造桩（不起真连接池），构造期捕获 `this.pool` 会让那条路数静默失效。每个实例的
   * `pool` 只在构造函数里赋值一次、`forSchema` 另建新实例，故缓存切片是安全的。
   */
  private get workflowRuns(): WorkflowRunSlice {
    return (this.workflowRunsSlice ??= new WorkflowRunSlice({ pool: this.pool, appendOutbox: (aggregateType, aggregateId, eventType, payload) => this.appendOutbox(aggregateType, aggregateId, eventType, payload), expireOutstandingTasks: (workflowRunKey, reason) => this.modelTasks.expireForWorkflow(workflowRunKey, reason) }));
  }

  /** 同 workflowRuns：懒建以兼容 `Object.create(prototype)` 造桩路数。 */
  private get modelTasks(): ModelTaskSlice {
    return (this.modelTasksSlice ??= new ModelTaskSlice({ pool: this.pool, appendOutbox: (aggregateType, aggregateId, eventType, payload) => this.appendOutbox(aggregateType, aggregateId, eventType, payload) }));
  }

  /** 懒建，同 workflowRuns/modelTasks：构造期捕获 this.pool 会打死 Object.create(prototype) 造桩路数。 */
  private get telemetry(): TelemetrySlice {
    return (this.telemetrySlice ??= new TelemetrySlice(this.pool));
  }

  forSchema(schemaName: string): NovelPostgresRepository {
    if (!/^[a-z_][a-z0-9_]*$/u.test(schemaName)) throw new Error(`非法 schema 名：${schemaName}`);
    return new NovelPostgresRepository({
      ...this.connectionConfig,
      options: `-c search_path=${schemaName},pg_catalog`,
    });
  }

  /**
   * Serialize every planning/review/next-batch admission for one story arc.
   * The lock is held through workflow registration and Temporal start so a
   * second request cannot pass the status check while the first is in flight.
   */
  async withStoryArcWorkflowLock<T>(projectId: string, arcId: string, callback: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockKey = `ymcp-novel-v2:story-arc:${projectId}:${arcId}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      return await callback();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async listActiveStoryArcWorkflowIds(projectId: string, arcId: string): Promise<string[]> {
    const result = await this.pool.query<{ temporal_workflow_id: string }>(
      `SELECT temporal_workflow_id
       FROM workflow_runs
       WHERE project_id=$1
         AND workflow_type='story-arc-planning'
         AND payload->>'arcId'=$2
         AND status IN (${OPEN_WORKFLOW_RUN_STATUSES_SQL})
       ORDER BY updated_at DESC, temporal_workflow_id`,
      [projectId, arcId],
    );
    return result.rows.map((row) => row.temporal_workflow_id);
  }

  private async assertNoActiveStoryArcWorkflow(client: Pool | PoolClient, projectId: string, arcId: string): Promise<void> {
    const result = await client.query<{ temporal_workflow_id: string }>(
      `SELECT temporal_workflow_id
       FROM workflow_runs
       WHERE project_id=$1
         AND workflow_type='story-arc-planning'
         AND payload->>'arcId'=$2
         AND status IN (${OPEN_WORKFLOW_RUN_STATUSES_SQL})
       ORDER BY updated_at DESC
       LIMIT 1`,
      [projectId, arcId],
    );
    if (result.rowCount) throw new Error(`故事弧已有活动工作流：${result.rows[0].temporal_workflow_id}`);
  }

  /**
   * 应用迁移 + 启动写路径尾部修复。
   *
   * `objects` 可选：传入对象存储适配器时，尾部会一并跑派生正文指标回填
   * （`backfillMissingContentWordCounts`）。**为什么在 migrate 尾而不是调用方**：
   * 迁移新增的可空派生列（对白量）由消费方按"NULL = 不可测"排除，而历史上
   * 回填只挂在 API 入口的启动代码上——worker 同样调 migrate、同样消费该信号，
   * 却永远不回填。于是"迁移已落地、信号恒为空"可以长期静默：实测迁移 098
   * 增列后运行库 424/424 个历史 blob 的 dialogue_characters 全为 NULL，
   * 对白密度信号对规划面与弧审核面始终不可见（docs/novel-v2/state-audit-20261013.md
   * §7 第 5 项的机制在自己的部署面上空转）。migrate 是 API 与 worker 唯一共同调用
   * 的启动路径，与既有的 6 条启动修复同层，故回填归于此处；调用方缺省不传即
   * 保持既有行为（测试库不接对象存储）。
   */
  async migrate(migrationsDir = process.env.NOVEL_V2_MIGRATIONS_DIR ?? join(process.cwd(), "deploy", "postgres"), objects?: ObjectStoreAdapter) {
    const files = readMigrationFiles(migrationsDir);
    if (!files.length) throw new Error(`没有找到 V2 数据库迁移：${migrationsDir}`);
    const manifest = readMigrationManifest(migrationsDir);
    const client = await this.connectForMigration();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('ymcp-novel-v2-migrations'))");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const appliedResult = await client.query<{ version: string; checksum: string; applied_at: Date }>("SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version");
      const audit = auditMigrationFiles(files, appliedResult.rows.map((row) => ({ version: row.version, checksum: row.checksum, appliedAt: row.applied_at.toISOString() })), manifest);
      if (audit.checksumMismatches.length || audit.unexpectedApplied.length) {
        throw new Error(`迁移审计失败：\n${formatMigrationAudit(audit).join("\n")}`);
      }
      for (const file of files) {
        if (!audit.missingInDatabase.includes(file.version)) continue;
        const sql = readFileSync(join(migrationsDir, file.version), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [file.version, file.checksum]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`数据库迁移失败 ${file.version}: ${(error as Error).message}`, { cause: error });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('ymcp-novel-v2-migrations'))").catch(() => undefined);
      client.release();
    }
    // Keep the repair available even in deployments where local SQL migration
    // files are supplied outside the application package.
    await this.repairFinalChapterBlueprintStatuses();
    await this.repairCompletedStoryArcStatuses();
    await this.backfillCurrentChapterReviewSnapshots();
    await this.repairFoundationClaimSingletons();
    await this.repairStoryArcReferenceHygiene();
    await this.repairBookTitleProjections();
    await this.repairForeshadowingPayoffLedger();
    await this.repairStoryArcBatchCompleteFlags();
    await this.repairForeshadowingLedgerDuplicates();
    if (objects) {
      // 派生正文指标回填（内容寻址、逐行 try/catch，对象不可读只计失败不抛）。
      // 幂等：已回填的行不再进选择集，故每次启动为零行扫描。
      const derived = await this.backfillMissingContentWordCounts(objects);
      if (derived.updated || derived.failed) console.warn(`[migrate] content blob 派生指标回填更新 ${derived.updated} 行、失败 ${derived.failed} 行`);
    }
    await this.seedWorkspaceSkills();
    const expiredOrphanTasks = await this.expireOrphanedModelTasks();
    if (expiredOrphanTasks) console.warn(`[migrate] 收编 run 已终态/缺失的未交付外部任务 ${expiredOrphanTasks} 条`);
    const prunedOutboxEvents = await this.pruneOutboxEvents();
    if (prunedOutboxEvents) console.warn(`[migrate] 域事件账本按 ${OUTBOX_RETENTION_DAYS} 天保留清理 ${prunedOutboxEvents} 行`);
  }

  /**
   * 批次 complete 旗回补（与 projectStoryArcBundle 派生口径同源，2026-09-12 弧5
   * 实践批）：该旗此前是模型自报——弧 1 满覆盖却存 false（下游只能靠 prepareNext
   * 维度守卫兜底），弧 5 重编排批次系统派生了 true 但存量行仍是生成时的 false。
   * 只回补每个弧的最后一批（complete 语义=弧内规划覆盖已达成，滚动批次的中间批
   * 恒为 false 本就正确）；expected 缺失/为 0 的旧弧不动（无声明窗口不发明事实）。
   * 幂等：派生值与存量一致的行 jsonb_set 值短路（seed 教训同款值比较守卫）。
   */
  async repairStoryArcBatchCompleteFlags(): Promise<number> {
    const result = await this.pool.query(
      `WITH last_batches AS (
         SELECT b.id, b.arc_id,
           (SELECT COUNT(DISTINCT c.ordinal) FROM chapters c WHERE c.arc_id = b.arc_id) AS planned_ordinals,
           COALESCE((SELECT (a.payload->>'expectedChapterCount')::int FROM arcs a WHERE a.id = b.arc_id), 0) AS expected
         FROM story_arc_batches b
         WHERE (b.arc_id, b.batch_index) IN (SELECT arc_id, MAX(batch_index) FROM story_arc_batches GROUP BY arc_id)
       )
       UPDATE story_arc_batches b
       SET payload = jsonb_set(b.payload, '{complete}', to_jsonb(l.planned_ordinals >= l.expected))
       FROM last_batches l
       WHERE b.id = l.id AND l.expected > 0 AND (b.payload->>'complete') IS DISTINCT FROM (l.planned_ordinals >= l.expected)::text`,
    );
    return result.rowCount ?? 0;
  }

  /**
   * 伏笔账本同章重措辞归并（弧6 收口对账实证）：锚点身份（PL-5③）上线前登记的老行退回
   * 描述内容键，同一叙事装置的每轮重抽取换措辞即新增一行——运行库实测 overdue 101 条
   * 中约四成为此类变体（"树洞蓝光"六个变体）。归并只吃"同章 + 描述 bigram 相似度达阈"
   * 的保守面：keeper=最早登记行，变体 status 翻 'merged'（非破坏，open 消费面自然出局），
   * 描述进 keeper.mergedFrom、keywords/possiblePayoffs 并集、变体 payload.mergedInto 指向
   * keeper。幂等：变体已标 merged 不再出现于 open 扫描面，keeper 侧重复描述由集合去重吸收。
   *
   * 2026-09-19 两处判据面收口（product-audit-20260910 §五复测）：
   * ① 分桶键加 project_id。此前扫描面无项目约束、分组只按 narrative_order，两个项目
   *    的"第 31 章"行会进同一桶——在阈值 0.24 的传递闭包下即跨项目归并（A 项目的伏笔
   *    被 B 项目的行吃掉账）。运行库实测当前只有一个项目携带伏笔账，故属潜伏缺陷而非
   *    事故，但多项目是本仓库的既有契约，不能靠"暂时只有一个项目"保平安。
   * ② `narrative_order IS NULL` 的行并入独立桶（此前 WHERE 整批排除）。检测面
   *    （getArchitectureHealth）跨全表按 narrativeTextKey+bigram Dice≥0.85 聚簇，而修复面
   *    看不见无锚点行 ⇒ 二者判据不对称，实测残留的那 1 簇正是两条无锚点的规划期同事件
   *    行（括注人名版与去括注版，Dice 0.92）。同桶 10 行用本面同一判据（0.24 并查集）
   *    实测只成两簇、七条单例，无闭包吞并，故纳入是安全的。
   *    刻意不做：跨章同文仍不归并——不同章的相同描述是"两次埋设事件"而非重复登记，
   *    该形态由检测面 warning 交作者判断（宁缺毋伪），不因 warning 计数为 0 而放宽。
   */
  async repairForeshadowingLedgerDuplicates(): Promise<{ clusters: number; retired: number }> {
    // 账表无时间戳列；keeper=同桶字典序首行（内容派生 id 稳定），并集不丢任何变体信息，
    // keeper 选择不影响语义。桶键=项目 + 埋设章（无锚点行以 "#" 自成一桶，不与任何章混桶）。
    const rows = await this.pool.query<{ project_id: string; id: string; narrative_order: number | null; payload: Record<string, unknown> }>(
      "SELECT project_id, id, narrative_order, payload FROM foreshadowing WHERE status='open' ORDER BY project_id, narrative_order NULLS LAST, id",
    );
    // 阈值 0.24（运行库校准，非猜测）：弧6 收口对全 open 账做逐对扫描，同事件变体
    // 实测带 0.25-0.41（含人物别名与句式重组；并查集传递闭包把 0.22-0.24 的同族两两
    // 间接并入"粉末→树洞→蓝光"一个装置族，语义正确），首个真·不同叙事时刻（同一物件
    // 的不同动作："欲言又止未追问" vs "移除后发现表面干净"）落在 0.21。取 0.24 让
    // 闭包吃到全部变体、留出边界余量。TODO 可配置意图：重抽取模型措辞漂移率变化时
    // 用同法（逐对分布带）重校准，不逐例加规则。
    const THRESHOLD = 0.24;
    const norm = (s: string) => s.replace(/[^一-鿿]/g, "");
    const byBucket = new Map<string, typeof rows.rows>();
    for (const row of rows.rows) {
      const key = `${row.project_id}\u0000${row.narrative_order ?? "#"}`;
      const list = byBucket.get(key) ?? [];
      list.push(row);
      byBucket.set(key, list);
    }
    let clusters = 0;
    let retired = 0;
    for (const group of byBucket.values()) {
      if (group.length < 2) continue;
      const parent = group.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = norm(String(group[i].payload?.description ?? ""));
          const b = norm(String(group[j].payload?.description ?? ""));
          if (a && b && textBigramDice(a, b) >= THRESHOLD) parent[find(j)] = find(i);
        }
      }
      const buckets = new Map<number, number[]>();
      group.forEach((_, i) => buckets.set(find(i), [...(buckets.get(find(i)) ?? []), i]));
      for (const members of buckets.values()) {
        if (members.length < 2) continue;
        clusters += 1;
        const keeper = group[members[0]];
        const keeperPayload = { ...keeper.payload };
        const keeperDescription = String(keeperPayload.description ?? "");
        const mergedFrom = new Set<string>((keeperPayload.mergedFrom as string[]) ?? []);
        const keywords = new Set<string>((keeperPayload.triggerKeywords as string[]) ?? []);
        const payoffs = new Set<string>((keeperPayload.possiblePayoffs as string[]) ?? []);
        for (const idx of members.slice(1)) {
          const variant = group[idx];
          const vp = variant.payload ?? {};
          const text = String(vp.description ?? "");
          if (text && text !== keeperDescription) mergedFrom.add(text);
          for (const k of (vp.triggerKeywords as string[]) ?? []) keywords.add(k);
          for (const p of (vp.possiblePayoffs as string[]) ?? []) payoffs.add(p);
          await this.pool.query("UPDATE foreshadowing SET status='merged', payload=$2 WHERE id=$1", [variant.id, { ...vp, mergedInto: keeper.id }]);
          retired += 1;
        }
        keeperPayload.triggerKeywords = [...keywords];
        if (payoffs.size) keeperPayload.possiblePayoffs = [...payoffs];
        if (mergedFrom.size) keeperPayload.mergedFrom = [...mergedFrom];
        await this.pool.query("UPDATE foreshadowing SET payload=$2 WHERE id=$1", [keeper.id, keeperPayload]);
      }
    }
    return { clusters, retired };
  }

  /**
   * 存量收敛（product-audit-20260910 A2）：foundation 投影切换段级单例 id 后，
   * 为所有含 foundation artifact 的项目回填/刷新单例行；历史 per-artifact 行由
   * 单例行 supersedes 退役（查询期可见性，不删数据）。幂等：单例行已指向
   * 最新 artifact 的槽位直接跳过。
   */
  async repairFoundationClaimSingletons(): Promise<void> {
    const projects = await this.pool.query<{ project_id: string }>(
      "SELECT DISTINCT project_id FROM artifacts WHERE kind='foundation'");
    for (const row of projects.rows) {
      await this.ensureFoundationMemoryClaims(row.project_id);
    }
  }

  /**
   * books.title 收口为 novel_projects.title 的投影（审计 FM-6 派生名单一真源）。
   * books 是 story_arcs 的 FK 锚且 title 无读消费方，历史上只在项目初建时写了一次
   * 快照，重批书名后永远滞留旧值。派生写面已同步（approveProjectPlanSection），
   * 这里幂等收口存量：仅两值确实不同才改写，重复执行为零变更。
   */
  async repairBookTitleProjections(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE books b SET title = p.title
       FROM novel_projects p
       WHERE b.project_id = p.id AND b.title IS DISTINCT FROM p.title`,
    );
    return result.rowCount ?? 0;
  }

  async auditMigrations(migrationsDir = process.env.NOVEL_V2_MIGRATIONS_DIR ?? join(process.cwd(), "deploy", "postgres")): Promise<MigrationAudit> {
    const files = readMigrationFiles(migrationsDir);
    if (!files.length) throw new Error(`没有找到 V2 数据库迁移：${migrationsDir}`);
    const manifest = readMigrationManifest(migrationsDir);
    const client = await this.connectForMigration();
    try {
      const result = await client.query<{ version: string; checksum: string; applied_at: Date }>("SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version");
      return auditMigrationFiles(files, result.rows.map((row) => ({ version: row.version, checksum: row.checksum, appliedAt: row.applied_at.toISOString() })), manifest);
    } finally {
      client.release();
    }
  }

  private async repairFinalChapterBlueprintStatuses(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE chapters c
       SET status='final',updated_at=now()
       FROM manuscript_documents d
       WHERE c.project_id=d.project_id
         AND c.document_id=d.id
         AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
         AND c.status<>'final'`,
    );
    return result.rowCount ?? 0;
  }

  /**
   * Reconcile arc lifecycle state after an older commit path left all of its
   * approved batch chapters final while the arc remained active.
   *
   * The condition intentionally requires every blueprint chapter to have a
   * final manuscript revision and the last approved batch either to declare
   * itself complete or to cover the arc's expected chapter boundary. The
   * boundary fallback prevents a model omission of `complete=true` from
   * leaving a fully committed arc permanently active; an unlinked or planned
   * chapter still blocks completion.
   */
  private async repairCompletedStoryArcStatuses(): Promise<number> {
    const result = await this.pool.query<{ id: string; project_id: string }>(
      `UPDATE arcs a
       SET execution_status='completed',completed_at=COALESCE(completed_at,now()),updated_at=now()
       WHERE a.execution_status='active'
         AND EXISTS (SELECT 1 FROM chapters c WHERE c.arc_id=a.id)
         AND NOT EXISTS (
           SELECT 1
           FROM chapters c
           LEFT JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
           WHERE c.arc_id=a.id
             AND (d.id IS NULL OR d.status<>'final' OR d.current_revision_id IS NULL)
         )
         AND ${arcCompletionPredicateSql("a", "b")}
       RETURNING a.id,a.project_id`,
    );
    for (const row of result.rows) {
      await this.pool.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc.completion-reconciled','story-arc',$2,$3)",
        [row.project_id, row.id, { reason: "all chapters final and last approved batch complete" }],
      );
    }
    return result.rowCount ?? 0;
  }

  /**
   * content_blobs 派生正文指标回补（字数 + 对白量）。
   *
   * 两个指标都是"从正文派生、可复用、内容寻址天然去重"的结构量，故共用同一次正文读取：
   * 逐行取对象存储原文，只补仍为 NULL 的列（`word_count` / `dialogue_characters` 各自
   * 独立判定，避免其中一个已有值时另一个漏补）。对白量口径见
   * src/novel-v2/word-count.ts 的 `countDialogueCharacters`。
   *
   * 调用点只有 `migrate()` 尾（传入 objects 时）：见该处的根因说明——回填必须落在
   * API 与 worker 共同经过的启动路径上，只挂一个入口会让另一侧的消费方永远看不见
   * 这批派生指标。
   */
  async backfillMissingContentWordCounts(objects: ObjectStoreAdapter): Promise<{ updated: number; failed: number }> {
    const result = await this.pool.query<{ content_hash: string; object_key: string }>(
      "SELECT content_hash,object_key FROM content_blobs WHERE word_count IS NULL OR dialogue_characters IS NULL ORDER BY created_at,content_hash",
    );
    let updated = 0;
    let failed = 0;
    for (const row of result.rows) {
      try {
        const text = await objects.getText(row.object_key);
        const update = await this.pool.query(
          `UPDATE content_blobs
              SET word_count=COALESCE(word_count,$2),
                  dialogue_characters=COALESCE(dialogue_characters,$3)
            WHERE content_hash=$1 AND (word_count IS NULL OR dialogue_characters IS NULL)`,
          [row.content_hash, countNovelCharacters(text), countDialogueCharacters(text)],
        );
        updated += update.rowCount ?? 0;
      } catch {
        failed += 1;
      }
    }
    return { updated, failed };
  }

  async recordMemoryGateCheck(input: { projectId: string; workflowId: string; criticalMissingFacets: string[]; blockAfter?: number }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const missing = [...new Set(input.criticalMissingFacets)].sort();
      const result = await client.query<{ consecutive_critical_misses: number; last_missing_facets: string[] }>(`
        INSERT INTO memory_gate_states(project_id,consecutive_critical_misses,last_missing_facets,last_checked_at)
        VALUES($1,$2,$3,now())
        ON CONFLICT(project_id) DO UPDATE SET
          consecutive_critical_misses=CASE WHEN cardinality(EXCLUDED.last_missing_facets)=0 THEN 0 ELSE memory_gate_states.consecutive_critical_misses+1 END,
          last_missing_facets=EXCLUDED.last_missing_facets,
          last_checked_at=now()
        RETURNING consecutive_critical_misses,last_missing_facets
      `, [input.projectId, missing.length ? 1 : 0, missing]);
      const state = result.rows[0];
      const blocked = missing.length > 0 && state.consecutive_critical_misses >= (input.blockAfter ?? 3);
      if (blocked) {
        await this.appendOutboxTx(client, "memory-gate", input.projectId, "memory-gate.blocked", { projectId: input.projectId, workflowId: input.workflowId, consecutiveCriticalMisses: state.consecutive_critical_misses, missingFacets: state.last_missing_facets });
      }
      await client.query("COMMIT");
      return { consecutiveCriticalMisses: state.consecutive_critical_misses, missingFacets: state.last_missing_facets, blocked };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async connectForMigration(): Promise<PoolClient> {
    const timeoutMs = Number(process.env.NOVEL_V2_POSTGRES_CONNECT_TIMEOUT_MS ?? 60_000);
    const intervalMs = Number(process.env.NOVEL_V2_POSTGRES_CONNECT_RETRY_MS ?? 1_000);
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    let attempt = 0;
    let lastError: unknown;
    while (true) {
      try {
        return await this.pool.connect();
      } catch (error) {
        lastError = error;
        if (!isTransientPostgresStartupError(error) || Date.now() >= deadline) break;
        attempt += 1;
        const remainingMs = Math.max(deadline - Date.now(), 0);
        await delay(Math.min(intervalMs * Math.min(attempt, 5), remainingMs));
      }
    }
    throw new Error(`Postgres 未在 ${timeoutMs}ms 内准备好：${(lastError as Error)?.message ?? String(lastError)}`, { cause: lastError });
  }

  async requestMemoryRebuild(projectId: string) {
    const result = await this.pool.query<{ consecutive_critical_misses: number; last_missing_facets: string[] }>(`
      INSERT INTO memory_gate_states(project_id,last_checked_at)
      VALUES($1,now())
      ON CONFLICT(project_id) DO UPDATE SET last_checked_at=now()
      RETURNING consecutive_critical_misses,last_missing_facets
    `, [projectId]);
    const requestedAt = new Date().toISOString();
    await this.appendOutbox("memory-gate", projectId, "memory.rebuild-requested", { projectId, requestedAt });
    return { projectId, status: "rebuild-requested" as const, requestedAt, consecutiveCriticalMisses: result.rows[0].consecutive_critical_misses, missingFacets: result.rows[0].last_missing_facets };
  }

  async completeMemoryRebuild(projectId: string, indexedClaims: number, removedStalePoints = 0) {
    await this.pool.query(`
      INSERT INTO memory_gate_states(project_id,consecutive_critical_misses,last_missing_facets,last_checked_at)
      VALUES($1,0,'{}',now())
      ON CONFLICT(project_id) DO UPDATE SET consecutive_critical_misses=0,last_missing_facets='{}',last_checked_at=now()
    `, [projectId]);
    await this.appendOutbox("memory-gate", projectId, "memory.rebuild-completed", { projectId, indexedClaims, removedStalePoints });
    return { projectId, status: "ready" as const, indexedClaims, removedStalePoints };
  }

  async backfillCurrentChapterReviewSnapshots(): Promise<number> {
    const result = await this.pool.query<{ artifact_id: string }>(`
      SELECT DISTINCT mr.artifact_id
      FROM manuscript_documents d JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      WHERE mr.artifact_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chapter_review_snapshots s WHERE s.document_id=d.id AND s.reviewed_content_hash=mr.content_hash)
    `);
    let refreshed = 0;
    for (const row of result.rows) if (await this.refreshChapterReviewSnapshot(row.artifact_id)) refreshed += 1;
    return refreshed;
  }

  async health() {
    await this.pool.query("SELECT 1");
    return { postgres: true };
  }

  async projectModelRoutingConfig(config: ModelRoutingConfig, snapshot: ModelRoutingSnapshot) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // API and worker initialize the same routing snapshot concurrently. The
      // refresh is a delete-and-replace transaction, so serialize writers to
      // prevent both transactions inserting the same provider primary key.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('novel-v2:model-routing-config'))");
      await client.query("DELETE FROM provider_configs");
      await client.query("DELETE FROM model_routes");
      for (const profile of snapshot.profiles) {
        await client.query(
          `INSERT INTO provider_configs(id,provider,model,capabilities,config,enabled,config_revision,label,protocol,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [profile.id, profile.protocol, profile.model, profile.capabilities, { baseUrl: profile.baseUrl, responseMode: profile.responseMode, timeoutMs: profile.timeoutMs, contextWindow: profile.contextWindow, secretRef: profile.secretRef, hasSecret: profile.hasSecret }, profile.enabled, snapshot.id, profile.label, profile.protocol],
        );
      }
      for (const [taskClass, route] of Object.entries(config.routes)) {
        const apiCandidates = route.candidates.filter((candidate): candidate is Extract<(typeof route.candidates)[number], { executor: "api" }> => candidate.executor === "api");
        await client.query(
          `INSERT INTO model_routes(task_class,primary_provider_id,fallback_provider_id,budget,candidates,conversation_policy,config_revision,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now())`,
          [taskClass, apiCandidates[0]?.profileId ?? "external-mcp", apiCandidates[1]?.profileId ?? null, { maxInputTokens: route.maxInputTokens, maxOutputTokens: route.maxOutputTokens }, JSON.stringify(route.candidates), route.conversationPolicy ?? "stateless", snapshot.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

    async recordModelInvocation(input: ModelInvocationAudit): Promise<void> {
    return this.telemetry.recordModelInvocation(input);
  }

    async listModelUsage(limit = 100) {
    return this.telemetry.listModelUsage(limit);
  }

    async getEstimatedVsProviderRatio(input: { sinceDays?: number } = {}) {
    return this.telemetry.getEstimatedVsProviderRatio(input);
  }

    async getRoutingCandidateHealth(input: { sinceDays?: number; minSamples?: number } = {}) {
    return this.telemetry.getRoutingCandidateHealth(input);
  }

    async lookupEmbeddings(model: string, texts: string[]): Promise<(number[] | undefined)[]> {
    return this.telemetry.lookupEmbeddings(model, texts);
  }

    async storeEmbeddings(model: string, entries: Array<{ text: string; vector: number[] }>): Promise<void> {
    return this.telemetry.storeEmbeddings(model, entries);
  }

  async createModelTask(workPackage: ModelWorkPackage, idempotencyKey: string): Promise<ModelTaskRecord> {
    return this.modelTasks.create(workPackage, idempotencyKey);
  }

  async listModelTasks(status: ModelTaskRecord["status"] = "pending", limit = 50, projectId?: string): Promise<ModelTaskRecord[]> {
    return this.modelTasks.list(status, limit, projectId);
  }

  async getModelTask(taskId: string): Promise<ModelTaskRecord | undefined> {
    return this.modelTasks.get(taskId);
  }

  async claimModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; leaseMs: number }): Promise<ModelTaskRecord> {
    return this.modelTasks.claim(input);
  }

  async heartbeatModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; leaseMs: number }): Promise<void> {
    return this.modelTasks.heartbeat(input);
  }

  async submitModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; inputFingerprint: string; result: ModelTaskRecord["result"] }): Promise<ModelTaskRecord> {
    return this.modelTasks.submit(input);
  }

  async failModelTask(input: { taskId: string; attemptId: string; leaseOwner: string; reason: string }): Promise<ModelTaskRecord> {
    return this.modelTasks.fail(input);
  }

  /** 人物引用归一索引（P4）：登记表内把任意漂移形态解析为规范三形态。 */
  private async characterRefIndex(projectId: string, connection: Pool | PoolClient = this.pool) {
    const rows = await connection.query<{ id: string; name: string }>("SELECT id,name FROM entities WHERE project_id=$1 AND kind='character'", [projectId]);
    return buildCharacterRefIndex(rows.rows);
  }

  private async characterRefForms(projectId: string, value: string): Promise<CharacterRefForms | undefined> {
    return (await this.characterRefIndex(projectId)).resolve(value);
  }

  /** 引用 → 显示名解析（POV 残留扫描等"以名找文"消费面用；未登记为 undefined）。 */
  async resolveCharacterDisplayNames(projectId: string, refs: readonly string[]): Promise<Record<string, string | undefined>> {
    const index = await this.characterRefIndex(projectId);
    const resolved: Record<string, string | undefined> = {};
    for (const ref of refs) resolved[ref] = ref ? index.resolve(ref)?.name : undefined;
    return resolved;
  }

  async searchMemory(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    // P2-G1: 词法检索 SQL 修正为 OR 匹配
    // 设计依据：AGENTS.md「root-cause analysis」——原实现 `pattern = '%${terms.join(" ")}%'`
    // 把多关键词拼成精确短语匹配（如 "李雷 韩梅梅 学校" → '%李雷 韩梅梅 学校%'），
    // 只有 content 包含完整连续短语才命中，导致单个关键词命中也无法召回。
    // 修正为：每个 term 独立 ILIKE OR 匹配，任一关键词命中即召回，
    // 再用命中数（lexicalRank）做排序权重。
    //
    // P2-G2: 同时计算 lexicalRank（命中 term 数 / 总 term 数），
    // 让 buildMemoryBundle 能做三轨加权融合（semantic + lexical + graph）。
    const results: MemoryHit[] = [];
    // POV 作用域过滤的形态归一（P4）：facet.knowledgeCharacterId 来自蓝图（存在
    // char_chu/chu-heng 等漂移形态），claims.knowledge_scope 存短 id 或显示名——
    // 字符串相等匹配会静默漏配整章的 POV 记忆。登记表解析成功后按规范 URI 比对，
    // 未登记形态回退字面相等（不发明人物，也不改变旧数据语义）。
    const povIndex = input.facets.some((facet) => facet.knowledgeCharacterId) ? await this.characterRefIndex(input.projectId) : undefined;
    const sameCharacter = (left: string, right: string): boolean => {
      if (left === right) return true;
      if (!povIndex) return false;
      const leftForms = povIndex.resolve(left);
      const rightForms = povIndex.resolve(right);
      return Boolean(leftForms && rightForms && leftForms.uri === rightForms.uri);
    };
    for (const facet of input.facets) {
      const terms = facet.query.split(/\s+/u).filter(Boolean).slice(0, 8);
      if (terms.length === 0) continue;
      // 每个 term 在 WHERE 子句和 SELECT lexical_rank 中复用同一参数占位符（PostgreSQL 支持）
      const params: unknown[] = [input.projectId];
      const orClauses: string[] = [];
      for (const term of terms) {
        params.push(`%${term}%`);
        const contentParam = params.length;
        params.push(`%${term}%`);
        const titleParam = params.length;
        orClauses.push(`content ILIKE $${contentParam} OR title ILIKE $${titleParam}`);
      }
      params.push(terms);
      orClauses.push(`subject_refs && $${params.length}`);
      let extra = "";
      if (input.narrativeCutoff !== undefined) {
        params.push(input.narrativeCutoff);
        extra += ` AND (narrative_start IS NULL OR narrative_start <= $${params.length})`;
      }
      // lexical_rank 表达式：复用 $2..$(2+terms.length*2-1) 参数
      // 每 term 占 2 个参数位（content pattern + title pattern），从 $2 开始
      const lexicalRankSelect = terms.map((_, idx) => {
        const contentParam = 2 + idx * 2;
        const titleParam = 3 + idx * 2;
        return `(CASE WHEN content ILIKE $${contentParam} OR title ILIKE $${titleParam} THEN 1 ELSE 0 END)`;
      }).join(" + ");
      const sql = `SELECT *, (${lexicalRankSelect})::REAL / ${terms.length} AS lexical_rank FROM memory_claims WHERE project_id = $1 AND ${retrievalVisibleClaimsSql("memory_claims")} AND (${orClauses.join(" OR ")}) ${extra} ORDER BY lexical_rank DESC, confidence DESC, created_at DESC LIMIT 32`;
      const rows = await this.pool.query<any>(sql, params);
      for (const row of rows.rows) {
        if (facet.knowledgeCharacterId && row.knowledge_scope?.characterId && !sameCharacter(String(row.knowledge_scope.characterId), facet.knowledgeCharacterId)) continue;
        const lexicalRank = Number(row.lexical_rank ?? 0);
        results.push({
          id: row.id,
          projectId: row.project_id,
          kind: row.kind,
          title: row.title,
          content: row.content,
          subjectRefs: row.subject_refs ?? [],
          narrativeRange: {
            start: row.narrative_start === null || row.narrative_start === undefined ? undefined : Number(row.narrative_start),
            end: row.narrative_end === null || row.narrative_end === undefined ? undefined : Number(row.narrative_end),
          },
          knowledgeScope: row.knowledge_scope,
          authority: row.authority,
          confidence: Number(row.confidence),
          sourceRevisionIds: row.source_revision_ids ?? [],
          contentHash: row.content_hash,
          supersedes: row.supersedes ?? [],
          predicate: row.predicate ?? undefined,
          sourceArtifactId: row.source_artifact_id ?? undefined,
          decidedBy: row.decided_by ?? undefined,
          decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
          // 检索面必须带 identity/value 指纹：槽位配额与"同槽位同值跨管道判重"都以
          // identityHash 为键（cognition.ts 的 countSlot/semanticKey），漏字段=配额恒不触发。
          identityHash: row.identity_hash ?? undefined,
          valueHash: row.value_hash ?? undefined,
          // P2-G2: score 用 lexicalRank 加权（0.7 lexical + 0.3 confidence）
          score: 0.7 * lexicalRank + 0.3 * Number(row.confidence),
          matchedFacet: facet.kind,
          reason: `postgres lexical match:${facet.kind}`,
          // P2-G2: 填充 lexicalRank 字段，让 buildMemoryBundle 三轨融合能识别
          lexicalRank,
        });
      }
    }
    const merged = new Map<string, MemoryHit>();
    for (const hit of results) {
      const existing = merged.get(hit.id);
      if (!existing) {
        merged.set(hit.id, { ...hit, matchedFacets: [hit.matchedFacet] });
        continue;
      }
      const preferred = hit.score > existing.score ? hit : existing;
      merged.set(hit.id, {
        ...preferred,
        matchedFacets: [...new Set([...(existing.matchedFacets ?? [existing.matchedFacet]), hit.matchedFacet])],
        lexicalRank: Math.max(existing.lexicalRank ?? 0, hit.lexicalRank ?? 0),
        reason: `${existing.reason} | ${hit.reason}`,
      });
    }
    return [...merged.values()];
  }

  async searchGraphMemory(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    const graphFacets = input.facets.filter((facet) => facet.kind === "entity" || facet.kind === "relation" || facet.kind === "thread");
    if (!graphFacets.length) return [];
    const params: unknown[] = [input.projectId];
    // PL-4 正文可指认门（检索面）：来源为章节抽取（source_revision_id 非空）却未绑正文
    // 位置（valid_from NULL）的关系，是未通过可指认判定的"规划候选"，不得作为正文事实被
    // 检索——正是"零出场人物挂正文来源关系"的止血点。它们仍可经 listRelations 供人工裁决。
    // 人工/legacy 关系（source_revision_id 为空）保持原语义不受影响。
    let validity = " AND NOT (r.source_revision_id IS NOT NULL AND r.valid_from IS NULL)";
    if (input.narrativeCutoff !== undefined) {
      params.push(input.narrativeCutoff);
      validity += ` AND (r.valid_from IS NULL OR r.valid_from<=$${params.length}) AND (r.valid_to IS NULL OR r.valid_to>=$${params.length})`;
    }
    if (input.povCharacterId) {
      // P4：relations.subject_id/object_id 恒为实体 URI，蓝图 POV 是短 id/漂移形态——
      // 旧的字符串相等使 POV 作用域关系召回恒空。按登记表展开为 URI/短 id/原值集合，
      // 未登记值保留原样匹配（向后兼容）。
      const forms = await this.characterRefForms(input.projectId, input.povCharacterId);
      const scopeIds = [...new Set([forms?.uri ?? input.povCharacterId, forms?.shortId ?? input.povCharacterId, input.povCharacterId])];
      params.push(scopeIds);
      validity += ` AND (r.subject_id=ANY($${params.length}::text[]) OR r.object_id=ANY($${params.length}::text[]))`;
    }
    const relations = await this.pool.query<{
      id: string; subject_id: string; predicate: string; object_id: string; valid_from: string | number | null; valid_to: string | number | null; source_revision_id: string | null; subject_name: string | null; object_name: string | null;
    }>(
      `SELECT r.id,r.subject_id,r.predicate,r.object_id,r.valid_from,r.valid_to,r.source_revision_id,
         subject.name AS subject_name,object.name AS object_name
       FROM relations r
       LEFT JOIN entities subject ON subject.id=r.subject_id AND subject.project_id=r.project_id
       LEFT JOIN entities object ON object.id=r.object_id AND object.project_id=r.project_id
       WHERE r.project_id=$1${validity}
       ORDER BY r.valid_from DESC NULLS LAST,r.id LIMIT 96`,
      params,
    );
    const hits: MemoryHit[] = [];
    for (const row of relations.rows) {
      const content = `${row.subject_name ?? row.subject_id} ${row.predicate} ${row.object_name ?? row.object_id}`;
      for (const facet of graphFacets.filter((item) => item.kind !== "thread")) {
        const terms = facet.query.split(/\s+/u).filter(Boolean);
        const matched = terms.filter((term) => content.includes(term)).length;
        if (!matched && facet.kind !== "relation") continue;
        const score = terms.length ? Math.max(0.2, matched / terms.length) : 0.2;
        hits.push({
          id: `graph:${row.id}`,
          projectId: input.projectId,
          kind: "working",
          title: `关系：${content}`,
          content,
          subjectRefs: [row.subject_id, row.object_id],
          narrativeRange: { start: row.valid_from === null ? undefined : Number(row.valid_from), end: row.valid_to === null ? undefined : Number(row.valid_to) },
          knowledgeScope: input.povCharacterId ? { characterId: input.povCharacterId } : "author",
          authority: "derived",
          confidence: 0.85,
          sourceRevisionIds: row.source_revision_id ? [row.source_revision_id] : [],
          contentHash: createHash("sha256").update(`${row.id}:${content}:${row.valid_from ?? ""}:${row.valid_to ?? ""}`).digest("hex"),
          supersedes: [],
          predicate: row.predicate,
          score,
          graphRank: score,
          matchedFacet: facet.kind,
          matchedFacets: ["relation", "entity"],
          reason: "postgres relation graph",
        });
      }
    }
    const threadFacets = graphFacets.filter((facet) => facet.kind === "thread");
    if (threadFacets.length) {
      const threads = await this.pool.query<{ id: string; title: string; payload: Record<string, unknown> }>(
        "SELECT id,title,payload FROM plot_threads WHERE project_id=$1 AND status='open' ORDER BY id LIMIT 64",
        [input.projectId],
      );
      for (const row of threads.rows) {
        const content = `${row.title}\n${JSON.stringify(row.payload)}`;
        const matched = threadFacets.flatMap((facet) => facet.query.split(/\s+/u).filter(Boolean)).filter((term) => content.includes(term)).length;
        const score = matched ? Math.min(1, 0.4 + matched * 0.15) : 0.25;
        hits.push({ id: `graph-thread:${row.id}`, projectId: input.projectId, kind: "hierarchical", title: row.title, content, subjectRefs: [row.id], knowledgeScope: "author", authority: "approved", confidence: 0.9, sourceRevisionIds: [], contentHash: createHash("sha256").update(`${row.id}:${content}`).digest("hex"), supersedes: [], score, graphRank: score, matchedFacet: "thread", reason: "postgres plot-thread graph" });
      }
    }
    const merged = new Map<string, MemoryHit>();
    for (const hit of hits.sort((a, b) => b.score - a.score)) if (!merged.has(hit.id)) merged.set(hit.id, hit);
    return [...merged.values()];
  }

  async ensureProject(projectId: string, title = projectId, metadata?: Record<string, unknown>) {
    if (metadata && Object.keys(metadata).length) {
      // Phase 3.3: 支持 premise/genre 等元数据写入（题材通用差异化，不内置金手指/系统流特化）
      await this.pool.query(
        "INSERT INTO novel_projects(id, title, metadata) VALUES($1, $2, $3::jsonb) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(EXCLUDED.title,''), novel_projects.title), metadata=novel_projects.metadata || EXCLUDED.metadata, updated_at=now()",
        [projectId, title, JSON.stringify(metadata)],
      );
    } else {
      await this.pool.query("INSERT INTO novel_projects(id, title) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(EXCLUDED.title,''), novel_projects.title), updated_at=now()", [projectId, title]);
    }
  }

  async listProjects() {
    const result = await this.pool.query(`
      SELECT p.id,p.title,p.current_revision,p.metadata,p.created_at,p.updated_at,positioning.payload AS positioning_payload,
        latest.status AS latest_run_status
      FROM novel_projects p
      LEFT JOIN project_plan_sections positioning ON positioning.project_id=p.id AND positioning.task_key='project-positioning' AND positioning.status='approved'
      LEFT JOIN LATERAL (
        SELECT status FROM workflow_runs r WHERE r.project_id=p.id ORDER BY r.updated_at DESC LIMIT 1
      ) latest ON TRUE
      WHERE COALESCE(p.metadata->>'systemKind','') = ''
      ORDER BY p.updated_at DESC
    `);
    return result.rows.map((row: ProjectRow & { latest_run_status?: string | null; positioning_payload?: Record<string, unknown> | null }) => ({ id: row.id, title: resolveProjectTitle(row.id, row.title, row.positioning_payload ?? undefined), currentRevision: Number(row.current_revision), current_revision: Number(row.current_revision), metadata: row.metadata ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), updated_at: iso(row.updated_at), latestRunStatus: row.latest_run_status ?? undefined }));
  }

  async getProjectDetail(projectId: string): Promise<NovelProjectDetail> {
    const project = await this.pool.query<ProjectRow & { positioning_payload?: Record<string, unknown> | null }>("SELECT p.id,p.title,p.current_revision,p.metadata,p.created_at,p.updated_at,positioning.payload AS positioning_payload FROM novel_projects p LEFT JOIN project_plan_sections positioning ON positioning.project_id=p.id AND positioning.task_key='project-positioning' AND positioning.status='approved' WHERE p.id=$1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    const documents = await this.pool.query<DocumentRow>(`
      SELECT d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at,
        COALESCE(cb.word_count, 0) AS word_count,
        mr.revision AS latest_revision,
        cps.chapter_goal,
        COUNT(crsi.id)::int AS blocking_issue_count,
        crs.overall_score AS review_score,crs.verdict AS review_verdict,
        -- 作者对当前内容的最终决定：approval_evidence 按 artifact 内容哈希与当前修订内容对齐，
        -- 区分「reviewer 聚合判 revise」与「作者已覆盖批准」两个独立事实（防误读，见 protocol.authorDecision 注）。
        (SELECT ae.decision FROM approval_evidence ae
          JOIN artifacts ra ON ra.id=ae.artifact_id
          WHERE ae.project_id=d.project_id AND ra.content_hash=mr.content_hash
          ORDER BY ae.created_at DESC, ae.id DESC LIMIT 1) AS author_decision,
        CASE WHEN crs.id IS NULL THEN NULL ELSE crs.reviewed_content_hash<>mr.content_hash END AS review_stale,
        a.id AS arc_id,a.title AS arc_title,a.planning_status AS arc_planning_status
      FROM manuscript_documents d
      LEFT JOIN chapters ch ON ch.document_id=d.id
      LEFT JOIN arcs a ON a.id=ch.arc_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
      LEFT JOIN chapter_review_snapshots crs ON crs.document_id=d.id
      LEFT JOIN chapter_review_snapshot_issues crsi ON crsi.snapshot_id=crs.id AND crsi.severity='blocker' AND crsi.status='pending'
      WHERE d.project_id=$1
      GROUP BY d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at,cb.word_count,mr.revision,cps.chapter_goal,crs.id,crs.overall_score,crs.verdict,crs.reviewed_content_hash,mr.content_hash,a.id,a.title,a.planning_status
      ORDER BY d.narrative_order,d.id
    `, [projectId]);
    const runs = await this.listProjectRuns(projectId, 5);
    const row = project.rows[0];
    return { id: row.id, title: resolveProjectTitle(row.id, row.title, row.positioning_payload ?? undefined), currentRevision: Number(row.current_revision), metadata: row.metadata ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), documents: documents.rows.map(documentFromRow), latestRuns: runs };
  }

  async ensureDocument(input: { projectId: string; documentId?: string; title: string; narrativeOrder?: number; povCharacterId?: string; status?: string; chapterGoal?: string }): Promise<ManuscriptDocumentSummary> {
    await this.ensureProject(input.projectId);
    const id = input.documentId?.trim() || randomUUID();
    const order = input.narrativeOrder ?? await this.nextDocumentOrder(input.projectId);
    const result = await this.pool.query<DocumentRow>(`INSERT INTO manuscript_documents(id,project_id,title,narrative_order,pov_character_id,status)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(project_id,narrative_order) DO UPDATE SET title=EXCLUDED.title,pov_character_id=EXCLUDED.pov_character_id,status=EXCLUDED.status,updated_at=now()
      RETURNING id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at`, [id, input.projectId, input.title, order, input.povCharacterId ?? null, input.status ?? "planned"]);
    const document = documentFromRow(result.rows[0]);
    await this.upsertChapterProductionSpec({ projectId: input.projectId, documentId: document.id, chapterGoal: input.chapterGoal });
    return document;
  }

  async updateProject(input: { projectId: string; title?: string; metadata?: Record<string, unknown> }) {
    const result = await this.pool.query<ProjectRow>(`
      UPDATE novel_projects
      SET title=COALESCE($2, title),
          metadata=(metadata || COALESCE($3, '{}'::jsonb)) - CASE WHEN $2::text IS NULL THEN '__unchanged__' ELSE 'bookTitleCandidates' END,
          updated_at=now()
      WHERE id=$1
      RETURNING id,title,current_revision,metadata,created_at,updated_at
    `, [input.projectId, input.title ?? null, input.metadata ?? null]);
    if (!result.rowCount) throw new Error("项目不存在");
    await this.appendOutbox("novel-project", input.projectId, "project.updated", { projectId: input.projectId, title: input.title });
    return this.getProjectDetail(input.projectId);
  }

    async recordPromptExecution(input: ModelPromptExecution & { contextManifestId?: string }, objects: ObjectStoreAdapter): Promise<void> {
    return this.telemetry.recordPromptExecution(input, objects);
  }

    async putPromptContextManifest(manifest: PromptContextManifest): Promise<void> {
    return this.telemetry.putPromptContextManifest(manifest);
  }

    async listPromptExecutions(workflowId: string) {
    return this.telemetry.listPromptExecutions(workflowId);
  }

    async listModelInvocations(workflowId: string, limit = 200) {
    return this.telemetry.listModelInvocations(workflowId, limit);
  }

    async getPromptExecutionSnapshot(id: string, objects: ObjectStoreAdapter) {
    return this.telemetry.getPromptExecutionSnapshot(id, objects);
  }

  /**
   * 执行留痕的保留清理（挂在 api 的 retention 循环：启动一次 + 每 24h 一次）。
   *
   * 语义是"载荷到期、收据留存"：到期行清掉三样大载荷——两个对象存储键（迁移 028 正是
   * 为此把它们改成可空）与**整份内联 `context_manifest`**；行本身与 purpose/状态/指纹/耗时
   * 留着，`listPromptExecutions` 按 run 列留痕、报表按 fingerprint 关联 manifest 都读它们。
   * 此前只清前两个键，漏了内联 manifest：实测 `ymcp` 9,243 行全部带 30 天到期时间、4,861 行
   * 已过期，而内联 manifest 合计 184 MB（未压缩）——这张表 89 MB 几乎全是它，即"到期"从未
   * 真正收走过体积。
   *
   * 刻意不删行：删行会把审计收据一起收走，而 `expires_at` 的原意只管载荷；"收据要不要另设
   * 寿命"是独立问题，不混进这条清理。
   *
   * 引用集必须在置 NULL **之前**取：同一 prompt 的幂等重放会共用 content-addressed 键，
   * 先动键再问"还有谁引用"就会把仍被别的行引用的对象误报成孤儿、被调用方删掉。
   */
  async cleanupExpiredPromptExecutions(nowMs = Date.now()): Promise<{ cleared: number; orphanedObjectKeys: string[] }> {
    const expired = await this.pool.query<{ prompt_object_key: string | null; response_object_key: string | null }>(`
      WITH snapshots AS (
        SELECT id,prompt_object_key,response_object_key FROM prompt_executions
        WHERE expires_at<=to_timestamp($1 / 1000.0)
          AND (prompt_object_key IS NOT NULL OR response_object_key IS NOT NULL OR context_manifest IS NOT NULL)
        FOR UPDATE
      ), cleared AS (
        UPDATE prompt_executions AS execution
        SET prompt_object_key=NULL,response_object_key=NULL,context_manifest=NULL
        FROM snapshots WHERE execution.id=snapshots.id
        RETURNING snapshots.prompt_object_key,snapshots.response_object_key
      )
      SELECT * FROM cleared
    `, [nowMs]);
    const keys = [...new Set(expired.rows.flatMap((row) => [row.prompt_object_key, row.response_object_key]).filter((key): key is string => Boolean(key)))];
    if (!keys.length) return { cleared: expired.rowCount ?? 0, orphanedObjectKeys: [] };
    const referenced = await this.pool.query<{ object_key: string }>(`
      SELECT prompt_object_key AS object_key FROM prompt_executions WHERE prompt_object_key=ANY($1)
      UNION SELECT response_object_key FROM prompt_executions WHERE response_object_key=ANY($1)
      UNION SELECT object_key FROM content_blobs WHERE object_key=ANY($1)
      UNION SELECT object_key FROM artifacts WHERE object_key=ANY($1)
    `, [keys]);
    const retained = new Set(referenced.rows.map((row) => row.object_key));
    return { cleared: expired.rowCount ?? 0, orphanedObjectKeys: keys.filter((key) => !retained.has(key)) };
  }

  async saveBookSynopsisIfCurrent(input: { projectId: string; sourceFingerprint: string; synopsis: BookSynopsisRecord }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sectionRows = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 FOR UPDATE`,
        [input.projectId],
      );
      const project = await client.query<ProjectRow & { positioning_payload?: Record<string, unknown> | null }>(
        "SELECT p.id,p.title,p.current_revision,p.metadata,p.created_at,p.updated_at,positioning.payload AS positioning_payload FROM novel_projects p LEFT JOIN project_plan_sections positioning ON positioning.project_id=p.id AND positioning.task_key='project-positioning' AND positioning.status='approved' WHERE p.id=$1 FOR UPDATE OF p",
        [input.projectId],
      );
      if (!project.rowCount) throw new Error("项目不存在");
      const byKey = new Map(sectionRows.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
      const sections = PROJECT_PLAN_STAGES.flatMap((stage) => {
        const section = byKey.get(stage.taskKey);
        return section ? [section] : [];
      });
      const currentFingerprint = bookSynopsisSourceFingerprint({ projectTitle: resolveProjectTitle(project.rows[0].id, project.rows[0].title, project.rows[0].positioning_payload ?? undefined), sections });
      if (currentFingerprint !== input.sourceFingerprint) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE novel_projects SET metadata=metadata || $2::jsonb,updated_at=now() WHERE id=$1",
        [input.projectId, { bookSynopsis: input.synopsis }],
      );
      await client.query("COMMIT");
      await this.appendOutbox("novel-project", input.projectId, "project.synopsis-updated", { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint });
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveBookTitleCandidatesIfCurrent(input: { projectId: string; sourceFingerprint: string; candidates: BookTitleCandidatesRecord }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sectionRows = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 FOR UPDATE`,
        [input.projectId],
      );
      const project = await client.query<ProjectRow>(
        "SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rowCount) throw new Error("项目不存在");
      const byKey = new Map(sectionRows.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
      const sections = PROJECT_PLAN_STAGES.flatMap((stage) => {
        const section = byKey.get(stage.taskKey);
        return section ? [section] : [];
      });
      if (bookTitleSourceFingerprint(sections) !== input.sourceFingerprint) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE novel_projects SET metadata=metadata || $2::jsonb,updated_at=now() WHERE id=$1",
        [input.projectId, { bookTitleCandidates: input.candidates }],
      );
      await client.query("COMMIT");
      await this.appendOutbox("novel-project", input.projectId, "project.title-candidates-updated", { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint });
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async selectBookTitleCandidate(input: { projectId: string; sourceFingerprint: string; title: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sectionRows = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 FOR UPDATE`,
        [input.projectId],
      );
      const project = await client.query<ProjectRow>(
        "SELECT id,title,current_revision,metadata,created_at,updated_at FROM novel_projects WHERE id=$1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rowCount) throw new Error("项目不存在");
      const byKey = new Map(sectionRows.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
      const sections = PROJECT_PLAN_STAGES.flatMap((stage) => {
        const section = byKey.get(stage.taskKey);
        return section ? [section] : [];
      });
      if (bookTitleSourceFingerprint(sections) !== input.sourceFingerprint) throw new Error("全书规划已变化，请重新生成书名候选");
      const candidates = parseBookTitleCandidatesMetadata(project.rows[0].metadata);
      if (!candidates || candidates.sourceFingerprint !== input.sourceFingerprint) throw new Error("书名候选已失效，请重新生成");
      const selected = candidates.candidates.find((candidate) => candidate.title === input.title.trim());
      if (!selected) throw new Error("只能选择当前书名候选中的一项");
      await client.query(
        "UPDATE novel_projects SET title=$2,metadata=metadata - 'bookTitleCandidates',updated_at=now() WHERE id=$1",
        [input.projectId, selected.title],
      );
      await client.query("COMMIT");
      await this.appendOutbox("novel-project", input.projectId, "project.title-selected", { projectId: input.projectId, title: selected.title, sourceFingerprint: input.sourceFingerprint });
      return this.getProjectDetail(input.projectId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteProject(projectId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Telemetry and event tables cascade via the project_id FK (migration 083),
      // but rows written before attribution keep a NULL project_id; delete them by
      // the owning run reference while the run rows are still present.
      // 注：`model_tasks` / `task_attempts` 已不在此循环里——它们的 SQL 全部归
      // `ModelTaskSlice`（见 removeProjectTasks），归属判据由守卫按表名锁住。
      // 剩下这两张属 telemetry 片，同类缺陷登记在下一片。
      for (const table of ["model_invocations", "prompt_executions"]) {
        await client.query(`DELETE FROM ${table} WHERE project_id=$1 OR workflow_run_id IN (SELECT id FROM workflow_runs WHERE project_id=$1 UNION SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1)`, [projectId]);
      }
      await client.query("DELETE FROM outbox_events WHERE project_id=$1", [projectId]);
      await this.modelTasks.removeProjectTasks(client, projectId);
      await client.query("DELETE FROM workflow_runs WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM learning_assessments WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM context_manifests WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM retrieval_runs WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM execution_blueprints WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM skill_bundles WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM memory_bundles WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM preflight_plans WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM novel_intents WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM memory_claims WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM reviews WHERE project_id=$1", [projectId]);
      await client.query("DELETE FROM artifacts WHERE project_id=$1", [projectId]);
      const result = await client.query("DELETE FROM novel_projects WHERE id=$1 RETURNING id", [projectId]);
      await client.query("COMMIT");
      return { deleted: Boolean(result.rowCount), projectId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async updateDocument(input: { projectId: string; documentId: string; title?: string; narrativeOrder?: number; povCharacterId?: string | null; status?: string; chapterGoal?: string }): Promise<ManuscriptDocumentSummary> {
    const result = await this.pool.query<DocumentRow>(`
      UPDATE manuscript_documents
      SET title=COALESCE($3, title),
        narrative_order=COALESCE($4, narrative_order),
        pov_character_id=CASE WHEN $5::boolean THEN $6 ELSE pov_character_id END,
        status=COALESCE($7, status),
        updated_at=now()
      WHERE project_id=$1 AND id=$2
      RETURNING id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at
    `, [input.projectId, input.documentId, input.title ?? null, input.narrativeOrder ?? null, input.povCharacterId !== undefined, input.povCharacterId ?? null, input.status ?? null]);
    if (!result.rowCount) throw new Error("章节不存在");
    if (input.chapterGoal !== undefined) await this.upsertChapterProductionSpec({ projectId: input.projectId, documentId: input.documentId, chapterGoal: input.chapterGoal });
    await this.appendOutbox("manuscript-document", input.documentId, "document.updated", { projectId: input.projectId, documentId: input.documentId });
    return documentFromRow(result.rows[0]);
  }

  async deleteDocument(projectId: string, documentId: string) {
    const result = await this.pool.query("DELETE FROM manuscript_documents WHERE project_id=$1 AND id=$2 RETURNING id", [projectId, documentId]);
    await this.appendOutbox("manuscript-document", documentId, "document.deleted", { projectId, documentId, deleted: Boolean(result.rowCount) });
    return { deleted: Boolean(result.rowCount), projectId, documentId };
  }

  private async nextDocumentOrder(projectId: string): Promise<number> {
    const result = await this.pool.query<{ next_order: number }>("SELECT COALESCE(MAX(narrative_order),0)+1 AS next_order FROM manuscript_documents WHERE project_id=$1", [projectId]);
    return Number(result.rows[0]?.next_order ?? 1);
  }

  async getRecord(table: "preflight_plans" | "memory_bundles" | "skill_bundles" | "execution_blueprints" | "artifacts" | "context_manifests" | "learning_assessments", id: string) {
    const result = await this.pool.query(`SELECT payload FROM ${table} WHERE id=$1`, [id]);
    return result.rows[0]?.payload ?? null;
  }

  async putSkillBundle(bundle: SkillBundle): Promise<SkillBundle> {
    await this.pool.query(
      "INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,fingerprint=EXCLUDED.fingerprint",
      [bundle.id, bundle.projectId, bundle.preflightId, bundle, bundle.fingerprint],
    );
    return bundle;
  }

  async putMemoryBundle(bundle: MemoryBundle): Promise<MemoryBundle> {
    await this.pool.query(
      "INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,fingerprint=EXCLUDED.fingerprint",
      [bundle.id, bundle.projectId, bundle.preflightId, bundle, bundle.fingerprint],
    );
    return bundle;
  }

  /**
   * 按 `OUTBOX_RETENTION_DAYS` 清域事件账本（挂在 `migrate()` 尾部）。
   *
   * 分批 DELETE 而不是一条大语句：一条语句删到底会在单个事务里长时间持住大量行锁，
   * 而"锁按对象数堆爆共享锁表"的形态本仓在迁移面上已实测过（093 的 SQLSTATE 53200）。
   * 删的是超过保留期的历史事件；游标型消费方（REST 轮询按 `id>` 前进）只会看到窗口左端
   * 收缩，不会漏取未读过的行。
   */
  async pruneOutboxEvents(nowMs = Date.now()): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < OUTBOX_PRUNE_MAX_BATCHES; batch += 1) {
      const result = await this.pool.query(
        `DELETE FROM outbox_events WHERE id = ANY(
           ARRAY(SELECT id FROM outbox_events
                 WHERE created_at < to_timestamp($1 / 1000.0) - make_interval(days => $2::int)
                 ORDER BY id LIMIT $3)
         )`,
        [nowMs, OUTBOX_RETENTION_DAYS, OUTBOX_PRUNE_BATCH_ROWS],
      );
      const deleted = result.rowCount ?? 0;
      removed += deleted;
      if (deleted < OUTBOX_PRUNE_BATCH_ROWS) break;
    }
    return removed;
  }

  async putReview(review: Review, options: { refreshChapterSnapshot?: boolean; plainText?: string } = {}) {
    review = normalizeManuscriptStructuralReview(review);
    // pg 对 JS 数组使用 PostgreSQL array literal 序列化（{elem1,elem2}），而非 JSON。
    // issues 是 JS 对象数组，直接传给 jsonb 列会导致 "invalid input syntax for type json" 错误。
    // 修复：显式 JSON.stringify，让 pg 以字符串参数发送，PostgreSQL 再解析为 jsonb。
    // modelProvenance 是对象，pg 本身会正确序列化为 JSON，但显式 stringify 保持一致性。
    await this.pool.query("INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,artifact_fingerprint,issues,model_provenance,score,role,dimension_scores) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING", [review.id, review.projectId, review.artifactId, review.reviewerId, review.identity, review.verdict, review.artifactFingerprint, JSON.stringify(review.issues), review.modelProvenance ? JSON.stringify(review.modelProvenance) : null, review.score ?? null, review.role ?? null, JSON.stringify({})]);
    if (options.refreshChapterSnapshot !== false) await this.refreshChapterReviewSnapshot(review.artifactId, undefined, options.plainText);
    return review;
  }

  async getReviewsByIds(ids: string[]): Promise<Review[]> {
    if (!ids.length) return [];
    const result = await this.pool.query<any>("SELECT * FROM reviews WHERE id=ANY($1::text[])", [ids]);
    const byId = new Map<string, Review>(result.rows.map((row) => [row.id, normalizeManuscriptStructuralReview({
      id: row.id,
      projectId: row.project_id,
      artifactId: row.artifact_id,
      reviewerId: row.reviewer_id,
      identity: row.identity,
      verdict: row.verdict,
      artifactFingerprint: row.artifact_fingerprint,
      issues: row.issues ?? [],
      score: row.score === null ? undefined : Number(row.score),
      role: row.role ?? undefined,
      modelProvenance: row.model_provenance ?? undefined,
      createdAt: new Date(row.created_at).getTime(),
    })]));
    return ids.flatMap((id) => {
      const review = byId.get(id);
      return review ? [review] : [];
    });
  }

  async expireModelTask(taskId: string, reason: string): Promise<void> {
    return this.modelTasks.expire(taskId, reason);
  }

  async expireWorkflowModelTasks(workflowRunId: string, reason: string): Promise<number> {
    return this.modelTasks.expireForWorkflow(workflowRunId, reason);
  }

  /**
   * 收编"run 已终态（或 run 行已不存在）却仍挂着未交付"的外部任务，挂在 `migrate()` 尾。
   *
   * 为什么还需要它而不只靠新的终态转换挂钩：挂钩只对未来生效，而运行库已经积着这类行（实测
   * `ymcp` 3 条 pending：2 条挂在 cancelled、1 条挂在 completed 的 run 上）。它们所在的 run
   * 早已终态，`reconcileStaleWorkflowRuns` 的候选集只挑**非终态** run，永远不会碰它们，于是
   * 编排者的任务队列里长期挂着领不走也关不掉的僵尸。
   * 选键与收编**都**在 `ModelTaskSlice.expireOrphaned`（整个概念一个家）；本层只委托。
   */
  async expireOrphanedModelTasks(reason = "run-already-terminal"): Promise<number> {
    return this.modelTasks.expireOrphaned(reason);
  }

  /**
   * OR-B4（product-audit-20260910 E3）周期对账：僵尸非终态 run 的诚实关闭。
   * 判据：Temporal retention=24h 无卷——updated_at 超窗的 running 类 run 已无从核对
   * 引擎真相（代码里曾有的 zombieReaped 机制并不存在），继续挂 running 只会永久阻塞
   * 同类工作流的活动锁与看板。超窗统一落 failed + 显式 terminalOutcome/reasonCode：
   *   running/accepted → abandoned-stale-run；waiting-external → external-wait-timed-out。
   * 边界（刻意不收编）：manual-review-required/paused 是**等待人**的合法停驻态，
   * 机器无权判定人类何时回来。配套 expireWorkflowModelTasks 清其名下未认领外部任务。
   * 触发：maintenance 端点/编排者周期调用（无隐式调度器——对账是运维决策频率）。
   */
  async reconcileStaleWorkflowRuns(input: { nowMs: number; maxRunningMs?: number; maxWaitingExternalMs?: number }): Promise<Array<{ workflowId: string; previousStatus: string; reasonCode: string }>> {
    const maxRunningMs = input.maxRunningMs ?? 6 * 60 * 60 * 1000; // TODO P3: running 类上限应可配置（覆盖最长合法生成链 + 余量）
    const maxWaitingExternalMs = input.maxWaitingExternalMs ?? 24 * 60 * 60 * 1000; // TODO P3: 与 Temporal history retention(24h) 对齐
    const reconciledAt = new Date(input.nowMs).toISOString();
    const candidates = await this.pool.query<{ temporal_workflow_id: string; project_id: string; status: string }>(
      `SELECT temporal_workflow_id, project_id, status FROM workflow_runs
       WHERE (status IN (${ACTIVE_WORKFLOW_RUN_STATUSES_SQL}) AND updated_at < $1::timestamptz)
          OR (status=${WAITING_EXTERNAL_WORKFLOW_RUN_STATUS_SQL} AND updated_at < $2::timestamptz)
       ORDER BY updated_at LIMIT 200`,
      [new Date(input.nowMs - maxRunningMs).toISOString(), new Date(input.nowMs - maxWaitingExternalMs).toISOString()],
    );
    const reconciled: Array<{ workflowId: string; previousStatus: string; reasonCode: string }> = [];
    for (const row of candidates.rows) {
      const waitingExternal = row.status === "waiting-external";
      const terminalOutcome = waitingExternal ? "external-wait-timed-out" : "abandoned-stale-run";
      const reasonCode = waitingExternal ? "external-wait-exceeded-retention-window" : "stale-running-beyond-temporal-retention";
      // 乐观守卫：仅当仍是候选快照里的旧状态才收编——对账期间 run 真的推进/终态
      // （workflow 自己写了新状态）时放弃本行，绝不用过期判据覆写新鲜事实。
      const updated = await this.pool.query(
        `UPDATE workflow_runs SET status='failed', updated_at=now(),
           payload = payload || jsonb_build_object('terminalOutcome', $3::text, 'reasonCode', $4::text, 'reconciledAt', $5::text)
         WHERE temporal_workflow_id=$1 AND status=$2 RETURNING id`,
        [row.temporal_workflow_id, row.status, terminalOutcome, reasonCode, reconciledAt],
      );
      if (!updated.rowCount) continue;
      await this.appendOutbox("workflow-run", row.temporal_workflow_id, "workflow.reconciled-abandoned", { projectId: row.project_id, workflowId: row.temporal_workflow_id, previousStatus: row.status, terminalOutcome, reasonCode });
      // 僵尸 run 名下未认领/未关闭的外部任务一并清账，防止 pending 队列被幽灵 run 喂脏。
      await this.expireWorkflowModelTasks(row.temporal_workflow_id, `run-reconciled: ${reasonCode}`);
      reconciled.push({ workflowId: row.temporal_workflow_id, previousStatus: row.status, reasonCode });
    }
    // creative_runs 镜像收编（审计"11 条非终态累积"）：paused 同 manual-review-required
    // 是等人的合法停驻态，不收编。
    const creativeCandidates = await this.pool.query<{ id: string; project_id: string; status: string }>(
      `SELECT id, project_id, status FROM creative_runs
       WHERE status IN ('pending','running') AND updated_at < $1::timestamptz
       ORDER BY updated_at LIMIT 200`,
      [new Date(input.nowMs - maxRunningMs).toISOString()],
    );
    for (const row of creativeCandidates.rows) {
      const updated = await this.pool.query(
        `UPDATE creative_runs SET status='failed', updated_at=now(),
           payload = payload || jsonb_build_object('terminalOutcome', 'abandoned-stale-run', 'reasonCode', 'stale-creative-run-beyond-retention', 'reconciledAt', $3::text)
         WHERE id=$1 AND status=$2 RETURNING id`,
        [row.id, row.status, reconciledAt],
      );
      if (!updated.rowCount) continue;
      await this.appendOutbox("creative-run", row.id, "creative-run.reconciled-abandoned", { projectId: row.project_id, runId: row.id, previousStatus: row.status, reasonCode: "stale-creative-run-beyond-retention" });
      reconciled.push({ workflowId: row.id, previousStatus: row.status, reasonCode: "stale-creative-run-beyond-retention" });
    }
    return reconciled;
  }

  async listIndexableMemoryClaims(input: { offset?: number; limit?: number; projectId?: string } = {}): Promise<MemoryClaim[]> {
    const result = await this.pool.query<any>(
      `SELECT * FROM memory_claims
       WHERE ${retrievalVisibleClaimsSql("memory_claims")} AND ($3::text IS NULL OR project_id=$3)
       ORDER BY project_id,created_at,id OFFSET $1 LIMIT $2`,
      [input.offset ?? 0, input.limit ?? 500, input.projectId ?? null],
    );
    return result.rows.map((row: any) => ({
      id: row.id, projectId: row.project_id, kind: row.kind, title: row.title, content: row.content,
      subjectRefs: row.subject_refs ?? [], narrativeRange: {
        start: row.narrative_start === null || row.narrative_start === undefined ? undefined : Number(row.narrative_start),
        end: row.narrative_end === null || row.narrative_end === undefined ? undefined : Number(row.narrative_end),
      },
      knowledgeScope: row.knowledge_scope, authority: row.authority, confidence: Number(row.confidence),
      sourceRevisionIds: row.source_revision_ids ?? [], contentHash: row.content_hash, supersedes: row.supersedes ?? [],
      predicate: row.predicate ?? undefined, sourceArtifactId: row.source_artifact_id ?? undefined,
    }));
  }

  async listActiveMemoryClaimsByRevision(projectId: string, revisionId: string): Promise<MemoryClaim[]> {
    const result = await this.pool.query<any>(
      `SELECT * FROM memory_claims
       WHERE project_id=$1 AND lifecycle_status='active'
         AND authority IN ('approved','author','derived')
         AND $2=ANY(source_revision_ids)
       ORDER BY created_at,id`,
      [projectId, revisionId],
    );
    return result.rows.map(memoryClaimFromRow);
  }

  /**
   * 全库可索引声明总数（`reindex-novel-memory` 拿它对账"应索引 vs 已索引"）。
   * 与 listIndexableMemoryClaims 同口径：被 supersedes 退役的行不进入向量索引
   * （memory-governance-audit-20260909 §5.3.1——可索引集 = 检索可见集）。
   * 刻意由 {@link listIndexableMemoryRowIds} 求和得出：可见性谓词只许有一份。
   */
  async countIndexableMemoryClaims(): Promise<number> {
    const rows = await this.listIndexableMemoryRowIds();
    return rows.reduce((sum, row) => sum + row.claimIds.length + row.chapterMemoryIds.length, 0);
  }

  /**
   * 向量索引"该有哪些点"的基线，按项目给出**行 id**（doctor 的 `memory-index-drift` 用）。
   *
   * 与重建路径同源：`POST /v2/projects/:id/memory/rebuild` 灌进 Qdrant 的正是
   * `listIndexableMemoryClaims` + `listAllChapterMemories` 两批，一行一个点；谓词直接复用
   * `retrievalVisibleClaimsSql`，不手写第二份可见性判据（本仓不变量）。
   *
   * 给 id 而非计数：漂移只能按集合对账。按条数比会把"缺 N 条"和"多 M 个点"抵消成
   * 一条中间数，而这两个方向的后果完全不同（见 memory-index-drift.ts）。
   */
  async listIndexableMemoryRowIds(): Promise<Array<{ projectId: string; claimIds: string[]; chapterMemoryIds: string[] }>> {
    const result = await this.pool.query<{ project_id: string; source: string; id: string }>(`
      SELECT project_id, 'claim' AS source, id FROM memory_claims WHERE ${retrievalVisibleClaimsSql("memory_claims")}
      UNION ALL
      SELECT project_id, 'chapter' AS source, id FROM chapter_memories
      ORDER BY 1, 2, 3`);
    const byProject = new Map<string, { projectId: string; claimIds: string[]; chapterMemoryIds: string[] }>();
    for (const row of result.rows) {
      const entry = byProject.get(row.project_id) ?? { projectId: row.project_id, claimIds: [], chapterMemoryIds: [] };
      if (row.source === "claim") entry.claimIds.push(row.id); else entry.chapterMemoryIds.push(row.id);
      byProject.set(row.project_id, entry);
    }
    return [...byProject.values()];
  }

  /**
   * 给定行 id 中"当前仍在可索引集里"的那个子集——语义检索的存活判定。
   *
   * 存在的理由是一条实测缺口：Qdrant 点 payload 里的 `lifecycleStatus`/`authority`/
   * `supersedes` 都是**索引时刻的副本**，行此后被退役、转 staged、被删都不会自己变。
   * `ymcp` 实测索引里有 22 个"已被可见杀手退役"的点与 5 个"行已 staged"的点。召回时
   * 只看这份副本，就会把已退役内容当现行事实交给模型（正是 A1/FM-1 那条不变量要防的）。
   *
   * 谓词与 {@link listIndexableMemoryRowIds} 同源，本方法只是把它从"全库枚举"收成
   * "按 id 批量问"，不另写第二份可见性判据（本仓不变量）。
   */
  async filterIndexableMemoryRowIds(projectId: string, rowIds: string[]): Promise<Set<string>> {
    if (!rowIds.length) return new Set();
    const claims = await this.pool.query<{ id: string }>(
      `SELECT id FROM memory_claims WHERE project_id=$1 AND id=ANY($2) AND ${retrievalVisibleClaimsSql("memory_claims")}`,
      [projectId, rowIds]);
    // 章记忆点在库里活在 chapter_memories（rebuild 的组成里它就不受 supersedes 约束），
    // 只判"行还在不在"：删弧连带删行时，它的点必须不再被召回。
    const chapters = await this.pool.query<{ id: string }>(
      "SELECT id FROM chapter_memories WHERE project_id=$1 AND id=ANY($2)", [projectId, rowIds]);
    return new Set([...claims.rows, ...chapters.rows].map((row) => row.id));
  }

  async listAllChapterMemories(input: { offset?: number; limit?: number; projectId?: string } = {}): Promise<ChapterMemory[]> {
    const result = await this.pool.query<any>("SELECT * FROM chapter_memories WHERE ($3::text IS NULL OR project_id=$3) ORDER BY project_id,narrative_start,id OFFSET $1 LIMIT $2", [input.offset ?? 0, input.limit ?? 500, input.projectId ?? null]);
    return result.rows.map((row: any) => ({
      id: row.id, projectId: row.project_id, documentId: row.document_id, revisionId: row.revision_id,
      narrativeRange: { start: Number(row.narrative_start), end: Number(row.narrative_end) }, summary: row.summary,
      keyEvents: row.key_events ?? [], characterStates: row.character_states ?? [], unresolvedThreads: row.unresolved_threads ?? [],
      emotionalArc: row.emotional_arc ?? undefined, fingerprint: row.fingerprint, createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async upsertChapterProductionSpec(input: { projectId: string; documentId: string; chapterGoal?: string }) {
    const result = await this.pool.query(`
      INSERT INTO chapter_production_specs(document_id,project_id,chapter_goal)
      VALUES($1,$2,$3)
      ON CONFLICT(document_id) DO UPDATE SET
        chapter_goal=CASE WHEN $4::boolean THEN EXCLUDED.chapter_goal ELSE chapter_production_specs.chapter_goal END,
        updated_at=now()
      RETURNING document_id,project_id,chapter_goal,updated_at
    `, [input.documentId, input.projectId, input.chapterGoal ?? "", input.chapterGoal !== undefined]);
    return result.rows[0];
  }

  async getChapterWorkspace(projectId: string, documentId: string) {
    const document = await this.pool.query(`
      SELECT d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at,
        mr.revision,mr.content_hash,cb.object_key,cb.byte_length,
        cps.chapter_goal,ch.payload AS chapter_payload,ba.fingerprint AS chapter_blueprint_fingerprint,cps.updated_at AS spec_updated_at,
        crs.id AS review_id,crs.revision_id AS reviewed_revision_id,crs.reviewed_content_hash,crs.artifact_fingerprint,
        crs.source_workflow_id,crs.verdict,crs.complete,crs.overall_score,crs.dimension_scores,crs.reviewer_roles,crs.reviewed_at,
        -- 作者对当前内容的最终决定（同 getProjectDetail 标量子查询口径）。
        (SELECT ae.decision FROM approval_evidence ae
          JOIN artifacts ra ON ra.id=ae.artifact_id
          WHERE ae.project_id=d.project_id AND ra.content_hash=mr.content_hash
          ORDER BY ae.created_at DESC, ae.id DESC LIMIT 1) AS author_decision
      FROM manuscript_documents d
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
      LEFT JOIN chapters ch ON ch.document_id=d.id AND ch.project_id=d.project_id
      LEFT JOIN artifacts ba ON ba.id=ch.source_artifact_id
      LEFT JOIN chapter_review_snapshots crs ON crs.document_id=d.id
      WHERE d.project_id=$1 AND d.id=$2
    `, [projectId, documentId]);
    if (!document.rowCount) return undefined;
    const row = document.rows[0];
    const issues = row.review_id ? await this.pool.query(`
      SELECT id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,reader_reconstruction,source_roles,status,updated_at
      FROM chapter_review_snapshot_issues WHERE snapshot_id=$1
      ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 ELSE 2 END,created_at,id
    `, [row.review_id]) : { rows: [] };
    const versions = await this.pool.query(`
      SELECT mr.id,mr.revision,mr.content_hash,mr.retention_class,mr.label,mr.expires_at,mr.created_at,
        mr.id=d.current_revision_id AS is_current
      FROM manuscript_revisions mr JOIN manuscript_documents d ON d.id=mr.document_id
      WHERE mr.project_id=$1 AND mr.document_id=$2
      ORDER BY mr.revision DESC LIMIT 20
    `, [projectId, documentId]);
    return {
      document: {
        id: row.id, projectId: row.project_id, title: row.title, narrativeOrder: Number(row.narrative_order),
        povCharacterId: row.pov_character_id ?? undefined, status: row.status, currentRevisionId: row.current_revision_id ?? undefined,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      },
      content: row.current_revision_id ? { revisionId: row.current_revision_id, revision: Number(row.revision), contentHash: row.content_hash, objectKey: row.object_key, byteLength: Number(row.byte_length ?? 0) } : undefined,
      spec: { chapterGoal: row.chapter_goal ?? "", blueprint: row.chapter_payload ?? {}, blueprintFingerprint: row.chapter_blueprint_fingerprint ?? canonicalSha256(row.chapter_payload ?? {}), updatedAt: row.spec_updated_at ? iso(row.spec_updated_at) : undefined },
      review: row.review_id ? {
        id: row.review_id, revisionId: row.reviewed_revision_id ?? undefined, reviewedContentHash: row.reviewed_content_hash,
        artifactFingerprint: row.artifact_fingerprint, sourceWorkflowId: row.source_workflow_id ?? undefined, verdict: row.verdict,
        complete: row.complete, overallScore: row.overall_score === null ? undefined : Number(row.overall_score),
        reviewerRoles: row.reviewer_roles ?? [], reviewedAt: iso(row.reviewed_at), stale: row.reviewed_content_hash !== row.content_hash,
        /** 作者对当前内容的最终决定（与文档列表 authorDecision 同口径），供工作台区分 reviewer 判定与作者覆盖批准。 */
        authorDecision: row.author_decision ?? undefined,
        issues: issues.rows.map((issue) => ({ id: issue.id, fingerprint: issue.issue_fingerprint, severity: issue.severity, title: issue.title, description: issue.description ?? undefined, evidenceQuote: issue.evidence_quote, paragraph: issue.paragraph ?? undefined, revisionRanges: issue.revision_ranges ?? [], rule: issue.rule ?? undefined, suggestion: issue.suggestion ?? undefined, readerReconstruction: issue.reader_reconstruction ?? null, sourceRoles: issue.source_roles ?? [], status: issue.status, updatedAt: iso(issue.updated_at) })),
      } : undefined,
      versions: versions.rows.map((version) => ({ id: version.id, revision: Number(version.revision), contentHash: version.content_hash, retentionClass: version.retention_class, label: version.label ?? undefined, expiresAt: version.expires_at ? iso(version.expires_at) : undefined, createdAt: iso(version.created_at), current: version.is_current })),
    };
  }

  async updateChapterReviewIssueStatus(input: { projectId: string; documentId: string; issueId: string; status: ChapterReviewIssueStatus }) {
    const result = await this.pool.query(`
      UPDATE chapter_review_snapshot_issues i SET status=$4,updated_at=now()
      FROM chapter_review_snapshots s
      WHERE i.snapshot_id=s.id AND s.project_id=$1 AND s.document_id=$2 AND i.id=$3
      RETURNING i.id,i.status,i.updated_at
    `, [input.projectId, input.documentId, input.issueId, input.status]);
    if (!result.rowCount) throw new Error("审核意见不存在");
    return { id: result.rows[0].id, status: result.rows[0].status, updatedAt: iso(result.rows[0].updated_at) };
  }

  async addChapterReviewIssue(input: {
    projectId: string;
    documentId: string;
    severity: ReviewIssue["severity"];
    title: string;
    description?: string;
    evidenceQuote?: string;
    paragraph?: number;
    /**
     * 多段落修订范围（1-based）。同机制多处时用数组一次覆盖全部位置，
     * 避免 targeted 修订只修首个段落导致同一问题反复残留（AGENTS.md「revisionRanges
     * 必须覆盖每一处承载同一机制且可安全修改的范围」）。
     */
    revisionRanges?: Array<{ start: number; end: number }>;
    suggestion?: string;
  }) {
    const title = input.title.trim();
    const evidenceQuote = input.evidenceQuote?.trim() || title;
    const suggestion = input.suggestion?.trim() || undefined;
    if (!title) throw new Error("审核意见标题不能为空");
    const snapshot = await this.pool.query<{ id: string; reviewed_content_hash: string; current_content_hash: string | null; complete: boolean }>(`
      SELECT s.id,s.reviewed_content_hash,mr.content_hash AS current_content_hash,s.complete
      FROM chapter_review_snapshots s
      JOIN manuscript_documents d ON d.id=s.document_id AND d.project_id=s.project_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      WHERE s.project_id=$1 AND s.document_id=$2
    `, [input.projectId, input.documentId]);
    const current = snapshot.rows[0];
    if (!current?.complete) throw new Error("当前章节没有完整审核快照");
    if (!current.current_content_hash || current.reviewed_content_hash !== current.current_content_hash) throw new Error("审核快照已过期，请先重新审校当前正文");
    const explicitRanges = input.revisionRanges?.length
      ? input.revisionRanges.map((range) => {
          if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) {
            throw new Error("revisionRanges 的 start/end 必须是满足 1<=start<=end 的整数");
          }
          return range;
        }).sort((left, right) => left.start - right.start)
      : [];
    const revisionRanges = explicitRanges.length
      ? explicitRanges
      : input.paragraph ? [{ start: input.paragraph, end: input.paragraph }] : [];
    const issue: ReviewIssue = {
      severity: input.severity,
      title,
      description: input.description?.trim() || undefined,
      evidence: evidenceQuote,
      excerpt: evidenceQuote,
      paragraph: input.paragraph,
      revisionRanges,
      suggestion,
      rule: "author-review-note",
    };
    const id = randomUUID();
    const fingerprint = `author:${reviewIssueFingerprint(issue)}:${id}`;
    const result = await this.pool.query(`
      INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,source_roles,status)
      VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
      RETURNING id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,source_roles,status,updated_at
    `, [id, current.id, fingerprint, input.severity, title, issue.description ?? null, evidenceQuote, input.paragraph ?? null, JSON.stringify(issue.revisionRanges), issue.rule, suggestion ?? null, ["author"]]);
    const row = result.rows[0];
    return { id: row.id, fingerprint: row.issue_fingerprint, dimension: row.dimension ?? undefined, severity: row.severity, title: row.title, description: row.description ?? undefined, evidenceQuote: row.evidence_quote, paragraph: row.paragraph ?? undefined, revisionRanges: row.revision_ranges ?? [], rule: row.rule ?? undefined, suggestion: row.suggestion ?? undefined, sourceRoles: row.source_roles ?? [], status: row.status, updatedAt: iso(row.updated_at) };
  }

  async getTargetedChapterReviewIssues(input: { projectId: string; documentId: string; issueIds: string[]; plainText?: string }): Promise<{ snapshotId: string; reviewedContentHash: string; fingerprints: string[]; issues: ReviewIssue[] }> {
    const issueIds = [...new Set(input.issueIds.map((id) => id.trim()).filter(Boolean))];
    if (!issueIds.length) throw new Error("至少选择一条待处理审核意见");
    if (issueIds.length !== input.issueIds.length) throw new Error("目标审核意见不能重复");
    const snapshot = await this.pool.query<{ id: string; reviewed_content_hash: string; current_content_hash: string | null; complete: boolean }>(`
      SELECT s.id,s.reviewed_content_hash,mr.content_hash AS current_content_hash,s.complete
      FROM chapter_review_snapshots s
      JOIN manuscript_documents d ON d.id=s.document_id AND d.project_id=s.project_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      WHERE s.project_id=$1 AND s.document_id=$2
    `, [input.projectId, input.documentId]);
    const current = snapshot.rows[0];
    if (!current?.complete) throw new Error("当前章节没有完整审核快照");
    if (!current.current_content_hash || current.reviewed_content_hash !== current.current_content_hash) throw new Error("审核快照已过期，请先重新审校当前正文");
    const rows = await this.pool.query<{
      id: string; issue_fingerprint: string; dimension: string | null; severity: ReviewIssue["severity"]; title: string; description: string | null;
      evidence_quote: string; paragraph: number | null; revision_ranges: Array<{ start: number; end: number }> | null;
      rule: string | null; suggestion: string | null; reader_reconstruction: ReviewIssue["readerReconstruction"]; status: ChapterReviewIssueStatus;
    }>(`
      SELECT id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,reader_reconstruction,status
      FROM chapter_review_snapshot_issues
      WHERE snapshot_id=$1 AND id=ANY($2::text[])
      ORDER BY id
    `, [current.id, issueIds]);
    if (rows.rowCount !== issueIds.length) throw new Error("部分审核意见不属于当前章节快照");
    if (rows.rows.some((row) => row.status !== "pending")) throw new Error("只能修复状态为待处理的审核意见");
    const issues = rows.rows.map((row): ReviewIssue => {
      const issue: ReviewIssue = {
        severity: row.severity,
        title: row.title,
        description: row.description ?? undefined,
        evidence: row.evidence_quote,
        excerpt: row.evidence_quote,
        paragraph: row.paragraph ?? undefined,
        revisionRanges: row.revision_ranges ?? [],
        rule: row.rule ?? undefined,
        suggestion: row.suggestion ?? undefined,
        readerReconstruction: row.reader_reconstruction ?? null,
      };
      // Evidence 闭环校验·消费时（2026-09-08）：证据已不在当前正文 → 陈旧意见。
      // 实证：ch2 期限条目（采纳将复现已修复的时序矛盾）与 ch6×5（引用已删除文本）。
      // 只附标记不改状态——是否忽略由编辑者决定，但标记会随窗口进入修订与审批链路。
      if (input.plainText && isEvidencePresentInText(row.evidence_quote, input.plainText) === false) {
        issue.description = [issue.description, "[evidence-stale] 证据引文已不在当前正文中：意见可能已过时，采纳前请核对是否仍成立（或应忽略）。"].filter(Boolean).join(" ");
      }
      return issue;
    });
    if (issues.some((issue) => !issue.revisionRanges?.length && !issue.paragraph && !issue.excerpt?.trim())) throw new Error("所选审核意见缺少可定位的正文证据");
    return { snapshotId: current.id, reviewedContentHash: current.reviewed_content_hash, fingerprints: rows.rows.map((row) => row.issue_fingerprint), issues };
  }

  async saveManualRevision(input: { projectId: string; documentId: string; expectedContentHash: string; text: string; contentHash: string; objectKey: string; label?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ current_revision: string; current_revision_id: string | null; content_hash: string | null }>(`
        SELECT p.current_revision,d.current_revision_id,mr.content_hash
        FROM novel_projects p JOIN manuscript_documents d ON d.project_id=p.id
        LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
        WHERE p.id=$1 AND d.id=$2 FOR UPDATE OF p,d
      `, [input.projectId, input.documentId]);
      if (!current.rowCount) throw new Error("章节不存在");
      if ((current.rows[0].content_hash ?? "") !== input.expectedContentHash) throw new Error("正文已被其他操作更新，请刷新后重新编辑");
      if (input.contentHash === input.expectedContentHash) {
        await client.query("COMMIT");
        return { unchanged: true, revisionId: current.rows[0].current_revision_id, revision: Number(current.rows[0].current_revision), contentHash: input.contentHash };
      }
      const revision = Number(current.rows[0].current_revision) + 1;
      const revisionId = randomUUID();
      if (current.rows[0].current_revision_id) await client.query("UPDATE manuscript_revisions SET retention_class='rolling',expires_at=COALESCE(expires_at,now()+interval '30 days') WHERE id=$1 AND retention_class<>'named'", [current.rows[0].current_revision_id]);
      await client.query("INSERT INTO content_blobs(content_hash,object_key,byte_length,word_count,dialogue_characters) VALUES($1,$2,$3,$4,$5) ON CONFLICT(content_hash) DO UPDATE SET word_count=COALESCE(content_blobs.word_count,EXCLUDED.word_count), dialogue_characters=COALESCE(content_blobs.dialogue_characters,EXCLUDED.dialogue_characters)", [input.contentHash, input.objectKey, Buffer.byteLength(input.text, "utf8"), countNovelCharacters(input.text), countDialogueCharacters(input.text)]);
      await client.query(`
        INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,retention_class,label,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='named' THEN NULL ELSE now()+interval '30 days' END)
      `, [revisionId, input.projectId, input.documentId, revision, Number(current.rows[0].current_revision), input.contentHash, input.label ? "named" : "rolling", input.label ?? null]);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2", [revisionId, input.documentId]);
      await this.syncFinalChapterBlueprintStatusTx(client, input.projectId, input.documentId);
      await client.query("UPDATE novel_projects SET current_revision=$1,updated_at=now() WHERE id=$2", [revision, input.projectId]);
      await this.appendOutboxTx(client, "manuscript-revision", revisionId, "manuscript-revision.saved", { projectId: input.projectId, documentId: input.documentId, revision, contentHash: input.contentHash, source: "web-author" });
      await client.query("COMMIT");
      return { unchanged: false, revisionId, revision, contentHash: input.contentHash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async nameManuscriptVersion(input: { projectId: string; documentId: string; revisionId: string; label: string }) {
    const result = await this.pool.query(`UPDATE manuscript_revisions SET retention_class='named',label=$4,expires_at=NULL
      WHERE id=$3 AND project_id=$1 AND document_id=$2 RETURNING id,revision,content_hash,label,created_at`, [input.projectId, input.documentId, input.revisionId, input.label]);
    if (!result.rowCount) throw new Error("正文版本不存在");
    return { id: result.rows[0].id, revision: Number(result.rows[0].revision), contentHash: result.rows[0].content_hash, label: result.rows[0].label, createdAt: iso(result.rows[0].created_at) };
  }

  async restoreManuscriptVersion(input: { projectId: string; documentId: string; revisionId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query<{ content_hash: string }>("SELECT content_hash FROM manuscript_revisions WHERE id=$3 AND project_id=$1 AND document_id=$2", [input.projectId, input.documentId, input.revisionId]);
      if (!source.rowCount) throw new Error("正文版本不存在");
      const head = await client.query<{ current_revision: string; current_revision_id: string | null }>("SELECT p.current_revision,d.current_revision_id FROM novel_projects p JOIN manuscript_documents d ON d.project_id=p.id WHERE p.id=$1 AND d.id=$2 FOR UPDATE OF p,d", [input.projectId, input.documentId]);
      if (!head.rowCount) throw new Error("章节不存在");
      if (head.rows[0].current_revision_id) await client.query("UPDATE manuscript_revisions SET retention_class='rolling',expires_at=COALESCE(expires_at,now()+interval '30 days') WHERE id=$1 AND retention_class<>'named'", [head.rows[0].current_revision_id]);
      const revision = Number(head.rows[0].current_revision) + 1;
      const revisionId = randomUUID();
      await client.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,retention_class,expires_at) VALUES($1,$2,$3,$4,$5,$6,'rolling',now()+interval '30 days')", [revisionId, input.projectId, input.documentId, revision, Number(head.rows[0].current_revision), source.rows[0].content_hash]);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2", [revisionId, input.documentId]);
      await this.syncFinalChapterBlueprintStatusTx(client, input.projectId, input.documentId);
      await client.query("UPDATE novel_projects SET current_revision=$1,updated_at=now() WHERE id=$2", [revision, input.projectId]);
      await this.appendOutboxTx(client, "manuscript-revision", revisionId, "manuscript-revision.restored", { projectId: input.projectId, documentId: input.documentId, revision, sourceRevisionId: input.revisionId });
      await client.query("COMMIT");
      return { revisionId, revision, contentHash: source.rows[0].content_hash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async cleanupExpiredChapterData(cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) {
    const eligible = await this.pool.query<WorkflowRunRow>(`
      SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at
      FROM workflow_runs
      WHERE status IN (${SUCCEEDED_WORKFLOW_RUN_STATUSES_SQL}) AND updated_at<$1
        AND (workflow_type='chapter-review' OR payload#>>'{intent,target,kind}'='chapter' OR payload->>'documentId' IS NOT NULL)
        AND NOT (payload ? 'diagnosticsCleanedAt')
      ORDER BY updated_at LIMIT 100
    `, [cutoff]);
    let artifactsDeleted = 0;
    let runsCompacted = 0;
    for (const run of eligible.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<WorkflowRunRow>("SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE id=$1 FOR UPDATE", [run.id]);
        if (!locked.rowCount || locked.rows[0].payload?.diagnosticsCleanedAt) { await client.query("COMMIT"); continue; }
        const current = locked.rows[0];
        const documentId = typeof current.payload.documentId === "string"
          ? current.payload.documentId
          : typeof (current.payload.intent as { target?: { id?: unknown } } | undefined)?.target?.id === "string"
            ? (current.payload.intent as { target: { id: string } }).target.id
            : null;
        const artifactRows = await client.query<{ id: string }>("SELECT id FROM artifacts WHERE project_id=$1 AND (payload->>'workflowId'=$2 OR payload->>'runId'=$2)", [current.project_id, current.temporal_workflow_id]);
        const artifactIds = artifactRows.rows.map((row) => row.id);
        if (artifactIds.length) {
          await client.query("UPDATE manuscript_revisions SET artifact_id=NULL WHERE artifact_id=ANY($1::text[])", [artifactIds]);
          await client.query("DELETE FROM artifacts WHERE id=ANY($1::text[])", [artifactIds]);
        }
        await this.modelTasks.removeRunTasks(client, { id: current.id, temporalWorkflowId: current.temporal_workflow_id });
        await client.query("DELETE FROM outbox_events WHERE (aggregate_type='workflow-run' AND aggregate_id=$1) OR payload->>'workflowId'=$1 OR payload->>'runId'=$1", [current.temporal_workflow_id]);
        const compactPayload = {
          documentId, finalScore: typeof current.payload.finalScore === "number" ? current.payload.finalScore : undefined,
          reasonCode: typeof current.payload.reasonCode === "string" ? current.payload.reasonCode : undefined,
          diagnosticsCleanedAt: new Date().toISOString(),
        };
        await client.query("UPDATE workflow_runs SET payload=$2 WHERE id=$1", [current.id, compactPayload]);
        await client.query("COMMIT");
        artifactsDeleted += artifactIds.length;
        runsCompacted += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await this.pool.query(`
      WITH ranked AS (
        SELECT mr.id,mr.document_id,mr.expires_at,mr.id=d.current_revision_id AS is_current,
          ROW_NUMBER() OVER(PARTITION BY mr.document_id ORDER BY mr.revision DESC) AS position
        FROM manuscript_revisions mr JOIN manuscript_documents d ON d.id=mr.document_id
        WHERE mr.retention_class='rolling'
      )
      DELETE FROM manuscript_revisions mr USING ranked r
      WHERE mr.id=r.id AND NOT r.is_current AND (r.expires_at<now() OR r.position>10)
    `);
    const orphaned = await this.pool.query<{ content_hash: string; object_key: string }>(`
      DELETE FROM content_blobs cb
      WHERE NOT EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.content_hash=cb.content_hash)
        AND NOT EXISTS (SELECT 1 FROM manuscript_blocks mb WHERE mb.content_hash=cb.content_hash)
        AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash=cb.content_hash)
      RETURNING content_hash,object_key
    `);
    return { runsCompacted, artifactsDeleted, orphanedObjects: orphaned.rows.map((row) => ({ contentHash: row.content_hash, objectKey: row.object_key })) };
  }

  async refreshChapterReviewSnapshot(artifactId: string, revisionId?: string, plainText?: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const refreshed = await this.refreshChapterReviewSnapshotTx(client, artifactId, revisionId, plainText);
      await client.query("COMMIT");
      return refreshed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshChapterReviewSnapshotTx(client: PoolClient, artifactId: string, revisionId?: string, plainText?: string): Promise<boolean> {
    const subject = await client.query<{
      project_id: string; content_hash: string; fingerprint: string; workflow_id: string | null; document_id: string | null;
      change_scope: string | null;
    }>(`
      SELECT a.project_id,a.content_hash,a.fingerprint,
        COALESCE(a.payload->>'workflowId',a.payload->>'runId') AS workflow_id,
        COALESCE(w.payload->>'documentId',w.payload#>>'{intent,target,id}',mr.document_id) AS document_id,
        COALESCE(eb_direct.payload->>'changeScope',eb_intent.payload->>'changeScope') AS change_scope
      FROM artifacts a
      LEFT JOIN workflow_runs w ON w.temporal_workflow_id=COALESCE(a.payload->>'workflowId',a.payload->>'runId')
      LEFT JOIN execution_blueprints eb_direct ON eb_direct.id=w.payload->>'blueprintId'
      LEFT JOIN execution_blueprints eb_intent ON eb_intent.intent_id=w.payload#>>'{intent,id}'
      LEFT JOIN manuscript_revisions mr ON mr.artifact_id=a.id
      WHERE a.id=$1
    `, [artifactId]);
    const target = subject.rows[0];
    if (!target?.document_id) return false;
    let resolvedRevisionId = revisionId ?? null;
    if (!revisionId) {
      // 未显式给修订时，从文档的当前修订同时取"可比对的内容哈希"与"快照该挂的修订归属"。
      // 此前这里只验哈希却不回填 revision_id，于是启动投影出的快照 revision_id 恒为 null，
      // 而实时评审路径（调用方传 revisionId）落的是真值——同名字段两种形态，回填账答不出
      // "这份快照对应哪一修订"，对账与追溯都要靠 content_hash 反查。
      const current = await client.query<{ content_hash: string | null; current_revision_id: string | null }>(`
        SELECT mr.content_hash, d.current_revision_id FROM manuscript_documents d
        LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
        WHERE d.id=$1 AND d.project_id=$2
      `, [target.document_id, target.project_id]);
      if (!current.rows[0]?.content_hash || current.rows[0].content_hash !== target.content_hash) return false;
      resolvedRevisionId = current.rows[0].current_revision_id ?? null;
    }

    const rows = await client.query<{
      id: string; project_id: string; artifact_id: string; reviewer_id: string; identity: Review["identity"];
      verdict: Review["verdict"]; issues: Review["issues"]; score: number | null; role: string | null;
      dimension_scores: unknown; artifact_fingerprint: string; created_at: Date | string;
    }>(`
      SELECT id,project_id,artifact_id,reviewer_id,identity,verdict,issues,score,role,dimension_scores,artifact_fingerprint,created_at
      FROM reviews WHERE artifact_id=$1 ORDER BY created_at,id
    `, [artifactId]);
    const reviews: Review[] = rows.rows.map((row) => ({
      id: row.id, projectId: row.project_id, artifactId: row.artifact_id, reviewerId: row.reviewer_id,
      identity: row.identity, verdict: row.verdict, issues: row.issues ?? [], score: row.score === null ? undefined : Number(row.score),
      role: row.role ?? undefined, artifactFingerprint: row.artifact_fingerprint,
      createdAt: new Date(row.created_at).getTime(),
    }));
    const existing = await client.query<{ id: string }>("SELECT id FROM chapter_review_snapshots WHERE document_id=$1 FOR UPDATE", [target.document_id]);
    const snapshotId = existing.rows[0]?.id ?? randomUUID();
    const prior = existing.rowCount
      ? await client.query<{ issue_fingerprint: string; status: ChapterReviewIssueStatus }>("SELECT issue_fingerprint,status FROM chapter_review_snapshot_issues WHERE snapshot_id=$1", [snapshotId])
      : { rows: [] };
    // E4：完整性判定必须与实际评审执行面同源——蓝图存了窄档就按窄档数期望角色，
    // 否则机械/局部档章节（两审即完整）永远 complete=false，快照静默滞留旧修订。
    const changeScope = target.change_scope === "mechanical-format" || target.change_scope === "local-text" ? target.change_scope : undefined;
    const snapshot = aggregateChapterReviews(reviews, new Map(prior.rows.map((row) => [row.issue_fingerprint, row.status])), changeScope);
    if (!snapshot.complete) return false;
    const reviewedAt = new Date(Math.max(...reviews.map((review) => review.createdAt)));
    await client.query(`
      INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,source_workflow_id,verdict,complete,overall_score,dimension_scores,reviewer_roles,reviewed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10,$11,$12)
      ON CONFLICT(document_id) DO UPDATE SET
        revision_id=EXCLUDED.revision_id,reviewed_content_hash=EXCLUDED.reviewed_content_hash,
        artifact_fingerprint=EXCLUDED.artifact_fingerprint,source_workflow_id=EXCLUDED.source_workflow_id,verdict=EXCLUDED.verdict,
        complete=TRUE,overall_score=EXCLUDED.overall_score,dimension_scores=EXCLUDED.dimension_scores,reviewer_roles=EXCLUDED.reviewer_roles,
        reviewed_at=EXCLUDED.reviewed_at,updated_at=now()
    `, [snapshotId, target.document_id, target.project_id, resolvedRevisionId, target.content_hash, target.fingerprint, target.workflow_id, snapshot.verdict, snapshot.overallScore ?? null, JSON.stringify({}), snapshot.reviewerRoles, reviewedAt]);
    await client.query("DELETE FROM chapter_review_snapshot_issues WHERE snapshot_id=$1", [snapshotId]);
    for (const issue of snapshot.issues) {
      // P0-C4: evidence 正文包含性软校验——审校 issue 的 evidence 在正文零命中时
      // 附 evidence-unverified 标记（作者 issue 不做校验），供人工决策识别回显误报。
      const marked = plainText ? markEvidenceUnverified(issue, plainText) : issue;
      await client.query(`
        INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,dimension,severity,title,description,evidence_quote,paragraph,revision_ranges,rule,suggestion,reader_reconstruction,source_roles,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [marked.id, snapshotId, marked.fingerprint, marked.dimension ?? null, marked.severity, marked.title, marked.description ?? null, marked.evidenceQuote, marked.paragraph ?? null, JSON.stringify(marked.revisionRanges), marked.rule ?? null, marked.suggestion ?? null, marked.readerReconstruction ?? null, marked.sourceRoles, marked.status]);
    }
    return true;
  }

  /** 章节短剧剧本：项目级共享 subject_definitions 预设（用户手动编辑，生成前预设）。 */
  async getChapterScriptSubjectPreset(projectId: string): Promise<string> {
    const result = await this.pool.query<{ definition_text: string }>(
      "SELECT definition_text FROM chapter_script_subject_presets WHERE project_id=$1",
      [projectId],
    );
    return result.rows[0]?.definition_text ?? "";
  }

  async putChapterScriptSubjectPreset(projectId: string, definitionText: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO chapter_script_subject_presets(project_id, definition_text, updated_at) VALUES($1,$2,now())
       ON CONFLICT (project_id) DO UPDATE SET definition_text=EXCLUDED.definition_text, updated_at=now()`,
      [projectId, definitionText],
    );
  }

  async listSkills(_projectId: string): Promise<SkillDescriptor[]> {
    type SkillRow = { skill_id: string; version: string; capabilities: string[] | null; applicable_tasks: PreflightPlan["taskClass"][] | null; required_memory_kinds: SkillDescriptor["requiredMemoryKinds"] | null; conflicts: string[] | null; quality_gates: string[] | null; prompt_sections: SkillDescriptor["promptSections"] | null; applicable_genres: string[] | null; enabled: boolean; execution_points: string[] | null; roles: string[] | null; depends_on: string[] | null; priority: SkillDescriptor["priority"] | null; content_fingerprint: string | null; source_ref: string | null };
    const result = await this.pool.query<SkillRow>("SELECT * FROM skill_definitions WHERE enabled = TRUE ORDER BY skill_id");
    return result.rows.map((row: SkillRow) => ({ skillId: row.skill_id, version: row.version, capabilities: row.capabilities ?? [], applicableTasks: row.applicable_tasks ?? [], requiredMemoryKinds: row.required_memory_kinds ?? [], conflicts: row.conflicts ?? [], qualityGates: row.quality_gates ?? [], promptSections: row.prompt_sections ?? {}, applicableGenres: row.applicable_genres ?? [], enabled: row.enabled, executionPoints: row.execution_points as SkillDescriptor["executionPoints"], roles: row.roles ?? [], dependsOn: row.depends_on ?? [], priority: row.priority ?? undefined, contentFingerprint: row.content_fingerprint || undefined, sourceRef: row.source_ref ?? "database:skill_definitions" }));
  }

  async listKnowledgeRecords(projectId: string, kind: KnowledgeRecordKind): Promise<Array<Record<string, unknown>>> {
    if (kind === "foundation") {
      const sections = await this.listProjectPlanSections(projectId);
      return sections.map((section) => {
        const stage = PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === section.taskKey);
        const title = typeof section.payload.title === "string" && section.payload.title.trim()
          ? section.payload.title.trim()
          : stage?.label ?? section.taskKey;
        return {
          id: `plan:${section.taskKey}`,
          taskKey: section.taskKey,
          name: title,
          title,
          summary: typeof section.payload.summary === "string" ? section.payload.summary : "",
          payload: section.payload,
          status: section.status,
          editRevision: section.editRevision,
          sourceArtifactId: section.sourceArtifactId,
          approvedAt: section.approvedAt,
          updatedAt: section.updatedAt,
          source: "project-plan",
          readOnly: true,
        };
      });
    }
    if (kind === "claims") {
      const result = await this.pool.query(`
        SELECT claim.id,claim.kind,claim.title,claim.content,claim.subject_refs,
               claim.narrative_start,claim.narrative_end,claim.knowledge_scope,
               claim.authority,claim.confidence,claim.source_revision_ids,claim.predicate,
               claim.source_artifact_id,claim.supersedes,claim.decided_by,claim.decided_at,
               claim.created_at,source.kind AS source_kind
        FROM memory_claims claim
        LEFT JOIN artifacts source ON source.id=claim.source_artifact_id
        WHERE claim.project_id=$1
          AND ${retrievalVisibleClaimsSql("claim")}
          AND claim.predicate IS NOT NULL
          AND (source.kind='fact-extraction' OR (claim.source_artifact_id IS NULL AND claim.authority='author'))
        ORDER BY claim.narrative_start NULLS LAST,claim.created_at DESC,claim.id
      `, [projectId]);
      return result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        name: row.title,
        content: row.content,
        subjectRefs: row.subject_refs ?? [],
        narrativeStart: row.narrative_start === null ? undefined : Number(row.narrative_start),
        narrativeEnd: row.narrative_end === null ? undefined : Number(row.narrative_end),
        knowledgeScope: row.knowledge_scope,
        authority: row.authority,
        confidence: Number(row.confidence),
        sourceRevisionIds: row.source_revision_ids ?? [],
        predicate: row.predicate ?? undefined,
        sourceArtifactId: row.source_artifact_id ?? undefined,
        supersedes: row.supersedes ?? [],
        decidedBy: row.decided_by ?? undefined,
        decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
        createdAt: iso(row.created_at),
        source: row.source_kind === "fact-extraction" ? "fact-extraction" : "manual-claim",
        readOnly: false,
      }));
    }
    if (kind === "chapter-memories") {
      const memories = await this.getChapterMemories({ projectId, limit: 500 });
      return memories.map((memory) => ({
        ...memory,
        name: `第 ${memory.narrativeRange.start} 章记忆`,
        narrativeStart: memory.narrativeRange.start,
        narrativeEnd: memory.narrativeRange.end,
        source: "chapter-memory",
        readOnly: true,
      }));
    }
    if (kind === "project-skills") {
      const result = await this.pool.query<{ id: string; payload: SkillBundle; created_at: Date | string }>(
        "SELECT id,payload,created_at FROM skill_bundles WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [projectId],
      );
      const bundle = result.rows[0];
      if (!bundle) return [];
      return (Array.isArray(bundle.payload.skills) ? bundle.payload.skills : []).map((skill) => ({
        id: skill.skillId,
        skillId: skill.skillId,
        version: skill.version,
        capabilities: skill.capabilities ?? [],
        applicableTasks: skill.applicableTasks ?? [],
        requiredMemoryKinds: skill.requiredMemoryKinds ?? [],
        conflicts: skill.conflicts ?? [],
        qualityGates: skill.qualityGates ?? [],
        promptSections: skill.promptSections ?? {},
        applicableGenres: skill.applicableGenres ?? [],
        enabled: skill.enabled !== false,
        bundleId: bundle.id,
        bundleCreatedAt: iso(bundle.created_at),
        bundleMissingCapabilities: bundle.payload.missingCapabilities ?? [],
        source: "skill-bundle",
        readOnly: true,
      }));
    }
    if (kind === "skills") {
      const result = await this.pool.query("SELECT skill_id AS id, version, capabilities, applicable_tasks, required_memory_kinds, conflicts, quality_gates, prompt_sections, applicable_genres, execution_points, roles, depends_on, priority, content_fingerprint, source_ref, enabled, updated_at FROM skill_definitions ORDER BY skill_id");
      return result.rows.map((row) => ({
        id: row.id,
        skillId: row.id,
        version: row.version,
        capabilities: row.capabilities ?? [],
        applicableTasks: row.applicable_tasks ?? [],
        requiredMemoryKinds: row.required_memory_kinds ?? [],
        conflicts: row.conflicts ?? [],
        qualityGates: row.quality_gates ?? [],
        promptSections: row.prompt_sections ?? {},
        applicableGenres: row.applicable_genres ?? [],
        executionPoints: row.execution_points ?? [],
        roles: row.roles ?? [],
        dependsOn: row.depends_on ?? [],
        priority: row.priority ?? undefined,
        contentFingerprint: row.content_fingerprint || undefined,
        sourceRef: row.source_ref ?? "database:skill_definitions",
        enabled: row.enabled,
        updatedAt: row.updated_at,
        source: "skill-definition",
        readOnly: false,
      }));
    }
    if (kind === "planning" || kind === "worldview" || kind === "characters") {
      const entityKind = kind === "characters" ? "character" : kind;
      // 已归并退役的实体（payload.mergedInto）对知识工作台不可见，声部数据由规范行承载。
      const result = await this.pool.query<{ id: string; kind: string; name: string; payload: Record<string, unknown> | null }>("SELECT id, kind, name, payload FROM entities WHERE project_id=$1 AND kind=$2 AND (payload->>'mergedInto') IS NULL ORDER BY name,id", [projectId, entityKind]);
      if (kind !== "characters") return result.rows;
      const foundation = await this.pool.query<{ characters: unknown }>("SELECT payload->'structuredData'->'characters' AS characters FROM project_plan_sections WHERE project_id=$1 AND task_key='characters'", [projectId]);
      const foundationCharacters = Array.isArray(foundation.rows[0]?.characters)
        ? foundation.rows[0].characters.filter((item): item is FoundationCharacter => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
      const index = buildCharacterIdentityIndex(projectId, result.rows, foundationCharacters);
      const foundationById = new Map(foundationCharacters.flatMap((item) => typeof item.id === "string" && item.id.trim() ? [[item.id.trim(), item] as const] : []));
      return result.rows.map((row) => {
        const identity = resolveCharacterIdentity(projectId, row.id, index);
        return {
          ...row,
          name: identity.displayName,
          displayName: identity.displayName,
          canonicalId: identity.canonicalId,
          displayNameStatus: identity.status,
          sourceCharacterId: identity.sourceId,
          foundation: foundationById.get(identity.canonicalId),
        };
      });
    }
    if (kind === "relations") {
      const result = await this.pool.query("SELECT id, subject_id, predicate, object_id, valid_from, valid_to, source_revision_id FROM relations WHERE project_id=$1 ORDER BY id", [projectId]);
      return result.rows.map((row) => ({ id: row.id, subjectId: row.subject_id, predicate: row.predicate, objectId: row.object_id, validFrom: row.valid_from, validTo: row.valid_to, sourceRevisionId: row.source_revision_id }));
    }
    if (kind === "timeline") {
      const result = await this.pool.query("SELECT id, narrative_time, event_type, content, source_revision_id FROM timeline_events WHERE project_id=$1 ORDER BY narrative_time,id", [projectId]);
      return result.rows.map((row) => ({ id: row.id, narrativeTime: Number(row.narrative_time), eventType: row.event_type, content: row.content ?? {}, sourceRevisionId: row.source_revision_id }));
    }
    throw new Error(`不支持的资料类型：${kind}（遗留 facts 表已收口，事实断言请使用 claims）`);
  }

  async upsertNarrativeClaim(projectId: string, input: Record<string, unknown>) {
    const replacedId = typeof input.id === "string" && input.id.trim() ? input.id.trim() : undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let previous: MemoryClaim | undefined;
      if (replacedId) {
        const existing = await client.query<any>(`
          SELECT claim.*,source.kind AS source_kind
          FROM memory_claims claim
          LEFT JOIN artifacts source ON source.id=claim.source_artifact_id
          WHERE claim.id=$1 AND claim.project_id=$2
            AND claim.lifecycle_status='active'
            AND claim.authority IN ('approved','author','derived')
            AND claim.predicate IS NOT NULL
            AND (source.kind='fact-extraction' OR (claim.source_artifact_id IS NULL AND claim.authority='author'))
          FOR UPDATE OF claim
        `, [replacedId, projectId]);
        if (!existing.rowCount) throw new Error(`叙事事实不存在或不可编辑：${replacedId}`);
        previous = memoryClaimFromRow(existing.rows[0]);
      }

      const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
      const rawSubjects = input.subjectRefs ?? (previous?.subjectRefs ?? []);
      const subjectRefs = [...new Set((Array.isArray(rawSubjects) ? rawSubjects : []).map(text).filter(Boolean))];
      const predicate = text(input.predicate ?? previous?.predicate);
      const content = text(input.content ?? previous?.content);
      const title = text(input.title ?? input.name ?? previous?.title) || content.slice(0, 32);
      if (!subjectRefs.length) throw new Error("叙事事实至少需要一个明确主体");
      if (!predicate) throw new Error("叙事事实需要 predicate");
      if (!content) throw new Error("叙事事实需要 content");

      const numberOrUndefined = (value: unknown, fallback?: number) => {
        if (value === undefined || value === null || value === "") return fallback;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error("叙事位置必须是大于等于 1 的整数");
        return parsed;
      };
      const narrativeStart = numberOrUndefined(input.narrativeStart, previous?.narrativeRange?.start);
      const narrativeEnd = numberOrUndefined(input.narrativeEnd, previous?.narrativeRange?.end);
      if (narrativeStart !== undefined && narrativeEnd !== undefined && narrativeEnd < narrativeStart) {
        throw new Error("叙事结束位置不能早于开始位置");
      }

      const normalizedPredicate = canonicalizeFactPredicate(predicate);
      const identityHash = canonicalSha256({ subjectRefs: [...subjectRefs].sort(), predicate: normalizedPredicate, knowledgeScope: "author" });
      const valueHash = canonicalSha256({
        identityHash,
        title: normalizeFactToken(title),
        content: normalizeFactToken(content),
        narrativeRange: { start: narrativeStart ?? null, end: narrativeEnd ?? null },
      });
      if (previous && previous.valueHash === valueHash) {
        await client.query("COMMIT");
        return { id: previous.id, kind: "claims" as const, record: narrativeClaimRecord(previous, previous.sourceArtifactId ? "fact-extraction" : "manual-claim"), claim: previous };
      }
      const duplicate = await client.query<{ id: string }>(
        "SELECT id FROM memory_claims WHERE project_id=$1 AND content_hash=$2 AND knowledge_scope='\"author\"'::jsonb AND authority <> 'rejected' LIMIT 1",
        [projectId, valueHash],
      );
      if (duplicate.rowCount) throw new Error(`相同叙事事实已存在：${duplicate.rows[0].id}`);

      const id = `claim:author:${projectId}:${valueHash.slice(0, 16)}:${randomUUID().slice(0, 8)}`;
      const kindValue = input.kind === "hierarchical" || previous?.kind === "hierarchical" ? "hierarchical" : "episodic";
      const supersedes = previous ? [...new Set([previous.id, ...previous.supersedes])] : [];
      const inserted = await client.query<any>(`
        INSERT INTO memory_claims(
          id,project_id,kind,title,content,subject_refs,narrative_start,narrative_end,
          knowledge_scope,authority,confidence,source_revision_ids,content_hash,supersedes,
          predicate,lifecycle_status,identity_hash,value_hash,decided_by,decided_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'"author"'::jsonb,'author',1,'{}',$9,$10,$11,'active',$12,$9,'author',now())
        RETURNING *
      `, [id, projectId, kindValue, title, content, subjectRefs, narrativeStart ?? null, narrativeEnd ?? null, valueHash, supersedes, predicate, identityHash]);
      const claim = memoryClaimFromRow(inserted.rows[0]);
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'author','knowledge.upsert','claims',$2,$3)",
        [projectId, id, { replacedId, before: previous ? narrativeClaimRecord(previous, previous.sourceArtifactId ? "fact-extraction" : "manual-claim") : null, after: narrativeClaimRecord(claim, "manual-claim") }],
      );
      await this.appendOutboxTx(client, "memory-claim", id, "memory-claim.author-upserted", { projectId, claimId: id, replacedId });
      await client.query("COMMIT");
      return { id, kind: "claims" as const, replacedId, record: narrativeClaimRecord(claim, "manual-claim"), claim };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteNarrativeClaim(projectId: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<any>(`
        SELECT claim.*,source.kind AS source_kind
        FROM memory_claims claim
        LEFT JOIN artifacts source ON source.id=claim.source_artifact_id
        WHERE claim.id=$1 AND claim.project_id=$2
          AND claim.lifecycle_status='active'
          AND claim.authority IN ('approved','author','derived')
          AND claim.predicate IS NOT NULL
          AND (source.kind='fact-extraction' OR (claim.source_artifact_id IS NULL AND claim.authority='author'))
        FOR UPDATE OF claim
      `, [id, projectId]);
      if (!existing.rowCount) {
        await client.query("COMMIT");
        return { deleted: false, id, kind: "claims" as const };
      }
      const claim = memoryClaimFromRow(existing.rows[0]);
      const deletedClaimIds = [...new Set([id, ...claim.supersedes])];
      await client.query("UPDATE memory_claims SET authority='rejected',decided_by='author',decided_at=now() WHERE project_id=$1 AND id=ANY($2::text[])", [projectId, deletedClaimIds]);
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'author','knowledge.delete','claims',$2,$3)",
        [projectId, id, { deletedClaimIds, before: narrativeClaimRecord(claim, existing.rows[0].source_kind === "fact-extraction" ? "fact-extraction" : "manual-claim") }],
      );
      await this.appendOutboxTx(client, "memory-claim", id, "memory-claim.author-rejected", { projectId, claimId: id, deletedClaimIds });
      await client.query("COMMIT");
      return { deleted: true, id, kind: "claims" as const, deletedClaimIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertKnowledgeRecord(projectId: string, kind: "claims", input: Record<string, unknown>): ReturnType<NovelPostgresRepository["upsertNarrativeClaim"]>;
  async upsertKnowledgeRecord(projectId: string, kind: MutableKnowledgeRecordKind, input: Record<string, unknown>): Promise<
    Awaited<ReturnType<NovelPostgresRepository["upsertNarrativeClaim"]>> | { id: string; kind: Exclude<MutableKnowledgeRecordKind, "claims">; record: Record<string, unknown> | null }
  >;
  async upsertKnowledgeRecord(projectId: string, kind: MutableKnowledgeRecordKind, input: Record<string, unknown>) {
    if (kind === "claims") return this.upsertNarrativeClaim(projectId, input);
    const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : randomUUID();
    if (kind === "skills") {
      const version = typeof input.version === "string" && input.version.trim() ? input.version.trim() : "1.0.0";
      const promptSections = input.promptSections ?? input.prompt_sections ?? {};
      // 值相同 ⇒ rowCount 0 ⇒ 不翻 updated_at、不写审计/outbox（seedWorkspaceSkills 与
      // skills sync 每次 migrate/同步都全量重放，无此短路会把 audit_records/outbox 灌满
      // 无效 churn，并放大依赖 audit 历史的重放面扫描——幂等必须对副作用成立）。
      const wrote = await this.pool.query(`INSERT INTO skill_definitions(skill_id,version,capabilities,applicable_tasks,required_memory_kinds,conflicts,quality_gates,prompt_sections,applicable_genres,execution_points,roles,depends_on,priority,content_fingerprint,source_ref,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT(skill_id) DO UPDATE SET version=EXCLUDED.version,capabilities=EXCLUDED.capabilities,applicable_tasks=EXCLUDED.applicable_tasks,required_memory_kinds=EXCLUDED.required_memory_kinds,conflicts=EXCLUDED.conflicts,quality_gates=EXCLUDED.quality_gates,prompt_sections=EXCLUDED.prompt_sections,applicable_genres=EXCLUDED.applicable_genres,execution_points=EXCLUDED.execution_points,roles=EXCLUDED.roles,depends_on=EXCLUDED.depends_on,priority=EXCLUDED.priority,content_fingerprint=EXCLUDED.content_fingerprint,source_ref=EXCLUDED.source_ref,enabled=EXCLUDED.enabled,updated_at=now()
        WHERE skill_definitions.version IS DISTINCT FROM EXCLUDED.version
           OR skill_definitions.capabilities IS DISTINCT FROM EXCLUDED.capabilities
           OR skill_definitions.applicable_tasks IS DISTINCT FROM EXCLUDED.applicable_tasks
           OR skill_definitions.required_memory_kinds IS DISTINCT FROM EXCLUDED.required_memory_kinds
           OR skill_definitions.conflicts IS DISTINCT FROM EXCLUDED.conflicts
           OR skill_definitions.quality_gates IS DISTINCT FROM EXCLUDED.quality_gates
           OR skill_definitions.prompt_sections IS DISTINCT FROM EXCLUDED.prompt_sections
           OR skill_definitions.applicable_genres IS DISTINCT FROM EXCLUDED.applicable_genres
           OR skill_definitions.execution_points IS DISTINCT FROM EXCLUDED.execution_points
           OR skill_definitions.roles IS DISTINCT FROM EXCLUDED.roles
           OR skill_definitions.depends_on IS DISTINCT FROM EXCLUDED.depends_on
           OR skill_definitions.priority IS DISTINCT FROM EXCLUDED.priority
           OR skill_definitions.content_fingerprint IS DISTINCT FROM EXCLUDED.content_fingerprint
           OR skill_definitions.source_ref IS DISTINCT FROM EXCLUDED.source_ref
           OR skill_definitions.enabled IS DISTINCT FROM EXCLUDED.enabled`,
      [id, version, input.capabilities ?? [], input.applicableTasks ?? input.applicable_tasks ?? [], input.requiredMemoryKinds ?? input.required_memory_kinds ?? [], input.conflicts ?? [], input.qualityGates ?? input.quality_gates ?? [], promptSections, input.applicableGenres ?? input.applicable_genres ?? [], input.executionPoints ?? input.execution_points ?? [], input.roles ?? [], input.dependsOn ?? input.depends_on ?? [], input.priority ?? "normal", input.contentFingerprint ?? canonicalSha256({ id, version, promptSections }), input.sourceRef ?? "knowledge-record", input.enabled !== false]);
      if (!wrote.rowCount) {
        return { id, kind, record: (await this.listKnowledgeRecords(projectId, kind)).find((record) => record.id === id) ?? null };
      }
    } else if (kind === "planning" || kind === "worldview" || kind === "characters") {
      const entityKind = kind === "characters" ? "character" : kind;
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
      await this.pool.query("INSERT INTO entities(id,project_id,kind,name,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,payload=EXCLUDED.payload", [id, projectId, entityKind, name, input.payload ?? {}]);
    } else if (kind === "relations") {
      const subjectId = String(input.subjectId ?? input.subject_id ?? "").trim();
      const predicate = String(input.predicate ?? "").trim();
      const objectId = String(input.objectId ?? input.object_id ?? "").trim();
      if (!subjectId || !predicate || !objectId) throw new Error("关系记录需要 subjectId、predicate、objectId");
      await this.pool.query("INSERT INTO relations(id,project_id,subject_id,predicate,object_id,valid_from,valid_to,source_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET subject_id=EXCLUDED.subject_id,predicate=EXCLUDED.predicate,object_id=EXCLUDED.object_id,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,source_revision_id=EXCLUDED.source_revision_id", [id, projectId, subjectId, predicate, objectId, input.validFrom ?? input.valid_from ?? null, input.validTo ?? input.valid_to ?? null, input.sourceRevisionId ?? input.source_revision_id ?? null]);
    } else if (kind === "timeline") {
      const eventType = String(input.eventType ?? input.event_type ?? "").trim();
      const narrativeTime = Number(input.narrativeTime ?? input.narrative_time);
      if (!eventType || !Number.isFinite(narrativeTime)) throw new Error("时间线记录需要 eventType 和 narrativeTime");
      await this.pool.query("INSERT INTO timeline_events(id,project_id,narrative_time,event_type,content,source_revision_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET narrative_time=EXCLUDED.narrative_time,event_type=EXCLUDED.event_type,content=EXCLUDED.content,source_revision_id=EXCLUDED.source_revision_id", [id, projectId, narrativeTime, eventType, input.content ?? {}, input.sourceRevisionId ?? input.source_revision_id ?? null]);
    } else {
      // The legacy `facts` table is a retired second source of truth: chapter-derived
      // and author facts live in memory_claims (approval-governed). Writing it from
      // any surface is closed; the commit-rollback path still purges old rows only.
      throw new Error(`不支持的资料类型：${kind}（事实断言请使用 claims）`);
    }
    await this.recordKnowledgeMutation(projectId, kind, id, "upsert", input);
    return { id, kind, record: (await this.listKnowledgeRecords(projectId, kind)).find((record) => record.id === id) ?? null };
  }

  async deleteKnowledgeRecord(projectId: string, kind: MutableKnowledgeRecordKind, id: string) {
    if (kind === "claims") return this.deleteNarrativeClaim(projectId, id);
    const table = kind === "skills" ? "skill_definitions" : kind === "planning" || kind === "worldview" || kind === "characters" ? "entities" : kind === "relations" ? "relations" : kind === "timeline" ? "timeline_events" : null;
    if (!table) throw new Error(`不支持删除的资料类型：${kind}（事实断言请使用 claims）`);
    const idColumn = kind === "skills" ? "skill_id" : "id";
    const projectClause = kind === "skills" ? "" : " AND project_id=$2";
    const params = kind === "skills" ? [id] : [id, projectId];
    const result = await this.pool.query(`DELETE FROM ${table} WHERE ${idColumn}=$1${projectClause} RETURNING ${idColumn} AS id`, params);
    await this.recordKnowledgeMutation(projectId, kind, id, "delete", { deleted: Boolean(result.rowCount) });
    return { deleted: Boolean(result.rowCount), id, kind };
  }

  private async recordKnowledgeMutation(projectId: string, kind: string, id: string, action: "upsert" | "delete", payload: Record<string, unknown>) {
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [projectId, "web", `knowledge.${action}`, kind, id, payload]);
    await this.appendOutbox(kind, id, `knowledge.${action}`, { projectId, kind, id });
  }

  async getProjectSnapshot(projectId: string, targetDocumentId?: string): Promise<NovelProjectSnapshot> {
    const project = await this.pool.query<{ current_revision: string; metadata: Record<string, unknown> }>("SELECT current_revision, metadata FROM novel_projects WHERE id = $1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    // Phase 3.3: 从 metadata 读取 genre/premise（题材通用差异化，不内置金手指/系统流特化）
    const metadata = project.rows[0].metadata ?? {};
    const genre = typeof metadata.genre === "string" ? metadata.genre : undefined;
    const premise = typeof metadata.premise === "string" ? metadata.premise : undefined;
    if (!targetDocumentId) return { projectId, currentRevision: Number(project.rows[0].current_revision), genre, premise };
    const document = await this.pool.query<{ narrative_order: number; pov_character_id: string | null; status: "planned" | "draft" | "review" | "final"; current_revision_id: string | null }>("SELECT narrative_order, pov_character_id, status, current_revision_id FROM manuscript_documents WHERE id = $1 AND project_id = $2", [targetDocumentId, projectId]);
    const row = document.rows[0];
    if (!row) throw new Error("目标章节不存在");
    return { projectId, currentRevision: Number(project.rows[0].current_revision), targetDocumentId, targetDocumentOrder: Number(row.narrative_order), targetDocumentStatus: row.status, targetDocumentRevisionId: row.current_revision_id ?? undefined, povCharacterId: row.pov_character_id ?? undefined, genre, premise };
  }

  async putIntent(intent: NovelIntent) {
    const result = await this.pool.query("INSERT INTO novel_intents(id, project_id, source, objective, payload, idempotency_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,idempotency_key) DO UPDATE SET objective=EXCLUDED.objective RETURNING payload", [intent.id, intent.projectId, intent.source, intent.objective, intent, intent.idempotencyKey]);
    return result.rows[0]?.payload as NovelIntent;
  }

  // ---- workflow_runs 生命周期：实现住在 repository/workflow-run-slice.ts，本层只委托。
  // 拆片的可验证性正在于此：公开面与 SQL 行为逐字不变，slice 可独立测、独立推演。
  async putWorkflowRun(input: { id: string; workflowType: string; projectId: string; temporalWorkflowId: string; status: WorkflowRunStatus; payload?: Record<string, unknown> }) {
    return this.workflowRuns.put(input);
  }

  async updateWorkflowRunStatus(temporalWorkflowId: string, status: WorkflowRunStatus, payload: Record<string, unknown> = {}) {
    return this.workflowRuns.updateStatus(temporalWorkflowId, status, payload);
  }

  async resumeWorkflowRunFromHumanGate(temporalWorkflowId: string, payload: Record<string, unknown> = {}) {
    return this.workflowRuns.resumeFromHumanGate(temporalWorkflowId, payload);
  }

  async claimApprovalEvidence(input: { workflowId: string; artifactId: string; decision: ApprovalEvidence["decision"]; actorSource: ApprovalEvidence["actorSource"]; actorId: string; feedback?: string; revisionBase?: "current" | "previous" }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runResult = await client.query<WorkflowRunRow>(
        `SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at
         FROM workflow_runs
         WHERE temporal_workflow_id=$1 AND status='manual-review-required' AND payload->>'artifactId'=$2
           AND payload->'pendingHumanDecision'->>'artifactId' IS DISTINCT FROM $2
         FOR UPDATE`,
        [input.workflowId, input.artifactId],
      );
      if (!runResult.rowCount) {
        await client.query("ROLLBACK");
        return undefined;
      }
      if (input.actorSource === "automation"
        && input.decision === "approve"
        && runResult.rows[0].payload.reasonCode !== "fact-approval-pending") {
        throw new Error("自动化来源不能执行作者覆盖批准");
      }
      const missingReviewerRoles = Array.isArray(runResult.rows[0].payload.missingReviewerRoles)
        ? runResult.rows[0].payload.missingReviewerRoles.filter((role): role is string => typeof role === "string")
        : [];
      assertCompleteChapterReviewEvidence(input.decision, missingReviewerRoles);
      const reviewRows = await client.query<{ issues: ReviewIssue[] }>("SELECT issues FROM reviews WHERE artifact_id=$1", [input.artifactId]);
      const unresolvedIssueFingerprints = [...new Set(reviewRows.rows.flatMap((row) => Array.isArray(row.issues) ? row.issues : [])
        .filter((item) => item.severity === "blocker" || item.severity === "major")
        .map(reviewIssueFingerprint))];
      if (input.decision === "approve" && unresolvedIssueFingerprints.length && !input.feedback?.trim()) throw new Error("覆盖严重审校问题时必须填写作者判断理由");
      const evidence: ApprovalEvidence = {
        id: randomUUID(),
        projectId: runResult.rows[0].project_id,
        workflowId: input.workflowId,
        artifactId: input.artifactId,
        decision: input.decision,
        actorSource: input.actorSource,
        actorId: input.actorId,
        unresolvedIssueFingerprints,
        ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
        ...(input.revisionBase ? { revisionBase: input.revisionBase } : {}),
        createdAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO approval_evidence(id,project_id,workflow_id,artifact_id,decision,actor_source,actor_id,unresolved_issue_fingerprints,feedback,revision_base,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [evidence.id, evidence.projectId, evidence.workflowId, evidence.artifactId, evidence.decision, evidence.actorSource, evidence.actorId, evidence.unresolvedIssueFingerprints, evidence.feedback ?? null, evidence.revisionBase ?? null, evidence.createdAt],
      );
      const claim = { approvalEvidenceId: evidence.id, artifactId: evidence.artifactId, decision: evidence.decision, actorSource: evidence.actorSource, actorId: evidence.actorId, feedback: evidence.feedback, revisionBase: evidence.revisionBase, submittedAt: evidence.createdAt };
      const updated = await client.query<WorkflowRunRow>(
        `UPDATE workflow_runs SET payload=payload || jsonb_build_object('pendingHumanDecision',$3::jsonb),updated_at=now()
         WHERE temporal_workflow_id=$1 AND payload->>'artifactId'=$2
           AND payload->'pendingHumanDecision'->>'artifactId' IS DISTINCT FROM $2
         RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`,
        [input.workflowId, input.artifactId, JSON.stringify(claim)],
      );
      if (!updated.rowCount) throw new Error("审批候选在证据创建期间发生变化");
      await client.query("COMMIT");
      return { evidence, run: workflowFromRow(updated.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getApprovalEvidence(workflowId: string, evidenceId: string): Promise<ApprovalEvidence | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const evidence = await this.getApprovalEvidenceById(evidenceId, client);
      if (!evidence || evidence.workflowId !== workflowId) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        // 与 workflow-run-slice 的门态回写同一条终态判据（同一 vocabulary，不另立第二份
        // "谁能改状态"规则）：消费裁决时若 run 已被 reject/abandon 短路径写成终态，
        // 这里不得把它覆回 running——否则一次成功裁决最终以僵尸 running 等收编。
        `UPDATE workflow_runs
         SET status=$3,payload=payload-'pendingHumanDecision',updated_at=now()
         WHERE temporal_workflow_id=$1
           AND payload->'pendingHumanDecision'->>'approvalEvidenceId'=$2
           ${terminalOverwriteGuardSql("$3")}`,
        [workflowId, evidenceId, HUMAN_GATE_RESUME_WORKFLOW_RUN_STATUS],
      );
      await client.query("COMMIT");
      return evidence;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getApprovalEvidenceById(evidenceId: string, connection: Pool | PoolClient = this.pool): Promise<ApprovalEvidence | undefined> {
    const result = await connection.query<{ id: string; project_id: string; workflow_id: string; artifact_id: string; decision: ApprovalEvidence["decision"]; actor_source: ApprovalEvidence["actorSource"]; actor_id: string; unresolved_issue_fingerprints: string[]; feedback: string | null; revision_base: "current" | "previous" | null; created_at: Date | string }>(
      "SELECT id,project_id,workflow_id,artifact_id,decision,actor_source,actor_id,unresolved_issue_fingerprints,feedback,revision_base,created_at FROM approval_evidence WHERE id=$1",
      [evidenceId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: row.id, projectId: row.project_id, workflowId: row.workflow_id, artifactId: row.artifact_id, decision: row.decision, actorSource: row.actor_source, actorId: row.actor_id, unresolvedIssueFingerprints: row.unresolved_issue_fingerprints ?? [], ...(row.feedback ? { feedback: row.feedback } : {}), ...(row.revision_base ? { revisionBase: row.revision_base } : {}), createdAt: iso(row.created_at) };
  }

  async releaseHumanDecisionClaim(workflowId: string, artifactId: string) {
    const result = await this.pool.query<WorkflowRunRow>(
      `UPDATE workflow_runs
       SET payload=payload-'pendingHumanDecision',updated_at=now()
       WHERE temporal_workflow_id=$1
         AND payload->'pendingHumanDecision'->>'artifactId'=$2
       RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`,
      [workflowId, artifactId],
    );
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async replacePendingHumanArtifact(input: { workflowId: string; currentArtifactId: string; replacement: Artifact; authorId: string }) {
    const editedAt = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<WorkflowRunRow>(
        `SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at
         FROM workflow_runs
         WHERE temporal_workflow_id=$1
           AND project_id=$2
           AND status='manual-review-required'
           AND payload->>'artifactId'=$3
           AND payload->'pendingHumanDecision' IS NULL
         FOR UPDATE`,
        [input.workflowId, input.replacement.projectId, input.currentArtifactId],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING",
        [
          input.replacement.id,
          input.replacement.projectId,
          input.replacement.taskId,
          input.replacement.attemptId,
          input.replacement.kind,
          input.replacement.contentHash,
          input.replacement.objectKey ?? "",
          input.replacement.baseRevision,
          input.replacement.fingerprint,
          input.replacement.structuredData ?? {},
        ],
      );
      const result = await client.query<WorkflowRunRow>(
        `UPDATE workflow_runs
         SET payload=payload || jsonb_build_object(
             'artifactId', $4::text,
             'replacedArtifactId', $3::text,
             'authorEditedAt', $5::text,
             'authorEditedBy', $6::text
           ),
           updated_at=now()
         WHERE temporal_workflow_id=$1
           AND project_id=$2
           AND status='manual-review-required'
           AND payload->>'artifactId'=$3
           AND payload->'pendingHumanDecision' IS NULL
         RETURNING id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at`,
        [input.workflowId, input.replacement.projectId, input.currentArtifactId, input.replacement.id, editedAt, input.authorId],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const row = workflowFromRow(result.rows[0]);
      await this.appendOutboxTx(client, "artifact", input.replacement.id, `artifact.${input.replacement.kind}.ready`, { projectId: input.replacement.projectId, artifactId: input.replacement.id, taskId: input.replacement.taskId, fingerprint: input.replacement.fingerprint, replacesArtifactId: input.currentArtifactId });
      await this.appendOutboxTx(client, "workflow-run", row.temporalWorkflowId, "workflow.artifact-replaced", { projectId: row.projectId, workflowId: row.temporalWorkflowId, runId: row.id, artifactId: input.replacement.id, replacedArtifactId: input.currentArtifactId, authorEditedAt: editedAt });
      await client.query("COMMIT");
      return { run: row, artifact: input.replacement };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getWorkflowRunByTemporalId(temporalWorkflowId: string) {
    return this.workflowRuns.getByTemporalId(temporalWorkflowId);
  }

  async listProjectRuns(projectId: string, limit = 20, workflowType?: string): Promise<WorkflowRunRecord[]> {
    return this.workflowRuns.listProjectRuns(projectId, limit, workflowType);
  }

  async findBootstrapRunId(projectId: string, idempotencyKey: string): Promise<string | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM creative_runs
       WHERE project_id=$1 AND payload->>'bootstrapKey'=$2
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, idempotencyKey],
    );
    return result.rows[0]?.id;
  }

  async initializeProjectPlan(input: {
    projectId: string;
    workItemByTaskKey: Map<string, string>;
    includedTaskKeys: readonly string[];
  }): Promise<ProjectPlanSection[]> {
    const included = new Set(input.includedTaskKeys);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const stage of PROJECT_PLAN_STAGES) {
        if (!included.has(stage.taskKey)) continue;
        const status: ProjectPlanStatus = stage.dependsOn.length === 0 ? "ready" : "locked";
        await client.query(
          `INSERT INTO project_plan_sections(project_id,task_key,work_item_id,status,payload)
           VALUES($1,$2,$3,$4,'{}'::jsonb)
           ON CONFLICT(project_id,task_key) DO UPDATE SET
             work_item_id=EXCLUDED.work_item_id,
             status=EXCLUDED.status,
             approved_at=NULL,
             updated_at=now()`,
          [input.projectId, stage.taskKey, input.workItemByTaskKey.get(stage.taskKey) ?? null, status],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.listProjectPlanSections(input.projectId);
  }

  async listProjectPlanSections(projectId: string): Promise<ProjectPlanSection[]> {
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
       FROM project_plan_sections WHERE project_id=$1`,
      [projectId],
    );
    const byKey = new Map(result.rows.map((row) => [row.task_key, projectPlanSectionFromRow(row)]));
    return PROJECT_PLAN_STAGES.flatMap((stage) => {
      const section = byKey.get(stage.taskKey);
      return section ? [section] : [];
    });
  }

  async getProjectPlanSection(projectId: string, taskKey: ProjectPlanTaskKey): Promise<ProjectPlanSection | undefined> {
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
       FROM project_plan_sections WHERE project_id=$1 AND task_key=$2`,
      [projectId, taskKey],
    );
    return result.rows[0] ? projectPlanSectionFromRow(result.rows[0]) : undefined;
  }

  async markProjectPlanGenerating(projectId: string, taskKey: ProjectPlanTaskKey): Promise<ProjectPlanSection> {
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `UPDATE project_plan_sections SET status='generating',updated_at=now()
       WHERE project_id=$1 AND task_key=$2 AND status IN ('ready','stale','failed')
       RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
      [projectId, taskKey],
    );
    if (!result.rowCount) throw new Error(`规划阶段当前不可生成：${taskKey}`);
    return projectPlanSectionFromRow(result.rows[0]);
  }

  async prepareProjectPlanRegeneration(input: {
    projectId: string;
    taskKey: ProjectPlanTaskKey;
    workItemId: string;
    actor: string;
  }): Promise<ProjectPlanSection> {
    const stage = PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === input.taskKey)!;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (stage.dependsOn.length) {
        const dependencies = await client.query<{ task_key: string; status: ProjectPlanStatus }>(
          "SELECT task_key,status FROM project_plan_sections WHERE project_id=$1 AND task_key=ANY($2::text[])",
          [input.projectId, stage.dependsOn],
        );
        const approved = new Set(dependencies.rows.filter((row) => row.status === "approved").map((row) => row.task_key));
        const missing = stage.dependsOn.filter((key) => !approved.has(key));
        if (missing.length) throw new Error(`规划阶段依赖尚未确认：${missing.join(", ")}`);
      }
      const result = await client.query<ProjectPlanSectionRow>(
        `UPDATE project_plan_sections SET work_item_id=$3,status='generating',approved_at=NULL,updated_at=now()
         WHERE project_id=$1 AND task_key=$2
         RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
        [input.projectId, input.taskKey, input.workItemId],
      );
      if (!result.rowCount) throw new Error(`规划阶段不存在：${input.taskKey}`);
      const dependents = transitivePlanDependents(input.taskKey);
      if (dependents.length) {
        await client.query(
          `UPDATE project_plan_sections SET status='stale',approved_at=NULL,updated_at=now()
           WHERE project_id=$1 AND task_key=ANY($2::text[]) AND status <> 'locked'`,
          [input.projectId, dependents],
        );
      }
      await client.query(
        "UPDATE arcs SET planning_status='stale',approved_at=NULL,context_fingerprint=NULL,updated_at=now() WHERE project_id=$1 AND execution_status NOT IN ('completed','abandoned')",
        [input.projectId],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'plan.section.regeneration-started','project-plan-section',$3,$4)",
        [input.projectId, input.actor, input.taskKey, { workItemId: input.workItemId, staleDependents: dependents }],
      );
      await client.query("COMMIT");
      return projectPlanSectionFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async projectFoundationArtifact(artifact: Artifact): Promise<ProjectPlanSection | undefined> {
    const taskKey = foundationTaskKey(artifact);
    if (!taskKey) return undefined;
    const result = await this.pool.query<ProjectPlanSectionRow>(
      `INSERT INTO project_plan_sections(project_id,task_key,work_item_id,source_artifact_id,status,payload)
       VALUES($1,$2,$3,$4,'awaiting-confirmation',$5)
       ON CONFLICT(project_id,task_key) DO UPDATE SET
         work_item_id=COALESCE(EXCLUDED.work_item_id,project_plan_sections.work_item_id),
         source_artifact_id=EXCLUDED.source_artifact_id,
         status='awaiting-confirmation',payload=EXCLUDED.payload,approved_at=NULL,updated_at=now()
       RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
      [artifact.projectId, taskKey, artifact.structuredData?.workItemId ?? null, artifact.id, artifact.structuredData ?? {}],
    );
    return projectPlanSectionFromRow(result.rows[0]);
  }

  async replaceProjectPlanSection(input: {
    projectId: string;
    taskKey: ProjectPlanTaskKey;
    artifact: Artifact;
    actor: string;
  }): Promise<ProjectPlanSection> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ProjectPlanSectionRow>(
        `UPDATE project_plan_sections SET source_artifact_id=$3,payload=$4,status='awaiting-confirmation',
           edit_revision=edit_revision+1,approved_at=NULL,updated_at=now()
         WHERE project_id=$1 AND task_key=$2
         RETURNING project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at`,
        [input.projectId, input.taskKey, input.artifact.id, input.artifact.structuredData ?? {}],
      );
      if (!result.rowCount) throw new Error(`规划阶段不存在：${input.taskKey}`);
      const dependents = transitivePlanDependents(input.taskKey);
      if (dependents.length) {
        await client.query(
          `UPDATE project_plan_sections SET status='stale',approved_at=NULL,updated_at=now()
           WHERE project_id=$1 AND task_key=ANY($2::text[]) AND status <> 'locked'`,
          [input.projectId, dependents],
        );
      }
      await client.query(
        "UPDATE arcs SET planning_status='stale',approved_at=NULL,context_fingerprint=NULL,updated_at=now() WHERE project_id=$1 AND execution_status NOT IN ('completed','abandoned')",
        [input.projectId],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'plan.section.updated','project-plan-section',$3,$4)",
        [input.projectId, input.actor, input.taskKey, { artifactId: input.artifact.id, editRevision: Number(result.rows[0].edit_revision) }],
      );
      await client.query("COMMIT");
      return projectPlanSectionFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async approveProjectPlanSection(projectId: string, taskKey: ProjectPlanTaskKey, artifactId: string, actor: string): Promise<ProjectPlanSection[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<ProjectPlanSectionRow>(
        `SELECT project_id,task_key,work_item_id,source_artifact_id,status,payload,edit_revision,approved_at,created_at,updated_at
         FROM project_plan_sections WHERE project_id=$1 AND task_key=$2 FOR UPDATE`,
        [projectId, taskKey],
      );
      if (!current.rowCount) throw new Error(`规划阶段不存在：${taskKey}`);
      if (current.rows[0].source_artifact_id !== artifactId) throw new Error("规划内容已变化，请刷新后重新确认");
      // PL-8（product-audit-20260910 B3）：批准曾只做状态翻转，exact-keys 契约只在生成
      // 重试循环跑——非生成入口（人工编辑、旧快照回放）带入的键名/类型漂移可绕过校验直接
      // 批准。批准是"承诺此段结构可信"的语义点，契约必须在**此处**强制，与来源无关。
      const payload = current.rows[0].payload;
      const contractErrors = validateFoundationTaskContract(payload as unknown as FoundationOutput, taskKey);
      if (contractErrors.length) throw new Error(`规划阶段 ${taskKey} 契约校验未通过，不能批准：${contractErrors.slice(0, 6).join("；")}${contractErrors.length > 6 ? ` 等 ${contractErrors.length} 项` : ""}`);
      await client.query(
        "UPDATE project_plan_sections SET status='approved',approved_at=now(),updated_at=now(),payload=$3 WHERE project_id=$1 AND task_key=$2",
        [projectId, taskKey, { ...payload, contractVersion: foundationContractFingerprint(taskKey) }],
      );
      if (taskKey === "project-positioning") {
        const bookTitle = approvedProjectBookTitle(current.rows[0].payload);
        if (bookTitle) {
          await client.query("UPDATE novel_projects SET title=$2,updated_at=now() WHERE id=$1", [projectId, bookTitle]);
          // books.title 与项目名同源（books 是 story_arcs 的 FK 锚；派生名单一写面，
          // 否则锚表永远滞留初建快照——审计实测 books.title=旧书名）。
          await client.query("UPDATE books SET title=$2 WHERE project_id=$1", [projectId, bookTitle]);
          await client.query(
            "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'project.title.adopted','novel-project',$1,$3)",
            [projectId, actor, { title: bookTitle, sourceArtifactId: artifactId, taskKey }],
          );
        }
      }
      for (const stage of PROJECT_PLAN_STAGES) {
        if (!stage.dependsOn.includes(taskKey as never)) continue;
        const dependencyResult = await client.query<{ task_key: string; status: ProjectPlanStatus }>(
          "SELECT task_key,status FROM project_plan_sections WHERE project_id=$1 AND task_key=ANY($2::text[])",
          [projectId, stage.dependsOn],
        );
        if (stage.dependsOn.every((key) => dependencyResult.rows.some((row) => row.task_key === key && row.status === "approved"))) {
          await client.query(
            "UPDATE project_plan_sections SET status='ready',updated_at=now() WHERE project_id=$1 AND task_key=$2 AND status IN ('locked','stale')",
            [projectId, stage.taskKey],
          );
        }
      }
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'plan.section.approved','project-plan-section',$3,$4)",
        [projectId, actor, taskKey, { artifactId }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.listProjectPlanSections(projectId);
  }

  async listCurrentFoundationArtifacts(projectId: string, approvedOnly = true, connection: Pool | PoolClient = this.pool): Promise<Artifact[]> {
    const result = await connection.query<ArtifactRow>(
      `SELECT a.id,a.project_id,a.task_id,a.attempt_id,a.kind,a.content_hash,a.object_key,a.base_revision,a.fingerprint,a.payload,a.created_at
       FROM project_plan_sections ps JOIN artifacts a ON a.id=ps.source_artifact_id
       WHERE ps.project_id=$1 AND ($2::boolean=FALSE OR ps.status='approved')`,
      [projectId, approvedOnly],
    );
    const byKey = new Map(result.rows.map((row) => {
      const artifact = artifactFromRow(row);
      return [foundationTaskKey(artifact), artifact] as const;
    }));
    return PROJECT_PLAN_STAGES.flatMap((stage) => {
      const artifact = byKey.get(stage.taskKey);
      return artifact ? [artifact] : [];
    });
  }

  async assertRequiredPlanApproved(projectId: string): Promise<void> {
    const result = await this.pool.query<{ task_key: string }>(
      "SELECT task_key FROM project_plan_sections WHERE project_id=$1 AND status='approved' AND task_key=ANY($2::text[])",
      [projectId, REQUIRED_APPROVED_PLAN_TASK_KEYS],
    );
    const approved = new Set(result.rows.map((row) => row.task_key));
    const missing = REQUIRED_APPROVED_PLAN_TASK_KEYS.filter((key) => !approved.has(key));
    if (missing.length) throw new Error(`全书规划尚未确认：${missing.join(", ")}`);
  }

  async getProjectPlanRun(projectId: string): Promise<{ runId: string; status: string } | undefined> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT cr.id,cr.status FROM creative_runs cr
       WHERE cr.project_id=$1 AND cr.payload->>'bootstrap'='true'
       ORDER BY cr.created_at DESC LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ? { runId: result.rows[0].id, status: result.rows[0].status } : undefined;
  }

  private async ensureOutlineRoot(projectId: string, client: Pool | PoolClient = this.pool): Promise<string> {
    const project = await client.query<{ title: string }>("SELECT title FROM novel_projects WHERE id=$1", [projectId]);
    if (!project.rowCount) throw new Error("项目不存在");
    const bookId = `book:${projectId}`;
    const volumeId = `volume:${projectId}:1`;
    await client.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [bookId, projectId, project.rows[0].title]);
    await client.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,'正文',1) ON CONFLICT DO NOTHING", [volumeId, bookId]);
    return volumeId;
  }

  async createNextStoryArc(input: { projectId: string; workflowId: string; authorIntent?: string; plotOutline?: StoryArcPlotOutline }): Promise<StoryArcRecord> {
    await this.assertRequiredPlanApproved(input.projectId);
    const client = await this.pool.connect();
    let arcId = "";
    try {
      await client.query("BEGIN");
      const unfinished = await client.query<{ id: string }>(
        "SELECT id FROM arcs WHERE project_id=$1 AND execution_status NOT IN ('completed','abandoned') ORDER BY ordinal DESC LIMIT 1 FOR UPDATE",
        [input.projectId],
      );
      if (unfinished.rowCount) throw new Error("上一故事弧尚未完成或放弃，不能规划下一故事弧");
      const volumeId = await this.ensureOutlineRoot(input.projectId, client);
      const ordinalResult = await client.query<{ ordinal: number }>("SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM arcs WHERE project_id=$1", [input.projectId]);
      const ordinal = Number(ordinalResult.rows[0]?.ordinal ?? 1);
      arcId = randomUUID();
      const payload = { title: input.plotOutline?.title || `故事弧 ${ordinal}`, objective: input.plotOutline?.objective || input.authorIntent || "依据当前宏观规划和已定稿故事状态，形成一个完整的小故事", entryState: input.plotOutline?.entryState ?? "", centralConflict: input.plotOutline?.centralConflict ?? "", development: input.plotOutline?.development ?? [], resolution: input.plotOutline?.resolution ?? "", exitState: input.plotOutline?.exitState ?? "", threadResponsibilities: input.plotOutline?.threadResponsibilities ?? [], foreshadowingRefs: [], expectedChapterCount: input.plotOutline?.expectedChapterCount ?? 0, phases: input.plotOutline?.phases ?? [], workflowId: input.workflowId };
      await client.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,$4,$5,'generating','planned',$6)`,
        [arcId, volumeId, input.projectId, payload.title, ordinal, payload],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc.created','story-arc',$2,$3)",
        [input.projectId, arcId, { workflowId: input.workflowId, authorIntent: input.authorIntent, ...(input.plotOutline ? { plotOutline: input.plotOutline } : {}) }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getStoryArc(input.projectId, arcId))!;
  }

  async projectStoryArcBundle(input: { projectId: string; arcId: string; bundle: StoryArcBundle; artifact: Artifact; actor: string; edited?: boolean }): Promise<StoryArcRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [input.arcId, input.projectId]);
      if (!current.rowCount) throw new Error("故事弧不存在");
      // POV 写侧归一（P4 安全网）：模型幻觉/MCP 手改带入的漂移形态在进 chapters
      // payload 一刻按登记表收敛为短 id，防污染面扩大；未登记形态原样通过。
      const povWriteIndex = buildCharacterRefIndex((await client.query<{ id: string; name: string }>("SELECT id,name FROM entities WHERE project_id=$1 AND kind='character'", [input.projectId])).rows);
      if (current.rows[0].execution_status === "abandoned" || (current.rows[0].execution_status === "completed" && !input.edited)) throw new Error("已结束故事弧不可改写");
      const existing = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE arc_id=$1 ORDER BY ordinal", [input.arcId]);
      const existingBatch = await client.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2 AND batch_index=$3 FOR UPDATE", [input.arcId, input.projectId, input.bundle.batch.batchIndex]);
      const existingByLocal = new Map(existing.rows.map((row) => [Number(row.payload?.index ?? 0), row]));
      const linkedDocumentIds = existing.rows.flatMap((row) => row.document_id ? [row.document_id] : []);
      const linkedDocuments = linkedDocumentIds.length
        ? await client.query<{ id: string; status: string; current_revision_id: string | null }>("SELECT id,status,current_revision_id FROM manuscript_documents WHERE id=ANY($1::text[]) FOR UPDATE", [linkedDocumentIds])
        : { rows: [] };
      const linkedDocumentById = new Map(linkedDocuments.rows.map((row) => [row.id, row]));
      const minExisting = existing.rows.length ? Math.min(...existing.rows.map((row) => Number(row.ordinal))) : undefined;
      const next = await client.query<{ ordinal: number }>(
        `SELECT GREATEST(
           COALESCE((
             SELECT MAX(c.ordinal)
             FROM chapters c
             JOIN arcs a ON a.id=c.arc_id
             WHERE c.project_id=$1
               AND NOT (a.execution_status='abandoned' AND c.document_id IS NULL)
           ),0),
           COALESCE((SELECT MAX(narrative_order) FROM manuscript_documents WHERE project_id=$1),0)
         )+1 AS ordinal`,
        [input.projectId],
      );
      const baseOrder = input.bundle.batch.batchIndex === 1 ? minExisting ?? Number(next.rows[0]?.ordinal ?? 1) : Number(next.rows[0]?.ordinal ?? 1);
      const batchStartChapterIndex = input.bundle.batch.batchIndex === 1 ? baseOrder : input.bundle.batch.startChapterIndex;
      const previousBatchStart = existingBatch.rows[0] ? Number(existingBatch.rows[0].start_chapter_index) : batchStartChapterIndex;
      const previousBatchEnd = existingBatch.rows[0] ? Number(existingBatch.rows[0].end_chapter_index) : batchStartChapterIndex + input.bundle.chapters.length - 1;
      // 与 startChapterIndex 同理：complete 是"弧内期望是否已被规划覆盖"的系统事实，
      // 不是模型自报旗（窗口契约同族教训——模型自报值既漏标（弧1 满覆盖却报 false）
      // 又可能谎报，下游 prepareNext/审计/面板全按它分支）。派生口径：投影后弧内
      // 不同章序数 ≥ expectedChapterCount。expected 缺失（旧弧 0）才保留模型自报值。
      const expectedForComplete = Number((current.rows[0].payload as NarrativeArcPlan).expectedChapterCount ?? 0);
      const projectedOrdinals = new Set<number>([
        ...existing.rows.map((row) => Number(row.ordinal)),
        ...input.bundle.chapters.map((_, i) => batchStartChapterIndex + i),
      ]);
      const batchPayload = { ...input.bundle.batch, startChapterIndex: batchStartChapterIndex, ...(expectedForComplete ? { complete: projectedOrdinals.size >= expectedForComplete } : {}) };
      const batchId = `batch:${input.arcId}:${input.bundle.batch.batchIndex}`;
      const isInitialBatch = input.bundle.batch.batchIndex === 1;
      const batchRows = await client.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2", [input.arcId, input.projectId]);
      const batchIssues = auditStoryArcBatchRanges([
        ...batchRows.rows
          .filter((batch) => Number(batch.batch_index) !== input.bundle.batch.batchIndex)
          .map((batch) => ({ batchIndex: Number(batch.batch_index), startChapterIndex: Number(batch.start_chapter_index), endChapterIndex: Number(batch.end_chapter_index), status: batch.status })),
        { batchIndex: input.bundle.batch.batchIndex, startChapterIndex: batchStartChapterIndex, endChapterIndex: batchStartChapterIndex + input.bundle.chapters.length - 1, status: "awaiting-review" },
      ]);
      if (batchIssues.length && !input.edited) throw new Error(`故事弧批次区间不合法：${batchIssues.map((issue) => issue.message).join("；")}`);
      const editingCurrentAwaitingReviewBatch = input.edited === true
        && (existingBatch.rowCount ?? 0) > 0
        && existingBatch.rows[0].status === "awaiting-review";
      if (!isInitialBatch && current.rows[0].planning_status !== "approved" && !editingCurrentAwaitingReviewBatch) throw new Error("上一故事弧批次尚未批准");
      if (!isInitialBatch) {
        const approvedArc = current.rows[0].payload as NarrativeArcPlan;
        for (const field of ["title", "objective", "entryState", "exitState", "expectedChapterCount"] as const) {
          if (JSON.stringify(input.bundle.arc[field]) !== JSON.stringify(approvedArc[field])) throw new Error(`后续批次不得改写故事弧边界：${field}`);
        }
      }
      await client.query(
        `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,payload)
         VALUES($1,$2,$3,$4,$5,$6,'awaiting-review',$7,$8)
         ON CONFLICT(arc_id,batch_index) DO UPDATE SET end_chapter_index=EXCLUDED.end_chapter_index,status='awaiting-review',source_artifact_id=EXCLUDED.source_artifact_id,payload=EXCLUDED.payload,updated_at=now()`,
        [batchId, input.arcId, input.projectId, input.bundle.batch.batchIndex, batchStartChapterIndex, batchStartChapterIndex + input.bundle.chapters.length - 1, input.artifact.id, batchPayload],
      );
      const keptIds: string[] = [];
      for (const chapter of input.bundle.chapters) {
        const globalIndex = batchStartChapterIndex + chapter.index - 1;
        const previous = existingByLocal.get(globalIndex);
        const linkedDocument = previous?.document_id ? linkedDocumentById.get(previous.document_id) : undefined;
        const isProtected = Boolean(linkedDocument && (linkedDocument.status !== "planned" || linkedDocument.current_revision_id));
        const chapterId = previous?.id ?? chapter.id ?? randomUUID();
        const globalOrder = previous ? Number(previous.ordinal) : baseOrder + chapter.index - 1;
        const normalizedPov = chapter.povCharacterId ? povWriteIndex.resolve(chapter.povCharacterId) : undefined;
        const chapterPayload = { ...chapter, id: chapterId, index: globalIndex, ...(normalizedPov ? { povCharacterId: normalizedPov.shortId } : {}) };
        keptIds.push(chapterId);
        // Generated rebases cannot rewrite the plan behind committed prose. An explicit
        // author edit may update that plan so the formal chapter-review workflow can
        // repair already-final chapters against the corrected intent.
        if (previous && isProtected && !input.edited) continue;
        await client.query(
          `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision,batch_id,batch_index,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10,$11,now())
           ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,payload=EXCLUDED.payload,source_artifact_id=EXCLUDED.source_artifact_id,
             blueprint_revision=chapters.blueprint_revision+1,batch_id=EXCLUDED.batch_id,batch_index=EXCLUDED.batch_index,updated_at=now()`,
          [chapterId, input.arcId, input.projectId, previous?.document_id ?? null, chapter.title, globalOrder, chapterPayload, input.artifact.id, previous ? Number(previous.blueprint_revision) + 1 : 0, batchId, input.bundle.batch.batchIndex],
        );
        if (!isProtected) {
          await client.query("DELETE FROM scenes WHERE chapter_id=$1", [chapterId]);
          for (let index = 0; index < chapter.scenes.length; index += 1) {
            const scene = chapter.scenes[index];
            await client.query("INSERT INTO scenes(id,chapter_id,ordinal,summary,payload) VALUES($1,$2,$3,$4,$5)", [randomUUID(), chapterId, index + 1, scene.situation, scene]);
          }
        }
      }
      // A protected chapter may skip the blueprint upsert during rebase. Sync
      // the denormalized lifecycle marker so an old planned value cannot
      // survive beside a committed manuscript.
      await client.query(
        `UPDATE chapters c
         SET status='final',updated_at=now()
         FROM manuscript_documents d
         WHERE c.project_id=$1
           AND c.arc_id=$2
           AND c.document_id=d.id
           AND d.project_id=c.project_id
           AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
           AND c.status<>'final'`,
        [input.projectId, input.arcId],
      );
      const removable = existing.rows.filter((row) => {
        const index = Number(row.payload?.index ?? 0);
        return index >= previousBatchStart && index <= previousBatchEnd && !keptIds.includes(row.id) && !row.document_id;
      }).map((row) => row.id);
      if (removable.length) await client.query("DELETE FROM chapters WHERE id=ANY($1::text[])", [removable]);
      await client.query(
        `UPDATE arcs SET title=CASE WHEN $7 THEN $3 ELSE title END,payload=CASE WHEN $7 THEN $4 ELSE payload END,source_artifact_id=COALESCE(source_artifact_id,$5),blueprint_artifact_id=$5,
           planning_status='awaiting-review',context_fingerprint=NULL,approved_at=NULL,
           edit_revision=edit_revision+$6,updated_at=now() WHERE id=$1 AND project_id=$2`,
        [input.arcId, input.projectId, input.bundle.arc.title, input.bundle.arc, input.artifact.id, input.edited ? 1 : 0, isInitialBatch],
      );
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,'story-arc',$4,$5)",
        [input.projectId, input.actor, input.edited ? "story-arc.edited" : "story-arc.generated", input.arcId, { artifactId: input.artifact.id, chapterCount: input.bundle.chapters.length }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getStoryArc(input.projectId, input.arcId))!;
  }

  async listStoryArcs(projectId: string): Promise<StoryArcRecord[]> {
    const arcs = await this.pool.query<ArcRow>("SELECT * FROM arcs WHERE project_id=$1 ORDER BY ordinal", [projectId]);
    const result: StoryArcRecord[] = [];
    for (const arc of arcs.rows) result.push((await this.getStoryArc(projectId, arc.id))!);
    return result;
  }

  /**
   * Read-only architecture diagnostic. It reports hard-boundary risks without
   * imposing literary requirements on chapters or changing persisted data.
   */
  async getArchitectureHealth(projectId: string) {
    const [project, sections, arcs, batches, chapters, threads, foreshadowing, arcPlanningRuns, projectionFailures] = await Promise.all([
      this.pool.query<{ id: string; title: string; current_revision: string | number }>("SELECT id,title,current_revision FROM novel_projects WHERE id=$1", [projectId]),
      this.pool.query<{ task_key: string; status: ProjectPlanStatus; payload: Record<string, unknown> }>("SELECT task_key,status,payload FROM project_plan_sections WHERE project_id=$1 ORDER BY task_key", [projectId]),
      this.pool.query<{ id: string; ordinal: string | number; planning_status: StoryArcRecord["planningStatus"]; execution_status: StoryArcRecord["executionStatus"]; payload: NarrativeArcPlan; approved_at: Date | null; completed_at: Date | null }>("SELECT id,ordinal,planning_status,execution_status,payload,approved_at,completed_at FROM arcs WHERE project_id=$1 ORDER BY ordinal", [projectId]),
      this.pool.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE project_id=$1 ORDER BY arc_id,batch_index", [projectId]),
      this.pool.query<{ arc_id: string | null; ordinal: string | number; batch_id: string | null; batch_index: string | number | null; document_id: string | null; document_status: string | null; current_revision_id: string | null; narrative_function: string | null }>(
        `SELECT c.arc_id,c.ordinal,c.batch_id,c.batch_index,c.document_id,d.status AS document_status,d.current_revision_id,c.payload->>'narrativeFunction' AS narrative_function
         FROM chapters c LEFT JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
         WHERE c.project_id=$1 ORDER BY c.ordinal`,
        [projectId],
      ),
      this.pool.query<{ id: string; title: string; payload: Record<string, unknown> }>("SELECT id,title,payload FROM plot_threads WHERE project_id=$1 ORDER BY id", [projectId]),
      this.pool.query<{ id: string; payload: Record<string, unknown> }>("SELECT id,payload FROM foreshadowing WHERE project_id=$1 ORDER BY id", [projectId]),
      // PL-6 连载健康度：弧规划工作流的终态分布（失败重试数是规划稳定性指标）。
      this.pool.query<{ status: string; count: string }>("SELECT status, count(*)::text AS count FROM workflow_runs WHERE project_id=$1 AND workflow_type='story-arc-planning' GROUP BY status", [projectId]),
      // F3 可见性：投影失败登记面（commit 链路吞下的叙事元素/快照投影失败）此前**只进不出**
      // ——全仓无任何 SELECT 消费者，于是"可重放"的提示语掩盖了账本永久丢项。健康度先把
      // pending 数量与类型暴露出来；重放通道要按 payload 重建投影，属独立一步，不在观测面里偷做。
      // 明细取一页（常量见下），但 `pending` 必须是整账真数：用 rowCount 会把"页"当"账"，
      // >20 条时静默截断，且 DESC 序先隐藏的正是要修的最陈旧卡死账。
      this.pool.query<{ projection_type: string; aggregate_id: string; error_message: string | null; attempts: string | number; updated_at: Date; total: string }>(
        `SELECT projection_type,aggregate_id,error_message,attempts,updated_at,
                COUNT(*) OVER()::text AS total
         FROM projection_failures WHERE project_id=$1 AND status='pending'
         ORDER BY updated_at ASC LIMIT ${HEALTH_PROJECTION_FAILURE_PAGE}`,
        [projectId],
      ),
    ]);
    if (!project.rowCount) throw new Error("项目不存在");

    const labels = (payload: Record<string, unknown> | undefined): string[] => {
      if (!payload) return [];
      const values = [payload.name, payload.title, payload.description, payload.label, payload.aliases, payload.names];
      return values.flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []);
    };
    const threadCandidates: NamedReferenceCandidate[] = threads.rows.map((row) => ({ id: row.id, labels: [row.title, ...labels(row.payload)] }));
    const foreshadowingCandidates: NamedReferenceCandidate[] = foreshadowing.rows.map((row) => ({ id: row.id, labels: labels(row.payload) }));
    // PL-2 修复④：引用解析区分 resolved-existing 与 resolved-newly-created——引用完整性
    // 不能对"弧审批时新造的对象"永久失明（影子线自我审批的根因）。
    const referenceCreatedIds = new Set<string>([
      ...threads.rows.filter((row) => row.payload?.source === "story-arc-reference").map((row) => row.id),
      ...foreshadowing.rows.filter((row) => row.payload?.source === "story-arc-reference").map((row) => row.id),
    ]);
    const titleHygieneRows: Array<{ id: string; title: string }> = [
      ...threads.rows.map((row) => ({ id: row.id, title: row.title })),
      ...arcs.rows.flatMap((arc) => {
        const p = arc.payload as unknown as Record<string, unknown> | undefined;
        const keys = ["title", "objective", "entryState", "centralConflict", "resolution", "exitState"] as const;
        return keys.flatMap((key) => typeof p?.[key] === "string" ? [{ id: `${arc.id}#${key}`, title: String(p[key]) }] : []);
      }),
    ];
    const hygieneIssues: StoryArcIntegrityIssue[] = titleHygieneRows.flatMap((row) => {
      const embedded = findEmbeddedInternalIdentifiers(row.title);
      return embedded.length
        ? [{ code: "embedded-identifier" as const, severity: "blocking" as const, reference: row.id, candidateIds: embedded, message: `“${row.id}”的文本内嵌内部标识符（${embedded.slice(0, 3).join("、")}）：机器记号泄漏进创作文本会随快照复制自我放大，需作者决定改写或登记` }]
        : [];
    });
    const referenceReports = arcs.rows.map((arc) => {
      const plotThreadAudit = auditNamedReferences(
        Array.isArray(arc.payload?.threadResponsibilities)
          ? arc.payload.threadResponsibilities.flatMap((value) => value && typeof value === "object" && !Array.isArray(value) && typeof (value as unknown as Record<string, unknown>).threadRef === "string" ? [(value as unknown as Record<string, unknown>).threadRef as string] : [])
          : [],
        threadCandidates,
      );
      const foreshadowingAudit = auditNamedReferences(Array.isArray(arc.payload?.foreshadowingRefs) ? arc.payload.foreshadowingRefs.filter((value): value is string => typeof value === "string") : [], foreshadowingCandidates);
      const classify = (audit: { resolutions: Array<{ status: string; canonicalId?: string }> }) => {
        const resolved = audit.resolutions.filter((resolution) => resolution.status === "resolved" && resolution.canonicalId);
        return {
          resolvedExisting: resolved.filter((resolution) => !referenceCreatedIds.has(resolution.canonicalId!)).length,
          resolvedNewlyCreated: resolved.filter((resolution) => referenceCreatedIds.has(resolution.canonicalId!)).length,
        };
      };
      return {
        arcId: arc.id,
        plotThreads: { ...plotThreadAudit, ...classify(plotThreadAudit) },
        foreshadowing: { ...foreshadowingAudit, ...classify(foreshadowingAudit) },
      };
    });
    const batchReports = arcs.rows.map((arc) => {
      const ranges = batches.rows.filter((batch) => batch.arc_id === arc.id).map((batch) => ({ batchIndex: Number(batch.batch_index), startChapterIndex: Number(batch.start_chapter_index), endChapterIndex: Number(batch.end_chapter_index), status: batch.status }));
      return { arcId: arc.id, ranges, issues: auditStoryArcBatchRanges(ranges) };
    });
    // PL-1 诊断面（B1）：completed 弧的期望章数与弧内实际落籍章数不一致 → blocking，
    // 强制 rebase/abandon 或作者修正期望后回写——弧 2 式"缺 7 章静默收口"必须可见。
    const completionIssues: StoryArcIntegrityIssue[] = arcs.rows.filter((arc) => arc.execution_status === "completed").flatMap((arc) => {
      const expected = Number((arc.payload as unknown as Record<string, unknown> | undefined)?.expectedChapterCount ?? 0);
      const localCount = chapters.rows.filter((chapter) => chapter.arc_id === arc.id).length;
      return expected > 0 && localCount !== expected
        ? [{ code: "completion-count-mismatch" as const, severity: "blocking" as const, reference: arc.id, message: `弧 ${arc.id} 已 completed 但期望 ${expected} 章、弧内实际落籍 ${localCount} 章：需要 rebase/abandon，或作者确认弧以 ${localCount} 章收口后修正 expectedChapterCount 回写` }]
        : [];
    });
    // PL-5 修复⑤：伏笔账本五类计数（B2——账面失真让"哪些伏笔必须兑现"不可用作决策依据）。
    // 只读诊断不改数据；每类聚合成一条 issue，计数供总览面板。
    const [foreshadowingLedgerRows, payoffLedgerRows, currentOrderRow] = await Promise.all([
      this.pool.query<{ id: string; thread_id: string | null; status: string; narrative_order: number | null; payload: Record<string, unknown> }>(
        "SELECT id,thread_id,status,narrative_order,payload FROM foreshadowing WHERE project_id=$1", [projectId]),
      this.pool.query<{ foreshadowing_id: string }>("SELECT DISTINCT p.foreshadowing_id FROM payoffs p JOIN foreshadowing f ON f.id=p.foreshadowing_id WHERE f.project_id=$1", [projectId]),
      this.pool.query<{ max: number | null }>("SELECT MAX(narrative_order)::int AS max FROM manuscript_documents WHERE project_id=$1 AND status='final'", [projectId]),
    ]);
    const paidOffForeshadowingIds = new Set(payoffLedgerRows.rows.map((row) => row.foreshadowing_id));
    const liveArcIds = new Set(arcs.rows.map((arc) => arc.id));
    const currentNarrativeOrder = currentOrderRow.rows[0]?.max ?? null;
    const ledgerFlows = foreshadowingLedgerRows.rows;
    // overdue 语义（2026-09-18 P1 修正）：`horizonOrder` 是窗口**上界**，不是死线。
    // 实测 244 条"窗口上界已过"中 238 条仍在活跃推进（关键词被后续 20+ 章提及），
    // 只有 6 条真沉睡——对连载而言"上界已过而线索仍在跑"是正常形态，不是债务。
    // 故本字段改称中性事实 `windowElapsed`（窗口上界已过），不再声称超期；
    // 真正需要行动的"曾活跃→静默终止"由 narrative-dormancy 通道单独给出
    // （依赖全章正文，只在有对象存储的活动中计算，见 activities.loadNarrativeDormancy）。
    // 依据：docs/novel-v2/p1-foreshadowing-survey-20260918.md
    const windowElapsed = ledgerFlows.filter((row) => {
      if (row.status !== "open") return false;
      const window = parsePayoffWindow(row.payload?.expectedPayoffWindow, row.narrative_order);
      return window.kind === "chapter" && window.horizonOrder !== null && currentNarrativeOrder !== null && currentNarrativeOrder > window.horizonOrder;
    });
    const unboundOpen = ledgerFlows.filter((row) => row.status === "open" && !row.thread_id);
    const fulfilledWithoutPayoff = ledgerFlows.filter((row) => row.status === "fulfilled" && !paidOffForeshadowingIds.has(row.id));
    const arcOrphans = ledgerFlows.filter((row) => typeof row.payload?.sourceArcId === "string" && !liveArcIds.has(String(row.payload.sourceArcId)));
    // 重复簇=规范化描述字符二元组 Dice 近同文聚簇（精确 key 匹配抓不住"每轮换措辞"的
    // 真实重复形态）。阈值刻意保守在高位——只聚近同文，语义等价判定仍归 grooming 报告。
    // TODO(magic-value): 0.85 为经验保守位，需按跨题材语料校准后配置化。
    const descKeys = ledgerFlows.map((row) => narrativeTextKey(String(row.payload?.description ?? "")));
    const clusterParent = descKeys.map((_, index) => index);
    const findCluster = (index: number): number => (clusterParent[index] === index ? index : (clusterParent[index] = findCluster(clusterParent[index]!)));
    for (let i = 0; i < descKeys.length; i += 1) {
      for (let j = i + 1; j < descKeys.length; j += 1) {
        const left = descKeys[i]!;
        const right = descKeys[j]!;
        if (!left || !right) continue;
        if (left === right || textBigramDice(left, right) >= 0.85) clusterParent[findCluster(i)] = findCluster(j);
      }
    }
    const clusterSizes = new Map<number, number>();
    for (let i = 0; i < descKeys.length; i += 1) {
      if (!descKeys[i]) continue;
      const root = findCluster(i);
      clusterSizes.set(root, (clusterSizes.get(root) ?? 0) + 1);
    }
    const duplicateClusters = [...clusterSizes.values()].filter((size) => size > 1).length;
    const foreshadowingLedger = {
      total: ledgerFlows.length,
      open: ledgerFlows.filter((row) => row.status === "open").length,
      fulfilled: ledgerFlows.filter((row) => row.status === "fulfilled").length,
      overdue: windowElapsed.length,
      unbound: unboundOpen.length,
      fulfilledWithoutPayoff: fulfilledWithoutPayoff.length,
      arcOrphan: arcOrphans.length,
      duplicateClusters,
    };
    const ledgerIssues: StoryArcIntegrityIssue[] = [];
    if (foreshadowingLedger.fulfilledWithoutPayoff > 0) ledgerIssues.push({ code: "ledger-inconsistency", severity: "blocking", message: `${foreshadowingLedger.fulfilledWithoutPayoff} 条伏笔标记已兑现但兑现账（payoffs）无行：兑现入口失控，需按单入口重建或补登证据` });
    // 窗口上界已过是**中性事实**，不报为问题（2026-09-18 P1 修正）：
    // 对连载而言，长线伏笔的上界过期而线索仍在推进是常态（实测 238/244）。
    // 旧行为把它报成 warning 并指示"兑现/改写/放弃"，指挥作者处理 238 条不存在的问题。
    // 需要行动的信号是"曾活跃→静默终止"，由 narrative-dormancy 通道给出。
    if (duplicateClusters > 0) ledgerIssues.push({ code: "foreshadowing-duplicate", severity: "warning", message: `${duplicateClusters} 簇伏笔描述跨来源重复（每轮重抽取换措辞即多行）：需按锚点归并` });
    if (arcOrphans.length > 0) ledgerIssues.push({ code: "foreshadowing-arc-orphan", severity: "warning", message: `${arcOrphans.length} 条伏笔的引用弧已不存在/被弃：需作者决定重挂或关闭` });
    // PL-8：approved-but-stale-contract——以"当前契约实时校验"为真相判定：approved 段在
    // 今天不再满足契约（键名漂移、类型不符、内容缺陷）即须重审。批准时落的 contractVersion
    // 指纹提供演进痕迹；旧段无版本时以实时校验兜底（通过=与当前契约兼容，不制造噪声）。
    const staleContracts: string[] = [];
    for (const section of sections.rows) {
      if (section.status !== "approved") continue;
      if (!foundationContractFingerprint(section.task_key)) continue;
      if (String(section.payload?.contractVersion ?? "") === foundationContractFingerprint(section.task_key)) continue;
      if (validateFoundationTaskContract(section.payload as unknown as FoundationOutput, section.task_key).length) staleContracts.push(section.task_key);
    }
    const contractIssues: StoryArcIntegrityIssue[] = staleContracts.length
      ? [{ code: "stale-foundation-contract", severity: "warning", message: `${staleContracts.length} 个 approved 段（${staleContracts.join("、")}）批准时的契约版本与当前不一致：需重审后重新批准以刷新 contractVersion` }]
      : [];
    // PL-6 连载健康度（B5）：跨弧空窗天数 = 前一 completed 弧收口 → 下一弧批准的间隔；
    // 规划失败数 = story-arc-planning 工作流 failed 终态计数。两者都是**可见性指标**，
    // 不限制单批章数——批量生成是合法模式，失控的是"无人知道断更与反复失败"，不是批量本身。
    const serializationGaps: Array<{ fromArcId: string; toArcId: string; gapDays: number }> = [];
    for (let index = 1; index < arcs.rows.length; index += 1) {
      const previous = arcs.rows[index - 1]!;
      const current = arcs.rows[index]!;
      if (!previous.completed_at || !current.approved_at) continue;
      const gapDays = Math.round((new Date(current.approved_at).getTime() - new Date(previous.completed_at).getTime()) / 86_400_000);
      if (Number.isFinite(gapDays)) serializationGaps.push({ fromArcId: previous.id, toArcId: current.id, gapDays });
    }
    // TODO(magic-value): 7 天=周更连载基线，超过即断更风险；应按项目连载节奏配置化。
    const serializationIssues: StoryArcIntegrityIssue[] = serializationGaps.filter((gap) => gap.gapDays > 7)
      .map((gap) => ({ code: "serialization-gap" as const, severity: "warning" as const, reference: gap.toArcId, message: `弧 ${gap.fromArcId} 收口后 ${gap.gapDays} 天才批准弧 ${gap.toArcId}：跨弧空窗超过周更基线，连载断更风险` }));
    const planningRunStatuses = Object.fromEntries(arcPlanningRuns.rows.map((row) => [row.status, Number(row.count)]));
    const planningFailures = planningRunStatuses.failed ?? 0;
    if (planningFailures > 0) serializationIssues.push({ code: "arc-planning-failures", severity: "warning", message: `story-arc-planning 工作流累计 ${planningFailures} 次 failed（总 ${arcPlanningRuns.rows.reduce((sum, row) => sum + Number(row.count), 0)} 次）：规划失败重试是稳定性信号，需回看失败原因是否已消除` });
    // PL-6 阶段绑定覆盖率：有阶段的弧若章节无 chapterOrdinals 绑定，阶段归属不可用
    //（旧等分推算已删除——宁缺毋伪），提示补绑而非静默失真。
    const phaseBindingIssues: StoryArcIntegrityIssue[] = arcs.rows.filter((arc) => {
      const phases = Array.isArray(arc.payload?.phases) ? arc.payload.phases : [];
      if (!phases.length) return false;
      const bound = new Set(phases.flatMap((phase: { chapterOrdinals?: number[] }) => phase.chapterOrdinals ?? []));
      return bound.size === 0;
    }).map((arc) => ({ code: "phase-binding-missing" as const, severity: "warning" as const, reference: arc.id, message: `弧 ${arc.id} 有 ${Array.isArray(arc.payload?.phases) ? arc.payload.phases.length : 0} 个阶段但均未绑定 chapterOrdinals：章节所属阶段不可判定（等分推算已删除），需 rebase 或作者回写绑定` }));
    // D5 情感契约承载核对（product-audit-20260910 Batch 5）：整书声明了情绪回报契约，
    // 却没有任何一章按章功能被指派交付它＝口号账。判据只用既有规划事实（章节蓝图的
    // narrativeFunction 投影），不新增可由模型随口填写的字段；作者的 notApplicable
    // 是合法退出而非漏写，不报。
    // 取值只认 `structuredData.emotionalContract`——那是 foundation 契约校验的字段位置
    //（foundation-contract.ts 的 section schema 与 validateNotApplicableAnnotation 都读这里）。
    // 运行库实测：同一份 payload 里该值还出现在 `creativeBrief.emotionalContract`（简报投影），
    // 顶层则没有；曾按顶层键取值得到 declared=false，判据在真实项目上静默空转，
    // 而自造同形夹具的测试照样全绿——夹具必须照库内实形写，不能照实现的假设写。
    const positioningSection = sections.rows.find((section) => section.task_key === "project-positioning");
    const emotionalContractValue = (positioningSection?.payload?.structuredData as Record<string, unknown> | undefined)?.emotionalContract;
    const emotionalContractDeclared = typeof emotionalContractValue === "string"
      ? emotionalContractValue.trim().length > 0
      : Boolean(emotionalContractValue && typeof emotionalContractValue === "object" && (emotionalContractValue as Record<string, unknown>).notApplicable !== true);
    const emotionalCarrierIssues = auditEmotionalContractCarriage({
      emotionalContractDeclared,
      arcs: arcs.rows.map((arc) => ({
        id: arc.id,
        ordinal: Number(arc.ordinal),
        chapters: chapters.rows.filter((chapter) => chapter.arc_id === arc.id).map((chapter) => ({ ordinal: Number(chapter.ordinal), narrativeFunction: chapter.narrative_function ?? undefined })),
      })),
    });
    // F3：pending 投影失败必须自己出现在健康度里。提交链路对它的处理是"warn + 记账后继续"，
    // 账若无人读，丢掉的伏笔/承诺/快照就是永久静默损失。
    const projectionFailureIssues: StoryArcIntegrityIssue[] = projectionFailures.rows.map((row) => ({
      code: "projection-failure-pending" as const,
      severity: "warning" as const,
      reference: `${row.projection_type}:${row.aggregate_id}`,
      message: `${row.projection_type} 投影失败待处理（已试 ${Number(row.attempts)} 次，${iso(row.updated_at)}）：${row.error_message ?? "无错误文本"}`,
    }));
    const issues: StoryArcIntegrityIssue[] = [
      ...hygieneIssues,
      ...completionIssues,
      ...projectionFailureIssues,
      ...ledgerIssues,
      ...contractIssues,
      ...serializationIssues,
      ...phaseBindingIssues,
      ...emotionalCarrierIssues,
      ...batchReports.flatMap((report) => report.issues.map((issue) => ({ ...issue, message: `${report.arcId}: ${issue.message}` }))),
      ...referenceReports.flatMap((report) => [
        ...report.plotThreads.issues.map((issue) => ({ ...issue, message: `${report.arcId}: 剧情线${issue.message}` })),
        ...report.foreshadowing.issues.map((issue) => ({ ...issue, message: `${report.arcId}: 伏笔${issue.message}` })),
      ]),
    ];
    const required = REQUIRED_APPROVED_PLAN_TASK_KEYS.map((taskKey) => ({ taskKey, approved: sections.rows.some((section) => section.task_key === taskKey && section.status === "approved") }));
    const finalChapters = chapters.rows.filter((chapter) => chapter.document_status === "final" && Boolean(chapter.current_revision_id)).length;
    const foundationData = Object.fromEntries(sections.rows.map((section) => {
      const structuredData = section.payload?.structuredData;
      const root = structuredData && typeof structuredData === "object" && !Array.isArray(structuredData) ? structuredData as Record<string, unknown> : {};
      return [section.task_key, normalizeFoundationStructuredDataFlat(root, section.task_key)];
    }));
    const fullBookArchitecture = auditFullBookArchitecture({
      architecture: foundationData.architecture,
      characters: Array.isArray(foundationData.characters) ? { characters: foundationData.characters } : foundationData.characters,
      worldview: foundationData.worldview,
      plotStrategy: foundationData["plot-design"],
    });
    return {
      projectId,
      projectTitle: project.rows[0].title,
      runtime: { protocolVersion: "2.0", foundationStageCount: PROJECT_PLAN_STAGES.length },
      foundation: { required, missing: required.filter((item) => !item.approved).map((item) => item.taskKey), staleContract: staleContracts },
      arcs: arcs.rows.map((arc) => ({ id: arc.id, ordinal: Number(arc.ordinal), planningStatus: arc.planning_status, executionStatus: arc.execution_status })),
      chapters: (() => {
        const arcPlanningStatus = new Map(arcs.rows.map((arc) => [arc.id, arc.planning_status]));
        const planned = chapters.rows.filter((chapter) => !chapter.document_id || chapter.document_status === "planned").length;
        const orphaned = chapters.rows.filter((chapter) => {
          if (!chapter.arc_id) return true;
          if (chapter.document_id && !chapter.document_status) return true;
          return !chapter.document_id && arcPlanningStatus.get(chapter.arc_id) === "approved";
        }).length;
        return { total: chapters.rowCount ?? 0, final: finalChapters, planned, orphaned };
      })(),
      batches: batchReports,
      references: referenceReports,
      foreshadowingLedger,
      serialization: { gaps: serializationGaps, planningRunStatuses },
      projectionFailures: {
        pending: Number(projectionFailures.rows[0]?.total ?? 0),
        oldestAt: projectionFailures.rows[0] ? iso(projectionFailures.rows[0].updated_at) : undefined,
        details: projectionFailures.rows.map((row) => ({ projectionType: row.projection_type, aggregateId: row.aggregate_id, attempts: Number(row.attempts) })),
      },
      fullBookArchitecture,
      issues,
    };
  }

  /**
   * Convert legacy story-arc labels into project-scoped canonical records.
   * Unknown labels become author-visible records instead of being silently lost.
   */
  async normalizeStoryArcReferences(projectId: string, arcId: string, actor = "web-author") {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const arcResult = await client.query<{ payload: NarrativeArcPlan }>("SELECT payload FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [arcId, projectId]);
      if (!arcResult.rowCount) throw new Error("故事弧不存在");
      const [threads, foreshadowing] = await Promise.all([
        client.query<{ id: string; title: string; payload: Record<string, unknown> }>("SELECT id,title,payload FROM plot_threads WHERE project_id=$1 ORDER BY id", [projectId]),
        client.query<{ id: string; payload: Record<string, unknown> }>("SELECT id,payload FROM foreshadowing WHERE project_id=$1 ORDER BY id", [projectId]),
      ]);
      const labels = (payload: Record<string, unknown> | undefined): string[] => {
        if (!payload) return [];
        return [payload.name, payload.title, payload.description, payload.label, payload.aliases, payload.names].flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []);
      };
      const created: string[] = [];
      const unresolved: Array<{ kind: "thread" | "foreshadowing"; input: string }> = [];
      const mappings: Array<{ kind: "thread" | "foreshadowing"; input: string; canonicalId: string; created: boolean }> = [];
      const normalize = async (kind: "thread" | "foreshadowing", values: unknown[], candidates: NamedReferenceCandidate[]): Promise<string[]> => {
        const result: string[] = [];
        for (const value of values) {
          if (typeof value !== "string" || !value.trim()) continue;
          // PL-2（product-audit-20260910 A4）：取消未知名静默 auto-create——引用字符串
          // 自我放大成影子对象（title=输入原样）的根因。新对象只能经**显式新建通道**
          // （`new:<名称>` 前缀）表达；其余未解析引用收集为 blocking 回流 planner。
          // 复合串自愈与序号前缀剥离由 resolveNamedReference/sanitizeReferenceToken 共享层完成。
          const explicitNew = parseExplicitNewReference(value);
          const resolution = explicitNew ? undefined : resolveNamedReference(sanitizeReferenceToken(value), candidates);
          if (resolution?.status === "ambiguous") throw new Error(`引用“${value}”匹配多个${kind === "thread" ? "剧情线" : "伏笔"}：${resolution.candidateIds.join("、")}`);
          if (resolution?.status === "resolved" && resolution.canonicalId) {
            result.push(resolution.canonicalId);
            mappings.push({ kind, input: value, canonicalId: resolution.canonicalId, created: false });
            continue;
          }
          const label = sanitizeReferenceToken(explicitNew ? explicitNew.name : value);
          if (!explicitNew || !label) {
            unresolved.push({ kind, input: value });
            continue;
          }
          const id = canonicalReferenceId(kind, projectId, label);
          if (kind === "thread") {
            await client.query(
              `INSERT INTO plot_threads(id,project_id,title,status,payload)
               VALUES($1,$2,$3,'open',$4)
               ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,payload=plot_threads.payload || EXCLUDED.payload`,
              [id, projectId, label, { aliases: [label], source: "story-arc-reference", sourceArcId: arcId, explicitNew: true }],
            );
          } else {
            await client.query(
              `INSERT INTO foreshadowing(id,project_id,status,payload)
               VALUES($1,$2,'open',$3)
               ON CONFLICT(id) DO UPDATE SET payload=foreshadowing.payload || EXCLUDED.payload`,
              [id, projectId, { description: label, aliases: [label], source: "story-arc-reference", sourceArcId: arcId, explicitNew: true }],
            );
          }
          created.push(id);
          result.push(id);
          mappings.push({ kind, input: value, canonicalId: id, created: true });
          // 显式新建的原始表达（含 new: 前缀）登记为别名：responsibilities 的二次解析
          // 与后续弧对该名称的引用都能直接命中这个规范对象。
          candidates.push({ id, labels: [label, value.trim()] });
        }
        return [...new Set(result)];
      };
      const payload = arcResult.rows[0].payload ?? {};
      const rawPayload = payload as unknown as Record<string, unknown>;
      const threadCandidates = threads.rows.map((row) => ({ id: row.id, labels: [row.title, ...labels(row.payload)] }));
      const originalResponsibilities = Array.isArray(payload.threadResponsibilities) ? payload.threadResponsibilities : [];
      if (Object.prototype.hasOwnProperty.call(rawPayload, "plotThreadRefs")) {
        throw new Error("故事弧仍包含已删除的 plotThreadRefs；请按当前契约重新生成并审核故事弧");
      }
      // 根因修复（2026-08-07）：此前 threadResponsibilities 只走 normalizeThreadResponsibilityReferences
      //（unresolved 保持原值、不创建项目对象），导致 plot_threads 表中没有对应剧情线时，弧审批的
      // 引用完整性门禁永远判 blocking。此处先用 normalize("thread", ...) 物化缺失的剧情线对象
      //（创建逻辑已存在，与 foreshadowing 一致），再解析 responsibilities 得到 canonicalId。
      const threadRefsToNormalize = originalResponsibilities
        .map((responsibility) => (responsibility && typeof responsibility === "object" && typeof (responsibility as unknown as Record<string, unknown>).threadRef === "string" ? (responsibility as unknown as Record<string, unknown>).threadRef as string : undefined))
        .filter((ref): ref is string => Boolean(ref && ref.trim()));
      await normalize("thread", threadRefsToNormalize, threadCandidates);
      const threadResponsibilities = normalizeThreadResponsibilityReferences(
        originalResponsibilities,
        threadCandidates,
      );
      threadResponsibilities.forEach((responsibility, index) => {
        const original = originalResponsibilities[index];
        if (original && original.threadRef !== responsibility.threadRef) {
          mappings.push({ kind: "thread", input: original.threadRef, canonicalId: responsibility.threadRef, created: created.includes(responsibility.threadRef) });
        }
      });
      const foreshadowingRefs = await normalize("foreshadowing", Array.isArray(payload.foreshadowingRefs) ? payload.foreshadowingRefs : [], foreshadowing.rows.map((row) => ({ id: row.id, labels: labels(row.payload) })));
      if (unresolved.length) {
        // blocking 回流（PL-2 修复②）：错误文本即可执行审核意见，planner 重新生成时
        // 要么改用现有对象 id，要么显式 new: 新建——不再有静默影子对象。
        throw new Error(`故事弧引用无法解析（${unresolved.length} 处）：${unresolved.map((item) => `${item.kind === "thread" ? "剧情线" : "伏笔"}“${item.input}”`).join("、")}。引用既有对象请使用其 id 或登记名原文；确需新建对象请显式输出“new:<名称>”前缀。`);
      }
      const normalizedPayload = { ...rawPayload, threadResponsibilities, foreshadowingRefs };
      validateStoryArcPlanContracts(parseStoryArcPlan(normalizedPayload));
      await client.query("UPDATE arcs SET payload=$3,updated_at=now() WHERE id=$1 AND project_id=$2", [arcId, projectId, normalizedPayload]);
      // PL-5 修复④ 的判据面收口（2026-09-19）：归属证据由线程自己声明，不再从共现推断
      //（旧"恰好一条线程才绑"判据在真实数据上恒不命中——24 条弧全部并行 4-7 条线，
      //  全表 thread_id 绑定 0 行，见 product-audit-20260910 §五）。认领引用先经本弧
      //  同一次归一的 raw→canonical 映射翻译，避免第二套解析真源；账外认领按 blocking
      //  回流 planner（不静默丢弃，也不新建对象）。
      const canonicalByRawRef = new Map(mappings.filter((mapping) => mapping.kind === "foreshadowing").map((mapping) => [mapping.input, mapping.canonicalId]));
      const threadBindings = planThreadForeshadowingBindings({
        arcForeshadowingRefs: foreshadowingRefs,
        responsibilities: threadResponsibilities.map((responsibility) => ({
          threadRef: responsibility.threadRef,
          foreshadowingRefs: (responsibility.foreshadowingRefs ?? []).map((ref) => canonicalByRawRef.get(ref) ?? ref),
        })),
      });
      if (threadBindings.violations.length) {
        throw new Error(`剧情线认领了本弧伏笔账之外的引用（${threadBindings.violations.length} 处）：${threadBindings.violations.map((violation) => `线程“${violation.threadRef}”→“${violation.input}”`).join("、")}。线程的 foreshadowingRefs 只能填本弧 foreshadowingRefs 中已出现的引用；确属新增伏笔请先登记进弧级账。`);
      }
      for (const binding of threadBindings.bindings) {
        await client.query(
          `UPDATE foreshadowing SET thread_id=$2
           WHERE project_id=$1 AND id=ANY($3::text[]) AND thread_id IS NULL AND status='open'`,
          [projectId, binding.threadId, binding.foreshadowingIds],
        );
      }
      // 兜底保持原语义：无认领信息（旧弧/旧 planner 输出）时，仍只在本弧恰好一条线程责任
      // 时才绑；多线程弧留空交人工/弧审核。planted_revision 归属的弧不在此处理。
      const arcThreadRefs = [...new Set(threadResponsibilities.map((responsibility) => responsibility.threadRef).filter(Boolean))];
      if (!threadBindings.bindings.length && arcThreadRefs.length === 1 && foreshadowingRefs.length) {
        await client.query(
          `UPDATE foreshadowing SET thread_id=$2
           WHERE project_id=$1 AND id=ANY($3::text[]) AND thread_id IS NULL AND status='open'`,
          [projectId, arcThreadRefs[0], foreshadowingRefs],
        );
      }
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.references-normalized','story-arc',$3,$4)",
        [projectId, actor, arcId, { mappings, created: [...new Set(created)], threadBindings: threadBindings.bindings, threadBindingAmbiguous: threadBindings.ambiguous }],
      );
      await client.query("COMMIT");
      return { arc: await this.getStoryArc(projectId, arcId), mappings, created: [...new Set(created)] };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reconcile legacy overlapping batches only when the later batch has no
   * chapter ownership. Non-empty overlaps remain visible for author review.
   */
  async reconcileStoryArcBatchRanges(projectId: string, arcId: string, actor = "web-author") {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batches = await client.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2 ORDER BY start_chapter_index,batch_index FOR UPDATE", [arcId, projectId]);
      const ranges = batches.rows.map((batch) => ({ batchIndex: Number(batch.batch_index), startChapterIndex: Number(batch.start_chapter_index), endChapterIndex: Number(batch.end_chapter_index), status: batch.status }));
      const activeRanges = ranges.filter((range) => range.status !== "failed");
      const reconciled: number[] = [];
      const unresolved: StoryArcIntegrityIssue[] = [];
      let previous = activeRanges[0];
      for (let index = 1; index < activeRanges.length; index += 1) {
        const current = activeRanges[index];
        if (current.startChapterIndex > previous.endChapterIndex) {
          previous = current;
          continue;
        }
        const currentRow = batches.rows.find((batch) => Number(batch.batch_index) === current.batchIndex);
        if (!currentRow || currentRow.status !== "approved") {
          if (current.endChapterIndex > previous.endChapterIndex) previous = current;
          continue;
        }
        const owned = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM chapters WHERE batch_id=$1", [currentRow.id]);
        if (Number(owned.rows[0]?.count ?? 0) === 0) {
          await client.query(
            "UPDATE story_arc_batches SET status='failed',payload=payload || $3,updated_at=now() WHERE id=$1 AND project_id=$2",
            [currentRow.id, projectId, { reconciled: true, reconciliationReason: "overlapping-empty-batch" }],
          );
          reconciled.push(current.batchIndex);
        } else {
          unresolved.push({ code: "overlapping-batch", severity: "blocking", batchIndex: current.batchIndex, message: `批次 ${previous.batchIndex} 与批次 ${current.batchIndex} 重叠且后者仍拥有章节` });
          if (current.endChapterIndex > previous.endChapterIndex) previous = current;
        }
      }
      if (reconciled.length) {
        await client.query(
          "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc-batches.reconciled','story-arc',$3,$4)",
          [projectId, actor, arcId, { reconciled, unresolved }],
        );
      }
      await client.query("COMMIT");
      return { arc: await this.getStoryArc(projectId, arcId), reconciled, unresolved };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getStoryArc(projectId: string, arcId: string): Promise<StoryArcRecord | undefined> {
    const [arcResult, chapterResult, batchResult] = await Promise.all([
      this.pool.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2", [arcId, projectId]),
      this.pool.query<ChapterBlueprintRow>(
        `SELECT c.id,c.arc_id,c.project_id,c.document_id,c.title,c.ordinal,c.status,c.payload,c.source_artifact_id,c.blueprint_revision,
                d.status AS document_status,d.current_revision_id AS document_current_revision_id
         FROM chapters c
         LEFT JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
         WHERE c.arc_id=$1 AND c.project_id=$2
         ORDER BY c.ordinal`,
        [arcId, projectId],
      ),
      this.pool.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2 ORDER BY batch_index", [arcId, projectId]),
    ]);
    const row = arcResult.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      volumeId: row.volume_id,
      ordinal: Number(row.ordinal),
      planningStatus: row.planning_status,
      executionStatus: row.execution_status,
      arc: parseStoryArcPlan(row.payload),
      chapters: chapterResult.rows.map(chapterBlueprintFromRow),
      batches: batchResult.rows.map((batch) => ({ id: batch.id, arcId: batch.arc_id, projectId: batch.project_id, batchIndex: Number(batch.batch_index), startChapterIndex: Number(batch.start_chapter_index), endChapterIndex: Number(batch.end_chapter_index), complete: batch.payload?.complete === true, status: batch.status, entryFingerprint: batch.entry_fingerprint, sourceArtifactId: batch.source_artifact_id ?? undefined, approvedAt: batch.approved_at ? iso(batch.approved_at) : undefined })),
      sourceArtifactId: row.source_artifact_id ?? undefined,
      blueprintArtifactId: row.blueprint_artifact_id ?? undefined,
      contextFingerprint: row.context_fingerprint ?? undefined,
      reviewArtifactId: row.review_artifact_id ?? undefined,
      reviewFingerprint: row.review_fingerprint ?? undefined,
      editRevision: Number(row.edit_revision),
      approvedAt: row.approved_at ? iso(row.approved_at) : undefined,
      completedAt: row.completed_at ? iso(row.completed_at) : undefined,
      abandonedAt: row.abandoned_at ? iso(row.abandoned_at) : undefined,
      updatedAt: iso(row.updated_at),
    };
  }

  async deleteStoryArc(projectId: string, arcId: string, actor: string, options: { force?: boolean } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const arc = await client.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [arcId, projectId]);
      if (!arc.rowCount) throw new Error("故事弧不存在");
      const chapters = await client.query<{ id: string; document_id: string | null; document_status: string | null; current_revision_id: string | null; revision_count: string; narrative_order: string | number | null }>(
        "WITH locked_chapters AS (SELECT * FROM chapters WHERE arc_id=$1 AND project_id=$2 FOR UPDATE) " +
        "SELECT c.id,c.document_id,d.status AS document_status,d.current_revision_id,d.narrative_order,COUNT(mr.id)::text AS revision_count " +
        "FROM locked_chapters c " +
        "LEFT JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id " +
        "LEFT JOIN manuscript_revisions mr ON mr.document_id=d.id " +
        "GROUP BY c.id,c.document_id,d.status,d.current_revision_id,d.narrative_order ",
        [arcId, projectId],
      );
      const protectedChapter = chapters.rows.find((chapter) => chapter.current_revision_id || Number(chapter.revision_count) > 0 || (chapter.document_id && chapter.document_status !== "planned"));
      if (protectedChapter && !options.force) throw new Error("故事弧已关联进入创作或已有正文的章节，不能删除；请使用放弃故事弧保留历史");
      const documentIds = [...new Set(chapters.rows.flatMap((chapter) => chapter.document_id ? [chapter.document_id] : []))];
      const chapterIds = chapters.rows.map((chapter) => chapter.id);
      const narrativeOrders = chapters.rows.flatMap((chapter) => chapter.narrative_order === null || chapter.narrative_order === undefined ? [] : [Number(chapter.narrative_order)]);
      const minNarrativeOrder = narrativeOrders.length ? Math.min(...narrativeOrders) : null;
      const maxNarrativeOrder = narrativeOrders.length ? Math.max(...narrativeOrders) : null;
      let removedRevisionIds: string[] = [];
      let removedMemoryClaimIds: string[] = [];
      let removedChapterMemoryIds: string[] = [];
      let cancelledWorkflowIds: string[] = [];

      if (options.force) {
        const workflows = await client.query<{ id: string; temporal_workflow_id: string }>(
          `SELECT id,temporal_workflow_id
           FROM workflow_runs
           WHERE project_id=$1
             AND (
               payload->>'arcId'=$2
               OR payload->>'documentId'=ANY($3::text[])
               OR payload #>> '{intent,target,id}' = ANY($3::text[])
             )
           FOR UPDATE`,
          [projectId, arcId, documentIds],
        );
        cancelledWorkflowIds = workflows.rows.map((row) => row.temporal_workflow_id);
        if (workflows.rowCount) {
          await client.query(
            `UPDATE workflow_runs
             SET status='cancelled',
                 payload=payload || $3::jsonb,
                 updated_at=now()
             WHERE project_id=$1 AND id=ANY($2::text[])`,
            [projectId, workflows.rows.map((row) => row.id), JSON.stringify({ cancelledBy: "story-arc.force-delete", arcId, documentIds })],
          );
        }
      }

      if (options.force && documentIds.length) {
        const revisionRows = await client.query<{ id: string; content_hash: string }>(
          "SELECT id,content_hash FROM manuscript_revisions WHERE project_id=$1 AND document_id=ANY($2::text[]) FOR UPDATE",
          [projectId, documentIds],
        );
        removedRevisionIds = revisionRows.rows.map((row) => row.id);
        const contentHashes = [...new Set(revisionRows.rows.map((row) => row.content_hash))];

        const chapterMemoryRows = await client.query<{ id: string }>(
          `SELECT id FROM chapter_memories
           WHERE project_id=$1
             AND (document_id=ANY($2::text[]) OR revision_id=ANY($3::text[]))`,
          [projectId, documentIds, removedRevisionIds],
        );
        removedChapterMemoryIds = chapterMemoryRows.rows.map((row) => row.id);

        const directClaimRows = await client.query<{ id: string }>(
          `SELECT id FROM memory_claims
           WHERE project_id=$1
             AND (
               source_document_id=ANY($2::text[])
               OR source_revision_ids && $3::text[]
             )`,
          [projectId, documentIds, removedRevisionIds],
        );
        const rollupClaimRows = await client.query<{ id: string }>(
          `SELECT id FROM memory_claims
           WHERE project_id=$1
             AND predicate='chapter-memory-rollup'
             AND (
               source_revision_ids && $2::text[]
               OR ($3::bigint IS NOT NULL AND narrative_start <= $4::bigint AND COALESCE(narrative_end,narrative_start) >= $3::bigint)
             )`,
          [projectId, removedRevisionIds, minNarrativeOrder, maxNarrativeOrder],
        );
        const removedSourceRows = await client.query<{ claim_id: string }>(
          `DELETE FROM memory_claim_sources
           WHERE project_id=$1
             AND (document_id=ANY($2::text[]) OR revision_id=ANY($3::text[]))
           RETURNING claim_id`,
          [projectId, documentIds, removedRevisionIds],
        );
        const affectedClaimIds = [...new Set([...directClaimRows.rows.map((row) => row.id), ...removedSourceRows.rows.map((row) => row.claim_id)])];
        if (affectedClaimIds.length) {
          await client.query(
            `UPDATE memory_claims claim SET
               ${CLAIM_PROJECTION_SET_SQL},
               source_document_id=(
                 SELECT source.document_id FROM memory_claim_sources source
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active' AND source.document_id IS NOT NULL
                 ORDER BY source.created_at DESC LIMIT 1
               )
             WHERE claim.project_id=$1 AND claim.id=ANY($2::text[])`,
            [projectId, affectedClaimIds],
          );
          const deletedClaims = await client.query<{ id: string }>(
            `DELETE FROM memory_claims claim
             WHERE claim.project_id=$1
               AND claim.id=ANY($2::text[])
               AND NOT EXISTS (
                 SELECT 1 FROM memory_claim_sources source
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active'
               )
             RETURNING id`,
            [projectId, affectedClaimIds],
          );
          removedMemoryClaimIds.push(...deletedClaims.rows.map((row) => row.id));
        }
        const rollupClaimIds = rollupClaimRows.rows.map((row) => row.id);
        if (rollupClaimIds.length) {
          await client.query("DELETE FROM memory_claim_sources WHERE project_id=$1 AND claim_id=ANY($2::text[])", [projectId, rollupClaimIds]);
          const deletedRollups = await client.query<{ id: string }>("DELETE FROM memory_claims WHERE project_id=$1 AND id=ANY($2::text[]) RETURNING id", [projectId, rollupClaimIds]);
          removedMemoryClaimIds.push(...deletedRollups.rows.map((row) => row.id));
        }

        // 删除 claim 必须同时摘掉**别的行** supersedes 数组里指向它的死引用
        // （2026-10-14 复核轮 round 21 实测：生产库 34 个 killer 攒了 94 条悬空引用，
        // 全部来自这个删除块的两处 DELETE 只删行、不清引用）。
        // 为什么必须清：`retiredByVisibleKillerSql` 用 `alias.id = ANY(killer.supersedes)`
        // 判定"是否已被可见 killer 覆盖"。悬空引用**不影响检索正确性**（匹配不到任何行），
        // 但会让任何走 supersedes 链的核查/统计看到幽灵目标——本轮自己的取证脚本首版
        // 就因此报出"94 条悬空"，而真实结论是"覆盖关系部分失效、检索无恙"。
        // 且数组只增不减，长期累积。放在同一事务内，删除与清理原子。
        if (removedMemoryClaimIds.length) {
          const stripped = await client.query<{ id: string }>(
            `UPDATE memory_claims survivor
                SET supersedes = (
                  SELECT coalesce(array_agg(entry ORDER BY entry), '{}'::text[])
                  FROM unnest(survivor.supersedes) AS entry
                  WHERE entry <> ALL($2::text[])
                )
              WHERE survivor.project_id = $1
                AND survivor.id <> ALL($2::text[])
                AND survivor.supersedes && $2::text[]
              RETURNING survivor.id`,
            [projectId, removedMemoryClaimIds],
          );
          if (stripped.rows.length) {
            console.warn(`[memory-governance] 清理 ${stripped.rows.length} 行里指向已删 claim 的死 supersedes 引用（删除 ${removedMemoryClaimIds.length} 行）`);
          }
        }

        if (removedRevisionIds.length) {
          // v1 遗留 `facts`/`fact_sources` 的清理分支已随迁移 095 撤表移除：两表在运行库与测试库
          // 都恒 0 行（真源早已是 memory_claims/memory_claim_sources），留着这段反而会在回滚路径上
          // 抛 `relation "facts" does not exist` 把一次正常回滚变成失败。
          await client.query("UPDATE promises SET status='open' WHERE id IN (SELECT promise_id FROM payoffs WHERE revision_id=ANY($1::text[]) AND promise_id IS NOT NULL)", [removedRevisionIds]);
          await client.query("UPDATE foreshadowing SET status='open',payoff_revision_id=NULL WHERE project_id=$1 AND payoff_revision_id=ANY($2::text[])", [projectId, removedRevisionIds]);
          await client.query("DELETE FROM payoffs WHERE revision_id=ANY($1::text[])", [removedRevisionIds]);
          await client.query("DELETE FROM foreshadowing WHERE project_id=$1 AND planted_revision_id=ANY($2::text[])", [projectId, removedRevisionIds]);
          await client.query("DELETE FROM promises WHERE project_id=$1 AND source_revision_id=ANY($2::text[])", [projectId, removedRevisionIds]);
          await client.query("DELETE FROM timeline_events WHERE project_id=$1 AND source_revision_id=ANY($2::text[])", [projectId, removedRevisionIds]);
          await client.query("DELETE FROM relations WHERE project_id=$1 AND source_revision_id=ANY($2::text[])", [projectId, removedRevisionIds]);
          await client.query("DELETE FROM narrative_state_snapshots WHERE project_id=$1 AND (document_id=ANY($2::text[]) OR revision_id=ANY($3::text[]))", [projectId, documentIds, removedRevisionIds]);
        }
        await client.query("DELETE FROM chapter_memories WHERE project_id=$1 AND (document_id=ANY($2::text[]) OR revision_id=ANY($3::text[]))", [projectId, documentIds, removedRevisionIds]);
        await client.query("DELETE FROM chapter_review_snapshot_issues WHERE snapshot_id IN (SELECT id FROM chapter_review_snapshots WHERE project_id=$1 AND document_id=ANY($2::text[]))", [projectId, documentIds]);
        await client.query("DELETE FROM chapter_review_snapshots WHERE project_id=$1 AND document_id=ANY($2::text[])", [projectId, documentIds]);
        await client.query("DELETE FROM chapter_production_specs WHERE project_id=$1 AND document_id=ANY($2::text[])", [projectId, documentIds]);
        await client.query("DELETE FROM chapter_planning_contexts WHERE project_id=$1 AND (arc_id=$2 OR document_id=ANY($3::text[]) OR chapter_blueprint_id=ANY($4::text[]))", [projectId, arcId, documentIds, chapterIds]);
        if (removedRevisionIds.length) await client.query("DELETE FROM manuscript_revisions WHERE project_id=$1 AND id=ANY($2::text[])", [projectId, removedRevisionIds]);
        if (contentHashes.length) await client.query("DELETE FROM content_blobs cb WHERE cb.content_hash=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.content_hash=cb.content_hash)", [contentHashes]);
      }
      await client.query("DELETE FROM scenes WHERE chapter_id IN (SELECT id FROM chapters WHERE arc_id=$1 AND project_id=$2)", [arcId, projectId]);
      await client.query("DELETE FROM chapters WHERE arc_id=$1 AND project_id=$2", [arcId, projectId]);
      if (documentIds.length) {
        const documentDeleteClause = options.force ? "" : " AND status='planned' AND current_revision_id IS NULL";
        await client.query(`DELETE FROM manuscript_documents WHERE project_id=$1 AND id=ANY($2::text[])${documentDeleteClause}`, [projectId, documentIds]);
      }
      await client.query("DELETE FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2", [arcId, projectId]);
      const deleted = await client.query("DELETE FROM arcs WHERE id=$1 AND project_id=$2 RETURNING id", [arcId, projectId]);
      removedMemoryClaimIds = [...new Set(removedMemoryClaimIds)];
      removedChapterMemoryIds = [...new Set(removedChapterMemoryIds)];
      removedRevisionIds = [...new Set(removedRevisionIds)];
      cancelledWorkflowIds = [...new Set(cancelledWorkflowIds)];
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.deleted','story-arc',$3,$4)",
        [projectId, actor, arcId, { title: arc.rows[0].title, force: options.force === true, chapterCount: chapters.rowCount, documentIds, revisionIds: removedRevisionIds, memoryClaimIds: removedMemoryClaimIds, chapterMemoryIds: removedChapterMemoryIds, cancelledWorkflowIds }],
      );
      await client.query("COMMIT");
      return { deleted: Boolean(deleted.rowCount), projectId, arcId, force: options.force === true, removedDocumentIds: documentIds, removedRevisionIds, removedMemoryClaimIds, removedChapterMemoryIds, cancelledWorkflowIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareNextStoryArcBatch(projectId: string, arcId: string): Promise<{ batchIndex: number; startChapterIndex: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertNoActiveStoryArcWorkflow(client, projectId, arcId);
      const arc = await client.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [arcId, projectId]);
      if (!arc.rowCount || arc.rows[0].planning_status !== "approved" || arc.rows[0].execution_status !== "active") throw new Error("故事弧当前不可生成下一批次");
      const batches = await client.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index FOR UPDATE", [arcId]);
      const last = batches.rows.at(-1);
      if (!last || last.status !== "approved" || last.payload?.complete === true) throw new Error("上一批次未批准或故事弧已完成");
      // 量纲修正（弧5实证 bug）：end_chapter_index 是全局章序，expectedChapterCount
      // 是弧内章数——两者直接比较即 PL-1"全局序对照弧内期望"同型错配（弧1 全局
      // 1..7 恰好重合蒙混过关，此后每个多章弧都误报"已达到预计章节数"）。
      // 正确谓词：弧内已规划章数 ≥ 弧内期望章数。
      const plannedInArc = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM chapters WHERE arc_id=$1", [arcId]);
      const expectedTotal = (arc.rows[0].payload as NarrativeArcPlan).expectedChapterCount;
      if (expectedTotal && Number(plannedInArc.rows[0]?.count ?? 0) >= expectedTotal) throw new Error("故事弧已达到预计章节数，请先完成或调整弧计划");
      if (batches.rows.some((batch) => batch.status === "generating" || batch.status === "awaiting-review")) throw new Error("已有批次正在生成或等待审核");
      const progress = await client.query<{ planned: string; finalized: string }>(
        `SELECT count(*)::text AS planned,count(*) FILTER (WHERE d.status='final')::text AS finalized
         FROM chapters c LEFT JOIN manuscript_documents d ON d.id=c.document_id WHERE c.batch_id=$1`, [last.id],
      );
      if (!canGenerateNextStoryArcBatch({ plannedInBatch: Number(progress.rows[0]?.planned ?? 0), finalizedInBatch: Number(progress.rows[0]?.finalized ?? 0), batchStatus: last.status })) {
        throw new Error("当前批次尚未达到 70% 定稿门槛");
      }
      const batchIndex = Number(last.batch_index) + 1;
      const startChapterIndex = Number(last.end_chapter_index) + 1;
      const id = `batch:${arcId}:${batchIndex}`;
      const entryFingerprint = createHash("sha256").update(JSON.stringify({ arcId, batchIndex, startChapterIndex, finalized: progress.rows[0]?.finalized, updatedAt: arc.rows[0].updated_at })).digest("hex");
      await client.query(`INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,payload)
        VALUES($1,$2,$3,$4,$5,$5,'generating',$6,$7)`, [id, arcId, projectId, batchIndex, startChapterIndex, entryFingerprint, { complete: false }]);
      await client.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc-batch.started','story-arc-batch',$2,$3)", [projectId, id, { arcId, batchIndex, startChapterIndex, entryFingerprint }]);
      await client.query("COMMIT");
      return { batchIndex, startChapterIndex };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareStoryArcBatchRetry(projectId: string, arcId: string): Promise<{ batchIndex: number; startChapterIndex: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertNoActiveStoryArcWorkflow(client, projectId, arcId);
      const arc = await client.query<ArcRow>("SELECT * FROM arcs WHERE id=$1 AND project_id=$2 FOR UPDATE", [arcId, projectId]);
      if (!arc.rowCount || arc.rows[0].planning_status !== "approved" || arc.rows[0].execution_status !== "active") throw new Error("故事弧当前不可重试批次");
      const batches = await client.query<StoryArcBatchRow>("SELECT * FROM story_arc_batches WHERE arc_id=$1 AND project_id=$2 ORDER BY batch_index FOR UPDATE", [arcId, projectId]);
      const last = batches.rows.at(-1);
      if (!last || last.status !== "failed") throw new Error("当前没有可重试的失败批次");
      const progress = await client.query<{ planned: string; finalized: string }>(
        `SELECT count(*)::text AS planned,count(*) FILTER (WHERE d.status='final')::text AS finalized
         FROM chapters c LEFT JOIN manuscript_documents d ON d.id=c.document_id WHERE c.batch_id=$1`, [last.id],
      );
      if (Number(progress.rows[0]?.planned ?? 0) > 0 || Number(progress.rows[0]?.finalized ?? 0) > 0) throw new Error("失败批次已有章节投影，不能原区间重试");
      const retryCount = Number((last.payload as { retryCount?: number } | undefined)?.retryCount ?? 0) + 1;
      await client.query(
        "UPDATE story_arc_batches SET status='generating',payload=(payload - 'failureReason') || $4::jsonb,updated_at=now() WHERE id=$1 AND arc_id=$2 AND project_id=$3 AND status='failed'",
        [last.id, arcId, projectId, JSON.stringify({ complete: false, retryCount })],
      );
      await client.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc-batch.retry','story-arc-batch',$2,$3)", [projectId, last.id, { arcId, batchIndex: Number(last.batch_index), startChapterIndex: Number(last.start_chapter_index), retryCount }]);
      await client.query("COMMIT");
      return { batchIndex: Number(last.batch_index), startChapterIndex: Number(last.start_chapter_index) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failStoryArcBatch(projectId: string, arcId: string, batchIndex: number, reason: string): Promise<void> {
    await this.pool.query("UPDATE story_arc_batches SET status='failed',payload=payload || $4,updated_at=now() WHERE project_id=$1 AND arc_id=$2 AND batch_index=$3 AND status='generating'", [projectId, arcId, batchIndex, { failureReason: reason }]);
  }

  async getStoryArcWorkflow(projectId: string, arcId: string): Promise<WorkflowRunRecord | undefined> {
    const result = await this.pool.query<WorkflowRunRow>(
      "SELECT id,workflow_type,project_id,temporal_workflow_id,status,payload,created_at,updated_at FROM workflow_runs WHERE project_id=$1 AND workflow_type='story-arc-planning' AND payload->>'arcId'=$2 ORDER BY created_at DESC LIMIT 1",
      [projectId, arcId],
    );
    return result.rows[0] ? workflowFromRow(result.rows[0]) : undefined;
  }

  async previewStoryArcApproval(projectId: string, arcId: string) {
    const arc = await this.getStoryArc(projectId, arcId);
    if (!arc || arc.planningStatus !== "awaiting-review" || !arc.blueprintArtifactId) throw new Error("故事弧当前不可确认");
    const creates: Array<{ chapterId: string; index: number; title: string }> = [];
    const updates: Array<{ chapterId: string; documentId: string; index: number; title: string }> = [];
    const conflicts: Array<{ chapterId: string; documentId: string; index: number; title: string; reason: string }> = [];
    for (const chapter of arc.chapters) {
      if (!chapter.documentId) creates.push({ chapterId: chapter.id, index: chapter.globalOrder, title: chapter.title });
      else {
        const doc = await this.pool.query<{ status: string; current_revision_id: string | null }>("SELECT status,current_revision_id FROM manuscript_documents WHERE id=$1 AND project_id=$2", [chapter.documentId, projectId]);
        if (!doc.rowCount || doc.rows[0].current_revision_id || doc.rows[0].status !== "planned") conflicts.push({ chapterId: chapter.id, documentId: chapter.documentId, index: chapter.globalOrder, title: chapter.title, reason: "章节已有正文或已进入创作流程" });
        else updates.push({ chapterId: chapter.id, documentId: chapter.documentId, index: chapter.globalOrder, title: chapter.title });
      }
    }
    return { creates, updates, conflicts, artifactId: arc.blueprintArtifactId };
  }

  async approveStoryArc(projectId: string, arcId: string, artifactId: string, reviewArtifactId: string, actor: string) {
    const preview = await this.previewStoryArcApproval(projectId, arcId);
    if (preview.artifactId !== artifactId) throw new Error("故事弧蓝图已变化，请刷新后重新确认");
    const [blueprintArtifact, reviewArtifact] = await Promise.all([this.getArtifact(artifactId), this.getArtifact(reviewArtifactId)]);
    if (!blueprintArtifact || !reviewArtifact || reviewArtifact.kind !== "review") throw new Error("故事弧缺少有效审核证据");
    if (reviewArtifact.structuredData?.subjectArtifactId !== artifactId) throw new Error("故事弧审核证据不属于当前蓝图");
    const review = reviewArtifact.structuredData as unknown as StoryArcReviewOutput;
    const architectureHealth = await this.getArchitectureHealth(projectId);
    const missingFoundation = architectureHealth.foundation.missing;
    const blockingArchitectureIssues = architectureHealth.fullBookArchitecture.issues.filter((issue) => issue.severity === "blocker" || issue.severity === "major");
    if (missingFoundation.length || blockingArchitectureIssues.length) {
      const foundationMessage = missingFoundation.length ? `Foundation 未批准：${missingFoundation.join("、")}` : "";
      const architectureMessage = blockingArchitectureIssues.length ? `全书架构审计：${blockingArchitectureIssues.map((issue) => `${issue.path} ${issue.message}`).join("；")}` : "";
      throw new Error(`故事弧审批前置门禁未通过：${[foundationMessage, architectureMessage].filter(Boolean).join("；")}`);
    }
    // 根因修复（2026-08-07）：normalizeStoryArcReferences 此前从未被调用，弧的
    // threadResponsibilities.threadRef 与 foreshadowingRefs 无法解析到项目级对象
    //（plot_threads / foreshadowing 表），approveStoryArc 的引用完整性门禁被判
    // blocking（"故事弧存在未解决的结构引用"）。在引用门禁前先物化弧引用为项目对象，
    // 幂等（ON CONFLICT DO UPDATE）；物化会改写 arc payload 的 threadRef 为 canonicalId，
    // 因此需要重新获取架构健康以刷新引用检查。
    await this.normalizeStoryArcReferences(projectId, arcId, actor);
    const refreshedHealth = await this.getArchitectureHealth(projectId);
    const references = refreshedHealth.references.find((item) => item.arcId === arcId);
    const blockingReferenceIssues = [
      ...(references?.plotThreads.issues ?? []),
      ...(references?.foreshadowing.issues ?? []),
    ].filter((issue) => issue.severity === "blocking");
    if (blockingReferenceIssues.length) throw new Error(`故事弧存在未解决的结构引用：${blockingReferenceIssues.map((issue) => issue.message).join("；")}`);
    if (review.verdict !== "passed") throw new Error("故事弧审核尚未通过，不能批准");
    // PL-1 审批入口声明一致性（product-audit-20260910 B1 + §六闭环）：末个待审批次
    // complete=true 却 expectedChapterCount≠已落籍章数时拒绝批准——弧 2 的形态
    // （期望 15 实际规划 8、靠全局章序算术被静默截断）不再可能通过审批。
    // 人工 complete=true 的优先权保留给运行期完成转移，不豁免审批入口的一致性声明。
    const approvalSnapshot = await this.getStoryArc(projectId, arcId);
    if (!approvalSnapshot) throw new Error("故事弧不存在，无法批准");
    const closingBatch = approvalSnapshot.batches
      .filter((batch) => batch.status === "awaiting-review" && batch.complete)
      .sort((left, right) => right.batchIndex - left.batchIndex)[0];
    if (closingBatch) {
      const expectedChapters = Number(approvalSnapshot.arc.expectedChapterCount ?? 0);
      const plannedChapters = approvalSnapshot.chapters.length;
      if (expectedChapters > 0 && plannedChapters < expectedChapters) {
        throw new Error(`批次 ${closingBatch.batchIndex} 声明收口本弧（complete=true），但 expectedChapterCount=${expectedChapters} 与已落籍章节数 ${plannedChapters} 不符：请把本批次规划补足到 ${expectedChapters} 章，或按实际规划修正期望章数后再批准`);
      }
    }
    const macro = await this.listCurrentFoundationArtifacts(projectId);
    const contextFingerprint = createHash("sha256").update(JSON.stringify({ macro: macro.map((item) => [foundationTaskKey(item), item.id, item.fingerprint]), artifactId })).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of preview.creates) {
        const chapter = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE id=$1 FOR UPDATE", [item.chapterId]);
        const blueprint = chapterBlueprintFromRow(chapter.rows[0]);
        const documentId = randomUUID();
        await client.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,pov_character_id,status) VALUES($1,$2,$3,$4,$5,'planned')", [documentId, projectId, blueprint.title, blueprint.globalOrder, blueprint.povCharacterId ?? null]);
        await client.query("UPDATE chapters SET document_id=$2,updated_at=now() WHERE id=$1", [blueprint.id, documentId]);
      }
      for (const item of preview.updates) {
        const chapter = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE id=$1", [item.chapterId]);
        const blueprint = chapterBlueprintFromRow(chapter.rows[0]);
        await client.query("UPDATE manuscript_documents SET title=$3,pov_character_id=$4,updated_at=now() WHERE id=$1 AND project_id=$2 AND status='planned' AND current_revision_id IS NULL", [item.documentId, projectId, blueprint.title, blueprint.povCharacterId ?? null]);
      }
      for (const item of preview.conflicts) {
        const chapter = await client.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE id=$1", [item.chapterId]);
        const blueprint = chapterBlueprintFromRow(chapter.rows[0]);
        await client.query("UPDATE manuscript_documents SET title=$3,pov_character_id=$4,updated_at=now() WHERE id=$1 AND project_id=$2", [item.documentId, projectId, blueprint.title, blueprint.povCharacterId ?? null]);
      }
      await client.query("UPDATE arcs SET planning_status='approved',execution_status=CASE WHEN execution_status='completed' THEN 'completed' ELSE 'active' END,context_fingerprint=$3,review_artifact_id=$4,review_fingerprint=$5,approved_at=now(),updated_at=now() WHERE id=$1 AND project_id=$2", [arcId, projectId, contextFingerprint, reviewArtifactId, reviewArtifact.fingerprint]);
      await client.query("UPDATE story_arc_batches SET status='approved',approved_at=now(),updated_at=now() WHERE arc_id=$1 AND project_id=$2 AND status='awaiting-review'", [arcId, projectId]);
      await client.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.approved','story-arc',$3,$4)", [projectId, actor, arcId, { artifactId, reviewArtifactId, reviewFingerprint: reviewArtifact.fingerprint, preview, contextFingerprint }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { arc: await this.getStoryArc(projectId, arcId), preview };
  }

  async abandonStoryArc(projectId: string, arcId: string, reason: string, actor: string) {
    const result = await this.pool.query("UPDATE arcs SET execution_status='abandoned',abandoned_at=now(),updated_at=now(),payload=payload || $3 WHERE id=$1 AND project_id=$2 AND execution_status<>'completed' RETURNING id", [arcId, projectId, { abandonmentReason: reason }]);
    if (!result.rowCount) throw new Error("故事弧不存在或已完成");
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.abandoned','story-arc',$3,$4)", [projectId, actor, arcId, { reason }]);
    return this.getStoryArc(projectId, arcId);
  }

  async markStoryArcGenerating(projectId: string, arcId: string, actor: string, options: { workflowId?: string } = {}) {
    await this.assertNoActiveStoryArcWorkflow(this.pool, projectId, arcId);
    const payloadPatch = {
      ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    };
    const result = await this.pool.query(`
      UPDATE arcs SET
        planning_status='generating',
        approved_at=CASE WHEN execution_status='completed' THEN approved_at ELSE NULL END,
        context_fingerprint=CASE WHEN execution_status='completed' THEN context_fingerprint ELSE NULL END,
        payload=(payload - 'failureReason') || $3,
        updated_at=now()
      WHERE id=$1 AND project_id=$2 AND execution_status<>'abandoned'
      RETURNING id,execution_status
    `, [arcId, projectId, payloadPatch]);
    if (!result.rowCount) throw new Error("故事弧当前不可重基线");
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.rebase-started','story-arc',$3,$4)", [projectId, actor, arcId, { preserveExecutionStatus: result.rows[0]?.execution_status === "completed" }]);
    return this.getStoryArc(projectId, arcId);
  }

  async prepareStoryArcReviewRetry(projectId: string, arcId: string, actor: string) {
    const result = await this.pool.query(`
      UPDATE arcs a SET
        planning_status='awaiting-review',
        updated_at=now(),
        payload=payload - 'failureReason'
      WHERE a.id=$1
        AND a.project_id=$2
        AND a.planning_status='failed'
        AND a.blueprint_artifact_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM story_arc_batches b
          WHERE b.arc_id=a.id
            AND b.project_id=a.project_id
            AND b.status='awaiting-review'
            AND b.source_artifact_id=a.blueprint_artifact_id
        )
      RETURNING a.id
    `, [arcId, projectId]);
    if (!result.rowCount) throw new Error("故事弧没有可重试的审核蓝图");
    await this.pool.query(
      "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.review-retry-prepared','story-arc',$3,$4)",
      [projectId, actor, arcId, { blueprintArtifactId: (await this.getStoryArc(projectId, arcId))?.blueprintArtifactId }],
    );
    return this.getStoryArc(projectId, arcId);
  }

  /**
   * Rebase recovery for a failed arc that has no awaiting-review batch for the
   * current blueprint.
   *
   * prepareStoryArcReviewRetry only handles the "review interrupted mid-flight"
   * case, where the pending batch still references the current blueprint.
   * A failed arc whose batch was already approved (e.g. the macro plan changed
   * after the arc was approved, so the blueprint went stale) can never satisfy
   * that precondition, while the rebase decision in startStoryArcReview requires
   * the absence of an awaiting-review batch. That precondition pair deadlocks the
   * arc in failed status. This method recovers that second case by returning the
   * arc to awaiting-review with its blueprint preserved, so the caller's rebase
   * decision (no pending batch for the current blueprint + committed chapters)
   * can take the rebase path.
   *
   * Precondition aligns with prepareStoryArcReviewRetry's source_artifact_id
   * semantics (negated): "pending batch" means an awaiting-review batch whose
   * source_artifact_id equals the current blueprint. A batch awaiting-review
   * that references an older artifact is stale and does not block rebase; this
   * makes the two recovery paths exact complements with no deadlock gap.
   *
   * 审计语义注意：本方法只把 failed 弧恢复为 awaiting-review（audit
   * story-arc.review-recovered，recovery=rebase-prepare）。调用方
   * startStoryArcReview 随后按是否有 committed 章节决定走 frozen-history rebase
   * 还是普通复审：无 committed 章节时 rebase 判定为 false，工作流实际对旧蓝图做
   * 普通复审（修订只在审核失败时触发，蓝图本身保留）；真正 rebase 决策记录在
   * workflow run payload 的 rebase 字段，而非本恢复审计。
   */
  async prepareStoryArcRebase(projectId: string, arcId: string, actor: string) {
    const result = await this.pool.query(`
      UPDATE arcs a SET
        planning_status='awaiting-review',
        updated_at=now(),
        payload=payload - 'failureReason'
      WHERE a.id=$1
        AND a.project_id=$2
        AND a.planning_status='failed'
        AND a.blueprint_artifact_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM story_arc_batches b
          WHERE b.arc_id=a.id
            AND b.project_id=a.project_id
            AND b.status='awaiting-review'
            AND b.source_artifact_id=a.blueprint_artifact_id
        )
      RETURNING a.id
    `, [arcId, projectId]);
    if (!result.rowCount) throw new Error("故事弧没有可重基线的失败蓝图");
    await this.pool.query(
      "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.review-recovered','story-arc',$3,$4)",
      [projectId, actor, arcId, { recovery: "rebase-prepare", blueprintArtifactId: (await this.getStoryArc(projectId, arcId))?.blueprintArtifactId }],
    );
    return this.getStoryArc(projectId, arcId);
  }

  async failStoryArc(projectId: string, arcId: string, reason: string) {
    await this.pool.query(`
      UPDATE arcs SET
        planning_status=CASE
          WHEN execution_status='completed' THEN 'approved'
          ELSE 'failed'
        END,
        updated_at=now(),
        payload=payload || $3
      WHERE id=$1 AND project_id=$2 AND execution_status<>'abandoned'
    `, [arcId, projectId, { failureReason: reason }]);
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc.failed','story-arc',$2,$3)", [projectId, arcId, { reason }]);
  }

  async recoverStoryArcAfterWorkflowCancellation(projectId: string, arcId: string) {
    const result = await this.pool.query<{ planning_status: ArcPlanningStatus }>(`
      UPDATE arcs a SET
        planning_status=CASE
          WHEN EXISTS (
            SELECT 1 FROM story_arc_batches b
            WHERE b.arc_id=a.id AND b.project_id=a.project_id
              AND b.status='awaiting-review' AND b.source_artifact_id=a.blueprint_artifact_id
          ) THEN 'awaiting-review'
          WHEN a.execution_status='completed' THEN 'approved'
          ELSE 'failed'
        END,
        updated_at=now()
      WHERE a.id=$1 AND a.project_id=$2 AND a.planning_status='generating'
      RETURNING planning_status
    `, [arcId, projectId]);
    if (result.rowCount) {
      await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','story-arc.cancelled','story-arc',$2,$3)", [projectId, arcId, { restoredPlanningStatus: result.rows[0].planning_status }]);
    }
    return this.getStoryArc(projectId, arcId);
  }

  async getStoryArcPlanningInput(projectId: string, arcId?: string) {
    const [project, macro, memories, threads, narrativeState, openElements, learning, cast, foreshadowingLedger] = await Promise.all([
      this.pool.query<{ title: string }>("SELECT title FROM novel_projects WHERE id=$1", [projectId]),
      this.listCurrentFoundationArtifacts(projectId),
      this.getChapterMemories({ projectId, limit: 6 }),
      this.pool.query<{ id: string; title: string; payload: Record<string, unknown> }>("SELECT id,title,payload FROM plot_threads WHERE project_id=$1 AND status='open' ORDER BY id", [projectId]),
      this.getLatestNarrativeStateSnapshot(projectId),
      this.getOpenForeshadowingAndPromises(projectId),
      this.listLearningAssessments(projectId, 24),
      // 人物登记表：povCharacterId 漂移（chu-heng/char_chu/char_hu_cheng 四形态并存）的
      // 根因是规划模型从未见过合法 id 名册，只能幻觉（2026-09-16 全书扫描确诊）。
      // id 取实体 URI 末段（与正文流水线消费的短 id 形态一致），不发明新形态。
      this.pool.query<{ id: string; name: string }>("SELECT id,name FROM entities WHERE project_id=$1 AND kind='character' ORDER BY id", [projectId]),
      // 到期账数据面（P1）：全量 open 行自带窗口与埋设章序，与 health 共用同一谓词
      // （parsePayoffWindow），不再依赖 openForeshadowings 的展示投影。
      this.pool.query<{ id: string; narrative_order: number | null; payload: Record<string, unknown> }>(
        "SELECT id,narrative_order,payload FROM foreshadowing WHERE project_id=$1 AND status='open' ORDER BY narrative_order ASC NULLS LAST, id",
        [projectId],
      ),
    ]);
    if (!project.rowCount) throw new Error("项目不存在");
    // 跨章序列信号前移到规划：查询最近 N 章的 narrativeFunction，计算连续同类功能游程。
    // 设计依据：AGENTS.md「问题要在机制层解决」——连续低行动/观察型章节密度类问题的
    // 根因在规划批准了被动功能序列；把 functionRuns 前移到 arc.plan 让规划器在分配
    // narrativeFunction 时就能看到疲劳风险，主动轮换压力类型，而不是等到正文生成后
    // 再由 learning 事后补救。只输出描述性统计，不输出短语黑名单或题材特定规则。
    // TODO P3: SERIAL_WINDOW 为魔法值，未来应可配置（序列证据预算的一部分）。
    const SERIAL_WINDOW = 6;
    const SERIAL_FUNCTION_RUN_MIN = 3;
    const narrativeCutoffForSerial = (narrativeState?.narrativeOrder ?? memories.reduce((max, memory) => Math.max(max, memory.narrativeRange.end), 0)) || 0;
    const serialRows = narrativeCutoffForSerial > 0
      ? await this.pool.query<{ narrative_order: string | number; narrative_function: string | null; scenes: unknown }>(
        `SELECT d.narrative_order, c.payload->>'narrativeFunction' AS narrative_function, c.payload->'scenes' AS scenes
         FROM chapters c
         JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
         WHERE c.project_id=$1 AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
           AND d.narrative_order <= $2
         ORDER BY d.narrative_order DESC
         LIMIT $3`,
        [projectId, narrativeCutoffForSerial, SERIAL_WINDOW],
      )
      : { rows: [] };
    const serialChapters = serialRows.rows
      .map((row) => ({ narrativeOrder: Number(row.narrative_order), narrativeFunction: row.narrative_function ?? undefined }))
      .filter((chapter): chapter is { narrativeOrder: number; narrativeFunction: string } => typeof chapter.narrativeFunction === "string" && chapter.narrativeFunction.length > 0)
      .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
    // 群像游程信号（2026-09-16 全书审校的机制端）：近窗口内"全部场景参与者≤1"的章
    // 与最长独处游程。与 serialFunctionRuns 同型——只呈现描述性统计，配额判断归
    // 规划指引与弧审核面；不做词表/题材黑名单。
    //
    // 注：2026-09-17 曾试图同时投影 opposition 以检测"第二意志缺口"，两版正则
    // 判据均被实测推翻（见 application/story-arc.ts 的负结果记录）——该判断是
    // 语义判断，不做机器判据，改为生成面契约。故此处仍只投影 participants。
    const ensembleWindow = serialRows.rows.map((row) => ({
      index: Number(row.narrative_order),
      scenes: (Array.isArray(row.scenes) ? row.scenes : []).flatMap((scene) => {
        if (!scene || typeof scene !== "object" || Array.isArray(scene)) return [];
        const item = scene as Record<string, unknown>;
        return [{ participants: Array.isArray(item.participants) ? item.participants.filter((name): name is string => typeof name === "string") : [] }];
      }),
    }));
    const ensembleSignal = ensembleWindow.length >= 3 ? inspectStoryArcEnsemble(ensembleWindow) : undefined;
    // 章长漂移/内容稀疏信号（2026-09-22 商业基准对照确诊的可见性落点）：近窗口定稿
    // 章的 \p{L}\p{N} 字数统计（均长 / 低于 sparseFloor 计数 / 最短章）。**只做描述性
    // 统计**——候选逐章门被 168 章实测推翻（28/31 章全书散布命中，见
    // word-count.ts LENGTH_DRIFT_POLICY 注释），章长约束的执法面仍是提交门
    // length-under-target（对声明目标），本信号只让"连续低量"成为规划与审核
    // 看得见的数字。判据校准与口径见 LENGTH_DRIFT_POLICY。
    const lengthRows = narrativeCutoffForSerial > 0
      ? await this.pool.query<{ narrative_order: string | number; word_count: string | number; dialogue_characters: string | number | null }>(
        `SELECT d.narrative_order, cb.word_count, cb.dialogue_characters
         FROM chapters c
         JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
         JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
         JOIN content_blobs cb ON cb.content_hash=mr.content_hash
         WHERE c.project_id=$1 AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
           AND d.narrative_order <= $2
         ORDER BY d.narrative_order DESC
         LIMIT $3`,
        [projectId, narrativeCutoffForSerial, LENGTH_DRIFT_POLICY.window],
      )
      : { rows: [] as Array<{ narrative_order: string | number; word_count: string | number; dialogue_characters: string | number | null }> };
    const lengthWindow = lengthRows.rows
      .map((row) => ({ order: Number(row.narrative_order), chars: Number(row.word_count) }))
      .filter((row) => Number.isFinite(row.chars) && row.chars > 0)
      .sort((left, right) => left.order - right.order);
    const lengthDrift = lengthWindow.length >= 3
      ? {
        windowSize: lengthWindow.length,
        avgChars: Math.round(lengthWindow.reduce((sum, row) => sum + row.chars, 0) / lengthWindow.length),
        sparseCount: lengthWindow.filter((row) => row.chars < LENGTH_DRIFT_POLICY.sparseFloor).length,
        minChars: lengthWindow.reduce((min, row) => Math.min(min, row.chars), Number.MAX_SAFE_INTEGER),
      }
      : undefined;
    // 正文对白密度漂移信号（2026-10-13，state-audit-20261013.md §7 第 5 项，作者裁决选项 A）：
    // 与 lengthDrift 共用同一次窗口查询（同窗口、同"只做描述性统计"纪律）。
    //
    // 为什么需要它：上游的 ensembleSignal 只能看见"蓝图参与者数"，看不见"正文实际对白"——
    // 两者之间此前没有任何回读，2026-09-22 商业基准对照确诊的 051-080「死亡象限」
    // （对白密度崩落）只能靠一次性人工复盘发现。本信号让"对手戏正在被挤出正文"成为
    // 规划面与审核面看得见的数字。
    //
    // 口径与边界见 word-count.ts 的 DIALOGUE_DRIFT_POLICY：不设绝对下限、不做逐章门、
    // 不引入"应有对白"的题材假设；dialogue_characters 为 NULL（历史 blob 未回补）的章
    // 一律按"不可测"排除出分母，不当作 0% 对白。
    const dialogueDrift = inspectDialogueDrift(
      lengthRows.rows.flatMap((row) => {
        if (row.dialogue_characters === null || row.dialogue_characters === undefined) return [];
        const characters = Number(row.word_count);
        const dialogueCharacters = Number(row.dialogue_characters);
        if (!Number.isFinite(characters) || !Number.isFinite(dialogueCharacters)) return [];
        return [{ order: Number(row.narrative_order), characters, dialogueCharacters }];
      }),
    );
    // 窗口上界已过的账（P1，2026-09-16 起，2026-09-18 修正语义）：
    // 规划者需要看见"哪些线索的兑现窗口上界已经过去"，但**不把它叫超期债务**——
    // 实测 244 条上界已过中 238 条仍在活跃推进，对连载而言这是常态而非欠账。
    // 故字段改称中性的 windowElapsedCount，行动建议交给静默判据
    // （narrative-dormancy 通道，需全章正文，在 activities.loadNarrativeDormancy 计算）。
    // 可判定纪律：只列 parsePayoffWindow 给出 chapter horizon 且上界已过的条目；
    // 窗口不可判定但埋设超过 40 章的归入账龄计数，不发明 deadline（宁缺勿伪）。
    // TODO(magic-value): 40=账龄位、12=注入预算条数，应进连载健康度配置。
    const dueItems: Array<{ id: string; description: string; horizonOrder: number; plantedOrder: number | null }> = [];
    let agedOpenCount = 0;
    for (const row of foreshadowingLedger.rows) {
      const window = parsePayoffWindow(row.payload?.expectedPayoffWindow, row.narrative_order);
      if (window.kind === "chapter" && window.horizonOrder !== null && narrativeCutoffForSerial > window.horizonOrder) {
        dueItems.push({
          id: row.id,
          description: String(row.payload?.description ?? "").slice(0, 80),
          horizonOrder: window.horizonOrder,
          plantedOrder: row.narrative_order ?? null,
        });
      } else if (window.horizonOrder === null && row.narrative_order != null && narrativeCutoffForSerial - row.narrative_order >= 40) {
        agedOpenCount += 1;
      }
    }
    dueItems.sort((left, right) => left.horizonOrder - right.horizonOrder || (left.plantedOrder ?? 0) - (right.plantedOrder ?? 0));
    const dueLedger = dueItems.length || agedOpenCount
      ? { currentOrder: narrativeCutoffForSerial, windowElapsedCount: dueItems.length, agedOpenCount, items: dueItems.slice(0, 12) }
      : undefined;
    // 跨弧回报节奏信号（P5，2026-09-16 审核确诊"061-091 共 31 章结清 0 笔"的可见性
    // 落点）：逐弧"定稿章数 vs 兑付笔数"——兑付密度是题材判断不设硬门，但连续数弧
    // 零兑付必须成为规划者看得见的数字（读者契约在弧尺度上被静默透支的机制端）。
    const rhythmRows = await this.pool.query<{ arc_ordinal: string | number | null; payoff_count: string | number }>(
      `SELECT a.ordinal AS arc_ordinal, COUNT(DISTINCT p.id)::int AS payoff_count
       FROM payoffs p
       LEFT JOIN foreshadowing f ON f.id=p.foreshadowing_id
       LEFT JOIN promises pr ON pr.id=p.promise_id
       JOIN manuscript_revisions mr ON mr.id=p.revision_id
       JOIN manuscript_documents d ON d.id=mr.document_id
       LEFT JOIN chapters c ON c.document_id=d.id
       LEFT JOIN arcs a ON a.id=c.arc_id
       WHERE (f.project_id=$1 OR pr.project_id=$1)
       GROUP BY a.id, a.ordinal`,
      [projectId],
    );
    const arcChapterCounts = await this.pool.query<{ arc_ordinal: string | number | null; arc_title: string | null; final_count: string | number }>(
      `SELECT a.ordinal AS arc_ordinal, a.title AS arc_title, COUNT(*)::int AS final_count
       FROM chapters c
       JOIN arcs a ON a.id=c.arc_id
       JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
       WHERE c.project_id=$1 AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
       GROUP BY a.id, a.ordinal, a.title`,
      [projectId],
    );
    const payoffByArc = new Map(rhythmRows.rows.map((row) => [String(row.arc_ordinal ?? "unassigned"), Number(row.payoff_count)]));
    const payoffRhythm = arcChapterCounts.rows
      .filter((row) => Number(row.final_count) > 0)
      .sort((left, right) => Number(left.arc_ordinal) - Number(right.arc_ordinal))
      .slice(-4)
      .map((row) => ({ arcOrdinal: Number(row.arc_ordinal), title: row.arc_title ?? null, finalChapters: Number(row.final_count), payoffCount: payoffByArc.get(String(row.arc_ordinal)) ?? 0 }));
    const serialFunctionRuns: Array<{ narrativeFunction: string; narrativeOrders: number[] }> = [];
    let runStart = 0;
    for (let index = 1; index <= serialChapters.length; index += 1) {
      const previous = serialChapters[index - 1].narrativeFunction;
      const current = index < serialChapters.length ? serialChapters[index].narrativeFunction : undefined;
      if (previous === current) continue;
      const run = serialChapters.slice(runStart, index);
      if (run.length >= SERIAL_FUNCTION_RUN_MIN) {
        serialFunctionRuns.push({ narrativeFunction: run[0].narrativeFunction, narrativeOrders: run.map((chapter) => chapter.narrativeOrder) });
      }
      runStart = index;
    }
    const planningFeedback = learning
      .filter((view) => view.assessment.conclusion === "propose-improvement" && view.assessment.underlyingMechanism && view.assessment.affectedInputClass)
      .filter((view) => {
        const target = view.assessment.candidate?.targetId ?? "";
        const layer = view.assessment.failingLayer ?? "";
        return /planning|arc|continuity|causal|plot|state|memory/iu.test(`${target} ${layer}`);
      })
      .slice(0, 8)
      .map((view) => ({
        sourceChapterOrder: view.sourceChapter?.narrativeOrder,
        targetId: view.assessment.candidate?.targetId ?? "system-prompt",
        underlyingMechanism: view.assessment.underlyingMechanism!,
        affectedInputClass: view.assessment.affectedInputClass!,
        boundaries: view.assessment.boundaries,
        sourceArtifactId: view.assessment.source.artifactId,
      }));
    const contextData: {
      projectTitle: string;
      macro: Array<{ taskKey: string; title: string; summary: string }>;
      recentChapters: Array<{ order: number; summary: string; unresolvedThreads: string[]; emotionalArc?: string }>;
      openThreads: Array<{ id: string; title: string; payload: Record<string, unknown> }>;
      openForeshadowings: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string; plantedRevisionId: string }>;
      openPromises: Array<{ id: string; promiser: string; promisee: string; statement: string; sourceRevisionId: string }>;
      undisclosedSecrets?: Array<{ claim: string; revealWindow?: string; carrier?: string }>;
      planningFeedback: Array<{ sourceChapterOrder?: number; targetId: string; underlyingMechanism: string; affectedInputClass: string; boundaries?: string; sourceArtifactId?: string }>;
      narrativeState: NarrativeStateSnapshot | undefined;
      plotOutline?: StoryArcPlotOutline;
      serialFunctionRuns?: Array<{ narrativeFunction: string; narrativeOrders: number[] }>;
      cast?: Array<{ id: string; name: string }>;
      ensembleSignal?: { soloOnlyOrders: number[]; longestSoloRun: number; windowSize: number };
      dueLedger?: { currentOrder: number; windowElapsedCount: number; agedOpenCount: number; items: Array<{ id: string; description: string; horizonOrder: number; plantedOrder: number | null }> };
      payoffRhythm?: Array<{ arcOrdinal: number; title: string | null; finalChapters: number; payoffCount: number }>;
      lengthDrift?: { windowSize: number; avgChars: number; sparseCount: number; minChars: number };
      dialogueDrift?: { windowSize: number; avgRatio: number; hintBelowRatio: number; silentOrders: number[]; minRatio: number };
    } = {
      projectTitle: project.rows[0].title,
      macro: macro.map((artifact) => ({ taskKey: foundationTaskKey(artifact) ?? "unknown", title: typeof artifact.structuredData?.title === "string" ? artifact.structuredData.title : "", summary: typeof artifact.structuredData?.summary === "string" ? artifact.structuredData.summary : "" })),
      recentChapters: memories.slice().reverse().map((memory) => ({ order: memory.narrativeRange.end, summary: memory.summary, unresolvedThreads: memory.unresolvedThreads, emotionalArc: memory.emotionalArc })),
      openThreads: threads.rows,
      openForeshadowings: openElements.foreshadowings,
      openPromises: openElements.promises,
      planningFeedback,
      narrativeState,
      ...(serialFunctionRuns.length ? { serialFunctionRuns } : {}),
      // 登记表只投影短 id（实体 URI 末段）与显示名，上限 80 行防止超长群像项目挤爆预算。
      cast: cast.rows.slice(0, 80).map((row) => ({ id: row.id.slice(row.id.lastIndexOf(":") + 1), name: row.name })),
      ...(ensembleSignal ? { ensembleSignal: { soloOnlyOrders: ensembleSignal.soloOnlyChapterIndexes, longestSoloRun: ensembleSignal.longestSoloRun, windowSize: ensembleWindow.length } } : {}),
      ...(dueLedger ? { dueLedger } : {}),
      ...(payoffRhythm.length ? { payoffRhythm } : {}),
      ...(lengthDrift ? { lengthDrift } : {}),
      ...(dialogueDrift ? { dialogueDrift } : {}),
    };
    // PL-8③：未揭示秘密清单投影（plot-design informationBoundaries.hidden）。别名迁移
    // 在 flat 归一层内完成（散文时代成员升为 {claim}）；plot-design 缺失或形态非法时返回
    // 空——不发明内容，宁缺毋造。
    {
      const plotDesign = macro.find((artifact) => foundationTaskKey(artifact) === "plot-design");
      const envelopeData = plotDesign?.structuredData?.structuredData;
      const designRoot = (typeof envelopeData === "string"
        ? (() => { try { return JSON.parse(envelopeData) as unknown; } catch { return undefined; } })()
        : envelopeData) as Record<string, unknown> | undefined;
      if (designRoot && typeof designRoot === "object" && !Array.isArray(designRoot)) {
        const flatDesign = normalizeFoundationStructuredDataFlat(designRoot, "plot-design");
        const hiddenMembers = (flatDesign.informationBoundaries as Record<string, unknown> | undefined)?.hidden;
        const undisclosedSecrets = (Array.isArray(hiddenMembers) ? hiddenMembers : []).flatMap((member) => {
          if (typeof member === "string") return member.trim() ? [{ claim: member.trim() }] : [];
          if (!member || typeof member !== "object" || Array.isArray(member)) return [];
          const record = member as Record<string, unknown>;
          const claim = typeof record.claim === "string" ? record.claim.trim() : "";
          if (!claim) return [];
          const revealWindow = [record.revealWindow, record.window, record.doNotConsumeBefore].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
          const carrier = typeof record.carrier === "string" && record.carrier.trim() ? record.carrier.trim() : undefined;
          return [{ claim, ...(revealWindow ? { revealWindow: revealWindow.trim() } : {}), ...(carrier ? { carrier } : {}) }];
        });
        if (undisclosedSecrets.length) contextData.undisclosedSecrets = undisclosedSecrets;
      }
    }
    // 外部剧情编排（模式 B）从对应故事弧的规划 workflow run 读取：arcs.payload
    // 在项目蓝图投影时会被 bundle.arc 覆盖，不能作为编排输入的持久化位置；
    // workflow_runs.payload 是审计性持久层，经 startStoryArcOrchestratedPlanning
    // 写入 plotOutline，按 arcId 精确匹配避免被其他弧的编排串扰；未提供
    // arcId（如 novel_context_get 项目级视图）时回退到项目最近一次编排。
    let plotOutline: StoryArcPlotOutline | undefined;
    if (arcId) {
      const outlineResult = await this.pool.query<{ plot_outline: StoryArcPlotOutline | null }>(
        `SELECT payload->'plotOutline' AS plot_outline
         FROM workflow_runs
         WHERE project_id=$1 AND workflow_type='story-arc-planning' AND payload->>'arcId'=$2 AND payload ? 'plotOutline'
         ORDER BY updated_at DESC LIMIT 1`,
        [projectId, arcId],
      );
      plotOutline = outlineResult.rows[0]?.plot_outline ?? undefined;
    } else {
      const outlineResult = await this.pool.query<{ plot_outline: StoryArcPlotOutline | null }>(
        `SELECT payload->'plotOutline' AS plot_outline
         FROM workflow_runs
         WHERE project_id=$1 AND workflow_type='story-arc-planning' AND payload ? 'plotOutline'
         ORDER BY updated_at DESC LIMIT 1`,
        [projectId],
      );
      plotOutline = outlineResult.rows[0]?.plot_outline ?? undefined;
    }
    if (plotOutline) contextData.plotOutline = plotOutline;
    const narrativeCutoff = (narrativeState?.narrativeOrder ?? memories.reduce((max, memory) => Math.max(max, memory.narrativeRange.end), 0)) || undefined;
    const sourceArtifactIds = [...new Set([
      ...macro.map((artifact) => artifact.id),
      ...learning.flatMap((view) => view.assessment.source.artifactId ? [view.assessment.source.artifactId] : []),
    ])];
    const sourceRevisionIds = [...new Set([
      ...memories.map((memory) => memory.revisionId),
      ...(narrativeState?.revisionId ? [narrativeState.revisionId] : []),
      ...openElements.foreshadowings.map((item) => item.plantedRevisionId),
      ...openElements.promises.map((item) => item.sourceRevisionId),
    ])];
    // 段 ↔ 指纹对应关系见 application/story-arc.ts 的 STORY_ARC_CONTEXT_SECTION_IDS。
    // 三条纪律（2026-10-14 复核轮，两处缺陷的修复依据）：
    //  ① **指纹按段登记，不按段内信号登记**：serial-signals 段内的五个信号
    //     （功能游程 / 群像 / 回报节奏 / 篇幅 / 对白）共用同一个指纹键。原实现按信号
    //     粒度登记，于是 payoffRhythm 单独占一个 "payoff-rhythm" 键却没有任何渲染方
    //     读取它（算了没人取），而共享段的键又挂在"三个信号之一在场"的条件上
    //     （段非空而指纹不在册 ⇒ provenanceRefs 为空）。
    //  ② **无条件渲染的段就不设条件**：serial-signals 段的文本恒非空（serialSignals
    //     恒有兜底文案），故其指纹无条件入册；条件入册的只有"空段不注入"的那几个。
    //  ③ "payoff-rhythm" 键已移除：信号粒度的遗留，其回收读点在 serial-signals 段内。
    //  ④ secrets 的指纹原先是**漏登**的（该段条件渲染却无指纹键 ⇒ 有段无引用），
    //     此处补齐，判据与 cast / dueLedger 同型：投影非空才入册。
    //     特意**不含 dormancy**：`narrativeDormancy` 由调用方（activities）在拿到
    //     本返回值之后注入（`loadNarrativeDormancy` 需全章正文，仓储层不读对象存储），
    //     本处拿不到它的值，为其登记指纹只会造出第二个"算了没人取"的键。
    const sectionFingerprints = {
      [STORY_ARC_CONTEXT_SECTION_IDS.macro.fingerprintKey]: canonicalSha256(contextData.macro),
      [STORY_ARC_CONTEXT_SECTION_IDS.recent.fingerprintKey]: canonicalSha256(contextData.recentChapters),
      [STORY_ARC_CONTEXT_SECTION_IDS.openElements.fingerprintKey]: canonicalSha256({ openThreads: contextData.openThreads, openForeshadowings: contextData.openForeshadowings, openPromises: contextData.openPromises }),
      [STORY_ARC_CONTEXT_SECTION_IDS.feedbackState.fingerprintKey]: canonicalSha256({ planningFeedback: contextData.planningFeedback, narrativeState: contextData.narrativeState }),
      [STORY_ARC_CONTEXT_SECTION_IDS.serialSignals.fingerprintKey]: canonicalSha256({ runs: contextData.serialFunctionRuns, ensembleSignal: contextData.ensembleSignal, payoffRhythm: contextData.payoffRhythm, lengthDrift: contextData.lengthDrift, dialogueDrift: contextData.dialogueDrift }),
      ...(contextData.cast ? { [STORY_ARC_CONTEXT_SECTION_IDS.cast.fingerprintKey]: canonicalSha256(contextData.cast) } : {}),
      ...(contextData.dueLedger ? { [STORY_ARC_CONTEXT_SECTION_IDS.dueLedger.fingerprintKey]: canonicalSha256(contextData.dueLedger) } : {}),
      ...(contextData.undisclosedSecrets?.length ? { [STORY_ARC_CONTEXT_SECTION_IDS.secrets.fingerprintKey]: canonicalSha256(contextData.undisclosedSecrets) } : {}),
    };
    const receiptBase: Omit<StoryArcContextReceipt, "fingerprint"> = { narrativeCutoff, sourceArtifactIds, sourceRevisionIds, sectionFingerprints, legacy: false };
    const contextReceipt: StoryArcContextReceipt = { ...receiptBase, fingerprint: canonicalSha256(receiptBase) };
    return { ...contextData, contextReceipt };
  }

  async getStoryArcRebaseTarget(projectId: string, arcId: string): Promise<StoryArcRebaseTarget> {
    const arc = await this.getStoryArc(projectId, arcId);
    if (!arc) throw new Error("故事弧不存在");
    const rows = await this.pool.query<{
      chapter_id: string;
      document_id: string;
      global_order: string | number;
      document_title: string;
      current_revision_id: string | null;
      approved_blueprint: Record<string, unknown> | null;
    }>(
      `SELECT c.id AS chapter_id,c.document_id,c.ordinal AS global_order,d.title AS document_title,
              d.current_revision_id,c.payload AS approved_blueprint
       FROM chapters c
       JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
       WHERE c.project_id=$1 AND c.arc_id=$2
       ORDER BY c.ordinal`,
      [projectId, arcId],
    );
    if (!rows.rowCount) throw new Error("故事弧没有可重基线的已关联章节");
    if (rows.rows.length > MAX_STORY_ARC_BATCH_WINDOW) throw new Error(`单次重基线最多处理 ${MAX_STORY_ARC_BATCH_WINDOW} 个已关联章节；更长故事弧需要按批次重基线`);

    const approvals = await this.pool.query<{ artifact_id: string | null }>(
      `SELECT payload->>'artifactId' AS artifact_id
       FROM audit_records
       WHERE project_id=$1 AND aggregate_type='story-arc' AND aggregate_id=$2 AND action='story-arc.approved'
       ORDER BY created_at ASC,id ASC`,
      [projectId, arcId],
    );
    // A rebase may cover several approved batches. Reconstruct the last
    // approved forward blueprint per global chapter position so uncreated
    // chapters are not mistaken for committed history.
    const approvedChapterByOrder = new Map<number, ChapterBlueprint>();
    for (const approval of approvals.rows) {
      if (!approval.artifact_id) continue;
      const artifact = await this.getArtifact(approval.artifact_id);
      if (!artifact?.structuredData) continue;
      const bundle = parseStoryArcBundle(artifact.structuredData);
      bundle.chapters.forEach((chapter, index) => {
        approvedChapterByOrder.set(bundle.batch.startChapterIndex + index, chapter);
      });
    }
    const approvedArtifactId = approvals.rows[approvals.rows.length - 1]?.artifact_id ?? arc.blueprintArtifactId;
    const approvedArtifact = approvedArtifactId ? await this.getArtifact(approvedArtifactId) : undefined;
    const approvedArc = approvedArtifact?.structuredData
      ? parseStoryArcBundle(approvedArtifact.structuredData).arc
      : arc.arc;
    const approvedStructuredArc = approvedArtifact?.structuredData
      && typeof approvedArtifact.structuredData === "object"
      && !Array.isArray(approvedArtifact.structuredData)
      && typeof (approvedArtifact.structuredData as Record<string, unknown>).arc === "object"
      && (approvedArtifact.structuredData as Record<string, unknown>).arc !== null
      && !Array.isArray((approvedArtifact.structuredData as Record<string, unknown>).arc)
      ? (approvedArtifact.structuredData as Record<string, unknown>).arc as Record<string, unknown>
      : undefined;
    if (approvedStructuredArc && !Object.prototype.hasOwnProperty.call(approvedStructuredArc, "threadResponsibilities")) {
      throw new Error("故事弧批准记录缺少 threadResponsibilities，已标记为 stale；请重新生成并审核故事弧");
    }
    const batch = arc.batches[0];
    const startChapterIndex = batch?.startChapterIndex ?? Number(rows.rows[0].global_order);

    const chapters = await Promise.all(rows.rows.map(async (row) => {
      const memory = await this.getChapterMemoryByDocument(projectId, row.document_id);
      const currentMemory = memory && (!row.current_revision_id || memory.revisionId === row.current_revision_id) ? memory : undefined;
      const claims = row.current_revision_id ? await this.listActiveMemoryClaimsByRevision(projectId, row.current_revision_id) : [];
      const plannedBlueprint = !row.current_revision_id ? approvedChapterByOrder.get(Number(row.global_order)) : undefined;
      const committedBlueprint = !plannedBlueprint && row.approved_blueprint
        ? parseStoryArcBundle({
          arc: { title: "历史章节重基线", objective: "保留已批准章节蓝图" },
          batch: { batchIndex: 1, startChapterIndex: Number(row.global_order), complete: false },
          chapters: [row.approved_blueprint],
        }).chapters[0]
        : undefined;
      return {
        chapterId: row.chapter_id,
        documentId: row.document_id,
        globalOrder: Number(row.global_order),
        title: row.document_title,
        revisionId: row.current_revision_id ?? undefined,
        plannedBlueprint,
        committedBlueprint,
        chapterMemory: currentMemory ? {
          summary: currentMemory.summary,
          keyEvents: currentMemory.keyEvents,
          characterStates: currentMemory.characterStates,
          unresolvedThreads: currentMemory.unresolvedThreads,
          emotionalArc: currentMemory.emotionalArc,
        } : undefined,
        authoritativeFacts: claims
          .filter((claim) => claim.knowledgeScope === "author" && claim.predicate !== "character-knows")
          .map((claim) => ({ title: claim.title, content: claim.content, predicate: claim.predicate, subjectRefs: claim.subjectRefs })),
      };
    }));

    return {
      arcId,
      executionStatus: arc.executionStatus,
      approvedArc,
      batchIndex: batch?.batchIndex ?? 1,
      startChapterIndex,
      chapters,
    };
  }

  async recordNarrativeStateSnapshot(input: {
    projectId: string;
    documentId: string;
    revisionId: string;
    narrativeOrder: number;
    chapterMemory: ChapterMemory;
    narrativeElements?: FactExtractionOutput["narrativeElements"];
  }, connection: Pool | PoolClient = this.pool): Promise<NarrativeStateSnapshot> {
    if (connection === this.pool) {
      // 与 recordNarrativeElements 同族：提交链路默认面若逐条 autocommit，快照与它的
      // outbox/来源行会出现"有快照无事件"或反之的半提交形态，且这类偏差只在事后对账时
      // 才看得见。调用方传入 client 时沿用其事务边界，不在此嵌套 BEGIN。
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.recordNarrativeStateSnapshot(input, client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    // 五条读依次取而非 Promise.all：本方法的两条路径（默认面自管事务、调用方传入 client）
    // 都在单个 PoolClient 上跑，pg 已废弃"同一 client 并发 query"（pg@9 直接抛），并发只
    // 能靠串行保证。这里读的是账本输入，串行多四次本地往返，换两条路径共用一段可判定代码。
    const open = await this.getOpenForeshadowingAndPromises(input.projectId, input.narrativeOrder, connection);
    const threads = await connection.query<{ id: string; title: string; payload: Record<string, unknown> }>(
      "SELECT id,title,payload FROM plot_threads WHERE project_id=$1 AND status='open' ORDER BY id",
      [input.projectId],
    );
    // 规划上下文与账本其余读同面（同一 connection）：调用方持事务时它必须看到本事务的状态；
    // allowHistorical=true ⇒ 方法内的 stale 标记写在本路径不可达。读失败仍降级为"无阶段"而不是
    // 打断账本；代价是同面之后，一条 SQL 级错误会连带中止调用方事务（旧写法走独立连接不会），
    // 但两条路径的投影失败都由调用方记进 projection_failures 账，不丢症状。
    const planning = await this.getChapterPlanningContext(input.projectId, input.documentId, true, connection).catch(() => undefined);
    const arcPosition = await connection.query<{ current_order: string | number; first_order: string | number }>(
      `SELECT c.ordinal AS current_order,MIN(peer.ordinal) AS first_order
       FROM chapters c JOIN chapters peer ON peer.arc_id=c.arc_id
       WHERE c.project_id=$1 AND c.document_id=$2 GROUP BY c.ordinal`,
      [input.projectId, input.documentId],
    );
    // "已兑现"与"未来才该兑现"两侧共用这一条查询，按 cutoff 分侧，两侧不会各自漂移。
    // 列语义是判据的关键（09-19 复核自纠）：`foreshadowing.narrative_order` 是**埋设章**序，
    // 兑现动作只写 status='fulfilled' + payoff_revision_id，所以兑现章序必须走
    // payoff_revision_id→revision→document；按埋设序分侧会把"建立≤cutoff、兑现在未来"
    // 误归进已兑现侧——恰是"不可提前消费"要挡的形态，且顺序推进时未来侧恒空。
    // 上限 120 是明细页不是账：payoffs 支已含伏笔兑现行，foreshadowing.payoff_revision_id
    // 支只补 v1 时代无 payoffs 行的存量，按兑现章倒序取最近一页（同 openPromises LIMIT 40 取舍）。
    const fulfillments = await connection.query<{ description: string | null; narrative_order: string | number | null }>(
      `SELECT * FROM (
         SELECT p.evidence->>'description' AS description, d.narrative_order
         FROM payoffs p
         JOIN manuscript_revisions r ON r.id=p.revision_id AND r.project_id=$1
         JOIN manuscript_documents d ON d.id=r.document_id AND d.project_id=r.project_id
         WHERE p.revision_id IS NOT NULL
         UNION ALL
         SELECT f.payload->>'description', d2.narrative_order
         FROM foreshadowing f
         JOIN manuscript_revisions r2 ON r2.id=f.payoff_revision_id AND r2.project_id=$1
         JOIN manuscript_documents d2 ON d2.id=r2.document_id AND d2.project_id=r2.project_id
         WHERE f.project_id=$1 AND f.status='fulfilled' AND f.payoff_revision_id IS NOT NULL
       ) recorded
       ORDER BY narrative_order DESC NULLS LAST
       LIMIT 120`,
      [input.projectId],
    );
    const recordedPayoffs = fulfillments.rows
      .filter((row): row is { description: string; narrative_order: string | number } => Boolean(row.description) && row.narrative_order !== null);
    const futurePayoffRefs = recordedPayoffs
      .filter((row) => Number(row.narrative_order) > input.narrativeOrder)
      .map((row) => row.description);
    const phases = planning?.arc.phases ?? [];
    const position = arcPosition.rows[0];
    const arcLocalOrdinal = position ? Math.max(1, Number(position.current_order) - Number(position.first_order) + 1) : 0;
    // PL-6：阶段归属只认 phases[].chapterOrdinals 数据绑定；未绑定不猜（旧
    // floor(localIndex/expected*phases) 等分推算在"期望≠实际"弧上静默失真）。
    const boundPhase = resolveArcPhase(phases, arcLocalOrdinal);
    const payloadWithoutFingerprint = {
      id: `narrative-state:${input.revisionId}`,
      projectId: input.projectId,
      documentId: input.documentId,
      revisionId: input.revisionId,
      narrativeOrder: input.narrativeOrder,
      arcId: planning?.arcId,
      chapterBlueprintId: planning?.chapterBlueprintId,
      arcPhase: boundPhase?.title,
      openThreads: [...new Set([
        ...input.chapterMemory.unresolvedThreads,
        ...threads.rows.map((thread) => `${thread.id} ${thread.title}`),
      ])],
      openForeshadowings: open.foreshadowings.map((item) => ({ id: item.id, description: item.description, expectedPayoffWindow: item.expectedPayoffWindow, readerQuestion: item.readerQuestion, possiblePayoffs: item.possiblePayoffs, meaningDelta: item.meaningDelta, cost: item.cost })),
      openPromises: open.promises.map((item) => ({ id: item.id, promiser: item.promiser, promisee: item.promisee, statement: item.statement })),
      fulfilledNodes: [...new Set([
        ...recordedPayoffs.filter((row) => Number(row.narrative_order) <= input.narrativeOrder).map((row) => row.description),
        ...(input.narrativeElements?.payoffs ?? []).map((item) => item.description),
      ])],
      prohibitedEarlyConsumption: [...new Set([
        ...futurePayoffRefs,
        ...(planning?.arc.exitState ? [`故事弧退出状态：${planning.arc.exitState}`] : []),
      ])],
      continuityConstraints: planning?.chapter.continuityConstraints ?? [],
    };
    const snapshot: NarrativeStateSnapshot = {
      ...payloadWithoutFingerprint,
      fingerprint: canonicalSha256(payloadWithoutFingerprint),
      createdAt: Date.now(),
    };
    await connection.query(
      `INSERT INTO narrative_state_snapshots(id,project_id,document_id,revision_id,narrative_order,payload,fingerprint,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(project_id,revision_id) DO UPDATE SET payload=EXCLUDED.payload,fingerprint=EXCLUDED.fingerprint,created_at=EXCLUDED.created_at`,
      [snapshot.id, snapshot.projectId, snapshot.documentId, snapshot.revisionId, snapshot.narrativeOrder, snapshot, snapshot.fingerprint, new Date(snapshot.createdAt)],
    );
    await connection.query(
      "INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,project_id) VALUES('narrative-state',$1,'narrative-state.upserted',$2,$3)",
      [snapshot.id, { projectId: snapshot.projectId, documentId: snapshot.documentId, revisionId: snapshot.revisionId, narrativeOrder: snapshot.narrativeOrder, fingerprint: snapshot.fingerprint }, snapshot.projectId],
    );
    return snapshot;
  }

  async getLatestNarrativeStateSnapshot(projectId: string, narrativeCutoff?: number): Promise<NarrativeStateSnapshot | undefined> {
    const result = narrativeCutoff === undefined
      ? await this.pool.query<{ payload: NarrativeStateSnapshot }>(
        "SELECT payload FROM narrative_state_snapshots WHERE project_id=$1 ORDER BY narrative_order DESC,created_at DESC LIMIT 1",
        [projectId],
      )
      : await this.pool.query<{ payload: NarrativeStateSnapshot }>(
        "SELECT payload FROM narrative_state_snapshots WHERE project_id=$1 AND narrative_order<=$2 ORDER BY narrative_order DESC,created_at DESC LIMIT 1",
        [projectId, narrativeCutoff],
      );
    const payload = result.rows[0]?.payload;
    if (!payload) return undefined;
    return payload;
  }

  async getNarrativeStatePinnedClaims(input: { projectId: string; documentId?: string; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    const [snapshot, memories] = await Promise.all([
      this.getLatestNarrativeStateSnapshot(input.projectId, input.narrativeCutoff),
      this.getChapterMemories({ projectId: input.projectId, narrativeCutoff: input.narrativeCutoff, limit: 4 }),
    ]);
    const latestMemory = snapshot
      ? memories.find((memory) => memory.narrativeRange.end === snapshot.narrativeOrder)
      : undefined;
    const hits: MemoryHit[] = [];
    const push = (claim: Omit<MemoryHit, "score" | "reason" | "semanticRank">) => hits.push({ ...claim, score: 1, reason: "pinned-narrative-state", semanticRank: 1 });
    if (snapshot) {
      const content = [
        `当前弧阶段：${snapshot.arcPhase || "未记录"}`,
        `角色状态：${latestMemory?.characterStates.map((item) => `${item.characterId}=${item.stateSnapshot}`).join("；") || "无"}`,
        `开放线索：${snapshot.openThreads.join("；") || "无"}`,
        `开放伏笔 ID（详细内容按需检索）：${snapshot.openForeshadowings.map((item) => item.id).join("、") || "无"}`,
        `开放承诺 ID（详细内容按需检索）：${snapshot.openPromises.map((item) => item.id).join("、") || "无"}`,
        `已兑现：${snapshot.fulfilledNodes.join("；") || "无"}`,
        `禁止提前消费：${snapshot.prohibitedEarlyConsumption.filter((item) => !item.startsWith("故事弧退出状态：")).join("；") || "无"}`,
      ].join("\n");
      const subjectRefs = latestMemory?.characterStates.map((item) => item.characterId) ?? [];
      push({ id: snapshot.id, projectId: input.projectId, kind: "hierarchical", title: `第${snapshot.narrativeOrder}章叙事状态账本`, content, subjectRefs, narrativeRange: { start: snapshot.narrativeOrder, end: snapshot.narrativeOrder }, knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: sourceRevisionIdsOf(snapshot.revisionId), contentHash: snapshot.fingerprint, supersedes: [], matchedFacet: "thread", matchedFacets: ["thread", "entity"] });
      const povForms = input.povCharacterId ? await this.characterRefForms(input.projectId, input.povCharacterId) : undefined;
      const povMatches = (characterId: string) => characterId === input.povCharacterId
        || Boolean(povForms && (characterId === povForms.shortId || characterId === povForms.name || characterId === povForms.uri));
      const povState = latestMemory?.characterStates.find((item) => povMatches(item.characterId));
      const povCanonical = povForms?.shortId ?? input.povCharacterId;
      if (povState && povCanonical) {
        push({ id: `${snapshot.id}:pov:${povCanonical}`, projectId: input.projectId, kind: "working", title: `POV角色章末状态：${povForms?.name ?? povCanonical}`, content: povState.stateSnapshot, subjectRefs: [povCanonical], narrativeRange: { start: snapshot.narrativeOrder, end: snapshot.narrativeOrder }, knowledgeScope: { characterId: povCanonical }, authority: "derived", confidence: 1, sourceRevisionIds: sourceRevisionIdsOf(snapshot.revisionId), contentHash: createHash("sha256").update(`${snapshot.fingerprint}:${povCanonical}:${povState.stateSnapshot}`).digest("hex"), supersedes: [], matchedFacet: "entity" });
      }
    }
    for (const memory of memories) {
      push({ id: `pinned:${memory.id}`, projectId: input.projectId, kind: "episodic", title: `第${memory.narrativeRange.end}章定稿记忆`, content: `${memory.summary}\n关键事件：${memory.keyEvents.join("；")}\n未解线索：${memory.unresolvedThreads.join("；")}`, subjectRefs: memory.characterStates.map((item) => item.characterId), narrativeRange: memory.narrativeRange, knowledgeScope: "author", authority: "derived", confidence: 0.95, sourceRevisionIds: sourceRevisionIdsOf(memory.revisionId), contentHash: memory.fingerprint, supersedes: [], matchedFacet: "chapter-memory" });
    }
    return hits;
  }

  /**
   * 章节规划上下文（章/弧蓝图 + 宏观规划 + 相邻章 + 弧审核证据）。
   *
   * connection 线程化（F3′ 的"已登记未修"项收口）：本方法的读**与写**都落在调用方给的那条
   * 连接上。读侧：持事务的调用方（`applyCommittedChapterStateRebuild` → 账本投影）若走默认面
   * 就是在自己事务之外读，看到的是事务开始前的账本。写侧：三处 `planning_status='stale'` 若走
   * 另一条连接，而调用方事务已锁住该弧行，就会等自己已持有的那把锁而自死锁（行锁按会话，不可重入）。
   * 代价如实记：调用方回滚时 stale 标记随之消失，但它由重算派生，下一次读会再标一次，不需持久化。
   */
  async getChapterPlanningContext(
    projectId: string,
    documentId: string,
    allowHistorical = false,
    connection: Pool | PoolClient = this.pool,
  ): Promise<ChapterPlanningContext> {
    const markArcStale = async (arcId: string): Promise<void> => {
      await connection.query("UPDATE arcs SET planning_status='stale',approved_at=CASE WHEN execution_status='completed' THEN approved_at ELSE NULL END,updated_at=now() WHERE id=$1", [arcId]);
    };
    const chapterResult = await connection.query<ChapterBlueprintRow & { planning_status: string; context_fingerprint: string | null; review_artifact_id: string | null; review_fingerprint: string | null; arc_payload: NarrativeArcPlan }>(
      `SELECT c.id,c.arc_id,c.project_id,c.document_id,c.title,c.ordinal,c.status,c.payload,c.source_artifact_id,c.blueprint_revision,
         a.planning_status,a.context_fingerprint,a.review_artifact_id,a.review_fingerprint,a.payload AS arc_payload
       FROM chapters c JOIN arcs a ON a.id=c.arc_id WHERE c.project_id=$1 AND c.document_id=$2`,
      [projectId, documentId],
    );
    if (!chapterResult.rowCount) throw new Error("目标章节尚未关联故事弧蓝图");
    const row = chapterResult.rows[0];
    if (!allowHistorical && row.planning_status !== "approved") throw new Error(`目标故事弧蓝图不可用：${row.planning_status}`);
    const chapter = chapterBlueprintFromRow(row);
    // 依次取而非 Promise.all：两条路径可能共用同一个 PoolClient，pg 已废弃同 client 并发 query。
    const macro = await this.listCurrentFoundationArtifacts(projectId, true, connection);
    const neighborsResult = await connection.query<ChapterBlueprintRow>("SELECT id,arc_id,project_id,document_id,title,ordinal,status,payload,source_artifact_id,blueprint_revision FROM chapters WHERE arc_id=$1 AND id<>$2 ORDER BY ABS(ordinal-$3),ordinal LIMIT 2", [row.arc_id, row.id, row.ordinal]);
    const sourceArtifactIds = [...macro.map((artifact) => artifact.id), ...(row.source_artifact_id ? [row.source_artifact_id] : [])];
    const withoutFingerprint = {
      projectId,
      arcId: row.arc_id,
      chapterBlueprintId: row.id,
      arc: parseStoryArcPlan(row.arc_payload),
      chapter,
      neighbors: neighborsResult.rows.map(chapterBlueprintFromRow).map(({ id, globalOrder, title, narrativeFunction, stateTransition, unresolvedAtClose }) => ({ id, globalOrder, title, narrativeFunction, stateTransition, unresolvedAtClose })),
      sourceArtifactIds,
    };
    const context = { ...withoutFingerprint, fingerprint: planningContextFingerprint(withoutFingerprint) };
    if (!allowHistorical) {
      const currentArcFingerprint = createHash("sha256").update(JSON.stringify({ macro: macro.map((item) => [foundationTaskKey(item), item.id, item.fingerprint]), artifactId: row.source_artifact_id })).digest("hex");
      if (!row.context_fingerprint || currentArcFingerprint !== row.context_fingerprint) {
        await markArcStale(row.arc_id);
        throw new Error("故事弧蓝图与当前宏观规划不一致，请先重基线");
      }
      if (!row.review_artifact_id || !row.review_fingerprint) {
        await markArcStale(row.arc_id);
        throw new Error("故事弧缺少逐章审核证据，请先重新审核");
      }
      const reviewArtifact = await this.getArtifact(row.review_artifact_id, connection);
      if (!reviewArtifact || reviewArtifact.fingerprint !== row.review_fingerprint || reviewArtifact.structuredData?.subjectArtifactId !== row.source_artifact_id) {
        await markArcStale(row.arc_id);
        throw new Error("故事弧审核证据已失效，请先重新审核");
      }
    }
    return context;
  }

  async getNarrativeRhythmSnapshot(projectId: string, documentId: string, narrativeCutoff: number): Promise<NarrativeRhythmSnapshot | undefined> {
    const result = await this.pool.query<{
      document_id: string;
      revision_id: string;
      narrative_order: string | number;
      title: string;
      arc_id: string;
      chapter_payload: Record<string, unknown>;
    }>(
      buildNarrativeRhythmSnapshotQuery(),
      [projectId, documentId, narrativeCutoff],
    );
    if (!result.rowCount) return undefined;
    const chapters = result.rows.map((row) => {
      const payload = row.chapter_payload ?? {};
      return {
        documentId: row.document_id,
        revisionId: row.revision_id,
        narrativeOrder: Number(row.narrative_order),
        title: row.title,
        narrativeFunction: typeof payload.narrativeFunction === "string" && CHAPTER_NARRATIVE_FUNCTIONS.includes(payload.narrativeFunction as (typeof CHAPTER_NARRATIVE_FUNCTIONS)[number])
          ? payload.narrativeFunction as NonNullable<ChapterBlueprintRecord["narrativeFunction"]>
          : undefined,
      };
    });
    const arcId = result.rows[0].arc_id;
    return { arcId, chapters, fingerprint: canonicalSha256({ arcId, chapters }) };
  }

  /**
   * 跨章序列证据快照：把最近 window 章的结构化统计投影给 draft/review/revision/learning。
   *
   * 设计依据：AGENTS.md「问题要在机制层解决」——单章审核结构上看不见跨章模式
   * （状态等幅重述、连续同功能章节、物件/主题跨度），本快照用确定性计算（无 LLM）
   * 把最近 N 章压缩为描述性统计信号：
   * - characterSpans：同一角色章末状态快照的跨章序列（状态账本重述信号）；
   * - functionRuns：同 narrativeFunction 的连续游程 ≥ FUNCTION_RUN_MIN（节奏密度信号）；
   * - subjectSpans：同一 subject 相关事实出现在 ≥2 个窗口章节（物件/主题跨度信号）。
   * 只输出统计与摘要，不输出短语黑名单；"母题还是疲劳"由 reviewer 判断。
   *
   * TODO P3: window 与 FUNCTION_RUN_MIN 为魔法值，未来应可配置（序列证据预算的一部分）。
   */
  async getSerialContextSnapshot(projectId: string, documentId: string, narrativeCutoff: number, window = 6): Promise<SerialContextSnapshot | undefined> {
    const rhythm = await this.getNarrativeRhythmSnapshot(projectId, documentId, narrativeCutoff);
    if (!rhythm) return undefined;
    const windowChapters = rhythm.chapters.slice(-window);
    if (!windowChapters.length) return undefined;
    const minOrder = windowChapters[0].narrativeOrder;
    const maxOrder = windowChapters[windowChapters.length - 1].narrativeOrder;

    // characterSpans：取窗口内各章最新 chapter memory 的 characterStates
    const memories = await this.getChapterMemories({ projectId, narrativeCutoff: maxOrder, limit: 64 });
    const memoryByOrder = new Map(memories.filter((m) => m.narrativeRange.start >= minOrder).map((m) => [m.narrativeRange.start, m]));
    const characterStateMap = new Map<string, Array<{ narrativeOrder: number; stateSnapshot: string }>>();
    for (const chapter of windowChapters) {
      const memory = memoryByOrder.get(chapter.narrativeOrder);
      for (const state of memory?.characterStates ?? []) {
        const list = characterStateMap.get(state.characterId) ?? [];
        list.push({ narrativeOrder: chapter.narrativeOrder, stateSnapshot: state.stateSnapshot });
        characterStateMap.set(state.characterId, list);
      }
    }
    const characterSpans: SerialCharacterStateSpan[] = [...characterStateMap.entries()]
      .filter(([, states]) => states.length >= 2)
      .sort((left, right) => right[1].length - left[1].length)
      .map(([characterId, states]) => ({ characterId, states }));

    // functionRuns：同 narrativeFunction 的连续游程
    const FUNCTION_RUN_MIN = 3; // TODO P3: 可配置阈值（序列证据预算的一部分）
    const functionRuns: SerialFunctionRun[] = [];
    let runStart = 0;
    for (let index = 1; index <= windowChapters.length; index += 1) {
      const previous = windowChapters[index - 1].narrativeFunction;
      const current = index < windowChapters.length ? windowChapters[index].narrativeFunction : undefined;
      if (previous && previous === current) continue;
      const run = windowChapters.slice(runStart, index);
      if (run.length >= FUNCTION_RUN_MIN && run[0].narrativeFunction) {
        functionRuns.push({ narrativeFunction: run[0].narrativeFunction, narrativeOrders: run.map((chapter) => chapter.narrativeOrder) });
      }
      runStart = index;
    }

    // subjectSpans：窗口内出现在 ≥2 个章节的 subject（active claims）
    const subjectRows = await this.pool.query<{ subject: string; orders: string[]; latest_title: string }>(
      `WITH w AS (
         SELECT unnest(subject_refs) AS subject, narrative_start, title
         FROM memory_claims
         WHERE project_id=$1 AND narrative_start BETWEEN $2 AND $3
           AND lifecycle_status='active'
       )
       SELECT subject,
              array_agg(DISTINCT narrative_start ORDER BY narrative_start) AS orders,
              (array_agg(title ORDER BY narrative_start DESC))[1] AS latest_title
       FROM w
       GROUP BY subject
       HAVING count(DISTINCT narrative_start) >= 2
       ORDER BY count(DISTINCT narrative_start) DESC, subject
       LIMIT 40`,
      [projectId, minOrder, maxOrder],
    );
    const subjectSpans: SerialSubjectSpan[] = subjectRows.rows.map((row) => ({
      subject: row.subject,
      narrativeOrders: row.orders.map((value) => Number(value)),
      latestExcerpt: row.latest_title ?? "",
    }));

    // openPromises：项目开放承诺账本（不随窗口截断——期限类事实的建立章可能远早于
    // 窗口起点，且引用它之前必须知道它的建立位置；按建立章排序供「不早于建立章」核对）。
    // 孤儿 source_revision（文档已删）仍投影，established_order 为 NULL 由渲染层如实标注。
    const promiseRows = await this.pool.query<{ statement: string; established_order: number | null }>(
      `SELECT p.statement, d.narrative_order AS established_order
       FROM promises p
       LEFT JOIN manuscript_revisions mr ON mr.id = p.source_revision_id
       LEFT JOIN manuscript_documents d ON d.id = mr.document_id
       WHERE p.project_id=$1 AND p.status='open'
       ORDER BY d.narrative_order ASC NULLS LAST, p.id
       LIMIT 40`,
      [projectId],
    );
    // 拿不到章节序的承诺仍投影（establishedAtOrder=null，如孤儿修订），渲染层如实标注。
    const openPromises: SerialOpenPromise[] = promiseRows.rows.map((row) => ({
      statement: row.statement,
      establishedAtOrder: row.established_order === null ? null : Number(row.established_order),
    }));

    return {
      window,
      chapters: windowChapters,
      characterSpans,
      functionRuns,
      subjectSpans,
      openPromises,
      // assetSpans 由 activities 层按窗口正文做确定性扫描后回填并**重算指纹**
      // （repository 无 object store 访问权）。两侧共用 serialContextFingerprint 算式。
      assetSpans: [],
      fingerprint: serialContextFingerprint({ window, chapters: windowChapters, characterSpans, functionRuns, subjectSpans, openPromises, assetSpans: [] }),
    };
  }

  /**
   * 序列证据的可用目标章——"哪一章能被 getSerialContextSnapshot 当 target 用"的唯一口径。
   *
   * 判据与 `buildNarrativeRhythmSnapshotQuery` 的 target 条件同形（chapters 行存在、
   * document.status='final'、已挂 current_revision_id）。不同形就会给出"解析成功但
   * 快照恒空"的目标：本应可见的字段静默缺失（`novel_context_get` 的序列证据块即因传空
   * documentId 长期恒缺，而 smoke 测试跑在没有章节的空项目上，看不出差别）。
   */
  async getLatestFinalChapterTarget(projectId: string): Promise<{ documentId: string; narrativeOrder: number } | undefined> {
    const result = await this.pool.query<{ document_id: string; narrative_order: string | number }>(
      `SELECT d.id AS document_id, d.narrative_order
       FROM chapters target
       JOIN manuscript_documents d ON d.id=target.document_id AND d.project_id=target.project_id
       WHERE target.project_id=$1 AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
       ORDER BY d.narrative_order DESC LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { documentId: row.document_id, narrativeOrder: Number(row.narrative_order) };
  }

  /**
   * 近 N 章审核 issue 按规则类聚类（learning 跨章聚合输入）。
   *
   * 设计依据：AGENTS.md「review-stage → learning 通路」——单章 issue 构不成"持续模式"，
   * 只有同 rule/title 类别在多个章节重复出现才能让 learning 判定 propose-improvement。
   * 聚类键优先 rule，其次 title（已规范化空白），按命中章节数降序。
   *
   * TODO P3: window 为魔法值，应可配置（learning 跨章窗口预算的一部分）。
   */
  async getRecentReviewIssueClusters(projectId: string, narrativeCutoff: number, window = 6): Promise<RecentIssueCluster[]> {
    const minOrder = Math.max(1, narrativeCutoff - window + 1);
    // evidence-unverified issue 的 evidence 在正文零命中，可能是审校模型对指令示例词的回显误报。
    // 聚类时排除这些 issue，避免误报形成"持续模式"污染 learning propose-improvement。
    // 设计依据：AGENTS.md「根因分析与迭代改进」——基于"证据是否在正文出现"这一结构特征过滤，
    // 跨题材复用，不识别特定审校模型或指令示例词。
    const result = await this.pool.query<{ key: string; chapter_count: string; orders: string[]; titles: string[]; severities: string[] }>(
      `WITH windowed AS (
         SELECT d.id AS document_id, d.narrative_order, d.title, i.rule, i.title AS issue_title, i.severity
         FROM chapter_review_snapshots s
         JOIN manuscript_documents d ON d.id=s.document_id AND d.project_id=s.project_id
         JOIN chapter_review_snapshot_issues i ON i.snapshot_id=s.id
         WHERE s.project_id=$1 AND d.narrative_order BETWEEN $2 AND $3
           AND (i.dimension IS NULL OR i.dimension != 'evidence-unverified')
       )
       SELECT COALESCE(NULLIF(trim(rule),''), trim(issue_title)) AS key,
              count(DISTINCT document_id) AS chapter_count,
              array_agg(DISTINCT narrative_order ORDER BY narrative_order) AS orders,
              array_agg(DISTINCT title ORDER BY title) AS titles,
              array_agg(DISTINCT severity) AS severities
       FROM windowed
       GROUP BY key
       HAVING count(DISTINCT document_id) >= 2
       ORDER BY chapter_count DESC, key`,
      [projectId, minOrder, narrativeCutoff],
    );
    return result.rows.map((row) => ({
      key: row.key,
      chapterCount: Number(row.chapter_count),
      narrativeOrders: row.orders.map((value) => Number(value)),
      titles: row.titles,
      severities: row.severities,
    }));
  }

  async findNextPlannedArcDocument(projectId: string): Promise<ManuscriptDocumentSummary | undefined> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT d.id,d.project_id,d.title,d.narrative_order,d.pov_character_id,d.current_revision_id,d.status,d.created_at,d.updated_at
       FROM manuscript_documents d JOIN chapters c ON c.document_id=d.id JOIN arcs a ON a.id=c.arc_id
       WHERE d.project_id=$1 AND d.status='planned' AND d.current_revision_id IS NULL AND a.planning_status='approved' AND a.execution_status='active'
       ORDER BY d.narrative_order LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ? documentFromRow(result.rows[0]) : undefined;
  }

  async putChapterPlanningContext(blueprintId: string, documentId: string, context: ChapterPlanningContext): Promise<void> {
    await this.pool.query(
      `INSERT INTO chapter_planning_contexts(id,project_id,document_id,arc_id,chapter_blueprint_id,source_artifact_ids,payload,fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [blueprintId, context.projectId, documentId, context.arcId, context.chapterBlueprintId, context.sourceArtifactIds, context, context.fingerprint],
    );
  }

  async getChapterPlanningContextSnapshot(blueprintId: string): Promise<ChapterPlanningContext | undefined> {
    const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM chapter_planning_contexts WHERE id=$1", [blueprintId]);
    return normalizeChapterPlanningContext(result.rows[0]?.payload);
  }

  async previewChapterPlanApplication(projectId: string): Promise<{
    creates: Array<{ index: number; title: string; summary?: string }>;
    updates: Array<{ documentId: string; index: number; fromTitle: string; title: string; summary?: string }>;
    conflicts: Array<{ documentId: string; index: number; title: string; reason: string }>;
  }> {
    await this.assertRequiredPlanApproved(projectId);
    const section = await this.getProjectPlanSection(projectId, "chapter-plan");
    const structured = section?.payload.structuredData;
    const chapters = structured && typeof structured === "object" && !Array.isArray(structured)
      ? (structured as Record<string, unknown>).chapters
      : undefined;
    if (!Array.isArray(chapters)) throw new Error("章节计划缺少 chapters 数组");
    const existing = await this.pool.query<DocumentRow>(
      "SELECT id,project_id,title,narrative_order,pov_character_id,current_revision_id,status,created_at,updated_at FROM manuscript_documents WHERE project_id=$1",
      [projectId],
    );
    const byOrder = new Map(existing.rows.map((row) => [Number(row.narrative_order), row]));
    const preview = { creates: [] as Array<{ index: number; title: string; summary?: string }>, updates: [] as Array<{ documentId: string; index: number; fromTitle: string; title: string; summary?: string }>, conflicts: [] as Array<{ documentId: string; index: number; title: string; reason: string }> };
    for (const raw of chapters) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const chapter = raw as Record<string, unknown>;
      const index = Number(chapter.index);
      const title = typeof chapter.title === "string" ? chapter.title.trim() : "";
      const state = chapter.stateTransition && typeof chapter.stateTransition === "object" && !Array.isArray(chapter.stateTransition) ? chapter.stateTransition as Record<string, unknown> : undefined;
      const summary = typeof state?.evidence === "string" ? state.evidence : undefined;
      if (!Number.isInteger(index) || index < 1 || !title) continue;
      const document = byOrder.get(index);
      if (!document) preview.creates.push({ index, title, summary });
      else if (document.current_revision_id || document.status !== "planned") preview.conflicts.push({ documentId: document.id, index, title: document.title, reason: "章节已有正文或已进入创作流程" });
      else if (document.title !== title) preview.updates.push({ documentId: document.id, index, fromTitle: document.title, title, summary });
    }
    return preview;
  }

  async applyChapterPlan(projectId: string) {
    const preview = await this.previewChapterPlanApplication(projectId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const chapter of preview.creates) {
        await client.query(
          "INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'planned')",
          [randomUUID(), projectId, chapter.title, chapter.index],
        );
      }
      for (const chapter of preview.updates) {
        await client.query(
          "UPDATE manuscript_documents SET title=$3,updated_at=now() WHERE id=$1 AND project_id=$2 AND status='planned' AND current_revision_id IS NULL",
          [chapter.documentId, projectId, chapter.title],
        );
      }
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'web-author','plan.chapters.applied','project-plan',$1,$2)",
        [projectId, preview],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { ...preview, applied: { created: preview.creates.length, updated: preview.updates.length } };
  }

  async listRunArtifacts(temporalWorkflowId: string): Promise<Artifact[]> {
    const run = await this.getWorkflowRunByTemporalId(temporalWorkflowId);
    if (!run) return [];
    const result = await this.pool.query<ArtifactRow>(`
      SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
      FROM artifacts
       WHERE project_id=$1 AND (payload->>'workflowId'=$2 OR payload->>'runId'=$2)
      ORDER BY created_at DESC
      LIMIT 100
    `, [run.projectId, temporalWorkflowId]);
    return result.rows.map(artifactFromRow);
  }

  async assertRuntimeObjectStoreIdentity(identity: ObjectStoreIdentity): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ymcp-novel-v2-object-store'))");
      const result = await client.query<{ value: ObjectStoreIdentity }>("SELECT value FROM runtime_configuration WHERE key='object-store' FOR UPDATE");
      const recorded = result.rows[0]?.value;
      if (recorded && recorded.fingerprint !== identity.fingerprint) {
        throw new Error(`对象存储配置与数据库绑定不一致：数据库=${recorded.backend}:${recorded.location}，当前=${identity.backend}:${identity.location}`);
      }
      if (!recorded) {
        await client.query("INSERT INTO runtime_configuration(key,value) VALUES('object-store',$1)", [identity]);
      } else {
        await client.query("UPDATE runtime_configuration SET updated_at=now() WHERE key='object-store'");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRuntimeConfiguration<T>(key: string): Promise<T | undefined> {
    const result = await this.pool.query<{ value: T }>("SELECT value FROM runtime_configuration WHERE key=$1", [key]);
    return result.rows[0]?.value;
  }

  async setRuntimeConfiguration(key: string, value: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "INSERT INTO runtime_configuration(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [key, value],
    );
  }

  async listCurrentDocumentObjectKeys(): Promise<Array<{ documentId: string; title: string; objectKey: string }>> {
    const result = await this.pool.query<{ document_id: string; title: string; object_key: string }>(
      `SELECT d.id AS document_id,d.title,cb.object_key
       FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       JOIN content_blobs cb ON cb.content_hash=mr.content_hash
       WHERE d.status='final'`,
    );
    return result.rows.map((row) => ({ documentId: row.document_id, title: row.title, objectKey: row.object_key }));
  }

  async listReferencedObjectKeys(): Promise<Array<{ objectKey: string; contentHash: string; reference: string }>> {
    // 空/NULL object_key 的行（如 restore/占位类 artifact，仅有元数据无存储对象）不是
    // 可验证的对象引用：objects.has('') 会让 S3 SDK 因空 Key 抛序列化异常，导致启动
    // 失败。完整性检查只针对真实持有存储键的引用；空键行的可读性无从校验，排除之。
    const result = await this.pool.query<{ object_key: string; content_hash: string; reference: string }>(`
      SELECT cb.object_key,cb.content_hash,'content-blob'::text AS reference
      FROM content_blobs cb
      WHERE COALESCE(cb.object_key,'')<>''
        AND (EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.content_hash=cb.content_hash)
          OR EXISTS (SELECT 1 FROM manuscript_blocks mb WHERE mb.content_hash=cb.content_hash)
          OR EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash=cb.content_hash))
      UNION
      SELECT a.object_key,a.content_hash,'artifact'::text AS reference FROM artifacts a
      WHERE COALESCE(a.object_key,'')<>''
      ORDER BY object_key
    `);
    return result.rows.map((row) => ({ objectKey: row.object_key, contentHash: row.content_hash, reference: row.reference }));
  }

  async listRunReviews(temporalWorkflowId: string) {
    const run = await this.getWorkflowRunByTemporalId(temporalWorkflowId);
    if (!run) return [];
    const result = await this.pool.query<{
      id: string; project_id: string; artifact_id: string; artifact_fingerprint: string; reviewer_id: string;
      identity: "internal" | "independent" | "human";
      verdict: "passed" | "revise" | "blocked";
      issues: Review["issues"]; score: number | null; role: string | null; dimension_scores: unknown;
      created_at: Date | string;
    }>(`
      SELECT r.id,r.project_id,r.artifact_id,r.artifact_fingerprint,r.reviewer_id,r.identity,r.verdict,r.issues,r.score,r.role,r.dimension_scores,r.created_at
      FROM reviews r
      JOIN artifacts a ON a.id=r.artifact_id
      WHERE r.project_id=$1 AND (a.payload->>'workflowId'=$2 OR a.payload->>'runId'=$2)
      ORDER BY r.created_at ASC,r.id ASC
    `, [run.projectId, temporalWorkflowId]);
    return result.rows.map((row) => normalizeManuscriptStructuralReview({
      id: row.id, projectId: row.project_id, artifactId: row.artifact_id, reviewerId: row.reviewer_id,
      identity: row.identity, verdict: row.verdict, issues: row.issues ?? [],
      artifactFingerprint: row.artifact_fingerprint, score: row.score === null ? undefined : Number(row.score), role: row.role ?? undefined,
      createdAt: new Date(row.created_at).getTime(),
      } as Review));
  }

  async listRunOutbox(temporalWorkflowId: string, afterId = 0) {
    const run = await this.getWorkflowRunByTemporalId(temporalWorkflowId);
    if (!run) return [];
    const result = await this.pool.query(`
      WITH run_artifacts AS (
        SELECT id FROM artifacts
        WHERE project_id=$1 AND (payload->>'workflowId'=$2 OR payload->>'runId'=$2)
      )
      SELECT id,aggregate_type,aggregate_id,event_type,payload,created_at
      FROM outbox_events
      WHERE id>$3 AND payload->>'projectId'=$1 AND (
        (aggregate_type='workflow-run' AND aggregate_id=$2)
        OR payload->>'workflowId'=$2 OR payload->>'runId'=$2
        OR payload->'source'->>'workflowId'=$2
        OR aggregate_id IN (SELECT id FROM run_artifacts)
        OR payload->>'artifactId' IN (SELECT id FROM run_artifacts)
        OR payload->>'sourceArtifactId' IN (SELECT id FROM run_artifacts)
      )
      ORDER BY id LIMIT 200
    `, [run.projectId, temporalWorkflowId, afterId]);
    return result.rows;
  }

    async listModelInvocationErrors(projectId?: string, limit = 50) {
    return this.telemetry.listModelInvocationErrors(projectId, limit);
  }

  async listFoundationArtifacts(projectId: string): Promise<Artifact[]> {
    const result = await this.pool.query<ArtifactRow>(`
      SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
      FROM artifacts
      WHERE project_id=$1 AND kind='foundation'
      ORDER BY created_at ASC
    `, [projectId]);
    return result.rows.map(artifactFromRow);
  }

  async getArtifactById(projectId: string, artifactId: string): Promise<Artifact | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
       FROM artifacts WHERE project_id=$1 AND id=$2`,
      [projectId, artifactId],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  /**
   * 列出项目下的创作产物（按时间倒序），供外部编排者定位审核/决策对象。
   *
   * 设计依据：mcp-orchestrator.md「外部大模型作为编排者」——外部模型需要
   * 找到 blueprint/draft/review artifactId 才能调用 novel_artifact_get 阅读
   * 内容并做审核或决策。kind 可选过滤（foundation/chapter-blueprint/draft/
   * review 等），workflow 级列表仍使用 listRunArtifacts(temporalWorkflowId)。
   */
  async listProjectArtifacts(input: { projectId: string; kind?: string; limit?: number }): Promise<Artifact[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const params: unknown[] = [input.projectId];
    let filterSql = "";
    if (input.kind) {
      params.push(input.kind);
      filterSql = " AND kind=$2";
    }
    params.push(limit);
    const result = await this.pool.query<ArtifactRow>(
      `SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
       FROM artifacts
       WHERE project_id=$1${filterSql}
       ORDER BY created_at DESC,id DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(artifactFromRow);
  }

  async getArtifact(artifactId: string, connection: Pool | PoolClient = this.pool): Promise<Artifact | undefined> {
    const result = await connection.query<ArtifactRow>(
      `SELECT id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload,created_at
       FROM artifacts WHERE id=$1`,
      [artifactId],
    );
    return result.rows[0] ? artifactFromRow(result.rows[0]) : undefined;
  }

  async createNextDocument(projectId: string, title?: string): Promise<ManuscriptDocumentSummary> {
    const narrativeOrder = await this.nextDocumentOrder(projectId);
    return this.ensureDocument({ projectId, title: title?.trim() || `第 ${narrativeOrder} 章`, narrativeOrder, status: "planned" });
  }

  async getDocumentStatus(projectId: string, documentId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ status: string }>("SELECT status FROM manuscript_documents WHERE project_id=$1 AND id=$2", [projectId, documentId]);
    return result.rows[0]?.status;
  }

  /**
   * Generation must use the manuscript lifecycle as its authority. A stale
   * blueprint projection must not make an already committed chapter writable.
   */
  async assertChapterGenerationAllowed(projectId: string, documentId: string): Promise<void> {
    const result = await this.pool.query<{ status: string; current_revision_id: string | null }>(
      "SELECT status,current_revision_id FROM manuscript_documents WHERE project_id=$1 AND id=$2",
      [projectId, documentId],
    );
    const document = result.rows[0];
    if (!document) throw new Error(`章节不存在:${documentId}`);
    if (document.status === "final" || document.current_revision_id !== null) {
      throw new Error("章节已定稿,如需重审请使用 novel_chapter_review");
    }
  }

  async getChapterReviewPreflight(projectId: string, documentId: string): Promise<{ status: string; baseRevision: number; activeWorkflowId?: string; projectActiveReviewWorkflowId?: string; hasBlueprint: boolean } | undefined> {
    const document = await this.pool.query<{ status: string; current_revision: string | number }>(
      `SELECT d.status,p.current_revision FROM manuscript_documents d JOIN novel_projects p ON p.id=d.project_id WHERE d.project_id=$1 AND d.id=$2`,
      [projectId, documentId],
    );
    if (!document.rowCount) return undefined;
    const [activeWorkflowId, projectActiveReviewWorkflowId, blueprint] = await Promise.all([
      this.findActiveChapterReview(projectId, documentId),
      this.findActiveProjectChapterReview(projectId, documentId),
      this.findHistoricalBlueprintForDocument(projectId, documentId),
    ]);
    return { status: document.rows[0].status, baseRevision: Number(document.rows[0].current_revision), activeWorkflowId, projectActiveReviewWorkflowId, hasBlueprint: Boolean(blueprint) };
  }

  /**
   * 查找同项目其他章节的活跃 chapter-review 工作流。
   *
   * 设计依据：并发审校同一项目的不同章节时，前一个工作流 commit 会提升项目
   * current_revision，使后一个工作流 commit 因"正式稿基线已变化"整体失败。
   * 这是项目级串行约束（基线是项目级的），不是单章节约束；启动时检测并提示，
   * 让调用方决定串行等待，避免事后失败。
   */
  async findActiveProjectChapterReview(projectId: string, documentId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ temporal_workflow_id: string }>(
      `SELECT temporal_workflow_id FROM workflow_runs
       WHERE project_id=$1 AND workflow_type='chapter-review'
         AND (payload->>'documentId') IS DISTINCT FROM $2
         AND status IN (${OPEN_WORKFLOW_RUN_STATUSES_SQL})
       ORDER BY updated_at DESC LIMIT 1`,
      [projectId, documentId],
    );
    return result.rows[0]?.temporal_workflow_id;
  }

  async findActiveChapterReview(projectId: string, documentId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ temporal_workflow_id: string }>(
      `SELECT temporal_workflow_id FROM workflow_runs WHERE project_id=$1 AND payload->>'documentId'=$2 AND workflow_type='chapter-review' AND status IN (${OPEN_WORKFLOW_RUN_STATUSES_SQL}) ORDER BY updated_at DESC LIMIT 1`,
      [projectId, documentId],
    );
    return result.rows[0]?.temporal_workflow_id;
  }

  async getPromotionReceiptById(receiptId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query("SELECT id,candidate_id,project_id,status,result,failure_reason,created_at FROM promotion_receipts WHERE id=$1", [receiptId]);
    return result.rows[0];
  }

  async getCraftRuleTarget(target: { kind: "skill" | "system-prompt"; projectId: string; targetId: string }): Promise<Record<string, unknown> | undefined> {
    if (target.kind === "system-prompt") {
      const separator = target.targetId.indexOf(":");
      const projectId = separator >= 0 ? target.targetId.slice(0, separator) : target.projectId;
      const templateId = separator >= 0 ? target.targetId.slice(separator + 1) : target.targetId;
      if (!projectId || !templateId) return undefined;
      const result = await this.pool.query("SELECT project_id,template_id,version,stages,content,content_fingerprint,active,created_at,updated_at FROM prompt_templates WHERE project_id=$1 AND template_id=$2", [projectId, templateId]);
      return result.rows[0];
    }
    const result = await this.pool.query("SELECT skill_id,version,capabilities,applicable_tasks,required_memory_kinds,conflicts,quality_gates,prompt_sections,enabled,updated_at FROM skill_definitions WHERE skill_id=$1 ORDER BY version DESC LIMIT 1", [target.targetId]);
    return result.rows[0];
  }

  async countDocuments(projectId: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM manuscript_documents WHERE project_id=$1", [projectId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async findHistoricalBlueprintForDocument(projectId: string, documentId: string): Promise<{ blueprint: ExecutionBlueprint; artifactId: string } | undefined> {
    // 首选：novel-intent 链路的 draft artifact 反查 execution_blueprints（review-stage 不重新编译蓝图）。
    const result = await this.pool.query<{ payload: ExecutionBlueprint; artifact_id: string }>(
      `SELECT eb.payload,a.id AS artifact_id
       FROM artifacts a
       JOIN execution_blueprints eb ON a.task_id=eb.id || ':draft'
       JOIN novel_intents ni ON ni.id=eb.intent_id
       WHERE a.project_id=$1 AND a.kind='draft'
         AND ni.payload->'target'->>'kind'='chapter'
         AND ni.payload->'target'->>'id'=$2
       ORDER BY a.created_at DESC LIMIT 1`,
      [projectId, documentId],
    );
    if (result.rows[0]) return { blueprint: result.rows[0].payload, artifactId: result.rows[0].artifact_id };
    // 回退：产物保留策略可能清理 intent 链路的历史 :draft artifact，但章节的
    // execution_blueprints 行（payload 即 ExecutionBlueprint，含 id/preflightId/budget）
    // 是审校链路真正的加载源（reviewByRefs/reviseByRefs 按 blueprintId 读本表），
    // 仍被 memory_bundles/skill_bundles/章节工作区快照引用，不会随产物清理消失。
    // 按 intent 反查最近一条章节蓝图，artifactId 以最近的 review-draft 兜底
    // （仅供审计溯源；工作流自身会用当前正文新建 review-draft artifact）。
    const fallback = await this.pool.query<{ payload: ExecutionBlueprint; review_draft_id: string | null }>(
      `SELECT eb.payload AS payload,
              (SELECT a.id FROM artifacts a WHERE a.task_id=eb.id || ':review-draft' AND a.kind='draft' ORDER BY a.created_at DESC LIMIT 1) AS review_draft_id
       FROM novel_intents ni
       JOIN execution_blueprints eb ON eb.intent_id=ni.id
       WHERE ni.project_id=$1 AND ni.payload->'target'->>'kind'='chapter' AND ni.payload->'target'->>'id'=$2
       ORDER BY eb.created_at DESC LIMIT 1`,
      [projectId, documentId],
    );
    if (fallback.rows[0]?.payload) return { blueprint: fallback.rows[0].payload, artifactId: fallback.rows[0].review_draft_id ?? fallback.rows[0].payload.id };
    return undefined;
  }

  async getFinalDocumentContentRef(projectId: string, documentId: string): Promise<{ title: string; status: string; narrativeOrder: number; revision: number; sourceRevisionId?: string; artifactId?: string; contentHash: string; objectKey: string } | undefined> {
    const result = await this.pool.query<{ title: string; status: string; narrative_order: string | number; revision_id: string | null; revision: string | number | null; artifact_id: string | null; content_hash: string | null; object_key: string | null }>(
      `SELECT d.title,d.status,d.narrative_order,mr.id AS revision_id,mr.revision,mr.artifact_id,mr.content_hash,cb.object_key
       FROM manuscript_documents d
       LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
       WHERE d.project_id=$1 AND d.id=$2`,
      [projectId, documentId],
    );
    const row = result.rows[0];
    if (!row || row.revision === null || !row.revision_id || !row.content_hash || !row.object_key) return row ? { title: row.title, status: row.status, narrativeOrder: Number(row.narrative_order), revision: 0, contentHash: "", objectKey: "" } : undefined;
    return { title: row.title, status: row.status, narrativeOrder: Number(row.narrative_order), revision: Number(row.revision), sourceRevisionId: row.revision_id, artifactId: row.artifact_id ?? undefined, contentHash: row.content_hash, objectKey: row.object_key };
  }

  /**
   * 取本章之前最近 N 章的结尾末段正文（跨章语境，供 manuscript.ending-ritual 判据使用）。
   *
   * 设计依据：AGENTS.md「在拥有错误行为的最低共享层修复」——章末仪式化（"清点/吹灯/
   * 格账留白"在 50+ 章近 verbatim 复现）在单章内与"留白"这一本书优点**形态相同**，
   * 任何单章判据都会把优点一起打掉。故通道必须跨章，而跨章语境只有编排方能提供。
   *
   * 返回对象存储的 object_key 列表（非纯文本）：正文住在 MinIO，仓储层只持有引用，
   * 取文本与裁末段由 activities.loadPriorChapterEndings 完成（objects.getText +
   * extractChapterEnding）。这样分段口径（extractChapterEnding）只有一处定义，
   * 仓储层不重复实现文本切分。
   * 只取 status='final' 且 current_revision_id 非空的行，保证比较对象是已定稿正文。
   * 返回按章序**升序**（最早的在前），与 narrativeOrder 自然序一致。
   */
  async getPriorChapterEndings(input: { projectId: string; narrativeOrder: number; count: number }): Promise<string[]> {
    if (input.count <= 0) return [];
    const result = await this.pool.query<{ narrative_order: string | number; content_hash: string; object_key: string }>(
      `SELECT d.narrative_order, mr.content_hash, cb.object_key
       FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       JOIN content_blobs cb ON cb.content_hash=mr.content_hash
       WHERE d.project_id=$1 AND ${PROJECTABLE_FINAL_DOCUMENT_SQL}
         AND d.narrative_order < $2
       ORDER BY d.narrative_order DESC, d.id DESC
       LIMIT $3`,
      [input.projectId, input.narrativeOrder, input.count],
    );
    return result.rows
      .sort((a, b) => Number(a.narrative_order) - Number(b.narrative_order))
      .map((row) => row.object_key);
  }

  private async findLaterFinalDocument(projectId: string, narrativeOrder: number, connection: Pool | PoolClient = this.pool): Promise<{ id: string; narrativeOrder: number } | undefined> {
    const result = await connection.query<{ id: string; narrative_order: string | number }>(
      `SELECT id,narrative_order FROM manuscript_documents
       WHERE project_id=$1 AND status='final' AND current_revision_id IS NOT NULL AND narrative_order>$2
       ORDER BY narrative_order,id LIMIT 1`,
      [projectId, narrativeOrder],
    );
    const row = result.rows[0];
    return row ? { id: row.id, narrativeOrder: Number(row.narrative_order) } : undefined;
  }

  private async assertNoLaterFinalDocument(projectId: string, narrativeOrder: number, connection: Pool | PoolClient = this.pool): Promise<void> {
    const later = await this.findLaterFinalDocument(projectId, narrativeOrder, connection);
    if (later) {
      throw new ChapterStateRebuildConflictError({
        targetNarrativeOrder: narrativeOrder,
        laterFinalDocumentId: later.id,
        laterNarrativeOrder: later.narrativeOrder,
      });
    }
  }

  async assertChapterStateRebuildHead(projectId: string, documentId: string, revisionId: string): Promise<void> {
    const target = await this.pool.query<{ narrative_order: string | number; current_revision_id: string | null }>(
      "SELECT narrative_order,current_revision_id FROM manuscript_documents WHERE id=$1 AND project_id=$2",
      [documentId, projectId],
    );
    if (!target.rowCount || target.rows[0].current_revision_id !== revisionId) throw new Error("章节正式 revision 已变化，不能重建过期状态");
    await this.assertNoLaterFinalDocument(projectId, Number(target.rows[0].narrative_order));
  }

  async listCapturedSnapshots(projectId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query("SELECT id,project_id,hash,head,created_at FROM project_snapshots WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return result.rows;
  }

  async getCapturedSnapshot(snapshotId: string, projectId?: string): Promise<ProjectSnapshotBundle | undefined> {
    const result = projectId
      ? await this.pool.query("SELECT id,project_id,hash,payload,head,created_at FROM project_snapshots WHERE id=$1 AND project_id=$2", [snapshotId, projectId])
      : await this.pool.query("SELECT id,project_id,hash,payload,head,created_at FROM project_snapshots WHERE id=$1", [snapshotId]);
    const row = result.rows[0];
    return row ? { id: row.id, projectId: row.project_id, hash: row.hash, payload: row.payload, head: row.head, createdAt: new Date(row.created_at).getTime() } : undefined;
  }

  async listCandidateBundles(projectId: string): Promise<CandidateBundle[]> {
    const result = await this.pool.query("SELECT payload FROM candidate_bundles WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return result.rows.map((row) => row.payload);
  }

  async getCandidateBundle(candidateId: string): Promise<CandidateBundle | undefined> {
    const result = await this.pool.query("SELECT payload FROM candidate_bundles WHERE id=$1", [candidateId]);
    return result.rows[0]?.payload;
  }

  async saveCandidateBundle(candidate: CandidateBundle): Promise<void> {
    await this.pool.query(
      "INSERT INTO candidate_bundles(id,experiment_id,project_id,payload,fingerprint,created_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(id) DO NOTHING",
      [candidate.id, candidate.experimentId, candidate.sourceProjectId, candidate, candidate.manuscript.contentHash],
    );
  }

  async listPromotionReceipts(projectId: string): Promise<PromotionReceipt[]> {
    const result = await this.pool.query("SELECT id,candidate_id,project_id,status,result,failure_reason,created_at FROM promotion_receipts WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return result.rows.map((row) => ({ id: row.id, candidateId: row.candidate_id, projectId: row.project_id, status: row.status, result: row.result, failureReason: row.failure_reason ?? undefined, createdAt: new Date(row.created_at).getTime() }));
  }

  async getDocumentRevisionBaseline(projectId: string, documentId: string): Promise<{ revision: number; contentHash: string } | undefined> {
    const result = await this.pool.query<{ revision: string | number; content_hash: string }>(
      `SELECT mr.revision,mr.content_hash FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
       WHERE d.project_id=$1 AND d.id=$2`,
      [projectId, documentId],
    );
    return result.rows[0] ? { revision: Number(result.rows[0].revision), contentHash: result.rows[0].content_hash } : undefined;
  }

  async getDocumentNarrativeOrder(projectId: string, documentId: string): Promise<number | undefined> {
    const result = await this.pool.query<{ narrative_order: string | number }>("SELECT narrative_order FROM manuscript_documents WHERE project_id=$1 AND id=$2", [projectId, documentId]);
    return result.rows[0] ? Number(result.rows[0].narrative_order) : undefined;
  }

  /**
   * 提交面的**有效**目标篇幅（篇幅欠量门判据），与 lifecycle 三面同源同尺：
   * `planningContext?.chapter ? chapter.targetWordCount ?? DEFAULT : undefined`。
   *
   * 三条口径都对齐到该式：
   * - "有无蓝图"用 `chapters JOIN arcs` 同一形状——lifecycle 的 planningContext 正是这条
   *   join 拿不到行时抛错为 undefined 的，判据不同形就会一个面施门、另一个面不施；
   * - 有蓝图但未声明目标 ⇒ 回落 `DEFAULT_TARGET_WORD_COUNT`，因为 draft prompt 播报的
   *   就是这个回落值（门与指引一本账；09-17 的"同一目标三个数"即两侧各自回落的前一次现形）；
   * - 无蓝图 ⇒ undefined，门不施——门不替系统从没承载过该章的场合发明目标。
   * 归一判据单源见 `normalizeTargetWordCount`。
   */
  async getChapterTargetWordCount(projectId: string, documentId: string): Promise<number | undefined> {
    const result = await this.pool.query<{ payload: Record<string, unknown> | null }>(
      "SELECT c.payload FROM chapters c JOIN arcs a ON a.id=c.arc_id WHERE c.project_id=$1 AND c.document_id=$2 LIMIT 1",
      [projectId, documentId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    // 量纲与回落各自单源（normalizeTargetWordCount 与 chapterBlueprintFromRow 同一判据，
    // effectiveTargetWordCount 与 draft prompt 播报同一回落）。
    return effectiveTargetWordCount(normalizeTargetWordCount(row.payload?.targetWordCount));
  }

  async getLatestMemoryBundle(projectId: string): Promise<MemoryBundle | undefined> {
    const result = await this.pool.query<{ payload: MemoryBundle }>("SELECT payload FROM memory_bundles WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1", [projectId]);
    return result.rows[0]?.payload;
  }

  /**
   * Foundation 投影落库（段级单例 + 代际收敛）。
   *
   * 设计依据：memory-governance-audit-20260909 §M4/§5.3.1 与 product-audit-20260910 A2——
   * 早期实现每次生成追加一条整段投影（supersedes 硬编码为空），历史代际常驻 active；
   * 9/9 的"最新代 supersede 其余代"修复仍让每代各保一行，检索轨任何一处退役口径漂移
   * 都会把陈旧投影放回 bundle（实测 draft preflight 混入 20-29 条陈旧 foundation 行）。
   * 段级单例（id = foundation:<projectId>:<taskKey>）从 id 层根除：
   * - 每槽位只有一行，重新生成即覆盖写（replaceExistingById），Qdrant 同名点物理覆盖；
   * - 非最新 artifact 的投影不再落行，历史原文只存 artifacts 表（source_artifact_id 溯源）；
   * - 存量 per-artifact 行由单例行的 supersedes 一次性退役（配合 memory-visibility 统一口径）。
   */
  async recordFoundationClaim(input: { projectId: string; claim: MemoryClaim; sourceArtifactId: string }): Promise<MemoryClaim[]> {
    const taskKeyRef = input.claim.subjectRefs.find((ref) => ref.startsWith("foundation:"));
    const taskKey = taskKeyRef ? taskKeyRef.slice("foundation:".length) : undefined;
    if (!taskKey || !taskKeyRef) {
      return this.recordMemoryClaims({ projectId: input.projectId, claims: [input.claim], sourceArtifactId: input.sourceArtifactId });
    }
    const latest = await this.pool.query<{ id: string }>(
      `SELECT id FROM artifacts
       WHERE project_id=$1 AND kind='foundation' AND payload->>'taskKey'=$2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.projectId, taskKey],
    );
    if (latest.rows[0]?.id !== input.sourceArtifactId) {
      // 段级单例下陈旧代际不再落投影行：槽位内容由最新代的单例行承载，
      // 历史原文永久保存在 artifacts 表（审计溯源走 source_artifact_id，不靠记忆层留档）。
      return [];
    }
    const prior = await this.pool.query<{ id: string }>(
      `SELECT id FROM memory_claims
       WHERE project_id=$1 AND lifecycle_status='active' AND subject_refs && $2::text[] AND id <> $3`,
      [input.projectId, [taskKeyRef], input.claim.id],
    );
    const supersedes = [...new Set([...prior.rows.map((row) => row.id), ...input.claim.supersedes])];
    // 段级单例覆盖写：同 (project,taskKey) 重新生成时刷新内容并指向最新 artifact；
    // prior 里同槽位的其余 active 行（历史 per-artifact 代际）以 supersedes 退役。
    return this.recordMemoryClaims({ projectId: input.projectId, claims: [{ ...input.claim, supersedes }], sourceArtifactId: input.sourceArtifactId, replaceExistingById: true });
  }

  async ensureFoundationMemoryClaims(projectId: string): Promise<MemoryClaim[]> {
    const artifacts = await this.listFoundationArtifacts(projectId);
    if (!artifacts.length) return [];
    // 段级单例回填：只处理每个 taskKey 的最新 artifact；单例行已指向该 artifact 则跳过。
    const latestByTask = new Map<string, Artifact>();
    for (const artifact of artifacts) {
      const taskKey = typeof artifact.structuredData?.taskKey === "string" ? artifact.structuredData.taskKey : "foundation";
      const current = latestByTask.get(taskKey);
      if (!current || artifact.createdAt > current.createdAt || (artifact.createdAt === current.createdAt && artifact.id > current.id)) {
        latestByTask.set(taskKey, artifact);
      }
    }
    const claimIds = [...latestByTask.keys()].map((taskKey) => foundationClaimId(projectId, taskKey));
    const existing = await this.pool.query<{ id: string; source_artifact_id: string | null }>(
      "SELECT id,source_artifact_id FROM memory_claims WHERE project_id=$1 AND id = ANY($2::text[])",
      [projectId, claimIds],
    );
    const pointedArtifact = new Map(existing.rows.map((row) => [row.id, row.source_artifact_id]));
    const missing = [...latestByTask.entries()].filter(([taskKey, artifact]) => pointedArtifact.get(foundationClaimId(projectId, taskKey)) !== artifact.id);
    if (!missing.length) return [];

    const runIds = [...new Set(missing.map(([, artifact]) => artifact.structuredData?.runId).filter((value): value is string => typeof value === "string"))];
    const objectives = new Map<string, string>();
    if (runIds.length) {
      const runs = await this.pool.query<{ id: string; objective: string | null }>(
        "SELECT id,payload->>'objective' AS objective FROM creative_runs WHERE id = ANY($1::text[])",
        [runIds],
      );
      for (const run of runs.rows) if (run.objective) objectives.set(run.id, run.objective);
    }

    const recorded: MemoryClaim[] = [];
    for (const [, artifact] of missing) {
      const runId = typeof artifact.structuredData?.runId === "string" ? artifact.structuredData.runId : undefined;
      const claim = foundationArtifactToMemoryClaim(artifact, { objective: runId ? objectives.get(runId) : undefined });
      // 单例覆盖写 + 存量 per-artifact 行退役在 recordFoundationClaim 内完成。
      recorded.push(...await this.recordFoundationClaim({ projectId, claim, sourceArtifactId: artifact.id }));
    }
    return recorded;
  }

  async putCognition(plan: PreflightPlan, memory: MemoryBundle, skills: SkillBundle, blueprint: ExecutionBlueprint, context?: ContextManifest) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (context?.retrievalRunId) await client.query("INSERT INTO retrieval_runs(id,project_id,query,result) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING", [context.retrievalRunId, context.projectId, { preflightId: context.preflightId }, { includedClaimIds: context.includedClaimIds, excludedClaimIds: context.excludedClaimIds }]);
      await client.query("INSERT INTO preflight_plans(id,intent_id,project_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [plan.id, plan.intentId, plan.projectId, plan, plan.sourceFingerprint]);
      await client.query("INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [memory.id, memory.projectId, memory.preflightId, memory, memory.fingerprint]);
      await client.query("INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", [skills.id, skills.projectId, skills.preflightId, skills, skills.fingerprint]);
      if (context) await client.query("INSERT INTO context_manifests(id,project_id,retrieval_run_id,source_revision_ids,token_budget,truncation_reason,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING", [context.id, context.projectId, context.retrievalRunId ?? null, context.sourceRevisionIds, context.tokenBudget, context.truncationReason ?? null, context.fingerprint, context]);
      await client.query("INSERT INTO execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING", [blueprint.id, blueprint.projectId, blueprint.intentId, blueprint.preflightId, blueprint.memoryBundleId, blueprint.skillBundleId, blueprint, blueprint.fingerprint]);
      await this.appendOutboxTx(client, "execution-blueprint", blueprint.id, "execution-blueprint.ready", { ...blueprint, projectId: blueprint.projectId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async upsertTaskAttempt(input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; leaseOwner?: string; leaseMs?: number; payload?: Record<string, unknown> }) {
    return this.modelTasks.upsertAttempt(input);
  }

  async recordTaskSignal(input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) {
    return this.modelTasks.recordSignal(input);
  }

  async recordArtifact(artifact: Artifact) {
    await this.pool.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING", [artifact.id, artifact.projectId, artifact.taskId, artifact.attemptId, artifact.kind, artifact.contentHash, artifact.objectKey ?? "", artifact.baseRevision, artifact.fingerprint, artifact.structuredData ?? {}]);
    await this.appendOutbox("artifact", artifact.id, `artifact.${artifact.kind}.ready`, { projectId: artifact.projectId, artifactId: artifact.id, taskId: artifact.taskId, fingerprint: artifact.fingerprint });
  }

  /**
   * 登记事实提取遇到的名册外主体为待补全实体（state-audit-20261013 §3.6 主体碎片治理）。
   *
   * 根因：prompt.ts 的规范人物名册段已向模型承诺"名册之外的人物以正文原名作 subject.id，
   * 由系统登记为待补全实体"，但出口归一此前只兑现了名册的一半（命中才重写），未命中键
   * 从未落库，于是同一主体反复以不同键形态写入，identityHash 分槽、矛盾核验与槽位时效
   * 排序双双看不见它们。
   *
   * 写入形态与 character-enrichment 的"关系目标实体"占位（payload.pendingEnrichment=true）
   * 完全同构，并沿用同一条引用完整性边界：ON CONFLICT DO NOTHING——已存在的实体（含已富化
   * 档案）绝不被 stub 覆盖。kind 固定为 character：身份索引（loadCharacterIdentityRegistry）
   * 只解析 kind='character'，用其它 kind 登记等于登记了也解析不到，无法消除碎片化。
   * status 由 payload.pendingEnrichment 决定，故这些行不会进入 prompt 的规范名册
   * （名册只列 status='identified'），也不会被当作已富化角色消费。
   *
   * 刻意不覆盖：非 entity 的 subject kind（project/outline/thread/foreshadowing/timeline
   * 各有自己的表与键空间；relation 由 relations 表承载；scene/地点物件归 §5.4 的非人物主体
   * 注册 P2）；不做拼音/近义合并（语义判定超出共享层职责，见审计 §5.5）。
   */
  async registerPendingSubjects(input: {
    projectId: string;
    subjects: ReadonlyArray<{ id: string; kind: string }>;
    sourceRevisionId?: string;
    narrativeOrder?: number;
    source?: string;
  }): Promise<number> {
    let registered = 0;
    for (const subject of input.subjects) {
      const id = subject.id.trim();
      if (!id) continue;
      const entityId = `entity:${input.projectId}:character:${id}`;
      const result = await this.pool.query(
        `INSERT INTO entities(id, project_id, kind, name, payload)
         VALUES($1, $2, 'character', $3, $4)
         ON CONFLICT(id) DO NOTHING`,
        [
          entityId,
          input.projectId,
          id,
          {
            autoCreated: true,
            autoCreatedFrom: input.source ?? "fact-extraction",
            pendingEnrichment: true,
            sourceRevisionId: input.sourceRevisionId,
            narrativeOrder: input.narrativeOrder,
            canonicalCharacterId: id,
            displayName: id,
            displayNameStatus: "pending",
          },
        ],
      );
      registered += result.rowCount ?? 0;
    }
    return registered;
  }

  async recordFactExtraction(input: {
    projectId: string;
    artifact: Artifact;
    claims: MemoryClaim[];
    lifecycleStatus?: "staged" | "active";
    documentId?: string;
    revisionId?: string;
    workflowId?: string;
    narrativeOrder?: number;
  }): Promise<MemoryClaim[]> {
    if (!input.documentId || input.narrativeOrder === undefined) {
      throw new Error("章节事实写入必须同时提供 documentId 和 narrativeOrder");
    }
    await this.recordArtifact(input.artifact);
    return this.recordMemoryClaims({
      projectId: input.projectId,
      claims: scopeClaimsToChapter(input.claims, input.narrativeOrder),
      sourceArtifactId: input.artifact.id,
      lifecycleStatus: input.lifecycleStatus ?? "staged",
      documentId: input.documentId,
      revisionId: input.revisionId,
      workflowId: input.workflowId,
    });
  }

  async replaceCommittedChapterFactSources(input: { projectId: string; documentId: string; revisionId: string; factArtifactId: string; actorId: string }, transactionClient?: PoolClient): Promise<{ removedClaimIds: string[]; activatedClaims: MemoryClaim[] }> {
    const client = transactionClient ?? await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query("BEGIN");
      const current = await client.query<{ current_revision_id: string | null; narrative_order: string | number }>(
        "SELECT current_revision_id,narrative_order FROM manuscript_documents WHERE id=$1 AND project_id=$2 FOR UPDATE",
        [input.documentId, input.projectId],
      );
      if (!current.rowCount || current.rows[0].current_revision_id !== input.revisionId) throw new Error("章节正式 revision 已变化，不能应用过期的状态重建结果");
      await this.assertNoLaterFinalDocument(input.projectId, Number(current.rows[0].narrative_order), client);
      const artifact = await client.query("SELECT id FROM artifacts WHERE id=$1 AND project_id=$2", [input.factArtifactId, input.projectId]);
      if (!artifact.rowCount) throw new Error("状态重建 fact artifact 不存在或不属于当前项目");

      const prior = await client.query<{ claim_id: string }>(
        "SELECT claim_id FROM memory_claim_sources WHERE project_id=$1 AND document_id=$2 AND lifecycle_status='active'",
        [input.projectId, input.documentId],
      );
      // 幸存 revision 的富化声明不参与 staging：character-enrichment 的知识/声部声明挂在
      // commit artifact（当前 revision）上，状态重建只替换事实提取产物（fact artifact），
      // 不重跑富化——若把当前 revision 的富化 source 一并 staged，该章的角色知识边界会
      // 在重建后从检索中消失（方案 A 后知识单一来源，此缺口会被放大）。
      // memory-governance-audit-20260909 §8.1 复审发现并修复；边界：旧 revision 的富化
      // source 仍按原语义 staged（其声明随 revision 退役）。
      const survivingRevisionArtifact = await client.query<{ artifact_id: string | null }>(
        "SELECT artifact_id FROM manuscript_revisions WHERE id=$1 AND project_id=$2",
        [input.revisionId, input.projectId],
      );
      const survivingArtifactId = survivingRevisionArtifact.rows[0]?.artifact_id ?? null;
      if (survivingArtifactId) {
        await client.query(
          "UPDATE memory_claim_sources SET lifecycle_status='staged' WHERE project_id=$1 AND document_id=$2 AND artifact_id IS DISTINCT FROM $3",
          [input.projectId, input.documentId, survivingArtifactId],
        );
      } else {
        await client.query(
          "UPDATE memory_claim_sources SET lifecycle_status='staged' WHERE project_id=$1 AND document_id=$2",
          [input.projectId, input.documentId],
        );
      }
      const activated = await client.query<{ claim_id: string }>(
        `UPDATE memory_claim_sources SET document_id=$3,revision_id=$4,lifecycle_status='active'
         WHERE project_id=$1 AND artifact_id=$2 RETURNING claim_id`,
        [input.projectId, input.factArtifactId, input.documentId, input.revisionId],
      );
      const affectedIds = [...new Set([...prior.rows, ...activated.rows].map((row) => row.claim_id))];
      if (affectedIds.length) {
        await client.query(
          `UPDATE memory_claims claim SET
             ${CLAIM_PROJECTION_SET_SQL}
           WHERE claim.id=ANY($1::text[])`,
          [affectedIds],
        );
      }
      const removed = affectedIds.length ? await client.query<{ id: string }>("SELECT id FROM memory_claims WHERE id=ANY($1::text[]) AND lifecycle_status='staged'", [affectedIds]) : { rows: [] };
      const active = activated.rows.length ? await client.query<any>("SELECT * FROM memory_claims WHERE id=ANY($1::text[]) AND lifecycle_status='active'", [[...new Set(activated.rows.map((row) => row.claim_id))]]) : { rows: [] };
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'chapter-state.rebuilt-facts','manuscript-document',$3,$4)",
        [input.projectId, input.actorId, input.documentId, { revisionId: input.revisionId, factArtifactId: input.factArtifactId, activatedClaimIds: active.rows.map((row: any) => row.id), deactivatedClaimIds: removed.rows.map((row) => row.id) }],
      );
      if (ownsTransaction) await client.query("COMMIT");
      return { removedClaimIds: removed.rows.map((row) => row.id), activatedClaims: active.rows.map(memoryClaimFromRow) };
    } catch (error) {
      if (ownsTransaction) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async resetCommittedRevisionDerivedState(projectId: string, documentId: string, revisionId: string, transactionClient?: PoolClient): Promise<void> {
    const client = transactionClient ?? await this.pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query("BEGIN");
      const current = await client.query<{ current_revision_id: string | null; narrative_order: string | number }>("SELECT current_revision_id,narrative_order FROM manuscript_documents WHERE id=$1 AND project_id=$2 FOR UPDATE", [documentId, projectId]);
      if (!current.rowCount || current.rows[0].current_revision_id !== revisionId) throw new Error("章节正式 revision 已变化，不能重置过期投影");
      await this.assertNoLaterFinalDocument(projectId, Number(current.rows[0].narrative_order), client);
      await client.query("UPDATE promises SET status='open' WHERE id IN (SELECT promise_id FROM payoffs WHERE revision_id=$1 AND promise_id IS NOT NULL)", [revisionId]);
      await client.query("UPDATE foreshadowing SET status='open',payoff_revision_id=NULL WHERE project_id=$1 AND payoff_revision_id=$2", [projectId, revisionId]);
      await client.query("DELETE FROM payoffs WHERE revision_id=$1", [revisionId]);
      await client.query("DELETE FROM foreshadowing WHERE project_id=$1 AND planted_revision_id=$2", [projectId, revisionId]);
      await client.query("DELETE FROM promises WHERE project_id=$1 AND source_revision_id=$2", [projectId, revisionId]);
      await client.query("DELETE FROM narrative_state_snapshots WHERE project_id=$1 AND document_id=$2 AND revision_id<>$3", [projectId, documentId, revisionId]);
      if (ownsTransaction) await client.query("COMMIT");
    } catch (error) {
      if (ownsTransaction) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  async applyCommittedChapterStateRebuild(input: {
    projectId: string;
    documentId: string;
    revisionId: string;
    factArtifactId: string;
    actorId: string;
    artifact: Artifact;
    narrativeOrder: number;
    narrativeElements?: FactExtractionOutput["narrativeElements"];
    chapterMemory: ChapterMemory;
  }): Promise<{ removedClaimIds: string[]; activatedClaims: MemoryClaim[]; narrativeState: NarrativeStateSnapshot }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimSwap = await this.replaceCommittedChapterFactSources({
        projectId: input.projectId,
        documentId: input.documentId,
        revisionId: input.revisionId,
        factArtifactId: input.factArtifactId,
        actorId: input.actorId,
      }, client);
      await this.resetCommittedRevisionDerivedState(input.projectId, input.documentId, input.revisionId, client);
      if (input.narrativeElements) {
        await this.recordNarrativeElements({
          projectId: input.projectId,
          documentId: input.documentId,
          artifact: input.artifact,
          revisionId: input.revisionId,
          narrativeOrder: input.narrativeOrder,
          narrativeElements: input.narrativeElements,
        }, client);
      }
      await this.createChapterMemory(input.chapterMemory, client);
      const narrativeState = await this.recordNarrativeStateSnapshot({
        projectId: input.projectId,
        documentId: input.documentId,
        revisionId: input.revisionId,
        narrativeOrder: input.narrativeOrder,
        chapterMemory: input.chapterMemory,
        narrativeElements: input.narrativeElements,
      }, client);
      await client.query("COMMIT");
      return { ...claimSwap, narrativeState };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMemoryClaims(input: {
    projectId: string;
    claims: MemoryClaim[];
    sourceArtifactId?: string;
    lifecycleStatus?: "staged" | "active";
    documentId?: string;
    revisionId?: string;
    workflowId?: string;
    replaceExistingById?: boolean;
  }): Promise<MemoryClaim[]> {
    if (!input.claims.length) return [];
    const recorded: MemoryClaim[] = [];
    const lifecycleStatus = input.lifecycleStatus ?? "active";
    const conflictClause = input.replaceExistingById
      ? `ON CONFLICT(id) DO UPDATE SET
           kind=EXCLUDED.kind,title=EXCLUDED.title,content=EXCLUDED.content,subject_refs=EXCLUDED.subject_refs,
           narrative_start=EXCLUDED.narrative_start,narrative_end=EXCLUDED.narrative_end,
           knowledge_scope=EXCLUDED.knowledge_scope,authority=EXCLUDED.authority,confidence=EXCLUDED.confidence,
           source_revision_ids=EXCLUDED.source_revision_ids,content_hash=EXCLUDED.content_hash,supersedes=EXCLUDED.supersedes,
           source_artifact_id=EXCLUDED.source_artifact_id,predicate=EXCLUDED.predicate,lifecycle_status=EXCLUDED.lifecycle_status,
           source_document_id=EXCLUDED.source_document_id,source_workflow_id=EXCLUDED.source_workflow_id,
           identity_hash=EXCLUDED.identity_hash,value_hash=EXCLUDED.value_hash`
      : "ON CONFLICT DO NOTHING";
    for (const claim of input.claims) {
      await this.pool.query(
        `INSERT INTO memory_claims(
           id,project_id,kind,title,content,subject_refs,narrative_start,narrative_end,
           knowledge_scope,authority,confidence,source_revision_ids,content_hash,supersedes,
           source_artifact_id,predicate,lifecycle_status,source_document_id,source_workflow_id,
           identity_hash,value_hash
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
         ) ${conflictClause}`,
        [
          claim.id,
          claim.projectId,
          claim.kind,
          claim.title,
          claim.content,
          claim.subjectRefs,
          claim.narrativeRange?.start ?? null,
          claim.narrativeRange?.end ?? null,
          // knowledge_scope 是 jsonb 列：pg 对 JS 字符串不会自动加引号，
          // 必须显式 JSON.stringify 让 "author" 变成 '"author"'（合法 JSON 字符串）。
          // 与 putReview 的 issues 数组→jsonb 同类问题。
          JSON.stringify(claim.knowledgeScope),
          claim.authority,
          claim.confidence,
          claim.sourceRevisionIds,
          claim.contentHash,
          claim.supersedes,
          input.sourceArtifactId ?? claim.sourceArtifactId ?? null,
          claim.predicate ?? null,
          lifecycleStatus,
          input.documentId ?? claim.sourceDocumentId ?? null,
          input.workflowId ?? null,
          claim.identityHash ?? null,
          claim.valueHash ?? claim.contentHash,
        ],
      );

      const stored = input.replaceExistingById
        ? await this.pool.query<any>("SELECT * FROM memory_claims WHERE id=$1 AND project_id=$2", [claim.id, input.projectId])
        : await this.pool.query<any>(
          `SELECT * FROM memory_claims
           WHERE project_id=$1 AND content_hash=$2 AND knowledge_scope=$3::jsonb
           ORDER BY created_at,id LIMIT 1`,
          [input.projectId, claim.contentHash, JSON.stringify(claim.knowledgeScope)],
        );
      const row = stored.rows[0];
      if (!row) throw new Error(`事实写入后无法读取：${claim.id}`);

      if (input.sourceArtifactId) {
        await this.pool.query(
          `INSERT INTO memory_claim_sources(
             claim_id,project_id,document_id,revision_id,artifact_id,workflow_id,lifecycle_status
           ) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(claim_id,artifact_id) DO UPDATE SET
             document_id=COALESCE(EXCLUDED.document_id,memory_claim_sources.document_id),
             revision_id=COALESCE(EXCLUDED.revision_id,memory_claim_sources.revision_id),
             workflow_id=COALESCE(EXCLUDED.workflow_id,memory_claim_sources.workflow_id),
             lifecycle_status=EXCLUDED.lifecycle_status`,
          [row.id, input.projectId, input.documentId ?? null, input.revisionId ?? null, input.sourceArtifactId, input.workflowId ?? null, lifecycleStatus],
        );
      }

      if (lifecycleStatus === "active") {
        await this.pool.query(
          `UPDATE memory_claims SET
             lifecycle_status='active',
             source_document_id=COALESCE($3,source_document_id),
             source_revision_ids=CASE WHEN $4::text IS NULL THEN source_revision_ids ELSE ARRAY(SELECT DISTINCT unnest(source_revision_ids || ARRAY[$4::text])) END
           WHERE id=$1 AND project_id=$2`,
          [row.id, input.projectId, input.documentId ?? null, input.revisionId ?? null],
        );
      }

      const refreshed = await this.pool.query<any>("SELECT * FROM memory_claims WHERE id=$1", [row.id]);
      const recordedClaim = memoryClaimFromRow(refreshed.rows[0]);
      await this.appendOutbox("memory-claim", recordedClaim.id, "memory-claim.upserted", { projectId: claim.projectId, claimId: recordedClaim.id, sourceArtifactId: input.sourceArtifactId, lifecycleStatus });
      recorded.push(recordedClaim);
    }
    return recorded;
  }

  /**
   * Phase 3.1 写入叙事元素（伏笔/承诺/兑现）。
   *
   * 设计依据：Phase 3.1 计划——激活 foreshadowing/promises/payoffs 表。
   * 由 recordFactExtraction 在写入 claims 后调用，把 LLM 提取的 narrativeElements
   * 持久化到对应表，建立 payoff → foreshadowing/promise 的关联。
   *
   * 失败不阻塞 fact-extraction（claims 已写入），只记录警告。
   * payoff 关联策略：
   * - payoffType=foreshadowing：用 matchedTriggerKeywords 匹配未兑现 foreshadowing 的 trigger_keywords
   * - payoffType=promise：用 matchedPromiser 匹配未兑现 promise 的 promiser
   * 匹配不到时不伪造 promise 外键；兑现证据仍由 narrative snapshot/payoff curve 保留。
   */
  async recordNarrativeElements(input: {
    projectId: string;
    documentId: string;
    artifact: Artifact;
    revisionId: string;
    narrativeElements: NonNullable<FactExtractionOutput["narrativeElements"]>;
    /** 当前章节的叙事顺序（1-based）。用于让未兑现伏笔按叙事顺序过滤，避免剧透未来章节。 */
    narrativeOrder?: number;
  }, connection: Pool | PoolClient = this.pool): Promise<{ foreshadowings: number; promises: number; payoffs: number }> {
    if (connection === this.pool) {
      // 默认面（提交链路）此前把整组投影当 autocommit 语句序列跑：`payoffs` 插入与
      // `promises.status='fulfilled'` 翻转分属两条语句，中途失败就留下"已兑现账在、承诺仍
      // 开放"的可二次兑现账本；调用方的补偿记录（projection_failures）至今无人重放，半提交
      // 状态因此是永久的。默认面自此自管事务——整组投影要么全成要么全回滚；调用方已持事务
      // 时（传入 client）继续沿用其边界，不在此嵌套 BEGIN。
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.recordNarrativeElements(input, client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    const { projectId, documentId, artifact, revisionId, narrativeElements, narrativeOrder } = input;
    const revision = await connection.query<{ id: string }>(
      "SELECT id FROM manuscript_revisions WHERE id=$1 AND project_id=$2 AND document_id=$3",
      [revisionId, projectId, documentId],
    );
    if (!revision.rowCount) throw new Error(`叙事元素投影要求已提交且归属匹配的 revision：${revisionId}`);
    let foreshadowingCount = 0;
    let promiseCount = 0;
    let payoffCount = 0;

    // 1. 写入 foreshadowings
    // PL-5③ 锚点身份：登记键 =（文档, 规范化锚点）——同一伏笔多轮重抽取的措辞改写
    // 不再漂移成新行；锚点缺失/形态不合退回描述内容键（保守不猜）。同键归并在应用层：
    // 最早埋设信息保留，keywords/possiblePayoffs 有序并集，被吸收描述进 mergedFrom。
    for (const f of narrativeElements.foreshadowings ?? []) {
      const id = foreshadowingLedgerId(projectId, documentId, f);
      const payload: ForeshadowingLedgerPayload = { description: f.description, anchor: f.anchor ?? "", triggerKeywords: f.triggerKeywords ?? [], expectedPayoffWindow: f.expectedPayoffWindow, readerQuestion: f.readerQuestion ?? "", possiblePayoffs: f.possiblePayoffs ?? [], meaningDelta: f.meaningDelta ?? "", cost: f.cost ?? "", evidence: f.evidence, artifactId: artifact.id };
      const inserted = await connection.query(
        "INSERT INTO foreshadowing(id, project_id, planted_revision_id, status, payload, narrative_order) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id",
        [id, projectId, revisionId, "open", payload, narrativeOrder ?? null],
      );
      if (!inserted.rowCount) {
        const current = await connection.query<{ payload: ForeshadowingLedgerPayload }>("SELECT payload FROM foreshadowing WHERE id=$1", [id]);
        const merged = mergeForeshadowingLedgerPayload(current.rows[0]?.payload ?? payload, payload);
        await connection.query("UPDATE foreshadowing SET payload=$2 WHERE id=$1", [id, merged]);
      }
      foreshadowingCount += 1;
    }

    // 2. 写入 promises
    // 同上：内容派生键 + COALESCE 保留首次登记的叙事顺序。
    for (const p of narrativeElements.promises ?? []) {
      const id = `promise:${projectId}:${promiseContentKey(p.promiser, p.promisee, p.statement)}`;
      await connection.query(
        `INSERT INTO promises(id, project_id, statement, source_revision_id, status, payload, narrative_order)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(id) DO UPDATE SET statement=EXCLUDED.statement,payload=EXCLUDED.payload,narrative_order=COALESCE(promises.narrative_order, EXCLUDED.narrative_order)`,
        [id, projectId, p.statement, revisionId, "open", { promiser: p.promiser, promisee: p.promisee, evidence: p.evidence, artifactId: artifact.id }, narrativeOrder ?? null],
      );
      promiseCount += 1;
    }

    // 3. 写入 payoffs 并关联未兑现的 foreshadowing/promise。
    // 优先使用提取阶段看到的精确 ID；旧输出没有 ID 时只接受唯一的
    // 模糊候选，避免“同一承诺者/关键词”误关闭多个叙事元素。
    for (const payoff of narrativeElements.payoffs ?? []) {
      const payoffId = `payoff:${projectId}:${createHash("sha256").update(`${artifact.id}:${payoff.description}`).digest("hex").slice(0, 12)}`;
      let matchedPromiseId: string | null = null;

      if (payoff.payoffType === "promise") {
        if (payoff.matchedPromiseId) {
          const cutoffClause = narrativeOrder === undefined ? "" : " AND narrative_order <= $3";
          const params: unknown[] = [projectId, payoff.matchedPromiseId];
          if (narrativeOrder !== undefined) params.push(narrativeOrder);
          const exact = await connection.query<{ id: string }>(
            `SELECT id FROM promises WHERE project_id=$1 AND id=$2 AND status='open'${cutoffClause}`,
            params,
          );
          if (exact.rowCount === 1) matchedPromiseId = exact.rows[0].id;
        } else if (payoff.matchedPromiser) {
          const cutoffClause = narrativeOrder === undefined ? "" : " AND narrative_order <= $3";
          const candidateParams: unknown[] = [projectId, payoff.matchedPromiser];
          if (narrativeOrder !== undefined) candidateParams.push(narrativeOrder);
          const candidates = await connection.query<{ id: string }>(
            `SELECT id FROM promises
             WHERE project_id=$1 AND status='open' AND payload->>'promiser'=$2${cutoffClause}
             ORDER BY narrative_order DESC NULLS LAST,source_revision_id DESC LIMIT 2`,
            candidateParams,
          );
          if (candidates.rowCount === 1) matchedPromiseId = candidates.rows[0].id;
        }
      }

      if (matchedPromiseId) {
        await connection.query(
          "INSERT INTO payoffs(id, promise_id, revision_id, evidence) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET evidence=EXCLUDED.evidence",
          [payoffId, matchedPromiseId, revisionId, { description: payoff.description, payoffType: payoff.payoffType, matchedTriggerKeywords: payoff.matchedTriggerKeywords, matchedForeshadowingIds: payoff.matchedForeshadowingIds, matchedPromiseId: payoff.matchedPromiseId, matchedPromiser: payoff.matchedPromiser, intensity: payoff.intensity, artifactId: artifact.id }],
        );
      }

      // 若匹配到 promise，更新 promise 状态为 fulfilled
      if (matchedPromiseId) {
        await connection.query("UPDATE promises SET status='fulfilled' WHERE id=$1", [matchedPromiseId]);
      }

      // payoffType=foreshadowing 时，优先使用精确 ID；旧输出只有关键词时，
      // 只有恰好命中一个开放伏笔才允许自动兑现。
      if (payoff.payoffType === "foreshadowing") {
        const foreshadowingCutoff = narrativeOrder === undefined ? "" : " AND narrative_order <= $2";
        let matchedForeshadowingIds: string[] = [];
        if (payoff.matchedForeshadowingIds?.length) {
          const exactCutoff = narrativeOrder === undefined ? "" : " AND narrative_order <= $3";
          const exact = await connection.query<{ id: string }>(
            `SELECT id FROM foreshadowing WHERE project_id=$1 AND status='open' AND id=ANY($2::text[])${exactCutoff}`,
            narrativeOrder === undefined ? [projectId, payoff.matchedForeshadowingIds] : [projectId, payoff.matchedForeshadowingIds, narrativeOrder],
          );
          matchedForeshadowingIds = exact.rows.map((row) => row.id);
        } else if (payoff.matchedTriggerKeywords?.length) {
          const openForeshadowings = await connection.query<{ id: string; payload: { triggerKeywords?: string[] } }>(
            `SELECT id,payload FROM foreshadowing WHERE project_id=$1 AND status='open'${foreshadowingCutoff}`,
            narrativeOrder === undefined ? [projectId] : [projectId, narrativeOrder],
          );
          const candidates = openForeshadowings.rows.filter((row) => (row.payload?.triggerKeywords ?? []).some((keyword) => payoff.matchedTriggerKeywords!.includes(keyword)));
          if (candidates.length === 1) matchedForeshadowingIds = [candidates[0].id];
        }
        for (const foreshadowingId of matchedForeshadowingIds) {
          // PL-5 修复②：fulfilled 只能由兑现账行驱动（与 promise 同一入口、同一事务）——
          // 历史上只翻 status 不落账，兑现账本对伏笔失明。
          await connection.query(
            `INSERT INTO payoffs(id, promise_id, foreshadowing_id, revision_id, evidence)
             VALUES($1,NULL,$2,$3,$4)
             ON CONFLICT(id) DO UPDATE SET revision_id=EXCLUDED.revision_id, evidence=EXCLUDED.evidence`,
            [`foreshadowing-payoff:${foreshadowingId}`, foreshadowingId, revisionId, { description: payoff.description, payoffType: "foreshadowing", matchedTriggerKeywords: payoff.matchedTriggerKeywords ?? [], matchedForeshadowingIds: [foreshadowingId], intensity: payoff.intensity ?? null, artifactId: artifact.id }],
          );
          await connection.query("UPDATE foreshadowing SET status='fulfilled', payoff_revision_id=$2 WHERE id=$1", [foreshadowingId, revisionId]);
        }
      }

      payoffCount += 1;
    }

    return { foreshadowings: foreshadowingCount, promises: promiseCount, payoffs: payoffCount };
  }

  /**
   * 伏笔账本作者分流面（弧6 收口实践抓出的工具缺口）：overdue 告警一直指示
   * "兑现/改写窗口/放弃"三选一，但系统从未提供后两者的通道，健康告警在指挥作者
   * 做不存在的操作。放弃=abandoned 终态（open 消费面全部按 status='open' 过滤，
   * 出局即不再注入规划/审校/账本）；改写窗口只动 payload 的窗口字段，不动描述与
   * 埋设账。兑现不走此门（由 payoffs 账行驱动，见 projectNarrativeElements）。
   */
  async listForeshadowingForTriage(projectId: string, opts: { status?: "open" | "fulfilled" | "abandoned" | "all"; overdueBeyondOrder?: number; limit?: number } = {}): Promise<Array<{ id: string; status: string; plantedOrder: number | null; anchor: string; description: string; window: string; overdue: boolean; readerQuestion?: string }>> {
    const status = opts.status ?? "open";
    const rows = await this.pool.query<{ id: string; status: string; narrative_order: number | null; payload: Record<string, unknown> }>(
      status === "all"
        ? "SELECT id,status,narrative_order,payload FROM foreshadowing WHERE project_id=$1 ORDER BY narrative_order ASC NULLS LAST, id LIMIT $2"
        : "SELECT id,status,narrative_order,payload FROM foreshadowing WHERE project_id=$1 AND status=$2 ORDER BY narrative_order ASC NULLS LAST, id LIMIT $3",
      status === "all" ? [projectId, opts.limit ?? 200] : [projectId, status, opts.limit ?? 200],
    );
    const currentOrder = opts.overdueBeyondOrder ?? (await this.pool.query<{ max: number | null }>("SELECT MAX(narrative_order)::int AS max FROM manuscript_documents WHERE project_id=$1 AND status='final'", [projectId])).rows[0]?.max ?? null;
    return rows.rows.map((row) => {
      const window = parsePayoffWindow(row.payload?.expectedPayoffWindow, row.narrative_order);
      return {
        id: row.id,
        status: row.status,
        plantedOrder: row.narrative_order,
        anchor: typeof row.payload?.anchor === "string" ? row.payload.anchor : "",
        description: typeof row.payload?.description === "string" ? row.payload.description : "",
        window: formatPayoffWindow(row.payload?.expectedPayoffWindow),
        overdue: row.status === "open" && window.kind === "chapter" && window.horizonOrder !== null && currentOrder !== null && currentOrder > window.horizonOrder,
        ...(typeof row.payload?.readerQuestion === "string" && row.payload.readerQuestion ? { readerQuestion: row.payload.readerQuestion } : {}),
      };
    });
  }

  async triageForeshadowing(input: {
    projectId: string;
    actorId: string;
    entries: Array<{ id: string; action: "abandon" | "rewrite-window"; reason: string; windowFrom?: number; windowTo?: number }>;
  }): Promise<{ processed: string[]; skipped: Array<{ id: string; why: string }> }> {
    const processed: string[] = [];
    const skipped: Array<{ id: string; why: string }> = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of input.entries) {
        if (!entry.reason?.trim()) { skipped.push({ id: entry.id, why: "abandon/rewrite-window 必须带 reason（审计轨迹）" }); continue; }
        if (entry.action === "rewrite-window") {
          const from = entry.windowFrom; const to = entry.windowTo;
          if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
            skipped.push({ id: entry.id, why: "rewrite-window 需要整数 windowFrom<=windowTo 且均≥1" });
            continue;
          }
        }
        const current = await client.query<{ status: string; payload: Record<string, unknown> }>(
          "SELECT status,payload FROM foreshadowing WHERE id=$1 AND project_id=$2 FOR UPDATE", [entry.id, input.projectId],
        );
        if (!current.rowCount) { skipped.push({ id: entry.id, why: "伏笔不存在或不属于本项目" }); continue; }
        if (current.rows[0].status !== "open") { skipped.push({ id: entry.id, why: `仅 open 可分流（当前 ${current.rows[0].status}）` }); continue; }
        const triage = { action: entry.action, reason: entry.reason.trim(), actorId: input.actorId, at: new Date().toISOString() };
        if (entry.action === "abandon") {
          const payload = { ...current.rows[0].payload, triage };
          await client.query("UPDATE foreshadowing SET status='abandoned', payload=$2 WHERE id=$1", [entry.id, payload]);
        } else {
          const payload = { ...current.rows[0].payload, expectedPayoffWindow: { scope: "chapter", from: entry.windowFrom, to: entry.windowTo }, triage };
          await client.query("UPDATE foreshadowing SET payload=$2 WHERE id=$1", [entry.id, payload]);
        }
        await this.appendOutboxTx(client, "foreshadowing", entry.id, `foreshadowing.triaged.${entry.action}`, { projectId: input.projectId, foreshadowingId: entry.id, actorId: input.actorId, reason: entry.reason.trim(), ...(entry.action === "rewrite-window" ? { windowFrom: entry.windowFrom, windowTo: entry.windowTo } : {}) });
        processed.push(entry.id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { processed, skipped };
  }

  async getChapterTitleSource(projectId: string, documentId: string): Promise<Omit<ChapterTitleSource, "plainText" | "blueprint"> & { blueprint: Record<string, unknown>; objectKey?: string } | undefined> {
    const result = await this.pool.query<{
      project_title: string; document_id: string; current_title: string; narrative_order: string | number;
      chapter_goal: string | null; blueprint: Record<string, unknown> | null; blueprint_fingerprint: string | null;
      content_hash: string | null; object_key: string | null;
    }>(`
      SELECT p.title AS project_title,d.id AS document_id,d.title AS current_title,d.narrative_order,
        cps.chapter_goal,ch.payload AS blueprint,ba.fingerprint AS blueprint_fingerprint,mr.content_hash,cb.object_key
      FROM manuscript_documents d
      JOIN novel_projects p ON p.id=d.project_id
      LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
      LEFT JOIN chapters ch ON ch.document_id=d.id AND ch.project_id=d.project_id
      LEFT JOIN artifacts ba ON ba.id=ch.source_artifact_id
      LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      LEFT JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      WHERE d.project_id=$1 AND d.id=$2
    `, [projectId, documentId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      projectTitle: row.project_title,
      documentId: row.document_id,
      currentTitle: row.current_title,
      narrativeOrder: Number(row.narrative_order),
      chapterGoal: row.chapter_goal ?? "",
      blueprint: row.blueprint ?? {},
      blueprintFingerprint: row.blueprint_fingerprint ?? canonicalSha256(row.blueprint ?? {}),
      contentHash: row.content_hash ?? undefined,
      objectKey: row.object_key ?? undefined,
    };
  }

  async saveGeneratedChapterTitleIfCurrent(input: { projectId: string; documentId: string; sourceFingerprint: string; title: string }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        project_title: string; document_id: string; current_title: string; narrative_order: string | number;
        chapter_goal: string | null; blueprint: Record<string, unknown> | null; blueprint_fingerprint: string | null; content_hash: string | null;
      }>(`
        SELECT p.title AS project_title,d.id AS document_id,d.title AS current_title,d.narrative_order,
          cps.chapter_goal,ch.payload AS blueprint,ba.fingerprint AS blueprint_fingerprint,mr.content_hash
        FROM manuscript_documents d
        JOIN novel_projects p ON p.id=d.project_id
        LEFT JOIN chapter_production_specs cps ON cps.document_id=d.id
        LEFT JOIN chapters ch ON ch.document_id=d.id AND ch.project_id=d.project_id
        LEFT JOIN artifacts ba ON ba.id=ch.source_artifact_id
        LEFT JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
        WHERE d.project_id=$1 AND d.id=$2
        FOR UPDATE OF d,p
      `, [input.projectId, input.documentId]);
      const row = result.rows[0];
      if (!row) throw new Error("章节不存在");
      const currentFingerprint = chapterTitleSourceFingerprint({
        projectTitle: row.project_title,
        documentId: row.document_id,
        currentTitle: row.current_title,
        narrativeOrder: Number(row.narrative_order),
        chapterGoal: row.chapter_goal ?? "",
        blueprintFingerprint: row.blueprint_fingerprint ?? canonicalSha256(row.blueprint ?? {}),
        contentHash: row.content_hash ?? undefined,
      });
      if (currentFingerprint !== input.sourceFingerprint) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("UPDATE manuscript_documents SET title=$3,updated_at=now() WHERE project_id=$1 AND id=$2", [input.projectId, input.documentId, input.title]);
      await client.query(
        "UPDATE chapters SET title=$3,payload=jsonb_set(payload,'{title}',to_jsonb($3::text),true),updated_at=now() WHERE project_id=$1 AND document_id=$2",
        [input.projectId, input.documentId, input.title],
      );
      await client.query("COMMIT");
      await this.appendOutbox("manuscript-document", input.documentId, "chapter.title-generated", { projectId: input.projectId, documentId: input.documentId, title: input.title, sourceFingerprint: input.sourceFingerprint });
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordProjectionFailure(input: { projectId: string; projectionType: string; aggregateId: string; payload: Record<string, unknown>; error: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO projection_failures(project_id,projection_type,aggregate_id,payload,error_message,attempts,updated_at)
       VALUES($1,$2,$3,$4,$5,1,now())
       ON CONFLICT(projection_type,aggregate_id) DO UPDATE SET payload=EXCLUDED.payload,error_message=EXCLUDED.error_message,status='pending',attempts=projection_failures.attempts+1,updated_at=now()`,
      [input.projectId, input.projectionType, input.aggregateId, input.payload, input.error],
    );
  }

  async heartbeatRuntimeService(input: { serviceId: string; serviceType: string; status: string; details?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_services(service_id,service_type,status,details,heartbeat_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(service_id) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,heartbeat_at=now()`,
      [input.serviceId, input.serviceType, input.status, input.details ?? {}],
    );
  }

  async latestRuntimeService(serviceType: string): Promise<{ serviceId: string; status: string; details: Record<string, unknown>; heartbeatAt: string } | undefined> {
    const result = await this.pool.query<{ service_id: string; status: string; details: Record<string, unknown>; heartbeat_at: Date | string }>(
      "SELECT service_id,status,details,heartbeat_at FROM runtime_services WHERE service_type=$1 ORDER BY heartbeat_at DESC LIMIT 1",
      [serviceType],
    );
    const row = result.rows[0];
    return row ? { serviceId: row.service_id, status: row.status, details: row.details, heartbeatAt: new Date(row.heartbeat_at).toISOString() } : undefined;
  }

  /**
   * Phase 3.1 查询未兑现的伏笔与承诺，供 drafting/revision 注入上下文。
   *
   * 设计依据：Phase 3.1 计划——buildMemoryBundle 把未兑现的 foreshadowing/promise
   * 注入上下文（高优先级），提醒 LLM 本章是否应兑现。
   *
   * 返回结构化数据，由 retrieveMemory activity 包装为 MemoryHit[] 注入 MemoryBundle。
   */
  async getOpenForeshadowingAndPromises(projectId: string, narrativeCutoff?: number, connection: Pool | PoolClient = this.pool): Promise<{
    foreshadowings: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string; plantedRevisionId: string }>;
    promises: Array<{ id: string; promiser: string; promisee: string; statement: string; sourceRevisionId: string }>;
  }> {
    // P0 #2: 按叙事顺序过滤未兑现伏笔，避免长篇后期审校注入"未来章节"埋设的伏笔造成剧透。
    // narrativeCutoff = 当前章节顺序 - 1（由 retrieveMemory 传入），只有 planted 在 cutoff 之前
    // （narrative_order <= cutoff）的伏笔才对当前章节可见、可被其兑现。迁移会尽力回填旧数据；
    // 仍无法确定顺序的记录在有 cutoff 时隐藏，避免未知来源被错误当作过去事实而泄露未来剧情。
    const foreshadowingSql = narrativeCutoff === undefined
      ? "SELECT id, planted_revision_id, payload FROM foreshadowing WHERE project_id=$1 AND status='open' ORDER BY planted_revision_id ASC"
      : "SELECT id, planted_revision_id, payload FROM foreshadowing WHERE project_id=$1 AND status='open' AND narrative_order <= $2 ORDER BY narrative_order ASC, planted_revision_id ASC";
    const foreshadowingParams = narrativeCutoff === undefined ? [projectId] : [projectId, narrativeCutoff];
    // 查询未兑现的 foreshadowing
    const foreshadowingRows = await connection.query<{ id: string; planted_revision_id: string; payload: { description?: string; triggerKeywords?: string[]; expectedPayoffWindow?: PayoffWindowRaw; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string } }>(
      foreshadowingSql,
      foreshadowingParams,
    );
    const foreshadowings = dedupeByNarrativeText(foreshadowingRows.rows.map((row) => ({
      id: row.id,
      description: row.payload?.description ?? "",
      triggerKeywords: row.payload?.triggerKeywords ?? [],
      expectedPayoffWindow: formatPayoffWindow(row.payload?.expectedPayoffWindow),
      readerQuestion: row.payload?.readerQuestion || undefined,
      possiblePayoffs: row.payload?.possiblePayoffs?.length ? row.payload.possiblePayoffs : undefined,
      meaningDelta: row.payload?.meaningDelta || undefined,
      cost: row.payload?.cost || undefined,
      plantedRevisionId: row.planted_revision_id,
    })), (item) => item.description);

    // 查询未兑现的 promises
    const promiseSql = narrativeCutoff === undefined
      ? "SELECT id,statement,source_revision_id,payload FROM promises WHERE project_id=$1 AND status='open' ORDER BY narrative_order ASC NULLS LAST,source_revision_id ASC"
      : "SELECT id,statement,source_revision_id,payload FROM promises WHERE project_id=$1 AND status='open' AND narrative_order<=$2 ORDER BY narrative_order ASC,source_revision_id ASC";
    const promiseRows = await connection.query<{ id: string; statement: string; source_revision_id: string; payload: { promiser?: string; promisee?: string } }>(
      promiseSql,
      narrativeCutoff === undefined ? [projectId] : [projectId, narrativeCutoff],
    );
    const promises = dedupeByNarrativeText(promiseRows.rows.map((row) => ({
      id: row.id,
      promiser: row.payload?.promiser ?? "",
      promisee: row.payload?.promisee ?? "",
      statement: row.statement,
      sourceRevisionId: row.source_revision_id,
    })), (item) => `${item.promiser}\u0000${item.promisee}\u0000${item.statement}`);

    return { foreshadowings, promises };
  }

  /**
   * 文风契约版本管理。
   *
   * 设计依据：参考手册 §7.1 的可版本化滑杆模型。契约按 (project_id, version) 唯一，
   * 同一项目至多一个 active 版本；激活只改本地状态，不重写历史版本。
   * 新版本号取当前最大版本 +1，保证契约版本可审计、可回滚。
   */
  async createStyleContract(projectId: string, draft: { label: string; payload: unknown; sourceArtifactId?: string }): Promise<StyleContract> {
    const payload = normalizeStyleContractPayload(draft.payload);
    const label = draft.label.trim();
    if (!label) throw new Error("文风契约必须提供 label");
    const fingerprint = styleContractFingerprint(payload);
    // 版本号是审计计数器：MAX(version)+1 读后插入在并发创建同一项目草稿时可能撞
    // UNIQUE(project_id, version)，用 ON CONFLICT DO NOTHING + 有限重试自愈，
    // 而不是把唯一约束冲突原样抛给调用方。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const versionRow = await this.pool.query<{ next_version: number }>(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM style_contracts WHERE project_id=$1",
        [projectId],
      );
      const version = Number(versionRow.rows[0]?.next_version ?? 1);
      const id = `style-contract:${projectId}:${version}`;
      const result = await this.pool.query(
        `INSERT INTO style_contracts(id, project_id, version, label, payload, source_artifact_id, fingerprint, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'draft')
         ON CONFLICT (project_id, version) DO NOTHING`,
        [id, projectId, version, label, payload, draft.sourceArtifactId ?? null, fingerprint],
      );
      if ((result.rowCount ?? 0) > 0) return (await this.getStyleContract(projectId, id))!;
    }
    throw new Error(`文风契约版本分配冲突：${projectId}`);
  }

  async getStyleContract(projectId: string, contractId: string, connection: Pool | PoolClient = this.pool): Promise<StyleContract | undefined> {
    const result = await connection.query<{ id: string; project_id: string; version: number; label: string; payload: Record<string, unknown>; source_artifact_id: string | null; fingerprint: string; status: string; created_at: string; updated_at: string | null }>(
      "SELECT id,project_id,version,label,payload,source_artifact_id,fingerprint,status,created_at,updated_at FROM style_contracts WHERE project_id=$1 AND id=$2",
      [projectId, contractId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      label: row.label,
      payload: row.payload as unknown as StyleContractPayload,
      fingerprint: row.fingerprint,
      status: row.status === "active" ? "active" : "draft",
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  async listStyleContracts(projectId: string, connection: Pool | PoolClient = this.pool): Promise<StyleContract[]> {
    const result = await connection.query<{ id: string; project_id: string; version: number; label: string; payload: Record<string, unknown>; source_artifact_id: string | null; fingerprint: string; status: string; created_at: string; updated_at: string | null }>(
      "SELECT id,project_id,version,label,payload,source_artifact_id,fingerprint,status,created_at,updated_at FROM style_contracts WHERE project_id=$1 ORDER BY version ASC",
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      label: row.label,
      payload: row.payload as unknown as StyleContractPayload,
      fingerprint: row.fingerprint,
      status: row.status === "active" ? "active" : "draft",
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    }));
  }

  async getActiveStyleContract(projectId: string, connection: Pool | PoolClient = this.pool): Promise<StyleContract | undefined> {
    const result = await connection.query<{ id: string; project_id: string; version: number; label: string; payload: Record<string, unknown>; source_artifact_id: string | null; fingerprint: string; status: string; created_at: string; updated_at: string | null }>(
      "SELECT id,project_id,version,label,payload,source_artifact_id,fingerprint,status,created_at,updated_at FROM style_contracts WHERE project_id=$1 AND status='active' ORDER BY version DESC LIMIT 1",
      [projectId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      label: row.label,
      payload: row.payload as unknown as StyleContractPayload,
      fingerprint: row.fingerprint,
      status: "active",
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  /**
   * 激活指定版本并撤销同项目其它 active 版本；事务内完成。
   *
   * 修复依据：原实现直接用连接池执行 BEGIN/COMMIT——Pool.query() 每次获取并
   * 释放连接，并发或池内有活跃连接时各条语句可能落到不同连接，事务不成立、
   * ROLLBACK 成为无连接上的 no-op。必须用 pool.connect() 的专属 client
   * 并在 finally 中 release，与仓库其它事务方法一致。
   */
  async activateStyleContract(projectId: string, contractId: string): Promise<StyleContract> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await this.getStyleContract(projectId, contractId, client);
      if (!existing) throw new Error(`文风契约不存在：${contractId}`);
      await client.query("UPDATE style_contracts SET status='draft' WHERE project_id=$1 AND status='active'", [projectId]);
      await client.query("UPDATE style_contracts SET status='active', updated_at=now() WHERE id=$1 AND project_id=$2", [contractId, projectId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.getStyleContract(projectId, contractId))!;
  }

  /**
   * 写入 chapter memory（章节级结构化摘要）。
   *
   * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
   * 通过 (project_id, document_id) 唯一约束：同一章节只保留最新 chapter memory，
   * revision_id 变化时 UPSERT 覆盖（章节重审后 chapter memory 跟随更新）。
   */
  async createChapterMemory(input: ChapterMemory, connection: Pool | PoolClient = this.pool): Promise<ChapterMemory> {
    await connection.query(
      `INSERT INTO chapter_memories(id,project_id,document_id,revision_id,narrative_start,narrative_end,summary,key_events,character_states,unresolved_threads,emotional_arc,fingerprint,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         revision_id=EXCLUDED.revision_id,
         narrative_start=EXCLUDED.narrative_start,
         narrative_end=EXCLUDED.narrative_end,
         summary=EXCLUDED.summary,
         key_events=EXCLUDED.key_events,
         character_states=EXCLUDED.character_states,
         unresolved_threads=EXCLUDED.unresolved_threads,
         emotional_arc=EXCLUDED.emotional_arc,
         fingerprint=EXCLUDED.fingerprint,
         created_at=EXCLUDED.created_at`,
      [
        input.id,
        input.projectId,
        input.documentId,
        input.revisionId,
        input.narrativeRange.start,
        input.narrativeRange.end,
        input.summary,
        JSON.stringify(input.keyEvents),
        JSON.stringify(input.characterStates),
        JSON.stringify(input.unresolvedThreads),
        input.emotionalArc ?? null,
        input.fingerprint,
        input.createdAt,
      ],
    );
    await connection.query(
      "INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,project_id) VALUES('chapter-memory',$1,'chapter-memory.upserted',$2,$3)",
      [input.id, { projectId: input.projectId, documentId: input.documentId, revisionId: input.revisionId, narrativeStart: input.narrativeRange.start, narrativeEnd: input.narrativeRange.end }, input.projectId],
    );
    return input;
  }

  async refreshChapterMemoryRollup(projectId: string, narrativeOrder: number, windowSize = 20): Promise<MemoryClaim> {
    const start = Math.floor(Math.max(0, narrativeOrder - 1) / windowSize) * windowSize + 1;
    const end = start + windowSize - 1;
    const memories = (await this.getChapterMemories({ projectId, narrativeCutoff: end, limit: windowSize }))
      .filter((memory) => memory.narrativeRange.start >= start && memory.narrativeRange.start <= end);
    if (!memories.length) throw new Error(`第 ${start}-${end} 章没有可汇总的 chapter memory`);

    const unresolved = [...new Set(memories.flatMap((memory) => memory.unresolvedThreads))].slice(0, 80);
    const latestCharacterStates = new Map<string, string>();
    for (const memory of memories) for (const state of memory.characterStates) latestCharacterStates.set(state.characterId, state.stateSnapshot);
    const chapterSummaries = memories.map((memory) => `第${memory.narrativeRange.start}章：${memory.summary}`);
    const content = [
      `章节窗口：第${start}-${Math.min(end, memories.at(-1)?.narrativeRange.end ?? end)}章`,
      `阶段进展：\n${chapterSummaries.join("\n")}`,
      unresolved.length ? `尚未解决：${unresolved.join("；")}` : "尚未解决：无",
      latestCharacterStates.size ? `窗口末角色状态：${[...latestCharacterStates].map(([characterId, state]) => `${characterId}——${state}`).join("；")}` : "",
    ].filter(Boolean).join("\n").slice(0, 12_000);
    const id = `chapter-memory:rollup:${projectId}:${start}-${end}`;
    const claim: MemoryClaim = {
      id,
      projectId,
      kind: "hierarchical",
      title: `第${start}-${end}章长期记忆汇总`,
      content,
      subjectRefs: [...latestCharacterStates.keys()],
      narrativeRange: { start, end: Math.min(end, memories.at(-1)?.narrativeRange.end ?? end) },
      knowledgeScope: "author",
      authority: "derived",
      confidence: 0.9,
      sourceRevisionIds: [...new Set(memories.map((memory) => memory.revisionId))],
      contentHash: createHash("sha256").update(content).digest("hex"),
      supersedes: [],
      predicate: "chapter-memory-rollup",
    };
    const [recorded] = await this.recordMemoryClaims({ projectId, claims: [claim], replaceExistingById: true });
    return recorded ?? claim;
  }

  /**
   * 按项目 + 章节顺序范围检索 chapter memory（用于 buildMemoryBundle 注入前章摘要）。
   *
   * 每个 document 可能有多个 chapter memory（每 revision 一条），用 DISTINCT ON 取最新一条。
   * 排序：按 narrative_start ASC（章节顺序），让上游能按时间线串联前章进展。
   * narrativeCutoff：若提供，只返回 narrative_start <= cutoff 的章节（叙事截止前）。
   */
  /**
   * 全部定稿章的正文对象引用（供线索静默账等需要**全量**正文的确定性扫描）。
   *
   * 与 getChapterContentRefsByOrders（按指定章序取）并列：静默判定需要"该线索在
   * 埋设后到当前章之间何时最后出现"，窗口内取不到答案，必须全量（P1 2026-09-18）。
   */
  async listFinalChapterContentRefs(projectId: string): Promise<Array<{ documentId: string; narrativeOrder: number; objectKey: string }>> {
    const result = await this.pool.query<{ document_id: string; narrative_order: string | number; object_key: string }>(
      `SELECT d.id AS document_id, d.narrative_order, cb.object_key
       FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id = d.current_revision_id
       JOIN content_blobs cb ON cb.content_hash = mr.content_hash
       WHERE d.project_id=$1 AND d.status='final' AND d.narrative_order IS NOT NULL AND cb.object_key IS NOT NULL
       ORDER BY d.narrative_order`,
      [projectId],
    );
    return result.rows.map((row) => ({ documentId: row.document_id, narrativeOrder: Number(row.narrative_order), objectKey: row.object_key }));
  }

  /**
   * open 伏笔的"在场判定输入"（P1 2026-09-18）：id + 描述 + 埋设章序 + 触发关键词。
   *
   * 专供线索静默账（narrative-dormancy）的全量正文扫描——`getOpenForeshadowingAndPromises`
   * 的投影是给创作上下文用的，不含 narrative_order，无法支撑"埋设后是否再出现"的判定。
   * 索引名与 plant 章序在此一次性取齐，避免调用方拼装。
   */
  async listOpenForeshadowingPresenceInputs(projectId: string): Promise<Array<{ id: string; description: string; plantedOrder: number | null; keywords: string[] }>> {
    const result = await this.pool.query<{ id: string; narrative_order: number | null; payload: Record<string, unknown> }>(
      "SELECT id,narrative_order,payload FROM foreshadowing WHERE project_id=$1 AND status='open' ORDER BY narrative_order ASC NULLS LAST, id",
      [projectId],
    );
    return result.rows.map((row) => {
      const rawKeywords = row.payload?.triggerKeywords;
      return {
        id: row.id,
        description: typeof row.payload?.description === "string" ? row.payload.description : "",
        plantedOrder: row.narrative_order,
        keywords: Array.isArray(rawKeywords) ? rawKeywords.filter((item): item is string => typeof item === "string") : [],
      };
    });
  }

  /** 窗口章节的正文对象引用（供资产数量账本等确定性扫描按叙事序取正文）。 */
  async getChapterContentRefsByOrders(projectId: string, narrativeOrders: number[]): Promise<Array<{ documentId: string; narrativeOrder: number; objectKey: string }>> {
    if (!narrativeOrders.length) return [];
    const result = await this.pool.query<{ document_id: string; narrative_order: string | number; object_key: string }>(
      `SELECT d.id AS document_id, d.narrative_order, cb.object_key
       FROM manuscript_documents d
       JOIN manuscript_revisions mr ON mr.id = d.current_revision_id
       JOIN content_blobs cb ON cb.content_hash = mr.content_hash
       WHERE d.project_id=$1 AND d.narrative_order = ANY($2::int[]) AND cb.object_key IS NOT NULL
       ORDER BY d.narrative_order`,
      [projectId, narrativeOrders],
    );
    return result.rows.map((row) => ({ documentId: row.document_id, narrativeOrder: Number(row.narrative_order), objectKey: row.object_key }));
  }

  async getChapterMemories(input: { projectId: string; narrativeCutoff?: number; limit?: number }): Promise<ChapterMemory[]> {    const params: unknown[] = [input.projectId];
    let cutoffClause = "";
    if (input.narrativeCutoff !== undefined) {
      params.push(input.narrativeCutoff);
      cutoffClause = ` AND narrative_start <= $${params.length}`;
    }
    params.push(input.limit ?? 32);
    const limitClause = ` LIMIT $${params.length}`;
    const result = await this.pool.query<any>(
      `WITH latest_per_document AS (
         SELECT DISTINCT ON (document_id)
           id,project_id,document_id,revision_id,narrative_start,narrative_end,summary,key_events,character_states,unresolved_threads,emotional_arc,fingerprint,created_at
         FROM chapter_memories
         WHERE project_id=$1${cutoffClause}
         ORDER BY document_id ASC, created_at DESC, id DESC
       ), recent AS (
         SELECT * FROM latest_per_document
         ORDER BY narrative_start DESC, created_at DESC, id DESC${limitClause}
       )
       SELECT * FROM recent
       ORDER BY narrative_start ASC, created_at ASC, id ASC`,
      params,
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      documentId: row.document_id,
      revisionId: row.revision_id,
      narrativeRange: { start: Number(row.narrative_start), end: Number(row.narrative_end) },
      summary: row.summary,
      keyEvents: row.key_events ?? [],
      characterStates: row.character_states ?? [],
      unresolvedThreads: row.unresolved_threads ?? [],
      emotionalArc: row.emotional_arc ?? undefined,
      fingerprint: row.fingerprint,
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * 按 documentId 查询单条 chapter memory（章节审校时取最近 chapter memory）。
   */
  async getChapterMemoryByDocument(projectId: string, documentId: string): Promise<ChapterMemory | undefined> {
    const result = await this.pool.query<any>(
      `SELECT id,project_id,document_id,revision_id,narrative_start,narrative_end,summary,key_events,character_states,unresolved_threads,emotional_arc,fingerprint,created_at
       FROM chapter_memories
       WHERE project_id=$1 AND document_id=$2
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, documentId],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    return {
      id: row.id,
      projectId: row.project_id,
      documentId: row.document_id,
      revisionId: row.revision_id,
      narrativeRange: { start: Number(row.narrative_start), end: Number(row.narrative_end) },
      summary: row.summary,
      keyEvents: row.key_events ?? [],
      characterStates: row.character_states ?? [],
      unresolvedThreads: row.unresolved_threads ?? [],
      emotionalArc: row.emotional_arc ?? undefined,
      fingerprint: row.fingerprint,
      createdAt: Number(row.created_at),
    };
  }

  /**
   * 项目级 learning 读取接口。
   * learning_assessments 仍是 assessment 真源；章节与候选只是可见化关联，
   * 关联缺失时保留 assessment 本身，避免历史记录因旧 provenance 不完整而消失。
   */
  async listLearningAssessments(projectId: string, limit = 100): Promise<LearningAssessmentView[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const result = await this.pool.query<{
      payload: RuntimeLearningAssessmentV2;
      source_chapter_id: string | null;
      source_chapter_title: string | null;
      source_chapter_order: string | number | null;
      source_chapter_status: string | null;
      candidate_id: string | null;
      candidate_status: string | null;
      candidate_target_kind: string | null;
      candidate_target_id: string | null;
      candidate_proposed_version: string | null;
    }>(
      `SELECT la.payload,
              COALESCE(d.id, workflow_document.id) AS source_chapter_id,
              COALESCE(d.title, workflow_document.title) AS source_chapter_title,
              COALESCE(d.narrative_order, workflow_document.narrative_order) AS source_chapter_order,
              COALESCE(d.status, workflow_document.status) AS source_chapter_status,
              c.id AS candidate_id,
              c.status AS candidate_status,
              c.target_kind AS candidate_target_kind,
              c.target_id AS candidate_target_id,
              c.proposed_version AS candidate_proposed_version
       FROM learning_assessments la
       LEFT JOIN artifacts a
         ON a.project_id = la.project_id
        AND a.id = la.source->>'artifactId'
       LEFT JOIN manuscript_revisions mr
         ON mr.project_id = la.project_id
        AND mr.artifact_id = a.id
       LEFT JOIN manuscript_documents d
         ON d.project_id = la.project_id
        AND d.id = mr.document_id
       LEFT JOIN workflow_runs wr
         ON wr.project_id = la.project_id
        AND (wr.id = la.source->>'workflowId' OR wr.temporal_workflow_id = la.source->>'workflowId')
       LEFT JOIN manuscript_documents workflow_document
         ON workflow_document.project_id = la.project_id
        AND workflow_document.id = COALESCE(
          wr.payload->>'documentId',
          wr.payload->'intent'->'target'->>'id'
        )
       LEFT JOIN craft_rule_candidates c
         ON c.project_id = la.project_id
        AND c.learning_source->>'assessmentId' = la.id
       WHERE la.project_id = $1
       ORDER BY la.created_at DESC, la.id DESC
       LIMIT $2`,
      [projectId, boundedLimit],
    );
    return result.rows.map((row) => ({
      assessment: row.payload,
      sourceChapter: row.source_chapter_id && row.source_chapter_title
        ? { id: row.source_chapter_id, title: row.source_chapter_title, narrativeOrder: Number(row.source_chapter_order), status: row.source_chapter_status ?? "" }
        : undefined,
      candidate: row.candidate_id
        ? { id: row.candidate_id, status: row.candidate_status ?? "proposed", targetKind: row.candidate_target_kind ?? "", targetId: row.candidate_target_id ?? "", proposedVersion: row.candidate_proposed_version ?? "" }
        : undefined,
    }));
  }

  async getLearningAssessmentSourceChapter(projectId: string, assessmentId: string): Promise<LearningAssessmentView["sourceChapter"]> {
    const result = await this.pool.query<{
      source_chapter_id: string | null;
      source_chapter_title: string | null;
      source_chapter_order: string | number | null;
      source_chapter_status: string | null;
    }>(
      `SELECT COALESCE(d.id, workflow_document.id) AS source_chapter_id,
              COALESCE(d.title, workflow_document.title) AS source_chapter_title,
              COALESCE(d.narrative_order, workflow_document.narrative_order) AS source_chapter_order,
              COALESCE(d.status, workflow_document.status) AS source_chapter_status
       FROM learning_assessments la
       LEFT JOIN artifacts a
         ON a.project_id = la.project_id
        AND a.id = la.source->>'artifactId'
       LEFT JOIN manuscript_revisions mr
         ON mr.project_id = la.project_id
        AND mr.artifact_id = a.id
       LEFT JOIN manuscript_documents d
         ON d.project_id = la.project_id
        AND d.id = mr.document_id
       LEFT JOIN workflow_runs wr
         ON wr.project_id = la.project_id
        AND (wr.id = la.source->>'workflowId' OR wr.temporal_workflow_id = la.source->>'workflowId')
       LEFT JOIN manuscript_documents workflow_document
         ON workflow_document.project_id = la.project_id
        AND workflow_document.id = COALESCE(wr.payload->>'documentId', wr.payload->'intent'->'target'->>'id')
       WHERE la.project_id = $1 AND la.id = $2
       LIMIT 1`,
      [projectId, assessmentId],
    );
    const row = result.rows[0];
    return row?.source_chapter_id && row.source_chapter_title
      ? { id: row.source_chapter_id, title: row.source_chapter_title, narrativeOrder: Number(row.source_chapter_order), status: row.source_chapter_status ?? "" }
      : undefined;
  }

  async recordLearningAssessment(assessment: RuntimeLearningAssessmentV2) {
    if (assessment.conclusion === "propose-improvement" && (!assessment.underlyingMechanism || !assessment.affectedInputClass || !assessment.candidate)) throw new Error("propose-improvement 必须包含机制、影响输入类和候选变更");
    await this.pool.query("INSERT INTO learning_assessments(id,project_id,source,conclusion,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,conclusion=EXCLUDED.conclusion", [assessment.id, assessment.projectId, assessment.source, assessment.conclusion, assessment]);
    if (assessment.conclusion === "no-shared-learning") {
      // 同一 assessment 可能经历模型重试：旧 worker 已创建的未审核候选不能继续冒充有效改进。
      // 已进入 evidencing/reviewing 或已晋升的候选保留，避免撤销新状态的审计轨迹。
      await this.pool.query(
        `DELETE FROM craft_rule_candidates
         WHERE project_id=$1
           AND learning_source->>'assessmentId'=$2
           AND status='proposed'`,
        [assessment.projectId, assessment.id],
      );
    }
    await this.appendOutbox("learning-assessment", assessment.id, `learning.${assessment.conclusion}`, { projectId: assessment.projectId, assessmentId: assessment.id, source: assessment.source, proposeImprovement: assessment.conclusion === "propose-improvement" });
    return assessment;
  }

  /**
   * SK-3 候选聚合（product-audit-20260910 C3）：learning prompt 注入的排队候选摘要。
   * 只投影未关闭三态（proposed/evidencing/reviewing）——promoted/rejected 已离开队列，
   * 聚合引用它们没有意义（且会被 aggregate 通道的状态守卫拒绝）。
   */
  async listPendingCraftRuleCandidates(projectId: string, limit = 15): Promise<Array<{ id: string; targetKind: string; targetId: string; proposedVersion: string; rationale: string; underlyingMechanism?: string }>> {
    const result = await this.pool.query<{ id: string; target_kind: string; target_id: string; proposed_version: string; rationale: string; scope: Record<string, unknown> }>(
      `SELECT id, target_kind, target_id, proposed_version, rationale, scope
       FROM craft_rule_candidates
       WHERE project_id=$1 AND status IN ('proposed','evidencing','reviewing')
       ORDER BY updated_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      proposedVersion: row.proposed_version,
      rationale: row.rationale,
      underlyingMechanism: typeof row.scope?.underlyingMechanism === "string" ? row.scope.underlyingMechanism : undefined,
    }));
  }

  /**
   * SK-3 聚合通道：把一次 learning assessment 的证据挂到既有排队候选上
   * （learning_source.aggregateAssessments 追加去重，updated_at 前进=停滞计时重置）。
   * 状态守卫（pending 三态 + 同项目）保证 LLM 幻觉 id / 已关闭候选不会静默吞证据——
   * 返回 false 时调用方回退为正常新建候选。幂等：同一 assessmentId 重放不重复追加。
   */
  async aggregateCraftRuleCandidateLearning(input: { projectId: string; candidateId: string; assessmentId: string }): Promise<boolean> {
    const existing = await this.pool.query<{ learning_source: Record<string, unknown> | null }>(
      `SELECT learning_source FROM craft_rule_candidates
       WHERE id=$1 AND project_id=$2 AND status IN ('proposed','evidencing','reviewing')`,
      [input.candidateId, input.projectId],
    );
    if (!existing.rowCount) return false;
    const source = existing.rows[0].learning_source ?? {};
    const prior = Array.isArray(source.aggregateAssessments) ? (source.aggregateAssessments as unknown[]) : [];
    if (prior.includes(input.assessmentId)) return true;
    await this.pool.query(
      `UPDATE craft_rule_candidates
       SET learning_source = COALESCE(learning_source, '{}'::jsonb) || $3::jsonb, updated_at = now()
       WHERE id=$1 AND project_id=$2 AND status IN ('proposed','evidencing','reviewing')`,
      [input.candidateId, input.projectId, JSON.stringify({ ...source, aggregateAssessments: [...prior, input.assessmentId] })],
    );
    await this.appendOutbox("craft-rule-candidate", input.candidateId, "craft-rule.candidate-aggregated", { projectId: input.projectId, candidateId: input.candidateId, assessmentId: input.assessmentId });
    return true;
  }

  /**
   * SK-3 候选关闭通道（product-audit-20260910 C3）：排队候选停滞超阈值且无证据时，
   * 发 `craft-rule.candidate-stale` outbox 事件给编排者/作者裁决（晋升、驳回或补证据），
   * 队列不再只进不出。不改 status——stale 是提醒不是判定。
   * 事件幂等：同一候选在最后一次 updated_at 之后只发一次（updated_at 前进=重新计时）。
   * 触发时机挂在 recordLearning（随章节提交自然发生，无需独立调度器）。
   * 扫描窗口有**上界** = `OUTBOX_RETENTION_DAYS`：更老的候选不再通报。这不是省事，是让去重判据
   * 与保留策略互相成立——被扫候选的 `updated_at` 不早于保留线 ⇒ 任何能为它去重的事件都还没被
   * `pruneOutboxEvents` 清掉；否则清完旧事件的第二天，同一个候选会被再通报一次（判据查无旧账）。
   */
  async detectStaleCraftRuleCandidates(projectId: string, input: { nowMs: number; staleAfterDays?: number }): Promise<string[]> {
    const staleAfterDays = input.staleAfterDays ?? 30; // TODO P3: 停滞阈值应可配置（memory-gate.blocked 同款提醒模板语义）
    const stale = await this.pool.query<{ id: string; status: string; target_kind: string; target_id: string; proposed_version: string }>(
      `SELECT c.id, c.status, c.target_kind, c.target_id, c.proposed_version
       FROM craft_rule_candidates c
       WHERE c.project_id=$1
         AND c.status IN ('proposed','evidencing')
         AND c.updated_at < to_timestamp($2 / 1000.0) - make_interval(days => $3::int)
         AND c.updated_at >= to_timestamp($2 / 1000.0) - make_interval(days => $4::int)
         AND c.evidence_cases = '[]'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events e
           WHERE e.aggregate_type='craft-rule-candidate' AND e.aggregate_id=c.id
             AND e.event_type='craft-rule.candidate-stale' AND e.created_at >= c.updated_at
         )
       ORDER BY c.updated_at LIMIT 20`,
      [projectId, input.nowMs, staleAfterDays, OUTBOX_RETENTION_DAYS],
    );
    for (const row of stale.rows) {
      await this.appendOutbox("craft-rule-candidate", row.id, "craft-rule.candidate-stale", {
        projectId, candidateId: row.id, status: row.status, targetKind: row.target_kind, targetId: row.target_id, proposedVersion: row.proposed_version,
        decisionHint: "停滞候选需裁决：补证据、晋升（走双回归）或显式 rejected；编排者可用 novel_rule_candidate_advance(action=review/promote) 或作者驳回。",
      });
    }
    return stale.rows.map((row) => row.id);
  }

  async requestLearningPromotion(assessmentId: string) {
    const result = await this.pool.query<{ project_id: string; payload: RuntimeLearningAssessmentV2 }>("SELECT project_id,payload FROM learning_assessments WHERE id=$1", [assessmentId]);
    const assessment = result.rows[0]?.payload;
    if (!assessment) throw new Error("learning assessment 不存在");
    if (assessment.conclusion !== "propose-improvement" || !assessment.candidate) throw new Error("只有 propose-improvement 可进入 promote 回归验证");
    await this.pool.query("INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [result.rows[0].project_id, "runtime-learning", "promotion-regression-required", "learning-assessment", assessmentId, { assessmentId, candidate: assessment.candidate, regressionRisks: assessment.regressionRisks ?? [] }]);
    await this.appendOutbox("learning-assessment", assessmentId, "learning.promotion-regression-required", { projectId: result.rows[0].project_id, assessmentId, targetKind: assessment.candidate.targetKind, targetId: assessment.candidate.targetId });
    return { assessmentId, promoted: false, status: "regression-validation-required" as const, candidate: assessment.candidate };
  }

  async listFactCandidates(projectId: string, documentId?: string): Promise<MemoryClaim[]> {
    const result = await this.pool.query<any>(
      `SELECT mc.*
       FROM memory_claims mc
       WHERE mc.project_id=$1 AND mc.authority='candidate'
          AND ($2::text IS NULL OR mc.source_document_id=$2 OR EXISTS (
            SELECT 1 FROM memory_claim_sources source
            WHERE source.claim_id=mc.id AND source.document_id=$2
          ))
       ORDER BY mc.created_at DESC,mc.id`,
      [projectId, documentId ?? null],
    );
    return result.rows.map((row) => this.factClaimFromRow(row));
  }

  /** 裁决通道（REST/MCP/workflow）事后取整行做向量索引同步。 */
  async getMemoryClaimById(projectId: string, claimId: string): Promise<MemoryClaim | undefined> {
    const result = await this.pool.query<any>(
      "SELECT * FROM memory_claims WHERE project_id=$1 AND id=$2",
      [projectId, claimId],
    );
    const row = result.rows[0];
    return row ? this.factClaimFromRow(row) : undefined;
  }

  private factClaimFromRow(row: any): MemoryClaim {
    return {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      subjectRefs: row.subject_refs ?? [],
      narrativeRange: {
        start: row.narrative_start === null || row.narrative_start === undefined ? undefined : Number(row.narrative_start),
        end: row.narrative_end === null || row.narrative_end === undefined ? undefined : Number(row.narrative_end),
      },
      knowledgeScope: row.knowledge_scope,
      authority: row.authority,
      confidence: Number(row.confidence),
      sourceRevisionIds: row.source_revision_ids ?? [],
      contentHash: row.content_hash,
      supersedes: row.supersedes ?? [],
      predicate: row.predicate ?? undefined,
      sourceArtifactId: row.source_artifact_id ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
    };
  }

  /**
   * 事实候选积压画像（product-audit-20260910 A3/FM-2）：候选队列此前对编排层
   * 完全不可见（无聚合、无裁决工具入口），导致整本书人工确认零运转、候选沦为
   * 事实坟场。按章聚合待裁决数量、账龄与可见事实占比，作为编排者的债务面板。
   */
  async getFactCandidateBacklog(projectId: string): Promise<{
    totalPending: number;
    stagedDebris: number;
    oldestPendingDays: number | null;
    byChapter: Array<{
      chapterIndex: number | null;
      pending: number;
      maxAgeDays: number;
      visibleFacts: number;
      pendingRatio: number;
      samples: Array<{ id: string; title: string; predicate?: string; confidence: number }>;
    }>;
  }> {
    const pending = await this.pool.query<any>(
      `SELECT id,title,predicate,confidence,narrative_start,EXTRACT(EPOCH FROM (now()-created_at))/86400.0 AS age_days
       FROM memory_claims
       WHERE project_id=$1 AND authority='candidate' AND lifecycle_status='active'
       ORDER BY narrative_start ASC NULLS LAST,created_at ASC`,
      [projectId],
    );
    const staged = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_claims WHERE project_id=$1 AND authority='candidate' AND lifecycle_status='staged'`,
      [projectId],
    );
    const visibleCountsQuery = await this.pool.query<{ chapter: string | null; visible_facts: string }>(
      `SELECT narrative_start AS chapter,count(*)::text AS visible_facts
       FROM memory_claims
       WHERE project_id=$1 AND ${retrievalVisibleClaimsSql("memory_claims")}
       GROUP BY narrative_start`, [projectId]);
    const visibleByChapter = new Map<string, number>();
    for (const row of visibleCountsQuery.rows) {
      visibleByChapter.set(row.chapter ?? "null", Number(row.visible_facts));
    }
    const chapters = new Map<string, { chapterIndex: number | null; rows: typeof pending.rows }>();
    for (const row of pending.rows) {
      const key = row.narrative_start === null || row.narrative_start === undefined ? "null" : String(row.narrative_start);
      const bucket = chapters.get(key) ?? { chapterIndex: key === "null" ? null : Number(key), rows: [] };
      bucket.rows.push(row);
      chapters.set(key, bucket);
    }
    const byChapter = [...chapters.values()].map((bucket) => {
      const visibleFacts = visibleByChapter.get(bucket.chapterIndex === null ? "null" : String(bucket.chapterIndex)) ?? 0;
      return {
        chapterIndex: bucket.chapterIndex,
        pending: bucket.rows.length,
        maxAgeDays: Number(Math.max(...bucket.rows.map((row) => Number(row.age_days))).toFixed(1)),
        visibleFacts,
        pendingRatio: Number((bucket.rows.length / (bucket.rows.length + visibleFacts)).toFixed(3)),
        samples: bucket.rows.slice(0, 3).map((row) => ({
          id: row.id,
          title: row.title,
          predicate: row.predicate ?? undefined,
          confidence: Number(row.confidence),
        })),
      };
    });
    byChapter.sort((a, b) => (a.chapterIndex ?? -1) - (b.chapterIndex ?? -1));
    const ages = pending.rows.map((row) => Number(row.age_days));
    return {
      totalPending: pending.rows.length,
      stagedDebris: Number(staged.rows[0]?.count ?? "0"),
      oldestPendingDays: ages.length ? Number(Math.max(...ages).toFixed(1)) : null,
      byChapter,
    };
  }

  /**
   * staged 重建残骸对账（product-audit-20260910 A3/FM-2 修复③）。重建/重抽取会把
   * 与既有可见 active 行**精确同文**（content_hash 相同）的 staged 候选留在账上
   * （激活走 ON CONFLICT DO NOTHING，永不移除），只读诊断不涉裁决：这类行从未参与
   * 检索、无审计增量（原文与证据在 artifacts/active 行里都在），物理清理仅降噪。
   * 模糊近重复**不**自动清理——那是 grooming 报告 + 裁决通道的人类决策域。
   */
  async reconcileStagedClaimDebris(projectId: string, documentId?: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM memory_claims staged
       WHERE staged.project_id=$1 AND staged.lifecycle_status='staged'
         AND ($2::text IS NULL OR staged.source_document_id=$2)
         AND EXISTS (
           SELECT 1 FROM memory_claims live
           WHERE live.project_id=staged.project_id
             AND live.content_hash=staged.content_hash
             AND ${retrievalVisibleClaimsSql("live")}
         )
       RETURNING staged.id`,
      [projectId, documentId ?? null],
    );
    return result.rowCount ?? 0;
  }

  /**
   * PL-2 存量清理（product-audit-20260910 A4 修复③的库存面）。历史上弧审批对复合串
   * 引用静默 auto-create，产生了 title 形如 `<真实id> <slug>` 的影子对象，后续弧又
   * 引用影子 id 形成逐代放大。规则纯结构化、幂等：
   * - 影子判定：source='story-arc-reference' 的对象，title 的 token 中恰好命中一个
   *   同项目同 kind 的其他 id → 它是那个 id 的影子（多命中/无命中不动，交给 health
   *   的 embedded-identifier 报告人工处理）；
   * - 引用重定向：弧 payload 的 threadRef / foreshadowingRefs 元素只要内嵌影子 id 或
   *   真实 id 的 token 形态，一律收敛为该 id（复合串自愈），影子 id 再映射到真实 id；
   * - 影子行删除（其显示名与真实对象同 slug，无独立信息；原始证据仍在弧蓝图 artifact）。
   */
  async repairStoryArcReferenceHygiene(): Promise<{ deletedShadows: string[]; rewrittenArcs: string[] }> {
    const objects = await this.pool.query<{ project_id: string; id: string; kind: "thread" | "foreshadowing"; title: string; referenced: boolean }>(
      `SELECT project_id, id, 'thread' AS kind, title, (payload->>'source')='story-arc-reference' AS "referenced" FROM plot_threads
       UNION ALL
       SELECT project_id, id, 'foreshadowing' AS kind, coalesce(payload->>'description',''), (payload->>'source')='story-arc-reference' FROM foreshadowing`,
    );
    const shadows: Array<{ projectId: string; kind: "thread" | "foreshadowing"; shadowId: string; targetId: string }> = [];
    for (const row of objects.rows) {
      if (!row.referenced) continue; // 影子只可能来自弧引用物化通道；其余对象即使同名不猜
      const tokens = row.title.split(/[\s,，、;；|]+/u).filter(Boolean);
      const targets = [...new Set(tokens.filter((token) => token !== row.id && objects.rows.some((candidate) => candidate.project_id === row.project_id && candidate.kind === row.kind && candidate.id === token)))];
      if (targets.length === 1) shadows.push({ projectId: row.project_id, kind: row.kind, shadowId: row.id, targetId: targets[0] });
    }
    // 历史重放面：既往 hygiene 事件记录过的 shadowId→targetId 映射是系统自证的
    // provenance。单跳重定向年代（本函数修复前）曾把弧引用落到"当时还是影子、
    // 随后被删除"的行上——这类悬空引用靠活行检测永远修不到，必须重放历史映射。
    const historyEvents = await this.pool.query<{ project_id: string; payload: { shadows?: Array<{ shadowId: string; targetId: string }> } }>(
      "SELECT project_id,payload FROM audit_records WHERE action='story-arc.reference-hygiene' ORDER BY created_at",
    );
    const historyByProject = new Map<string, Array<{ shadowId: string; targetId: string }>>();
    for (const event of historyEvents.rows) {
      const list = historyByProject.get(event.project_id) ?? [];
      for (const entry of event.payload.shadows ?? []) list.push({ shadowId: entry.shadowId, targetId: entry.targetId });
      historyByProject.set(event.project_id, list);
    }
    const projectIds = [...new Set([...shadows.map((shadow) => shadow.projectId), ...historyByProject.keys()])];
    if (!projectIds.length) return { deletedShadows: [], rewrittenArcs: [] };
    const shadowByProject = new Map<string, Array<{ kind: string; shadowId: string; targetId: string }>>();
    for (const shadow of shadows) {
      const list = shadowByProject.get(shadow.projectId) ?? [];
      list.push(shadow);
      shadowByProject.set(shadow.projectId, list);
    }
    const rewrittenArcs: string[] = [];
    const shadowMapDeleted = new Set<string>();
    for (const projectId of projectIds) {
      const projectShadows = shadowByProject.get(projectId) ?? [];
      const rawMap = new Map<string, string>();
      for (const entry of historyByProject.get(projectId) ?? []) rawMap.set(entry.shadowId, entry.targetId);
      for (const shadow of projectShadows) rawMap.set(shadow.shadowId, shadow.targetId);
      // 影子链必须传递解析到不动点：影子的目标可能本身是另一代影子的行（逐代
      // auto-create 的真实形态）；只走一跳会把弧引用收敛到即将被删除的影子行上，
      // 删除后成为 dangling unknown-reference（arc4 threadRef fce92edd 实证）。
      // 环（A→B→A）没有可信落点，放弃该条重定向，留给 health 人工处理。
      // 所有本项目 id（含活影子）作为可识别 token；重写后的值收敛为规范 id。
      const allIds = new Set(objects.rows.filter((row) => row.project_id === projectId).map((row) => row.id));
      const resolveShadowTarget = (start: string): string | undefined => {
        const seen = new Set<string>([start]);
        let current = rawMap.get(start);
        while (current !== undefined) {
          if (seen.has(current)) return undefined;
          seen.add(current);
          const next = rawMap.get(current);
          if (next === undefined) return allIds.has(current) ? current : undefined;
          current = next;
        }
        return undefined;
      };
      const shadowMap = new Map([...rawMap.keys()].map((id) => [id, resolveShadowTarget(id)]).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const fixRef = (value: unknown): unknown => {
        if (typeof value !== "string") return value;
        const tokens = value.split(/[\s,，、;；|]+/u).filter(Boolean);
        // token 命中活行（含未删影子）或历史映射里的已删影子都算可识别引用；
        // 后者是"重定向到已删影子"的存量残局，只有历史重放面能修。
        const embedded = [...new Set(tokens.filter((token) => allIds.has(token) || shadowMap.has(token)))];
        if (embedded.length === 1) return shadowMap.get(embedded[0]) ?? embedded[0];
        return value;
      };
      const arcs = await this.pool.query<{ id: string; payload: Record<string, unknown> }>("SELECT id,payload FROM arcs WHERE project_id=$1", [projectId]);
      const projectRewritten: string[] = [];
      for (const arc of arcs.rows) {
        let changed = false;
        const payload = { ...arc.payload };
        const responsibilities = Array.isArray(payload.threadResponsibilities) ? payload.threadResponsibilities : [];
        const seenThreadRefs = new Set<string>();
        payload.threadResponsibilities = responsibilities.filter((entry) => {
          if (!entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>).threadRef !== "string") return true;
          const fixed = fixRef((entry as Record<string, unknown>).threadRef);
          if (fixed !== (entry as Record<string, unknown>).threadRef) {
            (entry as Record<string, unknown>).threadRef = fixed;
            changed = true;
          }
          // 重定向后同一条线的责任条目合一（保持"threadRef 不得重复"的既有契约）。
          const ref = String((entry as Record<string, unknown>).threadRef);
          if (seenThreadRefs.has(ref)) {
            changed = true;
            return false;
          }
          seenThreadRefs.add(ref);
          return true;
        });
        if (Array.isArray(payload.foreshadowingRefs)) {
          const originalRefs: unknown[] = payload.foreshadowingRefs;
          const fixedRefs = originalRefs.map((ref) => fixRef(ref));
          if (fixedRefs.some((ref, index) => ref !== originalRefs[index])) {
            payload.foreshadowingRefs = [...new Set(fixedRefs)];
            changed = true;
          }
        }
        if (changed) {
          await this.pool.query("UPDATE arcs SET payload=$3,updated_at=now() WHERE id=$1 AND project_id=$2", [arc.id, projectId, payload]);
          rewrittenArcs.push(arc.id);
          projectRewritten.push(arc.id);
        }
      }
      for (const shadow of projectShadows) {
        // 只删除已成功重定向的影子：环中未解析者保留原行，否则弧引用会被指向
        // 已删除的行（dangling unknown-reference），health 的人工处理承诺落空。
        if (!shadowMap.has(shadow.shadowId)) continue;
        shadowMapDeleted.add(shadow.shadowId);
        if (shadow.kind === "thread") await this.pool.query("DELETE FROM plot_threads WHERE id=$1 AND project_id=$2", [shadow.shadowId, projectId]);
        else await this.pool.query("DELETE FROM foreshadowing WHERE id=$1 AND project_id=$2", [shadow.shadowId, projectId]);
      }
      const localRewritten = projectRewritten;
      if (projectShadows.length || localRewritten.length) {
        await this.pool.query(
          "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.reference-hygiene','project',$3,$4)",
          [projectId, "migration", projectId, { shadows: projectShadows, replayRedirectedArcs: localRewritten }],
        );
      }
    }
    return { deletedShadows: shadows.filter((shadow) => shadowMapDeleted.has(shadow.shadowId)).map((shadow) => shadow.shadowId), rewrittenArcs };
  }

  /**
   * PL-5/084 补账缺口：084 回填是迁移时刻的一次性动作，此后仍可能存在"只翻 status
   * 不落账"的历史行（例如迁移后由旧代码路径写入、或迁移当时锚点判定未覆盖的形态）。
   * 本修复只对有真实修订证据的行补合成兑现账（evidence 标记 backfilled 来源，与 084
   * 语义一致、可审计），无锚点的 fulfilled 行刻意保持无账——那正是 health
   * fulfilledWithoutPayoff blocking 要曝光的"无证据兑现"，补伪造账等于消灭信号。
   * 幂等：NOT EXISTS + ON CONFLICT DO NOTHING 双保险。
   */
  async repairForeshadowingPayoffLedger(): Promise<{ backfilled: string[] }> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO payoffs(id, promise_id, foreshadowing_id, revision_id, evidence)
       SELECT 'foreshadowing-payoff:' || f.id, NULL, f.id, f.payoff_revision_id,
              jsonb_build_object('backfilled', true, 'source', 'fulfilled-status-only')
       FROM foreshadowing f
       WHERE f.status='fulfilled' AND f.payoff_revision_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM manuscript_revisions mr WHERE mr.id=f.payoff_revision_id)
         AND NOT EXISTS (SELECT 1 FROM payoffs p WHERE p.foreshadowing_id=f.id)
       ON CONFLICT (id) DO NOTHING
       RETURNING payoffs.foreshadowing_id AS id`,
    );
    return { backfilled: result.rows.map((row) => row.id) };
  }

  /**
   * workspace yaml → skill_definitions 种子同步（migrate 尾部，幂等）：数据库消费面
   * （学习闭环 promote、实验/评估执行走 database provider）一直隐含要求"库里已有
   * 当前 yaml 种子"，但该前提只靠人工 `novel:skills:sync` 维持——测试库重建后
   * evaluation 集成套件的失败实证了这个隐藏环境依赖。护栏与 SK-2 单一真源一致：
   * 库内版本高于种子（晋升内容）绝不回滚；同版/落后/缺行按种子 upsert。
   * workspace yaml 不存在（纯包部署）时跳过不抛错，SQL 迁移照常可用。刻意不读
   * NOVEL_SKILL_ROOT：那是 SK-2 晋升/测试的显式隔离通道，启动种子恒跟仓库规范目录。
   */
  async seedWorkspaceSkills(): Promise<{ synced: string[]; skippedAheadOfSeed: string[]; skippedNoWorkspace?: string }> {
    const seedId = "runtime-skill-seed";
    let skills;
    try {
      skills = await listCurrentSkillDescriptors(createWorkspaceSkillProvider(), seedId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[skills-seed] 跳过 workspace 种子同步（skill 目录不可用）：${reason}`);
      return { synced: [], skippedAheadOfSeed: [], skippedNoWorkspace: reason };
    }
    // 伪项目只做审计 FK 锚：值短路（upsertKnowledgeRecord）生效后稳态零写入；
    // metadata.systemKind 标记使其被 listProjects 排除，不再出现在作者项目面。
    const seededProject = await this.pool.query("SELECT 1 FROM novel_projects WHERE id=$1", [seedId]);
    if (!seededProject.rowCount) {
      await this.ensureProject(seedId, "运行时 Skill 种子"); // 种子写入经 upsertKnowledgeRecord 记审计，audit_records 有 project FK
    }
    // 幂等打标含存量自愈（上一版 migrate 建的未标行）；打标条件写进 WHERE，稳态零写入。
    await this.pool.query(
      "UPDATE novel_projects SET metadata=COALESCE(metadata,'{}'::jsonb) || '{\"systemKind\":\"runtime-skill-seed\"}'::jsonb WHERE id=$1 AND COALESCE(metadata->>'systemKind','') <> 'runtime-skill-seed'",
      [seedId],
    );
    const databaseRows = await this.pool.query<{ skill_id: string; version: string }>("SELECT skill_id, version FROM skill_definitions");
    const databaseVersions = new Map(databaseRows.rows.map((row) => [row.skill_id, row.version]));
    const synced: string[] = [];
    const skippedAheadOfSeed: string[] = [];
    for (const skill of skills) {
      const promotedAhead = databaseVersions.get(skill.skillId);
      if (promotedAhead && compareSkillVersions(promotedAhead, skill.version) > 0) {
        skippedAheadOfSeed.push(skill.skillId);
        continue;
      }
      await this.upsertKnowledgeRecord(seedId, "skills", {
        id: skill.skillId,
        version: skill.version,
        capabilities: skill.capabilities,
        applicableTasks: skill.applicableTasks,
        requiredMemoryKinds: skill.requiredMemoryKinds,
        conflicts: skill.conflicts,
        qualityGates: skill.qualityGates,
        promptSections: skill.promptSections,
        applicableGenres: skill.applicableGenres,
        executionPoints: skill.executionPoints,
        roles: skill.roles,
        dependsOn: skill.dependsOn,
        priority: skill.priority ?? "required",
        contentFingerprint: skill.contentFingerprint,
        sourceRef: skill.sourceRef,
        enabled: skill.enabled,
      });
      synced.push(skill.skillId);
    }
    return { synced, skippedAheadOfSeed };
  }

  async decideFactCandidate(input: { projectId: string; claimId: string; actorId: string; decision: "approve" | "reject"; reason?: string }): Promise<{ claimId: string; authority: "approved" | "rejected" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ authority: string }>("SELECT authority FROM memory_claims WHERE id=$1 AND project_id=$2 FOR UPDATE", [input.claimId, input.projectId]);
      if (!current.rowCount) throw new Error(`事实候选不存在：${input.claimId}`);
      if (current.rows[0].authority !== "candidate") throw new Error(`事实候选已处理（当前 authority=${current.rows[0].authority}）`);
      const authority = input.decision === "approve" ? "approved" : "rejected";
      await client.query("UPDATE memory_claims SET authority=$3,decided_by=$4,decided_at=now() WHERE id=$1 AND project_id=$2", [input.claimId, input.projectId, authority, input.actorId]);
      await client.query(
        "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,'memory-claim',$4,$5)",
        [input.projectId, input.actorId, `fact-candidate.${input.decision}`, input.claimId, { decision: input.decision, reason: input.reason }],
      );
      await this.appendOutboxTx(client, "memory-claim", input.claimId, `memory-claim.${authority}`, { projectId: input.projectId, claimId: input.claimId, actorId: input.actorId, reason: input.reason });
      await client.query("COMMIT");
      return { claimId: input.claimId, authority };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getFactExtractionContext(projectId: string, narrativeCutoff?: number): Promise<{ contentHashes: Set<string>; claimsIndex: Map<string, string[]>; claimsDigest: string; valueHashById: Map<string, string | undefined> }> {
    const result = await this.pool.query<{ id: string; content_hash: string; value_hash: string | null; subject_refs: string[] | null; predicate: string | null; title: string; content: string }>(
      `SELECT id,content_hash,value_hash,subject_refs,predicate,title,content
       FROM memory_claims
       WHERE project_id=$1 AND lifecycle_status='active' AND authority <> 'rejected'
         AND NOT ${retiredByVisibleKillerSql("memory_claims")}
         AND ($2::bigint IS NULL OR narrative_start IS NULL OR narrative_start <= $2)
       ORDER BY narrative_start DESC NULLS LAST,created_at DESC
       LIMIT 200`,
      [projectId, narrativeCutoff ?? null],
    );
    const contentHashes = new Set<string>();
    const claimsIndex = new Map<string, string[]>();
    // 值哈希索引（improvement-plan-fact-injection-20260922 迭代 2）：确定性矛盾核验
    // 需要"同槽位冻结声明的取值指纹"来区分 同值重复 / 异值矛盾，claimsIndex 只有 id。
    // 未知 value_hash（其他管道写入的行）记 undefined——核验侧对未知取值保持沉默
    // （宁可少报，由既有审批通道兜底）。
    const valueHashById = new Map<string, string | undefined>();
    for (const row of result.rows) {
      contentHashes.add(row.content_hash);
      valueHashById.set(row.id, row.value_hash ?? undefined);
      if (!row.predicate) continue;
      for (const subject of row.subject_refs ?? []) {
        const key = `${normalizeFactToken(subject)}|${canonicalizeFactPredicate(row.predicate)}`;
        claimsIndex.set(key, [...(claimsIndex.get(key) ?? []), row.id]);
      }
    }
    // 同主体同谓词历史槽位聚合（memory-governance-audit-20260909 §M5/§5.3.2）：
    // 近期明细 LIMIT 200 对更早历史存在静默盲区，而 novelty 判定需要全史感知。
    // 槽位按（规范化主体, 规范谓词）聚合全部截止点内 active 声明，每槽位输出累计条数
    // 与最近值。Foundation 投影（predicate IS NULL）与 rollup 不参与。
    const SLOT_LIMIT = 40; // TODO: move into runtime configuration (magic value: number of historical slots per extraction)
    const totalResult = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory_claims
       WHERE project_id=$1 AND lifecycle_status='active' AND authority <> 'rejected'
         AND ($2::bigint IS NULL OR narrative_start IS NULL OR narrative_start <= $2)`,
      [projectId, narrativeCutoff ?? null],
    );
    const totalEligible = Number(totalResult.rows[0]?.n ?? 0);
    const slotRows = await this.pool.query<{ ref: string; predicate: string; content: string; narrative_start: number | null }>(
      `SELECT unnest(subject_refs) AS ref, predicate, left(content, 120) AS content, narrative_start
       FROM memory_claims
       WHERE project_id=$1 AND lifecycle_status='active' AND authority <> 'rejected' AND predicate IS NOT NULL
         AND ($2::bigint IS NULL OR narrative_start IS NULL OR narrative_start <= $2)`,
      [projectId, narrativeCutoff ?? null],
    );
    const slotMap = new Map<string, { subject: string; predicate: string; count: number; latest: string; latestOrder: number | null }>();
    for (const row of slotRows.rows) {
      const key = `${normalizeFactToken(row.ref)}|${canonicalizeFactPredicate(row.predicate)}`;
      const order = row.narrative_start === null ? null : Number(row.narrative_start);
      const existing = slotMap.get(key);
      if (!existing) {
        slotMap.set(key, { subject: row.ref, predicate: canonicalizeFactPredicate(row.predicate), count: 1, latest: row.content, latestOrder: order });
        continue;
      }
      existing.count += 1;
      if (order !== null && (existing.latestOrder === null || order > existing.latestOrder)) {
        existing.latest = row.content;
        existing.latestOrder = order;
      }
    }
    const truncationNotice = totalEligible > result.rows.length
      ? [`（注意：近期明细仅显示最近 ${result.rows.length} 条，另有 ${totalEligible - result.rows.length} 条更早明细未列出；对未列出历史无法确认是否重复时，novelty 输出 new 并由后续事实梳理处理，不要猜测 duplicate。）`]
      : [];
    const slotLines = slotMap.size
      ? [
          ``,
          `## 同主体同谓词历史槽位（上表明细未覆盖的更早历史以此辅助 novelty/conflict 判断）`,
          ...[...slotMap.values()]
            .sort((a, b) => b.count - a.count || (b.latestOrder ?? 0) - (a.latestOrder ?? 0))
            .slice(0, SLOT_LIMIT)
            .map((slot) => `- ${slot.subject}｜${slot.predicate}：历史累计 ${slot.count} 条；最近：${slot.latest}`),
        ]
      : [];
    const detailLines = result.rows.map((row) => `- [${row.id}] ${(row.subject_refs ?? []).join("、") || "未指定主体"} ${row.predicate ?? "相关事实"}：${row.content}`);
    const claimsDigest = detailLines.length || slotLines.length
      ? [...truncationNotice, ...detailLines, ...slotLines].join("\n")
      : "- 暂无已存在记忆。所有事实 novelty=new。";
    return { contentHashes, claimsIndex, claimsDigest, valueHashById };
  }

  async recordFactApprovalPolicy(input: { projectId: string; artifactId: string; workflowId: string }): Promise<FactApprovalSummary> {
    // P0 #1: 记录自动审批决定——derived 事实视为 runtime 自动批准，写入 decided_by/decided_at 以便审计。
    // 此前该函数仅做统计、不改 authority，导致"审批"形同虚设。
    await this.pool.query(
      `UPDATE memory_claims SET decided_by='runtime',decided_at=now()
       WHERE project_id=$1 AND authority='derived' AND id IN (
         SELECT claim_id FROM memory_claim_sources WHERE project_id=$1 AND artifact_id=$2
       )`,
      [input.projectId, input.artifactId],
    );
    const result = await this.pool.query<{ authority: string; count: string }>(
      `SELECT claim.authority,count(*)::text AS count
       FROM memory_claims claim
       WHERE claim.project_id=$1 AND claim.id IN (
         SELECT claim_id FROM memory_claim_sources WHERE project_id=$1 AND artifact_id=$2
       ) GROUP BY claim.authority`,
      [input.projectId, input.artifactId],
    );
    const counts = new Map(result.rows.map((row) => [row.authority, Number(row.count)]));
    const pendingIds = (await this.pool.query<{ id: string }>(
      `SELECT claim.id FROM memory_claims claim
       WHERE claim.project_id=$1 AND claim.authority='candidate' AND claim.id IN (
         SELECT claim_id FROM memory_claim_sources WHERE project_id=$1 AND artifact_id=$2
       )`,
      [input.projectId, input.artifactId],
    )).rows.map((row) => row.id);
    const summary: FactApprovalSummary = { autoApproved: counts.get("derived") ?? 0, pending: counts.get("candidate") ?? 0, pendingIds };
    await this.pool.query(
      "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,'runtime','fact-approval.policy-applied','artifact',$2,$3)",
      [input.projectId, input.artifactId, { workflowId: input.workflowId, ...summary }],
    );
    await this.appendOutbox("artifact", input.artifactId, "fact-approval.policy-applied", { projectId: input.projectId, workflowId: input.workflowId, ...summary });
    return summary;
  }

  /**
   * P0 #1: 批量批准事实候选（人工事实审批门通过时调用）。
   * 将 candidate 事实翻转为 approved（authority=approved, decided_by='author'）。
   * 返回更新后的 MemoryClaim 列表，由 activity 层（createNovelWorkflowActivities.approveFactClaims）
   * 写回 Qdrant 向量索引；本函数只负责 PostgreSQL 真源。
   */
  async approveFactClaims(input: { projectId: string; ids: string[] }): Promise<MemoryClaim[]> {
    if (input.ids.length === 0) return [];
    await this.pool.query(
      "UPDATE memory_claims SET authority='approved', decided_by='author', decided_at=now() WHERE project_id=$1 AND id = ANY($2::text[]) AND authority='candidate'",
      [input.projectId, input.ids],
    );
    const result = await this.pool.query<any>(
      "SELECT * FROM memory_claims WHERE project_id=$1 AND id = ANY($2::text[])",
      [input.projectId, input.ids],
    );
    return result.rows.map(memoryClaimFromRow);
  }

  async appendCreativeRunEvent(runId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.pool.query("INSERT INTO creative_run_events(run_id,event_type,payload) VALUES($1,$2,$3)", [runId, eventType, payload]);
  }

  async getFoundationWorkContext(projectId: string, dependencyWorkItemIds: string[], currentTaskKey?: ProjectPlanTaskKey): Promise<{
    project: { title: string; metadata: Record<string, unknown> };
    priorArtifacts: Array<{ taskKey: string; title: string; summary: string }>;
  }> {
    const projectResult = await this.pool.query<{ title: string; metadata: Record<string, unknown> }>("SELECT title,metadata FROM novel_projects WHERE id=$1", [projectId]);
    const project = projectResult.rows[0];
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const stage = currentTaskKey ? PROJECT_PLAN_STAGES.find((candidate) => candidate.taskKey === currentTaskKey) : undefined;
    if (!dependencyWorkItemIds.length && !stage?.dependsOn.length) return { project, priorArtifacts: [] };
    const result = currentTaskKey
      ? await this.pool.query<{ task_key: string | null; payload: Record<string, unknown> | null }>(
        `SELECT ps.task_key,a.payload
         FROM project_plan_sections ps
         JOIN artifacts a ON a.id=ps.source_artifact_id
         WHERE ps.project_id=$1 AND ps.task_key=ANY($2::text[]) AND ps.status='approved'`,
        [projectId, stage?.dependsOn ?? []],
      )
      : await this.pool.query<{ task_key: string | null; payload: Record<string, unknown> | null }>(
        `SELECT wi.task_key,a.payload
         FROM creative_work_items wi
         LEFT JOIN LATERAL (
           SELECT payload FROM artifacts WHERE id=wi.artifact_refs[array_length(wi.artifact_refs,1)]
         ) a ON TRUE
         WHERE wi.id=ANY($1::text[])`,
        [dependencyWorkItemIds],
      );
    const priorArtifacts = result.rows.flatMap((row) => {
      const title = row.payload?.title;
      const summary = row.payload?.summary;
      return typeof title === "string" && typeof summary === "string"
        ? [{ taskKey: row.task_key ?? "unknown", title, summary }]
        : [];
    });
    return { project, priorArtifacts };
  }

  async commitRevision(input: CommitRequest & { text: string; contentHash: string; objectKey: string; revisionId: string; factArtifactId?: string; narrativeOrder?: number }): Promise<CommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ result: CommitResult }>("SELECT result FROM idempotency_keys WHERE project_id=$1 AND key=$2", [input.projectId, input.idempotencyKey]);
      if (existing.rowCount) { await client.query("COMMIT"); return existing.rows[0].result; }
      const project = await client.query<{ current_revision: string }>("SELECT current_revision FROM novel_projects WHERE id=$1 FOR UPDATE", [input.projectId]);
      if (!project.rowCount || Number(project.rows[0].current_revision) !== input.baseRevision) throw new Error("正式稿基线已变化，需要重新生成和审核");
      await client.query("INSERT INTO content_blobs(content_hash,object_key,byte_length,word_count,dialogue_characters) VALUES($1,$2,$3,$4,$5) ON CONFLICT(content_hash) DO UPDATE SET word_count=COALESCE(content_blobs.word_count,EXCLUDED.word_count), dialogue_characters=COALESCE(content_blobs.dialogue_characters,EXCLUDED.dialogue_characters)", [input.contentHash, input.objectKey, Buffer.byteLength(input.text, "utf8"), countNovelCharacters(input.text), countDialogueCharacters(input.text)]);
      await client.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING", [input.artifact.id, input.projectId, input.artifact.taskId, input.artifact.attemptId, input.artifact.kind, input.contentHash, input.objectKey, input.baseRevision, input.artifact.fingerprint, input.artifact.structuredData ?? {}]);
      // 修复：显式 JSON.stringify，与 putReview 一致。
      // 原因：review.issues 是 ReviewIssue[]，pg 直接传数组到 jsonb 列时，
      // 若元素含 undefined/Date/特殊对象会触发 "invalid input syntax for type json" 错误
      // （如 "Expected ":", but found ",""）。先 JSON.stringify 为字符串，让 PostgreSQL 解析为 jsonb。
      for (const review of input.reviews) await client.query("INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,artifact_fingerprint,issues,score,role,model_provenance,dimension_scores) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING", [review.id, input.projectId, review.artifactId, review.reviewerId, review.identity, review.verdict, review.artifactFingerprint, JSON.stringify(review.issues), review.score ?? null, review.role ?? null, review.modelProvenance ? JSON.stringify(review.modelProvenance) : null, JSON.stringify({})]);
      const revision = input.baseRevision + 1;
      const currentDocument = await client.query<{ current_revision_id: string | null }>("SELECT current_revision_id FROM manuscript_documents WHERE id=$1 AND project_id=$2 FOR UPDATE", [input.documentId, input.projectId]);
      const previousRevisionId = currentDocument.rows[0]?.current_revision_id ?? null;
      if (previousRevisionId) await client.query("UPDATE manuscript_revisions SET retention_class='rolling',expires_at=COALESCE(expires_at,now()+interval '30 days') WHERE id=$1 AND retention_class<>'named'", [previousRevisionId]);
      await client.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [input.revisionId, input.projectId, input.documentId, revision, input.baseRevision, input.contentHash, input.artifact.id]);
      // P0-C4 修订：传提交正文作为 plainText，使 refresh 重算 evidence 软标记时
      // 不因缺少正文而抹掉已落库的 evidence-unverified 标记（与 putReview 路径一致）。
      await this.refreshChapterReviewSnapshotTx(client, input.artifact.id, input.revisionId, input.text);
      await client.query("UPDATE manuscript_documents SET current_revision_id=$1,status='final',updated_at=now() WHERE id=$2 AND project_id=$3", [input.revisionId, input.documentId, input.projectId]);
      await this.syncFinalChapterBlueprintStatusTx(client, input.projectId, input.documentId);

      let removedClaimIds: string[] = [];
      let activatedClaims: MemoryClaim[] = [];
      if (input.factArtifactId) {
        const activatedSources = await client.query<{ claim_id: string }>(
          `UPDATE memory_claim_sources SET
             document_id=$3,revision_id=$4,lifecycle_status='active'
           WHERE project_id=$1 AND artifact_id=$2
           RETURNING claim_id`,
          [input.projectId, input.factArtifactId, input.documentId, input.revisionId],
        );
        const activatedIds = [...new Set(activatedSources.rows.map((row) => row.claim_id))];

        let priorClaimIds: string[] = [];
        if (previousRevisionId) {
          const removedSources = await client.query<{ claim_id: string }>(
            `DELETE FROM memory_claim_sources
             WHERE project_id=$1 AND document_id=$2 AND revision_id=$3
             RETURNING claim_id`,
            [input.projectId, input.documentId, previousRevisionId],
          );
          priorClaimIds = [...new Set(removedSources.rows.map((row) => row.claim_id))];
        }

        const affectedIds = [...new Set([...activatedIds, ...priorClaimIds])];
        if (affectedIds.length) {
          await client.query(
            `UPDATE memory_claims claim SET
               ${CLAIM_PROJECTION_SET_SQL},
               source_document_id=COALESCE((
                 SELECT source.document_id FROM memory_claim_sources source
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active' AND source.document_id IS NOT NULL
                 ORDER BY source.created_at DESC LIMIT 1
               ),source_document_id)
             WHERE claim.id=ANY($1::text[])`,
            [affectedIds],
          );
        }

        if (priorClaimIds.length) {
          const deleted = await client.query<{ id: string }>(
            `DELETE FROM memory_claims claim
             WHERE claim.id=ANY($1::text[])
               AND NOT EXISTS (
                 SELECT 1 FROM memory_claim_sources source
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active'
               )
             RETURNING id`,
            [priorClaimIds],
          );
          removedClaimIds = deleted.rows.map((row) => row.id);
        }

        if (activatedIds.length) {
          const activeRows = await client.query<any>(
            "SELECT * FROM memory_claims WHERE id=ANY($1::text[]) AND lifecycle_status='active'",
            [activatedIds],
          );
          activatedClaims = activeRows.rows.map(memoryClaimFromRow);
        }
      }
        const arcCompletions = await client.query<{ id: string; project_id: string }>(
          `UPDATE arcs a SET execution_status='completed',completed_at=now(),updated_at=now()
          WHERE a.id=(SELECT arc_id FROM chapters WHERE document_id=$1)
            AND a.execution_status='active'
            AND EXISTS (SELECT 1 FROM chapters c WHERE c.arc_id=a.id)
            AND NOT EXISTS (
              SELECT 1
              FROM chapters c
              LEFT JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
              WHERE c.arc_id=a.id
                AND (d.id IS NULL OR d.status<>'final' OR d.current_revision_id IS NULL)
            )
            AND ${arcCompletionPredicateSql("a", "b")}
          RETURNING a.id,a.project_id`,
          [input.documentId],
        );
        for (const completedArc of arcCompletions.rows) {
          await client.query(
            "INSERT INTO audit_records(project_id,actor,action,aggregate_type,aggregate_id,payload) VALUES($1,$2,'story-arc.completion-reconciled','story-arc',$3,$4)",
            [completedArc.project_id, "runtime-commit", completedArc.id, { reason: "chapter commit closed the arc under the local-count completion predicate" }],
          );
        }
      await client.query("UPDATE novel_projects SET current_revision=$1,updated_at=now() WHERE id=$2", [revision, input.projectId]);
      const result: CommitResult = {
        revisionId: input.revisionId,
        revision,
        contentHash: input.contentHash,
        outboxEventId: 0,
        ...(removedClaimIds.length ? { removedClaimIds } : {}),
        ...(activatedClaims.length ? { activatedClaims } : {}),
      };
      const event = await this.appendOutboxTx(client, "manuscript-revision", input.revisionId, "manuscript-revision.committed", { projectId: input.projectId, documentId: input.documentId, revision, contentHash: input.contentHash });
      result.outboxEventId = event;
      await client.query("INSERT INTO idempotency_keys(project_id,key,result) VALUES($1,$2,$3)", [input.projectId, input.idempotencyKey, result]);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  private outboxProjectId(payload: Record<string, unknown>): string | null {
    return typeof payload.projectId === "string" && payload.projectId ? payload.projectId : null;
  }

  private async appendOutbox(aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) {
    const result = await this.pool.query<{ id: number }>("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,project_id) VALUES($1,$2,$3,$4,$5) RETURNING id", [aggregateType, aggregateId, eventType, payload, this.outboxProjectId(payload)]);
    return Number(result.rows[0].id);
  }

  private async appendOutboxTx(client: PoolClient, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) {
    const result = await client.query<{ id: number }>("INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,project_id) VALUES($1,$2,$3,$4,$5) RETURNING id", [aggregateType, aggregateId, eventType, payload, this.outboxProjectId(payload)]);
    return Number(result.rows[0].id);
  }

  async close() { await this.pool.end(); }
}
