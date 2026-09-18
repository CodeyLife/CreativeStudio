import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../postgres-repository";
import type { ModelInvocationAudit } from "../model-gateway";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/**
 * OR-A1（product-audit-20260910 E1）：跨 purpose 候选健康度诊断。
 * 死路由（样本≥阈值且从未成功）必须被标出并暴露失败等待墙钟；
 * 成功候选与小样本失败候选必须不被误判（阈值防"偶发失败即摘除"）。
 */
describe("getRoutingCandidateHealth（OR-A1 死路由诊断）", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const purpose = `probe.purpose-${randomUUID().slice(0, 8)}`;
  const deadModel = `probe-dead-${randomUUID().slice(0, 8)}`;
  const healthyModel = `probe-ok-${randomUUID().slice(0, 8)}`;
  const smallSampleModel = `probe-small-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      const base = { purpose: purpose as ModelInvocationAudit["purpose"], configRevision: `rev-${randomUUID().slice(0, 8)}`, executor: "api" as const, inputTokens: 1, outputTokens: 1 };
      for (let i = 0; i < 6; i++) {
        await repository.recordModelInvocation({ ...base, candidateIndex: 0, model: deadModel, providerLabel: "probe-dead-label", status: "failed", latencyMs: 1_000, promptFingerprint: `fp-${randomUUID()}` });
      }
      for (let i = 0; i < 3; i++) {
        await repository.recordModelInvocation({ ...base, candidateIndex: 1, model: healthyModel, providerLabel: "probe-ok-label", status: "completed", latencyMs: 200, promptFingerprint: `fp-${randomUUID()}` });
      }
      for (let i = 0; i < 2; i++) {
        await repository.recordModelInvocation({ ...base, candidateIndex: 2, model: smallSampleModel, providerLabel: "probe-small-label", status: "failed", latencyMs: 300, promptFingerprint: `fp-${randomUUID()}` });
      }
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[routing-candidate-health.test] Postgres 不可用，跳过集成测试: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) return;
    await repository.pool.query("DELETE FROM model_invocations WHERE purpose=$1", [purpose]).catch(() => undefined);
    await repository.close();
  });

  it("死路由命中且墙钟聚合；健康候选与小样本不误判（默认阈值 5）", async () => {
    if (!available) return;
    const cells = await repository.getRoutingCandidateHealth();
    const dead = cells.find((cell) => cell.purpose === purpose && cell.model === deadModel);
    expect(dead).toMatchObject({ candidateIndex: 0, calls: 6, failures: 6, neverSucceeded: true, failedWallClockMs: 6_000 });
    const healthy = cells.find((cell) => cell.purpose === purpose && cell.model === healthyModel);
    expect(healthy?.neverSucceeded).toBe(false);
    // 小样本失败：默认阈值下不得判死（防误摘除）。
    const small = cells.find((cell) => cell.purpose === purpose && cell.model === smallSampleModel);
    expect(small).toMatchObject({ calls: 2, neverSucceeded: false });
  });

  it("阈值可参数化：minSamples=2 时小样本失败同样入死路由名单", async () => {
    if (!available) return;
    const cells = await repository.getRoutingCandidateHealth({ minSamples: 2 });
    const small = cells.find((cell) => cell.purpose === purpose && cell.model === smallSampleModel);
    expect(small?.neverSucceeded).toBe(true);
  });

  it("sinceDays 窗口收窄可排除历史样本（时间维度可诊断）", async () => {
    if (!available) return;
    const cells = await repository.getRoutingCandidateHealth({ sinceDays: 0 });
    expect(cells.find((cell) => cell.purpose === purpose && cell.model === deadModel)).toBeUndefined();
  });
});
