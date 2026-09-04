/**
 * 章节短剧剧本提示词（chapter-script-h3）单元测试（契约 v5 + 零阻断契约）。
 *
 * 契约：每条片段提示词自包含六段（subject_definitions → non_diegetic_music）；
 * 顶层 plotBeats 穷举剧情节拍，segments 用 beatIds 引用；
 * v5 增剧集剧作层提示契约（开场即冲突/情绪节点节奏/出口即钩子/台词密度/伏笔链/人物经济）；
 * v11 上述剧作层与镜头层契约迁出代码侧、改由运行时 skill（h3-video-prompt）承载
 *     （根因：与 skill 指引重复 27%，重复段挤占注意力预算致长指引被词汇层合规），
 *     并新增画面设计层（构图设计/色彩设计/反平庸默认态）；代码侧只保留运行时事实，
 *     测试改为断言"契约不在代码侧 + 契约仍在 skill 侧"的双向守护。
 * 零阻断契约（2026-08-31，用户指令：产物不做任何校验，直接显示）：结构观察
 * （标签/时序/标记/时长/节拍覆盖/呈现手段）全部只进 hints，normalize 仅在
 * 完全无可展示片段时失败；时长非法回退中点、越界夹回界内。
 * 夹具说明：使用虚构人物与仙侠题材的示例性内容作结构校验样本；被测的结构规则、
 * 校验逻辑与断言全部题材无关，不构成 case-specific 产品契约（泛化优先约束针对
 * 规则与规则文本，不禁止测试样本携带题材）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "../protocol";
import { NovelPostgresRepository } from "../postgres-repository";
import {
  assembleSegmentPromptText,
  buildChapterScriptCharacterDigests,
  buildChapterScriptPrompt,
  buildSharedSubjectLibraryText,
  CHAPTER_SCRIPT_H3_SCHEMA,
  CHAPTER_SCRIPT_ARTIFACT_KIND,
  computeCinematicHints,
  deriveMinSegments,
  MAX_SEGMENTS_PER_CHAPTER,
  MIN_SEGMENT_SECONDS,
  MAX_SEGMENT_SECONDS,
  normalizeChapterScriptOutput,
  collectSegmentHintIssues,
  parseSharedSubjectPreset,
  SCRIPT_CONTRACT_VERSION,
  validateChapterScriptSegment,
  submitExternalChapterScriptH3,
} from "../application/chapter-script-h3";

const COURIER_BASELINE = "A middle-aged courier with short black hair, stubble, a faded grey uniform jacket and a scuffed delivery satchel.";

const PLOT_BEATS = [
  { id: "beat-wake", kind: "event" as const, summary: "楚衡头痛惊醒，确认身处陌生木屋" },
  { id: "beat-memory", kind: "memory" as const, summary: "记忆碎片涌入：灵网宗杂役弟子、欠例供被罚守夜、高烧病亡穿越" },
  { id: "beat-inventory", kind: "setup" as const, summary: "家当盘点：两块下品灵石与缺页的《引气诀》残册" },
  { id: "beat-deadline", kind: "hook" as const, summary: "期限任务：三天内凑齐三块下品灵石" },
];

function courierSectionFields(overrides: Partial<Record<string, string>> = {}) {
  return {
    subjectDefinitions: overrides.subjectDefinitions
      ?? "<Subject 1> is the middle-aged courier, whose appearance comes from the character sheet: short black hair, stubble, a faded grey uniform jacket and a scuffed delivery satchel.\n<Subject 2> is the rain-glossed alley behind the courier station, lit by a single flickering wall lamp.",
    summary: overrides.summary
      ?? "[reference generation] The target video follows <Subject 1> into <Subject 2> as he opens his empty delivery satchel under the lamp light.",
    retentionAnalysis: overrides.retentionAnalysis
      ?? "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - grey uniform, stubble and scuffed satchel retained.\n<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - alley set dressing and flickering wall lamp retained.",
    detailedDescription: overrides.detailedDescription
      ?? [
        "Live-action cinematic look, handheld energy.",
        "[Shot 1] A medium-wide shot frames <Subject 2>, the rain-glossed alley lit by one flickering wall lamp. <Subject 1>, the courier in his faded grey uniform with a scuffed satchel, steps in from the left. The camera pushes in slowly as he lifts the satchel flap and frowns at the emptiness inside.",
        "[Shot 2] At 00:04.000, the shot cuts to a close-up of <Subject 1> (S1). Speaking into a worn radio in Chinese with clipped urgency, <d>[中文] 包裹不见了，先别回站。</d> Static answers him; water drips off the lamp housing beside his shoulder.",
      ].join("\n"),
    overallSoundscape: overrides.overallSoundscape
      ?? "Steady drizzle against brickwork, distant traffic hum, and irregular water drips continue throughout the clip.",
    nonDiegeticMusic: overrides.nonDiegeticMusic ?? "N/A",
  };
}

function courierSegment(durationSeconds = 12) {
  return {
    title: "雨巷发现空袋",
    synopsis: "快递员进巷查看，发现包裹丢失并上报。",
    durationSeconds,
    beatIds: ["beat-wake", "beat-inventory"],
    ...courierSectionFields(),
  };
}

/** memory/hook 节拍的合法承载：[Flashback] 闪回 + 台词，写出具体信息点。 */
function memoryCarrierSegment() {
  return {
    ...courierSegment(),
    title: "记忆涌入",
    synopsis: "记忆碎片涌入，得知杂役弟子身份、欠供守夜死因与三天期限。",
    beatIds: ["beat-memory", "beat-deadline"],
    detailedDescription: [
      "Live-action cinematic look.",
      "[Shot 1] Close-up of <Subject 1> clutching his head on the plank bed, eyes squeezed shut.",
      "[Shot 2] At 00:02.000, the shot cuts to [Flashback] the same courier, younger, kneeling before a steward at a spirit-field gate at night, bowing repeatedly as the steward points at the dark paddies.",
      "[Shot 3] At 00:04.500, the shot cuts to [Flashback] the hut at noon, the courier shivering under a ragged blanket, sweat soaking the bed board as an unseen fever burns him down.",
      "[Shot 4] At 00:07.000, back to reality: <Subject 1> opens his eyes and mutters in a hoarse voice, <d>[中文] 三天之内凑不齐三块下品灵石，就别想留在外门。</d>",
    ].join("\n"),
  };
}

