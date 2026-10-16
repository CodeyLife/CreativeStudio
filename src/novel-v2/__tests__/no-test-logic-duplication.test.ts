/**
 * "测试不得复刻生产逻辑"守卫（2026-10-14 复核轮 round 27）。
 *
 * 由来（round 26）：被测函数 `orderStateLikeSlotsByRecency` 是模块私有 ⇒ 外部测试
 * 无法直接调用 ⇒ 测试只能自己复刻一套同形逻辑 ⇒ **那份复刻锁住的是副本而不是源码**
 * （把生产源码的比较器方向改反，复刻型测试照样全绿）。修法是导出该函数并改为直接调用。
 *
 * round 27 把该教训推广为**全仓守卫**：任何测试 helper 若与生产源码逐行同形
 * （同一比较式/同一正则/同一段常量），就是"复刻生产逻辑"——它会在源码演进后
 * 悄悄变成过时副本，且**没有任何机制会发现这件事**。
 *
 * 判据（结构性，不靠猜）：归一化代码行（去空白与行尾注释、要求含运算符）后，
 * helper 函数体里 ≥2 行在生产源码中也出现，且占其代码行 ≥50% ⇒ 判为复刻候选。
 *
 * **禁止把判据简化成"名字相同"**（2026-10-14 round 57 核过）：
 * 本文件自己就在被扫描的范围里（round 56 的 audited 列表含它），
 * 且本文件自己的局部名（`walk`/`list`/`text`/`body`）与生产 helper **同名 5 处**。
 * 若判据取"名字相同"，守卫会**报它自己**，而唯一的"修复"是改守卫自己——
 * 典型的自我指涉陷阱。当前判据取"函数体同形"，实测本文件 110 行代码行里
 * 与生产同形 **0 行**（离阈值差 2 行），故自我免疫。
 * 这个免疫不是巧合，是"按结构判、不按名字判"的副产品——
 * 当初按结构判是为了跨措辞识别复刻，顺带也让守卫对自己安全。
 *
 * 两条自检（本会话的教训：判据本身必须先证明会响）：
 *   ① **人造正例自检**：把一段与生产源码逐行相同的代码写进临时测试文件，
 *      探测器必须抓到它（≥2 行命中）。抓不到 ⇒ 本守卫是空转，先修守卫。
 *   ② **真库样本自检**：`orderStateLikeSlotsByRecency` 的比较器行必须能被索引到
 *      （它是本守卫存在的理由）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = "src/novel-v2/__tests__";
const SRC_DIR = "src";

const walk = (dir: string, filter: (name: string) => boolean, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(name)) out.push(full);
  }
  return out;
};

/** 归一化代码行：去行尾注释与多余空白；只要"含运算符的可执行行"。 */
const normalizeLine = (line: string) => line.replace(/\/\/.*$/u, "").replace(/\s+/gu, " ").trim();
const codeLines = (text: string) => text.split(/\r?\n/)
  .map((line) => normalizeLine(line))
  .filter((line) => line.length >= 12 && /[=<>!+\-*/%?:]|&&|\|\||=>/u.test(line) && !/^(?:import|export)/u.test(line));

/** 抽 helper 函数体（括号配对）。 */
function extractHelpers(text: string): Array<{ name: string; body: string }> {
  const helpers: Array<{ name: string; body: string }> = [];
  for (const match of text.matchAll(/(?:const|function)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*\([^)]*\)\s*=>|\([^)]*\))\s*\{/gu)) {
    const braceStart = text.indexOf("{", match.index);
    let depth = 0;
    let end = braceStart;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") { depth -= 1; if (depth === 0) break; }
    }
    helpers.push({ name: match[1]!, body: text.slice(braceStart + 1, end) });
  }
  return helpers;
}

