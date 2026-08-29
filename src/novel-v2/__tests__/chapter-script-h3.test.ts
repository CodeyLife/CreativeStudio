/**
 * 章节短剧剧本提示词（chapter-script-h3）单元测试（契约 v5）。
 *
 * 契约：每条片段提示词自包含六段（subject_definitions → non_diegetic_music）；
 * 顶层 plotBeats 穷举剧情节拍，segments 用 beatIds 引用；
 * memory/setup/hook 类节拍必须以 [Flashback] 闪回、台词 <d> 或屏幕文字承载信息内容，
 * 仅靠反应动作视为呈现缺失；
 * v5 增剧集剧作层提示契约（开场即冲突/情绪节点节奏/出口即钩子/台词密度/伏笔链/人物经济）。
 * 夹具说明：使用虚构人物与仙侠题材的示例性内容作结构校验样本；被测的结构规则、
 * 校验逻辑与断言全部题材无关，不构成 case-specific 产品契约（泛化优先约束针对
 * 规则与规则文本，不禁止测试样本携带题材）。
 */
import { describe, expect, it } from "vitest";
import {
  assembleSegmentPromptText,
  buildChapterScriptCharacterDigests,
  buildChapterScriptPrompt,
  buildSharedSubjectLibraryText,
  CHAPTER_SCRIPT_H3_SCHEMA,
  computeCinematicHints,
  deriveMinSegments,
  MAX_SEGMENTS_PER_CHAPTER,
  MIN_SEGMENT_SECONDS,
  MAX_SEGMENT_SECONDS,
  normalizeChapterScriptOutput,
  parseSharedSubjectPreset,
  SCRIPT_CONTRACT_VERSION,
  validateChapterScriptSegment,
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

function courierSegment(durationSeconds = 8) {
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

  it("rejects redefinition of shared subjects and broken continuation numbering", () => {
    const redefine = { ...courierSegment(), subjectDefinitions: `<Subject 1> ${COURIER_BASELINE}` };
    expect(validateChapterScriptSegment(redefine, SHARED)).toContainEqual(expect.stringContaining("与共享定义重复"));
    const restart = { ...courierSegment(), subjectDefinitions: "<Subject 1> is a new prop restarting numbering instead of continuing." };
    expect(validateChapterScriptSegment(restart, SHARED)).toContainEqual(expect.stringContaining("与共享定义重复"));
    const gap = { ...courierSegment(), subjectDefinitions: "<Subject 5> is a prop skipping the continuation order." };
    expect(validateChapterScriptSegment(gap, SHARED)).toContainEqual(expect.stringContaining("从 <Subject 3> 起连续递增"));
    const duplicate = { ...courierSegment(), subjectDefinitions: "<Subject 3> is a prop.\n<Subject 3> is the same prop again." };
    expect(validateChapterScriptSegment(duplicate, SHARED)).toContainEqual(expect.stringContaining("定义重复"));
  });

  it("allows an empty subjectDefinitions when shared subjects exist, and falls back without sharing", () => {
    const reuseOnly = { ...courierSegment(), subjectDefinitions: "" };
    expect(validateChapterScriptSegment(reuseOnly, SHARED)).toEqual([]);
    expect(assembleSegmentPromptText(reuseOnly)).not.toContain("subject_definitions:");
    expect(() => normalizeChapterScriptOutput(
      { plotBeats: PLOT_BEATS, characters: [], segments: [{ ...courierSegment(), subjectDefinitions: "" }] },
      { minSegments: 2, shared: SHARED },
    )).toThrow(/beat-memory|beat-deadline/s);
    expect(() => normalizeChapterScriptOutput(
      { plotBeats: PLOT_BEATS, characters: [], segments: [{ ...courierSegment(), subjectDefinitions: "" }] },
      { minSegments: 6, shared: { lines: [], maxLabel: 0 } },
    )).toThrow(/subjectDefinitions（无共享定义时必须在本段定义主体）/);
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

  describe("剧情节拍与呈现手段校验", () => {
    it("rejects a memory beat carried only by reaction actions without dialogue/flashback/on-screen text", () => {
      const reactionOnly = {
        ...memoryCarrierSegment(),
        detailedDescription: [
          "Live-action cinematic look.",
          "[Shot 1] Close-up of <Subject 1> clutching his head on the plank bed, eyes squeezed shut, knuckles whitening.",
          "[Shot 2] At 00:03.000, the shot cuts to <Subject 1> trembling, sweat dripping down his temple as he stares at his calloused palms.",
        ].join("\n"),
      };
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [courierSegment(), reactionOnly] })).toThrow(/没有呈现手段|反应动作/);
    });

    it("rejects beats that no segment carries", () => {
      const orphan = { ...validScript(), segments: [courierSegment()] };
      expect(() => normalizeChapterScriptOutput(orphan)).toThrow(/剧情节拍未被任何片段承载.*beat-memory|剧情节拍未被任何片段承载.*beat-deadline/s);
    });

    it("rejects beatIds referencing unknown beats and empty beat lists", () => {
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), beatIds: ["beat-ghost"] }, memoryCarrierSegment()] })).toThrow(/不存在的节拍 beat-ghost/);
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), beatIds: [] }, memoryCarrierSegment()] })).toThrow(/beatIds 为空/);
    });

    it("rejects missing or invalid plotBeats", () => {
      expect(() => normalizeChapterScriptOutput({ characters: [], segments: [courierSegment()] })).toThrow(/plotBeats/);
      expect(() => normalizeChapterScriptOutput({ plotBeats: [{ id: "b1", kind: "telepathy", summary: "未知类型节拍" }], characters: [], segments: [courierSegment()] })).toThrow(/没有有效的剧情节拍/);
    });
  });

  describe("时序与标记校验", () => {
    it.each([
      ["cut beyond duration", { durationSeconds: MIN_SEGMENT_SECONDS, detailedDescription: courierSectionFields().detailedDescription.replace("At 00:04.000", "At 00:06.500") }],
      ["non-increasing cut times", {
        detailedDescription: [
          "Live-action cinematic look.",
          "[Shot 1] A medium-wide shot frames the rain-glossed alley lamp as <Subject 1>, the courier in his faded grey uniform, steps into view beside <Subject 2>.",
          "[Shot 2] At 00:05.000, the shot cuts to a close-up of <Subject 1> (S1), who radios the station in Chinese, <d>[中文] 包裹不见了，先别回站。</d>",
          "[Shot 3] At 00:03.000, the shot cuts back to the alley entrance as drizzle keeps falling across the wall lamp.",
        ].join("\n"),
      }],
      ["opening shot carries a timestamp", { detailedDescription: courierSectionFields().detailedDescription.replace("[Shot 1] A medium-wide shot", "[Shot 1] At 00:00.500, a medium-wide shot") }],
      ["missing shot marker", { detailedDescription: "Live-action cinematic look. The camera follows the courier in his faded grey uniform as he crosses the lamp-lit alley and opens the empty satchel; nothing else happens." }],
    ])("rejects timing failure: %s", (_label, overrides) => {
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), ...overrides }] })).toThrow(/切点|镜头编号|时间戳|镜头标记|超出片段时长/);
    });

    it("rejects an unresolved reference label used outside definitions", () => {
      const fields = courierSectionFields();
      const broken = {
        ...fields,
        summary: `[reference generation] The target video follows <Subject 9> through the alley lamp light.`,
      };
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), ...broken }] })).toThrow(/<Subject 9>/);
    });

    it("rejects a defined label that is never used", () => {
      const fields = courierSectionFields();
      expect(() => normalizeChapterScriptOutput({
        ...validScript(),
        segments: [{ ...courierSegment(), subjectDefinitions: `${fields.subjectDefinitions}\n<Subject 3> is an unused radio prop.` }],
      })).toThrow(/未被.*使用|未被 summary/);
    });

    it("rejects unpaired dialogue tags and missing language markers", () => {
      const unclosed = courierSectionFields().detailedDescription.replace("</d>", "");
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), detailedDescription: unclosed }] })).toThrow(/标签不配对/);
      const unlabeled = courierSectionFields().detailedDescription.replace("[中文] ", "");
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), detailedDescription: unlabeled }] })).toThrow(/语言标注/);
    });

    it("rejects a summary without the bracketed task-type prefix", () => {
      const noPrefix = courierSectionFields().summary.replace(/^\[reference generation\]\s*/u, "");
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), summary: noPrefix }] })).toThrow(/任务类型前缀/);
    });

    it("rejects invented audio assets and empty section fields", () => {
      const fields = courierSectionFields();
      expect(() => normalizeChapterScriptOutput({
        ...validScript(),
        segments: [{ ...courierSegment(), subjectDefinitions: `${fields.subjectDefinitions}\n<Audio 1> is the reused source audio track.` }],
      })).toThrow(/Audio N/);
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(), overallSoundscape: "" }] })).toThrow(/字段为空：overallSoundscape/);
    });

    it("rejects out-of-range durations aligned with the schema bounds", () => {
      expect(() => normalizeChapterScriptOutput({ ...validScript(), segments: [{ ...courierSegment(4) }] })).toThrow(/durationSeconds/);
      expect(CHAPTER_SCRIPT_H3_SCHEMA.properties.segments.maxItems).toBe(MAX_SEGMENTS_PER_CHAPTER);
      expect(CHAPTER_SCRIPT_H3_SCHEMA.properties.segments.items.properties.durationSeconds.maximum).toBe(MAX_SEGMENT_SECONDS);
    });

    it("fails closed when no valid object is returned", () => {
      expect(() => normalizeChapterScriptOutput(null)).toThrow();
      expect(() => normalizeChapterScriptOutput({ plotBeats: PLOT_BEATS, characters: [], segments: [] })).toThrow();
    });
  });

  describe("剧情覆盖下限", () => {
    it("derives the floor from chapter length and clamps to bounds", () => {
      expect(deriveMinSegments("短")).toBe(6);
      expect(deriveMinSegments("字".repeat(3556))).toBe(11);
      expect(deriveMinSegments("字".repeat(999_999))).toBe(MAX_SEGMENTS_PER_CHAPTER);
    });

    it("rejects segment sets below the floor with a repairable message", () => {
      expect(() => normalizeChapterScriptOutput(validScript(), { minSegments: 6 })).toThrow(/覆盖不足.*下限 6|剧情节拍未被任何片段承载/s);
    });

    it("accepts segment sets at or above the floor", () => {
      const result = normalizeChapterScriptOutput(validScript(), { minSegments: 2 });
      expect(result.segments).toHaveLength(2);
    });
  });
});

