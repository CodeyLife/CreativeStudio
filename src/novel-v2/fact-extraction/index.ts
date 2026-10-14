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
import type { CharacterIdentityIndex } from "../character-identity";

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
  /**
   * 确定性矛盾核验的取值指纹索引（improvement-plan-fact-injection-20260922 迭代 2）：
   * 冻结 claim id → value_hash，与 existingClaimsIndex 同源（getFactExtractionContext）。
   * 提供时 classify 层对值槽谓词做同槽异值对账，矛盾候选强制 candidate（不进检索面）。
   */
  existingValueHashById?: Map<string, string | undefined>;
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
  /**
   * 人物身份注册索引（memory-governance-audit-20260909 §5.1.1）。
   *
   * 提供时：① prompt 注入"规范人物名册"，要求已注册人物必须用规范 ID 作 subject.id；
   * ② 提取结果在哈希计算之前经同一索引做主体归一（显示名/实体名等别名命中才重写，
   * 未命中键原样保留——不发明第三种键形态），使批内指纹去重、跨章 identity 槽位与
   * subject_refs 消费方（知识边界过滤/图检索/资产对照）全部对齐同一键空间。
   * 缺省时保持既有行为（主体 ID 由模型自由生成）。
   */
  identityIndex?: CharacterIdentityIndex;
  /** 随 prompt 注入的规范人物名册；与 identityIndex 同源，由调用方从注册表投影。 */
  canonicalCharacters?: Array<{ canonicalId: string; displayName: string }>;
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
  /**
   * 待登记主体（§3.6 主体碎片治理）：未命中身份注册表、且 kind 属于可登记集的 subject 键。
   *
   * 可登记集**只有 `character`**（判据见下方 `REGISTRABLE_SUBJECT_KINDS` 的说明）——
   * 身份注册表只解析人物键，把 `entity` 一并登记会让地点/物件混进角色名册。此处早先
   * 误写成"kind 可登记（`entity`）"，与实现相反，已按代码订正。
   */
  unregisteredSubjects: UnregisteredSubject[];
  /**
   * 确定性矛盾核验结果（迭代 2）：与冻结表同槽异值且未声明覆盖的候选清单。
   * 这些候选已被强制 authority=candidate（须人工裁决后晋升，不进检索面）。
   */
  verification: {
    contradictions: Array<{ claimId: string; subjectRef: string; predicate: string; frozenClaimIds: string[]; riskReason: string }>;
  };
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
    canonicalCharacters: input.canonicalCharacters,
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

/**
 * 主体键等价索引：在身份注册索引之上补一层确定性键归一。
 *
 * 设计依据：state-audit-20261013 §3.6 实测——active 断言里 171 个 subject 键有 132 个永不命中
 * 身份注册表，主角自己的两条互斥死因就分属 `char_chu_heng` 与 `chu_heng` 两个 identity 槽，
 * 使确定性矛盾核验（按 identityHash 对账）与槽位时效重排双双看不见这对硬矛盾。
 *
 * 归一只有三级，全部是确定性等价，不含语义猜测：
 * 1. 精确别名命中（canonicalId/displayName/entityId/实体名）——原有行为；
 * 2. 键书写等价：NFKC + 去空白 + 分隔符归一 + 小写（`char-qi` ≡ `char_qi`）；
 * 3. 机器 ID 前缀等价：`char_X` 与裸键 `X` 视为同一键（`chu_heng` → `char_chu_heng`）。
 * 刻意不做拼音/近义/模糊匹配（`qi` ≡ `齐姓人` 属语义判定，超出共享层职责，见审计 §5.5）。
 */
export interface SubjectKeyIndex {
  readonly identity: CharacterIdentityIndex;
  readonly normalized: Map<string, string>;
}

const CHARACTER_ID_PREFIX = /^char[-_](.+)$/u;

function normalizeSubjectKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, "").replace(/[-_]+/gu, "_").toLowerCase();
}

export function buildSubjectKeyIndex(identityIndex: CharacterIdentityIndex): SubjectKeyIndex {
  const normalized = new Map<string, string>();
  const register = (key: string, canonicalId: string): void => {
    if (key && !normalized.has(key)) normalized.set(key, canonicalId);
  };
  for (const [alias, identity] of identityIndex) {
    const key = normalizeSubjectKey(alias);
    register(key, identity.canonicalId);
    const bare = CHARACTER_ID_PREFIX.exec(key)?.[1];
    if (bare) register(bare, identity.canonicalId);
  }
  return { identity: identityIndex, normalized };
}

/**
 * 解析主体键到规范 ID；未命中返回 undefined（不发明新键）。
 */
function resolveCanonicalSubjectId(rawId: string, index: SubjectKeyIndex): string | undefined {
  const trimmed = rawId.trim();
  if (!trimmed) return undefined;
  const exact = index.identity.get(trimmed);
  if (exact) return exact.canonicalId;
  return index.normalized.get(normalizeSubjectKey(trimmed));
}

