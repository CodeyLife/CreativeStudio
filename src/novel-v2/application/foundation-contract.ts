import Ajv from "ajv";
import { foundationSchema, type FoundationOutput } from "../prompts/schemas";

export const FOUNDATION_TASK_CONTRACTS: Record<string, {
  dataRoot: string;
  requiredPaths: string[];
  qualityFocus: string[];
}> = {
  "project-positioning": {
    dataRoot: "positioning",
    requiredPaths: [
      "positioning.bookTitle",
      "positioning.sellingPoints",
      "positioning.targetReader",
      "positioning.coreConflict",
      "positioning.activePressureSource",
      "positioning.corePromise",
      "positioning.protagonistNeed",
      "positioning.centralOpposition",
      "positioning.emotionalContract",
      "positioning.themeQuestion",
    ],
    qualityFocus: ["读者承诺与目标读者", "主角核心矛盾与中央对抗", "情感契约", "主题问题或明确待确认边界"],
  },
  architecture: {
    dataRoot: "architecture",
    requiredPaths: ["architecture.structure", "architecture.volumes", "architecture.povStrategy", "architecture.timeSpan"],
    qualityFocus: ["长程层级", "卷级职责", "视角一致性", "节奏与信息释放边界"],
  },
  characters: {
    dataRoot: "characters",
    requiredPaths: ["characters"],
    qualityFocus: ["人物独立欲望", "变化弧", "声部锚点", "人物之间的直接关系"],
  },
  worldview: {
    dataRoot: "worldview",
    requiredPaths: ["worldview.geography", "worldview.politics", "worldview.factions", "worldview.rules"],
    qualityFocus: ["规则与代价", "社会纹理", "世界独立运行", "不可违背事实"],
  },
  relations: {
    dataRoot: "relations",
    requiredPaths: ["relations"],
    qualityFocus: ["方向性关系", "关系变化条件", "人物不经过主角的直接关系", "选择后果"],
  },
  "plot-threads": {
    dataRoot: "plotThreads",
    requiredPaths: ["plotThreads.main", "plotThreads.subplots"],
    qualityFocus: ["主线因果", "支线独立价值", "人物与剧情线交叉", "情感线适用性"],
  },
  foreshadowing: {
    dataRoot: "foreshadowings",
    requiredPaths: ["foreshadowings"],
    qualityFocus: ["埋设与触发", "回收窗口", "回收后的意义变化", "不提前消费"],
  },
  timeline: {
    dataRoot: "timeline",
    requiredPaths: ["timeline.storyEvents"],
    qualityFocus: ["故事时间与叙事顺序", "硬约束", "事件因果", "时间密度变化"],
  },
  "story-control": {
    dataRoot: "storyControl",
    requiredPaths: ["storyControl.paceCurve", "storyControl.payoffDistribution"],
    qualityFocus: ["信息释放", "高潮与缓冲", "读者回报类型", "避免固定节拍"],
  },
  "plot-design": {
    dataRoot: "plotStrategy",
    requiredPaths: [
      "plotStrategy.narrativePromises",
      "plotStrategy.characterDestinations",
      "plotStrategy.longHorizonThreads",
      "plotStrategy.informationBoundaries",
      "plotStrategy.endingEnvelope",
      "plotStrategy.nonNegotiables",
    ],
    qualityFocus: ["长期承诺", "人物终点区间", "终局边界", "适应性修订触发器"],
  },
};

export function foundationRequiredFields(taskKey: string): string[] {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return [];
  const prefix = `${contract.dataRoot}.`;
  return contract.requiredPaths.map((path) => path.startsWith(prefix) ? path.slice(prefix.length) : path);
}