function validScript() {
  return { plotBeats: PLOT_BEATS, characters: [{ name: "陈默", appearanceEn: COURIER_BASELINE }], segments: [courierSegment(), memoryCarrierSegment()] };
}

/** 用户预设的共享定义：主角与场景由作者手写，片段只写新增主体（编号从 3 起续接）。 */
const SHARED_PRESET_TEXT = "<Subject 1> The middle-aged courier has short black hair, stubble, a faded grey uniform jacket and a scuffed delivery satchel.\n<Subject 2> The alley behind the courier station is rain-glossed and lit by one flickering wall lamp.";
const SHARED = parseSharedSubjectPreset(SHARED_PRESET_TEXT);

describe("章节共享定义预设（用户手动编辑）", () => {
  it("parses user text, strips the optional header, and requires continuous numbering", () => {
    const withHeader = parseSharedSubjectPreset(`subject_definitions:\n${SHARED_PRESET_TEXT}`);
    expect(withHeader.lines).toHaveLength(2);
    expect(withHeader.maxLabel).toBe(2);
    expect(parseSharedSubjectPreset("")).toEqual({ lines: [], maxLabel: 0 });
    expect(parseSharedSubjectPreset(undefined)).toEqual({ lines: [], maxLabel: 0 });
    expect(() => parseSharedSubjectPreset("<Subject 2> skips one")).toThrow(/期望 <Subject 1>/);
    expect(() => parseSharedSubjectPreset("A free-form line without labels")).toThrow(/<Subject N> 开头/);
  });

  it("exports the shared library as a standalone block", () => {
    expect(buildSharedSubjectLibraryText(SHARED)).toBe(`subject_definitions:\n${SHARED_PRESET_TEXT}`);
    expect(buildSharedSubjectLibraryText({ lines: [], maxLabel: 0 })).toBe("");
  });

  it("lets segments reference shared subjects without redefining them", () => {
    const fields = {
      ...courierSegment(),
      subjectDefinitions: "<Subject 3> is a scuffed delivery satchel with a frayed strap, hanging from the courier's shoulder.",
      summary: "[reference generation] <Subject 1> checks <Subject 3> while walking through <Subject 2> in the rain.",
      retentionAnalysis: "<Subject 3> (appears in [Shot 1], [Shot 2]): fully_preserved - strap and scuffs retained.",
      detailedDescription: [
        "Live-action cinematic look.",
        "[Shot 1] <Subject 1>, the courier in his faded grey uniform, walks through <Subject 2> carrying <Subject 3>. He pauses and lifts the satchel flap.",
        "[Shot 2] At 00:04.000, the shot cuts to a close-up of <Subject 3> as <Subject 1> (S1) mutters in Chinese, <d>[中文] 包裹不见了，先别回站。</d>",
      ].join("\n"),
    };
    expect(validateChapterScriptSegment(fields, SHARED)).toEqual([]);
    expect(assembleSegmentPromptText(fields)).not.toContain(COURIER_BASELINE);
    expect(assembleSegmentPromptText(fields).startsWith("subject_definitions:\n<Subject 3>")).toBe(true);
  });

  it("downgrades shared-subject redefinition and broken numbering to hints (weak validator)", () => {
    const redefine = { ...courierSegment(), subjectDefinitions: `<Subject 1> ${COURIER_BASELINE}` };
    expect(collectSegmentHintIssues(redefine, SHARED)).toContainEqual(expect.stringContaining("与共享定义重复"));
    const restart = { ...courierSegment(), subjectDefinitions: "<Subject 1> is a new prop restarting numbering instead of continuing." };
    expect(collectSegmentHintIssues(restart, SHARED)).toContainEqual(expect.stringContaining("与共享定义重复"));
    const gap = { ...courierSegment(), subjectDefinitions: "<Subject 5> is a prop skipping the continuation order." };
    expect(collectSegmentHintIssues(gap, SHARED)).toContainEqual(expect.stringContaining("从 <Subject 3> 起连续递增"));
    const duplicate = { ...courierSegment(), subjectDefinitions: "<Subject 3> is a prop.\n<Subject 3> is the same prop again." };
    expect(collectSegmentHintIssues(duplicate, SHARED)).toContainEqual(expect.stringContaining("定义重复"));
  });

  it("allows an empty subjectDefinitions when shared subjects exist, and observes without sharing", () => {
    const reuseOnly = { ...courierSegment(), subjectDefinitions: "" };
    expect(validateChapterScriptSegment(reuseOnly, SHARED)).toEqual([]);
    expect(assembleSegmentPromptText(reuseOnly)).not.toContain("subject_definitions:");
    // 零阻断契约：未承载节拍、空 subjectDefinitions 与悬空引用标签均只进 hints，不抛错。
    const withShared = normalizeChapterScriptOutput(
      { plotBeats: PLOT_BEATS, characters: [], segments: [{ ...courierSegment(), subjectDefinitions: "" }] },
      { minSegments: 2, shared: SHARED },
    );
    expect(withShared.hints.some((hint) => /beat-memory|beat-deadline/.test(hint))).toBe(true);
    // 无共享且空定义时正文引用悬空标签——H3 语义必需项观察，零阻断契约下仅提示。
    const withoutShared = normalizeChapterScriptOutput(
      { plotBeats: PLOT_BEATS, characters: [], segments: [{ ...courierSegment(), subjectDefinitions: "" }] },
      { minSegments: 6, shared: { lines: [], maxLabel: 0 } },
    );
    expect(withoutShared.segments).toHaveLength(1);
    expect(withoutShared.hints.some((hint) => hint.includes("未在 subject_definitions 定义的引用标签"))).toBe(true);
  });
});

