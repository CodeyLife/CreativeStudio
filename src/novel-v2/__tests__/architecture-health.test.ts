import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NovelPostgresRepository } from "../postgres-repository";
import type { Artifact } from "../protocol";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

describe("architecture health lifecycle", () => {
  let repository: NovelPostgresRepository;
  let available = false;
  const projectId = `test-architecture-health-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      await repository.ensureProject(projectId, "Architecture health test");
      await repository.pool.query("INSERT INTO books(id,project_id,title) VALUES($1,$2,$3)", [`book-${projectId}`, projectId, "Test book"]);
      await repository.pool.query("INSERT INTO volumes(id,book_id,title,ordinal) VALUES($1,$2,$3,1)", [`volume-${projectId}`, `book-${projectId}`, "Test volume"]);
      await repository.pool.query(
        `INSERT INTO arcs(id,volume_id,project_id,title,ordinal,planning_status,execution_status,payload)
         VALUES($1,$3,$4,'待审批弧',1,'awaiting-review','planned','{}'::jsonb),
               ($2,$3,$4,'已批准弧',2,'approved','active','{}'::jsonb)`,
        [`arc-pending-${projectId}`, `arc-approved-${projectId}`, `volume-${projectId}`, projectId],
      );
      await repository.pool.query(
        `INSERT INTO chapters(id,arc_id,project_id,title,ordinal,status,payload)
         VALUES($1,$4,$5,'审批前蓝图',1,'planned','{}'::jsonb),
               ($2,$6,$5,'批准后缺正文',2,'planned','{}'::jsonb),
               ($3,NULL,$5,'无弧章节',3,'planned','{}'::jsonb)`,
        [`chapter-pending-${projectId}`, `chapter-approved-${projectId}`, `chapter-orphan-${projectId}`, projectId, projectId, `arc-approved-${projectId}`],
      );
      available = true;
    } catch (error) {
      console.warn(`[architecture-health.test] Postgres unavailable: ${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available) await repository.deleteProject(projectId).catch(() => undefined);
    await repository?.close().catch(() => undefined);
  });

  it("counts pre-approval blueprints as planned but not orphaned", async () => {
    if (!available) return;
    const health = await repository.getArchitectureHealth(projectId);
    expect(health.chapters).toMatchObject({ total: 3, planned: 3, orphaned: 2 });
  });
});

describe("story arc approval architecture gate", () => {
  const blueprint: Artifact = {
    id: "blueprint-1", projectId: "project-1", taskId: "story-arc", attemptId: "attempt-1", kind: "chapter-blueprint",
    contentHash: "hash", baseRevision: 0, createdAt: 1, fingerprint: "fingerprint",
    structuredData: {
      arc: { title: "第一弧", objective: "验证审批门禁" },
      batch: { batchIndex: 1, startChapterIndex: 1 },
      chapters: [{ title: "测试章节", scenes: [] }],
    },
  };
  const review: Artifact = {
    id: "review-1", projectId: "project-1", taskId: "story-arc", attemptId: "attempt-2", kind: "review",
    contentHash: "review-hash", baseRevision: 0, createdAt: 1, fingerprint: "review-fingerprint",
    structuredData: { subjectArtifactId: blueprint.id, verdict: "passed", issues: [], chapterChecks: [], arcChecks: [] },
  };

  async function expectGate(health: {
    foundation: { missing: string[] };
    fullBookArchitecture: { issues: Array<{ severity: string; path: string; message: string }> };
    references?: Array<{
      arcId: string;
      plotThreads: { issues: Array<{ severity: string; message: string }> };
      foreshadowing: { issues: Array<{ severity: string; message: string }> };
    }>;
  }) {
    const fakeRepository = {
      previewStoryArcApproval: async () => ({ creates: [], updates: [], conflicts: [], artifactId: blueprint.id }),
      getArtifact: async (id: string) => id === blueprint.id ? blueprint : id === review.id ? review : undefined,
      getArchitectureHealth: async () => health,
      // approveStoryArc 在引用门禁前会先物化弧引用；测试中不物化，保持 health 的 blocking issues 可见
      normalizeStoryArcReferences: async () => ({ arc: null, mappings: [], created: [] }),
    } as unknown as NovelPostgresRepository;
    await expect(NovelPostgresRepository.prototype.approveStoryArc.call(fakeRepository, "project-1", "arc-1", blueprint.id, review.id, "test"))
      .rejects.toThrow(/故事弧审批前置门禁未通过|故事弧存在未解决的结构引用/);
  }

  it("blocks when required Foundation stages are missing", async () => {
    await expectGate({ foundation: { missing: ["worldview"] }, fullBookArchitecture: { issues: [] } });
  });

  it("blocks blocker and major issues from full-book architecture", async () => {
    await expectGate({ foundation: { missing: [] }, fullBookArchitecture: { issues: [{ severity: "major", path: "worldview.rules", message: "缺少规则" }] } });
  });

  it("blocks unknown foreshadowing references", async () => {
    await expectGate({
      foundation: { missing: [] },
      fullBookArchitecture: { issues: [] },
      references: [{
        arcId: "arc-1",
        plotThreads: { issues: [] },
        foreshadowing: { issues: [{ severity: "blocking", message: "伏笔引用无法解析" }] },
      }],
    });
  });
});
