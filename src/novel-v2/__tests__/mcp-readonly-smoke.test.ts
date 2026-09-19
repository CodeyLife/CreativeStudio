/**
 * OR-E1 / 审计 E6：MCP 只读工具 smoke 契约测试（固定 fixture）。
 *
 * 根因（product-audit-20260910 E6）：`novel_prompt_inspect`/`novel_invocation_list`
 * SELECT 不存在的列恒抛、`novel_context_get` 增强块裸 catch 恒静默丢字段，长期无人发现
 * 的机制原因是这些工具不在编排 skill 的收录面（文档-代码互盲），没有任何测试触达它们的
 * SQL。修复不是给每个坏工具手写用例（会再次漏掉下一个），而是**枚举全部只读工具做 schema
 * 漂移 smoke**：新工具按命名形态自动进入烟测面。
 *
 * 判据是结构性的（AGENTS.md 泛化优先）：
 * - 只读面 = 名称匹配 `*_(get|list|query|inspect|queue|report)` 的工具（写动作工具不
 *   smoke，避免副作用）；反向守卫断言三个历史坏工具都在面内（模式漂移即报警）。
 * - 失败判据 = PostgreSQL schema 漂移错误（列/表/函数不存在、非法输入语法、类型不符）。
 *   业务性 "not found" 允许（空 fixture 的诚实输出）；schema 漂移说明 SQL 与当前
 *   migration 脱节，正是"恒抛/恒静默"的形态。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { executeTool } from "../mcp";
import { TOOL_NAMES } from "../mcp/tool-definitions";
import { buildToolArgumentSkeleton } from "../mcp/tool-metadata";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/** 只读工具的结构性命名形态（与 handlers.ts 的查询类命名约定对齐）。 */
const READ_ONLY_TOOL_PATTERN = /_(get|list|query|inspect|queue|report)$/u;

/** PostgreSQL schema 漂移错误形态：SQL 引用的列/表/函数与当前 migration 脱节。 */
const SCHEMA_DRIFT = /does not exist|syntax error|invalid input syntax|cannot be casted|column .* is of type|function\(.*\) does not exist|operator does not exist/u;

function readOnlyToolNames(): string[] {
  return TOOL_NAMES.filter((name) => READ_ONLY_TOOL_PATTERN.test(name));
}

describe("MCP 只读工具 smoke 契约（OR-E1）", () => {
  it("只读面按命名形态自动覆盖，且三个历史坏工具（恒抛×2+恒静默×1）都在面内", () => {
    const names = readOnlyToolNames();
    // 反向守卫：模式若漂移（如改名丢失后缀），坏工具会溜出烟测面——正是本次事故形态。
    for (const broken of ["novel_prompt_inspect", "novel_invocation_list", "novel_context_get"]) {
      expect(names).toContain(broken);
    }
    expect(names.length).toBeGreaterThanOrEqual(18);
  });

  it("模式不会把写动作工具吸进烟测面（副作用边界）", () => {
    const names = new Set(readOnlyToolNames());
    for (const writeTool of ["novel_project_create", "novel_project_delete", "novel_rule_promote", "novel_rule_rollback", "novel_review_submit", "novel_action_execute", "novel_run_complete"]) {
      expect(names.has(writeTool)).toBe(false);
    }
  });
});

