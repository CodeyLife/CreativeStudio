import Ajv from "ajv";
import { foundationSchema, type FoundationOutput } from "../prompts/schemas";
import { parseStructuredJson } from "../structured-json";

export const FOUNDATION_TASK_CONTRACTS: Record<string, {
  dataRoot: string;
  requiredPaths: string[];
  qualityFocus: string[];
}> = {
  "project-positioning": {
    dataRoot: "positioning",
    requiredPaths: [
      "bookTitle",
      "sellingPoints",
      "targetReader",
      "coreConflict",
      "activePressureSource",
      "corePromise",
      "protagonistNeed",
      "centralOpposition",
      "emotionalContract",
      "themeQuestion",
    ],
    qualityFocus: ["读者承诺与目标读者", "主角核心矛盾与中央对抗", "情感契约", "主题问题或明确待确认边界"],
  },
  architecture: {
    dataRoot: "architecture",
    requiredPaths: ["structure", "volumes", "povStrategy", "timeSpan"],
    qualityFocus: ["长程层级", "卷级职责", "视角一致性", "节奏与信息释放边界"],
  },
  characters: {
    dataRoot: "characters",
    requiredPaths: ["characters"],
    qualityFocus: ["人物独立欲望", "变化弧", "声部锚点", "人物之间的直接关系"],
  },
  worldview: {
    dataRoot: "worldview",
    requiredPaths: ["geography", "politics", "factions", "rules"],
    qualityFocus: ["规则与代价", "社会纹理", "世界独立运行", "不可违背事实"],
  },
  relations: {
    dataRoot: "relations",
    requiredPaths: ["relations"],
    qualityFocus: ["方向性关系", "关系变化条件", "人物不经过主角的直接关系", "选择后果"],
  },
  "plot-threads": {
    dataRoot: "plotThreads",
    requiredPaths: ["main", "subplots"],
    qualityFocus: ["主线因果", "支线独立价值", "人物与剧情线交叉", "情感线适用性"],
  },
  foreshadowing: {
    dataRoot: "foreshadowings",
    requiredPaths: ["foreshadowings"],
    qualityFocus: ["埋设与触发", "回收窗口", "回收后的意义变化", "不提前消费"],
  },
  timeline: {
    dataRoot: "timeline",
    requiredPaths: ["storyEvents"],
    qualityFocus: ["故事时间与叙事顺序", "硬约束", "事件因果", "时间密度变化"],
  },
  "story-control": {
    dataRoot: "storyControl",
    requiredPaths: ["paceCurve", "payoffDistribution"],
    qualityFocus: ["信息释放", "高潮与缓冲", "读者回报类型", "避免固定节拍"],
  },
  "plot-design": {
    dataRoot: "plotStrategy",
    requiredPaths: [
      "narrativePromises",
      "characterDestinations",
      "longHorizonThreads",
      "informationBoundaries",
      "endingEnvelope",
      "nonNegotiables",
    ],
    qualityFocus: ["长期承诺", "人物终点区间", "终局边界", "适应性修订触发器"],
  },
};

export function foundationRequiredFields(taskKey: string): string[] {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return [];
  return contract.requiredPaths;
}

/**
 * 未知 taskKey 必须是**响的失败**，不是静默的空结果。
 *
 * 根因（2026-10-14 round 44，state-audit §8.42）：本文件里三处对
 * `FOUNDATION_TASK_CONTRACTS[taskKey]` 的查询都用 `if (!contract) return …`
 * 兜底——`foundationRequiredFields` 返回 `[]`、
 * `normalizeFoundationStructuredDataFlat` 原样返回 root、
 * `validateFoundationTaskContract` 返回 `[]`（零错误）。三者合起来的效果是：
 * **一个不存在的 taskKey 会让契约校验"全部通过"**，而调用方看不到任何异常。
 * 这是 round 43 那类缺陷（lookup 失败被静默兜底成空值，于是"找不到"与
 * "确实是空"在下游无法区分）的生产版本——当时是复核脚本的 `?? ""` 把
 * 6 条正确登记判成未登记，这里是 `?? []` 把"未知阶段"判成"契约满足"。
 *
 * 现有两个调用点靠别处的检查兜住：`postgres-repository.ts` 批准路径先抛
 * "规划阶段不存在"，`activities.ts` 的 `work.taskKey ?? ""` 则**没有**这层保护
 * ——空 taskKey 会让生成重试循环里的契约校验静默通过，而这正是 PL-8 注释
 * 要求"与来源无关都必须强制"的那道门。故在最低共享层把它变响：
 * 未知 taskKey 直接抛错，而不是返回一个看起来"校验通过"的空数组。
 */
