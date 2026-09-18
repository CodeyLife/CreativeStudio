import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("foreshadowing narrative visibility", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-foreshadowing-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Foreshadowing Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[foreshadowing-order.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  it("shows only known past foreshadowing when a narrative cutoff is active", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    const contentHash = `content-${randomUUID()}`;
    const revisionIds = ["past", "future", "unknown"].map((label) => `${label}-revision-${randomUUID()}`);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,1)", [documentId, projectId, "测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    for (let index = 0; index < revisionIds.length; index += 1) {
      await repository.pool.query(
        "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,$4,0,$5)",
        [revisionIds[index], projectId, documentId, index + 1, contentHash],
      );
    }
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,planted_revision_id,status,payload,narrative_order)
       VALUES($1,$4,$8,'open',$5,3),($2,$4,$9,'open',$6,8),($3,$4,$10,'open',$7,NULL)`,
      [`past-${randomUUID()}`, `future-${randomUUID()}`, `unknown-${randomUUID()}`, projectId,
        { description: "测试伏笔·过去（井底铜镜泛潮）" }, { description: "测试伏笔·未来（古钟余音不散）" }, { description: "测试伏笔·未知（残卷缺页待补）" }, ...revisionIds],
    );
    await repository.pool.query(
      `INSERT INTO promises(id,project_id,statement,source_revision_id,status,payload,narrative_order)
       VALUES($1,$4,'过去承诺',$6,'open',$5,3),($2,$4,'未来承诺',$7,'open',$5,8),($3,$4,'未知承诺',$8,'open',$5,NULL)`,
      [`past-promise-${randomUUID()}`, `future-promise-${randomUUID()}`, `unknown-promise-${randomUUID()}`, projectId, { promiser: "甲", promisee: "乙" }, ...revisionIds],
    );
    const relationPast = `relation-past-${randomUUID()}`;
    const relationFuture = `relation-future-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO entities(id,project_id,kind,name) VALUES($1,$3,'character','甲'),($2,$3,'character','乙')",
      [`entity-a-${randomUUID()}`, `entity-b-${randomUUID()}`, projectId],
    );
    const entityIds = await repository.pool.query<{ id: string }>("SELECT id FROM entities WHERE project_id=$1 ORDER BY id DESC LIMIT 2", [projectId]);
    await repository.pool.query(
      `INSERT INTO relations(id,project_id,subject_id,predicate,object_id,valid_from,source_revision_id)
       VALUES($1,$3,$4,'同行',$5,3,$6),($2,$3,$4,'同行',$5,8,$7)`,
      [relationPast, relationFuture, projectId, entityIds.rows[0].id, entityIds.rows[1].id, revisionIds[0], revisionIds[1]],
    );
    const graphAtFive = await repository.searchGraphMemory({ projectId, narrativeCutoff: 5, povCharacterId: entityIds.rows[0].id, facets: [{ kind: "relation", query: "同行", required: false }] });
    expect(graphAtFive.map((item) => item.id)).toEqual([`graph:${relationPast}`]);

    const visibleAtFive = await repository.getOpenForeshadowingAndPromises(projectId, 5);
    const visibleWithoutCutoff = await repository.getOpenForeshadowingAndPromises(projectId);

    expect(visibleAtFive.foreshadowings.map((item) => item.plantedRevisionId)).toEqual([revisionIds[0]]);
    expect(visibleWithoutCutoff.foreshadowings.map((item) => item.plantedRevisionId).sort()).toEqual([...revisionIds].sort());
    expect(visibleAtFive.promises).toEqual([expect.objectContaining({ statement: "过去承诺", promiser: "甲", promisee: "乙", sourceRevisionId: revisionIds[0] })]);
    expect(visibleWithoutCutoff.promises.map((item) => item.statement).sort()).toEqual(["过去承诺", "未来承诺", "未知承诺"].sort());

    const snapshot = await repository.recordNarrativeStateSnapshot({
      projectId,
      documentId,
      revisionId: revisionIds[0],
      narrativeOrder: 5,
      chapterMemory: {
        id: `memory-${randomUUID()}`,
        projectId,
        documentId,
        revisionId: revisionIds[0],
        narrativeRange: { start: 5, end: 5 },
        summary: "甲与乙确认继续同行，但尚未处理过去的承诺。",
        keyEvents: ["双方继续同行"],
        characterStates: [{ characterId: "甲", stateSnapshot: "仍然保持戒备" }],
        unresolvedThreads: ["承诺是否兑现"],
        fingerprint: "memory-fingerprint",
        createdAt: Date.now(),
      },
    });
    // 与 commit 阶段一致：先持久化 chapter memory，POV 章末状态才会进入 pinned claims。
    await repository.createChapterMemory({
      id: `memory-persist-${randomUUID()}`,
      projectId,
      documentId,
      revisionId: revisionIds[0],
      narrativeRange: { start: 5, end: 5 },
      summary: "甲与乙确认继续同行，但尚未处理过去的承诺。",
      keyEvents: ["双方继续同行"],
      characterStates: [{ characterId: "甲", stateSnapshot: "仍然保持戒备" }],
      unresolvedThreads: ["承诺是否兑现"],
      fingerprint: "memory-fingerprint",
      createdAt: Date.now(),
    });
    const pinned = await repository.getNarrativeStatePinnedClaims({ projectId, narrativeCutoff: 5, povCharacterId: "甲" });
    // P4 归一：POV 输入为显示名"甲"时，pinned 身份与 knowledgeScope 收敛到登记表规范 id
    //（claims/向量面消费形态），而非原样透传输入形态——同一 POV 无论何种形态进入都得到同一身份。
    const jiaEntity = await repository.pool.query<{ id: string }>("SELECT id FROM entities WHERE project_id=$1 AND name='甲'", [projectId]);
    expect(snapshot.openPromises.map((item) => item.statement)).toEqual(["过去承诺"]);
    expect(pinned).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: snapshot.id, matchedFacets: expect.arrayContaining(["thread", "entity"]) }),
      expect.objectContaining({ id: `${snapshot.id}:pov:${jiaEntity.rows[0].id}`, knowledgeScope: { characterId: jiaEntity.rows[0].id } }),
    ]));
    const stateClaim = pinned.find((item) => item.id === snapshot.id);
    expect(stateClaim?.content).toContain(snapshot.openForeshadowings[0].id);
    expect(stateClaim?.content).toContain(snapshot.openPromises[0].id);
  });

  it("persists and projects enriched foreshadowing ledger fields", async () => {
    if (!available) return;
    const documentId = `document-enrich-${randomUUID()}`;
    const revisionId = `revision-enrich-${randomUUID()}`;
    const contentHash = `content-enrich-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,2)", [documentId, projectId, "账本测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)",
      [revisionId, projectId, documentId, contentHash],
    );
    const artifact = { id: `artifact-enrich-${randomUUID()}` } as never;
    await repository.recordNarrativeElements({
      projectId,
      documentId,
      revisionId,
      artifact,
      narrativeOrder: 2,
      narrativeElements: {
        foreshadowings: [{
          description: "旧门上的刻痕在月圆夜会渗出寒气",
          triggerKeywords: ["刻痕", "月圆"],
          expectedPayoffWindow: "本卷末",
          readerQuestion: "刻痕与失踪的守门人有什么关系？",
          possiblePayoffs: ["刻痕是封印的地图", "刻痕是守门人留下的求救信号"],
          meaningDelta: "刻痕从装饰变为通往密室的门",
          cost: "开门会唤醒被封印的存在",
          evidence: "她注意到旧门上的刻痕在月圆夜渗出寒气。",
        }],
        promises: [],
        payoffs: [],
      },
    });
    const open = await repository.getOpenForeshadowingAndPromises(projectId);
    const stored = open.foreshadowings.find((candidate) => candidate.description.includes("刻痕"));
    expect(stored).toMatchObject({
      readerQuestion: "刻痕与失踪的守门人有什么关系？",
      possiblePayoffs: ["刻痕是封印的地图", "刻痕是守门人留下的求救信号"],
      meaningDelta: "刻痕从装饰变为通往密室的门",
      cost: "开门会唤醒被封印的存在",
    });

    const snapshot = await repository.recordNarrativeStateSnapshot({
      projectId,
      documentId,
      revisionId,
      narrativeOrder: 2,
      chapterMemory: {
        id: `memory-enrich-${randomUUID()}`,
        projectId,
        documentId,
        revisionId,
        narrativeRange: { start: 2, end: 2 },
        summary: "发现旧门刻痕",
        keyEvents: [],
        characterStates: [],
        unresolvedThreads: [],
        fingerprint: "memory-enrich-fingerprint",
        createdAt: Date.now(),
      },
    });
    const projected = snapshot.openForeshadowings.find((candidate) => candidate.description.includes("刻痕"));
    expect(projected).toMatchObject({
      readerQuestion: "刻痕与失踪的守门人有什么关系？",
      possiblePayoffs: ["刻痕是封印的地图", "刻痕是守门人留下的求救信号"],
      meaningDelta: "刻痕从装饰变为通往密室的门",
      cost: "开门会唤醒被封印的存在",
    });
  });

  it("re-extracting the same foreshadowing across revisions reuses one ledger row (content-derived id)", async () => {
    if (!available) return;
    const documentId = `document-dedupe-${randomUUID()}`;
    const contentHash = `content-dedupe-${randomUUID()}`;
    const revisionIds = [`revision-dedupe-a-${randomUUID()}`, `revision-dedupe-b-${randomUUID()}`];
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,3)", [documentId, projectId, "去重测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    for (let index = 0; index < revisionIds.length; index += 1) {
      await repository.pool.query(
        "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,$4,0,$5)",
        [revisionIds[index], projectId, documentId, index + 1, contentHash],
      );
    }
    // 描述须与「enriched foreshadowing ledger fields」用例的"旧门刻痕"不同：
    // 内容派生 ID 契约下同项目同描述命中同一行，两用例共用文本会互相污染埋设来源。
    const description = "祠堂石阶的裂缝在雷雨夜会透出微光";
    // 两次来自不同 artifact/revision 的重提取：内容派生 ID 应命中同一行，不再按 artifact 生成新 ID。
    for (const [index, revisionId] of revisionIds.entries()) {
      await repository.recordNarrativeElements({
        projectId,
        documentId,
        revisionId,
        artifact: { id: `artifact-dedupe-${randomUUID()}` } as never,
        narrativeOrder: index + 3,
        narrativeElements: {
          foreshadowings: [{ description, triggerKeywords: ["石阶"], expectedPayoffWindow: "本卷末", evidence: "他注意到祠堂石阶的裂缝在雷雨夜透出微光。" }],
          promises: [{ promiser: "甲", promisee: "乙", statement: "雷雨夜再去祠堂石阶", evidence: "甲对乙说雷雨夜再去祠堂石阶。" }],
          payoffs: [],
        },
      });
    }
    const open = await repository.getOpenForeshadowingAndPromises(projectId);
    const sameRows = open.foreshadowings.filter((candidate) => candidate.description.includes("石阶"));
    expect(sameRows).toHaveLength(1);
    // 首次埋设来源保留，不被后续修订覆盖。
    expect(sameRows[0]?.plantedRevisionId).toBe(revisionIds[0]);
    const samePromises = open.promises.filter((candidate) => candidate.statement.includes("石阶"));
    expect(samePromises).toHaveLength(1);
    expect(samePromises[0]?.sourceRevisionId).toBe(revisionIds[0]);
  });

  it("多轮重抽取措辞改写但锚点相同 → 归并单行、keywords 有序并集、被吸收描述进 mergedFrom（PL-5③）", async () => {
    if (!available) return;
    const documentId = `document-anchor-${randomUUID()}`;
    const contentHash = `content-anchor-${randomUUID()}`;
    const revisionIds = [`revision-anchor-a-${randomUUID()}`, `revision-anchor-b-${randomUUID()}`];
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,40)", [documentId, projectId, "锚点归并测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    for (let index = 0; index < revisionIds.length; index += 1) {
      await repository.pool.query(
        "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,$4,0,$5)",
        [revisionIds[index], projectId, documentId, index + 1, contentHash],
      );
    }
    // 同一伏笔（同锚点"井底绳索"）、描述措辞与 keywords 各不同——锚点键应把它们收敛到一行。
    const rounds = [
      { description: "古井底部摸到一段浸水的绳索", anchor: "古井绳索", triggerKeywords: ["绳索"] },
      { description: "井里的绳子被人动过，断口是新的", anchor: "古井，绳索", triggerKeywords: ["绳索", "断口"] },
    ];
    for (const [index, round] of rounds.entries()) {
      await repository.recordNarrativeElements({
        projectId,
        documentId,
        revisionId: revisionIds[index],
        artifact: { id: `artifact-anchor-${randomUUID()}` } as never,
        narrativeOrder: index + 40,
        narrativeElements: {
          foreshadowings: [{ ...round, expectedPayoffWindow: { scope: "chapters", count: 6 }, evidence: "他俯身探向古井。" }],
          promises: [],
          payoffs: [],
        },
      });
    }
    const ledger = await repository.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM foreshadowing WHERE project_id=$1 AND payload->>'anchor' LIKE '%古井%绳索%'", [projectId]);
    expect(Number(ledger.rows[0]?.count)).toBe(1);
    const row = await repository.pool.query<{ payload: { description: string; triggerKeywords: string[]; mergedFrom?: string[]; expectedPayoffWindow: unknown } }>(
      "SELECT payload FROM foreshadowing WHERE project_id=$1 AND payload->>'anchor' LIKE '%古井%绳索%'",
      [projectId],
    );
    const payload = row.rows[0]!.payload;
    // 最早埋设描述与首埋修订保留，keywords 有序并集，第二轮改写描述进 mergedFrom。
    expect(payload.description).toBe(rounds[0].description);
    expect(payload.triggerKeywords).toEqual(["绳索", "断口"]);
    expect(payload.mergedFrom).toEqual([rounds[1].description]);
    expect(payload.expectedPayoffWindow).toMatchObject({ scope: "chapters", count: 6 });
    expect((await repository.getOpenForeshadowingAndPromises(projectId)).foreshadowings.find((item) => item.description === rounds[0].description)?.expectedPayoffWindow).toBe("6章内");
  });

  it("requires an exact payoff ID or a unique legacy fallback before closing a promise", async () => {
    if (!available) return;
    const documentId = `document-payoff-${randomUUID()}`;
    const revisionId = `revision-payoff-${randomUUID()}`;
    const contentHash = `content-payoff-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,20)", [documentId, projectId, "兑现测试章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)",
      [revisionId, projectId, documentId, contentHash],
    );
    const exactPromiseId = `promise-exact-${randomUUID()}`;
    const exactForeshadowingId = `foreshadowing-exact-${randomUUID()}`;
    const ambiguousPromiseIds = [`promise-ambiguous-a-${randomUUID()}`, `promise-ambiguous-b-${randomUUID()}`];
    await repository.pool.query(
      `INSERT INTO promises(id,project_id,statement,source_revision_id,status,payload,narrative_order)
       VALUES($1,$4,'精确承诺',$5,'open',$6,3),($2,$4,'模糊承诺甲',$5,'open',$6,4),($3,$4,'模糊承诺乙',$5,'open',$6,5)`,
      [exactPromiseId, ambiguousPromiseIds[0], ambiguousPromiseIds[1], projectId, revisionId, { promiser: "同一承诺者", promisee: "乙" }],
    );
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,planted_revision_id,status,payload,narrative_order)
       VALUES($1,$2,$3,'open',$4,3)`,
      [exactForeshadowingId, projectId, revisionId, { description: "精确伏笔", triggerKeywords: ["精确"] }],
    );
    await repository.recordNarrativeElements({
      projectId,
      documentId,
      revisionId,
      artifact: { id: `artifact-payoff-${randomUUID()}` } as never,
      narrativeOrder: 20,
      narrativeElements: {
        foreshadowings: [],
        promises: [],
        payoffs: [
          { description: "精确兑现", payoffType: "promise", matchedPromiseId: exactPromiseId, evidence: "正文明确完成精确承诺" },
          { description: "无法唯一关联", payoffType: "promise", matchedPromiser: "同一承诺者", evidence: "正文完成但来源不唯一" },
          { description: "精确伏笔兑现", payoffType: "foreshadowing", matchedForeshadowingIds: [exactForeshadowingId], evidence: "正文明确回收精确伏笔" },
        ],
      },
    });
    const statuses = await repository.pool.query<{ id: string; status: string }>("SELECT id,status FROM promises WHERE id=ANY($1::text[])", [[exactPromiseId, ...ambiguousPromiseIds]]);
    expect(statuses.rows.find((row) => row.id === exactPromiseId)?.status).toBe("fulfilled");
    expect(statuses.rows.filter((row) => ambiguousPromiseIds.includes(row.id)).every((row) => row.status === "open")).toBe(true);
    const foreshadowingStatus = await repository.pool.query<{ status: string }>("SELECT status FROM foreshadowing WHERE id=$1", [exactForeshadowingId]);
    expect(foreshadowingStatus.rows[0]?.status).toBe("fulfilled");
    // PL-5 修复②：兑现单入口——伏笔兑现与 status 同事务落 payoffs 账（旧路径只翻 status，
    // 兑现账对伏笔失明）。
    const payoffRows = await repository.pool.query<{ id: string }>("SELECT id FROM payoffs WHERE foreshadowing_id=$1", [exactForeshadowingId]);
    expect(payoffRows.rowCount).toBe(1);
    // 幂等重放：再次提取同文兑现不重复落账（伏笔已脱离 open，账行 id 确定）。
    await repository.recordNarrativeElements({
      projectId,
      documentId,
      revisionId,
      artifact: { id: `artifact-replay-${randomUUID()}` } as never,
      narrativeOrder: 20,
      narrativeElements: {
        foreshadowings: [],
        promises: [],
        payoffs: [{ description: "精确伏笔兑现", payoffType: "foreshadowing", matchedForeshadowingIds: [exactForeshadowingId], evidence: "正文明确回收精确伏笔" }],
      },
    });
    const replayedRows = await repository.pool.query("SELECT id FROM payoffs WHERE foreshadowing_id=$1", [exactForeshadowingId]);
    expect(replayedRows.rowCount).toBe(1);
  });

  it("reports fulfilled-without-payoff as a blocking ledger inconsistency and clears it once the payoff row exists (PL-5⑤)", async () => {
    if (!available) return;
    const documentId = `document-ledger-${randomUUID()}`;
    const revisionId = `revision-ledger-${randomUUID()}`;
    const contentHash = `content-ledger-${randomUUID()}`;
    const foreshadowingId = `foreshadowing-ledger-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,30)", [documentId, projectId, "账实核对章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)",
      [revisionId, projectId, documentId, contentHash],
    );
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,planted_revision_id,payoff_revision_id,status,payload,narrative_order)
       VALUES($1,$2,$3,$4,'fulfilled',$5,30)`,
      [foreshadowingId, projectId, revisionId, revisionId, { description: "只翻 status 的旧时代兑现" }],
    );
    const unhealthy = await repository.getArchitectureHealth(projectId);
    expect(unhealthy.foreshadowingLedger.fulfilledWithoutPayoff).toBeGreaterThanOrEqual(1);
    expect(unhealthy.issues.some((issue) => issue.code === "ledger-inconsistency" && issue.severity === "blocking")).toBe(true);
    // 双向：补登兑现账行后，该项计数与 issue 消失。
    await repository.pool.query(
      "INSERT INTO payoffs(id, promise_id, foreshadowing_id, revision_id, evidence) VALUES($1,NULL,$2,$3,'{}'::jsonb)",
      [`foreshadowing-payoff:${foreshadowingId}`, foreshadowingId, revisionId],
    );
    const healthy = await repository.getArchitectureHealth(projectId);
    const residual = healthy.foreshadowingLedger.fulfilledWithoutPayoff;
    const baseline = unhealthy.foreshadowingLedger.fulfilledWithoutPayoff;
    expect(residual).toBeLessThan(baseline);
  });

  it("replays the 084 backfill predicate idempotently and never fabricates payoff evidence for anchorless rows", async () => {
    if (!available) return;
    const documentId = `document-repair-${randomUUID()}`;
    const revisionId = `revision-repair-${randomUUID()}`;
    const contentHash = `content-repair-${randomUUID()}`;
    const anchoredId = `foreshadowing-anchored-${randomUUID()}`;
    const anchorlessId = `foreshadowing-anchorless-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order) VALUES($1,$2,$3,31)", [documentId, projectId, "补账修复章节"]);
    await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,0)", [contentHash, `test/${contentHash}`]);
    await repository.pool.query(
      "INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)",
      [revisionId, projectId, documentId, contentHash],
    );
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,planted_revision_id,payoff_revision_id,status,payload,narrative_order)
       VALUES($1,$2,$3,$4,'fulfilled',$5,31)`,
      [anchoredId, projectId, revisionId, revisionId, { description: "有修订锚点的漏账兑现" }],
    );
    await repository.pool.query(
      `INSERT INTO foreshadowing(id,project_id,status,payload,narrative_order) VALUES($1,$2,'fulfilled',$3,31)`,
      [anchorlessId, projectId, { description: "无任何证据的虚账兑现" }],
    );

    const first = await repository.repairForeshadowingPayoffLedger();
    expect(first.backfilled).toContain(anchoredId);
    const anchoredRow = await repository.pool.query("SELECT revision_id, evidence FROM payoffs WHERE foreshadowing_id=$1", [anchoredId]);
    expect(anchoredRow.rowCount).toBe(1);
    expect(anchoredRow.rows[0].revision_id).toBe(revisionId);
    expect(anchoredRow.rows[0].evidence).toMatchObject({ backfilled: true });
    // 双向：无锚点行刻意不补——blocking 信号必须保留给作者补登证据或改判。
    expect(first.backfilled).not.toContain(anchorlessId);
    const anchorlessRow = await repository.pool.query("SELECT id FROM payoffs WHERE foreshadowing_id=$1", [anchorlessId]);
    expect(anchorlessRow.rowCount).toBe(0);
    // 幂等：第二次运行零补账。
    const second = await repository.repairForeshadowingPayoffLedger();
    expect(second.backfilled).not.toContain(anchoredId);
  });

  it("同章重措辞变体归并为一条 open，跨章/异事件不误并，复跑零改动", async () => {
    if (!available) return;
    const order = 31;
    const seed = async (id: string, chapter: number, description: string) => {
      await repository.pool.query(
        "INSERT INTO foreshadowing(id, project_id, status, payload, narrative_order) VALUES($1,$2,'open',$3,$4)",
        [id, projectId, { description, anchor: "", triggerKeywords: ["颤动"], expectedPayoffWindow: "10章内" }, chapter],
      );
    };
    const keeper = `fs-dup-k-${randomUUID().slice(0, 8)}`;
    const variant = `fs-dup-v-${randomUUID().slice(0, 8)}`;
    const different = `fs-dup-x-${randomUUID().slice(0, 8)}`;
    const crossChapter = `fs-dup-c-${randomUUID().slice(0, 8)}`;
    const siblingA = `fs-dup-sa-${randomUUID().slice(0, 8)}`;
    const siblingB = `fs-dup-sb-${randomUUID().slice(0, 8)}`;
    await seed(keeper, order, "窗外老槐树下的落叶在无风情况下轻微颤动，暗示树根附近存在异常动静");
    await seed(variant, order, "老槐树下几片刚落下的叶子在无风情况下极其轻微地颤动后恢复死寂，暗示树根附近存在不明异动");
    await seed(different, order, "赵虎离去时的轻蔑态度说明他把楚衡当废人，短期不会再构成直接威胁");
    await seed(crossChapter, order + 1, "窗外老槐树下的落叶在无风情况下轻微颤动，暗示树根附近存在异常动静");
    // 边界反例（随 0.24 阈值入籍）：同物件不同叙事动作，运行库带实测 ≈0.21，不得并。
    const sibA = "周师兄目睹石头后欲言又止，事后未追问石头来历也未表明是否上报";
    const sibB = "楚衡在移除云纹草根下的青灰色石头后，发现石头表面干净不像自然形成";
    await seed(siblingA, order, sibA);
    await seed(siblingB, order, sibB);
    const { textBigramDice } = await import("../memory-grooming");
    const norm = (s: string) => s.replace(/[^一-鿿]/g, "");
    expect(textBigramDice(norm(sibA), norm(sibB))).toBeLessThan(0.24);
    const outcome = await repository.repairForeshadowingLedgerDuplicates();
    expect(outcome.retired).toBeGreaterThanOrEqual(1);
    const rows = await repository.pool.query<{ id: string; status: string; payload: Record<string, unknown> }>(
      "SELECT id,status,payload FROM foreshadowing WHERE id = ANY($1::text[])", [[keeper, variant, different, crossChapter]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(keeper)!.status).toBe("open");
    expect(byId.get(keeper)!.payload.mergedFrom).toContain(String(byId.get(variant)!.payload.description));
    expect(byId.get(variant)!.status).toBe("merged");
    expect(byId.get(variant)!.payload.mergedInto).toBe(keeper);
    // 反例面：同章异事件、跨章同文、0.21 带同物件异动作都不许并。
    expect(byId.get(different)!.status).toBe("open");
    expect(byId.get(crossChapter)!.status).toBe("open");
    const sibs = await repository.pool.query<{ status: string }>("SELECT status FROM foreshadowing WHERE id = ANY($1::text[])", [[siblingA, siblingB]]);
    expect(sibs.rows.every((row) => row.status === "open")).toBe(true);
    // 幂等：复跑不再产生新归并（本夹具已无 open 变体）。
    const rerun = await repository.repairForeshadowingLedgerDuplicates();
    const keeperAgain = await repository.pool.query("SELECT payload FROM foreshadowing WHERE id=$1", [keeper]);
    expect((keeperAgain.rows[0].payload.mergedFrom as string[]).filter((text) => text === String(byId.get(variant)!.payload.description))).toHaveLength(1);
    expect(rerun).toBeDefined();
  });

  it("无锚点行自成一桶参与归并；同章同文跨项目不误并", async () => {
    if (!available) return;
    const otherProject = `test-foreshadowing-other-${randomUUID().slice(0, 8)}`;
    await repository.ensureProject(otherProject, "Foreshadowing Other");
    const order = 41;
    const text = "井底铜镜在无人触碰时泛出一层潮气并映出非当前时间的影子";
    const variant = "井底铜镜没有人触碰却自行泛起潮气，镜面映出的影子不属于当前时间";
    const unrelated = "第五种笔迹的收笔与前四种都不同，说明抄册的人不止一个时期";
    const anchorlessA = "宗门高层（玄机子）对外门某些异常迹象的例行忽视或延迟处理（暗示后续的察觉机制）";
    const anchorlessB = "宗门高层对外门某些异常迹象的例行忽视或延迟处理（暗示后续的察觉机制）";
    const ids = {
      keeper: `fs-sc-k-${randomUUID().slice(0, 8)}`,
      variant: `fs-sc-v-${randomUUID().slice(0, 8)}`,
      unrelated: `fs-sc-x-${randomUUID().slice(0, 8)}`,
      otherProject: `fs-sc-p-${randomUUID().slice(0, 8)}`,
      anchorlessKeeper: `fs-na-k-${randomUUID().slice(0, 8)}`,
      anchorlessVariant: `fs-na-v-${randomUUID().slice(0, 8)}`,
    };
    const seed = async (id: string, project: string, chapter: number | null, description: string) => {
      await repository.pool.query(
        "INSERT INTO foreshadowing(id, project_id, status, payload, narrative_order) VALUES($1,$2,'open',$3,$4)",
        [id, project, { description, anchor: "", triggerKeywords: ["铜镜"] }, chapter],
      );
    };
    await seed(ids.keeper, projectId, order, text);
    await seed(ids.variant, projectId, order, variant);
    await seed(ids.unrelated, projectId, order, unrelated);
    await seed(ids.otherProject, otherProject, order, text);
    await seed(ids.anchorlessKeeper, projectId, null, anchorlessA);
    await seed(ids.anchorlessVariant, projectId, null, anchorlessB);
    const { textBigramDice } = await import("../memory-grooming");
    const norm = (s: string) => s.replace(/[^一-鿿]/g, "");
    expect(textBigramDice(norm(text), norm(variant))).toBeGreaterThanOrEqual(0.24);
    expect(textBigramDice(norm(text), norm(unrelated))).toBeLessThan(0.24);

    await repository.repairForeshadowingLedgerDuplicates();

    const rows = await repository.pool.query<{ id: string; status: string; payload: Record<string, unknown> }>(
      "SELECT id,status,payload FROM foreshadowing WHERE id = ANY($1::text[])",
      [[ids.keeper, ids.variant, ids.unrelated, ids.otherProject, ids.anchorlessKeeper, ids.anchorlessVariant]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(ids.keeper)!.status).toBe("open");
    expect(byId.get(ids.variant)!.status).toBe("merged");
    expect(byId.get(ids.unrelated)!.status).toBe("open");
    // 跨项目负控：同章号 + 同文但不同项目，不得进同一桶（只按 narrative_order 分桶的旧实现会把它归并掉）
    expect(byId.get(ids.otherProject)!.status).toBe("open");
    expect(byId.get(ids.otherProject)!.payload.mergedInto ?? null).toBeNull();
    // 无锚点面：检测面（跨全表 Dice≥0.85）能看见、修复面此前看不见的那一类
    const anchorless = [byId.get(ids.anchorlessKeeper)!, byId.get(ids.anchorlessVariant)!];
    expect(anchorless.filter((row) => row.status === "merged")).toHaveLength(1);
    expect(anchorless.filter((row) => row.status === "open")).toHaveLength(1);
    await repository.deleteProject(otherProject).catch(() => undefined);
  });
});
