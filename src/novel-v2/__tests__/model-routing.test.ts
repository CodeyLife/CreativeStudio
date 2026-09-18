import { mkdtemp, rm } from "node:fs/promises";
import { isPostgresUnavailable } from "./test-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfigStore, applyRuntimeModelOverrides } from "../model-config-store";
import { normalizeProviderJsonSchema, RoutedModelGateway } from "../model-gateway";
import { NovelPostgresRepository } from "../postgres-repository";
import { ExternalMcpRequiredError, ModelRoutingConfigError, createRoutingSnapshot, resolveRoute, syncExternalMcpHttpStatus, validateModelRoutingConfig, type ModelProviderProfile, type ModelRoutingConfig } from "../model-routing";

function profile(overrides: Partial<ModelProviderProfile> = {}): ModelProviderProfile {
  return {
    id: "primary",
    label: "Primary",
    protocol: "chat-completions",
    baseUrl: "https://example.test/v1",
    model: "writer-model",
    responseMode: "json",
    capabilities: ["text", "structured", "stream", "embedding", "rerank"],
    secret: { source: "inline", value: "toolkey-secret" },
    enabled: true,
    ...overrides,
  };
}

function config(profiles = [profile()], candidates: ModelRoutingConfig["routes"][string]["candidates"] = [{ executor: "api", profileId: "primary" }]): ModelRoutingConfig {
  return { version: 1, profiles, routes: { "*": { candidates, conversationPolicy: "stateless" } } };
}

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

afterEach(() => vi.unstubAllGlobals());