function requireFoundationContract(taskKey: string): (typeof FOUNDATION_TASK_CONTRACTS)[string] {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) throw new Error(`未知的 Foundation taskKey：${JSON.stringify(taskKey)}（契约查询失败，不得按空契约放行）`);
  return contract;
}

type JsonSchema = Record<string, unknown>;

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const stringOrObjectSchema: JsonSchema = { anyOf: [{ type: "string", minLength: 1 }, { type: "object" }] };
// 默认成员形态 string∪object：校验器激活（PL-8）前这些约束从未真正验证过数据，
// 无证据支持"成员必须是对象"；契约只强制键存在、数组非空与已验证的嵌套结构
// （volumes/rules/destinations 等各自显式给 items），散文列表两可形态都合法。
const nonEmptyArraySchema = (items: JsonSchema = stringOrObjectSchema): JsonSchema => ({ type: "array", minItems: 1, items });
const objectSchema = (required: string[], properties: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: "object",
  additionalProperties: true,
  required,
  properties,
});

const architectureVolumeSchema = objectSchema(
  ["name", "theme", "function", "entryState", "exitState", "pressures", "promiseWindows"],
  {
    name: stringSchema,
    theme: stringSchema,
    function: stringSchema,
    entryState: stringSchema,
    exitState: stringSchema,
    pressures: nonEmptyArraySchema({ type: "string", minLength: 1 }),
    promiseWindows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          promiseRef: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          windowOrdinals: { type: "array", items: { type: "integer", minimum: 1 } },
          window: { type: "string", minLength: 1 },
          payoffWindow: { type: "string", minLength: 1 },
        },
      },
    },
  },
);

const longHorizonThreadSchema = objectSchema(
  ["threadRef", "direction", "closureCondition", "doNotConsumeBefore", "responsibleVolumeOrdinals", "nextResponsibility"],
  {
    threadRef: stringSchema,
    direction: stringSchema,
    closureCondition: stringSchema,
    doNotConsumeBefore: stringSchema,
    responsibleVolumeOrdinals: nonEmptyArraySchema({ type: "integer", minimum: 1 }),
    nextResponsibility: stringSchema,
    coupling: stringSchema,
    mergePoint: stringSchema,
    exitPoint: stringSchema,
    transformPoint: stringSchema,
  },
);

const independentActionSchema = objectSchema(
  ["desire", "choice", "cost", "knowledgeBoundary"],
  {
    desire: stringSchema,
    choice: stringSchema,
    cost: stringSchema,
    knowledgeBoundary: stringOrObjectSchema,
  },
);

