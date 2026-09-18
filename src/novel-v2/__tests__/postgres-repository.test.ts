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

  // 2026-09-17 断链修复双向锁（docs/novel-v2/ai-taint-diagnosis-20260917.md F1/§四-3）：
  // 此前本映射不读 payload.targetWordCount，补录值在行→记录这一步被静默丢弃，
  // chapter_planning_contexts 因此 226 行全空、写作端回落默认 3500，与编排指令
  // 手写的 2600 和门执法的 3500×0.6=2100 构成"同一目标三个数"。这条测试若失败，
  // 说明断链复发：写作契约会重新拿到一个不是规划者给的数字。
  it("preserves targetWordCount from the payload row (otherwise the writer never sees the planned length)", () => {
    const base = {
      id: "chapter-1",
      arc_id: "arc-1",
      project_id: "project-1",
      document_id: null,
      title: "夜谈",
      ordinal: 1,
      status: "planned" as const,
      source_artifact_id: null,
      blueprint_revision: 0,
    };
    // 正向：补录值原样进入记录（写作契约、审核面、执法门三面同源）。
    expect(chapterBlueprintFromRow({ ...base, payload: { targetWordCount: 2600 } }).targetWordCount).toBe(2600);
    // 小数取整，与 parseStoryArcBundle 同口径。
    expect(chapterBlueprintFromRow({ ...base, payload: { targetWordCount: 2799.6 } }).targetWordCount).toBe(2800);
    // 反向：缺省不注入（回落 DEFAULT_TARGET_WORD_COUNT，历史章零回归）。
    expect(chapterBlueprintFromRow({ ...base, payload: {} }).targetWordCount).toBeUndefined();
    // 反向：非法值一律不注入——0/负数/非数/NaN 都不得被当成目标传播。
    for (const bad of [0, -100, "2600", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chapterBlueprintFromRow({ ...base, payload: { targetWordCount: bad } }).targetWordCount).toBeUndefined();
    }
  });
});
