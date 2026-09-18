import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildChapterGatePayload, finalizeChapterLifecycle, runChapterLifecycle } from "../application/chapter-lifecycle";
import { inspectManuscript, structuralReviewFromReport } from "../application/manuscript-structure";
import type { Artifact, FactApprovalSummary, Review, ReviewIssue } from "../protocol";
import type { ManuscriptStructuralReport } from "../application/manuscript-structure";

const artifact: Artifact = {
  id: "artifact-1",
  projectId: "project-1",
  taskId: "draft-1",
  attemptId: "attempt-1",
  kind: "draft",
  contentHash: "content-1",
  baseRevision: 1,
  fingerprint: "fingerprint-1",
  structuredData: {},
  createdAt: 1,
};

function review(id: string, identity: Review["identity"], verdict: Review["verdict"], warning = false, role?: string): Review {
  return {
    id,
    projectId: artifact.projectId,
    artifactId: artifact.id,
    reviewerId: id,
    identity,
    role,
    verdict,
    issues: warning ? [{ severity: "warning", title: "可微调", evidence: "段落 1" }] : [],
    score: verdict === "passed" ? 5 : 4,
    artifactFingerprint: artifact.fingerprint,
    createdAt: 2,
  };
}

function fivePassedReviews(): Review[] {
  return [
    review("structure", "internal", "passed", false, "structure-reviewer"),
    review("character", "independent", "passed", false, "character-reviewer"),
    review("prose", "independent", "passed", false, "prose-reviewer"),
  ];
}

function baseParams(reviews: Review[], events: string[]) {
  return {
    projectId: artifact.projectId,
    initialDraft: { artifact, text: "正文" },
    inspect: vi.fn(async (current: { artifact: Artifact; text: string }) => {
      const report = inspectManuscript({ text: current.text });
      return { report, review: structuralReviewFromReport(artifact.projectId, current.artifact, report, 1) };
    }),
    review: vi.fn(async (_current?: { artifact: Artifact; text: string }) => reviews),
    revise: vi.fn(async (current: { artifact: Artifact; text: string }, _reviews: Review[], _iteration: number, _directedIssues?: ReviewIssue[]) => current),
    assessLearning: vi.fn(async () => {
      events.push("learning");
      return {
        id: "learning-1",
        projectId: artifact.projectId,
        source: { workflowId: "workflow-1", artifactId: artifact.id, reviewIds: reviews.map((item) => item.id), fingerprint: artifact.fingerprint },
        conclusion: "no-shared-learning" as const,
        symptom: "none",
        failingLayer: "review",
        createdAt: 3,
      };
    }),
    extractFacts: vi.fn(async () => { events.push("facts"); return artifact; }),
    approveFacts: vi.fn(async (): Promise<FactApprovalSummary> => { events.push("fact-approval"); return { autoApproved: 0, pending: 0, pendingIds: [] }; }),
    commit: vi.fn(async () => { events.push("commit"); return { revisionId: "revision-2", revision: 2, contentHash: "content-2", projectRevision: 2, outboxEventId: 2 }; }),
    enrich: vi.fn(async () => { events.push("enrich"); }),
    progress: vi.fn(async () => undefined),
    requireManualFactApproval: false,
  };
}

