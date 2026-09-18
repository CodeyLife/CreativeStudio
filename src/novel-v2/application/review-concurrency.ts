import type { ReviewerRole } from "../prompts/chapter-review";
import type { ChapterChangeScope } from "../protocol";

export const REVIEW_EXECUTIONS: ReadonlyArray<{ role: ReviewerRole; identity: "internal" | "independent" }> = [
  { role: "structure-reviewer", identity: "internal" },
  { role: "character-reviewer", identity: "independent" },
  { role: "prose-reviewer", identity: "independent" },
];

/**
 * E4（product-audit-20260910）changeScope → 评审面投影。收窄依据是"该类变更
 * 不可能触及的评审维度"，不是降本偏好——非后门契约：结构校验与 commit gate
 * 在任何一档都完整保留，被裁掉的只是与该类变更语义无关的评审角色：
 * - narrative（缺省）：全量三审（现行为）。
 * - local-text：局部文本改写不改事件/人物知识边界 → 角色审跳过。
 * - mechanical-format：格式噪声（引号/错别字/黑话替换）不改事件、人物与段落
 *   功能 → 仅结构+行文；角色审跳过。
 * 反向恢复：intent 不带 changeScope 即回到三审，无需数据迁移（蓝图 payload
 * 内字段，重放旧蓝图 = 其自身记录的档位）。
 */
export function reviewExecutionsForScope(scope: ChapterChangeScope | undefined): typeof REVIEW_EXECUTIONS {
  if (scope === "mechanical-format" || scope === "local-text") {
    return REVIEW_EXECUTIONS.filter((entry) => entry.role !== "character-reviewer");
  }
  return REVIEW_EXECUTIONS;
}

export function runReviewersConcurrently<T>(
  runReview: (role: ReviewerRole, identity: "internal" | "independent") => Promise<T>,
  scope?: ChapterChangeScope,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(reviewExecutionsForScope(scope).map(({ role, identity }) => runReview(role, identity)));
}
