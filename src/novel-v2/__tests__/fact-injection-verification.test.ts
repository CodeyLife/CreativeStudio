import { describe, expect, it } from "vitest";
import { buildFactRetrievalPlan, capDirectionPinnedClaims, MAX_DIRECTION_ENTITIES, MAX_DIRECTION_PINNED_TOTAL, mergeEntitiesByHeadSuffix } from "../fact-retrieval";
import { classifyFactRisk, isExclusiveValueSlotPredicate } from "../fact-extraction/classify";
import { factValueHash } from "../fact-extraction/fingerprint";
import { buildMemoryBundle, createPreflightPlan } from "../cognition";
import { buildChapterDraftPromptPackage } from "../prompts/chapter-draft";
import type { FactExtractionOutput } from "../prompts/schemas";
import type { MemoryHit, NovelIntent } from "../protocol";

/**
 * 方向驱动事实检索 + 确定性事实矛盾核验（improvement-plan-fact-injection-20260922 迭代 1/2）。
 *
 * 命中面取自真实病章形态（020 账册日期 / 021 交易条款 / 024 玉牌归属——
 * 同 subject|predicate 槽位被草稿改写为异值），反例面为合法状态演化与
 * 事件累积型谓词（同槽多值合法），双向覆盖。
 */

type Fact = FactExtractionOutput["facts"][number];

function fact(over: Partial<Fact> & { subjectId: string; predicate: string; value: string }): Fact {
  return {
    subject: { kind: "entity", id: over.subjectId },
    predicate: over.predicate,
    object: { kind: "string", value: over.value },
    polarity: "affirmed",
    truthStatus: "objective",
    humanReadable: over.humanReadable ?? `${over.subjectId}${over.predicate}${over.value}`,
    evidence: "证据句。",
    confidence: over.confidence ?? 0.95,
    novelty: over.novelty ?? "new",
    conflict: over.conflict ?? false,
  } as Fact;
}

function hit(over: Partial<MemoryHit> & { id: string; content: string }): MemoryHit {
  return {
    projectId: "p1", kind: "episodic", title: over.content.slice(0, 20),
    subjectRefs: ["hero"], knowledgeScope: "author", authority: "approved",
    confidence: 0.9, sourceRevisionIds: [], contentHash: `h-${over.id}`, supersedes: [],
    score: 1, matchedFacet: "fact", reason: "postgres lexical match:fact", ...over,
  } as MemoryHit;
}

describe("迭代 1：fact retrieval plan（方向派生 + 限域护栏）", () => {
  it("从蓝图场景参与者派生实体 facet，中心语后置归并（下品灵石→灵石）", () => {
    const plan = buildFactRetrievalPlan({
      chapterBlueprint: { scenes: [
        { participants: ["陈默", "掌柜"], situation: "", observableActions: [], outcome: "" },
        { participants: ["下品灵石", "陈默"], situation: "", observableActions: [], outcome: "" },
      ] } as never,
    });
    const queries = plan.facets.map((facet) => facet.query);
    expect(queries).toContain("陈默");
    expect(queries).toContain("掌柜");
    // "下品灵石" 与无其他以"灵石"结尾的形态并存时各自成组；同组取最短形态。
    expect(plan.facets.every((facet) => facet.kind === "fact" && facet.required)).toBe(true);
    expect(plan.enhancementWarnings).toEqual([]);
  });

  it("mergeEntitiesByHeadSuffix：同尾 2 字归并取最短形态，不同尾字不归并", () => {
    expect(mergeEntitiesByHeadSuffix(["下品灵石", "上品灵石", "灵石"])).toEqual(["灵石"]);
    expect(mergeEntitiesByHeadSuffix(["阅字玉牌", "令牌"])).toEqual(["阅字玉牌", "令牌"]);
    expect(mergeEntitiesByHeadSuffix(["", "  ", "陈默"])).toEqual(["陈默"]);
  });

  it("实体数超上限时截断并记 enhancementWarnings（pinned 超预算硬失败的护栏）", () => {
    const participants = Array.from({ length: MAX_DIRECTION_ENTITIES + 5 }, (_, index) => `人物${index}`);
    const plan = buildFactRetrievalPlan({
      chapterBlueprint: { scenes: [{ participants, situation: "", observableActions: [], outcome: "" }] } as never,
    });
    expect(plan.facets).toHaveLength(MAX_DIRECTION_ENTITIES);
    expect(plan.enhancementWarnings[0]).toContain("超上限");
  });

  it("线程引用派生为 thread facet 且不设 required（缺席不触发 required-facet 硬失败）", () => {
    const plan = buildFactRetrievalPlan({
      chapterBlueprint: { scenes: [] } as never,
      threadResponsibilities: [{ threadRef: "账册线" }, { threadRef: "玉牌线" }],
    });
    expect(plan.facets).toEqual([
      { kind: "thread", query: "账册线", required: false },
      { kind: "thread", query: "玉牌线", required: false },
    ]);
  });

  it("capDirectionPinnedClaims：按 score 降序封顶并打 direction-pinned 审计标记", () => {
    const hits = Array.from({ length: MAX_DIRECTION_PINNED_TOTAL + 3 }, (_, index) => hit({ id: `h${index}`, content: `事实${index}`, score: index }));
    const capped = capDirectionPinnedClaims(hits);
    expect(capped).toHaveLength(MAX_DIRECTION_PINNED_TOTAL);
    expect(capped.every((item) => item.reason === "direction-pinned")).toBe(true);
    expect(capped.map((item) => item.score)).toEqual([...capped.map((item) => item.score)].sort((a, b) => b - a));
    expect(capped.some((item) => item.id === "h2")).toBe(false); // 最低分 3 条被截断
  });
});

