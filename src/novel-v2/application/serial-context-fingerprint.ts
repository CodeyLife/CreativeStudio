import { canonicalSha256 } from "../canonical-json";
import type { SerialContextSnapshot } from "../protocol";

/**
 * 序列证据指纹——repository 与 activities 共用的唯一算式。
 *
 * 根因（2026-09-19 实测）：`assetSpans` 由 activities 层在快照**返回之后**回填
 * （repository 没有对象存储访问权，取正文只能在上层做），而指纹在 repository 内
 * 按 `assetSpans: []` 算定后就再也不动。于是回填改变了内容却没改变指纹——
 * `provenanceRefs: [serialContext.fingerprint]` 与 memory bundle 指纹都声称覆盖
 * 整份序列证据，实际漏掉资产账本，两份不同输入可以共用同一个 bundle 指纹；
 * 而"外部任务交付须输入指纹一致"这条不变式正建在这个值上。
 *
 * 因此算式抽成单一函数，两侧同调：写入时按当先内容算，回填后按新内容重算。
 * 资产扫描失败或无资产时输入不变 ⇒ 指纹与修复前逐字节相同（不给历史项目制造漂移）。
 */
export function serialContextFingerprint(snapshot: Omit<SerialContextSnapshot, "fingerprint">): string {
  const { window, chapters, characterSpans, functionRuns, subjectSpans, openPromises, assetSpans } = snapshot;
  return canonicalSha256({ window, chapters, characterSpans, functionRuns, subjectSpans, openPromises, assetSpans });
}
