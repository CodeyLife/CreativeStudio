import { describe, expect, it } from "vitest";
import { auditFullBookArchitecture } from "../application/full-book-architecture";

const complete = {
  architecture: {
    structure: "两阶段递进",
    volumes: [
      { name: "起点", theme: "失去与求生", function: "建立问题", entryState: "主角被迫离开原生活", exitState: "主角选择追查真相", pressures: ["制度追责"], promiseWindows: [{ id: "p1", window: "阶段末" }] },
      { name: "回响", theme: "真相与责任", function: "承担后果", entryState: "主角开始追查", exitState: "主角公开承担选择", pressures: ["关系破裂"], promiseWindows: [{ id: "p1", window: "阶段末" }] },
    ],
    povStrategy: "单一限知",
    timeSpan: "三年",
  },
  characters: {
    characters: [{ id: "p1", name: "甲", fear: "失去证据", independentAction: { desire: "保护证据", choice: "拒绝交易", cost: "失去职位", knowledgeBoundary: "不知道幕后交易的完整参与者" }, motivation: "查清旧案" }],
  },
  worldview: { rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }], resourcesAndTechnology: [{ name: "卷宗权限", distribution: "集中在核心机构", scarcity: "普通调查者无法调取", access: "需要担保与审批" }], valuesAndConflicts: [{ value: "真相优先于人情", rewardedBy: "升职与信任", punishedBy: "孤立与内部排挤", unequalFor: "底层调查者取证更难", consequence: "多数人选择沉默" }] },
  plotStrategy: {
    characterDestinations: [{ characterRef: "p1", direction: "承担后果" }],
    longHorizonThreads: [{ threadRef: "main", direction: "追查真相", closureCondition: "真相公开", doNotConsumeBefore: "阶段末", responsibleVolumeOrdinals: [1, 2], nextResponsibility: "在第二阶段公开证据", coupling: "改变人物选择", transformPoint: "真相公开后并入人物责任线" }],
    informationBoundaries: { hidden: ["幕后动机"], notDesigned: [], open: ["新秩序细节"] },
  },
};

