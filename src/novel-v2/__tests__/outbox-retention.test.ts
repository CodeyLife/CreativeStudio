import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository, OUTBOX_RETENTION_DAYS } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 域事件账本（`outbox_events`）的账面粉层（迁移 094）+ 保留策略。
 *
 * 三条判据各自挡一种失效：
 * 1. 面本身：`published_at` 与那个谓词恒真的重复索引确实消失，真实读需要的复合索引确实建立
 *    （直接查 information_schema，而不是锁迁移文本——文本锁不住"库里没应用"）。
 * 2. 保留策略：超期的删、期内的一行都不动，且重放为 no-op。
 * 3. **保留与去重的不变式**（本文件真正要紧的一条）：停滞通报的去重靠"该候选 updated_at 之后
 *    有没有事件"，而事件会被清；所以扫描窗口必须有 = 保留期的上界。不配上界时清完旧事件的
 *    第二天，同一个候选会被再通报一次——反向对照即"删掉那条上界"，本文件第三条判红。
 */
describe("域事件账本的面与保留策略（迁移 094）", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `outbox-retention-${randomUUID().slice(0, 8)}`;
  const staleCandidateId = `candidate-old-${randomUUID().slice(0, 8)}`;
  const inWindowCandidateId = `candidate-in-window-${randomUUID().slice(0, 8)}`;

  async function seedEvent(aggregateId: string, eventType: string, createdAtMs: number) {
    await repository.pool.query(
      "INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,project_id,created_at) VALUES('craft-rule-candidate',$1,$2,$3,$4,to_timestamp($5 / 1000.0))",
      [aggregateId, eventType, { candidateId: aggregateId }, projectId, createdAtMs],
    );
  }

  async function seedCandidate(id: string, updatedAtMs: number) {
    await repository.pool.query(
      `INSERT INTO craft_rule_candidates(id,project_id,target_kind,target_id,before_version,proposed_version,before_text,after_text,rationale,scope,status,evidence_cases,reviews,created_at,updated_at)
       VALUES($1,$2,'skill','target-1','1.0.0','1.0.1','前','后','保留策略用例','{}'::jsonb,'proposed','[]'::jsonb,'[]'::jsonb,to_timestamp($3 / 1000.0),to_timestamp($3 / 1000.0))`,
      [id, projectId, updatedAtMs],
    );
  }

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Outbox Retention Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[outbox-retention.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("publisher 遗留面已撤，真实读用的复合索引在场", async () => {
    if (!available) return;
    const columns = await repository.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='outbox_events' AND column_name='published_at'",
    );
    expect(columns.rows, "0/21,807 行非空且全仓零引用的投递标记列").toEqual([]);
    const indexes = await repository.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='outbox_events'",
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).not.toContain("outbox_unpublished");
    expect(names).toContain("outbox_events_aggregate_idx");
    expect(names).toContain("outbox_events_pkey");
  });

  it("按保留期分批清理：超期删、期内不动、重放 no-op", async () => {
    if (!available) return;
    const now = Date.now();
    const expiredId = `expired-${randomUUID().slice(0, 8)}`;
    const freshId = `fresh-${randomUUID().slice(0, 8)}`;
    await seedEvent(expiredId, "craft-rule.candidate-stale", now - (OUTBOX_RETENTION_DAYS + 30) * DAY_MS);
    await seedEvent(freshId, "craft-rule.candidate-stale", now - Math.floor(OUTBOX_RETENTION_DAYS / 2) * DAY_MS);
    const exists = async (id: string) => (await repository.pool.query("SELECT 1 FROM outbox_events WHERE aggregate_id=$1", [id])).rowCount ?? 0;

    const removed = await repository.pruneOutboxEvents(now);
    expect(removed, "至少清掉本轮种的超期行").toBeGreaterThanOrEqual(1);
    expect(await exists(expiredId)).toBe(0);
    expect(await exists(freshId), "期内一行都不能动").toBe(1);
    expect(await repository.pruneOutboxEvents(now), "重放必须零删除").toBe(0);
  });

  it("扫描窗上界与保留期同源：旧事件被清后不会把同一候选再通报一次", async () => {
    if (!available) return;
    const now = Date.now();
    // 期内候选：updated_at 在 (staleAfterDays, OUTBOX_RETENTION_DAYS) 之间，且已有一条通报事件
    await seedCandidate(inWindowCandidateId, now - 40 * DAY_MS);
    await seedEvent(inWindowCandidateId, "craft-rule.candidate-stale", now - 39 * DAY_MS);
    // 超期候选：同样已通报过，但候选与事件都早于保留线
    await seedCandidate(staleCandidateId, now - (OUTBOX_RETENTION_DAYS + 60) * DAY_MS);
    await seedEvent(staleCandidateId, "craft-rule.candidate-stale", now - (OUTBOX_RETENTION_DAYS + 59) * DAY_MS);

    await repository.pruneOutboxEvents(now);

    const detected = await repository.detectStaleCraftRuleCandidates(projectId, { nowMs: now, staleAfterDays: 30 });
    expect(detected, "期内候选已有事件 ⇒ 去重生效，不得重复通报").not.toContain(inWindowCandidateId);
    expect(detected, "超期候选已出扫描窗（其事件也已被清，再判会复活成重复通报）").not.toContain(staleCandidateId);
    // 判据本身要能命中：把期内候选的旧事件抹掉后必须重新通报，否则上面两条断言是空转判绿。
    await repository.pool.query("DELETE FROM outbox_events WHERE aggregate_id=$1", [inWindowCandidateId]);
    expect(await repository.detectStaleCraftRuleCandidates(projectId, { nowMs: now, staleAfterDays: 30 })).toContain(inWindowCandidateId);
  });

  it("源面锁：保留常数只有一处定义，且清理与扫描窗都引它", () => {
    const source = readFileSync("src/novel-v2/postgres-repository.ts", "utf8");
    expect([...source.matchAll(/export const OUTBOX_RETENTION_DAYS = /g)].length).toBe(1);
    // 关系而非绝对值：保留期必须长于停滞阈值，否则"可被判停滞"与"事件已被清"两个窗口重叠，
    // 通报会在清理后的第二天复活。
    const staleDefault = Number(/staleAfterDays = input\.staleAfterDays \?\? (\d+)/.exec(source)?.[1]);
    expect(Number.isFinite(staleDefault) && staleDefault > 0).toBe(true);
    expect(OUTBOX_RETENTION_DAYS, "保留期必须长于停滞阈值").toBeGreaterThan(staleDefault);
    const prune = source.slice(source.indexOf("async pruneOutboxEvents("), source.indexOf("async putReview("));
    const scan = source.slice(source.indexOf("async detectStaleCraftRuleCandidates("), source.indexOf("async requestLearningPromotion("));
    expect(prune).toContain("OUTBOX_RETENTION_DAYS");
    expect(scan).toContain("OUTBOX_RETENTION_DAYS");
    // 停滞扫描必须走绑定参数而不是第二个字面量天数，否则两处的数会各自漂移。
    expect(scan).toContain("AND c.updated_at >= to_timestamp($2 / 1000.0) - make_interval(days => $4::int)");
    // 已撤的投递标记面不得在代码里复活。
    expect(source).not.toMatch(/published_at\s*(=|IS)/);
    expect(source).not.toContain("outbox_unpublished");
  });
});