describe("迭代 2：确定性事实矛盾核验（classify 层，零模型调用）", () => {
  const frozenFact = fact({ subjectId: "陈默", predicate: "持有", value: "月例丹药按内门杂役份例" });
  const frozenHash = factValueHash(frozenFact);
  const frozenIndex = new Map([["陈默|持有", ["claim-frozen-1"]]]);
  const frozenHashes = new Map([["claim-frozen-1", frozenHash]]);

  it("021 形态：LLM 把改写声明成 novelty=new，同槽异值 → 强制 high risk + candidate", () => {
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "陈默", predicate: "持有", value: "月供减半折丹药" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: frozenIndex,
      existingValueHashById: frozenHashes,
    });
    expect(classified.risk).toBe("high");
    expect(classified.claim.authority).toBe("candidate");
    expect(classified.riskReason).toContain("确定性矛盾核验");
    expect(classified.factContradiction?.frozenClaimIds).toEqual(["claim-frozen-1"]);
  });

  it("反例：合法状态演化（novelty=update 值槽）填充 supersedes，不报矛盾", () => {
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "陈默", predicate: "持有", value: "月供减半折丹药", novelty: "update" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: frozenIndex,
      existingValueHashById: frozenHashes,
    });
    expect(classified.claim.supersedes).toEqual(["claim-frozen-1"]);
    expect(classified.factContradiction).toBeUndefined();
    expect(classified.risk).toBe("medium");
  });

  it("反例：同值重复（取值指纹相同）不报矛盾", () => {
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "陈默", predicate: "持有", value: "月例丹药按内门杂役份例" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: frozenIndex,
      existingValueHashById: frozenHashes,
    });
    expect(classified.factContradiction).toBeUndefined();
  });

  it("反例：事件累积型谓词（状态变化）同槽多值合法，不报矛盾", () => {
    expect(isExclusiveValueSlotPredicate("状态变化")).toBe(false);
    const eventIndex = new Map([["陈默|状态变化", ["claim-event-1"]]]);
    const eventHashes = new Map([["claim-event-1", "some-other-value-hash"]]);
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "陈默", predicate: "状态变化", value: "灵石欠项缴清" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: eventIndex,
      existingValueHashById: eventHashes,
    });
    expect(classified.factContradiction).toBeUndefined();
  });

  it("反例：冻结取值未知（其他管道写入，value_hash 缺失）保持沉默", () => {
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "陈默", predicate: "持有", value: "月供减半折丹药" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: frozenIndex,
      existingValueHashById: new Map([["claim-frozen-1", undefined]]),
    });
    expect(classified.factContradiction).toBeUndefined();
  });

  it("反例：冻结表无此键 → 正常新登记，不报矛盾", () => {
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "新实体", predicate: "持有", value: "青玉丹" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: frozenIndex,
      existingValueHashById: frozenHashes,
    });
    expect(classified.risk).toBe("low");
    expect(classified.claim.authority).toBe("derived");
    expect(classified.factContradiction).toBeUndefined();
  });

  it("024 形态：玉牌归属（持有槽）被改写为异值 → 确定性命中", () => {
    const jadeFrozen = fact({ subjectId: "阅字玉牌", predicate: "持有", value: "戒律堂偏殿执事" });
    const classified = classifyFactRisk({
      fact: fact({ subjectId: "阅字玉牌", predicate: "持有", value: "主角本人" }),
      projectId: "p1", artifactId: "a1", baseRevision: 0,
      existingClaimIndex: new Map([["阅字玉牌|持有", ["claim-jade"]]]),
      existingValueHashById: new Map([["claim-jade", factValueHash(jadeFrozen)]]),
    });
    expect(classified.claim.authority).toBe("candidate");
    expect(classified.factContradiction?.frozenClaimIds).toEqual(["claim-jade"]);
  });
});

