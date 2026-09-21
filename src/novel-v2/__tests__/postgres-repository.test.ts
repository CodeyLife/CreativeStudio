import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chapterBlueprintFromRow, isTransientPostgresStartupError, NovelPostgresRepository, buildNarrativeRhythmSnapshotQuery, PROJECTABLE_FINAL_DOCUMENT_SQL } from "../postgres-repository";
import { DEFAULT_TARGET_WORD_COUNT } from "../word-count";

describe("postgres repository startup errors", () => {
  it("retries Postgres startup and recovery errors", () => {
    expect(isTransientPostgresStartupError({ code: "57P03", message: "the database system is not yet accepting connections" })).toBe(true);
    expect(isTransientPostgresStartupError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" })).toBe(true);
    expect(isTransientPostgresStartupError({ message: "Consistent recovery state has not been yet reached." })).toBe(true);
  });

  it("does not retry configuration or migration errors", () => {
    expect(isTransientPostgresStartupError({ code: "28P01", message: "password authentication failed for user ymcp" })).toBe(false);
    expect(isTransientPostgresStartupError({ code: "3D000", message: "database ymcp does not exist" })).toBe(false);
    expect(isTransientPostgresStartupError({ code: "42601", message: "syntax error at or near SELECT" })).toBe(false);
  });
});

describe("chapter blueprint row projection", () => {
  it("preserves planner rationale while keeping legacy scenes compatible", () => {
    const chapter = chapterBlueprintFromRow({
      id: "chapter-1",
      arc_id: "arc-1",
      project_id: "project-1",
      document_id: null,
      title: "夜谈",
      ordinal: 1,
      status: "planned",
      payload: {
        index: 1,
        title: "夜谈",
        scenes: [{
          title: "厨房",
          participants: ["主角"],
          situation: "雨夜停电",
          observableActions: ["收回问题"],
          planningRationale: "规划器内部推演，不进入正文执行合同",
          outcome: "关系距离变化",
        }],
      },
      source_artifact_id: null,
      blueprint_revision: 0,
    });

    expect(chapter.scenes[0].planningRationale).toBe("规划器内部推演，不进入正文执行合同");
    expect(chapterBlueprintFromRow({
      id: "chapter-legacy",
      arc_id: "arc-1",
      project_id: "project-1",
      document_id: null,
      title: "旧章",
      ordinal: 2,
      status: "planned",
      payload: { scenes: [{ title: "旧场景", participants: [], situation: "", observableActions: [], outcome: "" }] },
      source_artifact_id: null,
      blueprint_revision: 0,
    }).scenes[0]).not.toHaveProperty("planningRationale");
  });

  // 2026-09-17 断链修复双向锁（docs/novel-v2/ai-taint-diagnosis-20260917.md F1/§四-3）：
  // 此前本映射不读 payload.targetWordCount，补录值在行→记录这一步被静默丢弃，
  // chapter_planning_contexts 因此 226 行全空、写作端回落默认 3500，与编排指令
  // 手写的 2600 和门执法的 3500×0.6=2100 构成"同一目标三个数"。这条测试若失败，
  // 说明断链复发：写作契约会重新拿到一个不是规划者给的数字。
  it("preserves targetWordCount from the payload row (otherwise the writer never sees the planned length)", () => {
    const base = {
      id: "chapter-1",
      arc_id: "arc-1",
      project_id: "project-1",
      document_id: null,
      title: "夜谈",
      ordinal: 1,
      status: "planned" as const,
      source_artifact_id: null,
      blueprint_revision: 0,
    };
    // 正向：补录值原样进入记录（写作契约、审核面、执法门三面同源）。
    expect(chapterBlueprintFromRow({ ...base, payload: { targetWordCount: 2600 } }).targetWordCount).toBe(2600);
    // 小数取整，与 parseStoryArcBundle 同口径。
    expect(chapterBlueprintFromRow({ ...base, payload: { targetWordCount: 2799.6 } }).targetWordCount).toBe(2800);
    // 反向：缺省不注入（回落 DEFAULT_TARGET_WORD_COUNT，历史章零回归）。
    expect(chapterBlueprintFromRow({ ...base, payload: {} }).targetWordCount).toBeUndefined();
    // 反向：非法值一律不注入——0/负数/非数/NaN 都不得被当成目标传播。
    for (const bad of [0, -100, "2600", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chapterBlueprintFromRow({ ...base, payload: { targetWordCount: bad } }).targetWordCount).toBeUndefined();
    }
  });
});

describe("提交面有效目标篇幅（与 lifecycle 三面同尺）", () => {
  function repositoryWithChapterRow(row: { payload: Record<string, unknown> } | undefined) {
    const statements: string[] = [];
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", {
      value: { query: async (sql: string) => { statements.push(sql); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; } },
    });
    return { repository, statements };
  }

  it("无章节蓝图 ⇒ undefined：门不施，也不从没承载过该章的场合发明目标", async () => {
    const { repository } = repositoryWithChapterRow(undefined);
    await expect(repository.getChapterTargetWordCount("p1", "d1")).resolves.toBeUndefined();
  });

  it("有蓝图但未声明目标 ⇒ 回落默认值（与 draft prompt 播报同一个数）", async () => {
    const { repository } = repositoryWithChapterRow({ payload: {} });
    await expect(repository.getChapterTargetWordCount("p1", "d1")).resolves.toBe(DEFAULT_TARGET_WORD_COUNT);
    const { repository: dirty } = repositoryWithChapterRow({ payload: { targetWordCount: "2600" } });
    await expect(dirty.getChapterTargetWordCount("p1", "d1")).resolves.toBe(DEFAULT_TARGET_WORD_COUNT);
    const { repository: declared } = repositoryWithChapterRow({ payload: { targetWordCount: 2799.6 } });
    await expect(declared.getChapterTargetWordCount("p1", "d1")).resolves.toBe(2800);
  });

  it("有无蓝图的判据与 lifecycle 的 planningContext 同形（chapters JOIN arcs）", async () => {
    // lifecycle 侧 planningContext 为 undefined 的形态就是这条 join 拿不到行；提交面若只查
    // chapters，同一章会在一个面施门、另一个面不施（09-19 复核轮两把尺子的成因）。
    const { repository, statements } = repositoryWithChapterRow(undefined);
    await repository.getChapterTargetWordCount("p1", "d1");
    expect(statements[0].replace(/\s+/g, " ")).toMatch(/FROM chapters c JOIN arcs a ON a\.id=c\.arc_id/);
  });
});

