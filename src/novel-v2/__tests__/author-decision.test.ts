import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("document authorDecision projection", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-author-decision-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Author Decision Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[author-decision.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("surfaces the latest author decision aligned to current content hash in project detail", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    const workflowId = `workflow-${randomUUID()}`;
    // 两代内容：旧哈希对应作者 revise 决定，新哈希对应最新 approve（应胜出）。
    const oldHash = `hash-old-${randomUUID()}`;
    const currentHash = `hash-current-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,1)", [documentId, projectId, "作者决定测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [oldHash, `test/${oldHash}`]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [currentHash, `test/${currentHash}`]);
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)",
      [`rev-old-${randomUUID()}`, projectId, documentId, oldHash],
    );
    const currentRevisionId = `rev-current-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,2,1,$4)",
      [currentRevisionId, projectId, documentId, currentHash],
    );
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$2 WHERE id=$1", [documentId, currentRevisionId]);
    // 审校快照：reviewer 聚合判 revise（作者批准后保留原判是合法并存状态）。
    await repository.pool.query(
      `INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,source_workflow_id,verdict,complete,overall_score,dimension_scores,reviewer_roles,reviewed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'revise',TRUE,4.1,'{}'::jsonb,ARRAY[]::text[],now())`,
      [`snapshot-${randomUUID()}`, documentId, projectId, currentRevisionId, currentHash, `fp-${randomUUID()}`, workflowId],
    );
    const artifactFor = async (hash: string) => {
      const artifactId = `artifact-${randomUUID()}`;
      await repository.pool.query(
        "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,'revision',$5,$6,0,$7,'{}'::jsonb)",
        [artifactId, projectId, `task-${randomUUID()}`, `attempt-${randomUUID()}`, hash, `test/${hash}`, hash],
      );
      return artifactId;
    };
    // 历史决定：旧内容上的 revise（不应影响当前内容投影）。
    await repository.pool.query(
      `INSERT INTO approval_evidence(id,project_id,workflow_id,artifact_id,decision,actor_source,actor_id,unresolved_issue_fingerprints,created_at)
       VALUES($1,$2,$3,$4,'revise','interactive-web','web-author',ARRAY[]::text[], now() - interval '1 hour')`,
      [`evidence-old-${randomUUID()}`, projectId, workflowId, await artifactFor(oldHash)],
    );
    // 当前内容最新决定：approve（应胜出）。
    await repository.pool.query(
      `INSERT INTO approval_evidence(id,project_id,workflow_id,artifact_id,decision,actor_source,actor_id,unresolved_issue_fingerprints,created_at)
       VALUES($1,$2,$3,$4,'approve','interactive-web','web-author',ARRAY[]::text[], now())`,
      [`evidence-new-${randomUUID()}`, projectId, workflowId, await artifactFor(currentHash)],
    );

    const detail = await repository.getProjectDetail(projectId);
    const doc = detail.documents.find((candidate) => candidate.id === documentId);
    expect(doc).toBeDefined();
    // reviewer verdict 保留 revise 原判……
    expect(doc?.reviewVerdict).toBe("revise");
    // ……但作者决定独立可见：当前内容哈希对齐的最新行是 approve。
    expect(doc?.authorDecision).toBe("approve");

    // 工作台详情投影同口径。
    const workspace = await repository.getChapterWorkspace(projectId, documentId);
    expect(workspace?.review?.verdict).toBe("revise");
    expect(workspace?.review?.authorDecision).toBe("approve");
  });

  it("leaves authorDecision undefined when the author has not decided on current content", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    const currentHash = `hash-solo-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,2)", [documentId, projectId, "无作者决定章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [currentHash, `test/${currentHash}`]);
    const revisionId = `rev-solo-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)",
      [revisionId, projectId, documentId, currentHash],
    );
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$2 WHERE id=$1", [documentId, revisionId]);

    const detail = await repository.getProjectDetail(projectId);
    const doc = detail.documents.find((candidate) => candidate.id === documentId);
    expect(doc).toBeDefined();
    expect(doc?.authorDecision).toBeUndefined();
  });
});
