import { createHash, randomUUID } from "node:crypto";
import type { ReaderReconstructionEvidence, Review, ReviewIssue } from "./protocol";
import { mergeReaderReconstructionEvidence } from "./reader-reconstruction";
import { REQUIRED_CHAPTER_REVIEWERS } from "./temporal/revision-policy";

export type ChapterReviewVerdict = "passed" | "revise" | "blocked";
export type ChapterReviewIssueStatus = "pending" | "ignored" | "resolved";

/**
 * evidence 未在正文中命中的软标记（写入 dimension 字段，不参与 issue 指纹）。
 *
 * 设计依据：AGENTS.md「审核证据以正文为准」——审校模型可能把指令示例词或
 * 修订前文本当作正文证据引用（回显误报），落库时做正文包含性软校验，零命中
 * 时附标记，供人工决策参考；不删除 issue、不改变指纹，避免误杀有效审校。
 *
 * 契约边界：chapter_review_snapshot_issues.dimension 列当前专用作该软标记
 * （D1-D5 质量维度不落此列，review 的维度分数存于 dimension_scores）。
 * TODO P2: 若后续需把 D1-D5 落到该列，必须为软标记另立独立列，避免枚举混入。
 */
export const EVIDENCE_UNVERIFIED_MARKER = "evidence-unverified";

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
  /** 机器可读软标记；当前仅 EVIDENCE_UNVERIFIED_MARKER，无标记时为 undefined。 */
  dimension?: string;
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

/**
 * 校验 issue 的 evidenceQuote 是否出现在给定正文中。
 *
 * 规则（保守）：把 evidence 与正文都做空白归一化；evidence 去除常见省略符
 * （……/…/...）后若长度 ≥ 6 且正文不包含其任意 24 字窗口，判定为未命中。
 * 省略号两侧内容不连续时，取省略号后的最长连续片段做窗口匹配。
 * 短 evidence（< 6 字）不做判定（可能是通用指代，误报率高）。
 * 设计依据：evidence 不是逐字引文（pipeline-audit §2.5），因此只做包含性软校验，
 * 不要求逐字匹配；命中与否都保留 issue，只附机器可读标记。
 */
export function isEvidencePresentInText(evidence: string | undefined, plainText: string | undefined): boolean | undefined {
  if (!evidence || !plainText) return undefined;
  const compactText = plainText.replace(/\s+/gu, "");
  if (!compactText) return undefined;
  const segments = evidence
    .replace(/\s+/gu, "")
    // 省略符形态覆盖 U+2026（…、……、………）与 ASCII 点号（...、......）。
    .split(/…+|\.{3,}/u)
    .map((segment) => segment.replace(/[。，、；：？！]/gu, ""))
    .filter((segment) => segment.length > 0)
    .sort((left, right) => right.length - left.length);
  const best = segments[0];
  if (!best || best.length < 6) return undefined;
  if (compactText.includes(best)) return true;
  const window = best.slice(0, 24);
  if (window.length >= 6 && compactText.includes(window)) return true;
  return false;
}

export function markEvidenceUnverified(issue: ChapterReviewSnapshotIssue, plainText: string | undefined): ChapterReviewSnapshotIssue {
  if (issue.sourceRoles.includes("author")) return issue;
  const present = isEvidencePresentInText(issue.evidenceQuote, plainText);
  if (present === false) return { ...issue, dimension: EVIDENCE_UNVERIFIED_MARKER };
  return issue;
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
