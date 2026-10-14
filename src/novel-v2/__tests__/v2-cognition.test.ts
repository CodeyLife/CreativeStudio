import { describe, expect, it } from "vitest";
import { buildContextManifest, buildMemoryBundle, compileExecutionBlueprint, createPreflightPlan, resolveSkillBundle } from "../cognition";
import type { MemoryProvider, NovelIntent, SkillProvider } from "../protocol";

const intent: NovelIntent = { id: "intent-1", projectId: "p1", source: "web", objective: "续写第 12 章，保持主角对秘密尚未知情", target: { kind: "chapter", id: "doc-12", order: 12 }, requestedStage: "drafting", createdAt: 1, idempotencyKey: "k1" };

/**
 * 构造同一身份槽位的一条取值断言。谓词、身份槽、叙事位置与权威等级是唯一变量，其余字段固定，
 * 使夹具形状本身不参与被测条件（同一夹具同时用于状态类与累积型，只切换 predicate）。
 */
function slotValueClaim(input: { id: string; predicate: string; identityHash: string; start?: number; authority: "approved" | "derived" }) {
  return {
    id: input.id,
    projectId: "p1",
    kind: "episodic" as const,
    title: `${input.predicate}取值`,
    content: `${input.predicate}在叙事位置 ${input.start ?? "未知"} 的取值`,
    subjectRefs: ["hero"],
    predicate: input.predicate,
    narrativeRange: input.start === undefined ? undefined : { start: input.start },
    knowledgeScope: "author" as const,
    authority: input.authority,
    confidence: 1,
    sourceRevisionIds: [`r-${input.id}`],
    contentHash: `hash-${input.id}`,
    valueHash: `hash-${input.id}`,
    identityHash: input.identityHash,
    supersedes: [],
    score: 1,
    matchedFacet: "fact" as const,
    reason: "test",
  };
}

/** 起草第 168 章的预检计划：narrativeCutoff = 167，故所有叙事位置 ≤ 167 的取值都可见。 */
function lateChapterPlan() {
  return createPreflightPlan(intent, { projectId: "p1", currentRevision: 170, targetDocumentOrder: 168 });
}

