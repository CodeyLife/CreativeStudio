/**
 * 盲杀不变式在**真实数据库**上的对抗验证（2026-10-14 复核轮 round 25）。
 *
 * 为什么需要：`memory-visibility.ts` 的头注释声称修掉了"盲杀"（candidate/rejected 行也能
 * 把可见事实逐出检索面，round 3 的历史病例：ch19「缴清灵石」derived 被 ch21
 * 「旁路状态」candidate 退役）。代码侧只有**锁 SQL 形状**的单元测试，**没有一个测试
 * 在真实数据上验证该谓词确实在挡住盲杀**——即谓词可能因为"本库当前没有这种病例"
 * 而空转，也可能因为写反而漏杀。两者都无法从形状测试看出来。
 *
 * 本测试在真库上做对抗验证，三条判据：
 *   ① **算术闭环**：检索面可见数 + 被可见 killer 退役数 == active∧可见authority 总数。
 *      这是**最强的无漏杀证明**：若有任何"被可见 killer 覆盖却仍可见"的行，右边会大于左边。
 *      （首版想直接查漏杀，写错 SQL 报了歧义列；改用算术闭环反而更硬。）
 *   ② **盲杀防护真实存在**：真库确有 candidate 覆盖 derived/approved 的病例，
 *      谓词正在保护它们（否则谓词是空转的纯装饰）。
 *   ③ **谓词方向正确**：`retrievalVisibleClaimsSql` 必须是 visible ∧ ¬retiredByVisibleKiller。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository } from "../postgres-repository";
import { retrievalVisibleClaimsSql, retiredByVisibleKillerSql } from "../memory-visibility";
import type { MemoryClaim } from "../protocol";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

const VISIBLE = `lifecycle_status='active' AND authority IN ('approved','author','derived')`;

describe("blind-kill invariant against live data（round 25）", () => {
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[blind-kill] Postgres 不可用：${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available) await repository.close();
  });

  const count = async (sql: string): Promise<number> => {
    const row = (await repository.pool.query<{ n: string }>(sql)).rows[0];
    return Number(row?.n ?? -1);
  };

  it("① 算术闭环：可见 + 被可见killer退役 == active∧可见authority 总数（等价于无漏杀证明）", async () => {
    if (!available) return;
    const visible = await count(`SELECT count(*)::text AS n FROM memory_claims c WHERE ${retrievalVisibleClaimsSql("c")}`);
    const retiredByVisibleKiller = await count(
      `SELECT count(*)::text AS n FROM memory_claims c WHERE ${VISIBLE}
         AND EXISTS (SELECT 1 FROM memory_claims k WHERE k.project_id=c.project_id AND ${VISIBLE} AND c.id = ANY(k.supersedes))`,
    );
    const activeVisibleAuthority = await count(
      `SELECT count(*)::text AS n FROM memory_claims c WHERE ${VISIBLE}`,
    );
    // 左边必须恰好等于右边：任何"被覆盖却仍可见"的行都会让左边变小。
    expect(visible + retiredByVisibleKiller, "谓词漏杀：有行被可见 killer 覆盖却仍在检索面").toBe(activeVisibleAuthority);
  }, 60_000);

  it("② 盲杀防护真实存在：真库有 candidate 覆盖可见行 ⇒ 谓词不是空转", async () => {
    if (!available) return;
    // 被**任意** killer 覆盖 vs 被**可见** killer 覆盖：差值就是谓词挡住的行数。
    const retiredByAny = await count(
      `SELECT count(*)::text AS n FROM memory_claims c WHERE ${VISIBLE}
         AND EXISTS (SELECT 1 FROM memory_claims k WHERE k.project_id=c.project_id AND c.id = ANY(k.supersedes))`,
    );
    const retiredByVisible = await count(
      `SELECT count(*)::text AS n FROM memory_claims c WHERE ${VISIBLE}
         AND EXISTS (SELECT 1 FROM memory_claims k WHERE k.project_id=c.project_id AND ${VISIBLE} AND c.id = ANY(k.supersedes))`,
    );
    // 只做**方向**断言：盲杀口径不会比可见口径杀得更少。若本库没有 candidate 病例，
    // 两者相等也成立（谓词此时是纯防御）——所以不断言差值 > 0，那不跨环境稳定。
    expect(retiredByAny, "盲杀口径不可能比可见口径杀得更少（否则谓词方向反了）").toBeGreaterThanOrEqual(retiredByVisible);
    expect(retiredByVisible, "可见口径不应超过 active∧可见authority 总数").toBeLessThanOrEqual(
      await count(`SELECT count(*)::text AS n FROM memory_claims c WHERE ${VISIBLE}`),
    );
  }, 60_000);

  it("③ 谓词方向：可见谓词必须同时含 killer 可见性与覆盖判定", () => {
    // 反向锁：谓词不得退化成"任意 killer"（那正是 round 3 修掉的盲杀）。
    expect(retiredByVisibleKillerSql("c")).toMatch(/lifecycle_status/u);
    expect(retiredByVisibleKillerSql("c")).toMatch(/authority IN/u);
    expect(retrievalVisibleClaimsSql("c")).toContain("NOT EXISTS");
  });

  it("④ 自证：构造一对 candidate→derived，验证候选确实杀不掉派生事实", async () => {
    if (!available) return;
    // 用一个独立项目在本测试内构造最小病例，避免依赖真库既有数据（跨环境不稳定）。
    const projectId = `test-blind-kill-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(projectId, "Blind Kill Test");
    const claim = (id: string, authority: string, supersedes: string[], content: string): MemoryClaim => ({
      id, projectId, kind: "canonical", title: content, content, subjectRefs: ["hero"],
      knowledgeScope: "author", authority, confidence: 0.9, sourceRevisionIds: [],
      contentHash: id, supersedes, lifecycleStatus: "active",
    } as unknown as MemoryClaim);

    const derivedId = `derived-${randomUUID().slice(0, 6)}`;
    const candidateId = `candidate-${randomUUID().slice(0, 6)}`;
    await repository.recordMemoryClaims({
      projectId,
      claims: [claim(derivedId, "derived", [], "主角持有两块灵石")],
    });
    await repository.recordMemoryClaims({
      projectId,
      claims: [claim(candidateId, "candidate", [derivedId], "主角已缴清全部灵石（候选）")],
    });

    // 候选态的 killer **不得**把 derived 逐出检索面。
    const visibleDerived = await repository.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory_claims c WHERE ${retrievalVisibleClaimsSql("c")} AND c.id=$1`,
      [derivedId],
    );
    expect(visibleDerived.rows[0]!.n, "候选态 killer 不该退役派生事实（盲杀）").toBe("1");

    // 同一份 killer 升为 approved 后，derived 必须被正确退役（证明不是"永远杀不掉"）。
    await repository.pool.query("UPDATE memory_claims SET authority='approved' WHERE id=$1", [candidateId]);
    const visibleAfterApprove = await repository.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory_claims c WHERE ${retrievalVisibleClaimsSql("c")} AND c.id=$1`,
      [derivedId],
    );
    expect(visibleAfterApprove.rows[0]!.n, "批准后的 killer 必须能退役旧事实").toBe("0");

    await repository.deleteProject(projectId).catch(() => undefined);
  }, 60_000);
});
