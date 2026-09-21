import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    /**
     * 全局超时（此前两处都不设，落在 vitest 默认的 5s）。
     *
     * 立这个常数的依据是实测：安静机器上全量 1,235 测的分布是 p50=1ms、最慢 4,000ms
     * （`evaluation.test.ts` 的 dryRun 闭环），即默认预算已被用到 80%——同一次真库全量跑里，
     * 一条 `migrate-tail-repairs` 用例在机器带负载时越过 5s 判红，而它测的是启动回填的
     * 行为，不是时间。默认值的问题不在"太小"这一抽象判断，在这条可复现的越线。
     *
     * 取 15s = 安静最慢值 ×3 余量；再大就会把"真的挂住"（例如本仓那条以挂起为证据的
     * 死锁反向对照）的判红时间按比例拖长，故不取 30s 以上。慢钩子仍在各处显式给值
     * （migrate 类 30s/60s/120s 共 39 处）——那些是真实的启动耗时，不该被全局值放宽。
     */
    testTimeout: 15_000,
    hookTimeout: 30_000,
    setupFiles: ["./src/novel-v2/__tests__/setup.ts"],
    include: [
      "src/novel-v2/**/__tests__/*.test.{ts,tsx}",
      "src/pages/novel-v2/**/__tests__/*.test.{ts,tsx}",
      "src/lib/**/__tests__/*.test.{ts,tsx}",
      "src/shared/**/__tests__/*.test.{ts,tsx}",
      "src/stores/**/__tests__/*.test.{ts,tsx}"
    ],
    exclude: [
      "**/node_modules/**",
      "**/e2e-*.test.ts",
      "**/real-llm-*.test.ts",
      "**/bench/*.test.ts"
    ]
  }
});
