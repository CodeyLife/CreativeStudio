import { randomUUID } from "node:crypto";
import type { ModelGateway } from "../model-gateway";
import type { ManuscriptDocumentSummary, ProjectSnapshotBundle, SkillDescriptor, SkillProvider } from "../protocol";
import type { NovelPostgresRepository } from "../postgres-repository";
import {
  areScenarioProfilesMateriallyDifferent,
  createScenarioProfileFingerprint,
  inspectCraftRuleCandidate,
  recordCraftRuleExperimentEvidence,
  type CraftRuleCandidate,
  type CraftRuleEvidenceCase,
  type CraftRuleScenarioProfile,
} from "../craft-rule";
import { createExperimentWorkspace, type ExperimentWorkspaceHandle } from "./experiment-workspace";
import { captureProjectSnapshot } from "./project-snapshot";
import { executeChapterReviewExperiment, type ExperimentExecutionResult } from "./experiment-execution";
import { mergeCraftRulePromptSections, parseCraftRulePromptPatch } from "../craft-rule/prompt-patch";
import type { ChapterPlanningContext } from "../application/story-arc";
import { canonicalSha256 } from "../canonical-json";
import type { PromptContextManifest } from "../protocol";

export interface CraftRuleExperimentScenarioResult {
  scenarioRole: CraftRuleEvidenceCase["scenarioRole"];
  scenarioClass: string;
  documentId: string;
  experimentId: string;
  baselineWorkflowRunId?: string;
  candidateWorkflowRunId?: string;
  baselineScore?: number;
  candidateScore?: number;
  blockerDelta?: number;
  majorDelta?: number;
  passed: boolean;
  error?: string;
  scenarioProfile: CraftRuleScenarioProfile;
}

export interface CraftRuleExperimentResult {
  candidate: CraftRuleCandidate;
  snapshotId: string;
  passed: boolean;
  scenarios: CraftRuleExperimentScenarioResult[];
}

/**
 * afterText 是历史候选的持久化格式：优先读取 execution-point map，
 * 旧候选的普通文本则作为 drafting section 使用，保持跨版本兼容。
 */
export const parseCandidatePromptSections = parseCraftRulePromptPatch;

export function buildScenarioProfile(document: ManuscriptDocumentSummary, planning?: ChapterPlanningContext): CraftRuleScenarioProfile {
  const chapter = planning?.chapter;
  const scenes = chapter?.scenes ?? [];
  const participantCount = new Set(scenes.flatMap((scene) => scene.participants)).size;
  const sceneCountBucket = scenes.length === 0 ? "none" : scenes.length === 1 ? "single" : "multiple";
  const participantShape = participantCount === 0 ? "none" : participantCount === 1 ? "solo" : participantCount === 2 ? "dyad" : "ensemble";
  const profile = {
    narrativeFunction: chapter?.narrativeFunction ?? null,
    povCharacterId: chapter?.povCharacterId ?? document.povCharacterId ?? null,
    sceneCountBucket,
    participantShape,
    hasUnresolvedClose: Boolean(chapter?.unresolvedAtClose?.length),
  } satisfies Omit<CraftRuleScenarioProfile, "fingerprint">;
  return { ...profile, fingerprint: createScenarioProfileFingerprint(profile) };
}

async function loadScenarioProfile(repository: NovelPostgresRepository, projectId: string, document: ManuscriptDocumentSummary): Promise<CraftRuleScenarioProfile> {
  const planning = await repository.getChapterPlanningContext(projectId, document.id, true).catch(() => undefined);
  return buildScenarioProfile(document, planning);
}

function blockingPatterns(result: ExperimentExecutionResult): Set<string> {
  return new Set(result.reviews.flatMap((review) => review.issues)
    .filter((issue) => issue.severity === "blocker" || issue.severity === "major")
    .map((issue) => issue.rule ?? issue.title));
}

export interface ChapterRegressionSnapshot {
  committed: boolean;
  structuralPassed: boolean;
  structuralBlockerCount: number;
  finalScore: number;
  blockerCount: number;
  majorCount: number;
  blockingPatterns: string[];
}

