import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { readMigrationFiles, readMigrationManifest } from "./migrations";

export type NovelRuntimeProfile = "local-hybrid" | "container";

export interface NovelRuntimeConfig {
  profile: NovelRuntimeProfile;
  runtimeId: string;
  runtimeFingerprint: string;
  projectRoot: string;
  databaseUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  workerBuildId: string;
  qdrantUrl: string;
  qdrantCollection: string;
  embeddingDimension: number;
  embeddingModel: string;
  embeddingRevision: string;
  objectBackend: "file" | "s3";
  objectRoot?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  modelConfigPath: string;
  migrationsDir: string;
  apiHost: string;
  apiPort: number;
  workerHealthHost: string;
  workerHealthPort: number;
}

function value(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const current = env[key]?.trim();
  if (current) return current;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少运行时配置：${key}`);
}

function numberValue(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`运行时配置 ${key} 必须是正整数`);
  return parsed;
}

function sanitizedDatabaseTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.protocol}//${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return databaseUrl.replace(/:\/\/[^/@]+@/u, "://<redacted>@");
  }
}

export function resolveNovelRuntimeConfig(env: NodeJS.ProcessEnv = process.env): NovelRuntimeConfig {
  const profile = value(env, "NOVEL_RUNTIME_PROFILE", "local-hybrid") as NovelRuntimeProfile;
  if (profile !== "local-hybrid" && profile !== "container") throw new Error(`不支持的 NOVEL_RUNTIME_PROFILE：${profile}`);
  const projectRoot = resolve(value(env, "NOVEL_PROJECT_ROOT", process.cwd()));
  const objectBackend = value(env, "NOVEL_OBJECT_BACKEND") as "file" | "s3";
  if (objectBackend !== "file" && objectBackend !== "s3") throw new Error("NOVEL_OBJECT_BACKEND 必须是 file 或 s3");
  const databaseUrl = value(env, "DATABASE_URL");
  const temporalAddress = value(env, "TEMPORAL_ADDRESS");
  const qdrantUrl = value(env, "QDRANT_URL");
  const qdrantCollection = value(env, "QDRANT_COLLECTION", "novel-memory-current");
  const embeddingDimension = numberValue(env, "NOVEL_EMBEDDING_DIM", 1024);
  const embeddingModel = value(env, "NOVEL_EMBEDDING_MODEL", "BAAI/bge-m3");
  const embeddingRevision = value(env, "NOVEL_EMBEDDING_REVISION", "siliconflow-managed");
  const taskQueue = value(env, "TEMPORAL_TASK_QUEUE", "novel-v2");
  const temporalNamespace = value(env, "TEMPORAL_NAMESPACE", "default");
  const workerBuildId = value(env, "TEMPORAL_WORKER_BUILD_ID", "creative-studio-v2");
  const objectRoot = env.NOVEL_OBJECT_ROOT?.trim();
  const s3Endpoint = env.S3_ENDPOINT?.trim() || env.MINIO_ENDPOINT?.trim();
  const s3Bucket = env.S3_BUCKET?.trim() || env.MINIO_BUCKET?.trim();
  const s3AccessKeyId = env.S3_ACCESS_KEY_ID?.trim() || env.MINIO_ROOT_USER?.trim();
  const s3SecretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() || env.MINIO_ROOT_PASSWORD?.trim();
  if (objectBackend === "file" && (!objectRoot || !isAbsolute(objectRoot))) throw new Error("file 对象存储必须配置绝对路径 NOVEL_OBJECT_ROOT");
  if (objectBackend === "s3" && (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey)) throw new Error("s3 对象存储配置不完整");
  const modelConfigPath = resolve(value(env, "NOVEL_MODEL_CONFIG_PATH", join(projectRoot, "config", "model-providers.local.yaml")));
  const migrationsDir = resolve(value(env, "NOVEL_V2_MIGRATIONS_DIR", join(projectRoot, "deploy", "postgres")));
  const runtimeId = value(env, "NOVEL_RUNTIME_ID", `creative-studio-${profile}`);
  const migrationIdentity = {
    files: readMigrationFiles(migrationsDir),
    manifest: readMigrationManifest(migrationsDir),
  };
  const identity = {
    profile,
    runtimeId,
    database: sanitizedDatabaseTarget(databaseUrl),
    temporalAddress,
    temporalNamespace,
    taskQueue,
    qdrantUrl,
    qdrantCollection,
    embeddingDimension,
    embeddingModel,
    embeddingRevision,
    objectBackend,
    objectLocation: objectBackend === "file" ? resolve(objectRoot!) : `${s3Endpoint!.replace(/\/+$/u, "")}/${s3Bucket}`,
    migrationIdentity,
  };
  const runtimeFingerprint = createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
  return {
    profile,
    runtimeId,
    runtimeFingerprint,
    projectRoot,
    databaseUrl,
    temporalAddress,
    temporalNamespace,
    taskQueue,
    workerBuildId,
    qdrantUrl,
    qdrantCollection,
    embeddingDimension,
    embeddingModel,
    embeddingRevision,
    objectBackend,
    ...(objectRoot ? { objectRoot: resolve(objectRoot) } : {}),
    ...(s3Endpoint ? { s3Endpoint } : {}),
    ...(s3Bucket ? { s3Bucket } : {}),
    ...(s3AccessKeyId ? { s3AccessKeyId } : {}),
    ...(s3SecretAccessKey ? { s3SecretAccessKey } : {}),
    modelConfigPath,
    migrationsDir,
    apiHost: value(env, "NOVEL_API_HOST", profile === "container" ? "0.0.0.0" : "127.0.0.1"),
    apiPort: numberValue(env, "NOVEL_V2_API_PORT", 4770),
    workerHealthHost: value(env, "WORKER_HEALTH_HOST", profile === "container" ? "0.0.0.0" : "127.0.0.1"),
    workerHealthPort: numberValue(env, "WORKER_HEALTH_PORT", 4771),
  };
}

export function publicRuntimeIdentity(config: NovelRuntimeConfig): Record<string, string | number> {
  return {
    profile: config.profile,
    runtimeId: config.runtimeId,
    fingerprint: config.runtimeFingerprint,
    taskQueue: config.taskQueue,
    temporalNamespace: config.temporalNamespace,
    qdrantCollection: config.qdrantCollection,
    embeddingDimension: config.embeddingDimension,
    objectBackend: config.objectBackend,
  };
}
