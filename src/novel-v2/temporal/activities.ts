import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, ContextManifest, CreativeReview, CreativeRun, CreativeWorkItem, ExecutionBlueprint, MemoryBundle, MemoryClaim, MemoryHit, MemoryProvider, NovelIntent, PreflightPlan, PreflightProjectSnapshot, PromptContextManifest, Review, ReviewIssue, RuntimeLearningAssessmentV2, SkillBundle, SkillExecutionPoint, SkillProvider, StageContextSection, StageGoalContract, TaskAttemptRecord } from "../protocol";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, computeTokenBudget, createPreflightPlan, isMemoryClaimVisibleAtCutoff, matchedFacetsOf } from "../cognition";
import { canonicalSha256 } from "../canonical-json";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelGateway } from "../model-gateway";
import { ExternalMcpRequiredError, type ModelExecutionProvenance, type ModelPurpose, type ModelRoutingSnapshot, type ModelTaskRecord, type ModelWorkPackage } from "../model-routing";
import { ContentObjectStore } from "../object-store";
import { normalizeStoryArcRebaseBundle, parseStoryArcBundle, validateChapterExecutionContract, validateStoryArcExecutionContracts, validateStoryArcRebaseBundle, type ChapterPlanningContext, type StoryArcBundle } from "../application/story-arc";
import { inspectManuscript, structuralReviewFromReport, type ManuscriptStructuralReport } from "../application/manuscript-structure";
import { buildStoryArcChaptersPrompt, buildStoryArcPlanPrompt, buildStoryArcPlanningContextSections, buildStoryArcReviewPrompt, buildStoryArcRevisionPrompt, storyArcBundleSchema, storyArcChaptersOutputSchema, storyArcPlanBatchSchema, type StoryArcReviewOutput } from "../prompts/story-arc";
import { foundationArtifactToMemoryClaim } from "../foundation-memory";
import { CommitService } from "../commit-service";
import type { MemoryIndex } from "../qdrant-memory";
import { assessRuntimeLearningWithModel, reviewIssuesForLearning, buildRuntimeLearningPrompt, parseRuntimeLearningAssessmentV2, runtimeLearningAssessmentSchema } from "../learning-assessment";
import { buildChapterDraftPromptPackage } from "../prompts/chapter-draft";
import { buildChapterReviewPromptPackage, getReviewFocus, reviewExecutionPoint, selectReviewerMemory, selectReviewerSkills, toReview, type ReviewerRole } from "../prompts/chapter-review";
import { applyRevisionWindows, applyTargetedRevisionReplacements, authorRevisionAlignmentSchema, buildAuthorRevisionRepairPromptPackage, buildFullChapterRevisionPromptPackage, buildRevisionWindowPromptPackage, buildTargetedRevisionBatchPromptPackage, planRevisionWindows, revisionWindowsCoverAllIssues, sanitizeRevisionOutput, shouldUseRevisionWindows, splitChapterParagraphs, TargetedRevisionContractError, targetedRevisionBatchSchema, type AuthorRevisionAlignment, type RevisionAttempt, type TargetedRevisionReplacement } from "../prompts/chapter-revision";
import { chapterStateDeltaSchema, reviewerSchema, type ChapterStateDelta, type FactExtractionOutput, type FoundationOutput, type ReviewerOutput } from "../prompts/schemas";
import { extractFactsWithStats, projectFactExtractionOutput } from "../fact-extraction";
import { enrichCharactersFromChapter, parseCharacterEnrichmentOutput } from "../character-enrichment";
import { characterEnrichmentSchema } from "../prompts/schemas";
import { buildFactExtractionPrompt } from "../fact-extraction/prompt";
import { styleContractAsMemoryHit } from "../style-contract";
import { createCraftRuleCandidate } from "../craft-rule";
import { countNovelCharacters } from "../word-count";
import { buildFoundationPrompt, FOUNDATION_SYSTEM_PROMPT } from "../prompts/foundation";
import { compileStageContext, createStageGoalContract, StageContextBudgetError } from "../stage-context";
import { reviewIssueFingerprint } from "../chapter-review-snapshot";
import { buildRevisionBrief, shouldBlockRevisionForConflicts } from "../application/revision-brief";
import { classifyRevisionEvidence } from "./revision-policy";
import { buildSkillContextSections, resolveStageSkillBundle } from "../skill-runtime";
import {
  BOOK_SYNOPSIS_SCHEMA,
  BOOK_TITLE_CANDIDATES_SCHEMA,
  bookSynopsisSourceFingerprint,
  bookTitleSourceFingerprint,
  buildBookSynopsisPrompt,
  buildBookTitleCandidatesPrompt,
  normalizeBookTitleCandidates,
  type BookSynopsisRecord,
  type BookTitleCandidate,
  type BookTitleCandidatesRecord,
} from "../application/book-synopsis";
import {
  CHAPTER_TITLE_SCHEMA,
  buildChapterTitlePrompt,
  chapterTitleSourceFingerprint,
  normalizeChapterTitle,
} from "../application/chapter-title";
import {
  acceptWork as creativeAcceptWork,
  attachArtifact as creativeAttachArtifact,
  checkGate as creativeCheckGate,
  getCreativeRun,
  getWorkItem as creativeGetWorkItem,
  listWorkItems as creativeListWorkItems,
  retryWork as creativeRetryWork,
  reviseWork as creativeReviseWork,
  startWork as creativeStartWork,
  updateRunStatusFromWork,
  failWork as creativeFailWork,
  listReviews as creativeListReviews,
  submitReview as creativeSubmitReview,
} from "../creative";
import { parseCreativeBrief } from "../application/creative-brief";
import { assertFoundationTaskContract, foundationSchemaForTask, normalizeFoundationModelOutput, validateFoundationTaskContract } from "../application/foundation-contract";
import { hasPassedIndependentReviewForArtifact } from "../creative/review-gate";
import { isProjectPlanTaskKey, isRetiredFoundationTaskKey, requiresFoundationAuthorConfirmation } from "../application/project-plan";
import { buildFoundationReviewPrompt } from "../prompts/foundation-review";
import { extractReviewText, opinionToReviewIssue, parseTextReview } from "../text-review";

function assertStructuredSchema(value: unknown, schema: Record<string, unknown>, label: string): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(value)) throw new Error(`${label}不符合输出契约：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；") ?? "未知错误"}`);
}

type GeneratedTextResult = { kind: "completed"; artifact: Artifact; text: string } | { kind: "external"; task: ModelTaskRecord };
type GeneratedReviewResult = { kind: "completed"; review: Review } | { kind: "external"; task: ModelTaskRecord };
type GeneratedArtifactResult = { kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact };
type GeneratedLearningResult = { kind: "completed"; assessment: RuntimeLearningAssessmentV2 } | { kind: "external"; task: ModelTaskRecord };
type GeneratedStoryArcResult = { kind: "completed"; artifact: Artifact; bundle: StoryArcBundle } | { kind: "external"; task: ModelTaskRecord };
type StoryArcPlanOutput = Pick<StoryArcBundle, "arc" | "batch">;
type StoryArcChaptersOutput = Pick<StoryArcBundle, "chapters">;
type GeneratedStoryArcReviewResult = { kind: "completed"; artifact: Artifact; review: StoryArcReviewOutput } | { kind: "external"; task: ModelTaskRecord };
type GeneratedBookSynopsisResult = { kind: "completed"; text: string } | { kind: "external"; task: ModelTaskRecord };
type GeneratedBookTitleCandidatesResult = { kind: "completed"; candidates: BookTitleCandidate[] } | { kind: "external"; task: ModelTaskRecord };
type GeneratedChapterTitleResult = { kind: "completed"; title: string } | { kind: "external"; task: ModelTaskRecord };
type TargetedRevisionBatchOutput = { replacements: TargetedRevisionReplacement[] };