describe("assembleSegmentPromptText", () => {
  it("emits the six Ref2VA sections in canonical snake_case order", () => {
    const text = assembleSegmentPromptText(courierSegment());
    const headers = text.split("\n").filter((line) => /^[a-z_]+:$/u.test(line));
    expect(headers).toEqual([
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "overall_soundscape:",
      "non_diegetic_music:",
    ]);
    expect(text.startsWith("subject_definitions:\n<Subject 1>")).toBe(true);
    expect(text.trimEnd().endsWith("N/A")).toBe(true);
  });
});

describe("normalizeChapterScriptOutput", () => {
  it("accepts a valid two-segment script across different scene shapes", () => {
    const result = normalizeChapterScriptOutput(validScript());
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].index).toBe(1);
    expect(result.segments[1].promptText).toContain("[Flashback]");
    expect(result.plotBeats.map((beat) => beat.id)).toEqual(["beat-wake", "beat-memory", "beat-inventory", "beat-deadline"]);
    expect(result.characters[0]).toEqual({ name: "陈默", appearanceEn: COURIER_BASELINE });
  });

  describe("剧情节拍与呈现手段观察（提示级）", () => {
    it("downgrades a reaction-only memory beat to a hint (no dialogue/flashback/on-screen text)", () => {
      const reactionOnly = {
        ...memoryCarrierSegment(),
        detailedDescription: [
          "Live-action cinematic look.",
          "[Shot 1] Close-up of <Subject 1> clutching his head on the plank bed, eyes squeezed shut, knuckles whitening.",
          "[Shot 2] At 00:03.000, the shot cuts to <Subject 1> trembling, sweat dripping down his temple as he stares at his calloused palms.",
        ].join("\n"),
      };
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [courierSegment(), reactionOnly] });
      expect(normalized.hints.some((hint) => hint.includes("没有台词/闪回/屏幕文字呈现手段"))).toBe(true);
    });

    it("downgrades uncovered beats to hints", () => {
      const orphan = { ...validScript(), segments: [courierSegment()] };
      const normalized = normalizeChapterScriptOutput(orphan);
      expect(normalized.hints.some((hint) => /剧情节拍未被任何片段承载.*beat-memory|剧情节拍未被任何片段承载.*beat-deadline/s.test(hint))).toBe(true);
    });

    it("downgrades unknown beatId references and empty beat lists to hints", () => {
      const ghost = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), beatIds: ["beat-ghost"] }, memoryCarrierSegment()] });
      expect(ghost.hints.some((hint) => hint.includes("不存在的节拍 beat-ghost"))).toBe(true);
      const empty = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), beatIds: [] }, memoryCarrierSegment()] });
      expect(empty.hints.some((hint) => hint.includes("beatIds 为空"))).toBe(true);
    });

    it("tolerates missing or invalid plotBeats with an observation hint (zero-blocking)", () => {
      const missing = normalizeChapterScriptOutput({ characters: [], segments: [courierSegment()] });
      expect(missing.segments).toHaveLength(1);
      expect(missing.plotBeats).toEqual([]);
      expect(missing.hints.some((hint) => hint.includes("plotBeats 缺失"))).toBe(true);
      const invalid = normalizeChapterScriptOutput({ plotBeats: [{ id: "b1", kind: "telepathy", summary: "未知类型节拍" }], characters: [], segments: [courierSegment()] });
      expect(invalid.plotBeats).toEqual([]);
      expect(invalid.hints.some((hint) => hint.includes("没有有效的剧情节拍"))).toBe(true);
    });
  });

  describe("时序与标记校验", () => {
    it.each([
      ["non-sequential shot numbers", {
        detailedDescription: [
          "Live-action cinematic look.",
          "[Shot 1] A medium-wide shot frames the rain-glossed alley lamp as <Subject 1>, the courier in his faded grey uniform, steps into view beside <Subject 2>.",
          "[Shot 3] At 00:04.000, the shot cuts to a close-up of <Subject 1> (S1), who radios the station in Chinese, <d>[中文] 包裹不见了，先别回站。</d>",
        ].join("\n"),
      }],
      ["missing shot marker", { detailedDescription: "Live-action cinematic look. The camera follows the courier in his faded grey uniform as he crosses the lamp-lit alley and opens the empty satchel; nothing else happens." }],
    ])("downgrades marker failure to a hint: %s", (_label, overrides) => {
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), ...overrides }] });
      expect(normalized.segments).toHaveLength(1);
      expect(normalized.hints.some((hint) => /镜头编号|镜头标记/.test(hint))).toBe(true);
    });

    // 风格类时序问题（开场镜头带时间戳 / 末镜头缺切点 / 切点超时长或非递增）为提示级：
    // H3 生成器对切点风格差异兼容性好，不再阻断生成，仅进 cinematicHints 供人工复核。
    it.each([
      ["cut beyond duration", { durationSeconds: MIN_SEGMENT_SECONDS, detailedDescription: courierSectionFields().detailedDescription.replace("At 00:04.000", "At 00:12.500") }],
      ["non-increasing cut times", {
        detailedDescription: [
          "Live-action cinematic look.",
          "[Shot 1] A medium-wide shot frames the rain-glossed alley lamp as <Subject 1>, the courier in his faded grey uniform, steps into view beside <Subject 2>.",
          "[Shot 2] At 00:05.000, the shot cuts to a close-up of <Subject 1> (S1), who radios the station in Chinese, <d>[中文] 包裹不见了，先别回站。</d>",
          "[Shot 3] At 00:03.000, the shot cuts back to the alley entrance as drizzle keeps falling across the wall lamp.",
        ].join("\n"),
      }],
      ["opening shot carries a timestamp", { detailedDescription: courierSectionFields().detailedDescription.replace("[Shot 1] A medium-wide shot", "[Shot 1] At 00:00.500, a medium-wide shot") }],
    ])("downgrades stylistic timing issue to hint: %s", (_label, overrides) => {
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), ...overrides }, memoryCarrierSegment()] });
      expect(computeCinematicHints(normalized.segments).length).toBeGreaterThan(0);
    });

    it("accepts the prefix cut style (At MM:SS.mmm cut to [Shot N]) as a valid timeline", () => {
      // 前缀式与后缀式均为行业惯例（真实生成验证发现 provider 稳定采用前缀式），
      // 解析层按最近邻配对双写法兼容；规范写法仍由 skill v1.4.1 指定为后缀式。
      const prefixStyle = [
        "Live-action cinematic look, handheld energy.",
        "[Shot 1] A medium-wide shot frames <Subject 2>, the rain-glossed alley lit by one flickering wall lamp. <Subject 1>, the courier in his faded grey uniform with a scuffed satchel, steps in from the left and frowns at his empty satchel.",
        "At 00:04.000 cut to [Shot 2] a close-up of <Subject 1> (S1). Speaking into a worn radio in Chinese with clipped urgency, <d>[中文] 包裹不见了，先别回站。</d> Static answers him; water drips off the lamp housing beside his shoulder.",
      ].join("\n");
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), detailedDescription: prefixStyle }, memoryCarrierSegment()] });
      expect(normalized.segments[0].detailedDescription).toContain("cut to [Shot 2]");
    });

    it("prefix-style timestamp on the opening shot downgrades to hint (not rejected)", () => {
      // Shot 1 前的 At 归属 Shot 1：作为提示级观察进 cinematicHints，不再阻断生成。
      const badOpening = [
        "Live-action cinematic look.",
        "At 00:00.500 cut to [Shot 1] a medium-wide shot of the rain-glossed alley as <Subject 1> steps in with his empty satchel.",
        "At 00:04.000 cut to [Shot 2] a close-up of <Subject 1> (S1) radioing the station in Chinese, <d>[中文] 包裹不见了，先别回站。</d>",
      ].join("\n");
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), detailedDescription: badOpening }, memoryCarrierSegment()] });
      expect(computeCinematicHints(normalized.segments).some((hint) => hint.includes("[Shot 1] 携带"))).toBe(true);
    });

    it("downgrades an unresolved reference label used outside definitions to a hint", () => {
      const fields = courierSectionFields();
      const broken = {
        ...fields,
        summary: `[reference generation] The target video follows <Subject 9> through the alley lamp light.`,
      };
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), ...broken }] });
      expect(normalized.segments).toHaveLength(1);
      expect(normalized.hints.some((hint) => hint.includes("<Subject 9>"))).toBe(true);
    });

    it("downgrades an unused defined label to a hint", () => {
      const fields = courierSectionFields();
      const normalized = normalizeChapterScriptOutput({
        ...validScript(),
        segments: [{ ...courierSegment(), subjectDefinitions: `${fields.subjectDefinitions}\n<Subject 3> is an unused radio prop.` }],
      });
      expect(normalized.hints.some((hint) => /未被.*使用|未被 summary/.test(hint))).toBe(true);
    });

    it("downgrades unpaired dialogue tags and missing language markers to hints", () => {
      const unclosed = courierSectionFields().detailedDescription.replace("</d>", "");
      const unpaired = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), detailedDescription: unclosed }] });
      expect(unpaired.segments).toHaveLength(1);
      expect(unpaired.hints.some((hint) => hint.includes("标签不配对"))).toBe(true);
      const unlabeled = courierSectionFields().detailedDescription.replace("[中文] ", "");
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), detailedDescription: unlabeled }] });
      expect(normalized.hints.some((hint) => hint.includes("语言标注"))).toBe(true);
    });

    it("downgrades a summary without the bracketed task-type prefix to a hint", () => {
      const noPrefix = courierSectionFields().summary.replace(/^\[reference generation\]\s*/u, "");
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), summary: noPrefix }] });
      expect(normalized.hints.some((hint) => hint.includes("任务类型前缀"))).toBe(true);
    });

    it("downgrades invented audio assets and empty section fields to hints", () => {
      const fields = courierSectionFields();
      const withAudio = normalizeChapterScriptOutput({
        ...validScript(),
        segments: [{ ...courierSegment(), subjectDefinitions: `${fields.subjectDefinitions}\n<Audio 1> is the reused source audio track.` }],
      });
      expect(withAudio.segments).toHaveLength(1);
      expect(withAudio.hints.some((hint) => hint.includes("Audio N"))).toBe(true);
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), overallSoundscape: "" }] });
      expect(normalized.hints.some((hint) => hint.includes("字段为空：overallSoundscape"))).toBe(true);
    });

    it("clamps out-of-range durations to the schema bounds instead of rejecting", () => {
      const normalized = normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(4) }] });
      expect(normalized.segments).toHaveLength(1);
      expect(normalized.segments[0].durationSeconds).toBe(MIN_SEGMENT_SECONDS);
      expect(normalized.hints.some((hint) => /durationSeconds 4s 超出.*已收敛/.test(hint))).toBe(true);
      expect(CHAPTER_SCRIPT_H3_SCHEMA.properties.segments.maxItems).toBe(MAX_SEGMENTS_PER_CHAPTER);
      expect(CHAPTER_SCRIPT_H3_SCHEMA.properties.segments.items.properties.durationSeconds.maximum).toBe(MAX_SEGMENT_SECONDS);
    });

    it("falls back to the midpoint duration when durationSeconds is invalid", () => {
      const normalized = normalizeChapterScriptOutput({
        ...validScript(),
        segments: [{ ...courierSegment(), durationSeconds: "12s" as unknown as number }],
      });
      expect(normalized.segments[0].durationSeconds).toBe(12);
      expect(normalized.hints.some((hint) => hint.includes("已回退为 12s"))).toBe(true);
    });

    it("fails closed only when nothing displayable is returned", () => {
      expect(() => normalizeChapterScriptOutput(null)).toThrow();
      expect(() => normalizeChapterScriptOutput({ plotBeats: PLOT_BEATS, characters: [], segments: [] })).toThrow();
      expect(() => normalizeChapterScriptOutput({ plotBeats: PLOT_BEATS, characters: [], segments: ["not-an-object"] })).toThrow(/可展示/);
    });
  });

  describe("剧情覆盖下限", () => {
    it("derives the floor from chapter length and clamps to bounds", () => {
      expect(deriveMinSegments("短")).toBe(6);
      expect(deriveMinSegments("字".repeat(3556))).toBe(11);
      expect(deriveMinSegments("字".repeat(999_999))).toBe(MAX_SEGMENTS_PER_CHAPTER);
    });

    it("downgrades below-floor segment sets to a hint (no longer blocks output)", () => {
      const normalized = normalizeChapterScriptOutput(validScript(), { minSegments: 6 });
      expect(normalized.hints.some((hint) => /覆盖不足.*下限 6/.test(hint))).toBe(true);
    });

    it("accepts segment sets at or above the floor", () => {
      const result = normalizeChapterScriptOutput(validScript(), { minSegments: 2 });
      expect(result.segments).toHaveLength(2);
    });
  });
});

