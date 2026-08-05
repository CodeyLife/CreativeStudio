import type { Artifact, MemoryClaim, SkillBundle, SkillResolutionManifest } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import { chapterStateDeltaSchema, type ChapterStateDelta, type FactExtractionModelOutput, type FactExtractionOutput } from "../prompts/schemas";
import { buildFactExtractionPrompt } from "./prompt";
import { dedupeFactCandidates } from "./dedupe";
import { classifyFactCandidates } from "./classify";
import { compileStageContext } from "../stage-context";
import { canonicalSha256 } from "../canonical-json";
import { scopeClaimsToChapter } from "./narrative-scope";
import { buildSkillContextSections } from "../skill-runtime";

/**
 * V2 事实提取编排函数。
 *
 * 流程：
 * 1. 用 model.generateStructured 让 LLM 从正文中提取结构化事实
 * 2. 用 dedupeFactCandidates 做去重与校验（11 类失败覆盖）
 * 3. 用 classifyFactCandidates 投影为 MemoryClaim + 风险等级
 * 4. 返回 MemoryClaim 列表（不含 risk，由 recordFactExtraction 决定写入路径）
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific examples」——
 * 本模块只做编排，去重/分类规则在 dedupe.ts/classify.ts 中独立维护。
 */

export interface ExtractFactsInput {
  projectId: string;
  artifact: Artifact;
  text: string;
  model: ModelGateway;
  existingClaimsDigest?: string;
  /** 已存在记忆的 contentHash 集合（用于 novelty=duplicate 判断） */
  existingContentHashes?: Set<string>;
  /**
   * P0-A1: 按 `${subject.id}|${predicate}` 映射到旧 claim id 列表。
   * 由上游从数据库查询构建，用于 novelty=update 时填充 supersedes 字段。
   * 让 retrieval 层屏蔽被覆盖的旧版本，避免 LLM 看到自相矛盾的事实。
   */
  existingClaimsIndex?: Map<string, string[]>;
  /** 当前叙事截止点可见的开放伏笔/承诺，用于兑现时建立精确关联。 */
  openNarrativeElements?: {
    foreshadowings: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string }>;
    promises: Array<{ id: string; promiser: string; promisee: string; statement: string }>;
  };
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
  /** 正文所属章节的叙事顺序；章节事实必须以此为时间边界，不能使用段落号。 */
  narrativeOrder?: number;
  /**
   * 可选,激活的 skill bundle(注入到 fact-extraction prompt)。
   *
   * 设计依据:让 v1 迁移的 fact-delta-extraction skill 的 promptSections
   * 真正进入 LLM,而非死载荷。对齐 foundation/draft/review/revise 的 skill 注入。
   */
  skills?: Array<{ skillId: string; promptSections: Partial<Record<string, string>> }>;
  /** 新调用方使用 bundle，让 Skill section 与 resolution manifest 在同一编译层对账。 */
  skillBundle?: SkillBundle;
  /** 当前 fact-extraction Skill manifest；模型调用前由运行时重新解析。 */
  skillManifest?: SkillResolutionManifest;
}

export interface ExtractFactsResult {
  claims: MemoryClaim[];
  /**
   * Phase 3.1 叙事元素（伏笔/承诺/兑现）。
   *
   * 由 LLM 在 fact-extraction 阶段一并提取，由 activity 层调用
   * repository.recordNarrativeElements 写入对应表；没有对应内容时使用空数组。
   */
  narrativeElements: FactExtractionOutput["narrativeElements"];
  stats: {
    totalCandidates: number;
    kept: number;
    discardedDuplicate: number;
    discardedLowConfidence: number;
    discardedShortEvidence: number;
    discardedInvalidSubject: number;
    discardedInvalidObject: number;
    discardedExistingHash: number;
  };
}

/**
 * 从章节正文中提取结构化事实并投影为 MemoryClaim 列表。
 *
 * 不写入数据库——数据库写入由 postgres-repository.recordFactExtraction 负责。
 * 本函数只做"提取 + 去重 + 分类"，返回 MemoryClaim 列表给上游。
 */
export async function extractFactsFromText(input: ExtractFactsInput): Promise<MemoryClaim[]> {
  const result = await extractFactsWithStats(input);
  return result.claims;
}

/**
 * 与 extractFactsFromText 等价，但返回详细统计信息（用于日志与监控）。
 */
