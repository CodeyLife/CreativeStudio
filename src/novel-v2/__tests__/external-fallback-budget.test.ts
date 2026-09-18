import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_EXTERNAL_FALLBACK_ADVANCES, ExternalFallbackBudgetExhaustedError } from "../temporal/workflows";

/**
 * OR-B3（product-audit-20260910 E3）外部回退显式预算的结构契约。
 * workflow 沙箱代码难以单测执行，这里守住接线完整性：三处带超时推进语义的
 * waitForExternal 必须有预算守卫、其外层 catch 必须保留 manual-review-required
 * （instanceof 保护）。删守卫/漏接线即红——防"机制存在但被某次重构拆散"。
 */
describe("外部回退预算接线（OR-B3）", () => {
  const source = readFileSync(join(process.cwd(), "src", "novel-v2", "temporal", "workflows.ts"), "utf8");

  it("预算常量具名存在且样本量级合理（对齐 DEFAULT_MAX_AUTO_REVISIONS 形态）", () => {
    expect(MAX_EXTERNAL_FALLBACK_ADVANCES).toBeGreaterThan(0);
    expect(MAX_EXTERNAL_FALLBACK_ADVANCES).toBeLessThanOrEqual(20);
    expect(new ExternalFallbackBudgetExhaustedError(7, "mt-1").name).toBe("ExternalFallbackBudgetExhaustedError");
  });

  it("超时推进型 waitForExternal 全部挂预算守卫，预算错误出口全部被 catch 保护", () => {
    const guards = [...source.matchAll(/externalAdvances \+= 1;/g)].length;
    const throws = [...source.matchAll(/throw new ExternalFallbackBudgetExhaustedError/g)].length;
    const catchGuards = [...source.matchAll(/if \(error instanceof ExternalFallbackBudgetExhaustedError\)/g)].length;
    expect(guards).toBe(3); // 章节主循环 / creative run / targeted revision
    expect(throws).toBe(guards);
    expect(catchGuards).toBe(guards); // 每个预算出口都有对应 catch 保护，DB 态不被覆写 failed
  });
});
