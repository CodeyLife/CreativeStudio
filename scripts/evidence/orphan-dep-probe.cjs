// 取证：实验沙箱与 public 对象的依赖边形态（核对 migration 093 头注释的因果论断）
const { Pool } = require("pg");

const VICTIMS = ["short_scripts", "short_drama_materials", "short_drama_workspaces",
  "character_knowledge", "skill_versions", "skill_bindings", "memory_snapshots", "usage_ledger"];

async function run(url, label) {
  const pool = new Pool({ connectionString: url });
  const out = (k, rows) => console.log(`\n== ${label} ${k}\n` + JSON.stringify(rows, null, 1));
  try {
    const seqDefaults = await pool.query(`
      SELECT ns.nspname AS seq_nsp, count(*)::int AS cols
      FROM pg_attrdef d
      JOIN pg_class t ON t.oid = d.adrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE ns.nspname LIKE 'experiment\\_%' AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval%'
      GROUP BY 1 ORDER BY 2 DESC`);
    out("clone columns whose default is nextval, grouped by the schema holding the TABLE", seqDefaults.rows);

    const refNsp = await pool.query(`
      SELECT DISTINCT split_part(pg_get_expr(d.adbin, d.adrelid), '''', 2) AS seq_qualified
      FROM pg_attrdef d
      JOIN pg_class t ON t.oid = d.adrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE ns.nspname LIKE 'experiment\\_%' AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval%'
      LIMIT 12`);
    out("sample sequence references inside clones", refNsp.rows);

    const edges = await pool.query(`
      SELECT deptype, refkind, ref_nsp, count(*)::int n
      FROM (
        SELECT d.deptype,
               CASE d.refclassid WHEN 'pg_class'::regclass THEN (SELECT relkind FROM pg_class c WHERE c.oid = d.refobjid) ELSE d.refclassid::regclass::text END AS refkind,
               CASE d.refclassid WHEN 'pg_class'::regclass THEN (SELECT nsp.nspname FROM pg_class c JOIN pg_namespace nsp ON nsp.oid = c.relnamespace WHERE c.oid = d.refobjid) ELSE '-' END AS ref_nsp,
               (SELECT nsp.nspname FROM pg_class s JOIN pg_namespace nsp ON nsp.oid = s.relnamespace WHERE s.oid = d.objid) AS src_nsp
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
      ) e
      WHERE src_nsp LIKE 'experiment\\_%' AND ref_nsp = 'public'
      GROUP BY 1, 2, 3 ORDER BY n DESC`);
    out("class->class dependency edges from experiment schemas into public", edges.rows);

    const victimDeps = await pool.query(`
      SELECT dep.relname AS dependent, dep.relkind AS dep_kind, depns.nspname AS dep_nsp, d.deptype, count(*)::int n
      FROM pg_depend d
      JOIN pg_class tbl ON tbl.oid = d.refobjid AND tbl.relname = ANY($1::text[])
      JOIN pg_namespace tns ON tns.oid = tbl.relnamespace AND tns.nspname = 'public'
      LEFT JOIN pg_class seq ON seq.oid = d.objid AND d.classid = 'pg_class'::regclass
      LEFT JOIN pg_class dep ON dep.oid = COALESCE(seq.oid, CASE WHEN d.refclassid = 'pg_class'::regclass THEN NULL END)
      LEFT JOIN pg_namespace depns ON depns.oid = dep.relnamespace
      WHERE d.deptype = 'a' AND d.classid = 'pg_class'::regclass
      GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 20`, [VICTIMS]);
    out("auto-dependents recorded against the victim tables' own objects", victimDeps.rows);

    const seqOwnedByVictims = await pool.query(`
      SELECT seq.relname AS seq, tbl.relname AS owner_tbl, count(*)::int clone_refs
      FROM pg_depend d
      JOIN pg_class seq ON seq.oid = d.objid AND seq.relkind = 'S'
      JOIN pg_class tbl ON tbl.oid = d.refobjid AND tbl.relname = ANY($1::text[])
      JOIN pg_namespace tns ON tns.oid = tbl.relnamespace AND tns.nspname = 'public'
      LEFT JOIN pg_attrdef ad ON ad.adrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'experiment\\_%')
        AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%' || seq.relname || '%'
      WHERE d.deptype = 'a'
      GROUP BY 1, 2 ORDER BY 1`, [VICTIMS]);
    out("sequences owned by victims + how many clone defaults name them", seqOwnedByVictims.rows);

    const schemas = await pool.query(`
      SELECT count(*)::int experiment_schemas FROM pg_namespace n WHERE n.nspname LIKE 'experiment\\_%'`);
    out("schema count", schemas.rows);
  } catch (error) {
    console.log(`\n== ${label} ERR ${error.message}`);
  } finally {
    await pool.end();
  }
}

(async () => {
  await run("postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp", "ymcp");
  await run("postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test", "ymcp_test");
})();