describe("model routing config", () => {
  it("maps the external-MCP wait to 503 for synchronous paths and leaves other errors untouched", () => {
    // 同步链路（短剧/章节剧本直出）没有外部任务物化通道：ExternalMcpRequiredError
    // 映射 503 + 可行动文案，其余错误返回 null 由调用方按原通道处理。
    expect(syncExternalMcpHttpStatus(new ExternalMcpRequiredError("writing.script", "snapshot-1", 1))).toBe(503);
    expect(syncExternalMcpHttpStatus(new Error("普通错误"))).toBeNull();
    expect(syncExternalMcpHttpStatus(undefined)).toBeNull();
  });

  it("overrides only the embedding route profile base URL for the active runtime", () => {
    const next = config([
      profile({ id: "writer", capabilities: ["text"] }),
      profile({ id: "embedding", capabilities: ["embedding"], baseUrl: "http://embedding/v1" }),
    ]);
    next.routes["memory.embed"] = { candidates: [{ executor: "api", profileId: "embedding" }] };
    const overridden = applyRuntimeModelOverrides(next, { embeddingBaseUrl: "http://127.0.0.1:8081/v1/" });
    expect(overridden.profiles.find((item) => item.id === "embedding")?.baseUrl).toBe("http://127.0.0.1:8081/v1");
    expect(overridden.profiles.find((item) => item.id === "writer")?.baseUrl).toBe("https://example.test/v1");
    expect(next.profiles.find((item) => item.id === "embedding")?.baseUrl).toBe("http://embedding/v1");
  });

  it("supports a different model override for each vector purpose on one provider", async () => {
    const next = config(
      [profile({ id: "vectors", model: "default-model", capabilities: ["embedding", "rerank"] })],
      [],
    );
    next.routes["memory.embed"] = { candidates: [{ executor: "api", profileId: "vectors", model: "embed-model" }] };
    next.routes["memory.rerank"] = { candidates: [{ executor: "api", profileId: "vectors", model: "rerank-model" }] };
    const requestedModels: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requestedModels.push(JSON.parse(String(init?.body)).model);
      return url.endsWith("/embeddings")
        ? new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 })
        : new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), { status: 200 });
    }));
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next));

    await gateway.embed({ purpose: "memory.embed", texts: ["文本"] });
    await gateway.rerank({ purpose: "memory.rerank", query: "查询", documents: ["文本"] });

    expect(requestedModels).toEqual(["embed-model", "rerank-model"]);
  });

  it("masks inline secrets and never includes them in the routing snapshot", () => {
    const store = new ModelConfigStore("unused", config());
    expect(store.getMaskedConfig().profiles[0]).toMatchObject({ hasSecret: true, secretHint: "***cret" });
    expect(JSON.stringify(createRoutingSnapshot(config()))).not.toContain("toolkey-secret");
  });

  it("reloads file changes before a long-lived worker gateway resolves the next route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ymcp-model-config-"));
    const path = join(dir, "model-providers.local.yaml");
    try {
      const initial = config([profile({ model: "old-model" })]);
      const updated = config([profile({ model: "new-model" })]);
      const apiStore = new ModelConfigStore(path, initial);
      await apiStore.save(initial);

      const workerStore = new ModelConfigStore(path);
      await workerStore.load();
      const gateway = new RoutedModelGateway(workerStore);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await apiStore.save(updated);

      const requestedModels: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        requestedModels.push(JSON.parse(String(init?.body)).model);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }));

      const result = await gateway.generateText({ purpose: "writing.draft", prompt: "p" });

      expect(result.text).toBe("ok");
      expect(requestedModels).toEqual(["new-model"]);
      expect(result.provenance.model).toBe("new-model");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores the removed structuredOutput field when loading legacy provider config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ymcp-model-config-legacy-"));
    const path = join(dir, "model-providers.local.yaml");
    try {
      await (await import("node:fs/promises")).writeFile(path, [
        "version: 1",
        "profiles:",
        "  - id: primary",
        "    label: Primary",
        "    protocol: chat-completions",
        "    baseUrl: https://example.test/v1",
        "    model: writer-model",
        "    structuredOutput: prompt",
        "    capabilities: [text, structured, stream, embedding, rerank]",
        "    enabled: true",
        "routes:",
        "  '*':",
        "    candidates:",
        "      - executor: api",
        "        profileId: primary",
      ].join("\n"), "utf8");
      const store = new ModelConfigStore(path);
      await store.load();
      expect(store.getProfile("primary")).not.toHaveProperty("structuredOutput");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips legacy explicit external-mcp candidates when loading a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ymcp-model-config-legacy-external-"));
    const path = join(dir, "model-providers.local.yaml");
    try {
      await (await import("node:fs/promises")).writeFile(path, [
        "version: 1",
        "profiles:",
        "  - id: primary",
        "    label: Primary",
        "    protocol: chat-completions",
        "    baseUrl: https://example.test/v1",
        "    model: writer-model",
        "    capabilities: [text, structured, stream, embedding, rerank]",
        "    enabled: true",
        "routes:",
        "  '*':",
        "    candidates:",
        "      - executor: api",
        "        profileId: primary",
        "      - executor: external-mcp",
        "  writing.draft:",
        "    candidates:",
        "      - executor: external-mcp",
      ].join("\n"), "utf8");
      const store = new ModelConfigStore(path);
      await store.load();
      const loaded = store.getConfig();
      // 剥离后 API 候选保留、显式外部候选移除；纯外部路由变为空链（纯兜底）。
      expect(loaded.routes["*"].candidates).toEqual([{ executor: "api", profileId: "primary" }]);
      expect(loaded.routes["writing.draft"].candidates).toEqual([]);
      // 剥离结果必须通过新契约校验（可保存回写）。
      expect(() => validateModelRoutingConfig(loaded)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects task-chain on non-writing purposes", () => {
    const invalid = config([profile({ protocol: "responses", capabilities: ["text", "structured", "responses-continuation", "embedding", "rerank"] })]);
    invalid.routes = { "review.*": { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "task-chain" }, "*": { candidates: [{ executor: "api", profileId: "primary" }] } };
    expect(() => validateModelRoutingConfig(invalid)).toThrow(ModelRoutingConfigError);
  });

  it("allows Foundation review to use a dedicated structured route", () => {
    const next = config([profile()]);
    next.routes["review.*"] = { candidates: [], conversationPolicy: "stateless" };
    next.routes["review.foundation"] = { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "stateless" };
    expect(resolveRoute(next, "review.foundation")).toEqual(next.routes["review.foundation"]);
    expect(() => validateModelRoutingConfig(next)).not.toThrow();
  });

  it("allows an empty candidate chain as the external-MCP fallback form", () => {
    const next = config([profile()]);
    next.routes["*"] = { candidates: [], conversationPolicy: "stateless" };
    expect(() => validateModelRoutingConfig(next)).not.toThrow();
  });

  it("rejects explicit external-mcp candidates now that the fallback is implicit", () => {
    const invalid = config([], [{ executor: "external-mcp" }]);
    expect(() => validateModelRoutingConfig(invalid)).toThrow(/不允许显式 external-mcp/);
    const chained = config([profile({ id: "a" }), profile({ id: "b" })], [{ executor: "api", profileId: "a" }, { executor: "external-mcp" }, { executor: "api", profileId: "b" }]);
    expect(() => validateModelRoutingConfig(chained)).toThrow(/不允许显式 external-mcp/);
  });

  it("resolves canonical chapter review purposes through the review wildcard", () => {
    const next = config([profile()]);
    next.routes = {
      "review.*": { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "stateless" },
      "*": { candidates: [], conversationPolicy: "stateless" },
    };
    expect(resolveRoute(next, "review.structure")).toEqual(next.routes["review.*"]);
    expect(resolveRoute(next, "review.prose")).toEqual(next.routes["review.*"]);
    expect(() => validateModelRoutingConfig(next)).not.toThrow();
  });
});

