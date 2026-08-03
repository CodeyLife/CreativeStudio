import { describe, expect, it } from "vitest";
import { aggregateChapterReviews, reviewIssueFingerprint } from "../chapter-review-snapshot";
import type { Review, ReviewIssue } from "../protocol";
import type { ReviewerRole } from "../prompts/chapter-review";

function makeReview(role: ReviewerRole, identity: Review["identity"], score: number, issues: ReviewIssue[] = []): Review {
  return {
    id: role,
    projectId: "p1",
    artifactId: "a1",
    reviewerId: role,
    role,
    identity,
    verdict: issues.length ? "revise" : "passed",
    issues,
    score,
    createdAt: 1,
    artifactFingerprint: "fp1",
  };
}

function completeReviews(issue: ReviewIssue[] = []) {
  return [
    makeReview("structure-reviewer", "internal", 4, issue),
    makeReview("character-reviewer", "independent", 4),
    makeReview("prose-reviewer", "independent", 4, issue),
  ];
}

describe("aggregateChapterReviews", () => {
  it("aggregates the current three-reviewer contract without dimension scores", () => {
    const snapshot = aggregateChapterReviews(completeReviews());
    expect(snapshot.complete).toBe(true);
    expect(snapshot.reviewerRoles).toEqual(["structure-reviewer", "character-reviewer", "prose-reviewer"]);
    expect(snapshot.overallScore).toBe(4);
    expect(snapshot.verdict).toBe("passed");
    expect("dimensionScores" in snapshot).toBe(false);
  });

  it("does not fabricate a score when a required reviewer is missing", () => {
    const snapshot = aggregateChapterReviews(completeReviews().slice(0, 2));
    expect(snapshot.complete).toBe(false);
    expect(snapshot.overallScore).toBeUndefined();
  });

  it("merges the same issue across roles and inherits the user's status", () => {
    const issue: ReviewIssue = { severity: "major", title: "因果跳步", description: "转折缺少触发", evidence: "他停住了。", excerpt: "他停住了。", suggestion: "补足促成选择的信息" };
    const fingerprint = reviewIssueFingerprint(issue);
    const snapshot = aggregateChapterReviews(completeReviews([issue]), new Map([[fingerprint, "ignored"]]));
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({ fingerprint, status: "ignored", sourceRoles: ["structure-reviewer", "prose-reviewer"] });
    expect(snapshot.verdict).toBe("revise");
  });
});
