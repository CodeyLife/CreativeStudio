import { describe, expect, it } from "vitest";
import { groupClaimsBySlot, textBigramDice } from "../memory-grooming";

describe("memory grooming diagnostics (memory-governance-audit-20260909 §5.5)", () => {
  it("scores near-duplicate paraphrases high and unrelated statements low", () => {
    const a = "齐姓人提出交易：每月上报所见换取月例翻倍、旧欠勾销和养脉药。";
    const b = "听闻齐姓人提出的条件：每月写报所见，换月例翻倍、旧欠项不再被翻。";
    const c = "老槐树的一片叶子在没有风的夜里轻轻颤动。";
    // 相对排序契约：同义改写显著高于无关文本；完全相同=1。绝对阈值属运行参数，不进测试。
    const paraphrase = textBigramDice(a, b);
    const unrelated = textBigramDice(a, c);
    expect(paraphrase).toBeGreaterThan(unrelated * 2);
    expect(paraphrase).toBeGreaterThan(0.3);
    expect(unrelated).toBeLessThan(0.2);
    expect(textBigramDice(a, a)).toBe(1);
  });

  it("groups claims by normalized subject and canonical predicate across pipelines", () => {
    const base = { narrative_start: 3, authority: "derived", created_at: new Date("2026-09-09T00:00:00Z") };
    const groups = groupClaimsBySlot("p1", [
      { id: "claim:p1:facthash", subject_refs: ["char_hero"], predicate: "知晓", content: "主角得知北门封闭", ...base },
      { id: "claim:knowledge:r3:knowhash", subject_refs: ["char_hero"], predicate: "character-knows", content: "听闻北门已经封闭", ...base },
      { id: "claim:p1:otherhash", subject_refs: ["char_hero"], predicate: "持有", content: "主角持有一块玉牌", ...base },
      { id: "foundation:some-artifact", subject_refs: ["foundation:characters", "facet:fact"], predicate: null, content: "foundation projection", ...base },
    ]);
    // 知晓与 character-knows 经谓词别名归一落入同一槽位——跨管道重复在该槽位可见。
    const knowsGroup = groups.find((group) => group.predicate === "知晓");
    expect(knowsGroup?.claims).toHaveLength(2);
    expect(knowsGroup?.claims.map((claim) => claim.sourcePipeline)).toEqual(["fact-extraction", "character-enrichment"]);
    expect(groups.find((group) => group.predicate === "持有")?.claims).toHaveLength(1);
    // Foundation 投影（predicate 为空）与 facet:fact 引用不进入槽位。
    expect(groups.find((group) => group.subject === "foundation:characters")).toBeUndefined();
  });

  it("ranks duplicate candidates by similarity within a slot", () => {
    const base = { narrative_start: 5, authority: "derived", created_at: new Date("2026-09-09T00:00:00Z") };
    const groups = groupClaimsBySlot("p1", [
      { id: "a", subject_refs: ["char_hero"], predicate: "知晓", content: "执事弟子当众宣布例供未缴限期三天缴齐三块下品灵石", ...base },
      { id: "b", subject_refs: ["char_hero"], predicate: "知晓", content: "执事弟子当众宣布上月例供未缴，限期三天缴齐三块下品灵石", ...base },
      { id: "c", subject_refs: ["char_hero"], predicate: "知晓", content: "完全无关的另一条长句内容，谈论的是药田除草与贡献点报酬的安排", ...base },
    ]);
    const group = groups[0];
    expect(group.claims).toHaveLength(3);
    expect(group.duplicateCandidates.length).toBeGreaterThanOrEqual(1);
    expect(group.duplicateCandidates[0].similarity).toBeGreaterThan(0.5);
  });
});
