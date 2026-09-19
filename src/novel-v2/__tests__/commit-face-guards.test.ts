import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { NovelPostgresRepository } from "../postgres-repository";
import { CommitService } from "../commit-service";
import { inspectManuscript } from "../application/manuscript-structure";
import type { Artifact } from "../protocol";

/**
 * 提交面（`CommitService` + 默认面的账本投影）的两道守卫。
 *
 * 用假连接而不是起 Postgres：本仓既有做法（见 `workflow-run-slice.test.ts`），事务边界与
 * 门参数这类"SQL 形状 + 调用序"判据在假连接上是确定性断言，且 DB 不可用时不会整组静默
 * 失效；真库面仍由 `foreshadowing-order.test.ts` 的投影回归负责。
 */

type Probe = { statements: string[]; transactions: string[] };

function stubRepository(options: { failWhen?: (sql: string) => boolean } = {}) {
  const probe: Probe = { statements: [], transactions: [] };
  const run = async (sql: string) => {
    const head = sql.trim().split(/\s+/)[0].toUpperCase();
    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") {
      probe.transactions.push(head);
      return { rows: [], rowCount: 0 };
    }
    probe.statements.push(sql);
    if (options.failWhen?.(sql)) throw new Error("stub：该语句失败");
    return { rows: [{ id: "revision-1", content_hash: "hash-1" }], rowCount: 1 };
  };
  const client = { query: run, release: () => undefined };
  const pool = { query: run, connect: async () => client } as unknown as Pool;
  const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
  Object.defineProperty(repository, "pool", { value: pool });
  return { repository, probe };
}

const ledgerInput = {
  projectId: "p1",
  documentId: "doc-1",
  artifact: { id: "artifact-1", projectId: "p1", taskId: "t", attemptId: "a", kind: "draft", contentHash: "hash-1", baseRevision: 0, fingerprint: "fp", createdAt: 1 } as unknown as Artifact,
  revisionId: "revision-1",
  narrativeOrder: 3,
  narrativeElements: {
    foreshadowings: [{ description: "井底铜镜背面的刻痕", triggerKeywords: ["刻痕"], expectedPayoffWindow: "本卷末", evidence: "她用指腹擦过刻痕。" }],
    promises: [{ promiser: "甲", promisee: "乙", statement: "三日内答复", evidence: "甲在门口说完就转身走了。" }],
    payoffs: [],
  },
};

