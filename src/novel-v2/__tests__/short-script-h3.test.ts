/**
 * 独立短剧（short-script-h3）单元测试（stateless：后端只生成不落库，无 repository/objects）。
 *
 * 覆盖：时长预算推导、素材注入幂等指纹、stateless 直接返回完整 record、
 * avoidMotifs 入参参与反同质、两阶段生成路径（分批）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildShortScriptPrompt,
  clampShortScriptTargetSeconds,
  DEFAULT_SHORT_SCRIPT_TARGET_SECONDS,
  deriveShortScriptMaxSegments,
  deriveShortScriptMinSegments,
  generateShortScriptH3,
  MAX_SHORT_SCRIPT_TARGET_SECONDS,
  MAX_SHORT_SCRIPT_SEGMENTS,
  MIN_IDEA_LENGTH,
  MIN_SHORT_SCRIPT_TARGET_SECONDS,
  normalizeShortScriptDurationMode,
  SHORT_SCRIPT_CONTRACT_VERSION,
  ShortScriptInputError,
  shortScriptDurationKey,
} from "../application/short-script-h3";
import {
  buildShortScriptBatchPrompt,
  buildShortScriptMaterialLine,
  buildShortScriptPlanPrompt,
  type ShortScriptReferenceMaterial,
} from "../application/staged-script-generation";

const IDEA = "深夜便利店店员发现连续三晚同一时刻进店的顾客们买走的商品首字拼成同一句警告，而第四晚进店的是他自己。";

function makeSkillProvider() {
  return {
    list: vi.fn(async () => [{
      skillId: "test-short-script",
      version: "1.0.0",
      enabled: true,
      priority: "required",
      executionPoints: ["short.script"],
      capabilities: ["script"],
      content: "short.script 执行点指引（测试桩）",
      promptSections: { "short.script": "short.script 执行点指引（测试桩）" },
    }]),
  } as never;
}

/** 单次 30s 模型的六段结构与创意策略输出（契约 v10）。 */
function shortScriptOutput(targetDurationSeconds: number) {
  const segments = [];
  let remaining = targetDurationSeconds;
  while (remaining > 0) {
    const duration = Math.min(15, Math.max(10, remaining));
    segments.push({
      title: "货架异样",
      synopsis: "店员发现商品缺口规律。",
      durationSeconds: duration,
      beatIds: ["beat-pattern"],
      subjectDefinitions: "<Subject 1> is the night-shift clerk; <Subject 2> is the convenience store interior.",
      summary: "[reference generation] <Subject 1> notices a pattern in the shelves of <Subject 2>.",
      retentionAnalysis: "<Subject 1>: fully_preserved.\n<Subject 2>: fully_preserved.",
      detailedDescription: "[Shot 1] A medium shot of <Subject 2>, cold fluorescent light; <Subject 1> restocks cans. [Shot 2] A close-up of <Subject 1> muttering in Chinese.",
      overallSoundscape: "Fridge hum and register beep throughout.",
      nonDiegeticMusic: "A low synth pulse builds.",
    });
    remaining -= duration;
  }
  return {
    plotBeats: [{ id: "beat-pattern", kind: "setup" as const, summary: "店员发现缺货商品首字拼出警告" }],
    creativeStrategy: { hookType: "awe" as const, subversion: "警告并非来自监控，而是顾客的购物习惯被暗处操控", signatureMoment: "第四晚推门进店的是他自己" },
    characters: [{ name: "夜班店员", appearanceEn: "A young clerk in a dark green apron." }],
    segments,
  };
}

function mockModel(value: unknown) {
  return { generateStructured: vi.fn(async () => ({ value })) } as never;
}