/**
 * 可登记为主体的 subject.kind：只认 `character`。
 *
 * prompt 要求人物一律用 `character`，地点/物件/机构等非人物用 `entity`/`scene`——
 * 身份注册表只解析 kind='character'（所有生产加载器都按它过滤），因此只有人物键
 * 才该登记；把 `entity` 一并登记会让"补发房""玉牌""门框"这类地点物件混进角色名册
 * 与知识工作台，是语义错误。指纹层把 `character` 折叠为 `entity`（见 fingerprint.ts
 * 的 normalizeSubjectKind），故判别位不影响身份槽。其余 kind（project/outline/thread/
 * foreshadowing/timeline）属系统命名空间，relation 由 relations 表承载，scene 归
 * §5.4 的非人物主体注册（P2）。
 */
const REGISTRABLE_SUBJECT_KINDS: ReadonlySet<string> = new Set(["character"]);

/**
 * 按身份注册索引归一事实主体 ID。
 *
 * 设计依据：memory-governance-audit-20260909 §M2/§5.1.1——fact-extraction 的 subject.id
 * 此前由模型即兴生成（显示名/拼音转写/自造 ID 并存），同一人物多种键形态使 identityHash
 * 聚簇、跨章去重与所有按主体键过滤的消费方失明。命中（含键等价）时重写为规范 ID；
 * 未命中键原样保留，但会被收集为"待登记主体"，由调用方按 pendingEnrichment 规则登记实体
 * ——这正是 prompt.ts 规范人物名册段已向模型承诺的"名册之外的人物以正文原名作 subject.id，
 * 由系统登记为待补全实体"。此前只兑现了名册的一半，未命中侧从未落库。
 */
function normalizeFactSubjectId(fact: FactExtractionOutput["facts"][number], index: SubjectKeyIndex): FactExtractionOutput["facts"][number] {
  const rawId = fact.subject.id;
  if (typeof rawId !== "string") return fact;
  const canonicalId = resolveCanonicalSubjectId(rawId, index);
  if (!canonicalId || canonicalId === rawId) return fact;
  return { ...fact, subject: { ...fact.subject, id: canonicalId } };
}

/** 待登记主体：未命中注册表、且 kind 属于可登记命名空间的 subject 键（按 id 去重）。 */
export interface UnregisteredSubject {
  readonly id: string;
  readonly kind: string;
}

export function projectFactExtractionOutput(input: Omit<ExtractFactsInput, "model">, output: FactExtractionModelOutput | ChapterStateDelta): ExtractFactsResult {
  const normalized = normalizeFactExtractionOutput(output);
  // 身份归一必须发生在指纹计算与批内去重之前：同一事实以"显示名"与"规范 ID"两种主体
  // 出现在同一批提取结果时，归一后才会命中同指纹去重（dedupe L2/L3），否则照旧落两行。
  const subjectKeyIndex = input.identityIndex ? buildSubjectKeyIndex(input.identityIndex) : undefined;
  const facts = subjectKeyIndex
    ? normalized.facts.map((fact) => normalizeFactSubjectId(fact, subjectKeyIndex))
    : normalized.facts;
  // 待登记主体（未命中注册表且 kind 可登记）：随提取结果上浮，由 activity 层按
  // pendingEnrichment 规则登记实体，使该键下次可被解析——不发明第三种键形态。
  const unregisteredSubjects: UnregisteredSubject[] = [];
  if (subjectKeyIndex) {
    const seen = new Set<string>();
    for (const fact of facts) {
      const rawId = fact.subject.id;
      if (typeof rawId !== "string" || !REGISTRABLE_SUBJECT_KINDS.has(fact.subject.kind)) continue;
      const trimmed = rawId.trim();
      if (!trimmed || seen.has(trimmed) || resolveCanonicalSubjectId(trimmed, subjectKeyIndex)) continue;
      seen.add(trimmed);
      unregisteredSubjects.push({ id: trimmed, kind: fact.subject.kind });
    }
  }
  const deduped = dedupeFactCandidates({
    candidates: facts,
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
    existingValueHashById: input.existingValueHashById,
  });

  const projectedClaims = classified.map((item) => item.claim);
  const claims = input.narrativeOrder === undefined
    ? projectedClaims
    : scopeClaimsToChapter(projectedClaims, input.narrativeOrder);

  return {
    claims,
    // Phase 3.1: 透传 narrativeElements 给 activity 层，由其调用 recordNarrativeElements
    narrativeElements: normalized.narrativeElements,
    // 待登记主体（§3.6 主体碎片治理）：activity 层据此按 pendingEnrichment 规则建实体行，
    // 兑现 prompt.ts 规范人物名册段"由系统登记为待补全实体"的承诺。
    unregisteredSubjects,
    // 确定性矛盾核验审计面（迭代 2）：结构化冲突清单随提取结果上浮，
    // activity 层落 factArtifact.structuredData.verification，不静默。
    verification: {
      contradictions: classified
        .filter((item) => item.factContradiction)
        .map((item) => ({ claimId: item.claim.id, subjectRef: item.claim.subjectRefs[0] ?? "", predicate: item.claim.predicate ?? "", frozenClaimIds: item.factContradiction!.frozenClaimIds, riskReason: item.riskReason })),
    },
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