describe("默认面的账本投影原子性（F3）", () => {
  it("未传连接时自管一个事务，整组投影一起提交", async () => {
    const { repository, probe } = stubRepository();
    await repository.recordNarrativeElements(ledgerInput);
    expect(probe.transactions).toEqual(["BEGIN", "COMMIT"]);
    expect(probe.statements.some((sql) => /INSERT INTO foreshadowing/i.test(sql))).toBe(true);
    expect(probe.statements.some((sql) => /INSERT INTO promises/i.test(sql))).toBe(true);
  });

  it("中途语句失败时整组回滚并把错误抛给调用方（不留半提交账本）", async () => {
    const { repository, probe } = stubRepository({ failWhen: (sql) => /INSERT INTO promises/i.test(sql) });
    await expect(repository.recordNarrativeElements(ledgerInput)).rejects.toThrow("stub：该语句失败");
    expect(probe.transactions).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("调用方已持事务（传入 client）时不嵌套 BEGIN，沿用其边界", async () => {
    const { repository, probe } = stubRepository();
    const outer = { query: async (sql: string) => { probe.statements.push(sql); return { rows: [{ id: "revision-1" }], rowCount: 1 }; } };
    await repository.recordNarrativeElements(ledgerInput, outer as never);
    expect(probe.transactions).toEqual([]);
  });

  it("快照投影走同一条包装：默认面先 BEGIN，失败即整组 ROLLBACK", async () => {
    // 行为向覆盖 F3′ 的新接线：第一条读语句失败时必须已经开过事务，否则快照/outbox
    // 仍是逐条 autocommit，回滚路径无从发生。
    const { repository, probe } = stubRepository({ failWhen: () => true });
    await expect(repository.recordNarrativeStateSnapshot({
      projectId: "p1", documentId: "doc-1", revisionId: "revision-1", narrativeOrder: 3, chapterMemory: {} as never,
    })).rejects.toThrow("stub：该语句失败");
    expect(probe.transactions).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("默认面自管事务的两处投影都受锁：不得再有第三条 autocommit 账本投影", async () => {
    const source = readFileSync("src/novel-v2/postgres-repository.ts", "utf8");
    // 快照投影的递归调用必须传 client（传 this.pool 会自嵌套并绕过回滚），此处锁接线形状。
    expect([...source.matchAll(/if \(connection === this\.pool\) \{/g)].length).toBe(2);
    for (const method of ["async recordNarrativeElements(", "async recordNarrativeStateSnapshot("]) {
      const start = source.indexOf(method);
      expect(start, method).toBeGreaterThan(-1);
      const wrapper = source.slice(source.indexOf("if (connection === this.pool) {", start), start + 2000);
      expect(wrapper, method).toContain("await client.query(\"BEGIN\")");
      expect(wrapper, method).toContain(`await this.${method.slice(6, -1)}(input, client)`);
    }
  });
});

describe("提交面篇幅门（F6）", () => {
  const artifact = { id: "artifact-1", projectId: "p1", taskId: "t", attemptId: "a", kind: "draft", contentHash: "hash-1", baseRevision: 0, fingerprint: "fp-1", createdAt: 1 } as unknown as Artifact;
  const shortText = "他推开门，屋里没有人。".repeat(10); // 110 字，远低于声明目标 2600

  // 与门判据同面的三份通过证据：让 qualityFailure 只剩篇幅这一项可失败。
  const passedReviews = [
    { role: "structure-reviewer", identity: "internal" },
    { role: "character-reviewer", identity: "independent" },
    { role: "prose-reviewer", identity: "independent" },
  ].map((entry) => ({
    id: entry.role, projectId: "p1", artifactId: artifact.id, reviewerId: entry.role,
    identity: entry.identity as "internal" | "independent", role: entry.role, verdict: "passed" as const,
    issues: [], score: 5, artifactFingerprint: artifact.fingerprint, createdAt: 2,
  }));

  function stubCommitService(input: { target?: number; readerFails?: boolean }) {
    const calls: unknown[][] = [];
    const repository = {
      getChapterTargetWordCount: async (projectId: string, documentId: string) => {
        calls.push([projectId, documentId]);
        if (input.readerFails) throw new Error("stub：读取失败");
        return input.target;
      },
      commitRevision: async () => { throw new Error("stub：门若放过才会走到落库"); },
    };
    const objects = { putText: async (value: string) => ({ key: `obj-${value.length}`, hash: `hash-${value.length}` }) };
    return { service: new CommitService(repository as never, objects as never, undefined), calls };
  }

  const request = () => ({
    projectId: "p1",
    documentId: "doc-1",
    artifact,
    reviews: passedReviews,
    structuralReport: inspectManuscript({ text: shortText }),
    baseRevision: 0,
    idempotencyKey: "k-1",
    text: shortText,
  });

  it("目标篇幅由服务自行从蓝图取，短文在提交面即被拦（此前只有 lifecycle 三面传参）", async () => {
    const { service, calls } = stubCommitService({ target: 2600 });
    // 失败原因必须在报错文本里现形（此前只说"缺 reviewer 证据"，短稿被拦时运维无从归因）。
    await expect(service.commit(request() as never)).rejects.toThrow(/质量失败=length-under-target/);
    expect(calls).toEqual([["p1", "doc-1"]]);
  });

  it("无章节蓝图（仓储给 undefined）时不施篇幅门——门不替系统发明目标", async () => {
    const { service } = stubCommitService({ target: undefined });
    // 反向对照：三份通过证据 + 无有效目标 ⇒ 门放过，走到落库桩才报错，
    // 说明确实是"篇幅门未触发"而不是别的原因拦下。
    await expect(service.commit(request() as never)).rejects.toThrow(/门若放过才会走到落库/);
  });

  it("目标读取失败时降级为跳过篇幅门，不把提交打死", async () => {
    const { service } = stubCommitService({ readerFails: true });
    await expect(service.commit(request() as never)).rejects.toThrow(/门若放过才会走到落库/);
  });

  it("第三向：仓储未提供读取能力时显式告警并按未施门处理（生产装配缺失不可静默）", async () => {
    // 与"读取失败"同属降级，但要区分得开：前者是 DB 抖动，后者是装配漏接线——
    // 静默放行会让整道门在生产里消失而测试全绿（F6 的原始形态即"少一个调用点"）。
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const repository = { commitRevision: async () => { throw new Error("stub：门若放过才会走到落库"); } };
      const objects = { putText: async (value: string) => ({ key: `obj-${value.length}`, hash: `hash-${value.length}` }) };
      const service = new CommitService(repository as never, objects as never, undefined);
      await expect(service.commit(request() as never)).rejects.toThrow(/门若放过才会走到落库/);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((line) => /生产装配缺失/.test(line))).toBe(true);
  });
});
