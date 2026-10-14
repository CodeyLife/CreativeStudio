import { qdrantPointId } from "./memory-point-id";

/**
 * 记忆索引漂移判据（doctor 的 `memory-index-drift` 检查用）。
 *
 * 存在的理由是一条真实缺口：删故事弧时 Qdrant 清理失败，本仓只在 HTTP 响应里回一句
 * warning，那个"索引已脏"的状态此前唯一的落点是 `memory_gate_states.rebuild_requested_at`
 * ——一个无人回读的列（已随迁移 097 撤）。可见性从"写一个没人读的布尔"换成"常态比对
 * 两边的真实条数"。
 *
 * **比较的是集合，不是条数**（这一条是被实测逼出来的）：`ymcp` 首跑给出"应有 2180 / 实有
 * 2131"，按基数的判据据此报"欠灌 49、不脏"。集合级复测的实形是**缺 76 条 + 多 27 个陈旧点**
 * ——两向误差相减才得 49。也就是说只要补灌速度与删除失败速度相当，按基数的检查会一路报绿，
 * 而那 27 个点正把已退役内容当现行事实召回。基数掩盖集合不是精度问题，是判据方向错。
 *
 * 判据仍只认一个方向为"异常"：
 * - **有陈旧点 = 脏索引**：点无对应可见行，检索会把已删/已退役内容当现行事实召回。
 * - 缺点 = 欠灌：重索引可修，且写入与索引间有正常异步窗口，判异常只会制造噪声——但它
 *   以 `missingRowIds` 具名给出（欠灌是"检索读不到"，与陈旧点的"读到假的"后果不同级）。
 * - 拿不到点集（集合不存在、非 2xx）：两向都不判，`indexed: null`。
 *
 * 只报不修：重建整项目索引会重灌全部向量并触发一遍 embedding 调用，不该由一次体检顺手
 * 触发；修的路径是既有的 `POST /v2/projects/:id/memory/rebuild`。
 */
export type MemoryIndexBaseline = { projectId: string; claimIds: string[]; chapterMemoryIds: string[] };

export type MemoryIndexDrift = {
  projectId: string;
  expected: number;
  /** 索引里的实际点数；null = 点数不可得，两向都不判。 */
  indexed: number | null;
  /** 应被索引却没有点的行 id（可定向补灌的清单）。 */
  missingRowIds: string[];
  /** 索引里存在但当前不该存在的点 id（陈旧点；id 是散列，具名行 id 反推不出，故只给点）。 */
  extraPointIds: string[];
};

export function detectMemoryIndexDrift(
  baseline: MemoryIndexBaseline[],
  indexedPointIdsByProject: Map<string, Set<string> | null>,
): { rows: MemoryIndexDrift[]; dirty: MemoryIndexDrift[] } {
  const rows = baseline.map((row) => {
    const rowIds = [...row.claimIds, ...row.chapterMemoryIds];
    const indexed = indexedPointIdsByProject.get(row.projectId) ?? null;
    if (indexed === null) {
      return { projectId: row.projectId, expected: rowIds.length, indexed: null, missingRowIds: [], extraPointIds: [] };
    }
    const expectedPointIds = new Set(rowIds.map((rowId) => qdrantPointId(row.projectId, rowId)));
    const missingRowIds = rowIds.filter((rowId) => !indexed.has(qdrantPointId(row.projectId, rowId)));
    const extraPointIds = [...indexed].filter((pointId) => !expectedPointIds.has(pointId));
    return { projectId: row.projectId, expected: rowIds.length, indexed: indexed.size, missingRowIds, extraPointIds };
  });
  return { rows, dirty: rows.filter((row) => row.extraPointIds.length > 0) };
}

/**
 * 单项目的陈旧点点 id 清单（重建路径的清理输入）。
 *
 * 与 {@link detectMemoryIndexDrift} 共用同一套基线推导，只是把"按项目分组对账"
 * 收成"给定一个项目的基线与实有点集，给出差集"。之所以单独成函数而不是让调用方
 * 自己 `[...indexed].filter(...)`：重建路径（api 的 memory/rebuild）与 doctor 的
 * 观测面必须对"什么是陈旧点"有同一份定义，否则又会出现"doctor 说旧、rebuild 说新"
 * 的第二次口径分叉——那正是本模块存在的原因（见文件头注释的"比较的是集合"）。
 *
 * `indexed === null`（点集不可得）时返回空数组：拿不到实有集合就不能安全地删，
 * 此时正确行为是"不删"而不是"全删"。
 */
export function staleMemoryPointIds(baseline: MemoryIndexBaseline, indexed: ReadonlySet<string> | null): string[] {
  if (indexed === null) return [];
  const rowIds = [...baseline.claimIds, ...baseline.chapterMemoryIds];
  const expected = new Set(rowIds.map((rowId) => qdrantPointId(baseline.projectId, rowId)));
  return [...indexed].filter((pointId) => !expected.has(pointId));
}
