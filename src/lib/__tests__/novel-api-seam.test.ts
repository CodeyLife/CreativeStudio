import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVE_RUN_POLL_MS, DIAGNOSTIC_POLL_MS, LEARNING_CENTER_POLL_MS, novelCommands, novelKeys, novelPaths, novelScopes } from "../novelApi";

/**
 * novelApi 接口面的守卫（W1 主体：三级收到一级）。
 *
 * 背景：`novelApi.ts` 曾把同一件事放出**三级**——40 个 hook（深）、5 个非 hook 普通函数
 * （中）、裸 `novelFetch`（浅）。消费侧自选了浅的两级：7 个文件、41 处调用，于是 react-query
 * 的缓存、去重、失效全部作废，失效被重新发明成父组件传下来的 prop 回调。
 * 详见 `.scratch/w1-novel-api-seam/spec.md`。
 *
 * 这个文件锁的是"收编不会退回去"：只要有人重新导出裸 transport、在页面里拼端点路径、
 * 或手写轮询间隔，这里就红。
 */

/** 判据必须落在代码上，不是注释上——迁移后的注释大量引用 `novelFetch` 讲历史。 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "__tests__" ? [] : walk(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  });
}

const apiPath = join(process.cwd(), "src/lib/novelApi.ts");
const apiSource = readFileSync(apiPath, "utf8");
const pageFiles = walk(join(process.cwd(), "src/pages"));
const rel = (file: string) => relative(process.cwd(), file).replace(/\\/g, "/");

describe("novelApi 接口面", () => {
  it("裸 transport 不在导出面上（`novelFetch` 为模块私有）", () => {
    const code = stripComments(apiSource);
    expect(/export\s+(async\s+)?function\s+novelFetch\b/.test(code), "novelFetch 又被导出了").toBe(false);
    expect(/export\s*\{[^}]*\bnovelFetch\b[^}]*\}/.test(code), "novelFetch 又被 re-export 了").toBe(false);
  });

  it("页面不得直连端点、不得拼 /v2/ 路径、不得手写轮询间隔", () => {
    const offenders = pageFiles.flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      const hits: string[] = [];
      if (/\bnovelFetch\s*[<(]/.test(code)) hits.push("直连 novelFetch");
      if (/["'`]\/v2\//.test(code)) hits.push("/v2/ 字面量路径");
      if (/\brefetchInterval\b/.test(code)) hits.push("手写 refetchInterval");
      return hits.length ? [`${rel(file)}: ${hits.join("、")}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("两个原语是消费侧唯一入口，且确有消费方（不是空转机制）", () => {
    for (const primitive of ["useNovelQuery", "useNovelCommand"]) {
      expect(apiSource).toContain(`export function ${primitive}`);
      const users = pageFiles.filter((file) => new RegExp(`\\b${primitive}\\b`).test(readFileSync(file, "utf8")));
      expect(users.length, `${primitive} 应有消费方，否则是空转机制`).toBeGreaterThan(0);
    }
  });

  it("唯一的逃逸口是有名字、有契约的 executeNovelTool", () => {
    expect(apiSource).toContain("export async function executeNovelTool");
    // 逃逸口只服务通用工具执行器：除它之外不应有第二个"任意 args"入口。
    const callers = pageFiles.filter((file) => /\bexecuteNovelTool\b/.test(readFileSync(file, "utf8")));
    expect(callers.map(rel)).toEqual(["src/pages/novel-v2/McpToolGatewayPanel.tsx"]);
  });

  it("命令注册表每条都有合法 method 与 path 构造器", () => {
    /**
     * `novelCommands` 是 `as const`，每条命令的字段集各不相同，直接遍历会得到联合类型
     * （访问 `.body` 编译不过）。这里按"契约字段"重新标注，正是这条用例要检查的形状。
     */
    const entries = Object.entries(novelCommands) as Array<[string, {
      method: string;
      path: unknown;
      body?: unknown;
      headers?: unknown;
      invalidates?: unknown;
    }]>;
    expect(entries.length).toBeGreaterThan(20);
    for (const [name, command] of entries) {
      expect(["POST", "PATCH", "PUT", "DELETE"], `${name} 的 method`).toContain(command.method);
      expect(typeof command.path, `${name} 的 path`).toBe("function");
      if (command.body !== undefined) expect(typeof command.body, `${name} 的 body`).toBe("function");
      if (command.headers !== undefined) expect(typeof command.headers, `${name} 的 headers`).toBe("function");
      if (command.invalidates !== undefined) expect(typeof command.invalidates, `${name} 的 invalidates`).toBe("function");
    }
  });

  it("九类曾无 key 的资源都已在 key 表里，且项目级资源可被项目前缀失效覆盖", () => {
    const projectId = "p1";
    const projectPrefix = novelScopes.project(projectId);
    const families = [
      novelKeys.projectPlan(projectId),
      novelKeys.storyArcs(projectId),
      novelKeys.knowledge(projectId, "characters"),
      novelKeys.creativeRuns(projectId),
      novelKeys.snapshots(projectId),
      novelKeys.experiments(projectId),
      novelKeys.candidates(projectId),
      novelKeys.receipts(projectId),
      novelKeys.scriptSubjectPreset(projectId),
    ];
    for (const key of families) {
      // react-query 按前缀失效：项目级资源必须以项目前缀开头，否则"一次失效整族"不成立。
      expect(key.slice(0, projectPrefix.length), `${key.join("/")} 应挂在项目前缀下`).toEqual([...projectPrefix]);
    }
  });

  /**
   * 轮询间隔只有一个来源：常量。
   *
   * 失效形态（本用例首版踩过）：只断言 `typeof ACTIVE_RUN_POLL_MS === "number"` 且 `> 0`
   * 是**恒真**——常量在不在、10 处硬编码删没删，断言都通过，属"绿的说谎"。
   * 本版把判据挪到**调用点**：任何 `refetchInterval` 附近出现数字字面量即红。
   *
   * 取三行窗口而非单行：取值可能跨行（`refetchInterval: pollWhile` 后面才是三元与箭头
   * 函数），只看单行会漏掉原语内部的真实取值。
   */
  it("轮询间隔只来自常量：调用点不得再出现数字字面量", () => {
    const code = stripComments(apiSource);
    const lines = code.split(/\r?\n/u);
    const offenders: string[] = [];
    lines.forEach((line, index) => {
      if (!/\brefetchInterval\b/u.test(line)) return;
      const window = lines.slice(index, index + 3).join("\n");
      // 数字字面量（含 `30_000` 形态）；标识符内部的数字不算。
      if (/(?<![\w.])\d[\d_]*(?![\w.])/u.test(window)) offenders.push(`novelApi.ts:${index + 1}: ${line.trim()}`);
    });
    expect(offenders, "间隔数字不得出现在调用点，只能用常量").toEqual([]);

    // 节拍语义本身也要锁：三个名字若被改成同一个数，"按数据变化速度分档"的设计就没了。
    expect(ACTIVE_RUN_POLL_MS, "活跃 run 必须是最快的一档").toBeLessThan(LEARNING_CENTER_POLL_MS);
    expect(LEARNING_CENTER_POLL_MS, "诊断档必须慢于学习中心档").toBeLessThan(DIAGNOSTIC_POLL_MS);

    // 反向：常量必须真的被消费（声明处之外至少一处），否则"收口"只是把数字搬去没人读的地方。
    for (const constant of ["ACTIVE_RUN_POLL_MS", "DIAGNOSTIC_POLL_MS", "LEARNING_CENTER_POLL_MS"]) {
      const uses = (apiSource.match(new RegExp(`\\b${constant}\\b`, "gu")) ?? []).length;
      expect(uses, `${constant} 只被声明、没有被消费`).toBeGreaterThan(1);
    }
  });

  it("路径注册表覆盖读路径（页面零 /v2/ 的前提）", () => {
    for (const [name, build] of Object.entries(novelPaths)) {
      expect(typeof build, `${name}`).toBe("function");
    }
    expect(novelPaths.projectPlan({ projectId: "p1" })).toBe("/v2/projects/p1/plan");
    expect(novelPaths.knowledge({ projectId: "p1", kind: "characters" })).toBe("/v2/projects/p1/knowledge/characters");
  });
});