describe("影视镜头语言提示（cinematicHints，提示级）", () => {
  it("no longer flags shots missing camera motion or framing vocabulary", () => {
    // 描述语言放开中文后（v1.4.2）英文术语词表无法覆盖中文镜头描述，误报率高，
    // 该检测已移除；无运镜/景别词的镜头不应产生"缺少镜头四要素"提示。
    const flat = {
      ...courierSegment(),
      detailedDescription: [
        "Live-action cinematic look.",
        "[Shot 1] The courier stands in the alley and opens his empty satchel while rain keeps falling.",
        "[Shot 2] At 00:04.000, the shot cuts to <Subject 1> staring at his calloused palms under the lamplight.",
      ].join("\n"),
    };
    const hints = computeCinematicHints([{ ...courierSegment(), index: 1, promptText: "" }, { ...flat, index: 2, promptText: "" }]);
    expect(hints.some((hint) => hint.includes("缺少运镜") || hint.includes("镜头四要素"))).toBe(false);
  });

  it("keeps shot-timing observations (开场镜头携带时间戳)", () => {
    const badTiming = {
      ...courierSegment(),
      detailedDescription: [
        "Live-action cinematic look.",
        "[Shot 1] At 00:00.500, the courier stands in the alley under lamplight.",
        "[Shot 2] At 00:02.000, the shot cuts to <Subject 1> staring at his calloused palms.",
      ].join("\n"),
    };
    const hints = computeCinematicHints([{ ...badTiming, index: 1, promptText: "" }]);
    expect(hints.some((hint) => hint.includes("[Shot 1] 携带"))).toBe(true);
  });

  it("passes shots with clean timing", () => {
    const cinematic = {
      ...courierSegment(),
      detailedDescription: courierSectionFields().detailedDescription,
    };
    expect(computeCinematicHints([{ ...cinematic, index: 1, promptText: "" }])).toEqual([]);
  });
});

