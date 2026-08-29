/**
 * 模型用途（purpose）与能力要求的单一真源。
 *
 * 设计依据：AGENTS.md「根因分析与迭代改进」——模型路由的 purpose 枚举此前在
 * model-routing.ts 与前端 NovelModelRoutingSettings.tsx 各自硬编码，已发生漂移
 * （前端缺 planning.arc / planning.arc-revision / review.arc / writing.script），
 * 导致设置界面无法配置新增用途的路由。本文件不含任何 node 依赖，可被前端与
 * 运行时共同导入；新增 purpose 只改这里 + 前端标签表两处，能力要求单一真源。
 */

export const MODEL_PURPOSES = [
  "planning.foundation",
  "planning.blueprint",
  "planning.arc",
  "planning.arc-revision",
  "writing.draft",
  "writing.revision",
  "writing.script",
  "review.structure",
  "review.character",
  "review.prose",
  "review.foundation",
  "review.arc",
  "facts.extract",
  "learning.assess",
  "skill.iterate",
  "memory.embed",
  "memory.rerank",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];
export type ModelCapability = "text" | "structured" | "stream" | "responses-continuation" | "embedding" | "rerank";

/** 每个 purpose 要求的最低模型能力（路由候选校验与设置界面共用同一份）。 */
export const PURPOSE_CAPABILITY: Record<ModelPurpose, ModelCapability> = {
  "planning.foundation": "structured",
  "planning.blueprint": "structured",
  "planning.arc": "structured",
  "planning.arc-revision": "structured",
  "writing.draft": "text",
  "writing.revision": "text",
  "writing.script": "structured",
  "review.structure": "structured",
  "review.character": "structured",
  "review.prose": "structured",
  "review.foundation": "structured",
  "review.arc": "structured",
  "facts.extract": "structured",
  "learning.assess": "structured",
  "skill.iterate": "structured",
  "memory.embed": "embedding",
  "memory.rerank": "rerank",
};
