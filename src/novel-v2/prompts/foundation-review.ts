import type { Artifact } from "../protocol";
import { FOUNDATION_TASK_CONTRACTS } from "../application/foundation-contract";

export const FOUNDATION_REVIEW_DIMENSIONS = [
  "worldbuilding",
  "story",
  "ensemble",
  "romance",
  "humor",
] as const;

export type FoundationReviewDimension = (typeof FOUNDATION_REVIEW_DIMENSIONS)[number];

export interface FoundationReviewOutput {
  artifactFingerprint: string;
  verdict: "passed" | "revise" | "blocked";
  summary: string;
  scores: Record<FoundationReviewDimension, number>;
  issues: Array<{
    dimension: FoundationReviewDimension;
    severity: "blocker" | "major" | "warning";
    title: string;
    description: string;
    evidence: string;
    suggestion: string;
  }>;
  consistencyChecks: Array<{
    check: string;
    verdict: "passed" | "revise" | "blocked";
    evidence: string;
    reason: string;
  }>;
}

export const foundationReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifactFingerprint", "verdict", "summary", "scores", "issues", "consistencyChecks"],
  properties: {
    artifactFingerprint: { type: "string", minLength: 1 },
    verdict: { enum: ["passed", "revise", "blocked"] },
    summary: { type: "string", minLength: 1 },
    scores: {
      type: "object",
      additionalProperties: false,
      required: FOUNDATION_REVIEW_DIMENSIONS,
      properties: Object.fromEntries(FOUNDATION_REVIEW_DIMENSIONS.map((dimension) => [dimension, { type: "number", minimum: 0, maximum: 5 }])),
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "severity", "title", "description", "evidence", "suggestion"],
        properties: {
          dimension: { enum: FOUNDATION_REVIEW_DIMENSIONS },
          severity: { enum: ["blocker", "major", "warning"] },
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
          suggestion: { type: "string", minLength: 1 },
        },
      },
    },
    consistencyChecks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "verdict", "evidence", "reason"],
        properties: {
          check: { type: "string", minLength: 1 },
          verdict: { enum: ["passed", "revise", "blocked"] },
          evidence: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export function buildFoundationReviewPrompt(input: { taskKey: string; artifact: Artifact; premise?: string; genre?: string }): string {
  const contract = FOUNDATION_TASK_CONTRACTS[input.taskKey];
  return [
    "以独立长篇策划编辑身份审核 Foundation 架构产出。审核对象是项目级结构化规划，不是章节正文，因此不得使用章节钩子、语言润色或字数作为主要判据。",
    "必须从 D1 世界观、D2 故事性、D3 群像、D4 感情线、D5 幽默五个维度分别评分。感情线或幽默不适用时，检查是否明确记录了不适用边界，不因没有强行加入而扣分。",
    "先检查规划契约是否完整：读者承诺、主题问题、主角需要与矛盾、核心对抗、情感契约、世界压力、终局边界、不可违背项和待确认项是否互相支持。",
    "再检查层级与因果：全书方向是否能下传到故事弧，人物欲望与外部压力是否产生选择和代价，卷/线/伏笔是否有状态变化、回收窗口和后果，是否给下层创作保留真实空间。",
    "审查多线与结构承诺：每条长线是否说明它与主线的耦合机制（改变人物选择/资源/认知/关系/世界规则之一）以及交汇/退出/转化条件；无法说明耦合或生命周期、只能靠新增角色和地点维持存在的支线应被指出。全书结构类型（linear/tree/network）若已声明，检查其与读者承诺是否匹配。",
    "审查不确定性：区分已经隐藏的信息、尚未设计的信息和明确开放的问题；不允许把推测当事实，也不允许用新名词掩盖缺失的因果责任。",
    "每个问题必须引用 structuredData、sections 或 summary 的精确路径/片段，并说明问题机制、影响范围和最小修复方向。不得用抽象偏好替代证据，也不得通过增加固定章节数量、固定爽点密度或强制感情线来修复问题。",
    `审核结果必须原样回填当前 artifact fingerprint：${input.artifact.fingerprint}。若 fingerprint 不匹配，结果无效。`,
    `当前 taskKey：${input.taskKey}`,
    `当前任务应覆盖：${contract?.qualityFocus.join("；") || "通用架构完整性与上下游一致性"}`,
    input.premise ? `项目 premise：${input.premise}` : "项目 premise：未提供",
    input.genre ? `题材：${input.genre}` : "题材：未提供",
    "审核输出必须符合 foundationReviewSchema。consistencyChecks 至少检查一组跨字段关系，并优先覆盖契约→架构、架构→故事弧、人物→剧情线、世界规则→行动代价中的实际适用项。",
    "## 待审 artifact",
    JSON.stringify({ id: input.artifact.id, fingerprint: input.artifact.fingerprint, taskId: input.artifact.taskId, structuredData: input.artifact.structuredData }, null, 2),
  ].join("\n\n");
}