describe("runChapterLifecycle", () => {
  it("records learning evidence but never extracts facts or commits when the dual gate fails", async () => {
    const events: string[] = [];
    const params = baseParams([
      review("internal", "internal", "revise", true),
      review("independent", "independent", "passed"),
    ], events);

    const result = await runChapterLifecycle(params);

    expect(result.commitGate.passed).toBe(false);
    expect(result.commitResult).toBeUndefined();
    expect(params.commit).not.toHaveBeenCalled();
    expect(params.enrich).not.toHaveBeenCalled();
    expect(events).toEqual(["learning"]);
  });

  it("commits and enriches only after current-artifact internal and independent reviews pass", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);

    const result = await runChapterLifecycle(params);

    expect(result.commitGate.passed).toBe(true);
    expect(result.commitResult?.revisionId).toBe("revision-2");
    expect(events).toEqual(["facts", "fact-approval", "commit", "enrich", "learning"]);
    expect(params.assessLearning).toHaveBeenCalledTimes(1);
  });

  it("returns factApprovalBlocked without committing when manual mode has pending facts", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);
    // manual 模式 + pending>0：应提前返回 factApprovalBlocked，不进入 commit/enrich
    params.approveFacts = vi.fn(async (): Promise<FactApprovalSummary> => {
      events.push("fact-approval");
      return { autoApproved: 2, pending: 1, pendingIds: ["claim-pending-1"] };
    });
    params.requireManualFactApproval = true;

    const result = await runChapterLifecycle(params);

    expect(result.factApprovalBlocked).toEqual({ pendingIds: ["claim-pending-1"], factArtifact: artifact });
    expect(result.commitResult).toBeUndefined();
    expect(params.commit).not.toHaveBeenCalled();
    expect(params.enrich).not.toHaveBeenCalled();
    // 仍应执行 facts 提取与 fact-approval，但不应在未提交的 artifact 上执行 learning。
    expect(events).toEqual(["facts", "fact-approval"]);
    expect(params.assessLearning).not.toHaveBeenCalled();
  });

  it("commits normally in manual mode when no pending facts exist", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);
    // manual 模式但 pending=0：应正常走 commit/enrich，与默认模式行为一致
    params.requireManualFactApproval = true;

    const result = await runChapterLifecycle(params);

    expect(result.factApprovalBlocked).toBeUndefined();
    expect(result.commitGate.passed).toBe(true);
    expect(result.commitResult?.revisionId).toBe("revision-2");
    expect(events).toEqual(["facts", "fact-approval", "commit", "enrich", "learning"]);
    expect(params.assessLearning).toHaveBeenCalledTimes(1);
  });

  it("runs post-commit learning when a manually approved fact gate resumes", async () => {
    const events: string[] = [];
    const params = baseParams(fivePassedReviews(), events);

    const result = await finalizeChapterLifecycle({
      projectId: params.projectId,
      draft: params.initialDraft,
      reviews: await params.review(),
      structuralReport: inspectManuscript({ text: params.initialDraft.text }),
      commit: params.commit,
      enrich: params.enrich,
      assessLearning: params.assessLearning,
      progress: params.progress,
    });

    expect(result.commitResult.revisionId).toBe("revision-2");
    expect(events).toEqual(["commit", "enrich", "learning"]);
  });

  it("runs a directed revision from selected issues before reviewing the revised draft", async () => {
    const events: string[] = [];
    const initialReviews = fivePassedReviews();
    const revisedArtifact = { ...artifact, id: "artifact-targeted", fingerprint: "fingerprint-targeted", contentHash: "content-targeted", kind: "revision" as const };
    const targetIssue = { severity: "warning" as const, title: "意象不够贴合人物", evidence: "像困兽撞笼", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }], suggestion: "改用结构性意象" };
    const params = baseParams(initialReviews, events);
    params.review = vi.fn(async (current?: { artifact: Artifact; text: string }) => {
      events.push("professional-review");
      expect(current?.artifact.id).toBe(revisedArtifact.id);
      return fivePassedReviews().map((item) => ({ ...item, artifactId: revisedArtifact.id, artifactFingerprint: revisedArtifact.fingerprint }));
    });
    params.revise = vi.fn(async (_current: { artifact: Artifact; text: string }, revisionReviews: Review[], _iteration: number, directedIssues?: ReviewIssue[]) => {
      events.push("targeted-revision");
      expect(revisionReviews).toMatchObject([{ identity: "human", reviewerId: "author-selected-review-issues", verdict: "revise", issues: [targetIssue] }]);
      expect(directedIssues).toEqual([targetIssue]);
      return { artifact: revisedArtifact, text: "正文\n\n结构如断齿般卡住" };
    });

    const result = await runChapterLifecycle({
      ...params,
      directedRevision: { issues: [targetIssue], requireManuscriptApproval: true },
    });

    expect(params.review).toHaveBeenCalledTimes(1);
    expect(params.revise).toHaveBeenCalledTimes(1);
    expect(result.draft.artifact.id).toBe(revisedArtifact.id);
    expect(result.iteration).toBe(1);
    expect(result.commitBlocked).toEqual({ reasonCode: "targeted-manuscript-approval", targetIssueCount: 1 });
    expect(params.extractFacts).not.toHaveBeenCalled();
    expect(params.commit).not.toHaveBeenCalled();
    expect(events).toEqual(["targeted-revision", "professional-review", "learning"]);
  });

  it("keeps the baseline candidate when a directed revision lowers lexicographic quality", async () => {
    const events: string[] = [];
    const baselineReviews = fivePassedReviews();
    const baselineStructuralReport = inspectManuscript({ text: "正文" });
    const revisedArtifact = { ...artifact, id: "artifact-directed-worse", fingerprint: "fingerprint-directed-worse", contentHash: "content-directed-worse", kind: "revision" as const };
    const targetIssue = { severity: "major" as const, title: "视角越界", evidence: "出现不可见信息" };
    const worseReviews = fivePassedReviews().map((item) => ({
      ...item,
      artifactId: revisedArtifact.id,
      artifactFingerprint: revisedArtifact.fingerprint,
      verdict: "revise" as const,
      score: 3,
      issues: [targetIssue],
    }));
    const params = baseParams(worseReviews, events);
    params.revise = vi.fn(async () => ({ artifact: revisedArtifact, text: "修订后正文" }));

    const result = await runChapterLifecycle({
      ...params,
      directedRevision: {
        issues: [targetIssue],
        requireManuscriptApproval: true,
        baseline: { reviews: baselineReviews, structuralReport: baselineStructuralReport },
      },
    });

    expect(result.draft.artifact.id).toBe(artifact.id);
    expect(result.reviews).toBe(baselineReviews);
    expect(result.finalScore).toBe(5);
    expect(result.commitGate.passed).toBe(true);
    expect(params.progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "revision-reverted" }));
  });

  it("reviews an unscored author-selected source and keeps it when directed revision is worse", async () => {
    const events: string[] = [];
    const sourceArtifact = { ...artifact, id: "artifact-author-edited", fingerprint: "fingerprint-author-edited", contentHash: "content-author-edited" };
    const revisedArtifact = { ...artifact, id: "artifact-author-revision", fingerprint: "fingerprint-author-revision", contentHash: "content-author-revision", kind: "revision" as const };
    const sourceReviews = fivePassedReviews().map((item) => ({ ...item, artifactId: sourceArtifact.id, artifactFingerprint: sourceArtifact.fingerprint, score: 4.4 }));
    const worseReviews = sourceReviews.map((item) => ({ ...item, artifactId: revisedArtifact.id, artifactFingerprint: revisedArtifact.fingerprint, verdict: "revise" as const, score: 3, issues: [{ severity: "major" as const, title: "修订引入退化", evidence: "证据" }] }));
    const params = baseParams(sourceReviews, events);
    params.initialDraft = { artifact: sourceArtifact, text: "作者编辑后的正文" };
    params.review = vi.fn(async (current?: { artifact: Artifact; text: string }) => current?.artifact.id === sourceArtifact.id ? sourceReviews : worseReviews);
    params.revise = vi.fn(async () => ({ artifact: revisedArtifact, text: "更差的定向修订" }));

    const result = await runChapterLifecycle({
      ...params,
      directedRevision: { issues: [{ severity: "major", title: "待处理问题", evidence: "证据" }], requireManuscriptApproval: true },
      reviewBeforeDirectedRevision: true,
      preserveDirectedRevisionCandidate: true,
    });

    expect(params.review).toHaveBeenCalledTimes(2);
    expect(result.draft.artifact.id).toBe(sourceArtifact.id);
    expect(result.reviews.map((review) => review.id)).toEqual([expect.stringMatching(/^structural:/), ...sourceReviews.map((review) => review.id)]);
    expect(result.finalScore).toBe(4.4);
    expect(params.progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "revision-reverted" }));
  });

  it("skips model reviewers for a structural blocker and reviews only after repair", async () => {
    const events: string[] = [];
    const repeated = "这是一段足够长的正文，用来验证结构门不会把连续重复交给五个模型审校员。".repeat(4);
    const initial = { ...artifact, id: "artifact-duplicate", fingerprint: "fingerprint-duplicate" };
    const repaired = { ...artifact, id: "artifact-repaired", fingerprint: "fingerprint-repaired", contentHash: "content-repaired", kind: "revision" as const };
    const params = baseParams(fivePassedReviews(), events);
    params.initialDraft = { artifact: initial, text: [repeated, repeated].join("\n\n") };
    params.revise = vi.fn(async () => ({ artifact: repaired, text: "雨停以后，他把旧案卷交给了等在门外的人。" }));
    params.review = vi.fn(async () => fivePassedReviews().map((item) => ({ ...item, artifactId: repaired.id, artifactFingerprint: repaired.fingerprint, score: 4 })));

    const result = await runChapterLifecycle(params);

    expect(params.revise).toHaveBeenCalledTimes(1);
    expect(params.review).toHaveBeenCalledTimes(1);
    expect(result.draft.artifact.id).toBe(repaired.id);
    expect(result.structuralReport.passed).toBe(true);
  });
});

