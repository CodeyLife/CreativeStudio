/**
 * V2 结构化输出 JSON Schema 集中模块。
 *
 * 这些 schema 与 v1 [workflow-shared.ts] 的 reviewerSchema/factSchema/auditIssueSchema
 * 等价，但归 v2 独立维护——避免 v2 依赖 v1 的 workflow-shared（v1 模块混杂了大量
 * IndexedDB/WorkflowRun 依赖）。
 *
 * 所有 schema 都遵循 OpenAI strict-mode 要求：
 * - `additionalProperties: false`
 * - 所有字段都在 `required` 中（strict-mode 不支持 optional fields）
 */

import { readerReconstructionStrictSchema } from "../reader-reconstruction-schema";

/** 五大质量维度由三个审校角色覆盖，但不再要求模型逐项评分。 */
export const REVIEW_COVERAGE = {
  "structure-reviewer": ["D1-world", "D2-story"],
  "character-reviewer": ["D3-ensemble", "D4-relationship"],
  "prose-reviewer": ["D2-story", "D5-humor"],
} as const;

export type ReviewerRole = keyof typeof REVIEW_COVERAGE;

const reviewIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "description", "excerpt", "revisionRanges", "rule", "suggestion", "readerReconstruction"],
  properties: {
    severity: { type: "string", enum: ["blocker", "major", "warning"], description: "问题严重程度；只使用 schema 中的字符串枚举" },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    excerpt: { type: "string" },
    revisionRanges: { type: "array", description: "1-based正文段落编号范围，不是字符、token或字节偏移", items: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: { type: "integer", minimum: 1, description: "起始段落编号" }, end: { type: "integer", minimum: 1, description: "结束段落编号" } } } },
    rule: { type: "string", minLength: 1 },
    suggestion: { type: "string", minLength: 1 },
    readerReconstruction: readerReconstructionStrictSchema,
  },
} as const;

export const reviewerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "score", "issues"],
  properties: {
    verdict: { type: "string", enum: ["passed", "revise", "blocked"], description: "审核结论字符串；不要用数字或额外的 passed 布尔字段" },
    score: { type: "number", minimum: 0, maximum: 5, description: "本角色整体质量分，范围 0 到 5" },
    issues: { type: "array", items: reviewIssueSchema },
  },
} as const;

export interface ReviewerOutput {
  verdict: "passed" | "revise" | "blocked";
  score: number;
  issues: Array<{
    severity: "blocker" | "major" | "warning";
    title: string;
    description: string;
    excerpt?: string;
    paragraph?: number;
    revisionRanges: Array<{ start: number; end: number }>;
    rule: string;
    sourceId?: string;
    suggestion: string;
    readerReconstruction: {
      impact: "core" | "local";
      missingEvidence: Array<"body" | "space" | "object" | "action" | "consequence" | "relationship">;
      blockedQuestion: string;
    } | null;
  }>;
}

/**
 * 事实提取 schema：与 v1 [workflow-shared.ts] factSchema 等价。
 *
 * 用于 extractFacts activity，要求 LLM 从章节正文中提取结构化事实。
 */
