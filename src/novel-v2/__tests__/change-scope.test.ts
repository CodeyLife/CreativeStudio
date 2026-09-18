/**
 * E4（product-audit-20260910）changeScope：评审面按变更意图档位收窄的契约测试。
 * 双向覆盖：默认档零回归（三审全量）；收窄档裁掉无关角色但不裁结构校验与
 * blocker 判定；commit gate 期望与评审执行同源（收窄档缺 character 不判 missing，
 * 全量档缺 character 仍判 missing）；非法组合（非正文 taskClass 带收窄档）拒绝。
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { reviewExecutionsForScope, runReviewersConcurrently } from "../application/review-concurrency";
import { evaluateCommitGate } from "../temporal/revision-policy";
import { aggregateChapterReviews } from "../chapter-review-snapshot";
import { createPreflightPlan } from "../cognition";
import type { ManuscriptStructuralReport } from "../application/manuscript-structure";
import type { NovelIntent, PreflightProjectSnapshot, Review } from "../protocol";

function review(role: NonNullable<Review["role"]>, identity: Review["identity"], fingerprint: string): Review {
  return {
    id: randomUUID(), reviewerId: `reviewer-${role}`, projectId: "p1", kind: "chapter", role, identity, subjectType: "artifact", subjectId: "art-1",
    artifactId: "art-1", artifactFingerprint: fingerprint, verdict: "passed", issues: [], createdAt: Date.now(), score: 4.5,
  } as Review;
}

const structuralPass: ManuscriptStructuralReport = { passed: true, fingerprint: "s", blockers: [], warnings: [], metrics: {} as never };

describe("E4 changeScope 评审面收窄", () => {
  it("默认/narrative 档 = 全量三审（零回归）", async () => {
    for (const scope of [undefined, "narrative"] as const) {
      expect(reviewExecutionsForScope(scope).map((entry) => entry.role)).toEqual(["structure-reviewer", "character-reviewer", "prose-reviewer"]);
    }
    const roles: string[] = [];
    await runReviewersConcurrently(async (role) => { roles.push(role); return 1; });
    expect(roles).toHaveLength(3);
  });

  it("收窄档裁 character 不裁 structure/prose；两档当前共享同一裁剪集但语义独立声明", () => {
    expect(reviewExecutionsForScope("local-text").map((entry) => entry.role)).toEqual(["structure-reviewer", "prose-reviewer"]);
    expect(reviewExecutionsForScope("mechanical-format").map((entry) => entry.role)).toEqual(["structure-reviewer", "prose-reviewer"]);
  });

  it("commit gate 双向：narrative 缺 character → missing；local-text 缺 character → passed；任何档 blocker 仍拒", () => {
    const fp = "fp-1";
    const full = [review("structure-reviewer", "internal", fp), review("character-reviewer", "independent", fp), review("prose-reviewer", "independent", fp)];
    const narrowed = [review("structure-reviewer", "internal", fp), review("prose-reviewer", "independent", fp)];
    expect(evaluateCommitGate(narrowed, fp, structuralPass).missingRoles).toContain("character-reviewer");
    expect(evaluateCommitGate(narrowed, fp, structuralPass, "local-text").passed).toBe(true);
    expect(evaluateCommitGate(narrowed, fp, structuralPass, "local-text").missingRoles).toEqual([]);
    expect(evaluateCommitGate(full, fp, structuralPass, "mechanical-format").passed).toBe(true); // 多审不惩罚
    const blocker = [...narrowed.map((r) => ({ ...r, issues: [{ severity: "blocker" as const, title: "x", description: "y", evidence: "z", rule: "r" }] }))];
    expect(evaluateCommitGate(blocker, fp, structuralPass, "mechanical-format").passed).toBe(false); // 非后门：blocker 判定不随档位放松
  });

  it("review snapshot 聚合按档判 complete：local-text 两审即完整分，narrative 两审不完整", () => {
    const fp = "fp-2";
    const narrowed = [review("structure-reviewer", "internal", fp), review("prose-reviewer", "independent", fp)];
    expect(aggregateChapterReviews(narrowed).overallScore).toBeUndefined();
    expect(aggregateChapterReviews(narrowed, new Map(), "local-text").overallScore).toBeCloseTo(4.5, 5);
  });

  it("preflight 归一化与守卫：缺省 narrative；非法值拒绝", () => {
    const snapshot: PreflightProjectSnapshot = { projectId: "p1", currentRevision: 1, targetDocumentId: undefined, targetDocumentStatus: undefined, targetDocumentOrder: undefined, povCharacterId: undefined, totalChapters: 10, completedChapters: 1 } as PreflightProjectSnapshot;
    const base: NovelIntent = { id: "i1", projectId: "p1", source: "web", objective: "生成下一章", target: { kind: "chapter", id: "doc-2" }, createdAt: 1, idempotencyKey: "k1" };
    expect(createPreflightPlan(base, snapshot).changeScope).toBe("narrative");
    expect(createPreflightPlan({ ...base, changeScope: "mechanical-format" }, snapshot).changeScope).toBe("mechanical-format");
    expect(() => createPreflightPlan({ ...base, changeScope: "nonsense" as never }, snapshot)).toThrow(/changeScope 非法/);
  });

  it("scope×taskClass 语义守卫（下沉 plan 纯函数=全入口共享）：正文档放行，规划/复盘档拒绝", () => {
    const snapshot: PreflightProjectSnapshot = { projectId: "p1", currentRevision: 1, targetDocumentId: undefined, targetDocumentStatus: undefined, targetDocumentOrder: undefined, povCharacterId: undefined, totalChapters: 10, completedChapters: 1 } as PreflightProjectSnapshot;
    // 正向：drafting/revision 携带收窄档合法（评审面存在）。
    const chapterIntent: NovelIntent = { id: "i2", projectId: "p1", source: "web", objective: "重写这一段", target: { kind: "chapter", id: "doc-2" }, createdAt: 1, idempotencyKey: "k2" };
    expect(createPreflightPlan({ ...chapterIntent, changeScope: "local-text" }, snapshot).changeScope).toBe("local-text");
    expect(createPreflightPlan({ ...chapterIntent, requestedStage: "revision", changeScope: "mechanical-format" }, snapshot).changeScope).toBe("mechanical-format");
    // 反向：规划/复盘没有章节评审面，收窄档是无效组合——两例分别锁 planning/review。
    const planningIntent: NovelIntent = { id: "i3", projectId: "p1", source: "web", objective: "规划下一故事弧", createdAt: 1, idempotencyKey: "k3" };
    expect(() => createPreflightPlan({ ...planningIntent, changeScope: "local-text" }, snapshot)).toThrow(/仅适用于 drafting\/revision/);
    const reviewIntent: NovelIntent = { id: "i4", projectId: "p1", source: "web", objective: "审核已定稿章节质量", createdAt: 1, idempotencyKey: "k4" };
    expect(() => createPreflightPlan({ ...reviewIntent, changeScope: "mechanical-format" }, snapshot)).toThrow(/taskClass=review/);
    // 同两例不带收窄档：默认 narrative 放行（守卫只对非默认档生效，零回归）。
    expect(createPreflightPlan(planningIntent, snapshot).changeScope).toBe("narrative");
    expect(createPreflightPlan(reviewIntent, snapshot).changeScope).toBe("narrative");
  });
});
