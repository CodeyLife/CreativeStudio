/**
 * OR-D3（product-audit-20260910 E5 剩余子项）：结构化调用的上下文清单采样物化。
 * 症状：context_manifests 仅 25 份对 1523 次调用——prompt-package 级上下文收据
 * （分段预算、排除原因、skill 投影）只在蓝图主链路落库，评审/修订/抽取等高频
 * purpose 的上下文膨胀在观测面完全不可见。
 * 机制：对每次带 manifest 的调用按 sha256(purpose + promptFingerprint) 的稳定
 * 采样命中物化 manifest 并回填 prompt_executions.context_manifest_id。稳定哈希
 * 而非随机：同一 prompt 重放得到同一决策，观测可复现；purpose 参与哈希避免
 * 同一文本在不同 purpose 间共享命中（膨胀面按 purpose 独立）。
 * 边界：比率 env 可配（默认 5%，0=关闭）；manifest 全量 JSONB 本就逐次留痕，
 * 采样只决定"规范化可 JOIN 面"的写入量——未命中行不丢数据，只是不进
 * context_manifests 表。物化失败（DB 抖动）不阻塞留痕主链路。
 * 执行位置（审核 N1）：命中判定与物化在 repository.recordPromptExecution 本体
 * 执行——网关回调、外部任务 submit 直连、诊断工具等全部留痕消费面天然同源，
 * 采样不存在"某进程漏接线即绕过"的漂移面。本模块只提供纯判据与 env 解析。
 */
import { createHash } from "node:crypto";
import type { PromptContextManifest } from "./protocol";

/** 采样命中：sha256 前 8 hex → [0,1) 均匀映射，与比率比较。 */
export function contextManifestSamplingHit(manifest: PromptContextManifest, promptFingerprint: string, ratio: number): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  const digest = createHash("sha256").update(`${manifest.purpose}:${promptFingerprint}`, "utf8").digest("hex").slice(0, 8);
  return Number.parseInt(digest, 16) / 0x100000000 < ratio;
}

export function samplingRatioFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOVEL_CONTEXT_MANIFEST_SAMPLING;
  if (raw === undefined || raw === "") return 0.05;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.05;
}
