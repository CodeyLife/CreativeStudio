import { describe, expect, it } from "vitest";
import { describePromptPatchFormatWarning, parseCraftRulePromptPatch } from "../craft-rule/prompt-patch";

const multiSectionBefore = JSON.stringify({
  "chapter.review.structure": "结构审核条款",
  drafting: "起草条款",
});

describe("describePromptPatchFormatWarning", () => {
  it("多执行点快照 + 纯文本 afterText → 告警（promote 将覆盖 drafting 段）", () => {
    const warning = describePromptPatchFormatWarning(multiSectionBefore, "只针对结构审核的新条款文本");
    expect(warning).toContain("drafting");
    expect(warning).toContain("chapter.review.structure");
  });

  it("execution-point patch JSON → 不告警", () => {
    const warning = describePromptPatchFormatWarning(multiSectionBefore, JSON.stringify({ "chapter.review.structure": "新条款" }));
    expect(warning).toBeUndefined();
  });

  it("beforeText 非 JSON（旧版纯文本 skill）→ 不告警", () => {
    const warning = describePromptPatchFormatWarning("旧版单段 skill 文本", "新版纯文本");
    expect(warning).toBeUndefined();
  });

  it("beforeText 单段 map → 不告警（旧版纯文本 afterText 语义兼容）", () => {
    const warning = describePromptPatchFormatWarning(JSON.stringify({ review: "单段条款" }), "新纯文本");
    expect(warning).toBeUndefined();
  });

  it("纯文本 afterText 经 parseCraftRulePromptPatch 确实落入 drafting（告警所依据的回退行为）", () => {
    const sections = parseCraftRulePromptPatch("纯文本条款");
    expect(sections).toEqual({ drafting: "纯文本条款" });
  });
});
