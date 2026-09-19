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
import { isPostgresUnavailable } from "./test-db";
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
  it("TOOL_NAMES has exactly 50 tools", () => {
    // 47 → 49：2026-09-10 新增 novel_fact_candidate_queue/novel_fact_candidate_decide（FM-2）。
    // 49 → 50：2026-09-12 弧6 新增 novel_story_arc_decision。
    // 50 → 52：2026-09-12 弧6 新增 novel_foreshadowing_list/triage。
    // 52 → 59：2026-09-17 短剧创作台新增 7 个创作台/素材工具（后来被浏览器化移除）。
    // 59 → 49：2026-09-17 独立短剧改浏览器本地存储，移除 10 个独立短剧工具（short_script_h3/brainstorm/submit + 创作台/素材）。
    // 49 → 50：2026-09-19 回述对照只读诊断 novel_chapter_recall_report（审计 §四 19 的 D2 项）。
    expect(TOOL_NAMES).toHaveLength(50);
  });

  it("TOOL_DEFINITIONS has 50 defs, each with name/description/inputSchema", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(50);
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

  it("novel_fact_candidate_queue surfaces per-chapter backlog (FM-2)", async () => {
    const ctx = {
      repository: {
        getFactCandidateBacklog: async () => ({
          totalPending: 2, stagedDebris: 1, oldestPendingDays: 12.5,
          byChapter: [{ chapterIndex: 6, pending: 2, maxAgeDays: 12.5, visibleFacts: 20, pendingRatio: 0.091, samples: [] }],
        }),
      },
    } as never;
    const response = await executeTool("novel_fact_candidate_queue", { projectId: "p1" }, ctx);
    expect(response.isError).toBeFalsy();
    const body = JSON.parse(response.content[0].text);
    expect(body.totalPending).toBe(2);
    expect(body.byChapter[0].chapterIndex).toBe(6);
  });

  it("novel_chapter_recall_report pairs recall sentences with prior-chapter originals and never feeds the target chapter to itself", async () => {
    const readKeys: string[] = [];
    const bodies: Record<string, string> = {
      "key-9": "昨夜他试着让灵气撞开淤塞的经脉，那套走法后来再没用过。",
      "key-10": "他想起昨夜灵气撞开经脉的那套走法，膝上的旧伤跟着跳了一下。",
    };
    const ctx = {
      repository: {
        getChapterContentRefsByOrders: async (_projectId: string, orders: number[]) => orders.map((order) => ({
          documentId: `doc-${order}`,
          narrativeOrder: order,
          objectKey: order === 10 ? "key-10" : order === 9 ? "key-9" : `missing-${order}`,
        })),
      },
      objects: {
        getText: async (objectKey: string) => {
          readKeys.push(objectKey);
          if (bodies[objectKey]) return bodies[objectKey];
          throw new Error("对象不存在");
        },
      },
    } as never;
    const response = await executeTool("novel_chapter_recall_report", { projectId: "p1", narrativeOrder: 10, window: 2 }, ctx);
    expect(response.isError).toBeFalsy();
    const body = JSON.parse(response.content[0].text);
    expect(body).toMatchObject({ narrativeOrder: 10, documentId: "doc-10", window: 2 });
    expect(body.anchors).toHaveLength(1);
    expect(body.anchors[0]).toMatchObject({ cue: "想起" });
    // 第 9 章正文与回述句共享"灵气/经脉/走法"，是对照的真实来源；缺文的第 8 章被尝试读取后
    // 跳过（不计入 chaptersCompared），既不让缺文伪装成"无相似内容"，也不因此整批失败。
    expect(body.anchors[0].sources[0]).toMatchObject({ narrativeOrder: 9 });
    expect(typeof body.anchors[0].sources[0].similarity).toBe("number");
    expect(body.chaptersCompared).toBe(1);
    expect(readKeys).toContain("missing-8");
  });

  it("novel_chapter_recall_report fails loudly instead of guessing when inputs or object storage are missing", async () => {
    const withoutStore = { repository: { getChapterContentRefsByOrders: async () => [] } } as never;
    expect((await executeTool("novel_chapter_recall_report", { projectId: "p1", narrativeOrder: 3 }, withoutStore)).isError).toBe(true);
    const missingSnapshot = {
      repository: { getChapterContentRefsByOrders: async () => [] },
      objects: { getText: async () => "" },
    } as never;
    const response = await executeTool("novel_chapter_recall_report", { projectId: "p1", narrativeOrder: 3 }, missingSnapshot);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("没有当前正文快照");
    // schema 层就挡住缺参/非法值，不把手写校验当唯一防线。
    expect((await executeTool("novel_chapter_recall_report", { projectId: "p1" }, missingSnapshot)).isError).toBe(true);
    expect((await executeTool("novel_chapter_recall_report", { projectId: "p1", narrativeOrder: 0 }, missingSnapshot)).isError).toBe(true);
  });

  it("novel_fact_candidate_decide is idempotent per claim and syncs the approved point once", async () => {
    const decided: string[] = [];
    const upserted: string[] = [];
    const ctx = {
      repository: {
        decideFactCandidate: async ({ claimId }: { claimId: string }) => {
          if (claimId === "c2") throw new Error("事实候选已处理（当前 authority=approved）");
          decided.push(claimId);
          return { claimId, authority: "approved" as const };
        },
        getMemoryClaimById: async (_projectId: string, claimId: string) => ({ id: claimId }),
      },
      memoryIndex: {
        upsertClaims: async (_projectId: string, claims: Array<{ id: string }>) => { upserted.push(...claims.map((claim) => claim.id)); },
        deleteClaims: async () => undefined,
      },
    } as never;
    const response = await executeTool("novel_fact_candidate_decide", { projectId: "p1", claimIds: ["c1", "c2"], decision: "approve", reason: "作者确认：以正文证据为准" }, ctx);
    expect(response.isError).toBeFalsy();
    const body = JSON.parse(response.content[0].text);
    expect(body.results).toEqual([
      { claimId: "c1", status: "decided", authority: "approved" },
      { claimId: "c2", status: "skipped" },
    ]);
    expect(upserted).toEqual(["c1"]);
    expect(body.indexed).toBe(true);
    expect(body.vectorSyncError).toBeUndefined();
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

  describe("novel_story_arc_orchestrate", () => {
    it("valid args → valid=true", () => {
      const result = validateToolArgs("novel_story_arc_orchestrate", {
        projectId: "p-1",
        plotOutline: {
          objective: "主角必须混进暗渠上方的体系",
          centralConflict: "体系要求交出秘密",
          development: ["查明守门人", "通过审查"],
          threadResponsibilities: [{ threadRef: "thread-1", responsibility: "推进探查", nextAdvance: "身份暴露后转移" }],
          expectedChapterCount: 12,
          chapterHints: ["开篇是驱逐现场"],
          plotNotes: "伏笔：最后一封信在守门人手里",
        },
        reviewPolicy: "auto",
      });
      expect(result.valid).toBe(true);
    });

    it("missing plotOutline → valid=false", () => {
      expect(validateToolArgs("novel_story_arc_orchestrate", { projectId: "p-1" }).valid).toBe(false);
    });

    it("empty objective → valid=false", () => {
      expect(validateToolArgs("novel_story_arc_orchestrate", { projectId: "p-1", plotOutline: { objective: "" } }).valid).toBe(false);
    });

    it("malformed threadResponsibility entry → valid=false", () => {
      expect(validateToolArgs("novel_story_arc_orchestrate", {
        projectId: "p-1",
        plotOutline: { objective: "目标", threadResponsibilities: [{ threadRef: "t-1", responsibility: "r" }] },
      }).valid).toBe(false);
    });

    it("unknown field in plotOutline → valid=false", () => {
      expect(validateToolArgs("novel_story_arc_orchestrate", {
        projectId: "p-1",
        plotOutline: { objective: "目标", sceneCount: 5 },
      }).valid).toBe(false);
    });

    it("invalid reviewPolicy → valid=false", () => {
      expect(validateToolArgs("novel_story_arc_orchestrate", {
        projectId: "p-1",
        plotOutline: { objective: "目标", plotNotes: "说明" },
        reviewPolicy: "partial",
      }).valid).toBe(false);
    });
  });

  describe("novel_context_get", () => {
    it("valid args → valid=true", () => {
      expect(validateToolArgs("novel_context_get", { projectId: "p-1" }).valid).toBe(true);
      expect(validateToolArgs("novel_context_get", { projectId: "p-1", sections: ["narrative-state", "open-elements"] }).valid).toBe(true);
    });

    it("unknown section → valid=false", () => {
      expect(validateToolArgs("novel_context_get", { projectId: "p-1", sections: ["facts"] }).valid).toBe(false);
    });

    it("missing projectId → valid=false", () => {
      expect(validateToolArgs("novel_context_get", {}).valid).toBe(false);
    });
  });

  describe("novel_artifact_list", () => {
    it("valid args → valid=true", () => {
      expect(validateToolArgs("novel_artifact_list", { projectId: "p-1" }).valid).toBe(true);
      expect(validateToolArgs("novel_artifact_list", { projectId: "p-1", kind: "review", limit: 10 }).valid).toBe(true);
    });

    it("out-of-range limit → valid=false", () => {
      expect(validateToolArgs("novel_artifact_list", { projectId: "p-1", limit: 0 }).valid).toBe(false);
      expect(validateToolArgs("novel_artifact_list", { projectId: "p-1", limit: 101 }).valid).toBe(false);
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
          prepareStoryArcRebase: vi.fn().mockResolvedValue({
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

  it("novel_story_arc_orchestrate starts the orchestrated planning workflow with the outline", async () => {
    const createNextStoryArc = vi.fn().mockResolvedValue({ id: "arc-orch-1" });
    const putWorkflowRun = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ firstExecutionRunId: "temporal-run-orch-1" });
    const result = await executeTool(
      "novel_story_arc_orchestrate",
      {
        projectId: "p1",
        plotOutline: { objective: "查明暗渠上方的体系", development: ["找到守门人", "通过审查"], plotNotes: "伏笔在守门人手里" },
        reviewPolicy: "auto",
      },
      {
        repository: { createNextStoryArc, withStoryArcWorkflowLock: async (_projectId: string, _arcId: string, callback: () => Promise<unknown>) => callback(), putWorkflowRun } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ status: "accepted", orchestrated: true, arcId: "arc-orch-1" });
    expect(createNextStoryArc).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      plotOutline: expect.objectContaining({ objective: "查明暗渠上方的体系" }),
    }));
    expect(putWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "story-arc-planning",
      payload: expect.objectContaining({ orchestrated: true, plotOutline: expect.objectContaining({ objective: "查明暗渠上方的体系" }) }),
    }));
    expect(start).toHaveBeenCalledWith("storyArcPlanningWorkflow", expect.objectContaining({
      args: [expect.objectContaining({ arcId: "arc-orch-1", plotOutline: expect.objectContaining({ objective: "查明暗渠上方的体系" }) })],
    }));
  });

  it("novel_story_arc_orchestrate rejects an empty-substance outline before starting Temporal", async () => {
    const start = vi.fn();
    const result = await executeTool(
      "novel_story_arc_orchestrate",
      { projectId: "p1", plotOutline: { objective: "写一个故事" } },
      {
        repository: { withStoryArcWorkflowLock: async (_projectId: string, _arcId: string, callback: () => Promise<unknown>) => callback() } as never,
        temporal: { workflow: { start } } as never,
        taskQueue: "novel-v2",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("novel_story_arc_start");
    expect(start).not.toHaveBeenCalled();
  });

  it("novel_context_get projects the planning context with section filtering", async () => {
    const getStoryArcPlanningInput = vi.fn().mockResolvedValue({
      projectTitle: "测试项目",
      macro: [{ taskKey: "characters", title: "人物", summary: "甲" }],
      recentChapters: [{ order: 3, summary: "第三章程", unresolvedThreads: ["t-1"] }],
      openThreads: [{ id: "t-1", title: "线索一", payload: {} }],
      openForeshadowings: [],
      openPromises: [],
      planningFeedback: [],
      narrativeState: { narrativeOrder: 3, arcPhase: "development", openThreads: [], openForeshadowings: [], openPromises: [], fulfilledNodes: [], prohibitedEarlyConsumption: [], continuityConstraints: [], fingerprint: "fp" },
      contextReceipt: { narrativeCutoff: 3, sourceArtifactIds: [], sourceRevisionIds: [], sectionFingerprints: {}, fingerprint: "ctx-fp", legacy: false },
    });
    const result = await executeTool(
      "novel_context_get",
      { projectId: "p1", sections: ["narrative-state", "recent-chapters"] },
      { repository: { getStoryArcPlanningInput } as never },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.projectTitle).toBe("测试项目");
    expect(payload.narrativeState.narrativeOrder).toBe(3);
    expect(payload.recentChapters).toHaveLength(1);
    expect(payload.openThreads).toBeUndefined();
    expect(payload.foundation).toBeUndefined();
  });

  it("novel_artifact_list lists project artifacts through the repository", async () => {
    const listProjectArtifacts = vi.fn().mockResolvedValue([
      { id: "a-1", kind: "chapter-blueprint", taskId: "t-1", fingerprint: "f-1", createdAt: 1, objectKey: "o-1" },
    ]);
    const result = await executeTool(
      "novel_artifact_list",
      { projectId: "p1", kind: "chapter-blueprint" },
      { repository: { listProjectArtifacts } as never },
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.artifacts[0].id).toBe("a-1");
    expect(listProjectArtifacts).toHaveBeenCalledWith({ projectId: "p1", kind: "chapter-blueprint", limit: 50 });
  });

  it("novel_foreshadowing_list passes status/limit through and rejects bad status", async () => {
    const listForeshadowingForTriage = vi.fn().mockResolvedValue([{ id: "f-1", status: "open", overdue: true, window: "至第9章" }]);
    const ok = await executeTool("novel_foreshadowing_list", { projectId: "p1", status: "open", limit: 5 }, { repository: { listForeshadowingForTriage } as never });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text).foreshadowings[0].id).toBe("f-1");
    expect(listForeshadowingForTriage).toHaveBeenCalledWith("p1", { status: "open", limit: 5 });
    const bad = await executeTool("novel_foreshadowing_list", { projectId: "p1", status: "stale" }, { repository: { listForeshadowingForTriage } as never });
    expect(bad.isError).toBe(true);
  });

  it("novel_foreshadowing_triage requires reason per entry and maps entries through", async () => {
    const triageForeshadowing = vi.fn().mockResolvedValue({ processed: ["f-1"], skipped: [] });
    const ok = await executeTool(
      "novel_foreshadowing_triage",
      { projectId: "p1", actorId: "orchestrator:test", entries: [{ id: "f-1", action: "abandon", reason: "早期噪声，正文已无承接" }] },
      { repository: { triageForeshadowing } as never },
    );
    expect(ok.isError).toBeFalsy();
    expect(triageForeshadowing).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", actorId: "orchestrator:test", entries: [expect.objectContaining({ id: "f-1", action: "abandon" })] }));
    // 反例：兑现不经此门
    const payoff = await executeTool("novel_foreshadowing_triage", { projectId: "p1", actorId: "a", entries: [{ id: "f-1", action: "fulfill", reason: "越权" }] }, { repository: { triageForeshadowing } as never });
    expect(payoff.isError).toBe(true);
    // 反例：无 reason
    const bare = await executeTool("novel_foreshadowing_triage", { projectId: "p1", actorId: "a", entries: [{ id: "f-1", action: "abandon", reason: "  " }] }, { repository: { triageForeshadowing } as never });
    expect(bare.isError).toBe(true);
  });
});

