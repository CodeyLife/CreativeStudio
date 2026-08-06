import type { StoryArcBundle } from "./story-arc";
import type { TextReviewOutput } from "../text-review";

/**
 * 故事弧审核文本契约。
 *
 * 设计依据：规划级审核产出本质是「通过」或「可执行指导意见」；结构化证据账本
 * （逐章维度校验、authorityChecks）依赖 provider 真正执行 strict json_schema，
 * 第三方中转站可能忽略该字段导致审核反复失败。文本契约对任何 provider 零依赖：
 * - 通过 → 只输出单行 PASSED
 * - 不通过 → 输出审核意见全文，意见本身即「不通过」信号
 *
 * 审核完整性（逐章状态连续/场景因果/功能/权威边界、整弧边界/节奏/层级）
 * 由审核 prompt 的检查清单要求模型逐项覆盖，不再以机器账本强制。
 */
export type StoryArcReviewOutput = TextReviewOutput;

/** Story Arc checks stay structural; literary preferences remain open to the writer. */
export function storyArcReviewStrategy(reviewPolicy: "manual" | "auto") {
  return { automaticReview: true as const, automaticRevision: reviewPolicy === "auto", humanApproval: reviewPolicy === "manual" };
}

/**
 * 每章权威路径清单：供审核 prompt 与重基线归一化使用，
 * 作为「逐章证据边界」的检查指引，不再是输出账本的强制结构。
 */
export function storyArcAuthorityPaths(chapter: StoryArcBundle["chapters"][number]): string[] {
  const paths = ["stateTransition.before", "stateTransition.after", "stateTransition.evidence"];
  chapter.scenes.forEach((_, sceneIndex) => {
    paths.push(
      `scenes[${sceneIndex}].situation`,
      `scenes[${sceneIndex}].observableActions`,
      `scenes[${sceneIndex}].outcome`,
    );
  });
  return paths;
}
