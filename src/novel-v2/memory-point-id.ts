import { createHash } from "node:crypto";

/**
 * 记忆向量点的 id：`(projectId, claimId)` 的确定性散列。
 *
 * 独立成 leaf 模块的理由是消费方不止写入侧——漂移对账要在库侧按行 id 反推"点该在哪"，
 * 若从 `qdrant-memory.ts` 引这一个函数，会把 `@qdrant/js-client-rest` 与 ModelGateway
 * 的整条导入链拖进一个纯判据（以及它的测试）。
 *
 * 一条声明 = 一个点（幂等 upsert 的立足点）：id 与内容无关，改正文不产生新点。
 * RFC 9562 UUIDv8：应用自定的确定性内容，但按标准置 variant 位，Qdrant 才认它是合法 id。
 */
export function qdrantPointId(projectId: string, claimId: string): string {
  const bytes = createHash("sha256").update(projectId).update("\0").update(claimId).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
