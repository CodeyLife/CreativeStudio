import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { foundationSchemaForTask, normalizeFoundationModelOutput, normalizeFoundationStructuredDataFlat, validateFoundationTaskContract } from "../application/foundation-contract";
import { foundationContractFingerprint } from "../application/foundation-contract-fingerprint";
import type { FoundationOutput } from "../prompts/schemas";

const output = (structuredData: Record<string, unknown>): FoundationOutput => ({
  title: "规划",
  summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向和后续修订边界。",
  sections: [],
  structuredData,
});

describe("foundation task semantic contracts", () => {
  it("accepts the required structured anchors for all ten tasks (flat root for object tasks)", () => {
    const fixtures: Record<string, Record<string, unknown>> = {
      "project-positioning": { bookTitle: "长夜归舟", sellingPoints: ["关系悬疑"], targetReader: "成年悬疑读者", coreConflict: "追查与自保", activePressureSource: "制度追责", corePromise: "每次揭示都改变关系", protagonistNeed: "承认失去", centralOpposition: "沉默的共同体", emotionalContract: "克制但有回响", themeQuestion: { notApplicable: true, rationale: "主题保留到故事弧中处理" } },
      architecture: { structure: "三卷递进", volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }, { name: "对抗", theme: "承担", function: "公开后果", entryState: "开始追查", exitState: "承担结果", pressures: ["关系破裂"], promiseWindows: [] }], povStrategy: "限知视角", timeSpan: "两年" },
      characters: { characters: [{ id: "p1", name: "甲", role: "主角", motivation: "查清旧案", fear: "失去最后的亲人", voiceAnchor: { sentenceLength: "短句", vocabulary: "克制", directness: "间接", avoidance: "回避承诺" }, arc: "从逃避到承担", independentAction: { desire: "保护证据", choice: "拒绝交易", cost: "失去职位", knowledgeBoundary: "不知道幕后交易的完整参与者" } }] },
      worldview: { geography: "沿江城市", politics: "地方机构", factions: ["调查组"], rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }] },
      relations: { relations: [{ from: "甲", to: "乙", type: "互相利用", strength: "脆弱", evolution: { from: "利用", to: "合作", trigger: "共同承担风险" }, choiceConsequence: "任一方退出都会失去翻案机会" }] },
      "plot-threads": { main: ["查案"], subplots: ["家庭关系"] },
      foreshadowing: { foreshadowings: [{ id: "f1", description: "旧照片缺角", expectedPayoffWindow: "第二卷末" }] },
      timeline: { storyEvents: ["归乡", "发现照片"] },
      "story-control": { paceCurve: ["缓", "紧"], payoffDistribution: ["关系回报", "真相回报"] },
      "plot-design": { narrativePromises: ["真相改变关系"], characterDestinations: [{ characterRef: "p1", endingRange: "承担后果" }], longHorizonThreads: [{ threadRef: "main", direction: "查明真相", closureCondition: "公开真相", doNotConsumeBefore: "后期", responsibleVolumeOrdinals: [1, 2], nextResponsibility: "在第二阶段公开证据" }], informationBoundaries: { hidden: [], notDesigned: [], open: [] }, endingEnvelope: "开放但不否定代价", nonNegotiables: ["不抹除已付出的代价"] },
    };
    for (const [taskKey, structuredData] of Object.entries(fixtures)) {
      expect(validateFoundationTaskContract(output(structuredData), taskKey), taskKey).toEqual([]);
    }
  });

  it("accepts legacy container-shaped structuredData as well", () => {
    // 历史容器形态 { architecture: {...} } 在契约校验入口被解包为平铺，仍通过
    const value = output({ architecture: { structure: "三卷递进", volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }], povStrategy: "限知视角", timeSpan: "两年" } });
    expect(validateFoundationTaskContract(value, "architecture")).toEqual([]);
  });

  /**
   * 未知 taskKey 必须**响**，不能静默返回空契约（2026-10-14 round 44，state-audit §8.42）。
   *
   * 根因：本模块三处 `FOUNDATION_TASK_CONTRACTS[taskKey]` 查询都用 `if (!contract) return …`
   * 兜底——`foundationRequiredFields`→`[]`、`normalizeFoundationStructuredDataFlat`→原样 root、
   * `validateFoundationTaskContract`→`[]`（零错误）。合起来的效果是：
   * **一个不存在的 taskKey 会让契约校验"全部通过"**，调用方看不到任何异常。
   *
   * 这是 round 43 那类缺陷的生产版本：当时是复核脚本的 `?? ""` 把 6 条正确登记判成未登记，
   * 这里是 `?? []` 把"未知阶段"判成"契约满足"。后果更重——PL-8 注释明确要求契约强制
   * "与来源无关"，而 `activities.ts` 的 `work.taskKey ?? ""`（taskKey 在 work-item 协议里
   * 是可选的）原本没有别处的保护。
   *
   * 双向覆盖：未知/空 taskKey 必须抛错；已知 taskKey 必须照常工作（不能误伤）。
   */
  describe("未知 taskKey 不得静默放行（round 44）", () => {
    it("对未知 taskKey 抛错，而不是返回空契约", () => {
      expect(() => validateFoundationTaskContract(output({}), "no-such-task"), "未知 taskKey 必须抛错").toThrow(/未知的 Foundation taskKey/);
      expect(() => validateFoundationTaskContract(output({}), ""), "空 taskKey 必须抛错").toThrow(/未知的 Foundation taskKey/);
      expect(() => normalizeFoundationModelOutput({ title: "t", summary: "s", structuredData: "{}" }, "no-such-task")).toThrow(/未知的 Foundation taskKey/);
    });

    it("已知 taskKey 照常校验（守卫不误伤）", () => {
      const architecture = { structure: "三卷递进", volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }], povStrategy: "限知视角", timeSpan: "两年" };
      expect(validateFoundationTaskContract(output(architecture), "architecture")).toEqual([]);
      const normalized = normalizeFoundationModelOutput({ title: "t", summary: "s", structuredData: JSON.stringify(architecture) }, "architecture");
      expect(validateFoundationTaskContract(normalized, "architecture")).toEqual([]);
    });
  });

  it("rejects a positioning artifact when the creation promise is only in prose", () => {
    const value = output({ bookTitle: "长夜归舟", sellingPoints: ["悬疑"], targetReader: "读者", coreConflict: "追查", activePressureSource: "追责", protagonistNeed: "真相", centralOpposition: "制度", emotionalContract: "克制", themeQuestion: "真相是否值得代价" });
    expect(validateFoundationTaskContract(value, "project-positioning")).toContain("corePromise 不能为空");
  });

  it("requires a rationale for explicit not-applicable positioning fields", () => {
    const value = output({ bookTitle: "长夜归舟", sellingPoints: ["悬疑"], targetReader: "读者", coreConflict: "追查", activePressureSource: "追责", corePromise: "真相会改变关系", protagonistNeed: "真相", centralOpposition: "制度", emotionalContract: { notApplicable: true }, themeQuestion: { notApplicable: true, rationale: "保留为空" } });
    expect(validateFoundationTaskContract(value, "project-positioning")).toContain("emotionalContract 的不适用标记必须包含 notApplicable=true 和 rationale");
  });

  it("rejects incomplete repeated entries instead of accepting an empty row", () => {
    const value = output({ characters: [{ id: "p1", name: "甲", role: "配角", motivation: "", fear: "", voiceAnchor: {}, arc: "", independentAction: {} }] });
    expect(validateFoundationTaskContract(value, "characters")).toEqual(expect.arrayContaining([
      "characters[0].motivation 不能为空",
      "characters[0].arc 不能为空",
      "characters[0].independentAction.desire 不能为空",
      "characters[0].independentAction.knowledgeBoundary 不能为空",
    ]));
  });

  it("accepts optional thread coupling and lifecycle fields and explicit structure type", () => {
    const structuredData = {
      structure: "网状群像", structureType: "network", volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }], povStrategy: "限知视角", timeSpan: "两年",
    };
    expect(validateFoundationTaskContract(output(structuredData), "architecture")).toEqual([]);

    const plotData = output({ narrativePromises: ["真相改变关系"], characterDestinations: [{ characterRef: "p1", endingRange: "承担后果" }], longHorizonThreads: [{ threadRef: "side", direction: "调查失踪者", closureCondition: "查明去向", doNotConsumeBefore: "中期", responsibleVolumeOrdinals: [2], nextResponsibility: "与主线交汇前确认线索", coupling: "改变人物认知", mergePoint: "第二卷中段", exitPoint: "第二卷末", transformPoint: "真相公开后并入责任线" }], informationBoundaries: { hidden: [], notDesigned: [], open: [] }, endingEnvelope: "开放但不否定代价", nonNegotiables: ["不抹除已付出的代价"] });
    expect(validateFoundationTaskContract(plotData, "plot-design")).toEqual([]);
  });

  it("keeps legacy threads without coupling fields valid", () => {
    const value = output({ narrativePromises: ["真相"], characterDestinations: [{ characterRef: "p1", endingRange: "承担后果" }], longHorizonThreads: [{ threadRef: "main", direction: "查明", closureCondition: "完成", doNotConsumeBefore: "后期", responsibleVolumeOrdinals: [1], nextResponsibility: "下一阶段推进" }], informationBoundaries: { hidden: [], notDesigned: [], open: [] }, endingEnvelope: "开放", nonNegotiables: ["保留代价"] });
    expect(validateFoundationTaskContract(value, "plot-design")).toEqual([]);
  });

  it("accepts optional worldview pressure layers and keeps legacy worldview valid", () => {
    const layered = output({ geography: "沿江城市", politics: "地方机构", factions: ["调查组"], rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }], resourcesAndTechnology: [{ name: "卷宗权限", distribution: "集中在核心机构", scarcity: "普通调查者无法调取", access: "需要担保与审批" }], valuesAndConflicts: [{ value: "真相优先于人情", rewardedBy: "升职与信任", punishedBy: "孤立与排挤", unequalFor: "底层调查者", consequence: "多数人选择沉默" }] });
    expect(validateFoundationTaskContract(layered, "worldview")).toEqual([]);

    const legacy = output({ geography: "沿江城市", politics: "地方机构", factions: ["调查组"], rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }] });
    expect(validateFoundationTaskContract(legacy, "worldview")).toEqual([]);
  });

  it("keeps the native envelope compact and validates task data after decoding", () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(foundationSchemaForTask("architecture"));
    const base = { title: "架构", summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。", sections: [] };
    expect(validate({ ...base, structuredData: { structure: {} } })).toBe(false);

    const validStructuredData = { structure: "三卷递进", volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }], povStrategy: "限知", timeSpan: "两年" };
    expect(validate({ ...base, structuredData: JSON.stringify(validStructuredData) })).toBe(true);
    expect(validateFoundationTaskContract(normalizeFoundationModelOutput({ ...base, structuredData: JSON.stringify(validStructuredData) }), "architecture")).toEqual([]);

    const wrongRoot = normalizeFoundationModelOutput({ ...base, structuredData: JSON.stringify({ positioning: validStructuredData }) });
    expect(validateFoundationTaskContract(wrongRoot, "architecture")).toContain("structure 不能为空");
  });

  it("does not misjudge string-shaped structuredData as empty and normalizes before task validation", () => {
    const raw = {
      title: "架构",
      summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。",
      sections: [],
      structuredData: JSON.stringify({ structure: "三卷递进", volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }], povStrategy: "限知视角", timeSpan: "两年" }),
    };
    // generateStructured 的 parsed 保留 string structuredData；直接校验会全部误判为空
    expect(validateFoundationTaskContract(raw as unknown as FoundationOutput, "architecture")).toContain("structure 不能为空");
    // 先 normalize 再校验才是正确路径
    expect(validateFoundationTaskContract(normalizeFoundationModelOutput(raw), "architecture")).toEqual([]);
  });

  it("keeps a flat structuredData root flat when taskKey is known (canonical contract)", () => {
    // 规范契约：architecture 字段直接平铺在根上，不再包容器键
    const raw = {
      title: "架构",
      summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。",
      sections: [],
      structuredData: JSON.stringify({
        structure: "三卷递进",
        structureType: "linear",
        volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }],
        povStrategy: "限知视角",
        timeSpan: "两年",
      }),
    };
    const normalized = normalizeFoundationModelOutput(raw, "architecture");
    expect(normalized.structuredData).toEqual({
      structure: "三卷递进",
      structureType: "linear",
      volumes: [{ name: "寻找", theme: "查明", function: "建立问题", entryState: "未知", exitState: "开始追查", pressures: ["制度追责"], promiseWindows: [] }],
      povStrategy: "限知视角",
      timeSpan: "两年",
    });
    expect(validateFoundationTaskContract(normalized, "architecture")).toEqual([]);
  });

  it("unwraps a legacy container-shaped structuredData root when taskKey is known", () => {
    // 模型/旧数据仍可能返回容器形态 { architecture: {...} }；解包为平铺后校验与落库一致
    const raw = {
      title: "世界观",
      summary: "这是一段足够长的规划摘要，用于说明地理、政治、势力与规则的边界，以及世界独立运行的方式。",
      sections: [],
      structuredData: JSON.stringify({
        worldview: {
          geography: "沿江城市",
          politics: "地方机构",
          factions: ["调查组"],
          rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }],
        },
      }),
    };
    const normalized = normalizeFoundationModelOutput(raw, "worldview");
    expect(Object.keys(normalized.structuredData).sort()).toEqual(["factions", "geography", "politics", "rules"]);
    expect(validateFoundationTaskContract(normalized, "worldview")).toEqual([]);
  });

  it("does not mask genuinely missing content inside a flat root", () => {
    // 平铺但缺 volumes/povStrategy/timeSpan：契约校验仍如实报告缺失
    const raw = {
      title: "架构",
      summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。",
      sections: [],
      structuredData: JSON.stringify({ structure: "三卷递进" }),
    };
    const normalized = normalizeFoundationModelOutput(raw, "architecture");
    expect(normalized.structuredData).toEqual({ structure: "三卷递进" });
    expect(validateFoundationTaskContract(normalized, "architecture")).toEqual(expect.arrayContaining([
      "volumes 不能为空",
      "povStrategy 不能为空",
      "timeSpan 不能为空",
    ]));
  });

  it("does not unwrap a root that belongs to a different task's container", () => {
    // 根是 positioning 容器（错 task），对 architecture 任务不得误解包为 architecture
    const raw = {
      title: "架构",
      summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。",
      sections: [],
      structuredData: JSON.stringify({ positioning: { bookTitle: "长夜归舟" } }),
    };
    const normalized = normalizeFoundationModelOutput(raw, "architecture");
    expect(normalized.structuredData).toEqual({ positioning: { bookTitle: "长夜归舟" } });
    expect(validateFoundationTaskContract(normalized, "architecture")).toContain("structure 不能为空");
  });

  it("keeps legacy behavior when no taskKey is provided (no unwrapping)", () => {
    const flat = {
      title: "架构",
      summary: "这是一段足够长的规划摘要，用于说明结构决策、冲突来源、人物方向、信息释放、卷级职责、视角边界、时间跨度和后续修订边界。",
      sections: [],
      structuredData: JSON.stringify({ structure: "三卷递进", volumes: [], povStrategy: "限知视角", timeSpan: "两年" }),
    };
    expect(normalizeFoundationModelOutput(flat).structuredData).toEqual({ structure: "三卷递进", volumes: [], povStrategy: "限知视角", timeSpan: "两年" });
  });
});

