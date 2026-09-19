import { describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact } from "../protocol";

const artifact: Artifact = { id: "a1", projectId: "p1", taskId: "t1", attemptId: "x1", kind: "fact-extraction", contentHash: "h", baseRevision: 1, createdAt: 1, fingerprint: "fp" };

describe("narrative projection revision ownership", () => {
  it("fails explicitly before projection when revision is absent or belongs to another document", async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; }, release: () => undefined };
    const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
    // 默认面自管事务，因此桩连接必须像真 Pool 一样可 connect()
    Object.defineProperty(repository, "pool", { value: { query: client.query, connect: async () => client } });
    await expect(repository.recordNarrativeElements({
      projectId: "p1", documentId: "d1", revisionId: "r-other", artifact, narrativeElements: { foreshadowings: [], promises: [], payoffs: [] },
    })).rejects.toThrow(/已提交且归属匹配/);
    // 归属校验之前不发出任何写语句；失败必走 ROLLBACK（半提交账本的形态之一）
    expect(statements.map((sql) => sql.trim().split(/\s+/)[0].toUpperCase())).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
    expect(statements[1]).toContain("project_id=$2 AND document_id=$3");
  });
});
