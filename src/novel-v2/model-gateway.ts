import { createHash } from "node:crypto";
import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import { ModelConfigStore } from "./model-config-store";
import { assertNativeJsonSchema } from "./native-schema";
import {
  ExternalMcpRequiredError,
  type ModelExecutionProvenance,
  type ModelProviderProfile,
  type ModelPurpose,
  type ModelRoute,
  type ModelRoutingSnapshot,
  resolveProfileSecret,
  resolveRoute,
} from "./model-routing";
import type { PromptContextManifest } from "./protocol";
import { parseStructuredJson } from "./structured-json";

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerCachedInputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  usageSource?: "provider" | "estimated" | "mixed";
  costUsd: number;
  latencyMs: number;
}

export interface ModelResult<T> {
  value: T;
  usage: ModelUsage;
  provenance: ModelExecutionProvenance;
}

interface BaseModelInput {
  purpose: ModelPurpose;
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  routingSnapshot?: ModelRoutingSnapshot;
  previousResponseId?: string;
  previousProfileId?: string;
  candidateStartIndex?: number;
  workflowRunId?: string;
  taskId?: string;
  promptContext?: PromptContextManifest;
}

export interface GenerateTextInput extends BaseModelInput { prompt: string }
export interface GenerateStructuredInput<T> extends BaseModelInput {
  prompt: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  maxRepairAttempts?: number;
  /**
   * 任务级契约校验：在 provider JSON schema 校验通过后追加执行。
   * 失败时抛出 ModelTransportError("schema-validation")，进入 repair 循环
   * 由模型依据错误信息自动修复后重试。用于 provider schema 无法表达的
   * 嵌套/语义契约（如 foundation architecture 的 volumes 结构），
   * 避免契约失败直接导致 workflow 终态 failed 而无修复机会。
   */
  extraValidate?: (value: T) => string[];
  __type?: T;
}

export interface ModelGateway {
  getRoutingSnapshot(): ModelRoutingSnapshot;
  generateText(input: GenerateTextInput): Promise<ModelResult<string> & { text: string }>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<ModelResult<T>>;
  embed(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<ModelResult<number[][]> & { vectors: number[][] }>;
  rerank(input: { purpose: "memory.rerank"; query: string; documents: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<ModelResult<number[]> & { scores: number[] }>;
}

export interface ModelInvocationAudit {
  workflowRunId?: string;
  taskId?: string;
  /**
   * OR-D2（product-audit-20260910 E5）：调用归属项目。memory.embed 等无 workflowRunId
   * 的旁路调用此前 100% 不可归属（project_id 派生 SELECT 对 NULL run 恒空）；
   * 显式带 projectId 让嵌入用量可按项目核算（派生仍作 run 存在时的兜底）。
   */
  projectId?: string;
  purpose: ModelPurpose;
  configRevision: string;
  candidateIndex: number;
  executor: "api" | "external-mcp";
  profileId?: string;
  providerLabel?: string;
  protocol?: string;
  model: string;
  status: "completed" | "failed" | "waiting-external";
  inputTokens: number;
  outputTokens: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerCachedInputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  usageSource?: "provider" | "estimated" | "mixed";
  latencyMs: number;
  promptFingerprint: string;
  responseId?: string;
  errorCategory?: string;
  errorMessage?: string;
}

export type ModelInvocationRecorder = (audit: ModelInvocationAudit) => Promise<void>;

export interface ModelPromptExecution {
  workflowRunId?: string;
  taskId?: string;
  purpose: ModelPurpose;
  candidateIndex: number;
  status: "completed" | "failed";
  system?: string;
  prompt: string;
  response?: string;
  promptFingerprint: string;
  contextManifest?: PromptContextManifest;
  errorCategory?: string;
}

export type ModelPromptExecutionRecorder = (execution: ModelPromptExecution) => Promise<void>;

export class ModelContextBudgetError extends Error {
  readonly category = "context-budget-exceeded";
  constructor(readonly estimatedInputTokens: number, readonly maxInputTokens: number, readonly purpose: ModelPurpose) {
    super(`context-budget-exceeded: ${purpose} 实际输入约 ${estimatedInputTokens} tokens，超过有效预算 ${maxInputTokens}`);
    this.name = "ModelContextBudgetError";
  }
}

interface TransportResponse {
  text: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  providerCachedInputTokens?: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  usageSource: "provider" | "estimated" | "mixed";
}

interface TransportRequest {
  profile: ModelProviderProfile;
  model: string;
  system?: string;
  prompt: string;
  schema?: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  previousResponseId?: string;
  signal?: AbortSignal;
}

class ModelTransportError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly category: string, readonly status?: number) {
    super(message);
    // Temporal only serializes the error type, not arbitrary custom fields.
    // Give exhausted/non-retryable failures a distinct type so workflow retry
    // policies can avoid repeating an already completed repair loop.
    this.name = retryable ? "ModelTransportError" : "NonRetryableModelTransportError";
  }
}

function promptFingerprint(system: string | undefined, prompt: string): string {
  return createHash("sha256").update(`${system ?? ""}\n${prompt}`).digest("hex");
}

/**
 * OR-D2（product-audit-20260910 E5）：嵌入幂等短路的缓存键。model 参与哈希是
 * 正确性边界——不同 embedding 模型的向量空间不互通，绝不允许跨模型命中。
 */
export function embeddingFingerprint(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

/** OR-D2 嵌入缓存端口（repository 注入；端口失败必须退化为直连，不阻断检索/入库）。 */
export interface EmbeddingCachePort {
  lookupEmbeddings(model: string, texts: string[]): Promise<(number[] | undefined)[]>;
  storeEmbeddings(model: string, entries: Array<{ text: string; vector: number[] }>): Promise<void>;
}

/** OR-D2 共用：把 OpenAI-compatible embeddings 响应按 index 归位成向量数组。 */
function parseEmbeddingVectors(data: Record<string, unknown>, expected: number): number[][] {
  const rows = Array.isArray(data.data) ? data.data as Array<{ embedding?: number[]; index?: number }> : [];
  const vectors = Array.from({ length: expected }, () => [] as number[]);
  rows.forEach((row, responseIndex) => {
    const inputIndex = Number.isInteger(row.index) ? Number(row.index) : responseIndex;
    if (inputIndex >= 0 && inputIndex < vectors.length && Array.isArray(row.embedding)) vectors[inputIndex] = row.embedding;
  });
  return vectors;
}

function modelErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function jsonSchemaPrimitiveType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

/**
 * Some OpenAI-compatible providers reject valid JSON Schema nodes that only
 * contain enum/const. Add the inferable primitive type at the transport
 * boundary while keeping the application schema unchanged for AJV validation.
 */
export function normalizeProviderJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProviderJsonSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const normalized = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, normalizeProviderJsonSchema(item)])) as Record<string, unknown>;
  // Preserve standard nullable unions such as ["object", "null"]. The
  // native schema validator accepts only a single value or this narrow union;
  // replacing it with object here would make null outputs fail AJV validation.
  if (typeof normalized.type === "string" || Array.isArray(normalized.type)) return normalized;

  const candidates = Array.isArray(normalized.enum)
    ? normalized.enum.map(jsonSchemaPrimitiveType).filter((type): type is string => Boolean(type))
    : "const" in normalized
      ? [jsonSchemaPrimitiveType(normalized.const)]
      : [];
  const inferred = candidates.length && candidates.every((type) => type === candidates[0]) ? candidates[0] : undefined;
  if (inferred) normalized.type = inferred;
  else if (normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties)) normalized.type = "object";
  else if ("items" in normalized) normalized.type = "array";
  return normalized;
}