describe("model routing persistence", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn("[model-routing.test] Postgres 不可用，跳过持久化测试: " + (error as Error).message);
    }
  }, 30000);

  afterAll(async () => {
    if (postgresAvailable && repository) await repository.close();
  });

  it("persists empty candidate chains (implicit external fallback) as JSONB arrays", async () => {
    if (!postgresAvailable) return;
    const next = config([], []);
    const snapshot = createRoutingSnapshot(next);
    await repository.projectModelRoutingConfig(next, snapshot);
    const result = await repository.pool.query("SELECT candidates FROM model_routes WHERE task_class = $1", ["*"]);
    expect(result.rows[0].candidates).toEqual([]);
  });

  it("serializes concurrent API and worker routing refreshes", async () => {
    if (!postgresAvailable) return;
    const next = config([profile()]);
    const snapshot = createRoutingSnapshot(next);
    await expect(Promise.all([
      repository.projectModelRoutingConfig(next, snapshot),
      repository.projectModelRoutingConfig(next, snapshot),
    ])).resolves.toHaveLength(2);
    const providers = await repository.pool.query("SELECT id FROM provider_configs WHERE config_revision=$1", [snapshot.id]);
    expect(providers.rows).toHaveLength(snapshot.profiles.length);
  });
});

describe("RoutedModelGateway adapters", () => {
  it("adds inferable primitive types for enum and const schema nodes at transport time", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "passed", enabled: true }) } }] }), { status: 200 });
    }));
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "enabled"],
      properties: { verdict: { enum: ["passed"] }, enabled: { const: true } },
    };
    await expect(new RoutedModelGateway(new ModelConfigStore("unused", config())).generateStructured({ purpose: "review.arc", prompt: "输出审核结果", schema })).resolves.toMatchObject({ value: { verdict: "passed", enabled: true } });
    const sent = (requestBody?.response_format as Record<string, unknown>)?.json_schema as Record<string, unknown>;
    expect(sent.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "enabled"],
      properties: { verdict: { enum: ["passed"], type: "string" }, enabled: { const: true, type: "boolean" } },
    });
    expect(normalizeProviderJsonSchema(schema)).toEqual(sent.schema);
    expect(schema.properties.verdict).toEqual({ enum: ["passed"] });
  });

  it("aggregates one stateless Chat Completions SSE request", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "complete prompt" }]);
      expect(body.stream).toBe(true);
      const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"id":"r1","choices":[{"delta":{"content":"hello "}}]}\n\n')); controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n')); controller.close(); } });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new ModelConfigStore("unused", config([profile({ responseMode: "sse" })]));
    const result = await new RoutedModelGateway(store).generateText({ purpose: "writing.draft", system: "sys", prompt: "complete prompt" });
    expect(result.text).toBe("hello world");
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates provider cached input usage into the invocation audit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 12, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } },
    }), { status: 200 })));
    const recorder = vi.fn(async () => undefined);
    const result = await new RoutedModelGateway(new ModelConfigStore("unused", config()), recorder).generateText({ purpose: "writing.draft", prompt: "完整上下文" });

    expect(result.usage).toMatchObject({ providerInputTokens: 12, providerCachedInputTokens: 8 });
    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({ providerInputTokens: 12, providerCachedInputTokens: 8 }));
  });

  it("records the provider label and response body for failed model calls before the external fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"error\":\"Insufficient Balance\"}", { status: 402 })));
    const recorder = vi.fn(async () => undefined);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()), recorder);

    // 402 留痕后走链尾兜底：最终抛出 ExternalMcpRequiredError，且兜底位有 waiting-external 留痕。
    await expect(gateway.generateText({ purpose: "review.prose", prompt: "审校正文" })).rejects.toBeInstanceOf(ExternalMcpRequiredError);
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      providerLabel: "Primary",
      model: "writer-model",
      errorCategory: "http-402",
      errorMessage: expect.stringContaining("Insufficient Balance"),
    }));
    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({ status: "waiting-external", executor: "external-mcp" }));
  });

  it("uses previous_response_id only for a configured Responses writing chain", async () => {
    const responsesProfile = profile({ protocol: "responses", responseMode: "json", capabilities: ["text", "structured", "responses-continuation", "embedding", "rerank"] });
    const next = config([responsesProfile]);
    next.routes["*"] = { candidates: [{ executor: "api", profileId: "primary" }] };
    next.routes["writing.*"] = { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "task-chain" };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ previous_response_id: "resp_previous", input: "revise" });
      return new Response(JSON.stringify({ id: "resp_next", output_text: "done", usage: { input_tokens: 12, output_tokens: 3 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new RoutedModelGateway(new ModelConfigStore("unused", next)).generateText({ purpose: "writing.revision", prompt: "revise", previousProfileId: "primary", previousResponseId: "resp_previous" });
    expect(result.provenance.responseId).toBe("resp_next");
  });

  it("uses the Responses schema contract without repeating the JSON Schema in user input", async () => {
    const responsesProfile = profile({ protocol: "responses", responseMode: "json", capabilities: ["text", "structured", "stream", "embedding", "rerank"] });
    const next = config([responsesProfile]);
    const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "response-1", output_text: JSON.stringify({ ok: true }) }), { status: 200 });
    }));

    await expect(new RoutedModelGateway(new ModelConfigStore("unused", next)).generateStructured({
      purpose: "review.arc",
      prompt: "只判断当前故事弧是否满足状态合同。",
      schema,
    })).resolves.toMatchObject({ value: { ok: true } });

    expect(requestBody?.input).toBe("只判断当前故事弧是否满足状态合同。");
    expect(JSON.stringify(requestBody?.input)).not.toContain("additionalProperties");
    expect(requestBody?.text).toEqual({ format: { type: "json_schema", name: "model_output", strict: true, schema } });
  });

  it("uses the native Chat Completions schema envelope without prompt fallback", async () => {
    const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 });
    }));

    await expect(new RoutedModelGateway(new ModelConfigStore("unused", config())).generateStructured({
      purpose: "review.prose",
      prompt: "只检查当前段落的事实边界。",
      schema,
    })).resolves.toMatchObject({ value: { ok: true } });

    expect(requestBody?.messages).toEqual([{ role: "user", content: "只检查当前段落的事实边界。" }]);
    expect(JSON.stringify(requestBody?.messages)).not.toContain("additionalProperties");
    expect(requestBody?.response_format).toEqual({ type: "json_schema", json_schema: { name: "model_output", strict: true, schema } });
  });

  it("moves to the next explicit candidate after a non-retryable provider error", async () => {
    const profiles = [profile({ id: "bad" }), profile({ id: "good", model: "good-model" })];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config(profiles, [{ executor: "api", profileId: "bad" }, { executor: "api", profileId: "good" }])));
    const result = await gateway.generateText({ purpose: "writing.draft", prompt: "p" });
    expect(result.text).toBe("ok");
    expect(result.provenance).toMatchObject({ candidateIndex: 1, profileId: "good", model: "good-model" });
  });

  it("moves structured calls to the next API candidate after an exhausted empty response", async () => {
    const profiles = [profile({ id: "empty" }), profile({ id: "good", model: "good-model" })];
    const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config(profiles, [
      { executor: "api", profileId: "empty" },
      { executor: "api", profileId: "good" },
    ])));

    const result = await gateway.generateStructured<{ ok: boolean }>({
      purpose: "facts.extract",
      prompt: "extract",
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.provenance).toMatchObject({ candidateIndex: 1, profileId: "good", model: "good-model" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to the implicit external-MCP tail after every API candidate fails", async () => {
    const profiles = [profile({ id: "bad" })];
    const fetchMock = vi.fn().mockResolvedValue(new Response("gateway unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const recorder = vi.fn(async () => undefined);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config(profiles, [{ executor: "api", profileId: "bad" }])), recorder);

    // API 候选重试耗尽后进入链尾兜底：抛 ExternalMcpRequiredError，候选位为链长（虚拟兜底位）。
    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p", workflowRunId: "run-1", taskId: "task-1" }))
      .rejects.toMatchObject({ name: "ExternalMcpRequiredError", candidateIndex: 1 });
    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({
      purpose: "writing.draft",
      candidateIndex: 1,
      executor: "external-mcp",
      status: "waiting-external",
    }));
  });

  it("uses the implicit external-MCP tail when the candidate chain is empty", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const recorder = vi.fn(async () => undefined);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config([profile()], [])), recorder);

    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p", workflowRunId: "run-1", taskId: "task-1" }))
      .rejects.toMatchObject({ name: "ExternalMcpRequiredError", candidateIndex: 0 });
    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({
      purpose: "writing.draft",
      candidateIndex: 0,
      executor: "external-mcp",
      status: "waiting-external",
    }));
  });

  it("counts the final prompt against the effective context budget and records the failure", async () => {
    const next = config([profile({ contextWindow: 64 })]);
    next.routes["*"] = { candidates: [{ executor: "api", profileId: "primary" }], maxInputTokens: 40, maxOutputTokens: 16 };
    const promptRecorder = vi.fn(async () => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next), undefined, promptRecorder);

    await expect(gateway.generateStructured({ purpose: "review.prose", prompt: "正文".repeat(100), schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }, maxTokens: 16 }))
      .rejects.toThrow("context-budget-exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(promptRecorder).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorCategory: "context-budget-exceeded" }));
  });

  it("keeps the original task semantics while repairing invalid structured output", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requestBodies.length === 1
        ? JSON.stringify({ score: 4 })
        : JSON.stringify({ name: "保留克制对白", score: 4 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()));

    const result = await gateway.generateStructured<{ name: string; score: number }>({
      purpose: "review.prose",
      system: "你是对白修订目标验收员。",
      prompt: "检查候选是否减少解释性对白，并保留人物之间的试探感。",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "score"],
        properties: { name: { type: "string" }, score: { type: "number" } },
      },
      maxRepairAttempts: 1,
    });

    expect(result.value).toEqual({ name: "保留克制对白", score: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairMessages = requestBodies[1].messages as Array<{ role: string; content: string }>;
    expect(repairMessages.find((message) => message.role === "system")?.content).toContain("对白修订目标验收员");
    expect(repairMessages.find((message) => message.role === "user")?.content).toContain("减少解释性对白，并保留人物之间的试探感");
  });

  it("bounds invalid output carried into schema repair without dropping the original task", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const next = config();
    next.routes["*"] = { candidates: [{ executor: "api", profileId: "primary" }], maxInputTokens: 400, maxOutputTokens: 64 };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requestBodies.length === 1 ? `{"invalid":"${"冗余输出".repeat(500)}"}` : JSON.stringify({ ok: true });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next));

    await expect(gateway.generateStructured<{ ok: boolean }>({
      purpose: "review.prose",
      prompt: "核对人物是否通过行动而非解释性对白表达戒备。",
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
      maxTokens: 64,
      maxRepairAttempts: 1,
    })).resolves.toMatchObject({ value: { ok: true } });

    const repairMessages = requestBodies[1].messages as Array<{ role: string; content: string }>;
    const repairPrompt = repairMessages.find((message) => message.role === "user")?.content ?? "";
    expect(repairPrompt).toContain("核对人物是否通过行动而非解释性对白表达戒备");
    expect(repairPrompt).toContain("因上下文预算仅保留开头");
    expect(repairPrompt.length).toBeLessThan(800);
  });

  it("applies route context budgets before the implicit external-MCP tail fallback", async () => {
    const next = config([], []);
    next.routes["*"] = { candidates: [], maxInputTokens: 10 };
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next));
    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "超长正文".repeat(20) }))
      .rejects.toThrow("context-budget-exceeded");
  });

  it("uses the SiliconFlow embedding contract and restores response index order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://example.test/v1/embeddings");
      expect(JSON.parse(String(init?.body))).toEqual({ model: "writer-model", input: ["甲", "乙"], encoding_format: "float" });
      return new Response(JSON.stringify({
        data: [
          { object: "embedding", index: 1, embedding: [0, 1] },
          { object: "embedding", index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RoutedModelGateway(new ModelConfigStore("unused", config())).embed({ purpose: "memory.embed", texts: ["甲", "乙"] });

    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 0, usageSource: "provider" });
  });

  it("maps SiliconFlow sorted rerank results back to document order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://example.test/v1/rerank");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "writer-model",
        query: "人物关系",
        documents: ["天气", "旧友重逢", "城门"],
        top_n: 3,
        return_documents: false,
      });
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 2, relevance_score: 0.37 },
          { index: 0, relevance_score: 0.08 },
        ],
        meta: { tokens: { input_tokens: 12, output_tokens: 3 } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RoutedModelGateway(new ModelConfigStore("unused", config())).rerank({
      purpose: "memory.rerank",
      query: "人物关系",
      documents: ["天气", "旧友重逢", "城门"],
    });

    expect(result.scores).toEqual([0.08, 0.91, 0.37]);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, usageSource: "provider" });
  });

  it("rejects an incomplete rerank response instead of assigning silent zero scores", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.91 }],
      meta: { tokens: { input_tokens: 4, output_tokens: 1 } },
    }), { status: 200 })));

    await expect(new RoutedModelGateway(new ModelConfigStore("unused", config())).rerank({
      purpose: "memory.rerank",
      query: "关系",
      documents: ["天气", "旧友"],
    })).rejects.toThrow("要求覆盖 2 个文档");
  });

  it("marks an exhausted retryable transport failure as non-retryable when no fallback applies", async () => {
    // memory.rerank 是向量链路：没有外部任务物化路径，兜底不适用，候选耗尽仍快速失败。
    const fetchMock = vi.fn().mockResolvedValue(new Response("gateway unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()));

    await expect(gateway.rerank({ purpose: "memory.rerank", query: "q", documents: ["文本"] }))
      .rejects.toMatchObject({ name: "ModelTransportError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("also falls back to the external-MCP tail after structured validation exhausts the chain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{\"wrong\":\"shape\"}" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const recorder = vi.fn(async () => undefined);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()), recorder);

    // 修复循环耗尽后 schema 校验失败 → 跳过剩余 API 候选（无）→ 链尾兜底。
    await expect(gateway.generateStructured({
      purpose: "review.prose",
      prompt: "review",
      schema: { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: { type: "string" } } },
      maxRepairAttempts: 0,
      workflowRunId: "run-1",
      taskId: "task-1",
    })).rejects.toMatchObject({ name: "ExternalMcpRequiredError", candidateIndex: 1 });
    expect(recorder).toHaveBeenLastCalledWith(expect.objectContaining({ status: "waiting-external", candidateIndex: 1 }));
  });

  it("does not call fetch for an external MCP route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config([], [])));
    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p" })).rejects.toBeInstanceOf(ExternalMcpRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the native Responses schema envelope without copying schema into the prompt", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: JSON.stringify({ verdict: "passed", score: 5, issues: [] }) }), { status: 200 });
    }));
    const responsesProfile = profile({ protocol: "responses", responseMode: "json", capabilities: ["text", "structured", "responses-continuation", "embedding", "rerank"] });
    const schema = { type: "object", additionalProperties: false, required: ["verdict", "score", "issues"], properties: { verdict: { enum: ["passed"] }, score: { type: "number" }, issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string" } } } } } };

    await expect(new RoutedModelGateway(new ModelConfigStore("unused", config([responsesProfile]))).generateStructured({
      purpose: "review.prose",
      prompt: "审核正文",
      schema,
      maxRepairAttempts: 0,
    })).resolves.toMatchObject({ value: { verdict: "passed", score: 5, issues: [] } });

    expect(requestBody?.text).toMatchObject({ format: { type: "json_schema", strict: true, schema } });
    expect(requestBody?.input).toBe("审核正文");
    expect(String(requestBody?.input)).not.toContain(JSON.stringify(schema));
  });
});
