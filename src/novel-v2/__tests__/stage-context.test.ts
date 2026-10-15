import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { compileStageContext, createStageGoalContract, StageContextBudgetError } from "../stage-context";
import { canonicalSha256 } from "../canonical-json";

function productionTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** 收集 compileStageContext 报出的"预算挤掉"告警（2026-10-14 round 18 的回归锁用）。 */
const droppedWarnings: string[] = [];
const originalWarn = console.warn;
beforeEach(() => {
  droppedWarnings.length = 0;
  console.warn = (...args: unknown[]) => {
    const line = args.map((item) => String(item)).join(" ");
    if (line.includes("预算挤掉")) droppedWarnings.push(line);
  };
});
afterEach(() => { console.warn = originalWarn; });

describe("stage context compiler", () => {
  it("deduplicates repeated content without dropping distinct claims from one artifact", () => {
    const result = compileStageContext({
      projectId: "p1",
      workflowId: "wf1",
      purpose: "review.structure",
      stage: "review",
      maxInputTokens: 2_000,
      reservedOutputTokens: 200,
      sections: [
        { id: "goal", kind: "goal", title: "目标", text: "保留人物克制感", priority: "critical", provenanceRefs: ["goal:1"] },
        { id: "foundation", kind: "planning", title: "设定", text: "城市处于停电状态", priority: "required", provenanceRefs: ["artifact:a"], sourceArtifactId: "a" },
        { id: "foundation-memory", kind: "fact", title: "设定投影", text: "重复但文字不同", priority: "normal", provenanceRefs: ["claim:1"], sourceArtifactId: "a" },
        { id: "duplicate", kind: "background", title: "重复文本", text: "城市处于停电状态", priority: "soft", provenanceRefs: ["claim:2"] },
      ],
    }, 1);

    expect(result.instruction).toContain("保留人物克制感");
    expect(result.instruction).toContain("城市处于停电状态");
    expect(result.instruction).toContain("重复但文字不同");
    expect(result.manifest.sections.find((item) => item.id === "foundation-memory")?.status).toBe("included");
    expect(result.manifest.sections.find((item) => item.id === "duplicate")?.reason).toBe("duplicate-content");
  });

  it("同一装配串同时留两口径估算，比值方向随文本类型翻转（口径合并的前置观测面）", () => {
    const cjk = compileStageContext({
      projectId: "p1", workflowId: "wf-basis-cjk", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 8_000, reservedOutputTokens: 500, system: "你是中文长篇编辑，输出保持克制。",
      sections: [{ id: "m", kind: "manuscript", title: "正文", text: "他在长街上听见城墙那头的号角".repeat(20), priority: "required", provenanceRefs: [] }],
    }).manifest;
    const latin = compileStageContext({
      projectId: "p1", workflowId: "wf-basis-latin", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 8_000, reservedOutputTokens: 500, system: "You are a novel editor producing restrained output.",
      sections: [{ id: "m", kind: "manuscript", title: "manuscript", text: "the long street stayed quiet. ".repeat(80), priority: "required", provenanceRefs: [] }],
    }).manifest;

    // 两数来自同一段装配文本（逐部分同形，只差折算系数），故比值就是口径因子。
    expect(cjk.estimatedInputTokensAuditBasis).toBeTypeOf("number");
    expect(latin.estimatedInputTokensAuditBasis).toBeTypeOf("number");
    expect(cjk.estimatedInputTokensAuditBasis!).toBeGreaterThan(cjk.estimatedInputTokens);
    expect(latin.estimatedInputTokensAuditBasis!).toBeLessThan(latin.estimatedInputTokens);
  });

  it("派生的审计口径不进 fingerprint（在途外部任务的幂等键依赖它）", () => {
    const manifest = compileStageContext({
      projectId: "p1", workflowId: "wf-fp", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 8_000, reservedOutputTokens: 500, system: "你是中文长篇编辑。",
      sections: [{ id: "m", kind: "manuscript", title: "正文", text: "他在长街上听见号角".repeat(12), priority: "required", provenanceRefs: [] }],
    }).manifest;
    expect(manifest.estimatedInputTokensAuditBasis).toBeTypeOf("number");
    // fingerprint 必须恰等于"去掉 id/fingerprint/createdAt 与这个派生观测字段"后的规范化哈希；
    // 若把它并进 manifestBase，activities 的 inputFingerprint（含 promptContext.fingerprint 与
    // contextManifestId）会随观测字段变化，等于给部署时在途的外部任务换幂等键。
    const hashed: Record<string, unknown> = { ...manifest };
    delete hashed.id;
    delete hashed.fingerprint;
    delete hashed.createdAt;
    delete hashed.estimatedInputTokensAuditBasis;
    expect(canonicalSha256(hashed)).toBe(manifest.fingerprint);
    hashed.estimatedInputTokensAuditBasis = manifest.estimatedInputTokensAuditBasis;
    expect(canonicalSha256(hashed)).not.toBe(manifest.fingerprint);
  });

  it("drops soft context but fails explicitly when required context cannot fit", () => {
    const soft = compileStageContext({
      projectId: "p1", workflowId: "wf1", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 120, reservedOutputTokens: 20,
      sections: [
        { id: "required", kind: "manuscript", title: "正文", text: "正文".repeat(20), priority: "required", provenanceRefs: [] },
        { id: "soft", kind: "background", title: "背景", text: "背景".repeat(100), priority: "soft", provenanceRefs: [] },
      ],
    });
    expect(soft.manifest.sections.find((item) => item.id === "soft")?.reason).toBe("budget");
    expect(soft.manifest.budgetExcludedSectionCount).toBe(1);
    expect(soft.manifest.requiredInputTokens).toBeLessThanOrEqual(soft.manifest.usableInputTokens);
    // 被挤掉的段必须**报出来**（2026-10-14 round 18）：此前只记进 manifest 的
    // budgetExcludedSectionCount，而全仓没有生产读取方 ⇒ 上下文静默变薄、无人知；
    // 而审核面多处按"无该段时跳过"引用 normal 优先级的段，被挤掉会让那些检查静默失效。
    expect(droppedWarnings).toHaveLength(1);
    expect(droppedWarnings[0]).toContain("soft");
    expect(droppedWarnings[0]).toContain("预算挤掉");
    // 刻意不进 manifestBase（它参与 fingerprint，而 fingerprint 进外部任务幂等键）：
    // 因此"被挤掉"这件事在 manifest 里只以既有计数体现，不得新增观测字段。
    expect(Object.keys(soft.manifest)).not.toContain("budgetExcludedSectionIds");

    // 反例：全部装得下时不得报警（否则日志会被噪声淹没，等于没报）。
    droppedWarnings.length = 0;
    compileStageContext({
      projectId: "p1", workflowId: "wf3", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 4_000, reservedOutputTokens: 20,
      sections: [
        { id: "required", kind: "manuscript", title: "正文", text: "正文".repeat(20), priority: "required", provenanceRefs: [] },
        { id: "soft", kind: "background", title: "背景", text: "背景".repeat(20), priority: "soft", provenanceRefs: [] },
      ],
    });
    expect(droppedWarnings, "全部装得下时不得报预算丢弃").toHaveLength(0);

    let error: unknown;
    try {
      compileStageContext({
      projectId: "p1", workflowId: "wf2", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 20, reservedOutputTokens: 10,
      sections: [{ id: "required", kind: "manuscript", title: "正文", text: "正文".repeat(100), priority: "required", provenanceRefs: [] }],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StageContextBudgetError);
    expect((error as StageContextBudgetError).message).toContain("可用输入预算");
  });

  it("records upstream memory exclusions without injecting placeholder sections", () => {
    const result = compileStageContext({
      projectId: "p1", workflowId: "wf-memory", purpose: "writing.draft", stage: "drafting",
      maxInputTokens: 1_000, reservedOutputTokens: 100,
      sections: [
        { id: "active", kind: "fact", title: "有效事实", text: "角色仍在站台", priority: "required", provenanceRefs: ["r1"] },
        { id: "inactive", kind: "fact", title: "失活事实", text: "", priority: "soft", provenanceRefs: ["r0"], exclusionReason: "inactive" },
        { id: "merged", kind: "fact", title: "同值来源", text: "", priority: "soft", provenanceRefs: ["r2"], exclusionReason: "merged-source" },
      ],
    });

    expect(result.instruction).toContain("角色仍在站台");
    expect(result.instruction).not.toContain("失活事实");
    expect(result.manifest.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "inactive", status: "excluded", reason: "inactive" }),
      expect.objectContaining({ id: "merged", status: "excluded", reason: "merged-source" }),
    ]));
  });

  it("creates stable semantic goal identities without keyword taxonomies", () => {
    const first = createStageGoalContract({
      projectId: "p1", workflowId: "wf1", stage: "revision", targetArtifactId: "a1",
      authorInstruction: "让交流主要通过动作和停顿呈现", reviewIssueFingerprints: ["i2", "i1"],
      acceptanceCriteria: ["正文阅读效果明确响应作者要求"], allowedChangeScope: "chapter",
    },);
    const second = createStageGoalContract({
      projectId: "p1", workflowId: "wf1", stage: "revision", targetArtifactId: "a1",
      authorInstruction: "让交流主要通过动作和停顿呈现", reviewIssueFingerprints: ["i1", "i2"],
      acceptanceCriteria: ["正文阅读效果明确响应作者要求"], allowedChangeScope: "chapter",
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.id).toBe(second.id);
  });

  it("keeps distinct claims from one extraction artifact when claims are separate semantic sources", () => {
    const result = compileStageContext({
      projectId: "p1", workflowId: "wf-claims", purpose: "review.prose", stage: "review",
      maxInputTokens: 1_000, reservedOutputTokens: 100,
      sections: [
        { id: "claim-1", kind: "fact", title: "位置", text: "角色仍在车站", priority: "required", provenanceRefs: ["claim-1", "artifact-facts"], sourceArtifactId: "artifact-facts" },
        { id: "claim-2", kind: "fact", title: "持有物", text: "角色携带旧钥匙", priority: "required", provenanceRefs: ["claim-2", "artifact-facts"], sourceArtifactId: "artifact-facts" },
      ],
    });
    expect(result.instruction).toContain("角色仍在车站");
    expect(result.instruction).toContain("角色携带旧钥匙");
  });

  it("requires every production text or structured model call to carry a context manifest", () => {
    const sourceRoot = join(process.cwd(), "src", "novel-v2");
    const offenders: string[] = [];
    for (const file of productionTypeScriptFiles(sourceRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && (node.expression.name.text === "generateText" || node.expression.name.text === "generateStructured")) {
          const argument = node.arguments[0];
          const hasManifest = argument && ts.isObjectLiteralExpression(argument)
            && argument.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "promptContext");
          if (!hasManifest) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            offenders.push(`${relative(process.cwd(), file)}:${position.line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
