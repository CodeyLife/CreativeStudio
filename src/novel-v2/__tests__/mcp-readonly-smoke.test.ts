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
