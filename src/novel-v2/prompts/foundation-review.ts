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
    "## 读者视角严苛检查（检查方向与证据类型，不是必须全部成立的硬门；按当前 taskKey 的适用性选择检查项，不适用项跳过，不因缺少某项扣分，只有缺失确实损害已承诺功能时报告）",
    "以目标读者的眼光审视规划是否支撑「读者凭什么读下去、为什么被打动、为什么记得住」：",
    "- 读者承诺可兑现：sellingPoints/corePromise 描述的是可持续兑现的体验与冲突组合，不是题材标签或世界观名词堆；承诺的体验与规划的事件规模、人物配置匹配。例如承诺了认知差/智斗体验，就要有相应的人物知识边界与信息差设计；承诺了感情线，就要有关系阶段与行动证据的空间。",
    "- 主题进入选择：themeQuestion 不是宣言，而是能在人物利益、关系、责任、代价间的具体选择中被感知的压力；检查人物冲突与卷级压力是否由主题驱动，而非主题与剧情两张皮。",
    "- 最小动力闭环：protagonistNeed 与 centralOpposition 是否形成「欲望遇阻力产生选择」的最小动力；每个重要人物的选择是否有代价，没有代价的选择不构成转折（D2）。",
    "- 群像独立：配角是否有离开主角也成立的欲望、关系、秘密、工作和代价（characters 的 independentAction 与 relations）；只依赖主角存在的配角构成群像单薄（D3）。",
    "- 世界观压力系统：rules 的 cost/boundary 是否真实改变人物可选集合；删除世界观专有名词后人物仍能做同样的选择，说明设定没有成为叙事压力（D1）。",
    "- 感情线行动累积：emotionalContract 或关系线是否描述行动、物件、习惯、误解、牺牲与共同承担，而不是心理总结或宣言（D4）。",
    "- 疲劳管理：卷级压力、长线冲突、核心意象是否避免重复升级——每次重复必须改变层级、意义或代价（原则13）；承诺窗口是否错开同类回报，避免同一种刺激反复出现（D2）。",
    "- 留白证据：uncertainty 区分已隐藏/未设计/开放问题；读者不确定性必须能从已出现的行动、物件、语言或规则推断，否则是悬空而非留白（D2）。",
    "- 表层大众化：卷名、章节名、概念与术语命名是否面向大众读者、落在大众认知范围内；专业/技术概念若出现在表面是否有江湖化转译且全篇同译名。机制层可以技术化，读者可见表面不得技术化（D1）。",
    "- 揭示物分层：核心创意与世界观真相是否被写成剧情揭示物而非开篇设定——规划是否区分世界表面事实（开局成立）、异常现象（主角逐步发现）与底层真相（长线揭示）；若真相被当作既定的世界观基石直接铺开，检查删除该真相后开局是否仍成立（D1/D2）。",
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
