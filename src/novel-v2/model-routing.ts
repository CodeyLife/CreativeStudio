import { createHash } from "node:crypto";
import type { PromptContextManifest } from "./protocol";

// purpose / capability 单一真源见 model-purposes.ts（无 node 依赖，前端设置界面共用）；
// 这里 re-export 保持既有导入路径兼容。
import { MODEL_PURPOSES, PURPOSE_CAPABILITY, type ModelCapability, type ModelPurpose } from "./model-purposes";

export { MODEL_PURPOSES };
export type { ModelCapability, ModelPurpose };
export { PURPOSE_CAPABILITY };
export type ModelProtocol = "chat-completions" | "responses";
export type ConversationPolicy = "stateless" | "task-chain";

export type ModelSecret =
  | { source: "inline"; value: string }
  | { source: "env"; name: string };

export interface ModelProviderProfile {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  responseMode?: "json" | "sse";
  capabilities: ModelCapability[];
  secret?: ModelSecret;
  enabled: boolean;
  timeoutMs?: number;
  contextWindow?: number;
}

export type RouteCandidate =
  | { executor: "api"; profileId: string; model?: string }
  | { executor: "external-mcp" };

export interface ModelRoute {
  candidates: RouteCandidate[];
  conversationPolicy?: ConversationPolicy;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelRoutingConfig {
  version: 1;
  profiles: ModelProviderProfile[];
  routes: Record<string, ModelRoute>;
}

export interface ModelRoutingSnapshot {
  id: string;
  configVersion: number;
  profiles: Array<Omit<ModelProviderProfile, "secret"> & { secretRef?: string; hasSecret: boolean }>;
  routes: Record<string, ModelRoute>;
  createdAt: number;
}

export interface ModelExecutionProvenance {
  routeSnapshotId: string;
  purpose: ModelPurpose;
  candidateIndex: number;
  executor: "api" | "external-mcp";
  profileId?: string;
  protocol?: ModelProtocol;
  model: string;
  responseId?: string;
  promptFingerprint: string;
  /** Review-stage context identity used to reproduce a quality decision. */
  skillBundleId?: string;
  skillBundleFingerprint?: string;
  contextManifestId?: string;
}

export interface ModelWorkPackage {
  id: string;
  workflowRunId: string;
  taskId: string;
  purpose: ModelPurpose;
  configRevision: string;
  candidateIndex: number;
  outputKind: "text" | "structured" | "review";
  system?: string;
  instruction: string;
  schema?: Record<string, unknown>;
  schemaName?: string;
  baseRevision: number;
  inputFingerprint: string;
  contextRefs: Record<string, string | undefined>;
  /** Optional for historical tasks; new compiled prompts carry the same manifest as API execution. */
  promptContext?: PromptContextManifest;
  createdAt: number;
}

export interface ModelTaskRecord {
  id: string;
  workflowRunId: string;
  taskId: string;
  purpose: ModelPurpose;
  configRevision: string;
  candidateIndex: number;
  status: "pending" | "claimed" | "running" | "submitted" | "failed" | "cancelled";
  workPackage: ModelWorkPackage;
  result?: { text?: string; value?: unknown; reviewer?: string; verdict?: string; issues?: unknown[] };
  idempotencyKey: string;
  /** Project attribution, derived from the owning workflow run at insert time. */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export class ModelRoutingConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`模型路由配置无效：${problems.join("；")}`);
    this.name = "ModelRoutingConfigError";
  }
}

export class ExternalMcpRequiredError extends Error {
  constructor(
    readonly purpose: ModelPurpose,
    readonly snapshotId: string,
    readonly candidateIndex: number,
  ) {
    super(`模型任务 ${purpose} 需要由外部 MCP 执行`);
    this.name = "ExternalMcpRequiredError";
  }
}

/**
 * 同步链路的外部 MCP 兜底状态映射（机制契约 2026-09-07）。
 *
 * workflow 链路中 ExternalMcpRequiredError 由 activity 物化为可认领的外部任务，
 * 属正常等待而非错误；但 API 进程内同步调用（创意短剧、章节剧本直出）没有物化
 * 通道，异常直接冒泡——映射为 503 Service Unavailable（候选全部失败、可行动：
 * 补充 API 候选或走外部 submit 双轨），而非裸 500（语义为系统内部错误）。
 * 非 ExternalMcpRequiredError 返回 null，调用方按原错误通道处理。
 */
export function syncExternalMcpHttpStatus(error: unknown): number | null {
  return error instanceof ExternalMcpRequiredError ? 503 : null;
}

export function requiredCapability(purpose: ModelPurpose): ModelCapability {
  return PURPOSE_CAPABILITY[purpose];
}

export function resolveRoute(config: Pick<ModelRoutingConfig, "routes">, purpose: ModelPurpose): ModelRoute | undefined {
  return config.routes[purpose] ?? config.routes[`${purpose.split(".")[0]}.*`] ?? config.routes["*"];
}

