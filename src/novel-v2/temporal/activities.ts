import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, ChapterChangeScope, ContextManifest, CreativeReview, CreativeRun, CreativeWorkItem, ExecutionBlueprint, MemoryBundle, MemoryClaim, MemoryHit, MemoryProvider, NovelIntent, PreflightPlan, PreflightProjectSnapshot, PromptContextManifest, Review, ReviewIssue, RuntimeLearningAssessmentV2, SkillBundle, SkillExecutionPoint, SkillProvider, StageContextSection, StageGoalContract, TaskAttemptRecord } from "../protocol";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, computeTokenBudget, createPreflightPlan, isMemoryClaimVisibleAtCutoff, matchedFacetsOf } from "../cognition";
import { canonicalSha256 } from "../canonical-json";
import { withAssetSpans } from "../application/serial-context-assets";
import { NovelPostgresRepository } from "../postgres-repository";
import type { WorkflowRunStatus } from "../run-lifecycle";
import { estimateBudgetTokens } from "../token-estimate";
import type { ModelGateway } from "../model-gateway";
import { ExternalMcpRequiredError, type ModelExecutionProvenance, type ModelPurpose, type ModelRoutingSnapshot, type ModelTaskRecord, type ModelWorkPackage } from "../model-routing";
import { ContentObjectStore } from "../object-store";
import { assertStoryArcBatchWindow, normalizeStoryArcRebaseBundle, parseStoryArcBundle, storyArcBatchWindow, validateChapterExecutionContract, validateStoryArcExecutionContracts, validateStoryArcRebaseBundle, type ChapterPlanningContext, type StoryArcBundle } from "../application/story-arc";
import { extractChapterEnding, extractChapterOpening, inspectManuscript, structuralReviewFromReport, type ManuscriptStructuralReport } from "../application/manuscript-structure";
import { sourceRevisionIdsOf } from "../memory-visibility";
import { summarizeDormancy, type DormancyLedger } from "../narrative-dormancy";
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
import { buildFactRetrievalPlan, capDirectionPinnedClaims } from "../fact-retrieval";
import { enrichCharactersFromChapter, loadCharacterIdentityRegistry, parseCharacterEnrichmentOutput } from "../character-enrichment";
import { uniqueCharacterIdentities, type CharacterIdentityIndex } from "../character-identity";
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
import { writeMemoryIndexWithTrace } from "../memory-index-drift";
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

/**
 * 检出"系统自造的主体名"（2026-10-14 复核轮 round 59/60/64/65）。
 *
 * 根因（round 59/60 实测，生产库 166 个主体里 **33 个**在正文 0 次出现）：
 * 提取模型把两个分别出现的词拼成了小说里不存在的称呼——`灰衣杂役`
 * （正文"灰衣"3 次、"杂役"335 次、合称 0 次）、`补发房抄写人`、`城南看物屋` 等。
 * 后果：检索会按假名字返回结果，且假名字进入召回面后污染后续召回。
 *
 * round 59/60 已在提取 prompt 里禁止该形态（"不得由多个词拼合而成" +
 * "描述性短语不要当 subject.id"），但 prompt 约束不保证旧数据与新模型都遵守，
 * 故这里兜一道运行时检测。
 *
 * **判定（round 65 修正切分口径）**：主体整串不在本章正文、且**存在一个长度 ≥2 的
 * 真前缀出现在正文** ⇒ 报。这条判据是两种形态的并集，而并集恰好退化成"前缀在正文"：
 *   - **可拼型**：存在一种前后切分，两段都在正文（`灰衣杂役` ← 灰衣 + 杂役）；
 *   - **前缀型**：某个真前缀在正文、而剩余部分作为整体不在正文
 *     （`补发房抄写人` ← "补发房抄"在正文，"写人"不在 ⇒ 仍是拼出来的称呼）。
 *   尾部在不在正文不改变结果（尾部命中即前者、不命中即后者，二者穷尽），故实现只有
 *   一个循环。首版真正漏掉的不是"某一类"而是**切分口径**：只查"两段都在"时不查前缀，
 *   于是"补发房抄"在正文而"写人"不在的那条整条被跳过。
 *   round 65 实测：未覆盖的 5 个里有 2 个属此前漏掉的前缀型，
 *   且它们是**更严重**的整串幻觉。
 *
 * **故意不报**：整串不在、且所有片段也都不在正文的（`城南看物屋`、`屋内人`、
 * `挑水人`）——它们完全没出处，属更严重的一类，但判定需要语义（可能真是
 * 系统该新建的实体名），不该由检测器自动判，留给人核。
 *
 * 只检测不删除：订正主体要逐条判"该人物在正文的实际称呼"，属半语义工作
 * （round 58/60 的结论：需要人核的部分不硬自动化）。调用方负责留痕。
 *
 * 导出以便直接单测（round 26 的教训：模块私有 ⇒ 测试只能复刻逻辑 ⇒ 锁不住真源）。
 */
export function detectCoinedSubjects(claims: ReadonlyArray<{ subjectRefs?: readonly string[] }>, chapterText: string): string[] {
  const subjects = [...new Set(claims.flatMap((claim) => [...(claim.subjectRefs ?? [])]))];
  return subjects.filter((subject) => {
    // 防御：subjectRefs 里可能混入非字符串（历史数据/外部构造），不得让检测器崩。
    if (typeof subject !== "string" || subject.length < 3) return false;
    // 机器生成的键形态（character:/foundation:/facet:…）不参与——它们本就非正文指称。
    if (/^(?:character|foundation|facet|claim|memory|graph):/u.test(subject)) return false;
    if (chapterText.includes(subject)) return false;

    // 判据：**存在一个长度 ≥2 的真前缀出现在正文**。
    //
    // 两个子形态的并集恰好退化成这一个条件：某个 cut 上前缀命中时，尾部命中属
    // 「可拼型」、不命中属「前缀型」，二者穷尽。故尾部无需再查——首版写成两个循环
    // 并在注释里声称 ② 覆盖了 ① 漏掉的一类，实际 ① 在尾部不命中时本就不成立，
    // ② 是它的补集而非额外覆盖（2026-10-16 复核轮）。
    for (let cut = 2; cut <= subject.length - 2; cut += 1) {
      if (chapterText.includes(subject.slice(0, cut))) return true;
    }
    return false;
  });
}

