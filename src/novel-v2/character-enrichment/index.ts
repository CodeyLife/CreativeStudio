import { createHash } from "node:crypto";
import Ajv from "ajv";
import type { Artifact, MemoryClaim, SkillBundle } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ModelRoutingSnapshot } from "../model-routing";
import type { CharacterEnrichmentRepositoryAccess } from "../repository-capabilities";
import type { ContentObjectStore } from "../object-store";
import type { MemoryIndex } from "../qdrant-memory";
import { characterEnrichmentSchema, RELATION_PREDICATE_WORDS, type CharacterEnrichmentOutput } from "../prompts/schemas";
import { buildCharacterEnrichmentPrompt } from "./prompt";
import { compileStageContext } from "../stage-context";
import { buildSkillContextSections } from "../skill-runtime";
import { canonicalizeFactPredicate, factIdentityHash, factValueHash } from "../fact-extraction/fingerprint";
import {
  buildCharacterIdentityIndex,
  characterIdentityPayload,
  humanMentionNamesFor,
  isCharacterMentionedIn,
  resolveCharacterIdentity,
  uniqueCharacterIdentities,
  type CharacterIdentityIndex,
  type FoundationCharacter,
} from "../character-identity";

/**
 * 识别 motivationDelta 的"无变化"占位标记。
 *
 * 设计依据：AGENTS.md「root-cause analysis」——原下游用精确字符串匹配
 * `=== "本章无明显动机变化"`，但 LLM 常填变体（如"动机未变化""该角色无动机变化"），
 * 导致占位文本被当作真实动机写入 entities.payload，污染角色档案。
 * 改用正则覆盖所有"无 + 变化"语义变体，prompt 侧同步标准化为"无变化"三字。
 */
const NO_MOTIVATION_CHANGE_REGEX = /^\s*(无变化|.*无(明显)?(动机)?变化.*|.*动机未(发生)?变化.*)\s*$/u;

interface CharacterEntityRow {
  id: string;
  name: string;
  payload: Record<string, unknown> | null;
}

interface CharacterIdentityRegistry {
  index: CharacterIdentityIndex;
  entities: CharacterEntityRow[];
}

// TODO: move prompt-context budgets to the runtime routing configuration.
const MAX_CHARACTER_DIGEST_ENTRIES = 100;

