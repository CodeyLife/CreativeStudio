// 死表扫描（只读取证）：判据沿用迁移 093 那轮的三条教训
//  ① 不整文件排除（同一文件可能另有真 SQL），只剥"清理清单式"的字面量数组行；
//  ② 按 SQL 动词 + 表名 计数，不按裸表名（否则误伤"解释为什么它被删"的注释与断言）；
//  ③ 解析迁移文本前先剥 SQL 注释（否则头注释里的示例 SQL 会凭空造出一张表）。
// 输出三类：候选死表（0 行 + 无读写方）、只被清理路径引用（无 SELECT 无 INSERT）、行数非零但无代码引用。
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const MIGRATIONS = "deploy/postgres";
const CODE_ROOTS = ["src", "scripts"];

const stripSqlComments = (text) => text.split(/\r?\n/).filter((line) => !/^\s*--/u.test(line)).join("\n");
const stripTsComments = (text) => text
  .split(/\r?\n/)
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
  .join("\n");

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/u.test(entry.name)) out.push(full);
  }
  return out;
}

function aliveTables() {
  const created = new Map();
  const dropped = new Set();
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/u.test(f)).sort()) {
    const text = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
    for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/giu)) {
      created.set(m[1].toLowerCase(), file);
    }
    // DROP TABLE a, b, c：逐个名字都要解析出来（093 首版只取第一个）
    for (const m of text.matchAll(/DROP TABLE(?: IF EXISTS)?\s+([^;]+);/giu)) {
      for (const name of m[1].split(",")) {
        const clean = name.trim().replace(/^(public\.)?/iu, "").split(/\s+/u)[0];
        if (/^[a-z_][a-z0-9_]*$/iu.test(clean)) dropped.add(clean.toLowerCase());
      }
    }
  }
  const survivors = [];
  for (const [table, file] of created) if (!dropped.has(table)) survivors.push({ table, createdIn: file });
  return survivors.sort((a, b) => a.table.localeCompare(b.table));
}

function codeReferences(tables) {
  const counts = new Map(tables.map((t) => [t.table, { INSERT: 0, UPDATE: 0, DELETE: 0, SELECT: 0, JOIN: 0, files: new Set() }]));
  const alternatives = tables.map((t) => t.table).join("|");
  const patterns = {
    INSERT: new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?(${alternatives})\\b`, "giu"),
    UPDATE: new RegExp(`UPDATE\\s+(?:public\\.)?(${alternatives})\\b`, "giu"),
    DELETE: new RegExp(`DELETE\\s+FROM\\s+(?:public\\.)?(${alternatives})\\b`, "giu"),
    SELECT: new RegExp(`FROM\\s+(?:public\\.)?(${alternatives})\\b`, "giu"),
    JOIN: new RegExp(`JOIN\\s+(?:public\\.)?(${alternatives})\\b`, "giu"),
  };
  for (const file of CODE_ROOTS.flatMap((root) => sourceFiles(root))) {
    const source = stripTsComments(fs.readFileSync(file, "utf8"));
    for (const [verb, pattern] of Object.entries(patterns)) {
      for (const m of source.matchAll(pattern)) {
        const record = counts.get(m[1].toLowerCase());
        if (!record) continue;
        record[verb] += 1;
        record.files.add(file.replace(/\\/g, "/"));
      }
    }
  }
  return counts;
}

(async () => {
  const tables = aliveTables();
  const refs = codeReferences(tables);
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const rows = new Map();
  try {
    for (const { table } of tables) {
      try {
        const result = await pool.query(`SELECT count(*)::int AS n FROM public.${table}`);
        rows.set(table, result.rows[0].n);
      } catch {
        rows.set(table, null); // 表在运行库不存在（如 093 已删而迁移文本仍算它活着）
      }
    }
  } finally {
    await pool.end();
  }

  const buckets = { dead: [], cleanupOnly: [], zeroRefButHasRows: [], missingInRuntime: [] };
  for (const { table, createdIn } of tables) {
    const r = refs.get(table);
    const readers = r.SELECT + r.JOIN;
    const writers = r.INSERT + r.UPDATE;
    const n = rows.get(table);
    const entry = { table, createdIn, rows: n, select: r.SELECT, join: r.JOIN, insert: r.INSERT, update: r.UPDATE, delete: r.DELETE, files: [...r.files].slice(0, 3) };
    if (n === null) buckets.missingInRuntime.push(entry);
    else if (!readers && !writers && !r.DELETE) buckets.dead.push(entry);
    else if (!readers && !writers && r.DELETE) buckets.cleanupOnly.push(entry);
    else if (!readers && !writers) buckets.dead.push(entry);
    else if (n > 0 && !readers && !writers) buckets.zeroRefButHasRows.push(entry);
  }
  console.log(`\n本仓迁移建的存活表 ${tables.length} 张`);
  for (const [key, list] of Object.entries(buckets)) {
    console.log(`\n### ${key} (${list.length})`);
    for (const item of list) console.log(`  ${item.table}  rows=${item.rows} S/J=${item.select}/${item.join} I/U/D=${item.insert}/${item.update}/${item.delete}  ${item.createdIn}  ${item.files.join(",")}`);
  }
})();
