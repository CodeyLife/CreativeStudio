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
    expect(prompt).toContain("顶层必须始终输出 facts、narrativeElements、payoffMoments");
    expect(prompt).toContain("chapterMemory 和 characterDeltas 不属于本次输出");
    expect(chapterStateDeltaSchema.required).toEqual(["facts", "narrativeElements", "payoffMoments"]);
  });

  it("binds chapter facts to narrativeOrder instead of the evidence paragraph", () => {
    const output: ChapterStateDelta = { facts: [fact()] };
    const result = projectFactExtractionOutput({ projectId: "p1", artifact, text: "正文略。", narrativeOrder: 12 }, output);

    expect(result.claims[0].narrativeRange).toEqual({ start: 12, end: 12 });
  });

  it("rejects invalid chapter orders at the shared scoping boundary", () => {
    const claim = classifyFactRisk({ fact: fact(), projectId: "p1", artifactId: artifact.id, baseRevision: 1 }).claim;
    expect(() => scopeClaimsToChapter([claim], 0)).toThrow(/narrativeOrder/);
    expect(() => scopeClaimsToChapter([claim], 1.5)).toThrow(/narrativeOrder/);
  });

  it("returns narrative elements and payoff moments from the same extraction", async () => {
    const output: ChapterStateDelta = {
      facts: [fact()],
      narrativeElements: {
        foreshadowings: [],
        promises: [],
        payoffs: [],
      },
      payoffMoments: [{ payoffType: "recognition", intensity: 2, description: "角色得到有限认可", setupDescription: "", evidence: "他终于听见对方承认自己的判断。" }],
    };
    const result = await extractFactsWithStats({ projectId: "p1", artifact, text: "正文略。", model: new InMemoryModelGateway(() => output) });
    expect(result.narrativeElements?.payoffs).toEqual([]);
    expect(result.payoffMoments?.[0].payoffType).toBe("recognition");
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
      payoffMoments: [],
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
    const model = new InMemoryModelGateway(() => ({ facts: [], narrativeElements: { foreshadowings: [], promises: [], payoffs: [] }, payoffMoments: [] }));
    const result = await extractFactsFromText({ projectId: "p1", artifact, text: "正文略。", model });
    expect(result).toEqual([] satisfies MemoryClaim[]);
  });

  it("rejects model output that fails schema validation", async () => {
    const model = new InMemoryModelGateway(() => ({ summary: "缺字段" }));
    await expect(extractFactsWithStats({ projectId: "p1", artifact, text: "x", model })).rejects.toThrow(/InMemoryModelGateway structured|facts/);
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
