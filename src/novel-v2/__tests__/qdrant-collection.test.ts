import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { ModelGateway } from "../model-gateway";
import type { MemoryClaim } from "../protocol";
import { NO_SEMANTIC_SEARCH, QdrantMemoryProvider } from "../qdrant-memory";
import { qdrantPointId } from "../memory-point-id";

describe("Qdrant collection identity", () => {
  it("maps arbitrary business ids to stable project-scoped UUID point ids", () => {
    const first = qdrantPointId("project-a", "foundation:character:主角");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(qdrantPointId("project-a", "foundation:character:主角")).toBe(first);
    expect(qdrantPointId("project-b", "foundation:character:主角")).not.toBe(first);
  });

  it("keeps the original claim id in payload while upserting with a UUID", async () => {
    const upsert = vi.fn();
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      upsert,
    } as unknown as QdrantClient;
    const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]] })) } as unknown as ModelGateway;
    const claim: MemoryClaim = {
      id: "foundation:character:配角",
      projectId: "project-a",
      kind: "canonical",
      title: "配角",
      content: "首次登场",
      subjectRefs: ["character:配角"],
      knowledgeScope: "author",
      authority: "approved",
      confidence: 1,
      sourceRevisionIds: [],
      contentHash: "content-hash",
      supersedes: [],
    };

    await new QdrantMemoryProvider(client, gateway, "memory", 3).upsertClaims("project-a", [claim]);

    expect(upsert).toHaveBeenCalledWith("memory", expect.objectContaining({
      points: [expect.objectContaining({
        id: qdrantPointId("project-a", claim.id),
        payload: expect.objectContaining({ claim, lifecycleStatus: "active" }),
      })],
    }));
  });

  it("召回侧按 payload 的 lifecycle/authority 预筛（服务端过滤，省召回名额）", async () => {
    const query = vi.fn(async () => ({ points: [] }));
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      query,
    } as unknown as QdrantClient;
    const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]] })) } as unknown as ModelGateway;

    await new QdrantMemoryProvider(client, gateway, "memory", 3).search({
      projectId: "project-a",
      narrativeCutoff: 11,
      facets: [{ kind: "fact", query: "事实", required: true }],
    });

    expect(query).toHaveBeenCalledWith("memory", expect.objectContaining({
      filter: expect.objectContaining({
        must: expect.arrayContaining([
          { key: "lifecycleStatus", match: { value: "active" } },
          expect.objectContaining({ should: expect.any(Array) }),
        ]),
      }),
    }));
  });

  it("空召回不回库存活判定（无 id 可问，也不该触发未接判定的默认抛错）", async () => {
    const query = vi.fn(async () => ({ points: [] }));
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      query,
    } as unknown as QdrantClient;
    const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]] })) } as unknown as ModelGateway;
    const filterLiveRowIds = vi.fn(async (_projectId: string, rowIds: string[]) => new Set(rowIds));
    const hits = await new QdrantMemoryProvider(client, gateway, "memory", 3, filterLiveRowIds)
      .search({ projectId: "project-a", facets: [{ kind: "fact", query: "事实", required: true }] });
    expect(hits).toEqual([]);
    expect(filterLiveRowIds, "零命中时不该多打一次库").not.toHaveBeenCalled();
  });

  /**
   * 存活判定是 A1/FM-1 在语义检索侧的唯一落点。
   *
   * 立用例的形态是实测出来的：`ymcp` 索引里有 22 个"已被可见杀手退役"的点与 5 个
   * "行已 staged"的点。此前只拿命中集自身的 `payload.supersedes` 互相屏蔽，杀手不与
   * 受害者同时进 top-64 就失效——所以这里刻意让杀手**不在**召回结果里。
   */
  it("丢弃已不在库内可见集的点，即使它的杀手没被同窗召回", async () => {
    const point = (claim: Partial<MemoryClaim> & { id: string }) => ({
      id: qdrantPointId("project-a", claim.id),
      score: 0.9,
      payload: { claim: { projectId: "project-a", kind: "episodic", authority: "approved", lifecycleStatus: "active", supersedes: [], ...claim } },
    });
    const query = vi.fn(async () => ({
      points: [
        point({ id: "claim:live", title: "现行值", content: "现行值" }),
        // 受害者：payload 仍是索引时刻的"active + approved"，库里早已被那条杀手退役。
        point({ id: "claim:retired", title: "陈旧值", content: "陈旧值" }),
        point({ id: "memory:chapter:rev-9", title: "第 9 章记忆", content: "已删弧遗留" }),
      ],
    }));
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      query,
    } as unknown as QdrantClient;
    const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]] })) } as unknown as ModelGateway;
    const filterLiveRowIds = vi.fn(async (_projectId: string, rowIds: string[]) => new Set(rowIds.filter((rowId) => rowId === "claim:live")));

    const hits = await new QdrantMemoryProvider(client, gateway, "memory", 3, filterLiveRowIds)
      .search({ projectId: "project-a", facets: [{ kind: "fact", query: "事实", required: true }] });

    expect(hits.map((hit) => hit.id), "payload 说它活着不算数，库里不可见就不召回").toEqual(["claim:live"]);
    expect(filterLiveRowIds).toHaveBeenCalledWith("project-a", ["claim:live", "claim:retired", "memory:chapter:rev-9"]);
  });

  it("问不到存活集就整轨失败，不静默放行陈旧事实", async () => {
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      query: vi.fn(async () => ({ points: [{ id: "p1", score: 0.9, payload: { claim: { id: "claim:a", projectId: "project-a", kind: "episodic", authority: "approved", lifecycleStatus: "active", supersedes: [] } } }] })),
    } as unknown as QdrantClient;
    const gateway = { embed: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]] })) } as unknown as ModelGateway;
    const provider = new QdrantMemoryProvider(client, gateway, "memory", 3, NO_SEMANTIC_SEARCH);
    await expect(provider.search({ projectId: "project-a", facets: [{ kind: "fact", query: "事实", required: true }] })).rejects.toThrow(/未接存活判定/);
  });

  it("resolves an alias without trying to create a same-name physical collection", async () => {
    const createCollection = vi.fn();
    const client = { getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 1024 } } } })), createCollection } as unknown as QdrantClient;
    await new QdrantMemoryProvider(client, {} as ModelGateway, "novel-memory-current", 1024).ensureCollection();
    expect(client.getCollection).toHaveBeenCalledWith("novel-memory-current");
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("deletes obsolete claim points with the same project-scoped id contract", async () => {
    const remove = vi.fn();
    const client = {
      getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 3 } } } })),
      delete: remove,
    } as unknown as QdrantClient;
    const provider = new QdrantMemoryProvider(client, {} as ModelGateway, "memory", 3);
    await provider.deleteClaims("project-a", ["old-claim", "old-claim"]);
    expect(remove).toHaveBeenCalledWith("memory", {
      wait: true,
      points: [qdrantPointId("project-a", "old-claim")],
    });
  });

  it("rejects an alias or collection backed by vectors with another dimension", async () => {
    const client = { getCollection: vi.fn(async () => ({ config: { params: { vectors: { size: 1536 } } } })) } as unknown as QdrantClient;
    await expect(new QdrantMemoryProvider(client, {} as ModelGateway, "novel-memory-current", 1024).ensureCollection()).rejects.toThrow(/1536.*1024/);
  });

  /**
   * 源面锁：存活判定只许有一个来源（库内可见集），payload 副本不得再被当成第二套口径。
   * 剥注释行再判，否则本文件与代码里的说明文字会自己定罪自己。
   */
  it("检索侧不得复活按 payload 判存活的近似", () => {
    const body = readFileSync(new URL("../qdrant-memory.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");
    const search = body.slice(body.indexOf("async search("), body.indexOf("applyRerank(query"));
    expect(search, "召回后必须回库问一次存活集").toContain("this.filterLiveRowIds(");
    expect(search.match(/hit\.supersedes/gu) ?? [], "同窗互相屏蔽的近似判据不得复活").toHaveLength(0);
    expect(search.match(/claim\.lifecycleStatus === "staged"/gu) ?? [], "payload 的 lifecycle 副本不得再作存活判据").toHaveLength(0);
    expect(search.match(/claim\.authority/gu) ?? [], "payload 的 authority 副本同理").toHaveLength(0);

    for (const service of ["../../../scripts/novel-v2-api.ts", "../../../scripts/novel-v2-worker.ts"]) {
      expect(readFileSync(new URL(service, import.meta.url), "utf8"), "读侧服务必须接真判据，否则 search 直接抛错").toContain("filterIndexableMemoryRowIds");
    }
  });
});
