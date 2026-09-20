import { existsSync } from "node:fs";
import { Connection } from "@temporalio/client";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { publicRuntimeIdentity, resolveNovelRuntimeConfig } from "../src/novel-v2/runtime-config";
import { isOrphanExperimentSchemaResidue, listOrphanExperimentSchemas, ORPHAN_SCHEMA_INFLIGHT_GRACE_MS } from "../src/novel-v2/evaluation/experiment-workspace";

Object.assign(process.env, loadRuntimeEnv(process.cwd()));
const runtime = resolveNovelRuntimeConfig(process.env);
const json = process.argv.includes("--json");
type Check = { ok: boolean; detail?: string; data?: unknown };
const checks: Record<string, Check> = {};
const set = (name: string, check: Check) => { checks[name] = check; };

async function probeJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text.slice(0, 500) }; }
  return { status: response.status, body };
}

const repository = new NovelPostgresRepository(runtime.databaseUrl);
const objectStore = new ContentObjectStore();
try {
  set("runtime", { ok: true, data: publicRuntimeIdentity(runtime) });
  set("model-config", { ok: existsSync(runtime.modelConfigPath), detail: runtime.modelConfigPath });

  try {
    const audit = await repository.auditMigrations(runtime.migrationsDir);
    set("migrations", { ok: audit.ok && audit.missingInDatabase.length === 0, data: { files: audit.files.length, applied: audit.applied.length, missing: audit.missingInDatabase, duplicateOrdinals: audit.duplicateOrdinals, checksumMismatches: audit.checksumMismatches, unexpectedApplied: audit.unexpectedApplied, legacyApplied: audit.legacyApplied } });
  } catch (error) { set("migrations", { ok: false, detail: (error as Error).message }); }

  try {
    await repository.health();
    const stored = await repository.getRuntimeConfiguration<{ backend?: string; location?: string; fingerprint?: string }>("object-store");
    const current = objectStore.identity();
    set("postgres", { ok: true, data: { objectStore: stored ? { backend: stored.backend, location: stored.location, fingerprint: stored.fingerprint } : null } });
    set("object-store-identity", { ok: Boolean(stored && stored.fingerprint === current.fingerprint), detail: stored ? `${stored.backend}:${stored.location} vs ${current.backend}:${current.location}` : "数据库尚未绑定对象存储身份" });
    const references = await repository.listReferencedObjectKeys();
    const availability = await Promise.all(references.map(async (item) => ({ ...item, available: await objectStore.has(item.objectKey) })));
    const missing = availability.filter((item) => !item.available).slice(0, 10).map((item) => item.objectKey);
    set("object-store-references", { ok: missing.length === 0, detail: `references=${references.length} missing=${missing.length}`, data: { missing } });
  } catch (error) { set("postgres", { ok: false, detail: (error as Error).message }); }

  // 零登记实验沙箱：数据库全局残留，只报不删（删除是 DROP SCHEMA CASCADE，既会在单事务里
  // 打爆共享锁表，也会误删"登记行尚未插入"的在飞实验——两条都在真库实测过，见 migration 093
  // 头注释）。查到残留不改退出码——残留是运维 backlog 而非运行时不健康；只有查询本身失败才算
  // 检查失败。目的是让这件事从人工取证变成常规观测面。
  try {
    const orphans = await listOrphanExperimentSchemas(repository);
    const residue = orphans.filter((item) => isOrphanExperimentSchemaResidue(item));
    const tables = residue.reduce((sum, item) => sum + item.tables, 0);
    const columns = residue.reduce((sum, item) => sum + item.columns, 0);
    set("experiment-sandbox", {
      ok: true,
      detail: `零登记 ${orphans.length} 个（超在飞宽限 ${residue.length} 个：表 ${tables} / 列 ${columns}；宽限 ${ORPHAN_SCHEMA_INFLIGHT_GRACE_MS}ms）——只报不删`,
      data: { withinGrace: orphans.length - residue.length, residue: residue.slice(0, 20) },
    });
  } catch (error) { set("experiment-sandbox", { ok: false, detail: (error as Error).message }); }

  try {
    const [aliases, collection] = await Promise.all([
      probeJson(`${runtime.qdrantUrl.replace(/\/+$/u, "")}/aliases`),
      probeJson(`${runtime.qdrantUrl.replace(/\/+$/u, "")}/collections/${encodeURIComponent(runtime.qdrantCollection)}`),
    ]);
    const aliasRows = Array.isArray((aliases.body.result as { aliases?: unknown[] } | undefined)?.aliases) ? ((aliases.body.result as { aliases: Array<Record<string, unknown>> }).aliases) : [];
    const alias = aliasRows.find((row) => row.alias_name === runtime.qdrantCollection);
    const result = collection.body.result as { config?: { params?: { vectors?: { size?: number } } }; points_count?: number } | undefined;
    const dimension = result?.config?.params?.vectors?.size;
    set("qdrant", { ok: aliases.status < 300 && collection.status < 300 && Boolean(alias) && dimension === runtime.embeddingDimension, data: { alias: alias?.collection_name, dimension, points: result?.points_count } });
  } catch (error) { set("qdrant", { ok: false, detail: (error as Error).message }); }

  try {
    const connection = await Connection.connect({ address: runtime.temporalAddress });
    await connection.workflowService.getSystemInfo({});
    await connection.close();
    set("temporal", { ok: true, detail: runtime.temporalAddress });
  } catch (error) { set("temporal", { ok: false, detail: (error as Error).message }); }

  for (const [name, url] of [["api", `http://127.0.0.1:${runtime.apiPort}/ready`], ["worker", `http://127.0.0.1:${runtime.workerHealthPort}/ready`]] as const) {
    try {
      const result = await probeJson(url);
      const identity = result.body.runtime as { fingerprint?: string } | undefined;
      set(name, { ok: result.status < 300 && result.body.status === "healthy" && identity?.fingerprint === runtime.runtimeFingerprint, detail: `HTTP ${result.status}`, data: { status: result.body.status, runtime: identity } });
    } catch (error) { set(name, { ok: false, detail: (error as Error).message }); }
  }
} finally {
  await repository.close();
}

const ok = Object.values(checks).every((check) => check.ok);
const output = { ok, runtime: publicRuntimeIdentity(runtime), checks };
if (json) console.log(JSON.stringify(output, null, 2));
else {
  console.log(`runtime ${runtime.profile}/${runtime.runtimeId} fingerprint=${runtime.runtimeFingerprint.slice(0, 12)}`);
  for (const [name, check] of Object.entries(checks)) console.log(`${check.ok ? "OK" : "FAIL"} ${name}${check.detail ? ` ${check.detail}` : ""}`);
}
if (!ok) process.exitCode = 1;
