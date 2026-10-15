import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
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
   * 索引写入失败必须留下耐久痕迹（state-audit-20261013 §8.4）。
   *
   * 失效形态（运行库实测 6 条章记忆正是这个形态）：章节记忆"先写库、后写索引"，
   * 索引失败按不阻塞契约只 console.warn。于是库里那一行此后在**一切查询里都显得
   * 完全活着**（可见性谓词认它、基线枚举含它、authority 正常），只有语义检索永远
   * 召不回它。没有任何科目因此变红，作者与审核面都看不到——一次瞬时 Qdrant 故障
   * 可以这样静默数周，唯一的暴露途径是 doctor 的漂移检查，而它按设计不自动触发。
   *
   * 双向覆盖：
   *  - 命中面：失败确实落审计记录 + outbox 事件（可查询、可告警）；
   *  - 反例面：无失败行时不写任何记录（不能在成功路径上刷噪声，否则账本不可信）。
   */
  it("索引写入失败落耐久痕迹，无失败时不写", async () => {
    if (!available) return;
    const before = await repository.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_records WHERE project_id=$1 AND action='memory.index-write-failed'",
      [projectId],
    );
    await repository.recordMemoryIndexWriteFailure({
      projectId,
      rowIds: ["memory-1-1", "chapter-memory:rollup:x"],
      reason: "Qdrant upsert timeout",
      stage: "chapter-memory.persist",
    });
    const after = await repository.pool.query<{ n: number; payload: { rowCount: number; rowIds: string[]; reason: string }; aggregate_type: string }>(
      "SELECT count(*)::int AS n, (array_agg(payload ORDER BY created_at DESC))[1] AS payload, (array_agg(aggregate_type ORDER BY created_at DESC))[1] AS aggregate_type FROM audit_records WHERE project_id=$1 AND action='memory.index-write-failed'",
      [projectId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    // 载荷必须带**行 id 与条数**：这是"哪几行欠灌"的定向补救清单。
    // 只有一句 reason 的话，运维仍不知道去补哪些行——那账本等于没记。
    expect(after.rows[0].payload).toMatchObject({ rowCount: 2, rowIds: ["memory-1-1", "chapter-memory:rollup:x"] });
    expect(after.rows[0].payload.reason).toBe("Qdrant upsert timeout");
    // stage 走 aggregate_type（与同表其他 audit 记录同族），不塞进载荷。
    expect(after.rows[0].aggregate_type).toBe("chapter-memory.persist");

    const events = await repository.pool.query<{ event_type: string; payload: { rowCount: number } }>(
      "SELECT event_type, payload FROM outbox_events WHERE project_id=$1 AND event_type='memory.index-write-failed'",
      [projectId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.rowCount).toBe(2);

    // 反例：空行集不写记录——成功路径上刷噪声会让账本失去可信度。
    await repository.recordMemoryIndexWriteFailure({ projectId, rowIds: [], reason: "noop", stage: "test" });
    const unchanged = await repository.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_records WHERE project_id=$1 AND action='memory.index-write-failed'",
      [projectId],
    );
    expect(unchanged.rows[0].n).toBe(after.rows[0].n);
  });

  /**
   * 接线锁： swallow 站点必须真的调用耐久记录（而不是只在一个没人调的方法里实现）。
   *
   * 上一条只验了 `recordMemoryIndexWriteFailure` 自身的行为。若 `persistChapterMemoryOutput`
   * 的 catch 块仍只 console.warn（本修复前的形态），那条用例**照样全绿**——方法存在但没人调，
   * 正是本仓反复清理的"谓词恒假的守卫"同族。故补一条源码级接线断言。
   */
  it("索引失败被吞处必须接通耐久记录（接线锁）", () => {
    const source = readFileSync(new URL("../chapter-memory/index.ts", import.meta.url), "utf8");
    const catchAt = source.indexOf("Qdrant 索引失败（不阻塞 Postgres 落库）");
    expect(catchAt, "定位不到 swallow 站点：锁会空转，必须修锁而非放行").toBeGreaterThan(0);
    const catchBlock = source.slice(catchAt, source.indexOf("return chapterMemory", catchAt));
    expect(catchBlock, "catch 块必须调用 recordMemoryIndexWriteFailure——只 warn 等于让欠灌静默数周").toContain("recordMemoryIndexWriteFailure");
    // 且必须带上行 id（否则运维不知道补哪些行）。
    expect(catchBlock).toContain("rowIds:");
    // 不得因记录失败而抛出：观测路径不能把生产路径带崩。
    expect(catchBlock).toContain(".catch(");
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
