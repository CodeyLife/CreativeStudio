import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileStageContext, StageContextBudgetError } from "../stage-context";
import {
  SKILL_EXECUTION_POLICIES,
  createDatabaseSkillProvider,
  createWorkspaceSkillProvider,
  buildSkillContextSections,
  normalizeSkillDescriptor,
  renderSkillInstruction,
  resolveStageSkillBundle,
} from "../skill-runtime";
import type { SkillDescriptor } from "../protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporarySkillRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novel-v2-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function draftSkill(prompt: string, overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    skillId: "test-drafting",
    version: "1.0.0",
    capabilities: ["draft"],
    applicableTasks: ["drafting"],
    requiredMemoryKinds: [],
    conflicts: [],
    qualityGates: ["test"],
    promptSections: { "chapter.drafting": prompt },
    enabled: true,
    executionPoints: ["chapter.drafting"],
    roles: ["writer"],
    dependsOn: [],
    priority: "required",
    ...overrides,
  };
}

describe("Skill runtime resolution", () => {
  it("resolves every declared execution point to a required Skill", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    for (const executionPoint of Object.keys(SKILL_EXECUTION_POLICIES) as Array<keyof typeof SKILL_EXECUTION_POLICIES>) {
      const bundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint });
      expect(bundle.resolution?.source).toBe("workspace");
      expect(bundle.skills.some((skill) => skill.priority === "required")).toBe(true);
      expect(bundle.resolution?.skills.every((skill) => skill.contentFingerprint)).toBe(true);
    }
  });

  it("keeps workspace Skill execution points aligned with the live reviewer contract", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const descriptors = await provider.list("test-project");
    const validPoints = new Set(Object.keys(SKILL_EXECUTION_POLICIES));
    for (const descriptor of descriptors) {
      for (const point of descriptor.executionPoints ?? []) expect(validPoints.has(point)).toBe(true);
    }
  });

  it("resolves a role-specific Skill for every chapter reviewer", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const reviewers = [
      ["structure-reviewer", "chapter.review.structure"],
      ["character-reviewer", "chapter.review.character"],
      ["prose-reviewer", "chapter.review.prose"],
    ] as const;
    for (const [role, executionPoint] of reviewers) {
      const bundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role });
      expect(bundle.skills.some((skill) => skill.priority === "required")).toBe(true);
      expect(bundle.skills.some((skill) => skill.roles?.includes(role))).toBe(true);
    }
  });

  it("gives foundation review its own role-specific evidence Skill without changing planning resolution", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const planning = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "foundation.book-plan", role: "planner" });
    const review = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "foundation.book-plan", role: "foundation-reviewer" });
    expect(planning.skills.some((skill) => skill.skillId === "review-gate")).toBe(false);
    expect(review.skills.some((skill) => skill.skillId === "review-gate")).toBe(true);
    expect(review.skills.some((skill) => skill.roles?.includes("foundation-reviewer"))).toBe(true);
    expect(renderSkillInstruction(review, "foundation.book-plan")).toContain("项目级架构审核");
  });

  it("reads workspace Skill content on every resolution without a process cache", async () => {
    const root = await temporarySkillRoot();
    const file = path.join(root, "draft.yaml");
    await writeFile(file, "skillId: test-drafting\nversion: 1.0.0\nexecutionPoints: [chapter.drafting]\nroles: [writer]\ncapabilities: [draft]\npriority: required\npromptSections:\n  chapter.drafting: first prompt\n", "utf8");
    const provider = createWorkspaceSkillProvider(root);
    const first = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    await writeFile(file, "skillId: test-drafting\nversion: 1.0.1\nexecutionPoints: [chapter.drafting]\nroles: [writer]\ncapabilities: [draft]\npriority: required\npromptSections:\n  chapter.drafting: second prompt\n", "utf8");
    const second = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    expect(second.resolution?.skills[0].version).toBe("1.0.1");
    expect(second.resolution?.fingerprint).not.toBe(first.resolution?.fingerprint);
    expect(renderSkillInstruction(second, "chapter.drafting")).toContain("second prompt");
  });

  it("reads database Skill content on every resolution and has no local fallback", async () => {
    let current = draftSkill("database prompt one");
    const provider = createDatabaseSkillProvider(async () => [current]);
    const first = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    current = draftSkill("database prompt two", { version: "1.0.1" });
    const second = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    expect(second.resolution?.fingerprint).not.toBe(first.resolution?.fingerprint);
    expect(renderSkillInstruction(second, "chapter.drafting")).toContain("database prompt two");

    const emptyDatabase = createDatabaseSkillProvider(async () => []);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider: emptyDatabase, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow("database Skill 为空");
  });

  it("keeps invalid database execution points visible and refuses runtime resolution", async () => {
    const descriptor = normalizeSkillDescriptor({ ...draftSkill("draft"), executionPoints: ["chapter.drafting", "stale.execution-point"] as unknown as SkillDescriptor["executionPoints"] });
    expect(descriptor.executionPoints).toEqual(["chapter.drafting"]);
    expect(descriptor.invalidExecutionPoints).toEqual(["stale.execution-point"]);
    const provider = createDatabaseSkillProvider(async () => [descriptor]);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow(/stale.execution-point/);
  });

  it("rejects missing dependencies and conflicts", async () => {
    const missingDependency = createDatabaseSkillProvider(async () => [draftSkill("draft", { dependsOn: ["missing"] })]);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider: missingDependency, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow("缺少依赖");

    const conflicting = createDatabaseSkillProvider(async () => [
      draftSkill("draft", { conflicts: ["conflict"] }),
      draftSkill("conflict", { skillId: "conflict", conflicts: [], capabilities: ["draft"], promptSections: { "chapter.drafting": "conflict" } }),
    ]);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider: conflicting, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow("Skill 冲突");
  });

  it("fails instead of silently dropping a required Skill when the context budget is too small", () => {
    expect(() => compileStageContext({
      projectId: "p1",
      workflowId: "w1",
      purpose: "writing.draft",
      stage: "drafting",
      maxInputTokens: 32,
      reservedOutputTokens: 16,
      skillManifest: {
        source: "workspace",
        executionPoint: "chapter.drafting",
        resolvedAt: 1,
        skills: [{ skillId: "required", version: "1.0.0", contentFingerprint: "fp", priority: "required" }],
        dependencyClosure: ["required"],
        omittedOptionalSkills: [],
        fingerprint: "manifest-fp",
      },
      sections: [{ id: "required-skill", kind: "skill", title: "required", text: "a required Skill instruction that cannot fit", priority: "required", provenanceRefs: ["required"] }],
    })).toThrow(StageContextBudgetError);
  });

  it("records resolved and actually injected Skills separately", () => {
    const result = compileStageContext({
      projectId: "p1",
      workflowId: "w-manifest",
      purpose: "writing.draft",
      stage: "drafting",
      maxInputTokens: 1_000,
      reservedOutputTokens: 100,
      skillManifest: {
        source: "workspace",
        executionPoint: "chapter.drafting",
        resolvedAt: 1,
        skills: [
          { skillId: "required", version: "1.0.0", contentFingerprint: "required-fp", priority: "required" },
          { skillId: "optional", version: "1.0.0", contentFingerprint: "optional-fp", priority: "optional" },
        ],
        dependencyClosure: ["required", "optional"],
        omittedOptionalSkills: [],
        fingerprint: "manifest-fp",
      },
      sections: [{ id: "required-skill", kind: "skill", title: "required", text: "required Skill instruction", priority: "required", provenanceRefs: ["required@1.0.0"] }],
    });
    expect(result.manifest.skillManifest?.skills.map((skill) => skill.skillId)).toEqual(["required", "optional"]);
    expect(result.manifest.skillManifest?.injectedSkills?.map((skill) => skill.skillId)).toEqual(["required"]);
  });

  it("compiles each Skill section independently so budget and manifest stay aligned", () => {
    const bundle = {
      skills: [
        draftSkill("required instruction", { priority: "required" }),
        draftSkill("optional instruction that should be excluded by the section budget", { skillId: "optional", priority: "optional" }),
      ],
    };
    const sections = buildSkillContextSections(bundle, "chapter.drafting");
    expect(sections.map((section) => [section.id, section.priority])).toEqual([
      ["skill:test-drafting@1.0.0", "required"],
      ["skill:optional@1.0.0", "soft"],
    ]);

    const result = compileStageContext({
      projectId: "p1",
      workflowId: "w-skill-sections",
      purpose: "writing.draft",
      stage: "drafting",
      maxInputTokens: 80,
      reservedOutputTokens: 10,
      skillManifest: {
        source: "workspace",
        executionPoint: "chapter.drafting",
        resolvedAt: 1,
        skills: bundle.skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: "fp", priority: skill.priority! })),
        dependencyClosure: bundle.skills.map((skill) => skill.skillId),
        omittedOptionalSkills: [],
        fingerprint: "manifest-fp",
      },
      sections: [{ id: "manuscript", kind: "manuscript", title: "正文", text: "正文", priority: "critical", provenanceRefs: ["artifact-1"] }, ...sections],
    });
    expect(result.instruction).toContain("required instruction");
    expect(result.instruction).not.toContain("optional instruction");
    expect(result.manifest.skillManifest?.injectedSkills?.map((skill) => skill.skillId)).toEqual(["test-drafting"]);
  });
});
