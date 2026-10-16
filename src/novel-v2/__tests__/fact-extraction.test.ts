import { describe, expect, it } from "vitest";
import { classifyFactCandidates, classifyFactRisk } from "../fact-extraction/classify";
import {
  dedupeFactCandidates,
  evidenceFingerprint,
  factFingerprint,
  humanReadableFingerprint,
} from "../fact-extraction/dedupe";
import { extractFactsFromText, extractFactsWithStats, computeClaimContentHash, projectFactExtractionOutput } from "../fact-extraction";
import { scopeClaimsToChapter } from "../fact-extraction/narrative-scope";
import { InMemoryModelGateway } from "../model-gateway";
import type { Artifact, MemoryClaim } from "../protocol";
import { chapterStateDeltaSchema, type ChapterStateDelta, type FactExtractionOutput } from "../prompts/schemas";
import { canonicalizeFactPredicate, factIdentityHash, factValueHash } from "../fact-extraction/fingerprint";
import { buildFactExtractionPrompt } from "../fact-extraction/prompt";
import { buildCharacterIdentityIndex } from "../character-identity";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 7, createdAt: 1, fingerprint: "fp-1" };

function fact(overrides: Partial<FactExtractionOutput["facts"][number]> = {}): FactExtractionOutput["facts"][number] {
  return {
    subject: { kind: "entity", id: "hero" },
    predicate: "持有",
    object: { kind: "entity-ref", value: "sword-1" },
    polarity: "affirmed",
    truthStatus: "objective",
    humanReadable: "主角持有古剑承影",
    evidence: "他从匣中取出承影，剑身冷光一闪。",
    confidence: 0.9,
    novelty: "new",
    conflict: false,
    ...overrides,
  };
}

describe("fact-extraction dedupe fingerprints", () => {
  it("factFingerprint normalizes object values of any type", () => {
    const a = factFingerprint(fact({ object: { kind: "string", value: "x" } }));
    const b = factFingerprint(fact({ object: { kind: "string", value: "x" } }));
    expect(a).toBe(b);

    const c = factFingerprint(fact({ object: { kind: "json", value: { k: 1 } } }));
    expect(c).not.toBe(a);
    expect(c).toContain("json");
  });

  it("evidenceFingerprint strips punctuation and lowercases", () => {
    expect(evidenceFingerprint("他，从匣中。取出！")).toBe(evidenceFingerprint("他从匣中取出"));
    expect(evidenceFingerprint("Hello World")).toBe("helloworld");
  });

  it("humanReadableFingerprint truncates to 32 chars after normalization", () => {
    const long = "A".repeat(64);
    const fp = humanReadableFingerprint(long);
    expect(fp).toHaveLength(32);
    expect(fp).toBe(humanReadableFingerprint(`${long}更多内容`));
  });
});

