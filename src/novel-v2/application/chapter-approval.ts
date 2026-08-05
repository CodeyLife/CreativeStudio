export type ChapterApprovalDecision = "approve" | "reject" | "revise" | "abandon";

/**
 * 作者可以覆盖质量分数或问题，但不能绕过必需 reviewer 的缺失证据。
 * 这是提交边界的共享校验，持久化入口和 Temporal workflow 都必须复用。
 */
export function assertCompleteChapterReviewEvidence(decision: ChapterApprovalDecision, missingReviewerRoles: string[]): void {
  if (decision === "approve" && missingReviewerRoles.length > 0) {
    throw new Error(`不能批准章节：缺少必要的审核证据（${missingReviewerRoles.join("、")}）`);
  }
}
