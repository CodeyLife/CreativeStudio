import { describe, expect, it } from "vitest";
import { extractAssetMentions, groupAssetSpans } from "../asset-ledger";
import { scanPovResiduals } from "../pov-scan";

describe("extractAssetMentions", () => {
  it("extracts numeral + measure word + subject triples, grouping bare-form mentions", () => {
    const mentions = extractAssetMentions("他捏了捏袖中那两块硬邦邦的灵石。案上还有三株云纹草。");
    const subjects = mentions.map((m) => `${m.quantity}${m.subject}`);
    expect(subjects).toContain("那两块灵石");
    expect(subjects).toContain("三株云纹草");
  });

  it("resolves Chinese numerals to values and keeps vague quantities null", () => {
    const mentions = extractAssetMentions("怀里揣着两块下品灵石，树下散落几块碎砖。");
    const stone = mentions.find((m) => m.subject.includes("灵石"));
    const brick = mentions.find((m) => m.subject.includes("碎砖"));
    expect(stone?.value).toBe(2);
    expect(brick?.value).toBeNull();
  });

  it("skips identity stoplist subjects", () => {
    const mentions = extractAssetMentions("门口站着三个弟子。");
    expect(mentions.find((m) => m.subject === "弟子")).toBeUndefined();
  });
});

describe("groupAssetSpans", () => {
  it("groups mentions by subject across chapters and keeps multi-chapter entities only", () => {
    const spans = groupAssetSpans([
      { narrativeOrder: 1, mentions: extractAssetMentions("他清点了那两块灵石") },
      { narrativeOrder: 2, mentions: extractAssetMentions("那块灵石已经耗尽，桌上放着一把铁铲") },
      { narrativeOrder: 3, mentions: extractAssetMentions("三株云纹草") },
    ]);
    const stone = spans.find((span) => span.subject.includes("灵石"));
    expect(stone?.entries).toHaveLength(2);
    expect(stone?.entries[0]).toEqual({ narrativeOrder: 1, quantity: "那两块", value: 2 });
    // 单章出现的实体（铁铲/云纹草）不进入跨度。
    expect(spans.find((span) => span.subject.includes("云纹草"))).toBeUndefined();
  });
});

describe("scanPovResiduals", () => {
  it("flags non-pov character interiority sentences", () => {
    const hits = scanPovResiduals(
      "这种沉默让赵虎有些不悦。他嗤笑一声。\n\n楚衡心中暗惊。",
      ["楚衡"],
      ["赵虎", "楚衡"],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ paragraph: 1, character: "赵虎", marker: "不悦" });
  });

  it("ignores pov character interiority and returns nothing without other characters", () => {
    expect(scanPovResiduals("楚衡心中暗惊。", ["楚衡"], ["楚衡"])).toHaveLength(0);
    expect(scanPovResiduals("赵虎心中不悦。", ["楚衡"], [])).toHaveLength(0);
  });
});
