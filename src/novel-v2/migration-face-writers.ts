/**
 * 已撤销的表/列（"face"）与仍在其上写入的代码之间的对账判据。
 *
 * 存在的理由是一条真实时序缺口：撤表/撤列的迁移由**新代码**在启动时 `migrate()` 应用，
 * 但只要旧进程还活着（半停服、多实例、蓝绿没切干净），它持有的仍是"往已被删掉的对象写"
 * 那份 SQL —— 后果不是启动失败而是运行期某条业务路径抛 `relation/column does not exist`。
 * 本仓的撤面迁移（093/095/096 撤表、097 撤列）都靠"停服→迁移→起服"这个顺序假设保平安，无人核对过。
 *
 * 判据放这里而不是写在 doctor 里，是为了能被单测双向覆盖；doctor 只做取数与打印。
 */

/** 剥掉 SQL 行注释与 /* *\/ 块注释：迁移头注释里的示例 SQL 不是真语句（093 实测踩到）。 */
export function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, " ");
}

export type DroppedFace =
  | { kind: "table"; name: string; migration: string }
  | { kind: "column"; name: string; table: string; migration: string };

const TABLE_NAME = "[a-z_][a-z0-9_]*";

/**
 * 从单个迁移文件正文里解析出它撤掉的表与列。
 *
 * 刻意不理解"后续又 CREATE 回来"这种跨文件情形：调用方只喂**已应用**的文件，
 * 而本仓对已应用的迁移是只增不改的（改正文要登记 checksumAliases），所以
 * "后发的 CREATE"不可能出现在同一个 version 上。
 */
export function parseDroppedFaces(source: { version: string; text: string }): DroppedFace[] {
  const text = stripSqlComments(source.text);
  const faces: DroppedFace[] = [];
  for (const match of text.matchAll(new RegExp(`DROP TABLE(?: IF EXISTS)?\\s+(${TABLE_NAME}(?:\\s*,\\s*${TABLE_NAME})*)`, "giu"))) {
    for (const name of match[1].split(",").map((item) => item.trim()).filter(Boolean)) {
      faces.push({ kind: "table", name, migration: source.version });
    }
  }
  // ALTER TABLE t DROP COLUMN a, DROP COLUMN b; —— 一条语句里可有多个 DROP COLUMN，
  // 也可有 DROP CONSTRAINT/DROP NOT NULL 等无关动作，故按子句逐个取，不整串匹配。
  for (const stmt of text.split(";")) {
    const head = new RegExp(`ALTER TABLE\\s+(?:public\\.)?(${TABLE_NAME})`, "iu").exec(stmt);
    if (!head) continue;
    for (const column of stmt.matchAll(new RegExp(`DROP COLUMN(?: IF EXISTS)?\\s+(${TABLE_NAME})`, "giu"))) {
      faces.push({ kind: "column", name: column[1], table: head[1], migration: source.version });
    }
  }
  return faces;
}

/**
 * 粗筛判据：喂给 `git grep -l -E`，只用来挑出**候选文件**，宁可多挑。
 *
 * 刻意不在这里定罪——git grep 按行匹配且不认注释，而本仓迁移头注释与代码注释里大量
 * 出现被撤对象的名字（"为什么删它"正当引用）。定罪交给 {@link findWriterMatches}。
 */
export function candidateFilePattern(faces: DroppedFace[]): string {
  const names = [...new Set(faces.map((face) => face.name))];
  return names.length ? `\\b(${names.join("|")})\\b` : "";
}

/**
 * 把整行注释替换成空行（保留行数，好让报出来的行号仍对得上原文件）：
 * 注释里的表名列名是说明，不是消费方——与全仓接线锁同一口径。
 */
function stripCommentLines(text: string): string {
  return text.split(/\r?\n/).map((line) => (/^\s*(\/\/|\*|\/\*|--)/u.test(line) ? "" : line)).join("\n");
}

/** 源码里的字符串字面量（含模板串）及其起始行号——SQL 在本仓恒以字符串字面量形态出现。 */
function stringLiterals(text: string): Array<{ body: string; at: number }> {
  const out: Array<{ body: string; at: number }> = [];
  const pattern = /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu;
  for (const match of text.matchAll(pattern)) {
    out.push({ body: match[0], at: text.slice(0, match.index).split("\n").length });
  }
  return out;
}

/**
 * 精判：给定文件正文，找出仍在写被撤对象的语句。
 *
 * 判定单位是**字符串字面量**而不是行，两条理由：SQL 常跨行（模板串），而按行判会把
 * 跨行的 `INSERT INTO t(...)\n col ...` 漏掉；而 TS 字段名与列名同词（`blueprint`、
 * `sourceArtifactId` 之类），按行/按标识符判会把满仓的属性读写读成 SQL。
 *
 * - 表：字面量里出现挂介词的写短语（`INSERT INTO t` / `UPDATE t` / `DELETE FROM t`）。
 *   于是 `to_regclass('public.t')` 这类"证明它已缺席"的守卫不会定罪——它没有写介词。
 * - 列：字面量里**同时**出现"对该宿主表的写短语"与被撤列名。只认写不认读，因为本检查的
 *   主语是"旧进程还往已不存在的对象写"；纯 SELECT 的别名（`ch.payload AS blueprint`）与
 *   information_schema 式的缺席守卫（同时写着表名与 `published_at`）都不算。
 *   代价：跨字面量拼 SQL（写短语与列名分在两个串里）会漏报；本仓 SQL 都是整段字面量。
 * - 注释不参与判定（先剥 `//`、`*`、`/* *\/`、`--` 起始行），"解释为什么撤它"的说明不被定罪。
 */
export function findWriterMatches(faces: DroppedFace[], sources: Array<{ file: string; text: string }>): Array<{ file: string; at: string; face: string; migration: string }> {
  const tables = faces.filter((face): face is Extract<DroppedFace, { kind: "table" }> => face.kind === "table");
  const columns = faces.filter((face): face is Extract<DroppedFace, { kind: "column" }> => face.kind === "column");
  const tableSource = tables.length ? `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?(${tables.map((face) => face.name).join("|")})\\b` : null;
  const matches: Array<{ file: string; at: string; face: string; migration: string }> = [];
  for (const { file, text } of sources) {
    const literals = stringLiterals(stripCommentLines(text));
    for (const { body, at } of literals) {
      const tableHit = tableSource ? new RegExp(tableSource, "iu").exec(body) : null;
      if (tableHit) {
        const face = tables.find((item) => item.name === tableHit[2]);
        if (face) matches.push({ file, at: String(at), face: face.name, migration: face.migration });
      }
      for (const column of columns) {
        if (!new RegExp(`\\b${column.name}\\b`, "u").test(body)) continue;
        if (!new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${column.table}\\b`, "iu").test(body)) continue;
        matches.push({ file, at: String(at), face: `${column.table}.${column.name}`, migration: column.migration });
      }
    }
  }
  return matches;
}

/** 候选扫描面：SQL 只可能出现在这些目录里（与复活锁同一范围，不扫 node_modules）。 */
export const WRITER_SCAN_PATHS = ["src", "scripts"] as const;