describe("fact-extraction dedupeFactCandidates covers 11 failure classes", () => {
  it("drops low-confidence facts (L6)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ confidence: 0.4 })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedLowConfidenceCount).toBe(1);
  });

  it("drops facts with evidence shorter than 8 chars (L7)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ evidence: "短" })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedShortEvidenceCount).toBe(1);
  });

  it("drops facts with pronoun or empty subject id (L8)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ subject: { kind: "entity", id: "主角" } }), fact({ subject: { kind: "entity", id: "" } })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedInvalidSubjectCount).toBe(2);
  });

  it("drops facts with empty object value (L9)", () => {
    const result = dedupeFactCandidates({ candidates: [fact({ object: { kind: "string", value: "" } }), fact({ object: { kind: "string", value: null as unknown as string } })] });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedInvalidObjectCount).toBe(2);
  });

  it("drops duplicates by humanReadable fingerprint (L1)", () => {
    const a = fact({ humanReadable: "主角持有古剑承影" });
    const b = fact({ humanReadable: "主角 持有 古剑 承影！" });
    const result = dedupeFactCandidates({ candidates: [a, b] });
    expect(result.kept).toHaveLength(1);
    expect(result.discardedDuplicateCount).toBe(1);
  });

  it("drops duplicates by subject+predicate+object fingerprint (L2/L3)", () => {
    const a = fact({ humanReadable: "陈述一" });
    const b = fact({ humanReadable: "陈述二", evidence: "另外一段足够长的证据文本。" });
    const result = dedupeFactCandidates({ candidates: [a, b] });
    expect(result.kept).toHaveLength(1);
    expect(result.discardedDuplicateCount).toBe(1);
  });

  it("drops duplicates by evidence fingerprint (L4)", () => {
    const a = fact({ humanReadable: "陈述一" });
    const b = fact({ humanReadable: "陈述二", subject: { kind: "entity", id: "mentor" }, object: { kind: "string", value: "另一物" }, evidence: "他从匣中取出承影，剑身冷光一闪。" });
    const result = dedupeFactCandidates({ candidates: [a, b] });
    expect(result.kept).toHaveLength(1);
    expect(result.discardedDuplicateCount).toBe(1);
  });

  it("drops facts whose content hash already exists in the store (L11)", () => {
    const candidate = fact();
    const existingHash = factValueHash(candidate);
    const result = dedupeFactCandidates({ candidates: [candidate], existingContentHashes: new Set([existingHash]) });
    expect(result.kept).toHaveLength(0);
    expect(result.discardedExistingHashCount).toBe(1);
  });

  it("uses one canonical hash across paraphrases of the same structured fact", () => {
    const concise = fact({ humanReadable: "主角持有承影剑" });
    const descriptive = fact({ humanReadable: "承影古剑如今仍在主角手中" });
    expect(factIdentityHash(concise)).toBe(factIdentityHash(descriptive));
    expect(factValueHash(concise)).toBe(factValueHash(descriptive));
  });

  it("uses the preset predicate vocabulary across equivalent relation wording", () => {
    const held = fact({ predicate: "持有" });
    const owned = fact({ predicate: "拥有物品" });
    expect(canonicalizeFactPredicate("拥有物品")).toBe("持有");
    expect(factIdentityHash(held)).toBe(factIdentityHash(owned));
    expect(factValueHash(held)).toBe(factValueHash(owned));
  });

  it("keeps materially different values distinct after predicate normalization", () => {
    const sword = fact({ predicate: "持有", object: { kind: "entity-ref", value: "sword-1" } });
    const letter = fact({ predicate: "拥有", object: { kind: "entity-ref", value: "letter-1" } });
    expect(factValueHash(sword)).not.toBe(factValueHash(letter));
  });

  it("reports totalCandidates across mixed accept/discard outcomes", () => {
    const result = dedupeFactCandidates({
      candidates: [
        fact(),
        fact({ confidence: 0.3 }),
        fact({ humanReadable: "重复的陈述" }),
        fact({ humanReadable: "重复的陈述", evidence: "另外一段足够长的证据文本。" }),
      ],
    });
    expect(result.totalCandidates).toBe(4);
    expect(result.kept.length + result.discardedLowConfidenceCount + result.discardedDuplicateCount).toBe(4);
  });
});

describe("fact-extraction retention contract", () => {
  it("requires future continuity value and excludes consequence-free scene details", () => {
    const prompt = buildFactExtractionPrompt({ artifact, text: "她换了一件外衣，随后立誓守住城门。" });
    expect(prompt).toContain("后续章节");
    expect(prompt).toContain("持续状态");
    expect(prompt).toContain("一次性动作");
    expect(prompt).toContain("服饰");
    expect(prompt).toContain("承诺");
  });

  /**
   * subject.id 不得由多个词拼合而成（2026-10-14 复核轮 round 59）。
   *
   * 实测抓到的一例（生产库）：3 条 knowledge-scope claim 的 subject_refs 是
   * `灰衣杂役`，而正文里"灰衣"3 次、"杂役"335 次、"灰衣杂役"**0 次**
   * ——系统把两个分别出现的词拼成了一个小说里不存在的称呼。
   * 后果：检索会按这个假名字返回结果，且它进入召回面后污染后续所有召回。
   *
   * 根因：prompt 里已有"subject.id 必须是正文中可指认的对象"，
   * 但没说"必须是正文里作为**完整字符串**出现过的指称"。
   * 本锁钉住新加的这条约束，防止它被后续改动删掉。
   */
  it("禁止 subject.id 由多个词拼合而成（round 59 实测的系统造名）", () => {
    const prompt = buildFactExtractionPrompt({ artifact, text: "她换了一件外衣，随后立誓守住城门。" });
    expect(prompt, "必须禁止拼合 subject.id").toContain("不得由多个词拼合而成");
    expect(prompt, "必须要求完整字符串出现").toContain("完整字符串");
    // 原约束仍在（本条是新增强化，不是替换）。
    expect(prompt, "原有'可指认'约束必须保留").toContain("subject.id 必须是正文中可指认的对象");
  });

  it("offers exact open-element IDs while leaving unmatched payoffs unlinked", () => {
    const prompt = buildFactExtractionPrompt({
      artifact,
      text: "正文略。",
      openNarrativeElements: {
        foreshadowings: [{ id: "foreshadowing-1", description: "门上的刻痕", triggerKeywords: ["刻痕"], expectedPayoffWindow: "本卷末" }],
        promises: [{ id: "promise-1", promiser: "甲", promisee: "乙", statement: "会回来" }],
      },
    });
    expect(prompt).toContain("foreshadowing-1");
    expect(prompt).toContain("promise-1");
    expect(prompt).toContain("不要猜测");
  });
});

