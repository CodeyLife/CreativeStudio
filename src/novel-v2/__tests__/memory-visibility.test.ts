import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NovelPostgresRepository } from "../postgres-repository";
import { CLAIM_PROJECTION_SET_SQL, retrievalVisibleClaimsSql, retiredByVisibleKillerSql, isVisibleClaimAuthority } from "../memory-visibility";
import type { MemoryClaim } from "../protocol";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function claim(projectId: string, over: Partial<MemoryClaim> & { id: string; subjectRefs: string[]; predicate: string; content: string }): MemoryClaim {
  return {
    projectId, kind: "episodic", title: over.content.slice(0, 20), authority: "derived",
    confidence: 0.9, sourceRevisionIds: [], contentHash: `h-${over.id}`, supersedes: [], knowledgeScope: "author",
    narrativeRange: { start: 1, end: 1 }, ...over,
  } as MemoryClaim;
}

describe("claim retrieval visibility (FM-1)", () => {
  it("shared SQL requires the retirement killer to be retrieval-visible", () => {
    const sql = retiredByVisibleKillerSql("c");
    expect(sql).toContain("c_retirement_killer.lifecycle_status = 'active'");
    expect(sql).toContain("c_retirement_killer.authority IN ('approved','author','derived')");
    expect(sql).toContain("c.id = ANY(c_retirement_killer.supersedes)");
    const visible = retrievalVisibleClaimsSql("m");
    expect(visible).toContain("NOT EXISTS");
  });

  it("classifies candidate/rejected as invisible, approved/author/derived as visible", () => {
    expect(isVisibleClaimAuthority("candidate")).toBe(false);
    expect(isVisibleClaimAuthority("rejected")).toBe(false);
    expect(isVisibleClaimAuthority(null)).toBe(false);
    expect(isVisibleClaimAuthority("approved")).toBe(true);
    expect(isVisibleClaimAuthority("derived")).toBe(true);
    expect(isVisibleClaimAuthority("author")).toBe(true);
  });

  it("派生投影：叙事区间是跨度，end 取来源最大值而非最小值", () => {
    const startBlock = /narrative_start=\(\s*SELECT MIN\(document\.narrative_order\)/u;
    const endBlock = /narrative_end=\(\s*SELECT MAX\(document\.narrative_order\)/u;
    expect(CLAIM_PROJECTION_SET_SQL).toMatch(startBlock);
    expect(CLAIM_PROJECTION_SET_SQL).toMatch(endBlock);
    // 反例面：end 抄成 MIN 会让区间塌成点（历史缺陷形态）。
    expect(CLAIM_PROJECTION_SET_SQL).not.toMatch(/narrative_end=\(\s*SELECT MIN/u);
    // 片段以 ${} 内插进带编号绑参的语句，自身含 $n 会造成占位符错位。
    expect(CLAIM_PROJECTION_SET_SQL).not.toMatch(/\$\d/u);
  });

  it("接线锁：三处 claim 投影重算必须取自同一片段，不得残留内联副本", () => {
    const source = readFileSync(fileURLToPath(new URL("../postgres-repository.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/import \{ CLAIM_PROJECTION_SET_SQL[^}]*\} from "\.\/memory-visibility"/);
    // 三个调用点：deleteStoryArc / replaceCommittedChapterFactSources / commitRevision。
    expect(source.match(/\$\{CLAIM_PROJECTION_SET_SQL\}/g)?.length).toBe(3);
    // 反例面：任何内联 MIN/MAX 副本复发都会绕过单源。
    expect(source).not.toMatch(/narrative_(start|end)=\(\s*SELECT (MIN|MAX)/u);
    expect(source).not.toMatch(/narrative_(start|end)=\(SELECT (MIN|MAX)/u);
  });
});

describe("blind-kill invariant against PostgreSQL", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-visibility-${randomUUID().slice(0, 8)}`;
  const derivedId = `claim-derived-${randomUUID()}`;
  const candidateId = `claim-candidate-${randomUUID()}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Visibility Test");
      await repository.recordMemoryClaims({
        projectId,
        claims: [claim(projectId, { id: derivedId, subjectRefs: ["hero"], predicate: "持有", content: "主角持有两块灵石", authority: "derived", narrativeRange: { start: 1, end: 1 } })],
      });
      await repository.recordMemoryClaims({
        projectId,
        claims: [claim(projectId, { id: candidateId, subjectRefs: ["hero"], predicate: "持有", content: "主角已缴清全部灵石", authority: "candidate", supersedes: [derivedId], narrativeRange: { start: 5, end: 5 } })],
      });
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[memory-visibility integration] Postgres 不可用：${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  async function indexedVisible(): Promise<boolean> {
    const claims = await repository.listIndexableMemoryClaims({ projectId, limit: 1000 });
    return claims.some((row) => row.id === derivedId);
  }

  it("an unadjudicated candidate cannot retire a visible derived claim", async () => {
    if (!available) return;
    // Candidate killer is not retrieval-visible → derived stays live in both the
    // vector index set and lexical retrieval. This is the exact FM-1 failure mode.
    expect(await indexedVisible()).toBe(true);
    const hits = await repository.searchMemory({ projectId, facets: [{ kind: "fact", query: "灵石", required: true }] });
    expect(hits.some((hit) => hit.id === derivedId)).toBe(true);
  });

  it("候选积压面板可对真实 Postgres 执行且逐章聚合正确（FM-2；回归：可见数查询漏传参数导致整工具 'there is no parameter $1' 出生即坏）", async () => {
    if (!available) return;
    const backlog = await repository.getFactCandidateBacklog(projectId);
    expect(backlog.totalPending).toBe(1);
    expect(backlog.stagedDebris).toBe(0);
    expect(backlog.oldestPendingDays).not.toBeNull();
    // 候选挂在叙事第 5 章；该章可见事实数为 0（derived 在第 1 章），面板须按章对齐两个口径。
    const bucket = backlog.byChapter.find((item) => item.chapterIndex === 5);
    expect(bucket).toBeDefined();
    expect(bucket!.pending).toBe(1);
    expect(bucket!.visibleFacts).toBe(0);
    expect(bucket!.samples.some((sample) => sample.id === candidateId)).toBe(true);
    // 反例面：不存在候选的第 1 章不产生 bucket（可见数查询 JOIN 不发明积压）。
    expect(backlog.byChapter.some((item) => item.chapterIndex === 1)).toBe(false);
  });

  it("the same derived claim is retired once the candidate is approved", async () => {
    if (!available) return;
    await repository.pool.query("UPDATE memory_claims SET authority='approved' WHERE id=$1", [candidateId]);
    expect(await indexedVisible()).toBe(false);
    const hits = await repository.searchMemory({ projectId, facets: [{ kind: "fact", query: "灵石", required: true }] });
    expect(hits.some((hit) => hit.id === derivedId)).toBe(false);
  });
});

describe("foundation segment singleton (A2/FM-6)", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-foundation-${randomUUID().slice(0, 8)}`;
  const legacyId = `foundation:${randomUUID()}`; // 历史 per-artifact 格式行（无 singleton 前缀语义）
  const gen1 = `art-${randomUUID()}`;
  const gen2 = `art-${randomUUID()}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Foundation Test");
      // 两个 foundation artifact 代际（gen2 更新）。
      const insertArtifact = async (id: string, summary: string, ageMinutes: number) => {
        await repository.pool.query(
          `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload,created_at)
           VALUES($1,$2,$1,$1,'foundation',$5,0,$5,$3,now() - $4::interval)`,
          [id, projectId, { taskKey: "worldview", title: "世界规则", summary }, `${ageMinutes} minutes`, `hash-${id}`],
        );
      };
      await insertArtifact(gen1, "第一版规则", 60);
      await insertArtifact(gen2, "第二版规则", 10);
      // 存量：旧格式 active 投影行（模拟迁移前遗留代际）。
      await repository.recordMemoryClaims({
        projectId,
        claims: [{
          id: legacyId, projectId, kind: "canonical", title: "[foundation:worldview] 世界规则",
          content: "规划维度：worldview\n结构化决策：第一版规则", subjectRefs: ["foundation:worldview", "facet:fact"],
          knowledgeScope: "author", authority: "derived", confidence: 0.8, sourceRevisionIds: [],
          contentHash: `legacy-${gen1}`, supersedes: [],
        } as unknown as MemoryClaim],
        sourceArtifactId: gen1,
      });
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[foundation singleton] Postgres 不可用：${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("backfills one singleton row and retires legacy per-artifact generations", async () => {
    if (!available) return;
    const recorded = await repository.ensureFoundationMemoryClaims(projectId);
    expect(recorded.map((claim) => claim.id)).toEqual([`foundation:${projectId}:worldview`]);
    const indexable = await repository.listIndexableMemoryClaims({ projectId, limit: 1000 });
    const foundationRows = indexable.filter((row) => row.id.startsWith("foundation:"));
    expect(foundationRows.map((row) => row.id)).toEqual([`foundation:${projectId}:worldview`]);
    // 单例行承载最新代际内容，旧代仅存 artifacts 表。
    expect(foundationRows[0].content).toContain("第二版规则");
    // 幂等：再次 ensure 不产生新行也不覆盖。
    expect(await repository.ensureFoundationMemoryClaims(projectId)).toEqual([]);
    const count = await repository.pool.query(
      "SELECT count(*)::int AS n FROM memory_claims WHERE project_id=$1 AND id = ANY($2::text[])",
      [projectId, [`foundation:${projectId}:worldview`, legacyId]],
    );
    expect(count.rows[0].n).toBe(2); // 旧行保留为退役档案，不物理删除
  });

  it("regeneration refreshes the singleton in place instead of adding a row", async () => {
    if (!available) return;
    const gen3 = `art-${randomUUID()}`;
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint,payload,created_at)
       VALUES($1,$2,$1,$1,'foundation',$4,0,$4,$3,now())`,
      [gen3, projectId, { taskKey: "worldview", title: "世界规则", summary: "第三版规则" }, `hash-${gen3}`],
    );
    const recorded = await repository.ensureFoundationMemoryClaims(projectId);
    expect(recorded.map((claim) => claim.id)).toEqual([`foundation:${projectId}:worldview`]);
    const rows = await repository.pool.query(
      "SELECT content, source_artifact_id FROM memory_claims WHERE project_id=$1 AND id=$2",
      [projectId, `foundation:${projectId}:worldview`],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].content).toContain("第三版规则");
    expect(rows.rows[0].source_artifact_id).toBe(gen3);
  });
});
