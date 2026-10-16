import { describe, expect, it } from "vitest";
import { chapterMemoryAsClaim } from "../chapter-memory";
import type { ChapterMemory } from "../protocol";

/**
 * 章节记忆投影的 subject_refs 扇出上限（2026-10-14 复核轮 round 68）。
 *
 * 根因：`chapterMemoryAsClaim` 直接把 LLM 产出的 `characterStates` 映射为 subject_refs，
 * 无去重、无上限。真库实测（round 68）：1832 条可见 claim 中 **8 条挂 ≥10 个键**
 * （最多 14 个），且全部是 chapter-memory rollup（叙事位置 1/21/41/81/141/161）。
 *
 * 两层后果：
 *   ① 扇出放大——一条记忆出现在 N 个主体检索面里，其中多数组并非本章真正主角；
 *   ② 主体分裂被放大——模型自造指称（round 59/60 实测 31 个）有 18 个挂在这些
 *      高扇出 claim 上，同一主体的事实按不同写法分裂且随扇出扩大。
 *
 * 上限取 8（实测 rollup 键数中位数附近；1818/1832 条只挂 1 键，不受影响）。
 * 本锁双向：上限生效、去重生效、正常规模不受影响。
 */
describe("chapter memory subject_refs 扇出上限（round 68）", () => {
  const memory = (characterIds: string[]): ChapterMemory => ({
    id: "chapter-memory:rollup:project-1:1-20",
    projectId: "project-1",
    documentId: "doc-1",
    revisionId: "rev-1",
    summary: "测试摘要",
    keyEvents: ["事件一"],
    characterStates: characterIds.map((characterId) => ({ characterId, stateSnapshot: `${characterId}的状态` })),
    unresolvedThreads: [],
    emotionalArc: "由紧张转为克制",
    narrativeRange: { start: 1, end: 20 },
    createdAt: 0,
  } as unknown as ChapterMemory);

  it("① 超过上限的 subject_refs 被截断（防扇出放大）", () => {
    const ids = Array.from({ length: 14 }, (_, index) => `char-${index}`);
    const claim = chapterMemoryAsClaim(memory(ids));
    expect(claim.subjectRefs).toHaveLength(8);
    // 截断保留原始顺序的前 8 个（即该章状态表的前 8 个角色）。
    expect(claim.subjectRefs).toEqual(ids.slice(0, 8));
  });

  it("② 重复的主体去重后再截断（防同一主体占多个名额）", () => {
    const ids = ["char-a", "char-a", "char-b", "char-b", "char-c", "char-d", "char-e", "char-f", "char-g", "char-h", "char-i"];
    const claim = chapterMemoryAsClaim(memory(ids));
    expect(claim.subjectRefs).toEqual(["char-a", "char-b", "char-c", "char-d", "char-e", "char-f", "char-g", "char-h"]);
    expect(new Set(claim.subjectRefs).size).toBe(claim.subjectRefs.length);
  });

  it("③ 正常规模不受影响（上限是防御，不是削减）", () => {
    const claim = chapterMemoryAsClaim(memory(["楚衡", "赵虎", "刘管事"]));
    expect(claim.subjectRefs).toEqual(["楚衡", "赵虎", "刘管事"]);
  });

  it("④ 反向哨兵：上限真的生效（不是恒真断言）", () => {
    // 造 20 个主体：若不截断，长度必为 20；断言它 < 20 才证明上限在工作。
    const claim = chapterMemoryAsClaim(memory(Array.from({ length: 20 }, (_, index) => `char-${index}`)));
    expect(claim.subjectRefs.length, "反向哨兵：20 个主体必须被截断").toBeLessThan(20);
    expect(claim.subjectRefs.length).toBe(8);
  });
});
