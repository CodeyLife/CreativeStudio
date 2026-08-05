import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ChapterMemory } from "../protocol";

const EXPLICIT_TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_DB_URL = EXPLICIT_TEST_DB_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function chapterMemory(overrides: Partial<ChapterMemory> & { id: string; projectId: string; documentId: string; revisionId: string; order: number }): ChapterMemory {
  return {
    summary: `第${overrides.order}章摘要`,
    keyEvents: [],
    characterStates: [],
    unresolvedThreads: [],
    emotionalArc: undefined,
    narrativeRange: { start: overrides.order, end: overrides.order },
    fingerprint: `fp-${overrides.id}`,
    createdAt: 0,
    ...overrides,
  } as ChapterMemory;
}

describe("serial context snapshot (L1)", () => {
  const projectId = `test-serial-${randomUUID().slice(0, 8)}`;
  const arcId = `arc-${projectId}`;
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Serial context test");
      await repository.pool.query(
        `INSERT INTO books(id,project_id,title) VALUES($1,$2,'正文') ON CONFLICT DO NOTHING`,
        [`book-${projectId}`, projectId],
      );
      await repository.pool.query(
        `INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,'正文',1) ON CONFLICT DO NOTHING`,
        [`volume-${projectId}`, `book-${projectId}`],
      );
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'arc',1,'approved','active',$4::jsonb)`,
        [arcId, `volume-${projectId}`, projectId, JSON.stringify({ title: "arc", objective: "x" })],
      );
      // 6 章：第 8-11 章为 discovery 连续 4 章（功能密度信号），陈渊状态跨章等幅重述
      for (let order = 7; order <= 12; order += 1) {
        const documentId = `serial-doc-${order}`;
        const revisionId = `serial-rev-${order}`;
        const contentHash = `serial-content-${projectId}-${order}`;
        const chapterId = `serial-chapter-${order}`;
        await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'final')", [documentId, projectId, `第${order}章`, order]);
        await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [contentHash, `test/${contentHash}`]);
        await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, contentHash]);
        await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
        const narrativeFunction = order >= 8 && order <= 11 ? "discovery" : "development";
        await repository.pool.query(
          `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload)
           VALUES($1,$2,$3,$4,$5,$6,'final',$7::jsonb)`,
          [chapterId, arcId, projectId, documentId, `第${order}章`, order, JSON.stringify({ index: order, title: `第${order}章`, narrativeFunction, scenes: [] })],
        );
        await repository.createChapterMemory(chapterMemory({
          id: `serial-memory-${order}`, projectId, documentId, revisionId, order,
          characterStates: order >= 8
            ? [{ characterId: "陈渊", stateSnapshot: `第${order}章：肋骨断茬钝痛，手腕渗血，握着金属残片。` }]
            : [{ characterId: "陈渊", stateSnapshot: `第${order}章：虚弱。` }],
        }));
      }
      // 跨章 issue 聚类：第 7-9 章各有同 rule 的 warning
      for (let order = 7; order <= 9; order += 1) {
        const snapshotId = `snap-${order}`;
        await repository.pool.query(
          `INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,verdict,complete,overall_score,reviewer_roles,reviewed_at)
           VALUES($1,$2,$3,$4,$5,$6,'passed',TRUE,4.0,ARRAY[]::text[],now())`,
          [snapshotId, `serial-doc-${order}`, projectId, `serial-rev-${order}`, `serial-content-${projectId}-${order}`, `fp-${snapshotId}`],
        );
        await repository.pool.query(
          `INSERT INTO chapter_review_snapshot_issues(id,snapshot_id,issue_fingerprint,severity,title,rule,status)
           VALUES($1,$2,$3,'warning','状态等幅重述','cross-chapter-restatement','pending')`,
          [`issue-${order}`, snapshotId, `fingerprint-${order}`, ],
        );
      }
      available = true;
    } catch (error) {
      if (EXPLICIT_TEST_DB_URL) throw error;
      console.warn(`[serial-context.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!repository) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("detects consecutive same-function runs (>=3) and character state spans", async () => {
    if (!available) return;
    const serial = await repository.getSerialContextSnapshot(projectId, "serial-doc-12", 12, 6);
    expect(serial).toBeDefined();
    expect(serial!.window).toBe(6);
    // 第 8-11 章 discovery 连续 4 章 → 命中连续游程
    const run = serial!.functionRuns.find((item) => item.narrativeFunction === "discovery");
    expect(run?.narrativeOrders).toEqual([8, 9, 10, 11]);
    // 陈渊在 ≥2 章有状态快照 → 进入 characterSpans
    const span = serial!.characterSpans.find((item) => item.characterId === "陈渊");
    expect(span?.states.length).toBeGreaterThanOrEqual(2);
    expect(span?.states.map((state) => state.narrativeOrder)).toContain(8);
  });

  it("detects subject spans from active memory claims", async () => {
    if (!available) return;
    // 同一 subject 在 ≥2 个章节有 active 事实 → 进入 subjectSpans（HAVING ≥2）
    for (const order of [8, 10]) {
      const claimId = `serial-claim-${randomUUID().slice(0, 8)}`;
      await repository.pool.query(
        `INSERT INTO memory_claims(id,project_id,kind,title,content,subject_refs,narrative_start,narrative_end,authority,lifecycle_status,confidence,source_revision_ids,content_hash,supersedes,knowledge_scope,created_at)
         VALUES($1,$2,'fact','金属残片相关事实','陈渊握着金属残片',ARRAY['金属残片'],$3,$3,'approved','active',1,ARRAY['r-8'],$4,ARRAY[]::text[],'"author"'::jsonb,now())`,
        [claimId, projectId, order, `serial-hash-${order}`],
      );
    }
    const serial = await repository.getSerialContextSnapshot(projectId, "serial-doc-12", 12, 6);
    const span = serial!.subjectSpans.find((item) => item.subject === "金属残片");
    expect(span).toBeDefined();
    expect(span!.narrativeOrders).toEqual([8, 10]);
    expect(span!.latestExcerpt).toContain("金属残片");
  });

  it("clusters the same review rule across multiple chapters", async () => {
    if (!available) return;
    const clusters = await repository.getRecentReviewIssueClusters(projectId, 12, 6);
    const cluster = clusters.find((item) => item.key === "cross-chapter-restatement");
    expect(cluster).toBeDefined();
    expect(cluster!.chapterCount).toBe(3);
    expect(cluster!.narrativeOrders).toEqual([7, 8, 9]);
  });
});