export async function extractFactsWithStats(input: ExtractFactsInput): Promise<ExtractFactsResult> {
  const prompt = buildFactExtractionPrompt({
    artifact: input.artifact,
    text: input.text,
    existingClaimsDigest: input.existingClaimsDigest,
    openNarrativeElements: input.openNarrativeElements,
  });
  const system = "你是事实提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的事实，不提取隐喻、修辞或读者推断。";
  const skillSections = buildSkillContextSections({ skills: input.skillBundle?.skills ?? input.skills ?? [] }, "chapter.fact-extraction", "事实提取 Skill");
  const promptPackage = compileStageContext({ projectId: input.projectId, workflowId: input.workflowRunId ?? input.artifact.taskId, purpose: "facts.extract", stage: "fact-extraction", system, schema: chapterStateDeltaSchema as unknown as Record<string, unknown>, maxInputTokens: 128_000, reservedOutputTokens: 8_192, skillManifest: input.skillBundle?.resolution ?? input.skillManifest, sections: [{ id: "chapter-state-delta", kind: "manuscript", title: "状态提取任务与章节正文", text: prompt, priority: "critical", provenanceRefs: [input.artifact.id] }, ...skillSections] });

  const generated = await input.model.generateStructured<FactExtractionModelOutput>({
    purpose: "facts.extract",
    system,
    prompt: promptPackage.instruction,
    schema: chapterStateDeltaSchema as unknown as Record<string, unknown>,
    schemaName: "chapter-state-delta",
    routingSnapshot: input.routingSnapshot,
    candidateStartIndex: input.candidateStartIndex,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    promptContext: promptPackage.manifest,
  });

  return projectFactExtractionOutput(input, generated.value);
}

function decodeFactObjectValue(kind: string, value: string): unknown {
  if (kind !== "number" && kind !== "boolean" && kind !== "json") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function normalizeFactExtractionOutput(output: FactExtractionModelOutput | ChapterStateDelta): ChapterStateDelta {
  const source = output as FactExtractionModelOutput;
  return {
    facts: source.facts.map((fact) => ({
      ...fact,
      object: { ...fact.object, value: decodeFactObjectValue(fact.object.kind, fact.object.value) },
    })),
    narrativeElements: {
      foreshadowings: source.narrativeElements.foreshadowings,
      promises: source.narrativeElements.promises,
      payoffs: source.narrativeElements.payoffs.map((payoff) => ({
        ...payoff,
        matchedTriggerKeywords: payoff.matchedTriggerKeywords?.length ? payoff.matchedTriggerKeywords : undefined,
        matchedForeshadowingIds: payoff.matchedForeshadowingIds?.length ? payoff.matchedForeshadowingIds : undefined,
        matchedPromiseId: payoff.matchedPromiseId || undefined,
        matchedPromiser: payoff.matchedPromiser || undefined,
        intensity: payoff.intensity > 0 ? payoff.intensity : undefined,
      })),
    },
  };
}

export function projectFactExtractionOutput(input: Omit<ExtractFactsInput, "model">, output: FactExtractionModelOutput | ChapterStateDelta): ExtractFactsResult {
  const normalized = normalizeFactExtractionOutput(output);
  const deduped = dedupeFactCandidates({
    candidates: normalized.facts,
    existingContentHashes: input.existingContentHashes,
  });

  // P0-A1: 构建 existingClaimIndex 让 classifyFactCandidates 在 novelty=update 时填充 supersedes
  // 设计依据：AGENTS.md「root-cause analysis」——supersedes 必须按 subject.id+predicate 匹配旧 claim id，
  // 让 retrieval 层屏蔽被覆盖的旧版本，避免 LLM 看到自相矛盾的事实。
  const existingClaimIndex = input.existingClaimsIndex ?? new Map<string, string[]>();

  const classified = classifyFactCandidates({
    facts: deduped.kept,
    projectId: input.projectId,
    artifactId: input.artifact.id,
    baseRevision: input.artifact.baseRevision,
    existingClaimIndex,
  });

  const projectedClaims = classified.map((item) => item.claim);
  const claims = input.narrativeOrder === undefined
    ? projectedClaims
    : scopeClaimsToChapter(projectedClaims, input.narrativeOrder);

  return {
    claims,
    // Phase 3.1: 透传 narrativeElements 给 activity 层，由其调用 recordNarrativeElements
    narrativeElements: normalized.narrativeElements,
    stats: {
      totalCandidates: deduped.totalCandidates,
      kept: deduped.kept.length,
      discardedDuplicate: deduped.discardedDuplicateCount,
      discardedLowConfidence: deduped.discardedLowConfidenceCount,
      discardedShortEvidence: deduped.discardedShortEvidenceCount,
      discardedInvalidSubject: deduped.discardedInvalidSubjectCount,
      discardedInvalidObject: deduped.discardedInvalidObjectCount,
      discardedExistingHash: deduped.discardedExistingHashCount,
    },
  };
}

/**
 * 重新计算 contentHash（用于上游 recordFactExtraction 二次校验）。
 *
 * 与 classify.ts 中的 hashContent 算法一致，但用 node:crypto sha256，
 * 确保与 postgres-repository 的 contentHash 列长度匹配。
 */
export function computeClaimContentHash(claim: MemoryClaim): string {
  return canonicalSha256({
    subjectRefs: [...claim.subjectRefs].sort(),
    predicate: claim.predicate ?? null,
    knowledgeScope: claim.knowledgeScope,
    content: claim.content.normalize("NFKC").trim().replace(/\s+/gu, " "),
  });
}