describe("foundation schema 层校验活着（PL-8 死代码守卫，product-audit-20260910 B3）", () => {
  // 根因：Ajv.compile 后 validator 从未调用，schema 层（required 键/类型/数组成员）
  // 自落地起短路。以下反例全部**通过 requiredPaths 语义层**、只可能被 schema 层抓住——
  // 若校验再次失效，这些用例必红。
  const basePlotDesign = {
    narrativePromises: ["真相改变关系"],
    characterDestinations: [{ characterRef: "p1", endingRange: "承担后果" }],
    endingEnvelope: "开放但不否定代价",
    nonNegotiables: ["不抹除已付出的代价"],
  };

  it("子结构类型错误必须被 schema 抓住（requiredPaths 只看顶层非空，抓不到子键类型）", () => {
    const errors = validateFoundationTaskContract(output({
      ...basePlotDesign,
      longHorizonThreads: [{ threadRef: "main", direction: "查明", closureCondition: "公开", doNotConsumeBefore: "后期", responsibleVolumeOrdinals: ["非卷序值"], nextResponsibility: "推进" }],
      informationBoundaries: { hidden: [], notDesigned: [], open: [] },
    }), "plot-design");
    expect(errors.join("\n")).toMatch(/must be integer|must be number/);
  });

  it("informationBoundaries 成员类型错误必须被 schema 抓住", () => {
    const errors = validateFoundationTaskContract(output({
      ...basePlotDesign,
      longHorizonThreads: [{ threadRef: "main", direction: "查明", closureCondition: "公开", doNotConsumeBefore: "后期", responsibleVolumeOrdinals: [1], nextResponsibility: "推进" }],
      informationBoundaries: { hidden: "不是数组", notDesigned: [], open: [] },
    }), "plot-design");
    expect(errors.join("\n")).toContain("must be array");
  });

  it("旧键别名迁移：hiddenInformation/notDesignedYet + 裸字符串成员 → 规范 {claim} 对象数组且通过校验", () => {
    const legacy = {
      ...basePlotDesign,
      longHorizonThreads: [{ threadRef: "main", direction: "查明", closureCondition: "公开", doNotConsumeBefore: "后期", responsibleVolumeOrdinals: [1], nextResponsibility: "推进" }],
      informationBoundaries: {
        levelOne: { type: "异常现象", content: "可复验的规律" },
        hiddenInformation: ["底层机制完整答案", "潮汐异常最终来源"],
        notDesignedYet: ["终局后社会形态"],
        worldSurfaceFacts: ["宗门与境界常识"],
      },
    };
    const normalized = normalizeFoundationStructuredDataFlat(legacy, "plot-design");
    const boundaries = normalized.informationBoundaries as Record<string, unknown>;
    expect(boundaries.hidden).toEqual([{ claim: "底层机制完整答案" }, { claim: "潮汐异常最终来源" }]);
    expect(boundaries.notDesigned).toEqual([{ claim: "终局后社会形态" }]);
    expect(boundaries.open).toEqual([]);
    expect(boundaries.hiddenInformation).toBeUndefined();
    expect(boundaries.levelOne).toBeDefined(); // 未知键原样保留（前向兼容面）
    expect(validateFoundationTaskContract(output(legacy), "plot-design")).toEqual([]);
  });

  it("规范新键存在时别名不得覆盖（双向：迁移只补空缺不改已正）", () => {
    const mixed = normalizeFoundationStructuredDataFlat({
      informationBoundaries: { hidden: [{ claim: "已规范" }], hiddenInformation: ["应被忽略的残留"], notDesigned: [], open: [] },
    }, "plot-design");
    expect((mixed.informationBoundaries as Record<string, unknown>).hidden).toEqual([{ claim: "已规范" }]);
  });

  it("卷序记法归一：[\"V1\",\"卷2\",3] 纯记法漂移无损转整数；转不了的保留并如实报错（不掩盖）", () => {
    const normalized = normalizeFoundationStructuredDataFlat({
      longHorizonThreads: [
        { threadRef: "main", responsibleVolumeOrdinals: ["V1", "卷2", 3, "第4卷"] },
        { threadRef: "side", responsibleVolumeOrdinals: ["后半程"] },
      ],
    }, "plot-design");
    const threads = normalized.longHorizonThreads as Array<Record<string, unknown>>;
    expect(threads[0].responsibleVolumeOrdinals).toEqual([1, 2, 3, 4]);
    expect(threads[1].responsibleVolumeOrdinals).toEqual(["后半程"]); // 非记法值不猜，交给校验报告
  });

  it("契约指纹确定且随任务区分，未注册任务无指纹", () => {    const characters = foundationContractFingerprint("characters");
    expect(characters).toBeTruthy();
    expect(foundationContractFingerprint("characters")).toBe(characters);
    expect(foundationContractFingerprint("worldview")).not.toBe(characters);
    expect(foundationContractFingerprint("not-a-task")).toBeNull();
  });
});
