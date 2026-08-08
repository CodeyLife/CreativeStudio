import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { auditNamedReferences, auditStoryArcBatchRanges, canonicalReferenceId, normalizeThreadResponsibilityReferences, resolveNamedReference } from "../application/story-arc-integrity";
import { buildNarrativeRhythmSnapshotQuery, NovelPostgresRepository } from "../postgres-repository";

describe("story arc integrity diagnostics", () => {
  it("detects invalid and overlapping active batch windows", () => {
    const issues = auditStoryArcBatchRanges([
      { batchIndex: 1, startChapterIndex: 1, endChapterIndex: 6, status: "approved" },
      { batchIndex: 2, startChapterIndex: 4, endChapterIndex: 8, status: "awaiting-review" },
      { batchIndex: 3, startChapterIndex: 0, endChapterIndex: 2, status: "generating" },
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["overlapping-batch", "invalid-range"]));
    expect(issues.every((issue) => issue.severity === "blocking")).toBe(true);
  });

  it("does not treat a failed historical batch as an active overlap", () => {
    expect(auditStoryArcBatchRanges([
      { batchIndex: 1, startChapterIndex: 1, endChapterIndex: 6, status: "failed" },
      { batchIndex: 2, startChapterIndex: 1, endChapterIndex: 6, status: "approved" },
    ])).toEqual([]);
  });

  it("keeps the widest surviving range as the overlap frontier", () => {
    const issues = auditStoryArcBatchRanges([
      { batchIndex: 1, startChapterIndex: 1, endChapterIndex: 10, status: "approved" },
      { batchIndex: 2, startChapterIndex: 3, endChapterIndex: 4, status: "awaiting-review" },
      { batchIndex: 3, startChapterIndex: 5, endChapterIndex: 6, status: "approved" },
    ]);
    expect(issues.filter((issue) => issue.code === "overlapping-batch").map((issue) => issue.batchIndex)).toEqual([2, 3]);
  });

  it("resolves canonical IDs before aliases and reports ambiguity", () => {
    const candidates = [
      { id: "thread-a", labels: ["逃亡线", "逃亡"] },
      { id: "thread-b", labels: ["复仇线", "逃亡"] },
    ];
    expect(resolveNamedReference("thread-a", candidates)).toMatchObject({ status: "resolved", canonicalId: "thread-a" });
    expect(resolveNamedReference("复仇线", candidates)).toMatchObject({ status: "resolved", canonicalId: "thread-b" });
    expect(resolveNamedReference("逃亡", candidates)).toMatchObject({ status: "ambiguous", candidateIds: ["thread-a", "thread-b"] });
    expect(auditNamedReferences(["不存在的线"], candidates).issues[0]).toMatchObject({ code: "unknown-reference", severity: "blocking" });
    expect(canonicalReferenceId("thread", "project-1", "  逃亡线 ")).toBe(canonicalReferenceId("thread", "project-1", "逃亡线"));
  });

  it("normalizes thread responsibility aliases with the same canonical map", () => {
    expect(normalizeThreadResponsibilityReferences(
      [{ threadRef: "逃亡线", responsibility: "推进追捕压力", nextAdvance: "暴露落脚点" }],
      [{ id: "thread:escape", labels: ["逃亡线"] }],
    )).toEqual([{ threadRef: "thread:escape", responsibility: "推进追捕压力", nextAdvance: "暴露落脚点" }]);
    expect(() => normalizeThreadResponsibilityReferences(
      [{ threadRef: "共同别名" }],
      [{ id: "thread:a", labels: ["共同别名"] }, { id: "thread:b", labels: ["共同别名"] }],
    )).toThrow(/匹配多个对象/);
  });

  it("keeps narrative rhythm SQL executable without a dangling select comma", () => {
    const query = buildNarrativeRhythmSnapshotQuery();
    expect(query).toContain("FROM chapters target");
    expect(query).not.toMatch(/chapter_payload,\s*FROM/iu);
  });
});

