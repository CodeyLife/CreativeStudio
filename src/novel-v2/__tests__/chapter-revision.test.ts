import { describe, expect, it, vi } from "vitest";
import { applyRevisionWindows, applyTargetedRevisionReplacements, buildAuthorRevisionBrief, buildFullChapterRevisionPromptPackage, buildRevisionWindowPromptPackage, buildTargetedRevisionBatchPromptPackage, planRevisionWindows, sanitizeRevisionOutput, TargetedRevisionContractError } from "../prompts/chapter-revision";
import type { Artifact, ExecutionBlueprint, MemoryBundle, ReviewIssue, SkillBundle } from "../protocol";
import type { ModelGateway } from "../model-gateway";
import type { ContentObjectStore } from "../object-store";
import type { CommitService } from "../commit-service";
import type { NovelPostgresRepository } from "../postgres-repository";
import { createNovelWorkflowActivities } from "../temporal/activities";
import { READER_RECONSTRUCTION_CONTRACT } from "../reader-reconstruction";

const memory: MemoryBundle = {
  id: "m", projectId: "p", preflightId: "pf", claims: [], conflicts: [], missingFacets: [], tokenBudget: 1000,
  sourceRevisionIds: [], fingerprint: "m", createdAt: 1,
};

describe("chapter revision", () => {
  it("sanitizes structural instruction wrappers without phrase-specific matching", () => {
    expect(sanitizeRevisionOutput("```text\n正文第一段。\n\n正文第二段。\n```")).toBe("正文第一段。\n\n正文第二段。");
    expect(sanitizeRevisionOutput("修订结果：\n正文第一段。\n\n正文第二段。")).toContain("正文第一段。");
  });

  it("removes only adjacent exact duplicate paragraphs from revision output", () => {
    expect(sanitizeRevisionOutput("等待。\n\n等待。\n\n上方传来脚步。\n\n等待。"))
      .toBe("等待。\n\n上方传来脚步。\n\n等待。");
  });

  it("drops a replacement that copies the prior neighbor paragraph in full plus an appendage", () => {
    // 修订模型把窗口前邻段整段复制进替换文本并追加一句（ch5 段17 复制的拼接错误）。
    const text = "陈渊早已算准了扑击路线，侧身避开利齿，右手顺势向下握住了金属残片。\n\n那是一片不知什么年代断裂的武器部件，异常锋利。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮。";
    const window = { start: 1, end: 1, issues: [] };
    const replacement = "陈渊早已算准了扑击路线，侧身避开利齿，右手顺势向下握住了金属残片。与此同时，他握紧那片暗蓝色的金属，直接刺向水鼠的脖颈。";
    const result = applyRevisionWindows(text, [{ window, text: replacement }]);
    // 前邻段全文被复制为替换首段前缀 → 整段丢弃，窗口内容保留原文。
    expect(result).not.toContain("与此同时，他握紧那片暗蓝色的金属，直接刺向水鼠的脖颈。");
    expect(result.split("\n\n")).toHaveLength(3);
  });

  it("drops a replacement tail that exactly duplicates the next neighbor paragraph", () => {
    // 修订模型把窗口后邻段复制进替换文本末段（ch5 段19 完全重复的拼接错误）。
    const text = "甲握住残片。\n\n旧窗口段。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮，爪甲划破了他的手腕。\n\n痛感让陈渊清醒到顶峰。";
    const window = { start: 1, end: 1, issues: [] };
    const replacement = "新窗口段。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮，爪甲划破了他的手腕。";
    const result = applyRevisionWindows(text, [{ window, text: replacement }]);
    expect(result).toBe("甲握住残片。\n\n新窗口段。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮，爪甲划破了他的手腕。\n\n痛感让陈渊清醒到顶峰。");
  });

  it("drops a single-paragraph replacement that exactly duplicates the next neighbor", () => {
    // 单段窗口替换恰好等于后邻段全文（与 before 分支对称的边界回显故障）：
    // 整段丢弃后窗口保留原文，正文不出现硬重复段。
    const text = "甲握住残片。\n\n旧窗口段。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮。\n\n痛感让陈渊清醒到顶峰。";
    const window = { start: 1, end: 1, issues: [] };
    const result = applyRevisionWindows(text, [{ window, text: "水鼠扑了个空，陈渊左手按住它的后颈皮。" }]);
    expect(result).toBe("甲握住残片。\n\n旧窗口段。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮。\n\n痛感让陈渊清醒到顶峰。");
  });

  it("throws a contract error when the only targeted replacement is fully deduped", () => {
    // targeted 路径中窗口改动被完全剔除 → 无实际修改 → 契约错误，由调用方回退整章修订。
    const text = "甲握住残片。\n\n旧窗口段。\n\n水鼠扑了个空，陈渊左手按住它的后颈皮。";
    const windows = planRevisionWindows(text, [{ severity: "major", title: "目标", evidence: "旧窗口段。", revisionRanges: [{ start: 2, end: 2 }] }]);
    expect(() => applyTargetedRevisionReplacements(text, windows, [{ start: 2, end: 2, text: "水鼠扑了个空，陈渊左手按住它的后颈皮。" }])).toThrow(TargetedRevisionContractError);
  });

  it("keeps a legitimate replacement whose opening overlaps the prior paragraph only partially", () => {
    // 开头局部重合是正常承接，不应误删。
    const text = "他握紧了那块金属残片。\n\n旧窗口段。\n\n水鼠扑了个空。";
    const window = { start: 1, end: 1, issues: [] };
    const replacement = "他握紧残片，把断口抵在指缝里，屏住呼吸。";
    const result = applyRevisionWindows(text, [{ window, text: replacement }]);
    expect(result).toContain("他握紧残片，把断口抵在指缝里，屏住呼吸。");
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

  it("falls back from stale ranges to current paragraph evidence", () => {
    const text = "甲。\n\n乙。\n\n丙。";
    const [window] = planRevisionWindows(text, [{ severity: "major", title: "边界变化", evidence: "乙。", excerpt: "乙。", paragraph: 2, revisionRanges: [{ start: 9, end: 9 }] }]);
    expect(window).toMatchObject({ start: 1, end: 1 });
  });

  it("does not create a revision window from excerpt text matching", () => {
    const text = "甲。\n\n乙。\n\n丙。";
    expect(planRevisionWindows(text, [{ severity: "major", title: "边界变化", evidence: "乙。" }])).toEqual([]);
  });

  it("classifies invalid batch replacements as contract errors", () => {
    const text = "甲。\n\n乙。";
    const windows = planRevisionWindows(text, [{ severity: "major", title: "目标", evidence: "乙。", revisionRanges: [{ start: 2, end: 2 }] }]);
    expect(() => applyTargetedRevisionReplacements(text, windows, [{ start: 1, end: 1, text: "错误窗口" }])).toThrow(TargetedRevisionContractError);
  });

  it("renders shared revision context once for a multi-window batch", () => {
    const text = "甲在门外停了一会儿。\n\n乙没有回答。\n\n雨声压过了脚步。\n\n灯影晃了一下。";
    const issues: ReviewIssue[] = [
      { severity: "major", title: "动作承接", evidence: "甲在门外停了一会儿。", revisionRanges: [{ start: 1, end: 1 }], suggestion: "补足可观察的承接" },
      { severity: "warning", title: "反应缺口", evidence: "灯影晃了一下。", revisionRanges: [{ start: 4, end: 4 }], suggestion: "让反应与前文因果相连" },
    ];
    const windows = planRevisionWindows(text, issues);
    const input = { text, windows, memory, authorInstruction: "保持局部修改，不重写无关段落。" };
    const packageInput = { ...input, projectId: "p", workflowId: "workflow-1", system: "系统", maxInputTokens: 10000, maxOutputTokens: 1000 };
    const batch = buildTargetedRevisionBatchPromptPackage(packageInput).instruction;
    const individual = windows.map((window) => buildRevisionWindowPromptPackage({ ...packageInput, window })).map((item) => item.instruction).join("\n\n");

    expect((batch.match(/## 冻结事实（只读）/g) ?? [])).toHaveLength(1);
    expect((batch.match(/## 局部修订契约/g) ?? [])).toHaveLength(1);
    expect(batch).toContain("## 窗口 1");
    expect(batch).toContain("## 窗口 2");
    expect(batch).toContain("章末未解列表是冻结边界");
    expect(batch.length).toBeLessThan(individual.length);
  });

  it("keeps author direction general and separate from the issue contract", () => {
    const brief = buildAuthorRevisionBrief("让这一段更舒缓，并通过动作表现人物的犹豫。");
    expect(brief).toContain("让这一段更舒缓，并通过动作表现人物的犹豫。");
    expect(brief).toContain("自行判断受影响范围");
    expect(brief).not.toContain("固定字数");
  });

  it("uses evidence and author direction without adding chapter-level literary obligations", () => {
    const prompt = buildFullChapterRevisionPromptPackage({
      projectId: "p",
      workflowId: "workflow-1",
      system: "系统",
      sourceArtifactId: "artifact-1",
      maxInputTokens: 10000,
      maxOutputTokens: 1000,
      text: "她推开门。\n\n屋里没有人。",
      memory,
      issues: [{ severity: "major", title: "因果跳步", evidence: "她推开门。", revisionRanges: [{ start: 1, end: 1 }], suggestion: "补足可观察的承接" }],
      authorInstruction: "让动作更有停顿感。",
    }).instruction;
    expect(prompt).toContain("让动作更有停顿感。");
    expect(prompt).toContain("因果跳步");
    expect(prompt).toContain(READER_RECONSTRUCTION_CONTRACT);
    expect(prompt).toContain("不机械凑齐证据类别");
    expect(prompt).toContain("不得删除、回答或合并其中的问题");
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

  it("falls back to per-window calls when a batch omits a declared window", async () => {
    const text = "甲在门外停了一会儿。\n\n乙没有回答。\n\n雨声压过了脚步。\n\n灯影晃了一下。";
    const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "chapter-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", baseRevision: 0, createdAt: 1, fingerprint: "artifact-fp" };
    const reviews = [{
      id: "review-1", projectId: "p1", artifactId: artifact.id, reviewerId: "reviewer-1", identity: "internal" as const, verdict: "revise" as const,
      issues: [
        { severity: "major" as const, title: "动作承接", evidence: "甲在门外停了一会儿。", revisionRanges: [{ start: 1, end: 1 }], suggestion: "按证据局部修订" },
        { severity: "major" as const, title: "反应缺口", evidence: "灯影晃了一下。", revisionRanges: [{ start: 4, end: 4 }], suggestion: "按证据局部修订" },
      ],
      createdAt: 1, artifactFingerprint: artifact.fingerprint,
    }];
    const generateStructured = vi.fn(async () => ({
      value: { replacements: [{ start: 1, end: 1, text: "只返回一个窗口" }] },
      provenance: { routeSnapshotId: "route-1", purpose: "writing.revision", candidateIndex: 0, executor: "api" as const, profileId: "profile-1", model: "model-1", promptFingerprint: "prompt-fp" },
    }));
    const generateText = vi.fn(async () => ({
      text: "按当前窗口完成局部修订。",
      provenance: { routeSnapshotId: "route-1", purpose: "writing.revision", candidateIndex: 0, executor: "api" as const, profileId: "profile-1", model: "model-1", promptFingerprint: "prompt-fp" },
    }));
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
    expect(generateText).toHaveBeenCalledTimes(2);
    expect((result as { artifact: Artifact }).artifact.structuredData).not.toMatchObject({ revisionMode: "targeted-batch" });
  });

  it("resolves the reviewed text for evidence markers on the external review path", async () => {
    // 外部 MCP 审校路径必须把被审 artifact 的正文传给 putReview，
    // 否则 refresh 时 evidence 软校验无正文可查，issue 永不附 evidence-unverified 标记。
    const putReview = vi.fn(async () => undefined);
    const candidateText = "他握住残片，屏住呼吸。\n\n暗处的光斑晃了一下。";
    const activities = createNovelWorkflowActivities({
      repository: {
        putReview,
        getModelTask: async () => ({
          id: "task-1",
          status: "submitted",
          configRevision: "route-1",
          purpose: "writing.review",
          candidateIndex: 0,
          workPackage: { inputFingerprint: "fp", contextRefs: {} },
        }),
      } as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider: { list: async () => [] },
      modelGateway: {} as ModelGateway,
      objectStore: { getText: vi.fn(async () => candidateText) } as unknown as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    const artifact: Artifact = {
      id: "artifact-external-review", projectId: "p1", taskId: "chapter-1", attemptId: "attempt-1", kind: "draft",
      contentHash: "hash", objectKey: "objects/candidate", baseRevision: 0, createdAt: 1, fingerprint: "fp-1",
    };
    await activities.materializeExternalReview({
      modelTaskId: "task-1",
      artifact,
      identity: "internal",
      role: "structure-reviewer",
      value: { verdict: "passed", score: 4, issues: [] },
    });

    expect(putReview).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: artifact.id }),
      expect.objectContaining({ refreshChapterSnapshot: true, plainText: candidateText }),
    );
  });

  it("degrades to no plainText when the reviewed artifact has no object key", async () => {
    const putReview = vi.fn(async () => undefined);
    const getText = vi.fn(async () => "不应被读取");
    const activities = createNovelWorkflowActivities({
      repository: {
        putReview,
        getModelTask: async () => ({
          id: "task-2",
          status: "submitted",
          configRevision: "route-1",
          purpose: "writing.review",
          candidateIndex: 0,
          workPackage: { inputFingerprint: "fp", contextRefs: {} },
        }),
      } as unknown as NovelPostgresRepository,
      memoryProvider: { search: async () => [] },
      skillProvider: { list: async () => [] },
      modelGateway: {} as ModelGateway,
      objectStore: { getText } as unknown as ContentObjectStore,
      commitService: {} as CommitService,
      enableChapterMemory: false,
    });

    const artifact: Artifact = {
      id: "artifact-no-object-key", projectId: "p1", taskId: "chapter-1", attemptId: "attempt-1", kind: "draft",
      contentHash: "hash", baseRevision: 0, createdAt: 1, fingerprint: "fp-2",
    };
    await activities.materializeExternalReview({
      modelTaskId: "task-2",
      artifact,
      identity: "internal",
      role: "structure-reviewer",
      value: { verdict: "passed", score: 4, issues: [] },
    });

    expect(getText).not.toHaveBeenCalled();
    expect(putReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plainText: undefined }));
  });
});