describe("目标时长与分段预算", () => {
  it("clamps target into 10-180s", () => {
    expect(clampShortScriptTargetSeconds(1)).toBe(MIN_SHORT_SCRIPT_TARGET_SECONDS);
    expect(clampShortScriptTargetSeconds(30)).toBe(30);
    expect(clampShortScriptTargetSeconds(500)).toBe(MAX_SHORT_SCRIPT_TARGET_SECONDS);
    expect(clampShortScriptTargetSeconds(undefined)).toBe(DEFAULT_SHORT_SCRIPT_TARGET_SECONDS);
  });

  it("derives segment min/max from the target budget with a hard cap", () => {
    expect(deriveShortScriptMinSegments(30)).toBe(2);
    expect(deriveShortScriptMaxSegments(30)).toBe(3);
    // 硬顶：180s 按最短单段 10s 推导不得超过 MAX_SHORT_SCRIPT_SEGMENTS
    expect(deriveShortScriptMaxSegments(MAX_SHORT_SCRIPT_TARGET_SECONDS)).toBeLessThanOrEqual(MAX_SHORT_SCRIPT_SEGMENTS);
  });

  it("normalizes duration mode to fixed and keys fixed vs auto distinctly", () => {
    expect(normalizeShortScriptDurationMode("auto")).toBe("auto");
    expect(normalizeShortScriptDurationMode("nonsense")).toBe("fixed");
    expect(shortScriptDurationKey({ durationMode: "auto", targetDurationSeconds: 60 })).toBe("auto");
    expect(shortScriptDurationKey({ durationMode: "fixed", targetDurationSeconds: 30 })).toBe("30");
  });

  it("rejects ideas shorter than the minimum", async () => {
    await expect(generateShortScriptH3(
      { idea: "太短" },
      { model: mockModel(shortScriptOutput(30)), skillProvider: makeSkillProvider() },
    )).rejects.toBeInstanceOf(ShortScriptInputError);
  });
});

describe("buildShortScriptPrompt（素材注入）", () => {
  it("injects selected reference materials as <Subject N> frames, omits otherwise", () => {
    const withMaterials = buildShortScriptPrompt({
      projectTitle: "独立短剧",
      idea: IDEA,
      targetDurationSeconds: 30,
      minSegments: 2,
      maxSegments: 3,
      referenceMaterials: [
        { subjectTag: "Subject 1", description: "玻璃柜台里的白色机器人店员" },
        { subjectTag: "Subject 2", description: "挂满褪色雨伞的门口雨棚" },
      ],
    });
    expect(withMaterials).toContain("公用参考素材");
    expect(withMaterials).toContain("Subject 1：玻璃柜台里的白色机器人店员");
    const without = buildShortScriptPrompt({ projectTitle: "独立短剧", idea: IDEA, targetDurationSeconds: 30, minSegments: 2, maxSegments: 3 });
    expect(without).not.toContain("公用参考素材");
    expect(buildShortScriptMaterialLine([])).toBe("");
  });
});