describe("目标篇幅量纲与回落表达式单源", () => {
  const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(abs);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [abs] : [];
  });

  it("回落表达式只允许出现在 word-count 内，量纲判据只允许出现在 normalizeTargetWordCount", () => {
    const offenders: string[] = [];
    const predicateOffenders: string[] = [];
    for (const file of sourceFiles("src/novel-v2")) {
      if (file.endsWith("word-count.ts")) continue;
      const source = readFileSync(file, "utf8");
      // 剥注释行：负向锁只判代码本体（同仓既有口径——注释里引用被禁写法是"为什么禁"的说明）。
      const code = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
      if (/\?\?\s*DEFAULT_TARGET_WORD_COUNT/.test(code)) offenders.push(file);
      if (/targetWordCount\s*===\s*"number"/.test(code)) predicateOffenders.push(file);
    }
    expect(offenders).toEqual([]);
    expect(predicateOffenders).toEqual([]);
  });
});

describe("序列证据目标判据同形", () => {
  // 判据取仓储导出的那一份（断言的是"两侧都吃到它"）；常量自身的字面量由下一条锁守住。
  const PREDICATE = PROJECTABLE_FINAL_DOCUMENT_SQL;

  it("解析侧与投影侧读同一段判据，不是两处巧合同文", async () => {
    // 同形一旦断裂，形态就是"目标解析成功 → 快照查询 0 行 → 整块字段静默缺席"（F2 的成因）。
    expect(buildNarrativeRhythmSnapshotQuery()).toContain(PREDICATE);
    const statements: string[] = [];
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    Object.defineProperty(repository, "pool", { value: { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; } } });
    await repository.getLatestFinalChapterTarget("p1");
    expect(statements[0].replace(/\s+/g, " ")).toContain(PREDICATE);
  });

  it("判据字面量在仓储里只出现一次（常量定义处）", () => {
    const code = readFileSync("src/novel-v2/postgres-repository.ts", "utf8")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      // 折叠空白：这条判据原本就有三处是换行分写的，逐行匹配对那种形态天然失明
      // （与 run-lifecycle 的写入者计数锁同一课）。
      .join(" ")
      .replace(/\s+/g, " ");
    expect([...code.matchAll(/d\.status='final' AND d\.current_revision_id IS NOT NULL/g)].length).toBe(1);
    expect([...code.matchAll(/PROJECTABLE_FINAL_DOCUMENT_SQL/g)].length).toBeGreaterThan(6);
  });
});

/**
 * 真库用例的跳过判据单一真源（product-audit 事故①的锁）。
 * 旧形状 `if (EXPLICIT_TEST_DB_URL) throw` 在没设环境变量时把 CREATE SCHEMA／迁移 SQL／FK／
 * 权限错误一律当"环境缺失"吞掉 ⇒ 整块真库用例空过判绿。09-20 收口 6 个残留文件后用本锁钉住：
 * 凡"吞掉不可用警告"的测试文件都必须走 `isPostgresUnavailable`，且不得再出现环境变量存在性判据。
 */
describe("真库用例的跳过判据只许共享判据", () => {
  const dir = join(process.cwd(), "src", "novel-v2", "__tests__");
  const swallowing = readdirSync(dir)
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }))
    .filter((entry) => /Postgres (unavailable|不可用)/u.test(entry.source));

  it("判据覆盖面非空（扫描本身不得空转）", () => {
    expect(swallowing.length).toBeGreaterThan(20);
  });

  it("吞掉不可用警告的文件必须用 isPostgresUnavailable，且不得再用环境变量存在性判可达", () => {
    for (const entry of swallowing) {
      expect(entry.source, entry.file).toContain("isPostgresUnavailable(");
      expect(entry.source, entry.file).not.toContain("EXPLICIT_TEST_DB_URL");
    }
  });

  /**
   * 按**站点**而非按文件判：同一文件里可以一处用对判据、另一处无条件吞（实测抓到
   * `lease-integrity.test.ts` 的 reconcile 组——它 catch 任何 error 都只 warn 跳过，
   * 于是 09-21 一次迁移校验和漂移把整组真库用例静默跳过而全量仍判绿）。
   * 判据形态：打出"跳过"的那一行之上 5 行内必须出现 `isPostgresUnavailable(`。
   */
  it("每一处「因不可用而跳过」都必须紧跟共享判据（防空转的第二向）", () => {
    let sites = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".test.ts"))) {
      const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/console\.(warn|log)\(/u.test(line) || !/跳过/u.test(line)) return;
        sites += 1;
        const above = lines.slice(Math.max(0, index - 5), index).join("\n");
        expect(above, `${file}:${index + 1} 的跳过没有走共享判据`).toContain("isPostgresUnavailable(");
      });
    }
    expect(sites).toBeGreaterThanOrEqual(10); // 扫描空转时上面的循环不会给出任何失败
  });
});