describe("story arc batch reconciliation integration", () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  let projectId: string;
  let arcId: string;

  beforeAll(async () => {
    projectId = `test-story-arc-integrity-${randomUUID().slice(0, 8)}`;
    arcId = `arc-${projectId}`;
    try {
      repository = new NovelPostgresRepository(testDatabaseUrl);
      await repository.migrate();
      await repository.ensureProject(projectId, "Story arc integrity test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'测试弧',1,'approved','active','{"title":"测试弧","objective":"测试创作目的"}'::jsonb)`,
        [arcId, `volume-${projectId}`, projectId],
      );
      available = true;
    } catch (error) {
      console.warn(`[story-arc-integrity.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available && repository) await repository.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("does not reconcile an approved retry after a failed historical batch", async () => {
    if (!available || !repository) return;

    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);

    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$3,$4,1,1,6,'failed','{}'::jsonb),
             ($2,$3,$4,2,1,6,'approved','{}'::jsonb)`,
      [`batch-failed-${projectId}`, `batch-retry-${projectId}`, arcId, projectId],
    );

    const result = await repository.reconcileStoryArcBatchRanges(projectId, arcId);
    expect(result.reconciled).toEqual([]);
    const batch = await repository.pool.query<{ status: string }>("SELECT status FROM story_arc_batches WHERE id=$1", [`batch-retry-${projectId}`]);
    expect(batch.rows[0].status).toBe("approved");
  });

  it("compares later batches with the last surviving range after an empty overlap is failed", async () => {
    if (!available || !repository) return;

    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$4,$5,1,1,5,'approved','{}'::jsonb),
             ($2,$4,$5,2,4,6,'approved','{}'::jsonb),
             ($3,$4,$5,3,6,8,'approved','{}'::jsonb)`,
      [`batch-base-${projectId}`, `batch-overlap-${projectId}`, `batch-later-${projectId}`, arcId, projectId],
    );

    const result = await repository.reconcileStoryArcBatchRanges(projectId, arcId);
    expect(result.reconciled).toEqual([2]);
    const batches = await repository.pool.query<{ batch_index: number; status: string }>(
      "SELECT batch_index,status FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index",
      [arcId],
    );
    expect(batches.rows).toEqual([
      { batch_index: 1, status: "approved" },
      { batch_index: 2, status: "failed" },
      { batch_index: 3, status: "approved" },
    ]);
  });

  it("retains a wider surviving range when a nested active batch is encountered", async () => {
    if (!available || !repository) return;

    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$4,$5,1,1,10,'approved','{}'::jsonb),
             ($2,$4,$5,2,3,4,'awaiting-review','{}'::jsonb),
             ($3,$4,$5,3,5,6,'approved','{}'::jsonb)`,
      [`batch-wide-${projectId}`, `batch-nested-${projectId}`, `batch-later-nested-${projectId}`, arcId, projectId],
    );

    const result = await repository.reconcileStoryArcBatchRanges(projectId, arcId);
    expect(result.reconciled).toEqual([3]);
    const batches = await repository.pool.query<{ batch_index: number; status: string }>(
      "SELECT batch_index,status FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index",
      [arcId],
    );
    expect(batches.rows).toEqual([
      { batch_index: 1, status: "approved" },
      { batch_index: 2, status: "awaiting-review" },
      { batch_index: 3, status: "failed" },
    ]);
  });

  it("recovers a failed arc without a pending batch through rebase preparation", async () => {
    if (!available || !repository) return;

    const blueprintId = `blueprint-rebase-${projectId}`;
    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint)
       VALUES($1,$2,'rebase-test:artifact','attempt','chapter-blueprint','test-hash',0,'test-fingerprint')`,
      [blueprintId, projectId],
    );
    await repository.pool.query(
      `UPDATE arcs SET planning_status='failed', blueprint_artifact_id=$2, payload=payload || '{"failureReason":"audit failed"}'::jsonb WHERE id=$1`,
      [arcId, blueprintId],
    );

    const recovered = await repository.prepareStoryArcRebase(projectId, arcId, "test");
    if (!recovered) throw new Error("rebase preparation returned no arc");
    expect(recovered.planningStatus).toBe("awaiting-review");
    expect(recovered.blueprintArtifactId).toBe(blueprintId);
    const row = await repository.pool.query<{ planning_status: string; blueprint_artifact_id: string | null; failure_reason: boolean }>(
      `SELECT planning_status, blueprint_artifact_id, payload ? 'failureReason' AS failure_reason FROM arcs WHERE id=$1`,
      [arcId],
    );
    expect(row.rows[0]).toMatchObject({ planning_status: "awaiting-review", blueprint_artifact_id: blueprintId, failure_reason: false });
  });

  it("keeps review retry and rebase preparation mutually exclusive on a failed arc", async () => {
    if (!available || !repository) return;

    const blueprintId = `blueprint-retry-${projectId}`;
    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint)
       VALUES($1,$2,'retry-test:artifact','attempt','chapter-blueprint','test-hash',0,'test-fingerprint')`,
      [blueprintId, projectId],
    );

    // 场景 A：failed + 无 awaiting-review 批次 → retry 拒绝（死锁场景），rebase 允许恢复。
    await repository.pool.query(`UPDATE arcs SET planning_status='failed', blueprint_artifact_id=$2 WHERE id=$1`, [arcId, blueprintId]);
    await expect(repository.prepareStoryArcReviewRetry(projectId, arcId, "test")).rejects.toThrow("故事弧没有可重试的审核蓝图");
    const rebased = await repository.prepareStoryArcRebase(projectId, arcId, "test");
    if (!rebased) throw new Error("rebase preparation returned no arc");
    expect(rebased.planningStatus).toBe("awaiting-review");

    // 场景 B：failed + 有引用同一蓝图的 awaiting-review 批次 → retry 允许（审核中断重审），rebase 拒绝（不误入重基线）。
    await repository.pool.query(`UPDATE arcs SET planning_status='failed' WHERE id=$1`, [arcId]);
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,payload)
       VALUES($1,$2,$3,1,1,6,'awaiting-review',$4,'{}'::jsonb)`,
      [`batch-retry-${projectId}`, arcId, projectId, blueprintId],
    );
    await expect(repository.prepareStoryArcRebase(projectId, arcId, "test")).rejects.toThrow("故事弧没有可重基线的失败蓝图");
    const retried = await repository.prepareStoryArcReviewRetry(projectId, arcId, "test");
    if (!retried) throw new Error("retry preparation returned no arc");
    expect(retried.planningStatus).toBe("awaiting-review");
  });

  it("lets rebase recover a failed arc whose awaiting-review batch references a stale blueprint", async () => {
    if (!available || !repository) return;

    const currentBlueprintId = `blueprint-current-${projectId}`;
    const staleBlueprintId = `blueprint-stale-${projectId}`;
    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint)
       VALUES($1,$2,'stale-test:current','attempt','chapter-blueprint','test-hash',0,'test-fingerprint'),
             ($3,$2,'stale-test:stale','attempt','chapter-blueprint','test-hash',0,'test-fingerprint')`,
      [currentBlueprintId, projectId, staleBlueprintId],
    );

    // 场景 C：failed + awaiting-review 批次引用旧蓝图（source_artifact_id <> blueprint_artifact_id）：
    // retry 因引用不匹配拒绝，rebase 因"无引用当前蓝图的待审批次"允许恢复——闭合 retry/rebase
    // 前置条件互斥留下的死锁边角（此前该状态两个恢复路径都拒绝，弧永久卡在 failed）。
    await repository.pool.query(
      `UPDATE arcs SET planning_status='failed', blueprint_artifact_id=$2 WHERE id=$1`,
      [arcId, currentBlueprintId],
    );
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,payload)
       VALUES($1,$2,$3,1,1,6,'awaiting-review',$4,'{}'::jsonb)`,
      [`batch-stale-${projectId}`, arcId, projectId, staleBlueprintId],
    );
    await expect(repository.prepareStoryArcReviewRetry(projectId, arcId, "test")).rejects.toThrow("故事弧没有可重试的审核蓝图");
    const recovered = await repository.prepareStoryArcRebase(projectId, arcId, "test");
    if (!recovered) throw new Error("rebase preparation returned no arc");
    expect(recovered.planningStatus).toBe("awaiting-review");
    expect(recovered.blueprintArtifactId).toBe(currentBlueprintId);
  });
});