describe("迭代 1：buildMemoryBundle 方向强注装配", () => {
  const intent: NovelIntent = { id: "intent-dir", projectId: "p1", source: "web", objective: "续写第 12 章", target: { kind: "chapter", id: "doc-12", order: 12 }, requestedStage: "drafting", createdAt: 1, idempotencyKey: "dir-1" };
  const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 11, targetDocumentId: "doc-12", targetDocumentOrder: 12 });

  const directionClaim = (id: string, score: number): MemoryHit => hit({
    id, content: `方向冻结断言 ${id}`, score,
    title: `冻结断言 ${id}`,
    identityHash: `slot-${id}`, valueHash: `v-${id}`,
  });

  it("低分方向断言 pinned 在场，高分 ranked-fill 候选被预算淘汰", async () => {
    const rankedFillClaims = Array.from({ length: 6 }, (_, index) => hit({ id: `fill-${index}`, content: `背景噪声 ${index} 很长很长很长很长很长`, score: 10 }));
    const provider = { search: async () => rankedFillClaims };
    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider, tokenBudget: 100, pinnedClaims: [directionClaim("dir-low", 0.1)] });
    expect(bundle.claims.some((claim) => claim.id === "dir-low")).toBe(true);
    expect(bundle.claims.filter((claim) => claim.id.startsWith("fill-")).length).toBeLessThan(6);
    const pinnedReceipt = (bundle.selectionReceipts ?? []).find((receipt) => receipt.claimId === "dir-low" && receipt.status === "included");
    expect(pinnedReceipt?.reason).toBe("pinned-narrative");
  });

  it("pinned 超预算硬失败，不静默丢弃方向断言", async () => {
    const provider = { search: async () => [] };
    await expect(buildMemoryBundle(plan, { projectId: "p1", provider, tokenBudget: 1, pinnedClaims: [directionClaim("dir-huge", 1)] })).rejects.toThrow(/冻结叙事上下文超过记忆预算/);
  });
});

describe("迭代 1：draft prompt 方向冻结事实分轨", () => {
  const directionHit = hit({ id: "dir-1", content: "陈默持有的月例丹药按内门杂役份例供给。", reason: "direction-pinned", title: "月例条款" });
  const normalHit = hit({ id: "fill-1", content: "普通背景事实。", score: 5 });

  it("direction-pinned claim 单独成段并带对照指令，不与普通冻结事实混列", () => {
    const pkg = buildChapterDraftPromptPackage({
      intent: { id: "intent-1", projectId: "p", source: "web", objective: "完成章节", createdAt: 1, idempotencyKey: "k" },
      blueprint: { id: "blueprint-1", baseRevision: 0, commitPolicy: "human-only", tasks: [], budget: { maxInputTokens: 100000, maxOutputTokens: 1000 } } as never,
      memory: {
        id: "memory-1", projectId: "p", preflightId: "pre-1",
        claims: [directionHit, normalHit],
        conflicts: [], missingFacets: [], tokenBudget: 100000, sourceRevisionIds: [], narrativeCutoff: 11,
        selectionReceipts: [
          { claimId: "dir-1", matchedFacets: ["fact"], score: 1, authority: "approved", tokenCost: 10, status: "included", reason: "pinned-narrative" },
          { claimId: "fill-1", matchedFacets: ["fact"], score: 5, authority: "approved", tokenCost: 10, status: "included", reason: "ranked-fill" },
        ],
        fingerprint: "fp", createdAt: 1,
      } as never,
      skills: { id: "skills-1", skills: [], resolution: { bundleId: "skills-1", fingerprint: "skills", executionPoint: "chapter.drafting", skills: [] } } as never,
      workflowId: "workflow-1",
      system: "系统",
    });
    const directionSection = pkg.sections.find((section) => section.id === "direction-frozen-facts");
    expect(directionSection).toBeDefined();
    expect(directionSection!.priority).toBe("required");
    expect(directionSection!.text).toContain("不得改写其数值、归属、时间或既定状态");
    expect(directionSection!.text).toContain("月例丹药按内门杂役份例");
    // 普通冻结事实段不再重复方向段内容（分轨不重复注入）。
    const genericSections = pkg.sections.filter((section) => section.id.startsWith("memory:"));
    expect(genericSections.some((section) => section.text.includes("月例丹药按内门杂役份例"))).toBe(false);
    expect(genericSections.some((section) => section.text.includes("普通背景事实"))).toBe(true);
  });

  it("无方向命中时不产出空段（安静章零强注）", () => {
    const pkg = buildChapterDraftPromptPackage({
      intent: { id: "intent-1", projectId: "p", source: "web", objective: "完成章节", createdAt: 1, idempotencyKey: "k" },
      blueprint: { id: "blueprint-1", baseRevision: 0, commitPolicy: "human-only", tasks: [], budget: { maxInputTokens: 100000, maxOutputTokens: 1000 } } as never,
      memory: { id: "memory-1", projectId: "p", preflightId: "pre-1", claims: [normalHit], conflicts: [], missingFacets: [], tokenBudget: 100000, sourceRevisionIds: [], narrativeCutoff: 11, fingerprint: "fp", createdAt: 1 } as never,
      skills: { id: "skills-1", skills: [], resolution: { bundleId: "skills-1", fingerprint: "skills", executionPoint: "chapter.drafting", skills: [] } } as never,
      workflowId: "workflow-1",
      system: "系统",
    });
    expect(pkg.sections.some((section) => section.id === "direction-frozen-facts")).toBe(false);
  });
});
