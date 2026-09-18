import { describe, expect, it } from "vitest";
import { FusionMemoryProvider } from "../fusion-memory";
import type { MemoryHit, MemoryProvider, RetrievalFacet } from "../protocol";

function hit(matchedFacet: string, score: number): MemoryHit {
  return {
    id: "shared-claim",
    projectId: "project-1",
    kind: "canonical",
    title: "世界观与主线规划",
    content: "世界观设定、人物档案和主线剧情",
    subjectRefs: [],
    knowledgeScope: "author",
    authority: "derived",
    confidence: 0.8,
    sourceRevisionIds: [],
    contentHash: "hash",
    supersedes: [],
    score,
    matchedFacet,
    matchedFacets: [matchedFacet],
    reason: "test",
  };
}

describe("FusionMemoryProvider", () => {
  it("preserves every facet satisfied by the same claim across tracks", async () => {
    const semantic: MemoryProvider = { search: async () => [hit("fact", 0.7)] };
    const lexical = {
      search: async (_input: { projectId: string; facets: RetrievalFacet[] }) => [
        { ...hit("thread", 0.9), matchedFacets: ["fact", "thread", "foreshadowing"] },
      ],
    };
    const provider = new FusionMemoryProvider({ semantic, lexical });

    const results = await provider.search({
      projectId: "project-1",
      facets: [
        { kind: "fact", query: "世界观", required: true },
        { kind: "thread", query: "主线", required: false },
        { kind: "foreshadowing", query: "承诺", required: false },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].matchedFacets).toEqual(["fact", "thread", "foreshadowing"]);
  });

  it("returns more than 32 fused candidates for downstream token budgeting", async () => {
    const semantic: MemoryProvider = { search: async () => Array.from({ length: 40 }, (_, index) => ({ ...hit("fact", 1 - index / 100), id: `claim-${index}` })) };
    const provider = new FusionMemoryProvider({ semantic, lexical: { search: async () => [] }, perTrackLimit: 40 });
    const results = await provider.search({ projectId: "project-1", facets: [{ kind: "fact", query: "事实", required: true }] });
    expect(results).toHaveLength(40);
  });

  it("身份指纹跨轨保留：载荷缺字段时由另一轨补上，配额不得取决于轨道顺序", async () => {
    // 槽位配额与同值判重以 identityHash 为键；融合层若只保留先到那轨的字段，
    // 同一 claim 的"有没有指纹"就变成召回顺序的函数（旧索引载荷/词法轨都曾缺）。
    const staleIndexPayload = hit("fact", 0.7);
    const lexicalWithFingerprint = { ...hit("fact", 0.9), identityHash: "slot-hero-held", valueHash: "value-9" };
    const provider = new FusionMemoryProvider({
      semantic: { search: async () => [staleIndexPayload] } as MemoryProvider,
      lexical: { search: async () => [lexicalWithFingerprint] },
    });
    const results = await provider.search({ projectId: "project-1", facets: [{ kind: "fact", query: "世界观", required: true }] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ identityHash: "slot-hero-held", valueHash: "value-9" });
  });
});
