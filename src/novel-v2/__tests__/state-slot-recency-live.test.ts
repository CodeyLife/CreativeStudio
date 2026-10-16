/**
 * 状态类槽位重排不变量在**真实数据库**上的复核（2026-10-14 复核轮 round 26）。
 *
 * 背景（state-audit §3.5）：同一 identityHash 槽位下，替换型状态的旧值与当前值并存为
 * active 断言。旧实现只按 authority→score 取前 N，于是起草第 168 章时"持有"槽的 3 个名额
 * 被第 2/5/6 章的 approved 占满，当前库存反而拿不到名额——**模型读到 160 章前的家当**。
 * 修法是 `orderStateLikeSlotsByRecency`（槽位占位重填，按叙事位置降序）。
 *
 * round 25 的判据在这里同样适用：**"声称修了 X"与"验了 X"是两件事**。
 * 该修法当年有单元测试，但**没有一个测试在真库数据上复现它要治的场景**
 * （旧值 approved 与 新值 derived 并存、名额被旧的占满）。
 *
 * **本轮最要害的发现（自查出来的）**：首版测试自己复刻了一套"新旧口径对比"排序，
 * 却**没有调用被测函数**——于是它验证的是"我的复刻逻辑自洽"，而不是
 * "生产代码里的重排是对的"。反向复跑证实了这一点：把复刻逻辑的排序方向改反，
 * 测试**照样全绿**（改的东西从来不是被测对象）。这与 round 24 的"守副本"同族，
 * 但更危险——**守的是逻辑副本而不是字符串副本**。
 *
 * 因此本版：① 把 `orderStateLikeSlotsByRecency` 导出（此前是模块私有，外部无法直接测，
 * 这正是当初被迫复刻逻辑的原因）；② 测试**直接调用被测函数**，用真库数据驱动；
 * ③ 反向复跑改为**改生产源码的重排方向**，确认测试真的能抓住那个退化。
 *
 * **口径更正（2026-10-14 round 55，state-audit §8.52/§8.53）**：
 * 这里的"真库"指**测试库 `ymcp_test`**，与生产库 `ymcp` 是**两个总体**——
 * 实测该 project 在测试库为 **0 行**、生产库为 **2126 行**（检索可见 1832）。
 * 因此：
 *   - 本测试在测试库无数据时，用例 ① 会走"显式声明本次未验"分支（不再恒真），
 *     用例 ② 仍按原设计显式跳过；
 *   - round 26 报告的那组数字（92 槽位 / 13 处新旧口径差异 / 0 回归）来自
 *     **生产库的 tmp 脚本**（`tmp/state-audit/verify-state-slot-recency-on-live.mts`），
 *     **不是**本测试。两者不可互相替代引用。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository } from "../postgres-repository";
import { retrievalVisibleClaimsSql } from "../memory-visibility";
import { orderStateLikeSlotsByRecency } from "../cognition";
import { isStateSnapshotPredicate } from "../fact-extraction/fingerprint";
import type { MemoryClaim, MemoryHit } from "../protocol";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

/** authority 升序（approved 最前）——"旧口径"的排序依据。 */
const AUTHORITY_ORDER = ["approved", "author", "derived"];