describe("full-book architecture audit", () => {
  it("accepts a complete architecture without imposing prose or genre requirements", () => {
    const report = auditFullBookArchitecture(complete);
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("rejects missing or empty full-book root collections", () => {
    const report = auditFullBookArchitecture({
      architecture: { volumes: [] },
      characters: { characters: [] },
      worldview: { rules: [] },
      plotStrategy: { characterDestinations: [], longHorizonThreads: [] },
    });
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "full-book-root-contract-incomplete", severity: "major" }),
    ]));
  });

  it("reports missing stage contracts and cross-foundation identity drift", () => {
    const report = auditFullBookArchitecture({
      architecture: { structure: "单线", volumes: [{ name: "第一阶段", theme: "求生", function: "开篇", chapterCount: 10 }], povStrategy: "限知", timeSpan: "一年" },
      characters: { characters: [{ id: "char-a", name: "甲", motivation: "活下去" }] },
      worldview: { rules: ["规则只有描述，没有代价"] },
      plotStrategy: { characterDestinations: [{ characterRef: "乙", direction: "改变" }], longHorizonThreads: [{ threadRef: "main", direction: "查明", closureCondition: "完成", doNotConsumeBefore: "后期" }] },
    });
    expect(report.passed).toBe(false);
    expect(report.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      "volume-transition-contract-incomplete",
      "character-agency-contract-incomplete",
      "world-rule-cost-boundary-incomplete",
      "unresolved-character-destination",
      "long-horizon-thread-window-incomplete",
      "information-boundary-map-missing",
    ]));
  });

  it("does not auto-merge ambiguous character references", () => {
    const report = auditFullBookArchitecture({
      ...complete,
      characters: { characters: [{ id: "p1", name: "甲", fear: "失去", independentAction: { desire: "保护" } }, { id: "p2", name: "甲", fear: "失败", independentAction: { desire: "逃离" } }] },
      plotStrategy: { ...complete.plotStrategy, characterDestinations: [{ characterRef: "甲", direction: "改变" }] },
    });
    expect(report.issues.some((item) => item.code === "ambiguous-character-destination" && item.severity === "blocker")).toBe(true);
  });

  it("warns on ungrounded volume promise windows without blocking", () => {
    const report = auditFullBookArchitecture({
      ...complete,
      architecture: {
        ...complete.architecture,
        volumes: [
          { name: "起点", theme: "失去与求生", function: "建立问题", entryState: "主角被迫离开原生活", exitState: "主角选择追查真相", pressures: ["制度追责"], promiseWindows: [{ description: "旧日的约定会在本卷末兑现" }] },
        ],
      },
    });
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "promise-window-ungrounded", severity: "warning" }),
    ]));
    expect(report.issues.some((item) => item.code === "volume-transition-contract-incomplete")).toBe(false);
  });

  it("does not warn when every promise window carries a reference and a window", () => {
    const report = auditFullBookArchitecture({
      ...complete,
      architecture: {
        ...complete.architecture,
        volumes: [
          { name: "起点", theme: "失去与求生", function: "建立问题", entryState: "主角被迫离开原生活", exitState: "主角选择追查真相", pressures: ["制度追责"], promiseWindows: [{ promiseRef: "p1", windowOrdinals: [1, 10] }, { id: "p2", payoffWindow: "阶段末" }] },
        ],
      },
    });
    expect(report.issues.some((item) => item.code === "promise-window-ungrounded")).toBe(false);
  });

  it("warns on long-horizon threads without coupling or lifecycle conditions without blocking", () => {
    const report = auditFullBookArchitecture({
      ...complete,
      plotStrategy: {
        ...complete.plotStrategy,
        longHorizonThreads: [{ threadRef: "side", direction: "调查失踪者", closureCondition: "查明去向", doNotConsumeBefore: "中期", responsibleVolumeOrdinals: [2], nextResponsibility: "在第二卷与主线交汇前取得线索" }],
      },
    });
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "long-horizon-thread-coupling-incomplete", severity: "warning" }),
    ]));
    expect(report.issues.some((item) => item.code === "long-horizon-thread-window-incomplete")).toBe(false);
  });

  it("does not warn when threads carry a coupling mechanism or a lifecycle condition", () => {
    const withCoupling = auditFullBookArchitecture({
      ...complete,
      plotStrategy: {
        ...complete.plotStrategy,
        longHorizonThreads: [{ threadRef: "side", direction: "调查失踪者", closureCondition: "查明去向", doNotConsumeBefore: "中期", responsibleVolumeOrdinals: [2], nextResponsibility: "与主线交汇前确认线索", coupling: "改变人物认知" }],
      },
    });
    const withLifecycle = auditFullBookArchitecture({
      ...complete,
      plotStrategy: {
        ...complete.plotStrategy,
        longHorizonThreads: [{ threadRef: "side", direction: "调查失踪者", closureCondition: "查明去向", doNotConsumeBefore: "中期", responsibleVolumeOrdinals: [2], nextResponsibility: "与主线交汇前确认线索", exitPoint: "第二卷末并入主线" }],
      },
    });
    expect(withCoupling.issues.some((item) => item.code === "long-horizon-thread-coupling-incomplete")).toBe(false);
    expect(withLifecycle.issues.some((item) => item.code === "long-horizon-thread-coupling-incomplete")).toBe(false);
  });

  it("accepts an explicit structure type without imposing genre requirements", () => {
    const report = auditFullBookArchitecture({
      ...complete,
      architecture: { ...complete.architecture, structure: "网状群像", structureType: "network" },
    });
    expect(report.issues.filter((item) => item.code === "volume-transition-contract-incomplete")).toEqual([]);
    expect(report.issues.some((item) => item.path?.startsWith("architecture"))).toBe(false);
  });

  it("warns on missing worldview pressure layers without blocking", () => {
    const report = auditFullBookArchitecture({
      ...complete,
      worldview: { rules: [{ statement: "证据必须付出关系代价", cost: "失去盟友", boundary: "不能凭空恢复被毁证据" }] },
    });
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "worldview-pressure-layer-incomplete", severity: "warning" }),
    ]));
    expect(report.issues.some((item) => item.code === "world-rule-cost-boundary-incomplete")).toBe(false);
  });

  it("does not warn when worldview pressure layers are structured", () => {
    const report = auditFullBookArchitecture(complete);
    expect(report.issues.some((item) => item.code === "worldview-pressure-layer-incomplete")).toBe(false);
  });
});