function foundationCharacters(value: unknown): FoundationCharacter[] {
  return Array.isArray(value)
    ? value.filter((item): item is FoundationCharacter => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

/**
 * 加载项目人物身份注册表（entities + Foundation characters 的别名索引）。
 *
 * 设计依据：memory-governance-audit-20260909 §M2——身份解析此前只服务 character-enrichment
 * 路径，fact-extraction 路径的主体 ID 由模型即兴生成，造成同一人物多种 subject 键形态。
 * 导出给 extractFacts / chapter-state-rebuild 等提取调用方复用：prompt 注入规范名册 +
 * 提取结果经同一索引归一，是"身份注册表成为共享写入契约"的最低共享层实现。
 */
export async function loadCharacterIdentityRegistry(projectId: string, repository: CharacterEnrichmentRepositoryAccess): Promise<CharacterIdentityRegistry> {
  const [entities, foundation] = await Promise.all([
    repository.pool.query<CharacterEntityRow>("SELECT id, name, payload FROM entities WHERE project_id=$1 AND kind='character' AND (payload->>'mergedInto') IS NULL ORDER BY name ASC", [projectId]),
    repository.pool.query<{ characters: unknown }>("SELECT payload->'structuredData'->'characters' AS characters FROM project_plan_sections WHERE project_id=$1 AND task_key='characters'", [projectId]),
  ]);
  return {
    entities: entities.rows,
    index: buildCharacterIdentityIndex(projectId, entities.rows, foundationCharacters(foundation.rows[0]?.characters)),
  };
}

/**
 * V2 角色富化（character enrichment）模块。
 *
 * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
 *
 * 流程：
 * 1. 从 objectStore 取章节正文（commit 后已落库）
 * 2. LLM 结构化提取（purpose=facts.extract）：每个角色的 voiceAnchor/motivationDelta/newKnowledge/relationDeltas
 * 3. 回写角色档案：
 *    - voiceAnchor + motivationDelta → UPSERT 到 entities.payload（merge 现有 payload）
 *    - newKnowledge → 创建 MemoryClaim（knowledgeScope={characterId}），写入 memory_claims + Qdrant
 *    - relationDeltas → UPSERT 到 relations 表（时效关系，valid_from=当前 revision）
 *
 * 与 chapter memory 的区别：
 * - chapter memory 是章节级摘要（发生了什么）
 * - character enrichment 是角色级增量（角色怎么变了）
 * - 两者互补：chapter memory 用于跨章节事件一致性，character enrichment 用于角色声部/动机一致性
 *
 * 失败处理：失败不阻塞 commit（revision 已落库），只记录错误让上游 learning 闭环感知。
 * 符合 AGENTS.md「不阻塞 commit」契约。
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - 本模块只做编排，提取规则在 prompt.ts 中独立维护
 * - voiceAnchor 四维是题材无关的语言特征，不内置网文套路
 * - 知识边界用 MemoryClaim（knowledgeScope={characterId}）而非 v1 的人物知识表（该表已随 093 删除）
 */

// PL-4 谓词受控的写入侧兜底：schema 枚举（同一白名单单一真源）在第三方中转不执行
// json_schema 时可被绕过（AGENTS 已知问题），模型也会把句子塞进谓词（实测 111 行/66 种）。
// 白名单外短词无损收进"其他:<标签>"逃生通道；句子形态不截断（截断即 garble），
// 归入通用标签——完整语义本就由 delta 字段承载，此处只收敛检索槽位基数。
// TODO(magic-value): 8 为"关系词 vs 句子"的形态分界经验位；16 为 schema 标签上限(其他:3字+12)。需语料校准后配置化。
export function normalizeRelationPredicate(predicate: string): string {
  const value = predicate.replace(/\s+/gu, "").trim();
  if (!value) return "其他:关系未命名";
  if ((RELATION_PREDICATE_WORDS as readonly string[]).includes(value)) return value;
  if (value.startsWith("其他:")) return value.length <= 16 ? value : "其他:关系变化";
  if (value.length <= 8) return `其他:${value}`;
  return "其他:关系变化";
}

export interface EnrichCharactersInput {
  projectId: string;
  documentId: string;
  /** 定稿 revision id（commit-stage 产出）。 */
  revisionId: string;
  /** 章节顺序号（用于 narrativeRange）。 */
  narrativeOrder: number;
  /** 章节正文。 */
  text: string;
  /** 章节定稿 artifact。 */
  artifact: Artifact;
  model: ModelGateway;
  routingSnapshot?: ModelRoutingSnapshot;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
  skills?: Array<{ skillId: string; promptSections: Partial<Record<string, string>> }>;
  /** 新调用方使用 bundle，让 Skill section 与 resolution manifest 在同一编译层对账。 */
  skillBundle?: SkillBundle;
}

export interface EnrichCharactersDeps {
  repository: CharacterEnrichmentRepositoryAccess;
  objects: ContentObjectStore;
  /** Qdrant 索引（可选，缺失时跳过向量索引）。 */
  memoryIndex?: MemoryIndex;
}

/**
 * 单个角色的富化增量（提取后用于回写）。
 */
export interface CharacterEnrichmentDelta {
  characterId: string;
  voiceAnchor: CharacterEnrichmentOutput["characters"][number]["voiceAnchor"];
  motivationDelta: string;
  newKnowledge: CharacterEnrichmentOutput["characters"][number]["newKnowledge"];
  relationDeltas: CharacterEnrichmentOutput["characters"][number]["relationDeltas"];
}

export interface EnrichCharactersResult {
  deltas: CharacterEnrichmentDelta[];
  /** 回写产生的 MemoryClaim（角色知识边界），已写入 memory_claims。 */
  knowledgeClaims: MemoryClaim[];
  /** 回写产生的 relations 记录数。 */
  relationRecords: number;
  /** 回写更新的 entities 数量。 */
  entityUpdates: number;
}

/**
 * 从定稿章节中提取角色富化增量并回写角色档案。
 *
 * 返回值：成功返回 EnrichCharactersResult，失败抛错（由上游 try/catch 决定是否阻塞）。
 */
export async function enrichCharactersFromChapter(input: EnrichCharactersInput, deps: EnrichCharactersDeps): Promise<EnrichCharactersResult> {
  // 1. 取已有角色档案摘要（让 LLM 只提取增量）
  const characterRegistry = await loadCharacterIdentityRegistry(input.projectId, deps.repository);
  const entityById = new Map(characterRegistry.entities.map((row) => [row.id, row]));
  const existingCharactersDigest = uniqueCharacterIdentities(characterRegistry.index)
    .slice(0, MAX_CHARACTER_DIGEST_ENTRIES)
    .map((identity) => {
      const payload = entityById.get(identity.entityId)?.payload ?? {};
      const voice = payload.voiceAnchor ? `声部：${JSON.stringify(payload.voiceAnchor)}` : "";
      const motivation = payload.motivation ? `动机：${payload.motivation}` : "";
      // PL-4：区分"已出场/未出场"——未在本章正文以可指称名出现的人物显式标注，
      // 阻断模型把泛指描述（"高瘦的""圆脸弟子"）投射到规划专名（零出场却挂正文来源事实）。
      const mentioned = isCharacterMentionedIn(input.text, humanMentionNamesFor(characterRegistry.index, identity));
      return `- 规范 ID：${identity.canonicalId}；展示名：${identity.displayName}${mentioned ? "" : "；【未出场：本章正文未提及此人名，禁止把泛指人物映射到它】"}${voice ? `；${voice}` : ""}${motivation ? `；${motivation}` : ""}`;
    }).join("\n") || undefined;

  // 2. LLM 结构化提取
  const prompt = buildCharacterEnrichmentPrompt({
    artifact: input.artifact,
    text: input.text,
    existingCharactersDigest,
  });
  const system = "你是角色富化提取 Worker。只输出符合 JSON Schema 的 JSON。只提取正文实际呈现的内容，不提取读者推断或作者意图。";
  const skillSections = buildSkillContextSections({ skills: input.skillBundle?.skills ?? input.skills ?? [] }, "character.enrichment", "角色富化 Skill");
  const promptPackage = compileStageContext({ projectId: input.projectId, workflowId: input.workflowRunId ?? input.artifact.taskId, purpose: "facts.extract", stage: "fact-extraction", system, schema: characterEnrichmentSchema as unknown as Record<string, unknown>, maxInputTokens: 128_000, reservedOutputTokens: 4_096, skillManifest: input.skillBundle?.resolution, sections: [{ id: "character-enrichment-fallback", kind: "manuscript", title: "角色变化回退提取", text: prompt, priority: "critical", provenanceRefs: [input.artifact.id, input.revisionId] }, ...skillSections] });

  const generated = await input.model.generateStructured<CharacterEnrichmentOutput>({
    purpose: "facts.extract",
    system,
    prompt: promptPackage.instruction,
    schema: characterEnrichmentSchema as unknown as Record<string, unknown>,
    schemaName: "character-enrichment",
    routingSnapshot: input.routingSnapshot,
    candidateStartIndex: input.candidateStartIndex,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    promptContext: promptPackage.manifest,
  });

  const output = generated.value;
  validateCharacterEnrichmentOutput(output);

  const deltas: CharacterEnrichmentDelta[] = output.characters.map((character) => ({
    characterId: character.characterId,
    voiceAnchor: character.voiceAnchor,
    motivationDelta: character.motivationDelta,
    newKnowledge: character.newKnowledge,
    relationDeltas: character.relationDeltas,
  }));

  // 3. 回写角色档案
  const result = await persistCharacterEnrichment(input, deps, deltas);
  return result;
}

/**
 * 校验 LLM 输出符合 character enrichment schema 的基本约束。
 */
export function validateCharacterEnrichmentOutput(output: CharacterEnrichmentOutput): void {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(characterEnrichmentSchema);
  if (!validate(output)) {
    throw new Error(`角色富化提取结果无效：${validate.errors?.map((item) => `${item.instancePath}:${item.message}`).join("；") ?? "未知错误"}`);
  }
}

/**
 * 把角色富化增量回写到 entities / memory_claims / relations。
 *
 * 设计依据：AGENTS.md「reusable contracts」——回写逻辑题材无关，只处理通用结构。
 *
 * 导出供 materializeExternalEnrichment 复用，避免 external-mcp 双路径下重复实现回写逻辑。
 */
export async function persistCharacterEnrichment(input: { projectId: string; documentId: string; revisionId: string; narrativeOrder: number; artifact: Artifact; text?: string }, deps: EnrichCharactersDeps, deltas: CharacterEnrichmentDelta[]): Promise<EnrichCharactersResult> {
  let entityUpdates = 0;
  let relationRecords = 0;
  const knowledgeClaims: MemoryClaim[] = [];
  const characterRegistry = await loadCharacterIdentityRegistry(input.projectId, deps.repository);

  for (const delta of deltas) {
    const subjectIdentity = resolveCharacterIdentity(input.projectId, delta.characterId, characterRegistry.index);
    // P1-D3: entity id 统一为 `entity:${projectId}:character:${canonicalId}` 格式，
    // relations.subject_id/object_id 必须使用同样的 entityId 格式才能与 entities.id 对齐，
    // 否则 GraphMemoryProvider 基于 relations 表的图检索会找不到对应 entity（id 不匹配）。
    // 设计依据：AGENTS.md「root-cause analysis」——id 不对齐是数据模型层机制错误，
    // 不是单点 bug，会影响所有依赖 relations.subject_id=entities.id 的图遍历逻辑。
    const subjectEntityId = subjectIdentity.entityId;
    // 实体归并对账（memory-governance-audit-20260909 §5.4.1）：身份索引把同一人物的
    // 历史别名实体（如早期以显示名建行的 pendingEnrichment 实体）映射到同一规范身份时，
    // 先把旧行 payload 并入规范行（声部历史拼接、动机兜底），再把旧行标记 mergedInto
    // 退役——行保留满足 relations 外键与审计，但不再出现在任何身份索引与档案读取中。
    const legacyRows = characterRegistry.entities.filter((row) =>
      row.id !== subjectEntityId
      && !row.payload?.mergedInto
      && characterRegistry.index.get(row.id)?.entityId === subjectEntityId);
    const existingEntity = await deps.repository.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM entities WHERE id=$1",
      [subjectEntityId],
    );
    let existingPayload = existingEntity.rows[0]?.payload ?? {};
    for (const legacy of legacyRows) {
      existingPayload = mergeRetiredEntityPayload(existingPayload, legacy.payload ?? {});
    }
    const mergedPayload = {
      ...existingPayload,
      ...characterIdentityPayload(subjectIdentity),
      voiceAnchor: mergeVoiceAnchor(existingPayload.voiceAnchor, delta.voiceAnchor),
      motivation: NO_MOTIVATION_CHANGE_REGEX.test(delta.motivationDelta.trim())
        ? existingPayload.motivation ?? undefined
        : delta.motivationDelta,
    };
    await deps.repository.pool.query(
      `INSERT INTO entities(id, project_id, kind, name, payload)
       VALUES($1, $2, 'character', $3, $4)
       ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, name=EXCLUDED.name`,
      [subjectEntityId, input.projectId, subjectIdentity.displayName, mergedPayload],
    );
    entityUpdates += 1;
    for (const legacy of legacyRows) {
      await deps.repository.pool.query(
        `UPDATE entities SET payload = payload || jsonb_build_object('mergedInto', $2::text, 'mergedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')) WHERE id=$1`,
        [legacy.id, subjectEntityId],
      );
    }

    // 3b. 创建 MemoryClaim（角色知识边界）
    for (const knowledge of delta.newKnowledge) {
      const contentHash = createHash("sha256").update(`knowledge:${subjectIdentity.canonicalId}:${knowledge.description}`).digest("hex");
      // 统一事实指纹契约（memory-governance-audit-20260909 §5.1.2）：知识边界声明此前
      // 只有字符串 contentHash、无 identityHash，检索层合并键退化为 id 键，与 fact-extraction
      // 管道对同一章重复提取的"谁知道什么"永远无法对账。改用与 fact-extraction 同构的
      // identityHash/valueHash（predicate 经 canonicalizeFactPredicate 归一，character-knows
      // 与"知晓"落在同一槽位），contentHash 保留原算法作为写入层幂等键不变。
      const knowledgeFact = {
        subject: { kind: "entity" as const, id: subjectIdentity.canonicalId },
        predicate: "character-knows",
        object: { kind: "string" as const, value: knowledge.description },
        polarity: "affirmed" as const,
        truthStatus: "objective" as const,
      };
      const claim: MemoryClaim = {
        id: `claim:knowledge:${input.revisionId}:${contentHash.slice(0, 16)}`,
        projectId: input.projectId,
        kind: "episodic",
        title: `${subjectIdentity.displayName} 的信息边界（第${input.narrativeOrder}章）`,
        content: knowledge.description,
        subjectRefs: [subjectIdentity.canonicalId],
        narrativeRange: { start: input.narrativeOrder, end: input.narrativeOrder },
        knowledgeScope: { characterId: subjectIdentity.canonicalId },
        authority: "derived",
        confidence: 0.85,
        sourceRevisionIds: [input.revisionId],
        contentHash,
        supersedes: [],
        predicate: canonicalizeFactPredicate("character-knows"),
        identityHash: factIdentityHash(knowledgeFact),
        valueHash: factValueHash(knowledgeFact),
      };
      const recorded = await deps.repository.recordFactExtraction({
        projectId: input.projectId,
        artifact: input.artifact,
        claims: [claim],
        lifecycleStatus: "active",
        documentId: input.documentId,
        revisionId: input.revisionId,
        narrativeOrder: input.narrativeOrder,
      });
      if (recorded.length) {
        knowledgeClaims.push(recorded[0]);
        if (deps.memoryIndex) {
          try {
            await deps.memoryIndex.upsertClaims(input.projectId, recorded);
          } catch (error) {
            console.warn(`[character-enrichment] Qdrant 索引失败（不阻塞）：${(error as Error).message}`);
          }
        }
      }
    }

    // 3c. UPSERT relations（关系变化）
    // P1-D3: subject_id/object_id 使用 entityId 格式（与 entities.id 对齐），
    // 让 GraphMemoryProvider 的 BFS/DFS 能正确串联 entities 和 relations。
    //
    // P1-D4: relations.object_id 有 FK 约束引用 entities.id（010_fk_cascade.sql）。
    // relationDeltas 的 targetCharacterId 通常是本章"被提及但未作为富化主体"的角色
    // （如配角、首次出场角色），其 entity 可能尚未创建。原实现只对 subject 创建 entity，
    // 导致 relations INSERT 触发 FK 违反（observed: 江南男子/苏晚意 不在 entities 表），
    // 进而让 enrichCharacters activity 重试 3 次后失败、整个章节 workflow 终止。
    //
    // 根因（AGENTS.md「root-cause analysis」）：relations 要求两端 entity 都存在，
    // 这是数据模型层的引用完整性约束，而非单点 bug——任何"关系指向未富化角色"的章节
    // 都会触发同一类失败。修复在最低共享层（persistCharacterEnrichment 回写逻辑）：
    // 插入 relation 前对 object entity 做幂等 UPSERT（ON CONFLICT DO NOTHING）。
    // 已存在的 entity 不覆盖（保留历史富化数据），新 entity 写入 stub 标记
    // （payload.pendingEnrichment=true），待后续章节把它作为主体富化时补全
    // voiceAnchor/motivation。本修复题材无关，覆盖所有"关系指向未富化角色"的输入类。
    // 回归风险：无——ON CONFLICT DO NOTHING 对已存在 entity 无副作用；新 stub entity
    // 仅满足 FK + 图遍历可达性，不影响 character-reviewer（它按 subject 富化数据审校）。
    // PL-4：主体在本章正文的可指认性（displayName/aliases 命中）。调用方未提供正文
    // （chapter-state-rebuild 重放历史 delta）时门保守放行——无证据不做判定。
    const subjectMentioned = input.text === undefined || isCharacterMentionedIn(input.text, humanMentionNamesFor(characterRegistry.index, subjectIdentity));
    for (const relation of delta.relationDeltas) {
      const predicate = normalizeRelationPredicate(relation.predicate);
      const targetIdentity = resolveCharacterIdentity(input.projectId, relation.targetCharacterId, characterRegistry.index);
      const objectEntityId = targetIdentity.entityId;
      // PL-4 正文可指认门（写入面）：关系两端都以可指称名出现在正文，才允许把 valid_from
      // 绑到本 revision（成为正文来源事实）；任一端未出场 → 关系仍落库但 valid_from=NULL
      // （"规划候选"通道，检索面排除、可经 listRelations 人工裁决），杜绝零出场人物挂正文
      // 来源关系（叶轻眉/玄机子正文 0 命中却有绑定 ch7/ch11/ch20 的"警惕/未知"关系的根因）。
      const objectMentioned = input.text === undefined || isCharacterMentionedIn(input.text, humanMentionNamesFor(characterRegistry.index, targetIdentity));
      const mentionBound = subjectMentioned && objectMentioned;
      await deps.repository.pool.query(
        `INSERT INTO entities(id, project_id, kind, name, payload)
         VALUES($1, $2, 'character', $3, $4)
         ON CONFLICT(id) DO NOTHING`,
        [
          objectEntityId,
          input.projectId,
          targetIdentity.displayName,
          { autoCreated: true, autoCreatedFrom: "relation", sourceRevisionId: input.revisionId, narrativeOrder: input.narrativeOrder, pendingEnrichment: true, planningCandidate: !objectMentioned, ...characterIdentityPayload(targetIdentity) },
        ],
      );
      const relationId = `relation:${input.projectId}:${subjectEntityId}:${predicate}:${objectEntityId}:${input.revisionId}`;
      await deps.repository.pool.query(
        `INSERT INTO relations(id, project_id, subject_id, predicate, object_id, valid_from, source_revision_id)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(id) DO NOTHING`,
        [
          relationId,
          input.projectId,
          subjectEntityId,
          predicate,
          objectEntityId,
          // PL-1 量纲族修复（2026-09-16 上下文供给断裂审核实证）：valid_from 的读侧谓词是
          // `valid_from<=叙事cutoff`（searchGraphMemory）与 narrativeRange.start（命中投影），
          // 写入 Date.now()（≈1.7e12）使所有正文来源关系在检索面恒假全灭——关系 facet 召回
          // 自 PL-4 上线起整项目静默为 0。写侧必须落**叙事序**，与 revision/document 同量纲。
          mentionBound ? input.narrativeOrder : null,
          input.revisionId,
        ],
      );
      relationRecords += 1;
    }
  }

  return { deltas, knowledgeClaims, relationRecords, entityUpdates };
}

/**
 * 合并 voiceAnchor：渐进式合并策略，保留历史观测避免单章漂移。
 *
 * 设计依据：AGENTS.md「root-cause analysis」——原实现"新值覆盖旧值"是机制错误，
 * 单章 LLM 提取的 voiceAnchor 可能因剧情需要偏离常态（如角色伪装、情绪爆发），
 * 直接覆盖会让 character-reviewer 在后续章节基于"伪装声部"审校，导致误判。
 *
 * 合并规则（题材无关的通用机制，不内置套路）：
 * - 维度相同：新旧值都保留，按时间拼接（最新在前），让审校器看到声部演变轨迹
 * - 维度新增（旧值缺失）：直接采用新值
 * - 维度未变（新值缺失）：保留旧值
 * - 历史轨迹上限 3 条（避免无限增长），超出时丢弃最旧
 *
 * 不通过 craft rule 配置——这是数据完整性约束，不是题材特化规则。
 *
 * 返回值存入 entities.payload.voiceAnchor（JSONB），结构为
 * `{ sentenceLength: { latest, history }, vocabulary: ..., directness: ..., avoidance: ... }`。
 * character-reviewer 读取时优先看 latest，必要时参考 history 判断是否单章偏离。
 */
type MergedVoiceAnchor = Record<string, { latest: string; history: string[] }>;
function mergeVoiceAnchor(existing: unknown, delta: CharacterEnrichmentDelta["voiceAnchor"]): MergedVoiceAnchor {
  const MAX_HISTORY = 3;
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    // 旧值不是对象（首次写入或脏数据），返回带历史轨迹的 delta
    return appendHistory(undefined, delta, MAX_HISTORY);
  }
  return appendHistory(existing as Record<string, unknown>, delta, MAX_HISTORY);
}