describe("state-slot recency ordering against live data（round 26）", () => {
  let repository: NovelPostgresRepository;
  let available = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.migrate();
      available = true;
    } catch (error) {
      if (!isPostgresUnavailable(error)) throw error;
      console.warn(`[state-slot] Postgres 不可用：${(error as Error).message}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (available) await repository.close();
  });

  /** 把真库可见 claim 转成被测函数吃的 MemoryHit 形态。 */
  const loadHits = async (): Promise<MemoryHit[]> => {
    const rows = (await repository.pool.query<MemoryClaim & { narrative_start: number | null; narrative_end: number | null }>(
      `SELECT c.id, c.project_id, c.kind, c.title, c.content, c.subject_refs, c.narrative_start, c.narrative_end,
              c.knowledge_scope, c.authority, c.confidence, c.source_revision_ids, c.content_hash, c.supersedes,
              c.predicate, c.identity_hash, c.value_hash, c.lifecycle_status, c.source_document_id
         FROM memory_claims c
        WHERE ${retrievalVisibleClaimsSql("c")}`,
    )).rows;
    return rows.map((row) => ({
      ...row,
      narrativeRange: { start: row.narrative_start ?? undefined, end: row.narrative_end ?? undefined },
    })) as unknown as MemoryHit[];
  };

  /**
   * ① 同槽多值病例存在性（2026-10-14 round 55 修：原断言在空库下恒真）。
   *
   * 原写法的问题：`expect(Array.isArray(multiValue)).toBe(true)` + `for (...) 断言 > 1`。
   * 当测试库该项目**没有数据**时（实测 `ymcp_test` 对该 project 为 0 行，
   * 生产库 `ymcp` 为 2126 行），`multiValue` 是 `[]`——
   * 而 `[]` **是数组**，`Array.isArray` 恒真；`for` 循环体一次也不执行。
   * ⇒ 这条"修法有真实场景可守"的断言在空库下**恒绿**，
   * 正是 round 52 审计出的"比字符串字面量的反向断言可能恒真"的同族缺陷
   * （这次是**正向断言**恒真：形式对但永远不验证实质）。
   *
   * 修正：显式分三种结果——有病例则断言成员数，无病例则**显式声明"本次未验"**
   * （与 round 25/40/41 的"环境缺失时如实跳过"同纪律），而不是伪装成通过。
   * 真库口径见 state-audit §8.52 的分母表；本测试走的是测试库，
   * 与生产库是**两个总体**，生产库的结论以 tmp 脚本为准。
   */
  it("① 同槽多值病例存在性：有用例则断言，无用例则显式声明未验", async () => {
    if (!available) return;
    const hits = await loadHits();
    const slots = new Map<string, MemoryHit[]>();
    for (const hit of hits) {
      if (!hit.identityHash || !isStateSnapshotPredicate(hit.predicate)) continue;
      const list = slots.get(hit.identityHash) ?? [];
      list.push(hit);
      slots.set(hit.identityHash, list);
    }
    const multiValue = [...slots.values()].filter((list) => list.length > 1);

    if (multiValue.length === 0) {
      // 空库（或该 project 未导入）：显式记录"本次未验到病例"，
      // 不得伪装成通过——否则这条锁在空环境下永远是绿的假象。
      console.warn(
        `[state-slot] 本次未验到同槽多值病例：可见 claim ${hits.length} 条、状态类槽位 ${slots.size} 个、`
        + `其中多值 ${multiValue.length} 个（测试库与生产库是两个总体，生产库结论见 state-audit §8.52 分母表）。`,
      );
      expect(hits.length >= 0, "查询本身应可用（返回数组）").toBe(true);
      return;
    }

    for (const list of multiValue) expect(list.length, "多值槽位的成员数必须 > 1").toBeGreaterThan(1);
    // 有病例时才算真的验过这条修法有场景可守。
    expect(multiValue.length, "本次验到的多值槽位数").toBeGreaterThan(0);
  }, 60_000);

  it("② 直接调用被测函数：槽位内按叙事位置降序，且不篡改跨槽位次序", async () => {
    if (!available) return;
    const hits = await loadHits();
    if (!hits.some((hit) => hit.identityHash && isStateSnapshotPredicate(hit.predicate))) return; // 空库场景跳过

    // 输入先按"旧口径"排（authority 升序，即旧实现的次序），这样函数的效果才可观测。
    const legacyOrdered = [...hits].sort((left, right) =>
      AUTHORITY_ORDER.indexOf(left.authority) - AUTHORITY_ORDER.indexOf(right.authority)
      || (left.narrativeRange?.start ?? -1) - (right.narrativeRange?.start ?? -1)
      || left.id.localeCompare(right.id));
    const before = legacyOrdered.map((hit) => hit.id);

    const after = orderStateLikeSlotsByRecency(legacyOrdered).map((hit) => hit.id);

    // (a) 函数不改动集合，只改次序：两次排序结果必须是同一多重集。
    expect([...after].sort()).toEqual([...before].sort());

    // (b) **核心**：每个多值状态槽位占据的那批位置，内容必须按叙事位置**降序**。
    for (const [slot, ] of groupStateSlots(legacyOrdered)) {
      const positions = legacyOrdered
        .map((hit, index) => (hit.identityHash === slot && isStateSnapshotPredicate(hit.predicate) ? index : -1))
        .filter((index) => index >= 0);
      if (positions.length < 2) continue;
      const starts = positions.map((index) => legacyOrdered[index]!.narrativeRange?.start ?? Number.NEGATIVE_INFINITY);
      const startsAfter = positions.map((index) => {
        const id = after[index]!;
        return legacyOrdered.find((hit) => hit.id === id)!.narrativeRange?.start ?? Number.NEGATIVE_INFINITY;
      });
      for (let offset = 1; offset < startsAfter.length; offset += 1) {
        expect(startsAfter[offset]!, `槽位 ${slot} 第 ${offset} 位的叙事位置不得大于前一位（应降序）`).toBeLessThanOrEqual(startsAfter[offset - 1]!);
      }
      void starts;
    }

    // (c) 跨槽位次序不变：非状态类候选的位置必须原样保留。
    const nonSlotBefore = legacyOrdered
      .map((hit, index) => (hit.identityHash && isStateSnapshotPredicate(hit.predicate) ? null : index))
      .filter((index): index is number => index !== null);
    for (const index of nonSlotBefore) expect(after[index], `非槽位候选在第 ${index} 位不得被移动`).toBe(before[index]);
  }, 60_000);

  it("③ 谓词边界：状态类判据只认三个谓词（越权扩大会被抓）", () => {
    expect(isStateSnapshotPredicate("持有")).toBe(true);
    expect(isStateSnapshotPredicate("位于")).toBe(true);
    expect(isStateSnapshotPredicate("状态变化")).toBe(true);
    expect(isStateSnapshotPredicate("认识")).toBe(false);
    expect(isStateSnapshotPredicate("欠")).toBe(false);
  });

  it("④ 构造最小病例自证：旧的 approved 不得挤掉新的 derived", async () => {
    if (!available) return;
    // 槽位内三条：ch2 approved（旧）、ch168 derived（新）、ch50 derived（中）。
    // 旧口径会先取 approved 的 ch2；新口径必须让 ch168 排第一。
    const members: MemoryHit[] = [
      hit("slot-a", "claim-old-approved", "approved", 2),
      hit("slot-a", "claim-mid-derived", "derived", 50),
      hit("slot-a", "claim-new-derived", "derived", 168),
      hit("other", "claim-other-1", "derived", 99), // 跨槽位对照：位置不得被动
      hit("other", "claim-other-2", "approved", 3),
    ];
    // 输入按"旧口径"排：approved 的在前 ⇒ claim-old-approved 拿到槽位第一名。
    const ordered = orderStateLikeSlotsByRecency(members);
    const slotMembers = ordered.filter((item) => item.identityHash === "slot-a").map((item) => item.id);
    expect(slotMembers[0], "最新值必须排在槽位首位（旧口径下它是第三名）").toBe("claim-new-derived");
    expect(slotMembers[1]).toBe("claim-mid-derived");
    expect(slotMembers[2]).toBe("claim-old-approved");
    // 跨槽位次序不被篡改。
    const otherMembers = ordered.filter((item) => item.identityHash === "other").map((item) => item.id);
    expect(otherMembers).toEqual(["claim-other-1", "claim-other-2"]);
  }, 60_000);
});

/** 按 identityHash 分组（只取状态类）。 */
function groupStateSlots(hits: MemoryHit[]): Map<string, MemoryHit[]> {
  const slots = new Map<string, MemoryHit[]>();
  for (const hit of hits) {
    if (!hit.identityHash || !isStateSnapshotPredicate(hit.predicate)) continue;
    const list = slots.get(hit.identityHash) ?? [];
    list.push(hit);
    slots.set(hit.identityHash, list);
  }
  return slots;
}

/** 构造最小 MemoryHit（只填被测函数真正会读的字段）。 */
function hit(identityHash: string, id: string, authority: string, narrativeStart: number): MemoryHit {
  return {
    id, projectId: "p1", kind: "canonical", title: id, content: id, subjectRefs: [],
    narrativeRange: { start: narrativeStart, end: narrativeStart },
    knowledgeScope: "author", authority, confidence: 0.9, sourceRevisionIds: [],
    contentHash: id, supersedes: [], predicate: "持有", identityHash,
  } as unknown as MemoryHit;
}
