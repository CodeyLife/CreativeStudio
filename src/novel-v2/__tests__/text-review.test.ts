import { describe, expect, it } from "vitest";
import { parseTextReview, opinionToReviewIssue } from "../text-review";

describe("parseTextReview", () => {
  it("treats a lone PASSED line as passed regardless of case and whitespace", () => {
    for (const text of ["PASSED", "passed", "  PASSED  ", "PASSED\n"]) {
      expect(parseTextReview(text)).toEqual({ verdict: "passed", opinion: "" });
    }
  });

  it("treats PASSED with trailing punctuation as passed (marker may end with a period)", () => {
    for (const text of ["PASSED。", "PASSED.", "PASSED：", "PASSED:", "PASSED。 "]) {
      expect(parseTextReview(text)).toEqual({ verdict: "passed", opinion: "" });
    }
  });

  it("treats PASSED with trailing content as revise to avoid swallowing opinions", () => {
    const result = parseTextReview("PASSED\n但第二卷的承诺与人物配置不匹配");
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toContain("但第二卷");
  });

  it("treats a long analysis ending with a PASSED marker line as passed", () => {
    // 审核模型未严格遵循"通过只输出单行 PASSED"契约，输出逐项分析后以 PASSED 收尾；
    // 通过意图以显式标记结尾为证据，应判 passed（不把长分析误判为 revise）。
    const result = parseTextReview(
      "逐章检查：\n第1章：状态转换证据确凿，无问题。\n第7章：伏笔合理。\nPASSED",
    );
    expect(result.verdict).toBe("passed");
    expect(result.opinion).toBe("");
  });

  it("treats a paragraph ending with a PASSED marker as passed", () => {
    // 模型把 PASSED 写在最后一段末尾（"……。PASSED"），而非独立一行，也应判 passed。
    const result = parseTextReview(
      "我的判断是有几个非阻断建议但无 major，应该 PASSED。输出 PASSED。PASSED",
    );
    expect(result.verdict).toBe("passed");
    expect(result.opinion).toBe("");
  });

  it("keeps revise when PASSED is embedded mid-sentence, not a closing verdict", () => {
    // 观点句中夹带的 PASSED（前缀非分隔符结尾）不得误判为通过结论。
    const result = parseTextReview("这个修改已 PASSED，可以继续。");
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toContain("PASSED");
  });

  it("keeps a revise verdict when the trailing line is an opinion, not a PASSED marker", () => {
    // 最后一行不是 PASSED 标记（即使前文提到"通过"），仍须判 revise 并保留意见。
    const result = parseTextReview("第5章存在因果缺环，需补充动机。\n其余各章可以接受。");
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toContain("因果缺环");
  });

  it("strips a PASSED marker prefix echoed before the opinion", () => {
    const result = parseTextReview("PASSED：第一处问题：契约与架构脱节。");
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toBe("第一处问题：契约与架构脱节。");
    const lineBreak = parseTextReview("PASSED\n第一处问题：因果缺环。");
    expect(lineBreak.verdict).toBe("revise");
    expect(lineBreak.opinion).toBe("第一处问题：因果缺环。");
  });

  it("keeps a PASSED-prefixed opinion line when no marker-only line exists", () => {
    const opinion = "PASSED 与否不应影响以下判断：支线缺少退出条件。";
    const result = parseTextReview(opinion);
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toBe(opinion);
  });

  it("extracts review text from code fences", () => {
    const result = parseTextReview("```\n第一处问题：契约与架构脱节。\n```");
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toBe("第一处问题：契约与架构脱节。");
  });

  it("keeps arbitrary non-PASSED content as the opinion verbatim", () => {
    const opinion = "第一处问题：读者承诺与事件规模不匹配；第二处问题：支线缺少退出条件。";
    const result = parseTextReview(opinion);
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toBe(opinion);
  });

  it("strips a leading instruction echo line before the opinion", () => {
    const result = parseTextReview("审核意见：\n第一处问题：因果缺环。");
    expect(result.verdict).toBe("revise");
    expect(result.opinion).toBe("第一处问题：因果缺环。");
  });

  it("falls back to a non-empty opinion for empty revise output", () => {
    const result = parseTextReview("");
    expect(result.verdict).toBe("revise");
    expect(result.opinion.length).toBeGreaterThan(0);
  });
});

describe("opinionToReviewIssue", () => {
  it("projects the opinion into a single major issue with evidence", () => {
    const issue = opinionToReviewIssue("意见全文", "fingerprint-1");
    expect(issue).toMatchObject({
      severity: "major",
      title: "规划审核意见",
      description: "意见全文",
      evidence: "fingerprint-1",
      suggestion: "意见全文",
    });
  });
});
