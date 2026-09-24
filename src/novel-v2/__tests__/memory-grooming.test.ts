import { describe, expect, it } from "vitest";
import { textBigramDice } from "../memory-grooming";

describe("textBigramDice（字符二元组相似度）", () => {
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
});
