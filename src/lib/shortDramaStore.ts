/**
 * 独立短剧板块的浏览器本地存储（IndexedDB）。
 *
 * 设计目的：独立短剧（不含小说派生章节短剧）不再落 Postgres，改由浏览器 IndexedDB
 * 直接管理——创作台（短剧创作容器）、公用素材（含 Blob 图片）、以及每部剧情生成的
 * 剧本记录都存本地。生成仍走后端 stateless 端点，产物落这一步的 scripts store。
 *
 * 复用既有封装：`createRepairingStore`（src/lib/indexedDbStore.ts，基于 idb-keyval
 * ^6.2.6），DB 名 `ymcp-short-drama-db`，三个 store（workspaces / materials / scripts），
 * 各自 open 时自修复补建（up-open 保证缺失 store 就位）。
 *
 * 索引策略：数据量为创作台/素材/剧本几十条级，DAO 层用 JS 过滤（等价 workspaceId 索引）。
 * TODO P2: 若列表量级增长，再上真实 IDB index（objectStore.createIndex）。
 */
import { get, set, del, clear, entries } from "idb-keyval";
import { createRepairingStore } from "./indexedDbStore";

const DB_NAME = "ymcp-short-drama-db";
const workspacesStore = createRepairingStore(DB_NAME, "workspaces");
const materialsStore = createRepairingStore(DB_NAME, "materials");
const scriptsStore = createRepairingStore(DB_NAME, "scripts");