type JsonSchema = Record<string, unknown>;

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const stringOrObjectSchema: JsonSchema = { anyOf: [{ type: "string", minLength: 1 }, { type: "object" }] };
const nonEmptyArraySchema = (items: JsonSchema = { type: "object" }): JsonSchema => ({ type: "array", minItems: 1, items });
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
    longHorizonBoundaries: { type: "object" },
  }),
  characters: nonEmptyArraySchema(objectSchema(["id", "name", "role", "motivation", "fear", "voiceAnchor", "arc", "independentAction"], {
    id: stringSchema,
    name: stringSchema,
    role: stringSchema,
    motivation: stringSchema,
    fear: stringSchema,
    voiceAnchor: { type: "object" },
    arc: { type: "object" },
    independentAction: independentActionSchema,
  })),
  worldview: objectSchema(["geography", "politics", "factions", "rules"], {
    geography: { type: "object" },
    politics: { type: "object" },
    factions: nonEmptyArraySchema(),
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
  plotThreads: objectSchema(["main", "subplots"], { main: { type: "object" }, subplots: nonEmptyArraySchema() }),
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
    endingEnvelope: { type: "object" },
    nonNegotiables: nonEmptyArraySchema({ type: "string", minLength: 1 }),
  }),
};

/**
 * Keep the provider-facing envelope compact. Task-specific data schemas are
 * applied after JSON decoding by validateFoundationTaskContract, because
 * native provider schemas do not share one safe vocabulary for nested data.
 */
export function foundationSchemaForTask(taskKey: string): JsonSchema {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return foundationSchema as unknown as JsonSchema;
  return {
    ...foundationSchema,
    description: `Foundation ${taskKey} native output; structuredData is JSON text rooted at ${contract.dataRoot}`,
    properties: {
      ...foundationSchema.properties,
      structuredData: {
        ...(foundationSchema.properties?.structuredData as JsonSchema),
        description: `JSON text whose root object contains ${contract.dataRoot}`,
      },
    },
  };
}

/** Decode the compact native boundary without changing the persisted contract. */
export function normalizeFoundationModelOutput(value: unknown): FoundationOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Foundation 输出必须是对象");
  const source = value as Record<string, unknown>;
  const structuredData = typeof source.structuredData === "string"
    ? (() => {
      try {
        const parsed = JSON.parse(source.structuredData);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("structuredData JSON 根必须是对象");
        return parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Foundation structuredData JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
    })()
    : source.structuredData && typeof source.structuredData === "object" && !Array.isArray(source.structuredData)
      ? source.structuredData as Record<string, unknown>
      : undefined;
  if (!structuredData) throw new Error("Foundation structuredData 缺失");
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
    structuredData,
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
  const worldview = structuredData.worldview;
  if (!worldview || typeof worldview !== "object" || Array.isArray(worldview)) return;
  const rules = (worldview as Record<string, unknown>).rules;
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
  const architecture = structuredData.architecture;
  if (!architecture || typeof architecture !== "object" || Array.isArray(architecture)) return;
  const volumes = (architecture as Record<string, unknown>).volumes;
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

/** Validate semantic fields that generic foundationSchema cannot express. */
export function validateFoundationTaskContract(value: FoundationOutput, taskKey: string): string[] {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return [];
  const errors: string[] = [];
  const structuredData = value.structuredData ?? {};
  const taskDataSchema = foundationDataSchemas[taskKey];
  if (taskDataSchema) {
    const validate = new Ajv({ allErrors: true, strict: false }).compile({
      type: "object",
      additionalProperties: true,
      required: [contract.dataRoot],
      properties: { [contract.dataRoot]: taskDataSchema },
    });
    for (const issue of validate.errors ?? []) {
      const missingRoot = issue.keyword === "required"
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
    validateNotApplicableAnnotation(valueAt(structuredData, "positioning.themeQuestion"), "positioning.themeQuestion", errors);
    validateNotApplicableAnnotation(valueAt(structuredData, "positioning.emotionalContract"), "positioning.emotionalContract", errors);
  }
  validateRepeatedEntries(taskKey, structuredData, errors);
  if (taskKey === "worldview") validateWorldviewRules(structuredData, errors);
  if (taskKey === "architecture") validateArchitectureVolumes(structuredData, errors);
  return errors;
}

export function assertFoundationTaskContract(value: FoundationOutput, taskKey: string): void {
  const errors = validateFoundationTaskContract(value, taskKey);
  if (errors.length) throw new Error(`${taskKey} foundation 结构契约不完整：${errors.join("；")}`);
}
