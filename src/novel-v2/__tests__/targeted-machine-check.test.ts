import { describe, expect, it } from "vitest";
import { buildTargetedIssueMachineCheck, summarizeTargetedMachineChecks, type TargetedIssueMachineCheck } from "../evidence-check";
import type { ReviewIssue } from "../protocol";

const BEFORE = `清晨的杂役峰还笼着一层薄雾。\n\n“上月灵石两块。”刘管事把一块灵石搁在案面，指节叩了叩桌面。\n\n他退出去，站在门外冷风里。`;
const AFTER_FIXED = `清晨的杂役峰还笼着一层薄雾。\n\n“上月灵石两块。”刘管事从木匣里数出两块灵石，并排搁在案上，又当面收回一块。\n\n他退出去，站在门外冷风里，指节还在发麻。`;
const AFTER_UNCHANGED = BEFORE;

function issue(partial: { excerpt: string; revisionRanges: Array<{ start: number; end: number }> }): Pick<ReviewIssue, "evidence" | "excerpt" | "revisionRanges"> {
  return { evidence: partial.excerpt, excerpt: partial.excerpt, revisionRanges: partial.revisionRanges };
}

describe("buildTargetedIssueMachineCheck", () => {
  it("flags evidence still present when the targeted text was not actually changed", () => {
    // ch15 实证：修订窗口外残留旧结局，批准者需机器信号「证据仍在候选中」。
    const check = buildTargetedIssueMachineCheck(
      issue({ excerpt: `“上月灵石两块。”刘管事把一块灵石搁在案面，指节叩了叩桌面。`, revisionRanges: [{ start: 2, end: 2 }] }),
      { textBefore: BEFORE, textAfter: AFTER_UNCHANGED },
    );
    expect(check.evidenceStillPresent).toBe(true);
    expect(check.revisionRanges).toEqual([{ start: 2, end: 2 }]);
  });

  it("reports evidence removal for a real fix", () => {
    const check = buildTargetedIssueMachineCheck(
      issue({ excerpt: `“上月灵石两块。”刘管事把一块灵石搁在案面，指节叩了叩桌面。`, revisionRanges: [{ start: 2, end: 2 }] }),
      { textBefore: BEFORE, textAfter: AFTER_FIXED },
    );
    expect(check.evidenceStillPresent).toBeUndefined();
  });

  it("marks evidence stale when the evidence quote no longer exists before the revision", () => {
    // ch6×5 / ch2 期限条目实证：证据引用已删除文本，采纳将复现已修复的矛盾。
    const check = buildTargetedIssueMachineCheck(
      issue({ excerpt: "那弟子如蒙大赦，连滚带爬地从地上站起来，跌跌撞撞地冲出了食堂大门。", revisionRanges: [{ start: 57, end: 57 }] }),
      { textBefore: BEFORE, textAfter: AFTER_FIXED },
    );
    expect(check.evidenceStale).toBe(true);
  });

  it("leaves evidence checks indeterminate for short or vague quotes", () => {
    const check = buildTargetedIssueMachineCheck(
      issue({ excerpt: "太短", revisionRanges: [] }),
      { textBefore: BEFORE, textAfter: AFTER_FIXED },
    );
    expect(check.evidenceStale).toBeUndefined();
    expect(check.evidenceStillPresent).toBeUndefined();
  });
});

describe("summarizeTargetedMachineChecks", () => {
  it("passes when no blocking flags are present", () => {
    const checks: TargetedIssueMachineCheck[] = [{ revisionRanges: [{ start: 1, end: 1 }] }, { revisionRanges: [] }];
    expect(summarizeTargetedMachineChecks(checks).ok).toBe(true);
  });

  it("fails when evidence is stale or still present", () => {
    expect(summarizeTargetedMachineChecks([{ revisionRanges: [], evidenceStale: true }]).ok).toBe(false);
    expect(summarizeTargetedMachineChecks([{ revisionRanges: [], evidenceStillPresent: true }]).ok).toBe(false);
    expect(summarizeTargetedMachineChecks([{ revisionRanges: [] }]).ok).toBe(true);
  });
});