async function readHttpError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  throw new ModelTransportError(`模型服务 HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`, retryable, `http-${response.status}`, response.status);
}

function authorization(profile: ModelProviderProfile): HeadersInit {
  const secret = resolveProfileSecret(profile);
  return { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
}

function finiteToken(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function nextApiCandidateIndex(route: ModelRoute, currentIndex: number): number | undefined {
  const offset = route.candidates.slice(currentIndex + 1).findIndex((candidate) => candidate.executor === "api");
  return offset < 0 ? undefined : currentIndex + 1 + offset;
}

function tokenEstimate(text: string): number {
  if (!text.trim()) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk * 0.75 + other / 4));
}

export function normalizeUsage(
  usageValue: unknown,
  inputText: string,
  outputText: string,
): Pick<TransportResponse, "inputTokens" | "outputTokens" | "providerInputTokens" | "providerOutputTokens" | "providerCachedInputTokens" | "estimatedInputTokens" | "estimatedOutputTokens" | "usageSource"> {
  const usage = usageValue && typeof usageValue === "object" && !Array.isArray(usageValue) ? usageValue as Record<string, unknown> : {};
  const inputDetailsValue = usage.input_tokens_details ?? usage.prompt_tokens_details;
  const inputDetails = inputDetailsValue && typeof inputDetailsValue === "object" && !Array.isArray(inputDetailsValue) ? inputDetailsValue as Record<string, unknown> : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object" ? usage.output_tokens_details as Record<string, unknown> : {};
  const providerInputTokens = finiteToken(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? inputDetails.total_tokens);
  const providerOutputTokens = finiteToken(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? outputDetails.total_tokens);
  const providerCachedInputTokens = finiteToken(inputDetails.cached_tokens ?? inputDetails.cachedTokens);
  const estimatedInputTokens = tokenEstimate(inputText);
  const estimatedOutputTokens = tokenEstimate(outputText);
  const hasProviderInput = providerInputTokens !== undefined;
  const hasProviderOutput = providerOutputTokens !== undefined;
  const usageSource = hasProviderInput && hasProviderOutput ? "provider" : hasProviderInput || hasProviderOutput ? "mixed" : "estimated";
  return {
    inputTokens: providerInputTokens ?? estimatedInputTokens,
    outputTokens: providerOutputTokens ?? estimatedOutputTokens,
    providerInputTokens,
    providerOutputTokens,
    providerCachedInputTokens,
    estimatedInputTokens,
    estimatedOutputTokens,
    usageSource,
  };
}

function parseChatJson(data: Record<string, unknown>, inputText: string): TransportResponse {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const text = typeof first?.message?.content === "string" ? first.message.content : "";
  return {
    text,
    responseId: typeof data.id === "string" ? data.id : undefined,
    ...normalizeUsage(data.usage, inputText, text),
  };
}

async function parseChatSse(response: Response, inputText: string): Promise<TransportResponse> {
  if (!response.body) throw new ModelTransportError("Chat SSE 响应缺少 body", true, "empty-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let responseId: string | undefined;
  let usageValue: unknown;
  const consume = (line: string) => {
    const raw = line.replace(/^data:\s*/, "").trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      if (typeof event.id === "string") responseId = event.id;
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const first = choices[0] as { delta?: { content?: unknown } } | undefined;
      if (typeof first?.delta?.content === "string") text += first.delta.content;
      if (event.usage) usageValue = event.usage;
    } catch { /* Ignore provider keepalive and non-JSON SSE lines. */ }
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) consume(line);
    if (chunk.done) break;
  }
  if (buffer.startsWith("data:")) consume(buffer);
  return { text, responseId, ...normalizeUsage(usageValue, inputText, text) };
}

async function requestChatCompletions(input: TransportRequest): Promise<TransportResponse> {
  const stream = input.profile.responseMode === "sse";
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      { role: "user", content: input.prompt },
    ],
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (input.maxTokens) body.max_tokens = input.maxTokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (input.schema) body.response_format = { type: "json_schema", json_schema: { name: input.schemaName ?? "model_output", strict: true, schema: normalizeProviderJsonSchema(input.schema) } };
  let response: Response;
  try {
    response = await fetch(endpoint(input.profile.baseUrl, "chat/completions"), { method: "POST", headers: authorization(input.profile), body: JSON.stringify(body), signal: input.signal });
  } catch (error) {
    throw new ModelTransportError(error instanceof Error ? error.message : String(error), true, "network");
  }
  if (!response.ok) return readHttpError(response);
  return stream ? parseChatSse(response, input.prompt) : parseChatJson(await response.json() as Record<string, unknown>, input.prompt);
}