const foundationDataSchemas: Record<string, JsonSchema> = {
  "project-positioning": objectSchema(
    ["bookTitle", "sellingPoints", "targetReader", "coreConflict", "activePressureSource", "corePromise", "protagonistNeed", "centralOpposition", "emotionalContract", "themeQuestion"],
    {
      bookTitle: stringSchema,
      sellingPoints: nonEmptyArraySchema({ type: "string", minLength: 1 }),
      targetReader: stringOrObjectSchema,
      coreConflict: stringSchema,
      activePressureSource: stringSchema,
      corePromise: stringOrObjectSchema,
      protagonistNeed: stringSchema,
      centralOpposition: stringSchema,
      emotionalContract: stringOrObjectSchema,
      themeQuestion: stringOrObjectSchema,
    },
  ),
  architecture: objectSchema(["structure", "volumes", "povStrategy", "timeSpan"], {
    structure: stringSchema,
    structureType: { type: "string", enum: ["linear", "tree", "network"] },
    volumes: nonEmptyArraySchema(architectureVolumeSchema),
    povStrategy: stringSchema,
    timeSpan: stringSchema,
    longHorizonBoundaries: stringOrObjectSchema,
  }),
  characters: nonEmptyArraySchema(objectSchema(["id", "name", "role", "motivation", "fear", "voiceAnchor", "arc", "independentAction"], {
    id: stringSchema,
    name: stringSchema,
    role: stringSchema,
    motivation: stringSchema,
    fear: stringSchema,
    // 散文语义字段的合法形态是"文本或结构"两可（模型两种都稳定产出）；校验的价值在
    // 键存在与数组类型，不在猜叶子形态，故用 union。纯 string 字段（role/motivation…）
    // 的 stringSchema 保持收紧。
    voiceAnchor: stringOrObjectSchema,
    arc: stringOrObjectSchema,
    independentAction: independentActionSchema,
  })),
  worldview: objectSchema(["geography", "politics", "factions", "rules"], {
    geography: stringOrObjectSchema,
    politics: stringOrObjectSchema,
    factions: nonEmptyArraySchema(stringOrObjectSchema),
    rules: nonEmptyArraySchema(objectSchema(["statement", "cost", "boundary"], {
      statement: stringSchema,
      cost: stringSchema,
      boundary: stringSchema,
    })),
    resourcesAndTechnology: nonEmptyArraySchema(objectSchema(["name", "distribution", "scarcity", "access"], {
      name: stringSchema,
      distribution: stringSchema,
      scarcity: stringSchema,
      access: stringSchema,
    })),
    valuesAndConflicts: nonEmptyArraySchema(objectSchema(["value", "rewardedBy", "punishedBy", "unequalFor", "consequence"], {
      value: stringSchema,
      rewardedBy: stringSchema,
      punishedBy: stringSchema,
      unequalFor: stringSchema,
      consequence: stringSchema,
    })),
  }),
  relations: nonEmptyArraySchema(objectSchema(["from", "to", "type", "strength", "evolution", "choiceConsequence"], {
    from: stringSchema,
    to: stringSchema,
    type: stringSchema,
    evolution: { type: "object" },
    choiceConsequence: stringSchema,
  })),
  // legacy 任务（五阶段外）：历史数据 main 为字符串列表（见 foundation-contract 测试
  // fixture 复刻的真实形态），校验器激活前该约束从未验证过数据——按实际历史形态放开。
  plotThreads: objectSchema(["main", "subplots"], { main: { anyOf: [{ type: "string", minLength: 1 }, { type: "object" }, { type: "array" }] }, subplots: nonEmptyArraySchema() }),
  foreshadowings: nonEmptyArraySchema(objectSchema(["id", "description", "expectedPayoffWindow"], { id: stringSchema, description: stringSchema, expectedPayoffWindow: stringSchema })),
  timeline: objectSchema(["storyEvents"], { storyEvents: nonEmptyArraySchema() }),
  storyControl: objectSchema(["paceCurve", "payoffDistribution"], { paceCurve: nonEmptyArraySchema(), payoffDistribution: nonEmptyArraySchema() }),
  plotStrategy: objectSchema(["narrativePromises", "characterDestinations", "longHorizonThreads", "informationBoundaries", "endingEnvelope", "nonNegotiables"], {
    narrativePromises: nonEmptyArraySchema({ type: "string", minLength: 1 }),
    characterDestinations: nonEmptyArraySchema(),
    longHorizonThreads: nonEmptyArraySchema(longHorizonThreadSchema),
    informationBoundaries: objectSchema(["hidden", "notDesigned", "open"], {
      hidden: { type: "array", items: { type: "object" } },
      notDesigned: { type: "array", items: { type: "object" } },
      open: { type: "array", items: { type: "object" } },
    }),
    endingEnvelope: stringOrObjectSchema,
    nonNegotiables: nonEmptyArraySchema({ type: "string", minLength: 1 }),
  }),
};

