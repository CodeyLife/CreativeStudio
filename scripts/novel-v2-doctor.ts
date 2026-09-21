import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Connection } from "@temporalio/client";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { candidateFilePattern, findWriterMatches, parseDroppedFaces, WRITER_SCAN_PATHS } from "../src/novel-v2/migration-face-writers";
import { detectMemoryIndexDrift } from "../src/novel-v2/memory-index-drift";
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

async function postJson(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { raw: text.slice(0, 500) }; }
  return { status: response.status, body };
}

/**
 * 逐项目取回索引里的点 id 集合（漂移对账要用集合而非条数：见 memory-index-drift.ts）。
 * 拿不到（非 2xx）或翻页没走完都返回 null 判"不可得"——半个集合会把欠灌报成假数。
 */
async function scrollPointIds(scrollUrl: string, projectId: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let offset: unknown = null;
  for (let page = 0; page < 200; page += 1) {
    const probe = await postJson(scrollUrl, {
      filter: { must: [{ key: "projectId", match: { value: projectId } }] },
      limit: 256,
      with_payload: false,
      with_vector: false,
      ...(offset === null ? {} : { offset }),
    });
    const result = probe.status < 300 ? probe.body.result as { points?: Array<{ id: string | number }>; next_page_offset?: unknown } | undefined : undefined;
    if (!result) return null;
    const batch = result.points ?? [];
    for (const point of batch) ids.add(String(point.id));
    if (!batch.length || result.next_page_offset == null) return ids;
    offset = result.next_page_offset;
  }
  return null;
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

  // 记忆索引漂移：库里"该有哪些点"与向量库里实有点的逐项目**集合**对账。判据（含"只把
  // 陈旧点判成异常"与"只报不修"两条）在 memory-index-drift.ts，本处只取数打印。
  try {
    const baseline = await repository.listIndexableMemoryRowIds();
    const scrollUrl = `${runtime.qdrantUrl.replace(/\/+$/u, "")}/collections/${encodeURIComponent(runtime.qdrantCollection)}/points/scroll`;
    const indexedByProject = new Map<string, Set<string> | null>();
    for (const row of baseline) indexedByProject.set(row.projectId, await scrollPointIds(scrollUrl, row.projectId));
    const { rows, dirty } = detectMemoryIndexDrift(baseline, indexedByProject);
    const missing = rows.reduce((sum, row) => sum + row.missingRowIds.length, 0);
    const compact = (row: (typeof rows)[number]) => ({ projectId: row.projectId, expected: row.expected, indexed: row.indexed, missing: row.missingRowIds.length, extra: row.extraPointIds.length, extraSample: row.extraPointIds.slice(0, 5), missingSample: row.missingRowIds.slice(0, 5) });
    set("memory-index-drift", {
      ok: true,
      detail: `项目 ${rows.length} 个；欠灌行 ${missing} 条；陈旧点 ${dirty.reduce((sum, row) => sum + row.extraPointIds.length, 0)} 个（脏索引项目 ${dirty.length} 个）${dirty.length ? " ⇒ 陈旧点会把已退役内容当现行事实召回，走 POST /v2/projects/:id/memory/rebuild 重建，本检查不自动修" : ""}`,
      data: { dirty: dirty.map(compact).slice(0, 10), underIndexed: rows.filter((row) => row.missingRowIds.length > 0).map(compact).slice(0, 10) },
    });
  } catch (error) { set("memory-index-drift", { ok: false, detail: (error as Error).message }); }

  try {
    const connection = await Connection.connect({ address: runtime.temporalAddress });
    await connection.workflowService.getSystemInfo({});
    await connection.close();
    set("temporal", { ok: true, detail: runtime.temporalAddress });
  } catch (error) { set("temporal", { ok: false, detail: (error as Error).message }); }

  const codeRevisions: Array<{ service: string; revision: string }> = [];
  for (const [name, url] of [["api", `http://127.0.0.1:${runtime.apiPort}/ready`], ["worker", `http://127.0.0.1:${runtime.workerHealthPort}/ready`]] as const) {
    try {
      const result = await probeJson(url);
      const identity = result.body.runtime as { fingerprint?: string; codeRevision?: string } | undefined;
      if (typeof identity?.codeRevision === "string" && identity.codeRevision) codeRevisions.push({ service: name, revision: identity.codeRevision });
      set(name, { ok: result.status < 300 && result.body.status === "healthy" && identity?.fingerprint === runtime.runtimeFingerprint, detail: `HTTP ${result.status}`, data: { status: result.body.status, runtime: identity } });
    } catch (error) { set(name, { ok: false, detail: (error as Error).message }); }
  }

  // 撤面对账：库里**已经应用过**的撤表/撤列迁移，是否还有正在跑的进程仍往那个对象写。
  // 迁移由新代码在启动时跑，所以顺序假设是"旧进程先没"；半停服、多实例、蓝绿没切干净时
  // 该假设不成立，届时炸的不是启动而是某条业务路径抛 relation/column does not exist。
  // 本仓对"撤面必须让在飞的旧东西显式作废"已有先例：迁移 041 做 schema 减法时把在跑
  // run 标成 `needs-restart`。表/列级同理，但主语是进程代码而非 run 行，故落成观测面。
  // 只报不改退出码（与 experiment-sandbox 同形态）：这是一张对账单，不是运行时不健康。
  try {
    const audit = await repository.auditMigrations(runtime.migrationsDir);
    const faces = audit.applied.flatMap((row) => {
      const file = join(runtime.migrationsDir, row.version);
      return existsSync(file) ? parseDroppedFaces({ version: row.version, text: readFileSync(file, "utf8") }) : [];
    });
    const pattern = candidateFilePattern(faces);
    const readAtRevision = (revision: string, file: string) => execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const listWriters = (revision: string) => {
      const listing = (() => {
        try {
          return execFileSync("git", ["grep", "-l", "-E", pattern, revision, "--", ...WRITER_SCAN_PATHS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
          // git grep 的退出码 1 是"零命中"（干净），其余才是真失败。
          if ((error as { code?: number }).code === 1) return "";
          throw error;
        }
      })();
      const files = [...new Set(listing.split("\n").filter(Boolean).map((line) => line.slice(revision.length + 1)))];
      return findWriterMatches(faces, files.map((file) => ({ file, text: readAtRevision(revision, file) })));
    };
    const byService: Array<{ service: string; revision: string; offenders?: Array<{ file: string; at: string }>; note?: string }> = [];
    let undeterminable: string | null = null;
    for (const { service, revision } of codeRevisions) {
      if (!pattern) { byService.push({ service, revision, offenders: [], note: "库内无已落地的撤面对象" }); continue; }
      try {
        byService.push({ service, revision, offenders: listWriters(revision) });
      } catch (error) {
        // 无 git / 不是 git 工作树 / 该 revision 不在本库里：这是环境能力缺口，不是运行时不健康。
        undeterminable = (error as Error).message.split("\n")[0] ?? "git 取不到";
        byService.push({ service, revision, note: "无法判定" });
      }
    }
    const offenders = byService.filter((item) => (item.offenders?.length ?? 0) > 0);
    const tables = new Set(faces.filter((face) => face.kind === "table").map((face) => face.name));
    const columns = new Set(faces.filter((face) => face.kind === "column").map((face) => face.name));
    set("dropped-face-writers", {
      ok: true,
      detail: `已落地撤面 表 ${tables.size} / 列 ${columns.size}；在跑服务 ${byService.map((item) => `${item.service}@${item.revision.slice(0, 7)}`).join(" ") || "未探到"}；仍写被撤对象的服务 ${offenders.length} 个${offenders.length ? " ⇒ 先把旧进程换掉再让新代码跑迁移" : ""}${undeterminable ? `（有服务无法判定：${undeterminable}）` : ""}`,
      data: { tables: [...tables], columns: [...columns], byService },
    });
  } catch (error) { set("dropped-face-writers", { ok: false, detail: (error as Error).message }); }
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
