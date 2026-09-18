-- 091_claim_narrative_span_recompute.sql
-- 修复 claim 叙事区间的存量污染：`commitRevision` 与 `replaceCommittedChapterFactSources`
-- 两处投影重算曾把 narrative_end 抄成与 narrative_start 相同的 MIN(...)，多来源声明
-- （跨章持续事实、chapter-memory-rollup）的区间因此塌成第 1 个来源所在的章节点。
-- 代码侧口径已收口到 memory-visibility.CLAIM_PROJECTION_SET_SQL（单一定义），
-- 本迁移回填由该口径错误写入的历史行。
--
-- 受害面：cognition.isMemoryClaimVisibleAtCutoff 对 rollup 声明按
-- "narrative_end > cutoff 即整条隐藏" fail-closed 阻止后文剧情进入当前章上下文，
-- end==start 使该判据恒不触发；状态重建按区间重叠挑选受影响 rollup，塌点后漏挑。
--
-- 边界与幂等：
-- - 只重算"至少有一条 active source 且该 source 挂在有 narrative_order 的章节上"的声明
--   （与代码片段同一 INNER JOIN 口径）；无任何 active source 的声明刻意不动，
--   避免把 author/foundation 类直接写入区间的行误清空——那是本回填可能造成的唯一数据损失面。
-- - IS DISTINCT FROM 让重跑成为 no-op。
UPDATE memory_claims claim
SET narrative_start = span.min_order,
    narrative_end   = span.max_order
FROM (
  SELECT source.claim_id,
         MIN(document.narrative_order) AS min_order,
         MAX(document.narrative_order) AS max_order
  FROM memory_claim_sources source
  JOIN manuscript_documents document ON document.id = source.document_id
  WHERE source.lifecycle_status = 'active'
  GROUP BY source.claim_id
) span
WHERE claim.id = span.claim_id
  AND (claim.narrative_start IS DISTINCT FROM span.min_order
       OR claim.narrative_end IS DISTINCT FROM span.max_order);
