// 截断硬门的现形面取证（只读 ymcp）：prompt_executions 里有多少行带 context_manifest、其中多少带 maxInputTokens，按 purpose 分组。
// 从仓库根运行；纯 SELECT，不写业务数据。
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  await c.connect();
  const cols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='prompt_executions' ORDER BY ordinal_position");
  console.log("prompt_executions cols:", cols.rows.map((r) => r.column_name).join(","));
  const r = await c.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE context_manifest IS NULL OR context_manifest = '{}'::jsonb)::int AS no_manifest,
      count(*) FILTER (WHERE context_manifest ? 'maxInputTokens') AS manifest_has_limit
    FROM prompt_executions`);
  console.log(JSON.stringify(r.rows));
  const r2 = await c.query(`SELECT purpose, count(*)::int AS n, count(*) FILTER (WHERE context_manifest ? 'maxInputTokens') AS with_limit
    FROM prompt_executions GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
  console.log(JSON.stringify(r2.rows));
  await c.end();
})();