// ===== C. 集成测试：executeTool happy path（需 Postgres）=====

describe("mcp-tool-gateway integration", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;
  // 收集期条件 describe 的教训（DB 集成套件禁空过纪律的姊妹面）：
  // `postgresAvailable ? describe : describe.skip` 在收集期求值，彼时 beforeAll 未跑、
  // 恒为 false——真库用例在数据库明明可用的开发机上被整批静默跳过（弧6 收口批次实证
  // 新写的伏笔分流用例根本没跑）。运行期 ctx.skip() 才把"跳过"如实呈现为 skipped。
  const itDb = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!postgresAvailable) return ctx.skip();
      await fn();
    });

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[mcp-tool-gateway.test] Postgres 不可用: ${(error as Error).message}`);
    }
  }, 30000);

  afterAll(async () => {
    if (repository) await repository.close();
  });

  describe("with postgres", () => {
    itDb("novel_project_create happy path", async () => {
      // handler 使用 idempotencyKey 作为 projectId（schema additionalProperties: false 禁止传 projectId）
      const projectId = `mcp-test-${randomUUID().slice(0, 8)}`;
      const result = await executeTool(
        "novel_project_create",
        { title: "MCP 测试项目", premise: "测试用创意：一名少年在旧宅发现会呼吸的石阶。", autoBootstrap: false, idempotencyKey: projectId },
        { repository },
      );
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.project.id).toBe(projectId);
    });

    itDb("novel_run_create happy path", async () => {
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

    itDb("novel_project_list happy path", async () => {
      // 先创建一个项目保证列表非空
      const projectId = `mcp-list-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "List Test");
      const result = await executeTool("novel_project_list", {}, { repository });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text);
      expect(Array.isArray(payload.projects)).toBe(true);
      expect(payload.projects.some((p: { id: string }) => p.id === projectId)).toBe(true);
    });

    itDb("novel_artifact_get non-existent → isError=true", async () => {
      const result = await executeTool(
        "novel_artifact_get",
        { artifactId: "nonexistent" },
        { repository },
      );
      expect(result.isError).toBe(true);
    });

    itDb("伏笔分流真库双向：abandon 出局留审计、窗口改写、非 open/未知/无 reason 逐条 skip", async () => {
      const projectId = `mcp-fs-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "Foreshadow Triage");
      const seed = async (id: string, status: string, window: unknown) => {
        await repository.pool.query(
          "INSERT INTO foreshadowing(id, project_id, status, payload, narrative_order) VALUES($1,$2,$3,$4,$5)",
          [id, projectId, status, { description: `伏笔 ${id}`, anchor: "石阶裂缝", triggerKeywords: ["裂缝"], expectedPayoffWindow: window }, 3],
        );
      };
      await seed("fs-open-1", "open", { scope: "chapter", from: 4, to: 6 });
      await seed("fs-open-2", "open", { scope: "chapter", from: 4, to: 6 });
      await seed("fs-done", "fulfilled", { scope: "chapter", from: 4, to: 6 });
      try {
        const list = await repository.listForeshadowingForTriage(projectId, { status: "all", overdueBeyondOrder: 10 });
        expect(list).toHaveLength(3);
        expect(list.filter((item) => item.status === "open").every((item) => item.overdue)).toBe(true);

        const outcome = await repository.triageForeshadowing({
          projectId,
          actorId: "test-author",
          entries: [
            { id: "fs-open-1", action: "abandon", reason: "早期噪声，正文无承接" },
            { id: "fs-open-2", action: "rewrite-window", reason: "弧7 digest", windowFrom: 43, windowTo: 48 },
            { id: "fs-done", action: "abandon", reason: "越权尝试" },
            { id: "fs-ghost", action: "abandon", reason: "不存在" },
            { id: "fs-open-1", action: "rewrite-window", reason: "窗口非法", windowFrom: 9, windowTo: 5 },
            { id: "fs-open-1", action: "abandon", reason: "   " },
          ],
        });
        expect(outcome.processed).toEqual(["fs-open-1", "fs-open-2"]);
        expect(outcome.skipped).toHaveLength(4); // fulfilled 拒改 / 未知 / 窗口倒挂 / 空 reason
        const openList = await repository.listForeshadowingForTriage(projectId, { status: "open", overdueBeyondOrder: 10 });
        expect(openList.map((item) => item.id)).toEqual(["fs-open-2"]);
        expect(openList[0].overdue).toBe(false); // 窗口改到 43-48 后不再超 10 章
        expect(openList[0].window).toContain("48");
        const abandoned = await repository.listForeshadowingForTriage(projectId, { status: "abandoned" });
        expect(abandoned[0].id).toBe("fs-open-1");
        const audit = await repository.pool.query("SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND event_type LIKE 'foreshadowing.triaged%' ORDER BY id", ["fs-open-1"]);
        expect(audit.rowCount).toBe(1);
        // 反例面：abandon 不删数据、埋设账保留
        const row = await repository.pool.query("SELECT narrative_order, payload FROM foreshadowing WHERE id='fs-open-1'");
        expect(Number(row.rows[0].narrative_order)).toBe(3);
        expect(String(row.rows[0].payload.anchor)).toBe("石阶裂缝");
      } finally {
        await repository.deleteProject(projectId);
      }
    });
  });
});