describe("generateShortScriptH3（stateless）", () => {
  it("returns a full record without repository/objects, and keeps sourceFingerprint", async () => {
    const generateStructured = vi.fn(async () => ({ value: shortScriptOutput(30) }));
    const record = await generateShortScriptH3(
      { idea: IDEA },
      { model: { generateStructured } as never, skillProvider: makeSkillProvider() },
    );
    expect(record.scriptId).toBeTruthy();
    expect(record.sourceFingerprint).toBeTruthy();
    expect(record.segments.length).toBeGreaterThan(0);
    expect(record.characters.length).toBe(1);
    expect(record.creativeStrategy?.hookType).toBe("awe");
    // stateless：无落库，无需仓库
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("bakes selected materials into the fingerprint (mat:), differing across material sets", async () => {
    const one = await generateShortScriptH3(
      { idea: IDEA, referenceMaterials: [{ subjectTag: "Subject 1", description: "白色机器人" }] },
      { model: mockModel(shortScriptOutput(30)), skillProvider: makeSkillProvider() },
    );
    const two = await generateShortScriptH3(
      { idea: IDEA, referenceMaterials: [{ subjectTag: "Subject 1", description: "白色机器人" }, { subjectTag: "Subject 2", description: "门口雨棚" }] },
      { model: mockModel(shortScriptOutput(30)), skillProvider: makeSkillProvider() },
    );
    expect(one.sourceFingerprint).not.toBe(two.sourceFingerprint);
  });

  it("passes avoidMotifs into the prompt (跨作品反同质入参化)", async () => {
    let promptText = "";
    const model = {
      generateStructured: vi.fn(async (input: { prompt: string }) => {
        promptText = input.prompt;
        return { value: shortScriptOutput(30) };
      }),
    } as never;
    await generateShortScriptH3(
      { idea: IDEA, avoidMotifs: ["飞剑在云端倒悬"] },
      { model, skillProvider: makeSkillProvider() },
    );
    expect(promptText).toContain("跨作品反同质");
    expect(promptText).toContain("飞剑在云端倒悬");
  });
});

describe("两阶段生成契约（staged generation）", () => {
  it("drives plan + batched segment generation when segment count exceeds the single-shot threshold", async () => {
    // auto 模式恒走两阶段（段数硬顶 36 > 6）
    const planSegments = Array.from({ length: 8 }, () => ({ beatIds: ["beat-pattern"], durationSeconds: 10 }));
    const generateStructured = vi.fn(async (input: { schemaName: string; schema: { properties: { segments: { minItems: number } } } }) => {
      if (input.schemaName === "short-script-h3-plan") {
        return { value: { creativeStrategy: { hookType: "awe", subversion: "s", signatureMoment: "m" }, styleLine: "cold fluorescent palette", plotBeats: [{ id: "beat-pattern", kind: "setup", summary: "店员发现规律" }], characters: [{ name: "夜班店员", appearanceEn: "A clerk in apron." }], segmentPlan: planSegments } };
      }
      // 批次：schema 强制本批段数 = segments.minItems
      const count = input.schema.properties.segments.minItems;
      return { value: { segments: planSegments.slice(0, count).map((s) => ({ title: "段", synopsis: "略", durationSeconds: s.durationSeconds, beatIds: s.beatIds, subjectDefinitions: "<Subject 1> is clerk.", summary: "m", retentionAnalysis: "r", detailedDescription: "d", overallSoundscape: "o", nonDiegeticMusic: "n" })) } };
    });
    const record = await generateShortScriptH3(
      { idea: IDEA, durationMode: "auto" },
      { model: { generateStructured } as never, skillProvider: makeSkillProvider() },
    );
    expect(record.segments.length).toBe(8);
    // 规划 + 至少 1 批
    const schemas = generateStructured.mock.calls.map(([input]) => (input as { schemaName: string }).schemaName);
    expect(schemas).toContain("short-script-h3-plan");
  });

  it("defaults the plan prompt project title to 独立短剧", () => {
    const prompt = buildShortScriptPlanPrompt({ projectTitle: "独立短剧", idea: IDEA, targetDurationSeconds: 30, minSegments: 2, maxSegments: 3 });
    expect(prompt).toContain("独立短剧");
  });

  it("includes reference materials in the batch prompt", () => {
    const batchPrompt = buildShortScriptBatchPrompt({
      projectTitle: "独立短剧",
      idea: IDEA,
      styleLine: "style",
      characters: [],
      plotBeats: [],
      segmentPlan: [{ beatIds: ["b1"], durationSeconds: 10 }],
      batchStartIndex: 0,
      batchPlan: [{ beatIds: ["b1"], durationSeconds: 10 }],
      previousSegments: [],
      referenceMaterials: [{ subjectTag: "Subject 1", description: "白色机器人" }],
    });
    expect(batchPrompt).toContain("Subject 1：白色机器人");
  });
});

/** 契约版本守卫（据此诚实声明产物形状）。 */
describe("契约版本", () => {
  it("is at least contract v10", () => {
    expect(Number(SHORT_SCRIPT_CONTRACT_VERSION)).toBeGreaterThanOrEqual(10);
  });
});

/** 引用占位：确保 MIN_IDEA_LENGTH 常量仍被导出（前端白名单元依赖）。 */
describe("导出守卫", () => {
  it("exposes MIN_IDEA_LENGTH", () => {
    expect(MIN_IDEA_LENGTH).toBe(10);
  });
});

// 类型引用守卫，避免上述泛型变量被误用
const _materialRef: ShortScriptReferenceMaterial = { subjectTag: "Subject 1", description: "x" };
void _materialRef;