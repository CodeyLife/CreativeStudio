import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact, MemoryClaim } from "../protocol";
import { ChapterStateRebuildConflictError } from "../application/chapter-state-rebuild";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function artifact(projectId: string, id: string, kind: Artifact["kind"], baseRevision: number, sourceArtifactId?: string): Artifact {
  return {
    id,
    projectId,
    taskId: `${id}:task`,
    attemptId: `${id}:attempt`,
    kind,
    contentHash: `${id}:hash`,
    objectKey: `${id}:object`,
    baseRevision,
    fingerprint: `${id}:fingerprint`,
    structuredData: sourceArtifactId ? { sourceArtifactId } : {},
    createdAt: Date.now(),
  };
}

function claim(projectId: string, id: string, contentHash: string, content: string): MemoryClaim {
  return {
    id,
    projectId,
    kind: "episodic",
    title: content,
    content,
    subjectRefs: ["hero"],
    narrativeRange: { start: 1, end: 1 },
    knowledgeScope: "author",
    authority: "derived",
    confidence: 0.95,
    sourceRevisionIds: [],
    contentHash,
    supersedes: [],
    predicate: "持有",
    identityHash: `${contentHash}:identity`,
    valueHash: contentHash,
  };
}

describe("fact revision lifecycle", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-fact-revision-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Fact Revision Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[fact-revision-lifecycle.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("deletes obsolete chapter facts while preserving facts re-extracted by the new revision", async () => {
    if (!available) return;
    const document = await repository.createNextDocument(projectId, "第一章");

    const draft1 = artifact(projectId, `draft-1-${randomUUID()}`, "draft", 0);
    const facts1 = artifact(projectId, `facts-1-${randomUUID()}`, "fact-extraction", 0, draft1.id);
    const obsolete = claim(projectId, `claim-obsolete-${randomUUID()}`, randomUUID(), "旧稿独有事实");
    const retainedHash = randomUUID();
    const retained = claim(projectId, `claim-retained-${randomUUID()}`, retainedHash, "新旧稿共同事实");
    await repository.recordFactExtraction({
      projectId,
      artifact: facts1,
      claims: [obsolete, retained],
      lifecycleStatus: "staged",
      documentId: document.id,
      workflowId: "workflow-1",
      narrativeOrder: 1,
    });
    const first = await repository.commitRevision({
      projectId,
      documentId: document.id,
      artifact: draft1,
      reviews: [],
      baseRevision: 0,
      idempotencyKey: `commit-1-${randomUUID()}`,
      text: "第一版",
      contentHash: randomUUID(),
      objectKey: `test/first-${randomUUID()}`,
      revisionId: randomUUID(),
      factArtifactId: facts1.id,
      narrativeOrder: 1,
    });

    const oldKnowledge = claim(projectId, `claim-knowledge-${randomUUID()}`, randomUUID(), "旧稿角色知识");
    oldKnowledge.knowledgeScope = { characterId: "hero" };
    oldKnowledge.sourceRevisionIds = [first.revisionId];
    await repository.recordFactExtraction({
      projectId,
      artifact: draft1,
      claims: [oldKnowledge],
      lifecycleStatus: "active",
      documentId: document.id,
      revisionId: first.revisionId,
      narrativeOrder: 1,
    });

    const draft2 = artifact(projectId, `draft-2-${randomUUID()}`, "revision", 1);
    const facts2 = artifact(projectId, `facts-2-${randomUUID()}`, "fact-extraction", 1, draft2.id);
    const replacement = claim(projectId, `claim-replacement-${randomUUID()}`, randomUUID(), "新稿独有事实");
    await repository.recordFactExtraction({
      projectId,
      artifact: facts2,
      claims: [{ ...retained, id: `another-id-${randomUUID()}` }, replacement],
      lifecycleStatus: "staged",
      documentId: document.id,
      workflowId: "workflow-2",
      narrativeOrder: 1,
    });
    const second = await repository.commitRevision({
      projectId,
      documentId: document.id,
      artifact: draft2,
      reviews: [],
      baseRevision: 1,
      idempotencyKey: `commit-2-${randomUUID()}`,
      text: "第二版",
      contentHash: randomUUID(),
      objectKey: `test/second-${randomUUID()}`,
      revisionId: randomUUID(),
      factArtifactId: facts2.id,
      narrativeOrder: 1,
    });

    const rows = await repository.pool.query<{ id: string; lifecycle_status: string; source_revision_ids: string[] }>(
      "SELECT id,lifecycle_status,source_revision_ids FROM memory_claims WHERE project_id=$1",
      [projectId],
    );
    const ids = rows.rows.map((row) => row.id);
    expect(ids).not.toContain(obsolete.id);
    expect(ids).not.toContain(oldKnowledge.id);
    expect(ids).toContain(retained.id);
    expect(ids).toContain(replacement.id);
    expect(rows.rows.find((row) => row.id === retained.id)).toMatchObject({ lifecycle_status: "active", source_revision_ids: [second.revisionId] });
    expect(second.removedClaimIds).toEqual(expect.arrayContaining([obsolete.id, oldKnowledge.id]));

    const rollbackFacts = artifact(projectId, `facts-rollback-${randomUUID()}`, "fact-extraction", 2, draft2.id);
    const rollbackClaim = claim(projectId, `claim-rollback-${randomUUID()}`, randomUUID(), "事务失败时不得激活的事实");
    await repository.recordFactExtraction({ projectId, artifact: rollbackFacts, claims: [rollbackClaim], lifecycleStatus: "staged", documentId: document.id, workflowId: "rollback-workflow", narrativeOrder: 1 });
    await expect(repository.applyCommittedChapterStateRebuild({
      projectId,
      documentId: document.id,
      revisionId: second.revisionId,
      factArtifactId: rollbackFacts.id,
      actorId: "test-author",
      artifact: rollbackFacts,
      narrativeOrder: 1,
      chapterMemory: {
        id: `memory:invalid-${randomUUID()}`,
        projectId,
        documentId: `missing-document-${randomUUID()}`,
        revisionId: second.revisionId,
        narrativeRange: { start: 1, end: 1 },
        summary: "该投影故意引用不存在的章节，用于验证事实切换和派生状态重建处于同一事务。",
        keyEvents: ["触发事务回滚"],
        characterStates: [],
        unresolvedThreads: [],
        fingerprint: randomUUID(),
        createdAt: Date.now(),
      },
    })).rejects.toThrow();
    const rollbackRows = await repository.pool.query<{ id: string; lifecycle_status: string }>(
      "SELECT id,lifecycle_status FROM memory_claims WHERE project_id=$1 AND id=ANY($2::text[])",
      [projectId, [retained.id, replacement.id, rollbackClaim.id]],
    );
    expect(rollbackRows.rows.find((row) => row.id === retained.id)?.lifecycle_status).toBe("active");
    expect(rollbackRows.rows.find((row) => row.id === replacement.id)?.lifecycle_status).toBe("active");
    expect(rollbackRows.rows.find((row) => row.id === rollbackClaim.id)?.lifecycle_status).toBe("staged");

    // 复审回归（memory-governance-audit-20260909 §8.1）：挂在当前 commit artifact 上的
    // 富化声明（角色知识边界）属于幸存 revision，状态重建不得把它 staged。
    const enrichmentKnowledge = claim(projectId, `claim-enrich-${randomUUID()}`, randomUUID(), "当前 revision 的角色知识边界");
    enrichmentKnowledge.knowledgeScope = { characterId: "hero" };
    enrichmentKnowledge.sourceRevisionIds = [second.revisionId];
    await repository.recordFactExtraction({
      projectId,
      artifact: draft2,
      claims: [enrichmentKnowledge],
      lifecycleStatus: "active",
      documentId: document.id,
      revisionId: second.revisionId,
      narrativeOrder: 1,
    });

    const rebuiltFacts = artifact(projectId, `facts-rebuild-${randomUUID()}`, "fact-extraction", 2, draft2.id);
    const rebuilt = claim(projectId, `claim-rebuilt-${randomUUID()}`, randomUUID(), "基于当前正式稿重建的事实");
    await repository.recordFactExtraction({ projectId, artifact: rebuiltFacts, claims: [rebuilt], lifecycleStatus: "staged", documentId: document.id, workflowId: "rebuild-workflow", narrativeOrder: 1 });
    const swap = await repository.replaceCommittedChapterFactSources({ projectId, documentId: document.id, revisionId: second.revisionId, factArtifactId: rebuiltFacts.id, actorId: "test-author" });
    const rebuiltRows = await repository.pool.query<{ id: string; lifecycle_status: string; source_revision_ids: string[] }>("SELECT id,lifecycle_status,source_revision_ids FROM memory_claims WHERE project_id=$1 AND id=ANY($2::text[])", [projectId, [retained.id, replacement.id, rebuilt.id, enrichmentKnowledge.id]]);
    expect(rebuiltRows.rows.find((row) => row.id === rebuilt.id)).toMatchObject({ lifecycle_status: "active", source_revision_ids: [second.revisionId] });
    expect(rebuiltRows.rows.find((row) => row.id === retained.id)?.lifecycle_status).toBe("staged");
    expect(rebuiltRows.rows.find((row) => row.id === replacement.id)?.lifecycle_status).toBe("staged");
    // 幸存 revision 的富化声明保持 active（知识单一来源不被重建切断）。
    expect(rebuiltRows.rows.find((row) => row.id === enrichmentKnowledge.id)).toMatchObject({ lifecycle_status: "active", source_revision_ids: [second.revisionId] });
    expect(swap.removedClaimIds).toEqual(expect.arrayContaining([retained.id, replacement.id]));
    expect(swap.removedClaimIds).not.toContain(enrichmentKnowledge.id);
  });

  it("blocks historical rebuilds without deleting later payoff evidence", async () => {
    if (!available) return;
    const isolatedProjectId = `test-rebuild-head-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(isolatedProjectId, "Rebuild Head Boundary");
    try {
      const firstDocument = await repository.createNextDocument(isolatedProjectId, "第一章");
      const firstDraft = artifact(isolatedProjectId, `draft-head-1-${randomUUID()}`, "draft", 0);
      await repository.recordArtifact(firstDraft);
      const firstCommit = await repository.commitRevision({ projectId: isolatedProjectId, documentId: firstDocument.id, artifact: firstDraft, reviews: [], baseRevision: 0, idempotencyKey: randomUUID(), text: "第一章", contentHash: randomUUID(), objectKey: randomUUID(), revisionId: randomUUID(), narrativeOrder: 1 });

      const laterDocument = await repository.createNextDocument(isolatedProjectId, "第二章");
      await expect(repository.assertChapterStateRebuildHead(isolatedProjectId, firstDocument.id, firstCommit.revisionId)).resolves.toBeUndefined();

      const secondDraft = artifact(isolatedProjectId, `draft-head-2-${randomUUID()}`, "draft", 1);
      await repository.recordArtifact(secondDraft);
      const secondCommit = await repository.commitRevision({ projectId: isolatedProjectId, documentId: laterDocument.id, artifact: secondDraft, reviews: [], baseRevision: 1, idempotencyKey: randomUUID(), text: "第二章", contentHash: randomUUID(), objectKey: randomUUID(), revisionId: randomUUID(), narrativeOrder: 2 });

      const promiseId = `promise-${randomUUID()}`;
      const payoffId = `payoff-${randomUUID()}`;
      const foreshadowingId = `foreshadowing-${randomUUID()}`;
      await repository.pool.query("INSERT INTO promises(id,project_id,statement,source_revision_id,status) VALUES($1,$2,$3,$4,'fulfilled')", [promiseId, isolatedProjectId, "第一章作出的承诺", firstCommit.revisionId]);
      await repository.pool.query("INSERT INTO payoffs(id,promise_id,revision_id,evidence) VALUES($1,$2,$3,$4)", [payoffId, promiseId, secondCommit.revisionId, { description: "第二章兑现承诺" }]);
      await repository.pool.query("INSERT INTO foreshadowing(id,project_id,planted_revision_id,payoff_revision_id,status,payload,narrative_order) VALUES($1,$2,$3,$4,'fulfilled',$5,1)", [foreshadowingId, isolatedProjectId, firstCommit.revisionId, secondCommit.revisionId, { description: "第一章伏笔" }]);

      const rebuiltFacts = artifact(isolatedProjectId, `facts-head-${randomUUID()}`, "fact-extraction", 1, firstDraft.id);
      const rebuiltClaim = claim(isolatedProjectId, `claim-head-${randomUUID()}`, randomUUID(), "历史章节重建事实");
      await repository.recordFactExtraction({ projectId: isolatedProjectId, artifact: rebuiltFacts, claims: [rebuiltClaim], lifecycleStatus: "staged", documentId: firstDocument.id, workflowId: randomUUID(), narrativeOrder: 1 });

      await expect(repository.replaceCommittedChapterFactSources({ projectId: isolatedProjectId, documentId: firstDocument.id, revisionId: firstCommit.revisionId, factArtifactId: rebuiltFacts.id, actorId: "test-author" })).rejects.toMatchObject({
        code: "HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE",
        details: { targetNarrativeOrder: 1, laterFinalDocumentId: laterDocument.id, laterNarrativeOrder: 2 },
      });
      await expect(repository.resetCommittedRevisionDerivedState(isolatedProjectId, firstDocument.id, firstCommit.revisionId)).rejects.toBeInstanceOf(ChapterStateRebuildConflictError);

      const preserved = await repository.pool.query<{ promise_count: string; payoff_count: string; foreshadowing_count: string }>(
        `SELECT
           (SELECT COUNT(*)::text FROM promises WHERE id=$1) AS promise_count,
           (SELECT COUNT(*)::text FROM payoffs WHERE id=$2) AS payoff_count,
           (SELECT COUNT(*)::text FROM foreshadowing WHERE id=$3 AND status='fulfilled' AND payoff_revision_id=$4) AS foreshadowing_count`,
        [promiseId, payoffId, foreshadowingId, secondCommit.revisionId],
      );
      expect(preserved.rows[0]).toEqual({ promise_count: "1", payoff_count: "1", foreshadowing_count: "1" });
    } finally {
      await repository.deleteProject(isolatedProjectId).catch(() => undefined);
    }
  });

  it("跨章持续事实的叙事区间覆盖全部来源（narrative_end 取 MAX 而非 MIN）", async () => {
    if (!available) return;
    const spanProjectId = `test-claim-span-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(spanProjectId, "Claim Span");
    try {
      const firstDocument = await repository.createNextDocument(spanProjectId, "第一章");
      const secondDocument = await repository.createNextDocument(spanProjectId, "第二章");
      const persistent = claim(spanProjectId, `claim-span-${randomUUID()}`, randomUUID(), "贯穿两章仍然成立的持续事实");

      const firstFacts = artifact(spanProjectId, `facts-span-1-${randomUUID()}`, "fact-extraction", 0);
      await repository.recordFactExtraction({ projectId: spanProjectId, artifact: firstFacts, claims: [persistent], lifecycleStatus: "staged", documentId: firstDocument.id, workflowId: "span-workflow-1", narrativeOrder: 1 });
      const firstDraft = artifact(spanProjectId, `draft-span-1-${randomUUID()}`, "draft", 0);
      await repository.commitRevision({ projectId: spanProjectId, documentId: firstDocument.id, artifact: firstDraft, reviews: [], baseRevision: 0, idempotencyKey: randomUUID(), text: "第一章", contentHash: randomUUID(), objectKey: randomUUID(), revisionId: randomUUID(), factArtifactId: firstFacts.id, narrativeOrder: 1 });
      await repository.pool.query("UPDATE manuscript_documents SET status='final' WHERE id=$1", [firstDocument.id]);

      // 第二条来源落在更靠后的章节：重新抽取会先把投影覆写为单章口径（2,2），
      // commit 的投影重算负责把它恢复成真实跨度（1,2）。
      const secondFacts = artifact(spanProjectId, `facts-span-2-${randomUUID()}`, "fact-extraction", 1);
      await repository.recordFactExtraction({ projectId: spanProjectId, artifact: secondFacts, claims: [persistent], lifecycleStatus: "staged", documentId: secondDocument.id, workflowId: "span-workflow-2", narrativeOrder: 2 });
      const secondDraft = artifact(spanProjectId, `draft-span-2-${randomUUID()}`, "draft", 1);
      await repository.commitRevision({ projectId: spanProjectId, documentId: secondDocument.id, artifact: secondDraft, reviews: [], baseRevision: 1, idempotencyKey: randomUUID(), text: "第二章", contentHash: randomUUID(), objectKey: randomUUID(), revisionId: randomUUID(), factArtifactId: secondFacts.id, narrativeOrder: 2 });
      await repository.pool.query("UPDATE manuscript_documents SET status='final' WHERE id=$1", [secondDocument.id]);

      const span = await repository.pool.query<{ lifecycle_status: string; narrative_start: string; narrative_end: string }>(
        "SELECT lifecycle_status,narrative_start,narrative_end FROM memory_claims WHERE project_id=$1 AND id=$2",
        [spanProjectId, persistent.id],
      );
      expect(span.rows[0]).toMatchObject({ lifecycle_status: "active", narrative_start: "1", narrative_end: "2" });

      const sourceCount = await repository.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text count FROM memory_claim_sources WHERE claim_id=$1 AND lifecycle_status='active'",
        [persistent.id],
      );
      expect(sourceCount.rows[0].count).toBe("2");

      // 反例面（单来源声明）：跨度本应为点，修复不得把它拉成区间。
      const single = claim(spanProjectId, `claim-single-${randomUUID()}`, randomUUID(), "只在第二章出现的一次性事实");
      const thirdFacts = artifact(spanProjectId, `facts-span-3-${randomUUID()}`, "fact-extraction", 2);
      await repository.recordFactExtraction({ projectId: spanProjectId, artifact: thirdFacts, claims: [single], lifecycleStatus: "staged", documentId: secondDocument.id, workflowId: "span-workflow-3", narrativeOrder: 2 });
      const thirdDraft = artifact(spanProjectId, `draft-span-3-${randomUUID()}`, "revision", 2);
      await repository.commitRevision({ projectId: spanProjectId, documentId: secondDocument.id, artifact: thirdDraft, reviews: [], baseRevision: 2, idempotencyKey: randomUUID(), text: "第二章改稿", contentHash: randomUUID(), objectKey: randomUUID(), revisionId: randomUUID(), factArtifactId: thirdFacts.id, narrativeOrder: 2 });
      const singleSpan = await repository.pool.query<{ narrative_start: string; narrative_end: string }>(
        "SELECT narrative_start,narrative_end FROM memory_claims WHERE project_id=$1 AND id=$2",
        [spanProjectId, single.id],
      );
      expect(singleSpan.rows[0]).toMatchObject({ narrative_start: "2", narrative_end: "2" });
    } finally {
      await repository.deleteProject(spanProjectId).catch(() => undefined);
    }
  });
});
