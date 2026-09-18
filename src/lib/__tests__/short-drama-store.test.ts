/**
 * shortDramaStore（独立短剧浏览器 IndexedDB DAO）单元测试。
 * 用 fake-indexeddb（devDep）模拟浏览器 indexedDB；crypto.subtle / crypto.randomUUID
 * 用 Node 全局（Node 20+ 内置）。
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addShortDramaMaterialLocal,
  clearShortDramaStoreLocal,
  computeShortDramaLocalKey,
  createShortDramaWorkspaceLocal,
  deleteShortDramaMaterialLocal,
  deleteShortDramaWorkspaceLocal,
  findShortDramaScriptByLocalKey,
  getShortDramaScriptLocal,
  listShortDramaMaterialsLocal,
  listShortDramaRecentIdeas,
  listShortDramaScriptsLocal,
  listShortDramaWorkspacesLocal,
  saveShortDramaScriptLocal,
  updateShortDramaMaterialDescriptionLocal,
} from "../shortDramaStore";

function makeFile(name: string, bytes: string, type = "image/png"): File {
  if (typeof File === "undefined") {
    const f = new Blob([bytes], { type }) as File;
    Object.defineProperty(f, "name", { value: name });
    return f;
  }
  return new File([bytes], name, { type });
}

const SMART = {
  scriptId: "s-1",
  workspaceId: undefined as string | undefined,
  idea: "深夜便利店店员发现顾客买走商品首字拼成警告",
  durationMode: "fixed" as const,
  targetDurationSeconds: 30,
  sourceFingerprint: "fp-1",
  localKey: "lk-1",
  plotBeats: [],
  cinematicHints: [],
  characters: [],
  segments: [],
  createdAt: 1,
};

function scriptRecord(overrides: Partial<typeof SMART> = {}) {
  const base = { ...SMART, ...overrides };
  return base as ReturnType<typeof saveShortDramaScriptLocal> extends Promise<infer T> ? T : never;
}

beforeEach(async () => {
  await clearShortDramaStoreLocal();
});

describe("workflows", () => {
  it("creates and lists workspaces (newest updated first)", async () => {
    const a = await createShortDramaWorkspaceLocal({ title: "云中城" });
    const b = await createShortDramaWorkspaceLocal({ title: "剑冢" });
    const list = await listShortDramaWorkspacesLocal();
    expect(list.map((w) => w.title)).toEqual(["剑冢", "云中城"]);
    expect(a.workspaceId).toBeTruthy();
    expect(b.workspaceId !== a.workspaceId).toBe(true);
  });

  it("同毫秒连建的创作台仍严格最新在前（回归：时间戳并列会退化成 UUID 序）", async () => {
    const titles = ["t1", "t2", "t3", "t4", "t5"];
    const created = [];
    for (const title of titles) created.push(await createShortDramaWorkspaceLocal({ title }));
    // 毫秒分辨率下这些创建必然落在同一毫秒内
    const list = await listShortDramaWorkspacesLocal();
    expect(list.map((workspace) => workspace.title)).toEqual([...titles].reverse());
    for (let index = 1; index < list.length; index += 1) {
      expect(list[index - 1].updatedAt).toBeGreaterThan(list[index].updatedAt);
    }
    expect(new Set(created.map((workspace) => workspace.workspaceId)).size).toBe(titles.length);
  });

  it("时间戳并列的剧本按 scriptId 稳定全序（两次读取顺序一致）", async () => {
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "b", localKey: "lk-b", createdAt: 7 }));
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "a", localKey: "lk-a", createdAt: 7 }));
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "c", localKey: "lk-c", createdAt: 9 }));
    const first = await listShortDramaScriptsLocal();
    const second = await listShortDramaScriptsLocal();
    expect(second.map((script) => script.scriptId)).toEqual(first.map((script) => script.scriptId));
    expect(first.map((script) => script.scriptId)).toEqual(["c", "b", "a"]);
  });

  it("deleting a workspace cascades its materials and detaches its scripts", async () => {
    const ws = await createShortDramaWorkspaceLocal({ title: "w" });
    await addShortDramaMaterialLocal({ workspaceId: ws.workspaceId, description: "白鹤", file: makeFile("a.png", "bytes-1") });
    await addShortDramaMaterialLocal({ workspaceId: ws.workspaceId, description: "剑冢", file: makeFile("b.png", "bytes-2") });
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "s-ws", workspaceId: ws.workspaceId, localKey: "lk-ws" }));
    await deleteShortDramaWorkspaceLocal(ws.workspaceId);
    expect(await listShortDramaMaterialsLocal(ws.workspaceId)).toHaveLength(0);
    expect(await listShortDramaWorkspacesLocal()).toHaveLength(0);
    // 剧解除归属：仍存在，workspaceId 置为 undefined
    const s = await getShortDramaScriptLocal("s-ws");
    expect(s?.workspaceId).toBeUndefined();
  });

  it("dedupes materials by content hash within a workspace; different workspaces independent", async () => {
    const ws = await createShortDramaWorkspaceLocal({ title: "w" });
    const ws2 = await createShortDramaWorkspaceLocal({ title: "w2" });
    const first = await addShortDramaMaterialLocal({ workspaceId: ws.workspaceId, description: "白鹤", file: makeFile("a.png", "identical") });
    const dup = await addShortDramaMaterialLocal({ workspaceId: ws.workspaceId, description: "另一条", file: makeFile("a.png", "identical") });
    expect(first.reused).toBe(false);
    expect(dup.reused).toBe(true);
    expect(dup.material.materialId).toBe(first.material.materialId);
    const otherWs = await addShortDramaMaterialLocal({ workspaceId: ws2.workspaceId, description: "白鹤", file: makeFile("a.png", "identical") });
    expect(otherWs.material.materialId).not.toBe(first.material.materialId);
  });

  it("updates and deletes a material description", async () => {
    const ws = await createShortDramaWorkspaceLocal({ title: "w" });
    const { material } = await addShortDramaMaterialLocal({ workspaceId: ws.workspaceId, description: "天门初开", file: makeFile("a.png", "x") });
    await updateShortDramaMaterialDescriptionLocal(ws.workspaceId, material.materialId, "天门初开，光泻下");
    const list = await listShortDramaMaterialsLocal(ws.workspaceId);
    expect(list[0].description).toBe("天门初开，光泻下");
    await deleteShortDramaMaterialLocal(ws.workspaceId, material.materialId);
    expect(await listShortDramaMaterialsLocal(ws.workspaceId)).toHaveLength(0);
  });
});

describe("scripts + local idempotency", () => {
  it("lists scripts by workspace scope: undefined=independent, specific=workspace", async () => {
    const ws = await createShortDramaWorkspaceLocal({ title: "w" });
    await saveShortDramaScriptLocal(scriptRecord());
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "s-ws", workspaceId: ws.workspaceId }));
    expect((await listShortDramaScriptsLocal(undefined)).map((s) => s.scriptId)).toEqual(["s-1"]);
    expect((await listShortDramaScriptsLocal(ws.workspaceId)).map((s) => s.scriptId)).toEqual(["s-ws"]);
  });

  it("finds an existing script by local key within the same scope", async () => {
    await saveShortDramaScriptLocal(scriptRecord());
    const found = await findShortDramaScriptByLocalKey(undefined, "lk-1");
    expect(found?.scriptId).toBe("s-1");
    // 不同 localKey 不命中
    expect(await findShortDramaScriptByLocalKey(undefined, "lk-other")).toBeUndefined();
    // 不同创作台作用域不命中
    const ws = await createShortDramaWorkspaceLocal({ title: "w" });
    expect(await findShortDramaScriptByLocalKey(ws.workspaceId, "lk-1")).toBeUndefined();
  });

  it("computeLocalKey is deterministic and distinguishes material sets", async () => {
    const a = await computeShortDramaLocalKey({ workspaceId: "w", idea: IDEA_FOR_KEY, durationMode: "fixed", targetDurationSeconds: 30, materialRefs: [{ materialId: "m1", description: "白鹤", subjectTag: "Subject 1" }] });
    const b = await computeShortDramaLocalKey({ workspaceId: "w", idea: IDEA_FOR_KEY, durationMode: "fixed", targetDurationSeconds: 30, materialRefs: [{ materialId: "m1", description: "白鹤", subjectTag: "Subject 1" }] });
    const c = await computeShortDramaLocalKey({ workspaceId: "w", idea: IDEA_FOR_KEY, durationMode: "fixed", targetDurationSeconds: 30, materialRefs: [{ materialId: "m1", description: "白鹤", subjectTag: "Subject 1" }, { materialId: "m2", description: "剑冢", subjectTag: "Subject 2" }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("collects recent ideas for跨作品反同质 avoidMotifs", async () => {
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "r1", idea: "idea-one" }));
    await saveShortDramaScriptLocal(scriptRecord({ scriptId: "r2", idea: "idea-two" }));
    const ideas = await listShortDramaRecentIdeas();
    expect(ideas).toEqual(expect.arrayContaining(["idea-one", "idea-two"]));
  });
});

const IDEA_FOR_KEY = "深夜便利店店员发现顾客买走商品首字拼成警告";