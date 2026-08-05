import { describe, expect, it } from "vitest";
import { renderSerialContext } from "../prompts/chapter-planning-context";
import { getReviewFocus } from "../prompts/chapter-review";
import { buildRuntimeLearningPrompt } from "../learning-assessment";
import type { RecentIssueCluster, SerialContextSnapshot } from "../protocol";

function makeSerial(overrides: Partial<SerialContextSnapshot> = {}): SerialContextSnapshot {
  return {
    window: 6,
    chapters: [
      { documentId: "d1", narrativeOrder: 7, title: "待机失效", narrativeFunction: "development" },
      { documentId: "d2", narrativeOrder: 8, title: "资源痕迹", narrativeFunction: "discovery" },
      { documentId: "d3", narrativeOrder: 9, title: "二号槽的人声", narrativeFunction: "relationship" },
      { documentId: "d4", narrativeOrder: 10, title: "损耗口径", narrativeFunction: "confrontation" },
      { documentId: "d5", narrativeOrder: 11, title: "缝外有人", narrativeFunction: "relationship" },
      { documentId: "d6", narrativeOrder: 12, title: "半隐蔽的上行路", narrativeFunction: "payoff" },
    ],
    characterSpans: [
      { characterId: "陈渊", states: [{ narrativeOrder: 7, stateSnapshot: "肋骨断茬钝痛，手腕以水鼠皮包扎，握着暗蓝色金属残片。" }, { narrativeOrder: 8, stateSnapshot: "肋骨断茬钝痛，手腕伤口浸水渗血，握着暗蓝色金属残片。" }] },
    ],
    functionRuns: [
      { narrativeFunction: "relationship", narrativeOrders: [9, 11] },
    ],
    subjectSpans: [
      { subject: "金属残片", narrativeOrders: [7, 8, 10, 12], latestExcerpt: "陈渊把金属残片塞进输运段石槽下藏好。" },
    ],
    fingerprint: "serial-fp",
    ...overrides,
  };
}

function makeCluster(overrides: Partial<RecentIssueCluster> = {}): RecentIssueCluster {
  return {
    key: "cross-chapter-restatement",
    chapterCount: 3,
    narrativeOrders: [7, 8, 9],
    titles: ["第一章", "第二章", "第三章"],
    severities: ["warning"],
    ...overrides,
  };
}

describe("serial-context render", () => {
  it("renders function runs, character spans and subject spans as signals", () => {
    const text = renderSerialContext(makeSerial());
    expect(text).toContain("连续同类功能");
    expect(text).toContain("角色状态跨度");
    expect(text).toContain("物件/主题跨度");
    expect(text).toContain("陈渊");
    expect(text).toContain("金属残片");
  });

  it("does not turn repeated signals into hard requirements (no 必须/禁止 phrasing)", () => {
    const text = renderSerialContext(makeSerial());
    expect(text).not.toContain("必须改变");
    expect(text).not.toContain("禁止重复");
  });

  it("explicitly leaves the fatigue-vs-motif judgment to the reviewer", () => {
    const text = renderSerialContext(makeSerial());
    expect(text).toContain("不是逐章要求");
    expect(text).toContain("检查是否有恶化/愈合/消耗/转移等可观察增量");
  });

  it("falls back gracefully when no serial context is available", () => {
    const text = renderSerialContext(undefined);
    expect(text).toContain("没有可用的跨章序列证据");
  });

  it("handles empty chapters without crashing", () => {
    const text = renderSerialContext({ window: 6, chapters: [], characterSpans: [], functionRuns: [], subjectSpans: [], fingerprint: "f" });
    expect(text).toContain("没有可用的跨章序列证据");
  });
});

describe("reviewer focus serial clauses (L2)", () => {
  it("structure-reviewer can report serial rhythm fatigue only with serial evidence", () => {
    const focus = getReviewFocus("structure-reviewer");
    expect(focus).toContain("跨章序列证据");
    expect(focus).toContain("连续同类功能章节");
    expect(focus).not.toContain("每章都必须");
  });

  it("character-reviewer can report ensemble thinness only with serial evidence", () => {
    const focus = getReviewFocus("character-reviewer");
    expect(focus).toContain("跨章序列证据");
    expect(focus).toContain("功能声部");
    expect(focus).toContain("不要求配角每章都有戏份");
  });

  it("prose-reviewer extends deletion test to cross-chapter repeated naming", () => {
    const focus = getReviewFocus("prose-reviewer");
    expect(focus).toContain("跨章序列证据");
    expect(focus).toContain("跨章重复命名");
  });
});

describe("learning cross-chapter aggregation prompt (L3)", () => {
  const artifact = { id: "artifact-1", projectId: "p", taskId: "task-1" } as never;

  it("injects issue clusters and serial signals into the learning prompt", () => {
    const prompt = buildRuntimeLearningPrompt({
      artifact,
      reviews: [],
      availableSkills: [{ skillId: "longform-continuity", capabilities: ["draft"], executionPoints: ["chapter.drafting"] }],
      serialContext: makeSerial(),
      recentIssueClusters: [makeCluster()],
    });
    expect(prompt).toContain("## 跨章模式");
    expect(prompt).toContain("cross-chapter-restatement");
    expect(prompt).toContain("连续同类功能");
    expect(prompt).toContain("角色状态跨度");
    expect(prompt).toContain("物件/主题跨度");
  });

  it("declares that a rule cluster across >=2 chapters is persistent-pattern evidence", () => {
    const prompt = buildRuntimeLearningPrompt({
      artifact,
      reviews: [],
      serialContext: undefined,
      recentIssueClusters: [makeCluster({ chapterCount: 2 })],
    });
    expect(prompt).toContain("同 rule 类在近 N 章出现 ≥2 次");
  });

  it("routes observation-chapter density to the story-arc planning layer", () => {
    const prompt = buildRuntimeLearningPrompt({ artifact, reviews: [] });
    expect(prompt).toContain("story-arc planning");
    expect(prompt).toContain("规划类 skill 的 planning 执行点");
  });

  it("keeps serial signals descriptive rather than prescriptive bans", () => {
    const prompt = buildRuntimeLearningPrompt({
      artifact,
      reviews: [],
      serialContext: makeSerial(),
      recentIssueClusters: [makeCluster()],
    });
    expect(prompt).toContain("描述性统计");
    expect(prompt).toContain("返回 no-shared-learning");
  });
});
