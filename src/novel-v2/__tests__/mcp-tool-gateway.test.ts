/**
 * V2 MCP 工具网关测试套件（Phase B-2）。
 *
 * 策略：
 * - 纯函数测试（validateToolArgs）直接运行，无外部依赖。
 * - executeTool 错误路径测试（未知工具/参数校验/handler 抛错）使用 mock ctx，无 Postgres。
 * - 集成测试（happy path）需要真实 Postgres；beforeAll 尝试连接，失败则 skip。
 *
 * AGENTS.md 合规：
 * - 跨场景 counterexample：未知工具 vs 已知工具、参数校验通过 vs 失败
 * - 根因分析：测试失败时先识别 failingLayer（路由/校验/handler），不修改 fixture 让单 sample 通过
 *
 * 实现注记：
 * - novel_project_create 的 handler 使用 idempotencyKey 作为 projectId（非 args.projectId），
 *   且 schema 设置 additionalProperties: false，因此不能在 args 中传 projectId。
 * - novel_closed_loop_run 需要 idempotencyKey 通过 ajv 校验后才能到达 handler 的 model 检查，
 *   任务示例中省略 idempotencyKey 会导致参数校验先失败，无法测到 handler 抛错。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { validateToolArgs } from "../mcp/validator";
import { TOOL_NAMES, TOOL_DEFINITIONS } from "../mcp/tool-definitions";
import { buildToolArgumentSkeleton, TOOL_COUNT, TOOL_DESCRIPTIONS, TOOL_GROUPS } from "../mcp/tool-metadata";
import { executeTool } from "../mcp/index";

// ===== 测试夹具 =====

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

// mock ctx：repository.pool.query 返回空行，model=undefined
const mockCtx = {
  repository: { pool: { query: async () => ({ rows: [] }) } } as never,
  model: undefined,
};

// ===== A. 纯函数：validateToolArgs（无 Postgres 依赖）=====

describe("validateToolArgs pure function", () => {
  it("TOOL_NAMES has exactly 32 tools", () => {
    expect(TOOL_NAMES).toHaveLength(32);
  });

  it("TOOL_DEFINITIONS has 32 defs, each with name/description/inputSchema", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(32);
    for (const def of TOOL_DEFINITIONS) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.inputSchema).toBe("object");
      expect(def.inputSchema).not.toBeNull();
    }
  });

  it("shared Web metadata covers every MCP tool exactly once", () => {
    const grouped = TOOL_GROUPS.flatMap((group) => group.tools);
    expect(TOOL_COUNT).toBe(TOOL_NAMES.length);
    expect(new Set(grouped)).toEqual(new Set(TOOL_NAMES));
    expect(grouped).toHaveLength(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) expect(TOOL_DESCRIPTIONS[name].full).toBe(TOOL_DEFINITIONS.find((definition) => definition.name === name)?.description);
  });

  it("derives required argument skeletons from shared JSON schemas", () => {
    expect(buildToolArgumentSkeleton("novel_chapter_review")).toEqual({
      projectId: "",
      documentId: "",
      idempotencyKey: "",
    });
    expect(buildToolArgumentSkeleton("novel_rule_evidence_submit")).toMatchObject({
      projectId: "",
      candidateId: "",
      scenarioClass: "",
      scenarioRole: "source-failure",
    });
  });

  it("accepts targeted chapter review arguments", () => {
    expect(validateToolArgs("novel_chapter_review", {
      projectId: "p-1",
      documentId: "d-1",
      mode: "targeted",
      targetIssueIds: ["issue-1"],
      idempotencyKey: "review-targeted-1",
    }).valid).toBe(true);
  });

  it("rejects an invalid chapter review mode at schema validation", () => {
    expect(validateToolArgs("novel_chapter_review", {
      projectId: "p-1",
      documentId: "d-1",
      mode: "partial",
      idempotencyKey: "review-invalid-mode",
    }).valid).toBe(false);
  });

  it("unknown tool → valid=false", () => {
    const result = validateToolArgs("nonexistent_tool", {});
    expect(result.valid).toBe(false);
  });

  describe("novel_project_create", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "一个失去记忆的法医发现每具尸体都认识自己",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts an optional versioned creative brief", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "一位失忆法医追查旧案",
        idempotencyKey: "k-brief",
        creativeBrief: {
          targetReader: "悬疑读者",
          corePromise: "真相会改变关系",
          themeQuestion: { notApplicable: true, rationale: "本作不直接回答价值问题" },
          researchNeeds: ["法医流程"],
          nonNegotiables: ["不提前揭示结局"],
        },
      });
      expect(result.valid).toBe(true);
    });

    it("rejects a known creative brief field with the wrong type", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "一位失忆法医追查旧案",
        idempotencyKey: "k-bad-brief-type",
        creativeBrief: { targetReader: 3 },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects a non-object creative brief at schema validation", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "一位失忆法医追查旧案",
        idempotencyKey: "k-bad-brief",
        creativeBrief: "not-an-object",
      });
      expect(result.valid).toBe(false);
    });

    it("missing premise → valid=false", () => {
      const result = validateToolArgs("novel_project_create", {
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });

    it("empty premise → valid=false", () => {
      const result = validateToolArgs("novel_project_create", {
        premise: "",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("novel_run_create", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_run_create", {
        projectId: "p-1",
        mode: "chapter",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("invalid mode → valid=false", () => {
      const result = validateToolArgs("novel_run_create", {
        projectId: "p-1",
        mode: "invalid",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("novel_closed_loop_run", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_closed_loop_run", {
        projectId: "p-1",
        documentId: "d-1",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("missing documentId → valid=false", () => {
      const result = validateToolArgs("novel_closed_loop_run", {
        projectId: "p-1",
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("novel_review_submit", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_review_submit", {
        runId: "r-1",
        workItemId: "w-1",
        review: {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "passed",
          issues: [],
          summary: "ok",
        },
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(true);
    });

    it("invalid verdict → valid=false", () => {
      const result = validateToolArgs("novel_review_submit", {
        runId: "r-1",
        workItemId: "w-1",
        review: {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "invalid",
          issues: [],
          summary: "ok",
        },
        idempotencyKey: "k-1",
      });
      expect(result.valid).toBe(false);
    });

    it("accepts optional reader reconstruction evidence", () => {
      const base = {
        runId: "r-1",
        workItemId: "w-1",
        review: {
          subjectArtifactId: "a-1",
          reviewer: "internal",
          verdict: "revise",
          issues: [{
            severity: "major",
            title: "现场承接不足",
            evidence: "他停住了。",
            readerReconstruction: { impact: "core", missingEvidence: ["consequence"], blockedQuestion: "读者无法判断停顿造成的变化" },
          }],
          summary: "需要补足现场证据",
        },
        idempotencyKey: "k-reader-reconstruction",
      };
      expect(validateToolArgs("novel_review_submit", base).valid).toBe(true);
      expect(validateToolArgs("novel_review_submit", { ...base, review: { ...base.review, issues: [{ ...base.review.issues[0], readerReconstruction: null }] } }).valid).toBe(true);
      expect(validateToolArgs("novel_review_submit", { ...base, review: { ...base.review, issues: [{ ...base.review.issues[0], readerReconstruction: { impact: "core", missingEvidence: ["unknown"], blockedQuestion: "问题" } }] } }).valid).toBe(false);
    });
  });
});

// ===== B. executeTool 路由（无 Postgres 依赖，测错误路径）=====

describe("executeTool error paths", () => {
  it("unknown tool → isError=true, content contains '未知工具'", async () => {
    const result = await executeTool("nonexistent", {}, mockCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("未知工具");
  });

  it("invalid args → isError=true, content contains '参数校验失败'", async () => {
    // novel_project_create 需要 title + idempotencyKey，传空对象
    const result = await executeTool("novel_project_create", {}, mockCtx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("参数校验失败");
  });

  it("handler throws (novel_closed_loop_run without model) → isError=true, content contains 'model'", async () => {
    // 需要 idempotencyKey 通过 ajv 校验后才能到达 handler 的 model 检查
    const result = await executeTool(
      "novel_closed_loop_run",
      { projectId: "p1", documentId: "d1", idempotencyKey: "k1" },
      mockCtx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("model");
  });

  it("novel_chapter_review persists and starts one Temporal workflow with the same id", async () => {
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ firstExecutionRunId: "temporal-run-1" });
    const result = await executeTool(
      "novel_chapter_review",
      { projectId: "p1", documentId: "d1", idempotencyKey: "review-1" },
      {
        repository: { getChapterReviewPreflight: vi.fn().mockResolvedValue({ status: "final", baseRevision: 1, hasBlueprint: true }), putWorkflowRun } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("accepted");
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ temporalWorkflowId: payload.workflowId, workflowType: "chapter-review" }));
    expect(start).toHaveBeenCalledWith("chapterReviewWorkflow", expect.objectContaining({
      workflowId: payload.workflowId,
      args: [expect.objectContaining({ projectId: "p1", documentId: "d1", workflowId: payload.workflowId, mode: "full", targetIssueIds: undefined })],
    }));
  });

  it("novel_chapter_review routes targeted issue ids into the formal workflow", async () => {
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ firstExecutionRunId: "temporal-run-targeted-1" });
    const result = await executeTool(
      "novel_chapter_review",
      { projectId: "p1", documentId: "d1", mode: "targeted", targetIssueIds: ["issue-1", "issue-2"], idempotencyKey: "review-targeted-1" },
      {
        repository: { getChapterReviewPreflight: vi.fn().mockResolvedValue({ status: "final", baseRevision: 1, hasBlueprint: true }), putWorkflowRun } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.mode).toBe("targeted");
    expect(payload.targetIssueIds).toEqual(["issue-1", "issue-2"]);
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ mode: "targeted", targetIssueIds: ["issue-1", "issue-2"] }),
    }));
    expect(start).toHaveBeenCalledWith("chapterReviewWorkflow", expect.objectContaining({
      args: [expect.objectContaining({ mode: "targeted", targetIssueIds: ["issue-1", "issue-2"] })],
    }));
  });

  it("novel_chapter_review marks the run failed when workflow.start throws, so the lock is released", async () => {
    // accepted 悬挂会被单文档/项目级审校查询视为活跃并永久阻塞；start 失败必须转 failed。
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const updateWorkflowRunStatus = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockRejectedValue(new Error("Temporal 暂时不可用"));
    const result = await executeTool(
      "novel_chapter_review",
      { projectId: "p1", documentId: "d1", idempotencyKey: "review-fail-1" },
      {
        repository: {
          getChapterReviewPreflight: vi.fn().mockResolvedValue({ status: "final", baseRevision: 1, hasBlueprint: true }),
          putWorkflowRun,
          updateWorkflowRunStatus,
        } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(updateWorkflowRunStatus).toHaveBeenCalledWith(expect.any(String), "failed", expect.objectContaining({ reason: "workflow.start 失败" }));
  });

  it("novel_chapter_review_issue_add persists an author issue without mutating the manuscript", async () => {
    const addChapterReviewIssue = vi.fn().mockResolvedValue({ id: "issue-1", status: "pending" });
    const result = await executeTool(
      "novel_chapter_review_issue_add",
      { projectId: "p1", documentId: "d1", severity: "major", title: "推断超出蓝图边界", evidenceQuote: "正文证据", paragraph: 3, suggestion: "收回为未解观察" },
      { repository: { addChapterReviewIssue } as never },
    );
    expect(result.isError).toBeFalsy();
    expect(addChapterReviewIssue).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", documentId: "d1", severity: "major", title: "推断超出蓝图边界", paragraph: 3,
    }));
  });

  it("novel_chapter_review_issue_add rejects an invalid severity", async () => {
    const result = await executeTool(
      "novel_chapter_review_issue_add",
      { projectId: "p1", documentId: "d1", severity: "info", title: "无效" },
      { repository: { addChapterReviewIssue: vi.fn() } as never },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("参数校验失败");
  });

  it("rejects targeted chapter review without issue ids before starting Temporal", async () => {
    const start = vi.fn();
    const result = await executeTool(
      "novel_chapter_review",
      { projectId: "p1", documentId: "d1", mode: "targeted", idempotencyKey: "review-targeted-missing" },
      {
        repository: { getChapterReviewPreflight: vi.fn(), putWorkflowRun: vi.fn() } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("targetIssueIds");
    expect(start).not.toHaveBeenCalled();
  });

  it("novel_story_arc_review resumes an existing blueprint through the formal review workflow", async () => {
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ firstExecutionRunId: "temporal-run-arc-review-1" });
    const result = await executeTool(
      "novel_story_arc_review",
      { projectId: "p1", arcId: "arc-1" },
      {
        repository: {
          getStoryArc: vi.fn().mockResolvedValue({
            id: "arc-1",
            planningStatus: "failed",
            blueprintArtifactId: "blueprint-1",
            chapters: [],
          }),
          listActiveStoryArcWorkflowIds: vi.fn().mockResolvedValue([]),
          prepareStoryArcReviewRetry: vi.fn().mockResolvedValue({
            id: "arc-1",
            planningStatus: "awaiting-review",
            executionStatus: "planned",
            blueprintArtifactId: "blueprint-1",
            chapters: [],
          }),
          withStoryArcWorkflowLock: async (_projectId: string, _arcId: string, callback: () => Promise<unknown>) => callback(),
          putWorkflowRun,
        } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("accepted");
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "story-arc-planning",
      payload: expect.objectContaining({ existingArtifactId: "blueprint-1", rebase: false }),
    }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({
      args: [expect.objectContaining({ existingArtifactId: "blueprint-1", rebase: false })],
    }));
  });

  it("novel_story_arc_batch_start plans the next batch through the formal workflow", async () => {
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const prepareNextStoryArcBatch = vi.fn().mockResolvedValue({ batchIndex: 2, startChapterIndex: 11 });
    const start = vi.fn().mockResolvedValue({ firstExecutionRunId: "temporal-run-arc-batch-1" });
    const result = await executeTool(
      "novel_story_arc_batch_start",
      { projectId: "p1", arcId: "arc-1" },
      {
        repository: { prepareNextStoryArcBatch, withStoryArcWorkflowLock: async (_projectId: string, _arcId: string, callback: () => Promise<unknown>) => callback(), putWorkflowRun } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ status: "accepted", batchIndex: 2, startChapterIndex: 11 });
    expect(prepareNextStoryArcBatch).toHaveBeenCalledWith("p1", "arc-1");
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({
      args: [expect.objectContaining({ arcId: "arc-1", batchIndex: 2, startChapterIndex: 11 })],
    }));
  });
});

// ===== C. 集成测试：executeTool happy path（需 Postgres）=====

describe("mcp-tool-gateway integration", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      console.warn(`[mcp-tool-gateway.test] Postgres 不可用: ${(error as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (repository) await repository.close();
  });

  (postgresAvailable ? describe : describe.skip)("with postgres", () => {
    it("novel_project_create happy path", async () => {
      // handler 使用 idempotencyKey 作为 projectId（schema additionalProperties: false 禁止传 projectId）
      const projectId = `mcp-test-${randomUUID().slice(0, 8)}`;
      const result = await executeTool(
        "novel_project_create",
        { title: "MCP 测试项目", idempotencyKey: projectId },
        { repository },
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.project.id).toBe(projectId);
    });

    it("novel_run_create happy path", async () => {
      const projectId = `mcp-run-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Run Test");
      const result = await executeTool(
        "novel_run_create",
        { projectId, mode: "chapter", idempotencyKey: `k-${Date.now()}` },
        { repository },
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.run.projectId).toBe(projectId);
      expect(payload.run.status).toBe("pending");
    });

    it("novel_project_list happy path", async () => {
      // 先创建一个项目保证列表非空
      const projectId = `mcp-list-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "List Test");
      const result = await executeTool("novel_project_list", {}, { repository });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(Array.isArray(payload.projects)).toBe(true);
      expect(payload.projects.some((p: { id: string }) => p.id === projectId)).toBe(true);
    });

    it("novel_artifact_get non-existent → isError=true", async () => {
      const result = await executeTool(
        "novel_artifact_get",
        { artifactId: "nonexistent" },
        { repository },
      );
      expect(result.isError).toBe(true);
    });
  });
});
