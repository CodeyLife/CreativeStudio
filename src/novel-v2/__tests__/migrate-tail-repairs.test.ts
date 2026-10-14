import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ObjectStoreAdapter } from "../object-store";
import { countNovelCharacters } from "../word-count";

/**
 * migrate() 尾部启动写路径的双向回归（复核轮 F7）。
 *
 * 这些修复每次进程启动都会跑，此前**没有任何测试引用**：spec 断言它们幂等且"值相同即
 * 零变更"，而一旦某条判据写错，形态不是"启动失败"而是每次启动反复搅动运行库（改写行、
 * 翻 updated_at、灌审计/outbox），恰好是最难事后归因的那类静默损耗。因此每条都测两向：
 * 真修一次、重放零变更，外加"不该被动的行不动"。
 */
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("migrate 尾启动修复路径", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const suffix = randomUUID().slice(0, 8);
  const projectIds: string[] = [];

  async function newProject(title: string): Promise<string> {
    const projectId = `tail-repair-${title}-${suffix}`;
    await repository.ensureProject(projectId, title);
    projectIds.push(projectId);
    return projectId;
  }

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[migrate-tail-repairs] Postgres 不可用：${(error as Error).message}`);
    }
    // 60s：本套件的 beforeAll 跑整条 `migrate()`（92 个迁移文件 + 启动修复尾），而共享测试库
    // `ymcp_test` 随并行会话单调增长，vitest 默认 5s 与相邻套件的 30s 都不够用。越过该上限的
    // 正确处置是查 migrate 里新加的启动写路径，而不是继续加时。
  }, 60_000);

  afterAll(async () => {
    if (!available) return;
    for (const projectId of projectIds) await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("books.title 滞留值被收口为项目标题投影，重放零变更", async () => {
    if (!available) return;
    const projectId = await newProject("书名投影");
    const bookId = `book-${projectId}`;
    await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title", [bookId, projectId, "旧书名"]);
    await repository.pool.query("UPDATE novel_projects SET title=$2 WHERE id=$1", [projectId, "新书名"]);

    expect(await repository.repairBookTitleProjections()).toBeGreaterThanOrEqual(1);
    expect((await repository.pool.query<{ title: string }>("SELECT title FROM books WHERE id=$1", [bookId])).rows[0].title).toBe("新书名");
    // 重放：本项目已一致，不再被 UPDATE 命中（每启动零变更）。books 没有 updated_at 列，
    // 用 xmin 行版本证明"这行没被再写过"——比时间戳更强：同值改写也会抬 xmin。
    const versionOf = async () => (await repository.pool.query<{ v: string }>("SELECT xmin::text::bigint AS v FROM books WHERE id=$1", [bookId])).rows[0].v;
    const before = await versionOf();
    await repository.repairBookTitleProjections();
    expect(await versionOf()).toBe(before);
  });

  it("缺字数的 blob 由对象正文回填；正文不可得只计失败且不写脏值", async () => {
    if (!available) return;
    await newProject("字数回填");
    const goodHash = `tail-text-${suffix}`;
    const brokenHash = `tail-broken-${suffix}`;
    const text = "他推开门，屋里没有人。";
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1),($3,$4,1)", [goodHash, `tail/${goodHash}`, brokenHash, `tail/${brokenHash}`]);
    const objects = {
      getText: async (key: string) => {
        if (key.endsWith(brokenHash)) throw new Error("对象不可读");
        return text;
      },
    } as unknown as ObjectStoreAdapter;

    const first = await repository.backfillMissingContentWordCounts(objects);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    /**
     * 按 `content_hash` 取值，**不按位置**：`= ANY(...)` 不保证返回顺序，`rows[0]` 可能
     * 拿到 broken 那行（`word_count` 为 NULL ⇒ `Number(null)` = 0），于是断言报
     * "expected 0 to be 9"——一个与实现无关、只与执行计划有关的假红。全量首跑即撞上。
     */
    const rows = await repository.pool.query<{ content_hash: string; word_count: string | null }>(
      "SELECT content_hash, word_count FROM content_blobs WHERE content_hash = ANY($1::text[])",
      [[goodHash, brokenHash]],
    );
    const wordCountByHash = new Map(rows.rows.map((row) => [row.content_hash, row.word_count]));
    // pg 把 bigint 以字符串返回，判据前先归一（不依赖驱动配置）。
    expect(Number(wordCountByHash.get(goodHash))).toBe(countNovelCharacters(text));
    expect(wordCountByHash.get(brokenHash)).toBeNull();

    // 重放：已回填的行不再进入选择集（该查询是全库扫描，故只断言自己这行没被再动，
    // 不断言全局 updated/failed 计数——别的套件的数据也在同一库里）。判据用 xmin 而不是
    // 再读一次字数：同值重写读起来一模一样，只有行版本能证明"根本没再碰过"（与 books 那条同一判据）。
    const blobVersionOf = async () => (await repository.pool.query<{ v: string }>("SELECT xmin::text::bigint AS v FROM content_blobs WHERE content_hash=$1", [goodHash])).rows[0].v;
    const versionAfterFirst = await blobVersionOf();
    await repository.backfillMissingContentWordCounts(objects);
    expect(await blobVersionOf()).toBe(versionAfterFirst);
  });

  it("定稿文档下的章行收口为 final，重复启动不再改写", async () => {
    if (!available) return;
    const projectId = await newProject("章态收口");
    const documentId = `tail-doc-${suffix}`;
    const revisionId = `tail-rev-${suffix}`;
    const contentHash = `tail-content-${suffix}`;
    const bookId = `book-${projectId}`;
    const volumeId = `volume-${bookId}`;
    await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [bookId, projectId, "书名"]);
    await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,'正文',1) ON CONFLICT DO NOTHING", [volumeId, bookId]);
    await repository.pool.query("INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload) VALUES($1,$2,$3,'弧',1,'approved','active',$4::jsonb)", [`arc-${projectId}`, volumeId, projectId, JSON.stringify({ title: "弧", objective: "x" })]);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第一章',1,'final')", [documentId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `tail/${contentHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, contentHash]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
    await repository.pool.query("INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload) VALUES($1,$2,$3,$4,'第一章',1,'draft',$5::jsonb)", [`chapter-${projectId}`, `arc-${projectId}`, projectId, documentId, JSON.stringify({ index: 1, title: "第一章", scenes: [] })]);

    await repository.migrate();
    const after = await repository.pool.query<{ status: string; updated_at: string }>("SELECT status, updated_at::text AS updated_at FROM chapters WHERE id=$1", [`chapter-${projectId}`]);
    expect(after.rows[0].status).toBe("final");

    // 重放：判据要求 c.status<>'final'，已收口的行不得再被改写（每启动翻 updated_at 即静默损耗）。
    await repository.migrate();
    const again = await repository.pool.query<{ updated_at: string }>("SELECT updated_at::text AS updated_at FROM chapters WHERE id=$1", [`chapter-${projectId}`]);
    expect(again.rows[0].updated_at).toBe(after.rows[0].updated_at);
  });

  it("只有 foundation 产物的项目由启动修复补出段级单例声明，重放不新增行", async () => {
    if (!available) return;
    const projectId = await newProject("单例回填");
    const artifactId = `tail-foundation-${suffix}`;
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload,created_at)
       VALUES($1,$2,$1,$1,'foundation',$4,0,$4,$3,now())`,
      [artifactId, projectId, { taskKey: "worldview", title: "世界规则", summary: "启动修复应投影出的规则" }, `hash-${artifactId}`],
    );
    await repository.repairFoundationClaimSingletons();
    const claimId = `foundation:${projectId}:worldview`;
    const rows = await repository.pool.query<{ content: string }>("SELECT content FROM memory_claims WHERE project_id=$1 AND id=$2", [projectId, claimId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].content).toContain("启动修复应投影出的规则");

    await repository.repairFoundationClaimSingletons();
    const count = await repository.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM memory_claims WHERE project_id=$1", [projectId]);
    expect(count.rows[0].n).toBe(1);
  });

  it("当前修订无快照时回填真修一次，重放不再改写行（xmin 作证）", async () => {
    if (!available) return;
    // 三向的第二向：上一条只证"已在场不重复物化"，那等于只测了选择判据的反面。若回填
    // 永远修不好任何东西，同一批测试依然全绿——而启动回填的实际职责就是给历史项目补账。
    const projectId = await newProject("快照真修");
    const documentId = `fix-doc-${suffix}`;
    const revisionId = `fix-rev-${suffix}`;
    const contentHash = `fix-content-${suffix}`;
    const artifactId = `fix-artifact-${suffix}`;
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${artifactId}:draft`, attemptId: `${artifactId}:attempt`, kind: "draft", contentHash, baseRevision: 0, fingerprint: `fp-${artifactId}`, createdAt: Date.now() });
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第一章',1,'final')", [documentId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `tail/${contentHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,artifact_id) VALUES($1,$2,$3,1,0,$4,$5)", [revisionId, projectId, documentId, contentHash, artifactId]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
    // 完整三审（narrative 全量期望集）——快照的完整性判据与实际评审面同源，缺一份就不该物化。
    for (const [role, identity] of [["structure-reviewer", "internal"], ["character-reviewer", "independent"], ["prose-reviewer", "independent"]] as const) {
      await repository.pool.query(
        "INSERT INTO reviews(id,project_id,artifact_id,reviewer_id,identity,verdict,issues,score,role,dimension_scores,artifact_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,'passed','[]'::jsonb,4.0,$6,'{}'::jsonb,$7,now())",
        [`rev-${role}-${suffix}`, projectId, artifactId, `reviewer-${role}`, identity, role, `fp-${artifactId}`],
      );
    }

    await repository.backfillCurrentChapterReviewSnapshots();
    const created = await repository.pool.query<{ n: number; complete: boolean; revision_id: string }>(
      "SELECT count(*)::int AS n, bool_and(complete) AS complete, min(revision_id) AS revision_id FROM chapter_review_snapshots WHERE document_id=$1",
      [documentId],
    );
    expect(created.rows[0]).toMatchObject({ n: 1, complete: true, revision_id: revisionId });
    const roles = await repository.pool.query<{ r: string }>(
      "SELECT DISTINCT unnest(reviewer_roles) AS r FROM chapter_review_snapshots WHERE document_id=$1",
      [documentId],
    );
    expect(roles.rows.map((row) => row.r)).toEqual(expect.arrayContaining(["structure-reviewer", "character-reviewer", "prose-reviewer"]));

    // 重放：选择判据（当前修订且无匹配 hash 的快照）此刻已不成立，行必须根本没被再碰过——
    // 只重读值会放过"同值重写"（抬 xmin、翻 updated_at、给审计流灌噪声）。
    const versionOf = async () => (await repository.pool.query<{ v: string }>("SELECT xmin::text::bigint AS v FROM chapter_review_snapshots WHERE document_id=$1", [documentId])).rows[0].v;
    const afterFirst = await versionOf();
    await repository.backfillCurrentChapterReviewSnapshots();
    expect(await versionOf()).toBe(afterFirst);
  });

  it("当前修订已有快照时启动回填不再改写它", async () => {
    if (!available) return;
    const projectId = await newProject("快照回填");
    const documentId = `snap-doc-${suffix}`;
    const revisionId = `snap-rev-${suffix}`;
    const contentHash = `snap-content-${suffix}`;
    const artifactId = `snap-artifact-${suffix}`;
    await repository.recordArtifact({ id: artifactId, projectId, taskId: `${artifactId}:draft`, attemptId: `${artifactId}:attempt`, kind: "draft", contentHash, baseRevision: 0, fingerprint: `fp-${artifactId}`, createdAt: Date.now() });
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第一章',1,'final')", [documentId, projectId]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `tail/${contentHash}`]);
    await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash,artifact_id) VALUES($1,$2,$3,1,0,$4,$5)", [revisionId, projectId, documentId, contentHash, artifactId]);
    await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
    await repository.pool.query(
      `INSERT INTO chapter_review_snapshots(id,document_id,project_id,revision_id,reviewed_content_hash,artifact_fingerprint,verdict,complete,overall_score,reviewer_roles,reviewed_at)
       VALUES($1,$2,$3,$4,$5,$6,'passed',TRUE,4.2,ARRAY['prose']::text[],now())`,
      [`snap-${suffix}`, documentId, projectId, revisionId, contentHash, `fp-${artifactId}`],
    );

    await repository.backfillCurrentChapterReviewSnapshots();
    // 只断自己这份快照没被再写（回填是全库扫描，返回计数不可用于单项目断言）：
    // 选择判据要求"当前修订且 reviewed_content_hash 无匹配快照"，已在场即不得重复物化。
    const snapshots = await repository.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM chapter_review_snapshots WHERE document_id=$1", [documentId]);
    expect(snapshots.rows[0].n).toBe(1);
  });
});