/**
 * 把退役实体行的档案并入规范实体行（memory-governance-audit-20260909 §5.4.1）。
 *
 * 合并规则（题材无关的通用机制）：动机取规范行现值、缺失时兜底旧行值；
 * 声部四维按维度合并历史轨迹（去重保序，规范行 latest 不被旧行覆盖）。
 * 纯函数，运行时归并（persistCharacterEnrichment）与存量回填脚本共用同一实现，
 * 避免两处合并语义漂移。
 */
export function mergeRetiredEntityPayload(canonical: Record<string, unknown>, legacy: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...canonical };
  if (merged.motivation === undefined && typeof legacy.motivation === "string") merged.motivation = legacy.motivation;
  const legacyVoice = legacy.voiceAnchor;
  if (legacyVoice && typeof legacyVoice === "object" && !Array.isArray(legacyVoice)) {
    const baseVoice = merged.voiceAnchor && typeof merged.voiceAnchor === "object" && !Array.isArray(merged.voiceAnchor)
      ? merged.voiceAnchor as Record<string, unknown>
      : undefined;
    merged.voiceAnchor = mergeVoiceAnchorHistories(baseVoice, legacyVoice as Record<string, unknown>);
  }
  return merged;
}

const VOICE_ANCHOR_DIMENSIONS = ["sentenceLength", "vocabulary", "directness", "avoidance"] as const;

