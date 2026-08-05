import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { mergeReaderReconstructionEvidence, normalizeReviewIssueReaderEvidence, READER_RECONSTRUCTION_CONTRACT } from "../reader-reconstruction";
import { reviewerSchema } from "../prompts/schemas";

describe("reader reconstruction contract", () => {
  it("normalizes a core reader failure to at least a major issue", () => {
    const result = normalizeReviewIssueReaderEvidence({
      severity: "warning",
      readerReconstruction: {
        impact: "core",
        missingEvidence: ["body", "action"],
        blockedQuestion: "读者无法判断人物为何从站立改为爬行",
      },
    });

    expect(result.severity).toBe("major");
    expect(result.readerReconstruction).toMatchObject({ impact: "core", missingEvidence: ["body", "action"] });
  });

  it("keeps local evidence local and does not create a lexical ban", () => {
    const result = normalizeReviewIssueReaderEvidence({
      severity: "warning",
      readerReconstruction: {
        impact: "local",
        missingEvidence: ["consequence"],
        blockedQuestion: "读者暂时不清楚一个局部动作造成的轻微变化",
      },
    });

    expect(result.severity).toBe("warning");
    expect(READER_RECONSTRUCTION_CONTRACT).not.toContain("输入");
    expect(READER_RECONSTRUCTION_CONTRACT).not.toContain("报警");
    expect(READER_RECONSTRUCTION_CONTRACT).toContain("不能成为当前行动的唯一主语、唯一动因或唯一后果");
    expect(READER_RECONSTRUCTION_CONTRACT).toContain("事实、选择和因果都不变");
  });

  it("accepts sentinel none objects for unrelated issues and structured evidence for reader failures", () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(reviewerSchema);
    const base = {
      verdict: "revise",
      score: 3.5,
      issues: [{
        severity: "major",
        title: "现场承载不足",
        description: "关键动作缺少后果",
        excerpt: "动作证据",
        revisionRanges: [{ start: 1, end: 1 }],
        rule: "抽象判断替代现场经验",
        suggestion: "补足动作后的变化",
        readerReconstruction: {
          impact: "core",
          missingEvidence: ["action", "consequence"],
          blockedQuestion: "读者无法判断动作如何改变下一步选择",
        },
      }],
    };
    expect(validate(base)).toBe(true);
    // LLM 输出契约使用 impact=none sentinel（type 联合在 provider strict json_schema 下兼容性不一）；
    // normalizeReviewIssueReaderEvidence 把它归一为 null，下游语义不变。
    expect(validate({ ...base, issues: [{ ...base.issues[0], readerReconstruction: { impact: "none", missingEvidence: [], blockedQuestion: "" } }] })).toBe(true);
    expect(validate({ ...base, issues: [{ ...base.issues[0], readerReconstruction: null }] })).toBe(false);
    expect(validate({ ...base, issues: [{ ...base.issues[0], readerReconstruction: undefined }] })).toBe(false);
    expect(normalizeReviewIssueReaderEvidence({
      severity: "warning",
      readerReconstruction: { impact: "none", missingEvidence: [], blockedQuestion: "" },
    }).readerReconstruction).toBeNull();
  });

  it("merges evidence from multiple reviewers without weakening core impact", () => {
    expect(mergeReaderReconstructionEvidence(
      { impact: "local", missingEvidence: ["action"], blockedQuestion: "局部动作缺少承接" },
      { impact: "core", missingEvidence: ["consequence"], blockedQuestion: "读者无法判断选择造成的结果" },
    )).toEqual({
      impact: "core",
      missingEvidence: ["action", "consequence"],
      blockedQuestion: "读者无法判断选择造成的结果",
    });
  });
});