export const factExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts", "narrativeElements"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "subject",
          "predicate",
          "object",
          "polarity",
          "truthStatus",
          "humanReadable",
          "evidence",
          "confidence",
          "novelty",
          "conflict",
        ],
        properties: {
          subject: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: {
              kind: { enum: ["project", "entity", "relation", "outline", "scene", "thread", "foreshadowing", "timeline"] },
              id: { type: "string", minLength: 1 },
            },
          },
          predicate: { type: "string", minLength: 1 },
          object: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: { enum: ["entity-ref", "string", "number", "boolean", "json"] },
              value: { type: "string", description: "字符串、实体 ID 或规范化 JSON 文本；按 kind 解释" },
            },
          },
          polarity: { enum: ["affirmed", "negated"] },
          truthStatus: { enum: ["objective", "claim", "contested", "open-question"] },
          humanReadable: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          novelty: { enum: ["new", "update", "duplicate"] },
          conflict: { type: "boolean" },
        },
      },
    },
    /** facts 之外的章节级叙事装置：伏笔、承诺和兑现。 */
    narrativeElements: {
      type: "object",
      additionalProperties: false,
      required: ["foreshadowings", "promises", "payoffs"],
      properties: {
        foreshadowings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "anchor", "triggerKeywords", "expectedPayoffWindow", "readerQuestion", "possiblePayoffs", "meaningDelta", "cost", "evidence"],
            properties: {
              description: { type: "string", minLength: 1, description: "伏笔内容描述" },
              // PL-5③：锚点=承载伏笔的正文载体短词（实物/话语/异象名，如"祠堂石阶的裂缝"），
              // 跨轮重抽取措辞再改写、载体不变——登记身份按 (文档, 规范化锚点) 归并。
              anchor: { type: "string", minLength: 1, maxLength: 30, description: "承载本伏笔的正文载体短词（一个名词短语：实物/景象/一句话），不是整句描述" },
              triggerKeywords: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "触发关键词（后续章节兑现时应出现的关键词）",
              },
              // PL-5①写侧：窗口结构化（自由文本 24 形态是 overdue 不可判的根因）。
              // strict json_schema 契约下"可选"= 可空类型联合（properties 必须全 required）。
              //
              // 2026-09-18 实测修正（docs/novel-v2/p1-foreshadowing-survey-20260918.md）：
              // 旧 prompt 给了一个 count:5 的 worked example，导致 168 章实测 494 条可判定条目中
              // 160 条 delta 恰为 10、75 条恰为 5——期限退化为抽取模型的默认值，overdue 告警
              // 因此产生 465 条假阳性而彻底失去信号价值。结构性对策（非词表）：schema 层
              // 明确 null 是合法且首选的不确定表达，prompt 层移除取整示例并标注禁止编造。
              expectedPayoffWindow: {
                type: "object",
                additionalProperties: false,
                required: ["scope", "count", "from", "to", "note"],
                properties: {
                  scope: {
                    type: "string",
                    enum: ["chapters", "volume", "book", "unbounded"],
                    description: "chapters=正文/设计明确给出按章时限；volume/book=卷/全书内；unbounded=时机不明（判断不出时的**正确选择**，不要为填满而选 chapters）",
                  },
                  count: { type: ["integer", "null"], description: "scope=chapters：埋设后 N 章内兑现。须有正文或设计依据，禁止凭印象取整；不确定填 null" },
                  from: { type: ["integer", "null"], description: "scope=chapters：绝对章序范围起，否则 null" },
                  to: { type: ["integer", "null"], description: "scope=chapters：绝对章序范围止/章点，否则 null。须有依据，禁止编造整数" },
                  note: { type: ["string", "null"], maxLength: 24, description: "引自正文的原措辞短语（如“三日内”“本月十五”）；无依据时填 null，不要自造" },
                },
              },
              readerQuestion: { type: "string", description: "读者会自然产生的具体问题；无法确定时留空" },
              possiblePayoffs: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "一个或多个可行的兑现方向，属于设计态而非事实；未确定时为空数组",
              },
              meaningDelta: { type: "string", description: "兑现后相较埋设时预期增加的新意义或变化；无法判断时留空" },
              cost: { type: "string", description: "兑现会改变的关系、资源、真相或人物选择代价；无法判断时留空" },
              evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
            },
          },
        },
        promises: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["promiser", "promisee", "statement", "evidence"],
            properties: {
              promiser: { type: "string", minLength: 1, description: "承诺者（角色名）" },
              promisee: { type: "string", minLength: 1, description: "被承诺者（角色名或‘自己’）" },
              statement: { type: "string", minLength: 1, description: "承诺内容" },
              evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
            },
          },
        },
        payoffs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description", "payoffType", "matchedTriggerKeywords", "matchedForeshadowingIds", "matchedPromiseId", "matchedPromiser", "intensity", "evidence"],
            properties: {
              description: { type: "string", minLength: 1, description: "兑现内容描述" },
              payoffType: { enum: ["foreshadowing", "promise"], description: "兑现类型：伏笔兑现或承诺兑现" },
              matchedTriggerKeywords: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "匹配到的伏笔触发关键词（用于关联到对应 foreshadowing）",
              },
              matchedForeshadowingIds: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "已知开放伏笔的精确 ID；只有明确兑现时填写，不得自行编造 ID",
              },
              matchedPromiseId: { type: "string", description: "已知开放承诺的精确 ID；只有明确兑现时填写，不得自行编造 ID" },
              matchedPromiser: { type: "string", description: "匹配到的承诺者（用于关联到对应 promise）" },
              intensity: { type: "integer", minimum: 0, maximum: 5, description: "兑现强度；0 表示没有可靠强度判断" },
              evidence: { type: "string", minLength: 1, description: "正文逐字证据" },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * V2 事实提取输出类型。
 */
