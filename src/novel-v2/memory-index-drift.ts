/**
 * 记忆索引漂移判据（doctor 的 `memory-index-drift` 检查用）。
 *
 * 存在的理由是一条真实缺口：删故事弧时 Qdrant 清理失败，本仓只在 HTTP 响应里回一句
 * warning，那个"索引已脏"的状态此前唯一的落点是 `memory_gate_states.rebuild_requested_at`
 * ——一个无人回读的列（已随迁移 097 撤）。可见性从"写一个没人读的布尔"换成"常态比对
 * 两边的真实条数"。
 *
 * 判据只认一个方向：
 * - **点数 > 应有行数 = 脏索引**：多出来的点没有任何库内行对应，检索会把已删/已退役的
 *   内容当现行事实召回，正是"向量清理失败"那一型的后果形状。
 * - 点数 < 应有行数 = 欠灌：重索引可修，且写入与索引之间有正常的异步窗口，判异常只会
 *   制造噪声——所以只报数（`underIndexed`），不判脏。
 * - 拿不到点数（集合不存在、非 2xx）：两向都不判，如实记 `indexed: null`。
 *
 * 只报不修：重建整项目索引会重灌全部向量并触发一遍 embedding 调用，不该由一次体检顺手
 * 触发；修的路径是既有的 `POST /v2/projects/:id/memory/rebuild`。
 */
export type MemoryIndexBaseline = { projectId: string; claims: number; chapterMemories: number };

export type MemoryIndexDrift = {
  projectId: string;
  expected: number;
  indexed: number | null;
  /** 多出来的点数；null 表示"不判脏"（欠灌、持平或点数不可得）。 */
  extra: number | null;
};

export function detectMemoryIndexDrift(
  baseline: MemoryIndexBaseline[],
  indexedByProject: Map<string, number | null>,
): { rows: MemoryIndexDrift[]; dirty: MemoryIndexDrift[] } {
  const rows = baseline.map((row) => {
    const expected = row.claims + row.chapterMemories;
    const indexed = indexedByProject.get(row.projectId) ?? null;
    const extra = indexed !== null && indexed > expected ? indexed - expected : null;
    return { projectId: row.projectId, expected, indexed, extra };
  });
  return { rows, dirty: rows.filter((row) => row.extra !== null) };
}
