import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("chapter status projection", () => {
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  const projectId = `test-chapter-status-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Chapter status projection test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,$4,1,'approved','active',$5::jsonb)`,
        [`arc-${projectId}`, `volume-${projectId}`, projectId, "Test arc", JSON.stringify({ title: "Test arc" })],
      );
      available = true;
    } catch (error) {
      console.warn(`[chapter-status-projection.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available) await repository?.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("derives a final chapter status from its linked final manuscript", async () => {
    if (!available || !repository) return;

    const documentId = `document-${projectId}`;
    const chapterId = `chapter-${projectId}`;
    await repository.pool.query(
      `INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status,current_revision_id)
       VALUES($1,$2,$3,1,'final',$4)`,
      [documentId, projectId, "Committed chapter", `revision-${projectId}`],
    );
    await repository.pool.query(
      `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload)
       VALUES($1,$2,$3,$4,$5,1,'planned',$6::jsonb)`,
      [chapterId, `arc-${projectId}`, projectId, documentId, "Committed chapter", JSON.stringify({ index: 1, title: "Committed chapter", scenes: [] })],
    );

    const arc = await repository.getStoryArc(projectId, `arc-${projectId}`);
    expect(arc?.chapters[0]).toMatchObject({ id: chapterId, status: "final", documentId });
    await expect(repository.assertChapterGenerationAllowed(projectId, documentId)).rejects.toThrow("章节已定稿");
  });

  it("backfills the blueprint status in the same transaction as a manual final save", async () => {
    if (!available || !repository) return;

    const documentId = `manual-document-${projectId}`;
    const chapterId = `manual-chapter-${projectId}`;
    await repository.pool.query(
      `INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status)
       VALUES($1,$2,$3,2,'planned')`,
      [documentId, projectId, "Manual chapter"],
    );
    await repository.pool.query(
      `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload)
       VALUES($1,$2,$3,$4,$5,2,'planned',$6::jsonb)`,
      [chapterId, `arc-${projectId}`, projectId, documentId, "Manual chapter", JSON.stringify({ index: 2, title: "Manual chapter", scenes: [] })],
    );

    await expect(repository.assertChapterGenerationAllowed(projectId, documentId)).resolves.toBeUndefined();

    await repository.saveManualRevision({
      projectId,
      documentId,
      expectedContentHash: "",
      text: "手工定稿正文",
      contentHash: `content-${projectId}`,
      objectKey: `test/${projectId}/manual`,
    });

    const status = await repository.pool.query<{ status: string }>("SELECT status FROM chapters WHERE id=$1", [chapterId]);
    expect(status.rows[0]?.status).toBe("final");
    await expect(repository.assertChapterGenerationAllowed(projectId, documentId)).rejects.toThrow("章节已定稿");
  });

  it("does not complete an arc while a blueprint chapter is unlinked", async () => {
    if (!available || !repository) return;

    const arcId = `unlinked-arc-${projectId}`;
    await repository.pool.query(
      `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
       VALUES($1,$2,$3,$4,2,'approved','active',$5::jsonb)`,
      [arcId, `volume-${projectId}`, projectId, "Unlinked arc", JSON.stringify({ title: "Unlinked arc", expectedChapterCount: 1 })],
    );
    const batchId = `batch-${arcId}`;
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,payload)
       VALUES($1,$2,$3,1,3,3,'approved','test-fingerprint',$4::jsonb)`,
      [batchId, arcId, projectId, JSON.stringify({ complete: true })],
    );
    await repository.pool.query(
      `INSERT INTO chapters(id,arc_id,project_id,title,ordinal,status,payload,batch_id)
       VALUES($1,$2,$3,$4,3,'planned',$5::jsonb,$6)`,
      [`unlinked-chapter-${projectId}`, arcId, projectId, "Unlinked chapter", JSON.stringify({ index: 3, title: "Unlinked chapter", scenes: [] }), batchId],
    );

    await repository.migrate();

    const status = await repository.pool.query<{ execution_status: string }>("SELECT execution_status FROM arcs WHERE id=$1", [arcId]);
    expect(status.rows[0]?.execution_status).toBe("active");
  });

  it("uses the latest approved batch when a later generation attempt failed", async () => {
    if (!available || !repository) return;

    const arcId = `failed-later-arc-${projectId}`;
    const documentId = `failed-later-document-${projectId}`;
    const chapterId = `failed-later-chapter-${projectId}`;
    await repository.pool.query(
      `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
       VALUES($1,$2,$3,$4,3,'approved','active',$5::jsonb)`,
      [arcId, `volume-${projectId}`, projectId, "Failed later arc", JSON.stringify({ title: "Failed later arc", expectedChapterCount: 1 })],
    );
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,entry_fingerprint,payload)
       VALUES($1,$2,$3,1,1,1,'approved','approved-fingerprint',$4::jsonb),
             ($5,$2,$3,2,1,1,'failed','failed-fingerprint',$6::jsonb)`,
      [`approved-batch-${arcId}`, arcId, projectId, JSON.stringify({ complete: false }), `failed-batch-${arcId}`, JSON.stringify({ complete: false })],
    );
    await repository.pool.query(
      `INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status,current_revision_id)
       VALUES($1,$2,$3,1,'final',$4)`,
      [documentId, projectId, "Completed chapter", `revision-${chapterId}`],
    );
    await repository.pool.query(
      `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload)
       VALUES($1,$2,$3,$4,$5,1,'planned',$6::jsonb)`,
      [chapterId, arcId, projectId, documentId, "Completed chapter", JSON.stringify({ index: 1, title: "Completed chapter", scenes: [] })],
    );

    await repository.migrate();

    const status = await repository.pool.query<{ execution_status: string }>("SELECT execution_status FROM arcs WHERE id=$1", [arcId]);
    expect(status.rows[0]?.execution_status).toBe("completed");
  });
});
