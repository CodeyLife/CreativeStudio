import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { auditEmotionalContractCarriage, auditNamedReferences, auditStoryArcBatchRanges, canonicalReferenceId, EMOTIONAL_CONTRACT_CARRIER_FUNCTIONS, findEmbeddedInternalIdentifiers, normalizeThreadResponsibilityReferences, parseExplicitNewReference, planThreadForeshadowingBindings, resolveNamedReference, sanitizeReferenceToken } from "../application/story-arc-integrity";
import { parseStoryArcBundle, parseStoryArcPlan, parseStoryArcPlotOutline, resolveArcPhase } from "../application/story-arc";
import { renderStoryArcPlotOutline, storyArcBundleSchema } from "../prompts/story-arc";
import { TOOL_DEFINITIONS } from "../mcp/tool-definitions";
import { buildNarrativeRhythmSnapshotQuery, NovelPostgresRepository } from "../postgres-repository";
import { isPostgresUnavailable } from "./test-db";

describe("story arc integrity diagnostics", () => {
  it("detects invalid and overlapping active batch windows", () => {
    const issues = auditStoryArcBatchRanges([
      { batchIndex: 1, startChapterIndex: 1, endChapterIndex: 6, status: "approved" },
      { batchIndex: 2, startChapterIndex: 4, endChapterIndex: 8, status: "awaiting-review" },
      { batchIndex: 3, startChapterIndex: 0, endChapterIndex: 2, status: "generating" },
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["overlapping-batch", "invalid-range"]));
    expect(issues.every((issue) => issue.severity === "blocking")).toBe(true);
  });

  it("does not treat a failed historical batch as an active overlap", () => {
    expect(auditStoryArcBatchRanges([
      { batchIndex: 1, startChapterIndex: 1, endChapterIndex: 6, status: "failed" },
      { batchIndex: 2, startChapterIndex: 1, endChapterIndex: 6, status: "approved" },
    ])).toEqual([]);
  });

  it("keeps the widest surviving range as the overlap frontier", () => {
    const issues = auditStoryArcBatchRanges([
      { batchIndex: 1, startChapterIndex: 1, endChapterIndex: 10, status: "approved" },
      { batchIndex: 2, startChapterIndex: 3, endChapterIndex: 4, status: "awaiting-review" },
      { batchIndex: 3, startChapterIndex: 5, endChapterIndex: 6, status: "approved" },
    ]);
    expect(issues.filter((issue) => issue.code === "overlapping-batch").map((issue) => issue.batchIndex)).toEqual([2, 3]);
  });

  it("resolves canonical IDs before aliases and reports ambiguity", () => {
    const candidates = [
      { id: "thread-a", labels: ["逃亡线", "逃亡"] },
      { id: "thread-b", labels: ["复仇线", "逃亡"] },
    ];
    expect(resolveNamedReference("thread-a", candidates)).toMatchObject({ status: "resolved", canonicalId: "thread-a" });
    expect(resolveNamedReference("复仇线", candidates)).toMatchObject({ status: "resolved", canonicalId: "thread-b" });
    expect(resolveNamedReference("逃亡", candidates)).toMatchObject({ status: "ambiguous", candidateIds: ["thread-a", "thread-b"] });
    expect(auditNamedReferences(["不存在的线"], candidates).issues[0]).toMatchObject({ code: "unknown-reference", severity: "blocking" });
    expect(canonicalReferenceId("thread", "project-1", "  逃亡线 ")).toBe(canonicalReferenceId("thread", "project-1", "逃亡线"));
  });

  it("self-heals compound '<id> <slug>' references and multiple ids stay ambiguous (PL-2)", () => {
    const candidates = [
      { id: "thread:p1:aaa111", labels: ["主角觉醒线"] },
      { id: "thread:p1:bbb222", labels: ["师门恩怨线"] },
    ];
    // 复合串以 id token 为准（历史快照逐轮复制的形态）。
    expect(resolveNamedReference("thread:p1:aaa111 主角觉醒线", candidates)).toMatchObject({ status: "resolved", canonicalId: "thread:p1:aaa111" });
    // 内嵌两个不同 id → 仍是歧义，不猜。
    expect(resolveNamedReference("thread:p1:aaa111 thread:p1:bbb222", candidates)).toMatchObject({ status: "ambiguous", candidateIds: ["thread:p1:aaa111", "thread:p1:bbb222"] });
    // 不含任何 id 的自由文本保持原行为（未知名不再被创建，由调用方回流）。
    expect(resolveNamedReference("某条没登记过的线", candidates)).toMatchObject({ status: "unknown" });
  });

  it("typed-id 键代际容错：尾段哈希唯一命中即解析，多命中仍歧义，无命中不放宽（弧10 双代际键实证）", () => {
    const ledger = [
      { id: "foreshadowing:p1:0b6d8d5fa341", labels: ["三样旧物比对"] },
      { id: "foreshadowing:p1:anchor:f0aee7eab961", labels: ["空位发差单"] },
      { id: "foreshadowing:p1:99aa88bb77cc", labels: ["另一条目"] },
    ];
    // planner 按主导 anchor 格式拼了 raw 行的引用 → 尾段命中 raw。
    expect(resolveNamedReference("foreshadowing:p1:anchor:0b6d8d5fa341", ledger)).toMatchObject({ status: "resolved", canonicalId: "foreshadowing:p1:0b6d8d5fa341" });
    // 反方向：raw 形引用 anchor 行。
    expect(resolveNamedReference("foreshadowing:p1:f0aee7eab961", ledger)).toMatchObject({ status: "resolved", canonicalId: "foreshadowing:p1:anchor:f0aee7eab961" });
    // 尾段无匹配：仍 unknown（不因容错放宽自由文本引用面）。
    expect(resolveNamedReference("foreshadowing:p1:anchor:deadbeef0000", ledger)).toMatchObject({ status: "unknown" });
    // 尾段多命中：仍 ambiguous 不猜。
    expect(resolveNamedReference("foreshadowing:p1:anchor:x", [{ id: "foreshadowing:p1:a:x", labels: [] }, { id: "foreshadowing:p1:b:x", labels: [] }])).toMatchObject({ status: "ambiguous" });
    // ID 语法归一：真实 12-hex 尾段后拖挂 `_` 装饰（模型自造 _ref_unused 类标记）→ 剥饰重试命中。
    expect(resolveNamedReference("foreshadowing:p1:anchor:0b6d8d5fa341_ref_unused", ledger)).toMatchObject({ status: "resolved", canonicalId: "foreshadowing:p1:0b6d8d5fa341" });
    // 反方向：装饰的哈希不存在仍 unknown（归一不放宽引用面）。
    expect(resolveNamedReference("foreshadowing:p1:anchor:deadbeef0000_etc", ledger)).toMatchObject({ status: "unknown" });
    // 非 hex12 形（短尾段带饰）不触发剥饰——只认对象哈希语法。
    expect(resolveNamedReference("foreshadowing:p1:x_unused", [{ id: "foreshadowing:p1:a:x", labels: [] }])).toMatchObject({ status: "unknown" });
  });

  it("strips leading index-label forms from reference tokens without eating legitimate titles (PL-2)", () => {
    expect(sanitizeReferenceToken("弧3：主角觉醒线")).toBe("主角觉醒线");
    expect(sanitizeReferenceToken("Arc 2: 师门恩怨")).toBe("师门恩怨");
    expect(sanitizeReferenceToken("3、复仇线")).toBe("复仇线");
    // 反例：中文序号标题、小数与正常名称不被误剥。
    expect(sanitizeReferenceToken("第一章的雨")).toBe("第一章的雨");
    expect(sanitizeReferenceToken("1.5米的绳子")).toBe("1.5米的绳子");
    expect(sanitizeReferenceToken(" 主角觉醒线 ")).toBe("主角觉醒线");
  });

  it("recognizes the explicit new-object channel and rejects empty names (PL-2)", () => {
    expect(parseExplicitNewReference("new:新引入的第三方势力")).toEqual({ name: "新引入的第三方势力" });
    expect(parseExplicitNewReference("新增: 秘境守卫")).toEqual({ name: "秘境守卫" });
    expect(parseExplicitNewReference("new:   ")).toBeUndefined();
    expect(parseExplicitNewReference("thread:p1:aaa111")).toBeUndefined();
  });

  it("detects embedded machine identifiers in creative text and ignores plain prose (PL-2)", () => {
    expect(findEmbeddedInternalIdentifiers("承接 promise:5f6af0ca7b95 与 ch11 的余波")).toEqual(expect.arrayContaining(["promise:5f6af0ca7b95", "ch11"]));
    expect(findEmbeddedInternalIdentifiers("他在雨中的站台上等待那封没有拆开的信。")).toEqual([]);
    expect(findEmbeddedInternalIdentifiers("灵脉异变：从外门杂役到内门认可（第11章前后）")).toEqual([]);
  });

  it("normalizes thread responsibility aliases with the same canonical map", () => {
    expect(normalizeThreadResponsibilityReferences(
      [{ threadRef: "逃亡线", responsibility: "推进追捕压力", nextAdvance: "暴露落脚点" }],
      [{ id: "thread:escape", labels: ["逃亡线"] }],
    )).toEqual([{ threadRef: "thread:escape", responsibility: "推进追捕压力", nextAdvance: "暴露落脚点" }]);
    expect(() => normalizeThreadResponsibilityReferences(
      [{ threadRef: "共同别名" }],
      [{ id: "thread:a", labels: ["共同别名"] }, { id: "thread:b", labels: ["共同别名"] }],
    )).toThrow(/匹配多个对象/);
  });

  it("keeps narrative rhythm SQL executable without a dangling select comma", () => {
    const query = buildNarrativeRhythmSnapshotQuery();
    expect(query).toContain("FROM chapters target");
    expect(query).not.toMatch(/chapter_payload,\s*FROM/iu);
  });
});

