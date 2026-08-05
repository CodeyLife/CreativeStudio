import { createHash, randomUUID } from "node:crypto";
import type { ReaderReconstructionEvidence, Review, ReviewIssue } from "./protocol";
import { mergeReaderReconstructionEvidence } from "./reader-reconstruction";
import { REQUIRED_CHAPTER_REVIEWERS } from "./temporal/revision-policy";

export type ChapterReviewVerdict = "passed" | "revise" | "blocked";
export type ChapterReviewIssueStatus = "pending" | "ignored" | "resolved";

export interface ChapterReviewSnapshotIssue {
  id: string;
  fingerprint: string;
  severity: ReviewIssue["severity"];
  title: string;
  description?: string;
  evidenceQuote: string;
  paragraph?: number;
  revisionRanges: Array<{ start: number; end: number }>;
  rule?: string;
  suggestion?: string;
  readerReconstruction?: ReaderReconstructionEvidence | null;
  sourceRoles: string[];
  status: ChapterReviewIssueStatus;
}

export interface ChapterReviewSnapshotData {
  verdict: ChapterReviewVerdict;
  complete: boolean;
  overallScore?: number;
  reviewerRoles: string[];
  issues: ChapterReviewSnapshotIssue[];
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function reviewIssueFingerprint(issue: ReviewIssue): string {
  return createHash("sha256")
    // Reader reconstruction is diagnostic metadata, not issue identity. Keep
    // the historical three-part fingerprint so existing statuses remain valid.
    .update([normalized(issue.title), normalized(issue.excerpt ?? issue.evidence), normalized(issue.rule)].join("\u0000"))
    .digest("hex");
}

function aggregateVerdict(reviews: Review[]): ChapterReviewVerdict {
  if (reviews.some((review) => review.verdict === "blocked" || review.issues.some((issue) => issue.severity === "blocker"))) return "blocked";
  if (reviews.some((review) => review.verdict === "revise")) return "revise";
  return "passed";
}

export function aggregateChapterReviews(
  reviews: Review[],
  priorStatuses: ReadonlyMap<string, ChapterReviewIssueStatus> = new Map(),
): ChapterReviewSnapshotData {
  const latestByRole = new Map<string, Review>();
  for (const review of [...reviews].sort((left, right) => left.createdAt - right.createdAt)) {
    if (review.role) latestByRole.set(review.role, review);
  }
  const required = REQUIRED_CHAPTER_REVIEWERS.map(({ role }) => latestByRole.get(role)).filter((review): review is Review => Boolean(review));
  const complete = required.length === REQUIRED_CHAPTER_REVIEWERS.length;
  const scores = required.map((review) => review.score).filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const overallScore = complete && scores.length === required.length
    ? scores.reduce((sum, score) => sum + Math.max(0, Math.min(5, score)), 0) / scores.length
    : undefined;

  const merged = new Map<string, ChapterReviewSnapshotIssue>();
  for (const review of required) {
    for (const issue of review.issues) {
      const fingerprint = reviewIssueFingerprint(issue);
      const existing = merged.get(fingerprint);
      if (existing) {
        existing.sourceRoles = [...new Set([...existing.sourceRoles, review.role ?? review.reviewerId])];
        existing.readerReconstruction = mergeReaderReconstructionEvidence(existing.readerReconstruction, issue.readerReconstruction);
        continue;
      }
      merged.set(fingerprint, {
        id: randomUUID(),
        fingerprint,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        evidenceQuote: issue.excerpt ?? issue.evidence,
        paragraph: issue.paragraph,
        revisionRanges: issue.revisionRanges ?? [],
        rule: issue.rule,
        suggestion: issue.suggestion,
        readerReconstruction: issue.readerReconstruction ?? null,
        sourceRoles: [review.role ?? review.reviewerId],
        status: priorStatuses.get(fingerprint) ?? "pending",
      });
    }
  }

  return {
    verdict: aggregateVerdict(required),
    complete,
    overallScore,
    reviewerRoles: required.map((review) => review.role ?? review.reviewerId),
    issues: [...merged.values()],
  };
}
