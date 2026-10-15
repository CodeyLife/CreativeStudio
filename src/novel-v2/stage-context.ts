import { estimateBudgetTokens, estimateTokens } from "./token-estimate";
import { canonicalSha256 } from "./canonical-json";
import type {
  PromptContextManifest,
  PromptContextSectionReceipt,
  StageContextPriority,
  StageContextRequest,
  StageContextSection,
  StageGoalContract,
  StagePromptPackage,
} from "./protocol";

const PRIORITY_RANK: Record<StageContextPriority, number> = {
  critical: 4,
  required: 3,
  normal: 2,
  soft: 1,
};

export class StageContextBudgetError extends Error {
  constructor(readonly manifest: PromptContextManifest, readonly requiredTokens: number) {
    super(`context-budget-exceeded: 必要上下文需要 ${requiredTokens} tokens，可用输入预算为 ${manifest.usableInputTokens} tokens（总上限 ${manifest.maxInputTokens}，输出预留 ${manifest.reservedOutputTokens}）`);
    this.name = "StageContextBudgetError";
  }
}

/** 阶段装配走预算口径（与 maxInputTokens/reservedOutputTokens 常数共同标定）；保留本名是因为调用点语义贴近阶段装配。 */
export const estimateStageTokens = estimateBudgetTokens;

export function createStageGoalContract(input: Omit<StageGoalContract, "id" | "fingerprint" | "createdAt"> & { id?: string; createdAt?: number }): StageGoalContract {
  const createdAt = input.createdAt ?? Date.now();
  const stable = {
    projectId: input.projectId,
    workflowId: input.workflowId,
    stage: input.stage,
    targetArtifactId: input.targetArtifactId,
    authorInstruction: input.authorInstruction?.trim() || undefined,
    reviewIssueFingerprints: [...new Set(input.reviewIssueFingerprints)].sort(),
    acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean),
    allowedChangeScope: input.allowedChangeScope,
  };
  const fingerprint = canonicalSha256(stable);
  return { id: input.id ?? `stage-goal:${input.workflowId}:${fingerprint.slice(0, 16)}`, ...stable, fingerprint, createdAt };
}

function normalizeSection(section: StageContextSection): StageContextSection & { fingerprint: string } {
  const text = section.text.trim();
  return {
    ...section,
    text,
    provenanceRefs: [...new Set(section.provenanceRefs)].sort(),
    fingerprint: section.fingerprint ?? canonicalSha256({ text }),
  };
}

function receipt(section: StageContextSection & { fingerprint: string }, status: PromptContextSectionReceipt["status"], reason: PromptContextSectionReceipt["reason"]): PromptContextSectionReceipt {
  return {
    id: section.id,
    kind: section.kind,
    title: section.title,
    priority: section.priority,
    provenanceRefs: section.provenanceRefs,
    sourceArtifactId: section.sourceArtifactId,
    fingerprint: section.fingerprint,
    estimatedTokens: estimateStageTokens(section.text),
    status,
    reason,
  };
}

function renderSection(section: StageContextSection): string {
  return `## ${section.title}\n${section.text}`;
}

function materializeInjectedSkills(
  skillManifest: StageContextRequest["skillManifest"],
  receipts: PromptContextSectionReceipt[],
): StageContextRequest["skillManifest"] {
  if (!skillManifest) return undefined;
  const injectedSections = receipts.filter((item) => item.kind === "skill" && item.status === "included");
  if (!injectedSections.length) return { ...skillManifest, injectedSkills: [] };

  const refs = new Set(injectedSections.flatMap((item) => item.provenanceRefs));
  const injectedSkills = skillManifest.skills.filter((skill) => refs.has(`${skill.skillId}@${skill.version}`));
  // Some callers intentionally aggregate all Skill text into one required section
  // and use the bundle fingerprint as its provenance. In that case the included
  // section still represents the complete resolved bundle.
  return {
    ...skillManifest,
    injectedSkills: injectedSkills.length ? injectedSkills : skillManifest.skills,
  };
}

