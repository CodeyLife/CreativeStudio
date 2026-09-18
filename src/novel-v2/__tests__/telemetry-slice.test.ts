import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 观测面 slice（第三片）的归属锁。
 *
 * 这一片不新增业务判据——它是把既有留痕/报表 SQL 关进单一归属地。因此守卫的是**归属**：
 * 四张只增观测表的写入与报表聚合只能出现在 slice 里。之所以值得锁：估算口径合并（token
 * basis）要读的正是这批表，若留痕 SQL 散回仓储，"谁在什么口径下写了这一列"就又要靠翻
 * 7,000 行文件回答——那正是当初把口径收敛成单一真源要消灭的情形。
 */

const REPO = readFileSync(join(process.cwd(), "src/novel-v2/postgres-repository.ts"), "utf8");
const SLICE = readFileSync(join(process.cwd(), "src/novel-v2/repository/telemetry-slice.ts"), "utf8");
/** 只扫代码本体：注释里提到表名既会假红也会掩盖真漂移（多行 SQL 模板块的行不以注释符开头，不受影响）。 */
const codeOnly = (source: string) => source.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line)).join("\n");
const REPO_CODE = codeOnly(REPO);
const SLICE_CODE = codeOnly(SLICE);
const TABLES = ["model_invocations", "prompt_executions", "context_manifests", "embedding_cache"];

describe("观测面 slice 归属", () => {
  it("四张观测表的写 SQL 只在 slice 里（例外逐个点名并附理由）", () => {
    // 三个例外都是**跨片编排**，写入面天然横跨多张业务表，硬搬会把别处的表拖进观测片：
    //   cleanupExpiredPromptExecutions 要同时动 content_blobs / snapshots（保留期）；
    //   deleteProject 是项目级联删除；
    //   putCognition 一次落 preflight/memory/skill/blueprint/manifest 整组认知包。
    // 例外按方法名点名，不接受"整文件放行"——新增一处直写即红。
    const ALLOWED_REPO_WRITERS = new Set(["cleanupExpiredPromptExecutions", "deleteProject", "putCognition"]);
    const methodStarts = [...REPO_CODE.matchAll(/^  (?:private |public )?async (\w+)\(/gm)].map((m) => ({ index: m.index ?? 0, name: m[1] }));
    const ownerAt = (index: number) => [...methodStarts].filter((m) => m.index < index).pop()?.name ?? "(file top)";
    for (const table of TABLES) {
      const source = `(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`;
      // /g 正则的 .test() 会推进 lastIndex，两处分用各自实例，别共享同一个。
      expect(new RegExp(source, "g").test(SLICE_CODE), `${table} 应在 slice 内有归属`).toBe(true);
      const offenders = [...REPO_CODE.matchAll(new RegExp(source, "g"))].map((m) => ownerAt(m.index));
      expect(offenders.filter((name) => !ALLOWED_REPO_WRITERS.has(name)), `仓储直接写 ${table} 的方法`).toEqual([]);
    }
  });

  it("仓储侧 12 个留痕/报表入口全部只剩委托", () => {
    for (const name of ["recordModelInvocation", "listModelInvocations", "listModelInvocationErrors", "listModelUsage",
      "getRoutingCandidateHealth", "getEstimatedVsProviderRatio", "recordPromptExecution", "listPromptExecutions",
      "getPromptExecutionSnapshot", "putPromptContextManifest", "lookupEmbeddings", "storeEmbeddings"]) {
      expect(REPO, name).toContain(`return this.telemetry.${name}(`);
    }
  });

  it("懒建 getter（构造期捕获 this.pool 会打死 Object.create 造桩路数）", () => {
    expect(REPO).toContain("private get telemetry(): TelemetrySlice {");
    expect(REPO).toContain("this.telemetrySlice ??= new TelemetrySlice(this.pool)");
  });

  it("采样命中的确定性仍走 context-manifest-sampling 单源，slice 不自己发明抽样", () => {
    expect(SLICE).toContain('from "../context-manifest-sampling"');
    expect(SLICE).toContain("contextManifestSamplingHit(");
    expect(SLICE).not.toMatch(/sha256[^;]*purpose[^;]*promptFingerprint[^;]*% *0x/u);
  });
});
