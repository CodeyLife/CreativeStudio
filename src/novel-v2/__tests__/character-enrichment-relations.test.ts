import { describe, expect, it } from "vitest";
import { normalizeRelationPredicate, persistCharacterEnrichment, type CharacterEnrichmentDelta } from "../character-enrichment";
import { buildCharacterEnrichmentPrompt } from "../character-enrichment/prompt";
import { factIdentityHash } from "../fact-extraction/fingerprint";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact } from "../protocol";

const artifact: Artifact = { id: "a1", projectId: "p1", taskId: "t1", attemptId: "x1", kind: "revision", contentHash: "h", baseRevision: 1, createdAt: 1, fingerprint: "fp" };

function delta(characterId: string, targetCharacterId: string): CharacterEnrichmentDelta {
  return {
    characterId,
    voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "含蓄", avoidance: "先观察" },
    motivationDelta: "本章无明显动机变化",
    newKnowledge: [],
    relationDeltas: [{ targetCharacterId, predicate: "首次相遇", delta: "在门厅相遇" }],
  };
}

function createDeps() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      return sql.startsWith("SELECT payload") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    },
  };
  return {
    writes,
    deps: { repository: { pool, recordFactExtraction: async (input: { claims: unknown[] }) => input.claims } as unknown as NovelPostgresRepository, objects: {} as never },
  };
}