export function compileStageContext(request: StageContextRequest, now = Date.now()): StagePromptPackage {
  const systemTokens = estimateStageTokens(request.system ?? "");
  const schemaTokens = request.schema ? estimateStageTokens(JSON.stringify(request.schema)) : 0;
  // 同一段文本的第二口径（AUDIT），逐部分同形重算、只换折算系数：两数的比值才是干净的
  // 口径因子。跨文本比较（本 manifest vs 网关留痕）已被 426 行运行库实测证伪。
  const auditSystemTokens = estimateTokens(request.system ?? "");
  const auditSchemaTokens = request.schema ? estimateTokens(JSON.stringify(request.schema)) : 0;
  const usableTokens = Math.max(0, request.maxInputTokens - request.reservedOutputTokens - systemTokens - schemaTokens);
  const normalized = request.sections.map(normalizeSection);
  const receipts: PromptContextSectionReceipt[] = [];
  const candidates: Array<StageContextSection & { fingerprint: string }> = [];
  const contentSeen = new Set<string>();

  for (const section of normalized.sort((left, right) => PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority])) {
    if (section.exclusionReason) {
      receipts.push(receipt(section, "excluded", section.exclusionReason));
      continue;
    }
    if (!section.text) {
      receipts.push(receipt(section, "excluded", "empty"));
      continue;
    }
    if (contentSeen.has(section.fingerprint)) {
      receipts.push(receipt(section, "excluded", "duplicate-content"));
      continue;
    }
    contentSeen.add(section.fingerprint);
    candidates.push(section);
  }

  const included: Array<StageContextSection & { fingerprint: string }> = [];
  let spent = 0;
  for (const section of candidates) {
    const tokenCost = estimateStageTokens(renderSection(section));
    const required = section.priority === "critical" || section.priority === "required";
    if (spent + tokenCost <= usableTokens) {
      included.push(section);
      spent += tokenCost;
      receipts.push(receipt(section, "included", required ? "required" : "ranked-fill"));
      continue;
    }
    receipts.push(receipt(section, "excluded", "budget"));
  }

  const instruction = included.map(renderSection).join("\n\n");
  const requiredInputTokens = systemTokens + schemaTokens + candidates
    .filter((item) => item.priority === "critical" || item.priority === "required")
    .reduce((sum, item) => sum + estimateStageTokens(renderSection(item)), 0);
  const skillManifest = materializeInjectedSkills(request.skillManifest, receipts);
  const manifestBase = {
    projectId: request.projectId,
    workflowId: request.workflowId,
    purpose: request.purpose,
    stage: request.stage,
    goalId: request.goal?.id,
    maxInputTokens: request.maxInputTokens,
    reservedOutputTokens: request.reservedOutputTokens,
    estimatedSystemTokens: systemTokens,
    estimatedSchemaTokens: schemaTokens,
    usableInputTokens: usableTokens,
    requiredInputTokens,
    budgetExcludedSectionCount: receipts.filter((item) => item.reason === "budget").length,
    estimatedInputTokens: systemTokens + schemaTokens + estimateStageTokens(instruction),
    skillManifest,
    sections: receipts,
  };
  const fingerprint = canonicalSha256(manifestBase);
  // 审计口径的估算值刻意不进 manifestBase（即不参与 fingerprint）：它是同一段装配文本的
  // 派生观测，不是改变送检内容的输入事实。更要紧的是 activities.ts 的 inputFingerprint 会把
  // promptContext.fingerprint 与 contextRefs.contextManifestId 一起哈希进外部任务的幂等键——
  // 让一个纯观测字段参与指纹，等于在部署时给在途运行换任务 id（重复物化或交付时判"指纹不匹配"）。
  const manifest: PromptContextManifest = { id: `prompt-context:${request.workflowId}:${fingerprint.slice(0, 16)}`, ...manifestBase, estimatedInputTokensAuditBasis: auditSystemTokens + auditSchemaTokens + estimateTokens(instruction), fingerprint, createdAt: now };
  const missingRequired = receipts.filter((item) => item.reason === "budget" && (item.priority === "critical" || item.priority === "required"));
  if (missingRequired.length) {
    throw new StageContextBudgetError(manifest, requiredInputTokens);
  }
  // 非必要段被预算挤掉：**必须在此处报出来**（2026-10-14 复核轮 round 18）。
  // 此前这条事实只落在 manifest 的 `budgetExcludedSectionCount` 里，而全仓**没有任何生产
  // 读取方**（只有类型声明与测试断言）⇒ 上下文静默变薄、无人知。危害不是"少了一段背景"：
  // 审核面多处按"以上下文『X』段为准（**无该段时跳过**）"引用 normal 优先级的段
  // （跨章序列信号、开放线索、机制反馈等），被挤掉后那些检查会**静默失效**——
  // 看起来"检查通过"，实际是"没检查"。
  //
  // 刻意**不**把它加成 manifest 字段：`manifestBase` 参与 fingerprint，而 fingerprint 会与
  // contextRefs 一起哈希进外部任务的幂等键（见上方 estimatedInputTokensAuditBasis 的注释），
  // 给纯观测值加字段等于给在途运行换任务 id。故走日志这一侧，零指纹影响。
  const budgetExcluded = receipts.filter((item) => item.reason === "budget");
  if (budgetExcluded.length) {
    console.warn(`[context] ${request.stage}/${request.purpose} 有 ${budgetExcluded.length} 段被预算挤掉（不会出现在 prompt 里）：${budgetExcluded.map((item) => `${item.id}(${item.priority})`).join("、")}；可用 ${usableTokens} tokens，已装 ${spent}。被挤掉的段若被审核面按"无该段时跳过"引用，对应检查会静默失效。`);
  }
  return { system: request.system, instruction, schema: request.schema, goal: request.goal, sections: included, manifest };
}