export function createNovelWorkflowActivities(deps: { repository: NovelPostgresRepository; memoryProvider: MemoryProvider; skillProvider: SkillProvider; modelGateway: ModelGateway; objectStore?: ContentObjectStore; commitService?: CommitService; memoryIndex?: MemoryIndex; /** 是否启用 chapter memory 创建（默认 true，需 modelGateway 支持）。 */ enableChapterMemory?: boolean }) {
  const model = deps.modelGateway;
  const objects = deps.objectStore ?? new ContentObjectStore();
  // 线索静默账按 projectId 记忆化：一次工作流内定稿集不变，结果相同，而扫描全书
  // 正文代价高（弧规划/蓝图/审核三处都要用）。null 表示"已试算且无结果"，与
  // "未试算"（undefined）区分，避免失败后每处重试。
  const narrativeDormancyCache = new Map<string, DormancyLedger | null>();
  /** 前章开头缓存（与 narrativeDormancyCache 同形：null 为"已试算且不可得"哨兵）。 */
  const priorOpeningsCache = new Map<string, string[] | null>();
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
  /**
   * 项目题材缓存（2026-10-14 复核轮 round 17）。
   *
   * 为什么需要：`applicableGenres` 是软偏好（题材无关的 skill 永远入选），但**题材已知时**
   * 它才起作用。此前生产路径的 11 个 `resolveCurrentSkills` 调用点**一个都不传 genre**，
   * 于是题材匹配在生产上从未生效——结合当时"未传题材即排除"的兜底，任何声明了
   * `applicableGenres` 的 skill（学习闭环晋升出来的题材规则就会这样）都永不生效。
   * 项目题材本来就在 `project.metadata.genre`（foundation 提示词已在使用），这里按
   * 与其它 loader 相同的方式缓存，避免每章每阶段重复读项目行。
   * null 为"已试算且无题材"哨兵。
   */
  const projectGenreCache = new Map<string, string | null>();

  const loadProjectGenre = async (projectId: string): Promise<string | undefined> => {
    const cached = projectGenreCache.get(projectId);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const project = await deps.repository.getProjectDetail(projectId);
      const genre = typeof project?.metadata?.genre === "string" ? project.metadata.genre : null;
      projectGenreCache.set(projectId, genre);
      return genre ?? undefined;
    } catch (error) {
      // 不写哨兵：失败多为瞬时（DB 抖动），下次调用重试；题材拿不到时软偏好不排除任何技能。
      console.warn(`[skills] 项目题材读取失败，题材匹配本次不生效：${(error as Error).message}`);
      return undefined;
    }
  };
  const resolveCurrentSkills = async (input: { projectId: string; executionPoint: SkillExecutionPoint; role?: string; memory?: MemoryBundle; preflightId?: string; genre?: string; requestedCapabilities?: string[] }) => resolveStageSkillBundle({
    projectId: input.projectId,
    provider: deps.skillProvider,
    executionPoint: input.executionPoint,
    role: input.role,
    memory: input.memory,
    preflightId: input.preflightId,
    // 显式传入优先；未传时回落到项目题材（题材匹配是软偏好，拿不到就不排除任何技能）。
    genre: input.genre ?? await loadProjectGenre(input.projectId),
    requestedCapabilities: input.requestedCapabilities,
  });
  /**
   * 线索静默账加载（P1 2026-09-18）：扫本书全部定稿章正文，判定每条 open 伏笔
   * 是"从未再被提及 / 曾活跃现已静默 / 仍在推进"。
   *
   * 设计依据：AGENTS.md「在拥有错误行为的最低共享层修复」——旧口径把
   * `parsePayoffWindow` 的窗口上界当死线报"超期"，实测 244 条里 238 条仍在活跃
   * 推进（见 docs/novel-v2/p1-foreshadowing-survey-20260918.md）；真正需要行动的
   * 信号是"曾活跃→近 N 章消失"，而这个判定必须看全量正文，只有本活动有对象存储。
   * 失败软降级返回 undefined（不注入该段），与 loadPriorChapterEndings 同型。
   *
   * 按 projectId + 定稿末章序记忆化：同一定稿集内结果相同（弧规划/蓝图/审核三处都要用，
   * 重复扫描全书正文代价过高），而定稿集一旦推进静默账就变——只按 projectId 记忆化会把
   * 上一章算出的"末次提及"一路复用到全书结束，故键必须含 currentOrder。
   * null 为"已试算且无结果"哨兵。
   */
  const loadNarrativeDormancy = async (projectId: string): Promise<DormancyLedger | undefined> => {
    if (typeof deps.repository.listFinalChapterContentRefs !== "function" || typeof deps.repository.listOpenForeshadowingPresenceInputs !== "function") return undefined;
    try {
      const [refs, items] = await Promise.all([
        deps.repository.listFinalChapterContentRefs(projectId),
        deps.repository.listOpenForeshadowingPresenceInputs(projectId),
      ]);
      if (!refs.length || !items.length) return undefined;
      const currentOrder = refs[refs.length - 1]!.narrativeOrder;
      const cacheKey = `${projectId}:${currentOrder}`;
      const cached = narrativeDormancyCache.get(cacheKey);
      if (cached !== undefined) return cached ?? undefined;
      const chapterTexts: Array<{ narrativeOrder: number; text: string }> = [];
      for (const ref of refs) {
        try {
          chapterTexts.push({ narrativeOrder: ref.narrativeOrder, text: await objects.getText(ref.objectKey) });
        } catch (error) {
          console.warn(`[dormancy] 第 ${ref.narrativeOrder} 章正文读取失败（跳过该章）：${(error as Error).message}`);
        }
      }
      // 缺章会让"末次提及"失真——漏读的章可能正是末次出现处，会把仍在推进的线
      // 误判为静默。此时宁可不产出账，也不产出偏高的静默数。
      if (chapterTexts.length < refs.length) {
        console.warn(`[dormancy] 有 ${refs.length - chapterTexts.length} 章正文不可得，静默账本次不产出（避免失真）`);
        narrativeDormancyCache.set(cacheKey, null);
        return undefined;
      }
      const ledger = summarizeDormancy(items, chapterTexts, currentOrder);
      narrativeDormancyCache.set(cacheKey, ledger);
      return ledger;
    } catch (error) {
      // 不写哨兵：此处拿不到 cacheKey（失败可能发生在取定稿集之前），且失败多为瞬时
      // （对象存储/DB 抖动），下次调用重试即可，不该把一次抖动固化成"无账"。
      console.warn(`[dormancy] 线索静默扫描失败，该通道本次不注入：${(error as Error).message}`);
      return undefined;
    }
  };

  /**
   * 前两章的开头首段（供起手轮换契约跨批判定用）。
   *
   * 为什么需要（2026-10-14 复核轮 round 11/12）：起手轮换契约的 run 判据
   * （"不得有连续三章以同一槽位序列起头"）此前**只在本批次内**生效，而生产批次是
   * 7 章一弧（实测弧6=35-42 / 弧7=43-49）——全书唯一的真实 run（ch41-43）恰好跨在
   * 弧6/弧7 边界上，两条批次限定判据都看不见它。**门一直在，对全书唯一的病灶失明。**
   *
   * 修法照搬章末仪式化的既有形态：跨章判据由调用方喂入前章语境
   * （`ENDING_RITUAL_POLICY` 的 `priorEndings` 走同一条路）。这里只取首段而非全章
   * （`extractChapterOpening` 是取段口径的唯一来源），故成本约两句话。
   *
   * 失败/缺章一律返回 undefined（契约退回批次内措辞），不编造前章语境——
   * 宁可不跨批判定，也不给规划器一个假的前章开头。
   */
  const loadPriorChapterOpenings = async (projectId: string, count = 2): Promise<string[] | undefined> => {
    if (typeof deps.repository.listFinalChapterContentRefs !== "function") return undefined;
    try {
      const refs = await deps.repository.listFinalChapterContentRefs(projectId);
      if (refs.length < count) return undefined;
      const cacheKey = `${projectId}:${refs[refs.length - 1]!.narrativeOrder}:${count}`;
      const cached = priorOpeningsCache.get(cacheKey);
      if (cached !== undefined) return cached ?? undefined;
      const tail = refs.slice(-count);
      const openings: string[] = [];
      for (const ref of tail) {
        try {
          openings.push(extractChapterOpening(await objects.getText(ref.objectKey)));
        } catch (error) {
          console.warn(`[opening] 第 ${ref.narrativeOrder} 章正文读取失败，起手跨批判定本次不产出：${(error as Error).message}`);
          priorOpeningsCache.set(cacheKey, null);
          return undefined;
        }
      }
      priorOpeningsCache.set(cacheKey, openings);
      return openings;
    } catch (error) {
      console.warn(`[opening] 前章开头读取失败，起手跨批判定本次不产出：${(error as Error).message}`);
      return undefined;
    }
  };
  // CommitService 自动注入 chapter memory 依赖（若未提供 commitService 且未显式禁用）
  // 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约
  const enableChapterMemory = deps.enableChapterMemory ?? true;
  const commitService = deps.commitService ?? new CommitService(deps.repository, objects, enableChapterMemory ? { model, memoryIndex: deps.memoryIndex } : undefined);
  /**
   * 加载人物身份注册上下文（memory-governance-audit-20260909 §5.1.1）。
   *
   * 供 fact-extraction 与 chapter-state-rebuild 注入：prompt 带规范人物名册 +
   * 提取结果经同一索引归一。注册表读取失败不阻塞提取——缺失时保持既有行为
   * （主体 ID 由模型自由生成），降级只影响新写入行的键一致性，不产生错误数据。
   */
  const loadExtractionIdentityContext = async (projectId: string): Promise<{ identityIndex: CharacterIdentityIndex; canonicalCharacters: Array<{ canonicalId: string; displayName: string }> } | undefined> => {
    try {
      const registry = await loadCharacterIdentityRegistry(projectId, deps.repository);
      return {
        identityIndex: registry.index,
        canonicalCharacters: uniqueCharacterIdentities(registry.index)
          .filter((identity) => identity.status === "identified")
          .map((identity) => ({ canonicalId: identity.canonicalId, displayName: identity.displayName })),
      };
    } catch (error) {
      console.warn(`[fact-extraction] 人物身份注册表加载失败，本次提取退回无归一模式：${(error as Error).message}`);
      return undefined;
    }
  };
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
    // SK-3 候选聚合：LLM 判定与排队候选同机制时走聚合通道（证据挂到既有候选）；
    // 聚合被状态守卫拒绝（幻觉 id/已出队）时回退新建——证据宁可重复不可丢失。
    const aggregateTo = recorded.candidate?.aggregateToCandidateId;
    if (aggregateTo) {
      const aggregated = await deps.repository.aggregateCraftRuleCandidateLearning({ projectId: recorded.projectId, candidateId: aggregateTo, assessmentId: recorded.id });
      if (aggregated) return recorded;
      console.warn(`[learning] 聚合目标 ${aggregateTo} 不在排队队列，回退为新建候选`);
    }
    const candidateInput = buildCraftRuleCandidateInput(recorded);
    if (candidateInput) await createCraftRuleCandidate(deps.repository, candidateInput);
    // SK-3 关闭通道：learning 运行时顺带扫描停滞无证据的排队候选并发 stale 事件
    // （随提交自然节拍触发，无独立调度器）；扫描失败不影响本次学习落库。
    await deps.repository.detectStaleCraftRuleCandidates?.(recorded.projectId, { nowMs: Date.now() }).catch((error: unknown) => {
      console.warn(`[learning] 停滞候选扫描失败（本次跳过）：${(error as Error).message}`);
      return [];
    });
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
  /**
   * 跨章序列证据装载（draft/review/revision/learning 四面的**唯一**生产者）。
   *
   * 资产数量账本在这里回填：repository 取不到正文（无对象存储访问权），而回填若
   * 只挂在审校路径上，正文与修订侧的对照指令就永远拿到空账本（2026-09-19 实测的
   * 断链）。回填后必须重算指纹——prompt 渲染的是新内容，指纹不得停在旧内容。
   * 失败一律降级为"无资产对照"，不阻塞装载。
   */
  const loadSerialContext = async (projectId: string, documentId: string, narrativeCutoff: number) => {
    if (typeof deps.repository.getSerialContextSnapshot !== "function") return undefined;
    let snapshot;
    try {
      snapshot = await deps.repository.getSerialContextSnapshot(projectId, documentId, narrativeCutoff);
    } catch (error) {
      console.warn(`[serial-context] 跨章序列证据快照加载失败，继续使用既有记忆：${(error as Error).message}`);
      return undefined;
    }
    if (!snapshot) return undefined;
    return withAssetSpans(snapshot, projectId, {
      getChapterContentRefs: (id, orders) => deps.repository.getChapterContentRefsByOrders(id, orders),
      getText: (key) => objects.getText(key),
      onDegrade: (reason) => console.warn(`[asset-ledger] 资产数量扫描失败，降级为无资产对照：${reason}`),
    });
  };
  // TODO P2: 修订 temperature 应可配置——当前 0.3 是创作多样性与指令遵循的折中值，
  // 未来应由 model routing 配置或 blueprint budget 决定，而非硬编码。
  const REVISION_TEMPERATURE = 0.3;
  const api = {
    updateWorkflowStatus: (input: { workflowId: string; status: WorkflowRunStatus; payload?: Record<string, unknown> }) => deps.repository.updateWorkflowRunStatus(input.workflowId, input.status, input.payload),
    recordWorkflowSignal: (input: { workflowId: string; taskId: string; signal: string; payload?: Record<string, unknown> }) => deps.repository.recordTaskSignal(input),
    updateTaskAttempt: (input: { id: string; workflowRunId?: string; taskId: string; status: TaskAttemptRecord["status"]; payload?: Record<string, unknown> }) => deps.repository.upsertTaskAttempt(input),
    loadProjectSnapshot: (input: { projectId: string; targetDocumentId?: string }) => deps.repository.getProjectSnapshot(input.projectId, input.targetDocumentId),
    createPreflight: async (input: { intent: NovelIntent; snapshot: PreflightProjectSnapshot }) => {
      // E4 语义守卫在 createPreflightPlan 纯函数层（全入口共用，双向测试在
      // change-scope.test）；此处不重复第二判据。
      return createPreflightPlan(input.intent, input.snapshot);
    },
    retrieveMemory: async (input: { projectId: string; plan: PreflightPlan }): Promise<MemoryBundle> => {
      const repairedFoundationClaims = await deps.repository.ensureFoundationMemoryClaims(input.projectId);
      if (repairedFoundationClaims.length && deps.memoryIndex) {
        // 不阻塞 + 留痕走共享包膜（§8.6 的第六处，由站点级扫描锁查出——文件级断言漏了它）。
        // 这一处的后果最直接：`ensureFoundationMemoryClaims` 是规划事实的**补偿性补写**，
        // 补写成功而索引没写上，等于补偿没发生，且此后每次检索都看不到这批规划约束。
        await writeMemoryIndexWithTrace({
          projectId: input.projectId,
          aggregateId: input.projectId,
          projectionType: "memory-index:foundation-memory-repair",
          rowIds: repairedFoundationClaims.map((claim) => claim.id),
          write: () => deps.memoryIndex!.upsertClaims(input.projectId, repairedFoundationClaims),
          record: (failure) => deps.repository.recordProjectionFailure(failure),
        });
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
              sourceRevisionIds: sourceRevisionIdsOf(replaced.revisionId),
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
      //
      // 只注入"不在近期在场"的伏笔：线索静默账（narrative-dormancy）把每条 open 伏笔判为
      // 从未再被提及 / 曾活跃现已静默 / 仍在推进 / 无法判定，本通道取前三类。
      // 实测依据（docs/novel-v2/state-audit-20261013.md §4.1 与 §4.6）：整本 open 账无条件
      // 注入占记忆预算的 71.3%（425 条 / 69,845 token），把真事实层挤出预算（真事实 token
      // 在第 60 章达峰后崩落一个数量级）。按静默账过滤后，注入集与"生产静默账 atRisk ∩
      // cutoff 内候选"完全相等（79 条 / 12,138 token，71.3% → 12.4%），腾出的预算足以让
      // 此前因 budget 落选的真事实与章记忆全部进来。仍在推进的线交给检索与预算竞价，
      // 不再无条件强注。
      // 静默账不可得时（全书正文未读全或读取失败）不注入：无判定即全量注入正是被修的缺陷。
      if (typeof input.plan.narrativeCutoff === "number") {
        try {
          const { foreshadowings, promises } = await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.plan.narrativeCutoff);
          const dormancy = await loadNarrativeDormancy(input.projectId);
          const atRisk = dormancy ? new Set(dormancy.atRiskIds) : undefined;
          const dormantForeshadowings = atRisk ? foreshadowings.filter((f) => atRisk.has(f.id)) : [];
          if (!atRisk) {
            console.warn(`[memory] 线索静默账不可得，跳过开放伏笔注入（${foreshadowings.length} 条）：没有静默判定就注入等于把整本 open 账压进记忆预算`);
          }
          // score 0 / semanticRank 0：这些条目不是检索命中，没有相关度证据，在 ranked-fill 里
          // 排到证据排序的候选之后，绝不抢在它们之前占预算。线索连续性由 required facet 的
          // 章节记忆（每章 unresolvedThreads + 20 章 rollup 汇总，上限 80 条）兜底，本通道
          // 只是"预算还宽裕时的提醒"，被淘汰不等于线索丢失。
          openNarrativeHits = [
            ...dormantForeshadowings.map((f) => ({
              id: f.id,
              projectId: input.projectId,
              kind: "working" as const,
              title: `未兑现伏笔：${f.description.slice(0, 40)}`,
              content: `伏笔内容：${f.description}\n触发关键词：${f.triggerKeywords.join("、")}\n预期兑现：${f.expectedPayoffWindow}${f.readerQuestion ? `\n读者问题：${f.readerQuestion}` : ""}${f.possiblePayoffs?.length ? `\n可行兑现方向：${f.possiblePayoffs.join("、")}` : ""}${f.meaningDelta ? `\n意义增量：${f.meaningDelta}` : ""}${f.cost ? `\n代价：${f.cost}` : ""}\n埋设于：${f.plantedRevisionId}`,
              subjectRefs: [],
              knowledgeScope: "author" as const,
              authority: "derived" as const,
              confidence: 0.9,
              sourceRevisionIds: sourceRevisionIdsOf(f.plantedRevisionId),
              contentHash: f.id,
              supersedes: [],
              score: 0,
              matchedFacet: "foreshadowing",
              matchedFacets: ["foreshadowing"],
              reason: "open-foreshadowing-injection",
              semanticRank: 0,
            })),
            // 承诺不按静默过滤：静默账只登记伏笔（foreshadowing）的触发关键词，承诺没有
            // 可比信号；且全库 open 承诺实测仅 15 条 / 约 1K token，不构成预算风险。
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
              sourceRevisionIds: sourceRevisionIdsOf(p.sourceRevisionId),
              contentHash: p.id,
              supersedes: [],
              score: 0,
              matchedFacet: "foreshadowing",
              matchedFacets: ["foreshadowing"],
              reason: "open-promise-injection",
              semanticRank: 0,
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
      // 方向驱动事实检索（improvement-plan-fact-injection-20260922 迭代 1）：
      // 把"本章要写什么方向"翻译成强制注入的冻结断言。020/021/024 类硬矛盾的根因
      // 是相关冻结断言在预算竞价中落选、模型凭记忆重写；这里从结构化源（蓝图场景
      // 参与者 + 弧线程责任）派生定向 facet，命中经 cutoff/生命周期过滤后作为
      // pinnedClaims 注入——即使预算竞价落选也强制在场。任何失败都降级为无方向
      // 强注，不阻塞检索主链。
      let directionHits: MemoryHit[] = [];
      if ((input.plan.taskClass === "drafting" || input.plan.taskClass === "revision") && input.plan.targetDocumentId) {
        try {
          // allowHistorical=true：只读蓝图做 facet 派生，不重复工作流侧的弧新鲜度门
          // （该门由 loadChapterPlanningContext 在 compileBlueprint 前照常执行）。
          const planning = await deps.repository.getChapterPlanningContext(input.projectId, input.plan.targetDocumentId, true);
          const factPlan = buildFactRetrievalPlan({ chapterBlueprint: planning.chapter, threadResponsibilities: planning.arc.threadResponsibilities });
          for (const warning of factPlan.enhancementWarnings) console.warn(`[fact-retrieval] ${warning}`);
          if (factPlan.facets.length) {
            const hits = await deps.memoryProvider.search({ projectId: input.projectId, facets: factPlan.facets, narrativeCutoff: input.plan.narrativeCutoff, povCharacterId: input.plan.povCharacterId });
            directionHits = capDirectionPinnedClaims(
              hits.filter((hit) => hit.lifecycleStatus !== "staged" && isMemoryClaimVisibleAtCutoff(hit, input.plan.narrativeCutoff)),
            );
          }
        } catch (error) {
          console.warn(`[fact-retrieval] 方向事实检索失败，降级为无方向强注：${(error as Error).message}`);
        }
      }
      const bundle = await buildMemoryBundle(input.plan, { projectId: input.projectId, provider: deps.memoryProvider, tokenBudget, pinnedClaims: [...narrativeHits, ...directionHits], additionalClaims: [...openNarrativeHits, ...styleContractHits] });
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
      // 候选积压 facet（FM-2）：轻量聚合查询随 blueprint 落库，供编排者可见；失败不阻断编译。
      let factCandidateBacklog: { pending: number; oldestPendingDays: number | null } | undefined;
      try {
        const backlog = await deps.repository.getFactCandidateBacklog(input.intent.projectId);
        factCandidateBacklog = { pending: backlog.totalPending, oldestPendingDays: backlog.oldestPendingDays };
      } catch (error) {
        console.warn("[compileBlueprint] 候选积压统计失败（不阻断）：", error);
      }
      const blueprint = compileExecutionBlueprint(input.intent, input.plan, input.memory, input.skills, input.snapshot, context, input.foundationArtifacts, input.planningContext, factCandidateBacklog);
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
    // POV 残留扫描的显示名解析（P4 残留登记项）：蓝图 povCharacterId 是登记 id，
    // 正文出现的是显示名——不换算会把视角人物自己的内心戏误标为"他人残留"。
    resolveCharacterDisplayNames: (input: { projectId: string; refs: string[] }) => deps.repository.resolveCharacterDisplayNames(input.projectId, input.refs),
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
          ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: generated.value, currentText: input.text }),
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
    inspectManuscript: async (input: { projectId: string; artifact: Artifact; text: string; priorEndings?: string[] }) => {
      const stopReason = typeof input.artifact.structuredData?.stopReason === "string" ? input.artifact.structuredData.stopReason : undefined;
      const report = inspectManuscript({ text: input.text, stopReason, priorEndings: input.priorEndings });
      const review = structuralReviewFromReport(input.projectId, input.artifact, report);
      await deps.repository.putReview(review, { refreshChapterSnapshot: false });
      return { report, review };
    },
    /**
     * 跨章语境加载（2026-09-18 全书精修 P0）：取本章之前最近 N 章的结尾末段正文，
     * 供 manuscript.ending-ritual 判据做跨章重复度测量。
     *
     * 设计依据：AGENTS.md「在拥有错误行为的最低共享层修复」——单章门对"留白收尾"
     * 与"口癖收尾"形态相同、无法区分，只有把前章末段喂进判据才有跨章证据。
     * 失败时不阻断生成（返回空数组，通道不触发），与 loadSerialContext 同型软降级。
     */
    loadPriorChapterEndings: async (input: { projectId: string; narrativeOrder?: number; count: number }): Promise<string[]> => {
      // narrativeOrder 缺失（如项目级任务）时无"前章"概念，该通道不适用——
      // 与 runEnrichCharacters 的 narrativeOrder 缺失语义一致。
      if (input.narrativeOrder === undefined) return [];
      if (typeof deps.repository.getPriorChapterEndings !== "function") return [];
      try {
        const objectKeys = await deps.repository.getPriorChapterEndings({ projectId: input.projectId, narrativeOrder: input.narrativeOrder, count: input.count });
        const endings: string[] = [];
        for (const key of objectKeys) {
          try {
            const text = await objects.getText(key);
            const ending = extractChapterEnding(text);
            if (ending) endings.push(ending);
          } catch (error) {
            console.warn(`[ending-ritual] 前章末段读取失败（跳过该章）：${(error as Error).message}`);
          }
        }
        return endings;
      } catch (error) {
        console.warn(`[ending-ritual] 跨章结尾语境加载失败，该通道本次不触发：${(error as Error).message}`);
        return [];
      }
    },
    /**
     * 线索静默账（P1 2026-09-18）：扫本书全部定稿章正文，判定每条 open 伏笔
     * 是"从未再被提及 / 曾活跃现已静默 / 仍在推进"。见 loadNarrativeDormancy 定义。
     */
    loadNarrativeDormancy: async (input: { projectId: string }): Promise<DormancyLedger | undefined> => loadNarrativeDormancy(input.projectId),

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
      // 的新值不会追溯生效）。此处统一提升下限（模型上下文支持 128K），
      // 新 blueprint 的预算若更大则取其值。
      // 96K→112K（弧14 ch92 实证 97.2K）→118K（弧17 ch114 实证 112.3K 顶穿旧下限：
      // memory 面随章数/开放伏笔自然增长，该下限约每 25 章被顶穿一次）。
      // 118K→128K（弧18 ch125 生成实证 118.8K 顶穿：118K+预留已不够）。取 fact-extraction/
      // learning 阶段同模型已实证的 128K 为对齐值——这是本窗口的**最后一次抬升**：
      // 128K+预留=窗内顶格，再被顶穿时正解是给 revision 的 reviews/skills/memory 分段设
      // 独立预算（压缩记忆注入而非继续抬数字），不得再原地加数。
      // TODO: 该下限仍是魔法值，应迁入 model-routing profile 的 revisionMinInputTokens 配置。
      const revisionMaxInputTokens = Math.max(input.blueprint.budget.maxInputTokens, 128_000);
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
      // 分段预算（2026-09-16 ch126 v3 顶穿 133.7K 兑现承诺，停止抬总闸）：修订轮的
      // 记忆包按 30K 字符独立预算截断（修订者主看正文+问题+规划上下文，全量记忆是
      // 草稿期需求）；修订历史只保留近 3 轮（更早轮次的教训已凝固进当轮意见）。
      // 两处截断都是阶段输入构造，不动冻结事实与问题清单本身。
      const memoryHits = (input.memory as unknown as { hits?: Array<{ content: string }> } | undefined)?.hits;
      const revisionMemory = input.memory && Array.isArray(memoryHits)
        ? (() => {
            let used = 0;
            const kept: Array<{ content: string }> = [];
            for (const hit of memoryHits) {
              used += hit.content?.length ?? 0;
              // 12K 上限（ch129 顶穿 135.5K 二次实证后自 30K 收紧）：召回全复活+账本
              // 增长使辅助记忆位成为 revision 段主要超载源——修订主料是正文+问题+
              // 规划上下文，记忆仅作一致性护栏，按相关度前 12K 字符保留。
              if (used > 8_000) break;
              kept.push(hit);
            }
            return { ...input.memory, hits: kept } as typeof input.memory;
          })()
        : input.memory;
      const revisionHistory = Array.isArray(input.revisionHistory) ? input.revisionHistory.slice(-3) : input.revisionHistory;
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
        memory: revisionMemory,
        skills: input.skills,
        planningContext: input.planningContext,
        authorInstruction: input.authorInstruction,
        revisionHistory,
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
              memory: revisionMemory,
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
          const windowPackage = buildRevisionWindowPromptPackage({ projectId: input.intent.projectId, workflowId: input.workflowId, system, goal: stageGoal, maxInputTokens: revisionMaxInputTokens, maxOutputTokens: Math.min(4096, Math.max(1024, source.length * 2)), text: input.text, window, memory: revisionMemory, skills: input.skills, planningContext: input.planningContext, authorInstruction: input.authorInstruction, revisionHistory: input.revisionHistory });
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
                memory: revisionMemory,
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
              memory: revisionMemory,
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
          memory: revisionMemory,
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
      // 与内部审校路径（plainText: input.text）对齐：外部路径从被审 artifact 的
      // objectKey 解析正文——既供证据软校验落库标记，也供 toReview 的摘录在场性
      // 机械门禁（陈旧复读丢弃）；存储不可用时两处一并降级为不判定。
      let plainText: string | undefined;
      if (input.artifact.objectKey) {
        try { plainText = await objects.getText(input.artifact.objectKey); } catch { plainText = undefined; }
      }
      const review = { ...toReview({ artifact: input.artifact, identity: input.identity, role: input.role, output: input.value as ReviewerOutput, currentText: plainText }), modelProvenance: { routeSnapshotId: task.configRevision, purpose: task.purpose, candidateIndex: task.candidateIndex, executor: "external-mcp" as const, model: "external-mcp", promptFingerprint: task.workPackage.inputFingerprint, skillBundleId: task.workPackage.contextRefs.skillBundleId, skillBundleFingerprint: task.workPackage.contextRefs.skillBundleFingerprint, contextManifestId: task.workPackage.contextRefs.contextManifestId } };
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
        const identityContext = await loadExtractionIdentityContext(input.projectId);
        // Phase 3.1: 提取 claims 与正文修订派生数据；派生数据等待 commit 取得真实 revisionId 后落库。
        const result = await extractFactsWithStats({ projectId: input.projectId, artifact: factArtifact, text: input.text, model, existingClaimsDigest: extractionContext.claimsDigest, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex, existingValueHashById: extractionContext.valueHashById, openNarrativeElements, narrativeOrder: input.narrativeOrder, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, workflowRunId: input.workflowId, taskId: `${input.artifact.taskId}:facts:model`, skillBundle: currentSkills, identityIndex: identityContext?.identityIndex, canonicalCharacters: identityContext?.canonicalCharacters });
        if (result.verification.contradictions.length) {
          // 确定性矛盾核验命中（迭代 2）：冲突候选已强制 candidate，不进检索面；
          // 此处留痕 + 随 factArtifact.structuredData 上浮供审批/审计面消费。
          console.warn(`[fact-verification] ${result.verification.contradictions.length} 条新事实与冻结表同槽异值且未声明覆盖，已强制候选待裁决：${result.verification.contradictions.map((item) => item.claimId).join("、")}`);
        }
        // 自造主体检测（2026-10-14 round 59/60/64）：prompt 已禁止"拼合/描述性短语作 subject.id"，
        // 但 prompt 约束不保证旧数据与新模型都遵守——这里按 round 59 的特征信号兜一道：
        //   主体整串不在正文、而拆开的两段都在 ⇒ 系统把两个词拼成了一个小说里不存在的称呼。
        // 只报不删：删主体要逐条判"该人物在正文的实际称呼"，属半语义工作（round 58/60 结论）。
        // 实测规模：生产库 166 个主体里 33 个正文 0 次（拼合 28 + 整串幻觉 5），
        // 其中 `灰衣杂役`（灰衣 3 次 + 杂役 335 次、合称 0 次）涉及 3 条 claim。
        const coinedSubjects = detectCoinedSubjects(result.claims, input.text);
        if (coinedSubjects.length) {
          console.warn(`[fact-extraction] 检出 ${coinedSubjects.length} 个疑似自造主体（整串不在正文但拆开可拼）：${coinedSubjects.join("、")}——请核对这些称呼是否小说实际使用，必要时订正主体（round 59/60 已在 prompt 侧禁止该形态）`);
        }
        // 提取审计落盘（2026-10-14 round 66）：此前矛盾核验/自造主体/丢弃统计**只打 console.warn**，
        // 而 artifact 在提取前就建好（只带 sourceArtifactId）⇒ 这些痕迹随日志一起消失，
        // 事后无法回答"这一章提取消遇了多少条、为何判 candidate"。此处把它们并进
        // artifact.structuredData 再落库，与既有 `verification` 字段同一处（审批/审计面可读）。
        const factArtifactWithAudit: Artifact = {
          ...factArtifact,
          structuredData: {
            ...factArtifact.structuredData,
            sourceArtifactId: input.artifact.id,
            verification: result.verification,
            stats: result.stats,
            coinedSubjects,
          },
        };
        await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: factArtifactWithAudit, claims: result.claims, lifecycleStatus: "staged", documentId: input.documentId, workflowId: input.workflowId, narrativeOrder: input.narrativeOrder });
        // 名册外主体登记（§3.6）：prompt 已向模型承诺"由系统登记为待补全实体"，此处兑现。
        // 登记失败不阻塞事实落库——键一致性是后续收益，不是本章产出的前置条件。
        if (result.unregisteredSubjects.length) {
          try {
            const registered = await deps.repository.registerPendingSubjects({ projectId: input.projectId, subjects: result.unregisteredSubjects, narrativeOrder: input.narrativeOrder, source: "fact-extraction" });
            if (registered) console.info(`[fact-extraction] 登记 ${registered} 个名册外主体为待补全实体（候选 ${result.unregisteredSubjects.length} 个）：${result.unregisteredSubjects.map((subject) => subject.id).join("、")}`);
          } catch (error) {
            console.warn(`[fact-extraction] 名册外主体登记失败（不阻塞）：${(error as Error).message}`);
          }
        }
        return { kind: "completed", artifact: { ...factArtifact, structuredData: { ...factArtifact.structuredData, narrativeElements: result.narrativeElements, verification: result.verification } } };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const extractionContext = await deps.repository.getFactExtractionContext(input.projectId, input.narrativeOrder === undefined ? undefined : input.narrativeOrder - 1);
        const openNarrativeElements = input.narrativeOrder === undefined
          ? undefined
          : await deps.repository.getOpenForeshadowingAndPromises(input.projectId, input.narrativeOrder - 1).catch(() => undefined);
        const identityContext = await loadExtractionIdentityContext(input.projectId);
        const prompt = buildFactExtractionPrompt({ artifact: factArtifact, text: input.text, existingClaimsDigest: extractionContext.claimsDigest, openNarrativeElements, canonicalCharacters: identityContext?.canonicalCharacters });
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
      const identityContext = await loadExtractionIdentityContext(input.projectId);
      const projected = projectFactExtractionOutput({ projectId: input.projectId, artifact: input.artifact, text: input.text, existingClaimsDigest: extractionContext.claimsDigest, existingContentHashes: extractionContext.contentHashes, existingClaimsIndex: extractionContext.claimsIndex, existingValueHashById: extractionContext.valueHashById, narrativeOrder: input.narrativeOrder, identityIndex: identityContext?.identityIndex }, task.result!.value as ChapterStateDelta);
      await deps.repository.recordFactExtraction({ projectId: input.projectId, artifact: input.artifact, claims: projected.claims, lifecycleStatus: "staged", documentId: input.documentId, workflowId: task.workflowRunId, narrativeOrder: input.narrativeOrder });
      // 名册外主体登记（§3.6）：外部 MCP 提取路径与内部路径共用同一出口归一，
      // 因此也必须共用同一登记动作，否则两条路径的键一致性会分叉。
      if (projected.unregisteredSubjects.length) {
        try {
          const registered = await deps.repository.registerPendingSubjects({ projectId: input.projectId, subjects: projected.unregisteredSubjects, narrativeOrder: input.narrativeOrder, source: "fact-extraction-external" });
          if (registered) console.info(`[fact-extraction] 登记 ${registered} 个名册外主体为待补全实体（候选 ${projected.unregisteredSubjects.length} 个）：${projected.unregisteredSubjects.map((subject) => subject.id).join("、")}`);
        } catch (error) {
          console.warn(`[fact-extraction] 名册外主体登记失败（不阻塞）：${(error as Error).message}`);
        }
      }
      return { ...input.artifact, structuredData: { ...input.artifact.structuredData, narrativeElements: projected.narrativeElements, verification: projected.verification } };
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
      // SK-3 候选聚合：把未晋升候选队列投影给 LLM（同机制改进引用既有 id 聚合，
      // 不再新建重复候选）。查询失败不阻断 learning——聚合是抑重复的增益通道。
      const pendingCandidates = await deps.repository.listPendingCraftRuleCandidates?.(input.projectId).catch((error: unknown) => {
        console.warn(`[learning] 排队候选投影加载失败，本次评估不带队列摘要：${(error as Error).message}`);
        return undefined;
      });
      const learningEvidence = { serialContext, recentIssueClusters, plainText, pendingCandidates };
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
      const pendingCandidates = await deps.repository.listPendingCraftRuleCandidates?.(input.projectId).catch(() => undefined);
      try {
        const { assessment, validationError } = await assessRuntimeLearningWithModel({ projectId: input.projectId, workflowId: input.workflowId, artifact: input.artifact, reviews: [review], model, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, availableSkills, pendingCandidates, skillBundle: learningSkills });
        return { kind: "completed", assessment: await recordLearning(validationError ? { ...assessment, validationError } : assessment) };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        const learningIssues = reviewIssuesForLearning([review]);
        if (!learningIssues.length) throw error;
        const system = "你是长篇小说 Runtime 的学习闭环审计员，只在能说明底层机制和影响输入类时提出可复用规则改进。";
        const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "learning.assess", stage: "review", system, prompt: buildRuntimeLearningPrompt({ artifact: input.artifact, reviews: [review], availableSkills, pendingCandidates }), schema: runtimeLearningAssessmentSchema, reservedOutputTokens: 4_096, provenanceRefs: [input.artifact.id, input.reviewArtifact.id], skillBundle: learningSkills, skillExecutionPoint: "learning.assessment" });
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
    commit: async (input: { projectId: string; documentId: string; artifact: Artifact; factArtifact?: Artifact; narrativeOrder?: number; text: string; reviews: Review[]; structuralReport: ManuscriptStructuralReport; baseRevision: number; idempotencyKey: string; changeScope?: ChapterChangeScope }) => {
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
        // 不阻塞 + 留痕走共享包膜（state-audit §8.6 的第三处）。此处只 warn 的代价最隐蔽：
        // 裁决已经生效（库里 authority 已是 approved），但向量索引没有对应点 ⇒ 该事实
        // 从此不出现在任何语义召回里，而所有查询都显示它已被批准。
        await writeMemoryIndexWithTrace({
          projectId: input.projectId,
          aggregateId: input.ids.join(","),
          projectionType: "memory-index:fact-approval",
          rowIds: active.map((claim) => claim.id),
          write: () => deps.memoryIndex!.upsertClaims(input.projectId, active),
          record: (failure) => deps.repository.recordProjectionFailure(failure),
        });
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
      // Evidence 闭环校验·消费时：把当前正文传给 repository，让过报/陈旧意见
      // （证据已不在正文中）带上 [evidence-stale] 标记进入修订与审批链路。
      let plainText: string | undefined;
      try {
        const content = await deps.repository.getFinalDocumentContentRef(input.projectId, input.documentId);
        plainText = content?.objectKey ? await objects.getText(content.objectKey) : undefined;
      } catch {
        plainText = undefined; // 取不到正文时跳过标记（软校验不阻塞审校启动）
      }
      return deps.repository.getTargetedChapterReviewIssues({ ...input, plainText });
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
        tokenCost: estimateBudgetTokens(`${claim.title}\n${claim.content}`),
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
      // 读取面坐标归一（弧6 恢复环实证）：蓝图 artifact 的 batch 坐标是模型自报 echo（首弧常写
      // 局部 1 基），批次行坐标是系统派生事实；窗口契约只管写侧，重审/修订经本读取口回来时两套
      // 坐标系打架（重基线守卫与投影对账各信一边）。同"系统可推导事实不留裁量权"族：读入即对齐批次行。
      const arcRow = await deps.repository.getStoryArc(input.projectId, input.arcId);
      const batchRow = arcRow?.batches?.find((batch) => batch.sourceArtifactId === input.artifactId) ?? (arcRow?.batches?.length === 1 ? arcRow.batches[0] : undefined);
      if (batchRow) {
        bundle.batch = { ...bundle.batch, batchIndex: batchRow.batchIndex, startChapterIndex: batchRow.startChapterIndex, complete: batchRow.complete };
      }
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
      const skills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "chapter.title", role: "planner" });
      const system = "你是中文长篇小说的章节命名编辑。标题必须忠实于本章独特内容，优先简练的四字中文，但不以牺牲准确性换取字数整齐。";
      const routingSnapshot = model.getRoutingSnapshot();
      const promptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.foundation", stage: "foundation", system, prompt, schema: CHAPTER_TITLE_SCHEMA as unknown as Record<string, unknown>, reservedOutputTokens: 300, provenanceRefs: [input.documentId, input.sourceFingerprint], skillBundle: skills, skillExecutionPoint: "chapter.title" });
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
      // 线索静默账（P1）：与 planning 一并取，供弧规划/审核/修订三面看到
      // "曾活跃现已静默"的线索。取不到（无定稿/正文不可得）时该段不注入。
      const planning = { ...(await deps.repository.getStoryArcPlanningInput(input.projectId, input.arcId)), narrativeDormancy: await loadNarrativeDormancy(input.projectId), priorChapterOpenings: await loadPriorChapterOpenings(input.projectId) };
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

      // 批次窗口=系统分配事实（弧内剩余章数按上限截断；重基线走自己的逐章目标
      // 契约）。新弧无既有投影 ⇒ planned=0 ⇒ 窗口=全弧期望章数；expected 缺失
      // （旧弧形态）⇒ window=0 ⇒ 生成面契约与校验面守卫双跳过（零回归）。
      const batchWindow = !rebaseTarget ? storyArcBatchWindow({ expectedChapterCount: plan.arc.expectedChapterCount, plannedBeforeInArc: arc?.chapters.length ?? 0 }) : 0;
      // SK-5/C5：章节蓝图段消费 chapter.blueprint 执行点（蓝图契约 skill 的真实消费者），
      // 弧结构段留在 arc.plan——此前两段共用 arc.plan，蓝图指引反被标题任务占用。
      const chapterSkills = await resolveCurrentSkills({ projectId: input.projectId, executionPoint: "chapter.blueprint", role: "planner" });
      const chapterPromptPackage = compileSinglePrompt({ projectId: input.projectId, workflowId: input.workflowId, purpose: "planning.arc", stage: "planning", system, prompt: buildStoryArcChaptersPrompt({ ...planning, authorIntent: input.authorIntent, arc: plan.arc, batch: plan.batch, ...(batchWindow ? { windowChapters: batchWindow } : {}) }, rebaseTarget), schema: storyArcChaptersOutputSchema as unknown as Record<string, unknown>, reservedOutputTokens: 10_000, provenanceRefs: [input.arcId, "segment:chapters"], skillBundle: chapterSkills, skillExecutionPoint: "chapter.blueprint" });
      try {
        const generatedChapters = await model.generateStructured<StoryArcChaptersOutput>({ purpose: "planning.arc", system, prompt: chapterPromptPackage.instruction, schema: storyArcChaptersOutputSchema as unknown as Record<string, unknown>, schemaName: "story-arc-chapters", maxTokens: 10_000, workflowRunId: input.workflowId, taskId: `${input.arcId}:story-arc:chapters`, routingSnapshot: input.routingSnapshot, candidateStartIndex: input.candidateStartIndex, promptContext: chapterPromptPackage.manifest });
        let bundle = parseStoryArcBundle({ ...plan, chapters: generatedChapters.value.chapters });
        validateStoryArcExecutionContracts(bundle);
        if (rebaseTarget) {
          bundle = normalizeStoryArcRebaseBundle(bundle, rebaseTarget);
          validateStoryArcRebaseBundle(bundle, rebaseTarget);
        }
        if (batchWindow) assertStoryArcBatchWindow({ expectedChapterCount: plan.arc.expectedChapterCount, plannedBeforeInArc: arc?.chapters.length ?? 0, chaptersCount: bundle.chapters.length });
        if (input.batchIndex && (bundle.batch.batchIndex !== input.batchIndex || bundle.batch.startChapterIndex !== input.startChapterIndex)) throw new Error("生成结果的故事弧批次位置与请求不一致");
        const artifact = await makeArtifact({ projectId: input.projectId, taskId: `${input.arcId}:story-arc`, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: input.workflowId, arcId: input.arcId, ...(planning.plotOutline ? { plotOutline: planning.plotOutline } : {}), modelProvenance: { plan: planProvenance, chapters: generatedChapters.provenance } } });
        return { kind: "completed", artifact, bundle };
      } catch (error) {
        if (!(error instanceof ExternalMcpRequiredError)) throw error;
        return { kind: "external", task: await externalTask({ workflowId: input.workflowId, taskId: `${input.arcId}:story-arc:chapters`, purpose: "planning.arc", candidateIndex: error.candidateIndex, routingSnapshot: input.routingSnapshot, outputKind: "structured", system, instruction: chapterPromptPackage.instruction, schema: storyArcChaptersOutputSchema as unknown as Record<string, unknown>, schemaName: "story-arc-chapters", baseRevision: 0, contextRefs: { arcId: input.arcId, skillBundleId: chapterSkills.id, outputSegment: "chapters", segmentIndex: "2", segmentCount: "2", arcJson: JSON.stringify(plan.arc), batchJson: JSON.stringify(plan.batch), outlineJson: JSON.stringify(planning.plotOutline ?? null) }, promptContext: chapterPromptPackage.manifest }) };
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
      // 外部物化与内部生成同守卫：窗口是系统分配事实，提交方同样无裁量权。
      // expected 取 bundle 自身（外部 plan 段可能尚未回写弧行），planned 取弧上
      // 已投影章行（本批未投影，天然排除）。
      if (!rebaseTarget) {
        const arcRecord = await deps.repository.getStoryArc(input.projectId, input.arcId);
        if (arcRecord) assertStoryArcBatchWindow({ expectedChapterCount: bundle.arc.expectedChapterCount, plannedBeforeInArc: arcRecord.chapters.length, chaptersCount: bundle.chapters.length });
      }
      const artifact = await makeArtifact({ projectId: input.projectId, taskId: task.taskId, kind: "chapter-blueprint", baseRevision: 0, text: JSON.stringify(bundle, null, 2), structuredData: { ...bundle, workflowId: task.workflowRunId, arcId: input.arcId, externalModelTaskId: task.id, ...(plotOutline ? { plotOutline } : {}) } });
      return { artifact, bundle };
    },

    projectStoryArcBundle: async (input: { projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; actor: string; edited?: boolean }) => deps.repository.projectStoryArcBundle(input),

    reviewStoryArcBundle: async (input: { workflowId: string; projectId: string; arcId: string; artifact: Artifact; bundle: StoryArcBundle; routingSnapshot: ModelRoutingSnapshot; candidateStartIndex?: number; rebase?: boolean }): Promise<GeneratedStoryArcReviewResult> => {
      // 线索静默账（P1）：与 planning 一并取，供弧规划/审核/修订三面看到
      // "曾活跃现已静默"的线索。取不到（无定稿/正文不可得）时该段不注入。
      const planning = { ...(await deps.repository.getStoryArcPlanningInput(input.projectId, input.arcId)), narrativeDormancy: await loadNarrativeDormancy(input.projectId), priorChapterOpenings: await loadPriorChapterOpenings(input.projectId) };
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
      // 线索静默账（P1）：与 planning 一并取，供弧规划/审核/修订三面看到
      // "曾活跃现已静默"的线索。取不到（无定稿/正文不可得）时该段不注入。
      const planning = { ...(await deps.repository.getStoryArcPlanningInput(input.projectId, input.arcId)), narrativeDormancy: await loadNarrativeDormancy(input.projectId), priorChapterOpenings: await loadPriorChapterOpenings(input.projectId) };
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
        // 窗口不变量（非重基线）：修订是对候选批次窗口的修复，不是重新分配——
        // 章数必须与候选一致，否则修订成为静默缩窗通道。
        if (!rebaseTarget && bundle.chapters.length !== input.bundle.chapters.length) {
          throw new Error(`故事弧修订必须保持候选批次的章节窗口（${input.bundle.chapters.length} 章），本次输出 ${bundle.chapters.length} 章`);
        }
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
              // taskKey 缺失是**契约缺口**，不能按空 taskKey 放行：
              // foundation-contract 的未知 taskKey 现在直接抛错（round 44），
              // 空串会让"未知阶段"被当成"契约满足"——正是 PL-8 要防的静默放行。
              if (!work.taskKey) return [`Foundation taskKey 缺失，无法执行契约校验（workItemId=${input.workItemId}）`];
              normalizedValue = normalizeFoundationModelOutput(value as unknown, work.taskKey);
            } catch (error) {
              return [`structuredData 无法解析为对象：${error instanceof Error ? error.message : String(error)}`];
            }
            return validateFoundationTaskContract(normalizedValue as FoundationOutput, work.taskKey);
          },
        });
        // taskKey 缺失同样不能按空串放行（round 44）：契约层的未知 taskKey 现在直接抛错。
        if (!work.taskKey) throw new Error(`Foundation taskKey 缺失，无法生成规划产物（workItemId=${input.workItemId}）`);
        const normalizedFoundation = normalizeFoundationModelOutput(generated.value, work.taskKey);
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
        // recordFoundationClaim：同 taskKey 只有最新代际投影保持 active（supersedes 其余
        // active 投影），更早代际回填按 staged 落库——修复全部历史 Foundation 投影常驻
        // 检索竞争的问题（memory-governance-audit-20260909 §M4/§5.3.1）。
        const recordedClaims = await deps.repository.recordFoundationClaim({
          projectId: run.projectId,
          claim: foundationClaim,
          sourceArtifactId: artifact.id,
        });
        if (recordedClaims.length && deps.memoryIndex) {
          // 不阻塞 + 留痕走共享包膜（state-audit §8.6 第四/第五处，两处 foundation-memory
          // 同形）。规划事实只落库没进索引 ⇒ 后续章节的事实召回永久看不到这一条规划约束，
          // 而规划面查询显示它已在库里。
          await writeMemoryIndexWithTrace({
            projectId: run.projectId,
            aggregateId: artifact.id,
            projectionType: "memory-index:foundation-memory",
            rowIds: recordedClaims.map((claim) => claim.id),
            write: () => deps.memoryIndex!.upsertClaims(run.projectId, recordedClaims),
            record: (failure) => deps.repository.recordProjectionFailure(failure),
          });
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
      // taskKey 缺失不能按空串放行（round 44）：契约层的未知 taskKey 现在直接抛错，
      // 空串会让"未知阶段"被当成"契约满足"。本条是**外部结果入口**（外部编排写入
      // foundation 产物），静默放行的后果比生成路径更重——未校验的外部产物会直接进库。
      if (!work.taskKey) throw new Error(`Foundation taskKey 缺失，无法校验外部结果（workItemId=${input.workItemId}）`);
      const taskSchema = foundationSchemaForTask(work.taskKey);
      assertStructuredSchema(input.value, taskSchema, "外部 foundation 结果");
      const normalizedFoundation = normalizeFoundationModelOutput(input.value, work.taskKey);
      assertFoundationTaskContract(normalizedFoundation, work.taskKey);

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
      // 与内部生成路径同一退役契约（memory-governance-audit-20260909 §5.3.1）。
      const recordedClaims = await deps.repository.recordFoundationClaim({
        projectId: run.projectId,
        claim: foundationClaim,
        sourceArtifactId: artifact.id,
      });
      if (recordedClaims.length && deps.memoryIndex) {
        // 同上一处 foundation-memory：不阻塞 + 留痕（state-audit §8.6 第五处）。
        await writeMemoryIndexWithTrace({
          projectId: run.projectId,
          aggregateId: artifact.id,
          projectionType: "memory-index:foundation-memory",
          rowIds: recordedClaims.map((claim) => claim.id),
          write: () => deps.memoryIndex!.upsertClaims(run.projectId, recordedClaims),
          record: (failure) => deps.repository.recordProjectionFailure(failure),
        });
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