export interface FactExtractionOutput {
  facts: Array<{
    subject: { kind: string; id: string };
    predicate: string;
    object: { kind: string; value: unknown };
    polarity: "affirmed" | "negated";
    truthStatus: "objective" | "claim" | "contested" | "open-question";
    humanReadable: string;
    evidence: string;
    confidence: number;
    novelty: "new" | "update" | "duplicate";
    conflict: boolean;
  }>;
  /** 由 postgres-repository.recordNarrativeElements 写入对应表。 */
  narrativeElements: {
    foreshadowings: Array<{
      description: string;
      /** PL-5③ 锚点：登记身份键成分；旧代输出可缺（退回描述内容键）。 */
      anchor?: string;
      triggerKeywords: string[];
      /** PL-5①：写侧新形态为结构化对象；读侧兼容历史自由文本。 */
      expectedPayoffWindow: string | PayoffWindowStructured;
      readerQuestion?: string;
      possiblePayoffs?: string[];
      meaningDelta?: string;
      cost?: string;
      evidence: string;
    }>;
    promises: Array<{
      promiser: string;
      promisee: string;
      statement: string;
      evidence: string;
    }>;
    payoffs: Array<{
      description: string;
      payoffType: "foreshadowing" | "promise";
      matchedTriggerKeywords?: string[];
      matchedForeshadowingIds?: string[];
      matchedPromiseId?: string;
      matchedPromiser?: string;
      intensity?: number;
      evidence: string;
    }>;
  };
}

/**
 * P1-F4 删除（2026-07-27）：learningAssessmentSchema 是死代码。
 *
 * 原因：实际使用的是 learning-assessment.ts 中的 runtimeLearningAssessmentSchema，
 * 该 schema 更完整（包含 anyOf 强制 mechanism 字段必填、applicableGenres 字段等）。
 * 保留 schemas.ts 中的旧 schema 会让维护者误以为它是有效的，违反 AGENTS.md
 * 「reusable contracts」原则——同一契约不应有两套定义。
 *
 * 历史信息：原 schema 是 assessLearning activity 的早期定义，后被
 * runtimeLearningAssessmentSchema（含 P0-B3 修复）取代但未清理。
 * 若需查找历史 schema，参考 git log 此 commit 之前的版本。
 */

/**
 * 章节记忆提取 schema：用于 chapter memory 创建。
 *
 * 设计依据：AGENTS.md「commit-stage 对新 DocumentRevision 创建 chapter memory」契约。
 * 与 factExtractionSchema 互补：fact 提取细粒度事实，chapter memory 提取章节级高层摘要。
 *
 * LLM 输出 summary/keyEvents/characterStates/unresolvedThreads/emotionalArc 五类结构化字段，
 * 用于长篇跨章节一致性（前 N 章 summary 召回 + 角色状态快照 + 未解决线索追踪）。
 */
export const chapterMemorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "keyEvents", "characterStates", "unresolvedThreads", "emotionalArc"],
  properties: {
    summary: { type: "string", minLength: 80, maxLength: 800 },
    keyEvents: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      maxItems: 20,
    },
    characterStates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "stateSnapshot"],
        properties: {
          characterId: { type: "string", minLength: 1 },
          stateSnapshot: { type: "string", minLength: 1 },
        },
      },
    },
    unresolvedThreads: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    emotionalArc: { type: "string", minLength: 1 },
  },
} as const;

/**
 * V2 章节记忆提取输出类型。
 */
export interface ChapterMemoryOutput {
  summary: string;
  keyEvents: string[];
  characterStates: Array<{ characterId: string; stateSnapshot: string }>;
  unresolvedThreads: string[];
  emotionalArc: string;
}

