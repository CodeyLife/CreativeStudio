/**
 * 字符二元组 Dice 相似度（通用启发式，跨场景复用）。
 *
 * 原为记忆梳理诊断投影（memory-governance-audit-20260909 §5.5）与回述对照诊断
 * 的宿主模块；2026-09-24 工具面减法撤掉两个零调用诊断工具后，本模块只保留
 * 仍被检索/排序消费的纯函数。纯 TS 实现，不依赖 pg_trgm 等数据库扩展。
 */

/** 字符二元组 multiset Dice 系数（0-1）：中文近重复候选排序的通用启发式。 */
export function textBigramDice(a: string, b: string): number {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
  const left = normalize(a);
  const right = normalize(b);
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let intersection = 0;
  const rightTotal = right.length - 1;
  for (let i = 0; i < rightTotal; i += 1) {
    const gram = right.slice(i, i + 2);
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      intersection += 1;
      counts.set(gram, remaining - 1);
    }
  }
  const total = (left.length - 1) + rightTotal;
  return total === 0 ? 0 : (2 * intersection) / total;
}