export function validateModelRoutingConfig(config: ModelRoutingConfig): void {
  const problems: string[] = [];
  if (config.version !== 1) problems.push("仅支持 version=1");
  const profiles = new Map<string, ModelProviderProfile>();
  for (const profile of config.profiles ?? []) {
    if (!profile.id?.trim()) problems.push("profile.id 不能为空");
    if (profiles.has(profile.id)) problems.push(`profile.id 重复：${profile.id}`);
    profiles.set(profile.id, profile);
    try { new URL(profile.baseUrl); } catch { problems.push(`profile ${profile.id} 的 baseUrl 无效`); }
    if (!profile.model?.trim()) problems.push(`profile ${profile.id} 缺少默认模型`);
    if (!Array.isArray(profile.capabilities) || !profile.capabilities.length) problems.push(`profile ${profile.id} 缺少 capabilities`);
    if (profile.protocol === "responses" && profile.responseMode === "sse") problems.push(`profile ${profile.id} 的 Responses adapter 当前仅支持 JSON 聚合`);
    if (profile.secret?.source === "inline" && !profile.secret.value.trim()) problems.push(`profile ${profile.id} 的 inline key 为空`);
    if (profile.secret?.source === "env" && !profile.secret.name.trim()) problems.push(`profile ${profile.id} 的环境变量名为空`);
  }
  if (!Object.keys(config.routes ?? {}).length) problems.push("至少需要一条模型路由");
  for (const purpose of MODEL_PURPOSES) {
    const route = resolveRoute(config, purpose);
    if (!route || !route.candidates.length) {
      // 空候选链合法：网关在链尾隐式外部 MCP 兜底位执行（externalMcpFallback），
      // 不再要求每条 purpose 显式配置候选。显式配置仅用于挑选/排序 API 模型。
      continue;
    }
    if (route.conversationPolicy === "task-chain" && !purpose.startsWith("writing.")) {
      problems.push(`task-chain 仅允许 writing.*：${purpose}`);
    }
    for (const candidate of route.candidates) {
      // 机制契约（2026-09-07）：外部 MCP 不再是调用位置的可选执行者，而是所有
      // 调用链的隐式链尾兜底（候选耗尽时自动进入外部任务物化路径）。显式候选
      // 只允许 API provider；禁止在链中/链尾显式放置 external-mcp，避免「显式
      // 外部候选短路内部模型」与「显式外部候选把兜底位顶掉」两类配置形态。
      // 历史运行快照中的显式外部候选按原语义继续执行（invokeCandidate 兼容），
      // 保证在途工作流不受配置契约变更影响。
      if (candidate.executor === "external-mcp") {
        problems.push(`purpose ${purpose} 的候选链不允许显式 external-mcp（外部 MCP 已作为所有调用链的隐式兜底，候选链只配置 API 模型）`);
        continue;
      }
      const profile = profiles.get(candidate.profileId);
      if (!profile) {
        problems.push(`purpose ${purpose} 引用了不存在的 profile ${candidate.profileId}`);
        continue;
      }
      if (!profile.enabled) problems.push(`purpose ${purpose} 引用了已禁用的 profile ${profile.id}`);
      const capability = requiredCapability(purpose);
      if (!profile.capabilities.includes(capability)) problems.push(`profile ${profile.id} 不支持 ${purpose} 所需的 ${capability}`);
      if (route.conversationPolicy === "task-chain" && (profile.protocol !== "responses" || !profile.capabilities.includes("responses-continuation"))) {
        problems.push(`purpose ${purpose} 的 task-chain 候选 ${profile.id} 不支持 Responses 续接`);
      }
    }
  }
  if (problems.length) throw new ModelRoutingConfigError([...new Set(problems)]);
}

function secretRef(secret?: ModelSecret): string | undefined {
  if (!secret) return undefined;
  return secret.source === "env" ? `env:${secret.name}` : "local:inline";
}

export function createRoutingSnapshot(config: ModelRoutingConfig, now = Date.now()): ModelRoutingSnapshot {
  validateModelRoutingConfig(config);
  const sanitized = {
    version: config.version,
    profiles: config.profiles.map(({ secret, ...profile }) => ({ ...profile, secretRef: secretRef(secret), hasSecret: Boolean(secret) })),
    routes: config.routes,
  };
  const id = createHash("sha256").update(JSON.stringify(sanitized)).digest("hex");
  return { id, configVersion: config.version, profiles: sanitized.profiles, routes: structuredClone(config.routes), createdAt: now };
}

export function maskSecret(secret?: ModelSecret): { hasSecret: boolean; secretSource?: "inline" | "env"; secretHint?: string } {
  if (!secret) return { hasSecret: false };
  if (secret.source === "env") return { hasSecret: true, secretSource: "env", secretHint: secret.name };
  const value = secret.value.trim();
  return { hasSecret: Boolean(value), secretSource: "inline", secretHint: value ? `***${value.slice(-4)}` : undefined };
}

export function resolveProfileSecret(profile: ModelProviderProfile): string {
  if (!profile.secret) return "";
  return profile.secret.source === "inline" ? profile.secret.value : process.env[profile.secret.name] ?? "";
}
