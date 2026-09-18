/**
 * 代码版本戳（2026-09-16 审核轮 3：常驻服务"修复静默不生效"的可见性落点）。
 *
 * 根因：runtimeFingerprint 只哈希配置身份（profile/存储/迁移目录），代码改了它不变——
 * 复用旧进程的 dev 编排与人工排障都看不见"进程比 HEAD 旧"。全书审核的机制端修复
 * （人物登记表/群像契约/dueLedger/POV 归一）部署后，栈内旧 worker 仍在按旧 prompt
 * 生成——一次典型的"已修复但静默未生效"。本模块给每个服务一个启动期一次性读取的
 * git HEAD 短哈希，健康端点对外暴露；dev-v2 复用路径据此打版本滞后警告。
 * 边界：git 不可用（容器/裸部署）返回 "unknown"，消费方只警告不拒启；这是可见性
 * 探针，不是部署门禁。
 */
import { spawnSync } from "node:child_process";

let cached: string | undefined;

export function codeRevision(root?: string): string {
  if (cached === undefined) {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root ?? process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    cached = result.status === 0 ? result.stdout.trim() || "unknown" : "unknown";
  }
  return cached;
}
