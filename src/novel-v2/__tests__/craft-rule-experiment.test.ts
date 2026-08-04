import { describe, expect, it } from "vitest";
import { buildScenarioProfile, evaluateChapterRegression, parseCandidatePromptSections, resolveCraftRuleSourceDocumentId, wasCandidatePromptPatchConsumed } from "../evaluation/craft-rule-experiment";
import { areScenarioProfilesMateriallyDifferent } from "../craft-rule";
import { mergeCraftRulePromptSections } from "../craft-rule/prompt-patch";
import { canonicalSha256 } from "../canonical-json";

describe("craft-rule chapter experiment", () => {
  it("derives stable scenario profiles and rejects id-only differences", () => {
    const first = buildScenarioProfile({ id: "d1", projectId: "p1", title: "章节", narrativeOrder: 1, status: "final", povCharacterId: "pov-a", createdAt: "now", updatedAt: "now" });
    const sameShape = buildScenarioProfile({ id: "d2", projectId: "p1", title: "另一章", narrativeOrder: 2, status: "final", povCharacterId: "pov-a", createdAt: "now", updatedAt: "now" });
    const differentPov = buildScenarioProfile({ id: "d3", projectId: "p1", title: "另一视角", narrativeOrder: 3, status: "final", povCharacterId: "pov-b", createdAt: "now", updatedAt: "now" });

    expect(first.fingerprint).toBe(sameShape.fingerprint);
    expect(areScenarioProfilesMateriallyDifferent(first, sameShape)).toBe(false);
    expect(areScenarioProfilesMateriallyDifferent(first, differentPov)).toBe(true);
  });

  it("keeps execution-point sections and normalizes legacy plain text", () => {
    expect(parseCandidatePromptSections(JSON.stringify({ "chapter.drafting": "按可观察行动展开", "chapter.revision": "只修复有证据的问题" }))).toEqual({
      "chapter.drafting": "按可观察行动展开",
      "chapter.revision": "只修复有证据的问题",
    });
    expect(parseCandidatePromptSections("旧候选文本")).toEqual({ drafting: "旧候选文本" });
  });

  it("merges a patch into existing execution points instead of replacing the Skill", () => {
    expect(mergeCraftRulePromptSections(
      { drafting: "原 drafting", "chapter.review": "原 review", "chapter.revision": "原 revision" },
      parseCandidatePromptSections(JSON.stringify({ drafting: "新 drafting" })),
    )).toEqual({ drafting: "新 drafting", "chapter.review": "原 review", "chapter.revision": "原 revision" });
    expect(mergeCraftRulePromptSections(
      { drafting: "原 drafting", review: "原 review" },
      parseCandidatePromptSections("旧格式候选"),
    )).toEqual({ drafting: "旧格式候选", review: "原 review" });
  });

  it("requires the proposed prompt text to be included, not only the proposed Skill version", () => {
    const candidate = { targetId: "chapter-review", proposedVersion: "1.1.0", afterText: JSON.stringify({ "chapter.review": "检查因果证据" }) };
    const baseManifest = {
      sections: [{ id: "skill:chapter-review@1.1.0", status: "included", fingerprint: canonicalSha256({ text: "旧审核规则" }) }],
    };
    expect(wasCandidatePromptPatchConsumed([baseManifest as never], candidate)).toBe(false);
    expect(wasCandidatePromptPatchConsumed([{
      ...baseManifest,
      sections: [{ ...baseManifest.sections[0], fingerprint: canonicalSha256({ text: "检查因果证据" }) }],
    } as never], candidate)).toBe(true);
  });

  it("locks the source failure chapter to learning provenance", () => {
    expect(resolveCraftRuleSourceDocumentId({ assessmentId: "learning:1", sourceChapterId: "chapter:7" })).toBe("chapter:7");
    expect(() => resolveCraftRuleSourceDocumentId({ assessmentId: "learning:1", sourceChapterId: "chapter:7", requestedSourceDocumentId: "chapter:2" }))
      .toThrow(/必须来自候选 learning assessment/);
    expect(() => resolveCraftRuleSourceDocumentId({ assessmentId: "learning:legacy" })).toThrow(/未关联原失败章节/);
  });

  it("accepts a candidate only when the lifecycle and quality guards hold", () => {
    expect(evaluateChapterRegression(
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 72, blockerCount: 1, majorCount: 2, blockingPatterns: ["knowledge-boundary"] },
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 74, blockerCount: 0, majorCount: 1, blockingPatterns: [] },
    )).toMatchObject({ passed: true, blockerDelta: -1, majorDelta: -1 });
  });

  it("rejects score regressions and newly persistent issue patterns", () => {
    expect(evaluateChapterRegression(
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 72, blockerCount: 1, majorCount: 0, blockingPatterns: ["knowledge-boundary"] },
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 71, blockerCount: 0, majorCount: 0, blockingPatterns: ["knowledge-boundary"] },
    )).toMatchObject({ passed: false });
    expect(evaluateChapterRegression(
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 72, blockerCount: 1, majorCount: 1, blockingPatterns: ["old-pattern"] },
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 80, blockerCount: 1, majorCount: 1, blockingPatterns: ["new-pattern"] },
    )).toMatchObject({ passed: false, blockerDelta: 0, majorDelta: 0 });
    expect(evaluateChapterRegression(
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 72, blockerCount: 0, majorCount: 1, blockingPatterns: [] },
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 80, blockerCount: 1, majorCount: 2, blockingPatterns: [] },
    )).toMatchObject({ passed: false, blockerDelta: 1, majorDelta: 1 });
    expect(evaluateChapterRegression(
      { committed: true, structuralPassed: true, structuralBlockerCount: 0, finalScore: 72, blockerCount: 0, majorCount: 0, blockingPatterns: [] },
      { committed: false, structuralPassed: false, structuralBlockerCount: 1, finalScore: 80, blockerCount: 0, majorCount: 0, blockingPatterns: [] },
    )).toMatchObject({ passed: false });
  });
});
