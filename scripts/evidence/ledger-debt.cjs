// 账本欠债体检（只读 ymcp）：伏笔 open 未绑 thread 数、规范化后的重复描述簇、学习候选状态分布、晋升 receipt 与已晋升技能版本。
// 从仓库根运行；纯 SELECT。数字随产线变化，只作当轮取证与趋势对比用。
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  await c.connect();
  const q = async (label, sql, params) => {
    try { const r = await c.query(sql, params); console.log(label, JSON.stringify(r.rows)); }
    catch (e) { console.log(label, "ERR", e.message); }
  };
  await q("伏笔 open 未绑 thread:", `SELECT count(*)::int AS unbound_open FROM foreshadowing WHERE status='open' AND thread_id IS NULL`);
  await q("伏笔总数:", `SELECT count(*)::int AS n FROM foreshadowing`);
  await q("重复描述簇(规范化后 >1 行):", `
    WITH k AS (
      SELECT lower(regexp_replace(btrim(coalesce(payload->>'description','')), '\\s+', ' ', 'g')) AS d, count(*)::int AS n
      FROM foreshadowing GROUP BY 1
    ) SELECT count(*)::int AS dup_clusters, coalesce(sum(n-1),0)::int AS extra_rows FROM k WHERE n > 1 AND d <> ''`);
  await q("学习候选状态分布:", `SELECT status, count(*)::int AS n FROM craft_rule_candidates GROUP BY 1 ORDER BY 2 DESC`);
  await q("晋升 receipt 数:", `SELECT count(*)::int AS n FROM promotion_receipts`);
  await q("已晋升 skill 版本样例:", `SELECT name, version FROM skill_definitions ORDER BY updated_at DESC LIMIT 5`);
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