function parseResponsesJson(data: Record<string, unknown>, inputText: string): TransportResponse {
  let text = typeof data.output_text === "string" ? data.output_text : "";
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output as Array<Record<string, unknown>>) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content as Array<Record<string, unknown>>) {
        if (typeof content.text === "string") text += content.text;
      }
    }
  }
  return {
    text,
    responseId: typeof data.id === "string" ? data.id : undefined,
    ...normalizeUsage(data.usage, inputText, text),
  };
}

async function requestResponses(input: TransportRequest): Promise<TransportResponse> {
  const body: Record<string, unknown> = { model: input.model, input: input.prompt };
  if (input.system) body.instructions = input.system;
  if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
  if (input.maxTokens) body.max_output_tokens = input.maxTokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (input.schema) body.text = { format: { type: "json_schema", name: input.schemaName ?? "model_output", strict: true, schema: normalizeProviderJsonSchema(input.schema) } };
  let response: Response;
  try {
    response = await fetch(endpoint(input.profile.baseUrl, "responses"), { method: "POST", headers: authorization(input.profile), body: JSON.stringify(body), signal: input.signal });
  } catch (error) {
    throw new ModelTransportError(error instanceof Error ? error.message : String(error), true, "network");
  }
  if (!response.ok) return readHttpError(response);
  return parseResponsesJson(await response.json() as Record<string, unknown>, input.prompt);
}

async function requestTransport(input: TransportRequest): Promise<TransportResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`模型请求超过 ${input.profile.timeoutMs ?? 120_000}ms`));
  }, input.profile.timeoutMs ?? 120_000);
  try {
    return await (input.profile.protocol === "responses"
      ? requestResponses({ ...input, signal: controller.signal })
      : requestChatCompletions({ ...input, signal: controller.signal }));
  } catch (error) {
    if (timedOut) throw new ModelTransportError(`模型请求超过 ${input.profile.timeoutMs ?? 120_000}ms`, true, "timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

function parseJsonCandidate(candidate: string): unknown {
  return parseStructuredJson(candidate);
}

function balancedJsonObjects(content: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(content.slice(start, index + 1));
    }
  }
  return candidates;
}

/**
 * Project provider envelopes onto the declared structured-output contract.
 * Providers sometimes echo persistence metadata even when strict JSON schema
 * mode is requested. Only objects that explicitly disallow additional fields
 * are projected; required fields and value constraints remain AJV's job.
 */
function projectStructuredCandidate(value: unknown, schema: AnySchema): unknown {
  if (typeof schema === "boolean") return value;
  const schemaObject = schema as { anyOf?: unknown; items?: AnySchema; properties?: unknown; additionalProperties?: unknown };
  if (schemaObject.anyOf && Array.isArray(schemaObject.anyOf)) {
    // A union needs branch selection, which cannot be inferred from the schema
    // alone. Leave it intact and let AJV select the valid branch.
    return value;
  }
  if (Array.isArray(value) && schemaObject.items && typeof schemaObject.items === "object" && !Array.isArray(schemaObject.items)) {
    return value.map((item) => projectStructuredCandidate(item, schemaObject.items as AnySchema));
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !schemaObject.properties || typeof schemaObject.properties !== "object") return value;
  const source = value as Record<string, unknown>;
  const properties = schemaObject.properties as Record<string, AnySchema>;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (schemaObject.additionalProperties === false && !(key in properties)) continue;
    projected[key] = key in properties ? projectStructuredCandidate(child, properties[key]) : child;
  }
  return projected;
}

export function normalizeStructuredContent<T>(content: string, validate: ValidateFunction<T>): T | undefined {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1]);
  const fullValue = parseJsonCandidate(content);
  const rawCandidates = fullValue === undefined ? [...fenced, ...balancedJsonObjects(content)] : [content];
  for (const raw of rawCandidates) {
    const parsed = parseJsonCandidate(raw);
    const candidates = [parsed];
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      for (const key of ["data", "result", "output"]) if (key in root) candidates.push(root[key]);
    }
    for (const candidate of candidates) {
      if (validate(candidate)) return candidate;
      const projected = projectStructuredCandidate(candidate, validate.schema as AnySchema);
      if (validate(projected)) return projected;
    }
  }
  return undefined;
}

/**
 * 修复轮温度：首轮使用请求方默认（undefined），修复轮抬温重发。
 * 根因：确定性 provider（temperature=0 或路由默认低温）在修复轮原样重发同一 prompt
 * 时会逐字节复现同一非法输出（2026-09-07 实测：三次响应逐字节相同），修复循环退化为
 * 空转并白白消耗预算。抬温打破确定性，对所有 purpose 通用；首轮行为不变。
 */
const REPAIR_TEMPERATURE = 0.7;

/**
 * 解析失败保真诊断：与 normalizeStructuredContent 相同的候选枚举（全文 / 围栏块 /
 * 平衡对象），全部候选都无法 JSON.parse 时返回首个解析错误（含位置与附近原文）；
 * 任一候选可解析则返回 undefined（此时失败属于 Schema 校验而非解析，沿用 AJV 错误）。
 * 根因：2026-09-07 实测模型输出 segments 数组结构性断裂，报错却显示
 * "root must have required property …"（对 undefined 做 AJV 校验的缺字段错误），
 * 掩盖了真实失败模式，误导排障方向。
 */
function describeJsonParseFailure(content: string): string | undefined {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1]);
  const candidates = [content, ...fenced, ...balancedJsonObjects(content)];
  let firstError: string | undefined;
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (firstError === undefined) {
        const position = Number(message.match(/position (\d+)/)?.[1] ?? NaN);
        firstError = Number.isFinite(position) && candidate === content
          ? `${message}（附近原文：${content.slice(Math.max(0, position - 60), position + 60)}）`
          : message;
      }
    }
  }
  return firstError ?? "未找到任何可解析的 JSON 候选";
}

