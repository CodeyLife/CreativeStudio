/**
 * MCP 工具面单一真源守卫。
 *
 * 根因：工具面是外部编排者（dsh / 外部大模型 / 用户）唯一的行动依据，但它的定义
 * 分散在代码注册表、两份 spec 文档与两份 skill 契约面之间。2026-09-17 "独立短剧改
 * 浏览器本地存储" 一次性移除 10 个工具（见 mcp-tool-gateway.test.ts:46 的计数链），
 * 代码与计数测试同步改了，agent 侧契约面却继续把 `novel_short_script_h3` 等三个
 * 已不存在的工具描述为可调用——外部编排者按文档调用即失败，且失败形态是"工具不存在"
 * 而非"功能未做"，会诱发反复重试的编排死循环。
 *
 * 判据刻意保持泛化（不识别具体工具名/题材）：
 * 1. **调用形态**引用（`novel_x(` 带左括号）= 契约承诺，必须存在于注册表；
 *    纯文本提及（不带括号）视为叙述，不判定——历史台账因此无需逐条改写。
 * 2. 文档声明的工具总数必须等于代码派生的 `TOOL_COUNT`（真值只在代码侧）。
 * 3. 元数据面（TOOL_GROUPS / DIRECT_EXEC_TOOLS / TOOL_DESCRIPTIONS）不得引用
 *    未注册工具，且注册表里每个工具都要有可读标签（双向覆盖）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../mcp/tool-definitions";
import { DIRECT_EXEC_TOOLS, TOOL_COUNT, TOOL_DESCRIPTIONS, TOOL_GROUPS } from "../mcp/tool-metadata";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTERED = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * 时点记录豁免：文件名带 8 位日期戳（`-20260916`）的文档记录的是"当时做了什么"，
 * 其中对已移除工具的调用形态描述属于事实记录，不得为了让守卫变绿而回写成"从未存在"。
 * 判据按日期戳而非文档名清单——活契约面（workflow-map / mcp-orchestrator / 各 SKILL）
 * 一律不带日期后缀，因此新增历史报告自动豁免、新增活契约自动受检。
 * 已知边界：把活契约命名成带日期后缀会绕过本守卫；反向（历史文档不带日期）只会更严。
 */
const POINT_IN_TIME_PATTERN = /-20\d{6}(?=\.|_)/u;

function sourceFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(join(dir, entry)));
    else if (/\.(?:md|ts|mjs)$/u.test(entry)) out.push(full);
  }
  return out;
}

describe("MCP 工具面单一真源", () => {
  // 只扫 agent 侧契约面（文档 / skill / 运维脚本）。src 内的 `novel_projects(` 一类
  // 命中的是 SQL 表名而非工具名，纳入只会制造噪声。
  const scanned = ["docs", ".agents/skills", "scripts"].flatMap(sourceFiles);

  it("agent 契约面不得以调用形态引用未注册工具", () => {
    const violations: string[] = [];
    for (const file of scanned) {
      const relative = file.slice(REPO_ROOT.length).replace(/\\/gu, "/");
      if (POINT_IN_TIME_PATTERN.test(relative)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/novel_[a-z0-9_]+(?=\s*\()/gu)) {
        if (!REGISTERED.has(match[0])) violations.push(`${relative}: ${match[0]}`);
      }
    }
    // 反例面（本守卫要拦的形状）：09-17 移除的独立短剧三工具曾被四处契约面写成可调用。
    expect(violations.sort()).toEqual([]);
  });

  it("凡把工具面呈现为可调用的契约面，必须声明与代码一致的总数", () => {
    const offenders: string[] = [];
    let surfaces = 0;
    for (const file of scanned) {
      const relative = file.slice(REPO_ROOT.length).replace(/\\/gu, "/");
      if (POINT_IN_TIME_PATTERN.test(relative)) continue;
      const text = readFileSync(file, "utf8");
      if (!/novel_[a-z0-9_]+\s*\(/u.test(text)) continue;
      surfaces += 1;
      const declared = /当前工具面[^\d]{0,12}(\d{2,3})/u.exec(text);
      if (!declared) offenders.push(`${relative}: 缺少「当前工具面：<TOOL_COUNT>」声明`);
      else if (Number(declared[1]) !== TOOL_COUNT) offenders.push(`${relative}: 声明 ${declared[1]} ≠ 代码 ${TOOL_COUNT}`);
    }
    expect(surfaces).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("元数据面与注册表双向覆盖", () => {
    const grouped = TOOL_GROUPS.flatMap((group) => group.tools as string[]);
    expect(grouped.filter((name) => !REGISTERED.has(name))).toEqual([]);
    expect([...DIRECT_EXEC_TOOLS].filter((name) => !REGISTERED.has(name))).toEqual([]);
    // 注册表新增工具但没给可读标签/没归组 = 目录面静默漏项，外部编排者看不到它。
    const unlabeled = [...REGISTERED].filter((name) => !TOOL_DESCRIPTIONS[name]);
    expect(unlabeled).toEqual([]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.length).toBe(TOOL_COUNT);
  });

  it("注册表文件头的分组括号数总和等于 TOOL_COUNT", () => {
    const source = readFileSync(fileURLToPath(new URL("../mcp/tool-definitions.ts", import.meta.url)), "utf8");
    const header = source.slice(0, source.indexOf("*/"));
    const perGroup = [...header.matchAll(/（(\d{1,2})/g)].map((match) => Number(match[1]));
    expect(perGroup.length).toBe(TOOL_GROUPS.length);
    expect(perGroup.reduce((sum, value) => sum + value, 0)).toBe(TOOL_COUNT);
  });

  /**
   * 文件头分组是"按能力分类"的账，正文的 `// ===== 段名（N）=====` 是"按代码位置分段"的账，
   * 两者会各自漂移：2026-09-20 取证时正文三处括号已与实际条目不符（一键流程标 2 实为 13、
   * 外部产出标 3 实为 2、外部 LLM 参与标 5 实为 9），而头部分组总和仍恰好等于 50——
   * 只锁头部会漏掉这类"注释段落边界变了、括号留在旧数"的漂移。
   */
  it("注册表正文每个段落标记的括号数等于该段实际条目数", () => {
    const source = readFileSync(fileURLToPath(new URL("../mcp/tool-definitions.ts", import.meta.url)), "utf8");
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex((line) => /\/\/ ===== 工具定义 =====/u.test(line));
    expect(start).toBeGreaterThan(-1);
    const marks = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.index > start && /\/\/ ===== .+（\d{1,2}/u.test(entry.line));
    expect(marks.length, "段落标记扫描不得空转").toBeGreaterThan(5);
    const total = marks.reduce((sum, mark, position) => {
      const end = position + 1 < marks.length ? marks[position + 1].index : lines.length;
      const actual = lines.slice(mark.index, end).filter((line) => /\bname: "novel_/u.test(line)).length;
      expect(Number(/（(\d{1,2})/u.exec(mark.line)?.[1]), mark.line.trim()).toBe(actual);
      return sum + actual;
    }, 0);
    expect(total).toBe(TOOL_COUNT);
  });
});
