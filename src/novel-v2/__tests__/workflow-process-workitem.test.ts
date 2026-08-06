/**
 * processWorkItem 门禁等待循环的单元测试（无 Temporal/DB 依赖）。
 *
 * 覆盖根因修复（manual gate 下外部命令与 workflow 状态机脱节）：
 * - 场景 1：作者确认等待循环收到外部 revise review 信号 → 应触发 reviseWork，
 *   而不是被"等待 approve"循环无视（此前 manual gate + 系统自动审核 passed 进入
 *   gate.passed 分支后，外部 revise 永远不触发修订）。
 * - 场景 2：manual gate 等待收到外部 work.revise 命令（状态已变 pending）→ 应退出
 *   当前处理实例让主循环重新扫描，而不是对 pending 调 reviseWork 抛"状态非法"。
 * - 场景 3（回归）：作者确认满足 → 正常 accept，不受新逻辑影响。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CreativeReview, CreativeReviewGate, CreativeWorkItem } from "../protocol";

// condition 谓词 mock：谓词为 true 立即 resolve；否则挂起等待手动 resolve。
let conditionImpl: (fn: () => boolean) => Promise<boolean>;
let manualResolve: (() => void) | undefined;

vi.mock("@temporalio/workflow", () => ({
  CancellationScope: { cancelled: () => false },
  condition: (fn: () => boolean) => conditionImpl(fn),
  defineSignal: vi.fn(() => "mock-signal"),
  isCancellation: () => false,
  patched: () => false,
  proxyActivities: () => ({}),
  setHandler: vi.fn(),
}));

// 必须在 vi.mock 之后 import（vitest hoists vi.mock，此处仅作顺序标注）。
import { processWorkItem } from "../temporal/workflows";

function makeWork(overrides: Partial<CreativeWorkItem> = {}): CreativeWorkItem {
  return {
    id: "w1",
    runId: "r1",
    kind: "generation",
    taskKey: "characters",
    targetId: undefined,
    instruction: "",
    dependsOn: [],
    status: "running",
    artifactRefs: ["a1"],
    parameters: { bootstrap: true, iteration: 1 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeReview(
  id: string,
  reviewer: CreativeReview["reviewer"],
  verdict: CreativeReview["verdict"],
  summary: string,
  createdAt: number,
): CreativeReview {
  return { id, workItemId: "w1", subjectArtifactId: "a1", reviewer, verdict, issues: [], summary, createdAt };
}

function makeActivities(overrides: Record<string, unknown> = {}) {
  return {
    startWork: vi.fn(async () => makeWork()),
    generateFoundationWork: vi.fn(),
    reviewFoundationWork: vi.fn(async () => ({ kind: "completed", review: { summary: "" } })),
    checkGate: vi.fn(async (): Promise<CreativeReviewGate> => ({ passed: true, openIssues: [], reason: "manual gate passed by independent review" })),
    listWorkReviews: vi.fn(async (): Promise<CreativeReview[]> => []),
    getWorkItem: vi.fn(async () => makeWork()),
    foundationAuthorApproved: vi.fn(async () => false),
    planSectionApproved: vi.fn(async () => false),
    acceptWork: vi.fn(async () => makeWork({ status: "accepted" })),
    reviseWork: vi.fn(async () => makeWork({ status: "pending", parameters: { bootstrap: true, iteration: 2 } })),
    failWork: vi.fn(),
    recordEvent: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof processWorkItem>[0]["activities"];
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    runId: "r1",
    work: makeWork(),
    reviewFoundation: true,
    activities: makeActivities(),
    reviewedWorkItems: new Set<string>(),
    retryCount: new Map<string, number>(),
    maxRetries: 2,
    waitForExternal: async () => ({ failed: true }),
    isCancelled: () => false,
    isPaused: () => false,
    ...overrides,
  } as Parameters<typeof processWorkItem>[0];
}

describe("processWorkItem manual-gate 等待循环（外部信号修复）", () => {
  beforeEach(() => {
    manualResolve = undefined;
    conditionImpl = (fn) => {
      if (fn()) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        manualResolve = () => resolve(true);
      });
    };
  });

  it("作者确认等待循环收到外部 revise review 信号 → 触发 reviseWork（不无限等待 approve）", async () => {
    let gateCalls = 0;
    const params = makeParams({
      reviewedWorkItems: new Set(["w1"]), // 模拟 reviewSubmitted 信号已到达
      activities: makeActivities({
        // 最新 review 是外部提交的 revise 意见，应作为修订指令回流，
        // 而非初始 reviewFoundationWork 的 summary（foundationOpinion 缓存值）。
        listWorkReviews: vi.fn(async (): Promise<CreativeReview[]> => [
          makeReview("r1", "independent", "revise", "初始审核意见", 1),
          makeReview("r2", "human", "revise", "最新外部修订意见", 2),
        ]),
        checkGate: vi.fn(async (): Promise<CreativeReviewGate> => {
          gateCalls += 1;
          // 第一次（进入前）passed → 走作者确认分支；信号后重判 → 因 revise review 未通过
          return gateCalls === 1
            ? { passed: true, openIssues: [], reason: "manual gate passed by independent review" }
            : { passed: false, openIssues: [], reason: "manual gate requires human or independent accept" };
        }),
        getWorkItem: vi.fn(async () => makeWork()), // 外部命令未接管，仍 running
      }),
    });

    await processWorkItem(params);

    expect(params.activities.reviseWork).toHaveBeenCalledTimes(1);
    expect(params.activities.reviseWork).toHaveBeenCalledWith(expect.objectContaining({ instruction: "最新外部修订意见" }));
    expect(params.activities.acceptWork).not.toHaveBeenCalled();
    expect(gateCalls).toBeGreaterThanOrEqual(2);
  });

  it("manual gate 等待收到外部 work.revise（状态已变 pending）→ 退出且不调 reviseWork", async () => {
    const params = makeParams({
      reviewedWorkItems: new Set(["w1"]),
      activities: makeActivities({
        checkGate: vi.fn(async (): Promise<CreativeReviewGate> => ({
          passed: false,
          openIssues: [],
          reason: "manual gate requires human or independent accept",
        })),
        getWorkItem: vi.fn(async () => makeWork({ status: "pending" })), // 外部命令已改状态
      }),
    });

    await processWorkItem(params);

    expect(params.activities.reviseWork).not.toHaveBeenCalled();
    expect(params.activities.acceptWork).not.toHaveBeenCalled();
  });

  it("manual gate 收到 plan.approve（作者已批准）唤醒后不自动 revise；独立审核通过后 accept", async () => {
    let approveCalls = 0;
    const params = makeParams({
      reviewedWorkItems: new Set(["w1"]), // 首次信号：plan.approve
      activities: makeActivities({
        checkGate: vi.fn(async (): Promise<CreativeReviewGate> => ({
          passed: false,
          openIssues: [],
          reason: "manual gate requires human or independent accept",
        })),
        foundationAuthorApproved: vi.fn(async () => {
          approveCalls += 1;
          // 首次（作者已批准、独立 review 尚未 passed）→ false；独立审核通过后 → true
          return approveCalls >= 2;
        }),
        planSectionApproved: vi.fn(async () => true), // 作者已批准 section
        getWorkItem: vi.fn(async () => makeWork()), // 仍 running
      }),
    });

    const promise = processWorkItem(params);
    // 首次信号处理：作者已批准 → 不自动 revise，回到等待
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(params.activities.reviseWork).not.toHaveBeenCalled();
    expect(params.activities.acceptWork).not.toHaveBeenCalled();

    // 独立审核通过后，作者批准 + passed review 均满足 → accept
    params.reviewedWorkItems.add("w1");
    manualResolve?.();
    await promise;

    expect(params.activities.acceptWork).toHaveBeenCalledTimes(1);
    expect(params.activities.reviseWork).not.toHaveBeenCalled();
  });

  it("manual gate 收到 review.submit(revise) 且作者未批准 → 触发 reviseWork 携带最新意见", async () => {
    const params = makeParams({
      reviewedWorkItems: new Set(["w1"]),
      activities: makeActivities({
        listWorkReviews: vi.fn(async () => [makeReview("r1", "human", "revise", "最新外部修订意见", 1)]),
        checkGate: vi.fn(async (): Promise<CreativeReviewGate> => ({
          passed: false,
          openIssues: [],
          reason: "manual gate requires human or independent accept",
        })),
        foundationAuthorApproved: vi.fn(async () => false),
        planSectionApproved: vi.fn(async () => false), // 作者未批准
        getWorkItem: vi.fn(async () => makeWork()),
      }),
    });

    await processWorkItem(params);

    expect(params.activities.reviseWork).toHaveBeenCalledTimes(1);
    expect(params.activities.reviseWork).toHaveBeenCalledWith(expect.objectContaining({ instruction: "最新外部修订意见" }));
  });

  it("回归：作者确认满足后正常 accept（不因重判逻辑误伤）", async () => {
    let approveCalls = 0;
    const params = makeParams({
      reviewedWorkItems: new Set<string>(),
      activities: makeActivities({
        foundationAuthorApproved: vi.fn(async () => {
          approveCalls += 1;
          return approveCalls >= 2; // 第一次 false，信号后重判 true（approve 已落库）
        }),
        checkGate: vi.fn(async (): Promise<CreativeReviewGate> => ({ passed: true, openIssues: [], reason: "manual gate passed by independent review" })),
      }),
    });

    const promise = processWorkItem(params);
    // 第一次 foundationAuthorApproved=false → condition 谓词 false → 挂起；模拟 approve 信号到达
    await Promise.resolve();
    params.reviewedWorkItems.add("w1");
    manualResolve?.();
    await promise;

    expect(params.activities.acceptWork).toHaveBeenCalledTimes(1);
    expect(params.activities.reviseWork).not.toHaveBeenCalled();
  });
});
