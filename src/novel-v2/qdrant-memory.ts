import { QdrantClient } from "@qdrant/js-client-rest";
import type { MemoryClaim, MemoryHit, MemoryProvider, RetrievalFacet } from "./protocol";
import { isVisibleClaimAuthority, VISIBLE_CLAIM_AUTHORITIES } from "./memory-visibility";
import { qdrantPointId } from "./memory-point-id";
import type { ModelGateway } from "./model-gateway";

export interface MemoryIndex {
  upsertClaims(projectId: string, claims: MemoryClaim[]): Promise<void>;
  deleteClaims?(projectId: string, claimIds: string[]): Promise<void>;
}

/**
 * 存活判定注入点：把一批行 id 收成"当前仍在可索引集里"的子集。
 * 实现在仓储侧（谓词单源），本模块只负责在召回后问它一次。
 */
export type LiveMemoryRowFilter = (projectId: string, rowIds: string[]) => Promise<Set<string>>;

/** 只写不读的构造点（重建脚本、写入侧单测）用它：语义检索在此处不可达。 */
export const NO_SEMANTIC_SEARCH: LiveMemoryRowFilter = async () => {
  throw new Error("该 QdrantMemoryProvider 实例未接存活判定，不得用于语义检索");
};

/**
 * 通过 claim.id 前缀识别 chapter memory（由 chapter-memory/index.ts 的 chapterMemoryAsClaim 产出）。
 *
 * 设计依据：Phase 1.2 chapter memory 索引——chapter memory 投影为 MemoryClaim 时
 * id 格式为 `memory:chapter:${revisionId}`，通过此前缀在 Qdrant 检索结果中识别并
 * 标记 matchedFacet="chapter-memory"，让 buildMemoryBundle 能正确计算 missingFacets。
 */
const CHAPTER_MEMORY_ID_PREFIX = "memory:chapter:";

export class QdrantMemoryProvider implements MemoryProvider, MemoryIndex {
  readonly collection: string;
  readonly dimension: number;
  constructor(private readonly client: QdrantClient, private readonly gateway: ModelGateway, collection = process.env.QDRANT_COLLECTION ?? "novel-memory", dimension = Number(process.env.NOVEL_EMBEDDING_DIM ?? 1024), private readonly filterLiveRowIds: LiveMemoryRowFilter = NO_SEMANTIC_SEARCH) { this.collection = collection; this.dimension = dimension; }