function repairPrompt(originalTask: string, content: string, errors: string, attempt: number, maxInputTokens: number, system?: string, transportOverheadCharacters = 0): string {
  const prefix = [
    attempt ? "上一次修复仍未通过。重新生成完整 JSON。" : "修复下面输出，使其严格符合 JSON Schema。",
    "只输出 JSON。必须继续完成原始任务，不得只追求通过 Schema；不得新增原输出和原始任务依据中都不存在的故事事实。",
    "结构化 Schema 由请求层提供；不要输出 Schema、Markdown 或解释。",
    "如果校验错误涉及 additionalProperties，删除所有未在 Schema 声明的字段；尤其不要把上下文中的持久化、执行、批准、提交、文档或修订包装字段复制进返回值。输出应是规范业务对象，而不是输入记录的回显。",
    `原始任务与语义约束：\n${originalTask}`,
    `校验错误：${errors}`,
  ].join("\n\n");
  const maxCharacters = Number.isFinite(maxInputTokens) ? Math.max(0, maxInputTokens * 2 - (system?.length ?? 0) - prefix.length - transportOverheadCharacters - 128) : content.length;
  const retained = content.slice(0, maxCharacters);
  const outputSection = retained
    ? `${retained.length < content.length ? "原输出（因上下文预算仅保留开头，必要时按原始任务重新生成）" : "原输出"}：\n${retained}`
    : "原输出因上下文预算未重复注入；请依据原始任务、Schema 和校验错误重新生成。";
  return `${prefix}\n\n${outputSection}`;
}

function retryDelay(attempt: number): number { return [500, 1_000, 2_000][attempt] ?? 2_000; }
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

export class RoutedModelGateway implements ModelGateway {
  constructor(readonly configStore: ModelConfigStore, private readonly recordInvocation?: ModelInvocationRecorder, private readonly recordPromptExecution?: ModelPromptExecutionRecorder, private readonly embeddingCache?: EmbeddingCachePort) {}

  getRoutingSnapshot(): ModelRoutingSnapshot { return this.configStore.getSnapshot(); }

  private resolveProfile(snapshot: ModelRoutingSnapshot, profileId: string): ModelProviderProfile {
    const frozen = snapshot.profiles.find((item) => item.id === profileId);
    if (!frozen) throw new Error(`路由快照中不存在 profile ${profileId}`);
    const current = this.configStore.getProfile(profileId);
    if (!current) throw new Error(`本地密钥配置中不存在 profile ${profileId}`);
    const { secretRef: _secretRef, hasSecret: _hasSecret, ...profile } = frozen;
    return { ...profile, secret: current.secret };
  }

  private route(input: BaseModelInput): { snapshot: ModelRoutingSnapshot; route: ModelRoute } {
    const snapshot = input.routingSnapshot ?? this.getRoutingSnapshot();
    const route = resolveRoute({ routes: snapshot.routes }, input.purpose);
    if (!route) throw new Error(`没有匹配 ${input.purpose} 的模型路由`);
    return { snapshot, route };
  }

  private async record(audit: ModelInvocationAudit): Promise<void> {
    if (this.recordInvocation) await this.recordInvocation(audit);
  }

