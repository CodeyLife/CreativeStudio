import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "先写库、后写索引"的写入点必须全部走共享包膜（state-audit-20261013 §8.6）。
 *
 * 背景：本仓有 8 处这样的写入点，其中 **5 处曾只 `console.warn`**。逐处手写 catch 时
 * 形状会各自演进，实测出现三种互不相认的形态：
 *   ① 只 warn（5 处）——**静默欠灌**：库里那一行此后在一切查询里都显得完全活着，
 *      只有语义检索永远召不回它，没有任何科目变红；
 *   ② 返回 error 字段给调用方（mcp/handlers）——只在同步响应里可见，无耐久账；
 *   ③ 落 projection_failures（chapter-state-rebuild）——正确但只有一处这么做。
 *
 * 根因不是"忘了写 catch"，而是**没有共享形状**：每个站点自己决定失败后怎么办。
 * 故 `writeMemoryIndexWithTrace` 收口"不抛 + 落账 + 记账自身失败也不抛"三件事。
 *
 * 本锁防的是**回退**：任何人新写（或改写）一处索引同步点时，若退回裸 try/catch，
 * 这里会红。判据是源码级扫描——凡是同时含 `memoryIndex` upsert/delete 与
 * `console.warn` 的文件，必须出现包膜调用。
 *
 * 例外（有意不覆盖）：`mcp/handlers.ts` 把 vectorSyncError 作为工具返回值传出，
 * 调用方（外部编排 LLM）能立刻看到并重试；它不需要耐久账，因为失败是同步可见的。
 */
const ROOT = join(process.cwd(), "src", "novel-v2");

/** 出现"索引写入 + warn"的文件清单（真正需要包膜的面）。 */
const INDEX_WRITE_SITES = [
  "chapter-memory/index.ts",
  "commit-service.ts",
  "character-enrichment/index.ts",
  "temporal/activities.ts",
  "application/chapter-state-rebuild.ts",
] as const;

describe("索引写入点的失败处理必须走共享包膜", () => {
  it("每个索引写入调用都必须在包膜内（站点级计数，不是文件级）", () => {
    // 文件级断言不够：同一文件有三处站点，只回退其中一处（退回裸 try/catch）时，
    // 文件里仍有 writeMemoryIndexWithTrace 字样，锁会空转。故按"裸调用计数"判：
    // 每处 `.upsertClaims(` / `.deleteClaims?.(` 之前 400 字符内必须出现包膜调用。
    for (const file of INDEX_WRITE_SITES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const bare: number[] = [];
      // 形态兼容 `!` 非空断言与 `?.` 可选调用：`memoryIndex!.upsertClaims(` 与
      // `memoryIndex.deleteClaims?.(` 都要认。少了任一件形态，锁就会漏掉整个站点。
      const calls = [...source.matchAll(/\.(upsertClaims|deleteClaims)\??\.?\(/gu)];
      for (const call of calls) {
        // 窗口 600：包膜调用到真正的写入之间有注释 + 6 个参数字段，CRLF 下约占 400-500 字符。
        // 取 600 留余量；判据仍是"包膜调用必须出现在写入之前"，不是"必须紧邻"。
        const before = source.slice(Math.max(0, (call.index ?? 0) - 600), call.index ?? 0);
        if (!before.includes("writeMemoryIndexWithTrace({")) bare.push(call.index ?? 0);
      }
      expect(bare, `${file} 有 ${bare.length} 处索引写入未走包膜（只 warn = 静默欠灌）`).toEqual([]);
      expect(calls.length, `${file} 一个写入调用都没扫到：锁空转了，须修锁`).toBeGreaterThan(0);
    }
  });

  it("包膜自身三件事齐全：不抛、落账、记账失败也不抛", () => {
    const source = readFileSync(join(ROOT, "memory-index-drift.ts"), "utf8");
    const wrapper = source.slice(source.indexOf("export async function writeMemoryIndexWithTrace"));
    expect(wrapper.length, "定位不到包膜函数：锁会空转，必须修锁而非放行").toBeGreaterThan(200);
    // ① 不抛：write 的失败被包住。
    expect(wrapper).toContain("try {");
    expect(wrapper).toContain("} catch (error) {");
    // ② 落账：调注入的 record。
    expect(wrapper).toContain("await input.record(");
    // ③ 记账自身失败也不抛：内层还有一层 catch（第一次 catch 治写入失败，第二次治记账失败）。
    const catchCount = wrapper.split("} catch (").length - 1;
    expect(catchCount, "两层 catch：写入失败一层、记账失败一层").toBeGreaterThanOrEqual(2);
    expect(wrapper).toContain("观测降级");
    // 返回值区分成败，调用方可按需感知（不强迫所有站点都处理失败）。
    expect(wrapper).toContain("ok: true");
    expect(wrapper).toContain("ok: false");
  });

  it("包膜只此一份实现，不得有第二个同义函数", () => {
    // 曾经的形态：round 5 先落了 audit_records 专用方法，round 7 收口到 projection_failures
    // 包膜时把它撤掉。若再出现第二个"索引失败记账"函数，形状又会各自演进。
    const offenders: string[] = [];
    for (const file of [...INDEX_WRITE_SITES, "postgres-repository.ts", "memory-index-drift.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const names = [...source.matchAll(/(?:async\s+)?function\s+(\w*(?:IndexWriteFailure|MemoryIndexWithTrace)\w*)/gu)].map((match) => match[1]);
      for (const name of names) if (name !== "writeMemoryIndexWithTrace") offenders.push(`${file}:${name}`);
      // 仓储侧的同义方法名（recordMemoryIndexWriteFailure）一并禁掉。
      if (/recordMemoryIndexWriteFailure/u.test(source)) offenders.push(`${file}:recordMemoryIndexWriteFailure`);
    }
    expect(offenders).toEqual([]);
  });
});