describe("story arc batch reconciliation integration", () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  let projectId: string;
  let arcId: string;

  beforeAll(async () => {
    projectId = `test-story-arc-integrity-${randomUUID().slice(0, 8)}`;
    arcId = `arc-${projectId}`;
    try {
      repository = new NovelPostgresRepository(testDatabaseUrl);
      await repository.migrate();
      await repository.ensureProject(projectId, "Story arc integrity test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'测试弧',1,'approved','active','{"title":"测试弧","objective":"测试创作目的"}'::jsonb)`,
        [arcId, `volume-${projectId}`, projectId],
      );
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error; // 审核 S4/B#1：连接面失败静默=整块零断言假绿
      console.warn(`[story-arc-integrity.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available && repository) await repository.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("does not reconcile an approved retry after a failed historical batch", async () => {
    if (!available || !repository) return;

    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);

    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$3,$4,1,1,6,'failed','{}'::jsonb),
             ($2,$3,$4,2,1,6,'approved','{}'::jsonb)`,
      [`batch-failed-${projectId}`, `batch-retry-${projectId}`, arcId, projectId],
    );

    const result = await repository.reconcileStoryArcBatchRanges(projectId, arcId);
    expect(result.reconciled).toEqual([]);
    const batch = await repository.pool.query<{ status: string }>("SELECT status FROM story_arc_batches WHERE id=$1", [`batch-retry-${projectId}`]);
    expect(batch.rows[0].status).toBe("approved");
  });

  it("compares later batches with the last surviving range after an empty overlap is failed", async () => {
    if (!available || !repository) return;

    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$4,$5,1,1,5,'approved','{}'::jsonb),
             ($2,$4,$5,2,4,6,'approved','{}'::jsonb),
             ($3,$4,$5,3,6,8,'approved','{}'::jsonb)`,
      [`batch-base-${projectId}`, `batch-overlap-${projectId}`, `batch-later-${projectId}`, arcId, projectId],
    );

    const result = await repository.reconcileStoryArcBatchRanges(projectId, arcId);
    expect(result.reconciled).toEqual([2]);
    const batches = await repository.pool.query<{ batch_index: number; status: string }>(
      "SELECT batch_index,status FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index",
      [arcId],
    );
    expect(batches.rows).toEqual([
      { batch_index: 1, status: "approved" },
      { batch_index: 2, status: "failed" },
      { batch_index: 3, status: "approved" },
    ]);
  });

  it("complete 旗回补双向：满覆盖 false→true、谎报 true→false、无声明弧不动、幂等复跑零行（弧5 实践批派生口径）", async () => {
    if (!available || !repository) return;
    const pool = repository.pool;
    await pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await pool.query("DELETE FROM chapters WHERE arc_id=$1", [arcId]);
    await pool.query("UPDATE arcs SET payload = jsonb_set(payload,'{expectedChapterCount}','3') WHERE id=$1", [arcId]);
    await pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$3,$4,1,1,2,'approved','{"complete":false}'::jsonb),
              ($2,$3,$4,2,3,3,'approved','{"complete":false}'::jsonb)`,
      [`batch-mid-${projectId}`, `batch-last-${projectId}`, arcId, projectId],
    );
    await pool.query(
      `INSERT INTO chapters(id,arc_id,project_id,title,ordinal,status,payload,batch_id,batch_index)
       VALUES($1,$3,$4,'一',1,'planned','{}'::jsonb,$5,1),($2,$3,$4,'二',2,'planned','{}'::jsonb,$5,1),($6,$3,$4,'三',3,'planned','{}'::jsonb,$7,2)`,
      [`ch-a-${projectId}`, `ch-b-${projectId}`, arcId, projectId, `batch-mid-${projectId}`, `ch-c-${projectId}`, `batch-last-${projectId}`],
    );
    expect(await repository.repairStoryArcBatchCompleteFlags()).toBeGreaterThanOrEqual(1);
    const flags = await pool.query<{ id: string; complete: string }>(
      "SELECT id, payload->>'complete' AS complete FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index", [arcId]);
    // 中间批不被回补（滚动批次恒 false 本就正确）；末批满覆盖翻 true。
    expect(flags.rows.map((row) => row.complete)).toEqual(["false", "true"]);
    // 谎报反例：expected 抬到 5（3/5 覆盖）→ 末批 true 必须被翻回 false。
    await pool.query("UPDATE arcs SET payload = jsonb_set(payload,'{expectedChapterCount}','5') WHERE id=$1", [arcId]);
    expect(await repository.repairStoryArcBatchCompleteFlags()).toBeGreaterThanOrEqual(1);
    const refilled = await pool.query<{ complete: string }>("SELECT payload->>'complete' AS complete FROM story_arc_batches WHERE id=$1", [`batch-last-${projectId}`]);
    expect(refilled.rows[0].complete).toBe("false");
    // 无声明旧弧不动：expected 归 0，即便 3/3 覆盖也不发明事实；复跑状态幂等。
    await pool.query("UPDATE arcs SET payload = payload - 'expectedChapterCount' WHERE id=$1", [arcId]);
    await repository.repairStoryArcBatchCompleteFlags();
    const legacyFlags = await pool.query<{ complete: string; id: string }>("SELECT id, payload->>'complete' AS complete FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index", [arcId]);
    expect(legacyFlags.rows.map((row) => row.complete)).toEqual(["false", "false"]);
    await pool.query("DELETE FROM chapters WHERE arc_id=$1", [arcId]);
    await pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
  });

  it("retains a wider surviving range when a nested active batch is encountered", async () => {
    if (!available || !repository) return;

    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$4,$5,1,1,10,'approved','{}'::jsonb),
             ($2,$4,$5,2,3,4,'awaiting-review','{}'::jsonb),
             ($3,$4,$5,3,5,6,'approved','{}'::jsonb)`,
      [`batch-wide-${projectId}`, `batch-nested-${projectId}`, `batch-later-nested-${projectId}`, arcId, projectId],
    );

    const result = await repository.reconcileStoryArcBatchRanges(projectId, arcId);
    expect(result.reconciled).toEqual([3]);
    const batches = await repository.pool.query<{ batch_index: number; status: string }>(
      "SELECT batch_index,status FROM story_arc_batches WHERE arc_id=$1 ORDER BY batch_index",
      [arcId],
    );
    expect(batches.rows).toEqual([
      { batch_index: 1, status: "approved" },
      { batch_index: 2, status: "awaiting-review" },
      { batch_index: 3, status: "failed" },
    ]);
  });

  it("recovers a failed arc without a pending batch through rebase preparation", async () => {
    if (!available || !repository) return;

    const blueprintId = `blueprint-rebase-${projectId}`;
    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint)
       VALUES($1,$2,'rebase-test:artifact','attempt','chapter-blueprint','test-hash',0,'test-fingerprint')`,
      [blueprintId, projectId],
    );
    await repository.pool.query(
      `UPDATE arcs SET planning_status='failed', blueprint_artifact_id=$2, payload=payload || '{"failureReason":"audit failed"}'::jsonb WHERE id=$1`,
      [arcId, blueprintId],
    );

    const recovered = await repository.prepareStoryArcRebase(projectId, arcId, "test");
    if (!recovered) throw new Error("rebase preparation returned no arc");
    expect(recovered.planningStatus).toBe("awaiting-review");
    expect(recovered.blueprintArtifactId).toBe(blueprintId);
    const row = await repository.pool.query<{ planning_status: string; blueprint_artifact_id: string | null; failure_reason: boolean }>(
      `SELECT planning_status, blueprint_artifact_id, payload ? 'failureReason' AS failure_reason FROM arcs WHERE id=$1`,
      [arcId],
    );
    expect(row.rows[0]).toMatchObject({ planning_status: "awaiting-review", blueprint_artifact_id: blueprintId, failure_reason: false });
  });

  it("keeps review retry and rebase preparation mutually exclusive on a failed arc", async () => {
    if (!available || !repository) return;

    const blueprintId = `blueprint-retry-${projectId}`;
    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint)
       VALUES($1,$2,'retry-test:artifact','attempt','chapter-blueprint','test-hash',0,'test-fingerprint')`,
      [blueprintId, projectId],
    );

    // 场景 A：failed + 无 awaiting-review 批次 → retry 拒绝（死锁场景），rebase 允许恢复。
    await repository.pool.query(`UPDATE arcs SET planning_status='failed', blueprint_artifact_id=$2 WHERE id=$1`, [arcId, blueprintId]);
    await expect(repository.prepareStoryArcReviewRetry(projectId, arcId, "test")).rejects.toThrow("故事弧没有可重试的审核蓝图");
    const rebased = await repository.prepareStoryArcRebase(projectId, arcId, "test");
    if (!rebased) throw new Error("rebase preparation returned no arc");
    expect(rebased.planningStatus).toBe("awaiting-review");

    // 场景 B：failed + 有引用同一蓝图的 awaiting-review 批次 → retry 允许（审核中断重审），rebase 拒绝（不误入重基线）。
    await repository.pool.query(`UPDATE arcs SET planning_status='failed' WHERE id=$1`, [arcId]);
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,payload)
       VALUES($1,$2,$3,1,1,6,'awaiting-review',$4,'{}'::jsonb)`,
      [`batch-retry-${projectId}`, arcId, projectId, blueprintId],
    );
    await expect(repository.prepareStoryArcRebase(projectId, arcId, "test")).rejects.toThrow("故事弧没有可重基线的失败蓝图");
    const retried = await repository.prepareStoryArcReviewRetry(projectId, arcId, "test");
    if (!retried) throw new Error("retry preparation returned no arc");
    expect(retried.planningStatus).toBe("awaiting-review");
  });

  it("lets rebase recover a failed arc whose awaiting-review batch references a stale blueprint", async () => {
    if (!available || !repository) return;

    const currentBlueprintId = `blueprint-current-${projectId}`;
    const staleBlueprintId = `blueprint-stale-${projectId}`;
    await repository.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository.pool.query(
      `INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,base_revision,fingerprint)
       VALUES($1,$2,'stale-test:current','attempt','chapter-blueprint','test-hash',0,'test-fingerprint'),
             ($3,$2,'stale-test:stale','attempt','chapter-blueprint','test-hash',0,'test-fingerprint')`,
      [currentBlueprintId, projectId, staleBlueprintId],
    );

    // 场景 C：failed + awaiting-review 批次引用旧蓝图（source_artifact_id <> blueprint_artifact_id）：
    // retry 因引用不匹配拒绝，rebase 因"无引用当前蓝图的待审批次"允许恢复——闭合 retry/rebase
    // 前置条件互斥留下的死锁边角（此前该状态两个恢复路径都拒绝，弧永久卡在 failed）。
    await repository.pool.query(
      `UPDATE arcs SET planning_status='failed', blueprint_artifact_id=$2 WHERE id=$1`,
      [arcId, currentBlueprintId],
    );
    await repository.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,source_artifact_id,payload)
       VALUES($1,$2,$3,1,1,6,'awaiting-review',$4,'{}'::jsonb)`,
      [`batch-stale-${projectId}`, arcId, projectId, staleBlueprintId],
    );
    await expect(repository.prepareStoryArcReviewRetry(projectId, arcId, "test")).rejects.toThrow("故事弧没有可重试的审核蓝图");
    const recovered = await repository.prepareStoryArcRebase(projectId, arcId, "test");
    if (!recovered) throw new Error("rebase preparation returned no arc");
    expect(recovered.planningStatus).toBe("awaiting-review");
    expect(recovered.blueprintArtifactId).toBe(currentBlueprintId);
  });
});

describe("story arc reference normalization integration (PL-2)", () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  let projectId: string;
  let arcId: string;

  const fullArc = (threadRefs: string[]) => JSON.stringify({
    title: "测试弧", objective: "目的", entryState: "入", centralConflict: "争", development: ["a"], resolution: "解", exitState: "出",
    threadResponsibilities: threadRefs.map((threadRef) => ({ threadRef, responsibility: "推进", nextAdvance: "下一步" })),
    foreshadowingRefs: [], expectedChapterCount: 3, phases: [{ title: "阶段", objective: "目标" }],
  });
  const setArc = async (threadRefs: string[]) => {
    await repository!.pool.query("UPDATE arcs SET payload=$2::jsonb WHERE id=$1", [arcId, fullArc(threadRefs)]);
  };
  const threadCount = async () => Number((await repository!.pool.query<{ c: number }>("SELECT count(*)::int AS c FROM plot_threads WHERE project_id=$1", [projectId])).rows[0].c);

  beforeAll(async () => {
    projectId = `test-arc-normalize-${randomUUID().slice(0, 8)}`;
    arcId = `arc-${projectId}`;
    try {
      repository = new NovelPostgresRepository(testDatabaseUrl);
      await repository.migrate();
      await repository.ensureProject(projectId, "Arc normalize test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'测试弧',1,'draft','active','{}'::jsonb)`,
        [arcId, `volume-${projectId}`, projectId],
      );
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error; // 审核 S4/B#1：连接面失败静默=整块零断言假绿
      console.warn(`[story-arc-integrity.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available && repository) await repository.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("rejects unresolvable references instead of silently creating shadow objects", async () => {
    if (!available || !repository) return;
    await setArc(["一条从未登记过的线"]);
    await expect(repository.normalizeStoryArcReferences(projectId, arcId)).rejects.toThrow(/无法解析/);
    expect(await threadCount()).toBe(0);
  });

  it("self-heals a compound '<id> <name>' reference onto its canonical id without duplicating the thread", async () => {
    if (!available || !repository) return;
    const realId = canonicalReferenceId("thread", projectId, "主角觉醒线");
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,'主角觉醒线','open','{}'::jsonb)", [realId, projectId]);
    await setArc([`${realId} 主角觉醒`]);
    const normalized = await repository.normalizeStoryArcReferences(projectId, arcId);
    expect(normalized.arc!.arc.threadResponsibilities[0].threadRef).toBe(realId);
    expect(normalized.created).toEqual([]);
    expect(normalized.mappings[0]).toMatchObject({ created: false, canonicalId: realId });
    expect(await threadCount()).toBe(1);
  });

  it("creates through the explicit new channel and health distinguishes newly-created from existing", async () => {
    if (!available || !repository) return;
    await setArc(["主角觉醒线", "new:外部调查线"]);
    const normalized = await repository.normalizeStoryArcReferences(projectId, arcId);
    const newId = canonicalReferenceId("thread", projectId, "外部调查线");
    expect(normalized.created).toEqual([newId]);
    const createdRow = await repository.pool.query<{ title: string; payload: { source?: string; explicitNew?: boolean } }>("SELECT title,payload FROM plot_threads WHERE id=$1", [newId]);
    expect(createdRow.rows[0]).toMatchObject({ title: "外部调查线", payload: { source: "story-arc-reference", explicitNew: true } });
    const health = await repository.getArchitectureHealth(projectId);
    const report = health.references.find((item: { arcId: string }) => item.arcId === arcId)!;
    expect(report.plotThreads.resolvedExisting).toBe(1);
    expect(report.plotThreads.resolvedNewlyCreated).toBe(1);
  });

  it("threads claim ledger foreshadowings explicitly: binds, refuses out-of-ledger claims, leaves multi-claim unbound", async () => {
    if (!available || !repository) return;
    const threadA = canonicalReferenceId("thread", projectId, "铜镜承担线");
    const threadB = canonicalReferenceId("thread", projectId, "笔迹承担线");
    const inLedger = canonicalReferenceId("foreshadowing", projectId, "井底铜镜泛潮");
    const outOfLedger = canonicalReferenceId("foreshadowing", projectId, "未入账的伏笔");
    await repository.pool.query(
      "INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,'铜镜承担线','open','{}'::jsonb),($3,$2,'笔迹承担线','open','{}'::jsonb)",
      [threadA, projectId, threadB],
    );
    await repository.pool.query(
      "INSERT INTO foreshadowing(id,project_id,status,payload,narrative_order) VALUES($1,$2,'open',$3,9),($4,$2,'open',$5,9)",
      [inLedger, projectId, { description: "井底铜镜泛潮" }, outOfLedger, { description: "未入账的伏笔" }],
    );
    const setAttributedArc = async (claims: Array<{ thread: string; refs?: string[] }>) => {
      const payload = {
        title: "测试弧", objective: "目的", entryState: "入", centralConflict: "争", development: ["a"], resolution: "解", exitState: "出",
        threadResponsibilities: claims.map((claim) => ({ threadRef: claim.thread, responsibility: "推进", nextAdvance: "下一步", ...(claim.refs?.length ? { foreshadowingRefs: claim.refs } : {}) })),
        foreshadowingRefs: [inLedger], expectedChapterCount: 3, phases: [{ title: "阶段", objective: "目标" }],
      };
      await repository!.pool.query("UPDATE arcs SET payload=$2::jsonb WHERE id=$1", [arcId, JSON.stringify(payload)]);
    };
    const resetBindings = async () => { await repository!.pool.query("UPDATE foreshadowing SET thread_id=NULL WHERE project_id=$1", [projectId]); };
    const boundThread = async (foreshadowingId: string) => (await repository!.pool.query<{ thread_id: string | null }>("SELECT thread_id FROM foreshadowing WHERE id=$1", [foreshadowingId])).rows[0]?.thread_id ?? null;

    await setAttributedArc([{ thread: "铜镜承担线", refs: [inLedger] }, { thread: "笔迹承担线" }]);
    await resetBindings();
    await repository.normalizeStoryArcReferences(projectId, arcId);
    expect(await boundThread(inLedger)).toBe(threadA);

    await setAttributedArc([{ thread: "铜镜承担线", refs: [outOfLedger] }, { thread: "笔迹承担线" }]);
    await resetBindings();
    await expect(repository.normalizeStoryArcReferences(projectId, arcId)).rejects.toThrow(/本弧伏笔账之外/);
    expect(await boundThread(outOfLedger)).toBeNull();
    expect(await boundThread(inLedger)).toBeNull();

    await setAttributedArc([{ thread: "铜镜承担线", refs: [inLedger] }, { thread: "笔迹承担线", refs: [inLedger] }]);
    await resetBindings();
    await repository.normalizeStoryArcReferences(projectId, arcId);
    expect(await boundThread(inLedger)).toBeNull();
    const audit = await repository.pool.query<{ payload: { threadBindingAmbiguous?: string[] } }>(
      "SELECT payload FROM audit_records WHERE project_id=$1 AND action='story-arc.references-normalized' ORDER BY id DESC LIMIT 1", [projectId]);
    expect(audit.rows[0]?.payload.threadBindingAmbiguous).toEqual([inLedger]);

    // 零回归面：无认领信息时旧兜底语义不变——多线程弧不绑，单线程弧照旧绑。
    await setAttributedArc([{ thread: "铜镜承担线" }, { thread: "笔迹承担线" }]);
    await resetBindings();
    await repository.normalizeStoryArcReferences(projectId, arcId);
    expect(await boundThread(inLedger)).toBeNull();
    await setAttributedArc([{ thread: "铜镜承担线" }]);
    await resetBindings();
    await repository.normalizeStoryArcReferences(projectId, arcId);
    expect(await boundThread(inLedger)).toBe(threadA);
    await resetBindings();
  });

  it("health 消费面：声明情感契约而整弧无承载章时报警，补一章 payoff 即消（D5）", async () => {
    if (!available || !repository) return;
    // 载荷形态照运行库实形：契约字段在 structuredData 下（foundation 契约校验的位置），
    // 简报投影另有一份；顶层没有。曾按顶层键取值 ⇒ 真实项目上 declared 恒 false，
    // 判据静默空转，而同形自造夹具的测试照样绿——夹具照实现写不照库写，就是这个坑。
    const sectionPayload = { creativeBrief: { emotionalContract: "让读者在每一次退让里看见他没退的那部分" }, structuredData: { emotionalContract: "让读者看见他没退的那部分" } };
    await repository.pool.query(
      "INSERT INTO project_plan_sections(project_id,task_key,status,payload) VALUES($1,'project-positioning','approved',$2)",
      [projectId, sectionPayload],
    );
    const chapterIds = [`ch-emc-a-${randomUUID().slice(0, 8)}`, `ch-emc-b-${randomUUID().slice(0, 8)}`];
    const functions = ["development", "confrontation"];
    for (const [index, id] of chapterIds.entries()) {
      await repository.pool.query(
        "INSERT INTO chapters(id,arc_id,project_id,title,ordinal,status,payload) VALUES($1,$2,$3,$4,$5,'planned',$6)",
        [id, arcId, projectId, `契约核对章 ${index + 1}`, 900 + index, { narrativeFunction: functions[index] }],
      );
    }
    try {
      const carrierMissing = async () => (await repository!.getArchitectureHealth(projectId)).issues
        .some((issue: { code: string; reference?: string }) => issue.code === "emotional-carrier-missing" && issue.reference === arcId);
      expect(await carrierMissing()).toBe(true);
      await repository.pool.query(`UPDATE chapters SET payload=jsonb_set(payload,'{narrativeFunction}','"payoff"') WHERE id=$1`, [chapterIds[1]]);
      expect(await carrierMissing()).toBe(false);
    } finally {
      await repository.pool.query("DELETE FROM chapters WHERE id = ANY($1::text[])", [chapterIds]);
      await repository.pool.query("DELETE FROM project_plan_sections WHERE project_id=$1 AND task_key='project-positioning'", [projectId]);
    }
  });

  it("health 消费面：pending 投影失败按整账计数、明细只取最旧一页（F3）", async () => {
    if (!available || !repository) return;
    // 提交链路把投影失败记进 projection_failures 后继续走；这张账此前无任何 SELECT 消费者，
    // "可重放"因此等于"永久静默丢账"。可见性判据要同时满足两件事：整账真数、明细不截断计数。
    const marker = randomUUID().slice(0, 8);
    const aggregateIds = Array.from({ length: 21 }, (_, index) => `projection-${marker}-${index}`);
    const clear = () => repository!.pool.query("DELETE FROM projection_failures WHERE project_id=$1 AND aggregate_id = ANY($2::text[])", [projectId, aggregateIds]);
    for (const [index, aggregateId] of aggregateIds.entries()) {
      await repository.recordProjectionFailure({ projectId, projectionType: "narrative-elements", aggregateId, payload: { marker }, error: `stub 失败 ${index}` });
    }
    try {
      const reported = async () => (await repository!.getArchitectureHealth(projectId)).issues
        .some((issue: { code: string; reference?: string }) => issue.code === "projection-failure-pending" && issue.reference === `narrative-elements:${aggregateIds[0]}`);
      expect(await reported()).toBe(true);
      const health = await repository.getArchitectureHealth(projectId);
      // 21 条 > 明细页 20 ⇒ pending 必须是 21（把页当账时这里是 20），且明细取最旧优先
      expect(health.projectionFailures.pending).toBe(21);
      expect(health.projectionFailures.details).toHaveLength(20);
      expect(health.projectionFailures.details[0].aggregateId).toBe(aggregateIds[0]);
      expect(health.projectionFailures.oldestAt).toBeDefined();
      await clear();
      expect(await reported()).toBe(false);
      expect((await repository.getArchitectureHealth(projectId)).projectionFailures.pending).toBe(0);
    } finally {
      await clear();
    }
  });

  it("flags thread titles carrying embedded machine identifiers so health stops blessing shadows", async () => {
    if (!available || !repository) return;
    await repository.pool.query(
      "INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{}'::jsonb)",
      [`thread:${projectId}:f00dfeeddeadbeef`, projectId, `thread:other:abc123def456 影子线`],
    );
    const health = await repository.getArchitectureHealth(projectId);
    expect(health.issues.some((issue: { code: string; reference?: string }) => issue.code === "embedded-identifier" && issue.reference === `thread:${projectId}:f00dfeeddeadbeef`)).toBe(true);
  });

  it("redirects shadow-id references onto real ids and drops the shadow rows idempotently (PL-2 stock repair)", async () => {
    if (!available || !repository) return;
    const realId = canonicalReferenceId("thread", projectId, "外门压制线");
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,'外门压制线','open','{}'::jsonb)", [realId, projectId]);
    // 旧 auto-create 年代的影子行：title 是 `<真实id> <slug>` 复合串。
    const shadowId = canonicalReferenceId("thread", projectId, `${realId} 外门压制`);
    await repository.pool.query(
      "INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)",
      [shadowId, projectId, `${realId} 外门压制`],
    );
    await setArc([shadowId, `${realId} 外门压制线`]);

    const first = await repository.repairStoryArcReferenceHygiene();
    expect(first.deletedShadows).toContain(shadowId);
    const repaired = await repository.getStoryArc(projectId, arcId);
    expect(repaired!.arc.threadResponsibilities.map((responsibility) => responsibility.threadRef)).toEqual([realId]);
    const survivors = await repository.pool.query<{ c: number }>("SELECT count(*)::int AS c FROM plot_threads WHERE id=$1", [shadowId]);
    expect(survivors.rows[0].c).toBe(0);

    // 幂等：影子清空后第二次运行是无操作。
    const second = await repository.repairStoryArcReferenceHygiene();
    expect(second.deletedShadows).toEqual([]);
    expect(second.rewrittenArcs).toEqual([]);
  });

  it("resolves chained shadows transitively so redirects never land on deleted rows (arc4 root cause)", async () => {
    if (!available || !repository) return;
    const realId = canonicalReferenceId("thread", projectId, "宗门压制线");
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,'宗门压制线','open','{}'::jsonb)", [realId, projectId]);
    // 第二代影子：title 嵌真身 id。
    const shadowB = canonicalReferenceId("thread", projectId, `${realId} 压制分线`);
    await repository.pool.query(
      "INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)",
      [shadowB, projectId, `${realId} 压制分线`],
    );
    // 第一代影子：title 嵌影子 B 的 id——影子指向影子，只走一跳会落在被删行上。
    const shadowA = canonicalReferenceId("thread", projectId, `${shadowB} 底层压力`);
    await repository.pool.query(
      "INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)",
      [shadowA, projectId, `${shadowB} 底层压力`],
    );
    await setArc([shadowA]);

    const repair = await repository.repairStoryArcReferenceHygiene();
    expect(repair.deletedShadows).toEqual(expect.arrayContaining([shadowA, shadowB]));
    const repaired = await repository.getStoryArc(projectId, arcId);
    // 断言收敛到真身 C 而非中间影子：这是生产路径 arc4 悬空引用的回归判据。
    expect(repaired!.arc.threadResponsibilities.map((responsibility) => responsibility.threadRef)).toEqual([realId]);
    const health = await repository.getArchitectureHealth(projectId);
    expect(health.issues.some((issue: { code: string }) => issue.code === "unknown-reference")).toBe(false);
  });

  // 审核 B#5：重放面三个反例——此前只有"能解析"的正向面，把 cycle-skip 或
  // only-delete-resolved 删掉全套仍绿；这三个用例锁住"解析不了就不许动"。
  it("leaves a cyclic shadow pair untouched (no trusted landing point, keep for human)", async () => {
    if (!available || !repository) return;
    const idA = `thread:${projectId}:cyc-a00000001`;
    const idB = `thread:${projectId}:cyc-b00000002`;
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)", [idA, projectId, `${idB} 环甲`]);
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)", [idB, projectId, `${idA} 环乙`]);
    await setArc([idA]);

    const repair = await repository.repairStoryArcReferenceHygiene();
    expect(repair.deletedShadows).not.toContain(idA);
    expect(repair.deletedShadows).not.toContain(idB);
    const kept = await repository.getStoryArc(projectId, arcId);
    expect(kept!.arc.threadResponsibilities.map((r) => r.threadRef)).toEqual([idA]); // 环无落点，引用不许漂移
    const survivors = await repository.pool.query<{ c: number }>("SELECT count(*)::int AS c FROM plot_threads WHERE id=ANY($1)", [[idA, idB]]);
    expect(survivors.rows[0].c).toBe(2);
    // 反例的另一半：环不能吞掉同项目里可解析的正常影子。
    const realOk = canonicalReferenceId("thread", projectId, "环侧正常线");
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,'环侧正常线','open','{}'::jsonb)", [realOk, projectId]);
    const shadowOk = canonicalReferenceId("thread", projectId, `${realOk} 环侧影子`);
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)", [shadowOk, projectId, `${realOk} 环侧影子`]);
    await setArc([shadowOk]);
    const second = await repository.repairStoryArcReferenceHygiene();
    expect(second.deletedShadows).toContain(shadowOk);
    const healed = await repository.getStoryArc(projectId, arcId);
    expect(healed!.arc.threadResponsibilities.map((r) => r.threadRef)).toEqual([realOk]);
  });

  it("keeps a shadow whose embedded token names no row (unresolvable is not resolvable-by-guess)", async () => {
    if (!available || !repository) return;
    const ghost = `thread:${projectId}:g0st00000000`;
    const orphanShadow = `thread:${projectId}:orph0000001`;
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)", [orphanShadow, projectId, `${ghost} 无主影子`]);
    await setArc([orphanShadow]);
    const repair = await repository.repairStoryArcReferenceHygiene();
    expect(repair.deletedShadows).not.toContain(orphanShadow);
    const kept = await repository.getStoryArc(projectId, arcId);
    expect(kept!.arc.threadResponsibilities.map((r) => r.threadRef)).toEqual([orphanShadow]);
    const still = await repository.pool.query<{ c: number }>("SELECT count(*)::int AS c FROM plot_threads WHERE id=$1", [orphanShadow]);
    expect(still.rows[0].c).toBe(1);
  });

  it("replays audit history to fix refs redirected onto already-deleted shadows", async () => {
    if (!available || !repository) return;
    const realId = canonicalReferenceId("thread", projectId, "历史重放线");
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,'历史重放线','open','{}'::jsonb)", [realId, projectId]);
    const shadowId = canonicalReferenceId("thread", projectId, `${realId} 历史重放`);
    await repository.pool.query("INSERT INTO plot_threads(id,project_id,title,status,payload) VALUES($1,$2,$3,'open','{\"source\":\"story-arc-reference\"}'::jsonb)", [shadowId, projectId, `${realId} 历史重放`]);
    await setArc([shadowId]);
    const first = await repository.repairStoryArcReferenceHygiene();
    expect(first.deletedShadows).toContain(shadowId); // 影子被删，audit 记下映射

    // 模拟单跳重定向年代的残局：弧 payload 又指回已删影子（活行检测永远看不见它）。
    await setArc([shadowId]);
    const before = await repository.getStoryArc(projectId, arcId);
    expect(before!.arc.threadResponsibilities.map((r) => r.threadRef)).toEqual([shadowId]);
    const replay = await repository.repairStoryArcReferenceHygiene();
    expect(replay.deletedShadows).not.toContain(shadowId); // 行已不在，无删除可言
    const after = await repository.getStoryArc(projectId, arcId);
    expect(after!.arc.threadResponsibilities.map((r) => r.threadRef)).toEqual([realId]); // 靠历史映射修复悬空
    const health = await repository.getArchitectureHealth(projectId);
    expect(health.issues.some((issue: { code: string; reference?: string }) => issue.code === "unknown-reference" && issue.reference === shadowId)).toBe(false);
  });
});

describe("story arc completion predicate integration (PL-1)", () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  let projectId: string;
  let arcId: string;

  const setPlan = async (expected: number) => {
    await repository!.pool.query(
      "UPDATE arcs SET payload=jsonb_set(payload::jsonb,'{expectedChapterCount}',to_jsonb($2::int)) WHERE id=$1",
      [arcId, expected],
    );
  };
  const seedFinalChapter = async (ordinal: number) => {
    const documentId = `doc-${ordinal}`;
    const revisionId = `rev-${ordinal}`;
    const hash = `hash-pl1-${ordinal}`;
    // content_blobs 主键全局（跨项目 content_hash）：B#1 实锤——本项目第二次跑
    // migrate 种子时此 INSERT pkey 冲突，异常被 beforeAll 吞掉 → PL-1 三个用例
    // 零断言"通过"。内容寻址表的正确幂等语义就是 DO NOTHING。
    await repository!.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,10) ON CONFLICT(content_hash) DO NOTHING", [hash, `objects/${hash}`]);
    await repository!.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,pov_character_id,status) VALUES($1,$2,$3,$4,NULL,'final')", [documentId, projectId, `第${ordinal}章`, ordinal]);
    await repository!.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, projectId, documentId, hash]);
    await repository!.pool.query("UPDATE manuscript_documents SET current_revision_id=$2 WHERE id=$1", [documentId, revisionId]);
    await repository!.pool.query("INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,batch_index) VALUES($1,$2,$3,$4,$5,$6,'drafted',1)", [`ch-${ordinal}`, arcId, projectId, documentId, `第${ordinal}章`, ordinal]);
  };
  const setBatch = async (complete: boolean) => {
    await repository!.pool.query("DELETE FROM story_arc_batches WHERE arc_id=$1", [arcId]);
    await repository!.pool.query(
      `INSERT INTO story_arc_batches(id,arc_id,project_id,batch_index,start_chapter_index,end_chapter_index,status,payload)
       VALUES($1,$2,$3,1,8,15,'approved',$4::jsonb)`,
      [`batch-pl1-${arcId}`, arcId, projectId, JSON.stringify({ complete })],
    );
  };
  const runCompletionRepair = () => (repository as unknown as { repairCompletedStoryArcStatuses(): Promise<number> }).repairCompletedStoryArcStatuses();
  const executionStatus = async () => String((await repository!.pool.query<{ execution_status: string }>("SELECT execution_status FROM arcs WHERE id=$1", [arcId])).rows[0].execution_status);

  beforeAll(async () => {
    projectId = `test-arc-completion-${randomUUID().slice(0, 8)}`;
    arcId = `arc-${projectId}`;
    try {
      repository = new NovelPostgresRepository(testDatabaseUrl);
      await repository.migrate();
      await repository.ensureProject(projectId, "Arc completion test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'完成判定弧',1,'approved','active','{"title":"完成判定弧","objective":"o","entryState":"","centralConflict":"","development":[],"resolution":"","exitState":"","threadResponsibilities":[],"foreshadowingRefs":[],"expectedChapterCount":15,"phases":[]}'::jsonb)`,
        [arcId, `volume-${projectId}`, projectId],
      );
      // 弧 2 形态复刻：全局章序窗口 8–15（8 章），期望按弧内应为 15。
      for (const ordinal of [8, 9, 10]) await seedFinalChapter(ordinal);
      await setBatch(false);
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error; // 审核 S4/B#1：连接面失败静默=整块零断言假绿
      console.warn(`[story-arc-integrity.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available && repository) await repository.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("keeps the arc active when local finalized chapters fall short even though the global window end equals the expectation", async () => {
    if (!available || !repository) return;
    await setPlan(15);
    await runCompletionRepair();
    // 旧谓词 end_chapter_index(15) >= expected(15) 会误置 completed；弧内实际只有 3 章。
    expect(await executionStatus()).toBe("active");
  });

  it("honors a human-declared complete batch over the count mismatch and leaves an audit trail", async () => {
    if (!available || !repository) return;
    await setBatch(true);
    await runCompletionRepair();
    expect(await executionStatus()).toBe("completed");
    const audit = await repository.pool.query<{ action: string }>("SELECT action FROM audit_records WHERE aggregate_id=$1 AND action='story-arc.completion-reconciled'", [arcId]);
    expect(audit.rowCount).toBeGreaterThan(0);
    // B1 诊断面：completed 但期望≠实际 → blocking issue 可见。
    const health = await repository.getArchitectureHealth(projectId);
    expect(health.issues.some((issue: { code: string }) => issue.code === "completion-count-mismatch")).toBe(true);
  });

  it("auto-completes once the local count reaches the corrected expectation", async () => {
    if (!available || !repository) return;
    await repository.pool.query("UPDATE arcs SET execution_status='active',completed_at=NULL WHERE id=$1", [arcId]);
    await setBatch(false);
    await setPlan(3);
    await runCompletionRepair();
    expect(await executionStatus()).toBe("completed");
  });
});

describe("PL-6 连载健康度与阶段绑定", () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";
  let repository: NovelPostgresRepository | undefined;
  let available = false;
  let projectId: string;
  let firstArcId: string;
  let secondArcId: string;

  const insertArc = async (id: string, ordinal: number, payload: Record<string, unknown>, approvedAt: string | null, completedAt: string | null) => {
    await repository!.pool.query(
      `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload,approved_at,completed_at)
       VALUES($1,$2,$3,$4,$5,'approved','completed',$6::jsonb,$7,$8)`,
      [id, `volume-${projectId}`, projectId, `弧${ordinal}`, ordinal, JSON.stringify(payload), approvedAt, completedAt],
    );
  };
  const arcPayload = (expected: number, phases: unknown[]) => ({ title: "弧", objective: "o", entryState: "", centralConflict: "", development: [], resolution: "", exitState: "", threadResponsibilities: [], foreshadowingRefs: [], expectedChapterCount: expected, phases });

  beforeAll(async () => {
    projectId = `test-pl6-${randomUUID().slice(0, 8)}`;
    firstArcId = `arc-a-${projectId}`;
    secondArcId = `arc-b-${projectId}`;
    try {
      repository = new NovelPostgresRepository(testDatabaseUrl);
      await repository.migrate();
      await repository.ensureProject(projectId, "PL-6 health test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      // 弧 1 收口 → 弧 2 批准间隔 20 天（> 周更基线）；弧 1 阶段有绑定，弧 2 无绑定。
      await insertArc(firstArcId, 1, arcPayload(3, [{ title: "起", objective: "o1", chapterOrdinals: [1, 2] }, { title: "收", objective: "o2", chapterOrdinals: [3] }]), "2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z");
      await insertArc(secondArcId, 2, arcPayload(2, [{ title: "潜入", objective: "o" }]), "2026-08-30T00:00:00Z", "2026-09-05T00:00:00Z");
      // 阈值反例（审核 B#7-serialization）：弧 3 批准距弧 2 收口仅 3 天（≤ 周更基线）——
      // 间隔台账照常记录，但 serialization-gap warning 判定必须把它挡在门外。
      await insertArc(`arc-c-${projectId}`, 3, arcPayload(2, []), "2026-09-08T00:00:00Z", "2026-09-12T00:00:00Z");
      await repository.pool.query(
        `INSERT INTO workflow_runs(id,workflow_type,project_id,temporal_workflow_id,status,payload)
         VALUES($1,'story-arc-planning',$2,$1,'failed','{}'),($3,'story-arc-planning',$2,$3,'completed','{}')`,
        [`run-fail-1-${projectId}`, projectId, `run-ok-1-${projectId}`],
      );
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error; // 审核 S4/B#1：连接面失败静默=整块零断言假绿
      console.warn(`[story-arc-integrity.test PL-6] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available && repository) await repository.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("health 暴露跨弧空窗天数、规划失败数与阶段绑定缺失", async () => {
    if (!available || !repository) return;
    const health = await repository.getArchitectureHealth(projectId);
    // gaps 是原始事实台账（所有相邻间隔），warning 判定面才是 >7d 周更基线：
    // 弧 3 的 3 天间隔必须记录但不升级 issue（阈值退化=本用例炸，审核 B#7）。
    expect(health.serialization.gaps).toEqual([
      { fromArcId: firstArcId, toArcId: secondArcId, gapDays: 20 },
      { fromArcId: secondArcId, toArcId: `arc-c-${projectId}`, gapDays: 3 },
    ]);
    expect(health.serialization.planningRunStatuses).toMatchObject({ failed: 1, completed: 1 });
    const codes = health.issues.map((issue) => issue.code);
    expect(codes).toContain("serialization-gap");
    expect(codes).toContain("arc-planning-failures");
    const gapIssues = health.issues.filter((issue) => issue.code === "serialization-gap");
    expect(gapIssues.map((issue) => issue.reference)).toEqual([secondArcId]); // 只有 20d 对升级；3d 对不报
    // 弧 2 有阶段但无绑定 → phase-binding-missing；弧 1 绑定完整不报。
    const binding = health.issues.find((issue) => issue.code === "phase-binding-missing");
    expect(binding?.reference).toBe(secondArcId);
    // 弧 1 completed 且期望=落籍？落籍 0 章 → completion-count-mismatch 也报（B1 通道独立存在）。
    expect(codes).toContain("completion-count-mismatch");
  });

  it("resolveArcPhase 只认绑定：命中返回阶段，未绑定/越界返回 undefined（宁缺毋伪）", async () => {
    const phases = [
      { title: "起", objective: "o1", chapterOrdinals: [1, 2] },
      { title: "收", objective: "o2", chapterOrdinals: [3] },
    ];
    expect(resolveArcPhase(phases, 1)?.title).toBe("起");
    expect(resolveArcPhase(phases, 2)?.title).toBe("起");
    expect(resolveArcPhase(phases, 3)?.title).toBe("收");
    expect(resolveArcPhase(phases, 4)).toBeUndefined();
    expect(resolveArcPhase(phases, 0)).toBeUndefined();
    expect(resolveArcPhase([{ title: "无绑定", objective: "o" }], 1)).toBeUndefined();
    expect(resolveArcPhase(undefined, 1)).toBeUndefined();
    // 反例：期望 15 实际 8 的弧形态——第 8 章不再被等分到"第 4 阶段"，未绑定即 undefined。
    expect(resolveArcPhase([{ title: "潜入", objective: "o" }], 8)).toBeUndefined();
  });

  it("parseStoryArcPlan 保留合法绑定、丢弃含非法项的绑定（错误绑定比没有更糟）", async () => {
    const parsed = parseStoryArcPlan({
      title: "弧", objective: "o", entryState: "", centralConflict: "", development: [], resolution: "", exitState: "",
      threadResponsibilities: [], foreshadowingRefs: [], expectedChapterCount: 3,
      phases: [
        { title: "起", objective: "a", chapterOrdinals: [2, 1, 1] },
        { title: "收", objective: "b", chapterOrdinals: [0, 3] },
        { title: "弃", objective: "c", chapterOrdinals: "not-array" },
      ],
    });
    expect(parsed.phases[0]).toMatchObject({ title: "起", chapterOrdinals: [1, 2] });
    expect(parsed.phases[1]?.chapterOrdinals).toBeUndefined();
    expect(parsed.phases[2]?.chapterOrdinals).toBeUndefined();
  });
});

