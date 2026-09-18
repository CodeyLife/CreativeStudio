import { randomUUID } from "node:crypto";
import { isPostgresUnavailable } from "./test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/**
 * findHistoricalBlueprintForDocument 回退链路回归：
 * intent 链路的 :draft artifact 被产物保留策略清理后，章节审校仍能经
 * execution_blueprints 行（payload 即 ExecutionBlueprint）反查启动。
 * 根因实例：项目运行中 10/15 章的 :draft artifact 不存在，preflight.hasBlueprint=false
 * 拒绝启动审校——已定稿章节永久失去重审入口。
 */
describe("historical blueprint fallback for chapter review", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-bp-fallback-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Blueprint Fallback Test");
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[blueprint-fallback.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  function makeBlueprint(documentId: string, preflightId: string) {
    return {
      id: `blueprint-${randomUUID()}`,
      projectId,
      intentId: `intent-${randomUUID()}`,
      preflightId,
      memoryBundleId: `memory-${randomUUID()}`,
      skillBundleId: `skills-${randomUUID()}`,
      baseRevision: 1,
      tasks: [],
      commitPolicy: "dual-gate" as const,
      budget: { maxInputTokens: 128_000, maxOutputTokens: 32_000 },
      fingerprint: `fp-${randomUUID()}`,
      createdAt: Date.now(),
      // documentId 只出现在 novel_intents.payload.target.id；夹具同形以便断言。
      documentIdForTest: documentId,
    };
  }

  it("falls back to execution_blueprints when the intent-chain draft artifact is missing", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    const intentId = `intent-${randomUUID()}`;
    const preflightId = `preflight-${randomUUID()}`;
    const blueprint = makeBlueprint(documentId, preflightId);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,1,'final')", [documentId, projectId, "回退蓝图章节"]);
    // novel_intents + execution_blueprints 就位，但【不】创建 :draft artifact（模拟被清理）。
    await repository.pool.query(
      "INSERT INTO novel_intents(id,project_id,source,objective,payload,idempotency_key) VALUES($1,$2,'chapter-generate',$3::text,$4::jsonb,$5)",
      [intentId, projectId, `章节生成：${documentId}`, JSON.stringify({ target: { kind: "chapter", id: documentId }, idempotencyKey: `k-${randomUUID()}` }), `k-${randomUUID()}`],
    );
    // preflight_id 与 intent_id 均有 FK，先落 novel_intents 再落 preflight_plans。
    await repository.pool.query("INSERT INTO preflight_plans(id,intent_id,project_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [preflightId, intentId, projectId, `pfp-${randomUUID()}`]);
    // memory/skill bundle 同样有 FK → preflight_plans。
    await repository.pool.query("INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [blueprint.memoryBundleId, projectId, preflightId, `mb-${randomUUID()}`]);
    await repository.pool.query("INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [blueprint.skillBundleId, projectId, preflightId, `sb-${randomUUID()}`]);
    await repository.pool.query(
      `INSERT INTO execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [blueprint.id, projectId, intentId, blueprint.preflightId, blueprint.memoryBundleId, blueprint.skillBundleId, JSON.stringify(blueprint), blueprint.fingerprint],
    );

    const record = await repository.findHistoricalBlueprintForDocument(projectId, documentId);
    expect(record).toBeDefined();
    expect(record?.blueprint.id).toBe(blueprint.id);
    expect(record?.blueprint.preflightId).toBe(blueprint.preflightId);
    expect(record?.blueprint.budget.maxOutputTokens).toBe(32_000);
    // 无 review-draft artifact 时 artifactId 回退为蓝图 id（仅审计溯源用途）。
    expect(record?.artifactId).toBe(blueprint.id);
  });

  it("prefers the intent-chain draft artifact when it still exists", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    const intentId = `intent-${randomUUID()}`;
    const preflightId = `preflight-${randomUUID()}`;
    const blueprint = makeBlueprint(documentId, preflightId);
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,2,'final')", [documentId, projectId, "首选路径章节"]);
    await repository.pool.query(
      "INSERT INTO novel_intents(id,project_id,source,objective,payload,idempotency_key) VALUES($1,$2,'chapter-generate',$3::text,$4::jsonb,$5)",
      [intentId, projectId, `章节生成：${documentId}`, JSON.stringify({ target: { kind: "chapter", id: documentId }, idempotencyKey: `k-${randomUUID()}` }), `k-${randomUUID()}`],
    );
    await repository.pool.query("INSERT INTO preflight_plans(id,intent_id,project_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [preflightId, intentId, projectId, `pfp-${randomUUID()}`]);
    await repository.pool.query("INSERT INTO memory_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [blueprint.memoryBundleId, projectId, preflightId, `mb-${randomUUID()}`]);
    await repository.pool.query("INSERT INTO skill_bundles(id,project_id,preflight_id,payload,fingerprint) VALUES($1,$2,$3,'{}'::jsonb,$4)", [blueprint.skillBundleId, projectId, preflightId, `sb-${randomUUID()}`]);
    await repository.pool.query(
      `INSERT INTO execution_blueprints(id,project_id,intent_id,preflight_id,memory_bundle_id,skill_bundle_id,payload,fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [blueprint.id, projectId, intentId, blueprint.preflightId, blueprint.memoryBundleId, blueprint.skillBundleId, JSON.stringify(blueprint), blueprint.fingerprint],
    );
    const draftId = `draft-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO artifacts(id,project_id,task_id,attempt_id,kind,content_hash,object_key,base_revision,fingerprint,payload) VALUES($1,$2,$3,$4,'draft',$5,$6,0,$7,'{}'::jsonb)",
      [draftId, projectId, `${blueprint.id}:draft`, `attempt-${randomUUID()}`, `hash-${randomUUID()}`, `test/${draftId}`, `fp-${randomUUID()}`],
    );

    const record = await repository.findHistoricalBlueprintForDocument(projectId, documentId);
    expect(record?.artifactId).toBe(draftId);
    expect(record?.blueprint.id).toBe(blueprint.id);
  });

  it("returns undefined when neither draft artifact nor blueprint row exists", async () => {
    if (!available) return;
    const documentId = `document-${randomUUID()}`;
    await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,3,'final')", [documentId, projectId, "无蓝图章节"]);
    const record = await repository.findHistoricalBlueprintForDocument(projectId, documentId);
    expect(record).toBeUndefined();
  });
});