describe("MCP 只读工具 smoke 契约（OR-E1，需 Postgres）", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;
  let projectId = "";

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
      projectId = `mcp-smoke-${randomUUID().slice(0, 8)}`;
      await repository.ensureProject(projectId, "MCP Read-Only Smoke");
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[mcp-readonly-smoke] Postgres 不可用: ${(error as Error).message}`);
    }
  }, 60000);

  afterAll(async () => {
    if (repository && projectId) {
      await repository.pool.query("DELETE FROM creative_projects WHERE id=$1", [projectId]).catch(() => undefined);
      await repository.close();
    }
  });

  // 运行期守卫（收集期三元 describe 会恒 skip，见 craft-rule.test 同款模式）。
  const smoke = readOnlyToolNames();
  it.each(smoke)("%s 在固定 fixture 上不触发 schema 漂移错误", async (toolName) => {
    if (!postgresAvailable) return;
    const skeleton = buildToolArgumentSkeleton(toolName) as Record<string, unknown>;
    const args: Record<string, unknown> = { ...skeleton, projectId };
    // 幂等键类参数须全局唯一，避免撞既有行的唯一约束（那是业务冲突不是 schema 漂移，
    // 但会给 smoke 制造不稳定噪声）。
    if ("idempotencyKey" in skeleton) args.idempotencyKey = `smoke-${randomUUID()}`;
    const result = await executeTool(toolName, args, { repository });
    const text = result.content[0]?.text ?? "";
    expect(() => JSON.parse(text)).not.toThrow();
    if (result.isError) {
      expect(text, `只读工具 ${toolName} 返回 schema 漂移错误`).not.toMatch(SCHEMA_DRIFT);
    }
  });

  it("novel_context_get 增强字段显式可达（旧 bug：坏 SQL 被裸 catch 吞成恒缺字段）", async () => {
    if (!postgresAvailable) return;
    const result = await executeTool("novel_context_get", { projectId }, { repository });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    // recentModelInvocations 必须出现（查询成功、空数组是诚实输出）；
    // 任何增强块失败都必须进 enhancementErrors（可见降级），而不是静默缺字段。
    expect(Array.isArray(payload.recentModelInvocations)).toBe(true);
    expect(payload.enhancementErrors).toBeUndefined();
  });

  it("novel_context_get 的序列证据在真实定稿章上可达，且与生成链路同一份资产账本生产者", async () => {
    if (!postgresAvailable) return;
    // 断链回归（2026-09-19）：增强块原先拿 max(narrative_order) 却传 documentId=""，
    // rhythm 查询绑该值必 0 行 ⇒ serialContext 恒缺且不报错；而本文件的空项目 smoke
    // 看不出差别（无定稿章时"字段缺席"本就合法），所以可达性必须在有章的 fixture 上测。
    const arcProject = `mcp-smoke-serial-${randomUUID().slice(0, 8)}`;
    const arcId = `mcp-smoke-arc-${arcProject}`;
    try {
      await repository.ensureProject(arcProject, "MCP Serial Smoke");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [`book-${arcProject}`, arcProject, "书名"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,'正文',1) ON CONFLICT DO NOTHING", [`volume-${arcProject}`, `book-${arcProject}`]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$2,$3,'arc',1,'approved','active',$4::jsonb)`,
        [arcId, `volume-${arcProject}`, arcProject, JSON.stringify({ title: "arc", objective: "x" })],
      );
      const prose: Record<string, string> = {};
      for (const order of [1, 2]) {
        const documentId = `smoke-doc-${order}`;
        const revisionId = `smoke-rev-${order}`;
        const contentHash = `smoke-content-${arcProject}-${order}`;
        prose[`test/${contentHash}`] = order === 1 ? "他数了数，怀里两块灵石。" : "账房伸出指头，要三块灵石。";
        await repository.pool.query("INSERT INTO manuscript_documents(id,project_id,title,narrative_order,status) VALUES($1,$2,$3,$4,'final')", [documentId, arcProject, `第${order}章`, order]);
        await repository.pool.query("INSERT INTO content_blobs(content_hash,object_key,byte_length) VALUES($1,$2,1)", [contentHash, `test/${contentHash}`]);
        await repository.pool.query("INSERT INTO manuscript_revisions(id,project_id,document_id,revision,base_revision,content_hash) VALUES($1,$2,$3,1,0,$4)", [revisionId, arcProject, documentId, contentHash]);
        await repository.pool.query("UPDATE manuscript_documents SET current_revision_id=$1 WHERE id=$2", [revisionId, documentId]);
        await repository.pool.query(
          `INSERT INTO chapters(id,arc_id,project_id,document_id,title,ordinal,status,payload)
           VALUES($1,$2,$3,$4,$5,$6,'final',$7::jsonb)`,
          [`smoke-chapter-${order}`, arcId, arcProject, documentId, `第${order}章`, order, JSON.stringify({ index: order, title: `第${order}章`, narrativeFunction: "development", scenes: [] })],
        );
      }
      const objects = { getText: async (key: string) => prose[key] ?? "" } as never;
      const result = await executeTool("novel_context_get", { projectId: arcProject }, { repository, objects });
      const payload = JSON.parse(result.content[0].text);
      expect(payload.enhancementErrors, JSON.stringify(payload.enhancementErrors)).toBeUndefined();
      expect(typeof payload.serialContext?.window).toBe("number");
      expect(Array.isArray(payload.serialContext.characterSpans)).toBe(true);
      // 资产账本必须在只读诊断面同样现形（同一个 withAssetSpans 生产者）。
      expect(payload.serialContext.assetSpans.map((span: { subject: string }) => span.subject)).toContain("灵石");

      // 反向：无对象存储时不静默给空账本，而是记一条可见降级。
      const withoutStore = await executeTool("novel_context_get", { projectId: arcProject }, { repository });
      expect(JSON.parse(withoutStore.content[0].text).enhancementErrors).toEqual([expect.stringContaining("assetSpans")]);

      // F1′：`novel_memory_query` 曾直取 repository 拿序列证据 ⇒ 账本恒空，而 compact 摘要里
      // 就有一个 assetSpanCount 字段（读得到字段、读不到账）。同一 fixture 上两面必须同账。
      // cutoff 显式给 2：资产账本的判据是"同一实体 ≥2 章"（groupAssetSpans 与 subjectSpans
      // 同口径），按文档推得的 cutoff=1 只剩单章窗口，账本为空是设计行为、不能当断言面。
      const memory = JSON.parse((await executeTool("novel_memory_query", { projectId: arcProject, documentId: "smoke-doc-2", compact: true, narrativeCutoff: 2 }, { repository, objects })).content[0].text);
      expect(memory.serialContextSummary.assetSpanCount).toBeGreaterThan(0);
      expect(memory.enhancementErrors).toBeUndefined();
      const memoryNoStore = JSON.parse((await executeTool("novel_memory_query", { projectId: arcProject, documentId: "smoke-doc-2", narrativeCutoff: 2 }, { repository })).content[0].text);
      expect(memoryNoStore.enhancementErrors).toEqual([expect.stringContaining("assetSpans")]);
      expect(memoryNoStore.serialContext.assetSpans).toEqual([]);
    } finally {
      await repository.deleteProject(arcProject).catch(() => undefined);
    }
  });

  it("novel_prompt_inspect / novel_invocation_list 空 run 查询给出业务错误而非 schema 漂移", async () => {
    if (!postgresAvailable) return;
    const inspect = await executeTool("novel_prompt_inspect", { workflowId: "smoke-missing-run", taskId: "smoke-missing-task" }, { repository });
    // 空 fixture 下诚实报"未找到"（业务语义），而旧 bug 是直接抛 column does not exist。
    expect(inspect.isError).toBe(true);
    expect(inspect.content[0].text).toContain("未找到");
    expect(inspect.content[0].text).not.toMatch(SCHEMA_DRIFT);
    const list = await executeTool("novel_invocation_list", { projectId }, { repository });
    expect(list.isError).toBeFalsy();
    expect(JSON.parse(list.content[0].text).invocations).toEqual([]);
  });
});