describe("情感契约承载核对（D5，Batch 5）", () => {
  const arc = (chapters: Array<{ ordinal: number; narrativeFunction?: string }>) => [{ id: "arc-1", ordinal: 3, chapters }];

  it("声明了契约但整弧无 payoff/aftermath 章 → warning；有承载章或未声明则不报", () => {
    const escalated = auditEmotionalContractCarriage({
      emotionalContractDeclared: true,
      arcs: arc([{ ordinal: 21, narrativeFunction: "development" }, { ordinal: 22, narrativeFunction: "confrontation" }]),
    });
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ code: "emotional-carrier-missing", severity: "warning", reference: "arc-1" });
    expect(escalated[0]!.message).toContain("第 3 弧");

    expect(auditEmotionalContractCarriage({
      emotionalContractDeclared: true,
      arcs: arc([{ ordinal: 21, narrativeFunction: "development" }, { ordinal: 22, narrativeFunction: "payoff" }]),
    })).toEqual([]);
    expect(auditEmotionalContractCarriage({
      emotionalContractDeclared: true,
      arcs: arc([{ ordinal: 21, narrativeFunction: "aftermath" }]),
    })).toEqual([]);
    // 不发明要求：未声明契约、作者显式不适用（declared 由调用方按 notApplicable 折成 false）、
    // 弧尚未投影章节，三种输入一律不报。
    expect(auditEmotionalContractCarriage({ emotionalContractDeclared: false, arcs: arc([{ ordinal: 21, narrativeFunction: "setup" }]) })).toEqual([]);
    expect(auditEmotionalContractCarriage({ emotionalContractDeclared: true, arcs: arc([]) })).toEqual([]);
    // 章功能缺失（旧蓝图未填该字段）按"未指定"参与判定，不误判为已承载。
    const unspecified = auditEmotionalContractCarriage({ emotionalContractDeclared: true, arcs: arc([{ ordinal: 21 }]) });
    expect(unspecified).toHaveLength(1);
    expect(unspecified[0]!.message).toContain("未指定");
  });

  it("接线锁：承载判据用的章功能必须是规范枚举成员，且规范枚举新增不得自动成为承载章", async () => {
    const { CHAPTER_NARRATIVE_FUNCTIONS } = await import("../application/story-arc");
    for (const fn of EMOTIONAL_CONTRACT_CARRIER_FUNCTIONS) {
      expect(CHAPTER_NARRATIVE_FUNCTIONS).toContain(fn);
    }
    // 承载集合是显式选择（交付/承接两类），不是"全部非过渡章"的兜底：
    expect(EMOTIONAL_CONTRACT_CARRIER_FUNCTIONS.length).toBeLessThan(CHAPTER_NARRATIVE_FUNCTIONS.length);
  });
});

