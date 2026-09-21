// 账本读者取证（只读库；文档里的"可复跑"证据面，克隆后即可用）。
//
// 回答三个问题，全部按实测回答、不按表名裸计数：
//  1. 代码侧：这些表/列有没有 SQL 读者与写者（剥注释行，按 SQL 动词 + 表名判）；
//  2. 库内现状：行数、体积、列填充数（"0 行≠死表"与"有存量⇒删除不可逆"两条都要数）；
//  3. DROP 前依赖面：归属序列、入向/出向外键、实验沙箱克隆个数。
//
// 用法：node scripts/evidence/ledger-readers.cjs [表名 ...]
// 默认审 commit_records 与 workflow_run_summaries（迁移 096 的两本只写不读账）。
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const DEFAULT_TABLES = ["commit_records", "workflow_run_summaries"];
const TABLES = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const TARGETS = TABLES.length ? TABLES : DEFAULT_TABLES;
// 列级判据要显式点名（代码侧扫描不知库内 schema）：--columns=a,b
const COLUMNS = (process.argv.find((arg) => arg.startsWith("--columns=")) ?? "").slice("--columns=".length).split(",").filter(Boolean);
const SCAN_DIRS = ["src", "scripts"];
const SQL_VERBS = ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH"];
const DATABASES = (process.env.EVIDENCE_DATABASES ?? "ymcp,ymcp_test").split(",").filter(Boolean);


/** 只留代码本体：整行注释与块注释行剔除（注释里提表名是说明，不是消费方）。 */
function codeOnly(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*|--)/.test(line)).join("\n");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    // 取证脚本自身把表名/列名当默认参数写着，扫自己会把工具读成消费者。
    else if (abs.startsWith(path.join("scripts", "evidence"))) continue;
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) out.push(abs);
  }
  return out;
}

let codeFiles;
/** 一次性读全仓代码本体并缓存（列级扫描要按列数重复比对，不能每次重读盘）。 */
function codeFilesOnce() {
  if (!codeFiles) {
    codeFiles = SCAN_DIRS.flatMap((dir) => (fs.existsSync(dir) ? walk(dir) : []))
      .map((file) => ({ file, code: codeOnly(fs.readFileSync(file, "utf8")) }));
  }
  return codeFiles;
}

function scanCode() {
  const rows = [];
  for (const { file, code } of codeFilesOnce()) {
    for (const table of TARGETS) {
      const pattern = new RegExp(`\\b(${SQL_VERBS.join("|")})\\b[^;]{0,200}?\\b${table}\\b`, "giu");
      for (const match of code.matchAll(pattern)) {
        const stmt = match[0];
        const relation = new RegExp(`\\b(from|join|into|update)\\s+${table}\\b`, "iu").exec(stmt)?.[1]?.toLowerCase();
        // 只有真正挂着介词的那条语句才算读写方；`to_regclass('public.x')` 这类目录探测
        // （撤表后的缺席锁就是这种）不算，单独归到 noise 面，免得把守卫读成消费者。
        if (!relation) continue;
        // 写语句自带的 RETURNING 是同事务内的读回：按"零 SELECT"判它无读者，正是把
        // memory_gate_states 这类单行状态机误判成死账的那一步。
        const semicolon = code.indexOf(";", match.index);
        const tail = code.slice(match.index, semicolon === -1 ? match.index + 800 : semicolon);
        rows.push({ file, table, verb: match[1].toUpperCase(), relation, inlineRead: /RETURNING\s/i.test(tail) });
      }
    }
  }
  return rows;
}

/** 列级判据：整词出现在代码本体里就算被引用（列名只能以 SQL 片段形态被用，无需再辨动词）。 */
function scanColumns(columns) {
  return columns.map((column) => {
    const hits = [];
    for (const { file, code } of codeFilesOnce()) {
      const n = (code.match(new RegExp(`\\b${column}\\b`, "gu")) ?? []).length;
      if (n) hits.push({ file, n });
    }
    return { column, sites: hits.length, total: hits.reduce((sum, hit) => sum + hit.n, 0), hits };
  });
}

