/**
 * 列表容量上限与淘汰项计算。
 *
 * 存在的理由：历史记录与素材库都用「新条目插到头部、超出上限就截断」的模式，
 * 而截断必然要顺带清理被淘汰条目引用的 IndexedDB Blob。早期两处实现分别出错：
 * 历史用 `existing.slice(kept.length)` 反推淘汰项，在列表已满时该切片恒为空数组，
 * 被挤出的最后一项永远不被识别；素材库则只截断元数据、完全不清理 Blob。
 * 二者都会把 Blob 永久留在 IndexedDB 里。
 *
 * 这里改为对「合并后的完整列表」按上限切分：保留前 limit 项，其余即淘汰项。
 * 该式在任何上限、任何长度下都成立，不依赖新旧长度的差值关系。
 *
 * 约束：列表按插入时间倒序存放（新条目在前）；调用方负责把 kept 写回状态。
 */
export function prependWithCap<T>(
  existing: readonly T[],
  incoming: T,
  limit: number,
): { kept: T[]; evicted: T[] } {
  const merged = [incoming, ...existing];
  if (merged.length <= limit) {
    return { kept: merged, evicted: [] };
  }
  return { kept: merged.slice(0, limit), evicted: merged.slice(limit) };
}
