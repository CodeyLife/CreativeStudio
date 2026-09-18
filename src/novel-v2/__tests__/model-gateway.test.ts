import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { InMemoryModelGateway, normalizeStructuredContent, normalizeUsage, RoutedModelGateway, type GenerateStructuredInput, type ModelGateway, type ModelUsage } from "../model-gateway";
import { ModelConfigStore } from "../model-config-store";
import { ExternalMcpRequiredError, type ModelRoutingConfig } from "../model-routing";

const usage: ModelUsage = { model: "test", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };

const passthroughSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "score"],
  properties: {
    name: { type: "string", minLength: 1 },
    score: { type: "number", minimum: 0, maximum: 5 },
  },
} as const;

interface Passthrough {
  name: string;
  score: number;
}

describe("InMemoryModelGateway generateText", () => {
  it("returns string responses untouched and stringifies objects", async () => {
    const stringGateway = new InMemoryModelGateway(() => "hello");
    const result = await stringGateway.generateText({ purpose: "writing.draft", prompt: "p" });
    expect(result.text).toBe("hello");
    expect(result.usage.model).toBe("in-memory");

    const objectGateway = new InMemoryModelGateway(() => ({ a: 1 }));
    const objectResult = await objectGateway.generateText({ purpose: "writing.draft", prompt: "p" });
    expect(objectResult.text).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("InMemoryModelGateway generateStructured ajv contract", () => {
  it("returns the validated value when the responder conforms to the schema", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "alpha", score: 4 }));
    const input: GenerateStructuredInput<Passthrough> = {
      purpose: "facts.extract",
      prompt: "p",
      schema: passthroughSchema as unknown as Record<string, unknown>,
      schemaName: "passthrough",
    };
    const result = await gateway.generateStructured<Passthrough>(input);
    expect(result.value).toEqual({ name: "alpha", score: 4 });
    expect(result.usage.model).toBe("in-memory");
  });

  it("rejects output that violates minLength constraints", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "", score: 4 }));
    await expect(
      gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
      }),
    ).rejects.toThrow(/InMemoryModelGateway structured/);
  });

  it("rejects output with out-of-range numbers", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "x", score: 9 }));
    await expect(
      gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
      }),
    ).rejects.toThrow(/score/);
  });

  it("rejects output with additional properties", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "x", score: 1, extra: true }));
    await expect(
      gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
      }),
    ).rejects.toThrow(/additional/);
  });
});

/**
 * RoutedModelGateway 的 strict-mode 降级与自动修复路径需要 fetch mock。
 * 此处通过一个最小的 stub Gateway 验证 ModelGateway 接口契约，
 * 确保 RoutedModelGateway 与 InMemoryModelGateway 实现同一接口（编译期约束）。
 */
describe("ModelGateway interface contract", () => {
  it("both gateways satisfy ModelGateway", async () => {
    const inMemory: ModelGateway = new InMemoryModelGateway(() => "ok");
    expect(typeof inMemory.generateText).toBe("function");
    expect(typeof inMemory.generateStructured).toBe("function");
    expect(typeof inMemory.embed).toBe("function");
    expect(typeof inMemory.rerank).toBe("function");

    // embed/rerank 默认实现返回空数组
    await expect(inMemory.embed({ purpose: "memory.embed", texts: ["a"] })).resolves.toMatchObject({ vectors: [[]], usage: expect.any(Object) });
    await expect(inMemory.rerank({ purpose: "memory.rerank", query: "q", documents: ["a"] })).resolves.toMatchObject({ scores: [0], usage: expect.any(Object) });
  });

  it("usage object has all required fields", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "x", score: 1 }));
    const { usage: u } = await gateway.generateStructured<Passthrough>({
      purpose: "facts.extract",
      prompt: "p",
      schema: passthroughSchema as unknown as Record<string, unknown>,
    });
    expect(u).toMatchObject({ model: "in-memory", inputTokens: expect.any(Number), outputTokens: expect.any(Number), costUsd: expect.any(Number), latencyMs: expect.any(Number) });
    // 静态 usage 用于其他测试套件，避免字段漂移
    expect(usage).toMatchObject({ model: "test", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
  });
});