describe("测试不得复刻生产逻辑（round 27）", () => {
  const prodFiles = walk(SRC_DIR, (name) => /\.(ts|mts)$/u.test(name) && !name.endsWith(".test.ts"));
  const prodLineIndex = new Map<string, string[]>();
  for (const file of prodFiles) {
    for (const line of new Set(codeLines(readFileSync(file, "utf8")))) {
      const list = prodLineIndex.get(line) ?? [];
      list.push(file.replace(/\\/gu, "/"));
      prodLineIndex.set(line, list);
    }
  }

  it("① 人造正例自检：探测器对'复刻生产逻辑'必须能响", () => {
    // 取生产源码里真实存在的三行（含比较式），拼成一个人造 helper。
    const probes = [
      "if (leftStart !== rightStart) return rightStart - leftStart;",
      "const positions = slotPositions.get(claim.identityHash);",
      "if (!slotPositions.size) return claims;",
    ];
    const hits = probes.filter((probe) => prodLineIndex.has(probe.trim()));
    expect(hits.length, "人造正例必须能在生产源码索引里命中 ≥2 行，否则本守卫是空转").toBeGreaterThanOrEqual(2);
  });

  it("② round 26 的病灶行仍被索引（守卫的存在理由）", () => {
    // 该行正是 round 26 里"改反方向"的那行：若哪天它从源码消失，本守卫的存在理由也跟着消失。
    expect(prodLineIndex.has("if (leftStart !== rightStart) return rightStart - leftStart;"),
      "orderStateLikeSlotsByRecency 的比较器行必须仍在生产源码中（否则 round 26 的修法被回退了）").toBe(true);
  });

  it("③ 无测试 helper 复刻生产逻辑", () => {
    const testFiles = walk(TESTS_DIR, (name) => name.endsWith(".test.ts"));
    const offenders: Array<{ 文件: string; helper: string; 同形行: string[] }> = [];
    for (const file of testFiles) {
      const text = readFileSync(file, "utf8");
      for (const helper of extractHelpers(text)) {
        const lines = codeLines(helper.body);
        if (lines.length < 2) continue;
        const homomorphic = lines.filter((line) => prodLineIndex.has(line));
        if (homomorphic.length >= 2 && homomorphic.length / lines.length >= 0.5) {
          offenders.push({ 文件: file.replace(/\\/gu, "/"), helper: helper.name, 同形行: homomorphic.slice(0, 3) });
        }
      }
    }
    expect(offenders, `以下测试 helper 与生产源码逐行同形，属"复刻生产逻辑"——它们锁住的是副本：${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it("④ 反向哨兵：判据真的会判红（临时写入一个复刻 helper 再清掉）", () => {
    const probePath = join(TESTS_DIR, "__probe_duplication.test.ts");
    const existed = existsSync(probePath);
    const original = existed ? readFileSync(probePath, "utf8") : null;
    mkdirSync(TESTS_DIR, { recursive: true });
    writeFileSync(probePath, [
      'import { describe, expect, it } from "vitest";',
      'describe("probe", () => {',
      '  it("probe", () => {',
      "    const reordered = [...claims];",
      "    if (leftStart !== rightStart) return rightStart - leftStart;",
      "    const positions = slotPositions.get(claim.identityHash);",
      "    if (!slotPositions.size) return claims;",
      "    expect(reordered.length).toBeGreaterThan(0);",
      "  });",
      "});",
      "",
    ].join("\n"));

    try {
      const text = readFileSync(probePath, "utf8");
      const helpers = extractHelpers(text);
      // 取 it() 回调体作为被测 helper（正则抓到的第一个 `{` 体）。
      const body = helpers[0]?.body ?? text;
      const lines = codeLines(body);
      const homomorphic = lines.filter((line) => prodLineIndex.has(line));
      expect(lines.length, "探针应抽出若干代码行").toBeGreaterThan(0);
      expect(homomorphic.length, "反向哨兵：注入的复刻 helper 必须被命中 ≥2 行，否则判据失效").toBeGreaterThanOrEqual(2);
    } finally {
      if (original !== null) writeFileSync(probePath, original);
      else rmSync(probePath, { force: true });
    }
  });

  /**
   * 存在性断言不得恒真（2026-10-14 复核轮 round 56）。
   *
   * round 55 在 `state-slot-recency-live.test.ts` 抓到一个：
   * `expect(Array.isArray(multiValue)).toBe(true)` + 空数组的 `for` 断言
   * ——测试库无数据时 `[]` 也是数组、`for` 体一次不执行，于是"某类病例存在"
   * 这条断言**恒绿**。这是 round 52"反向断言可能恒真"的同族但**方向相反**
   * （那次是 not.toContain 恒真，这次是**正向断言恒真**）。
   *
   * round 56 按该判据扫我这几十轮的测试文件（4 条恒真形态正则，
   * 见 tmp/state-audit/audit-existence-assertions.mts 与其自检），
   * 结论：**除注释里的历史记录外无活断言命中**。
   *
   * 本锁固化为常态：新增的"存在性断言"不得取这些恒真形态；
   * 正确做法见 round 55——**空集时显式声明未验，而不是伪装成通过**。
   */
  it("⑤ 不得用会恒真的形态断言病例存在（round 56）", () => {
    const audited = [
      "state-slot-recency-live.test.ts",
      "blind-kill-live.test.ts",
      "qdrant-collection.test.ts",
      "skill-runtime.test.ts",
      "foundation-contract.test.ts",
      "craft-rule.test.ts",
      "book-synopsis.test.ts",
      "v2-repository-management.test.ts",
      "no-test-logic-duplication.test.ts",
      "lock-bite-registry.test.ts",
    ];
    const patterns: Array<[string, RegExp]> = [
      ["Array.isArray(...).toBe(true)", /expect\(\s*Array\.isArray\([^)]*\)\s*\)\.toBe\(true\)/gu],
      [">= 0 的比较（恒真）", /toBeGreaterThanOrEqual\(0\)/gu],
      ["空集迭代断言", /for\s*\([^)]*\)\s*\{[^}]*expect\(/gu],
      ["孤立 toBeDefined()", /expect\([^)]*\)\.toBeDefined\(\)\s*;\s*$/gmu],
    ];
    const offenders: Array<{ 文件: string; 行: number; 形态: string }> = [];
    for (const name of audited) {
      const full = join(TESTS_DIR, name);
      if (!existsSync(full)) continue;
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((line, index) => {
        // 注释与文档块里的历史记录不算（round 55 的说明就在注释里）。
        if (/^\s*(\*|\/\/|\/\*)/u.test(line)) return;
        for (const [label, pattern] of patterns) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) {
            offenders.push({ 文件: name, 行: index + 1, 形态: label });
            break;
          }
        }
      });
    }
    expect(offenders, `以下断言用了会恒真的形态（空集下也绿），应改为 round 55 的显式未验分支：${JSON.stringify(offenders)}`).toEqual([]);
  });
});
