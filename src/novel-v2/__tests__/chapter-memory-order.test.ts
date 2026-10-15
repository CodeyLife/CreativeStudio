import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import { writeMemoryIndexWithTrace } from "../memory-index-drift";
import { isPostgresUnavailable } from "./test-db";
import type { ChapterMemory } from "../protocol";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("chapter memory recency", () => {
  const projectId = `test-memory-order-${randomUUID().slice(0, 8)}`;
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Memory order test");
      for (let order = 1; order <= 7; order += 1) {
        const documentId = `doc-${String.fromCharCode(123 - order)}-${order}`;
        const revisionId = `revision-${order}-1`;
        const contentHash = `content-${projectId}-${order}`;
        await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'final')", [documentId, projectId, `chapter ${order}`, order]);
        await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [contentHash, `test/${contentHash}`]);
        await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, contentHash]);
        await repository.createChapterMemory(memory({ id: `memory-${order}-1`, projectId, documentId, revisionId, order, summary: `chapter-${order}-old`, createdAt: order }));
        if (order === 7) {
          const latestRevisionId = `revision-${order}-2`;
          const latestContentHash = `content-${projectId}-${order}-2`;
          await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [latestContentHash, `test/${latestContentHash}`]);
          await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,2,1,$4)", [latestRevisionId, projectId, documentId, latestContentHash]);
          await repository.createChapterMemory(memory({ id: `memory-${order}-2`, projectId, documentId, revisionId: latestRevisionId, order, summary: `chapter-${order}-latest`, createdAt: 100 }));
        }
      }
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[chapter-memory-order.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!repository) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("returns the latest revision for the most recent narrative chapters", async () => {
    if (!available) return;
    const memories = await repository.getChapterMemories({ projectId, narrativeCutoff: 7, limit: 5 });
    expect(memories.map((item) => item.narrativeRange.start)).toEqual([3, 4, 5, 6, 7]);
    expect(memories.at(-1)).toMatchObject({ revisionId: "revision-7-2", summary: "chapter-7-latest" });
  });

  it("maintains a bounded hierarchical rollup for the chapter window", async () => {
    if (!available) return;
    const rollup = await repository.refreshChapterMemoryRollup(projectId, 7);
    expect(rollup).toMatchObject({
      id: `chapter-memory:rollup:${projectId}:1-20`,
      kind: "hierarchical",
      narrativeRange: { start: 1, end: 7 },
      predicate: "chapter-memory-rollup",
    });
    expect(rollup.content).toContain("第7章：chapter-7-latest");
    expect(rollup.sourceRevisionIds).toContain("revision-7-2");

    const refreshedRevisionId = "revision-7-3";
    const refreshedContentHash = `content-${projectId}-7-3`;
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [refreshedContentHash, `test/${refreshedContentHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,'doc-t-7',3,2,$3)", [refreshedRevisionId, projectId, refreshedContentHash]);
    await repository.createChapterMemory(memory({ id: "memory-7-3", projectId, documentId: "doc-t-7", revisionId: refreshedRevisionId, order: 7, summary: "chapter-7-refreshed", createdAt: 200 }));

    const refreshed = await repository.refreshChapterMemoryRollup(projectId, 7);
    expect(refreshed.id).toBe(rollup.id);
    expect(refreshed.content).toContain("第7章：chapter-7-refreshed");
    expect(refreshed.contentHash).not.toBe(rollup.contentHash);
  });

  it("blocks the third consecutive critical miss and resets only after a completed rebuild", async () => {
    if (!available) return;
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-1", criticalMissingFacets: ["fact"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 1, blocked: false });
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-2", criticalMissingFacets: ["chapter-memory"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 2, blocked: false });
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-3", criticalMissingFacets: ["fact", "chapter-memory"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 3, blocked: true });
    await repository.completeMemoryRebuild(projectId, 8);
    await expect(repository.recordMemoryGateCheck({ projectId, workflowId: "wf-4", criticalMissingFacets: ["fact"] })).resolves.toMatchObject({ consecutiveCriticalMisses: 1, blocked: false });
  });

  /**
   * 索引写入的"不阻塞 + 留痕"包膜（state-audit-20261013 §8.6）。
   *
   * 8 处"先写库、后写 Qdrant"的写入点里，曾有 5 处只 `console.warn`。
   * **"不阻塞主路径"与"不留痕迹"是两件事**——前者是契约，后者是缺口。只 warn 的后果：
   * 库里那一行此后在一切查询里都显得完全活着，只有语义检索永远召不回它，没有任何科目
   * 因此变红，唯一暴露途径是 doctor 的漂移检查，而它按设计不自动触发——一次瞬时故障
   * 可以静默数周（运行库实测 6 条 current-revision 章记忆正是这个形态）。
   *
   * 双向覆盖：
   *  - 写入成功 ⇒ 原样返回值，且**不落任何账**（成功路径刷噪声会让账本不可信）；
   *  - 写入失败 ⇒ 不抛（主路径继续）+ 落 projection_failures（带重试计数与行 id 清单）。
   */
  it("writeMemoryIndexWithTrace：成功不落账、失败不抛且留行 id 清单", async () => {
    if (!available) return;
    const before = await repository.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM projection_failures WHERE project_id=$1 AND projection_type='memory-index:test-wrapper'",
      [projectId],
    );

    // 命中面一：成功路径零落账、原样返回值。
    const ok = await writeMemoryIndexWithTrace({
      projectId,
      aggregateId: "rev-ok",
      projectionType: "memory-index:test-wrapper",
      rowIds: ["row-a", "row-b"],
      write: async () => "written",
      record: (failure) => repository.recordProjectionFailure(failure),
    });
    expect(ok).toEqual({ ok: true, value: "written" });
    const afterOk = await repository.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM projection_failures WHERE project_id=$1 AND projection_type='memory-index:test-wrapper'",
      [projectId],
    );
    expect(afterOk.rows[0].n).toBe(before.rows[0].n);

    // 命中面二：失败不抛、落账、载荷带行 id 与条数（只有一句 error 等于没记）。
    const failed = await writeMemoryIndexWithTrace({
      projectId,
      aggregateId: "rev-fail",
      projectionType: "memory-index:test-wrapper",
      rowIds: ["row-a", "row-b"],
      write: async () => { throw new Error("Qdrant upsert timeout"); },
      record: (failure) => repository.recordProjectionFailure(failure),
    });
    expect(failed).toEqual({ ok: false, error: "Qdrant upsert timeout" });
    const row = await repository.pool.query<{ payload: { rowIds: string[]; rowCount: number }; error_message: string; status: string; attempts: number }>(
      "SELECT payload, error_message, status, attempts FROM projection_failures WHERE project_id=$1 AND projection_type='memory-index:test-wrapper' AND aggregate_id='rev-fail'",
      [projectId],
    );
    expect(row.rows[0].payload).toMatchObject({ rowIds: ["row-a", "row-b"], rowCount: 2 });
    expect(row.rows[0].error_message).toBe("Qdrant upsert timeout");
    expect(row.rows[0].status).toBe("pending");
    // 重复失败累加 attempts：待办账要能看出"这不是第一次"。
    await writeMemoryIndexWithTrace({
      projectId, aggregateId: "rev-fail", projectionType: "memory-index:test-wrapper", rowIds: ["row-a"],
      write: async () => { throw new Error("again"); },
      record: (failure) => repository.recordProjectionFailure(failure),
    });
    const retried = await repository.pool.query<{ attempts: number }>(
      "SELECT attempts FROM projection_failures WHERE project_id=$1 AND projection_type='memory-index:test-wrapper' AND aggregate_id='rev-fail'",
      [projectId],
    );
    expect(retried.rows[0].attempts).toBe(2);
  });

  /**
   * 记账自身失败也不得抛（观测路径不能把生产路径带崩）。
   *
   * 这一条是包膜的最后一道安全阀：若 recordProjectionFailure 自己抛（例如库抖动），
   * 而包膜没有内层 catch，那么一次索引故障会升级成一次写入失败——把"降级静默"
   * 换成"连带崩溃"，比原缺陷更坏。
   */
  it("writeMemoryIndexWithTrace：记账自身失败也只降级，不抛", async () => {
    if (!available) return;
    const outcome = await writeMemoryIndexWithTrace({
      projectId,
      aggregateId: "rev-record-fail",
      projectionType: "memory-index:test-wrapper",
      rowIds: ["row-a"],
      write: async () => { throw new Error("index down"); },
      record: async () => { throw new Error("db also down"); },
    });
    expect(outcome).toEqual({ ok: false, error: "index down" });
  });
});

function memory(input: { id: string; projectId: string; documentId: string; revisionId: string; order: number; summary: string; createdAt: number }): ChapterMemory {
  return {
    id: input.id,
    projectId: input.projectId,
    documentId: input.documentId,
    revisionId: input.revisionId,
    narrativeRange: { start: input.order, end: input.order },
    summary: input.summary,
    keyEvents: [],
    characterStates: [],
    unresolvedThreads: [],
    fingerprint: input.id,
    createdAt: input.createdAt,
  };
}