describe("RoutedModelGateway structured candidate fallback", () => {
  it("zero-progress guard: candidateStartIndex beyond terminal fallback fails fast instead of recreating external task (arc-15 spin)", async () => {
    const config = {
      version: 1 as const,
      profiles: [
        { id: "only", label: "only", protocol: "responses" as const, baseUrl: "https://first.test/v1", model: "only", responseMode: "json" as const, capabilities: ["text", "structured", "stream", "responses-continuation", "embedding", "rerank"], enabled: true },
      ],
      routes: { "*": { conversationPolicy: "stateless" as const, candidates: [{ executor: "api" as const, profileId: "only" }] } },
    } as unknown as ModelRoutingConfig;
    const store = new ModelConfigStore(".tmp-model-config-do-not-read.yaml", config);
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const gateway = new RoutedModelGateway(store, async () => undefined);
      // 反方向：起点恰在终位（链刚被消耗）仍走外部兜底等待（现状语义不动）。
      await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p", candidateStartIndex: 1 } as never)).rejects.toThrow(ExternalMcpRequiredError);
      // 起点越过终位（外部兜底也已消耗）：快速失败，不再造同位外部任务。
      await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p", candidateStartIndex: 2 } as never)).rejects.toThrow(/model-route-exhausted/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tries the next API candidate after a candidate exhausts schema repairs", async () => {
    const config = {
      version: 1 as const,
      profiles: [
        { id: "first", label: "first", protocol: "responses" as const, baseUrl: "https://first.test/v1", model: "first", responseMode: "json" as const, capabilities: ["text", "structured", "stream", "responses-continuation", "embedding", "rerank"], enabled: true },
        { id: "second", label: "second", protocol: "responses" as const, baseUrl: "https://second.test/v1", model: "second", responseMode: "json" as const, capabilities: ["text", "structured", "stream", "responses-continuation", "embedding", "rerank"], enabled: true },
      ],
      routes: { "*": { conversationPolicy: "stateless" as const, candidates: [{ executor: "api" as const, profileId: "first" }, { executor: "api" as const, profileId: "second" }] } },
    } as unknown as ModelRoutingConfig;
    const store = new ModelConfigStore(".tmp-model-config-do-not-read.yaml", config);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const output = url.includes("first.test") ? { score: 4, extra: true } : { name: "beta", score: 3 };
      return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await new RoutedModelGateway(store).generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
        maxRepairAttempts: 0,
      });
      expect(result.value).toEqual({ name: "beta", score: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("repairs task-contract violations on the same candidate when extraValidate fails then passes", async () => {
    const config = {
      version: 1 as const,
      profiles: [
        { id: "only", label: "only", protocol: "responses" as const, baseUrl: "https://only.test/v1", model: "only", responseMode: "json" as const, capabilities: ["text", "structured", "stream", "responses-continuation", "embedding", "rerank"], enabled: true },
      ],
      routes: { "*": { conversationPolicy: "stateless" as const, candidates: [{ executor: "api" as const, profileId: "only" }] } },
    } as unknown as ModelRoutingConfig;
    const store = new ModelConfigStore(".tmp-model-config-do-not-read.yaml", config);
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      const output = call === 1 ? { name: "", score: 4 } : { name: "fixed", score: 4 };
      return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await new RoutedModelGateway(store).generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
        maxRepairAttempts: 2,
        extraValidate: (value) => (value.name.length > 0 ? [] : ["name 不能为空"]),
      });
      expect(result.value).toEqual({ name: "fixed", score: 4 });
      expect(call).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("raises the temperature on repair rounds to break deterministic provider loops", async () => {
    // 根因：修复轮原样重发时确定性 provider 逐字节复现同一非法输出（2026-09-07 实测
    // 三次响应完全相同，修复空转）。首轮不带 temperature（沿用 provider 默认），
    // 修复轮固定 0.7 打破确定性。
    const config = {
      version: 1 as const,
      profiles: [
        { id: "only", label: "only", protocol: "responses" as const, baseUrl: "https://repair-temp.test/v1", model: "only", responseMode: "json" as const, capabilities: ["text", "structured", "stream", "responses-continuation", "embedding", "rerank"], enabled: true },
      ],
      routes: { "*": { conversationPolicy: "stateless" as const, candidates: [{ executor: "api" as const, profileId: "only" }] } },
    } as unknown as ModelRoutingConfig;
    const store = new ModelConfigStore(".tmp-model-config-do-not-read.yaml", config);
    let call = 0;
    const temperatures: Array<number | undefined> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const body = JSON.parse(String(init?.body)) as { temperature?: number };
      temperatures.push(body.temperature);
      const output = call === 1 ? { name: "", score: 4 } : { name: "fixed", score: 4 };
      return new Response(JSON.stringify({ output_text: JSON.stringify(output) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await new RoutedModelGateway(store).generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
        maxRepairAttempts: 2,
        extraValidate: (value) => (value.name.length > 0 ? [] : ["name 不能为空"]),
      });
      expect(result.value).toEqual({ name: "fixed", score: 4 });
      expect(temperatures).toEqual([undefined, 0.7]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports unparseable structured output with the parse error instead of AJV missing-field noise", async () => {
    // 根因（2026-09-07 实测）：模型输出 segments 数组结构性断裂（片段对象漏写开括号），
    // 旧报错对 undefined 做 AJV 校验，显示"root must have required property"缺字段
    // 噪音，掩盖了"JSON 无法解析"的真实失败模式。
    const config = {
      version: 1 as const,
      profiles: [
        { id: "only", label: "only", protocol: "responses" as const, baseUrl: "https://parse-fail.test/v1", model: "only", responseMode: "json" as const, capabilities: ["text", "structured", "stream", "responses-continuation", "embedding", "rerank"], enabled: true },
      ],
      routes: { "*": { conversationPolicy: "stateless" as const, candidates: [{ executor: "api" as const, profileId: "only" }] } },
    } as unknown as ModelRoutingConfig;
    const store = new ModelConfigStore(".tmp-model-config-do-not-read.yaml", config);
    const recordedErrors: Array<string | undefined> = [];
    // 与实测同形的畸形输出：数组第一个元素闭合后直接跟裸键值对（漏写对象开括号）
    const malformed = '{"plotBeats":[{"id":"b1","kind":"setup","summary":"节拍一"}],"segments":[{"title":"开场"},"summary":"裸露在数组层级的字段"}]}';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output_text: malformed }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const gateway = new RoutedModelGateway(store, async (audit) => { recordedErrors.push(audit.errorMessage); });
      await expect(gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
        maxRepairAttempts: 0,
      })).rejects.toThrow(ExternalMcpRequiredError);
      // 候选链耗尽后落入外部 MCP 兜底（ExternalMcpRequiredError），失败留痕里必须
      // 是保真的解析错误而非 AJV 缺字段噪音。
      expect(recordedErrors.some((message) => message?.includes("JSON 无法解析"))).toBe(true);
      expect(recordedErrors.some((message) => message?.includes("position"))).toBe(true);
      expect(recordedErrors.some((message) => message?.includes("must have required property"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("structured response normalization", () => {
  const validate = new Ajv({ strict: false }).compile(passthroughSchema);

  it("accepts fenced, explained, encoded, and single-envelope objects when the value itself validates", () => {
    expect(normalizeStructuredContent('说明如下\n```json\n{"name":"alpha","score":4}\n```', validate)).toEqual({ name: "alpha", score: 4 });
    expect(normalizeStructuredContent(JSON.stringify(JSON.stringify({ name: "beta", score: 3.5 })), validate)).toEqual({ name: "beta", score: 3.5 });
    expect(normalizeStructuredContent('{"result":{"name":"gamma","score":5}}', validate)).toEqual({ name: "gamma", score: 5 });
  });

  it("projects schema-disallowed envelope fields without weakening required validation", () => {
    expect(normalizeStructuredContent('{"name":"alpha","score":4,"persistence":{"id":"x"}}', validate)).toEqual({ name: "alpha", score: 4 });
    expect(normalizeStructuredContent('{"name":"alpha","persistence":{"id":"x"}}', validate)).toBeUndefined();
  });

  it("does not coerce arrays, primitives, or incomplete objects", () => {
    expect(normalizeStructuredContent('[{"name":"alpha","score":4}]', validate)).toBeUndefined();
    expect(normalizeStructuredContent('"alpha"', validate)).toBeUndefined();
    expect(normalizeStructuredContent('{"result":{"name":"alpha"}}', validate)).toBeUndefined();
  });
});

describe("provider usage normalization", () => {
  it("supports both Responses and Chat token field names", () => {
    expect(normalizeUsage({ input_tokens: 120, output_tokens: 40 }, "input", "output")).toMatchObject({ inputTokens: 120, outputTokens: 40, usageSource: "provider" });
    expect(normalizeUsage({ prompt_tokens: "90", completion_tokens: "12" }, "input", "output")).toMatchObject({ inputTokens: 90, outputTokens: 12, usageSource: "provider" });
  });

  it("preserves provider cache usage from Responses and Chat detail fields", () => {
    expect(normalizeUsage({ input_tokens: 120, output_tokens: 40, input_tokens_details: { cached_tokens: 80 } }, "input", "output")).toMatchObject({ providerInputTokens: 120, providerCachedInputTokens: 80 });
    expect(normalizeUsage({ prompt_tokens: 90, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 30 } }, "input", "output")).toMatchObject({ providerInputTokens: 90, providerCachedInputTokens: 30 });
  });

  it("keeps provider values separate from estimates and estimates missing usage", () => {
    const provider = normalizeUsage({ input_tokens: 1, output_tokens: 1 }, "这是一段明显超过一个 token 的中文输入", "较长输出");
    expect(provider.providerInputTokens).toBe(1);
    expect(provider.estimatedInputTokens).toBeGreaterThan(1);
    const estimated = normalizeUsage(undefined, "中文输入", "中文输出");
    expect(estimated.usageSource).toBe("estimated");
    expect(estimated.inputTokens).toBeGreaterThan(0);
  });
});
