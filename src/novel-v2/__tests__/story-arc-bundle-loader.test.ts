import { describe, expect, it } from "vitest";
import { createNovelWorkflowActivities } from "../temporal/activities";
import type { NovelPostgresRepository } from "../postgres-repository";

// 读取面坐标归一契约（弧6 恢复环实证，2026-09-12）：蓝图 artifact 内 batch 坐标是模型自报
// echo（新弧常写局部 1 基），story_arc_batches 行坐标是系统派生事实。artifact 一旦被重审/
// 修订路径读回，必须对齐批次行——否则重基线守卫与投影对账各信一边。

const bundleStructuredData = {
  arc: {
    title: "第一弧", objective: "建立初始关系", entryState: "抵达", centralConflict: "冲突",
    development: ["a", "b"], resolution: "确认", exitState: "决定", threadResponsibilities: [],
    foreshadowingRefs: [], expectedChapterCount: 1, phases: [],
  },
  batch: { batchIndex: 1, startChapterIndex: 1, complete: false },
  chapters: [{
    index: 1, title: "旧宅夜谈", narrativeFunction: "relationship", povCharacterId: "protagonist",
    stateTransition: { before: "防备", after: "松动", evidence: "称呼变化" },
    scenes: [{ title: "厨房", participants: ["protagonist"], situation: "雨夜", observableActions: ["换称呼"], outcome: "距离变化" }],
    continuityConstraints: ["真相不揭"], unresolvedAtClose: ["钥匙主人"],
  }],
};

const artifact = {
  id: "artifact-1", projectId: "project-1", kind: "story-arc-blueprint" as const,
  structuredData: bundleStructuredData as never,
};

function makeActivities(getStoryArc: () => Promise<unknown>) {
  const repository = {
    getArtifact: async () => artifact,
    getStoryArc,
  } as unknown as NovelPostgresRepository;
  return createNovelWorkflowActivities({ repository, memoryProvider: {} as never, skillProvider: {} as never, modelGateway: {} as never });
}

describe("loadStoryArcBundleArtifact 坐标归一", () => {
  it("批次行坐标覆写 artifact 自报 echo（弧6 形态：行=35 基，artifact=1 基）", async () => {
    const activities = makeActivities(async () => ({
      id: "arc-1",
      batches: [{ id: "b1", batchIndex: 1, startChapterIndex: 35, complete: true, sourceArtifactId: "artifact-1" }],
    })) as unknown as { loadStoryArcBundleArtifact: (i: { projectId: string; arcId: string; artifactId: string }) => Promise<{ bundle: typeof bundleStructuredData }> };
    const loaded = await activities.loadStoryArcBundleArtifact({ projectId: "project-1", arcId: "arc-1", artifactId: "artifact-1" });
    expect(loaded.bundle.batch).toMatchObject({ batchIndex: 1, startChapterIndex: 35, complete: true });
    // 非坐标字段原样保留（模型内容不被改写）。
    expect(loaded.bundle.chapters).toHaveLength(1);
  });

  it("反例面：无批次行（首次生成未投影）保留 artifact 原坐标；多批次须精确匹配 sourceArtifactId", async () => {
    const noBatch = makeActivities(async () => ({ id: "arc-1", batches: [] })) as unknown as {
      loadStoryArcBundleArtifact: (i: { projectId: string; arcId: string; artifactId: string }) => Promise<{ bundle: typeof bundleStructuredData }>;
    };
    const untouched = await noBatch.loadStoryArcBundleArtifact({ projectId: "project-1", arcId: "arc-1", artifactId: "artifact-1" });
    expect(untouched.bundle.batch.startChapterIndex).toBe(1);

    const multiUnmatched = makeActivities(async () => ({
      id: "arc-1",
      batches: [
        { id: "b1", batchIndex: 1, startChapterIndex: 35, complete: true, sourceArtifactId: "other" },
        { id: "b2", batchIndex: 2, startChapterIndex: 43, complete: false, sourceArtifactId: "artifact-2" },
      ],
    })) as unknown as {
      loadStoryArcBundleArtifact: (i: { projectId: string; arcId: string; artifactId: string }) => Promise<{ bundle: typeof bundleStructuredData }>;
    };
    const ambiguous = await multiUnmatched.loadStoryArcBundleArtifact({ projectId: "project-1", arcId: "arc-1", artifactId: "artifact-1" });
    expect(ambiguous.bundle.batch.startChapterIndex).toBe(1); // 多批次无匹配 → 不猜

    const matched = await multiUnmatched.loadStoryArcBundleArtifact({ projectId: "project-1", arcId: "arc-1", artifactId: "artifact-2" });
    expect(matched.bundle.batch).toMatchObject({ batchIndex: 2, startChapterIndex: 43 });
  });
});
