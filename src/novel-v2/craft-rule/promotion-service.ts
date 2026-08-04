/**
 * Craft-Rule 专用晋升服务。
 *
 * 设计依据：AGENTS.md 经验沉淀闭环 + v2-refactor-followup-plan.md C-2.5 方案 B。
 *
 * 与 evaluation/promotion.ts 的 PromotionService 区别：
 * - 不要求 CandidateBundle（craft-rule 不产生 manuscript / dependencyHead / acceptedFacts）
 * - 仅做 skill_definitions 或 prompt_templates 的原子写入 + receipt
 * - 回归验证由调用方（craft-rule/index.ts promoteCraftRuleCandidate）负责，本服务只返回 receipt
 *
 * 原子性：promote 在单个 Postgres 事务内完成 skill/prompt 更新 + receipt 写入 + candidate 状态更新；
 * 任一步骤抛错则整个事务回滚。
 * 幂等性：以 `promote:<candidateId>` 作为 receipt id，同一 candidateId 重复 promote 返回同一 receipt。
 *
 * 失败模式：
 * - stale-target-version：target 版本已漂移（skill_definitions.version != candidate.beforeVersion）
 * - transaction-failure：写 failed receipt
 *
 * AGENTS.md 契约：promote 后必须做回归验证（用新版本重跑失败场景）。
 * 回归验证由调用方负责，本服务只返回 receipt 供调用方决策。
 */
import type { PromotionReceipt } from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";
import type { CraftRuleCandidate } from "./index";
import { mergeCraftRulePromptSections, parseCraftRulePromptPatch } from "./prompt-patch";

// ===== 类型 =====

export interface CraftRulePromotionService {
  promote(input: { candidate: CraftRuleCandidate; authorId: string }): Promise<PromotionReceipt>;
  rollback(receiptId: string): Promise<void>;
  getReceipt(candidateId: string): Promise<PromotionReceipt | null>;
}

// ===== 辅助 =====

type ReceiptRow = {
  id: string;
  candidate_id: string;
  project_id: string;
  status: string;
  result: Record<string, unknown>;
  failure_reason: string | null;
  created_at: Date | string;
};