describe("影视镜头语言提示（cinematicHints，提示级）", () => {
  it("flags shots missing camera motion or framing vocabulary without blocking", () => {
    const flat = {
      ...courierSegment(),
      detailedDescription: [
        "Live-action cinematic look.",
        "[Shot 1] The courier stands in the alley and opens his empty satchel while rain keeps falling.",
        "[Shot 2] At 00:04.000, the shot cuts to <Subject 1> staring at his calloused palms under the lamplight.",
      ].join("\n"),
    };
    const hints = computeCinematicHints([{ ...courierSegment(), index: 1, promptText: "" }, { ...flat, index: 2, promptText: "" }]);
    expect(hints.some((hint) => hint.startsWith("片段 1"))).toBe(false);
    expect(hints.filter((hint) => hint.startsWith("片段 2")).length).toBe(2);
    expect(hints[0]).toContain("镜头四要素");
  });

  it("passes shots that carry camera motion or framing vocabulary", () => {
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

  it("embeds the v5 episode dramaturgy contract (hook opening, cadence, cut-point exits, dialogue density, plant chain, character economy)", () => {
    const prompt = buildChapterScriptPrompt({
      projectTitle: "长夜货运",
      chapterTitle: "空袋",
      narrativeOrder: 9,
      plainText: "陈默蹲下检查拉链……",
      characters: [],
      minSegments: 6,
      shared: { lines: [], maxLabel: 0 },
    });
    expect(prompt).toContain("剧集剧作契约");
    expect(prompt).toContain("开场即冲突");
    expect(prompt).toContain("铺垫性开场");
    expect(prompt).toContain("情绪节点节奏");
    expect(prompt).toContain("出口即钩子");
    expect(prompt).toContain("冲击瞬间切卡");
    expect(prompt).toContain("台词密度");
    expect(prompt).toContain("反转须有伏笔");
    expect(prompt).toContain("人物经济");
    expect(SCRIPT_CONTRACT_VERSION).toBe("5");
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
