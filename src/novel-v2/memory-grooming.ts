import { canonicalizeFactPredicate, normalizeFactToken } from "./fact-extraction/fingerprint";
import { retiredByVisibleKillerSql } from "./memory-visibility";

/**
 * 记忆梳理诊断投影（memory-governance-audit-20260909 §5.5）。
 *
 * 目的：把 active 事实账本按（规范化主体, 规范谓词）身份槽位分组，组内给出
 * 语义近重复候选对，供外部 LLM 做"事实梳理审核"（文本意见契约：通过时单行
 * PASSED，不通过时输出可执行梳理意见）。机械层只做候选排序，不做等价判定——
 * 同义改写的语义等价交由外部审核与作者确认，确认后走既有 claim 生命周期
 * （candidate→approved/rejected、supersedes 填充），不提供绕过质量门的直接改库工具。
 *
 * 泛化边界：相似度是字符二元组 Dice 系数，纯 TS 实现不依赖数据库扩展
 * （pg_trgm 等扩展属环境差异项）；阈值与上限为魔法值，标注 TODO 可配置意图。
 */

// TODO: move thresholds into the runtime routing configuration.
const DUPLICATE_SIMILARITY_THRESHOLD = 0.55;
const MAX_GROUPS = 40;
const MAX_PAIRS_PER_GROUP = 10;

export interface GroomingClaimEntry {
  id: string;
  subjects: string[];
  predicate: string;
  content: string;
  narrativeStart: number | null;
  authority: string;
  sourcePipeline: "fact-extraction" | "character-enrichment" | "author" | "foundation" | "other";
  createdAt: string;
}

export interface GroomingDuplicateCandidate {
  aId: string;
  bId: string;
  similarity: number;
}

export interface GroomingSlotGroup {
  subject: string;
  predicate: string;
  claims: GroomingClaimEntry[];
  duplicateCandidates: GroomingDuplicateCandidate[];
}

export interface MemoryGroomingReport {
  projectId: string;
  generatedAt: string;
  slotCount: number;
  claimCount: number;
  groups: GroomingSlotGroup[];
}

/** 字符二元组 multiset Dice 系数（0-1）：中文近重复候选排序的通用启发式。 */
export function textBigramDice(a: string, b: string): number {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
  const left = normalize(a);
  const right = normalize(b);
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let intersection = 0;
  const rightTotal = right.length - 1;
  for (let i = 0; i < rightTotal; i += 1) {
    const gram = right.slice(i, i + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      intersection += 1;
      counts.set(gram, remaining - 1);
    }
  }
  const total = (left.length - 1) + rightTotal;
  return total === 0 ? 0 : (2 * intersection) / total;
}

function sourcePipelineOf(claimId: string, projectId: string): GroomingClaimEntry["sourcePipeline"] {
  if (claimId.startsWith("claim:knowledge:")) return "character-enrichment";
  if (claimId.startsWith(`claim:${projectId}:`)) return "fact-extraction";
  if (claimId.startsWith("claim:author:")) return "author";
  if (claimId.startsWith("foundation:")) return "foundation";
  return "other";
}

/** 按身份槽位（规范化主体 × 规范谓词）分组；多主体声明会出现在多个组中。 */
export function groupClaimsBySlot(projectId: string, rows: Array<{
  id: string;
  subject_refs: string[] | null;
  predicate: string | null;
  content: string;
  narrative_start: number | null;
  authority: string;
  created_at: Date | string;
}>): GroomingSlotGroup[] {
  const groups = new Map<string, GroomingSlotGroup>();
  for (const row of rows) {
    if (!row.predicate) continue;
    for (const ref of row.subject_refs ?? []) {
      if (ref === "facet:fact") continue;
      const key = `${normalizeFactToken(ref)}|${canonicalizeFactPredicate(row.predicate)}`;
      let group = groups.get(key);
      if (!group) {
        group = { subject: ref, predicate: canonicalizeFactPredicate(row.predicate), claims: [], duplicateCandidates: [] };
        groups.set(key, group);
      }
      group.claims.push({
        id: row.id,
        subjects: row.subject_refs ?? [],
        predicate: canonicalizeFactPredicate(row.predicate),
        content: row.content,
        narrativeStart: row.narrative_start === null ? null : Number(row.narrative_start),
        authority: row.authority,
        sourcePipeline: sourcePipelineOf(row.id, projectId),
        createdAt: new Date(row.created_at).toISOString(),
      });
    }
  }
  for (const group of groups.values()) {
    const pairs: GroomingDuplicateCandidate[] = [];
    for (let i = 0; i < group.claims.length; i += 1) {
      for (let j = i + 1; j < group.claims.length; j += 1) {
        const similarity = textBigramDice(group.claims[i].content, group.claims[j].content);
        if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
          pairs.push({ aId: group.claims[i].id, bId: group.claims[j].id, similarity: Number(similarity.toFixed(4)) });
        }
      }
    }
    group.duplicateCandidates = pairs.sort((a, b) => b.similarity - a.similarity).slice(0, MAX_PAIRS_PER_GROUP);
  }
  return [...groups.values()]
    .sort((a, b) => b.claims.length - a.claims.length || b.duplicateCandidates[0]?.similarity - a.duplicateCandidates[0]?.similarity || 0)
    .slice(0, MAX_GROUPS);
}

export async function buildMemoryGroomingReport(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, projectId: string): Promise<MemoryGroomingReport> {
  // 与检索可见口径一致：杀手必须可见（active + approved/author/derived），candidate
  // 不得盲杀；被退役的 derived 因此在梳理报告里保持在场，直到候选获正式裁决。
  // target 侧仍含 candidate（梳理需要看到待裁决队列）。Foundation 投影
  // （predicate IS NULL）不参与槽位分组。
  const result = await pool.query(
    `SELECT c.id, c.subject_refs, c.predicate, c.content, c.narrative_start, c.authority, c.created_at
     FROM memory_claims c
     WHERE c.project_id=$1 AND c.lifecycle_status='active' AND c.authority <> 'rejected' AND c.predicate IS NOT NULL
       AND NOT ${retiredByVisibleKillerSql("c")}
     ORDER BY c.created_at ASC`,
    [projectId],
  );
  const groups = groupClaimsBySlot(projectId, result.rows);
  return {
    projectId,
    generatedAt: new Date().toISOString(),
    slotCount: groups.length,
    claimCount: result.rows.length,
    groups,
  };
}