/** 短剧创作台容器记录。 */
export interface ShortDramaWorkspaceRecord {
  workspaceId: string;
  title: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

/** 公用素材记录（含图片 Blob，读图时用 URL.createObjectURL）。 */
export interface ShortDramaMaterialRecord {
  materialId: string;
  workspaceId: string;
  description: string;
  fileName?: string;
  mimeType?: string;
  contentHash: string;
  blob: Blob;
  createdAt: number;
}

/** 剧情选中素材的快照（material_refs：与后端 ShortDramaMaterialRef 同形）。 */
export interface ShortDramaScriptRef {
  materialId: string;
  description: string;
  subjectTag: string;
}

/** 剧情（独立短剧脚本）在浏览器中的记录。segments/plotBeats 等沿用后端产物形状。 */
export interface ShortDramaScriptRecord {
  scriptId: string;
  /** 归属创作台；undefined = 独立剧情（无创作台）。 */
  workspaceId?: string;
  materialRefs?: ShortDramaScriptRef[];
  idea: string;
  instruction?: string;
  durationMode: "fixed" | "auto";
  targetDurationSeconds: number;
  sourceFingerprint: string;
  /** 前端幂等键（见 computeShortDramaLocalKey），同输入重复生成时去重。 */
  localKey: string;
  plotBeats: unknown[];
  creativeStrategy?: unknown;
  cinematicHints: string[];
  characters: unknown[];
  segments: unknown[];
  createdAt: number;
}

/** 计算十六进制 sha256（前端本地幂等/localKey、素材 contentHash 共用）。 */
export async function sha256Hex(input: string | BufferSource): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 前端幂等键：scope(workspaceId 或 "independent") + idea + instruction + 时长维度
 * + 素材快照（Subject N:描述，保序）。与后端 sourceFingerprint 语义一致，但完全在
 * 浏览器端计算，用于在落库前判断「同输入重复生成」以直接复用既有剧本。
 */
export async function computeShortDramaLocalKey(input: {
  workspaceId?: string;
  idea: string;
  instruction?: string;
  durationMode: "fixed" | "auto";
  targetDurationSeconds: number;
  materialRefs?: ShortDramaScriptRef[];
}): Promise<string> {
  const materials = (input.materialRefs ?? [])
    .map((ref) => `${ref.materialId}:${ref.subjectTag}:${ref.description}`)
    .join("|");
  return sha256Hex(
    `${input.workspaceId ?? "independent"}:${input.idea}:${input.instruction ?? ""}:${input.durationMode}:${input.targetDurationSeconds}:${materials}`,
  );
}

/**
 * 本地写入的单调时间戳。
 *
 * 根因：Date.now() 只有毫秒分辨率，同一毫秒内连建两条记录会得到相同时间戳，列表排序随即
 * 退化为 IndexedDB 主键（随机 UUID）顺序——用户看到"刚建的反而排在最后"，断言顺序的测试
 * 也会偶发红。这里保证同毫秒内严格递增（跨毫秒仍跟随真实时间），让"最新在前"在本地存储
 * 里成为可判定事实。
 */
let lastLocalStamp = 0;
function nextLocalStamp(): number {
  const now = Date.now();
  lastLocalStamp = now > lastLocalStamp ? now : lastLocalStamp + 1;
  return lastLocalStamp;
}

// ---------- 创作台 ----------

export async function createShortDramaWorkspaceLocal(input: { title: string; description?: string }): Promise<ShortDramaWorkspaceRecord> {
  const now = nextLocalStamp();
  const record: ShortDramaWorkspaceRecord = {
    workspaceId: crypto.randomUUID(),
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await set(record.workspaceId, record, workspacesStore);
  return record;
}

export async function listShortDramaWorkspacesLocal(): Promise<ShortDramaWorkspaceRecord[]> {
  const all = await entries<string, ShortDramaWorkspaceRecord>(workspacesStore);
  return all.map(([, value]) => value).sort((a, b) => b.updatedAt - a.updatedAt || a.workspaceId.localeCompare(b.workspaceId));
}

export async function getShortDramaWorkspaceLocal(workspaceId: string): Promise<ShortDramaWorkspaceRecord | undefined> {
  return get(workspaceId, workspacesStore);
}

/** 删除创作台：级联删素材 + 解除该创作台下剧本的归属（workspaceId 保留为 undefined 更合理）。 */
export async function deleteShortDramaWorkspaceLocal(workspaceId: string): Promise<void> {
  // 级联清素材
  const materials = await listShortDramaMaterialsLocal(workspaceId);
  for (const material of materials) await del(material.materialId, materialsStore);
  // 解除创作台下剧本归属
  for (const script of await listShortDramaScriptsLocal(workspaceId)) {
    const { workspaceId: _ws, ...rest } = script;
    await set(script.scriptId, { ...rest, workspaceId: undefined }, scriptsStore);
  }
  await del(workspaceId, workspacesStore);
}

// ---------- 素材（含 Blob 图） ----------

/** 新增素材：按 (workspaceId, contentHash) 去重；同图复用并保留原描述（返回 reused 标记）。 */
export async function addShortDramaMaterialLocal(input: {
  workspaceId: string;
  description: string;
  file: File;
}): Promise<{ material: ShortDramaMaterialRecord; reused: boolean }> {
  const contentHash = await sha256Hex(await input.file.arrayBuffer());
  const existing = (await listShortDramaMaterialsLocal(input.workspaceId)).find((m) => m.contentHash === contentHash);
  if (existing) return { material: existing, reused: true };
  const record: ShortDramaMaterialRecord = {
    materialId: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    description: input.description.trim(),
    fileName: input.file.name,
    mimeType: input.file.type || "image/png",
    contentHash,
    blob: input.file,
    createdAt: nextLocalStamp(),
  };
  await set(record.materialId, record, materialsStore);
  return { material: record, reused: false };
}

export async function listShortDramaMaterialsLocal(workspaceId: string): Promise<ShortDramaMaterialRecord[]> {
  const all = await entries<string, ShortDramaMaterialRecord>(materialsStore);
  return all
    .map(([, value]) => value)
    .filter((material) => material.workspaceId === workspaceId)
    .sort((a, b) => a.createdAt - b.createdAt || a.materialId.localeCompare(b.materialId));
}

export async function getShortDramaMaterialLocal(workspaceId: string, materialId: string): Promise<ShortDramaMaterialRecord | undefined> {
  const material = await get(materialId, materialsStore);
  return material?.workspaceId === workspaceId ? material : undefined;
}

export async function updateShortDramaMaterialDescriptionLocal(workspaceId: string, materialId: string, description: string): Promise<void> {
  const material = await getShortDramaMaterialLocal(workspaceId, materialId);
  if (!material) throw new Error("指定的素材不存在");
  await set(materialId, { ...material, description: description.trim() }, materialsStore);
}

export async function deleteShortDramaMaterialLocal(workspaceId: string, materialId: string): Promise<void> {
  const material = await getShortDramaMaterialLocal(workspaceId, materialId);
  if (!material) return;
  await del(materialId, materialsStore);
}

// ---------- 剧情（脚本） ----------

export async function saveShortDramaScriptLocal(record: ShortDramaScriptRecord): Promise<ShortDramaScriptRecord> {
  await set(record.scriptId, record, scriptsStore);
  return record;
}

export async function listShortDramaScriptsLocal(workspaceId?: string): Promise<ShortDramaScriptRecord[]> {
  const all = await entries<string, ShortDramaScriptRecord>(scriptsStore);
  return all
    .map(([, value]) => value)
    .filter((script) => (workspaceId === undefined ? !script.workspaceId : script.workspaceId === workspaceId))
    .sort((a, b) => b.createdAt - a.createdAt || b.scriptId.localeCompare(a.scriptId));
}

export async function getShortDramaScriptLocal(scriptId: string): Promise<ShortDramaScriptRecord | undefined> {
  return get(scriptId, scriptsStore);
}

export async function deleteShortDramaScriptLocal(scriptId: string): Promise<void> {
  await del(scriptId, scriptsStore);
}

/** 前端幂等查询：按 localKey 找既有剧本（workspaceId 维度）。 */
export async function findShortDramaScriptByLocalKey(workspaceId: string | undefined, localKey: string): Promise<ShortDramaScriptRecord | undefined> {
  const all = await entries<string, ShortDramaScriptRecord>(scriptsStore);
  return all
    .map(([, value]) => value)
    .find((script) => script.workspaceId === workspaceId && script.localKey === localKey);
}

/** 近期剧情核心创意（供跨作品反同质 avoidMotifs 注入；浏览器端历史源）。 */
export async function listShortDramaRecentIdeas(limit = 12): Promise<string[]> {
  const all = await entries<string, ShortDramaScriptRecord>(scriptsStore);
  return all
    .map(([, value]) => value.idea?.trim())
    .filter((idea): idea is string => Boolean(idea))
    .slice(0, limit);
}

/** 整板块清空（开发者/测试用）。 */
export async function clearShortDramaStoreLocal(): Promise<void> {
  await clear(workspacesStore);
  await clear(materialsStore);
  await clear(scriptsStore);
}