/**
 * Keep the provider-facing envelope compact. Task-specific data schemas are
 * applied after JSON decoding by validateFoundationTaskContract, because
 * native provider schemas do not share one safe vocabulary for nested data.
 *
 * structuredData 根形态（平铺契约）：对象型 task（positioning/architecture/
 * worldview/plotStrategy/plotThreads/timeline/storyControl）的根直接是 task 数据，
 * 不再包一层与 task 同名的容器键；数组型 task（characters/relations/
 * foreshadowings）的数据本质是数组，但 structuredData 根必须是对象，因此保留
 * `{ [collectionKey]: [...] }` 集合容器（provider 与解析层都要求根为对象）。
 */
export function foundationSchemaForTask(taskKey: string): JsonSchema {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return foundationSchema as unknown as JsonSchema;
  const arrayRooted = foundationDataSchemaForTask(taskKey)?.type === "array";
  return {
    ...foundationSchema,
    description: `Foundation ${taskKey} native output; structuredData is JSON text rooted at the task data${arrayRooted ? ` (wrapped in ${contract.dataRoot} collection)` : ""}`,
    properties: {
      ...foundationSchema.properties,
      structuredData: {
        ...(foundationSchema.properties?.structuredData as JsonSchema),
        description: arrayRooted
          ? `JSON text whose root object contains the ${contract.dataRoot} array`
          : `JSON text whose root object is the ${taskKey} task data (do not wrap it in an extra ${contract.dataRoot} key)`,
      },
    },
  };
}

/**
 * 把 provider 返回的 structuredData 根统一为平铺形态（对象型 task）。
 *
 * 契约演进：旧契约要求根包一层与 task 同名的容器键（如 {architecture: {...}}）；
 * 部分 provider（如 GLM-5.2 经第三方中转站）在 strict json_schema 未被严格执行时
 * 会省略该容器键，把 task 字段直接平铺在根上（如 {structure, volumes, ...}）。
 * 新契约以平铺为规范：对象型 task 的根直接承载 task 数据；本函数同时接受
 * 平铺与历史容器两种输入，统一输出平铺，保证校验与落库拿到一致形态。
 *
 * 判定基于纯结构特征（dataRoot 键），跨 provider/题材通用：
 * - 数组型 task（dataRoot 承载集合）：根必须 object，集合容器是技术必需，保持原样
 * - 对象型 task 根含 dataRoot 键（历史容器/模型遵守旧契约）→ 解包返回 root[dataRoot]
 * - 对象型 task 根不含 dataRoot 键 → 已平铺，直接返回
 * - 内容确实缺失时解包后仍是空对象，由契约校验如实报告，不掩盖内容问题
 */
