import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository } from "../postgres-repository";
import { promptExecutionRetentionDays } from "../repository/telemetry-slice";
import { detectMemoryIndexDrift, staleMemoryPointIds } from "../memory-index-drift";
import { qdrantPointId } from "../memory-point-id";

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

/**
 * 记忆索引漂移判据（doctor 的 memory-index-drift 用同一份代码）。
 *
 * 立用例的根因是本检查首版自己的形态缺陷：按**条数**比较。`ymcp` 首跑给出"应有 2180 /
 * 实有 2131"，按条数即报"欠灌 49、不脏"；集合级复测的真形是缺 76 条 **且** 多 27 个陈旧点，
 * 49 只是两者相减。故这里必须有一条"两向等量仍要判脏"的抵消回归——它锁的不是精度，
 * 是判据方向。
 */
describe("memory index drift 判据", () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => `${prefix}-${index}`);
  const pointSet = (projectId: string, rowIds: string[]) => new Set(rowIds.map((rowId) => qdrantPointId(projectId, rowId)));
  const baseline = [
    { projectId: "p-stale", claimIds: ids("c", 9), chapterMemoryIds: ids("m", 1) },
    { projectId: "p-cancel", claimIds: ids("c", 4), chapterMemoryIds: [] as string[] },
    { projectId: "p-under", claimIds: ids("c", 3), chapterMemoryIds: [] as string[] },
    { projectId: "p-even", claimIds: ids("c", 2), chapterMemoryIds: [] as string[] },
    { projectId: "p-unknown", claimIds: ids("c", 2), chapterMemoryIds: [] as string[] },
  ];
  // p-cancel 的真形：库里有 4 行、索引里也有 4 个点，但只有 1 行对得上——缺 3、多 3。
  const indexed = new Map<string, Set<string> | null>([
    ["p-stale", pointSet("p-stale", [...baseline[0].claimIds, ...baseline[0].chapterMemoryIds, "ghost"])],
    ["p-cancel", pointSet("p-cancel", ["c-0", "gone-1", "gone-2", "gone-3"])],
    ["p-under", pointSet("p-under", ["c-0"])],
    ["p-even", pointSet("p-even", baseline[3].claimIds)],
    ["p-unknown", null],
  ]);

  it("陈旧点判脏、欠灌只具名不判、点集不可得两向都不判", () => {
    const { rows, dirty } = detectMemoryIndexDrift(baseline, indexed);
    expect(dirty.map((row) => row.projectId), "只有『点比应有的还多』判异常").toEqual(["p-stale", "p-cancel"]);
    expect(dirty[0]).toMatchObject({ projectId: "p-stale", expected: 10, indexed: 11 });
    expect(dirty[0].extraPointIds).toEqual([qdrantPointId("p-stale", "ghost")]);
    const under = rows.find((row) => row.projectId === "p-under");
    expect(under, "欠灌是『读不到』，与陈旧点的『读到假的』不同级").toMatchObject({ extraPointIds: [] });
    expect(under?.missingRowIds.sort(), "欠灌要具名给出，供定向补灌").toEqual(["c-1", "c-2"]);
    expect(rows.find((row) => row.projectId === "p-unknown"), "拿不到点集两向都不判").toMatchObject({ indexed: null, missingRowIds: [], extraPointIds: [] });
  });

  it("抵消回归：缺 N 条与多 N 点相减为零时，判据仍必须报脏并报缺", () => {
    const { rows, dirty } = detectMemoryIndexDrift(baseline, indexed);
    const cancel = rows.find((row) => row.projectId === "p-cancel");
    expect(cancel?.indexed, "两边条数完全相等——按基数比较会在这里报绿").toBe(cancel?.expected);
    expect(dirty.map((row) => row.projectId)).toContain("p-cancel");
    expect(cancel?.missingRowIds).toEqual(["c-1", "c-2", "c-3"]);
    expect(cancel?.extraPointIds).toHaveLength(3);
  });

  it("应有集合 = 可见声明 + 章记忆（与重建路径同一组成）", () => {
    const { rows } = detectMemoryIndexDrift(baseline, new Map());
    expect(rows.map((row) => row.expected)).toEqual([10, 4, 3, 2, 2]);
  });

  it("仓储侧只有一份可见性谓词：三条消费路径都引它、无人自己抄", () => {
    const repo = readFileSync(new URL("../postgres-repository.ts", import.meta.url), "utf8");
    const at = (marker: string) => repo.indexOf(`async ${marker}`);
    const globalCount = repo.slice(at("countIndexableMemoryClaims"), at("listIndexableMemoryRowIds"));
    expect(globalCount, "全库计数若自己再写一遍 SQL，就会与按项目基线各自漂移").toContain("listIndexableMemoryRowIds()");
    expect(globalCount.match(/\bretrievalVisibleClaimsSql\s*\(/gu) ?? [], "谓词若自己再写一遍 SQL，就会与按项目基线各自漂移").toHaveLength(0);
    const consumers: Record<string, string> = {
      基线枚举: repo.slice(at("listIndexableMemoryRowIds"), at("filterIndexableMemoryRowIds")),
      检索存活判定: repo.slice(at("filterIndexableMemoryRowIds"), at("listAllChapterMemories")),
    };
    for (const [name, body] of Object.entries(consumers)) {
      expect(body, `${name} 找不到＝消费路径被拆走，锁该跟着改而非静默空转`).not.toBe("");
      expect([...body.matchAll(/\bretrievalVisibleClaimsSql\("memory_claims"\)/gu)].length, `${name} 必须引共享片段恰好一次`).toBe(1);
      expect(body, `${name} 不得自己抄写可见性字面量`).not.toMatch(/lifecycle_status\s*=\s*'active'/u);
    }
    expect(consumers.基线枚举, "点 id 散列若被抄第二份，两侧算出的 id 会各自漂移").not.toContain("sha256");
  });

  it("点 id 散列单源：判据用写入侧同一个函数，不另造", () => {
    const drift = readFileSync(new URL("../memory-index-drift.ts", import.meta.url), "utf8");
    expect(drift).toContain('import { qdrantPointId } from "./memory-point-id"');
    const writer = readFileSync(new URL("../qdrant-memory.ts", import.meta.url), "utf8");
    expect(writer).toContain('import { qdrantPointId } from "./memory-point-id"');
    expect([...writer.matchAll(/function qdrantPointId/gu)].length, "写入侧不得再留一份实现").toBe(0);
  });

  /**
   * 重建路径的陈旧点清理判据（2026-10-14 复核轮，state-audit §8.3）。
   *
   * 背景：`memory/rebuild` 此前只"补灌"——upsertClaims 只删被本次 upsert 的行
   * supersedes 的点，对"行已删 / 已 staged / 已被此后行退役"而点仍在索引里的陈旧点
   * 完全无动作。于是 doctor 报"陈旧点 N 个 ⇒ 走 memory/rebuild 重建"，
   * 而 rebuild 恰好修不了它指的那个方向——**观测面开的药方治不了观测面报的病**。
   *
   * 双向覆盖：
   *  - 命中面：差集与 detectMemoryIndexDrift 的 extraPointIds 完全一致（同一判据），
   *    且覆盖三种成因（行已删 / 行 staged / 行 active 但被可见杀手退役）；
   *  - 反例面：点集不可得（null）时**必须返回空**——宁可不修，不可误删现行事实。
   */
  it("staleMemoryPointIds 与 drift 判据同形，点集不可得时不删", () => {
    const project = baseline[0]; // p-stale：9 claim + 1 chapter memory
    const visible = pointSet(project.projectId, [...project.claimIds, ...project.chapterMemoryIds]);
    // 三种成因各一个：行已删的点 / 行 staged 的点 / 与可见行同形但 id 不同的游离点。
    const withStale = new Set([...visible, "deleted-row-point", "staged-row-point", "orphan-point"]);
    expect(staleMemoryPointIds(project, withStale).sort()).toEqual(["deleted-row-point", "orphan-point", "staged-row-point"]);

    // 与 drift 判据一致性：同输入的 extraPointIds 必须逐项相等（不得有第二套定义）。
    const { dirty } = detectMemoryIndexDrift([project], new Map([[project.projectId, withStale]]));
    expect(dirty[0]?.extraPointIds.sort()).toEqual(staleMemoryPointIds(project, withStale).sort());

    // 反例：点集拿不到 ⇒ 空。这是删除路径的安全阀——半个集合会把未翻到的现行点
    // 当陈旧点删掉，那比不修严重得多。
    expect(staleMemoryPointIds(project, null)).toEqual([]);
    // 干净集 ⇒ 空（rebuild 在无漂移时不得触发任何删除）。
    expect(staleMemoryPointIds(project, visible)).toEqual([]);
  });

  /**
   * 重建路由必须真的删陈旧点（源码级契约锁）。
   *
   * 失效形态（运行库 2026-10-14 实测）：`POST /v2/projects/:id/memory/rebuild` 只做
   * 补灌，删点一步不存在；而 doctor 的 `memory-index-drift` 恰恰把"走 memory/rebuild
   * 重建"当作陈旧点的唯一处方。**观测面报的病，它开的药方治不了**——这类缺陷不抛错、
   * 不影响任何科目的通过与否，只是让告警长期挂着而无人能解。
   *
   * 为什么用源码锁而不是路由单测：api 入口是个 2000 行、无导出、无 handler 抽取的
   * 顶层脚本，既有合同测试都走源码断言（本文件已有三条同形态锁）。锁的是两件：
   * ① rebuild 段内必须出现陈旧点清理，且经共享判据（不得在内联写第二套集合差）；
   * ② 基线取 `listIndexableMemoryRowIds`——与 doctor 同一个函数，否则又出现
   *   "doctor 说旧、rebuild 说新"的第二次口径分叉。
   */
  it("memory/rebuild 路由必须删陈旧点，且判据取自共享层", () => {
    const api = readFileSync(new URL("../../../scripts/novel-v2-api.ts", import.meta.url), "utf8");
    const routeAt = api.indexOf('memoryRebuildMatch');
    const routeEnd = api.indexOf("if (request.method === \"GET\" && storyArcListMatch)", routeAt);
    const route = api.slice(routeAt, routeEnd);
    expect(route.length, "rebuild 路由定位失败：锁会空转，必须修锁而非放行").toBeGreaterThan(200);
    expect(route, "rebuild 必须删陈旧点——只补灌不删点，doctor 报的漂移永远修不掉").toContain("staleMemoryPointIds");
    expect(route, "基线必须与 doctor 同一函数（listIndexableMemoryRowIds）").toContain("listIndexableMemoryRowIds");
    // 不得在内联重算集合差：那会让"什么是陈旧点"出现第二份定义。
    expect(route).not.toMatch(/\[\.\.\.indexed\]\.filter/u);
    // 删除必须经 Qdrant 的 delete（点 id 直删），而不是 deleteClaims——后者的契约是
    // "行 id → 内部散列"，而陈旧点的行通常已不在基线里，拿不到行 id。
    expect(route).toContain("qdrant.delete");
  });

  /**
   * 诊断脚本的谓词完整性锁（2026-10-14 复核轮 round 9 的自我纠正）。
   *
   * 失效形态：本轮第一个槽位诊断脚本用 `lifecycle_status='active' AND authority IN (...)`
   * 数高基数槽，**漏了 retiredByVisibleKillerSql**，于是得出"持有槽 155 条 active"。
   * 运行库正确数字是 73——错谓词多算了 **82 条**（project 级：1987 naive = 155 retired + 1832 correct，
   * 恒等式实测成立）。若不纠正，这个假数字会以"运行库实测"的身份写进文档，
   * 成为后续所有判断的地基。
   *
   * 与 round 4"把 76 条欠灌算成误删"是同一族错误：**用错谓词的取证脚本报出假数字**。
   * 区别是 round 4 的假红在验证脚本里（会被反向实测抓到），round 9 的假数字在诊断脚本里
   * （没有任何机制会发现）——故这里补一道源码锁。
   *
   * 锁的是三处诊断/取证脚本的谓词形态：凡查 memory_claims 的 active 行且意图是
   * "当前可见/应被索引/会被召回"，必须带退役谓词。用"禁止裸 active 谓词"的负向判据，
   * 因为这正是本次出错的形式。
   */
  it("取证脚本查 active 行必须带退役谓词（防诊断脚本报出假数字）", () => {
    const offenders: string[] = [];
    for (const file of [
      "tmp/state-audit/verify-fact-slot-vs-prose.mts",
      "tmp/state-audit/verify-stale-point-consequences.mts",
      "tmp/state-audit/verify-stale-points.mts",
    ]) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      // 找所有查 memory_claims 的 SQL 行：命中 active 谓词的必须同时命中退役谓词。
      const sqlLines = source.split("\n").filter((line) => /FROM memory_claims|UPDATE memory_claims/i.test(line) || /lifecycle_status\s*=\s*'active'/u.test(line));
      for (const line of sqlLines) {
        if (!/lifecycle_status\s*=\s*'active'/u.test(line)) continue;
        // 该行（或其后 12 行内）必须出现退役谓词的任一副本：
        // ① shared SQL 片段引用（生产代码路径）；② NOT EXISTS(killer) 内联（取证脚本路径）。
        const after = source.slice(source.indexOf(line), source.indexOf(line) + 600);
        const hasKiller = /NOT EXISTS[\s\S]{0,400}supersedes/u.test(after) || /retrievalVisibleClaimsSql/u.test(after) || /ANY\(killer\.supersedes\)/u.test(after);
        if (!hasKiller) offenders.push(`${file}: ${line.trim().slice(0, 70)}`);
      }
    }
    expect(offenders, "裸 active 谓词会把已退役行算进可见集 ⇒ 诊断数字虚高").toEqual([]);
  });
});
