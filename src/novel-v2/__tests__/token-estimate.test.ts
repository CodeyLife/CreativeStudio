import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_TOKEN_BASIS,
  BUDGET_TOKEN_BASIS,
  HARD_GATE_TOKEN_BASIS,
  estimateBudgetTokens,
  estimateTokens,
} from "../token-estimate";

/**
 * Token 估算单一真源的结构契约（product-audit-20260910 P2「估算口径收敛」）。
 *
 * 这里守两件事：
 * 1) 三条具名口径的**行为等价**——合并成单一实现时不得改动任何一条口径的数值，
 *    因为预算常数（computeTokenBudget 阶梯、maxInputTokens 配置）是与 BUDGET 口径
 *    共同标定的，数值漂移会让已上线长篇在边界章节批量顶穿。
 * 2) **接线完整性**——实现必须只有一份（CJK 判定/折算不得在别处再写一遍），
 *    且留痕侧与预算侧各自挂在对的口径上（写反 = 报表分母与淘汰判据再次分叉）。
 */

const legacyAudit = (text: string) => {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  return Math.max(1, Math.ceil(cjk * 0.75 + Math.max(0, text.length - cjk) / 4));
};
const legacyFlat = (text: string) => Math.ceil(text.length / 2);
const legacyHardGate = (text: string) => {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
};

const SAMPLES = [
  "他在深夜的长街上停下脚步，听见城墙那头传来的第一声号角。",
  "The orchestrator resolves the routing snapshot before the candidate chain runs.",
  "章节 final 正文与 review.verdict 字段 mixed 70% 中文 + English terms like json_schema",
  "字",
  "a",
];

describe("token 估算单一真源（口径行为等价 + 接线）", () => {
  it("三条口径的数值与合并前的独立实现逐样本等价", () => {
    for (const sample of SAMPLES) {
      expect(estimateTokens(sample, AUDIT_TOKEN_BASIS)).toBe(legacyAudit(sample));
      expect(estimateBudgetTokens(sample)).toBe(legacyFlat(sample));
      expect(estimateTokens(sample, BUDGET_TOKEN_BASIS)).toBe(legacyFlat(sample));
      // 硬上限闸只放宽了 CJK 判定范围（兼容表意区），故只要求"不低于旧值且同量纲"。
      expect(estimateTokens(sample, HARD_GATE_TOKEN_BASIS)).toBeGreaterThanOrEqual(legacyHardGate(sample));
    }
  });

  it("空白输入为 0，非空输入下限 1 token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateBudgetTokens("   \n\t ")).toBe(0);
    expect(estimateTokens("字")).toBe(1);
    expect(estimateTokens("a")).toBe(1);
  });

  it("口径间的偏差方向稳定：中文 AUDIT>BUDGET，拉丁 AUDIT<BUDGET，硬闸最悲观", () => {
    const cjk = "字".repeat(400);
    const latin = "a".repeat(400);
    expect(estimateTokens(cjk, AUDIT_TOKEN_BASIS)).toBeGreaterThan(estimateBudgetTokens(cjk));
    expect(estimateTokens(latin, AUDIT_TOKEN_BASIS)).toBeLessThan(estimateBudgetTokens(latin));
    expect(estimateTokens(cjk, HARD_GATE_TOKEN_BASIS)).toBeGreaterThan(estimateTokens(cjk, AUDIT_TOKEN_BASIS));
  });

  it("估算随文本单调不减（预算淘汰判据不得出现负成本）", () => {
    for (const estimate of [(t: string) => estimateTokens(t), (t: string) => estimateBudgetTokens(t)]) {
      let previous = 0;
      for (let length = 0; length <= 2_000; length += 37) {
        const value = estimate("文".repeat(length));
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });
});

describe("token 估算接线锁（防止口径再次分叉）", () => {
  const sourceFiles = (readdirSync(join(process.cwd(), "src"), { recursive: true, encoding: "utf8" }) as string[])
    .map((entry) => entry.replace(/\\/g, "/"))
    .filter((entry) => /\.tsx?$/.test(entry) && !entry.includes("__tests__"))
    .map((entry) => `src/${entry}`);

  const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

  it("token 折算式只在单一真源里出现（CJK 计数换算、flat length/2 均不得内联）", () => {
    const offenders = sourceFiles
      .filter((file) => !file.endsWith("token-estimate.ts"))
      .filter((file) => {
        const source = read(file);
        return /cjk\w*\s*\*\s*[\d.]/.test(source) || /Math\.ceil\(.*length.*\/\s*2\b/.test(source);
      });
    expect(offenders).toEqual([]);
  });

  it("口径常数只有单一真源一份定义", () => {
    const owners = sourceFiles.filter((file) => /cjkTokensPerChar|latinCharsPerToken/.test(read(file)));
    expect(owners).toEqual(["src/novel-v2/token-estimate.ts"]);
  });

  it("留痕侧走审计口径、预算闸走预算口径（写反即红）", () => {
    const gateway = read("src/novel-v2/model-gateway.ts");
    expect([...gateway.matchAll(/const estimatedInputTokens = estimateTokens\(/g)].length).toBe(1);
    expect([...gateway.matchAll(/estimatedOutputTokens = estimateTokens\(/g)].length).toBe(1);
    expect([...gateway.matchAll(/estimatedInputTokens = estimateBudgetTokens\(/g)].length).toBe(2);
  });

  it("淘汰/预算判据不得改用审计口径，观测字段不得改用预算口径（逐字段绑定）", () => {
    // 判据侧：cognition 与 activities 只允许预算口径。
    for (const file of ["src/novel-v2/cognition.ts", "src/novel-v2/temporal/activities.ts"]) {
      expect(read(file), file).not.toMatch(/estimateTokens\(/);
    }
    // 装配侧：usableTokens / requiredInputTokens / estimatedInputTokens 三处判据走预算，
    // 只有观测字段 estimatedInputTokensAuditBasis 走审计口径。写反=预算判据被换掉。
    const stage = read("src/novel-v2/stage-context.ts");
    expect(stage).toMatch(/const usableTokens = Math\.max\(0, request\.maxInputTokens - request\.reservedOutputTokens - systemTokens - schemaTokens\)/);
    expect(stage).toMatch(/systemTokens = estimateStageTokens\(/);
    expect(stage).toMatch(/estimatedInputTokens: systemTokens \+ schemaTokens \+ estimateStageTokens\(instruction\)/);
    expect(stage).toMatch(/estimatedInputTokensAuditBasis: auditSystemTokens \+ auditSchemaTokens \+ estimateTokens\(instruction\)/);
    expect([...stage.matchAll(/(?<![A-Za-z])estimateTokens\(/g)].length).toBe(3);
  });

  it("记忆选择收据的 tokenCost 两条路径同式（曾经一处含分隔符一处不含）", () => {
    const shape = /estimateBudgetTokens\(`\$\{claim\.title\}\\n\$\{claim\.content\}`\)/g;
    expect([...read("src/novel-v2/cognition.ts").matchAll(shape)].length).toBeGreaterThanOrEqual(1);
    expect([...read("src/novel-v2/temporal/activities.ts").matchAll(shape)].length).toBe(1);
  });
});