describe("V2 cognition compiler", () => {
  it("creates retrieval facets before an execution blueprint", () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentId: "doc-12", targetDocumentOrder: 12, povCharacterId: "hero" });
    expect(plan.stage).toBe("drafting");
    expect(plan.facets.some((facet) => facet.kind === "relation" && facet.knowledgeCharacterId === "hero")).toBe(true);
    expect(plan.narrativeCutoff).toBe(11);
  });

  it("filters future claims before the frozen bundle", async () => {
    const provider: MemoryProvider = { search: async () => [
      { id: "past", projectId: "p1", kind: "canonical", title: "过去", content: "已知", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: { characterId: "hero" }, authority: "approved", confidence: 1, sourceRevisionIds: ["r4"], contentHash: "a", supersedes: [], score: 0.9, matchedFacet: "fact", reason: "exact" },
      { id: "future", projectId: "p1", kind: "canonical", title: "未来", content: "不应泄漏", subjectRefs: ["hero"], narrativeRange: { start: 20 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r20"], contentHash: "b", supersedes: [], score: 1, matchedFacet: "fact", reason: "vector" },
    ] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12, povCharacterId: "hero" });
    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider });
    expect(bundle.claims.map((claim) => claim.id)).toEqual(["past"]);
    expect(bundle.sourceRevisionIds).toEqual(["r4"]);
  });

  it("caps ranked-fill claims per identity slot without blocking pinned or required selections", async () => {
    const slotClaims = Array.from({ length: 6 }, (_, index) => ({
      id: `slot-${index}`,
      projectId: "p1",
      kind: "episodic" as const,
      title: `槽位声明 ${index}`,
      content: `同一槽位的第 ${index} 条事实`,
      subjectRefs: ["hero"],
      narrativeRange: { start: 3 + index },
      knowledgeScope: "author" as const,
      authority: "derived" as const,
      confidence: 1,
      sourceRevisionIds: [`r${index}`],
      contentHash: `slot-${index}`,
      supersedes: [],
      identityHash: "slot-hero-knows",
      score: 1 - index / 10,
      matchedFacet: "fact" as const,
      reason: "lexical",
    }));
    const otherClaim = { ...slotClaims[0], id: "other-slot", identityHash: "slot-other", title: "其他槽位", content: "不同槽位的事实", contentHash: "other", narrativeRange: { start: 3 } };
    const provider: MemoryProvider = { search: async () => [...slotClaims, otherClaim] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider });
    const selectedIds = bundle.claims.map((claim) => claim.id);
    // 同槽位最多 3 条（按 compareCandidates 序取最优），其余被配额排除；
    // 不同槽位不受影响。
    expect(selectedIds.filter((id) => id.startsWith("slot-"))).toHaveLength(3);
    expect(selectedIds).toContain("other-slot");
    for (const excluded of slotClaims.slice(3).map((claim) => claim.id)) {
      expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: excluded, status: "excluded", reason: "identity-slot-quota" }));
    }
  });

  it("prefers the newest value inside a state-like identity slot", async () => {
    // 状态类谓词的槽位取值是同一状态维度的逐章快照（state-audit-20261013 §3：主角"持有"槽
    // 165 条 active 全是库存快照）。早期 approved 快照与晚期 derived 当前值并存时，
    // 槽位配额必须让当前值入选，否则模型读到的是 160 章前的家当。
    const claims = [
      slotValueClaim({ id: "holding-2", predicate: "持有", identityHash: "hero:holding", start: 2, authority: "approved" }),
      slotValueClaim({ id: "holding-5", predicate: "持有", identityHash: "hero:holding", start: 5, authority: "approved" }),
      slotValueClaim({ id: "holding-6", predicate: "持有", identityHash: "hero:holding", start: 6, authority: "approved" }),
      slotValueClaim({ id: "holding-160", predicate: "持有", identityHash: "hero:holding", start: 160, authority: "derived" }),
      slotValueClaim({ id: "holding-163", predicate: "持有", identityHash: "hero:holding", start: 163, authority: "derived" }),
    ];
    const bundle = await buildMemoryBundle(lateChapterPlan(), { projectId: "p1", provider: { search: async () => claims } });

    const selected = bundle.claims.map((claim) => claim.id);
    expect(selected).toHaveLength(3);
    expect(selected).toEqual(expect.arrayContaining(["holding-163", "holding-160", "holding-6"]));
    // 被挤掉的是最旧的 approved 快照，原因是槽位配额而非预算。
    expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "holding-2", status: "excluded", reason: "identity-slot-quota" }));
    expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "holding-5", status: "excluded", reason: "identity-slot-quota" }));
  });

  it("keeps authority-first ordering for accumulating identity slots", async () => {
    // 反向：累积型谓词的多个取值可以同时为真（知道 A 与知道 B 并存），
    // 因此不得因叙事位置更新而顶掉已核准断言。夹具与上例完全相同，只切换谓词。
    const claims = [
      slotValueClaim({ id: "knows-2", predicate: "知晓", identityHash: "hero:knows", start: 2, authority: "approved" }),
      slotValueClaim({ id: "knows-5", predicate: "知晓", identityHash: "hero:knows", start: 5, authority: "approved" }),
      slotValueClaim({ id: "knows-6", predicate: "知晓", identityHash: "hero:knows", start: 6, authority: "approved" }),
      slotValueClaim({ id: "knows-160", predicate: "知晓", identityHash: "hero:knows", start: 160, authority: "derived" }),
      slotValueClaim({ id: "knows-163", predicate: "知晓", identityHash: "hero:knows", start: 163, authority: "derived" }),
    ];
    const bundle = await buildMemoryBundle(lateChapterPlan(), { projectId: "p1", provider: { search: async () => claims } });

    const selected = bundle.claims.map((claim) => claim.id);
    expect(selected).toHaveLength(3);
    expect(selected).toEqual(expect.arrayContaining(["knows-2", "knows-5", "knows-6"]));
    expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "knows-163", status: "excluded", reason: "identity-slot-quota" }));
  });

  it("canonicalizes state-like aliases and treats undated values as oldest", async () => {
    // "拥有"是"持有"的别名，须经 canonicalizeFactPredicate 命中同一分类；
    // 无 narrativeRange 的取值拿不到叙事位置，按最旧处理，不抢占配额。
    const claims = [
      slotValueClaim({ id: "alias-163", predicate: "拥有", identityHash: "hero:owns", start: 163, authority: "derived" }),
      slotValueClaim({ id: "alias-90", predicate: "拥有", identityHash: "hero:owns", start: 90, authority: "derived" }),
      slotValueClaim({ id: "alias-3", predicate: "拥有", identityHash: "hero:owns", start: 3, authority: "derived" }),
      slotValueClaim({ id: "alias-undated", predicate: "拥有", identityHash: "hero:owns", start: undefined, authority: "approved" }),
    ];
    const bundle = await buildMemoryBundle(lateChapterPlan(), { projectId: "p1", provider: { search: async () => claims } });

    const selected = bundle.claims.map((claim) => claim.id);
    expect(selected).toHaveLength(3);
    expect(selected).toEqual(expect.arrayContaining(["alias-163", "alias-90", "alias-3"]));
    // 无叙事位置的 approved 断言也不因权威等级挤掉有位置的当前值。
    expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "alias-undated", status: "excluded", reason: "identity-slot-quota" }));
  });

  it("marks a final target revision as a replacement boundary without moving the narrative cutoff", () => {
    const revisionIntent: NovelIntent = { ...intent, requestedStage: "revision" };
    const plan = createPreflightPlan(revisionIntent, {
      projectId: "p1",
      currentRevision: 7,
      targetDocumentId: "doc-12",
      targetDocumentOrder: 12,
      targetDocumentStatus: "final",
      targetDocumentRevisionId: "rev-12",
      povCharacterId: "hero",
    });
    const newChapter = createPreflightPlan(intent, {
      projectId: "p1",
      currentRevision: 7,
      targetDocumentId: "doc-12",
      targetDocumentOrder: 12,
      targetDocumentStatus: "planned",
      povCharacterId: "hero",
    });

    expect(plan.replacementRevisionId).toBe("rev-12");
    expect(plan.narrativeCutoff).toBe(11);
    expect(newChapter.replacementRevisionId).toBeUndefined();
  });

  it("treats drafting on a final chapter as fresh generation without the old event boundary", () => {
    const freshIntent: NovelIntent = { ...intent, requestedStage: "drafting" };
    const plan = createPreflightPlan(freshIntent, {
      projectId: "p1",
      currentRevision: 7,
      targetDocumentId: "doc-12",
      targetDocumentOrder: 12,
      targetDocumentStatus: "final",
      targetDocumentRevisionId: "rev-12",
    });

    expect(plan.taskClass).toBe("drafting");
    expect(plan.replacementRevisionId).toBeUndefined();
    expect(plan.narrativeCutoff).toBe(11);
  });

  it("honors an explicit revision stage for a chapter target", () => {
    const revisionIntent: NovelIntent = {
      ...intent,
      objective: "重新生成本章完整正文，检查世界观铺陈与人物内心展开",
      requestedStage: "revision",
    };
    const plan = createPreflightPlan(revisionIntent, {
      projectId: "p1",
      currentRevision: 7,
      targetDocumentId: "doc-12",
      targetDocumentOrder: 12,
      targetDocumentStatus: "final",
      targetDocumentRevisionId: "rev-12",
    });

    expect(plan.taskClass).toBe("revision");
    expect(plan.stage).toBe("revision");
    expect(plan.replacementRevisionId).toBe("rev-12");
  });

  it("excludes bounded aggregates that cross the cutoff without dropping open-ended durable facts", async () => {    const provider: MemoryProvider = { search: async () => [
      { id: "past-rollup", projectId: "p1", kind: "hierarchical", title: "历史汇总", content: "仅包含截止章之前的内容", subjectRefs: [], narrativeRange: { start: 1, end: 11 }, knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: ["r1", "r11"], contentHash: "past-rollup", supersedes: [], predicate: "chapter-memory-rollup", score: 1, matchedFacet: "chapter-memory", reason: "pinned" },
      { id: "future-spanning-rollup", projectId: "p1", kind: "hierarchical", title: "跨截止章汇总", content: "同时包含第 12 章以后的结果", subjectRefs: [], narrativeRange: { start: 1, end: 20 }, knowledgeScope: "author", authority: "derived", confidence: 1, sourceRevisionIds: ["r1", "r20"], contentHash: "future-rollup", supersedes: [], predicate: "chapter-memory-rollup", score: 1, matchedFacet: "chapter-memory", reason: "pinned" },
      { id: "durable-fact", projectId: "p1", kind: "canonical", title: "持续事实", content: "第一章建立且仍然有效", subjectRefs: ["hero"], narrativeRange: { start: 1 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r1"], contentHash: "durable", supersedes: [], score: 1, matchedFacet: "fact", reason: "exact" },
      { id: "bounded-durable-fact", projectId: "p1", kind: "canonical", title: "有界持续事实", content: "跨过截止章但不包含未来正文", subjectRefs: ["hero"], narrativeRange: { start: 2, end: 20 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r2"], contentHash: "bounded-durable", supersedes: [], predicate: "alliance-active", score: 1, matchedFacet: "fact", reason: "exact" },
    ] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });

    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider });

    expect(bundle.claims.map((claim) => claim.id)).toEqual(expect.arrayContaining(["bounded-durable-fact", "durable-fact", "past-rollup"]));
    expect(bundle.claims.map((claim) => claim.id)).not.toContain("future-spanning-rollup");
    expect(bundle.sourceRevisionIds).toEqual(expect.arrayContaining(["r1", "r2", "r11"]));
    expect(bundle.sourceRevisionIds).not.toContain("r20");
    expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "future-spanning-rollup", status: "excluded", reason: "future-cutoff" }));
  });

  it("orders authoritative memories and freezes a ContextManifest before blueprint compilation", async () => {
    const provider: MemoryProvider = { search: async () => [
      { id: "candidate", projectId: "p1", kind: "episodic", title: "候选", content: "候选记忆", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: "author", authority: "candidate", confidence: 0.9, sourceRevisionIds: ["r-c"], contentHash: "c", supersedes: [], score: 0.99, matchedFacet: "fact", reason: "semantic" },
      { id: "approved", projectId: "p1", kind: "canonical", title: "核准", content: "正式事实", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: ["r-a"], contentHash: "a", supersedes: [], score: 0.5, matchedFacet: "entity", reason: "lexical" },
      { id: "thread", projectId: "p1", kind: "hierarchical", title: "线索", content: "主线仍在推进", subjectRefs: ["thread"], narrativeRange: { start: 5 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: ["r-t"], contentHash: "t", supersedes: [], score: 0.4, matchedFacet: "thread", reason: "lexical" },
      { id: "foreshadowing", projectId: "p1", kind: "hierarchical", title: "伏笔", content: "秘密尚未揭开", subjectRefs: ["thread"], narrativeRange: { start: 5 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: ["r-f"], contentHash: "f", supersedes: [], score: 0.4, matchedFacet: "foreshadowing", reason: "lexical" },
    ] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider });
    const manifest = buildContextManifest(plan, memory, { retrievalRunId: "retrieval-1" });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });
    const blueprint = compileExecutionBlueprint(intent, plan, memory, skills, { projectId: "p1", currentRevision: 7 }, manifest);
    expect(memory.claims.map((claim) => claim.id)).toEqual(["candidate", "approved", "foreshadowing", "thread"]);
    expect(manifest).toMatchObject({ memoryBundleId: memory.id, includedClaimIds: ["candidate", "approved", "foreshadowing", "thread"], excludedClaimIds: [], truncationReason: "none" });
    expect(blueprint.contextManifestId).toBe(manifest.id);
    expect(blueprint.factApprovalMode).toBe("auto");
  });

  it("preserves an explicit manual fact approval policy in the execution blueprint", async () => {
    const manualIntent: NovelIntent = { ...intent, factApprovalMode: "manual" };
    const plan = createPreflightPlan(manualIntent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [{ id: "known-fact", projectId: "p1", kind: "canonical", title: "已知事实", content: "当前章节可见", subjectRefs: [], narrativeRange: { start: 1 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r1"], contentHash: "known-fact", supersedes: [], score: 1, matchedFacet: "fact", reason: "exact" }] } });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });

    const blueprint = compileExecutionBlueprint(manualIntent, plan, memory, skills, { projectId: "p1", currentRevision: 7 });

    expect(blueprint.factApprovalMode).toBe("manual");
  });

  it("marks high-risk execution for manual review when required memory is missing", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12, povCharacterId: "hero" });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [] } });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [] } satisfies SkillProvider });
    const blueprint = compileExecutionBlueprint(intent, plan, memory, skills, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    expect(blueprint.memoryGate).toMatchObject({
      status: "manual-review",
      manualReviewFacets: expect.arrayContaining(["fact", "chapter-memory"]),
    });
  });

  it("excludes the rewritten chapter, later chapters, and staged facts while preserving prior facts", async () => {
    const claim = (id: string, start: number, lifecycleStatus: "staged" | "active" = "active") => ({
      id, projectId: "p1", kind: "episodic" as const, title: id, content: id, subjectRefs: ["hero"],
      narrativeRange: { start, end: start }, knowledgeScope: "author" as const, authority: "derived" as const,
      confidence: 1, sourceRevisionIds: [`r-${start}`], contentHash: id, supersedes: [], lifecycleStatus,
      score: 1, matchedFacet: "fact", reason: "test",
    });
    const provider: MemoryProvider = { search: async () => [
      claim("chapter-11", 11),
      claim("old-chapter-12", 12),
      claim("future-chapter-13", 13),
      claim("uncommitted-chapter-10", 10, "staged"),
    ] };
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });

    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider });

    expect(bundle.claims.map((item) => item.id)).toEqual(["chapter-11"]);
    expect(bundle.selectionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: "old-chapter-12", status: "excluded", reason: "future-cutoff" }),
      expect.objectContaining({ claimId: "future-chapter-13", status: "excluded", reason: "future-cutoff" }),
      expect.objectContaining({ claimId: "uncommitted-chapter-10", status: "excluded", reason: "inactive" }),
    ]));
  });

  it("selects pinned narratives and required facets before ranked fill and records exclusions", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const claim = (id: string, facet: string, content: string, score: number) => ({ id, projectId: "p1", kind: "canonical" as const, title: id, content, subjectRefs: [], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: [`r-${id}`], contentHash: id, supersedes: [], score, matchedFacet: facet, reason: "test" });
    const provider: MemoryProvider = { search: async () => [
      claim("high-score", "style", "x".repeat(60), 1),
      claim("fact", "fact", "fact", 0.5),
      claim("future", "fact", "future", 1),
    ].map((item) => item.id === "future" ? { ...item, narrativeRange: { start: 20 } } : item) };
    const pinned = claim("promise", "foreshadowing", "promise", 1);
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider, tokenBudget: 20, pinnedClaims: [pinned] }, 1);
    const manifest = buildContextManifest(plan, memory, { retrievalRunId: "r" }, 2);

    expect(memory.claims.map((item) => item.id)).toEqual(["promise", "fact"]);
    expect(memory.sourceRevisionIds).toEqual(["r-promise", "r-fact"]);
    expect(manifest.includedClaimIds).toEqual(["promise", "fact"]);
    expect(manifest.excludedClaimIds).toEqual(expect.arrayContaining(["future", "high-score"]));
    expect(manifest.selectionReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: "promise", status: "included", reason: "pinned-narrative" }),
      expect.objectContaining({ claimId: "fact", status: "included", reason: "required-facet" }),
      expect.objectContaining({ claimId: "future", status: "excluded", reason: "future-cutoff" }),
      expect.objectContaining({ claimId: "high-score", status: "excluded", reason: "budget" }),
    ]));
  });

  it("fails explicitly instead of dropping an oversized pinned narrative ledger", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const pinned = { id: "ledger", projectId: "p1", kind: "hierarchical" as const, title: "叙事账本", content: "x".repeat(400), subjectRefs: [], knowledgeScope: "author" as const, authority: "derived" as const, confidence: 1, sourceRevisionIds: ["r1"], contentHash: "ledger", supersedes: [], score: 1, matchedFacet: "thread", reason: "test" };
    await expect(buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [] }, tokenBudget: 10, pinnedClaims: [pinned] })).rejects.toThrow(/冻结叙事上下文超过记忆预算/);
  });

  it("fails explicitly instead of converting an oversized required facet into a missing facet", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12, povCharacterId: "hero" });
    const requiredFact = { id: "required-fact", projectId: "p1", kind: "canonical" as const, title: "必要事实", content: "x".repeat(400), subjectRefs: ["hero"], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: ["r1"], contentHash: "required-fact", supersedes: [], score: 1, matchedFacet: "fact", reason: "required" };
    await expect(buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [requiredFact] }, tokenBudget: 10 })).rejects.toThrow(/必要记忆 facet fact 超过记忆预算/);
  });

  it("keeps open ledger candidates available without making every item a pinned local constraint", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const requiredFact = { id: "required-fact", projectId: "p1", kind: "canonical" as const, title: "必要事实", content: "主角仍在旧站台", subjectRefs: ["hero"], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: ["r1"], contentHash: "required-fact", supersedes: [], score: 1, matchedFacet: "fact", reason: "required" };
    const openPromise = { id: "promise-1", projectId: "p1", kind: "working" as const, title: "开放承诺", content: "承诺内容：" + "x".repeat(100), subjectRefs: [], knowledgeScope: "author" as const, authority: "derived" as const, confidence: 0.9, sourceRevisionIds: ["r3"], contentHash: "promise-1", supersedes: [], score: 1, matchedFacet: "foreshadowing", reason: "open-promise" };
    const bundle = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [requiredFact] }, tokenBudget: 12, additionalClaims: [openPromise] });

    expect(bundle.claims.map((claim) => claim.id)).toEqual(["required-fact"]);
    expect(bundle.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "promise-1", status: "excluded", reason: "budget" }));
    expect(bundle.selectionReceipts).not.toContainEqual(expect.objectContaining({ claimId: "promise-1", reason: "pinned-narrative" }));
  });

  it("fingerprints the selected claim and pinned narrative content without depending on creation time", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 }, 1);
    const makeClaim = (content: string) => ({ id: "fact", projectId: "p1", kind: "canonical" as const, title: "事实", content, subjectRefs: [], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: ["r1"], contentHash: content, supersedes: [], score: 1, matchedFacet: "fact", reason: "test" });
    const makePinned = (content: string) => ({ ...makeClaim(content), id: "promise", title: "承诺", matchedFacet: "foreshadowing", sourceRevisionIds: ["r2"] });
    const first = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("原事实")] }, pinnedClaims: [makePinned("原承诺")] }, 1);
    const same = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("原事实")] }, pinnedClaims: [makePinned("原承诺")] }, 2);
    const changedClaim = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("变更事实")] }, pinnedClaims: [makePinned("原承诺")] }, 1);
    const changedPinned = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [makeClaim("原事实")] }, pinnedClaims: [makePinned("变更承诺")] }, 1);

    expect(same.fingerprint).toBe(first.fingerprint);
    expect(changedClaim.fingerprint).not.toBe(first.fingerprint);
    expect(changedPinned.fingerprint).not.toBe(first.fingerprint);
  });

  it("merges identical fact values across sources while preserving provenance", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const shared = { projectId: "p1", kind: "canonical" as const, title: "当前位置", content: "主角仍在旧站台", subjectRefs: ["hero"], knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, contentHash: "value-1", valueHash: "value-1", identityHash: "hero:location", supersedes: [], score: 1, matchedFacet: "fact", reason: "test" };
    const provider: MemoryProvider = { search: async () => [
      { ...shared, id: "claim-a", sourceRevisionIds: ["r1"] },
      { ...shared, id: "claim-b", sourceRevisionIds: ["r2"], matchedFacet: "entity" },
    ] };

    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider });

    expect(memory.claims).toHaveLength(1);
    expect(memory.claims[0].sourceRevisionIds).toEqual(["r1", "r2"]);
    expect(memory.claims[0].matchedFacets).toEqual(expect.arrayContaining(["fact", "entity"]));
    expect(memory.selectionReceipts).toContainEqual(expect.objectContaining({ claimId: "claim-b", status: "excluded", reason: "merged-source" }));
  });

  it("freezes task-applicable skills for every downstream stage", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [] } });
    const base = { version: "1", capabilities: ["prose"], applicableTasks: ["drafting" as const], requiredMemoryKinds: [], conflicts: [], qualityGates: ["readable"], enabled: true };
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [
      { ...base, skillId: "review-only", promptSections: { review: "只用于审校" } },
      { ...base, skillId: "drafting", promptSections: { drafting: "用于正文" } },
      { ...base, skillId: "disabled", promptSections: { drafting: "不能启用" }, enabled: false },
      { ...base, skillId: "wrong-task", applicableTasks: ["review"], promptSections: { review: "任务不匹配" } },
    ] }, requestedCapabilities: ["prose"] });

    expect(skills.skills.map((skill) => skill.skillId)).toEqual(["review-only", "drafting"]);
  });

  it("does not use quality gates as skill activation signals", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [] } });
    const shared = { version: "1", applicableTasks: ["drafting" as const], conflicts: [], enabled: true };
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [
      { ...shared, skillId: "gate-only", capabilities: ["prose"], requiredMemoryKinds: [], qualityGates: ["readable"], promptSections: { drafting: "不应仅因 gate 激活" } },
      { ...shared, skillId: "baseline", capabilities: [], requiredMemoryKinds: [], qualityGates: ["baseline-readable"], promptSections: { drafting: "显式基线" } },
    ] } });

    expect(skills.skills.map((skill) => skill.skillId)).toEqual(["baseline"]);
  });

  it("still activates a skill when its required memory kind is present", async () => {
    const plan = createPreflightPlan(intent, { projectId: "p1", currentRevision: 7, targetDocumentOrder: 12 });
    const memory = await buildMemoryBundle(plan, { projectId: "p1", provider: { search: async () => [{ id: "episode", projectId: "p1", kind: "episodic", title: "已发生事件", content: "主角已经拿到钥匙", subjectRefs: ["hero"], narrativeRange: { start: 11 }, knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["r11"], contentHash: "episode", supersedes: [], score: 1, matchedFacet: "fact", reason: "test" }] } });
    const skills = await resolveSkillBundle(plan, memory, { projectId: "p1", provider: { list: async () => [{ skillId: "continuity", version: "1", capabilities: ["memory"], applicableTasks: ["drafting"], requiredMemoryKinds: ["episodic"], conflicts: [], qualityGates: ["continuity"], promptSections: { drafting: "保持连续性" }, enabled: true }] } });

    expect(skills.skills.map((skill) => skill.skillId)).toEqual(["continuity"]);
  });
});
