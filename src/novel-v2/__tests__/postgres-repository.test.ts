import { describe, expect, it } from "vitest";
import { chapterBlueprintFromRow, isTransientPostgresStartupError } from "../postgres-repository";

describe("postgres repository startup errors", () => {
  it("retries Postgres startup and recovery errors", () => {
    expect(isTransientPostgresStartupError({ code: "57P03", message: "the database system is not yet accepting connections" })).toBe(true);
    expect(isTransientPostgresStartupError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" })).toBe(true);
    expect(isTransientPostgresStartupError({ message: "Consistent recovery state has not been yet reached." })).toBe(true);
  });

  it("does not retry configuration or migration errors", () => {
    expect(isTransientPostgresStartupError({ code: "28P01", message: "password authentication failed for user ymcp" })).toBe(false);
    expect(isTransientPostgresStartupError({ code: "3D000", message: "database ymcp does not exist" })).toBe(false);
    expect(isTransientPostgresStartupError({ code: "42601", message: "syntax error at or near SELECT" })).toBe(false);
  });
});

describe("chapter blueprint row projection", () => {
  it("preserves planner rationale while keeping legacy scenes compatible", () => {
    const chapter = chapterBlueprintFromRow({
      id: "chapter-1",
      arc_id: "arc-1",
      project_id: "project-1",
      document_id: null,
      title: "夜谈",
      ordinal: 1,
      status: "planned",
      payload: {
        index: 1,
        title: "夜谈",
        scenes: [{
          title: "厨房",
          participants: ["主角"],
          situation: "雨夜停电",
          observableActions: ["收回问题"],
          planningRationale: "规划器内部推演，不进入正文执行合同",
          outcome: "关系距离变化",
        }],
      },
      source_artifact_id: null,
      blueprint_revision: 0,
    });

    expect(chapter.scenes[0].planningRationale).toBe("规划器内部推演，不进入正文执行合同");
    expect(chapterBlueprintFromRow({
      id: "chapter-legacy",
      arc_id: "arc-1",
      project_id: "project-1",
      document_id: null,
      title: "旧章",
      ordinal: 2,
      status: "planned",
      payload: { scenes: [{ title: "旧场景", participants: [], situation: "", observableActions: [], outcome: "" }] },
      source_artifact_id: null,
      blueprint_revision: 0,
    }).scenes[0]).not.toHaveProperty("planningRationale");
  });
});
