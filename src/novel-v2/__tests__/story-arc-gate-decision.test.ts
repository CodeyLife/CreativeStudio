import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 弧6 实践批契约（规划门作者修订反馈通道）：storyArcPlanningWorkflow 的 manual 分支
// 在审核 verdict=revise 时曾是单向死锁——approve 被 repository 门禁正当拒绝、workflow
// 只等批准信号、MCP 无弧级决策工具，编排者唯一出路是放弃重建蓝图。本测试锁定修复的
// 承重结构（temporal workflow 代码 vitest 无法驱动，沿用 external-fallback-budget 的
// 源码契约扫描法）；行为面由真实弧门验证（本批弧6 修复上线即在该弧自身死锁门上跑通）。

const workflows = readFileSync(join(import.meta.dirname, "../temporal/workflows.ts"), "utf8");
const api = readFileSync(join(import.meta.dirname, "../../../scripts/novel-v2-api.ts"), "utf8");

describe("story arc gate author-revise channel（源码契约）", () => {
  it("信号面解析 decision=revise，旧载荷保持批准语义零回归", () => {
    expect(workflows).toMatch(/body\.decision === "revise"[\s\S]*?gateDecision = \{ decision: "revise", feedback/);
    // 反例面：不得退回"无脑置 approved"的旧 handler（丢 decision 解析=通道再死锁）。
    expect(workflows).not.toMatch(/setHandler\(storyArcApprovedSignal, \(\) => \{ approved = true; \}\)/);
  });

  it("manual 分支等 approve 或 gateDecision，revise 走 修订→重投影→重审→再入门", () => {
    const start = workflows.indexOf("if (reviewStrategy.humanApproval) {");
    const body = workflows.slice(start, workflows.indexOf("const maxRetries", start));
    expect(start).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain("await condition(() => approved || gateDecision !== undefined)");
    // 作者指令与审核意见合并（不覆盖审核器发现的问题）。
    expect(body).toMatch(/mergedOpinion = \[reviewed\.review\.verdict === "revise" \? reviewed\.review\.opinion : "", decision\.feedback/);
    expect(body).toContain("current = await reviseBundle(current, { verdict: \"revise\", opinion: mergedOpinion })");
    // 修订后必须重投影（edited 通道）并再审，投影 actor 记作者。
    expect(body).toMatch(/projectStoryArcBundle\(\{[^}]*actor: "web-author", edited: true/);
    expect(body).toMatch(/reviewed = await reviewBundle\(current\)/);
    // 批准路径保留 2026-09-08 修复：approved 后落库 approveStoryArcAutomatically。
    expect(body).toContain("approveStoryArcAutomatically");
  });

  it("REST 与 MCP 两入口同语义：revise 不落库批准、无活动门显式拒绝", () => {
    expect(api).toMatch(/input\.decision === "revise"/);
    expect(api).toMatch(/修订指令无处投递/);
    const reviseBranch = api.match(/if \(input\.decision === "revise"\) \{[\s\S]*?\n      \}/)?.[0] ?? "";
    // revise 分支不得调用 approveStoryArc（门禁拒绝是设计，指令只进信号）。
    expect(reviseBranch).not.toContain("approveStoryArc(");
    expect(reviseBranch).toContain('signal("storyArcApproved", { decision: "revise"');
  });
});
