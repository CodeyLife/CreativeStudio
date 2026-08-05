import { NativeConnection, Worker } from "@temporalio/worker";
import { QdrantClient } from "@qdrant/js-client-rest";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { createNovelWorkflowActivities } from "../src/novel-v2/temporal/activities";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import { QdrantMemoryProvider } from "../src/novel-v2/qdrant-memory";
import { createFusionMemoryProvider } from "../src/novel-v2/fusion-memory";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { bindRuntimeObjectStore } from "../src/novel-v2/runtime-object-store";
import { createConfiguredSkillProvider } from "../src/novel-v2/skill-runtime";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { publicRuntimeIdentity, resolveNovelRuntimeConfig } from "../src/novel-v2/runtime-config";

Object.assign(process.env, loadRuntimeEnv(process.cwd()));
const runtime = resolveNovelRuntimeConfig(process.env);

const repository = new NovelPostgresRepository(runtime.databaseUrl);
await repository.migrate(runtime.migrationsDir);
const skillProvider = createConfiguredSkillProvider({ source: process.env.NOVEL_SKILL_SOURCE, databaseList: (projectId) => repository.listSkills(projectId) });
const objectStore = new ContentObjectStore();
await bindRuntimeObjectStore(repository, objectStore, "worker");
const qdrant = new QdrantClient({ url: runtime.qdrantUrl });
const { gateway: modelGateway } = await createRuntimeModelGateway(repository, objectStore);
const qdrantMemory = new QdrantMemoryProvider(qdrant, modelGateway, runtime.qdrantCollection, runtime.embeddingDimension);
const workflowsPath = fileURLToPath(new URL("../src/novel-v2/temporal/workflows.ts", import.meta.url));

// P2-G2: 三轨加权融合（semantic 0.5 + lexical 0.3 + graph 0.2）
// 设计依据：AGENTS.md「reusable contracts」——融合逻辑从 worker 内联抽到
// FusionMemoryProvider 共享层，min-max 归一化 + 权重重分配，避免 last-wins 丢信号。
const fusionMemory = createFusionMemoryProvider(qdrantMemory, repository, {
  search: (input) => repository.searchGraphMemory(input),
});
const serviceId = `worker:${randomUUID()}`;
let readiness: { status: "healthy" | "degraded"; details: Record<string, unknown> } = { status: "healthy", details: {} };
try {
  const embeddingIndex = await repository.getRuntimeConfiguration<{ status?: string; alias?: string }>("embedding-index");
  if (embeddingIndex?.status !== "ready" || embeddingIndex.alias !== qdrantMemory.collection) throw new Error("embedding 索引尚未完成版本化重建与 alias 切换");
  await qdrantMemory.ensureCollection();
  const probe = await modelGateway.embed({ purpose: "memory.embed", texts: ["worker embedding readiness"] });
  if (probe.vectors[0]?.length !== qdrantMemory.dimension) throw new Error(`embedding 维度 ${probe.vectors[0]?.length ?? 0} != ${qdrantMemory.dimension}`);
} catch (error) {
  readiness = { status: "degraded", details: { embedding: error instanceof Error ? error.message : String(error) } };
}

const healthServer = createServer((request, response) => {
  const live = request.url === "/live";
  const ready = request.url === "/ready";
  const status = live || readiness.status === "healthy" ? 200 : 503;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-novel-runtime-id": runtime.runtimeId, "x-novel-runtime-profile": runtime.profile, "x-novel-runtime-fingerprint": runtime.runtimeFingerprint });
  response.end(JSON.stringify(live ? { status: "alive", serviceId, runtime: publicRuntimeIdentity(runtime) } : ready ? { ...readiness, serviceId, runtime: publicRuntimeIdentity(runtime) } : { error: "NOT_FOUND" }));
});
healthServer.listen(runtime.workerHealthPort, runtime.workerHealthHost);
const heartbeat = async () => repository.heartbeatRuntimeService({ serviceId, serviceType: "novel-worker", status: readiness.status, details: readiness.details });
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => console.warn("worker heartbeat 写入失败", error)), 10_000);
heartbeatTimer.unref();

const worker = await Worker.create({
  connection: await NativeConnection.connect({ address: runtime.temporalAddress }),
  namespace: runtime.temporalNamespace,
  taskQueue: runtime.taskQueue,
  // Keep the build id stable while this namespace runs without Worker Versioning.
  // The SDK default includes the workflow bundle hash, which can orphan open
  // workflow activities after a local code reload. Deployments using versioning
  // should provide an explicit release id through TEMPORAL_WORKER_BUILD_ID.
  buildId: runtime.workerBuildId,
  workflowsPath,
  activities: createNovelWorkflowActivities({
    repository,
    memoryProvider: fusionMemory,
    skillProvider,
    modelGateway,
    objectStore,
    // CommitService 由 createNovelWorkflowActivities 自动注入 chapter memory 依赖
    // 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约
    memoryIndex: {
      upsertClaims: async (projectId, claims) => { try { await qdrantMemory.upsertClaims(projectId, claims); } catch (error) { console.warn("Qdrant 写入失败，PostgreSQL memory_claims 已保留为真源", error); } },
      deleteClaims: async (projectId, claimIds) => { try { await qdrantMemory.deleteClaims(projectId, claimIds); } catch (error) { console.warn("Qdrant 删除失败，旧向量将被 active 状态过滤", error); } },
    },
    enableChapterMemory: true,
  }),
});

void qdrant.getCollections().catch((error: unknown) => console.warn("Qdrant 派生索引不可用，当前仅使用 PostgreSQL 事实检索", error));

process.once("SIGINT", () => void worker.shutdown());
process.once("SIGTERM", () => void worker.shutdown());
await worker.run();
clearInterval(heartbeatTimer);
healthServer.close();
await repository.close();