export function evaluateChapterRegression(baseline: ChapterRegressionSnapshot, candidate: ChapterRegressionSnapshot): {
  passed: boolean;
  blockerDelta: number;
  majorDelta: number;
  error?: string;
} {
  const unresolved = baseline.blockingPatterns.filter((pattern) => candidate.blockingPatterns.includes(pattern));
  const newPatterns = candidate.blockingPatterns.filter((pattern) => !baseline.blockingPatterns.includes(pattern));
  const blockerDelta = candidate.blockerCount - baseline.blockerCount;
  const majorDelta = candidate.majorCount - baseline.majorCount;
  const passed = candidate.committed
    && candidate.structuralPassed
    && candidate.structuralBlockerCount <= baseline.structuralBlockerCount
    && candidate.finalScore >= baseline.finalScore
    && blockerDelta <= 0
    && majorDelta <= 0
    && unresolved.length === 0
    && newPatterns.length === 0;
  return {
    passed,
    blockerDelta,
    majorDelta,
    error: passed ? undefined : `章节回归不满足质量守卫：committed=${candidate.committed}，structuralPassed=${candidate.structuralPassed}，score=${baseline.finalScore}->${candidate.finalScore}，blockerDelta=${blockerDelta}，majorDelta=${majorDelta}，unresolved=${unresolved.join("、") || "无"}，newPatterns=${newPatterns.join("、") || "无"}`,
  };
}

function compareScenario(baseline: ExperimentExecutionResult, candidate: ExperimentExecutionResult) {
  const baselineIssues = baseline.reviews.flatMap((review) => review.issues);
  const candidateIssues = candidate.reviews.flatMap((review) => review.issues);
  const comparison = evaluateChapterRegression({
    committed: baseline.committed,
    structuralPassed: baseline.structuralReport.passed,
    structuralBlockerCount: baseline.structuralReport.blockers.length,
    finalScore: baseline.finalScore,
    blockerCount: baselineIssues.filter((issue) => issue.severity === "blocker").length,
    majorCount: baselineIssues.filter((issue) => issue.severity === "major").length,
    blockingPatterns: [...blockingPatterns(baseline)],
  }, {
    committed: candidate.committed,
    structuralPassed: candidate.structuralReport.passed,
    structuralBlockerCount: candidate.structuralReport.blockers.length,
    finalScore: candidate.finalScore,
    blockerCount: candidateIssues.filter((issue) => issue.severity === "blocker").length,
    majorCount: candidateIssues.filter((issue) => issue.severity === "major").length,
    blockingPatterns: [...blockingPatterns(candidate)],
  });
  return comparison;
}

async function applyCandidateSkill(workspace: ExperimentWorkspaceHandle, snapshot: ProjectSnapshotBundle, candidate: CraftRuleCandidate): Promise<void> {
  if (candidate.targetKind !== "skill") {
    throw new Error("当前章节实验只允许注入 skill target；system-prompt 必须接入其实际消费点后才能回归");
  }
  const target = snapshot.payload.skillDefinitions.find((skill) => skill.skillId === candidate.targetId);
  if (!target) throw new Error(`候选目标 skill 不在实验快照中：${candidate.targetId}`);
  if (target.version !== candidate.beforeVersion) {
    throw new Error(`stale-target-version：快照 skill=${target.version}，候选 before=${candidate.beforeVersion}`);
  }
  const promptSections = mergeCraftRulePromptSections(target.promptSections, parseCandidatePromptSections(candidate.afterText));
  const result = await workspace.query<{ skill_id: string; version: string }>(
    `UPDATE ${workspace.schemaName}.skill_definitions
     SET prompt_sections = $2::jsonb, version = $3, updated_at = now()
     WHERE skill_id = $1 AND version = $4
     RETURNING skill_id, version`,
    [candidate.targetId, JSON.stringify(promptSections), candidate.proposedVersion, candidate.beforeVersion],
  );
  if (!result.rowCount) throw new Error(`实验 skill 注入失败：${candidate.targetId}`);
}

export function wasCandidatePromptPatchConsumed(
  manifests: Array<PromptContextManifest | null>,
  candidate: Pick<CraftRuleCandidate, "targetId" | "proposedVersion" | "afterText">,
): boolean {
  const expectedSectionId = `skill:${candidate.targetId}@${candidate.proposedVersion}`;
  const expectedFingerprints = new Set(
    Object.values(parseCandidatePromptSections(candidate.afterText)).map((text) => canonicalSha256({ text: text.trim() })),
  );
  return manifests.some((manifest) => manifest?.sections.some((section) => (
    section.id === expectedSectionId
    && section.status === "included"
    && expectedFingerprints.has(section.fingerprint)
  )));
}