function mergeVoiceAnchorHistories(base: Record<string, unknown> | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(base ?? {}) };
  for (const dim of VOICE_ANCHOR_DIMENSIONS) {
    const extraEntry = extra[dim];
    if (!extraEntry || typeof extraEntry !== "object" || Array.isArray(extraEntry)) continue;
    const extraRecord = extraEntry as { latest?: unknown; history?: unknown };
    const incoming = [
      typeof extraRecord.latest === "string" ? extraRecord.latest : undefined,
      ...(Array.isArray(extraRecord.history) ? extraRecord.history : []),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (!incoming.length) continue;
    const baseEntry = result[dim];
    if (!baseEntry) {
      result[dim] = extraEntry;
      continue;
    }
    if (typeof baseEntry === "string") {
      result[dim] = { latest: baseEntry, history: [...new Set([baseEntry, ...incoming])] };
      continue;
    }
    if (typeof baseEntry === "object" && !Array.isArray(baseEntry) && "latest" in baseEntry) {
      const record = baseEntry as { latest: unknown; history?: unknown };
      const baseHistory = Array.isArray(record.history) ? record.history : [];
      result[dim] = {
        latest: typeof record.latest === "string" ? record.latest : incoming[0],
        history: [...new Set([typeof record.latest === "string" ? record.latest : "", ...baseHistory, ...incoming].filter(Boolean))],
      };
    }
  }
  return result;
}