export function normalizeFoundationStructuredDataFlat(root: Record<string, unknown>, taskKey: string): Record<string, unknown> {
  const contract = requireFoundationContract(taskKey);
  if (foundationDataSchemaForTask(taskKey)?.type === "array") return root;
  let flat: Record<string, unknown> = root;
  const container = root[contract.dataRoot];
  if (container && typeof container === "object" && !Array.isArray(container)) {
    flat = container as Record<string, unknown>;
  }
  // 别名迁移（product-audit-20260910 B3/PL-8）：第一代 prompt 的 informationBoundaries 用
  // hiddenInformation/notDesignedYet 键与裸字符串成员；契约规范形态是 {hidden,notDesigned,open}
  // 对象数组（作者秘密对象化：至少含 claim）。结构重命名不改语义，未知键原样保留
  // （additionalProperties 是刻意的前向兼容面）。旧段完全缺键时按"未显式声明"归 []。
  if (taskKey === "plot-design") {
    const boundaries = flat.informationBoundaries;
    if (boundaries && typeof boundaries === "object" && !Array.isArray(boundaries)) {
      const renamed: Record<string, unknown> = { ...(boundaries as Record<string, unknown>) };
      const toMembers = (value: unknown): unknown[] | unknown => Array.isArray(value)
        ? value.map((member) => (typeof member === "string" ? { claim: member } : member))
        : value;
      for (const [legacyKey, canonicalKey] of [["hiddenInformation", "hidden"], ["notDesignedYet", "notDesigned"]] as const) {
        if (renamed[canonicalKey] === undefined && renamed[legacyKey] !== undefined) {
          renamed[canonicalKey] = toMembers(renamed[legacyKey]);
          delete renamed[legacyKey];
        }
      }
      for (const canonicalKey of ["hidden", "notDesigned", "open"] as const) {
        if (renamed[canonicalKey] === undefined) renamed[canonicalKey] = [];
        else renamed[canonicalKey] = toMembers(renamed[canonicalKey]);
      }
      flat = { ...flat, informationBoundaries: renamed };
    }
  }
  // 卷序记法归一（PL-8，纯记法非语义）：契约要求 responsibleVolumeOrdinals 为整数，模型
  // 惯用 "V1"/"卷2"/"第3卷" 指称同一概念（跨题材通用记法，与 hiddenInformation 别名同类）。
  // 可无损映射整数的成员归一；映射不了的保留原值交校验如实报告。刻意**不**修 narrativePromises
  // 装错容器、coupling 对象等真·内容缺陷——那属语义问题，自动拍平会制造"通过校验的垃圾"，
  // 由 stale-foundation-contract 暴露给作者/重新生成回路处理。
  const volumeOrdinal = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value !== "string") return null;
    const bare = /^\d+$/u.exec(value) ? value : null;
    const prefixed = /^[Vv]\s*(\d+)$/.exec(value)?.[1] ?? /^卷\s*(\d+)$/.exec(value)?.[1] ?? /^第\s*(\d+)\s*卷$/.exec(value)?.[1];
    const resolved = bare ?? prefixed;
    return resolved ? Number(resolved) : null;
  };
  if (taskKey === "plot-design" && Array.isArray(flat.longHorizonThreads)) {
    flat = {
      ...flat,
      longHorizonThreads: (flat.longHorizonThreads as unknown[]).map((thread) => {
        if (!thread || typeof thread !== "object" || Array.isArray(thread)) return thread;
        const item = thread as Record<string, unknown>;
        if (!Array.isArray(item.responsibleVolumeOrdinals)) return thread;
        const members = (item.responsibleVolumeOrdinals as unknown[]).map((entry) => volumeOrdinal(entry) ?? entry);
        const allNumeric = members.every((entry) => typeof entry === "number");
        return allNumeric ? { ...item, responsibleVolumeOrdinals: members } : thread;
      }),
    };
  }
  return flat;
}

/** Decode the compact native boundary; object-rooted tasks are flattened to the task data. */
export function normalizeFoundationModelOutput(value: unknown, taskKey?: string): FoundationOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Foundation 输出必须是对象");
  const source = value as Record<string, unknown>;
  const structuredData = typeof source.structuredData === "string"
    ? (() => {
      const parsed = parseStructuredJson(source.structuredData);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("structuredData JSON 根必须是对象");
      return parsed as Record<string, unknown>;
    })()
    : source.structuredData && typeof source.structuredData === "object" && !Array.isArray(source.structuredData)
      ? source.structuredData as Record<string, unknown>
      : undefined;
  if (!structuredData) throw new Error("Foundation structuredData 缺失");
  const containerData = taskKey ? normalizeFoundationStructuredDataFlat(structuredData, taskKey) : structuredData;
  return {
    title: typeof source.title === "string" ? source.title : "",
    summary: typeof source.summary === "string" ? source.summary : "",
    sections: Array.isArray(source.sections) ? source.sections.map((section) => {
      const item = section && typeof section === "object" && !Array.isArray(section) ? section as Record<string, unknown> : {};
      return {
        heading: typeof item.heading === "string" ? item.heading : "",
        content: typeof item.content === "string" ? item.content : "",
        items: Array.isArray(item.items) ? item.items.map((entry) => {
          const row = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
          return { label: typeof row.label === "string" ? row.label : "", detail: typeof row.detail === "string" ? row.detail : "", ...(row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes) ? { attributes: row.attributes as Record<string, unknown> } : {}) };
        }) : [],
      };
    }) : [],
    structuredData: containerData,
  };
}