async function assertCandidateWasConsumed(workspace: ExperimentWorkspaceHandle, workflowRunId: string, candidate: CraftRuleCandidate): Promise<void> {
  const result = await workspace.query<{ context_manifest: PromptContextManifest | null }>(
    `SELECT context_manifest FROM ${workspace.schemaName}.prompt_executions WHERE workflow_run_id = $1`,
    [workflowRunId],
  );
  const consumed = wasCandidatePromptPatchConsumed(result.rows.map((row) => row.context_manifest), candidate);
  if (!consumed) throw new Error(`实验执行未消费候选 skill：${candidate.targetId}@${candidate.proposedVersion}`);
}

export function resolveCraftRuleSourceDocumentId(input: {
  assessmentId?: string;
  sourceChapterId?: string;
  requestedSourceDocumentId?: string;
}): string {
  if (!input.assessmentId) throw new Error("候选缺少 learning assessment 来源，无法锁定原失败章节");
  if (!input.sourceChapterId) throw new Error(`learning assessment ${input.assessmentId} 未关联原失败章节`);
  if (input.requestedSourceDocumentId && input.requestedSourceDocumentId !== input.sourceChapterId) {
    throw new Error(`原失败章节必须来自候选 learning assessment：expected=${input.sourceChapterId}, requested=${input.requestedSourceDocumentId}`);
  }
  return input.sourceChapterId;
}