  async ensureCollection() {
    let info: Awaited<ReturnType<QdrantClient["getCollection"]>>;
    try {
      // getCollection resolves aliases as well as physical collection names.
      info = await this.client.getCollection(this.collection);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) throw error;
      await this.client.createCollection(this.collection, { vectors: { size: this.dimension, distance: "Cosine" } });
      return;
    }
    const vectors = info.config?.params?.vectors as { size?: number } | undefined;
    if (Number(vectors?.size) !== this.dimension) throw new Error(`Qdrant 集合 ${this.collection} 维度 ${String(vectors?.size)} 与 embedding 维度 ${this.dimension} 不一致`);
  }

  async search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    await this.ensureCollection();
    const query = input.facets.map((facet) => facet.query).join(" ");
    const embedding = await this.gateway.embed({ purpose: "memory.embed", texts: [query], projectId: input.projectId });
    if (embedding.vectors[0]?.length !== this.dimension) throw new Error(`查询向量维度 ${embedding.vectors[0]?.length ?? 0} 与集合维度 ${this.dimension} 不一致`);
    const filter: any = { must: [
      { key: "projectId", match: { value: input.projectId } },
      { key: "lifecycleStatus", match: { value: "active" } },
      // 服务端就限死可见 authority，避免 candidate/rejected 点挤占召回名额后在应用层丢弃。
      { key: "authority", match: { any: [...VISIBLE_CLAIM_AUTHORITIES] } },
    ] };
    // P0-A4: narrativeStart=null 表示全局可见（无章节归属的基础事实），
    // 不应被 narrativeCutoff 屏蔽。Qdrant 的 range:lte 过滤会排除 null 值，
    // 因此改用 should（OR）组合：narrativeStart <= cutoff OR narrativeStart IS NULL。
    // 设计依据：AGENTS.md「root-cause analysis」——null 语义是"全局可见"，
    // 被错误屏蔽会导致大量基础事实在检索时丢失。
    if (input.narrativeCutoff !== undefined) {
      filter.must.push({
        should: [
          { key: "narrativeStart", range: { lte: input.narrativeCutoff } },
          { key: "narrativeStart", is_null: true },
        ],
      });
    }
    // P0-A2: POV 角色知识边界过滤
    // 设计依据：AGENTS.md「reusable contracts」——POV 角色不应知道其他角色的秘密。
    // knowledgeScope="author" 是全局可见事实，总是召回；
    // knowledgeScope={characterId} 只在 characterId === povCharacterId 时召回。
    // Qdrant payload 中存储 knowledgeScopeCharacterId（upsertClaims 时填充）。
    if (input.povCharacterId) {
      filter.must.push({
        should: [
          { key: "knowledgeScopeCharacterId", is_null: true },
          { key: "knowledgeScopeCharacterId", match: { value: input.povCharacterId } },
        ],
      });
    }
    const points = await this.client.query(this.collection, { query: embedding.vectors[0], filter, limit: 64, with_payload: true });
    const facetKinds = new Set(input.facets.map((facet) => facet.kind));
    const hits = points.points
      .map((point: any) => {
        const claim = point.payload?.claim as MemoryHit | undefined;
        // 这里只留结构校验。存活与否不在此判：payload 的 lifecycleStatus/authority/supersedes
        // 全是索引时刻的副本（`claim.lifecycleStatus ?? "active"` 还会替缺字段的行撒谎），
        // 统一交给下面的库内可见集判定——那才是 A1/FM-1 的单一真源。
        if (!claim || !claim.id || claim.projectId !== input.projectId) return null;
        // P0-A5: matchedFacet 按 claim.kind 匹配 facet 列表，而非强制标记为 facets[0].kind
        // 设计依据：AGENTS.md「root-cause analysis」——matchedFacet 错标会导致 missingFacets
        // 计算错误，高风险任务可能因 missingFacets.length && risk==="high" 抛错阻断生成。
        // chapter memory 通过 id 前缀识别，优先标记为 "chapter-memory"。
        let matchedFacet: RetrievalFacet["kind"];
        if (claim.id.startsWith(CHAPTER_MEMORY_ID_PREFIX)) {
          matchedFacet = "chapter-memory";
        } else if (facetKinds.has(claim.kind as RetrievalFacet["kind"])) {
          // claim.kind 在 facet 列表中，用它标记
          matchedFacet = claim.kind as RetrievalFacet["kind"];
        } else {
          // claim.kind 不在 facet 列表中（如 episodic claim 被 foreshadowing facet 召回），
          // 标记为第一个匹配的 facet kind 作为 fallback
          matchedFacet = input.facets[0]?.kind ?? "fact";
        }
        return {
          ...claim,
          score: Number(point.score ?? 0),
          matchedFacet,
          matchedFacets: [matchedFacet],
          reason: "qdrant dense retrieval",
          semanticRank: Number(point.score ?? 0),
        } as MemoryHit;
      })
      .filter((claim: MemoryHit | null): claim is MemoryHit => claim !== null);

    // 存活判定（A1/FM-1 不变量在语义检索侧的落点）：召回后拿命中行 id 回库问一次
    // "当前仍在可索引集里"的子集，其余丢弃。
    //
    // 取代的是此前的 payload 近似：那版只把**同一窗内**命中行的 `supersedes` 互相屏蔽，
    // 杀手不与受害者同时进 top-64 就失效，而库里被退役/转 staged 的行其点不会自己变
    // （`ymcp` 实测索引里有 22 个已退役点与 5 个 staged 点）。近似判据留着的代价是
    // "同一契约两处口径"，正是本仓反复清理的形态，故一并撤掉。
    //
    // 失败即抛（不静默放行）：问不到存活集就等于无法排除陈旧事实，宁可让调用方
    // （融合检索按轨 catch）降级为其他轨，也不把已退役内容当现行事实送进 prompt。
    const liveRowIds = hits.length ? await this.filterLiveRowIds(input.projectId, hits.map((hit: MemoryHit) => hit.id)) : new Set<string>();
    const survivingHits = hits.filter((hit: MemoryHit) => liveRowIds.has(hit.id));

    // Phase 2.1 rerank：若 gateway.rerank 可用，对 top-N 做 cross-encoder rerank
    return this.applyRerank(query, survivingHits, input.projectId);
  }

  /**
   * 对 Qdrant 召回结果做 rerank 精排。
   *
   * - 输入：query + 已召回的 hits（limit=64）
   * - 输出：top-K（K=32）按 rerank score 降序
   * - 失败/不可用：降级为原 semanticRank 顺序，只截断到 top-32
   *
   * 设计依据：Phase 2.1 计划——rerank score 覆盖 semanticRank，
   * 让 buildMemoryBundle 的后续排序逻辑无需感知 rerank 存在。
   */
  private async applyRerank(query: string, hits: MemoryHit[], projectId?: string): Promise<MemoryHit[]> {
    const TOP_N = 64;
    const TOP_K = 32;
    if (hits.length === 0) return hits;

    // 截断到 TOP_N（Qdrant 已 limit=64，这里冗余保护）
    const candidates = hits.slice(0, TOP_N);

    try {
      const documents = candidates.map((hit) => `${hit.title}\n${hit.content}`);
      const rerankResult = await this.gateway.rerank({ purpose: "memory.rerank", query, documents, projectId });
      const scores = rerankResult.scores;
      if (scores.length !== candidates.length) {
        // scores 数量不匹配，降级
        return candidates.slice(0, TOP_K);
      }
      // 按 rerank score 降序排序，覆盖 semanticRank
      const reranked = candidates
        .map((hit, index) => ({ hit, rerankScore: Number(scores[index] ?? 0) }))
        .sort((a, b) => b.rerankScore - a.rerankScore)
        .slice(0, TOP_K)
        .map((entry) => ({
          ...entry.hit,
          score: entry.rerankScore,
          semanticRank: entry.rerankScore,
          reason: "qdrant dense + rerank",
        }));
      return reranked;
    } catch {
      // rerank 失败（模型不可用/超时/参数错误）→ 降级为纯 Qdrant score 顺序
      return candidates.slice(0, TOP_K);
    }
  }

  async upsertClaims(projectId: string, claims: MemoryClaim[]) {
    if (!claims.length) return;
    await this.ensureCollection();
    // 退役不变量（memory-visibility）：只有检索可见的声明才有资格退役向量点，
    // 否则未裁决的 candidate 会把它取代的旧派生事实从向量索引里盲删。
    const supersededIds = [...new Set(claims.filter((claim) => isVisibleClaimAuthority(claim.authority)).flatMap((claim) => claim.supersedes))];
    if (supersededIds.length) await this.deleteClaims(projectId, supersededIds);
    const embeddings = await this.gateway.embed({ purpose: "memory.embed", texts: claims.map((claim) => `${claim.title}\n${claim.content}`), projectId });
    if (embeddings.vectors.length !== claims.length || embeddings.vectors.some((vector) => vector.length !== this.dimension)) {
      throw new Error(`embedding 返回 ${embeddings.vectors.length} 个向量，要求 ${claims.length} 个且每个维度为 ${this.dimension}`);
    }
    await this.client.upsert(this.collection, {
      wait: true,
      points: claims.map((claim, index) => ({
        id: qdrantPointId(projectId, claim.id),
        vector: embeddings.vectors[index],
        payload: {
          projectId,
          authority: claim.authority,
          lifecycleStatus: claim.lifecycleStatus ?? "active",
          narrativeStart: claim.narrativeRange?.start ?? null,
          kind: claim.kind,
          // P0-A2: 存储 knowledgeScopeCharacterId 用于 POV 知识边界过滤
          // knowledgeScope="author" 时为 null（全局可见），{characterId} 时为该 characterId
          knowledgeScopeCharacterId: typeof claim.knowledgeScope === "object" && claim.knowledgeScope !== null
            ? claim.knowledgeScope.characterId
            : null,
          claim,
        },
      })),
    });
  }

  async deleteClaims(projectId: string, claimIds: string[]) {
    if (!claimIds.length) return;
    await this.ensureCollection();
    await this.client.delete(this.collection, {
      wait: true,
      points: [...new Set(claimIds)].map((claimId) => qdrantPointId(projectId, claimId)),
    });
  }
}
