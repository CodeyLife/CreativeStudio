/**
 * OR-D3（product-audit-20260910 E5 剩余子项）：上下文清单采样物化 + 估算/上报比值报表。
 * 双向覆盖：命中/未命中/关闭/幂等重放/物化失败降级（采样不得成为留痕主链路的新失败面）。
 * 采样判定住在本体（recordPromptExecution 内，审核 N1）：测试经 env 控制比率，
 * 与生产消费面（网关回调/REST 直连）走同一条代码路径——不存在测试专用的注入旁路。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import { contextManifestSamplingHit, samplingRatioFromEnv } from "../context-manifest-sampling";
import type { ContentObject } from "../object-store";
import type { ModelPromptExecution } from "../model-gateway";
import type { PromptContextManifest } from "../protocol";
import type { ModelPurpose } from "../model-purposes";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

function makeManifest(overrides: Partial<PromptContextManifest> = {}): PromptContextManifest {
  return {
    id: `prompt-context:run-test:${randomUUID().slice(0, 16)}`,
    projectId: "unused", workflowId: "run-test", purpose: "writing.draft" as ModelPurpose, stage: "drafting",
    maxInputTokens: 100_000, reservedOutputTokens: 8_000,
    estimatedSystemTokens: 100, estimatedSchemaTokens: 50, usableInputTokens: 91_000,
    requiredInputTokens: 200, budgetExcludedSectionCount: 0, estimatedInputTokens: 350,
    sections: [], fingerprint: `fp-${randomUUID()}`, createdAt: Date.now(),
    ...overrides,
  };
}

function makeObjects(): { putText(text: string): Promise<ContentObject>; getText(key: string): Promise<string>; putData(bytes: Buffer): Promise<ContentObject>; getData(key: string): Promise<Buffer>; } {
  const store = new Map<string, string>();
  return {
    async putText(text) {
      const key = `mem/${randomUUID()}`;
      store.set(key, text);
      return { key, hash: key, bytes: Buffer.byteLength(text), reused: false };
    },
    async getText(key) {
      const value = store.get(key);
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
    async putData(bytes) {
      const key = `mem/${randomUUID()}`;
      store.set(key, bytes.toString("utf8"));
      return { key, hash: key, bytes: bytes.byteLength };
    },
    async getData(key) {
      const value = store.get(key);
      if (value === undefined) throw new Error(`missing ${key}`);
      return Buffer.from(value, "utf8");
    },
  };
}

describe("上下文清单采样（OR-D3）", () => {
  it("采样纯函数：0=恒不命中、1=恒命中、同输入稳定", () => {
    const manifest = makeManifest();
    expect(contextManifestSamplingHit(manifest, "fp-a", 0)).toBe(false);
    expect(contextManifestSamplingHit(manifest, "fp-a", 1)).toBe(true);
    // 稳定性：同一 (purpose, fingerprint) 任意次调用决策一致（可复现观测面）。
    const half = contextManifestSamplingHit(manifest, "fp-a", 0.5);
    for (let i = 0; i < 5; i += 1) expect(contextManifestSamplingHit(manifest, "fp-a", 0.5)).toBe(half);
    expect(samplingRatioFromEnv({})).toBe(0.05);
    expect(samplingRatioFromEnv({ NOVEL_CONTEXT_MANIFEST_SAMPLING: "0" })).toBe(0);
    expect(samplingRatioFromEnv({ NOVEL_CONTEXT_MANIFEST_SAMPLING: "7" })).toBe(1); // 越界钳制
    expect(samplingRatioFromEnv({ NOVEL_CONTEXT_MANIFEST_SAMPLING: "garbage" })).toBe(0.05); // 非数回默认
  });

  it("哈希键承重（审核 B#2）：purpose 或 fingerprint 单独翻动能翻转决策（存在反向对）", () => {
    // 在 128 个候选中找 0.5 比率下决策相反的对——若哈希输入丢掉任一因子，
    // 全体候选决策必然一致，两对都找不到 ⇒ 本用例炸。确定性：sha256 稳定。
    const manifestOf = (purpose: string): PromptContextManifest => ({ ...makeManifest(), purpose: purpose as PromptContextManifest["purpose"] });
    const flipPair = (keys: string[], decision: (key: string) => boolean): { hit: string; miss: string } | undefined => {
      const hits = keys.filter((key) => decision(key));
      const misses = keys.filter((key) => !decision(key));
      return hits.length && misses.length ? { hit: hits[0], miss: misses[0] } : undefined;
    };
    const purposes = Array.from({ length: 128 }, (_, i) => `purpose-probe-${i}`);
    const purposePair = flipPair(purposes, (p) => contextManifestSamplingHit(manifestOf(p), "fp-fixed", 0.5));
    expect(purposePair).toBeDefined();
    expect(contextManifestSamplingHit(manifestOf(purposePair!.hit), "fp-fixed", 0.5)).toBe(true);
    expect(contextManifestSamplingHit(manifestOf(purposePair!.miss), "fp-fixed", 0.5)).toBe(false);
    const fingerprints = Array.from({ length: 128 }, (_, i) => `fp-probe-${i}`);
    const fpPair = flipPair(fingerprints, (fp) => contextManifestSamplingHit(manifestOf("writing.draft"), fp, 0.5));
    expect(fpPair).toBeDefined();
    expect(contextManifestSamplingHit(manifestOf("writing.draft"), fpPair!.hit, 0.5)).toBe(true);
    expect(contextManifestSamplingHit(manifestOf("writing.draft"), fpPair!.miss, 0.5)).toBe(false);
  });

  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-cmsampling-${randomUUID().slice(0, 8)}`;
  const runId = `run-${randomUUID()}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Context Sampling Test");
      await repository.putWorkflowRun({ id: runId, workflowType: "chapter-generation", projectId, temporalWorkflowId: `t-${runId}`, status: "running" });
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[context-manifest-sampling.test] Postgres 不可用：${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.deleteProject(projectId).catch(() => undefined);
    await repository.close();
  });

  function execution(manifest: PromptContextManifest): ModelPromptExecution {
    return { workflowRunId: runId, taskId: `t-${randomUUID()}`, purpose: "writing.draft", candidateIndex: 0, status: "completed", prompt: "测试提示词", response: "测试响应", promptFingerprint: `fp-${randomUUID()}`, contextManifest: { ...manifest, purpose: "writing.draft" } };
  }

  async function withRatio<T>(ratio: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.NOVEL_CONTEXT_MANIFEST_SAMPLING;
    process.env.NOVEL_CONTEXT_MANIFEST_SAMPLING = ratio;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.NOVEL_CONTEXT_MANIFEST_SAMPLING;
      else process.env.NOVEL_CONTEXT_MANIFEST_SAMPLING = previous;
    }
  }

  it("命中：manifest 物化进 context_manifests 且留痕行携带 context_manifest_id；重放幂等", async () => {
    if (!available) return;
    await withRatio("1", async () => {
      const manifest = makeManifest({ projectId, workflowId: runId });
      const objects = makeObjects();
      const first = execution(manifest);
      await repository.recordPromptExecution(first, objects);
      const rows = await repository.pool.query<{ context_manifest_id: string | null; project_id: string | null }>(
        "SELECT context_manifest_id, project_id FROM prompt_executions WHERE workflow_run_id=$1 AND task_id=$2", [runId, first.taskId],
      );
      expect(rows.rows[0].context_manifest_id).toBe(manifest.id);
      expect(rows.rows[0].project_id).toBe(projectId);
      const materialized = await repository.pool.query<{ count: string }>(
        "SELECT count(*) FROM context_manifests WHERE id=$1", [manifest.id],
      );
      expect(Number(materialized.rows[0].count)).toBe(1);
      // 同 manifest 二次命中：DO NOTHING 去重（id 确定），第二条留痕行独立存在。
      const second = execution(manifest);
      await repository.recordPromptExecution(second, objects);
      const again = await repository.pool.query<{ count: string }>("SELECT count(*) FROM context_manifests WHERE id=$1", [manifest.id]);
      expect(Number(again.rows[0].count)).toBe(1);
    });
  });

  it("未命中/关闭：context_manifest_id 为 NULL 且不写 context_manifests，但留痕行照常", async () => {
    if (!available) return;
    await withRatio("0", async () => {
      const manifest = makeManifest({ projectId, workflowId: runId });
      const objects = makeObjects();
      const off = execution(manifest);
      await repository.recordPromptExecution(off, objects);
      const latest = await repository.pool.query<{ n: string; nulls: string }>(
        "SELECT count(*)::text AS n, count(*) FILTER (WHERE context_manifest_id IS NULL)::text AS nulls FROM prompt_executions WHERE workflow_run_id=$1 AND task_id=$2",
        [runId, off.taskId],
      );
      expect(Number(latest.rows[0].n)).toBe(1);
      expect(Number(latest.rows[0].nulls)).toBe(1);
      const manifested = await repository.pool.query<{ count: string }>("SELECT count(*) FROM context_manifests WHERE id=$1", [manifest.id]);
      expect(Number(manifested.rows[0].count)).toBe(0);
    });
  });

  it("物化失败降级：manifest 写入抛错时留痕照常落库（采样不是新失败面）", async () => {
    if (!available) return;
    await withRatio("1", async () => {
      // projectId 指向不存在的项目 → context_manifests FK 违例，真实失败路径。
      const manifest = makeManifest({ projectId: `no-such-project-${randomUUID().slice(0, 8)}`, workflowId: runId });
      const objects = makeObjects();
      const fail = execution(manifest);
      await repository.recordPromptExecution(fail, objects);
      const rows = await repository.pool.query<{ n: string; linked: string }>(
        "SELECT count(*)::text AS n, count(context_manifest_id)::text AS linked FROM prompt_executions WHERE workflow_run_id=$1 AND task_id=$2", [runId, fail.taskId],
      );
      expect(Number(rows.rows[0].n)).toBe(1); // 留痕主链路不受物化失败影响
      expect(Number(rows.rows[0].linked)).toBe(0); // 物化失败 → 不回填 id
    });
  });

  it("比值报表：可比行按 purpose/model 聚合出 ratio，非测量行剔除且透明计数", async () => {
    if (!available) return;
    const fingerprint = `fp-${randomUUID()}`;
    const base = { workflowRunId: runId, taskId: "ratio-task", purpose: "writing.draft" as const, configRevision: "test", candidateIndex: 0, executor: "api" as const, model: "ratio-test-model", status: "completed" as const, latencyMs: 1, promptFingerprint: fingerprint };
    await repository.recordModelInvocation({ ...base, inputTokens: 200, outputTokens: 10, estimatedInputTokens: 100, providerInputTokens: 200, providerOutputTokens: 10, usageSource: "provider" });
    await repository.recordModelInvocation({ ...base, inputTokens: 90, outputTokens: 5, estimatedInputTokens: 90, providerInputTokens: undefined, providerOutputTokens: undefined, usageSource: "estimated" });
    // 非测量带（与同一请求估算偏离两个数量级以上）：占位哨兵 1/1（glm 实测形态）
    // 与"只报增量"20@50000 都必须剔出分位数——混入会把 p50 拉塌，报表失去意义。
    await repository.recordModelInvocation({ ...base, inputTokens: 1, outputTokens: 1, estimatedInputTokens: 5_000, providerInputTokens: 1, providerOutputTokens: 1, usageSource: "provider" });
    await repository.recordModelInvocation({ ...base, inputTokens: 20, outputTokens: 400, estimatedInputTokens: 50_000, providerInputTokens: 20, providerOutputTokens: 400, usageSource: "provider" });
    // 反例双向：真·小调用（est=1 上报 1）与真·低比值测量（50/100=0.5）不被误伤——
    // 判据是"对整份负载的矛盾度"，不是"数值小"或"比值低"。
    await repository.recordModelInvocation({ ...base, inputTokens: 1, outputTokens: 1, estimatedInputTokens: 1, providerInputTokens: 1, providerOutputTokens: 1, usageSource: "provider" });
    await repository.recordModelInvocation({ ...base, inputTokens: 50, outputTokens: 8, estimatedInputTokens: 100, providerInputTokens: 50, providerOutputTokens: 8, usageSource: "provider" });
    const report = await repository.getEstimatedVsProviderRatio({ sinceDays: 1 });
    const row = report.find((item) => item.model === "ratio-test-model");
    expect(row).toBeDefined();
    expect(row!.comparableCalls).toBe(3); // 200/100、1/1@est1、50/100；缺报与非测量都不算可比
    expect(row!.artifactCalls).toBe(2); // 1/1@5000 与 20@50000 显式计数，不静默丢账
    expect(row!.minRatio).toBeCloseTo(0.5, 5); // 真·低比值保留；若非测量混入会塌到 0.0004
    expect(row!.maxRatio).toBeCloseTo(2, 5);
    expect(row!.p50Ratio).toBeCloseTo(1, 5); // {0.5, 1, 2} 中位数
  });
});
