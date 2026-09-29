import type { MemoryHit, RetrievalFacet } from "./protocol";
import type { ChapterBlueprintRecord, StoryArcThreadResponsibility } from "./application/story-arc";

/**
 * 方向驱动事实检索计划（improvement-plan-fact-injection-20260922 迭代 1）。
 *
 * 设计依据：docs/novel-v2/improvement-plan-fact-injection-20260922.md §1——
 * 020 账册日期 / 021 交易条款 / 024 玉牌归属三类硬矛盾的共同根因：相关冻结断言
 * 在预算竞价中落选，没有被强制注入本章上下文，模型凭记忆重写。本模块把
 * "本章要写什么方向"翻译成"必须带上哪些实体/线程的冻结断言"（fact retrieval plan），
 * 由 retrieveMemory 据此定向检索并以 pinnedClaims 强制注入。
 *
 * 泛化红线（AGENTS.md）：
 * - facet **只从结构化源派生**——蓝图场景 participants 与弧 threadResponsibilities.threadRef。
 *   `chapter_goal` 是自由文本，仅用于人工"该章应带哪些事实"清单的吻合度核对，
 *   不作派生主源，防噪声实体混入（方案 2026-09-29 复核修订第 4 条）。
 * - 派生实体集合有硬上限（P0 护栏）：pinned 超预算在 buildMemoryBundle（cognition.ts）
 *   是硬 throw（"不能静默丢弃 pinned 内容"），派生过宽会使章节生成直接失败，
 *   因此护栏必须与注入同步上线（原迭代 3 的限域前移）。
 * - 不把"章节正文里偶然出现的词"扩成检索主题（防主题漂移式灌入）。
 * - 线程的 foreshadowingRefs 不在此重复检索：开放伏笔/承诺已有专用注入通道
 *   （activities.retrieveMemory 的 openNarrativeHits），重复拉取只浪费预算。
 */

/** 方向派生实体数上限。TODO: move into runtime configuration（对齐 identity-slot-quota 的可配置约定）。 */
export const MAX_DIRECTION_ENTITIES = 12;
/** 方向派生线程引用数上限。TODO: move into runtime configuration。 */
export const MAX_DIRECTION_THREADS = 8;
/** 方向强注 claim 总量上限（跨 facet 合计）。TODO: move into runtime configuration。 */
export const MAX_DIRECTION_PINNED_TOTAL = 24;

export interface FactRetrievalPlan {
  facets: RetrievalFacet[];
  /** 派生过程触发的截断/降级告警（enhancementWarnings 契约，方案 §3.1）。 */
  enhancementWarnings: string[];
}

/**
 * 实体名按中心语后置归并（同 asset-ledger.groupAssetSpans 的尾 2 字口径）：
 * "下品灵石"与"灵石"归并为一组，展示取组内最短形态（通常是裸名词）。
 * 边界与 asset-ledger 一致：无分词，尾 2 字会与裸名词形态不归并的情形可接受。
 */
export function mergeEntitiesByHeadSuffix(names: ReadonlyArray<string>): string[] {
  const groups = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const head = name.length >= 2 ? name.slice(-2) : name;
    const existing = groups.get(head);
    if (!existing || name.length < existing.length) groups.set(head, name);
  }
  return [...groups.values()];
}

export function buildFactRetrievalPlan(input: {
  chapterBlueprint: Pick<ChapterBlueprintRecord, "scenes">;
  threadResponsibilities?: ReadonlyArray<Pick<StoryArcThreadResponsibility, "threadRef">>;
}): FactRetrievalPlan {
  const warnings: string[] = [];
  const participants = [
    ...new Set(
      input.chapterBlueprint.scenes
        .flatMap((scene) => scene.participants ?? [])
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  const merged = mergeEntitiesByHeadSuffix(participants);
  const entities = merged.slice(0, MAX_DIRECTION_ENTITIES);
  if (merged.length > entities.length) {
    warnings.push(`方向派生实体数 ${merged.length} 超上限 ${MAX_DIRECTION_ENTITIES}，已截断（防 pinned 超预算硬失败）`);
  }
  const allThreadRefs = [
    ...new Set(
      (input.threadResponsibilities ?? [])
        .map((item) => item.threadRef.trim())
        .filter(Boolean),
    ),
  ];
  const threadRefs = allThreadRefs.slice(0, MAX_DIRECTION_THREADS);
  if (allThreadRefs.length > threadRefs.length) {
    warnings.push(`方向派生线程数 ${allThreadRefs.length} 超上限 ${MAX_DIRECTION_THREADS}，已截断`);
  }
  const facets: RetrievalFacet[] = [
    ...entities.map((name): RetrievalFacet => ({ kind: "fact", query: name, required: true })),
    // 线程引用不设 required：线程类声明的覆盖不保证，required 缺席会进入
    // buildMemoryBundle 的 required-facet 硬失败路径；线程补充信号交由
    // 开放伏笔/承诺专用注入与 ranked-fill 承担。
    ...threadRefs.map((ref): RetrievalFacet => ({ kind: "thread", query: ref, required: false })),
  ];
  return { facets, enhancementWarnings: warnings };
}

/**
 * 对检索命中做方向强注封顶：按 score 降序取前 MAX_DIRECTION_PINNED_TOTAL 条，
 * 并打上 reason="direction-pinned" 供装配面审计（哪些 claim 是被方向强制拉入
 * 而非预算竞价胜出）。过滤已在调用方完成（cutoff/生命周期），这里只做限量。
 */
export function capDirectionPinnedClaims(hits: ReadonlyArray<MemoryHit>): MemoryHit[] {
  return [...hits]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_DIRECTION_PINNED_TOTAL)
    .map((hit) => ({ ...hit, reason: "direction-pinned" }));
}