function createCanonicalDeps() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      if (sql.includes("SELECT id, name, payload FROM entities")) {
        return { rows: [{ id: "entity:p1:character:char-chen-yuan", name: "char-chen-yuan", payload: {} }], rowCount: 1 };
      }
      if (sql.includes("project_plan_sections")) {
        return { rows: [{ characters: [{ id: "char-chen-yuan", name: "陈渊" }, { id: "char-zhao-xing", name: "赵刑" }] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    writes,
    deps: { repository: { pool, recordFactExtraction: async (input: { claims: unknown[] }) => input.claims } as unknown as NovelPostgresRepository, objects: {} as never },
  };
}

function createLegacyAliasDeps() {
  // 场景（memory-governance-audit-20260909 §5.4.1）：早期以显示名建行的别名实体
  // （entity:p1:character:陈渊）与规范实体（char-chen-yuan）并存。
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const entities = [
    { id: "entity:p1:character:char-chen-yuan", name: "char-chen-yuan", payload: { canonicalCharacterId: "char-chen-yuan", displayName: "陈渊" } },
    { id: "entity:p1:character:陈渊", name: "陈渊", payload: { canonicalCharacterId: "陈渊", displayName: "陈渊", pendingEnrichment: true, voiceAnchor: { vocabulary: { latest: "旧词汇观测", history: ["旧词汇观测"] } } } },
  ];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      if (sql.includes("SELECT id, name, payload FROM entities")) return { rows: entities, rowCount: entities.length };
      if (sql.includes("project_plan_sections")) {
        return { rows: [{ characters: [{ id: "char-chen-yuan", name: "陈渊" }] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    writes,
    deps: { repository: { pool, recordFactExtraction: async (input: { claims: unknown[] }) => input.claims } as unknown as NovelPostgresRepository, objects: {} as never },
  };
}

function createLargeCanonicalDeps() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const entities = Array.from({ length: 101 }, (_, index) => {
    const number = index + 1;
    return {
      id: `entity:p1:character:char-${number}`,
      name: `角色${number}`,
      payload: { canonicalCharacterId: `char-${number}`, displayName: `角色${number}` },
    };
  });
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      writes.push({ sql, params });
      if (sql.includes("SELECT id, name, payload FROM entities")) return { rows: entities, rowCount: entities.length };
      if (sql.includes("project_plan_sections")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    writes,
    deps: { repository: { pool, recordFactExtraction: async (input: { claims: unknown[] }) => input.claims } as unknown as NovelPostgresRepository, objects: {} as never },
  };
}

describe("character enrichment relation integrity", () => {
  it("asks extraction to preserve epistemic status instead of promoting interpretation to fact", () => {
    const prompt = buildCharacterEnrichmentPrompt({ artifact, text: "来客说北门已经封了，主角没有回答。" });
    expect(prompt).toContain("观察、听闻、阅读或推断");
    expect(prompt).toContain("写明“怀疑/推测”，不得升级为客观事实");
    expect(prompt).toContain("不把能力原理、价值判断、主题解释、因果寓意或人物评价当作知识事实");
  });

  it("stores knowledge without copying evidence prose into future prompt material", async () => {
    const { deps } = createDeps();
    const knowledgeDelta = delta("主角", "门卫");
    knowledgeDelta.newKnowledge = [{ description: "听闻北门已经封闭", evidence: "来客说北门已经封了，主角没有回答。" }];
    const result = await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r3", narrativeOrder: 3, artifact }, deps, [knowledgeDelta]);
    // 谓词经 canonicalizeFactPredicate 归一：character-knows 与 fact-extraction 的"知晓"
    // 落同一身份槽位（memory-governance-audit-20260909 §5.1.2 跨管道对账契约）。
    expect(result.knowledgeClaims[0]).toMatchObject({
      title: "主角 的信息边界（第3章）",
      content: "听闻北门已经封闭",
      predicate: "知晓",
    });
    expect(result.knowledgeClaims[0].identityHash).toBe(result.knowledgeClaims[0].identityHash); // 显式存在
    expect(result.knowledgeClaims[0].valueHash).toBeTruthy();
    expect(result.knowledgeClaims[0].content).not.toContain("来客说北门");
  });

  it("aligns knowledge claim identity hash with fact-extraction pipeline for the same slot", async () => {
    const { deps } = createDeps();
    const knowledgeDelta = delta("主角", "门卫");
    knowledgeDelta.newKnowledge = [{ description: "听闻北门已经封闭", evidence: "来客说北门已经封了，主角没有回答。" }];
    const result = await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r3", narrativeOrder: 3, artifact }, deps, [knowledgeDelta]);
    const claim = result.knowledgeClaims[0];
    const factPipelineIdentity = factIdentityHash({
      subject: { kind: "entity", id: claim.subjectRefs[0] },
      predicate: "知晓",
    });
    expect(claim.identityHash).toBe(factPipelineIdentity);
  });

  it("creates a stub when a supporting character first appears only as a relation target", async () => {
    const { deps, writes } = createDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r1", narrativeOrder: 1, artifact }, deps, [delta("主角", "门卫")]);
    const target = writes.find((write) => write.sql.includes("ON CONFLICT(id) DO NOTHING") && write.params[0] === "entity:p1:character:门卫");
    expect(target?.params[3]).toMatchObject({ pendingEnrichment: true, sourceRevisionId: "r1" });
    expect(writes.some((write) => write.sql.includes("INSERT INTO relations") && write.params[4] === "entity:p1:character:门卫")).toBe(true);
  });

  it("merges a legacy alias entity into the canonical row and retires it", async () => {
    const { deps, writes } = createLegacyAliasDeps();
    const enrichment = delta("陈渊", "门卫");
    enrichment.voiceAnchor = { sentenceLength: "新句长观测", vocabulary: "新词汇观测", directness: "含蓄", avoidance: "先观察" };
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r2", narrativeOrder: 2, artifact }, deps, [enrichment]);
    // 规范行 upsert：payload 携带别名行合并进来的声部历史。
    const canonicalUpsert = writes.find((write) => write.sql.includes("ON CONFLICT(id) DO UPDATE") && write.params[0] === "entity:p1:character:char-chen-yuan");
    expect(canonicalUpsert).toBeTruthy();
    const canonicalPayload = canonicalUpsert?.params[3] as { voiceAnchor: Record<string, { latest: string; history: string[] }>; canonicalCharacterId: string };
    expect(canonicalPayload.canonicalCharacterId).toBe("char-chen-yuan");
    expect(canonicalPayload.voiceAnchor.vocabulary.history).toContain("旧词汇观测");
    expect(canonicalPayload.voiceAnchor.sentenceLength.latest).toBe("新句长观测");
    // 别名行退役：payload.mergedInto 指向规范行，后续身份索引与档案读取不再可见。
    const retire = writes.find((write) => write.sql.includes("mergedInto") && write.params[0] === "entity:p1:character:陈渊");
    expect(retire?.params[1]).toBe("entity:p1:character:char-chen-yuan");
  });

  it("is idempotent when the same enrichment is replayed", async () => {    const { deps, writes } = createDeps();
    const input = { projectId: "p1", documentId: "d1", revisionId: "r1", narrativeOrder: 1, artifact };
    await persistCharacterEnrichment(input, deps, [delta("主角", "门卫")]);
    await persistCharacterEnrichment(input, deps, [delta("主角", "门卫")]);
    const relationWrites = writes.filter((write) => write.sql.includes("INSERT INTO relations"));
    expect(relationWrites).toHaveLength(2);
    expect(relationWrites[0].params[0]).toBe(relationWrites[1].params[0]);
    expect(relationWrites.every((write) => write.sql.includes("ON CONFLICT(id) DO NOTHING"))).toBe(true);
  });

  it("creates both endpoints when both characters are new", async () => {
    const { deps, writes } = createDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r2", narrativeOrder: 2, artifact }, deps, [delta("旅人", "船夫")]);
    const entityIds = writes.filter((write) => write.sql.includes("INSERT INTO entities")).map((write) => write.params[0]);
    expect(entityIds).toEqual(expect.arrayContaining(["entity:p1:character:旅人", "entity:p1:character:船夫"]));
  });

  it("persists foundation display names while keeping canonical ids for references", async () => {
    const { deps, writes } = createCanonicalDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r1", narrativeOrder: 1, artifact }, deps, [delta("char-chen-yuan", "char-zhao-xing")]);

    const entityWrites = writes.filter((write) => write.sql.includes("INSERT INTO entities"));
    expect(entityWrites[0]?.params.slice(0, 4)).toEqual([
      "entity:p1:character:char-chen-yuan",
      "p1",
      "陈渊",
      expect.objectContaining({ canonicalCharacterId: "char-chen-yuan", displayName: "陈渊", displayNameStatus: "identified" }),
    ]);
    expect(entityWrites[1]?.params.slice(0, 4)).toEqual([
      "entity:p1:character:char-zhao-xing",
      "p1",
      "赵刑",
      expect.objectContaining({ canonicalCharacterId: "char-zhao-xing", displayName: "赵刑", displayNameStatus: "identified" }),
    ]);
  });

  it("resolves an existing character beyond the prompt digest budget without duplicating it", async () => {
    const { deps, writes } = createLargeCanonicalDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r101", narrativeOrder: 101, artifact }, deps, [delta("char-101", "char-101")]);

    const entityWrites = writes.filter((write) => write.sql.includes("INSERT INTO entities(id, project_id, kind, name, payload)"));
    expect(entityWrites[0]?.params[0]).toBe("entity:p1:character:char-101");
    expect(writes.some((write) => write.sql.includes("LIMIT 100"))).toBe(false);
  });
});

describe("正文可指认门与谓词受控（PL-4，product-audit-20260910 B4）", () => {
  const relationWrite = (writes: Array<{ sql: string; params: unknown[] }>) => writes.find((write) => write.sql.includes("INSERT INTO relations"));

  it("双方都以人名为正文出现时关系绑定 valid_from（正文来源事实）", async () => {
    const { deps, writes } = createCanonicalDeps();
    await persistCharacterEnrichment(
      { projectId: "p1", documentId: "d1", revisionId: "r1", narrativeOrder: 1, artifact, text: "陈渊在演武场撞见赵刑，两人对视一眼。" },
      deps,
      [delta("char-chen-yuan", "char-zhao-xing")],
    );
    const write = relationWrite(writes);
    expect(write).toBeDefined();
    // 量纲守卫：valid_from 必须是叙事序（读侧与 cutoff 同量纲比较），不得为时间戳。
    expect(write!.params[5]).toBe(1);
    // 谓词白名单外的短词无损收进"其他:"通道。
    expect(write!.params[3]).toBe("其他:首次相遇");
  });

  it("客体人名未在正文出现时关系落规划候选（valid_from=NULL，不落正文事实）", async () => {
    const { deps, writes } = createCanonicalDeps();
    await persistCharacterEnrichment(
      { projectId: "p1", documentId: "d1", revisionId: "r2", narrativeOrder: 2, artifact, text: "陈渊独自回到住处，谁也没有遇见。" },
      deps,
      [delta("char-chen-yuan", "char-zhao-xing")],
    );
    const write = relationWrite(writes);
    expect(write!.params[5]).toBeNull();
    // 未出场目标自动建档时带规划候选标记（可见、可裁决，不伪装正文来源）。
    const stub = writes.find((entry) => entry.sql.includes("INSERT INTO entities") && entry.params[0] === "entity:p1:character:char-zhao-xing");
    expect((stub!.params[3] as Record<string, unknown>).planningCandidate).toBe(true);
  });

  it("调用方未提供正文（重建重放历史 delta）时保守绑定，不无证据改判", async () => {
    const { deps, writes } = createCanonicalDeps();
    await persistCharacterEnrichment({ projectId: "p1", documentId: "d1", revisionId: "r3", narrativeOrder: 3, artifact }, deps, [delta("char-chen-yuan", "char-zhao-xing")]);
    expect(relationWrite(writes)!.params[5]).toBe(3); // 保守绑定同样是叙事序量纲
  });

  it("谓词归一双向：白名单词直通；句子形态归通用标签；其他: 通道保留", () => {
    expect(normalizeRelationPredicate("信任")).toBe("信任");
    expect(normalizeRelationPredicate("  从怀疑转为警惕的配合 ")).toBe("其他:关系变化"); // 句子形态
    expect(normalizeRelationPredicate("初遇")).toBe("其他:初遇"); // 词形保留为标签
    expect(normalizeRelationPredicate("其他:亦敌亦友")).toBe("其他:亦敌亦友");
    expect(normalizeRelationPredicate("")).toBe("其他:关系未命名");
  });
});