describe("fact-extraction classifyFactRisk maps to risk tiers", () => {
  it("marks conflict=true facts as high risk", () => {
    const { risk, riskReason, claim } = classifyFactRisk({ fact: fact({ conflict: true }), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("high");
    expect(riskReason).toContain("冲突");
    expect(claim.authority).toBe("candidate");
  });

  it("marks non-objective truthStatus as high risk", () => {
    const { risk } = classifyFactRisk({ fact: fact({ truthStatus: "claim" }), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("high");
  });

  it("marks novelty=update as medium risk", () => {
    const { risk, claim } = classifyFactRisk({ fact: fact({ novelty: "update", truthStatus: "objective" }), projectId: "p1", artifactId: artifact.id, baseRevision: 1, existingClaimIndex: new Map([["hero|持有", ["claim-old-location"]]]) });
    expect(risk).toBe("medium");
    expect(claim.authority).toBe("candidate");
    expect(claim.predicate).toBe("持有");
    expect(claim.supersedes).toEqual(["claim-old-location"]);
  });

  it("does not let an event-slot update sweep unrelated same-slot claims (FM-1)", () => {
    // 状态变化/知晓等事件累积谓词的同槽多行记录的是不同事件，单条 update 不得退役整槽。
    const { claim } = classifyFactRisk({ fact: fact({ predicate: "状态变化", novelty: "update", truthStatus: "objective", humanReadable: "主角当前状态：略宽于初开辟" }), projectId: "p1", artifactId: artifact.id, baseRevision: 1, existingClaimIndex: new Map([["hero|状态变化", ["claim-payoff", "claim-wound"]]]) });
    expect(claim.supersedes).toEqual([]);
  });

  it("keeps low-confidence continuity-changing facts as candidates", () => {
    const { risk, claim } = classifyFactRisk({ fact: fact({ predicate: "持有", confidence: 0.65 }), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("medium");
    expect(claim.authority).toBe("candidate");
  });

  it("does not escalate low-confidence descriptive details without continuity impact", () => {
    const { risk, claim } = classifyFactRisk({ fact: fact({ subject: { kind: "scene", id: "scene-1" }, predicate: "光线色调", confidence: 0.65 }), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("low");
    expect(claim.authority).toBe("derived");
  });

  it("marks objective affirmed new facts as low risk with derived authority", () => {
    const { risk, claim } = classifyFactRisk({ fact: fact(), projectId: "p1", artifactId: artifact.id, baseRevision: 1 });
    expect(risk).toBe("low");
    expect(claim.authority).toBe("derived");
  });

  it("classifies hierarchical memory when humanReadable matches longform patterns", () => {
    const { claim } = classifyFactRisk({
      fact: fact({ humanReadable: "主角与师父约定三年后归来" }),
      projectId: "p1",
      artifactId: artifact.id,
      baseRevision: 1,
    });
    expect(claim.kind).toBe("hierarchical");
  });

  it("classifies episodic memory for ordinary factual statements", () => {
    const { claim } = classifyFactRisk({
      fact: fact({ humanReadable: "主角走进客栈要了一壶酒" }),
      projectId: "p1",
      artifactId: artifact.id,
      baseRevision: 1,
    });
    expect(claim.kind).toBe("episodic");
  });

  it("classifyFactCandidates projects a stable MemoryClaim list", () => {
    const classified = classifyFactCandidates({
      facts: [fact(), fact({ subject: { kind: "entity", id: "mentor" }, humanReadable: "师父交还信物", evidence: "师父把玉佩放回桌上，未发一言。" })],
      projectId: "p1",
      artifactId: artifact.id,
      baseRevision: 1,
    });
    expect(classified).toHaveLength(2);
    expect(classified[0].claim.projectId).toBe("p1");
    expect(classified[0].claim.subjectRefs).toContain("hero");
    expect(classified[1].claim.subjectRefs).toContain("mentor");
  });
});

describe("fact-extraction extractFactsWithStats orchestration", () => {
  it("states the model output contract instead of leaving providers to infer it", () => {
    const prompt = buildFactExtractionPrompt({ artifact, text: "正文略。" });
    expect(prompt).toContain("顶层必须始终输出 facts 和 narrativeElements");
    expect(prompt).not.toContain("chapterMemory 和 characterDeltas");
    expect(chapterStateDeltaSchema.required).toEqual(["facts", "narrativeElements"]);
  });

  it("binds chapter facts to narrativeOrder instead of the evidence paragraph", () => {
    const output: ChapterStateDelta = { facts: [fact()], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] } };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", narrativeOrder: 12 }, output);

    expect(result.claims[0].narrativeRange).toEqual({ start: 12, end: 12 });
  });

  it("rejects invalid chapter orders at the shared scoping boundary", () => {
    const claim = classifyFactRisk({ fact: fact(), projectId: "p1", artifactId: artifact.id, baseRevision: 1 }).claim;
    expect(() => scopeClaimsToChapter([claim], 0)).toThrow(/narrativeOrder/);
    expect(() => scopeClaimsToChapter([claim], 1.5)).toThrow(/narrativeOrder/);
  });

  it("returns narrative elements from the same extraction", async () => {
    const output: ChapterStateDelta = {
      facts: [fact()],
      narrativeElements: {
        foreshadowings: [],
        promises: [],
        payoffs: [],
      },
    };
    const result = await extractFactsWithStats({ projectId: "p1", artifact, text: "正文略。", model: new InMemoryModelGateway(() => output) });
    expect(result.narrativeElements.payoffs).toEqual([]);
  });

  it("returns claims and stats end-to-end through the model gateway", async () => {
    const output: FactExtractionOutput = {
      facts: [
        fact(),
        fact({ subject: { kind: "entity", id: "mentor" }, humanReadable: "师父交还信物", evidence: "师父把玉佩放回桌上，未发一言。" }),
        fact({ confidence: 0.3 }), // 被 L6 丢弃
        fact({ humanReadable: "主角持有古剑承影" }), // 被 L1 丢弃
      ],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const model = new InMemoryModelGateway(() => output);
    const result = await extractFactsWithStats({
      projectId: "p1",
      artifact,
      text: "正文略。",
      model,
    });
    expect(result.claims).toHaveLength(2);
    expect(result.stats.totalCandidates).toBe(4);
    expect(result.stats.kept).toBe(2);
    expect(result.stats.discardedLowConfidence).toBe(1);
    expect(result.stats.discardedDuplicate).toBe(1);
  });

  it("returns an empty claim list when the model produces nothing", async () => {
    const model = new InMemoryModelGateway(() => ({ facts: [], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] } }));
    const result = await extractFactsFromText({ projectId: "p1", artifact, text: "正文略。", model });
    expect(result).toEqual([] satisfies MemoryClaim[]);
  });

  it("rejects model output that fails schema validation", async () => {
    const model = new InMemoryModelGateway(() => ({ summary: "缺字段" }));
    await expect(extractFactsWithStats({ projectId: "p1", artifact, text: "x", model })).rejects.toThrow(/InMemoryModelGateway structured|facts/);
  });

  it("rejects removed fact-extraction fields at the structured boundary", async () => {
    const model = new InMemoryModelGateway(() => ({
      facts: [],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
      payoffMoments: [],
      chapterMemory: { summary: "不应进入事实提取输出", keyEvents: [], characterStates: [], unresolvedThreads: [], emotionalArc: "无" },
    }));
    await expect(extractFactsWithStats({ projectId: "p1", artifact, text: "x", model })).rejects.toThrow(/InMemoryModelGateway structured|payoffMoments|additional/iu);
  });

  it("computeClaimContentHash is stable across calls with the same claim", () => {
    const claim: MemoryClaim = {
      id: "claim-1",
      projectId: "p1",
      kind: "episodic",
      title: "t",
      content: "c",
      subjectRefs: ["hero"],
      knowledgeScope: "author",
      authority: "derived",
      confidence: 0.9,
      sourceRevisionIds: [],
      contentHash: "x",
      supersedes: [],
    };
    expect(computeClaimContentHash(claim)).toBe(computeClaimContentHash(claim));
    expect(computeClaimContentHash({ ...claim, subjectRefs: ["mentor"] })).not.toBe(computeClaimContentHash(claim));
  });
});

describe("fact-extraction identity normalization (memory-governance-audit-20260909 §5.1.1)", () => {
  const identityIndex = buildCharacterIdentityIndex(
    "p1",
    [],
    [{ id: "char_hero", name: "主角" }, { id: "char_mentor", name: "师父" }],
  );

  it("rewrites subject ids that hit the registry alias map before hashing", () => {
    const output: ChapterStateDelta = {
      facts: [fact({ subject: { kind: "entity", id: "主角" }, humanReadable: "主角持有古剑承影" })],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", identityIndex }, output);
    expect(result.claims[0].subjectRefs).toEqual(["char_hero"]);
    // 归一发生在哈希之前：同一事实经规范 ID 提取时 identityHash 必须一致。
    const canonical = projectFactExtractionOutput(
      { projectId: "p1", artifact, text: "正文略。" },
      { facts: [fact({ subject: { kind: "entity", id: "char_hero" }, humanReadable: "主角持有古剑承影" })], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] } },
    );
    expect(result.claims[0].identityHash).toBe(canonical.claims[0].identityHash);
  });

  it("dedupes the same fact extracted with a display name and a canonical id in one batch", () => {
    const output: ChapterStateDelta = {
      facts: [
        fact({ subject: { kind: "entity", id: "主角" }, humanReadable: "主角持有古剑承影" }),
        fact({ subject: { kind: "entity", id: "char_hero" }, humanReadable: "主角持有古剑承影" }),
      ],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", identityIndex }, output);
    expect(result.claims).toHaveLength(1);
    expect(result.stats.discardedDuplicate).toBe(1);
  });

  it("keeps unknown subject keys untouched instead of inventing a third key form", () => {
    const output: ChapterStateDelta = {
      facts: [fact({ subject: { kind: "entity", id: "自造_ID" }, humanReadable: "陌生人物做了某事", evidence: "足够长的一段正文证据文本。" })],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", identityIndex }, output);
    expect(result.claims[0].subjectRefs).toEqual(["自造_ID"]);
  });

  it("resolves machine-id prefix variants of a registered key to the same identity slot", () => {
    // 实测根因（state-audit-20261013 §3.6）：主角两条互斥死因分属 `char_chu_heng` 与
    // `chu_heng` 两个槽，使矛盾核验与槽位时效重排双双看不见它们。
    const index = buildCharacterIdentityIndex("p1", [], [{ id: "char_chu_heng", name: "楚衡" }]);
    const prefixed = projectFactExtractionOutput(
      { projectId: "p1", artifact, text: "正文略。", identityIndex: index },
      { facts: [fact({ subject: { kind: "entity", id: "char_chu_heng" }, humanReadable: "楚衡身死" })], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] } },
    );
    const bare = projectFactExtractionOutput(
      { projectId: "p1", artifact, text: "正文略。", identityIndex: index },
      { facts: [fact({ subject: { kind: "entity", id: "chu_heng" }, humanReadable: "楚衡身死" })], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] } },
    );
    expect(bare.claims[0].subjectRefs).toEqual(["char_chu_heng"]);
    expect(bare.claims[0].identityHash).toBe(prefixed.claims[0].identityHash);
    // 归一后不再是"待登记主体"：键已可解析，登记它会凭空造出重复实体。
    expect(bare.unregisteredSubjects).toEqual([]);
  });

  it("normalizes separator and case variants of a registered key", () => {
    const index = buildCharacterIdentityIndex("p1", [], [{ id: "char_qi_xing_ren", name: "齐姓人" }]);
    const result = projectFactExtractionOutput(
      { projectId: "p1", artifact, text: "正文略。", identityIndex: index },
      { facts: [fact({ subject: { kind: "entity", id: "Char-Qi_Xing-Ren" }, humanReadable: "齐姓人交付布袋" })], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] } },
    );
    expect(result.claims[0].subjectRefs).toEqual(["char_qi_xing_ren"]);
  });

  it("collects unregistered character subjects for pending registration", () => {
    const output: ChapterStateDelta = {
      facts: [
        fact({ subject: { kind: "character", id: "送草的孩子" }, humanReadable: "送草的孩子放下草料" }),
        fact({ subject: { kind: "character", id: "送草的孩子" }, humanReadable: "送草的孩子转身离开", evidence: "他放下草料便转身出了院子。" }),
      ],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", identityIndex }, output);
    expect(result.unregisteredSubjects).toEqual([{ id: "送草的孩子", kind: "character" }]);
  });

  it("does not register non-character subjects (places and objects stay out of the roster)", () => {
    // 地点/物件用 entity/scene：登记它们会把"补发房""玉牌"混进角色名册与知识工作台。
    const output: ChapterStateDelta = {
      facts: [
        fact({ subject: { kind: "entity", id: "补发房" }, humanReadable: "补发房在功德司西跨院" }),
        fact({ subject: { kind: "scene", id: "老槐树" }, humanReadable: "老槐树立在哨位旁" }),
        fact({ subject: { kind: "entity", id: "玉牌" }, humanReadable: "玉牌刻着阅字" }),
      ],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", identityIndex }, output);
    expect(result.unregisteredSubjects).toEqual([]);
  });

  it("folds the character discriminator out of the identity fingerprint", () => {
    // 判别位只服务登记决策：旧数据 entity、新数据 character 必须落进同一身份槽，
    // 否则"新增判别位"本身就会制造新的碎片化。
    const asCharacter = fact({ subject: { kind: "character", id: "char_chu_heng" } });
    const asEntity = fact({ subject: { kind: "entity", id: "char_chu_heng" } });
    expect(factIdentityHash(asCharacter)).toBe(factIdentityHash(asEntity));
  });

  it("does not collect non-entity subject kinds (own tables and key spaces)", () => {
    const output: ChapterStateDelta = {
      facts: [
        fact({ subject: { kind: "relation", id: "relation_chu_qi_deal" }, humanReadable: "楚齐两人立约" }),
        fact({ subject: { kind: "thread", id: "thread-1" }, humanReadable: "线索尚未收束" }),
      ],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", identityIndex }, output);
    expect(result.unregisteredSubjects).toEqual([]);
  });

  it("collects nothing when no identity index is provided (registry unavailable)", () => {
    const output: ChapterStateDelta = {
      facts: [fact({ subject: { kind: "character", id: "陌生人" }, humanReadable: "陌生人经过" })],
      narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。" }, output);
    expect(result.unregisteredSubjects).toEqual([]);
  });

  it("injects the canonical character roster into the prompt when provided", () => {
    const prompt = buildFactExtractionPrompt({
      artifact,
      text: "正文略。",
      canonicalCharacters: [{ canonicalId: "char_hero", displayName: "主角" }],
    });
    expect(prompt).toContain("规范人物名册");
    expect(prompt).toContain("char_hero｜显示名：主角");
    expect(prompt).toContain("禁止使用显示名、拼音转写或自造 ID");
  });

  it("teaches the character/entity discriminator so only people get registered", () => {
    const prompt = buildFactExtractionPrompt({ artifact, text: "正文略。" });
    expect(prompt).toContain("人物（有名有姓或有稳定指称的角色）一律用 character");
    expect(prompt).toContain("非人物可指认对象用 entity 或 scene");
  });

  it("omits the roster section when no canonical characters are provided", () => {
    const prompt = buildFactExtractionPrompt({ artifact, text: "正文略。" });
    expect(prompt).not.toContain("规范人物名册");
  });

  it("aligns character-knows with the 知晓 identity slot across pipelines", () => {
    expect(canonicalizeFactPredicate("character-knows")).toBe("知晓");
    const enrichmentFact = {
      subject: { kind: "entity" as const, id: "char_hero" },
      predicate: "character-knows",
    };
    const extractionFact = fact({ subject: { kind: "entity", id: "char_hero" }, predicate: "知晓" });
    expect(factIdentityHash(enrichmentFact)).toBe(factIdentityHash(extractionFact));
  });
});
