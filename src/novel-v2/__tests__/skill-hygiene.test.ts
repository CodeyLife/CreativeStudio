import { describe, expect, it } from "vitest";
import { findOrphanedEnabledSkills, findUnsourcedEnabledSkills, hasSkillProvenance, inspectSkillProjection } from "../skill-hygiene";

describe("skill projection hygiene", () => {
  it("recognizes provenance from workspace sync and database seeds", () => {
    expect(hasSkillProvenance("skills\\novel-v2\\prose-craft.yaml")).toBe(true);
    expect(hasSkillProvenance("database:081_h3_video_prompt_skill_v1_9_2.sql")).toBe(true);
    expect(hasSkillProvenance(null)).toBe(false);
    expect(hasSkillProvenance("   ")).toBe(false);
  });

  it("flags enabled rows without provenance but ignores disabled leftovers", () => {
    const flagged = findUnsourcedEnabledSkills([
      { skillId: "v1-legacy", sourceRef: null, enabled: true },
      { skillId: "v1-retired", sourceRef: null, enabled: false },
      { skillId: "synced", sourceRef: "skills/novel-v2/x.yaml", enabled: true },
    ]);
    expect(flagged).toEqual(["v1-legacy"]);
  });

  it("flags enabled rows the workspace does not own unless a migration seeded them", () => {
    const orphaned = findOrphanedEnabledSkills(["a", "b"], [
      { skillId: "a", sourceRef: "skills/novel-v2/a.yaml" },
      { skillId: "h3", sourceRef: "database:081_seed.sql" },
      { skillId: "test-leftover", sourceRef: "somewhere-else" },
    ]);
    expect(orphaned).toEqual(["test-leftover"]);
  });

  it("reports clean for the sanctioned projection", () => {
    const findings = inspectSkillProjection(["a"], [
      { skillId: "a", sourceRef: "skills/novel-v2/a.yaml", enabled: true },
    ]);
    expect(findings).toEqual({ unsourced: [], orphaned: [] });
  });
});
