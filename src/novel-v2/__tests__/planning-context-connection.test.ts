import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/**
 * 收口 F3′ 行末尾那条"已登记未修"：`getChapterPlanningContext` 的读与写都必须在调用方给的
 * 那条连接上。三条判据各挡一种失效形态：
 *
 * 1. 读侧：持事务的调用方（`applyCommittedChapterStateRebuild` → 账本投影）此前经独立连接读，
 *    看到的是事务开始前的规划输入；线程化后才看见本事务未提交的章/弧状态。
 * 2. 写侧：方法内三处 `planning_status='stale'` 若走另一条连接，而调用方事务已锁住该弧行，
 *    UPDATE 会等自己会话持有的锁 ⇒ 自死锁。**反向对照**：把 `markArcStale` 改回 `this.pool`
 *    后本文件第二条用例会挂到超时判红（不是断言失败），这正是要它落在同一条连接的理由。
 *    代价：调用方回滚则标记一起消失——它由重算派生，下一次读会再标，不需持久化。
 * 3. 源面：方法体内不得再出现第二处 `this.pool`，账本调用点必须显式传 connection。
 */
describe("规划上下文的连接线程化", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `planning-conn-${randomUUID().slice(0, 8)}`;
  const arcId = `arc-${projectId}`;
  const documentId = `doc-${projectId}`;
  const chapterId = `chapter-${projectId}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Planning Context Connection Test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "测试书"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,'正文',1)", [`volume-${projectId}`, `book-${projectId}`]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'测试弧',1,'approved','active',$4)`,
        [arcId, `volume-${projectId}`, projectId, { title: "测试弧", objective: "线程化用例" }],
      );
      await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,'第一章',1,'planned')", [documentId, projectId]);
      await repository.pool.query(
        `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload,batch_index)
         VALUES($1,$2,$3,$4,'原章标题',1,'planned','{"index":1}'::jsonb,1)`,
        [chapterId, arcId, projectId, documentId],
      );
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[planning-context-connection.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 60_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("持事务调用读到本事务未提交的规划输入，默认面读不到（证明差异来自线程化）", async () => {
    if (!available) return;
    const client = await repository.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE chapters SET title=$1 WHERE id=$2", ["事务内改过的标题", chapterId]);
      const inside = await repository.getChapterPlanningContext(projectId, documentId, true, client);
      const outside = await repository.getChapterPlanningContext(projectId, documentId, true);
      expect(inside.chapter.title).toBe("事务内改过的标题");
      expect(outside.chapter.title).toBe("原章标题");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("stale 标记与调用方同面：事务内可见、随回滚消失、默认面持久", async () => {
    if (!available) return;
    // 指纹故意不一致 ⇒ 进 stale 分支（该分支不需审核证据，故夹具最小）
    await repository.pool.query("UPDATE arcs SET planning_status='approved',execution_status='planned',context_fingerprint='bogus',review_artifact_id=NULL,review_fingerprint=NULL WHERE id=$1", [arcId]);
    const statusOn = async (query: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ planning_status: string }> }> }) =>
      (await query.query("SELECT planning_status FROM arcs WHERE id=$1", [arcId])).rows[0].planning_status;

    const client = await repository.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM arcs WHERE id=$1 FOR UPDATE", [arcId]); // 调用方持住弧行锁
      await expect(repository.getChapterPlanningContext(projectId, documentId, false, client)).rejects.toThrow(/不一致/);
      expect(await statusOn(client), "标记必须落在调用方连接上").toBe("stale");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await statusOn(repository.pool), "调用方回滚 ⇒ 派生标记一起消失").toBe("approved");

    await expect(repository.getChapterPlanningContext(projectId, documentId, false)).rejects.toThrow(/不一致/);
    expect(await statusOn(repository.pool), "默认面无事务可依，标记照旧持久").toBe("stale");
  });

  it("源面锁：方法体内只允许默认面那一处 this.pool，账本调用点必须传 connection", () => {
    const source = readFileSync("src/novel-v2/postgres-repository.ts", "utf8");
    const start = source.indexOf("async getChapterPlanningContext(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n  async getNarrativeRhythmSnapshot", start));
    expect(body.length).toBeGreaterThan(100);
    // 一次：签名里的 `= this.pool` 默认面。第二次出现即说明某条读写绕过调用方连接。
    expect([...body.matchAll(/this\.pool/g)].length).toBe(1);
    // 同一 PoolClient 上不得并发 query（pg 已废弃）：宏观规划与相邻章必须依次取。
    expect(body).not.toMatch(/Promise\.all\(\[\s*this\.listCurrentFoundationArtifacts/);
    expect(source).toContain("this.getChapterPlanningContext(input.projectId, input.documentId, true, connection)");
  });
});