function mapReceiptRow(row: ReceiptRow): PromotionReceipt {
  const result = row.result ?? {};
  return {
    id: row.id,
    candidateId: row.candidate_id,
    projectId: row.project_id,
    status: row.status as PromotionReceipt["status"],
    result: {
      revisionId: typeof result.revisionId === "string" ? result.revisionId : undefined,
      skillUpdates: Array.isArray(result.skillUpdates) ? (result.skillUpdates as string[]) : undefined,
      promptTemplateUpdates: Array.isArray(result.promptTemplateUpdates) ? (result.promptTemplateUpdates as string[]) : undefined,
      factIds: Array.isArray(result.factIds) ? (result.factIds as string[]) : undefined,
    },
    failureReason: row.failure_reason ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/**
 * 把 prompt 文本序列化为 skill_definitions.prompt_sections 可写入的 JSON 字符串。
 * 与 evaluation/promotion.ts 处理逻辑一致：能解析为 JSON 则直接用，否则包装为 { drafting: text }。
 */
/**
 * 解析 system-prompt target 的 targetId。
 * 与 craft-rule/index.ts splitPromptTargetId 一致：支持 "<projectId>:<templateId>" 或 "<templateId>"。
 * 后者 fallback 到 candidate.projectId。
 */
function splitPromptTargetId(targetId: string, fallbackProjectId: string): [string, string] {
  const idx = targetId.indexOf(":");
  if (idx < 0) return [fallbackProjectId, targetId];
  const projectId = targetId.slice(0, idx);
  const templateId = targetId.slice(idx + 1);
  if (!projectId || !templateId) {
    throw new Error(`system-prompt targetId 格式非法：${targetId}`);
  }
  return [projectId, templateId];
}

// ===== 实现 =====

class CraftRulePromotionServiceImpl implements CraftRulePromotionService {
  constructor(private readonly repository: NovelPostgresRepository) {}

  async getReceipt(candidateId: string): Promise<PromotionReceipt | null> {
    const result = await this.repository.pool.query<ReceiptRow>(
      "SELECT id, candidate_id, project_id, status, result, failure_reason, created_at FROM promotion_receipts WHERE candidate_id = $1",
      [candidateId],
    );
    if (!result.rowCount) return null;
    return mapReceiptRow(result.rows[0]);
  }

  async promote(input: { candidate: CraftRuleCandidate; authorId: string }): Promise<PromotionReceipt> {
    const { candidate, authorId } = input;
    if (!authorId) {
      return this.writeFailedReceipt(candidate, "authorId 缺失");
    }

    // 1. 幂等检查
    const existing = await this.getReceipt(candidate.id);
    if (existing && existing.status === "promoted") {
      return existing;
    }

    // 2. 执行原子事务。目标版本必须在同一事务内锁定并校验，
    // 否则事务外的 preflight 与实际 UPDATE 之间会留下覆盖窗口。
    const receiptId = `promote:${candidate.id}`;
    const now = Date.now();

    const client = await this.repository.pool.connect();
    try {
      await client.query("BEGIN");

      // 3.1 UPDATE target（skill → skill_definitions，system-prompt → prompt_templates）
      if (candidate.targetKind === "skill") {
        // P0-C2 修复（2026-07-27）：promote 时同步写入 applicable_genres，
        // 让 resolveSkillBundle 能按 genre 匹配题材特化 skill。
        // 设计依据：Phase 3.3 + AGENTS.md「reusable contracts over case-specific rules」——
        // craft rule 通过 learning 闭环沉淀题材相关规则，promote 必须把 applicableGenres 持久化。
        const applicableGenres = candidate.applicableGenres ?? [];
        const current = await client.query<{ prompt_sections: Record<string, unknown> | null; version: string }>(
          "SELECT prompt_sections, version FROM skill_definitions WHERE skill_id = $1 FOR UPDATE",
          [candidate.targetId],
        );
        if (!current.rowCount || current.rows[0].version !== candidate.beforeVersion) throw new Error(`stale-target-version：skill_definitions.version 已漂移（before=${candidate.beforeVersion}, current=${current.rows[0]?.version ?? "missing"}）`);
        const promptSections = mergeCraftRulePromptSections(current.rows[0].prompt_sections, parseCraftRulePromptPatch(candidate.afterText));
        const updated = await client.query(
          "UPDATE skill_definitions SET prompt_sections = $2::jsonb, version = $3, applicable_genres = $4, updated_at = now() WHERE skill_id = $1 AND version = $5",
          [candidate.targetId, JSON.stringify(promptSections), candidate.proposedVersion, applicableGenres, candidate.beforeVersion],
        );
        if (updated.rowCount !== 1) throw new Error(`stale-target-version：skill_definitions.version 已漂移（before=${candidate.beforeVersion}）`);
      } else {
        const [promptProjectId, templateId] = splitPromptTargetId(candidate.targetId, candidate.projectId);
        const current = await client.query<{ version: string }>(
          "SELECT version FROM prompt_templates WHERE project_id = $1 AND template_id = $2 FOR UPDATE",
          [promptProjectId, templateId],
        );
        if (!current.rowCount || current.rows[0].version !== candidate.beforeVersion) throw new Error(`stale-target-version：prompt_templates.version 已漂移（before=${candidate.beforeVersion}, current=${current.rows[0]?.version ?? "missing"}）`);
        const updated = await client.query(
          "UPDATE prompt_templates SET content = $3, version = $4, content_fingerprint = md5($3), updated_at = now() WHERE project_id = $1 AND template_id = $2 AND version = $5",
          [promptProjectId, templateId, candidate.afterText, candidate.proposedVersion, candidate.beforeVersion],
        );
        if (updated.rowCount !== 1) throw new Error(`stale-target-version：prompt_templates.version 已漂移（before=${candidate.beforeVersion}）`);
      }

      // 3.2 INSERT promotion_receipts（status=promoted）
      const receipt: PromotionReceipt = {
        id: receiptId,
        candidateId: candidate.id,
        projectId: candidate.projectId,
        status: "promoted",
        result: candidate.targetKind === "skill"
          ? { skillUpdates: [candidate.targetId] }
          : { promptTemplateUpdates: [candidate.targetId] },
        createdAt: now,
      };
      await client.query(
        "INSERT INTO promotion_receipts(id, candidate_id, project_id, status, result, created_at) VALUES($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)) ON CONFLICT(candidate_id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result, failure_reason = NULL",
        [
          receipt.id,
          receipt.candidateId,
          receipt.projectId,
          receipt.status,
          JSON.stringify(receipt.result),
          now,
        ],
      );

      // 3.3 UPDATE craft_rule_candidates.status = 'promoted'
      await client.query(
        "UPDATE craft_rule_candidates SET status = 'promoted', updated_at = now() WHERE id = $1 AND project_id = $2",
        [candidate.id, candidate.projectId],
      );

      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      // 同一 candidate 的并发调用可能在本事务等待期间已经成功提交。
      // 成功 receipt 是幂等结果，不能被后来的 stale 错误降级为 failed。
      const promoted = await this.getReceipt(candidate.id);
      if (promoted?.status === "promoted") return promoted;
      const errorMessage = (error as Error).message ?? String(error);
      if (errorMessage.startsWith("stale-target-version")) {
        return this.writeFailedReceipt(candidate, errorMessage, receiptId);
      }
      await this.writeFailedReceipt(candidate, `transaction-failure：${errorMessage}`, receiptId);
      throw error;
    } finally {
      client.release();
    }
  }

  async rollback(receiptId: string): Promise<void> {
    // 1. 读取 receipt
    const receiptResult = await this.repository.pool.query<ReceiptRow>(
      "SELECT id, candidate_id, project_id, status, result, failure_reason, created_at FROM promotion_receipts WHERE id = $1",
      [receiptId],
    );
    if (!receiptResult.rowCount) throw new Error(`receipt 不存在：${receiptId}`);
    const receipt = mapReceiptRow(receiptResult.rows[0]);
    if (receipt.status !== "promoted") {
      throw new Error(`只能 rollback 已 promoted 的 receipt，当前状态：${receipt.status}`);
    }

    // 2. 读取 craft_rule_candidate 获取回滚所需信息
    const candidateResult = await this.repository.pool.query<{
      target_kind: "skill" | "system-prompt";
      target_id: string;
      before_version: string;
      proposed_version: string;
      before_text: string;
      project_id: string;
    }>(
      "SELECT target_kind, target_id, before_version, proposed_version, before_text, project_id FROM craft_rule_candidates WHERE id = $1",
      [receipt.candidateId],
    );
    if (!candidateResult.rowCount) {
      throw new Error(`craft_rule_candidate 不存在：${receipt.candidateId}`);
    }
    const candidateRow = candidateResult.rows[0];

    const client = await this.repository.pool.connect();
    try {
      await client.query("BEGIN");

      // 3.1 恢复 target（skill → skill_definitions，system-prompt → prompt_templates）
      if (candidateRow.target_kind === "skill") {
        const current = await client.query<{ version: string }>(
          "SELECT version FROM skill_definitions WHERE skill_id = $1 FOR UPDATE",
          [candidateRow.target_id],
        );
        if (!current.rowCount || current.rows[0].version !== candidateRow.proposed_version) throw new Error(`stale-target-version：skill_definitions.version 已漂移，拒绝覆盖回滚（expected=${candidateRow.proposed_version}, current=${current.rows[0]?.version ?? "missing"}）`);
        const updated = await client.query(
          "UPDATE skill_definitions SET prompt_sections = $2::jsonb, version = $3, updated_at = now() WHERE skill_id = $1 AND version = $4",
          [candidateRow.target_id, JSON.stringify(parseCraftRulePromptPatch(candidateRow.before_text)), candidateRow.before_version, candidateRow.proposed_version],
        );
        if (updated.rowCount !== 1) throw new Error(`stale-target-version：skill_definitions.version 已漂移，拒绝覆盖回滚（expected=${candidateRow.proposed_version}）`);
      } else {
        const [promptProjectId, templateId] = splitPromptTargetId(candidateRow.target_id, candidateRow.project_id);
        const current = await client.query<{ version: string }>(
          "SELECT version FROM prompt_templates WHERE project_id = $1 AND template_id = $2 FOR UPDATE",
          [promptProjectId, templateId],
        );
        if (!current.rowCount || current.rows[0].version !== candidateRow.proposed_version) throw new Error(`stale-target-version：prompt_templates.version 已漂移，拒绝覆盖回滚（expected=${candidateRow.proposed_version}, current=${current.rows[0]?.version ?? "missing"}）`);
        const updated = await client.query(
          "UPDATE prompt_templates SET content = $3, version = $4, content_fingerprint = md5($3), updated_at = now() WHERE project_id = $1 AND template_id = $2 AND version = $5",
          [promptProjectId, templateId, candidateRow.before_text, candidateRow.before_version, candidateRow.proposed_version],
        );
        if (updated.rowCount !== 1) throw new Error(`stale-target-version：prompt_templates.version 已漂移，拒绝覆盖回滚（expected=${candidateRow.proposed_version}）`);
      }

      // 3.2 更新 receipt status = rolled-back
      await client.query(
        "UPDATE promotion_receipts SET status = 'rolled-back' WHERE id = $1",
        [receiptId],
      );

      // 3.3 更新 craft_rule_candidates.status = 'rolled-back'
      await client.query(
        "UPDATE craft_rule_candidates SET status = 'rolled-back', updated_at = now() WHERE id = $1 AND project_id = $2",
        [receipt.candidateId, candidateRow.project_id],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeFailedReceipt(
    candidate: CraftRuleCandidate,
    reason: string,
    explicitId?: string,
  ): Promise<PromotionReceipt> {
    const receiptId = explicitId ?? `promote:${candidate.id}`;
    const now = Date.now();
    const receipt: PromotionReceipt = {
      id: receiptId,
      candidateId: candidate.id,
      projectId: candidate.projectId,
      status: "failed",
      result: {},
      failureReason: reason,
      createdAt: now,
    };
    try {
      await this.repository.pool.query(
        "INSERT INTO promotion_receipts(id, candidate_id, project_id, status, result, failure_reason, created_at) VALUES($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0)) ON CONFLICT(candidate_id) DO UPDATE SET status = EXCLUDED.status, failure_reason = EXCLUDED.failure_reason WHERE promotion_receipts.status <> 'promoted'",
        [receipt.id, receipt.candidateId, receipt.projectId, receipt.status, JSON.stringify(receipt.result), reason, now],
      );
    } catch {
      // 写 failed receipt 也失败时，只返回内存 receipt
    }
    return receipt;
  }
}

// ===== 工厂 =====

export function createCraftRulePromotionService(repository: NovelPostgresRepository): CraftRulePromotionService {
  return new CraftRulePromotionServiceImpl(repository);
}
