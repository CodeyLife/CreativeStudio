import { describe, expect, it } from "vitest";
import { applyRevisionWindows, applyTargetedRevisionReplacements, buildAuthorRevisionBrief, buildFullChapterRevisionPrompt, planRevisionWindows, sanitizeRevisionOutput } from "../prompts/chapter-revision";
import type { MemoryBundle, ReviewIssue } from "../protocol";

const memory: MemoryBundle = {
  id: "m", projectId: "p", preflightId: "pf", claims: [], conflicts: [], missingFacets: [], tokenBudget: 1000,
  sourceRevisionIds: [], fingerprint: "m", createdAt: 1,
};

describe("chapter revision", () => {
  it("sanitizes structural instruction wrappers without phrase-specific matching", () => {
    expect(sanitizeRevisionOutput("```text\n正文第一段。\n\n正文第二段。\n```")).toBe("正文第一段。\n\n正文第二段。");
    expect(sanitizeRevisionOutput("修订结果：\n正文第一段。\n\n正文第二段。")).toContain("正文第一段。");
  });

  it("plans evidence windows and preserves unrelated paragraphs", () => {
    const text = "第一段。\n\n第二段。\n\n第三段。\n\n第四段。";
    const issues: ReviewIssue[] = [{ severity: "major", title: "证据问题", evidence: "第二段。", revisionRanges: [{ start: 2, end: 2 }], suggestion: "改变承载方式" }];
    const [window] = planRevisionWindows(text, issues);
    expect(window).toMatchObject({ start: 1, end: 1 });
    expect(applyRevisionWindows(text, [{ window, text: "替换第二段。" }])).toBe("第一段。\n\n替换第二段。\n\n第三段。\n\n第四段。");
  });

  it("applies only the declared targeted windows", () => {
    const text = "甲。\n\n乙。\n\n丙。";
    const windows = planRevisionWindows(text, [{ severity: "warning", title: "乙", evidence: "乙。", revisionRanges: [{ start: 2, end: 2 }] }]);
    expect(applyTargetedRevisionReplacements(text, windows, [{ start: 2, end: 2, text: "新乙。" }])).toBe("甲。\n\n新乙。\n\n丙。");
    expect(() => applyTargetedRevisionReplacements(text, windows, [{ start: 1, end: 1, text: "越界" }])).toThrow();
  });

  it("keeps author direction general and separate from the issue contract", () => {
    const brief = buildAuthorRevisionBrief("让这一段更舒缓，并通过动作表现人物的犹豫。");
    expect(brief).toContain("让这一段更舒缓，并通过动作表现人物的犹豫。");
    expect(brief).toContain("自行判断受影响范围");
    expect(brief).not.toContain("固定字数");
  });

  it("uses evidence and author direction without adding chapter-level literary obligations", () => {
    const prompt = buildFullChapterRevisionPrompt({
      text: "她推开门。\n\n屋里没有人。",
      memory,
      issues: [{ severity: "major", title: "因果跳步", evidence: "她推开门。", revisionRanges: [{ start: 1, end: 1 }], suggestion: "补足可观察的承接" }],
      authorInstruction: "让动作更有停顿感。",
    });
    expect(prompt).toContain("让动作更有停顿感。");
    expect(prompt).toContain("因果跳步");
    expect(prompt).not.toContain("narrativeScale");
    expect(prompt).not.toContain("必须有新鲜贡献");
  });
});
