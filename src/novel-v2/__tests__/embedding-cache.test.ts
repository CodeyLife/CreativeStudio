import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { ModelConfigStore } from "../model-config-store";
import { RoutedModelGateway, embeddingFingerprint, type EmbeddingCachePort } from "../model-gateway";
import type { ModelRoutingConfig } from "../model-routing";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function config(): ModelRoutingConfig {
  return {
    version: 1,
    profiles: [{
      id: "embed-primary", label: "Embed", protocol: "chat-completions", baseUrl: "https://example.test/v1", model: "embed-model",
      responseMode: "json", capabilities: ["text", "structured", "stream", "embedding", "rerank"], secret: { source: "inline", value: "k" }, enabled: true,
    }],
    routes: { "*": { candidates: [{ executor: "api", profileId: "embed-primary" }], conversationPolicy: "stateless" as const } },
  };
}

function embeddingResponse(vectors: number[][]) {
  return new Response(JSON.stringify({
    data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
    usage: { prompt_tokens: vectors.length, completion_tokens: 0, total_tokens: vectors.length },
  }), { status: 200 });
}

function memoryPort(seed: Record<string, number[]> = {}, seedModel = "embed-model"): EmbeddingCachePort & { hits: string[]; stored: Array<{ model: string; text: string }> } {
  const table = new Map(Object.entries(seed).map(([text, vector]) => [embeddingFingerprint(seedModel, text), vector]));
  const hits: string[] = [];
  const stored: Array<{ model: string; text: string }> = [];
  return {
    hits, stored,
    async lookupEmbeddings(model, texts) {
      hits.push(model);
      return texts.map((text) => table.get(embeddingFingerprint(model, text)));
    },
    async storeEmbeddings(model, entries) {
      for (const entry of entries) {
        table.set(embeddingFingerprint(model, entry.text), entry.vector);
        stored.push({ model, text: entry.text });
      }
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

// ===== OR-D2（product-audit-20260910 E5）嵌入幂等短路 =====
describe("embed 幂等短路（gateway 缓存端口）", () => {
  it("全部命中：零 provider 调用、向量按入参顺序返回（含同批重复文本）", async () => {
    const fetchMock = vi.fn(async () => embeddingResponse([[9]]));
    vi.stubGlobal("fetch", fetchMock);
    const port = memoryPort({ "甲": [1, 0], "乙": [0, 1] });
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()), undefined, undefined, port);

    const result = await gateway.embed({ purpose: "memory.embed", texts: ["甲", "乙", "甲"] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.vectors).toEqual([[1, 0], [0, 1], [1, 0]]);
    expect(result.usage.inputTokens).toBe(0);
    expect(port.stored).toHaveLength(0);
  });

  it("部分命中：只对缺失文本调一次 provider 并按实际模型回填，原序重组", async () => {
    const bodies: { input?: string[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      bodies.push(body);
      return embeddingResponse(body.input.map((text) => [text.charCodeAt(0) % 100, 1]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const port = memoryPort({ "甲": [1, 0] });
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()), undefined, undefined, port);

    const result = await gateway.embed({ purpose: "memory.embed", texts: ["甲", "丙", "丙", "丁"] });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.input).toEqual(["丙", "丁"]); // 去重后的缺失集
    expect(result.vectors).toEqual([[1, 0], [93, 1], [93, 1], [69, 1]]);
    expect(port.stored.map((entry) => entry.text)).toEqual(["丙", "丁"]);
    expect(port.stored.every((entry) => entry.model === "embed-model")).toBe(true);
  });

  it("缓存端口故障：查询抛错退化为直连（短路是增益不是新失败面），回填抛错不影响返回", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return embeddingResponse(body.input.map(() => [7]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const brokenLookup = new RoutedModelGateway(new ModelConfigStore("unused", config()), undefined, undefined, {
      async lookupEmbeddings() { throw new Error("cache down"); },
      async storeEmbeddings() { /* unused */ },
    });
    await expect(brokenLookup.embed({ purpose: "memory.embed", texts: ["甲"] })).resolves.toMatchObject({ vectors: [[7]] });
    expect(fetchMock).toHaveBeenCalledOnce();

    const brokenStore = new RoutedModelGateway(new ModelConfigStore("unused", config()), undefined, undefined, {
      async lookupEmbeddings() { return []; },
      async storeEmbeddings() { throw new Error("write down"); },
    });
    await expect(brokenStore.embed({ purpose: "memory.embed", texts: ["乙"] })).resolves.toMatchObject({ vectors: [[7]] });
  });

  it("未注入缓存端口：行为与直连一致（无回归）", async () => {
    const fetchMock = vi.fn(async () => embeddingResponse([[3]]));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()));
    await expect(gateway.embed({ purpose: "memory.embed", texts: ["甲"] })).resolves.toMatchObject({ vectors: [[3]] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ===== repository 持久实现 =====
describe("embedding_cache 持久实现", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const textA = `嵌入缓存测试甲-${randomUUID().slice(0, 8)}`;
  const textB = `嵌入缓存测试乙-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[embedding-cache.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.pool.query("DELETE FROM embedding_cache WHERE vector IS NOT NULL AND model=$1", ["it-embed-model"]).catch(() => undefined);
    await repository.close();
  });

  it("存-取往返、顺序对应、模型隔离、重复写不覆盖（幂等）", async () => {
    if (!available) return;
    expect(await repository.lookupEmbeddings("it-embed-model", [textA, textB])).toEqual([undefined, undefined]);
    await repository.storeEmbeddings("it-embed-model", [{ text: textA, vector: [1, 2, 3] }, { text: textB, vector: [4] }]);
    // 顺序对应（含重复入参）。
    expect(await repository.lookupEmbeddings("it-embed-model", [textB, textA, textB])).toEqual([[4], [1, 2, 3], [4]]);
    // 模型隔离：同文本不同模型不串用。
    expect(await repository.lookupEmbeddings("it-other-model", [textA])).toEqual([undefined]);
    // 幂等：重复 store 不报冲突，原值保留。
    await repository.storeEmbeddings("it-embed-model", [{ text: textA, vector: [999] }]);
    expect(await repository.lookupEmbeddings("it-embed-model", [textA])).toEqual([[1, 2, 3]]);
    // 含 SQL 特殊字符的文本安全往返（参数化防注入/防语法炸裂）。
    const tricky = `quote-'-${randomUUID().slice(0, 4)}-${JSON.stringify({ k: "v" })}`;
    await repository.storeEmbeddings("it-embed-model", [{ text: tricky, vector: [7] }]);
    expect(await repository.lookupEmbeddings("it-embed-model", [tricky])).toEqual([[7]]);
  });
});