describe("伏笔归属按线程声明（PL-5④ 判据收口，2026-09-19）", () => {
  const THREAD_A = "thread:p:aaa";
  const THREAD_B = "thread:p:bbb";
  const FS_IN = "foreshadowing:p:in";
  const FS_OUT = "foreshadowing:p:out";

  it("认领弧账内引用才绑；账外报 violation；多线认领留 ambiguous 不绑", () => {
    expect(planThreadForeshadowingBindings({
      arcForeshadowingRefs: [FS_IN],
      responsibilities: [{ threadRef: THREAD_A, foreshadowingRefs: [FS_IN] }, { threadRef: THREAD_B }],
    })).toEqual({ bindings: [{ threadId: THREAD_A, foreshadowingIds: [FS_IN] }], violations: [], ambiguous: [] });

    const outOfLedger = planThreadForeshadowingBindings({
      arcForeshadowingRefs: [FS_IN],
      responsibilities: [{ threadRef: THREAD_A, foreshadowingRefs: [FS_OUT] }],
    });
    expect(outOfLedger.bindings).toEqual([]);
    expect(outOfLedger.violations).toEqual([{ threadRef: THREAD_A, input: FS_OUT }]);
    expect(outOfLedger.ambiguous).toEqual([]);

    const shared = planThreadForeshadowingBindings({
      arcForeshadowingRefs: [FS_IN],
      responsibilities: [{ threadRef: THREAD_A, foreshadowingRefs: [FS_IN] }, { threadRef: THREAD_B, foreshadowingRefs: [FS_IN] }],
    });
    expect(shared.bindings).toEqual([]);
    expect(shared.violations).toEqual([]);
    expect(shared.ambiguous).toEqual([FS_IN]);
    // 无认领信息（旧 planner 输出）不产生任何绑定计划——单线程兜底由调用方按其原语义处理。
    expect(planThreadForeshadowingBindings({ arcForeshadowingRefs: [FS_IN], responsibilities: [{ threadRef: THREAD_A }, { threadRef: THREAD_B }] }))
      .toEqual({ bindings: [], violations: [], ambiguous: [] });
  });

  it("外部编排与弧蓝图两面都解析该字段，旧载荷零回归；畸形输入抛回不静默吞", () => {
    const outline = parseStoryArcPlotOutline({
      objective: "本弧讲什么",
      threadResponsibilities: [
        { threadRef: "铜镜线", responsibility: "推进", nextAdvance: "下一步", foreshadowingRefs: [FS_IN] },
        { threadRef: "笔迹线", responsibility: "推进", nextAdvance: "下一步" },
      ],
    });
    expect(outline.threadResponsibilities?.[0]?.foreshadowingRefs).toEqual([FS_IN]);
    expect(outline.threadResponsibilities?.[1]?.foreshadowingRefs).toBeUndefined();
    expect(() => parseStoryArcPlotOutline({ objective: "o", centralConflict: "c", threadResponsibilities: [{ threadRef: "t", responsibility: "r", nextAdvance: "n", foreshadowingRefs: "不是数组" }] })).toThrow(/foreshadowingRefs/);
    expect(() => parseStoryArcPlotOutline({ objective: "o", centralConflict: "c", threadResponsibilities: [{ threadRef: "t", responsibility: "r", nextAdvance: "n", foreshadowingRefs: ["  "] }] })).toThrow(/foreshadowingRefs/);

    const bundle = parseStoryArcBundle({
      arc: { title: "t", objective: "o", threadResponsibilities: [{ threadRef: "铜镜线", responsibility: "r", nextAdvance: "n", foreshadowingRefs: [FS_IN] }], foreshadowingRefs: [FS_IN] },
      batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
      chapters: [{ title: "章", stateTransition: { before: "b", after: "a", evidence: "e" }, scenes: [{ title: "s", situation: "sit", observableActions: ["act"], outcome: "out" }] }],
    });
    expect(bundle.arc.threadResponsibilities[0]?.foreshadowingRefs).toEqual([FS_IN]);
    // 旧形态（无该字段）解析后不得凭空出现键
    expect(parseStoryArcPlan({ title: "t", objective: "o", threadResponsibilities: [{ threadRef: "t", responsibility: "r", nextAdvance: "n" }] }).threadResponsibilities[0]).not.toHaveProperty("foreshadowingRefs");
    // 编排注入规划上下文时归属声明必须可见，否则编排者的认领被静默丢弃
    expect(renderStoryArcPlotOutline(outline)).toContain(`本弧承担伏笔=${FS_IN}`);
  });

  it("接线锁：生成面 schema、外部工具 schema、repository 消费面三处同源", async () => {
    const planResponsibilities = (storyArcBundleSchema as unknown as {
      properties: { arc: { properties: { threadResponsibilities: { items: { properties: Record<string, unknown>; required: string[] } } } } };
    }).properties.arc.properties.threadResponsibilities.items;
    expect(Object.keys(planResponsibilities.properties)).toContain("foreshadowingRefs");
    // 原生结构化门（assertNativeJsonSchema）要求对象 properties 全部进 required，
    // "本条线不承担伏笔"因此以空数组表达而非省略字段。
    expect(planResponsibilities.required).toContain("foreshadowingRefs");

    // 2026-09-24 三批：编排入口并入 novel_story_arc_start（mode=orchestrated），外部面同源锁随迁
    const arcStart = TOOL_DEFINITIONS.find((tool) => tool.name === "novel_story_arc_start");
    const externalFace = (arcStart?.inputSchema as unknown as {
      properties: { plotOutline: { properties: { threadResponsibilities: { items: { properties: Record<string, unknown> } } } } };
    }).properties.plotOutline.properties.threadResponsibilities.items.properties;
    expect(Object.keys(externalFace)).toContain("foreshadowingRefs");

    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const repositorySource = readFileSync(fileURLToPath(new URL("../postgres-repository.ts", import.meta.url)), "utf8");
    expect(repositorySource.match(/planThreadForeshadowingBindings\(\{/g)?.length).toBe(1);
    // 兜底不得在无认领时抢绑（否则单值列被旧启发式覆写声明）
    expect(repositorySource).toContain("if (!threadBindings.bindings.length && arcThreadRefs.length === 1");
  });
});