  private async recordPrompt(input: ModelPromptExecution): Promise<void> {
    if (!this.recordPromptExecution) return;
    try { await this.recordPromptExecution(input); }
    catch (error) { console.warn(`[model-gateway] 提示词诊断留痕失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  private async invokeCandidate(input: BaseModelInput & { prompt: string; schema?: Record<string, unknown>; schemaName?: string }, snapshot: ModelRoutingSnapshot, route: ModelRoute, candidateIndex: number): Promise<{ response: TransportResponse; profile: ModelProviderProfile; model: string; provenance: ModelExecutionProvenance; latencyMs: number }> {
    const candidate = route.candidates[candidateIndex];
    if (!candidate) throw new Error(`模型候选索引越界：${candidateIndex}`);
    if (candidate.executor === "external-mcp") {
      // 历史运行快照兼容：配置契约变更前冻结的快照仍可能携带显式外部候选，
      // 按原语义在原候选位执行外部等待（新配置已禁止显式外部候选）。
      return this.invokeExternalMcpWait(input, snapshot, route, candidateIndex);
    }
    const profile = this.resolveProfile(snapshot, candidate.profileId);
    const model = candidate.model ?? profile.model;
    const transportPrompt = input.prompt;
    const fingerprint = promptFingerprint(input.system, transportPrompt);
    const outputReserve = Math.max(1, Math.min(input.maxTokens ?? route.maxOutputTokens ?? 4_096, route.maxOutputTokens ?? Number.MAX_SAFE_INTEGER));
    const profileInputLimit = profile.contextWindow ? Math.max(0, profile.contextWindow - outputReserve) : Number.MAX_SAFE_INTEGER;
    const effectiveInputLimit = Math.min(route.maxInputTokens ?? Number.MAX_SAFE_INTEGER, input.promptContext?.maxInputTokens ?? Number.MAX_SAFE_INTEGER, profileInputLimit);
    const estimatedInputTokens = Math.ceil(`${input.system ?? ""}\n${transportPrompt}`.length / 2);
    if (estimatedInputTokens > effectiveInputLimit) {
      const error = new ModelContextBudgetError(estimatedInputTokens, effectiveInputLimit, input.purpose);
      await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "failed", system: input.system, prompt: transportPrompt, promptFingerprint: fingerprint, contextManifest: input.promptContext, errorCategory: error.category });
      await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "api", profileId: profile.id, providerLabel: profile.label, protocol: profile.protocol, model, status: "failed", inputTokens: estimatedInputTokens, outputTokens: 0, estimatedInputTokens, estimatedOutputTokens: 0, usageSource: "estimated", latencyMs: 0, promptFingerprint: fingerprint, errorCategory: error.category, errorMessage: modelErrorMessage(error) });
      throw error;
    }
    const started = Date.now();
    let attempt = 0;
    let previousResponseId = route.conversationPolicy === "task-chain" && input.previousProfileId === profile.id
      ? input.previousResponseId
      : undefined;
    let continuationFallbackUsed = false;
    while (true) {
      try {
        const response = await requestTransport({ profile, model, system: input.system, prompt: transportPrompt, schema: input.schema, schemaName: input.schemaName, maxTokens: input.maxTokens, temperature: input.temperature, previousResponseId, signal: input.signal });
        if (!response.text.trim()) throw new ModelTransportError("模型返回空内容", true, "empty-response");
        const latencyMs = Date.now() - started;
        const provenance: ModelExecutionProvenance = { routeSnapshotId: snapshot.id, purpose: input.purpose, candidateIndex, executor: "api", profileId: profile.id, protocol: profile.protocol, model, responseId: response.responseId, promptFingerprint: fingerprint };
        await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "completed", system: input.system, prompt: transportPrompt, response: response.text, promptFingerprint: fingerprint, contextManifest: input.promptContext });
        return { response, profile, model, provenance, latencyMs };
      } catch (error) {
        if (previousResponseId && !continuationFallbackUsed && error instanceof ModelTransportError && error.status === 400) {
          previousResponseId = undefined;
          continuationFallbackUsed = true;
          continue;
        }
        if (error instanceof ModelTransportError && error.retryable && attempt < 2) {
          await sleep(retryDelay(attempt++), input.signal);
          continue;
        }
        const latencyMs = Date.now() - started;
        const errorCategory = error instanceof ModelTransportError ? error.category : error instanceof ModelContextBudgetError ? error.category : "protocol";
        await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "failed", system: input.system, prompt: transportPrompt, promptFingerprint: fingerprint, contextManifest: input.promptContext, errorCategory });
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "api", profileId: profile.id, providerLabel: profile.label, protocol: profile.protocol, model, status: "failed", inputTokens: 0, outputTokens: 0, latencyMs, promptFingerprint: fingerprint, errorCategory, errorMessage: modelErrorMessage(error) });
        throw error;
      }
    }
  }

  /**
   * 链尾外部 MCP 兜底（机制契约 2026-09-07）：外部 MCP 不再是调用位置的可选
   * 执行者，而是所有文本/结构化调用链的隐式链尾兜底——显式 API 候选全部失败
   * 或候选链为空时，在虚拟兜底位（candidateIndex = candidates.length）执行与
   * 显式外部候选相同的路由级预算检查和 waiting-external 留痕，然后抛出
   * ExternalMcpRequiredError 交由物化层创建可认领的外部任务。
   *
   * 刻意不覆盖：memory.embed / memory.rerank 向量链路没有外部任务物化路径
   * （外部任务产出为 text/structured/review，无法承载向量），候选耗尽后按原
   * 样失败；跨 provider 的 trade-off：原 exhaustedRouteError 的快速失败语义
   * 移除，无外部 worker 认领时任务保持 waiting-external 而非 workflow failed。
   */
  private async invokeExternalMcpWait(input: BaseModelInput & { prompt: string }, snapshot: ModelRoutingSnapshot, route: ModelRoute, candidateIndex: number): Promise<never> {
    const fingerprint = promptFingerprint(input.system, input.prompt);
    const effectiveInputLimit = Math.min(route.maxInputTokens ?? Number.MAX_SAFE_INTEGER, input.promptContext?.maxInputTokens ?? Number.MAX_SAFE_INTEGER);
    const estimatedInputTokens = Math.ceil(`${input.system ?? ""}\n${input.prompt}`.length / 2);
    if (estimatedInputTokens > effectiveInputLimit) {
      const error = new ModelContextBudgetError(estimatedInputTokens, effectiveInputLimit, input.purpose);
      await this.recordPrompt({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, candidateIndex, status: "failed", system: input.system, prompt: input.prompt, promptFingerprint: fingerprint, contextManifest: input.promptContext, errorCategory: error.category });
      await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "external-mcp", model: "external-mcp", providerLabel: "external-mcp", status: "failed", inputTokens: estimatedInputTokens, outputTokens: 0, estimatedInputTokens, estimatedOutputTokens: 0, usageSource: "estimated", latencyMs: 0, promptFingerprint: fingerprint, errorCategory: error.category, errorMessage: modelErrorMessage(error) });
      throw error;
    }
    await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex, executor: "external-mcp", model: "external-mcp", status: "waiting-external", inputTokens: 0, outputTokens: 0, latencyMs: 0, promptFingerprint: fingerprint });
    throw new ExternalMcpRequiredError(input.purpose, snapshot.id, candidateIndex);
  }

  async generateText(input: GenerateTextInput): Promise<ModelResult<string> & { text: string }> {
    const { snapshot, route } = this.route(input);
    for (let index = input.candidateStartIndex ?? 0; index < route.candidates.length; index += 1) {
      try {
        const result = await this.invokeCandidate(input, snapshot, route, index);
        const usage = { model: result.model, inputTokens: result.response.inputTokens, outputTokens: result.response.outputTokens, providerInputTokens: result.response.providerInputTokens, providerOutputTokens: result.response.providerOutputTokens, providerCachedInputTokens: result.response.providerCachedInputTokens, estimatedInputTokens: result.response.estimatedInputTokens, estimatedOutputTokens: result.response.estimatedOutputTokens, usageSource: result.response.usageSource, costUsd: 0, latencyMs: result.latencyMs };
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: result.profile.id, protocol: result.profile.protocol, model: result.model, status: "completed", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerInputTokens: usage.providerInputTokens, providerOutputTokens: usage.providerOutputTokens, providerCachedInputTokens: usage.providerCachedInputTokens, estimatedInputTokens: usage.estimatedInputTokens, estimatedOutputTokens: usage.estimatedOutputTokens, usageSource: usage.usageSource, latencyMs: usage.latencyMs, promptFingerprint: result.provenance.promptFingerprint, responseId: result.response.responseId });
        return { value: result.response.text, text: result.response.text, usage, provenance: result.provenance };
      } catch (error) {
        // 历史快照的显式外部候选或兜底位本身抛出的等待，直接上抛给物化层。
        if (error instanceof ExternalMcpRequiredError) throw error;
      }
    }
    // 链尾兜底：所有显式 API 候选失败（或链为空）时转入外部 MCP 等待，替代
    // 原 exhaustedRouteError 快速失败（机制契约 2026-09-07，见 invokeExternalMcpWait）。
    // 零进展守卫（弧15 65 分钟空转实证）：调用方把起点推过终位
    // （candidateStartIndex > candidates.length）意味着链尾兜底位也刚被消耗过——
    // 再造同位外部任务只会开启下一段 15 分钟死窗。此时快速失败，让 run
    // 进入正式恢复路径（provider 恢复后新快照从 0 位重跑）。
    if ((input.candidateStartIndex ?? 0) > route.candidates.length) {
      throw new Error(`model-route-exhausted: ${input.purpose} 候选链与链尾兜底位均已消耗（起点 ${input.candidateStartIndex} > 终位 ${route.candidates.length}）`);
    }
    return await this.invokeExternalMcpWait(input, snapshot, route, route.candidates.length);
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<ModelResult<T>> {
    assertNativeJsonSchema(input.schema, input.schemaName);
    const { snapshot, route } = this.route(input);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(input.schema as AnySchema) as ValidateFunction<T>;
    for (let index = input.candidateStartIndex ?? 0; index < route.candidates.length; index += 1) {
      try {
        let currentPrompt = input.prompt;
        let currentSystem = input.system;
        let totalInput = 0;
        let totalOutput = 0;
        let providerInputTotal = 0;
        let providerOutputTotal = 0;
        let providerCachedInputTotal = 0;
        let estimatedInputTotal = 0;
        let estimatedOutputTotal = 0;
        let providerInputComplete = true;
        let providerOutputComplete = true;
        let providerInputSeen = false;
        let providerOutputSeen = false;
        let providerCachedInputSeen = false;
        let latest: Awaited<ReturnType<RoutedModelGateway["invokeCandidate"]>> | undefined;
        const repairs = input.maxRepairAttempts ?? 2;
        for (let repair = 0; repair <= repairs; repair += 1) {
          const repairSystem = [input.system, "修复结构化输出时仍须遵守原始角色、任务目标和事实边界。只输出严格符合 JSON Schema 的 JSON，不使用 Markdown。"].filter(Boolean).join("\n\n");
          const repairCandidate = route.candidates[index];
          let repairInputLimit = Math.min(route.maxInputTokens ?? Number.MAX_SAFE_INTEGER, input.promptContext?.maxInputTokens ?? Number.MAX_SAFE_INTEGER);
          if (repairCandidate?.executor === "api") {
            const profile = this.resolveProfile(snapshot, repairCandidate.profileId);
            const outputReserve = Math.max(1, Math.min(input.maxTokens ?? route.maxOutputTokens ?? 4_096, route.maxOutputTokens ?? Number.MAX_SAFE_INTEGER));
            if (profile.contextWindow) repairInputLimit = Math.min(repairInputLimit, Math.max(0, profile.contextWindow - outputReserve));
          }
          latest = await this.invokeCandidate({ ...input, system: currentSystem, prompt: currentPrompt, temperature: repair === 0 ? input.temperature : REPAIR_TEMPERATURE }, snapshot, route, index);
          totalInput += latest.response.inputTokens;
          totalOutput += latest.response.outputTokens;
          estimatedInputTotal += latest.response.estimatedInputTokens;
          estimatedOutputTotal += latest.response.estimatedOutputTokens;
          if (latest.response.providerInputTokens === undefined) providerInputComplete = false;
          else { providerInputSeen = true; providerInputTotal += latest.response.providerInputTokens; }
          if (latest.response.providerOutputTokens === undefined) providerOutputComplete = false;
          else { providerOutputSeen = true; providerOutputTotal += latest.response.providerOutputTokens; }
          if (latest.response.providerCachedInputTokens !== undefined) { providerCachedInputSeen = true; providerCachedInputTotal += latest.response.providerCachedInputTokens; }
          const parsed = normalizeStructuredContent(latest.response.text, validate);
          if (parsed !== undefined) {
            const taskErrors = input.extraValidate ? input.extraValidate(parsed) : [];
            if (taskErrors.length > 0) {
              if (repair === repairs) {
                const error = new ModelTransportError(`结构化输出校验失败：${taskErrors.join("；")}`, false, "schema-validation");
                await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, providerLabel: latest.profile.label, protocol: latest.profile.protocol, model: latest.model, status: "failed", inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens: providerInputSeen ? providerInputTotal : undefined, providerOutputTokens: providerOutputSeen ? providerOutputTotal : undefined, providerCachedInputTokens: providerCachedInputSeen ? providerCachedInputTotal : undefined, estimatedInputTokens: estimatedInputTotal, estimatedOutputTokens: estimatedOutputTotal, usageSource: providerInputComplete && providerOutputComplete ? "provider" : providerInputSeen || providerOutputSeen ? "mixed" : "estimated", latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId, errorCategory: error.category, errorMessage: modelErrorMessage(error) });
                throw error;
              }
              currentSystem = repairSystem;
              currentPrompt = repairPrompt(input.prompt, latest.response.text, taskErrors.join("；"), repair, repairInputLimit, repairSystem);
              continue;
            }
            const providerInputTokens = providerInputSeen ? providerInputTotal : undefined;
            const providerOutputTokens = providerOutputSeen ? providerOutputTotal : undefined;
            const providerCachedInputTokens = providerCachedInputSeen ? providerCachedInputTotal : undefined;
            const usageSource = providerInputComplete && providerOutputComplete ? "provider" as const : providerInputSeen || providerOutputSeen ? "mixed" as const : "estimated" as const;
            const usage = { model: latest.model, inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens, providerOutputTokens, providerCachedInputTokens, estimatedInputTokens: estimatedInputTotal, estimatedOutputTokens: estimatedOutputTotal, usageSource, costUsd: 0, latencyMs: latest.latencyMs };
            await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, protocol: latest.profile.protocol, model: latest.model, status: "completed", inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens: usage.providerInputTokens, providerOutputTokens: usage.providerOutputTokens, providerCachedInputTokens: usage.providerCachedInputTokens, estimatedInputTokens: usage.estimatedInputTokens, estimatedOutputTokens: usage.estimatedOutputTokens, usageSource: usage.usageSource, latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId });
            return { value: parsed, usage, provenance: latest.provenance };
          }
          // 报错保真：parsed === undefined 时先区分「解析失败」与「解析成功但校验失败」——
          // 前者对 undefined 做 AJV 校验只会得到误导性的缺字段错误（实测掩盖了
          // segments 数组结构性断裂的真实原因），必须报告解析错误位置。
          const parseFailure = describeJsonParseFailure(latest.response.text);
          const errors = parseFailure
            ? `JSON 无法解析（${parseFailure}）`
            : validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；") ?? "JSON 无法解析";
          if (repair === repairs) {
            const error = new ModelTransportError(`结构化输出校验失败：${errors}`, false, "schema-validation");
            await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: latest.profile.id, providerLabel: latest.profile.label, protocol: latest.profile.protocol, model: latest.model, status: "failed", inputTokens: totalInput, outputTokens: totalOutput, providerInputTokens: providerInputSeen ? providerInputTotal : undefined, providerOutputTokens: providerOutputSeen ? providerOutputTotal : undefined, providerCachedInputTokens: providerCachedInputSeen ? providerCachedInputTotal : undefined, estimatedInputTokens: estimatedInputTotal, estimatedOutputTokens: estimatedOutputTotal, usageSource: providerInputComplete && providerOutputComplete ? "provider" : providerInputSeen || providerOutputSeen ? "mixed" : "estimated", latencyMs: latest.latencyMs, promptFingerprint: latest.provenance.promptFingerprint, responseId: latest.response.responseId, errorCategory: error.category, errorMessage: modelErrorMessage(error) });
            throw error;
          }
          currentSystem = repairSystem;
          currentPrompt = repairPrompt(input.prompt, latest.response.text, errors, repair, repairInputLimit, repairSystem);
        }
      } catch (error) {
        // 历史快照的显式外部候选或兜底位本身抛出的等待，直接上抛给物化层。
        if (error instanceof ExternalMcpRequiredError) throw error;
        // Empty response and schema validation are candidate-local: providers
        // can differ in output shape and schema adherence, so both exhaust the
        // next explicit API candidates before the external-MCP tail fallback.
        if (error instanceof ModelTransportError && (error.category === "schema-validation" || error.category === "empty-response")) {
          const nextApi = nextApiCandidateIndex(route, index);
          if (nextApi === undefined) break;
          index = nextApi - 1;
          continue;
        }
      }
    }
    // 链尾兜底：所有显式 API 候选失败（或链为空）时转入外部 MCP 等待，替代
    // 原 exhaustedRouteError 快速失败（机制契约 2026-09-07，见 invokeExternalMcpWait）。
    // 零进展守卫（弧15 65 分钟空转实证）：调用方把起点推过终位
    // （candidateStartIndex > candidates.length）意味着链尾兜底位也刚被消耗过——
    // 再造同位外部任务只会开启下一段 15 分钟死窗。此时快速失败，让 run
    // 进入正式恢复路径（provider 恢复后新快照从 0 位重跑）。
    if ((input.candidateStartIndex ?? 0) > route.candidates.length) {
      throw new Error(`model-route-exhausted: ${input.purpose} 候选链与链尾兜底位均已消耗（起点 ${input.candidateStartIndex} > 终位 ${route.candidates.length}）`);
    }
    return await this.invokeExternalMcpWait(input, snapshot, route, route.candidates.length);
  }

  private async vectorRequest(input: { purpose: "memory.embed" | "memory.rerank"; body: Record<string, unknown>; path: string; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<{ data: Record<string, unknown>; provenance: ModelExecutionProvenance; usage: ModelUsage }> {
    const { snapshot, route } = this.route(input);
    let lastError: unknown;
    for (let index = 0; index < route.candidates.length; index += 1) {
      const candidate = route.candidates[index];
      if (candidate.executor === "external-mcp") throw new ExternalMcpRequiredError(input.purpose, snapshot.id, index);
      const profile = this.resolveProfile(snapshot, candidate.profileId);
      const model = candidate.model ?? profile.model;
      const started = Date.now();
      const fingerprint = promptFingerprint(undefined, JSON.stringify(input.body));
      try {
        const response = await fetch(endpoint(profile.baseUrl, input.path), { method: "POST", headers: authorization(profile), body: JSON.stringify({ model, ...input.body }), signal: input.signal });
        if (!response.ok) return readHttpError(response);
        const data = await response.json() as Record<string, unknown>;
        const meta = data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
          ? data.meta as Record<string, unknown>
          : undefined;
        // OpenAI-compatible embeddings expose `usage`; SiliconFlow rerank
        // exposes the same token counters under `meta.tokens`.
        const normalized = normalizeUsage(data.usage ?? meta?.tokens, JSON.stringify(input.body), "");
        const usage = { model, ...normalized, costUsd: 0, latencyMs: Date.now() - started };
        const provenance = { routeSnapshotId: snapshot.id, purpose: input.purpose, candidateIndex: index, executor: "api" as const, profileId: profile.id, protocol: profile.protocol, model, promptFingerprint: fingerprint };
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, projectId: input.projectId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: profile.id, protocol: profile.protocol, model, status: "completed", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, providerInputTokens: usage.providerInputTokens, providerOutputTokens: usage.providerOutputTokens, providerCachedInputTokens: usage.providerCachedInputTokens, estimatedInputTokens: usage.estimatedInputTokens, estimatedOutputTokens: usage.estimatedOutputTokens, usageSource: usage.usageSource, latencyMs: usage.latencyMs, promptFingerprint: fingerprint });
        return { data, provenance, usage };
      } catch (error) {
        await this.record({ workflowRunId: input.workflowRunId, taskId: input.taskId, projectId: input.projectId, purpose: input.purpose, configRevision: snapshot.id, candidateIndex: index, executor: "api", profileId: profile.id, providerLabel: profile.label, protocol: profile.protocol, model, status: "failed", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, promptFingerprint: fingerprint, errorCategory: error instanceof ModelTransportError ? error.category : "protocol", errorMessage: modelErrorMessage(error) });
        lastError = error;
      }
    }
    throw lastError ?? new Error(`模型路由 ${input.purpose} 没有可执行候选`);
  }

  async embed(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<ModelResult<number[][]> & { vectors: number[][] }> {
    if (this.embeddingCache && input.texts.length) {
      const cached = await this.embedWithCache(input);
      if (cached) return cached;
    }
    return this.embedDirect(input);
  }

  private async embedDirect(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<ModelResult<number[][]> & { vectors: number[][] }> {
    const result = await this.vectorRequest({ ...input, body: { input: input.texts, encoding_format: "float" }, path: "embeddings" });
    const vectors = parseEmbeddingVectors(result.data, input.texts.length);
    return { value: vectors, vectors, usage: result.usage, provenance: result.provenance };
  }

  /**
   * OR-D2（product-audit-20260910 E5）嵌入幂等短路：以首选候选的 embedding 模型为
   * 命名空间查内容寻址缓存，全部命中则零 provider 调用返回；部分命中只对缺失文本
   * 调一次 embed（去重后），按原序回填。回填用实际执行模型（fallback 可能换模型），
   * 空向量不缓存。缓存端口失败一律退化为直连路径——幂等短路是增益，不是新的失败面。
   * 返回 undefined 表示"未走缓存路径"，由 embed() 直连。
   */
  private async embedWithCache(input: { purpose: "memory.embed"; texts: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<(ModelResult<number[][]> & { vectors: number[][] }) | undefined> {
    const cache = this.embeddingCache;
    if (!cache) return undefined;
    const { snapshot, route } = this.route(input);
    const primaryIndex = route.candidates.findIndex((candidate) => candidate.executor === "api");
    const primary = primaryIndex >= 0 ? route.candidates[primaryIndex] : undefined;
    if (!primary || primary.executor !== "api") return undefined;
    const model = primary.model ?? (primary.profileId ? this.resolveProfile(snapshot, primary.profileId).model : undefined);
    if (!model) return undefined;
    let hits: (number[] | undefined)[];
    try {
      hits = await cache.lookupEmbeddings(model, input.texts);
    } catch (error) {
      console.warn(`[model-gateway] 嵌入缓存查询失败，退化直连：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const missing = [...new Set(input.texts.filter((_text, index) => !(hits[index]?.length)))];
    if (!missing.length) {
      const vectors = input.texts.map((_, index) => hits[index] as number[]);
      const usage: ModelUsage = { model, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
      const provenance: ModelExecutionProvenance = { routeSnapshotId: snapshot.id, purpose: input.purpose, candidateIndex: primaryIndex, executor: "api", profileId: primary.profileId, model, promptFingerprint: promptFingerprint(undefined, JSON.stringify({ cached: vectors.length })) };
      return { value: vectors, vectors, usage, provenance };
    }
    const fresh = await this.vectorRequest({ ...input, body: { input: missing, encoding_format: "float" }, path: "embeddings" });
    const freshVectors = parseEmbeddingVectors(fresh.data, missing.length);
    try {
      await cache.storeEmbeddings(fresh.provenance.model, missing.map((text, index) => ({ text, vector: freshVectors[index] ?? [] })).filter((entry) => entry.vector.length));
    } catch (error) {
      console.warn(`[model-gateway] 嵌入缓存回填失败（本次结果仍返回）：${error instanceof Error ? error.message : String(error)}`);
    }
    const missingPosition = new Map(missing.map((text, index) => [text, index]));
    const vectors = input.texts.map((text, index) => (hits[index]?.length ? hits[index] as number[] : freshVectors[missingPosition.get(text) ?? -1] ?? []));
    return { value: vectors, vectors, usage: fresh.usage, provenance: fresh.provenance };
  }

  async rerank(input: { purpose: "memory.rerank"; query: string; documents: string[]; signal?: AbortSignal; routingSnapshot?: ModelRoutingSnapshot; workflowRunId?: string; taskId?: string; projectId?: string }): Promise<ModelResult<number[]> & { scores: number[] }> {
    const result = await this.vectorRequest({
      ...input,
      body: { query: input.query, documents: input.documents, top_n: input.documents.length, return_documents: false },
      path: "rerank",
    });
    const rows = Array.isArray(result.data.results)
      ? result.data.results as Array<{ index?: number; relevance_score?: number | string; score?: number | string }>
      : [];
    // SiliconFlow returns results sorted by relevance, so map each score back
    // to its original document index before the retrieval layer consumes it.
    const scores = Array.from({ length: input.documents.length }, () => 0);
    const assigned = Array.from({ length: input.documents.length }, () => false);
    rows.forEach((row, responseIndex) => {
      const documentIndex = Number.isInteger(row.index) ? Number(row.index) : responseIndex;
      const score = Number(row.relevance_score ?? row.score);
      if (documentIndex >= 0 && documentIndex < scores.length && !assigned[documentIndex] && Number.isFinite(score)) {
        scores[documentIndex] = score;
        assigned[documentIndex] = true;
      }
    });
    if (assigned.some((value) => !value)) throw new Error(`rerank 返回 ${rows.length} 个有效结果，要求覆盖 ${input.documents.length} 个文档`);
    return { value: scores, scores, usage: result.usage, provenance: result.provenance };
  }
}

export class InMemoryModelGateway implements ModelGateway {
  constructor(private readonly responder: (input: { purpose: ModelPurpose; system?: string; prompt: string; schema?: Record<string, unknown> }) => unknown) {}
  getRoutingSnapshot(): ModelRoutingSnapshot { return { id: "in-memory", configVersion: 1, profiles: [], routes: { "*": { candidates: [{ executor: "external-mcp" }] } }, createdAt: 0 }; }
  private provenance(purpose: ModelPurpose, prompt: string): ModelExecutionProvenance { return { routeSnapshotId: "in-memory", purpose, candidateIndex: 0, executor: "api", profileId: "in-memory", protocol: "chat-completions", model: "in-memory", promptFingerprint: promptFingerprint(undefined, prompt) }; }
  async generateText(input: GenerateTextInput) { const raw = this.responder({ purpose: input.purpose, system: input.system, prompt: input.prompt }); const text = typeof raw === "string" ? raw : JSON.stringify(raw); return { value: text, text, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.prompt) }; }
  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<ModelResult<T>> { assertNativeJsonSchema(input.schema, input.schemaName); const value = this.responder({ purpose: input.purpose, system: input.system, prompt: input.prompt, schema: input.schema }); const validate = new Ajv({ allErrors: true, strict: false }).compile(input.schema as AnySchema); if (!validate(value)) throw new Error(`InMemoryModelGateway structured 输出校验失败：${validate.errors?.map((item) => `${item.instancePath || "root"} ${item.message ?? ""}`).join("；")}`); return { value: value as T, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.prompt) }; }
  async embed(input: { purpose: "memory.embed"; texts: string[] }) { const vectors = input.texts.map(() => [] as number[]); return { value: vectors, vectors, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.texts.join("\n")) }; }
  async rerank(input: { purpose: "memory.rerank"; query: string; documents: string[] }) { const scores = input.documents.map(() => 0); return { value: scores, scores, usage: { model: "in-memory", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, provenance: this.provenance(input.purpose, input.query) }; }
}