/**
 * 角色富化（character enrichment）提取 schema：用于 characterEnrichmentStageHandler。
 *
 * 设计依据：AGENTS.md「commitStageHandler → characterEnrichmentStageHandler」契约。
 * 从定稿章节正文中提取角色声部锚点、动机变化、关系变化、知识边界变化，
 * 回写到 entities.payload / relations / memory_claims（knowledgeScope={characterId}），
 * 让 character-reviewer 审校结果能反哺角色档案，避免「只审不能改」的断裂。
 *
 * 设计原则（AGENTS.md「reusable contracts over case-specific examples」）：
 * - prompt 只描述通用提取规则，不嵌入任何题材/类型/角色名 fixture
 * - 不内置网文套路识别（走 craft rule 沉淀）
 */
/**
 * 兑现窗口结构化形态（PL-5①，product-audit-20260910 B2）：写侧 schema 强制，
 * 读侧 parsePayoffWindow 同时接受历史自由文本（新旧统一入口）。scope 词表与
 * narrative-elements.parsePayoffWindow 的结构化分支保持一致。
 */
export interface PayoffWindowStructured {
  scope: "chapters" | "volume" | "book" | "unbounded";
  count?: number | null;
  from?: number | null;
  to?: number | null;
  note?: string | null;
}

/**
 * PL-4（product-audit-20260910 B4）关系谓词受控词表：人类关系的通用短词，跨题材复用，
 * 不含题材/角色特定项；"其他:<标签>"为逃生通道（写入侧把超词表短语归入该通道），
 * "未知"等占位词刻意排除（关系未定应写 delta，不伪装成谓词入库、污染检索槽位）。
 */
export const RELATION_PREDICATE_WORDS = [
  "信任", "不信", "敌对", "友好", "合作", "冲突", "疏远", "依恋",
  "敬畏", "感激", "怨恨", "爱慕", "师徒", "主从", "亲缘", "结盟", "背叛", "提防", "利用",
] as const;

