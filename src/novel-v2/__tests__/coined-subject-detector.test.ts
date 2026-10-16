import { describe, expect, it, vi } from "vitest";
import { detectCoinedSubjects } from "../temporal/activities";

/**
 * 自造主体检测（2026-10-14 复核轮 round 64）。
 *
 * 由来（round 59/60/64）：提取 prompt 已禁止"subject.id 由多个词拼合而成"与
 * "描述性短语作主体"，但 prompt 约束不保证旧数据与新模型都遵守；
 * round 59/60 在生产库实测到 **33 个**正文 0 次的主体（166 个里）。
 * 故在 fact-extraction 的 activity 里兜一道运行时检测（`detectCoinedSubjects`），
 * 按 round 59 的特征信号判：**整串不在正文、而存在一种切分使两段都在正文**。
 *
 * 用例全部取自**生产库实测样本**（`tmp/state-audit/verify-all-subject-coining.mts`），
 * 不用臆造数据：这是 round 58/60 反复验证过的做法（代理必须用真实样本校准）。
 */
describe("detectCoinedSubjects（round 64）", () => {
  const NOVEL = [
    "他扯过盖布，那之物压在箱底。",
    "卯时岗棚换了一张生脸，翻册生疏。",
    "杂役们在补发房抄写册子。",
    "灰衣被汗水浸透。",
    "窗外老头抬起头。",
  ].join("");

  const claim = (...subjects: string[]) => ({ subjectRefs: subjects });

  it("① 检出拼合型自造主体（生产实测形态）", () => {
    const found = detectCoinedSubjects([
      claim("灰衣杂役"),   // 正文：灰衣 3 次、杂役 335 次、合称 0 次
      claim("盖布之物"),   // 正文：盖布（合句出现）+ 之物
      claim("岗棚生脸"),   // 正文：岗棚 + 生脸
      claim("补发房抄写人"), // 前缀型："补发房抄"在正文、"写人"不在 ⇒ round 64 漏检、round 65 补上
    ], NOVEL);
    expect(found).toContain("灰衣杂役");
    expect(found).toContain("盖布之物");
    expect(found).toContain("岗棚生脸");
    expect(found).toContain("补发房抄写人");
  });

  it("② 正文真实出现过的合称不报（防误伤）", () => {
    const text = "补发房抄写人把册子合上。灰衣杂役站在门口。";
    // 这两个在 text 里是真身 ⇒ 不得检出。
    expect(detectCoinedSubjects([claim("补发房抄写人"), claim("灰衣杂役")], text)).toEqual([]);
  });

  it("③ 机器生成的键形态不参与检测", () => {
    const found = detectCoinedSubjects([
      claim("character:char_chu_heng"),
      claim("foundation:worldview"),
      claim("facet:fact"),
      claim("graph-thread:main"),
    ], NOVEL);
    expect(found).toEqual([]);
  });

  it("④ 长度 < 3 的主体不参与（两字主体无切分空间）", () => {
    expect(detectCoinedSubjects([claim("老头"), claim("岗棚")], NOVEL)).toEqual([]);
  });

  it("⑤ 完全无出处的整串幻觉不报——属更严重但需人核的另一类", () => {
    // "城南看物屋"：所有两段切分（城南/看物屋、城南看/物屋、城南看物/屋）都不成立
    // （正文里这些片段都不出现）⇒ 检测器不报。
    // 这是有意的保守：只报"可确认是拼出来的"，不报"完全没出处"的
    // （后者在 round 60 实测里更严重，但需要人工核，不该由检测器自动判）。
    const found = detectCoinedSubjects([claim("城南看物屋")], "巷尾有一间无人认领的旧屋子，久无人至。");
    expect(found).toEqual([]);
  });

  it("⑤b 前缀型必须被抓到（round 65 的切分口径修正）", () => {
    // "补发房抄写人"：前缀"补发房抄"在正文、尾部"写人"不在 ⇒ 仍是拼出来的称呼。
    // round 64 只查"两段都在正文"的切分，任何切分都凑不齐 ⇒ 整条漏检。
    const found = detectCoinedSubjects([claim("补发房抄写人")], "杂役们在补发房抄写册子。");
    expect(found).toEqual(["补发房抄写人"]);
    // 反向确认：正文里确实没有"补发房抄写人"这个合称。
    expect("杂役们在补发房抄写册子。".includes("补发房抄写人")).toBe(false);
  });

  it("⑥ 空输入与去重", () => {
    expect(detectCoinedSubjects([], NOVEL)).toEqual([]);
    expect(detectCoinedSubjects([claim(), claim(undefined as unknown as string)], NOVEL)).toEqual([]);
    const duplicated = detectCoinedSubjects([claim("灰衣杂役"), claim("灰衣杂役")], NOVEL);
    expect(duplicated).toEqual(["灰衣杂役"]);
  });

  it("⑦ 反向哨兵：检测器真的会响", () => {
    // 一个由两个正文词拼成、但合称不在正文的主体，必须被检出。
    const text = "alpha beta";
    expect(detectCoinedSubjects([claim("alphabeta")], text)).toEqual(["alphabeta"]);
    expect(text.includes("alphabeta")).toBe(false); // 确认合称确实不在正文
    expect(vi.isMockFunction(() => undefined)).toBe(false); // 防呆：该断言不得因误写而恒真
  });
});
