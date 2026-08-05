import type { ReviewerRole } from "../prompts/chapter-review";

export const REVIEW_EXECUTIONS: ReadonlyArray<{ role: ReviewerRole; identity: "internal" | "independent" }> = [
  { role: "structure-reviewer", identity: "internal" },
  { role: "character-reviewer", identity: "independent" },
  { role: "prose-reviewer", identity: "independent" },
];

export function runReviewersConcurrently<T>(
  runReview: (role: ReviewerRole, identity: "internal" | "independent") => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(REVIEW_EXECUTIONS.map(({ role, identity }) => runReview(role, identity)));
}
