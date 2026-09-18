import { createHash } from "node:crypto";

import { FOUNDATION_TASK_CONTRACTS, foundationDataSchemaForTask } from "./foundation-contract";

/**
 * 契约内容指纹（PL-8）：批准时落进 section payload，health 重算对比。
 *
 * 独立成模块的原因与 ./evidence-check 相同：本函数依赖 node:crypto，而
 * foundation-contract 会被 temporal workflow 沙箱打包（workflows → project-plan →
 * foundation-contract），沙箱禁用 node:crypto——放在原模块会让 worker webpack
 * 打包失败（2026-09-08 evidence-check 抽取先例、2026-09-11 worker 启动失败实证）。
 * 仅允许 node 上下文（repository/activities/tests）导入本模块。
 */
export function foundationContractFingerprint(taskKey: string): string | null {
  const contract = FOUNDATION_TASK_CONTRACTS[taskKey];
  if (!contract) return null;
  return createHash("sha256")
    .update(JSON.stringify(contract) + JSON.stringify(foundationDataSchemaForTask(taskKey) ?? null))
    .digest("hex")
    .slice(0, 12);
}