async function runScenario(input: {
  repository: NovelPostgresRepository;
  model: ModelGateway;
  snapshot: ProjectSnapshotBundle;
  candidate: CraftRuleCandidate;
  projectId: string;
  documentId: string;
  scenarioRole: CraftRuleEvidenceCase["scenarioRole"];
  instruction?: string;
  baselineSkillProvider: SkillProvider;
  candidateSkillProvider: SkillProvider;
  scenarioProfile: CraftRuleScenarioProfile;
}): Promise<CraftRuleExperimentScenarioResult> {
  const scenarioClass = `scenario:${input.scenarioProfile.fingerprint}`;
  const experimentId = `exp-craft-rule-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let baseline: ExperimentExecutionResult | undefined;
  let candidateResult: ExperimentExecutionResult | undefined;
  let failure: string | undefined;
  let baselineWorkflowRunId: string | undefined;
  let candidateWorkflowRunId: string | undefined;

  const baselineWorkspace = await createExperimentWorkspace(input.repository, input.snapshot, `${experimentId}-baseline`);
  try {
    baseline = await executeChapterReviewExperiment({ workspace: baselineWorkspace, model: input.model, projectId: input.projectId, documentId: input.documentId, instruction: input.instruction, skillProvider: input.baselineSkillProvider });
    baselineWorkflowRunId = baseline.workflowRunId;
  } catch (error) {
    failure = `baseline: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await baselineWorkspace.close().catch(() => undefined);
  }

  const candidateWorkspace = await createExperimentWorkspace(input.repository, input.snapshot, `${experimentId}-candidate`);
  try {
    await applyCandidateSkill(candidateWorkspace, input.snapshot, input.candidate);
    candidateResult = await executeChapterReviewExperiment({ workspace: candidateWorkspace, model: input.model, projectId: input.projectId, documentId: input.documentId, instruction: input.instruction, skillProvider: input.candidateSkillProvider });
    candidateWorkflowRunId = candidateResult.workflowRunId;
    await assertCandidateWasConsumed(candidateWorkspace, candidateResult.workflowRunId, input.candidate);
  } catch (error) {
    failure = failure ?? `candidate: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await candidateWorkspace.close().catch(() => undefined);
  }

  const comparison = baseline && candidateResult ? compareScenario(baseline, candidateResult) : { passed: false, blockerDelta: undefined, majorDelta: undefined, error: failure ?? "实验缺少 baseline 或 candidate 结果" };
  const result: CraftRuleExperimentScenarioResult = {
    scenarioRole: input.scenarioRole,
    scenarioClass,
    documentId: input.documentId,
    experimentId,
    baselineWorkflowRunId,
    candidateWorkflowRunId,
    baselineScore: baseline?.finalScore,
    candidateScore: candidateResult?.finalScore,
    blockerDelta: comparison.blockerDelta,
    majorDelta: comparison.majorDelta,
    passed: comparison.passed,
    error: comparison.error,
    scenarioProfile: input.scenarioProfile,
  };
  await recordCraftRuleExperimentEvidence(input.repository, {
    projectId: input.projectId,
    candidateId: input.candidate.id,
    scenarioClass,
    scenarioRole: input.scenarioRole,
    baselineWorkItemId: baselineWorkflowRunId ?? `failed:${experimentId}:baseline`,
    candidateWorkItemId: candidateWorkflowRunId ?? `failed:${experimentId}:candidate`,
    experimentId,
    documentId: input.documentId,
    baselineScore: result.baselineScore,
    candidateScore: result.candidateScore,
    blockerDelta: result.blockerDelta,
    majorDelta: result.majorDelta,
    summary: result.error ?? `章节实验通过：score=${result.baselineScore}->${result.candidateScore}，blockerDelta=${result.blockerDelta}，majorDelta=${result.majorDelta}`,
    regressionPassed: result.passed,
    regressionError: result.error,
    scenarioProfile: input.scenarioProfile,
  });
  return result;
}

/**
 * 对原失败章节和异构章节各执行 baseline/candidate 完整生命周期。
 * 候选只写入隔离 schema；正式库直到 promoteCraftRuleCandidate 才会改变。
 */
export async function runCraftRuleCandidateExperiment(input: {
  repository: NovelPostgresRepository;
  model: ModelGateway;
  projectId: string;
  candidateId: string;
  sourceDocumentId?: string;
  crossScenarioDocumentId: string;
  instruction?: string;
  skillProvider?: SkillProvider;
}): Promise<CraftRuleExperimentResult> {
  const candidate = await inspectCraftRuleCandidate(input.repository, input.projectId, input.candidateId);
  if (!candidate) throw new Error(`CraftRuleCandidate 不存在：${input.candidateId}`);
  if (candidate.status !== "proposed" && candidate.status !== "evidencing") {
    throw new Error(`候选状态必须为 proposed 或 evidencing，当前为 ${candidate.status}`);
  }
  const sourceChapter = candidate.learningSource?.assessmentId
    ? await input.repository.getLearningAssessmentSourceChapter(input.projectId, candidate.learningSource.assessmentId)
    : undefined;
  const sourceDocumentId = resolveCraftRuleSourceDocumentId({
    assessmentId: candidate.learningSource?.assessmentId,
    sourceChapterId: sourceChapter?.id,
    requestedSourceDocumentId: input.sourceDocumentId,
  });
  if (sourceDocumentId === input.crossScenarioDocumentId) throw new Error("原失败场景和异构场景必须是不同章节");
  const snapshot = await captureProjectSnapshot(input.repository, input.projectId);
  const source = snapshot.payload.documents.find((document) => document.id === sourceDocumentId);
  const cross = snapshot.payload.documents.find((document) => document.id === input.crossScenarioDocumentId);
  if (!source || !cross) throw new Error("实验章节必须存在于当前项目快照");
  if (source.status !== "final" || cross.status !== "final") throw new Error("隔离回归只允许对已定稿章节执行");
  if (!source.currentRevisionId || !cross.currentRevisionId) throw new Error("实验章节缺少当前 revision");
  const [sourceProfile, crossProfile] = await Promise.all([
    loadScenarioProfile(input.repository, input.projectId, source),
    loadScenarioProfile(input.repository, input.projectId, cross),
  ]);
  if (!areScenarioProfilesMateriallyDifferent(sourceProfile, crossProfile)) {
    throw new Error(`异构场景不满足材料差异：两章节 ScenarioProfile 相同或差异不足（${sourceProfile.fingerprint} vs ${crossProfile.fingerprint}）`);
  }
  const formalSkillProvider = input.skillProvider ?? { source: "database" as const, list: (projectId: string) => input.repository.listSkills(projectId) };
  const formalSkills = await formalSkillProvider.list(input.projectId);
  const targetSkill = formalSkills.find((skill) => skill.skillId === candidate.targetId);
  if (!targetSkill) throw new Error(`候选目标 skill 不在当前正式 Skill provider 中：${candidate.targetId}`);
  if (targetSkill.version !== candidate.beforeVersion) throw new Error(`stale-target-version：正式 Skill provider=${targetSkill.version}，候选 before=${candidate.beforeVersion}`);
  const experimentSkillProvider: SkillProvider = {
    source: formalSkillProvider.source,
    list: async () => formalSkills.map((skill: SkillDescriptor) => skill.skillId === candidate.targetId
      ? { ...skill, version: candidate.proposedVersion, promptSections: mergeCraftRulePromptSections(skill.promptSections, parseCandidatePromptSections(candidate.afterText)) }
      : skill),
  };

  const scenarios = [
    await runScenario({ ...input, snapshot, candidate, baselineSkillProvider: formalSkillProvider, candidateSkillProvider: experimentSkillProvider, documentId: source.id, scenarioRole: "source-failure", scenarioProfile: sourceProfile }),
    await runScenario({ ...input, snapshot, candidate, baselineSkillProvider: formalSkillProvider, candidateSkillProvider: experimentSkillProvider, documentId: cross.id, scenarioRole: "cross-scenario", scenarioProfile: crossProfile }),
  ];
  const refreshed = await inspectCraftRuleCandidate(input.repository, input.projectId, input.candidateId);
  if (!refreshed) throw new Error(`实验后候选消失：${input.candidateId}`);
  return { candidate: refreshed, snapshotId: snapshot.id, passed: scenarios.every((scenario) => scenario.passed), scenarios };
}

/**
 * promotion transaction 之后的二次验证：只在隔离 schema 读取刚晋升的正式版本，
 * 不再把 before/after 当作实验变量，确保数据库更新确实进入后续章节消费点。
 */
export async function runCraftRuleCandidatePromotionVerification(input: {
  repository: NovelPostgresRepository;
  model: ModelGateway;
  candidate: CraftRuleCandidate;
  skillProvider: SkillProvider;
}): Promise<{ passed: boolean; reasons: string[]; details: Array<{ scenarioClass: string; workflowRunId?: string; score?: number; expectedScore?: number; error?: string }> }> {
  if (input.candidate.targetKind !== "skill") return { passed: false, reasons: ["system-prompt 尚未绑定章节实际消费点"], details: [] };
  if (input.skillProvider.source !== "database") {
    return { passed: false, reasons: ["正式 Skill provider 不是 database，晋升后的数据库版本不会被 drafting/revision 读取"], details: [] };
  }
  const latest = new Map<string, CraftRuleEvidenceCase>();
  for (const evidence of input.candidate.evidenceCases.filter((item) => item.evidenceKind === "chapter")) {
    latest.set(`${evidence.scenarioRole}:${evidence.scenarioClass}`, evidence);
  }
  const chapterCases = [...latest.values()];
  if (!chapterCases.length) return { passed: true, reasons: [], details: [] };

  const snapshot = await captureProjectSnapshot(input.repository, input.candidate.projectId);
  const target = snapshot.payload.skillDefinitions.find((skill) => skill.skillId === input.candidate.targetId);
  if (!target || target.version !== input.candidate.proposedVersion) {
    return { passed: false, reasons: [`晋升后快照未包含目标版本：expected=${input.candidate.proposedVersion}, actual=${target?.version ?? "missing"}`], details: [] };
  }

  const reasons: string[] = [];
  const details: Array<{ scenarioClass: string; workflowRunId?: string; score?: number; expectedScore?: number; error?: string }> = [];
  for (const evidence of chapterCases) {
    const experimentId = `exp-craft-rule-post-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const workspace = await createExperimentWorkspace(input.repository, snapshot, experimentId);
    try {
      const result = await executeChapterReviewExperiment({
        workspace,
        model: input.model,
        projectId: input.candidate.projectId,
        documentId: evidence.documentId ?? "",
      });
      await assertCandidateWasConsumed(workspace, result.workflowRunId, input.candidate);
      const expectedScore = evidence.candidateScore;
      const passed = result.committed && result.structuralReport.passed && (expectedScore === undefined || result.finalScore >= expectedScore);
      details.push({ scenarioClass: evidence.scenarioClass, workflowRunId: result.workflowRunId, score: result.finalScore, expectedScore });
      if (!passed) reasons.push(`scenarioClass=${evidence.scenarioClass} 晋升后验证失败：committed=${result.committed}，structuralPassed=${result.structuralReport.passed}，score=${expectedScore ?? "n/a"}->${result.finalScore}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      details.push({ scenarioClass: evidence.scenarioClass, error: message, expectedScore: evidence.candidateScore });
      reasons.push(`scenarioClass=${evidence.scenarioClass} 晋升后验证异常：${message}`);
    } finally {
      await workspace.close().catch(() => undefined);
    }
  }
  return { passed: reasons.length === 0, reasons, details };
}
