import { READER_RECONSTRUCTION_MISSING_EVIDENCE } from "./reader-reconstruction";

/**
 * MCP 工具层契约（review.submit 参数）：无关问题必须为 null。
 * 该 schema 不发给模型，不经过 provider strict json_schema 校验，类型联合合法。
 */
export const readerReconstructionSchema = {
  type: ["object", "null"],
  description: "仅当问题阻断普通读者复原现场时填写；无关问题必须为 null",
  additionalProperties: false,
  required: ["impact", "missingEvidence", "blockedQuestion"],
  properties: {
    impact: {
      type: "string",
      enum: ["core", "local"],
      description: "只能原样选择 core 或 local：core 影响关键行动/选择/结果，local 只影响局部阅读复原。",
    },
    missingEvidence: {
      type: "array",
      minItems: 1,
      description: "只填写缺少的现场证据类别；每项必须使用既定枚举。",
      items: {
        type: "string",
        enum: [...READER_RECONSTRUCTION_MISSING_EVIDENCE],
        description: "body=身体，space=空间，object=物件，action=动作，consequence=后果，relationship=关系反馈。",
      },
    },
    blockedQuestion: {
      type: "string",
      minLength: 1,
      description: "普通读者因此无法复原的具体问题，不要写成泛泛的通俗性评价。",
    },
  },
} as const;

/**
 * LLM 结构化输出契约：用 sentinel 编码替代 type 联合。
 *
 * 设计依据：`["object","null"]` 联合在 provider strict json_schema 下支持不一
 * （部分 OpenAI 兼容服务直接 400），而本代码库是多 provider 路由，无法在
 * transport 层保证兼容；唯一 provider 无关的写法是单一 type。用
 * impact=none + 空数组 + 空字符串表示"无关"，parse 层（normalizeReaderReconstruction）
 * 已把该形态归一为 null，下游消费方（severity 提升、指纹、落库）语义不变。
 */
export const readerReconstructionStrictSchema = {
  type: "object",
  description: "仅当问题阻断普通读者复原现场时填写；无关问题必须用 impact=none 的空对象表示",
  additionalProperties: false,
  required: ["impact", "missingEvidence", "blockedQuestion"],
  properties: {
    impact: {
      type: "string",
      enum: ["none", "core", "local"],
      description: "none=该问题不阻断读者复原；core=影响关键行动/选择/结果（severity 至少 major）；local=只影响局部阅读复原。",
    },
    missingEvidence: {
      type: "array",
      description: "无关问题时为空数组；否则只填写缺少的现场证据类别，每项必须使用既定枚举。",
      items: {
        type: "string",
        enum: [...READER_RECONSTRUCTION_MISSING_EVIDENCE],
        description: "body=身体，space=空间，object=物件，action=动作，consequence=后果，relationship=关系反馈。",
      },
    },
    blockedQuestion: {
      type: "string",
      description: "无关问题时为空字符串；否则填写普通读者因此无法复原的具体问题，不要写成泛泛的通俗性评价。",
    },
  },
} as const;
