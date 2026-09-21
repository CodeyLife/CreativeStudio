import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository } from "../postgres-repository";
import { promptExecutionRetentionDays } from "../repository/telemetry-slice";
import { detectMemoryIndexDrift } from "../memory-index-drift";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/**
 * 执行留痕的保留清理（载荷到期、收据留存）与记忆索引漂移判据。
 *
 * 立用例的根因：`prompt_executions` 的 89 MB 里几乎全是内联 `context_manifest`（实测
 * 184 MB 未压缩 / 9,243 行全部带 30 天到期时间 / 4,861 行已过期），而清理只置 NULL
 * 两个对象存储键，从未收走过这份内联副本——即"到期"这件事在体积维度上从未发生。
 * 刻意保留行：迁移 028 把键改成可空就是"载荷到期、收据留存"的设计，删行会连带收走
 * `listPromptExecutions` 与按 fingerprint 关联 manifest 的报表都在读的审计收据。
 */
describe("prompt_executions 保留清理（载荷到期、收据留存）", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-retention-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Prompt Retention Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[prompt-execution-retention.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.pool.query("DELETE FROM prompt_executions WHERE project_id=$1", [projectId]).catch(() => undefined);
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  type Row = { id: string; purpose: string; candidate_index: number; status: string; prompt_fingerprint: string; prompt_object_key: string | null; response_object_key: string | null; context_manifest: unknown; expires_at: Date };
  async function seed(input: { id: string; promptKey: string | null; responseKey: string | null; manifest: Record<string, unknown> | null; expiresAt: Date }): Promise<void> {
    await repository.pool.query(
      `INSERT INTO prompt_executions(id,workflow_run_id,purpose,candidate_index,status,prompt_fingerprint,prompt_object_key,response_object_key,context_manifest,expires_at,project_id)
       VALUES($1,$2,'writing.draft',0,'completed',$3,$4,$5,$6,$7,$8)`,
      [input.id, `run-${input.id}`, `fp-${input.id}`, input.promptKey, input.responseKey, input.manifest, input.expiresAt, projectId],
    );
  }
  async function read(id: string): Promise<Row | undefined> {
    const result = await repository.pool.query<Row>("SELECT * FROM prompt_executions WHERE id=$1", [id]);
    return result.rows[0];
  }

  it("到期行清空三样载荷但保留行；未到期行不动；重放 no-op", async () => {
    if (!available) return;
    const now = Date.now();
    // 共享测试库：别人的到期行也算数，所以"本次收走几行"要相对播种前的基线断言；
    // 基线 + 2 而不是 + 3，正是下面 pe-c（已到期但本来没载荷）不被计入的判别力。
    const pendingBefore = await repository.pool.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM prompt_executions
      WHERE expires_at<=now() AND (prompt_object_key IS NOT NULL OR response_object_key IS NOT NULL OR context_manifest IS NOT NULL)
    `);
    const expired = new Date(now - 60_000);
    const live = new Date(now + 29 * 86_400_000);
    const uniqueKey = `objects/expired-only-${randomUUID()}`;
    const sharedKey = `objects/shared-${randomUUID()}`;
    const expiredWithKeys = `pe-a-${randomUUID().slice(0, 8)}`;
    const expiredSharedKey = `pe-b-${randomUUID().slice(0, 8)}`;
    const expiredNoPayload = `pe-c-${randomUUID().slice(0, 8)}`;
    const liveRow = `pe-d-${randomUUID().slice(0, 8)}`;
    await seed({ id: expiredWithKeys, promptKey: uniqueKey, responseKey: null, manifest: { sections: [{ id: "plan", tokens: 12 }] }, expiresAt: expired });
    await seed({ id: expiredSharedKey, promptKey: sharedKey, responseKey: null, manifest: null, expiresAt: expired });
    // 反例：已到期但本来就没有任何载荷——不该被算进"本次收走了东西"的批量里。
    await seed({ id: expiredNoPayload, promptKey: null, responseKey: null, manifest: null, expiresAt: expired });
    // 共用同一个 content-addressed 键的在期行：它就是"引用集必须在置 NULL 之前取"的理由。
    await seed({ id: liveRow, promptKey: null, responseKey: sharedKey, manifest: { sections: [] }, expiresAt: live });

    const cleared = await repository.cleanupExpiredPromptExecutions(now);
    expect(cleared.cleared, "两条有载荷的到期行被收走；本来就没有载荷的那条不算").toBe(pendingBefore.rows[0].n + 2);
    expect(cleared.orphanedObjectKeys, "只有再无引用的键才交给调用方删对象").toContain(uniqueKey);
    expect(cleared.orphanedObjectKeys, "仍被在期行共用的键不得被误报成孤儿").not.toContain(sharedKey);

    const emptied = await read(expiredWithKeys);
    expect(emptied, "收据必须留着（删行会连带收走审计面）").toBeTruthy();
    expect(emptied).toMatchObject({ prompt_object_key: null, response_object_key: null, context_manifest: null, purpose: "writing.draft" });
    expect((await read(expiredSharedKey))?.prompt_object_key).toBeNull();
    expect((await read(liveRow))?.response_object_key, "未到期行的载荷不动").toBe(sharedKey);
    expect((await read(liveRow))?.context_manifest).not.toBeNull();

    const replay = await repository.cleanupExpiredPromptExecutions(now);
    expect(replay.cleared, "重放必须 no-op").toBe(0);
    expect(replay.orphanedObjectKeys, "重放不得把已置 NULL 的键再报一次成孤儿").toEqual([]);
  });

  it("源面锁：三样载荷同批置 NULL、寿命读行自带的 expires_at、默认窗口只有一个来源", () => {
    const repo = readFileSync(new URL("../postgres-repository.ts", import.meta.url), "utf8");
    const start = repo.indexOf("async cleanupExpiredPromptExecutions");
    const body = repo.slice(start, repo.indexOf("async saveBookSynopsisIfCurrent", start))
      .split("\n").filter((line) => !/^\s*(\/\/|\*)/.test(line)).join("\n");
    expect(body).toContain("prompt_object_key=NULL,response_object_key=NULL,context_manifest=NULL");
    expect(body).toContain("expires_at<=to_timestamp($1 / 1000.0)");
    // 引用集先于置 NULL：置 NULL 的 UPDATE 之后不能再查一次"谁还引用这些键"以外的顺序反转
    expect(body.indexOf("SET prompt_object_key=NULL")).toBeLessThan(body.indexOf("FROM prompt_executions WHERE prompt_object_key=ANY"));
    // 刻意不删行：这条清理里不许出现 DELETE FROM prompt_executions
    expect(body).not.toMatch(/DELETE FROM prompt_executions/);

    const slice = readFileSync(new URL("../repository/telemetry-slice.ts", import.meta.url), "utf8");
    expect([...slice.matchAll(/export const promptExecutionRetentionDays/gu)].length, "保留天数只许一处定义").toBe(1);
    expect([...slice.matchAll(/promptExecutionRetentionDays\(\)/gu)].length, "写入侧与报表默认窗口都引它").toBeGreaterThanOrEqual(2);
    expect(promptExecutionRetentionDays(), "缺省仍是既有的 30 天约定（改这个值等于改数据寿命）").toBe(30);
  });
});

/** 记忆索引漂移判据（doctor 的 memory-index-drift 用同一份代码）。 */
describe("memory index drift 判据", () => {
  const baseline = [
    { projectId: "p-dirty", claims: 90, chapterMemories: 10 },
    { projectId: "p-under", claims: 50, chapterMemories: 5 },
    { projectId: "p-even", claims: 7, chapterMemories: 3 },
    { projectId: "p-unknown", claims: 4, chapterMemories: 0 },
  ];

  it("只把「点数多于应有行数」判成脏索引，欠灌与点数不可得都不判", () => {
    const { rows, dirty } = detectMemoryIndexDrift(baseline, new Map([
      ["p-dirty", 141], ["p-under", 12], ["p-even", 10], ["p-unknown", null],
    ]));
    expect(dirty).toEqual([{ projectId: "p-dirty", expected: 100, indexed: 141, extra: 41 }]);
    expect(rows.find((row) => row.projectId === "p-under")?.extra, "欠灌只报数：写入与索引之间有正常异步窗口").toBeNull();
    expect(rows.find((row) => row.projectId === "p-even")?.extra).toBeNull();
    expect(rows.find((row) => row.projectId === "p-unknown"), "拿不到点数两向都不判").toMatchObject({ indexed: null, extra: null });
  });

  it("应有行数 = 可见声明 + 章记忆（与重建路径同一组成）", () => {
    const { rows } = detectMemoryIndexDrift(baseline, new Map([["p-dirty", 0]]));
    expect(rows.map((row) => row.expected)).toEqual([100, 55, 10, 4]);
  });

  it("仓储侧只有一份可见性谓词：全库计数就是按项目计数的和", async () => {
    const repo = readFileSync(new URL("../postgres-repository.ts", import.meta.url), "utf8");
    const globalCount = repo.slice(repo.indexOf("async countIndexableMemoryClaims"), repo.indexOf("async countIndexableMemoryRows"));
    expect(globalCount, "全库计数若自己再写一遍 SQL，就会与按项目基线各自漂移").toContain("countIndexableMemoryRows()");
    expect(globalCount.match(/\bretrievalVisibleClaimsSql\s*\(/gu) ?? [], "谓词若自己再写一遍 SQL，就会与按项目基线各自漂移").toHaveLength(0);
    const perProject = repo.slice(repo.indexOf("async countIndexableMemoryRows"), repo.indexOf("async listAllChapterMemories"));
    expect([...perProject.matchAll(/\bretrievalVisibleClaimsSql\("memory_claims"\)/gu)].length).toBe(1);
  });
});
