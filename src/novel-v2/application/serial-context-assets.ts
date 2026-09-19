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

/**
 * `withAssetSpans` 的调用门面：把"没有对象存储"这一形态也纳入降级回报。
 *
 * 单开一层的原因：`objects` 缺失时 `withAssetSpans` 根本没被调用，账本为空却是"未扫描"
 * 而非"无资产"——两者对读账本的人含义相反（前者要去接对象存储，后者是正文里确实没提资产）。
 * 各调用点此前各自判一次 `ctx.objects ? … : …`，于是 MCP 只读诊断面漏掉了这层回报。
 * 回报统一由返回值给出（不写死目标字段名），调用方把自己的降级通道（enhancementErrors 等）接上。
 */
export async function serialContextWithAssets(
  snapshot: SerialContextSnapshot,
  projectId: string,
  ports: {
    getChapterContentRefs: (projectId: string, narrativeOrders: number[]) => Promise<Array<{ narrativeOrder: number; objectKey: string }>>;
    getText?: (objectKey: string) => Promise<string>;
  },
): Promise<{ snapshot: SerialContextSnapshot; degradation?: string }> {
  if (!ports.getText) {
    // 已有账本（生成链路回填过的快照）即便本面无对象存储也照样读得到，不报降级。
    return snapshot.assetSpans.length
      ? { snapshot }
      : { snapshot, degradation: "serialContext.assetSpans: 对象存储不可用，未做资产数量扫描" };
  }
  const reasons: string[] = [];
  const next = await withAssetSpans(snapshot, projectId, {
    getChapterContentRefs: ports.getChapterContentRefs,
    getText: ports.getText,
    onDegrade: (reason) => reasons.push(reason),
  });
  return { snapshot: next, ...(reasons.length ? { degradation: reasons.join("；") } : {}) };
}