describe("buildChapterScriptCharacterDigests / buildChapterScriptPrompt", () => {
  it("extracts only primitive profile keys generically and drops nameless rows", () => {
    const digests = buildChapterScriptCharacterDigests([
      { name: "陈默", role: "快递员", motivation: "查清包裹去向", relations: [{ foo: "bar" }] },
      { role: "无名" },
      { name: "老周", description: "驿站看门人" },
    ]);
    expect(digests).toHaveLength(2);
    expect(digests[0].digest).toContain("role: 快递员");
    expect(digests[0].digest).not.toContain("foo");
  });

  it("embeds the coverage contract, presentation rules and full plain text in the prompt", () => {
    const prompt = buildChapterScriptPrompt({
      projectTitle: "长夜货运",
      chapterTitle: "空袋",
      narrativeOrder: 9,
      plainText: "陈默蹲下检查拉链……",
      characters: [{ name: "陈默", digest: "role: 快递员" }],
      instruction: "结尾保留悬念",
      minSegments: 11,
      shared: { lines: [], maxLabel: 0 },
    });
    expect(prompt).toContain("剧情覆盖契约");
    expect(prompt).toContain("至少拆出 11 个片段");
    expect(prompt).toContain("信息呈现手段（硬性规则）");
    expect(prompt).toContain("[Flashback]");
    expect(prompt).toContain("不能替代信息内容本身");
    expect(prompt).not.toContain("章节共享引用定义");
    expect(prompt).toContain("第 9 章《空袋》");
    expect(prompt).toContain("- 陈默：role: 快递员");
    expect(prompt).toContain("作者指令");
    expect(prompt.endsWith("陈默蹲下检查拉链……")).toBe(true);
  });

  it("hands the episode dramaturgy contract to the runtime skill instead of duplicating it in the prompt (v11 dedup)", () => {
    const prompt = buildChapterScriptPrompt({
      projectTitle: "长夜货运",
      chapterTitle: "空袋",
      narrativeOrder: 9,
      plainText: "陈默蹲下检查拉链……",
      characters: [],
      minSegments: 6,
      shared: { lines: [], maxLabel: 0 },
    });
    // v11 去重：剧作层与镜头层契约由运行时 skill（h3-video-prompt，priority=required）注入，
    // 代码侧不再重复——重复段挤占注意力预算，长指引被模型做词汇层合规而非真正执行。
    expect(prompt).not.toContain("剧集剧作契约");
    expect(prompt).not.toContain("开场即冲突");
    expect(prompt).not.toContain("人物经济");
    // 代码侧仍必须承载 skill 不掌握的运行时事实：节拍映射、呈现手段、时长区间、边界。
    expect(prompt).toContain("剧情覆盖契约");
    expect(prompt).toContain("不能替代信息内容本身");
    expect(prompt).toContain(`片段时长统一落在 ${MIN_SEGMENT_SECONDS}-${MAX_SEGMENT_SECONDS}s 区间`);
    expect(prompt).toContain("每个片段用 beatIds 声明它承载的节拍");
    expect(Number(SCRIPT_CONTRACT_VERSION)).toBeGreaterThanOrEqual(11);
  });

  it("keeps the dramaturgy and picture-design contracts in the runtime skill (guard against silent loss after dedup)", () => {
    // 守护测试：契约迁出代码侧后，若 skill 侧被误删或改坏，代码侧测试不会再发现。
    // 此处直接锚定 workspace skill 源文件，保证两端不同步时测试失败而非静默降级。
    const raw = readFileSync(new URL("../../../skills/novel-v2/h3-video-prompt.yaml", import.meta.url), "utf8");
    const chapter = raw.split("short.script: |")[0].split("chapter.script: |")[1] ?? "";
    for (const token of [
      "开场即冲突",
      "情绪节点节奏",
      "出口即钩子",
      "台词密度",
      "反转须有伏笔",
      "人物经济",
      "构图设计",
      "色彩设计",
      "反平庸默认态",
    ]) {
      expect(chapter, `skill 契约缺失：${token}`).toContain(token);
    }
  });

  it("injects the user-preset shared definitions with reuse rules when present", () => {
    const prompt = buildChapterScriptPrompt({
      projectTitle: "长夜货运",
      chapterTitle: "空袋",
      narrativeOrder: 9,
      plainText: "陈默蹲下检查拉链……",
      characters: [],
      minSegments: 6,
      shared: SHARED,
    });
    expect(prompt).toContain("章节共享引用定义（用户预设，全章唯一定义，直接复用）");
    expect(prompt).toContain(SHARED_PRESET_TEXT);
    expect(prompt).toContain("以上 <Subject 1>~<Subject 2> 已由作者预设定义");
    expect(prompt).toContain("编号从 <Subject 3> 起连续递增");
    expect(prompt).toContain("subjectDefinitions 返回空字符串");
  });
});