describe("篇幅欠量门口径锁（raw vs 去白计长，ch151/ch165 贴线放行根因）", () => {
  // 根因：lifecycle 曾向 commitGate 传 raw `.length`（含空白与换行），而结构门自检与
  // 人工验收按可见字符计——两口径实测差 10-20%，使 60% 底线被虚高满足（短稿 raw 达标、
  // 真实字数不足仍过门）。修复=单源 countNovelCharacters（word-count 叶子模块，与
  // draft 契约/DEFAULT_TARGET_WORD_COUNT 同住，workflow bundle 安全）。
  // 结构面显式放行：本用例只锁「计长口径」，与段落融合/重复块等结构规则解耦
  //（重复填充文本会触发 structural-blocker，掩盖 length 分类）。
  const lengthParams = (text: string, targetWordCount: number) => ({
    ...baseParams(fivePassedReviews(), []),
    initialDraft: { artifact, text },
    inspect: vi.fn(async () => ({
      report: { passed: true, blockers: [], warnings: [], issues: [] } as unknown as ManuscriptStructuralReport,
      review: review("structure", "internal", "passed", false, "structure-reviewer"),
    })),
    targetWordCount,
  });

  it("raw 口径达标但可见字数不足者被拦（原缺陷形态）", async () => {
    // 每段「他走。」= 可见 2 字 + 标点/换行 3 字符：可见 1000 字、raw 2500 字符。
    const padded = "他走。\n\n".repeat(500);
    expect(padded.length).toBeGreaterThanOrEqual(1800); // raw 口径本会放行
    const result = await runChapterLifecycle(lengthParams(padded, 3000));
    expect(result.commitGate.qualityFailure).toBe("length-under-target");
    expect(result.commitGate.passed).toBe(false);
  });

  it("可见字数达标者放行（无标点/空白可借的正文）", async () => {
    const dense = "他走了四十七步".repeat(300); // 可见 2100 字
    const result = await runChapterLifecycle(lengthParams(dense, 3000));
    expect(result.commitGate.qualityFailure).toBeUndefined();
  });

  it("接线锁：lifecycle 必须用 countNovelCharacters 计长，不得回到 raw .length", () => {
    const source = readFileSync(fileURLToPath(new URL("../application/chapter-lifecycle.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/from "\.\.\/word-count"/);
    // 三个 commitGate 调用点全部改用同一计数源。
    expect(source.match(/plainTextLength: countNovelCharacters\(draft\.text\)/g)?.length).toBe(3);
    // 反例面：raw 口径不得残留（否则口径分裂复发）。
    expect(source).not.toMatch(/plainTextLength: draft\.text\.length/);
  });
});

describe("buildChapterGatePayload（门 payload 真值直通，弧5 编排误导根因修复）", () => {
  const base = {
    blueprintId: "bp-1",
    signalCount: 2,
    iterations: 1,
    finalScore: 4.83,
    draftArtifactId: "art-1",
    commitGate: { reviewIds: ["r1", "r2"], failedReviewIds: [], missingRoles: [] },
  };

  it("作者驱动修订后的批准门保留 targeted-manuscript-approval，不被改写成质量门未过", () => {
    const payload = buildChapterGatePayload({ ...base, commitBlocked: { reasonCode: "targeted-manuscript-approval", targetIssueCount: 3 } });
    expect(payload.reasonCode).toBe("targeted-manuscript-approval");
    expect(payload.targetIssueCount).toBe(3);
    // 反例面（历史 bug）：全绿批准稿绝不允许显示为 quality-gate-not-passed。
    expect(payload.reasonCode).not.toBe("quality-gate-not-passed");
  });

  it("无 blocked 时回落 quality-gate-not-passed；stage 一律显式覆写为 manuscript-approval", () => {
    const fallback = buildChapterGatePayload(base);
    expect(fallback.reasonCode).toBe("quality-gate-not-passed");
    expect(fallback.stage).toBe("manuscript-approval");
    // memory-coverage-incomplete 等其它语义码同样直通。
    const memoryGate = buildChapterGatePayload({ ...base, commitBlocked: { reasonCode: "memory-coverage-incomplete", missingFacets: ["relations"] } });
    expect(memoryGate.reasonCode).toBe("memory-coverage-incomplete");
    expect((memoryGate.missingFacets as string[])).toEqual(["relations"]);
    // 上一 progress 的阶段名被门 payload 覆写，不随 merge 残留误导外部读者。
    expect(memoryGate.stage).toBe("manuscript-approval");
  });

  it("commitGate 质量分类直通 reasonCode（无拦截因时），显式拦截因仍最优先", () => {
    const lengthGate = buildChapterGatePayload({ ...base, commitGate: { ...base.commitGate, qualityFailure: "length-under-target" } });
    expect(lengthGate.reasonCode).toBe("length-under-target");
    const structuralGate = buildChapterGatePayload({ ...base, commitGate: { ...base.commitGate, structuralFailure: "structural-blocker" } });
    expect(structuralGate.reasonCode).toBe("structural-blocker");
    // 优先级链：commitBlocked（定向/记忆覆盖等显式因）不被质量分类劫持。
    const both = buildChapterGatePayload({ ...base, commitGate: { ...base.commitGate, qualityFailure: "length-under-target" }, commitBlocked: { reasonCode: "targeted-manuscript-approval" } });
    expect(both.reasonCode).toBe("targeted-manuscript-approval");
  });
});
