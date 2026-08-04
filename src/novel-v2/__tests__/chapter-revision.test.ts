import { describe, expect, it, vi } from "vitest";
import { applyRevisionWindows, applyTargetedRevisionReplacements, buildAuthorRevisionBrief, buildFullChapterRevisionPrompt, buildFullChapterRevisionPromptPackage, buildRevisionWindowPrompt, buildTargetedRevisionBatchPrompt, planRevisionWindows, sanitizeRevisionOutput } from "../prompts/chapter-revision";
import type { Artifact, ExecutionBlueprint, MemoryBundle, ReviewIssue, SkillBundle } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";
import type { CommitService } from "../commit-service";
import type { NovelPostgresRepository } from "../postgres-repository";
import { createNovelWorkflowActivities } from "../temporal/activities";

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

  it("renders shared revision context once for a multi-window batch", () => {
    const text = "甲在门外停了一会儿。\n\n乙没有回答。\n\n雨声压过了脚步。\n\n灯影晃了一下。";
    const issues: ReviewIssue[] = [
      { severity: "major", title: "动作承接", evidence: "甲在门外停了一会儿。", revisionRanges: [{ start: 1, end: 1 }], suggestion: "补足可观察的承接" },
      { severity: "warning", title: "反应缺口", evidence: "灯影晃了一下。", revisionRanges: [{ start: 4, end: 4 }], suggestion: "让反应与前文因果相连" },
    ];
    const windows = planRevisionWindows(text, issues);
    const input = { text, windows, memory, authorInstruction: "保持局部修改，不重写无关段落。" };
    const batch = buildTargetedRevisionBatchPrompt(input);
    const individual = windows.map((window) => buildRevisionWindowPrompt({ ...input, window })).join("\n\n");

    expect((batch.match(/## 冻结事实（只读）/g) ?? [])).toHaveLength(1);
    expect((batch.match(/## 局部修订契约/g) ?? [])).toHaveLength(1);
    expect(batch).toContain("## 窗口 1");
    expect(batch).toContain("## 窗口 2");
    expect(batch.length).toBeLessThan(individual.length);
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

  it("keeps hard facts required while allowing background and rhythm to be budgeted", () => {
    const hardFact = { id: "fact-hard", projectId: "p", kind: "canonical" as const, title: "已批准事实", content: "角色已经拿到钥匙", subjectRefs: [], narrativeRange: {}, knowledgeScope: "author" as const, authority: "approved" as const, confidence: 1, sourceRevisionIds: ["revision-1"], contentHash: "fact-hard", supersedes: [], score: 1, matchedFacet: "fact", reason: "hard fact" };
    const background = Array.from({ length: 8 }, (_, index) => ({ ...hardFact, id: `background-${index}`, title: `背景 ${index}`, content: "背景信息".repeat(100), authority: "derived" as const, kind: "hierarchical" as const, sourceRevisionIds: [] }));
    const packageResult = buildFullChapterRevisionPromptPackage({
      projectId: "p", workflowId: "revision-budget", system: "系统", sourceArtifactId: "artifact-1", maxInputTokens: 900, maxOutputTokens: 100,
      text: "正文", issues: [], memory: { ...memory, claims: [hardFact, ...background] },
    });
    expect(packageResult.manifest.sections.find((item) => item.id === "revision-facts-hard")?.status).toBe("included");
    expect(packageResult.manifest.sections.find((item) => item.id === "revision-facts-soft")?.reason).toBe("budget");
    expect(packageResult.manifest.sections.find((item) => item.id === "revision-rhythm")?.priority).toBe("normal");
  });

  it("uses one structured batch call for multiple safe revision windows", async () => {
    const text = "甲在门外停了一会儿。\n\n乙没有回答。\n\n雨声压过了脚步。\n\n灯影晃了一下。";
    const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "chapter-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", baseRevision: 0, createdAt: 1, fingerprint: "artifact-fp" };
    const issue = (title: string, paragraph: number, severity: ReviewIssue["severity"]): ReviewIssue => ({ severity, title, evidence: `第${paragraph}段证据`, excerpt: text.split("\n\n")[paragraph - 1], revisionRanges: [{ start: paragraph, end: paragraph }], suggestion: "按证据局部修订" });
    const reviews = [{
      id: "review-1",
      projectId: "p1",
      artifactId: artifact.id,
      reviewerId: "reviewer-1",
      identity: "internal" as const,
      verdict: "revise" as const,
      issues: [issue("动作承接", 1, "major"), issue("反应缺口", 4, "major")],
      createdAt: 1,
      artifactFingerprint: artifact.fingerprint,
    }];
    const generateStructured = vi.fn(async () => ({
      value: { replacements: [{ start: 1, end: 1, text: "甲在门外停住，听见里面终于传来一声轻响。" }, { start: 4, end: 4, text: "灯影晃了一下，像有人在门后屏住了呼吸。" }] },
      provenance: { routeSnapshotId: "route-1", purpose: "writing.revision", candidateIndex: 0, executor: "api" as const, profileId: "profile-1", model: "model-1", promptFingerprint: "prompt-fp" },
    }));
    const generateText = vi.fn();
    const activities = createNovelWorkflowActivities({
      repository: { recordArtifact: vi.fn(async () => undefined) } as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider: { list: async () => [{ skillId: "revision-skill", version: "1", capabilities: ["revision"], applicableTasks: ["revision"], requiredMemoryKinds: [], conflicts: [], qualityGates: [], promptSections: { "chapter.revision": "保持窗口边界与已冻结事实。" }, enabled: true, executionPoints: ["chapter.revision" as const], roles: [] }] },
      modelGateway: { generateStructured, generateText } as unknown as ModelGateway,
      objectStore: { putText: vi.fn(async (value: string) => ({ key: "object-1", hash: `hash-${value.length}` })) } as unknown as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    const result = await activities.revise({
      workflowId: "workflow-1",
      intent: { id: "intent-1", projectId: "p1", source: "chapter-review", objective: "修订章节", createdAt: 1, idempotencyKey: "intent-1" },
      artifact,
      text,
      reviews,
      memory,
      blueprint: { id: "blueprint-1", projectId: "p1", preflightId: "preflight-1", budget: { maxInputTokens: 100_000, maxOutputTokens: 20_000 } } as unknown as ExecutionBlueprint,
      skills: {} as SkillBundle,
      routingSnapshot: { id: "route-1" } as never,
    });

    expect(result.kind).toBe("completed");
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({ schemaName: "targeted-chapter-revision", taskId: "chapter-1:revise:targeted-batch" }));
    expect(generateText).not.toHaveBeenCalled();
    expect((result as { artifact: Artifact }).artifact.structuredData).toMatchObject({ revisionMode: "targeted-batch" });
  });
});
