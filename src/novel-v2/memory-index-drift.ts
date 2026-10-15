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
 * **`missingRowIds` 是混合口径，读数时要拆分**（2026-10-14 round 28 实测补注）：
 * 它同时含两类后果完全不同的行——
 *   ① **真缺口**：该 identity 槽位的当前值没有点，语义检索真的读不到；
 *   ② **不该灌**：同一 identity 槽位已灌了更新的可见值，旧值不入索引是**正确的**
 *      （灌了反而让检索面同时看到新旧两个值）。
 * `ymcp` 实测"欠灌 76"里 66 条属②、只有 **10 条**属①（且全在 ch13—ch98，中后期零缺口）。
 * 区分需要 identityHash 与叙事位置，而本判据的入参基线只带行 id（`MemoryIndexBaseline`），
 * 故不在判据内拆；要拆就用同源口径另行计算
 * （见 `tmp/state-audit/verify-under-indexed-attribution-v2.mts`）。
 * **因此"欠灌 N 条"不能直接当作待办总量**——这一点已写进 doctor 的 detail 文案。
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

/**
 * 索引写入的"不阻塞 + 留痕"包膜。
 *
 * 为什么需要它（state-audit-20261013 §8.4/§8.6）：本仓有 8 处"先写库、后写 Qdrant"的
 * 写入点，其中 5 处曾只 `console.warn`。**"不阻塞主路径"与"不留痕迹"是两件事**——
 * 前者是契约（瞬时 Qdrant 故障不该拦住作者创作），后者是缺口。只 warn 的后果是：
 * 库里那一行此后在一切查询里都显得完全活着（可见性谓词认它、基线枚举含它、authority
 * 正常），只有语义检索永远召不回它，没有任何科目因此变红，唯一暴露途径是 doctor 的
 * 漂移检查，而它按设计"只报不修/不自动触发"——一次瞬时故障可以静默数周
 * （运行库实测 6 条 current-revision 章记忆正是这个形态）。
 *
 * 收成一个函数的理由是**防再次分叉**：逐处手写 catch 时，形状会各自演进
 * （本仓 8 处里有 3 种不同形态：只 warn / 返回 error 字段 / 落 projection_failures）。
 * 包膜统一三件事：① 不抛（主路径继续）；② 落耐久账（recordProjectionFailure 优先，
 *    它是带 upsert 与重试计数的既有表，比 audit_records 更贴合"待重做"语义）；
 * ③ **记账自身失败也只 warn**——观测路径不能把生产路径带崩。
 *
 * 边界：包膜只负责"失败之后怎么办"，不改变写入顺序，也不承诺补偿
 * （补偿仍是 rebuild 的补灌侧，或由待办账驱动的人工重放）。
 */
export async function writeMemoryIndexWithTrace<T>(input: {
  projectId: string;
  /** 账本聚合 id：通常是 revision id（重做该 revision 的投影即可修复）。 */
  aggregateId: string;
  /** 投影类型名，进 projection_failures.projection_type（与同表其他类型不撞）。 */
  projectionType: string;
  /** 待写入的行 id：落账供定向补灌。缺省时账本只记"不知道是哪几行"，补救成本高得多。 */
  rowIds?: readonly string[];
  write: () => Promise<T>;
  record: (failure: { projectId: string; projectionType: string; aggregateId: string; payload: Record<string, unknown>; error: string }) => Promise<void>;
}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await input.write() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-index] ${input.projectionType} 索引写入失败（不阻塞主路径，已留痕）：${message}`);
    try {
      await input.record({
        projectId: input.projectId,
        projectionType: input.projectionType,
        aggregateId: input.aggregateId,
        payload: { rowIds: [...(input.rowIds ?? [])], rowCount: input.rowIds?.length ?? 0, projectionType: input.projectionType },
        error: message,
      });
    } catch (recordError) {
      // 观测路径不得把生产路径带崩；但这里必须留一句 warn，否则"留痕失败"再次静默。
      console.warn(`[memory-index] ${input.projectionType} 失败记账自身失败（观测降级）：${(recordError as Error).message}`);
    }
    return { ok: false, error: message };
  }
}
