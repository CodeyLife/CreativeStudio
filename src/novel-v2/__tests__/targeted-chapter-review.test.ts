import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact, Review } from "../protocol";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("targeted chapter review issues", () => {
  const suffix = randomUUID().slice(0, 8);
  const projectId = `targeted-review-${suffix}`;
  const documentId = `document-${suffix}`;
  const revisionId = `revision-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  const pendingIssueId = `issue-pending-${suffix}`;
  const ignoredIssueId = `issue-ignored-${suffix}`;
  const contentHash = `content-${suffix}`;
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Targeted review test");
      await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第一章',1,'final')", [documentId, projectId]);
      await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10)", [contentHash, `test/${contentHash}`]);
      await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, contentHash]);
      await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
      await repository.pool.query(`INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,verdict,complete,overall_score,reviewed_at)
        VALUES($1,$2,$3,$4,$5,'artifact-fingerprint','revise',TRUE,4.2,now())`, [snapshotId, documentId, projectId, revisionId, contentHash]);
      await repository.pool.query(`INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,severity,title,evidence_quote,paragraph,revision_ranges,suggestion,status)
        VALUES($1,$2,'fingerprint-pending','warning','意象失配','像齿轮一样精确',2,'[{"start":2,"end":2}]','改用世界内意象','pending'),
              ($3,$2,'fingerprint-ignored','major','重复解释','他知道自己明白了',3,'[{"start":3,"end":3}]','改为行动','ignored')`, [pendingIssueId, snapshotId, ignoredIssueId]);
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[targeted-chapter-review.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!repository) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("loads final manuscript content when a manual revision has no artifact", async () => {
    if (!available) return;
    await expect(repository.getFinalDocumentContentRef(projectId, documentId)).resolves.toMatchObject({
      status: "final",
      revision: 1,
      contentHash,
      objectKey: `test/${contentHash}`,
    });
  });

  it("normalizes PostgreSQL bigint narrative order to a runtime number", async () => {
    if (!available) return;
    await expect(repository.getProjectSnapshot(projectId, documentId)).resolves.toMatchObject({
      targetDocumentOrder: 1,
    });
    expect(typeof (await repository.getProjectSnapshot(projectId, documentId)).targetDocumentOrder).toBe("number");
  });

  it("loads only pending issues from the current non-stale snapshot", async () => {
    if (!available) return;
    const result = await repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [pendingIssueId] });
    expect(result).toMatchObject({ snapshotId, reviewedContentHash: contentHash, fingerprints: ["fingerprint-pending"] });
    expect(result.issues[0]).toMatchObject({ severity: "warning", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }] });
    await expect(repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [pendingIssueId, pendingIssueId] })).rejects.toThrow(/不能重复/);
    await expect(repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [ignoredIssueId] })).rejects.toThrow(/待处理/);
  });

  it("changes triage status without changing manuscript or review score", async () => {
    if (!available) return;
    const before = await repository.getChapterWorkspace(projectId, documentId);
    await repository.updateChapterReviewIssueStatus({ projectId, documentId, issueId: pendingIssueId, status: "resolved" });
    const after = await repository.getChapterWorkspace(projectId, documentId);
    expect(after?.content?.contentHash).toBe(before?.content?.contentHash);
    expect(after?.content?.revision).toBe(before?.content?.revision);
    expect(after?.review?.overallScore).toBe(before?.review?.overallScore);
    expect(after?.review?.issues.find((issue) => issue.id === pendingIssueId)?.status).toBe("resolved");
    await repository.updateChapterReviewIssueStatus({ projectId, documentId, issueId: pendingIssueId, status: "pending" });
  });

  it("adds author review notes to the same snapshot and keeps them targetable", async () => {
    if (!available) return;
    const created = await repository.addChapterReviewIssue({
      projectId,
      documentId,
      severity: "major",
      title: "人物反应太直白",
      paragraph: 2,
      suggestion: "改为动作和环境反馈",
    });
    expect(created).toMatchObject({ severity: "major", title: "人物反应太直白", sourceRoles: ["author"], status: "pending", revisionRanges: [{ start: 2, end: 2 }] });

    const workspace = await repository.getChapterWorkspace(projectId, documentId);
    expect(workspace?.review?.issues.find((issue) => issue.id === created.id)).toMatchObject({ title: "人物反应太直白", status: "pending" });

    const targeted = await repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [created.id] });
    expect(targeted.issues[0]).toMatchObject({ title: "人物反应太直白", paragraph: 2, revisionRanges: [{ start: 2, end: 2 }], suggestion: "改为动作和环境反馈" });
  });

  it("adds author review notes with multi-paragraph revision ranges covering every occurrence", async () => {
    if (!available) return;
    const created = await repository.addChapterReviewIssue({
      projectId,
      documentId,
      severity: "major",
      title: "同机制多处重述",
      evidenceQuote: "同一状态以相近措辞重复出现",
      revisionRanges: [{ start: 2, end: 2 }, { start: 4, end: 5 }],
      suggestion: "每处补可观察增量",
    });
    expect(created.revisionRanges).toEqual([{ start: 2, end: 2 }, { start: 4, end: 5 }]);
    const targeted = await repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [created.id] });
    expect(targeted.issues[0].revisionRanges).toEqual([{ start: 2, end: 2 }, { start: 4, end: 5 }]);
  });

  it("records targeted diagnostic reviews without promoting the chapter snapshot", async () => {
    if (!available) return;
    const workflowId = `targeted-diagnostic-${suffix}`;
    const artifact: Artifact = {
      id: `artifact-${suffix}`,
      projectId,
      taskId: `targeted-review-${suffix}`,
      attemptId: `attempt-${suffix}`,
      kind: "draft",
      contentHash,
      objectKey: `test/${contentHash}`,
      structuredData: { workflowId },
      baseRevision: 1,
      createdAt: Date.now(),
      fingerprint: `diagnostic-artifact-${suffix}`,
    };
    await repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "running", payload: { documentId, mode: "targeted" } });
    await repository.recordArtifact(artifact);
    const roles = ["structure-reviewer", "character-reviewer", "prose-reviewer"];
    for (const [index, role] of roles.entries()) {
      const review: Review = {
        id: `diagnostic-review-${index}-${suffix}`,
        projectId,
        artifactId: artifact.id,
        reviewerId: role,
        identity: index === 0 ? "internal" : "independent",
        verdict: "passed",
        issues: [],
        score: 5,
        role,
        createdAt: Date.now() + index,
        artifactFingerprint: artifact.fingerprint,
      };
      await repository.putReview(review, { refreshChapterSnapshot: false });
    }

    const workspace = await repository.getChapterWorkspace(projectId, documentId);
    expect(workspace?.review).toMatchObject({ id: snapshotId, overallScore: 4.2 });
    expect(workspace?.review?.issues.map((issue) => issue.id)).toContain(pendingIssueId);
  });

  it("accepts only one human decision for the current candidate artifact", async () => {
    if (!available) return;
    const workflowId = `human-decision-${suffix}`;
    const artifactId = `candidate-${suffix}`;
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${workflowId}:draft`, attemptId: `${workflowId}:attempt`, kind: "revision", contentHash, baseRevision: 1, fingerprint: `candidate-fingerprint-${suffix}`, createdAt: Date.now() });
    await repository.putWorkflowRun({
      id: workflowId,
      workflowType: "chapter-review",
      projectId,
      temporalWorkflowId: workflowId,
      status: "manual-review-required",
      payload: { documentId, artifactId, reasonCode: "targeted-manuscript-approval" },
    });

    await expect(repository.claimApprovalEvidence({ workflowId, artifactId, decision: "approve", actorSource: "automation", actorId: "automation" })).rejects.toThrow(/自动化来源/);
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" })).resolves.toMatchObject({
      evidence: { artifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" },
      run: { status: "manual-review-required", payload: { pendingHumanDecision: { artifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" } } },
    });
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" })).resolves.toBeUndefined();
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId: `${artifactId}-stale`, decision: "reject", actorSource: "interactive-web", actorId: "web-author" })).resolves.toBeUndefined();

    await repository.releaseHumanDecisionClaim(workflowId, artifactId);
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId, decision: "abandon", actorSource: "interactive-web", actorId: "web-author", feedback: "质量不足，放弃本轮", revisionBase: "previous" })).resolves.toMatchObject({
      run: { payload: { pendingHumanDecision: { artifactId, decision: "abandon", actorSource: "interactive-web", actorId: "web-author", feedback: "质量不足，放弃本轮", revisionBase: "previous" } } },
    });
  });

  it("consumes an approval claim so a reverted candidate can be decided again", async () => {
    if (!available) return;
    const workflowId = `reverted-human-decision-${suffix}`;
    const artifactId = `candidate-reverted-${suffix}`;
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${workflowId}:draft`, attemptId: `${workflowId}:attempt`, kind: "revision", contentHash, baseRevision: 1, fingerprint: `candidate-reverted-fingerprint-${suffix}`, createdAt: Date.now() });
    await repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "manual-review-required", payload: { documentId, artifactId, reasonCode: "quality-gate-not-passed" } });

    const first = await repository.claimApprovalEvidence({ workflowId, artifactId, decision: "revise", actorSource: "interactive-web", actorId: "web-author", revisionBase: "current" });
    expect(first).toBeDefined();
    await expect(repository.getApprovalEvidence(workflowId, first!.evidence.id)).resolves.toMatchObject({ revisionBase: "current" });
    await repository.updateWorkflowRunStatus(workflowId, "manual-review-required", { artifactId, reasonCode: "quality-gate-not-passed" });

    await expect(repository.claimApprovalEvidence({ workflowId, artifactId, decision: "abandon", actorSource: "interactive-web", actorId: "web-author" })).resolves.toBeDefined();
  });

  it("does not resurrect a terminal run when its approval evidence gets consumed", async () => {
    if (!available) return;
    // F5 回归：消费裁决那一步曾无条件写 status='running'。reject/abandon 短路径可能在
    // 回写落地前已把 run 写成终态，此时覆回 running 后工作流不再自写终态，只能等对账
    // 把僵尸 running 收编成 failed——一次成功的裁决最终以失败收场。现与漏斗同判据。
    const workflowId = `terminal-gate-consume-${suffix}`;
    const artifactId = `terminal-gate-candidate-${suffix}`;
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${workflowId}:draft`, attemptId: `${workflowId}:attempt`, kind: "revision", contentHash, baseRevision: 1, fingerprint: `terminal-gate-fingerprint-${suffix}`, createdAt: Date.now() });
    await repository.putWorkflowRun({ id: workflowId, workflowType: "chapter-review", projectId, temporalWorkflowId: workflowId, status: "manual-review-required", payload: { documentId, artifactId, reasonCode: "quality-gate-not-passed" } });
    const claim = await repository.claimApprovalEvidence({ workflowId, artifactId, decision: "revise", actorSource: "interactive-web", actorId: "web-author" });
    expect(claim).toBeDefined();

    await repository.updateWorkflowRunStatus(workflowId, "completed", { artifactId });
    // 裁决仍可被读到（消费是幂等读），但状态权归工作流：终态不得被覆回 running。
    await expect(repository.getApprovalEvidence(workflowId, claim!.evidence.id)).resolves.toMatchObject({ decision: "revise" });
    expect((await repository.getWorkflowRunByTemporalId(workflowId))?.status).toBe("completed");

    // 正向对照：门态内的裁决消费照常恢复 running。
    const activeId = `gate-consume-active-${suffix}`;
    const activeArtifact = `gate-consume-candidate-${suffix}`;
    await repository.recordArtifact({ id: activeArtifact, projectId, taskId: `${activeId}:draft`, attemptId: `${activeId}:attempt`, kind: "revision", contentHash, baseRevision: 1, fingerprint: `gate-consume-fingerprint-${suffix}`, createdAt: Date.now() });
    await repository.putWorkflowRun({ id: activeId, workflowType: "chapter-review", projectId, temporalWorkflowId: activeId, status: "manual-review-required", payload: { documentId, artifactId: activeArtifact, reasonCode: "quality-gate-not-passed" } });
    const activeClaim = await repository.claimApprovalEvidence({ workflowId: activeId, artifactId: activeArtifact, decision: "revise", actorSource: "interactive-web", actorId: "web-author" });
    await repository.getApprovalEvidence(activeId, activeClaim!.evidence.id);
    const resumed = await repository.getWorkflowRunByTemporalId(activeId);
    expect(resumed?.status).toBe("running");
    expect(resumed?.payload.pendingHumanDecision).toBeUndefined();
  });

  it("allows automation to approve the fact gate without allowing a manuscript override", async () => {
    if (!available) return;
    const workflowId = `fact-gate-automation-${suffix}`;
    const artifactId = `fact-gate-candidate-${suffix}`;
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${workflowId}:draft`, attemptId: `${workflowId}:attempt`, kind: "draft", contentHash, baseRevision: 1, fingerprint: `fact-gate-fingerprint-${suffix}`, createdAt: Date.now() });
    await repository.putWorkflowRun({ id: workflowId, workflowType: "novel-intent", projectId, temporalWorkflowId: workflowId, status: "manual-review-required", payload: { documentId, artifactId, reasonCode: "fact-approval-pending" } });

    await expect(repository.claimApprovalEvidence({ workflowId, artifactId, decision: "approve", actorSource: "automation", actorId: "automation" })).resolves.toMatchObject({ evidence: { actorSource: "automation", decision: "approve" } });
  });

  it("accepts a decision for a new candidate after the previous candidate was revised", async () => {
    if (!available) return;
    const workflowId = `multi-round-human-decision-${suffix}`;
    const firstArtifactId = `candidate-round-1-${suffix}`;
    const secondArtifactId = `candidate-round-2-${suffix}`;
    for (const [index, artifactId] of [firstArtifactId, secondArtifactId].entries()) {
      await repository.recordArtifact({ id: artifactId, projectId, taskId: `${workflowId}:draft:${index}`, attemptId: `${workflowId}:attempt:${index}`, kind: "revision", contentHash, baseRevision: 1, fingerprint: `candidate-round-${index}-${suffix}`, createdAt: Date.now() + index });
    }
    await repository.putWorkflowRun({
      id: workflowId,
      workflowType: "chapter-review",
      projectId,
      temporalWorkflowId: workflowId,
      status: "manual-review-required",
      payload: { documentId, artifactId: firstArtifactId, reasonCode: "quality-gate-not-passed" },
    });

    await expect(repository.claimApprovalEvidence({ workflowId, artifactId: firstArtifactId, decision: "revise", actorSource: "interactive-web", actorId: "web-author" })).resolves.toBeDefined();
    await repository.updateWorkflowRunStatus(workflowId, "manual-review-required", { artifactId: secondArtifactId, reasonCode: "quality-gate-not-passed" });

    await expect(repository.claimApprovalEvidence({ workflowId, artifactId: secondArtifactId, decision: "abandon", actorSource: "interactive-web", actorId: "web-author" })).resolves.toMatchObject({
      run: { payload: { artifactId: secondArtifactId, pendingHumanDecision: { artifactId: secondArtifactId, decision: "abandon" } } },
    });
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId: secondArtifactId, decision: "abandon", actorSource: "interactive-web", actorId: "web-author" })).resolves.toBeUndefined();
  });

  it("replaces the pending human artifact and makes the old artifact stale", async () => {
    if (!available) return;
    const workflowId = `artifact-replacement-${suffix}`;
    const sourceArtifactId = `candidate-source-${suffix}`;
    const replacementArtifactId = `candidate-edited-${suffix}`;
    const sourceArtifact: Artifact = {
      id: sourceArtifactId,
      projectId,
      taskId: `review-draft-${suffix}`,
      attemptId: `attempt-source-${suffix}`,
      kind: "revision",
      contentHash: `source-hash-${suffix}`,
      objectKey: `test/source-${suffix}`,
      structuredData: { workflowId },
      baseRevision: 1,
      createdAt: Date.now(),
      fingerprint: `source-fingerprint-${suffix}`,
    };
    const replacement: Artifact = {
      ...sourceArtifact,
      id: replacementArtifactId,
      attemptId: `attempt-edited-${suffix}`,
      contentHash: `edited-hash-${suffix}`,
      objectKey: `test/edited-${suffix}`,
      fingerprint: `edited-fingerprint-${suffix}`,
      structuredData: { ...sourceArtifact.structuredData, origin: "author-edit", replacesArtifactId: sourceArtifactId },
    };
    await repository.recordArtifact(sourceArtifact);
    await repository.putWorkflowRun({
      id: workflowId,
      workflowType: "chapter-review",
      projectId,
      temporalWorkflowId: workflowId,
      status: "manual-review-required",
      payload: { documentId, artifactId: sourceArtifactId, reasonCode: "targeted-manuscript-approval" },
    });

    await expect(repository.replacePendingHumanArtifact({ workflowId, currentArtifactId: sourceArtifactId, replacement, authorId: "author-1" })).resolves.toMatchObject({
      artifact: { id: replacementArtifactId },
      run: { payload: { artifactId: replacementArtifactId, replacedArtifactId: sourceArtifactId, authorEditedBy: "author-1" } },
    });
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId: sourceArtifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" })).resolves.toBeUndefined();
    await expect(repository.claimApprovalEvidence({ workflowId, artifactId: replacementArtifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" })).resolves.toMatchObject({
      run: { payload: { pendingHumanDecision: { artifactId: replacementArtifactId, decision: "approve", actorSource: "interactive-web", actorId: "web-author" } } },
    });
  });

  it("rejects invalid revision ranges instead of silently dropping them", async () => {
    if (!available) return;
    await expect(repository.addChapterReviewIssue({
      projectId,
      documentId,
      severity: "major",
      title: "非法范围",
      revisionRanges: [{ start: 9, end: 2 }],
    })).rejects.toThrow(/1<=start<=end/);
    await expect(repository.addChapterReviewIssue({
      projectId,
      documentId,
      severity: "major",
      title: "非整数范围",
      revisionRanges: [{ start: 1.5, end: 2 }],
    })).rejects.toThrow(/1<=start<=end/);
  });

  it("rejects a snapshot after the current manuscript hash changes", async () => {
    if (!available) return;
    const nextHash = `next-${contentHash}`;
    const nextRevisionId = `next-${revisionId}`;
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10)", [nextHash, `test/${nextHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,2,1,$4)", [nextRevisionId, projectId, documentId, nextHash]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [nextRevisionId, documentId]);
    await expect(repository.getTargetedChapterReviewIssues({ projectId, documentId, issueIds: [pendingIssueId] })).rejects.toThrow(/已过期/);
  });

  it("reports an active chapter review on a different document of the same project as a concurrency guard", async () => {
    if (!available) return;
    const otherDocumentId = `other-doc-${suffix}`;
    const otherWorkflowId = `other-review-${suffix}`;
    // 清理前序测试遗留的活跃 chapter-review workflow_run，隔离本测试。
    await repository.pool.query("DELETE FROM workflow_runs WHERE project_id=$1 AND workflow_type='chapter-review'", [projectId]);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第二章',2,'final')", [otherDocumentId, projectId]);
    await repository.putWorkflowRun({
      id: otherWorkflowId,
      workflowType: "chapter-review",
      projectId,
      temporalWorkflowId: otherWorkflowId,
      status: "running",
      payload: { documentId: otherDocumentId, reasonCode: "targeted-manuscript-approval" },
    });

    const preflight = await repository.getChapterReviewPreflight(projectId, otherDocumentId);
    expect(preflight?.projectActiveReviewWorkflowId).toBeUndefined();
    expect(preflight?.activeWorkflowId).toBe(otherWorkflowId);

    // 另一文档的活跃审校 → 同项目并发守卫命中
    const otherPreflight = await repository.getChapterReviewPreflight(projectId, documentId);
    expect(otherPreflight?.projectActiveReviewWorkflowId).toBe(otherWorkflowId);
  });

  it("快照聚合按蓝图档位判完整（S1）：窄档两审成快照，无档位三审才算全量", async () => {
    if (!available) return;
    // 三件套 fixture：workflow_run → execution_blueprint（changeScope=local-text），
    // 评审 artifact 挂 temporal_workflow_id；结构+文笔两审（裁掉的正是 character）。
    const scopeDocId = `scoped-doc-${suffix}`;
    const scopeWorkflowId = `scoped-review-${suffix}`;
    const scopeArtifactId = `scoped-artifact-${suffix}`;
    const scopeIntentId = `scoped-intent-${suffix}`;
    const scopeFingerprint = `scoped-fp-${suffix}`;
    const scopeHash = `scoped-hash-${suffix}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'档位快照章',3,'final')", [scopeDocId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10)", [scopeHash, `test/${scopeHash}`]);
    await repository.pool.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload,created_at) VALUES($1,$2,'t-scope','a-scope','chapter-draft',$3,0,$4,$5::jsonb,now())", [scopeArtifactId, projectId, scopeHash, scopeFingerprint, JSON.stringify({ workflowId: scopeWorkflowId })]);
    await repository.putWorkflowRun({
      id: `run-${scopeWorkflowId}`, workflowType: "chapter-generation", projectId,
      temporalWorkflowId: scopeWorkflowId, status: "running",
      payload: { documentId: scopeDocId, blueprintId: `eb-${suffix}`, intent: { id: scopeIntentId } },
    });
    // 蓝图 FK 链：intent → preflight → bundles → blueprint（与 blueprint-fallback 同法）。
    await repository.pool.query("INSERT INTO novel_intents(id,project_id,source,objective,payload,idempotency_key) VALUES($1,$2,'chapter-generate','档位测试',$3::jsonb,$4)", [scopeIntentId, projectId, JSON.stringify({ target: { kind: "chapter", id: scopeDocId } }), `k-scope-${suffix}`]);
    await repository.pool.query("INSERT INTO preflight_plans(id,intent_id,project_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [`pf-${suffix}`, scopeIntentId, projectId, `pfp-${suffix}`]);
    await repository.pool.query("INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [`mb-${suffix}`, projectId, `pf-${suffix}`, `mbf-${suffix}`]);
    await repository.pool.query("INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [`sb-${suffix}`, projectId, `pf-${suffix}`, `sbf-${suffix}`]);
    await repository.pool.query(
      `INSERT INTO execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'fp-eb',now())`,
      [`eb-${suffix}`, projectId, scopeIntentId, `pf-${suffix}`, `mb-${suffix}`, `sb-${suffix}`, JSON.stringify({ changeScope: "local-text" })],
    );
    for (const [role, identity] of [["structure-reviewer", "internal"], ["prose-reviewer", "independent"]] as const) {
      await repository.pool.query(
        "INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,issues,score,role,dimension_scores,artifact_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,'passed','[]'::jsonb,4.0,$6,'{}'::jsonb,$7,now())",
        [`rev-${role}-${suffix}`, projectId, scopeArtifactId, `reviewer-${role}`, identity, role, scopeFingerprint],
      );
    }
    // 正向：窄档两审 → 按 local-text 期望集判完整，快照行落库。
    expect(await repository.refreshChapterReviewSnapshot(scopeArtifactId, revisionId, "正文")).toBe(true);
    const scoped = await repository.pool.query<{ complete: boolean; reviewer_roles: string[] }>(
      "SELECT complete,reviewer_roles FROM chapter_review_snapshots WHERE document_id=$1", [scopeDocId],
    );
    expect(scoped.rows[0]).toMatchObject({ complete: true });
    expect(scoped.rows[0].reviewer_roles).toEqual(expect.arrayContaining(["structure-reviewer", "prose-reviewer"]));
    expect(scoped.rows[0].reviewer_roles).not.toContain("character-reviewer");

    // 反例：同两审、无蓝图档位 → narrative 全量期望，character 缺席不许成快照。
    const wideDocId = `wide-doc-${suffix}`;
    const wideWorkflowId = `wide-review-${suffix}`;
    const wideArtifactId = `wide-artifact-${suffix}`;
    const wideFingerprint = `wide-fp-${suffix}`;
    const wideHash = `wide-hash-${suffix}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'宽档对照章',4,'final')", [wideDocId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10)", [wideHash, `test/${wideHash}`]);
    await repository.pool.query("INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload,created_at) VALUES($1,$2,'t-wide','a-wide','chapter-draft',$3,0,$4,$5::jsonb,now())", [wideArtifactId, projectId, wideHash, wideFingerprint, JSON.stringify({ workflowId: wideWorkflowId })]);
    await repository.putWorkflowRun({
      id: `run-${wideWorkflowId}`, workflowType: "chapter-generation", projectId,
      temporalWorkflowId: wideWorkflowId, status: "running", payload: { documentId: wideDocId },
    });
    for (const [role, identity] of [["structure-reviewer", "internal"], ["prose-reviewer", "independent"]] as const) {
      await repository.pool.query(
        "INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,issues,score,role,dimension_scores,artifact_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,'passed','[]'::jsonb,4.0,$6,'{}'::jsonb,$7,now())",
        [`rev-wide-${role}-${suffix}`, projectId, wideArtifactId, `reviewer-${role}`, identity, role, wideFingerprint],
      );
    }
    expect(await repository.refreshChapterReviewSnapshot(wideArtifactId, revisionId, "正文")).toBe(false);
    const wideSnapshot = await repository.pool.query("SELECT 1 FROM chapter_review_snapshots WHERE document_id=$1", [wideDocId]);
    expect(wideSnapshot.rowCount).toBe(0);
  });
});
