// 定论 2：public 序列被谁依赖（把 pg_depend 的真实形状打出来），以及在测试库上
// 用 BEGIN/DROP/ROLLBACK 直接验证"克隆副本挡住公共表 DROP"这条因果链是否成立。
// ROLLBACK 保证零改动；只跑测试库 ymcp_test，绝不碰 ymcp。
const { Pool } = require("pg");

(async () => {
  const ymcp = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  try {
    const rows = await ymcp.query(`
      SELECT seq.relname AS seq, d.classid::regclass AS src_class, d.deptype,
             CASE d.classid WHEN 'pg_class'::regclass THEN (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=d.objid) ELSE NULL END AS src_nsp,
             count(*)::int n
      FROM pg_depend d
      JOIN pg_class seq ON seq.oid = d.refobjid AND seq.relkind = 'S'
      JOIN pg_namespace sn ON sn.oid = seq.relnamespace AND sn.nspname = 'public'
      GROUP BY 1,2,3,4 ORDER BY 1, n DESC`);
    console.log("== ymcp pg_depend edges pointing AT public sequences");
    console.log(JSON.stringify(rows.rows, null, 1));
    const own = await ymcp.query(`
      SELECT seq.relname AS seq, tbl.relname AS owned_by, depn.nspname
      FROM pg_depend d
      JOIN pg_class seq ON seq.oid = d.objid AND seq.relkind='S'
      JOIN pg_class tbl ON tbl.oid = d.refobjid
      JOIN pg_namespace depn ON depn.oid = tbl.relnamespace
      WHERE d.deptype='a' AND d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass
      ORDER BY 1`);
    console.log("== ymcp sequence ownership (deptype a)");
    console.log(JSON.stringify(own.rows, null, 1));
  } catch (error) {
    console.log("ymcp ERR", error.message);
  } finally {
    await ymcp.end();
  }

  // 真验：测试库里挑一张"有归属序列 + 被沙箱克隆过"的公共表，事务内 DROP 后回滚。
  const test = new Pool({ connectionString: process.env.TEST_DATABASE_URL || "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test" });
  const client = await test.connect();
  try {
    const candidates = await test.query(`
      SELECT tbl.relname AS table_name, seq.relname AS seq_name,
             (SELECT count(*) FROM pg_attrdef ad JOIN pg_class ct ON ct.oid=ad.adrelid
                JOIN pg_namespace cn ON cn.oid=ct.relnamespace
               WHERE cn.nspname LIKE 'experiment\\_%'
                 AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%' || seq.relname || '%')::int AS clone_default_refs
      FROM pg_depend d
      JOIN pg_class seq ON seq.oid = d.objid AND seq.relkind='S'
      JOIN pg_class tbl ON tbl.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = tbl.relnamespace AND tn.nspname='public'
      WHERE d.deptype='a'
      ORDER BY clone_default_refs DESC LIMIT 5`);
    console.log("== ymcp_test sequences and how many clone defaults name them");
    console.log(JSON.stringify(candidates.rows, null, 1));

    for (const row of candidates.rows) {
      if (!row.clone_default_refs) continue;
      await client.query("BEGIN");
      let dropResult = "ok";
      try {
        await client.query(`DROP TABLE public.${row.table_name}`);
      } catch (error) {
        dropResult = `${error.code || ""} ${error.message.split("\n")[0]}`;
      }
      await client.query("ROLLBACK");
      console.log(`\n-- 直接 DROP public.${row.table_name}（有 ${row.clone_default_refs} 处克隆默认值引用其序列）: ${dropResult}`);

      await client.query("BEGIN");
      let detachedResult = "ok";
      try {
        await client.query(`ALTER SEQUENCE public.${row.seq_name} OWNED BY NONE`);
        await client.query(`DROP TABLE public.${row.table_name}`);
        detachedResult = "ok（解绑归属后公共表可删，序列与副本留下）";
      } catch (error) {
        detachedResult = `${error.code || ""} ${error.message.split("\n")[0]}`;
      }
      await client.query("ROLLBACK");
      console.log(`-- 先 ALTER SEQUENCE ${row.seq_name} OWNED BY NONE 再 DROP: ${detachedResult}`);
      break;
    }
    // 回滚后确认表与序列仍在（证明本轮验证零改动）
    const still = await test.query(`
      SELECT count(*)::int c FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname=$1`, [candidates.rows[0]?.table_name ?? ""]);
    console.log("\n回滚后该表仍存在:", JSON.stringify(still.rows));
  } catch (error) {
    console.log("ymcp_test ERR", error.message);
  } finally {
    client.release();
    await test.end();
  }
})();