// TODO: Move the review-pass budget into the persisted model-route contract so
// operators can tune provider latency without rebuilding the worker. The
// default bounds one independent lens while leaving enough time for a large
// structured architecture review; a slow lens is evidence to retain, not a
// reason to block a complete independent review.
// 根因修复（2026-08-06）：弧审核 prompt 包含整弧章节蓝图 + 规划上下文，模型生成
// 审核意见通常需 2-5 分钟；120s 默认预算在模型服务响应偏慢时导致所有 lens 同时
// 超时（generated.length===0 → 整轮审核失败），连续多次复现。观察审核模型输出超长
// 逐章分析（>1.7 万字符）单次生成可超 5 分钟，故默认预算放宽为 10 分钟，属通用
// 超时配置，非针对特定弧/章节的个案调整；仍可经 env 覆盖。
const ARC_REVIEW_PASS_TIMEOUT_MS = (() => {
  const configured = Number(process.env.NOVEL_ARC_REVIEW_PASS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 600_000;
})();

export function buildCraftRuleCandidateInput(assessment: RuntimeLearningAssessmentV2): Parameters<typeof createCraftRuleCandidate>[1] | undefined {
  if (assessment.conclusion !== "propose-improvement" || !assessment.candidate) return undefined;
  const underlyingMechanism = assessment.underlyingMechanism;
  const affectedInputClass = assessment.affectedInputClass;
  if (!underlyingMechanism || !affectedInputClass) {
    throw new Error("propose-improvement 已落库但缺少 underlyingMechanism/affectedInputClass，不能创建改进候选");
  }
  return {
    projectId: assessment.projectId,
    targetKind: assessment.candidate.targetKind,
    targetId: assessment.candidate.targetId,
    afterText: assessment.candidate.afterText,
    rationale: assessment.candidate.rationale,
    scope: {
      observedSymptom: assessment.symptom ?? "未记录症状",
      failingLayer: assessment.failingLayer ?? "未记录失败层",
      underlyingMechanism,
      affectedInputClass,
      intendedBenefits: [assessment.candidate.rationale],
      boundaries: assessment.boundaries ? [assessment.boundaries] : [],
      nonGoals: [],
      regressionRisks: assessment.regressionRisks ?? [],
    },
    learningSource: {
      assessmentId: assessment.id,
      conclusion: assessment.conclusion,
      mechanism: underlyingMechanism,
    },
    applicableGenres: assessment.candidate.applicableGenres,
  };
}

export function createNovelWorkflowActivities(deps: { repository: NovelPostgresRepository; memoryProvider: MemoryProvider; skillProvider: SkillProvider; modelGateway: ModelGateway; objectStore?: ContentObjectStore; commitService?: CommitService; memoryIndex?: MemoryIndex; /** 是否启用 chapter memory 创建（默认 true，需 modelGateway 支持）。 */ enableChapterMemory?: boolean }) {
  const model = deps.modelGateway;
  const objects = deps.objectStore ?? new ContentObjectStore();
  const reviewerPurpose = (role: ReviewerRole): ModelPurpose => ({
    "structure-reviewer": "review.structure",
    "character-reviewer": "review.character",
    "prose-reviewer": "review.prose",
  } satisfies Record<ReviewerRole, ModelPurpose>)[role];
  const makeArtifact = async (input: { projectId: string; taskId: string; kind: Artifact["kind"]; baseRevision: number; text: string; structuredData?: Record<string, unknown> }): Promise<Artifact> => {
    const object = await objects.putText(input.text);
    const artifact = { id: randomUUID(), projectId: input.projectId, taskId: input.taskId, attemptId: randomUUID(), kind: input.kind, contentHash: object.hash, objectKey: object.key, structuredData: input.structuredData, baseRevision: input.baseRevision, createdAt: Date.now(), fingerprint: createHash("sha256").update(`${object.hash}:${input.taskId}`).digest("hex") } satisfies Artifact;
    await deps.repository.recordArtifact(artifact);
    return artifact;
  };
  const resolveCurrentSkills = (input: { projectId: string; executionPoint: SkillExecutionPoint; role?: string; memory?: MemoryBundle; preflightId?: string; genre?: string; requestedCapabilities?: string[] }) => resolveStageSkillBundle({
    projectId: input.projectId,
    provider: deps.skillProvider,
    executionPoint: input.executionPoint,
    role: input.role,
    memory: input.memory,
    preflightId: input.preflightId,
    genre: input.genre,
    requestedCapabilities: input.requestedCapabilities,
  });
  // CommitService 自动注入 chapter memory 依赖（若未提供 commitService 且未显式禁用）
  // 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约
  const enableChapterMemory = deps.enableChapterMemory ?? true;
  const commitService = deps.commitService ?? new CommitService(deps.repository, objects, enableChapterMemory ? { model, memoryIndex: deps.memoryIndex } : undefined);
  const compileSinglePrompt = (input: { projectId: string; workflowId: string; purpose: ModelPurpose; stage: "foundation" | "planning" | "review" | "revision" | "fact-extraction"; system: string; prompt: string; schema?: Record<string, unknown>; reservedOutputTokens?: number; provenanceRefs?: string[]; skillBundle?: SkillBundle; skillExecutionPoint?: string; contextSections?: StageContextSection[] }) => {
    const skillSections = input.skillBundle && input.skillExecutionPoint
      ? buildSkillContextSections(input.skillBundle, input.skillExecutionPoint)
      : [];
    return compileStageContext({
    projectId: input.projectId,
    workflowId: input.workflowId,
    purpose: input.purpose,
    stage: input.stage,
    system: input.system,
    schema: input.schema,
    maxInputTokens: 128_000,
    reservedOutputTokens: input.reservedOutputTokens ?? 8_192,
    skillManifest: input.skillBundle?.resolution,
    sections: [
      { id: `${input.stage}-prompt`, kind: "background", title: "阶段任务与上下文", text: input.prompt, priority: "required", provenanceRefs: input.provenanceRefs ?? [] },
      ...(input.contextSections ?? []),
      ...skillSections,
    ],
  });
  };
  const externalTask = async (input: { workflowId: string; taskId: string; purpose: ModelPurpose; candidateIndex: number; routingSnapshot: ModelRoutingSnapshot; outputKind: ModelWorkPackage["outputKind"]; system?: string; instruction: string; schema?: Record<string, unknown>; schemaName?: string; baseRevision: number; contextRefs: ModelWorkPackage["contextRefs"]; promptContext?: PromptContextManifest }): Promise<ModelTaskRecord> => {
    const inputFingerprint = createHash("sha256").update(JSON.stringify({ purpose: input.purpose, system: input.system, instruction: input.instruction, schema: input.schema, baseRevision: input.baseRevision, contextRefs: input.contextRefs, promptContextFingerprint: input.promptContext?.fingerprint })).digest("hex");
    const id = createHash("sha256").update(`${input.workflowId}:${input.taskId}:${input.candidateIndex}:${inputFingerprint}`).digest("hex");
    const workPackage: ModelWorkPackage = { id, workflowRunId: input.workflowId, taskId: input.taskId, purpose: input.purpose, configRevision: input.routingSnapshot.id, candidateIndex: input.candidateIndex, outputKind: input.outputKind, system: input.system, instruction: input.instruction, schema: input.schema, schemaName: input.schemaName, baseRevision: input.baseRevision, inputFingerprint, contextRefs: input.contextRefs, promptContext: input.promptContext, createdAt: Date.now() };
    return deps.repository.createModelTask(workPackage, `${input.workflowId}:${input.taskId}:${input.candidateIndex}:${inputFingerprint}`);
  };
  const recordLearning = async (assessment: RuntimeLearningAssessmentV2) => {
    const recorded = await deps.repository.recordLearningAssessment(assessment);
    const candidateInput = buildCraftRuleCandidateInput(recorded);
    if (candidateInput) await createCraftRuleCandidate(deps.repository, candidateInput);
    return recorded;
  };
  const loadNarrativeRhythm = async (projectId: string, documentId: string, narrativeCutoff: number) => {
    if (typeof deps.repository.getNarrativeRhythmSnapshot !== "function") return undefined;
    try {
      return await deps.repository.getNarrativeRhythmSnapshot(projectId, documentId, narrativeCutoff);
    } catch (error) {
      console.warn(`[narrative-rhythm] 连续章节节奏快照加载失败，继续使用事实记忆：${(error as Error).message}`);
      return undefined;
    }
  };
  const loadSerialContext = async (projectId: string, documentId: string, narrativeCutoff: number) => {
    if (typeof deps.repository.getSerialContextSnapshot !== "function") return undefined;
    try {
      return await deps.repository.getSerialContextSnapshot(projectId, documentId, narrativeCutoff);
    } catch (error) {
      console.warn(`[serial-context] 跨章序列证据快照加载失败，继续使用既有记忆：${(error as Error).message}`);
      return undefined;
    }
  };
  // TODO P2: 修订 temperature 应可配置——当前 0.3 是创作多样性与指令遵循的折中值，
  // 未来应由 model routing 配置或 blueprint budget 决定，而非硬编码。
  const REVISION_TEMPERATURE = 0.3;
  const api = {
    updateWorkflowStatus: (input: { workflowId: string; status: string; payload?: Record<string, unknown> }) => deps.repository.updateWorkflowRunStatus(input.workflowId, input.status, input.payload),
    recordWorkflowSignal: (input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) => deps.repository.recordTaskSignal(input),
    updateTaskAttempt: (input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; payload?: Record<string, unknown> }) => deps.repository.upsertTaskAttempt(input),
    loadProjectSnapshot: (input: { projectId: string; targetDocumentId?: string }) => deps.repository.getProjectSnapshot(input.projectId, input.targetDocumentId),
    createPreflight: async (input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }) => createPreflightPlan(input.intent, input.snapshot),
    retrieveMemory: async (input: { projectId: string; plan: PreflightPlan }): Promise<MemoryBundle> => {
      const repairedFoundationClaims = await deps.repository.ensureFoundationMemoryClaims(input.projectId);
      if (repairedFoundationClaims.length && deps.memoryIndex) {
        try {
          await deps.memoryIndex.upsertClaims(input.projectId, repairedFoundationClaims);
        } catch (error) {
          console.warn(`[foundation-memory] 历史 projection 的 Qdrant 索引失败，PostgreSQL 真源已保留：${(error as Error).message}`);
        }
      }
      // Phase 2.3 动态上下文预算：根据 taskClass + totalChapters 计算合理预算
      // 设计依据：Phase 2.3 计划——长篇后期需要更多前章记忆（chapter memory + 伏笔 + 角色状态）
      let totalChapters: number | undefined;
      try {
        totalChapters = await deps.repository.countDocuments(input.projectId);
      } catch {
        // 查询失败时降级为默认预算（computeTokenBudget 会返回 24K）
        totalChapters = undefined;
      }
      const tokenBudget = computeTokenBudget(input.plan.taskClass, totalChapters);
      let narrativeHits: MemoryHit[] = [];
      let openNarrativeHits: MemoryHit[] = [];
      let styleContractHits: MemoryHit[] = [];
      if (input.plan.taskClass === "drafting" || input.plan.taskClass === "revision" || input.plan.taskClass === "planning") {
        narrativeHits = await deps.repository.getNarrativeStatePinnedClaims({
          projectId: input.projectId,
          documentId: input.plan.targetDocumentId,
          narrativeCutoff: input.plan.narrativeCutoff,
          povCharacterId: input.plan.povCharacterId,
        });
        if (input.plan.replacementRevisionId && input.plan.targetDocumentId) {
          const replaced = await deps.repository.getChapterMemoryByDocument(input.projectId, input.plan.targetDocumentId);
          if (replaced?.revisionId === input.plan.replacementRevisionId) {
            const replacementFacts = (await deps.repository.listActiveMemoryClaimsByRevision(input.projectId, replaced.revisionId))
              .filter((claim) => claim.knowledgeScope === "author" && claim.kind !== "hierarchical");
            const eventBoundary = replacementFacts.length
              ? replacementFacts.map((claim) => `- ${claim.content}`).join("\n")
              : `- ${replaced.summary}`;
            const content = [
              "本次任务替换已有定稿。本段只约束下列已审核原子事实和仍未解决的问题；不得沿用旧对白、解释、主题结论、场景组织、具体措辞或旧摘要中的人物评价。原子事实是完成后的验收结果，不是必须逐句复述的提纲。",
              "既有事件与结果：",
              eventBoundary,
              `替换后仍须保持未解：${replaced.unresolvedThreads.join("；") || "无"}`,
            ].join("\n");
            narrativeHits.push({
              id: `replacement-boundary:${replaced.revisionId}`,
              projectId: input.projectId,
              kind: "working",
              title: "被替换章节的事件结果边界",
              content,
              subjectRefs: replaced.characterStates.map((item) => item.characterId),
              knowledgeScope: "author",
              authority: "approved",
              confidence: 1,
              sourceRevisionIds: [replaced.revisionId],
              contentHash: canonicalSha256({ revisionId: replaced.revisionId, replacementFacts: replacementFacts.map((claim) => claim.contentHash), unresolvedThreads: replaced.unresolvedThreads }),
              supersedes: [],
              score: 1,
              matchedFacet: "fact",
              matchedFacets: ["fact", "thread"],
              reason: "replacement-boundary",
              semanticRank: 1,
            });
          }
        }
      }
      // 开放伏笔/承诺注入（workflow-map.md §6.2：retrieveMemory 须组合开放伏笔/承诺）
      if (typeof input.plan.narrativeCutoff === "number") {
        try {
          const { foreshadowings, promises } = await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.plan.narrativeCutoff);
          openNarrativeHits = [
            ...foreshadowings.map((f) => ({
              id: f.id,
              projectId: input.projectId,
              kind: "working" as const,
              title: `未兑现伏笔：${f.description.slice(0, 40)}`,
              content: `伏笔内容：${f.description}\n触发关键词：${f.triggerKeywords.join("、")}\n预期兑现：${f.expectedPayoffWindow}${f.readerQuestion ? `\n读者问题：${f.readerQuestion}` : ""}${f.possiblePayoffs?.length ? `\n可行兑现方向：${f.possiblePayoffs.join("、")}` : ""}${f.meaningDelta ? `\n意义增量：${f.meaningDelta}` : ""}${f.cost ? `\n代价：${f.cost}` : ""}\n埋设于：${f.plantedRevisionId}`,
              subjectRefs: [],
              knowledgeScope: "author" as const,
              authority: "derived" as const,
              confidence: 0.9,
              sourceRevisionIds: [f.plantedRevisionId],
              contentHash: f.id,
              supersedes: [],
              score: 1.0,
              matchedFacet: "foreshadowing",
              matchedFacets: ["foreshadowing"],
              reason: "open-foreshadowing-injection",
              semanticRank: 1.0,
            })),
            ...promises.map((p) => ({
              id: p.id,
              projectId: input.projectId,
              kind: "working" as const,
              title: `未兑现承诺：${p.statement.slice(0, 40)}`,
              content: `承诺内容：${p.statement}\n承诺者：${p.promiser || "未知"}\n被承诺者：${p.promisee || "未知"}\n来源：${p.sourceRevisionId}`,
              subjectRefs: [],
              knowledgeScope: "author" as const,
              authority: "derived" as const,
              confidence: 0.9,
              sourceRevisionIds: [p.sourceRevisionId],
              contentHash: p.id,
              supersedes: [],
              score: 1.0,
              matchedFacet: "foreshadowing",
              matchedFacets: ["foreshadowing"],
              reason: "open-promise-injection",
              semanticRank: 1.0,
            })),
          ];
        } catch (error) {
          console.warn(`[memory] 开放伏笔/承诺注入失败，继续使用已有记忆：${(error as Error).message}`);
        }
      }
      // 文风契约注入：active 版本作为叙述声音的对照参考，走 ranked-fill（可被预算淘汰），不冻结。
      if (input.plan.taskClass === "drafting" || input.plan.taskClass === "revision" || input.plan.taskClass === "review") {
        try {
          const contract = await deps.repository.getActiveStyleContract(input.projectId);
          if (contract) styleContractHits.push(styleContractAsMemoryHit(contract, input.projectId));
        } catch (error) {
          console.warn(`[memory] 文风契约注入失败，继续使用已有记忆：${(error as Error).message}`);
        }
      }
      const bundle = await buildMemoryBundle(input.plan, { projectId: input.projectId, provider: deps.memoryProvider, tokenBudget, pinnedClaims: narrativeHits, additionalClaims: [...openNarrativeHits, ...styleContractHits] });
      if (!input.plan.targetDocumentId || typeof input.plan.narrativeCutoff !== "number") return bundle;
      const [narrativeRhythm, serialContext] = await Promise.all([
        loadNarrativeRhythm(input.projectId, input.plan.targetDocumentId, input.plan.narrativeCutoff),
        loadSerialContext(input.projectId, input.plan.targetDocumentId, input.plan.narrativeCutoff),
      ]);
      if (!narrativeRhythm && !serialContext) return bundle;
      return {
        ...bundle,
        ...(narrativeRhythm ? { narrativeRhythm } : {}),
        ...(serialContext ? { serialContext } : {}),
        fingerprint: canonicalSha256({ base: bundle.fingerprint, narrativeRhythm: narrativeRhythm?.fingerprint, serialContext: serialContext?.fingerprint }),
      };
    },
    resolveSkills: (input: { projectId: string; plan: PreflightPlan; memory: MemoryBundle; requestedCapabilities?: string[]; genre?: string }) => {
      const executionPointByTaskClass: Record<PreflightPlan["taskClass"], SkillExecutionPoint> = {
        foundation: "foundation.book-plan",
        planning: "chapter.blueprint",
        drafting: "chapter.drafting",
        review: "chapter.review.structure",
        revision: "chapter.revision",
        "memory-maintenance": "chapter.fact-extraction",
      };
      return resolveCurrentSkills({
        projectId: input.projectId,
        executionPoint: executionPointByTaskClass[input.plan.taskClass],
        memory: input.memory,
        preflightId: input.plan.id,
        genre: input.genre,
        requestedCapabilities: input.requestedCapabilities,
      });
    },
    resolveReviewSkills: async (input: { projectId: string; preflightId: string }): Promise<SkillBundle> => {
      const bundle = await resolveCurrentSkills({ projectId: input.projectId, preflightId: input.preflightId, executionPoint: "chapter.review.structure", role: "structure-reviewer" });
      return deps.repository.putSkillBundle(bundle);
    },
    compileBlueprint: async (input: { intent: NovelIntent; plan: PreflightPlan; memory: MemoryBundle; skills: SkillBundle; snapshot: PreflightProjectSnapshot; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<{ blueprint: ExecutionBlueprint; context: ContextManifest; routingSnapshot: ModelRoutingSnapshot }> => {
      if (input.planningContext && (input.plan.taskClass === "drafting" || input.plan.taskClass === "revision")) {
        validateChapterExecutionContract(input.planningContext.chapter);
      }
      const context = buildContextManifest(input.plan, input.memory, { retrievalRunId: `retrieval:${input.plan.id}` });
      const blueprint = compileExecutionBlueprint(input.intent, input.plan, input.memory, input.skills, input.snapshot, context, input.foundationArtifacts, input.planningContext);
      await deps.repository.putCognition(input.plan, input.memory, input.skills, blueprint, context);
      if (input.planningContext && input.intent.target?.id) await deps.repository.putChapterPlanningContext(blueprint.id, input.intent.target.id, input.planningContext);
      return { blueprint, context, routingSnapshot: model.getRoutingSnapshot() };
    },
    enforceMemoryCoverage: async (input: { projectId: string; workflowId: string; taskClass: PreflightPlan["taskClass"]; criticalMissingFacets: string[] }) => {
      if (input.taskClass !== "drafting" && input.taskClass !== "revision") return { consecutiveCriticalMisses: 0, blocked: false };
      return deps.repository.recordMemoryGateCheck({ projectId: input.projectId, workflowId: input.workflowId, criticalMissingFacets: input.criticalMissingFacets });
    },
    /**
     * 加载项目下所有 foundation artifacts(全书规划产出)。
     *
     * 设计依据:AGENTS.md「root-cause analysis」——v2 重构后 foundation artifacts 未被章节生成
     * 消费,导致章节生成不基于全书规划。此 activity 是 novelIntentWorkflow 加载规划产出的入口,
     * 供前置检查(必填 taskKey 清单)与 compileBlueprint/draft 注入使用。
     */
    listFoundationArtifacts: async (input: { projectId: string }) => {
      const current = await deps.repository.listCurrentFoundationArtifacts(input.projectId);
      return current.length ? current : deps.repository.listFoundationArtifacts(input.projectId);
    },
    assertRequiredPlanApproved: (input: { projectId: string }) => deps.repository.assertRequiredPlanApproved(input.projectId),
    assertChapterGenerationAllowed: (input: { projectId: string; documentId: string }) => deps.repository.assertChapterGenerationAllowed(input.projectId, input.documentId),
    loadChapterPlanningContext: (input: { projectId: string; documentId: string }) => deps.repository.getChapterPlanningContext(input.projectId, input.documentId),
    loadChapterPlanningContextSnapshot: (input: { blueprintId: string }) => deps.repository.getChapterPlanningContextSnapshot(input.blueprintId),
    draft: async (input: { workflowId: string; intent: NovelIntent; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; foundationArtifacts?: Artifact[]; planningContext?: ChapterPlanningContext }): Promise<GeneratedTextResult> => {
      const skills = await resolveCurrentSkills({ projectId: input.intent.projectId, executionPoint: "chapter.drafting", role: "writer", memory: input.memory, preflightId: input.blueprint.preflightId });
      const system = "你是长篇小说写作 Worker。只写当前章节正文，不解释流程；只使用当前环境解析出的 Skill 和冻结 MemoryBundle 中的事实；严格尊重叙事截止、视角知识边界、章节功能、文风目标和质量门。";
      const promptPackage = buildChapterDraftPromptPackage({ ...input, skills, system });
      const prompt = promptPackage.instruction;
      try {
        const generated = await model.generateText({
            purpose: "writing.draft",
            system,
            prompt,
            maxTokens: input.blueprint.budget.maxOutputTokens,
            workflowRunId: input.workflowId,
            taskId: `${input.blueprint.id}:draft`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            promptContext: promptPackage.manifest,
          });
        return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.blueprint.id}:draft`, kind: "draft", baseRevision: input.blueprint.baseRevision, text: generated.text, structuredData: { modelProvenance: generated.provenance, workflowId: input.workflowId } }), text: generated.text };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.blueprint.id}:draft`, purpose: "writing.draft", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "text", system, instruction: prompt, baseRevision: input.blueprint.baseRevision, contextRefs: { blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: skills.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    review: async (input: { workflowId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; memory: MemoryBundle; skills: SkillBundle; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; planningContext?: ChapterPlanningContext; suppressChapterSnapshotPromotion?: boolean; stageGoal?: StageGoalContract }): Promise<GeneratedReviewResult> => {
      const roleMemory = selectReviewerMemory(input.memory, input.role);
      const roleExecutionPoint = reviewExecutionPoint(input.role);
      const currentSkills = await resolveCurrentSkills({ projectId: input.artifact.projectId, executionPoint: roleExecutionPoint, role: input.role, memory: input.memory, preflightId: input.blueprint.preflightId });
      const roleSkills = selectReviewerSkills(currentSkills, input.role) ?? currentSkills;
      const embeddedGoal = input.artifact.structuredData?.stageGoal as StageGoalContract | undefined;
      const stageGoal = input.stageGoal ?? embeddedGoal;
      // P1-2: system prompt 注入完整 reviewer 职责（默认 + 题材/项目特化补充）。
      // 设计依据：AGENTS.md「reusable contracts over case-specific rules」——原 system 极简
      // (`你是${identity}审核 Worker(${role})。`)，职责定义只在 user prompt 中，导致 system/user
      // 角色割裂；且职责硬编码无法题材特化。现改为：system 承载完整角色定义（含 craft rule
      // 沉淀的题材特化补充），user 只保留维度边界与正文数据。
      const reviewFocus = getReviewFocus(input.role);
      const system = `你是${input.identity === "independent" ? "独立" : "内置"}审核 Worker（${input.role}）。\n\n## 审核职责\n${reviewFocus}`;
      const promptPackage = buildChapterReviewPromptPackage({ workflowId: input.workflowId, system, role: input.role, artifact: input.artifact, text: input.text, blueprint: input.blueprint, memory: roleMemory, skills: roleSkills, planningContext: input.planningContext, stageGoal });
      const prompt = promptPackage.instruction;
      const roleSchema = promptPackage.schema!;
      try {
        const generated = await model.generateStructured<ReviewerOutput>({
            purpose: reviewerPurpose(input.role),
            system,
            prompt,
            schema: roleSchema,
            schemaName: `reviewer:${input.role}`,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:review:${input.role}`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            promptContext: promptPackage.manifest,
          });
        const review = {
          ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: generated.value }),
          modelProvenance: {
            ...generated.provenance,
            skillBundleId: roleSkills.id,
            skillBundleFingerprint: roleSkills.fingerprint,
            contextManifestId: promptPackage.manifest.id,
          },
        };
        await deps.repository.putReview(review, { refreshChapterSnapshot: !input.suppressChapterSnapshotPromotion, plainText: input.text });
        return { kind: "completed", review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:review:${input.role}`, purpose: reviewerPurpose(input.role), candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "review", system, instruction: prompt, schema: roleSchema, schemaName: `reviewer:${input.role}`, baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: roleMemory.id, skillBundleId: roleSkills.id, skillBundleFingerprint: roleSkills.fingerprint, contextManifestId: promptPackage.manifest.id, goalId: stageGoal?.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    inspectManuscript: async (input: { projectId: string; artifact: Artifact; text: string }) => {
      const stopReason = typeof input.artifact.structuredData?.stopReason === "string" ? input.artifact.structuredData.stopReason : undefined;
      const report = inspectManuscript({ text: input.text, stopReason });
      const review = structuralReviewFromReport(input.projectId, input.artifact, report);
      await deps.repository.putReview(review, { refreshChapterSnapshot: false });
      return { report, review };
    },
    revise: async (input: { workflowId: string; intent: NovelIntent; artifact: Artifact; text: string; reviews: Review[]; directedIssues?: ReviewIssue[]; strictRevisionWindows?: boolean; authorInstruction?: string; memory: MemoryBundle; blueprint: ExecutionBlueprint; skills: SkillBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; planningContext?: ChapterPlanningContext; revisionHistory?: RevisionAttempt[] }): Promise<GeneratedTextResult> => {
      const currentSkills = await resolveCurrentSkills({ projectId: input.intent.projectId, executionPoint: "chapter.revision", role: "reviser", memory: input.memory, preflightId: input.blueprint.preflightId });
      input = { ...input, skills: currentSkills };
      const revisionEvidence = classifyRevisionEvidence(input.reviews);
      const revisionBrief = buildRevisionBrief(input.reviews, input.directedIssues, {
        includeWarnings: revisionEvidence === "quality-warning",
        includeDirectedReviewEvidence: Boolean(input.directedIssues?.length),
      });
      const hasAuthorInstruction = Boolean(input.authorInstruction?.trim());
      // 根因修复（2026-08-07）：修订阶段需要同时加载正文、记忆、规划上下文与审核意见，
      // 旧 blueprint 的 maxInputTokens（早期章节 32K）不足，实测必要上下文约 35K 触发
      // context-budget-exceeded（chapter-review 复用已固化 blueprint，computeTokenBudget
      // 的新值不会追溯生效）。此处统一提升到至少 96K（模型上下文支持 128K），
      // 新 blueprint 的预算若更大则取其值。
      // TODO: 96K 下限是魔法值，应迁入 model-routing profile 的 revisionMinInputTokens 配置；
      //   该下限使 computeTokenBudget 对 revision 的分级在 <96K 区间失效（只对 drafting 生效）。
      const revisionMaxInputTokens = Math.max(input.blueprint.budget.maxInputTokens, 96_000);
      if (shouldBlockRevisionForConflicts(revisionBrief.conflicts, hasAuthorInstruction)) {
        throw new Error(`revision-brief-conflict: ${revisionBrief.conflicts.map((conflict) => conflict.mechanism).join("、")}`);
      }
      const actionableIssues = revisionBrief.issues;
      const stageGoal = actionableIssues.length || hasAuthorInstruction ? createStageGoalContract({
        projectId: input.intent.projectId,
        workflowId: input.workflowId,
        stage: "revision",
        targetArtifactId: input.artifact.id,
        authorInstruction: input.authorInstruction,
        reviewIssueFingerprints: actionableIssues.map(reviewIssueFingerprint),
        acceptanceCriteria: [
          ...(hasAuthorInstruction ? ["修订后的实际阅读效果明确响应作者原始要求"] : []),
          ...actionableIssues.map((issue) => issue.title),
          "未被目标触及的有效事实、人物关系与章节功能保持连续",
        ],
        allowedChangeScope: input.strictRevisionWindows ? "local" : "chapter",
      }) : undefined;
      const system = hasAuthorInstruction
        ? "你是长篇小说定向修订编辑。作者原话是本轮任务目标，审核问题是辅助证据，技能是仅在不冲突时使用的背景方法；不得用完成审校问题代替完成作者目标。先理解它们的关系，再让修改结果在正文中明确可见，同时保持冻结事实、章节规划与既定因果。"
        : "你是长篇小说修订编辑。依据审核证据修订正文，保持原作的文风、节奏与叙事质感。修订应聚焦于解决审核指出的问题，同时保持原文已有的文学品质——不因修订而降低文笔质量或丢失原文的有效细节。不得新增冻结上下文之外的事实。";
      const fullRevisionPackage = buildFullChapterRevisionPromptPackage({
        projectId: input.intent.projectId,
        workflowId: input.workflowId,
        system,
        goal: stageGoal,
        sourceArtifactId: input.artifact.id,
        maxInputTokens: revisionMaxInputTokens,
        maxOutputTokens: input.blueprint.budget.maxOutputTokens,
        text: input.text,
        issues: actionableIssues,
        memory: input.memory,
        skills: input.skills,
        planningContext: input.planningContext,
        authorInstruction: input.authorInstruction,
        revisionHistory: input.revisionHistory,
      });
      try {
        const windows = planRevisionWindows(input.text, actionableIssues);
        // 审核范围来自旧正文时可能失效；窗口规划器会按当前段落、摘录和证据回定位。
        // 只有所有 actionable issue 都能安全落到当前正文，才允许严格局部修订。
        const windowsCoverAllIssues = revisionWindowsCoverAllIssues(windows, actionableIssues);
        const strictRevisionWindows = Boolean(input.strictRevisionWindows && windows.length && windowsCoverAllIssues);
        if (input.strictRevisionWindows && !windowsCoverAllIssues && !hasAuthorInstruction) throw new Error("目标意见无法解析出安全修订窗口");
        const requiresFullRevision = !strictRevisionWindows && !windowsCoverAllIssues;
        const useRevisionWindows = shouldUseRevisionWindows({ requiresFullRevision, authorInstruction: input.authorInstruction });
        const paragraphs = splitChapterParagraphs(input.text);
        const replacements: Array<{ window: (typeof windows)[number]; text: string }> = [];
        const modelProvenance: ModelExecutionProvenance[] = [];
        const revisionWindows = useRevisionWindows ? windows : [];
        if (revisionWindows.length > 1) {
          const targetSourceCharacters = revisionWindows.reduce((total, window) => total + paragraphs.slice(window.start, window.end + 1).join("\n\n").length, 0);
          const batchMaxTokens = Math.min(input.blueprint.budget.maxOutputTokens, Math.max(4_096, targetSourceCharacters * 2));
          try {
            const targetedRevisionPackage = buildTargetedRevisionBatchPromptPackage({
              projectId: input.intent.projectId,
              workflowId: input.workflowId,
              system,
              goal: stageGoal,
              maxInputTokens: revisionMaxInputTokens,
              maxOutputTokens: batchMaxTokens,
              text: input.text,
              windows: revisionWindows,
              memory: input.memory,
              skills: input.skills,
              planningContext: input.planningContext,
              authorInstruction: input.authorInstruction,
              revisionHistory: input.revisionHistory,
            });
            const generated = await model.generateStructured<TargetedRevisionBatchOutput>({
              purpose: "writing.revision",
              system,
              prompt: targetedRevisionPackage.instruction,
              schema: targetedRevisionBatchSchema as unknown as Record<string, unknown>,
              schemaName: "targeted-chapter-revision",
              maxTokens: batchMaxTokens,
              temperature: 0.25,
              workflowRunId: input.workflowId,
              taskId: `${input.artifact.taskId}:revise:targeted-batch`,
              routingSnapshot: input.routingSnapshot,
              candidateStartIndex: input.candidateStartIndex,
              promptContext: targetedRevisionPackage.manifest,
            });
            const revisedText = applyTargetedRevisionReplacements(input.text, revisionWindows, generated.value.replacements);
            return {
              kind: "completed",
              artifact: await makeArtifact({
                projectId: input.intent.projectId,
                taskId: `${input.artifact.taskId}:revise`,
                kind: "revision",
                baseRevision: input.artifact.baseRevision,
                text: revisedText,
                structuredData: {
                  modelProvenance: [generated.provenance],
                  revisionMode: "targeted-batch",
                  revisionWindows: revisionWindows.map((window) => ({ start: window.start + 1, end: window.end + 1, issueCount: window.issues.length })),
                  stageGoal,
                  workflowId: input.workflowId,
                },
              }),
              text: revisedText,
            };
          } catch (error) {
            // A batch that cannot fit the existing input budget falls back to
            // the previous per-window path, which keeps the quality boundary
            // for long chapters without making the common case more expensive.
            if (!(error instanceof StageContextBudgetError) && !(error instanceof TargetedRevisionContractError)) throw error;
          }
        }
        for (const window of revisionWindows) {
          const source = paragraphs.slice(window.start, window.end + 1).join("\n\n");
          const windowPackage = buildRevisionWindowPromptPackage({ projectId: input.intent.projectId, workflowId: input.workflowId, system, goal: stageGoal, maxInputTokens: revisionMaxInputTokens, maxOutputTokens: Math.min(4096, Math.max(1024, source.length * 2)), text: input.text, window, memory: input.memory, skills: input.skills, planningContext: input.planningContext, authorInstruction: input.authorInstruction, revisionHistory: input.revisionHistory });
          const generated = await model.generateText({
            purpose: "writing.revision",
            system,
            prompt: windowPackage.instruction,
            maxTokens: Math.min(4096, Math.max(1024, source.length * 2)),
            temperature: 0.25,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:revise:${window.start + 1}-${window.end + 1}`,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            promptContext: windowPackage.manifest,
          });
          if (generated.text.trim() && generated.text.trim() !== source.trim()) {
            replacements.push({ window, text: sanitizeRevisionOutput(generated.text) });
            modelProvenance.push(generated.provenance);
          }
        }
        if (strictRevisionWindows && replacements.length !== windows.length) throw new Error("AI 未实际修改全部目标段落");
        if (replacements.length) {
          const revisedText = applyRevisionWindows(input.text, replacements);
          return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { modelProvenance, revisionWindows: replacements.map(({ window }) => ({ start: window.start + 1, end: window.end + 1, issueCount: window.issues.length })), stageGoal, workflowId: input.workflowId } }), text: revisedText };
        }
        if (strictRevisionWindows) throw new Error("AI 未实际修改任何目标段落");
        const generated = await model.generateText({ purpose: "writing.revision", system, prompt: fullRevisionPackage.instruction, maxTokens: input.blueprint.budget.maxOutputTokens, temperature: REVISION_TEMPERATURE, workflowRunId: input.workflowId, taskId: `${input.artifact.taskId}:revise:full`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, promptContext: fullRevisionPackage.manifest });
        let revisedText = sanitizeRevisionOutput(generated.text);
        const fullRevisionProvenance: ModelExecutionProvenance[] = [generated.provenance];
        let authorAlignment: AuthorRevisionAlignment | undefined;
        const authorAlignmentHistory: AuthorRevisionAlignment[] = [];
        let authorAlignmentRepairApplied = false;
        if (hasAuthorInstruction) {
          try {
            const alignmentSystem = "你是独立的作者修改要求对齐检查员。只根据作者要求与修订前后文本的可核对差异判断，不替修订模型找借口。";
            const buildAlignmentPackage = (candidate: string) => compileStageContext({
              projectId: input.intent.projectId,
              workflowId: input.workflowId,
              purpose: "review.prose",
              stage: "review",
              system: alignmentSystem,
              goal: stageGoal,
              schema: authorRevisionAlignmentSchema as unknown as Record<string, unknown>,
              maxInputTokens: revisionMaxInputTokens,
              reservedOutputTokens: 2_048,
              skillManifest: input.skills.resolution,
              sections: [
                { id: "alignment-rubric", kind: "review", title: "语义验收规则", text: "判断候选正文是否实质响应作者本轮修改要求。需要结合修订前后的实际阅读效果，不做关键词匹配；若未满足，指出未满足目标与可核对证据。", priority: "required", provenanceRefs: [stageGoal?.id ?? input.artifact.id] },
                { id: "author-goal", kind: "goal", title: "作者原始修改要求", text: input.authorInstruction!, priority: "critical", provenanceRefs: [stageGoal?.id ?? input.artifact.id] },
                { id: "original-manuscript", kind: "manuscript", title: "修订前正文", text: input.text, priority: "required", provenanceRefs: [input.artifact.id], sourceArtifactId: input.artifact.id },
                { id: "candidate-manuscript", kind: "manuscript", title: "候选正文", text: candidate, priority: "critical", provenanceRefs: [input.artifact.id] },
                ...buildSkillContextSections(input.skills, "chapter.revision", "修订 Skill"),
              ],
            });
            const alignmentPackage = buildAlignmentPackage(revisedText);
            const alignment = await model.generateStructured<AuthorRevisionAlignment>({
              purpose: "review.prose",
              system: alignmentSystem,
              prompt: alignmentPackage.instruction,
              schema: authorRevisionAlignmentSchema as unknown as Record<string, unknown>,
              schemaName: "author-revision-alignment",
              maxTokens: 2048,
              temperature: 0.1,
              workflowRunId: input.workflowId,
              taskId: `${input.artifact.taskId}:revise:author-alignment`,
              routingSnapshot: input.routingSnapshot,
              promptContext: alignmentPackage.manifest,
            });
            authorAlignment = alignment.value;
            authorAlignmentHistory.push(alignment.value);
            fullRevisionProvenance.push(alignment.provenance);
            if (!alignment.value.satisfied) {
              const repairPackage = buildAuthorRevisionRepairPromptPackage({
                projectId: input.intent.projectId,
                workflowId: input.workflowId,
                system,
                goal: stageGoal,
                sourceArtifactId: input.artifact.id,
                maxInputTokens: revisionMaxInputTokens,
                maxOutputTokens: input.blueprint.budget.maxOutputTokens,
                original: input.text,
                candidate: revisedText,
                authorInstruction: input.authorInstruction!,
                alignment: alignment.value,
                memory: input.memory,
                skills: input.skills,
                planningContext: input.planningContext,
              });
              const repaired = await model.generateText({
                purpose: "writing.revision",
                system,
                prompt: repairPackage.instruction,
                maxTokens: input.blueprint.budget.maxOutputTokens,
                temperature: REVISION_TEMPERATURE,
                workflowRunId: input.workflowId,
                taskId: `${input.artifact.taskId}:revise:author-repair`,
                routingSnapshot: input.routingSnapshot,
                candidateStartIndex: input.candidateStartIndex,
                promptContext: repairPackage.manifest,
              });
              revisedText = sanitizeRevisionOutput(repaired.text);
              fullRevisionProvenance.push(repaired.provenance);
              authorAlignmentRepairApplied = true;
              const repairedAlignmentPackage = buildAlignmentPackage(revisedText);
              const repairedAlignment = await model.generateStructured<AuthorRevisionAlignment>({
                purpose: "review.prose",
                system: alignmentSystem,
                prompt: repairedAlignmentPackage.instruction,
                schema: authorRevisionAlignmentSchema as unknown as Record<string, unknown>,
                schemaName: "author-revision-alignment",
                maxTokens: 2048,
                temperature: 0.1,
                workflowRunId: input.workflowId,
                taskId: `${input.artifact.taskId}:revise:author-alignment-after-repair`,
                routingSnapshot: input.routingSnapshot,
                promptContext: repairedAlignmentPackage.manifest,
              });
              authorAlignment = repairedAlignment.value;
              authorAlignmentHistory.push(repairedAlignment.value);
              fullRevisionProvenance.push(repairedAlignment.provenance);
            }
          } catch (error) {
            if (!(error instanceof ExternalMcpRequiredError)) throw error;
            const unresolvedAlignment: AuthorRevisionAlignment = authorAlignment ?? {
              satisfied: false,
              summary: "需要外部执行器独立核对作者目标，并在未满足时继续修订。",
              unmetRequirements: [input.authorInstruction!],
              evidence: ["API 执行器无法完成作者目标语义验收，禁止跳过该门禁。"],
            };
            const externalGoalPackage = buildAuthorRevisionRepairPromptPackage({
              projectId: input.intent.projectId,
              workflowId: input.workflowId,
              system,
              goal: stageGoal,
              sourceArtifactId: input.artifact.id,
              maxInputTokens: revisionMaxInputTokens,
              maxOutputTokens: input.blueprint.budget.maxOutputTokens,
              original: input.text,
              candidate: revisedText,
              authorInstruction: input.authorInstruction!,
              alignment: unresolvedAlignment,
              memory: input.memory,
              skills: input.skills,
              planningContext: input.planningContext,
            });
            const task = await externalTask({
              workflowId: input.workflowId,
              taskId: `${input.artifact.taskId}:revise:author-goal-external`,
              purpose: error.purpose,
              candidateIndex: error.candidateIndex,
              routingSnapshot: input.routingSnapshot,
              outputKind: "text",
              system,
              instruction: externalGoalPackage.instruction,
              baseRevision: input.artifact.baseRevision,
              contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id, goalId: stageGoal?.id, goalContract: stageGoal ? JSON.stringify(stageGoal) : "", externalContinuation: "author-goal-alignment" },
              promptContext: externalGoalPackage.manifest,
            });
            return { kind: "external", task };
          }
        }
        return { kind: "completed", artifact: await makeArtifact({ projectId: input.intent.projectId, taskId: `${input.artifact.taskId}:revise`, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { modelProvenance: fullRevisionProvenance, revisionMode: "full-fallback", authorAlignment, authorAlignmentHistory, authorAlignmentRepairApplied, stageGoal, workflowId: input.workflowId } }), text: revisedText };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const windows = planRevisionWindows(input.text, actionableIssues);
        const windowsCoverAllIssues = revisionWindowsCoverAllIssues(windows, actionableIssues);
        const strictRevisionWindows = Boolean(input.strictRevisionWindows && windows.length && windowsCoverAllIssues);
        if (input.strictRevisionWindows && !windowsCoverAllIssues && !hasAuthorInstruction) throw new Error("目标意见无法解析出安全修订窗口");
        const useTargetedExternal = strictRevisionWindows && shouldUseRevisionWindows({ requiresFullRevision: false, authorInstruction: input.authorInstruction });
        const targetedRevisionPackage = useTargetedExternal ? buildTargetedRevisionBatchPromptPackage({
          projectId: input.intent.projectId,
          workflowId: input.workflowId,
          system,
          goal: stageGoal,
          maxInputTokens: revisionMaxInputTokens,
          maxOutputTokens: input.blueprint.budget.maxOutputTokens,
          text: input.text,
          windows,
          memory: input.memory,
          skills: input.skills,
          planningContext: input.planningContext,
          authorInstruction: input.authorInstruction,
        }) : undefined;
        const task = targetedRevisionPackage
          ? await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:revise:targeted`, purpose: "writing.revision", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: targetedRevisionPackage.instruction, schema: targetedRevisionBatchSchema as unknown as Record<string, unknown>, schemaName: "targeted-chapter-revision", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id, goalContract: stageGoal ? JSON.stringify(stageGoal) : "" }, promptContext: targetedRevisionPackage.manifest })
          : await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:revise`, purpose: "writing.revision", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "text", system, instruction: fullRevisionPackage.instruction, baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, blueprintId: input.blueprint.id, memoryBundleId: input.memory.id, skillBundleId: input.skills.id, goalId: stageGoal?.id, goalContract: stageGoal ? JSON.stringify(stageGoal) : "" }, promptContext: fullRevisionPackage.manifest });
        return { kind: "external", task };
      }
    },
    materializeExternalText: async (input: { projectId: string; modelTaskId: string; text: string; kind: "draft" | "revision"; baseRevision: number }): Promise<{ artifact: Artifact; text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted" || task.result?.text !== input.text) throw new Error("外部文本任务尚未通过 Runtime 验证");
      const stageGoal = task.workPackage.contextRefs.goalContract ? JSON.parse(task.workPackage.contextRefs.goalContract) as StageGoalContract : undefined;
      const cleanedText = input.kind === "revision" ? sanitizeRevisionOutput(input.text) : input.text;
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: input.kind, baseRevision: input.baseRevision, text: cleanedText, structuredData: { externalModelTaskId: task.id, modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp", model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint }, stageGoal, workflowId: task.workflowRunId } });
      return { artifact, text: cleanedText };
    },
    materializeExternalTargetedRevision: async (input: { projectId: string; modelTaskId: string; artifact: Artifact; text: string; issues: ReviewIssue[] }): Promise<{ artifact: Artifact; text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const value = task?.result?.value as unknown;
      const validate = new Ajv({ allErrors: true, strict: false }).compile(targetedRevisionBatchSchema);
      if (!task || task.status !== "submitted" || !validate(value)) throw new TargetedRevisionContractError(`外部定向修订结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const windows = planRevisionWindows(input.text, input.issues);
      const revisedText = applyTargetedRevisionReplacements(input.text, windows, (value as { replacements: TargetedRevisionReplacement[] }).replacements);
      const stageGoal = task.workPackage.contextRefs.goalContract ? JSON.parse(task.workPackage.contextRefs.goalContract) as StageGoalContract : undefined;
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "revision", baseRevision: input.artifact.baseRevision, text: revisedText, structuredData: { externalModelTaskId: task.id, revisionMode: "targeted-windows", revisionWindows: windows.map((window) => ({ start: window.start + 1, end: window.end + 1, issueCount: window.issues.length })), modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp", model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint }, stageGoal, workflowId: task.workflowRunId } });
      return { artifact, text: revisedText };
    },
    materializeExternalReview: async (input: { modelTaskId: string; artifact: Artifact; identity: "internal" | "independent"; role: ReviewerRole; value: unknown; suppressChapterSnapshotPromotion?: boolean }): Promise<Review> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(reviewerSchema);
      if (!task || task.status !== "submitted" || !validate(input.value)) throw new Error(`外部审核结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const review = { ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: input.value as ReviewerOutput }), modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp" as const, model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint, skillBundleId: task.workPackage.contextRefs.skillBundleId, skillBundleFingerprint: task.workPackage.contextRefs.skillBundleFingerprint, contextManifestId: task.workPackage.contextRefs.contextManifestId } };
      // 与内部审校路径（plainText: input.text）对齐：外部路径从被审 artifact 的
      // objectKey 解析正文，供 evidence 软校验落库时确定性标记；存储不可用时报
      // 级降级为不标记（软标记仅作人工参考，不影响审校落库）。
      let plainText: string | undefined;
      if (input.artifact.objectKey) {
        try { plainText = await objects.getText(input.artifact.objectKey); } catch { plainText = undefined; }
      }
      await deps.repository.putReview(review, { refreshChapterSnapshot: !input.suppressChapterSnapshotPromotion, plainText });
      return review;
    },
    extractFacts: async (input: { workflowId: string; projectId: string; artifact: Artifact; text: string; blueprint: ExecutionBlueprint; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; documentId?: string; narrativeOrder?: number }): Promise<GeneratedArtifactResult> => {
      const factArtifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.artifact.taskId}:facts`, kind: "fact-extraction", baseRevision: input.artifact.baseRevision, text: input.text, structuredData: { sourceArtifactId: input.artifact.id } });
      const currentSkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "chapter.fact-extraction", role: "fact-extractor", preflightId: input.blueprint.preflightId });

      try {
        const extractionContext = await deps.repository.getFactExtractionContext(input.projectId, input.narrativeOrder === undefined ? undefined : input.narrativeOrder - 1);
        const openNarrativeElements = input.narrativeOrder === undefined
          ? undefined
          : await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.narrativeOrder - 1).catch(() => undefined);
        // Phase 3.1: 提取 claims 与正文修订派生数据；派生数据等待 commit 取得真实 revisionId 后落库。
        const result = await extractFactsWithStats({ projectId: input.projectId, artifact: factArtifact, text: input.text, model, existingClaimsDigest: extractionContext.claimsDigest, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex, openNarrativeElements, narrativeOrder: input.narrativeOrder, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, workflowRunId: input.workflowId, taskId: `${input.artifact.taskId}:facts:model`, skillBundle: currentSkills });
        await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: factArtifact, claims: result.claims, lifecycleStatus: "staged", documentId: input.documentId, workflowId: input.workflowId, narrativeOrder: input.narrativeOrder });
        return { kind: "completed", artifact: { ...factArtifact, structuredData: { ...factArtifact.structuredData, narrativeElements: result.narrativeElements } } };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const extractionContext = await deps.repository.getFactExtractionContext(input.projectId, input.narrativeOrder === undefined ? undefined : input.narrativeOrder - 1);
        const openNarrativeElements = input.narrativeOrder === undefined
          ? undefined
          : await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.narrativeOrder - 1).catch(() => undefined);
        const prompt = buildFactExtractionPrompt({ artifact: factArtifact, text: input.text, existingClaimsDigest: extractionContext.claimsDigest, openNarrativeElements });
        const system = "你是事实提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的事实，不提取隐喻、修辞或读者推断。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "facts.extract", stage: "fact-extraction", system, prompt, schema: chapterStateDeltaSchema as unknown as Record<string, unknown>, provenanceRefs: [factArtifact.id], skillBundle: currentSkills, skillExecutionPoint: "chapter.fact-extraction" });
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:facts:model`, purpose: "facts.extract", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: chapterStateDeltaSchema as unknown as Record<string, unknown>, schemaName: "chapter-state-delta", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: factArtifact.id, blueprintId: input.blueprint.id, skillBundleId: currentSkills.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task, artifact: factArtifact };
      }
    },
    materializeExternalFacts: async (input: { modelTaskId: string; projectId: string; artifact: Artifact; text: string; documentId?: string; narrativeOrder?: number }): Promise<Artifact> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(chapterStateDeltaSchema);
      if (!task || task.status !== "submitted" || !validate(task.result?.value)) throw new Error(`外部事实提取结果无效：${validate.errors?.map((item) => item.message).join("；") ?? "任务未提交"}`);
      const extractionContext = await deps.repository.getFactExtractionContext(input.projectId, input.narrativeOrder === undefined ? undefined : input.narrativeOrder - 1);
      const projected = projectFactExtractionOutput({ projectId: input.projectId, artifact: input.artifact, text: input.text, existingClaimsDigest: extractionContext.claimsDigest, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex, narrativeOrder: input.narrativeOrder }, task.result!.value as ChapterStateDelta);
      await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: input.artifact, claims: projected.claims, lifecycleStatus: "staged", documentId: input.documentId, workflowId: task.workflowRunId, narrativeOrder: input.narrativeOrder });
      return { ...input.artifact, structuredData: { ...input.artifact.structuredData, narrativeElements: projected.narrativeElements } };
    },
    approveFacts: (input: { workflowId: string; projectId: string; artifact: Artifact }) =>
      deps.repository.recordFactApprovalPolicy({ workflowId: input.workflowId, projectId: input.projectId, artifactId: input.artifact.id }),
    assessLearning: async (input: { projectId: string; workflowId: string; assessmentKey: string; artifact: Artifact; reviews: Review[]; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; documentId?: string }): Promise<GeneratedLearningResult> => {
      const learningSkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "learning.assessment", role: "learning-auditor" });
      const availableSkills = learningSkills.availableSkills ?? learningSkills.skills.map((skill) => ({ skillId: skill.skillId, capabilities: skill.capabilities ?? [], executionPoints: skill.executionPoints }));
      // L3: 跨章序列证据 + 近 N 章 issue 聚类（持续模式信号）。按目标章前一章计算 cutoff，
      // 只让 learning 看到进入本章前的跨章模式，避免当前章自身的重复污染判定。
      // documentId 由调用方透传（novelIntentWorkflow 的 intent.target.id / chapterReviewWorkflow 的 params.documentId）。
      // 修复依据：artifact.taskId 是 "blueprint:<intent-uuid>:draft"，与 chapters.document_id 永不匹配，
      // 用它查询必然返回 0 行导致 serialContext 恒为 undefined；documentId 缺失时不发起查询，
      // 避免无意义查询与误导性空结果。
      const serialContext = typeof input.narrativeOrder === "number" && input.documentId
        ? await loadSerialContext(input.projectId, input.documentId, input.narrativeOrder - 1)
        : undefined;
      const recentIssueClusters = typeof input.narrativeOrder === "number"
        ? await deps.repository.getRecentReviewIssueClusters(input.projectId, input.narrativeOrder - 1)
        : undefined;
      // 获取当前章正文用于标注 issue evidence 是否在正文出现（降权审校模型回显误报）。
      // artifact.objectKey 存储了 commit 后的正文对象键；未配置 objectStore 或无 objectKey
      // 时跳过标注（learning 通路仍正常工作，只是不做 evidence-unverified 降权）。
      const plainText = input.artifact.objectKey
        ? await objects.getText(input.artifact.objectKey).catch(() => undefined)
        : undefined;
      const learningEvidence = { serialContext, recentIssueClusters, plainText };
      try {
        const { assessment, validationError } = await assessRuntimeLearningWithModel({ ...input, ...learningEvidence, model, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, availableSkills, skillBundle: learningSkills });
        const recorded = validationError ? { ...assessment, validationError } : assessment;
        return { kind: "completed", assessment: await recordLearning(recorded) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const learningIssues = reviewIssuesForLearning(input.reviews, plainText);
        if (!learningIssues.length) throw error;
        const system = "你是长篇小说 Runtime 的学习闭环审计员，只在能说明底层机制和影响输入类时提出可复用规则改进。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "learning.assess", stage: "review", system, prompt: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: input.reviews, availableSkills, ...learningEvidence }), schema: runtimeLearningAssessmentSchema, reservedOutputTokens: 4_096, provenanceRefs: [input.artifact.id, ...input.reviews.map((review) => review.id)], skillBundle: learningSkills, skillExecutionPoint: "learning.assessment" });
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:learning:${input.assessmentKey}`, purpose: "learning.assess", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: runtimeLearningAssessmentSchema, schemaName: "runtime-learning-assessment", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, reviewIds: input.reviews.map((review) => review.id).join(",") }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    materializeExternalLearning: async (input: { modelTaskId: string; projectId: string; workflowId: string; artifact: Artifact; reviews: Review[] }): Promise<RuntimeLearningAssessmentV2> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted") throw new Error("外部 learning 任务尚未提交");
      const assessment = parseRuntimeLearningAssessmentV2(task.result?.value, { id: `learning:${input.artifact.id}`, projectId: input.projectId, source: { workflowId: input.workflowId, artifactId: input.artifact.id, reviewIds: input.reviews.map((review) => review.id), fingerprint: input.artifact.fingerprint }, createdAt: Date.now() });
      return recordLearning(assessment);
    },
    assessStoryArcLearning: async (input: { projectId: string; workflowId: string; artifact: Artifact; reviewArtifact: Artifact; review: StoryArcReviewOutput; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<GeneratedLearningResult> => {
      const issues: ReviewIssue[] = input.review.verdict === "revise"
        ? [opinionToReviewIssue(input.review.opinion, input.reviewArtifact.fingerprint)]
        : [];
      const review: Review = {
        id: createHash("sha256").update(`${input.reviewArtifact.id}:story-arc-learning`).digest("hex"),
        projectId: input.projectId,
        artifactId: input.artifact.id,
        reviewerId: "story-arc-reviewer",
        identity: "independent",
        verdict: input.review.verdict,
        issues,
        role: "structure-reviewer",
        createdAt: Date.now(),
        artifactFingerprint: input.artifact.fingerprint,
      };
      const learningSkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "learning.assessment", role: "learning-auditor" });
      const availableSkills = learningSkills.availableSkills ?? learningSkills.skills.map((skill) => ({ skillId: skill.skillId, capabilities: skill.capabilities ?? [], executionPoints: skill.executionPoints }));
      try {
        const { assessment, validationError } = await assessRuntimeLearningWithModel({ projectId: input.projectId, workflowId: input.workflowId, artifact: input.artifact, reviews: [review], model, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, availableSkills, skillBundle: learningSkills });
        return { kind: "completed", assessment: await recordLearning(validationError ? { ...assessment, validationError } : assessment) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const learningIssues = reviewIssuesForLearning([review]);
        if (!learningIssues.length) throw error;
        const system = "你是长篇小说 Runtime 的学习闭环审计员，只在能说明底层机制和影响输入类时提出可复用规则改进。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "learning.assess", stage: "review", system, prompt: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: [review], availableSkills }), schema: runtimeLearningAssessmentSchema, reservedOutputTokens: 4_096, provenanceRefs: [input.artifact.id, input.reviewArtifact.id], skillBundle: learningSkills, skillExecutionPoint: "learning.assessment" });
        const task = await externalTask({ workflowId: input.workflowId, taskId: `${input.artifact.taskId}:learning:story-arc:${input.reviewArtifact.id}`, purpose: "learning.assess", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: runtimeLearningAssessmentSchema, schemaName: "runtime-learning-assessment", baseRevision: input.artifact.baseRevision, contextRefs: { artifactId: input.artifact.id, reviewIds: review.id }, promptContext: promptPackage.manifest });
        return { kind: "external", task };
      }
    },
    materializeExternalStoryArcLearning: async (input: { modelTaskId: string; projectId: string; workflowId: string; artifact: Artifact; reviewArtifact: Artifact; review: StoryArcReviewOutput; value: unknown }): Promise<RuntimeLearningAssessmentV2> => {
      const hasOpinion = input.review.verdict === "revise" && Boolean(input.review.opinion.trim());
      const reviewId = createHash("sha256").update(`${input.reviewArtifact.id}:story-arc-learning`).digest("hex");
      const assessment = parseRuntimeLearningAssessmentV2(input.value, { id: `learning:${input.reviewArtifact.id}:story-arc`, projectId: input.projectId, source: { workflowId: input.workflowId, artifactId: input.artifact.id, reviewIds: [reviewId], fingerprint: input.artifact.fingerprint }, createdAt: Date.now() });
      return recordLearning({ ...assessment, source: { ...assessment.source, reviewIds: hasOpinion ? [reviewId] : [] } });
    },
    commit: async (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; structuralReport: ManuscriptStructuralReport; baseRevision: number; idempotencyKey: string }) => {
      const chapterMemorySkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "chapter.fact-extraction", role: "fact-extractor", preflightId: input.artifact.taskId });
      return commitService.commit({ ...input, chapterMemorySkills, factArtifactId: input.factArtifact?.id, narrativeElements: input.factArtifact?.structuredData?.narrativeElements as FactExtractionOutput["narrativeElements"] | undefined });
    },
    loadApprovalEvidence: async (input: { workflowId: string; approvalEvidenceId: string }) => {
      const evidence = await deps.repository.getApprovalEvidence(input.workflowId, input.approvalEvidenceId);
      if (!evidence) throw new Error("批准证据不存在或不属于当前工作流");
      return evidence;
    },
    commitAuthorApproved: async (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; structuralReport: ManuscriptStructuralReport; baseRevision: number; idempotencyKey: string; approvalEvidenceId: string }) => {
      const chapterMemorySkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "chapter.fact-extraction", role: "fact-extractor", preflightId: input.artifact.taskId });
      return commitService.commitAuthorApproved({ ...input, chapterMemorySkills, factArtifactId: input.factArtifact?.id, narrativeElements: input.factArtifact?.structuredData?.narrativeElements as FactExtractionOutput["narrativeElements"] | undefined });
    },
    /** P0 #1: 人工事实审批门通过后，批量批准 pending 事实候选（candidate → approved）。
     *  内部同时写回 Qdrant 向量索引，与 recordFactExtraction 模式一致；
     *  Qdrant 失败不阻塞（PostgreSQL 真源已保留），只警告。 */
    approveFactClaims: async (input: { projectId: string; ids: string[] }): Promise<MemoryClaim[]> => {
      const approved = await deps.repository.approveFactClaims(input);
      const active = approved.filter((claim) => claim.lifecycleStatus !== "staged");
      if (active.length && deps.memoryIndex) {
        try {
          await deps.memoryIndex.upsertClaims(input.projectId, active);
        } catch (error) {
          console.warn(`[fact-approval] Qdrant 索引失败（PostgreSQL 真源已保留）：${(error as Error).message}`);
        }
      }
      return approved;
    },

    /**
     * 角色富化（character enrichment）activity。
     *
     * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
     * 在 commit 之后执行，从定稿章节提取角色声部/动机/知识/关系增量并回写角色档案。
     * 失败不阻塞 commit（revision 已落库），只抛错让 workflow 决定是否记录 learning。
     *
     * 支持 internal LLM 与 external-mcp 双路径（同其他生成类 activity）。
     */
    enrichCharacters: async (input: { workflowId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; factArtifact?: Artifact; text: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number }): Promise<{ kind: "completed"; result: { entityUpdates: number; knowledgeClaims: number; relationRecords: number } } | { kind: "external"; task: ModelTaskRecord }> => {
      let currentSkills: SkillBundle | undefined;
      try {
        currentSkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "character.enrichment", role: "character-enricher" });
        const result = await enrichCharactersFromChapter(
          {
            projectId: input.projectId,
            documentId: input.documentId,
            revisionId: input.revisionId,
            narrativeOrder: input.narrativeOrder,
            text: input.text,
            artifact: input.artifact,
            model,
            routingSnapshot: input.routingSnapshot,
            candidateStartIndex: input.candidateStartIndex,
            workflowRunId: input.workflowId,
            taskId: `${input.artifact.taskId}:enrich-characters`,
            skillBundle: currentSkills,
          },
          { repository: deps.repository, objects, memoryIndex: deps.memoryIndex },
        );
        return { kind: "completed", result: { entityUpdates: result.entityUpdates, knowledgeClaims: result.knowledgeClaims.length, relationRecords: result.relationRecords } };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        // external-mcp 双路径：构造 enrichment prompt + schema，让外部 worker 提取
        const { buildCharacterEnrichmentPrompt } = await import("../character-enrichment/prompt");
        currentSkills ??= await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "character.enrichment", role: "character-enricher" });
        const prompt = buildCharacterEnrichmentPrompt({ artifact: input.artifact, text: input.text });
        const system = "你是角色富化提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的内容，不提取读者推断或作者意图。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "facts.extract", stage: "fact-extraction", system, prompt, schema: characterEnrichmentSchema as unknown as Record<string, unknown>, reservedOutputTokens: 4_096, provenanceRefs: [input.artifact.id, input.revisionId], skillBundle: currentSkills, skillExecutionPoint: "character.enrichment" });
        const task = await externalTask({
          workflowId: input.workflowId,
          taskId: `${input.artifact.taskId}:enrich-characters`,
          purpose: "facts.extract",
          candidateIndex: error.candidateIndex,
          routingSnapshot: input.routingSnapshot,
          outputKind: "structured",
          system,
          instruction: promptPackage.instruction,
          schema: characterEnrichmentSchema as unknown as Record<string, unknown>,
          schemaName: "character-enrichment",
          baseRevision: input.artifact.baseRevision,
          contextRefs: { artifactId: input.artifact.id, documentId: input.documentId, revisionId: input.revisionId, narrativeOrder: String(input.narrativeOrder), skillBundleId: currentSkills.id },
          promptContext: promptPackage.manifest,
        });
        return { kind: "external", task };
      }
    },
    materializeExternalEnrichment: async (input: { modelTaskId: string; projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; text: string }): Promise<{ entityUpdates: number; knowledgeClaims: number; relationRecords: number }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task || task.status !== "submitted") throw new Error("外部角色富化任务尚未提交");
      const output = parseCharacterEnrichmentOutput(task.result?.value);
      const deltas = output.characters.map((character) => ({
        characterId: character.characterId,
        voiceAnchor: character.voiceAnchor,
        motivationDelta: character.motivationDelta,
        newKnowledge: character.newKnowledge,
        relationDeltas: character.relationDeltas,
      }));
      // 复用 persistCharacterEnrichment 回写角色档案，避免重复实现回写逻辑
      const { persistCharacterEnrichment } = await import("../character-enrichment");
      const result = await persistCharacterEnrichment(
        { projectId: input.projectId, documentId: input.documentId, revisionId: input.revisionId, narrativeOrder: input.narrativeOrder, artifact: input.artifact },
        { repository: deps.repository, objects, memoryIndex: deps.memoryIndex },
        deltas,
      );
      return { entityUpdates: result.entityUpdates, knowledgeClaims: result.knowledgeClaims.length, relationRecords: result.relationRecords };
    },

    // ===== 章节审校工作流专用 activities（C-2.4）=====
    // 设计依据：AGENTS.md 章节审校工作流复用契约。
    // 4 个独立 activity，不与 loadProjectSnapshot 合并（单一职责）。

    /**
     * 加载历史 blueprint artifact。
     *
     * 查 artifacts WHERE kind='draft' ORDER BY created_at DESC，取最新 draft 的 taskId
     * 反查 execution_blueprints.payload 获取完整 ExecutionBlueprint。
     *
     * 前置条件：项目必须有历史 draft artifact（即至少生成过一次章节）。
     */
    loadHistoricalBlueprint: async (input: { projectId: string; documentId: string }): Promise<{ blueprint: ExecutionBlueprint; artifactId: string }> => {
      const record = await deps.repository.findHistoricalBlueprintForDocument(input.projectId, input.documentId);
      if (!record) {
        throw new Error(`项目 ${input.projectId} 无历史 draft artifact，无法启动章节审校（需先运行 novelIntentWorkflow 生成章节）`);
      }
      return record;
    },

    /**
     * 加载章节当前定稿正文。
     *
     * 流程：manuscript_documents → manuscript_revisions → content_blobs → objectStore.getText。
     *
     * 前置条件：document.status === "final"（只对已定稿章节开放重审）。
     */
    loadDocumentPlainText: async (input: { projectId: string; documentId: string }): Promise<{ plainText: string; contentHtml: string; wordCount: number; documentRevision: number; sourceRevisionId: string; artifactId?: string; contentHash: string }> => {
      const content = await deps.repository.getFinalDocumentContentRef(input.projectId, input.documentId);
      if (!content) throw new Error(`章节不存在：${input.documentId}`);
      if (content.status !== "final") {
        throw new Error(`章节状态必须为 final（当前为 ${content.status}），只对已定稿章节开放重审`);
      }
      if (!content.objectKey || !content.sourceRevisionId) throw new Error(`章节 ${input.documentId} 无完整定稿 revision/content blob`);
      const plainText = await objects.getText(content.objectKey);

      return {
        plainText,
        contentHtml: "", // TODO P3: contentHtml 暂未存储，commit-service 也只存 plainText
        wordCount: countNovelCharacters(plainText),
        documentRevision: content.revision,
        sourceRevisionId: content.sourceRevisionId,
        artifactId: content.artifactId,
        contentHash: content.contentHash,
      };
    },

    loadTargetedReviewIssues: async (input: { projectId: string; documentId: string; issueIds: string[] }): Promise<{ snapshotId: string; reviewedContentHash: string; fingerprints: string[]; issues: ReviewIssue[] }> => {
      return deps.repository.getTargetedChapterReviewIssues(input);
    },

    loadProposedDraft: async (input: { projectId: string; artifactId: string }): Promise<{ artifact: Artifact; text: string }> => {
      const artifact = await deps.repository.getArtifactById(input.projectId, input.artifactId);
      if (!artifact?.objectKey) throw new Error(`作者修订 proposal 不存在或缺少 objectKey：${input.artifactId}`);
      return { artifact, text: await objects.getText(artifact.objectKey) };
    },

    createReviewDraft: (input: { projectId: string; documentId: string; workflowId: string; sourceRevisionId: string; sourceArtifactId?: string; blueprint: ExecutionBlueprint; text: string; baseRevision: number }): Promise<Artifact> =>
      makeArtifact({
        projectId: input.projectId,
        taskId: `${input.blueprint.id}:review-draft`,
        kind: "draft",
        baseRevision: input.baseRevision,
        text: input.text,
        structuredData: {
          source: "chapter-review",
          sourceRevisionId: input.sourceRevisionId,
          sourceArtifactId: input.sourceArtifactId,
          documentId: input.documentId,
          workflowId: input.workflowId,
          historicalBlueprint: input.blueprint,
        },
      }),

    /**
     * 获取默认 routing snapshot。
     *
     * 直接调 model.getRoutingSnapshot()，documentId 参数保留用于接口一致性。
     */
    getDefaultRoutingSnapshot: async (_input: { projectId: string; documentId: string }): Promise<ModelRoutingSnapshot> => {
      return model.getRoutingSnapshot();
    },

    /**
     * 检索 review 阶段所需的 memory bundle。
     *
     * 章节审校走 contextPacketId 路径（AGENTS.md 契约），不重新跑 preflight→retrieveMemory，
     * 而是复用项目最近的 memory_bundle（review 只需冻结事实，不需动态检索）。
     *
     * P1-D5: 应用 narrativeCutoff 屏蔽未来章节事实。
     * 设计依据：AGENTS.md「root-cause analysis」——原实现直接返回最新 memory_bundle，
     * 但审校早期章节时，bundle 可能包含后期章节的事实/伏笔兑现结果，让 reviewer 看到剧透，
     * 导致「未来事实污染当前审校」（如 reviewer 基于未来章节事实判定当前章节伏笔未兑现）。
     * 必须按目标章节前一章屏蔽未来事实，让审校器只看到「进入本章前的已知事实」。
     */
    retrieveMemoryForReview: async (input: { projectId: string; documentId: string; blueprint: ExecutionBlueprint }): Promise<MemoryBundle> => {
      // 重审正文已经作为 draft artifact 单独提供；记忆只允许看到目标章之前的状态，
      // 否则旧版当前章事实会反向约束重写，形成自我复制。
      const targetNarrativeOrder = await deps.repository.getDocumentNarrativeOrder(input.projectId, input.documentId);
      const narrativeCutoff = targetNarrativeOrder === undefined ? undefined : targetNarrativeOrder - 1;
      const [narrativeRhythm, serialContext] = typeof narrativeCutoff === "number"
        ? await Promise.all([
            loadNarrativeRhythm(input.projectId, input.documentId, narrativeCutoff),
            loadSerialContext(input.projectId, input.documentId, narrativeCutoff),
          ])
        : [undefined, undefined];
      const latestBundle = await deps.repository.getLatestMemoryBundle(input.projectId);
      if (!latestBundle) {
        // 即使没有历史记忆，也持久化不可变空快照；按引用执行不能依赖只存在于 workflow 内存的对象。
        const createdAt = Date.now();
        const fingerprint = canonicalSha256({ projectId: input.projectId, preflightId: input.blueprint.preflightId, narrativeCutoff, claims: [], narrativeRhythm: narrativeRhythm?.fingerprint, serialContext: serialContext?.fingerprint });
        return deps.repository.putMemoryBundle({
          id: `review-memory:${input.documentId}:${fingerprint.slice(0, 20)}`,
          projectId: input.projectId,
          preflightId: input.blueprint.preflightId,
          claims: [],
          conflicts: [],
          missingFacets: [],
          tokenBudget: 0,
          sourceRevisionIds: [],
          narrativeCutoff,
          selectionReceipts: [],
          narrativeRhythm,
          serialContext,
          fingerprint,
          createdAt,
        });
      }
      const bundle = latestBundle;
      // P1-D5: 应用 narrativeCutoff 过滤未来章节事实
      // 全局事实和跨章持续事实保持可见；跨 cutoff 的章节汇总包含未来正文，必须整体排除。
      const filteredClaims = narrativeCutoff === undefined
        ? bundle.claims
        : bundle.claims.filter((claim) => isMemoryClaimVisibleAtCutoff(claim, narrativeCutoff));

      // P1-5: 对已兑现伏笔/承诺标记 resolved，而非删除。
      // 设计依据：AGENTS.md「root-cause analysis」——原实现未过滤 narrativeRange.end，
      // 已兑现伏笔仍以"未兑现"形态注入（reason 含 "injection"），reviewer 误报"伏笔未兑现"。
      // 根因：foreshadowing claim 的 narrativeRange.end 表示兑现章节，end <= narrativeCutoff
      // 意味着该伏笔在当前章节之前已兑现，不再是"未兑现"状态。
      // 修复：不删除已兑现伏笔（reviewer 仍需知道伏笔存在过以判断兑现质量），而是在 reason
      // 字段追加 `[resolved-at:${end}]` 标记，让渲染层（buildContextMarkdown/buildReviewerContext）
      // 识别并加"【已兑现于第 X 章】"前缀，与未兑现伏笔区分。
      // 题材无关，覆盖所有 matchedFacets 含 foreshadowing 且 end <= narrativeCutoff 的 claim。
      const markedClaims = filteredClaims.map((claim) => {
        const end = claim.narrativeRange?.end;
        const isForeshadowing = matchedFacetsOf(claim).includes("foreshadowing");
        if (isForeshadowing && typeof end === "number" && typeof narrativeCutoff === "number" && end <= narrativeCutoff) {
          const resolvedMarker = `[resolved-at:${end}]`;
          const originalReason = claim.reason ?? "";
          // 避免重复标记（多次 retrieve 不会累加）
          if (originalReason.includes(resolvedMarker)) return claim;
          return { ...claim, reason: `${resolvedMarker}${originalReason}` };
        }
        return claim;
      });

      const includedIds = new Set(markedClaims.map((claim) => claim.id));
      const previousReceipts = new Map((bundle.selectionReceipts ?? []).map((receipt) => [receipt.claimId, receipt]));
      const selectionReceipts = bundle.claims.map((claim) => ({
        claimId: claim.id,
        matchedFacets: matchedFacetsOf(claim),
        score: claim.score,
        authority: claim.authority,
        tokenCost: Math.ceil((claim.title.length + claim.content.length) / 2),
        status: includedIds.has(claim.id) ? "included" as const : "excluded" as const,
        reason: includedIds.has(claim.id) ? (previousReceipts.get(claim.id)?.reason ?? "ranked-fill") : "future-cutoff" as const,
        sourceRevisionIds: claim.sourceRevisionIds,
      }));
      const snapshotShape = {
        projectId: bundle.projectId,
        preflightId: bundle.preflightId,
        sourceBundleId: bundle.id,
        narrativeCutoff,
        claims: markedClaims,
        conflicts: bundle.conflicts,
        missingFacets: bundle.missingFacets,
        tokenBudget: bundle.tokenBudget,
        selectionReceipts,
        narrativeRhythm: narrativeRhythm?.fingerprint,
        serialContext: serialContext?.fingerprint,
      };
      const fingerprint = canonicalSha256(snapshotShape);
      const reviewBundle: MemoryBundle = {
        ...bundle,
        id: `review-memory:${input.documentId}:${fingerprint.slice(0, 20)}`,
        claims: markedClaims,
        sourceRevisionIds: [...new Set(markedClaims.flatMap((claim) => claim.sourceRevisionIds))],
        narrativeCutoff,
        selectionReceipts,
        narrativeRhythm,
        serialContext,
        fingerprint,
        createdAt: Date.now(),
      };
      return deps.repository.putMemoryBundle(reviewBundle);
    },

    // ===== CreativeRun Workflow activities（Phase B-2.3）=====
    // 设计依据：AGENTS.md「章节审校工作流复用」+ Phase B-2.3 重构计划。
    // 9 个活动包装 creative/ 模块函数（状态机 + 事件溯源），
    // 不另起一套独立逻辑——所有状态转换与事件记录都走 creative/ 共享层。
    // 新增 generateFoundationWork + getWorkItem，驱动架构生成与 work item 重载。

    /**
     * 加载 CreativeRun（含 policy/payload）。
     * 包装 creative.getCreativeRun。
     */
    loadRun: async (input: { runId: string }): Promise<CreativeRun | null> => {
      return getCreativeRun(deps.repository, input.runId);
    },

    /**
     * 加载单个 work item（重载用）。
     * 包装 creative.getWorkItem。
     * processWorkItem 在生成步骤后需要重载 work item 以获取最新 artifactRefs。
     */
    getWorkItem: async (input: { workItemId: string }): Promise<CreativeWorkItem | null> => {
      return creativeGetWorkItem(deps.repository, input.workItemId);
    },

    /**
     * 列出 pending 状态的 work items（按 created_at ASC）。
     * 包装 creative.listWorkItems + 过滤 pending。
     */
    listPendingWork: async (input: { runId: string }): Promise<CreativeWorkItem[]> => {
      const all = await creativeListWorkItems(deps.repository, input.runId);
      const statusById = new Map(all.map((work) => [work.id, work.status]));
      const run = await getCreativeRun(deps.repository, input.runId);
      const sections = run ? await deps.repository.listProjectPlanSections(run.projectId) : [];
      const sectionStatus = new Map(sections.map((section) => [section.taskKey, section.status]));
      return all.filter((work) =>
        work.status === "pending"
        && work.dependsOn.every((dependencyId) => statusById.get(dependencyId) === "accepted"),
      ).filter((work) => {
        if (!run || run.policy.reviewGate === "none" || work.parameters.bootstrap !== true) return true;
        const dependencyTaskKeys = work.dependsOn
          .map((dependencyId) => all.find((candidate) => candidate.id === dependencyId)?.taskKey)
          .filter((taskKey): taskKey is string => Boolean(taskKey));
        return dependencyTaskKeys.every((taskKey) => sectionStatus.get(taskKey as import("../application/project-plan").ProjectPlanTaskKey) === "approved");
      });
    },

    /**
     * 启动 work item（pending → running）。
     * 包装 creative.startWork，内部更新状态 + 写 work.started 事件。
     */
    startWork: async (input: { runId: string; workItemId: string }): Promise<CreativeWorkItem> => {
      return creativeStartWork(deps.repository, input.workItemId);
    },

    /**
     * 检查 work item 的 review gate。
     * 包装 creative.checkGate，自动从 run 反查 policy。
     */
    checkGate: async (input: { runId: string; workItemId: string }): Promise<import("../protocol").CreativeReviewGate> => {
      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${input.runId}`);
      return creativeCheckGate(deps.repository, input.workItemId, run.policy);
    },

    listWorkReviews: async (input: { workItemId: string }): Promise<import("../protocol").CreativeReview[]> => {
      return creativeListReviews(deps.repository, input.workItemId);
    },

    /**
     * 接受 work item（running → accepted 终态）。
     * 包装 creative.acceptWork，内部触发 updateRunStatusFromWork 派生 run 状态。
     */
    acceptWork: async (input: { runId: string; workItemId: string }): Promise<CreativeWorkItem> => {
      const accepted = await creativeAcceptWork(deps.repository, input.workItemId);
      if (accepted.taskKey) {
        const artifactId = accepted.artifactRefs.at(-1);
        const run = await getCreativeRun(deps.repository, input.runId);
        if (artifactId && run) {
          const section = await deps.repository.getProjectPlanSection(run.projectId, accepted.taskKey as import("../application/project-plan").ProjectPlanTaskKey);
          if (section?.sourceArtifactId === artifactId && section.status !== "approved" && !requiresFoundationAuthorConfirmation(accepted.taskKey)) {
            await deps.repository.approveProjectPlanSection(run.projectId, section.taskKey, artifactId, "runtime");
          }
        }
      }
      return accepted;
    },

    foundationAuthorApproved: async (input: { runId: string; taskKey: string; artifactId: string }): Promise<boolean> => {
      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) return false;
      const section = await deps.repository.getProjectPlanSection(run.projectId, input.taskKey as import("../application/project-plan").ProjectPlanTaskKey);
      if (section?.status !== "approved" || section.sourceArtifactId !== input.artifactId) return false;
      const reviews = await creativeListReviews(deps.repository, section.workItemId ?? "");
      return hasPassedIndependentReviewForArtifact(reviews, input.artifactId);
    },

    /**
     * 检查规划阶段是否已由作者批准为当前 artifact（仅批准事实，不含独立审核通过要求）。
     * 用于 manual-gate 等待循环区分 plan.approve 唤醒与 review 唤醒：作者已批准的
     * foundation 产物不应被自动 revise 覆盖，继续等待独立 passed review 或作者后续命令。
     */
    planSectionApproved: async (input: { runId: string; taskKey: string; artifactId: string }): Promise<boolean> => {
      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) return false;
      const section = await deps.repository.getProjectPlanSection(run.projectId, input.taskKey as import("../application/project-plan").ProjectPlanTaskKey);
      return section?.status === "approved" && section.sourceArtifactId === input.artifactId;
    },

    /**
     * 修订 work item（running/accepted → pending，iteration+1）。
     * 包装 creative.reviseWork。
     */
    reviseWork: async (input: { runId: string; workItemId: string; instruction?: string }): Promise<CreativeWorkItem> => {
      return creativeReviseWork(deps.repository, input.workItemId, input.instruction);
    },

    /**
     * 重试 work item（failed → pending）。
     * 包装 creative.retryWork。
     */
    retryWork: async (input: { runId: string; workItemId: string }): Promise<CreativeWorkItem> => {
      return creativeRetryWork(deps.repository, input.workItemId);
    },

    /**
     * 更新 run 状态（基于 work items 状态派生）。
     * 包装 creative.updateRunStatusFromWork。
     */
    updateRunStatus: async (input: { runId: string }): Promise<CreativeRun> => {
      return updateRunStatusFromWork(deps.repository, input.runId);
    },

    /**
     * 写入 creative_run_events 事件。
     * 直接 INSERT，与 creative/ 模块的 writeRunEvent 一致。
     */
    recordEvent: async (input: { runId: string; eventType: string; payload: Record<string, unknown> }): Promise<unknown> => {
      await deps.repository.appendCreativeRunEvent(input.runId, input.eventType, input.payload);
      return { recorded: true };
    },

    /**
     * 标记 work item 失败并写入 run 事件（闭环状态机）。
     * 用于 CreativeRun 达到重试上限时，避免 work item 永久停留在 running。
     * 包装 creative.failWork。
     */
    failWork: async (input: { runId: string; workItemId: string; reason?: string }): Promise<CreativeWorkItem> => {
      return creativeFailWork(deps.repository, input.workItemId, input.reason ?? "maxRetriesExceeded");
    },

    getStoryArcRoutingSnapshot: async (): Promise<ModelRoutingSnapshot> => model.getRoutingSnapshot(),
    loadStoryArcBundleArtifact: async (input: { projectId: string; arcId: string; artifactId: string }) => {
      const artifact = await deps.repository.getArtifact(input.artifactId);
      if (!artifact || artifact.projectId !== input.projectId) throw new Error("故事弧蓝图 artifact 不存在或不属于当前项目");
      const bundle = parseStoryArcBundle(artifact.structuredData);
      const artifactArcId = typeof artifact.structuredData?.arcId === "string" ? artifact.structuredData.arcId : undefined;
      if (artifactArcId && artifactArcId !== input.arcId) throw new Error("故事弧蓝图 artifact 不属于当前故事弧");
      return { artifact, bundle };
    },
    expireExternalModelTask: async (input: { modelTaskId: string; reason: string }) => deps.repository.expireModelTask(input.modelTaskId, input.reason),

    generateBookSynopsis: async (input: { workflowId: string; projectId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<GeneratedBookSynopsisResult> => {
      const [sections, project] = await Promise.all([
        deps.repository.listProjectPlanSections(input.projectId),
        deps.repository.getProjectDetail(input.projectId),
      ]);
      const currentFingerprint = bookSynopsisSourceFingerprint({ projectTitle: project.title, sections });
      if (currentFingerprint !== input.sourceFingerprint) throw new Error("作品简介生成来源已变化，请基于最新规划重新生成");
      const prompt = buildBookSynopsisPrompt({ projectTitle: project.title, sections });
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "foundation.book-plan", role: "planner" });
      const system = "你是擅长将长篇小说创作规划转化为读者向作品简介的资深出版文案编辑。忠实于规划事实，以阅读吸引力为目标。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 1_200, provenanceRefs: [input.sourceFingerprint], skillBundle: skills, skillExecutionPoint: "foundation.book-plan" });
      try {
        const generated = await model.generateStructured<{ synopsis: string }>({
          purpose: "planning.foundation",
          system,
          prompt: promptPackage.instruction,
          schema: BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "book_synopsis",
          maxTokens: 1200,
          temperature: 0.75,
          workflowRunId: input.workflowId,
          taskId: `${input.projectId}:book-synopsis`,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        return { kind: "completed", text: generated.value.synopsis.trim() };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.workflowId,
            taskId: `${input.projectId}:book-synopsis`,
            purpose: "planning.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "structured",
            system,
            instruction: promptPackage.instruction,
            schema: BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "book_synopsis",
            baseRevision: 0,
            contextRefs: { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalBookSynopsis: async (input: { modelTaskId: string; value: unknown }): Promise<{ text: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部作品简介任务不存在");
      assertStructuredSchema(input.value, BOOK_SYNOPSIS_SCHEMA as unknown as Record<string, unknown>, "外部作品简介结果");
      return { text: (input.value as { synopsis: string }).synopsis.trim() };
    },

    persistBookSynopsis: async (input: { projectId: string; sourceFingerprint: string; text: string }): Promise<BookSynopsisRecord> => {
      const synopsis = { text: input.text.trim(), generatedAt: new Date().toISOString(), sourceFingerprint: input.sourceFingerprint };
      if (!synopsis.text) throw new Error("模型没有返回有效的作品简介");
      const saved = await deps.repository.saveBookSynopsisIfCurrent({ projectId: input.projectId, sourceFingerprint: input.sourceFingerprint, synopsis });
      if (!saved) throw new Error("作品简介生成期间全书规划已变化，旧结果未保存");
      return synopsis;
    },

    generateBookTitleCandidates: async (input: { workflowId: string; projectId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<GeneratedBookTitleCandidatesResult> => {
      const sections = await deps.repository.listProjectPlanSections(input.projectId);
      if (bookTitleSourceFingerprint(sections) !== input.sourceFingerprint) throw new Error("书名生成来源已变化，请基于最新规划重新生成");
      const prompt = buildBookTitleCandidatesPrompt(sections);
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "foundation.book-plan", role: "planner" });
      const system = "你是擅长为长篇中文小说提炼有辨识度书名的资深出版策划。忠实于作品规划，并让候选覆盖不同命名角度。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 1_600, provenanceRefs: [input.sourceFingerprint], skillBundle: skills, skillExecutionPoint: "foundation.book-plan" });
      try {
        const generated = await model.generateStructured<{ candidates: BookTitleCandidate[] }>({
          purpose: "planning.foundation",
          system,
          prompt: promptPackage.instruction,
          schema: BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "book_title_candidates",
          maxTokens: 1600,
          temperature: 0.9,
          workflowRunId: input.workflowId,
          taskId: `${input.projectId}:book-title-candidates`,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        return { kind: "completed", candidates: normalizeBookTitleCandidates(generated.value) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.workflowId,
            taskId: `${input.projectId}:book-title-candidates`,
            purpose: "planning.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "structured",
            system,
            instruction: promptPackage.instruction,
            schema: BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "book_title_candidates",
            baseRevision: 0,
            contextRefs: { projectId: input.projectId, sourceFingerprint: input.sourceFingerprint },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalBookTitleCandidates: async (input: { modelTaskId: string; value: unknown }): Promise<{ candidates: BookTitleCandidate[] }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部书名生成任务不存在");
      assertStructuredSchema(input.value, BOOK_TITLE_CANDIDATES_SCHEMA as unknown as Record<string, unknown>, "外部书名候选结果");
      return { candidates: normalizeBookTitleCandidates(input.value) };
    },

    persistBookTitleCandidates: async (input: { projectId: string; sourceFingerprint: string; candidates: BookTitleCandidate[] }): Promise<BookTitleCandidatesRecord> => {
      const record = { candidates: input.candidates, generatedAt: new Date().toISOString(), sourceFingerprint: input.sourceFingerprint };
      const saved = await deps.repository.saveBookTitleCandidatesIfCurrent({ projectId: input.projectId, sourceFingerprint: input.sourceFingerprint, candidates: record });
      if (!saved) throw new Error("书名生成期间全书规划已变化，旧结果未保存");
      return record;
    },

    generateChapterTitle: async (input: { workflowId: string; projectId: string; documentId: string; sourceFingerprint: string; candidateStartIndex?: number }): Promise<GeneratedChapterTitleResult> => {
      const source = await deps.repository.getChapterTitleSource(input.projectId, input.documentId);
      if (!source) throw new Error("章节不存在");
      if (chapterTitleSourceFingerprint(source) !== input.sourceFingerprint) throw new Error("章节命名来源已变化，请重新生成");
      const plainText = source.objectKey ? await objects.getText(source.objectKey) : undefined;
      const prompt = buildChapterTitlePrompt({ ...source, plainText });
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "chapter.blueprint", role: "planner" });
      const system = "你是中文长篇小说的章节命名编辑。标题必须忠实于本章独特内容，优先简练的四字中文，但不以牺牲准确性换取字数整齐。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 300, provenanceRefs: [input.documentId, input.sourceFingerprint], skillBundle: skills, skillExecutionPoint: "chapter.blueprint" });
      try {
        const generated = await model.generateStructured<{ title: string }>({
          purpose: "planning.foundation",
          system,
          prompt: promptPackage.instruction,
          schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "chapter_title",
          maxTokens: 300,
          temperature: 0.75,
          workflowRunId: input.workflowId,
          taskId: `${input.documentId}:chapter-title`,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        return { kind: "completed", title: normalizeChapterTitle(generated.value) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.workflowId,
            taskId: `${input.documentId}:chapter-title`,
            purpose: "planning.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "structured",
            system,
            instruction: promptPackage.instruction,
            schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "chapter_title",
            baseRevision: 0,
            contextRefs: { projectId: input.projectId, documentId: input.documentId, sourceFingerprint: input.sourceFingerprint },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalChapterTitle: async (input: { modelTaskId: string; value: unknown }): Promise<{ title: string }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部章节命名任务不存在");
      assertStructuredSchema(input.value, CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>, "外部章节命名结果");
      return { title: normalizeChapterTitle(input.value) };
    },

    persistGeneratedChapterTitle: async (input: { projectId: string; documentId: string; sourceFingerprint: string; title: string }): Promise<{ title: string }> => {
      const title = normalizeChapterTitle({ title: input.title });
      const saved = await deps.repository.saveGeneratedChapterTitleIfCurrent({ ...input, title });
      if (!saved) throw new Error("章节命名期间标题、蓝图或正文已变化，旧结果未保存");
      return { title };
    },

    generateStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; authorIntent?: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; batchIndex?: number; startChapterIndex?: number; rebase?: boolean; arcPlan?: StoryArcPlanOutput }): Promise<GeneratedStoryArcResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId, input.arcId);
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "arc.plan", role: "planner" });
      const rebaseTarget = input.rebase ? await deps.repository.getStoryArcRebaseTarget(input.projectId, input.arcId) : undefined;
      const arc = input.batchIndex ? await deps.repository.getStoryArc(input.projectId, input.arcId) : undefined;
      if (input.batchIndex && !arc) throw new Error("故事弧不存在");
      const system = "你是长篇小说故事弧策划师。只输出符合 schema 的 JSON。";
      const existingPlan = input.arcPlan
        ?? (input.batchIndex && arc ? { arc: arc.arc, batch: { batchIndex: input.batchIndex, startChapterIndex: input.startChapterIndex!, complete: false } } : undefined);
      let plan = existingPlan;
      let planProvenance: ModelExecutionProvenance | undefined;
      if (!plan) {
        const planPromptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.arc", stage: "planning", system, prompt: buildStoryArcPlanPrompt({ ...planning, authorIntent: input.authorIntent }, rebaseTarget), schema: storyArcPlanBatchSchema as unknown as Record<string, unknown>, reservedOutputTokens: 8_000, provenanceRefs: [input.arcId, "segment:arc-batch"], skillBundle: skills, skillExecutionPoint: "arc.plan" });
        try {
          const generatedPlan = await model.generateStructured<StoryArcPlanOutput>({ purpose: "planning.arc", system, prompt: planPromptPackage.instruction, schema: storyArcPlanBatchSchema as unknown as Record<string, unknown>, schemaName: "story-arc-plan-batch", maxTokens: 8_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc:arc-batch`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, promptContext: planPromptPackage.manifest });
          plan = generatedPlan.value;
          planProvenance = generatedPlan.provenance;
        } catch (error) {
          if (!(error instanceof ExternalMcpRequiredError)) throw error;
          return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc:arc-batch`, purpose: "planning.arc", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: planPromptPackage.instruction, schema: storyArcPlanBatchSchema as unknown as Record<string, unknown>, schemaName: "story-arc-plan-batch", baseRevision: 0, contextRefs: { arcId: input.arcId, skillBundleId: skills.id, outputSegment: "arc-batch", segmentIndex: "1", segmentCount: "2" }, promptContext: planPromptPackage.manifest }) };
        }
      }

      const chapterPromptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.arc", stage: "planning", system, prompt: buildStoryArcChaptersPrompt({ ...planning, authorIntent: input.authorIntent, arc: plan.arc, batch: plan.batch }, rebaseTarget), schema: storyArcChaptersOutputSchema as unknown as Record<string, unknown>, reservedOutputTokens: 10_000, provenanceRefs: [input.arcId, "segment:chapters"], skillBundle: skills, skillExecutionPoint: "arc.plan" });
      try {
        const generatedChapters = await model.generateStructured<StoryArcChaptersOutput>({ purpose: "planning.arc", system, prompt: chapterPromptPackage.instruction, schema: storyArcChaptersOutputSchema as unknown as Record<string, unknown>, schemaName: "story-arc-chapters", maxTokens: 10_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc:chapters`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, promptContext: chapterPromptPackage.manifest });
        let bundle = parseStoryArcBundle({ ...plan, chapters: generatedChapters.value.chapters });
        validateStoryArcExecutionContracts(bundle);
        if (rebaseTarget) {
          bundle = normalizeStoryArcRebaseBundle(bundle, rebaseTarget);
          validateStoryArcRebaseBundle(bundle, rebaseTarget);
        }
        if (input.batchIndex && (bundle.batch.batchIndex !== input.batchIndex || bundle.batch.startChapterIndex !== input.startChapterIndex)) throw new Error("生成结果的故事弧批次位置与请求不一致");
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, ...(planning.plotOutline ? { plotOutline: planning.plotOutline } : {}), modelProvenance: { plan: planProvenance, chapters: generatedChapters.provenance } } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc:chapters`, purpose: "planning.arc", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: chapterPromptPackage.instruction, schema: storyArcChaptersOutputSchema as unknown as Record<string, unknown>, schemaName: "story-arc-chapters", baseRevision: 0, contextRefs: { arcId: input.arcId, skillBundleId: skills.id, outputSegment: "chapters", segmentIndex: "2", segmentCount: "2", arcJson: JSON.stringify(plan.arc), batchJson: JSON.stringify(plan.batch), outlineJson: JSON.stringify(planning.plotOutline ?? null) }, promptContext: chapterPromptPackage.manifest }) };
      }
    },

    materializeExternalStoryArcPlan: async (input: { modelTaskId: string; value: unknown }): Promise<StoryArcPlanOutput> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部故事弧分段任务不存在");
      assertStructuredSchema(input.value, storyArcPlanBatchSchema as unknown as Record<string, unknown>, "外部故事弧 arc+batch 分段结果");
      const value = input.value as StoryArcPlanOutput;
      if (!value.arc || !value.batch) throw new Error("外部故事弧 arc+batch 分段缺少完整对象");
      return value;
    },

    materializeExternalStoryArcBundle: async (input: { modelTaskId: string; projectId: string; arcId: string; value: unknown; rebase?: boolean }): Promise<{ artifact: Artifact; bundle: StoryArcBundle }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部故事弧任务不存在");
      const segment = task.workPackage.contextRefs.outputSegment;
      // 外部编排（模式 B）的 provenance：chapters 分段携带 outlineJson，
      // 物化时写回蓝图 artifact，保证编排输入可追溯。
      const plotOutline = (() => {
        if (segment !== "chapters") return undefined;
        const raw = task.workPackage.contextRefs.outlineJson;
        if (!raw || raw === "null") return undefined;
        try {
          const parsed = JSON.parse(raw) as unknown;
          return parsed && typeof parsed === "object" ? parsed : undefined;
        } catch {
          return undefined;
        }
      })();
      let rawBundle: unknown = input.value;
      if (segment === "chapters") {
        assertStructuredSchema(input.value, storyArcChaptersOutputSchema as unknown as Record<string, unknown>, "外部故事弧 chapters 分段结果");
        const arc = JSON.parse(task.workPackage.contextRefs.arcJson ?? "null") as StoryArcBundle["arc"] | null;
        const batch = JSON.parse(task.workPackage.contextRefs.batchJson ?? "null") as StoryArcBundle["batch"] | null;
        if (!arc || !batch) throw new Error("外部故事弧 chapters 分段缺少前置 arc+batch");
        rawBundle = { arc, batch, chapters: (input.value as StoryArcChaptersOutput).chapters };
      } else {
        assertStructuredSchema(input.value, storyArcBundleSchema as unknown as Record<string, unknown>, "外部故事弧结果");
      }
      let bundle = parseStoryArcBundle(rawBundle);
      const rebaseTarget = input.rebase ? await deps.repository.getStoryArcRebaseTarget(input.projectId, input.arcId) : undefined;
      if (rebaseTarget) bundle = normalizeStoryArcRebaseBundle(bundle, rebaseTarget);
      else bundle = parseStoryArcBundle(bundle);
      validateStoryArcExecutionContracts(bundle);
      if (rebaseTarget) validateStoryArcRebaseBundle(bundle, rebaseTarget);
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: task.workflowRunId, arcId: input.arcId, externalModelTaskId: task.id, ...(plotOutline ? { plotOutline } : {}) } });
      return { artifact, bundle };
    },

    projectStoryArcBundle: async (input: { projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; actor: string; edited?: boolean }) => deps.repository.projectStoryArcBundle(input),

    reviewStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; rebase?: boolean }): Promise<GeneratedStoryArcReviewResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId, input.arcId);
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "arc.review", role: "structure-reviewer" });
      const rebaseTarget = input.rebase ? await deps.repository.getStoryArcRebaseTarget(input.projectId, input.arcId) : undefined;
      const prompt = buildStoryArcReviewPrompt(input.bundle, "", rebaseTarget);
      const contextSections = buildStoryArcPlanningContextSections(planning);
      const system = "你是独立长篇故事弧审核员。只输出审核结论文本，不输出 JSON 或 Schema。";
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "review.arc", stage: "review", system, prompt, contextSections, provenanceRefs: [input.arcId, input.artifact.id], skillBundle: skills, skillExecutionPoint: "arc.review" });
      const prompts = rebaseTarget
        ? [
          { suffix: "", lens: "balanced" },
          { suffix: "\n\n## 对抗式复核\n从每章 unresolvedAtClose 倒推检查所有权威路径，把候选当作待证明命题而非合理剧情；只要冻结证据不能蕴含候选主张，就列为越界问题。尤其检查来源归属、内心动机、危险性质、决定与实际行动之间的状态跨越。", lens: "adversarial-authority" },
        ]
        : [{ suffix: "", lens: "balanced" }];
      try {
        const attempts = await Promise.allSettled(prompts.map((pass, passIndex) => {
          const passPackage = passIndex === 0 ? promptPackage : compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "review.arc", stage: "review", system, prompt: `${prompt}${pass.suffix}`, contextSections, provenanceRefs: [input.arcId, input.artifact.id, pass.lens], skillBundle: skills, skillExecutionPoint: "arc.review" });
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(new Error(`故事弧审核轮次超过 ${ARC_REVIEW_PASS_TIMEOUT_MS}ms`)), ARC_REVIEW_PASS_TIMEOUT_MS);
          return model.generateText({ purpose: "review.arc", system, prompt: passPackage.instruction, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}:${pass.lens}`, routingSnapshot: input.routingSnapshot, candidateStartIndex: (input.candidateStartIndex ?? 0) + passIndex, promptContext: passPackage.manifest, signal: controller.signal }).finally(() => clearTimeout(timeout));
        }));
        const failedPasses = attempts.flatMap((result, index) => result.status === "rejected" ? [{ index, lens: prompts[index].lens, reason: result.reason }] : []);
        const externalFailure = failedPasses.find((pass) => pass.reason instanceof ExternalMcpRequiredError);
        const generated = attempts.flatMap((result, index) => result.status === "fulfilled" ? [{ index, result: result.value }] : []);
        // The lenses are independent evidence sources. A provider timeout or
        // malformed response in one lens must not erase a complete review from
        // another lens; retain the failure in artifact metadata instead. Only
        // fall back to an external task when no complete API review exists.
        if (!generated.length) {
          if (externalFailure) throw externalFailure.reason;
          throw failedPasses[0]?.reason ?? new Error("故事弧审核没有成功候选");
        }
        const lensReviews: Array<{ lens: string; review: StoryArcReviewOutput }> = generated.map(({ index, result }) => ({
          lens: prompts[index]?.lens ?? `pass-${index + 1}`,
          review: parseTextReview(result.text),
        }));
        const opinions = lensReviews
          .map((item) => item.review.verdict === "revise" ? `【${item.lens}】\n${item.review.opinion}` : "")
          .filter(Boolean);
        const review: StoryArcReviewOutput = {
          verdict: opinions.length ? "revise" : "passed",
          opinion: opinions.join("\n\n"),
        };
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc-review`, kind: "review", baseRevision: 0, text: JSON.stringify(review, null, 2), structuredData: { ...review, subjectArtifactId: input.artifact.id, workflowId: input.workflowId, modelProvenance: generated.map(({ result }) => result.provenance), reviewLenses: lensReviews.map((item) => item.lens), discardedReviewLenses: failedPasses.map((pass) => ({ lens: pass.lens, reason: pass.reason instanceof Error ? pass.reason.message : String(pass.reason) })) } });
        return { kind: "completed", artifact, review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const externalPromptPackage = rebaseTarget
          ? compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "review.arc", stage: "review", system, prompt: `${prompt}${prompts[1].suffix}`, contextSections, provenanceRefs: [input.arcId, input.artifact.id, prompts[1].lens], skillBundle: skills, skillExecutionPoint: "arc.review" })
          : promptPackage;
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-review:${input.artifact.id}`, purpose: "review.arc", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "review", system, instruction: externalPromptPackage.instruction, baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id, skillBundleId: skills.id }, promptContext: externalPromptPackage.manifest }) };
      }
    },

    materializeExternalStoryArcReview: async (input: { modelTaskId: string; projectId: string; arcId: string; subjectArtifactId: string; value: unknown; rebase?: boolean }): Promise<{ artifact: Artifact; review: StoryArcReviewOutput }> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error("外部故事弧审核任务不存在");
      const subjectArtifact = await deps.repository.getArtifact(input.subjectArtifactId);
      if (!subjectArtifact) throw new Error("外部故事弧审核对应的蓝图不存在");
      const rawText = extractReviewText(input.value);
      const review = parseTextReview(rawText);
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "review", baseRevision: 0, text: JSON.stringify(review, null, 2), structuredData: { ...review, subjectArtifactId: input.subjectArtifactId, workflowId: task.workflowRunId, externalModelTaskId: task.id, rebase: Boolean(input.rebase), reviewLenses: input.rebase ? ["balanced", "adversarial-authority"] : ["balanced"] } });
      return { artifact, review };
    },

    reviseStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; review: StoryArcReviewOutput; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; rebase?: boolean }): Promise<GeneratedStoryArcResult> => {
      const planning = await deps.repository.getStoryArcPlanningInput(input.projectId, input.arcId);
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "arc.revision", role: "reviser" });
      const rebaseTarget = input.rebase ? await deps.repository.getStoryArcRebaseTarget(input.projectId, input.arcId) : undefined;
      const prompt = buildStoryArcRevisionPrompt(input.bundle, input.review, "", rebaseTarget);
      const contextSections = buildStoryArcPlanningContextSections(planning);
      const system = "你是长篇小说故事弧修订策划师。只输出完整 JSON。";
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.arc-revision", stage: "revision", system, prompt, contextSections, schema: storyArcBundleSchema as unknown as Record<string, unknown>, reservedOutputTokens: 12_000, provenanceRefs: [input.arcId, input.artifact.id], skillBundle: skills, skillExecutionPoint: "arc.revision" });
      try {
        const generated = await model.generateStructured<StoryArcBundle>({ purpose: "planning.arc-revision", system, prompt: promptPackage.instruction, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", maxTokens: 12_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc-revision`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, promptContext: promptPackage.manifest });
        let bundle = parseStoryArcBundle(generated.value);
        if (rebaseTarget) bundle = normalizeStoryArcRebaseBundle(bundle, rebaseTarget);
        else bundle = parseStoryArcBundle(bundle);
        validateStoryArcExecutionContracts(bundle);
        if (rebaseTarget) validateStoryArcRebaseBundle(bundle, rebaseTarget);
        if (bundle.batch.batchIndex !== input.bundle.batch.batchIndex || bundle.batch.startChapterIndex !== input.bundle.batch.startChapterIndex) throw new Error("故事弧修订不得改写批次位置");
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc-revision`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, sourceArtifactId: input.artifact.id, modelProvenance: generated.provenance } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc-revision`, purpose: "planning.arc-revision", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: promptPackage.instruction, schema: storyArcBundleSchema as unknown as Record<string, unknown>, schemaName: "story-arc-bundle", baseRevision: 0, contextRefs: { arcId: input.arcId, artifactId: input.artifact.id, skillBundleId: skills.id }, promptContext: promptPackage.manifest }) };
      }
    },

    approveStoryArcAutomatically: async (input: { projectId: string; arcId: string; artifactId: string; reviewArtifactId: string }) => deps.repository.approveStoryArc(input.projectId, input.arcId, input.artifactId, input.reviewArtifactId, "external-reviewer"),
    failStoryArc: async (input: { projectId: string; arcId: string; reason: string }) => deps.repository.failStoryArc(input.projectId, input.arcId, input.reason),
    failStoryArcBatch: async (input: { projectId: string; arcId: string; batchIndex: number; reason: string }) => deps.repository.failStoryArcBatch(input.projectId, input.arcId, input.batchIndex, input.reason),
    recoverStoryArcAfterWorkflowCancellation: async (input: { projectId: string; arcId: string }) => deps.repository.recoverStoryArcAfterWorkflowCancellation(input.projectId, input.arcId),

    /**
     * 生成架构产出（foundation artifact）。
     *
     * 设计依据：AGENTS.md「reusable contracts over case-specific examples」+ 架构阶段原则。
     * - 按 work item.taskKey 调用 modelGateway.generateStructured(planning.foundation)
     * - 用 buildFoundationPrompt 构建 prompt（通用维度指导，不内置题材 fixture）
     * - 产出存为 kind="foundation" 的 artifact，并 attachArtifact 到 work item
     * - 前序 artifact 摘要从 dependsOn 链加载，提供依赖链上下文
     * - 支持 internal LLM 与 external-mcp 双路径（同 draft/review/revise）
     *
     * 与 draft activity 的区别：
     * - draft 生成章节正文（writing.draft, kind="draft"）
     * - generateFoundationWork 生成架构产出（planning.foundation, kind="foundation"）
     * - 两者都复用 makeArtifact + externalTask 模式
     */
    generateFoundationWork: async (input: {
      runId: string;
      workItemId: string;
      candidateStartIndex?: number;
    }): Promise<{ kind: "completed"; artifact: Artifact } | { kind: "external"; task: ModelTaskRecord; artifact: Artifact }> => {
      // 1. 加载 work item + run + project
      const work = await creativeGetWorkItem(deps.repository, input.workItemId);
      if (!work) throw new Error(`CreativeWorkItem 不存在：${input.workItemId}`);
      if (!work.taskKey) throw new Error(`work item 缺少 taskKey：${input.workItemId}`);
      if (isRetiredFoundationTaskKey(work.taskKey) || !isProjectPlanTaskKey(work.taskKey)) {
        throw new Error(`新的 Foundation 生成不接受该 taskKey：${work.taskKey}`);
      }
      const taskSchema = foundationSchemaForTask(work.taskKey);

      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${input.runId}`);

      const { project, priorArtifacts } = await deps.repository.getFoundationWorkContext(
        run.projectId,
        work.dependsOn,
        work.parameters.focusedPlanRegeneration === true ? work.taskKey as import("../application/project-plan").ProjectPlanTaskKey : undefined,
      );

      // Foundation 与章节生成共享同一套技能选择、题材匹配、冲突和 fingerprint 契约。
      const foundationSkillBundle = await resolveCurrentSkills({
        projectId: run.projectId,
        executionPoint: "foundation.book-plan",
        role: "planner",
        genre: typeof project.metadata?.genre === "string" ? project.metadata.genre : undefined,
        preflightId: `foundation:${input.runId}`,
      });
      if (foundationSkillBundle.conflicts.length) throw new Error(`Foundation skill 冲突：${foundationSkillBundle.conflicts.map((item) => `${item.skillId}/${item.conflictsWith}`).join(", ")}`);
      // 3. 构建 prompt
      const creativeBrief = parseCreativeBrief(project.metadata?.creativeBrief);
      const prompt = buildFoundationPrompt({
        taskKey: work.taskKey,
        instruction: work.instruction,
        projectTitle: project.title,
        premise: typeof project.metadata?.premise === "string" ? project.metadata.premise : undefined,
        genre: typeof project.metadata?.genre === "string" ? project.metadata.genre : undefined,
        objective: typeof run.payload?.objective === "string" ? run.payload.objective : undefined,
        priorArtifacts,
        creativeBrief,
      });

      const routingSnapshot = model.getRoutingSnapshot();
      const taskId = `${input.workItemId}:foundation`;
      const promptPackage = compileSinglePrompt({ projectId: run.projectId, workflowId: input.runId, purpose: "planning.foundation", stage: "foundation", system: FOUNDATION_SYSTEM_PROMPT, prompt, schema: taskSchema, reservedOutputTokens: 4096, provenanceRefs: [input.workItemId, ...work.dependsOn], skillBundle: foundationSkillBundle, skillExecutionPoint: "foundation.book-plan" });

      // 4. 调用 LLM 生成（支持 external-mcp 双路径）
      try {
        const generated = await model.generateStructured<FoundationOutput>({
          purpose: "planning.foundation",
          system: FOUNDATION_SYSTEM_PROMPT,
          prompt: promptPackage.instruction,
          schema: taskSchema,
          schemaName: "foundation-output",
          maxTokens: 4096,
          workflowRunId: input.runId,
          taskId,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
          extraValidate: (value) => {
            // generateStructured 的 parsed 中 structuredData 仍是 JSON 字符串，
            // validateFoundationTaskContract 期望对象形态；先 normalize 再校验，
            // 避免对字符串形态误判所有字段为空。
            let normalizedValue: unknown = value;
            try {
              normalizedValue = normalizeFoundationModelOutput(value as unknown, work.taskKey ?? "");
            } catch (error) {
              return [`structuredData 无法解析为对象：${error instanceof Error ? error.message : String(error)}`];
            }
            return validateFoundationTaskContract(normalizedValue as FoundationOutput, work.taskKey ?? "");
          },
        });
        const normalizedFoundation = normalizeFoundationModelOutput(generated.value, work.taskKey ?? "");
        assertFoundationTaskContract(normalizedFoundation, work.taskKey);

        const artifact = await makeArtifact({
          projectId: run.projectId,
          taskId,
          kind: "foundation",
          baseRevision: 0,
          text: JSON.stringify(normalizedFoundation, null, 2),
          structuredData: {
            ...normalizedFoundation,
            modelProvenance: generated.provenance,
            workItemId: input.workItemId,
            taskKey: work.taskKey,
            runId: input.runId,
            ...(work.taskKey === "project-positioning" && creativeBrief ? { creativeBrief } : {}),
            skillBundleId: foundationSkillBundle.id,
            skillBundleFingerprint: foundationSkillBundle.fingerprint,
          },
        });
        await deps.repository.projectFoundationArtifact(artifact);

        const foundationClaim = foundationArtifactToMemoryClaim(artifact, {
          objective: typeof run.payload?.objective === "string" ? run.payload.objective : undefined,
        });
        const recordedClaims = await deps.repository.recordMemoryClaims({
          projectId: run.projectId,
          claims: [foundationClaim],
          sourceArtifactId: artifact.id,
        });
        if (recordedClaims.length && deps.memoryIndex) {
          try {
            await deps.memoryIndex.upsertClaims(run.projectId, recordedClaims);
          } catch (error) {
            console.warn(`[foundation-memory] Qdrant 索引失败，PostgreSQL 真源已保留：${(error as Error).message}`);
          }
        }

        // attachArtifact 到 work item
        await creativeAttachArtifact(deps.repository, input.workItemId, artifact.id);

        return { kind: "completed", artifact };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        // external-mcp 路径：创建 external task，返回 stub artifact（待外部回填）
        const task = await externalTask({
          workflowId: input.runId,
          taskId,
          purpose: "planning.foundation",
          candidateIndex: error.candidateIndex,
          routingSnapshot,
          outputKind: "structured",
          system: FOUNDATION_SYSTEM_PROMPT,
          instruction: promptPackage.instruction,
          schema: taskSchema,
          schemaName: "foundation-output",
          baseRevision: 0,
          contextRefs: { workItemId: input.workItemId, taskKey: work.taskKey },
          promptContext: promptPackage.manifest,
        });
        // stub artifact：外部回填时由 materializeExternalFoundation 替换
        const stubArtifact = await makeArtifact({
          projectId: run.projectId,
          taskId,
          kind: "foundation",
          baseRevision: 0,
          text: "",
          structuredData: { workItemId: input.workItemId, taskKey: work.taskKey, runId: input.runId, pendingExternalTaskId: task.id, skillBundleId: foundationSkillBundle.id, skillBundleFingerprint: foundationSkillBundle.fingerprint },
        });
        await creativeAttachArtifact(deps.repository, input.workItemId, stubArtifact.id);
        return { kind: "external", task, artifact: stubArtifact };
      }
    },

    /**
     * 物化外部 foundation 任务结果（external-mcp 回填路径）。
     *
     * 与 materializeExternalText 对称：外部 MCP 完成 foundation 任务后，
     * 调用本 activity 将结果物化为 artifact 并 attach 到 work item。
     */
    materializeExternalFoundation: async (input: {
      modelTaskId: string;
      workItemId: string;
      value: unknown;
    }): Promise<Artifact> => {
      const work = await creativeGetWorkItem(deps.repository, input.workItemId);
      if (!work) throw new Error(`CreativeWorkItem 不存在：${input.workItemId}`);
      const run = await getCreativeRun(deps.repository, work.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${work.runId}`);
      const project = await deps.repository.getProjectDetail(run.projectId);
      const creativeBrief = parseCreativeBrief(project.metadata?.creativeBrief);
      const stubArtifact = work.artifactRefs.at(-1) ? await deps.repository.getArtifact(work.artifactRefs.at(-1)!) : undefined;
      const taskSchema = foundationSchemaForTask(work.taskKey ?? "");
      assertStructuredSchema(input.value, taskSchema, "外部 foundation 结果");
      const normalizedFoundation = normalizeFoundationModelOutput(input.value, work.taskKey ?? "");
      assertFoundationTaskContract(normalizedFoundation, work.taskKey ?? "");

      const artifact = await makeArtifact({
        projectId: run.projectId,
        taskId: `${input.workItemId}:foundation`,
        kind: "foundation",
        baseRevision: 0,
        text: JSON.stringify(normalizedFoundation, null, 2),
        structuredData: {
          ...normalizedFoundation,
          workItemId: input.workItemId,
          taskKey: work.taskKey,
          runId: work.runId,
          ...(work.taskKey === "project-positioning" && creativeBrief ? { creativeBrief } : {}),
          materializedFromTask: input.modelTaskId,
          skillBundleId: typeof stubArtifact?.structuredData?.skillBundleId === "string" ? stubArtifact.structuredData.skillBundleId : undefined,
          skillBundleFingerprint: typeof stubArtifact?.structuredData?.skillBundleFingerprint === "string" ? stubArtifact.structuredData.skillBundleFingerprint : undefined,
        },
      });
      await deps.repository.projectFoundationArtifact(artifact);
      const foundationClaim = foundationArtifactToMemoryClaim(artifact, {
        objective: typeof run.payload?.objective === "string" ? run.payload.objective : undefined,
      });
      const recordedClaims = await deps.repository.recordMemoryClaims({
        projectId: run.projectId,
        claims: [foundationClaim],
        sourceArtifactId: artifact.id,
      });
      if (recordedClaims.length && deps.memoryIndex) {
        try {
          await deps.memoryIndex.upsertClaims(run.projectId, recordedClaims);
        } catch (error) {
          console.warn(`[foundation-memory] Qdrant 索引失败，PostgreSQL 真源已保留：${(error as Error).message}`);
        }
      }
      await creativeAttachArtifact(deps.repository, input.workItemId, artifact.id);
      return artifact;
    },

    reviewFoundationWork: async (input: {
      runId: string;
      workItemId: string;
      candidateStartIndex?: number;
    }): Promise<{ kind: "completed"; review: CreativeReview } | { kind: "external"; task: ModelTaskRecord }> => {
      const work = await creativeGetWorkItem(deps.repository, input.workItemId);
      if (!work) throw new Error(`CreativeWorkItem 不存在：${input.workItemId}`);
      const artifactId = work.artifactRefs.at(-1);
      if (!artifactId) throw new Error(`Foundation work item 尚无 artifact：${input.workItemId}`);
      const artifact = await deps.repository.getArtifact(artifactId);
      if (!artifact) throw new Error(`Foundation artifact 不存在：${artifactId}`);
      const existing = (await creativeListReviews(deps.repository, input.workItemId)).find((review) => review.subjectArtifactId === artifact.id);
      if (existing) return { kind: "completed", review: existing };
      const run = await getCreativeRun(deps.repository, input.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${input.runId}`);
      const project = await deps.repository.getProjectDetail(run.projectId);
      const prompt = buildFoundationReviewPrompt({
        taskKey: work.taskKey ?? "",
        artifact,
        premise: typeof project.metadata?.premise === "string" ? project.metadata.premise : undefined,
        genre: typeof project.metadata?.genre === "string" ? project.metadata.genre : undefined,
      });
      const system = "你是独立的长篇小说 Foundation 规划审核编辑。只输出审核结论文本，不输出 JSON 或 Schema。";
      const skills = await resolveCurrentSkills({ projectId: run.projectId, executionPoint: "foundation.book-plan", role: "foundation-reviewer" });
      const routingSnapshot = model.getRoutingSnapshot();
      const taskId = `${input.workItemId}:foundation-review:${artifact.id}`;
      const promptPackage = compileSinglePrompt({ projectId: run.projectId, workflowId: input.runId, purpose: "review.foundation", stage: "review", system, prompt, reservedOutputTokens: 4096, provenanceRefs: [input.workItemId, artifact.id], skillBundle: skills, skillExecutionPoint: "foundation.book-plan" });
      try {
        const generated = await model.generateText({
          purpose: "review.foundation",
          system,
          prompt: promptPackage.instruction,
          workflowRunId: input.runId,
          taskId,
          routingSnapshot,
          candidateStartIndex: input.candidateStartIndex,
          promptContext: promptPackage.manifest,
        });
        const result = parseTextReview(generated.text);
        await makeArtifact({
          projectId: run.projectId,
          taskId: `${input.workItemId}:foundation-review`,
          kind: "review",
          baseRevision: artifact.baseRevision,
          text: JSON.stringify(result, null, 2),
          structuredData: { ...result, subjectArtifactId: artifact.id, artifactFingerprint: artifact.fingerprint, workflowId: input.runId },
        });
        const review: CreativeReview = await creativeSubmitReview(deps.repository, input.workItemId, {
          subjectArtifactId: artifact.id,
          reviewer: "independent",
          verdict: result.verdict,
          issues: result.verdict === "revise" ? [opinionToReviewIssue(result.opinion, artifact.fingerprint)] : [],
          summary: result.opinion,
        });
        return { kind: "completed", review };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return {
          kind: "external",
          task: await externalTask({
            workflowId: input.runId,
            taskId,
            purpose: "review.foundation",
            candidateIndex: error.candidateIndex,
            routingSnapshot,
            outputKind: "review",
            system,
            instruction: promptPackage.instruction,
            baseRevision: artifact.baseRevision,
            contextRefs: { workItemId: input.workItemId, artifactId: artifact.id, taskKey: work.taskKey },
            promptContext: promptPackage.manifest,
          }),
        };
      }
    },

    materializeExternalFoundationReview: async (input: { modelTaskId: string; workItemId: string; value: unknown }): Promise<CreativeReview> => {
      const task = await deps.repository.getModelTask(input.modelTaskId);
      if (!task) throw new Error(`外部 foundation 审核任务不存在：${input.modelTaskId}`);
      const work = await creativeGetWorkItem(deps.repository, input.workItemId);
      if (!work) throw new Error(`CreativeWorkItem 不存在：${input.workItemId}`);
      const artifactId = work.artifactRefs.at(-1);
      if (!artifactId) throw new Error(`Foundation work item 尚无 artifact：${input.workItemId}`);
      const artifact = await deps.repository.getArtifact(artifactId);
      if (!artifact) throw new Error(`Foundation artifact 不存在：${artifactId}`);
      const rawText = extractReviewText(input.value);
      const result = parseTextReview(rawText);
      const run = await getCreativeRun(deps.repository, work.runId);
      if (!run) throw new Error(`CreativeRun 不存在：${work.runId}`);
      await makeArtifact({
        projectId: run.projectId,
        taskId: `${input.workItemId}:foundation-review`,
        kind: "review",
        baseRevision: artifact.baseRevision,
        text: JSON.stringify(result, null, 2),
        structuredData: { ...result, subjectArtifactId: artifact.id, artifactFingerprint: artifact.fingerprint, workflowId: task.workflowRunId, externalModelTaskId: task.id },
      });
      return creativeSubmitReview(deps.repository, input.workItemId, {
        subjectArtifactId: artifactId,
        reviewer: "independent",
        verdict: result.verdict,
        issues: result.verdict === "revise" ? [opinionToReviewIssue(result.opinion, artifact.fingerprint)] : [],
        summary: result.opinion,
      });
    },
  };

  const loadRecord = async <T>(table: "memory_bundles" | "skill_bundles" | "execution_blueprints", id: string, label: string): Promise<T> => {
    const value = await deps.repository.getRecord(table, id);
    if (!value) throw new Error(`${label}不存在：${id}`);
    return value as T;
  };
  const loadArtifactText = async (artifactId: string): Promise<{ artifact: Artifact; text: string }> => {
    const artifact = await deps.repository.getArtifact(artifactId);
    if (!artifact) throw new Error(`产物不存在：${artifactId}`);
    if (!artifact.objectKey) throw new Error(`产物缺少正文对象：${artifactId}`);
    return { artifact, text: await objects.getText(artifact.objectKey) };
  };
  const assertReviewMemoryCutoff = (memory: MemoryBundle): void => {
    if (typeof memory.narrativeCutoff !== "number") return;
    const futureClaims = memory.claims.filter((claim) => !isMemoryClaimVisibleAtCutoff(claim, memory.narrativeCutoff));
    if (futureClaims.length) {
      throw new Error(`review-memory-cutoff-violation: cutoff=${memory.narrativeCutoff} claims=${futureClaims.map((claim) => claim.id).join(",")}`);
    }
  };

  return {
    ...api,
    draftByRefs: async (input: { workflowId: string; intent: NovelIntent; blueprintId: string; memoryBundleId: string; skillBundleId: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; foundationArtifactIds?: string[] }): Promise<GeneratedTextResult> => {
      const [blueprint, memory, skills] = await Promise.all([
        loadRecord<ExecutionBlueprint>("execution_blueprints", input.blueprintId, "执行蓝图"),
        loadRecord<MemoryBundle>("memory_bundles", input.memoryBundleId, "记忆包"),
        loadRecord<SkillBundle>("skill_bundles", input.skillBundleId, "技能包"),
      ]);
      const requestedFoundationIds = input.foundationArtifactIds ?? [];
      const resolvedFoundationArtifacts = await Promise.all(requestedFoundationIds.map((id) => deps.repository.getArtifact(id)));
      const missingFoundationIds = requestedFoundationIds.filter((_, index) => !resolvedFoundationArtifacts[index]);
      if (missingFoundationIds.length) throw new Error(`冻结的全书规划产物不存在：${missingFoundationIds.join(",")}`);
      const foundationArtifacts = resolvedFoundationArtifacts as Artifact[];
      const planningContext = await deps.repository.getChapterPlanningContextSnapshot(blueprint.id);
      return api.draft({ ...input, blueprint, memory, skills, foundationArtifacts, planningContext });
    },
    reviewByRefs: async (input: { workflowId: string; artifactId: string; blueprintId: string; memoryBundleId: string; skillBundleId: string; role: ReviewerRole; identity: "internal" | "independent"; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; narrativeOrder?: number; suppressChapterSnapshotPromotion?: boolean }): Promise<GeneratedReviewResult> => {
      const [{ artifact, text }, blueprint, memory, skills] = await Promise.all([
        loadArtifactText(input.artifactId),
        loadRecord<ExecutionBlueprint>("execution_blueprints", input.blueprintId, "执行蓝图"),
        loadRecord<MemoryBundle>("memory_bundles", input.memoryBundleId, "记忆包"),
        loadRecord<SkillBundle>("skill_bundles", input.skillBundleId, "技能包"),
      ]);
      assertReviewMemoryCutoff(memory);
      const planningContext = await deps.repository.getChapterPlanningContextSnapshot(blueprint.id);
      return api.review({ ...input, artifact, text, blueprint, memory, skills, planningContext });
    },
    reviseByRefs: async (input: { workflowId: string; intent: NovelIntent; artifactId: string; reviewIds: string[]; directedIssues?: ReviewIssue[]; strictRevisionWindows?: boolean; authorInstruction?: string; blueprintId: string; memoryBundleId: string; skillBundleId: string; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; revisionHistory?: RevisionAttempt[] }): Promise<GeneratedTextResult> => {
      const [{ artifact, text }, reviews, blueprint, memory, skills] = await Promise.all([
        loadArtifactText(input.artifactId),
        deps.repository.getReviewsByIds(input.reviewIds),
        loadRecord<ExecutionBlueprint>("execution_blueprints", input.blueprintId, "执行蓝图"),
        loadRecord<MemoryBundle>("memory_bundles", input.memoryBundleId, "记忆包"),
        loadRecord<SkillBundle>("skill_bundles", input.skillBundleId, "技能包"),
      ]);
      assertReviewMemoryCutoff(memory);
      const planningContext = await deps.repository.getChapterPlanningContextSnapshot(blueprint.id);
      return api.revise({ ...input, artifact, text, reviews, blueprint, memory, skills, planningContext });
    },
  };
}