async function main() {
  console.log("== 1. 代码侧 SQL 命中（剥注释；relation = 该表在语句里挂的介词）");
  const hits = scanCode();
  if (!hits.length) console.log("  (零命中 ⇒ 既无写方也无读方)");
  for (const hit of hits) console.log(`  ${hit.table} <- ${hit.verb}${hit.relation ? `/${hit.relation}` : ""} @ ${hit.file}`);
  const readers = hits.filter((hit) => hit.relation === "from" || hit.relation === "join");
  const writers = hits.filter((hit) => hit.relation === "into" || hit.relation === "update" || hit.verb === "DELETE");
  const inlineReads = writers.filter((hit) => hit.inlineRead).length;
  console.log(`  小结：写方 ${writers.length} 处（其中 ${inlineReads} 处带 RETURNING 读回）/ 读方 ${readers.length} 处 ⇒ ${readers.length ? "有读者" : inlineReads ? "读回内联在写语句里：零 SELECT ≠ 无读者，按死账判它会误删活机制" : writers.length ? "只写不读（真死账）" : "零读写方（死表）"}`);
  if (COLUMNS.length) {
    console.log("\n== 1b. 列级代码引用（整词命中；0 处 ⇒ 该列无任何读者与写者）");
    for (const item of scanColumns(COLUMNS)) {
      console.log(`  ${item.column}: ${item.sites} 个文件 / ${item.total} 处${item.hits.length ? ` —— ${item.hits.map((hit) => `${hit.file}×${hit.n}`).join(", ")}` : ""}`);
    }
  }

  console.log("\n== 2/3. 库内现状与 DROP 依赖面（只 SELECT 目录视图与计数）");
  for (const db of DATABASES) {
    const pool = new Pool({ connectionString: process.env.EVIDENCE_DATABASE_URL ? process.env.EVIDENCE_DATABASE_URL.replace("${db}", db) : `postgresql://ymcp:ymcp@127.0.0.1:5432/${db}` });
    console.log(`\n----- ${db}`);
    try {
      const present = await pool.query(
        "SELECT t.tbl, to_regclass('public.'||t.tbl) IS NOT NULL AS present FROM (SELECT unnest($1::text[]) AS tbl) t",
        [TARGETS],
      );
      console.log("  存在性:", JSON.stringify(present.rows));
      console.log("  归属序列:", JSON.stringify((await pool.query(`
        SELECT tbl.relname AS t, seq.relname AS seq FROM pg_depend d
        JOIN pg_class seq ON seq.oid=d.objid AND seq.relkind='S'
        JOIN pg_class tbl ON tbl.oid=d.refobjid AND tbl.relname=ANY($1::text[])
        JOIN pg_namespace n ON n.oid=tbl.relnamespace AND n.nspname='public' WHERE d.deptype='a'`, [TARGETS])).rows));
      console.log("  入向外键(别人引用它 ⇒ 撤它会连带):", JSON.stringify((await pool.query(`
        SELECT con.conname, cl.relname AS referencing FROM pg_constraint con
        JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_class ref ON ref.oid=con.confrelid
        WHERE ref.relname=ANY($1::text[]) AND con.contype='f'`, [TARGETS])).rows));
      console.log("  出向外键(它引用别人 ⇒ 撤它不受阻):", JSON.stringify((await pool.query(`
        SELECT cl.relname AS from_tbl, ref.relname AS to_tbl FROM pg_constraint con
        JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_class ref ON ref.oid=con.confrelid
        WHERE cl.relname=ANY($1::text[]) AND con.contype='f'`, [TARGETS])).rows.map((row) => `${row.from_tbl}→${row.to_tbl}`)));
      console.log("  沙箱克隆:", JSON.stringify((await pool.query(`
        SELECT c.relname AS t, count(*)::int clones FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname=ANY($1::text[]) AND n.nspname LIKE 'experiment\\_%' GROUP BY 1`, [TARGETS])).rows));
      for (const row of present.rows.filter((item) => item.present)) {
        const stats = await pool.query(`
          SELECT count(*)::int rows,
                 pg_size_pretty(pg_table_size('public.'||$1)) AS tbl_size,
                 pg_size_pretty(pg_total_relation_size('public.'||$1)) AS with_index_size
          FROM public.${row.tbl}`, [row.tbl]);
        console.log(`  ${row.tbl}:`, JSON.stringify(stats.rows[0]));
        const columns = await pool.query(
          "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [row.tbl],
        );
        const fill = [];
        for (const column of columns.rows) {
          if (!/^[a-z_][a-z0-9_]*$/u.test(column.column_name)) continue;
          const count = await pool.query(`SELECT count(${column.column_name})::int AS filled FROM public.${row.tbl}`);
          fill.push(`${column.column_name}=${count.rows[0].filled}`);
        }
        console.log(`  ${row.tbl} 列非空计数:`, fill.join(" "));
      }
    } catch (error) {
      console.log("  ERR", error.message);
    } finally {
      await pool.end();
    }
  }
}

main().catch((error) => { console.error("ERR", error.message); process.exit(1); });
