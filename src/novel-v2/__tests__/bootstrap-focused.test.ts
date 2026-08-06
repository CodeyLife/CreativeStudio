import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildFocusedTaskChain, startNovelBootstrap } from "../application/bootstrap";

vi.mock("../creative", () => ({
  createCreativeRun: vi.fn(),
  enqueueCreativeWork: vi.fn(),
  getRunSnapshot: vi.fn(),
}));

import type { NovelPostgresRepository } from "../postgres-repository";
import { createCreativeRun, enqueueCreativeWork, getRunSnapshot } from "../creative";

describe("buildFocusedTaskChain", () => {
  it("returns the full 5-stage chain when no focus is given", () => {
    const chain = buildFocusedTaskChain({ objective: "目标" });
    expect(chain.map((task) => task.taskKey)).toEqual([
      "project-positioning",
      "architecture",
      "characters",
      "worldview",
      "plot-design",
    ]);
    expect(chain.every((task) => task.instruction.includes("项目目标：目标"))).toBe(true);
  });

  it("keeps full chain when focusedTaskKeys is an empty array", () => {
    const chain = buildFocusedTaskChain({ objective: "目标", focusedTaskKeys: [] });
    expect(chain.length).toBe(5);
  });

  it("returns only the focused stages and prunes dependencies to focused-only", () => {
    const chain = buildFocusedTaskChain({
      objective: "目标",
      focusedTaskKeys: ["architecture", "worldview"],
    });
    expect(chain.map((task) => task.taskKey)).toEqual(["architecture", "worldview"]);
    // architecture 的依赖 project-positioning 不在白名单内 → 依赖裁剪为空
    expect(chain.find((task) => task.taskKey === "architecture")?.dependsOn).toEqual([]);
    expect(chain.find((task) => task.taskKey === "worldview")?.dependsOn).toEqual([]);
  });

  it("keeps intra-focus dependencies and injects revision instructions", () => {
    const chain = buildFocusedTaskChain({
      objective: "目标",
      focusedTaskKeys: ["characters", "plot-design"],
      revisionInstructions: {
        "plot-design": "终局边界需收紧：禁止开放式治理细节。",
      },
    });
    expect(chain.map((task) => task.taskKey)).toEqual(["characters", "plot-design"]);
    // plot-design 依赖 architecture/characters/worldview，仅 characters 在白名单内
    expect(chain.find((task) => task.taskKey === "plot-design")?.dependsOn).toEqual(["characters"]);
    // 意见注入
    expect(chain.find((task) => task.taskKey === "plot-design")?.instruction).toContain("## 修订要求（作者指令，优先级最高）");
    expect(chain.find((task) => task.taskKey === "plot-design")?.instruction).toContain("终局边界需收紧");
    // 未指定意见的阶段保持基础指令
    expect(chain.find((task) => task.taskKey === "characters")?.instruction).not.toContain("修订要求");
  });
});

function makeRepository(): NovelPostgresRepository {
  return {
    findBootstrapRunId: vi.fn(async () => null),
    initializeProjectPlan: vi.fn(async () => undefined),
    putWorkflowRun: vi.fn(async () => undefined),
  } as unknown as NovelPostgresRepository;
}

function makeTemporal(): { workflow: { start: ReturnType<typeof vi.fn> } } {
  return { workflow: { start: vi.fn(async () => ({ firstExecutionRunId: "tid-1" })) } };
}

describe("startNovelBootstrap focusedPlanRegeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createCreativeRun).mockResolvedValue({ id: "run-1", policy: {}, payload: {} } as never);
    vi.mocked(getRunSnapshot).mockResolvedValue(null);
    vi.mocked(enqueueCreativeWork).mockImplementation(
      (async (_repository: unknown, _runId: string, input: { taskKey: string; parameters: Record<string, unknown> }) => ({
        id: `wi-${input.taskKey}`,
        ...input,
      })) as never,
    );
  });

  it("sets focusedPlanRegeneration on work items when focusedTaskKeys is provided", async () => {
    await startNovelBootstrap(makeRepository(), makeTemporal() as never, {
      projectId: "p1",
      objective: "目标",
      idempotencyKey: "ik-1",
      focusedTaskKeys: ["worldview"],
    });

    expect(enqueueCreativeWork).toHaveBeenCalledTimes(1);
    expect(enqueueCreativeWork).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        taskKey: "worldview",
        parameters: { bootstrap: true, focusedPlanRegeneration: true },
      }),
    );
  });

  it("does not set focusedPlanRegeneration when focusedTaskKeys is absent", async () => {
    await startNovelBootstrap(makeRepository(), makeTemporal() as never, {
      projectId: "p1",
      objective: "目标",
      idempotencyKey: "ik-2",
    });

    for (const call of vi.mocked(enqueueCreativeWork).mock.calls) {
      const input = call[2] as { parameters: Record<string, unknown> };
      expect(input.parameters).toEqual({ bootstrap: true });
    }
  });
});
