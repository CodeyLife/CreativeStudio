import { describe, expect, it } from "vitest";
import { aggregateChapterReviews, EVIDENCE_UNVERIFIED_MARKER, isEvidencePresentInText, markEvidenceUnverified, reviewIssueFingerprint, type ChapterReviewSnapshotIssue } from "../chapter-review-snapshot";
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

  it("keeps diagnostic reader evidence out of issue identity", () => {
    const base: ReviewIssue = { severity: "major", title: "动作承接", evidence: "他停住了。", excerpt: "他停住了。", rule: "因果跳步" };
    const annotated = {
      ...base,
      readerReconstruction: { impact: "core" as const, missingEvidence: ["consequence" as const], blockedQuestion: "读者无法判断停顿改变了什么" },
    };
    const snapshot = aggregateChapterReviews([
      makeReview("structure-reviewer", "internal", 4, [base]),
      makeReview("character-reviewer", "independent", 4),
      makeReview("prose-reviewer", "independent", 4, [annotated]),
    ]);

    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({
      readerReconstruction: { impact: "core", missingEvidence: ["consequence"], blockedQuestion: "读者无法判断停顿改变了什么" },
      sourceRoles: ["structure-reviewer", "prose-reviewer"],
    });
  });
});

describe("evidence present-in-text verification (P0-C4)", () => {
  it("detects evidence that exists verbatim in the manuscript", () => {
    expect(isEvidencePresentInText("他握紧了那块金属残片。", "他握紧了那块金属残片。断口在指缝间发凉。")).toBe(true);
  });

  it("marks evidence absent from the manuscript as unverified", () => {
    expect(isEvidencePresentInText("像弹击代码里的一个错误节点", "拇指与中指抵紧，猛地一弹。指尖一阵麻酥。")).toBe(false);
  });

  it("matches through an ellipsis window when evidence quotes a partial span", () => {
    expect(isEvidencePresentInText("他……死死盯着那道光斑", "他强撑着干涩刺痛的眼皮，死死盯着那道光斑。")).toBe(true);
  });

  it("matches through an ASCII-dot ellipsis window when evidence quotes a partial span", () => {
    expect(isEvidencePresentInText("他...死死盯着那道光斑", "他强撑着干涩刺痛的眼皮，死死盯着那道光斑。")).toBe(true);
  });

  it("still marks ASCII-dot evidence absent from the manuscript as unverified", () => {
    expect(isEvidencePresentInText("他...死死盯着那道不存在的景象", "他强撑着干涩刺痛的眼皮，死死盯着那道光斑。")).toBe(false);
  });

  it("matches a leading window when evidence quotes a partial span", () => {
    // evidence 取正文前段真实子串（省略号在句首），窗口匹配应命中。
    expect(isEvidencePresentInText("……强撑着干涩刺痛的眼皮", "他强撑着干涩刺痛的眼皮，死死盯着那道光斑。")).toBe(true);
  });

  it("does not judge very short evidence (undefined result, not a miss)", () => {
    expect(isEvidencePresentInText("他停住了", "他握紧残片，屏住呼吸。")).toBeUndefined();
  });

  it("does not judge author-sourced issues even when evidence is absent", () => {
    const issue: ChapterReviewSnapshotIssue = {
      id: "i", fingerprint: "f", severity: "major", title: "作者意见", evidenceQuote: "正文中不存在的引用",
      revisionRanges: [], sourceRoles: ["author"], status: "pending",
    };
    expect(markEvidenceUnverified(issue, "正文实际内容……")).toBe(issue);
  });

  it("marks reviewer issues with absent evidence without touching identity fields", () => {
    const issue: ChapterReviewSnapshotIssue = {
      id: "i", fingerprint: "f", severity: "major", title: "审校意见", evidenceQuote: "像弹击代码里的一个错误节点",
      revisionRanges: [], sourceRoles: ["structure-reviewer"], status: "pending",
    };
    const marked = markEvidenceUnverified(issue, "拇指与中指抵紧，猛地一弹。");
    expect(marked.dimension).toBe(EVIDENCE_UNVERIFIED_MARKER);
    expect(marked.fingerprint).toBe("f");
    expect(marked.status).toBe("pending");
  });
});
