import { describe, expect, it } from "vitest";
import { foundationArtifactToMemoryClaim } from "../foundation-memory";
import type { Artifact } from "../protocol";

function artifact(taskKey: string, summary: string): Artifact {
  return {
    id: `artifact-${taskKey}`,
    projectId: "project-1",
    taskId: `work-${taskKey}:foundation`,
    attemptId: "attempt-1",
    kind: "foundation",
    contentHash: "artifact-hash",
    structuredData: { taskKey, title: "规划", summary, structuredData: { decision: "保持因果链" } },
    baseRevision: 0,
    createdAt: 1,
    fingerprint: "fingerprint",
  };
}

describe("foundation cognition projection", () => {
  it("creates a derived project-level claim with artifact provenance", () => {
    const claim = foundationArtifactToMemoryClaim(artifact("worldview", "世界规则不可随意破坏"), {
      objective: "创作一部长篇悬疑小说",
    });

    expect(claim.id).toBe("foundation:project-1:worldview");
    expect(claim.kind).toBe("canonical");
    expect(claim.authority).toBe("derived");
    expect(claim.knowledgeScope).toBe("author");
    expect(claim.subjectRefs).toContain("facet:fact");
    expect(claim.content).toContain("创作一部长篇悬疑小说");
    expect(claim.content).toContain("世界规则不可随意破坏");
    expect(claim.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("collapses artifact generations of one taskKey into a single slot row (A2/FM-6)", () => {
    // 段级单例：同一 taskKey 的不同 artifact 代际必须投影到同一个 claim id，
    // 使重新生成表现为覆盖写，而不是往检索面里追加陈旧代际。
    const first = foundationArtifactToMemoryClaim({ ...artifact("worldview", "第一版世界规则"), id: "artifact-gen-1" }, {});
    const second = foundationArtifactToMemoryClaim({ ...artifact("worldview", "第二版世界规则"), id: "artifact-gen-2" }, {});
    expect(second.id).toBe(first.id);
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it("keeps stylistic planning separate from canonical world facts", () => {
    const claim = foundationArtifactToMemoryClaim(artifact("story-control", "控制信息释放节奏"), {});
    expect(claim.kind).toBe("author");
  });
});