export const characterEnrichmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["characters"],
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["characterId", "voiceAnchor", "motivationDelta", "newKnowledge", "relationDeltas"],
        properties: {
          characterId: { type: "string", minLength: 1 },
          voiceAnchor: {
            type: "object",
            additionalProperties: false,
            required: ["sentenceLength", "vocabulary", "directness", "avoidance"],
            properties: {
              sentenceLength: { type: "string", minLength: 1 },
              vocabulary: { type: "string", minLength: 1 },
              directness: { type: "string", minLength: 1 },
              avoidance: { type: "string", minLength: 1 },
            },
          },
          motivationDelta: { type: "string", minLength: 1 },
          newKnowledge: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description", "evidence"],
              properties: {
                description: { type: "string", minLength: 1, description: "角色获得的最小知识命题" },
                evidence: { type: "string", minLength: 1, description: "支持该知识命题的正文逐字证据" },
              },
            },
          },
          relationDeltas: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["targetCharacterId", "predicate", "delta"],
              properties: {
                targetCharacterId: { type: "string", minLength: 1 },
                // PL-4：谓词受控枚举（人类关系通用词集，跨题材）+ `其他:<标签>` 逃生通道。
                // "未知"类占位词刻意不在枚举内——关系未定写进 delta，不伪装成谓词入库。
                predicate: { type: "string", pattern: `^(${RELATION_PREDICATE_WORDS.join("|")}|其他:.{1,12})$` },
                delta: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * V2 角色富化提取输出类型。
 */
export interface CharacterEnrichmentOutput {
  characters: Array<{
    characterId: string;
    voiceAnchor: {
      sentenceLength: string;
      vocabulary: string;
      directness: string;
      avoidance: string;
    };
    motivationDelta: string;
    newKnowledge: Array<{ description: string; evidence: string }>;
    relationDeltas: Array<{ targetCharacterId: string; predicate: string; delta: string }>;
  }>;
}

/** Facts and narrative elements are the complete fact-extraction contract. */
export type ChapterStateDelta = FactExtractionOutput;

/** Strict model boundary for fact extraction; chapter memory and character deltas use independent calls. */
export interface FactExtractionModelOutput {
  facts: Array<{
    subject: { kind: string; id: string };
    predicate: string;
    object: { kind: string; value: string };
    polarity: "affirmed" | "negated";
    truthStatus: "objective" | "claim" | "contested" | "open-question";
    humanReadable: string;
    evidence: string;
    confidence: number;
    novelty: "new" | "update" | "duplicate";
    conflict: boolean;
  }>;
  narrativeElements: {
    foreshadowings: Array<{ description: string; triggerKeywords: string[]; expectedPayoffWindow: string; readerQuestion?: string; possiblePayoffs?: string[]; meaningDelta?: string; cost?: string; evidence: string }>;
    promises: Array<{ promiser: string; promisee: string; statement: string; evidence: string }>;
    payoffs: Array<{
      description: string;
      payoffType: "foreshadowing" | "promise";
      matchedTriggerKeywords: string[];
      matchedForeshadowingIds: string[];
      matchedPromiseId: string;
      matchedPromiser: string;
      intensity: number;
      evidence: string;
    }>;
  };
}

export const chapterStateDeltaSchema = factExtractionSchema;

/**
 * V2 架构生成（foundation）schema。
 *
 * 设计依据：AGENTS.md「reusable contracts over case-specific examples」+ 架构阶段原则。
 * 用于 generateFoundationWork activity，按 taskKey 生成全书架构产出的不同维度。
 *
 * 通用性原则：
 * - schema 不内置任何题材/类型/角色名 fixture（不识别"程序员穿越"等特定主题）
 * - structuredData 是开放对象，容纳各 taskKey 的差异化结构化数据（人物档案/关系图/时间线等）
 * - sections 提供可读的分节内容，summary 提供摘要，title 提供标题
 * - 各 taskKey 的具体内容由 prompt 指导，schema 只保证结构合法
 *
 * additionalProperties 决策（LLM 生成 schema 原则）：
 * - 顶层与 section/section-item 层均使用 additionalProperties: true
 * - 原因：LLM 在生成复杂结构化产出时，常会附加 metadata/notes/index 等辅助字段。
 *   additionalProperties: false 会把这些视为非法，导致 schema-validation 失败 →
 *   修复循环耗尽 → 跳到下一个 API 候选 → 链尾隐式外部 MCP 兜底（2026-09-07
 *   机制契约：外部 MCP 不再是显式候选，而是所有调用链的隐式链尾兜底；
 *   兜底被认领前任务保持 waiting-external，不产生 workflow failed）。
 * - 允许额外字段不影响核心契约：required 字段（title/summary/sections/structuredData
 *   及 section 的 heading/content、item 的 label/detail）仍被强制校验，类型仍被校验。
 * - 不覆盖：LLM 缺失 required 字段或返回错误类型时仍会失败——这类是内容质量问题，
 *   应由 repair 循环或 prompt 改进解决，不应通过放宽 schema 掩盖。
 *
 * 与 chapterMemorySchema 的区别：
 * - chapterMemory 是章节级高层摘要（单章产出）
 * - foundation 是全书架构产出（project 级，按 taskKey 切分维度）
 */
export const foundationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "sections", "structuredData"],
  properties: {
    title: { type: "string", minLength: 1, description: "本次架构产出标题（如「主要人物档案」「世界观设定」）" },
    summary: { type: "string", minLength: 50, description: "本次架构产出摘要（200-800字，概括核心决策与设计意图）" },
    sections: {
      type: "array",
      description: "架构产出的分节内容（人类可读）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "content", "items"],
        properties: {
          heading: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          items: {
            type: "array",
            description: "分节下的结构化条目（如人物列表、势力列表、章节列表等）",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "detail"],
              properties: {
                label: { type: "string", minLength: 1 },
                detail: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    structuredData: {
      type: "string",
      minLength: 2,
      description: "taskKey 对应 structuredData 的 JSON 文本；应用层解析后恢复为结构化对象",
    },
  },
} as const;

/**
 * V2 架构生成输出类型。
 */
export interface FoundationOutput {
  title: string;
  summary: string;
  sections: Array<{
    heading: string;
    content: string;
    items?: Array<{
      label: string;
      detail: string;
      attributes?: Record<string, unknown>;
    }>;
  }>;
  structuredData: Record<string, unknown>;
}
