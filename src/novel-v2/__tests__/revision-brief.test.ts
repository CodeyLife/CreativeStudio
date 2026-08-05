import { describe, expect, it } from "vitest";
import { buildRevisionBrief, buildRevisionDirection, shouldBlockRevisionForConflicts } from "../application/revision-brief";
import type { Review, ReviewIssue } from "../protocol";

const issue = (title: string, evidence = "他停住了。"): ReviewIssue => ({
  severity: "major",
  title,
  evidence,
  excerpt: evidence,
  revisionRanges: [{ start: 1, end: 1 }],
  rule: "causal-fit",
  suggestion: "补足可观察的触发与反应。",
});

const review = (id: string, issues: ReviewIssue[]): Review => ({
  id,
  projectId: "p1",
  artifactId: "a1",
  reviewerId: id,
  identity: "internal",
  verdict: issues.length ? "revise" : "passed",
  issues,
  artifactFingerprint: "fp",
  createdAt: 1,
});

describe("revision brief", () => {
  it("clusters issues by evidence and rule without dimension fields", () => {
    const brief = buildRevisionBrief([
      review("structure", [issue("因果跳步")]),
      review("prose", [issue("停顿缺少承载")]),
    ]);
    expect(brief.clusters).toHaveLength(1);
    expect(brief.clusters[0].issue).toMatchObject({ rule: "causal-fit", evidence: "他停住了。" });
  });

  it("keeps author direction separate from reviewer issue structure", () => {
    const direction = buildRevisionDirection({
      directedIssues: [issue("对白过直")],
      authorInstruction: "保留沉默感，只让动作更明确。",
      chapterParagraphCount: 4,
    });
    expect(direction.authorInstruction).toContain("保留沉默感");
    expect(direction.strictRevisionWindows).toBe(true);
  });

  it("lets explicit author direction discard conflicting reviewer directives", () => {
    const preserve: ReviewIssue = {
      ...issue("术语处理"),
      suggestion: "保留抽象术语。",
    };
    const remove: ReviewIssue = {
      ...issue("术语处理"),
      suggestion: "删除抽象术语。",
    };
    const brief = buildRevisionBrief([review("structure", [preserve]), review("prose", [remove])]);

    expect(brief.conflicts).toHaveLength(1);
    expect(shouldBlockRevisionForConflicts(brief.conflicts, false)).toBe(true);
    expect(shouldBlockRevisionForConflicts(brief.conflicts, true)).toBe(false);
  });
});
