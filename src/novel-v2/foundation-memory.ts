import { createHash } from "node:crypto";
import type { Artifact, MemoryClaim, MemoryKind } from "./protocol";

const kindByTaskKey: Record<string, MemoryKind> = {
  "project-positioning": "author",
  architecture: "hierarchical",
  characters: "canonical",
  relations: "canonical",
  worldview: "canonical",
  "plot-threads": "hierarchical",
  foreshadowing: "hierarchical",
  timeline: "hierarchical",
  "story-control": "author",
  "plot-design": "hierarchical",
  "chapter-plan": "hierarchical",
};

function compactStructuredData(value: unknown): string {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length <= 12_000 ? serialized : `${serialized.slice(0, 12_000)}…`;
}

/**
 * 段级单例 claim id（product-audit-20260910 A2=PL-3+FM-6）：每个 (项目, taskKey)
 * 在记忆层只有一个 foundation 投影行。历史 per-artifact id
 * （`foundation:<artifactId>`）由回填行以 supersedes 退役；单例化让 Qdrant 同名
 * 点 upsert 即物理覆盖，陈旧代际不再有机会出现在任何检索轨。
 */
export function foundationClaimId(projectId: string, taskKey: string): string {
  return `foundation:${projectId}:${taskKey}`;
}

/** Projects an accepted foundation artifact into durable, derived cognition. */
export function foundationArtifactToMemoryClaim(
  artifact: Artifact,
  input: { objective?: string },
): MemoryClaim {
  const data = artifact.structuredData ?? {};
  const taskKey = typeof data.taskKey === "string" ? data.taskKey : "foundation";
  const title = typeof data.title === "string" ? data.title : taskKey;
  const summary = typeof data.summary === "string" ? data.summary : "";
  const content = [
    input.objective ? `项目目标：${input.objective}` : undefined,
    `规划维度：${taskKey}`,
    `规划标题：${title}`,
    summary ? `规划摘要：${summary}` : undefined,
    `结构化决策：${compactStructuredData(data.structuredData ?? data)}`,
  ].filter(Boolean).join("\n");
  const contentHash = createHash("sha256").update(content).digest("hex");

  return {
    id: foundationClaimId(artifact.projectId, taskKey),
    projectId: artifact.projectId,
    kind: kindByTaskKey[taskKey] ?? "hierarchical",
    title: `[foundation:${taskKey}] ${title}`,
    content,
    subjectRefs: [`foundation:${taskKey}`, "facet:fact"],
    knowledgeScope: "author",
    authority: "derived",
    confidence: 0.8,
    sourceRevisionIds: [],
    contentHash,
    supersedes: [],
  };
}
