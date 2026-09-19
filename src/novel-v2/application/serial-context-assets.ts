import { extractAssetMentions, groupAssetSpans, type AssetMention } from "../asset-ledger";
import { serialContextFingerprint } from "./serial-context-fingerprint";
import type { SerialContextSnapshot } from "../protocol";

/**
 * 给序列证据快照补上可数资产账本——"取正文 → 扫描 → 重算指纹"的唯一实现。
 *
 * 为什么在应用层而不是 repository：`assetSpans` 需要读章节正文，而 repository 没有对象
 * 存储访问权（它只发 SQL）。原先这段扫描挂在审校活动一处，于是所有直接从 repository
 * 取序列证据的消费面（正文、修订、MCP 只读诊断）都拿到空账本，而 prompt 侧的对照渲染
 * 判据是"有账本才输出"——四处渲染点在场、数据只到一处，且旧单测手工构造账本故照绿。
 * 因此回填与指纹重算收成一份，谁取序列证据谁调用。
 *
 * 边界：已有账本不重复扫描（幂等）；单章正文取不到只跳过该章（账本如实只含可得章）；
 * 整体扫描失败原样返回入参快照并回调降级原因——不留"内容变了而指纹没变"的半更新状态。
 */
export async function withAssetSpans(
  snapshot: SerialContextSnapshot,
  projectId: string,
  ports: {
    getChapterContentRefs: (projectId: string, narrativeOrders: number[]) => Promise<Array<{ narrativeOrder: number; objectKey: string }>>;
    getText: (objectKey: string) => Promise<string>;
    onDegrade?: (reason: string) => void;
  },
): Promise<SerialContextSnapshot> {
  if (snapshot.assetSpans.length) return snapshot;
  try {
    const orders = snapshot.chapters.map((chapter) => chapter.narrativeOrder);
    const refs = await ports.getChapterContentRefs(projectId, orders);
    const perChapter: Array<{ narrativeOrder: number; mentions: AssetMention[] }> = [];
    for (const ref of refs) {
      try {
        perChapter.push({ narrativeOrder: ref.narrativeOrder, mentions: extractAssetMentions(await ports.getText(ref.objectKey)) });
      } catch { /* 单章正文不可得：跳过该章 */ }
    }
    const assetSpans = groupAssetSpans(perChapter);
    if (!assetSpans.length) return snapshot;
    const withAssets = { ...snapshot, assetSpans };
    return { ...withAssets, fingerprint: serialContextFingerprint(withAssets) };
  } catch (error) {
    ports.onDegrade?.(error instanceof Error ? error.message : String(error));
    return snapshot;
  }
}