describe("submitExternalChapterScriptH3（外部 MCP 接手产出）", () => {
  const submitObjects = {
    getText: vi.fn(async () => "楚衡头痛惊醒，确认身处陌生木屋。记忆碎片涌入，得知杂役弟子身份与欠供守夜死因。"),
    putText: vi.fn(async () => ({ key: "objects/test-chapter-script" })),
  };

  function mockChapterRepository(options: { existingArtifactId?: string; status?: string; storedArtifact?: unknown } = {}) {
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    const finalDoc = {
      title: "测试章节",
      status: options.status ?? "final",
      narrativeOrder: 1,
      revision: 1,
      sourceRevisionId: "rev-1",
      artifactId: "art-1",
      contentHash: "hash-1",
      objectKey: "objects/chapter",
    };
    const getFinalDocumentContentRef = vi.fn(async () => finalDoc);
    const getChapterScriptSubjectPreset = vi.fn(async () => "");
    const poolQuery = vi.fn(async () => ({
      rows: options.existingArtifactId ? [{ id: options.existingArtifactId }] : [],
      rowCount: options.existingArtifactId ? 1 : 0,
    }));
    const recordArtifact = vi.fn(async (_artifact: Artifact) => {});
    const getArtifact = vi.fn(async () => options.storedArtifact ?? {
      id: "art-stored",
      kind: CHAPTER_SCRIPT_ARTIFACT_KIND,
      projectId: "project-1",
      structuredData: { ...validScript(), documentId: "doc-1", sourceFingerprint: "ext-stored", contractVersion: SCRIPT_CONTRACT_VERSION },
    });
    Object.defineProperty(repository, "getFinalDocumentContentRef", { value: getFinalDocumentContentRef });
    Object.defineProperty(repository, "getChapterScriptSubjectPreset", { value: getChapterScriptSubjectPreset });
    Object.defineProperty(repository, "pool", { value: { query: poolQuery } });
    Object.defineProperty(repository, "recordArtifact", { value: recordArtifact });
    Object.defineProperty(repository, "getArtifact", { value: getArtifact });
    return { repository, getFinalDocumentContentRef, getChapterScriptSubjectPreset, poolQuery, recordArtifact, getArtifact };
  }

  it("rejects a non-final chapter with a 409-style error", async () => {
    const { repository } = mockChapterRepository({ status: "drafting" });
    await expect(submitExternalChapterScriptH3(
      { projectId: "project-1", documentId: "doc-1", payload: validScript() },
      { repository, objects: submitObjects as never },
    )).rejects.toThrow(/只能为已有正式 revision 的定稿章节/);
  });

  it("rejects payload without segments", async () => {
    const { repository } = mockChapterRepository();
    await expect(submitExternalChapterScriptH3(
      { projectId: "project-1", documentId: "doc-1", payload: { plotBeats: [], characters: [] } },
      { repository, objects: submitObjects as never },
    )).rejects.toThrow(/payload\.segments 必填且非空/);
  });

  it("assembles external chapter script and marks origin=external-chapter-script-h3", async () => {
    const { repository, recordArtifact } = mockChapterRepository();
    const record = await submitExternalChapterScriptH3(
      { projectId: "project-1", documentId: "doc-1", payload: validScript() },
      { repository, objects: submitObjects as never },
    );
    expect(record.reused).toBeUndefined();
    expect(record.artifactId).toEqual(expect.any(String));
    expect(record.segments).toHaveLength(2);
    expect(record.segments[0].promptText).toContain("subject_definitions:");
    expect(recordArtifact).toHaveBeenCalledTimes(1);
    const stored = recordArtifact.mock.calls[0][0] as unknown as Artifact;
    expect(stored.kind).toBe(CHAPTER_SCRIPT_ARTIFACT_KIND);
    expect((stored.structuredData as Record<string, unknown>).origin).toBe("external-chapter-script-h3");
    expect((stored.structuredData as Record<string, unknown>).sourceFingerprint).toMatch(/^ext:/);
  });

  it("reuses identical external content (ext: fingerprint) without re-recording", async () => {
    const { repository, recordArtifact } = mockChapterRepository({ existingArtifactId: "art-stored" });
    const record = await submitExternalChapterScriptH3(
      { projectId: "project-1", documentId: "doc-1", payload: validScript() },
      { repository, objects: submitObjects as never },
    );
    expect(record.reused).toBe(true);
    expect(record.artifactId).toBe("art-stored");
    expect(recordArtifact).not.toHaveBeenCalled();
  });
});
