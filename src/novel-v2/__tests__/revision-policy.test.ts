import { describe, expect, it } from "vitest";
import { inspectManuscript } from "../application/manuscript-structure";
import type { Artifact, Review, ReviewIssue } from "../protocol";
import {
  allReviewsPassed,
  candidateQualityKey,
  decideRevision,
  DEFAULT_MAX_AUTO_REVISIONS,
  evaluateCommitGate,
  hasBlocker,
  hasBlockerOrMajor,
  isCandidateQualityBetter,
  scoreReviews,
} from "../temporal/revision-policy";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
const structuralReport = inspectManuscript({ text: "正文" });

function issue(severity: ReviewIssue["severity"], title = "issue"): ReviewIssue {
  return { severity, title, evidence: `evidence-${title}`, excerpt: `evidence-${title}`, revisionRanges: [{ start: 1, end: 1 }] };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: "review-1",
    projectId: "p1",
    artifactId: artifact.id,
    reviewerId: "internal-structure",
    identity: "internal",
    role: "structure-reviewer",
    verdict: "passed",
    issues: [],
    score: 4.2,
    createdAt: 2,
    artifactFingerprint: artifact.fingerprint,
    ...overrides,
  };
}

function completeReviews(overrides: Partial<Record<"structure" | "character" | "prose", Partial<Review>>> = {}): Review[] {
  return [
    makeReview({ id: "structure", role: "structure-reviewer", identity: "internal", ...(overrides.structure ?? {}) }),
    makeReview({ id: "character", role: "character-reviewer", identity: "independent", ...(overrides.character ?? {}) }),
    makeReview({ id: "prose", role: "prose-reviewer", identity: "independent", ...(overrides.prose ?? {}) }),
  ];
}

describe("revision-policy", () => {
  it("scores persisted reviewer totals and falls back to severity when absent", () => {
    expect(scoreReviews(completeReviews())).toBeCloseTo(4.2, 5);
    expect(scoreReviews([makeReview({ score: undefined, issues: [issue("blocker"), issue("major")] })])).toBe(3);
  });

  it("commit gate requires the three current reviewer roles", () => {
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport)).toMatchObject({ passed: true, missingRoles: [] });
    expect(evaluateCommitGate(completeReviews().slice(0, 2), artifact.fingerprint, structuralReport)).toMatchObject({
      passed: false,
      missingRoles: ["prose-reviewer"],
    });
  });

  it("rejects blockers, majors and low local reviewer scores", () => {
    expect(hasBlocker([makeReview({ issues: [issue("blocker")] })])).toBe(true);
    expect(hasBlockerOrMajor([makeReview({ issues: [issue("major")] })])).toBe(true);
    expect(evaluateCommitGate(completeReviews({ prose: { score: 3.2 } }), artifact.fingerprint, structuralReport)).toMatchObject({ passed: false, qualityFailure: "reviewer-score" });
  });

  it("keeps local degradation guard while allowing meaningful overall improvement", () => {
    const current = candidateQualityKey(completeReviews({ structure: { score: 4.0 }, character: { score: 4.0 }, prose: { score: 4.0 } }), structuralReport);
    const better = candidateQualityKey(completeReviews({ structure: { score: 3.8 }, character: { score: 4.7 }, prose: { score: 4.4 } }), structuralReport);
    const degraded = candidateQualityKey(completeReviews({ structure: { score: 3.0 }, character: { score: 5.0 }, prose: { score: 5.0 } }), structuralReport);
    expect(isCandidateQualityBetter(better, current)).toBe(true);
    expect(isCandidateQualityBetter(degraded, current)).toBe(false);
  });

  it("revision decisions stop after pass or max iteration", () => {
    expect(allReviewsPassed(completeReviews())).toBe(true);
    expect(decideRevision({ reviews: completeReviews(), iteration: 0 }).shouldRevise).toBe(false);
    expect(decideRevision({ reviews: [makeReview({ verdict: "blocked", issues: [issue("blocker")] })], iteration: DEFAULT_MAX_AUTO_REVISIONS }).shouldRevise).toBe(false);
  });
});