function valueAt(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, root);
}

function meaningful(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function validateNotApplicableAnnotation(value: unknown, path: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.notApplicable !== true || !meaningful(record.rationale)) {
    errors.push(`${path} 的不适用标记必须包含 notApplicable=true 和 rationale`);
  }
}

function validateRepeatedEntries(taskKey: string, structuredData: Record<string, unknown>, errors: string[]): void {
  const collectionKey = taskKey === "characters" ? "characters"
    : taskKey === "relations" ? "relations"
      : taskKey === "foreshadowing" ? "foreshadowings"
        : undefined;
  if (!collectionKey) return;
  const collection = structuredData[collectionKey];
  if (!Array.isArray(collection) || collection.length === 0) return;
  const requiredByTask: Record<string, string[]> = {
    characters: ["id", "name", "role", "motivation", "fear", "voiceAnchor", "arc", "independentAction"],
    relations: ["from", "to", "type", "strength", "evolution", "choiceConsequence"],
    foreshadowing: ["id", "description", "expectedPayoffWindow"],
  };
  for (const [index, entry] of collection.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${collectionKey}[${index}] 必须是对象`);
      continue;
    }
    for (const key of requiredByTask[taskKey] ?? []) {
      if (!meaningful((entry as Record<string, unknown>)[key])) errors.push(`${collectionKey}[${index}].${key} 不能为空`);
    }
    if (taskKey === "characters") {
      const action = (entry as Record<string, unknown>).independentAction;
      const actionRecord = action && typeof action === "object" && !Array.isArray(action) ? action as Record<string, unknown> : undefined;
      for (const key of ["desire", "choice", "cost", "knowledgeBoundary"]) {
        if (!meaningful(actionRecord?.[key])) errors.push(`${collectionKey}[${index}].independentAction.${key} 不能为空`);
      }
    }
  }
}

function validateWorldviewRules(structuredData: Record<string, unknown>, errors: string[]): void {
  const rules = structuredData.rules;
  if (!Array.isArray(rules)) return;
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`worldview.rules[${index}] 必须包含 statement、cost 和 boundary`);
      continue;
    }
    const record = rule as Record<string, unknown>;
    for (const key of ["statement", "cost", "boundary"]) {
      if (!meaningful(record[key])) errors.push(`worldview.rules[${index}].${key} 不能为空`);
    }
  }
}

function validateArchitectureVolumes(structuredData: Record<string, unknown>, errors: string[]): void {
  const volumes = structuredData.volumes;
  if (!Array.isArray(volumes)) return;
  for (const [index, volume] of volumes.entries()) {
    if (!volume || typeof volume !== "object" || Array.isArray(volume)) {
      errors.push(`architecture.volumes[${index}] 必须包含卷级状态、压力和承诺窗口`);
      continue;
    }
    const entry = volume as Record<string, unknown>;
    for (const key of ["entryState", "exitState", "pressures", "promiseWindows"]) {
      const valid = key === "promiseWindows" ? Array.isArray(entry[key]) : meaningful(entry[key]);
      if (!valid) errors.push(`architecture.volumes[${index}].${key} 不能为空`);
    }
  }
}

/** Resolve the task data schema by taskKey or its dataRoot container key. */
export function foundationDataSchemaForTask(taskKey: string): JsonSchema | undefined {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  return foundationDataSchemas[taskKey] ?? (contract ? foundationDataSchemas[contract.dataRoot] : undefined);
}

/**
 * 契约内容指纹（PL-8）：批准时落进 section payload，health 重算对比——契约（requiredPaths
 * + data schema + 别名迁移）一旦演进，旧的 approved 段即报 `approved-but-stale-contract`，
 * 让"契约演进无痕迹"（审计 B3：校验修了没人知道哪些段是修复前批的）变成可观测状态。
 * 无手写版本号，自动追踪代码演进。
 * 实现位于 ./foundation-contract-fingerprint（sha256 依赖 node:crypto，本模块会被
 * workflow 沙箱打包，禁止顶层引入 node:crypto——2026-09-08 与 2026-09-11 两次实证）。
 */

/** Validate semantic fields that generic foundationSchema cannot express. */
export function validateFoundationTaskContract(value: FoundationOutput, taskKey: string): string[] {
  const contract = requireFoundationContract(taskKey);
  const errors: string[] = [];
  const structuredData = normalizeFoundationStructuredDataFlat(value.structuredData ?? {}, taskKey);
  const taskDataSchema = foundationDataSchemaForTask(taskKey);
  if (taskDataSchema) {
    const arrayRooted = taskDataSchema.type === "array";
    const validate = new Ajv({ allErrors: true, strict: false }).compile(arrayRooted
      ? { type: "object", additionalProperties: true, required: [contract.dataRoot], properties: { [contract.dataRoot]: taskDataSchema } }
      : taskDataSchema);
    // 根因修复（product-audit-20260910 B3/PL-8）：此前 compile 后从未调用，未调用的
    // validator 的 errors 恒为 undefined——schema 层校验自落地起即为死代码，键名漂移、
    // 类型错误（integer 数组装 "V1"）、子对象缺键全部静默放行。必须真正执行。
    validate(structuredData);
    for (const issue of validate.errors ?? []) {
      const missingRoot = arrayRooted
        && issue.keyword === "required"
        && issue.instancePath === ""
        && (issue.params as { missingProperty?: string }).missingProperty === contract.dataRoot;
      if (missingRoot) continue;
      const location = issue.instancePath || `.${contract.dataRoot}`;
      errors.push(`structuredData${location} ${issue.message ?? "结构不符合任务契约"}`);
    }
  }
  for (const path of contract.requiredPaths) {
    if (!meaningful(valueAt(structuredData, path))) errors.push(`${path} 不能为空`);
  }
  if (taskKey === "project-positioning") {
    validateNotApplicableAnnotation(valueAt(structuredData, "themeQuestion"), "themeQuestion", errors);
    validateNotApplicableAnnotation(valueAt(structuredData, "emotionalContract"), "emotionalContract", errors);
  }
  validateRepeatedEntries(taskKey, structuredData, errors);
  if (taskKey === "worldview") validateWorldviewRules(structuredData, errors);
  if (taskKey === "architecture") validateArchitectureVolumes(structuredData, errors);
  if (taskKey === "plot-design") {
    // 根因修复（2026-08-06）：模型多次输出对象形式的 characterDestinations
    //（{ ChuHeng: {...} }），而契约与 full-book-architecture 审计都要求数组
    //（每项含 characterRef）。provider 的 strict json_schema 可能被第三方中转站忽略，
    // 因此在此处做本地强校验，确保生成时对象形式即被拦截。
    const destinations = valueAt(structuredData, "plotStrategy.characterDestinations") ?? structuredData.characterDestinations;
    if (destinations !== undefined && !Array.isArray(destinations)) {
      errors.push("plotStrategy.characterDestinations 必须是数组（每项含 characterRef 规范人物 ID 与 endingRange）");
    } else if (Array.isArray(destinations)) {
      for (const [index, entry] of destinations.entries()) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || !meaningful((entry as Record<string, unknown>).characterRef)) {
          errors.push(`plotStrategy.characterDestinations[${index}].characterRef 不能为空`);
        }
      }
    }
  }
  return errors;
}

export function assertFoundationTaskContract(value: FoundationOutput, taskKey: string): void {
  const errors = validateFoundationTaskContract(value, taskKey);
  if (errors.length) throw new Error(`${taskKey} foundation 结构契约不完整：${errors.join("；")}`);
}
