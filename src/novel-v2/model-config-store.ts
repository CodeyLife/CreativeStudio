import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  createRoutingSnapshot,
  maskSecret,
  type ModelProviderProfile,
  type ModelRoutingConfig,
  type ModelRoutingSnapshot,
  validateModelRoutingConfig,
} from "./model-routing";

export const DEFAULT_MODEL_CONFIG_PATH = join(process.cwd(), "config", "model-providers.local.yaml");

function normalizeLoadedConfig(value: ModelRoutingConfig): ModelRoutingConfig {
  const legacy = value as ModelRoutingConfig & { profiles: Array<ModelProviderProfile & { structuredOutput?: unknown }> };
  // 机制契约（2026-09-07）：候选链只承载 API 候选，外部 MCP 是所有调用链的隐式
  // 链尾兜底。载入旧格式配置时剥离显式 external-mcp 候选——行为等价（该候选的
  // 唯一作用就是触发外部等待，兜底机制覆盖同一语义），避免旧文件使 worker 启动
  // 失败；保存路径（validateModelRoutingConfig）仍拒绝显式外部候选，保证新落盘
  // 均为新契约形态。
  let strippedExternal = false;
  const routes = Object.fromEntries(Object.entries(legacy.routes ?? {}).map(([purpose, route]) => {
    const candidates = (route.candidates ?? []).filter((candidate) => {
      if (candidate.executor !== "external-mcp") return true;
      strippedExternal = true;
      return false;
    });
    return [purpose, { ...route, candidates }];
  }));
  if (strippedExternal) {
    console.warn("[model-config] 已剥离历史配置中的显式 external-mcp 候选：外部 MCP 现为所有调用链的隐式链尾兜底（见 docs/novel-v2/workflow-map.md 调用链契约）");
  }
  return {
    ...legacy,
    routes,
    profiles: (legacy.profiles ?? []).map((profile) => {
      const normalized = { ...profile } as ModelProviderProfile & { structuredOutput?: unknown };
      delete normalized.structuredOutput;
      return normalized;
    }),
  };
}

export function applyRuntimeModelOverrides(
  config: ModelRoutingConfig,
  overrides: { embeddingBaseUrl?: string } = {},
): ModelRoutingConfig {
  const embeddingBaseUrl = overrides.embeddingBaseUrl?.trim().replace(/\/+$/, "");
  if (!embeddingBaseUrl) return structuredClone(config);
  const embeddingProfileIds = new Set(
    (config.routes["memory.embed"]?.candidates ?? [])
      .filter((candidate) => candidate.executor === "api")
      .map((candidate) => candidate.profileId),
  );
  return {
    ...structuredClone(config),
    profiles: config.profiles.map((profile) => embeddingProfileIds.has(profile.id) && profile.capabilities.includes("embedding")
      ? { ...structuredClone(profile), baseUrl: embeddingBaseUrl }
      : structuredClone(profile)),
  };
}

export function createInitialModelConfig(): ModelRoutingConfig {
  // 机制契约（2026-09-07）：外部 MCP 不是调用位置的可选执行者，而是所有调用
  // 链的隐式链尾兜底（网关在候选耗尽时自动转入外部任务物化路径）。初始配置
  // 因此是空候选链——所有 purpose 在未显式配置 API 模型时走兜底。
  return { version: 1, profiles: [], routes: { "*": { conversationPolicy: "stateless", candidates: [] } } };
}

export class ModelConfigStore {
  private current: ModelRoutingConfig;
  private snapshot: ModelRoutingSnapshot;
  private loadedMtimeMs?: number;

  constructor(readonly path = process.env.NOVEL_MODEL_CONFIG_PATH ?? DEFAULT_MODEL_CONFIG_PATH, initial = createInitialModelConfig()) {
    const normalized = normalizeLoadedConfig(initial);
    validateModelRoutingConfig(normalized);
    this.current = structuredClone(normalized);
    this.snapshot = createRoutingSnapshot(this.current);
  }

  async load(): Promise<ModelRoutingConfig> {
    try {
      const parsed = normalizeLoadedConfig(parse(await readFile(this.path, "utf8")) as ModelRoutingConfig);
      validateModelRoutingConfig(parsed);
      this.current = applyRuntimeModelOverrides(parsed, { embeddingBaseUrl: process.env.NOVEL_EMBEDDING_BASE_URL });
      this.snapshot = createRoutingSnapshot(this.current);
      this.loadedMtimeMs = (await stat(this.path).catch(() => undefined))?.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    return this.getConfig();
  }

  private reloadIfChanged(): void {
    try {
      const stats = statSync(this.path);
      if (this.loadedMtimeMs !== undefined && stats.mtimeMs <= this.loadedMtimeMs) return;
      const parsed = normalizeLoadedConfig(parse(readFileSync(this.path, "utf8")) as ModelRoutingConfig);
      validateModelRoutingConfig(parsed);
      this.current = applyRuntimeModelOverrides(parsed, { embeddingBaseUrl: process.env.NOVEL_EMBEDDING_BASE_URL });
      this.snapshot = createRoutingSnapshot(this.current);
      this.loadedMtimeMs = stats.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
  }

  getConfig(): ModelRoutingConfig { this.reloadIfChanged(); return structuredClone(this.current); }
  getSnapshot(): ModelRoutingSnapshot { this.reloadIfChanged(); return structuredClone(this.snapshot); }

  getMaskedConfig() {
    this.reloadIfChanged();
    return {
      version: this.current.version,
      profiles: this.current.profiles.map(({ secret, ...profile }) => ({ ...profile, ...maskSecret(secret) })),
      routes: structuredClone(this.current.routes),
      snapshotId: this.snapshot.id,
    };
  }

  getProfile(profileId: string): ModelProviderProfile | undefined {
    this.reloadIfChanged();
    const profile = this.current.profiles.find((item) => item.id === profileId);
    return profile ? structuredClone(profile) : undefined;
  }

  async save(next: ModelRoutingConfig): Promise<ModelRoutingConfig> {
    validateModelRoutingConfig(next);
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tempPath, stringify(next), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.path);
    this.current = structuredClone(next);
    this.snapshot = createRoutingSnapshot(this.current);
    this.loadedMtimeMs = (await stat(this.path).catch(() => undefined))?.mtimeMs;
    return this.getConfig();
  }
}
