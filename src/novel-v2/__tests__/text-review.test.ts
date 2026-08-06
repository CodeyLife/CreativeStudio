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
