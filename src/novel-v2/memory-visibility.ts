/**
 * Claim retrieval visibility — the single definition of "this claim is live".
 *
 * 根因契约（product-audit-20260910 A1/FM-1）：退役（supersedes）此前只在部分查询里
 * 检查杀手行的 authority，candidate/rejected 行因此能"盲杀"可见事实——候选在被裁决
 * 之前就把尚未被它取代的旧派生事实逐出所有检索面，资产账本在模型视野中凭空消失
 * （实测 ch19「缴清灵石」derived 被 ch21「旁路状态」candidate 退役，全书灵石账本只剩 ch1）。
 *
 * 泛化不变量：**只有检索可见的声明才有资格退役其他声明**。
 * - 杀手行必须 active 且 authority ∈ {approved, author, derived}；
 * - 一层判定即传递正确：若可见杀手 B 之后又被更新的可见行 C 退役，A 仍应保持退役
 *   （C 才是槽位当前值，复活 A 会让陈旧值重新入场景）；若杀手是候选态，退役整体不生效，
 *   B 保持可见并继续合法地退役 A。不存在需要迭代求解的场景。
 * - candidate 获批后（authority 变为 approved）其 supersedes 边自动开始生效；被拒或
 *   撤回则被退役行自动复活。退役状态是查询期派生值，不需要回写数据。
 *
 * 所有装配/检索/梳理/索引路径必须从这里取同一 SQL 片段或同一 TS 判定，禁止再抄写
 * 手写变体（历史上多处口径漂移即本缺陷根源）。注意 target 侧条件各路径不同（事实提取
 * 上下文与梳理诊断故意把 candidate 也列出以避免重复），但 killer 侧统一用
 * retiredByVisibleKillerSql。
 */

export const VISIBLE_CLAIM_AUTHORITIES = ["approved", "author", "derived"] as const;

export type VisibleClaimAuthority = (typeof VISIBLE_CLAIM_AUTHORITIES)[number];

/**
 * 由"可能为空的来源 revision id"构造 claim 的 `sourceRevisionIds`（2026-10-14 round 22）。
 *
 * 失效形态：若干注入点直接写 `sourceRevisionIds: [x.revisionId]`，而该列在 schema 上
 * 可为空（生产实测 `foreshadowing.planted_revision_id`：717 条里 **41 条为空**）。
 * 于是数组里出现 `null` 并向下游传播——
 *   memory_bundles.payload.sourceRevisionIds 含 null：**454 行**
 *   context_manifests.source_revision_ids 含 NULL：**222 行**
 * 影响：任何按 sourceRevisionIds 做集合运算/join 的消费方拿到 null（`= ANY(array)`
 * 永远匹配不到；`unnest` 出来的 null 让悬空统计虚高——取证脚本就被它误导过一次）。
 * 放在这个文件是因为它与 claim 的来源真址同属一层：**组装处就滤掉，不让 null 流到下游再各自防御。**
 */
export function sourceRevisionIdsOf(...ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export function isVisibleClaimAuthority(authority: string | null | undefined): authority is VisibleClaimAuthority {
  return typeof authority === "string" && (VISIBLE_CLAIM_AUTHORITIES as readonly string[]).includes(authority);
}

const AUTHORITY_LIST = VISIBLE_CLAIM_AUTHORITIES.map((value) => `'${value}'`).join(",");

/** SQL predicate: the `alias` claim row is itself retrieval-visible (active + visible authority). */
export function visibleClaimSql(alias: string): string {
  return `${alias}.lifecycle_status = 'active' AND ${alias}.authority IN (${AUTHORITY_LIST})`;
}

/**
 * SQL predicate: the `alias` claim is retired by a retrieval-visible killer.
 * Callers negate it (`NOT …`) to keep only live claims. The killer must itself
 * be visible so an unadjudicated candidate can never silently delete facts.
 */
export function retiredByVisibleKillerSql(alias: string): string {
  return `EXISTS (
      SELECT 1 FROM memory_claims ${alias}_retirement_killer
      WHERE ${alias}_retirement_killer.project_id = ${alias}.project_id
        AND ${visibleClaimSql(`${alias}_retirement_killer`)}
        AND ${alias}.id = ANY(${alias}_retirement_killer.supersedes)
    )`;
}

/**
 * Convenience for the common full contract (target visible + not retired by a
 * visible killer): retrieval/assembly paths that surface only live facts.
 * `alias` must be a table alias or the bare table name `memory_claims`.
 */
export function retrievalVisibleClaimsSql(alias: string): string {
  return `${visibleClaimSql(alias)} AND NOT ${retiredByVisibleKillerSql(alias)}`;
}

/**
 * Claim 派生投影的唯一重算定义——`UPDATE memory_claims claim SET ${CLAIM_PROJECTION_SET_SQL}`。
 *
 * 根因契约：`narrative_start/narrative_end` 是声明在叙事时间轴上覆盖的**区间**
 * （由全部 active sources 的 `manuscript_documents.narrative_order` 派生），
 * 不是单点。两处重算点曾把 `narrative_end` 抄成与上一行 `narrative_start` 相同的
 * `MIN(...)`，区间因此塌成点。受害面（`cognition.isMemoryClaimVisibleAtCutoff`）：
 * `chapter-memory-rollup` 声明按"内容跨越 cutoff 即整条隐藏"fail-closed 防止把后文
 * 剧情泄进当前章上下文，而 end==start 使该判据恒不触发；`postgres-repository`
 * 状态重建按区间重叠挑选受影响的 rollup（`narrative_start <= hi AND narrative_end >= lo`），
 * 塌成点后漏挑，rollup 带着已删除来源继续存活。
 *
 * 边界：单来源声明 end 本等于 start，修复不改变其可见性；只影响多来源
 * （rollup / 跨章持续事实）声明。caller 侧的 `source_document_id` 三种语义
 * （覆盖 / 保留旧值 / 不重算）刻意留在各自调用点，本片段只收口区间口径。
 *
 * `claim` 与 `source` 是固定别名：调用方必须写成 `UPDATE memory_claims claim`，
 * 子查询内 sources 别名固定为 `source`。
 */
export const CLAIM_PROJECTION_SET_SQL = `lifecycle_status=CASE WHEN EXISTS (
                 SELECT 1 FROM memory_claim_sources source
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active'
               ) THEN 'active' ELSE 'staged' END,
               source_revision_ids=COALESCE((
                 SELECT array_agg(DISTINCT source.revision_id) FILTER (WHERE source.revision_id IS NOT NULL)
                 FROM memory_claim_sources source
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active'
               ),'{}'::text[]),
               narrative_start=(
                 SELECT MIN(document.narrative_order)
                 FROM memory_claim_sources source
                 JOIN manuscript_documents document ON document.id=source.document_id
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active'
               ),
               narrative_end=(
                 SELECT MAX(document.narrative_order)
                 FROM memory_claim_sources source
                 JOIN manuscript_documents document ON document.id=source.document_id
                 WHERE source.claim_id=claim.id AND source.lifecycle_status='active'
               )`;
