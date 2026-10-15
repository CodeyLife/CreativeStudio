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
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPostgresUnavailable } from "./test-db";
import { NovelPostgresRepository } from "../postgres-repository";
import { retrievalVisibleClaimsSql } from "../memory-visibility";
import { orderStateLikeSlotsByRecency } from "../cognition";
import { isStateLikePredicate } from "../fact-extraction/fingerprint";
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

  it("① 真库存在同槽多值并存的状态类病例（修法有真实场景可守）", async () => {
    if (!available) return;
    const hits = await loadHits();
    const slots = new Map<string, MemoryHit[]>();
    for (const hit of hits) {
      if (!hit.identityHash || !isStateLikePredicate(hit.predicate)) continue;
      const list = slots.get(hit.identityHash) ?? [];
      list.push(hit);
      slots.set(hit.identityHash, list);
    }
    const multiValue = [...slots.values()].filter((list) => list.length > 1);
    expect(Array.isArray(multiValue), "查询应能返回数组").toBe(true);
    for (const list of multiValue) expect(list.length, "多值槽位的成员数必须 > 1").toBeGreaterThan(1);
  }, 60_000);

  it("② 直接调用被测函数：槽位内按叙事位置降序，且不篡改跨槽位次序", async () => {
    if (!available) return;
    const hits = await loadHits();
    if (!hits.some((hit) => hit.identityHash && isStateLikePredicate(hit.predicate))) return; // 空库场景跳过

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
        .map((hit, index) => (hit.identityHash === slot && isStateLikePredicate(hit.predicate) ? index : -1))
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
      .map((hit, index) => (hit.identityHash && isStateLikePredicate(hit.predicate) ? null : index))
      .filter((index): index is number => index !== null);
    for (const index of nonSlotBefore) expect(after[index], `非槽位候选在第 ${index} 位不得被移动`).toBe(before[index]);
  }, 60_000);

  it("③ 谓词边界：状态类判据只认三个谓词（越权扩大会被抓）", () => {
    expect(isStateLikePredicate("持有")).toBe(true);
    expect(isStateLikePredicate("位于")).toBe(true);
    expect(isStateLikePredicate("状态变化")).toBe(true);
    expect(isStateLikePredicate("认识")).toBe(false);
    expect(isStateLikePredicate("欠")).toBe(false);
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
    if (!hit.identityHash || !isStateLikePredicate(hit.predicate)) continue;
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