/**
 * 把新观测的 voiceAnchor 维度追加到历史轨迹。
 *
 * 输出格式：每个维度是 `{ latest: string, history: string[] }`，
 * 让 character-reviewer 看到角色声部的演变轨迹而非单一快照。
 * 兼容旧格式（纯字符串）：读取时若旧值是字符串，转为 latest 单元素 history。
 */
function appendHistory(existing: Record<string, unknown> | undefined, delta: CharacterEnrichmentDelta["voiceAnchor"], maxHistory: number): MergedVoiceAnchor {
  const dimensions: Array<keyof CharacterEnrichmentDelta["voiceAnchor"]> = ["sentenceLength", "vocabulary", "directness", "avoidance"];
  const result: MergedVoiceAnchor = {};
  for (const dim of dimensions) {
    const newValue = delta[dim];
    const oldValue = existing?.[dim];
    if (typeof oldValue === "string") {
      // 旧格式：纯字符串，转为 latest + history
      result[dim] = {
        latest: newValue,
        history: dedupeHistory([oldValue, newValue], maxHistory),
      };
    } else if (oldValue && typeof oldValue === "object" && !Array.isArray(oldValue) && "latest" in oldValue) {
      // 已有轨迹格式：追加新值
      // 经 unknown 中转：oldValue 经 "latest" in 收窄后为 object & Record<"latest", unknown>，
      // 直接转 { history: string[] } 会被 TS 判定重叠不足，先转 unknown 再转目标类型。
      const oldRecord = oldValue as unknown as { history?: unknown };
      const oldHistory = Array.isArray(oldRecord.history) ? (oldRecord.history as string[]) : [];
      result[dim] = {
        latest: newValue,
        history: dedupeHistory([newValue, ...oldHistory], maxHistory),
      };
    } else {
      // 旧值缺失或脏数据，初始化轨迹
      result[dim] = {
        latest: newValue,
        history: [newValue],
      };
    }
  }
  return result;
}

/**
 * 去重并截断历史轨迹，避免同一观测值重复堆积。
 */
function dedupeHistory(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    result.push(v);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * 解析外部 MCP 提交的 character enrichment 结果（与 materializeExternalFacts 对称）。
 */
export function parseCharacterEnrichmentOutput(value: unknown): CharacterEnrichmentOutput {
  const output = value as CharacterEnrichmentOutput;
  validateCharacterEnrichmentOutput(output);
  return output;
}
