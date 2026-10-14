/* ============================================================
 * novel-v2 数据层 — 统一的 typed fetch + React Query hooks
 *
 * 现状：此前各面板（NovelV2Studio / CreativeRunPanel / EvaluationPanel）
 * 各自重复 readJson + useState + 轮询。这里收敛为共享数据层，
 * 由 main.tsx 挂载的 QueryClientProvider 提供缓存/去重/轮询。
 * ============================================================ */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isOpenWorkflowRunStatus, isTerminalWorkflowRunStatus } from "../novel-v2/run-lifecycle";

// ---------- API 类型（对齐 scripts/novel-v2-api.ts 返回体） ----------
export interface NovelDocumentSummary {
  id: string;
  title: string;
  narrativeOrder: number;
  status: string;
  povCharacterId?: string;
  wordCount?: number;
  latestRevision?: number;
  chapterGoal?: string;
  blockingIssueCount?: number;
  arcId?: string;
  arcTitle?: string;
  arcPlanningStatus?: string;
  reviewScore?: number;
  reviewVerdict?: "passed" | "revise" | "blocked";
  /** 作者对当前内容最近一次审校聚合结果的最终决定（approve=作者已覆盖批准，与 reviewer verdict 并存不冲突） */
  authorDecision?: "approve" | "revise" | "reject" | "abandon";
  reviewStale?: boolean;
}

export interface NovelProjectSummary {
  id: string;
  title: string;
  currentRevision?: number;
  current_revision?: number;
  updatedAt?: string;
  updated_at?: string;
  latestRunStatus?: string;
}

export interface NovelWorkflowRunRecord {
  id: string;
  workflowType: string;
  projectId: string;
  temporalWorkflowId: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NovelProjectDetail {
  id: string;
  title: string;
  currentRevision: number;
  updatedAt: string;
  documents: NovelDocumentSummary[];
  latestRuns?: NovelWorkflowRunRecord[];
}

export interface CreativeBriefSeed {
  version?: 1;
  targetReader?: string;
  corePromise?: string;
  themeQuestion?: string | { notApplicable: true; rationale: string };
  protagonistNeed?: string;
  protagonistContradiction?: string;
  centralOpposition?: string;
  emotionalContract?: string | { notApplicable: true; rationale: string };
  worldAnchor?: string;
  researchNeeds?: string[];
  nonNegotiables?: string[];
  endingEnvelope?: string;
  stylePreferences?: string;
}

export interface NovelRunState {
  workflowId: string;
  status: string;
  runId?: string;
  record?: NovelWorkflowRunRecord;
}

export interface NovelRunEvent {
  id?: number;
  event_type?: string;
  eventType?: string;
  payload?: unknown;
  created_at?: string;
  createdAt?: string;
}

export interface NovelArtifactSummary {
  id: string;
  projectId: string;
  taskId: string;
  attemptId?: string;
  kind: string;
  contentHash?: string;
  objectKey?: string;
  structuredData?: Record<string, unknown>;
  baseRevision?: number;
  createdAt?: string | number;
  fingerprint?: string;
}

export interface NovelReviewSummary {
  id: string;
  artifactId: string;
  reviewerId: string;
  identity: "internal" | "independent" | "human";
  verdict: "passed" | "revise" | "blocked";
  issues: Array<{
    severity: "blocker" | "major" | "warning";
    title?: string;
    description?: string;
    excerpt?: string;
    dimension?: string;
    rule?: string;
    suggestion?: string;
  }>;
  score?: number;
  role?: string;
  dimensionScores?: Record<string, number>;
  createdAt: number;
}

export interface NovelPromptContextSectionReceipt {
  id: string;
  kind: string;
  title: string;
  priority: "critical" | "required" | "normal" | "soft";
  estimatedTokens: number;
  status: "included" | "excluded" | "truncated";
  reason: string;
}

export interface NovelPromptExecution {
  id: string;
  workflowId: string;
  taskId: string;
  purpose: string;
  candidateIndex: number;
  status: "completed" | "failed";
  promptFingerprint: string;
  responseFingerprint?: string;
  errorCategory?: string;
  expiresAt: string;
  createdAt: string;
  snapshotAvailable: boolean;
  contextManifest?: {
    goalId?: string;
    estimatedInputTokens?: number;
    maxInputTokens?: number;
    sections?: NovelPromptContextSectionReceipt[];
  };
}

export interface NovelModelInvocation {
  id: number;
  workflowRunId: string;
  taskId: string;
  purpose: string;
  candidateIndex: number;
  executor: "api" | "external-mcp";
  profileId?: string;
  provider?: string;
  protocol?: string;
  model: string;
  status: "completed" | "failed" | "waiting-external";
  configRevision: string;
  isCurrentConfig?: boolean;
  latencyMs?: number;
  errorCategory?: string;
  errorMessage?: string;
  createdAt: string;
}

export function novelRunDocumentId(run: NovelWorkflowRunRecord | undefined): string | undefined {
  if (!run) return undefined;
  if (typeof run.payload.documentId === "string") return run.payload.documentId;
  const intent = run.payload.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const target = (intent as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined;
  const record = target as Record<string, unknown>;
  return record.kind === "chapter" && typeof record.id === "string" ? record.id : undefined;
}

export function isChapterWorkflowRun(run: NovelWorkflowRunRecord): boolean {
  if (run.workflowType === "chapter-title") return false;
  return run.workflowType === "chapter-review" || Boolean(novelRunDocumentId(run));
}

export interface NovelDocumentContent {
  documentId: string;
  title: string;
  status: string;
  revision: number;
  contentHash: string;
  plainText: string;
}

export interface NovelChapterReviewIssue {
  id: string;
  fingerprint: string;
  dimension?: string;
  severity: "blocker" | "major" | "warning";
  title: string;
  description?: string;
  evidenceQuote: string;
  paragraph?: number;
  revisionRanges: Array<{ start: number; end: number }>;
  rule?: string;
  suggestion?: string;
  sourceRoles: string[];
  status: "pending" | "ignored" | "resolved";
  updatedAt: string;
}

export interface NovelModelInvocationError {
  id: number;
  workflowRunId?: string;
  taskId?: string;
  purpose: string;
  candidateIndex: number;
  executor: string;
  profileId?: string;
  configRevision: string;
  isCurrentConfig?: boolean;
  provider: string;
  protocol?: string;
  model: string;
  errorCategory?: string;
  errorMessage?: string;
  createdAt: string;
  projectId?: string;
  workflowType?: string;
  documentId?: string;
}

export interface NovelChapterWorkspace {
  document: NovelDocumentSummary;
  content?: { revisionId: string; revision: number; contentHash: string; byteLength: number; plainText?: string };
  spec: { chapterGoal: string; blueprint: Record<string, unknown>; blueprintFingerprint: string; updatedAt?: string };
  review?: {
    id: string;
    revisionId?: string;
    reviewedContentHash: string;
    artifactFingerprint: string;
    sourceWorkflowId?: string;
    verdict: "passed" | "revise" | "blocked";
    complete: boolean;
    overallScore?: number;
    dimensionScores?: Record<string, number>;
    reviewerRoles: string[];
    reviewedAt: string;
    stale: boolean;
    issues: NovelChapterReviewIssue[];
  };
  versions: Array<{ id: string; revision: number; contentHash: string; retentionClass: "workflow" | "rolling" | "named"; label?: string; expiresAt?: string; createdAt: string; current: boolean }>;
}

export interface NovelFactCandidate {
  id: string;
  title: string;
  content: string;
  confidence: number;
  subjectRefs: string[];
  authority: string;
}

export interface NovelChapterScriptCharacterView {
  name: string;
  appearanceEn: string;
}

export interface NovelPlotBeatView {
  id: string;
  kind: "event" | "dialogue" | "memory" | "setup" | "hook" | "decision";
  summary: string;
}

/** 项目级共享 subject_definitions 预设（用户手动编辑，生成前预设；空文本=无共享） */
export interface NovelChapterScriptSharedSubjectsView {
  definitionText: string;
  maxLabel: number;
}

export interface NovelChapterScriptSegmentView {
  index: number;
  title: string;
  synopsis: string;
  durationSeconds: number;
  promptText: string;
}

/** GET /v2/projects/:id/documents/:docId/script-h3 响应；exists=false 表示本章尚未生成 */
export interface NovelChapterScriptView {
  exists: boolean;
  artifactId?: string;
  createdAt?: number;
  sourceFingerprint?: string | null;
  mode?: string;
  minSegments?: number;
  plotBeats?: NovelPlotBeatView[];
  /** 影视镜头语言提示（提示级，不阻断）：缺少运镜/景别描述的镜头清单 */
  cinematicHints?: string[];
  /** 本次产物使用的共享定义快照（片段 subjectDefinitions 只含新增主体） */
  sharedSubjects?: NovelChapterScriptSharedSubjectsView;
  characters?: NovelChapterScriptCharacterView[];
  segments?: NovelChapterScriptSegmentView[];
}

/** 剧情选入素材的快照（对应后端 materialRefs）：受选素材的 <Subject N> 参考帧。 */
export interface NovelShortScriptMaterialRefView {
  materialId: string;
  description: string;
  subjectTag: string;
}

/**
 * 创意短剧的**前端视图模型**（契约 v2：scriptId 主键，projectId 缺省=独立短剧）。
 * 09-17 浏览器化后服务端只提供一个 stateless `POST /v2/short-script-h3`（202 返回
 * `{ record }`，不落库）；本类型由 ScriptStudioPanel 从 IndexedDB 记录经
 * scriptRecordToView() 合成，`exists` 是前端"已有选中产物"的标志，不由服务端回填。
 */
export interface NovelShortScriptView {
  exists: boolean;
  scriptId?: string;
  /** 关联作品（衍生短剧）；缺省=独立短剧，不依赖任何小说项目 */
  projectId?: string;
  /** 归属短剧创作台（创作台内多剧情容器）；缺省=独立剧情 */
  workspaceId?: string;
  /** 该剧情选入的公用素材快照 */
  materialRefs?: NovelShortScriptMaterialRefView[];
  createdAt?: number;
  sourceFingerprint?: string | null;
  mode?: string;
  /** 本次产物的创意来源（历史列表语义展示依据） */
  idea?: string;
  instruction?: string;
  /** 时长模式：fixed=固定目标时长；auto=不限时长（targetDurationSeconds 记产物实际总时长） */
  durationMode?: "fixed" | "auto";
  targetDurationSeconds?: number;
  plotBeats?: NovelPlotBeatView[];
  cinematicHints?: string[];
  characters?: NovelChapterScriptCharacterView[];
  segments?: NovelChapterScriptSegmentView[];
}

export function fetchNovelChapterScriptSubjectPreset(projectId: string): Promise<{ definitionText: string }> {
  return novelFetch(`/v2/projects/${enc(projectId)}/script-h3/subject-preset`);
}

export function saveNovelChapterScriptSubjectPreset(projectId: string, definitionText: string): Promise<{ definitionText: string }> {
  return novelFetch(`/v2/projects/${enc(projectId)}/script-h3/subject-preset`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionText }),
  });
}

export interface NovelLearningAssessmentView {
  assessment: {
    id: string;
    projectId: string;
    source: { workflowId: string; artifactId?: string; reviewIds: string[]; fingerprint: string };
    conclusion: "no-shared-learning" | "propose-improvement";
    symptom?: string;
    failingLayer?: string;
    underlyingMechanism?: string;
    affectedInputClass?: string;
    boundaries?: string;
    regressionRisks?: string[];
    candidate?: { targetKind: "skill" | "system-prompt"; targetId: string; rationale: string; afterText: string; applicableGenres?: string[] };
    createdAt: number;
  };
  sourceChapter?: { id: string; title: string; narrativeOrder: number; status: string };
  candidate?: { id: string; status: string; targetKind: string; targetId: string; proposedVersion: string };
}

export interface NovelCraftRuleCandidate {
  id: string;
  projectId: string;
  targetKind: "skill" | "system-prompt";
  targetId: string;
  beforeVersion: string;
  proposedVersion: string;
  beforeText: string;
  afterText: string;
  rationale: string;
  scope: {
    observedSymptom: string;
    failingLayer: string;
    underlyingMechanism: string;
    affectedInputClass: string;
    intendedBenefits: string[];
    boundaries: string[];
    nonGoals: string[];
    regressionRisks: string[];
  };
  status: "proposed" | "evidencing" | "reviewing" | "promoted" | "rolled-back" | "rejected";
  evidenceCases: Array<{
    scenarioClass: string;
    scenarioRole: "source-failure" | "cross-scenario";
    baselineWorkItemId: string;
    candidateWorkItemId: string;
    capturedAt: number;
    evidenceKind?: "foundation" | "chapter";
    experimentId?: string;
    documentId?: string;
    baselineScore?: number;
    candidateScore?: number;
    blockerDelta?: number;
    majorDelta?: number;
    summary?: string;
    regressionPassed?: boolean;
    regressionError?: string;
  }>;
  reviews: Array<{ role: string; reviewerId: string; verdict: "passed" | "revise" | "rejected"; summary: string; concerns: string[]; submittedAt: number }>;
  learningSource?: { assessmentId: string; conclusion: string; mechanism: string };
  applicableGenres?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NovelCraftRuleExperimentResponse {
  result: {
    candidate: NovelCraftRuleCandidate;
    snapshotId: string;
    passed: boolean;
    scenarios: Array<{ scenarioRole: "source-failure" | "cross-scenario"; scenarioClass: string; passed: boolean; error?: string }>;
  };
}

// ---------- fetch 帮助 ----------
export interface NovelRuntimeIdentity {
  profile: string;
  runtimeId: string;
  fingerprint: string;
  taskQueue?: string;
  temporalNamespace?: string;
  qdrantCollection?: string;
  embeddingDimension?: number;
  objectBackend?: string;
}

let runtimeIdentity: NovelRuntimeIdentity | undefined;

export function getNovelRuntimeIdentity(): NovelRuntimeIdentity | undefined {
  return runtimeIdentity;
}

/**
 * 裸 transport —— **本模块私有，刻意不导出**。
 *
 * 它曾经是导出面的一部分，于是 7 个文件、41 处调用自选了这一级：缓存、去重、失效
 * 全部作废，失效被重新发明成 prop 回调（见 `.scratch/w1-novel-api-seam/spec.md`）。
 *
 * 现在消费侧只有两个入口：`useNovelQuery` / `useNovelCommand`（+ 唯一的具名逃逸口
 * `executeNovelTool`）。把这一层收回私有，是让"收编"不会被下一处内联 fetch 重新打穿的
 * 机械保证——`novel-api-seam.test.ts` 会断言它不在导出面上。
 */
async function novelFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const fingerprint = response.headers.get("x-novel-runtime-fingerprint");
  const profile = response.headers.get("x-novel-runtime-profile");
  const runtimeId = response.headers.get("x-novel-runtime-id");
  if (fingerprint && profile && runtimeId) {
    if (runtimeIdentity && runtimeIdentity.fingerprint !== fingerprint) throw new Error(`运行时身份发生变化：${runtimeIdentity.fingerprint.slice(0, 12)} -> ${fingerprint.slice(0, 12)}，请刷新页面重新加载数据`);
    runtimeIdentity = { profile, runtimeId, fingerprint };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `请求失败：${response.status}`);
  return body as T;
}

const enc = encodeURIComponent;

// ---------- Query Keys ----------
export const novelKeys = {
  projects: ["novel", "projects"] as const,
  project: (id: string) => ["novel", "project", id] as const,
  runs: (id: string) => ["novel", "project", id, "runs"] as const,
  modelInvocationErrors: (id: string) => ["novel", "project", id, "model-invocation-errors"] as const,
  run: (wfId: string) => ["novel", "run", wfId] as const,
  runEvents: (wfId: string) => ["novel", "run", wfId, "events"] as const,
  runArtifacts: (wfId: string) => ["novel", "run", wfId, "artifacts"] as const,
  runReviews: (wfId: string) => ["novel", "run", wfId, "reviews"] as const,
  runPromptExecutions: (wfId: string) => ["novel", "run", wfId, "prompt-executions"] as const,
  runModelInvocations: (wfId: string) => ["novel", "run", wfId, "model-invocations"] as const,
  docContent: (id: string, docId: string) => ["novel", "doc", id, docId, "content"] as const,
  chapterWorkspace: (id: string, docId: string) => ["novel", "doc", id, docId, "workspace"] as const,
  factCandidates: (id: string, docId: string) => ["novel", "facts", id, docId] as const,
  learningCenter: (id: string) => ["novel", "learning-center", id] as const,
  styleContracts: (id: string) => ["novel", "project", id, "style-contracts"] as const,
  activeStyleContract: (id: string) => ["novel", "project", id, "style-contracts", "active"] as const,
  /**
   * 以下九类资源此前**一个 key 都没有**——面板只能绕开缓存层自己发请求，于是缓存、去重、
   * 失效全部作废（见 `.scratch/w1-novel-api-seam/spec.md`）。
   *
   * 项目级资源一律挂在 `["novel","project",<id>]` 之下：react-query 按前缀失效，
   * 因此 `novelScopes.project(id)` 一次即覆盖整族，不必逐 key 枚举。
   */
  projectPlan: (id: string) => ["novel", "project", id, "plan"] as const,
  storyArcs: (id: string) => ["novel", "project", id, "story-arcs"] as const,
  knowledge: (id: string, kind: string) => ["novel", "project", id, "knowledge", kind] as const,
  creativeRuns: (id: string) => ["novel", "project", id, "creative-runs"] as const,
  snapshots: (id: string) => ["novel", "project", id, "snapshots"] as const,
  experiments: (id: string) => ["novel", "project", id, "experiments"] as const,
  candidates: (id: string) => ["novel", "project", id, "candidates"] as const,
  receipts: (id: string) => ["novel", "project", id, "receipts"] as const,
  scriptSubjectPreset: (id: string) => ["novel", "project", id, "script-h3-subject-preset"] as const,
  // 非项目级：按自身 id 归属，失效面各自独立。
  chapterScript: (id: string, docId: string) => ["novel", "doc", id, docId, "script-h3"] as const,
  snapshot: (snapshotId: string) => ["novel", "snapshot", snapshotId] as const,
  creativeRun: (runId: string) => ["novel", "creative-run", runId] as const,
  creativeRunEvents: (runId: string) => ["novel", "creative-run", runId, "events"] as const,
};

/**
 * 失效面的单一真源。
 *
 * 命令注册表只声明"这次写让哪些**面**过期"，具体 key 由这里展开——调用点永远不写 key，
 * 否则缓存图就重新散回 7 个面板里（那正是本片要收掉的东西）。
 */
export const novelScopes = {
  project: (projectId: string) => ["novel", "project", projectId] as const,
  document: (projectId: string, documentId: string) => ["novel", "doc", projectId, documentId] as const,
  run: (workflowId: string) => ["novel", "run", workflowId] as const,
  artifact: () => ["novel", "artifact"] as const,
  creativeRun: (runId: string) => ["novel", "creative-run", runId] as const,
};

/**
 * 运行中任务的轮询间隔——单一常量。
 *
 * 此前 10 处 `refetchInterval` 各自硬编码 3000（`novelApi.ts` 内 8 处 + 30_000/10_000 各一处），
 * 另有 `api.ts` 的 1500 与 `PsdTaskPanel.tsx` 的 4000 各自为政。间隔是运维决策，不该散落。
 */
export const ACTIVE_RUN_POLL_MS = 3000;

export function invalidateNovelProject(queryClient: ReturnType<typeof useQueryClient>, projectId: string | undefined, documentId?: string, workflowId?: string): void {
  if (!projectId) return;
  void queryClient.invalidateQueries({ queryKey: novelKeys.projects });
  void queryClient.invalidateQueries({ queryKey: novelKeys.project(projectId) });
  void queryClient.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
  void queryClient.invalidateQueries({ queryKey: novelKeys.learningCenter(projectId) });
  void queryClient.invalidateQueries({ queryKey: novelKeys.modelInvocationErrors(projectId) });
  void queryClient.invalidateQueries({ queryKey: ["novel", "artifact"] });
  if (documentId) {
    void queryClient.invalidateQueries({ queryKey: novelKeys.docContent(projectId, documentId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.chapterWorkspace(projectId, documentId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.factCandidates(projectId, documentId) });
  }
  if (workflowId) {
    void queryClient.invalidateQueries({ queryKey: novelKeys.run(workflowId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.runEvents(workflowId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.runArtifacts(workflowId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.runReviews(workflowId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.runPromptExecutions(workflowId) });
    void queryClient.invalidateQueries({ queryKey: novelKeys.runModelInvocations(workflowId) });
  }
}

// ---------- 两个通用原语（消费侧唯一入口） ----------
/**
 * 读原语。
 *
 * 调用点给 `queryKey`（缓存身份）与 `path`（端点）；轮询策略用 `pollWhile` 声明，
 * **调用点不写间隔数字**——间隔是 `ACTIVE_RUN_POLL_MS`。
 *
 * 端点字符串只允许出现在本模块：`src/pages/**` 里出现 `/v2/` 字面量即由守卫判红
 * （见 `novel-api-seam.test.ts`），否则"数据访问收归一层"会被下一处内联路径重新打穿。
 */
export function useNovelQuery<T>(
  queryKey: readonly unknown[],
  path: string,
  options?: { enabled?: boolean; pollWhile?: (data: T | undefined) => boolean },
) {
  const enabled = options?.enabled ?? true;
  const pollWhile = options?.pollWhile;
  return useQuery<T>({
    queryKey,
    queryFn: () => novelFetch<T>(path),
    enabled,
    refetchInterval: pollWhile
      ? (query) => (pollWhile(query.state.data as T | undefined) ? ACTIVE_RUN_POLL_MS : false)
      : false,
  });
}

/**
 * 一条写操作的完整声明：路径、方法、请求体、失效面。
 *
 * `path` / `body` / `invalidates` 刻意用**方法语法**而非函数属性语法：方法声明在
 * `strictFunctionTypes` 下是**双变**的，于是 `path` 只需声明它真正用到的字段
 * （`{ projectId }`）、`body` 只需声明它真正要发出去的字段（`{ instruction }`），
 * 两者不必写成同一个宽类型。同时它把"路径字段不得泄进请求体"这件事留给 body 自己表达。
 */
export interface NovelCommand<TInput> {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path(input: TInput): string;
  body?(input: TInput): unknown;
  /**
   * 额外请求头（`content-type` 由 `body` 的存在与否自动决定，不必在此重复声明）。
   *
   * 存在的理由是可验证的：`storyArcDelete` 在 `force` 时必须带 `x-force-delete: true`，
   * 缺了它强制删除会静默退化成普通删除。契约缺这个字段时，这种差异只能靠"少传一个
   * header"发生，而且编译期与测试都看不见——本片首跑就踩了这一条。
   */
  headers?(input: TInput): Record<string, string>;
  /**
   * 失效面。缺省＝`novelScopes.project(input.projectId)`（有 projectId 时失效整族）。
   * 需要更细或额外面时在此覆写——**失效策略住在注册表，不回调用点**。
   */
  invalidates?(input: TInput): readonly (readonly unknown[])[];
}

/**
 * 写原语。
 *
 * 命令（路径/方法/体/失效面）全部来自注册表；调用点只给业务入参，不碰 key、不碰 URL。
 * 成功后按命令声明的面失效，失败不失效（避免把失败当成功刷缓存）。
 *
 * 返回体类型由调用点按需标注（多数写操作只关心"写完并失效"，用缺省 `unknown` 即可）。
 */
export function useNovelCommand<TInput extends { projectId?: string }, TResult = unknown>(
  command: NovelCommand<TInput>,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TInput>({
    mutationFn: (input) => {
      const extra = command.headers ? command.headers(input) : {};
      const headers = { ...(command.body ? { "content-type": "application/json" } : {}), ...extra };
      return novelFetch<TResult>(command.path(input), {
        method: command.method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: command.body ? JSON.stringify(command.body(input)) : undefined,
      });
    },
    onSuccess: (_result, input) => {
      const targets = command.invalidates
        ? command.invalidates(input)
        : (input.projectId ? [novelScopes.project(input.projectId)] : []);
      for (const target of targets) void queryClient.invalidateQueries({ queryKey: target });
    },
  });
}

// ---------- 路径注册表 ----------
/**
 * 端点路径的单一真源。
 *
 * 为什么连"读"的路径也要收进来：本片的完成判据之一是 **`src/pages/**` 零 `/v2/` 字面量**。
 * 若只收命令（写）而不收读路径，面板仍要自己拼 URL，收编就会被下一处内联路径重新打穿。
 */
export const novelPaths = {
  projectPlan: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/plan`,
  storyArcs: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs`,
  knowledge: (i: { projectId: string; kind: string }) => `/v2/projects/${enc(i.projectId)}/knowledge/${enc(i.kind)}`,
  creativeRuns: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/creative-runs`,
  creativeRun: (i: { runId: string }) => `/v2/creative-runs/${enc(i.runId)}`,
  creativeRunEvents: (i: { runId: string; afterSequence: number }) =>
    `/v2/creative-runs/${enc(i.runId)}/events?afterSequence=${encodeURIComponent(String(i.afterSequence))}`,
  snapshots: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/snapshots`,
  snapshot: (i: { snapshotId: string }) => `/v2/snapshots/${enc(i.snapshotId)}`,
  experiments: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/experiments`,
  candidates: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/candidates`,
  receipts: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/receipts`,
  chapterScript: (i: { projectId: string; documentId: string }) =>
    `/v2/projects/${enc(i.projectId)}/documents/${enc(i.documentId)}/script-h3`,
  scriptSubjectPreset: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/script-h3/subject-preset`,
  chapterReview: (i: { projectId: string; documentId: string }) =>
    `/v2/projects/${enc(i.projectId)}/documents/${enc(i.documentId)}/review`,
};

// ---------- 命令注册表（写操作的单一真源） ----------
/**
 * 每条命令声明 method / path / body / 失效面。调用点只给业务入参。
 *
 * 失效面缺省＝项目前缀（`novelScopes.project`），对项目级资源已经足够——它们全部挂在
 * `["novel","project",<id>]` 之下。只有跨项目或非项目级的写（如快照、实验、候选稿按自身
 * id 归属）才显式覆写。
 */
export const novelCommands = {
  // ---- 全书规划 ----
  planStart: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/plan/start`,
    body: (i: { objective: string; idempotencyKey?: string }) => ({ objective: i.objective, idempotencyKey: i.idempotencyKey }),
  },
  planSectionGenerate: {
    method: "POST",
    path: (i: { projectId: string; taskKey: string }) => `/v2/projects/${enc(i.projectId)}/plan/sections/${enc(i.taskKey)}/generate`,
    body: (i: { instruction?: string }) => ({ instruction: i.instruction }),
  },
  planSectionApprove: {
    method: "POST",
    path: (i: { projectId: string; taskKey: string }) => `/v2/projects/${enc(i.projectId)}/plan/sections/${enc(i.taskKey)}/approve`,
    body: () => ({}),
  },
  planSectionUpdate: {
    method: "PATCH",
    path: (i: { projectId: string; taskKey: string }) => `/v2/projects/${enc(i.projectId)}/plan/sections/${enc(i.taskKey)}`,
    body: (i: { payload: unknown }) => ({ payload: i.payload }),
  },
  planSynopsisGenerate: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/plan/synopsis`,
    body: () => ({}),
  },
  planTitleCandidatesGenerate: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/plan/title-candidates`,
    body: () => ({}),
  },
  planTitleSelect: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/plan/title`,
    body: (i: { title: string; sourceFingerprint?: string }) => ({ title: i.title, sourceFingerprint: i.sourceFingerprint }),
  },

  // ---- 故事弧 ----
  storyArcStart: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/next`,
    body: (i: { authorIntent?: string; reviewPolicy: string }) => ({ authorIntent: i.authorIntent, reviewPolicy: i.reviewPolicy }),
  },
  storyArcNextBatch: {
    method: "POST",
    path: (i: { projectId: string; arcId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}/batches/next`,
    body: (i: { reviewPolicy: string }) => ({ reviewPolicy: i.reviewPolicy }),
  },
  storyArcUpdate: {
    method: "PATCH",
    path: (i: { projectId: string; arcId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}`,
    body: (i: { bundle: unknown }) => ({ bundle: i.bundle }),
  },
  storyArcApprovePreview: {
    method: "POST",
    path: (i: { projectId: string; arcId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}/approve`,
    body: () => ({ confirm: false }),
  },
  storyArcApprove: {
    method: "POST",
    path: (i: { projectId: string; arcId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}/approve`,
    body: () => ({ confirm: true }),
  },
  storyArcRebase: {
    method: "POST",
    path: (i: { projectId: string; arcId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}/rebase`,
    body: (i: { authorIntent?: string; reviewPolicy: string }) => ({ authorIntent: i.authorIntent, reviewPolicy: i.reviewPolicy }),
  },
  storyArcAbandon: {
    method: "POST",
    path: (i: { projectId: string; arcId: string }) => `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}/abandon`,
    body: (i: { reason?: string }) => ({ reason: i.reason }),
  },
  storyArcDelete: {
    method: "DELETE",
    path: (i: { projectId: string; arcId: string; force?: boolean }) =>
      `/v2/projects/${enc(i.projectId)}/story-arcs/${enc(i.arcId)}${i.force ? "?force=true" : ""}`,
    // 原实现无论 force 与否都发 body（`{}` / `{force:true}`），照原样保留。
    body: (i: { force?: boolean }) => (i.force ? { force: true } : {}),
    // force 时的专属头，缺它会静默退化成普通删除（见 NovelCommand.headers 注释）。
    headers: (i: { force?: boolean }): Record<string, string> => (i.force ? { "x-force-delete": "true" } : {}),
  },

  // ---- 评估面（快照 / 实验 / 候选稿按自身 id 归属，失效面需显式声明） ----
  snapshotCapture: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/snapshots`,
    body: () => ({}),
  },
  experimentCreate: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/experiments`,
    body: (i: { snapshotId: string }) => ({ snapshotId: i.snapshotId }),
  },
  experimentDelete: {
    method: "DELETE",
    // path 只用到 experimentId，但仍声明 projectId：它是**失效面的来源**（缺省失效整个项目前缀）。
    path: (i: { projectId: string; experimentId: string }) => `/v2/experiments/${enc(i.experimentId)}`,
  },
  experimentClose: {
    method: "POST",
    path: (i: { projectId: string; experimentId: string }) => `/v2/experiments/${enc(i.experimentId)}/close`,
    body: () => ({}),
  },
  candidateGenerate: {
    method: "POST",
    path: (i: { projectId: string; experimentId: string }) => `/v2/experiments/${enc(i.experimentId)}/candidate`,
    body: (i: { documentId: string }) => ({ documentId: i.documentId }),
  },
  candidatePromote: {
    method: "POST",
    path: (i: { projectId: string; candidateId: string }) => `/v2/candidates/${enc(i.candidateId)}/promote`,
    body: (i: { authorId?: string; decision: string; reason?: string }) => ({ authorId: i.authorId, decision: i.decision, reason: i.reason }),
  },

  // ---- 创作运行（creative_runs，与 workflow_runs 是两个词表） ----
  creativeRunCreate: {
    method: "POST",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/creative-runs`,
    body: (i: { mode: unknown; policy: unknown }) => ({ mode: i.mode, policy: i.policy }),
  },
  creativeRunCommand: {
    method: "POST",
    path: (i: { projectId: string; runId: string }) => `/v2/creative-runs/${enc(i.runId)}/commands`,
    body: (i: { command: unknown }) => i.command,
    // 两个面：run 自身（详情 + 事件流）与项目级列表。
    invalidates: (i: { projectId: string; runId: string }) => [novelScopes.creativeRun(i.runId), novelScopes.project(i.projectId)],
  },

  // ---- 章节剧本 ----
  chapterScriptGenerate: {
    method: "POST",
    path: (i: { projectId: string; documentId: string }) => `/v2/projects/${enc(i.projectId)}/documents/${enc(i.documentId)}/script-h3`,
    body: (i: { instruction?: string }) => ({ instruction: i.instruction }),
  },
  scriptSubjectPresetSave: {
    method: "PUT",
    path: (i: { projectId: string }) => `/v2/projects/${enc(i.projectId)}/script-h3/subject-preset`,
    body: (i: { definitionText: string }) => ({ definitionText: i.definitionText }),
  },

  // ---- 知识工作台 ----
  knowledgeCreate: {
    method: "POST",
    path: (i: { projectId: string; kind: string }) => `/v2/projects/${enc(i.projectId)}/knowledge/${enc(i.kind)}`,
    body: (i: { value: unknown }) => i.value,
  },
  knowledgeUpdate: {
    method: "PATCH",
    path: (i: { projectId: string; kind: string; id: string }) => `/v2/projects/${enc(i.projectId)}/knowledge/${enc(i.kind)}/${enc(i.id)}`,
    body: (i: { value: unknown }) => i.value,
  },
  knowledgeDelete: {
    method: "DELETE",
    path: (i: { projectId: string; kind: string; id: string }) => `/v2/projects/${enc(i.projectId)}/knowledge/${enc(i.kind)}/${enc(i.id)}`,
  },
} as const;

/** 取必填字符串入参，缺失即抛（与后端 400 相比，这里给出可读的中文原因）。 */
function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} 必填`);
  return value;
}

/**
 * 通用 MCP 工具执行器的**具名逃逸口**。
 *
 * `McpToolGatewayPanel` 是**通用**工具执行器——它把用户在文本框里编辑的任意 args JSON 原样转发，
 * 所以它不能走具名命令（那会把"任意 args"这个用途掐掉）。但它也不该拿到裸 transport：
 * **工具名 → 端点的映射是端点知识**，属本模块，不属于面板。
 *
 * 因此这是全仓唯一允许"任意 args"的入口，有名字、有契约、对未知工具给出可执行的报错。
 * 其余所有写操作一律走 `novelCommands`。
 */
export async function executeNovelTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const jsonHeaders = { "content-type": "application/json" };
  switch (toolName) {
    case "novel_run_create": {
      const projectId = requireStringArg(args, "projectId");
      return novelFetch(novelPaths.creativeRuns({ projectId }), { method: "POST", headers: jsonHeaders, body: JSON.stringify(args) });
    }
    case "novel_chapter_review": {
      const projectId = requireStringArg(args, "projectId");
      const documentId = requireStringArg(args, "documentId");
      return novelFetch(novelPaths.chapterReview({ projectId, documentId }), { method: "POST", headers: jsonHeaders, body: JSON.stringify(args) });
    }
    default:
      throw new Error(`工具 ${toolName} 不支持直接执行，请复制 MCP 调用命令后通过 MCP server 调用`);
  }
}

// ---------- 读 ----------
export function useNovelProjects() {
  return useQuery({
    queryKey: novelKeys.projects,
    queryFn: async () => (await novelFetch<{ projects: NovelProjectSummary[] }>("/v2/projects")).projects ?? [],
  });
}

export function useNovelProject(projectId: string) {
  return useQuery({
    queryKey: novelKeys.project(projectId),
    queryFn: async () => (await novelFetch<{ project: NovelProjectDetail }>(`/v2/projects/${enc(projectId)}`)).project,
    enabled: Boolean(projectId),
    refetchInterval: (query) => query.state.data?.latestRuns?.some((run) => isOpenWorkflowRunStatus(run.status)) ? 3000 : false,
  });
}

export function useNovelProjectRuns(projectId: string) {
  const queryClient = useQueryClient();
  const previous = useRef(new Map<string, string>());
  const query = useQuery({
    queryKey: novelKeys.runs(projectId),
    queryFn: async () => (await novelFetch<{ runs: NovelWorkflowRunRecord[] }>(`/v2/projects/${enc(projectId)}/runs`)).runs ?? [],
    enabled: Boolean(projectId),
    refetchInterval: (current) => current.state.data?.some((run) => isOpenWorkflowRunStatus(run.status)) ? 3000 : false,
  });
  useEffect(() => {
    for (const run of query.data ?? []) {
      const previousStatus = previous.current.get(run.temporalWorkflowId);
      if (previousStatus && isOpenWorkflowRunStatus(previousStatus) && isTerminalWorkflowRunStatus(run.status)) {
        invalidateNovelProject(queryClient, run.projectId || projectId, novelRunDocumentId(run), run.temporalWorkflowId);
      }
      previous.current.set(run.temporalWorkflowId, run.status);
    }
  }, [projectId, query.data, queryClient]);
  return query;
}

export function useNovelRun(workflowId: string | undefined) {
  const queryClient = useQueryClient();
  const previousStatus = useRef<string | undefined>(undefined);
  const query = useQuery({
    queryKey: novelKeys.run(workflowId ?? "none"),
    queryFn: () => novelFetch<NovelRunState>(`/v2/runs/${enc(workflowId!)}`),
    enabled: Boolean(workflowId),
    refetchInterval: (query) => (isOpenWorkflowRunStatus(query.state.data?.status) ? 3000 : false),
  });
  useEffect(() => {
    const state = query.data;
    const status = state?.record?.status ?? state?.status;
    if (previousStatus.current && isOpenWorkflowRunStatus(previousStatus.current) && status && isTerminalWorkflowRunStatus(status)) {
      invalidateNovelProject(queryClient, state?.record?.projectId, novelRunDocumentId(state?.record), workflowId);
    }
    if (status) previousStatus.current = status;
  }, [query.data, queryClient, workflowId]);
  return query;
}

export function useNovelRunEvents(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runEvents(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ events: NovelRunEvent[] }>(`/v2/runs/${enc(workflowId!)}/events`)).events ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelRunArtifacts(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runArtifacts(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ artifacts: NovelArtifactSummary[] }>(`/v2/runs/${enc(workflowId!)}/artifacts`)).artifacts ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelDocumentContent(projectId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: novelKeys.docContent(projectId, documentId ?? "none"),
    queryFn: () => novelFetch<NovelDocumentContent>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/content`),
    enabled: Boolean(projectId && documentId),
  });
}

export function useNovelFactCandidates(projectId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: novelKeys.factCandidates(projectId, documentId ?? "none"),
    queryFn: async () => (await novelFetch<{ candidates: NovelFactCandidate[] }>(`/v2/projects/${enc(projectId)}/fact-candidates?documentId=${enc(documentId!)}`)).candidates ?? [],
    enabled: Boolean(projectId && documentId),
  });
}

export function useNovelArtifactText(artifactId: string | undefined) {
  return useQuery({
    queryKey: ["novel", "artifact", artifactId ?? "none", "text"] as const,
    queryFn: () => novelFetch<{ text: string; kind: string; artifactId: string; wordCount: number }>(`/v2/artifacts/${enc(artifactId!)}/content`),
    enabled: Boolean(artifactId),
  });
}

/** 提交作者修改（proposedText）启动章节重审工作流（复用审核/修订/事实/提交闭环） */
export function useSubmitChapterReview(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { proposedText?: string; instruction?: string }) => {
      return novelFetch<{ workflowId: string; runId?: string }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: input.instruction ?? "从严审视叙事逻辑、人物声音、连续性、场景呈现与读者留存，并只修改有明确证据的问题。", proposedText: input.proposedText, idempotencyKey: `${projectId}:${documentId}:review:${Date.now()}` }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useNovelModelInvocationErrors(projectId: string) {
  return useQuery({
    queryKey: novelKeys.modelInvocationErrors(projectId),
    queryFn: async () => (await novelFetch<{ errors: NovelModelInvocationError[] }>(`/v2/projects/${enc(projectId)}/model-invocation-errors?limit=50`)).errors ?? [],
    enabled: Boolean(projectId),
    refetchInterval: 30_000,
  });
}

export function useNovelLearningCenter(projectId: string) {
  return useQuery({
    queryKey: novelKeys.learningCenter(projectId),
    queryFn: async () => {
      const [assessments, candidates] = await Promise.all([
        novelFetch<{ assessments: NovelLearningAssessmentView[] }>(`/v2/projects/${enc(projectId)}/learning-assessments`),
        novelFetch<{ candidates: NovelCraftRuleCandidate[] }>(`/v2/projects/${enc(projectId)}/craft-rule-candidates`),
      ]);
      return { assessments: assessments.assessments ?? [], candidates: candidates.candidates ?? [] };
    },
    enabled: Boolean(projectId),
    refetchInterval: 10_000,
  });
}

async function postCraftRuleOperation<T>(projectId: string, candidateId: string, input: Record<string, unknown>): Promise<T> {
  return novelFetch<T>(`/v2/projects/${enc(projectId)}/craft-rule-candidates/${enc(candidateId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ---------- 文风契约 ----------
export interface StyleDimensionView {
  value: string;
  note?: string;
}

export interface StyleContractView {
  id: string;
  projectId: string;
  version: number;
  label: string;
  payload: {
    dimensions: Partial<Record<"pov" | "narrationDistance" | "timeMode" | "sentenceRhythm" | "vocabularyLevel" | "sensoryFocus" | "metaphorDensity" | "dialogueRatio" | "restraintLevel" | "narrationAttitude", StyleDimensionView>>;
    note?: string;
  };
  fingerprint: string;
  status: "draft" | "active";
  createdAt: string;
  updatedAt?: string;
}

export function useStyleContracts(projectId: string) {
  return useQuery({
    queryKey: novelKeys.styleContracts(projectId),
    queryFn: async () => (await novelFetch<{ contracts: StyleContractView[] }>(`/v2/projects/${enc(projectId)}/style-contracts`)).contracts ?? [],
    enabled: Boolean(projectId),
  });
}

export function useActiveStyleContract(projectId: string) {
  return useQuery({
    queryKey: novelKeys.activeStyleContract(projectId),
    queryFn: async () => (await novelFetch<{ contract: StyleContractView | null }>(`/v2/projects/${enc(projectId)}/style-contracts/active`)).contract ?? null,
    enabled: Boolean(projectId),
  });
}

export function useCreateStyleContract(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string; payload: StyleContractView["payload"]; sourceArtifactId?: string }) =>
      novelFetch<{ contract: StyleContractView }>(`/v2/projects/${enc(projectId)}/style-contracts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: novelKeys.styleContracts(projectId) });
      void queryClient.invalidateQueries({ queryKey: novelKeys.activeStyleContract(projectId) });
    },
  });
}

export function useActivateStyleContract(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contractId: string) =>
      novelFetch<{ contract: StyleContractView }>(`/v2/projects/${enc(projectId)}/style-contracts/${enc(contractId)}/activate`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: novelKeys.styleContracts(projectId) });
      void queryClient.invalidateQueries({ queryKey: novelKeys.activeStyleContract(projectId) });
    },
  });
}


export function useRunCraftRuleCandidateExperiment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidateId: string; crossScenarioDocumentId: string; instruction?: string }) => postCraftRuleOperation<NovelCraftRuleExperimentResponse>(projectId, input.candidateId, { operation: "experiment", ...input }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: novelKeys.learningCenter(projectId) }); },
  });
}

export function useSubmitCraftRuleCandidateReview(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidateId: string; verdict: "passed" | "rejected"; summary: string }) => postCraftRuleOperation<{ candidate: NovelCraftRuleCandidate }>(projectId, input.candidateId, { operation: "review", reviewerId: "web-author", role: "author-reviewer", model: "human", ...input }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: novelKeys.learningCenter(projectId) }); },
  });
}

export function usePromoteCraftRuleCandidate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidateId: string; authorId?: string }) => postCraftRuleOperation<{ result: { candidate: NovelCraftRuleCandidate } }>(projectId, input.candidateId, { operation: "promote", ...input }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: novelKeys.learningCenter(projectId) }); },
  });
}

export function useStartTargetedChapterRepair(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { issueIds: string[]; instruction?: string }) => novelFetch<{ workflowId: string; runId?: string; targetIssueCount: number }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "targeted", targetIssueIds: input.issueIds, instruction: input.instruction?.trim() || undefined, idempotencyKey: `${projectId}:${documentId}:targeted-review:${crypto.randomUUID()}` }),
    }),
    onSuccess: () => {
      if (documentId) void qc.invalidateQueries({ queryKey: novelKeys.chapterWorkspace(projectId, documentId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useCancelNovelRun(projectId: string, workflowId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => novelFetch<{ workflowId: string; status: string }>(`/v2/runs/${enc(workflowId!)}/cancel`, { method: "POST" }),
    onSuccess: () => {
      if (workflowId) void qc.invalidateQueries({ queryKey: novelKeys.run(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useNovelRunReviews(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runReviews(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ reviews: NovelReviewSummary[] }>(`/v2/runs/${enc(workflowId!)}/reviews`)).reviews ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelRunPromptExecutions(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runPromptExecutions(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ executions: NovelPromptExecution[] }>(`/v2/runs/${enc(workflowId!)}/prompt-executions`)).executions ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelRunModelInvocations(workflowId: string | undefined, active = false) {
  return useQuery({
    queryKey: novelKeys.runModelInvocations(workflowId ?? "none"),
    queryFn: async () => (await novelFetch<{ invocations: NovelModelInvocation[] }>(`/v2/runs/${enc(workflowId!)}/model-invocations`)).invocations ?? [],
    enabled: Boolean(workflowId),
    refetchInterval: active ? 3000 : false,
  });
}

export function useNovelChapterWorkspace(projectId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: novelKeys.chapterWorkspace(projectId, documentId ?? "none"),
    queryFn: async () => (await novelFetch<{ workspace: NovelChapterWorkspace }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/workspace`)).workspace,
    enabled: Boolean(projectId && documentId),
  });
}

export function fetchNovelChapterScript(projectId: string, documentId: string): Promise<NovelChapterScriptView> {
  return novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}/script-h3`);
}

export function generateNovelChapterScript(projectId: string, documentId: string, instruction?: string): Promise<{ record: NovelChapterScriptView & { reused?: boolean } }> {
  return novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}/script-h3`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: instruction?.trim() || undefined }),
  });
}

/**
 * 独立短剧生成（stateless，浏览器存储）：POST /v2/short-script-h3 仅生成、不落库。
 * 产物由前端存入 IndexedDB（见 src/lib/shortDramaStore.ts）。素材/回避清单由前端直传。
 */
export function generateShortScriptStateless(input: {
  idea: string;
  instruction?: string;
  durationMode?: "fixed" | "auto";
  targetDurationSeconds?: number;
  referenceMaterials?: Array<{ subjectTag: string; description: string }>;
  materialRefs?: Array<{ materialId: string; description: string; subjectTag: string }>;
  avoidMotifs?: string[];
}): Promise<{ record: NovelShortScriptView & { scriptId: string } }> {
  return novelFetch("/v2/short-script-h3", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idea: input.idea,
      instruction: input.instruction?.trim() || undefined,
      durationMode: input.durationMode,
      targetDurationSeconds: input.durationMode === "auto" ? undefined : input.targetDurationSeconds,
      referenceMaterials: input.referenceMaterials?.length ? input.referenceMaterials : undefined,
      materialRefs: input.materialRefs?.length ? input.materialRefs : undefined,
      avoidMotifs: input.avoidMotifs?.length ? input.avoidMotifs : undefined,
    }),
  });
}

// ---------- 写 ----------
export function useCreateNovelProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { premise: string; title?: string; genre?: string; creativeBrief?: CreativeBriefSeed; autoBootstrap: boolean; includeChapterPlan: boolean }) =>
      novelFetch<{ project: NovelProjectDetail }>("/v2/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.projects }),
  });
}

export function useUpdateNovelProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, title }: { projectId: string; title: string }) =>
      novelFetch<{ project: NovelProjectDetail }>(`/v2/projects/${enc(projectId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: novelKeys.projects });
      void qc.invalidateQueries({ queryKey: novelKeys.project(project.id) });
    },
  });
}

export function useDeleteNovelProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => novelFetch(`/v2/projects/${enc(projectId)}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.projects }),
  });
}

export type NovelDocumentInput = {
  title: string;
  narrativeOrder?: number;
  povCharacterId?: string | null;
  status?: string;
  chapterGoal?: string;
};

export function useSaveNovelDocumentContent(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { plainText: string; expectedContentHash: string; label?: string }) => novelFetch<{ result: { unchanged: boolean; revisionId: string; revision: number; contentHash: string } }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    onSuccess: () => {
      if (!documentId) return;
      void qc.invalidateQueries({ queryKey: novelKeys.chapterWorkspace(projectId, documentId) });
      void qc.invalidateQueries({ queryKey: novelKeys.docContent(projectId, documentId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useUpdateChapterReviewIssue(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { issueId: string; status: NovelChapterReviewIssue["status"] }) => novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/review-issues/${enc(input.issueId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: input.status }),
    }),
    onSuccess: () => { if (documentId) void qc.invalidateQueries({ queryKey: novelKeys.chapterWorkspace(projectId, documentId) }); },
  });
}

export function useCreateChapterReviewIssue(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { severity: NovelChapterReviewIssue["severity"]; title: string; description?: string; evidenceQuote?: string; paragraph?: number; suggestion?: string }) => novelFetch<{ issue: NovelChapterReviewIssue }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/review-issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    onSuccess: () => { if (documentId) void qc.invalidateQueries({ queryKey: novelKeys.chapterWorkspace(projectId, documentId) }); },
  });
}

export function useChapterVersionActions(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = () => {
    if (!documentId) return;
    void qc.invalidateQueries({ queryKey: novelKeys.chapterWorkspace(projectId, documentId) });
    void qc.invalidateQueries({ queryKey: novelKeys.docContent(projectId, documentId) });
    void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
  };
  const restore = useMutation({
    mutationFn: (revisionId: string) => novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/versions/${enc(revisionId)}/restore`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const name = useMutation({
    mutationFn: (input: { revisionId: string; label: string }) => novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId!)}/versions/${enc(input.revisionId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: input.label }) }),
    onSuccess: invalidate,
  });
  return { restore, name };
}

export function useCreateNovelDocument(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NovelDocumentInput) => novelFetch<{ document: NovelDocumentSummary }>(`/v2/projects/${enc(projectId)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) }),
  });
}

export function useUpdateNovelDocument(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, ...input }: NovelDocumentInput & { documentId: string }) =>
      novelFetch<{ document: NovelDocumentSummary }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) }),
  });
}

export function useGenerateChapterTitle(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => novelFetch<{ workflowId: string; runId?: string; status: string }>(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}/title/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) }),
  });
}

export function useDeleteNovelDocument(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => novelFetch(`/v2/projects/${enc(projectId)}/documents/${enc(documentId)}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) }),
  });
}

export function useSubmitNovelIntent(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { objective: string; documentId?: string; factApprovalMode: "auto" | "manual"; idempotencyKey?: string }) =>
      novelFetch<{ workflowId: string; runId?: string }>("/v2/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          objective: input.objective,
          idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          source: "web",
          requestedStage: input.documentId ? "drafting" : "planning",
          target: input.documentId ? { kind: "chapter", id: input.documentId } : undefined,
          factApprovalMode: input.factApprovalMode,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useSignalHumanDecision(projectId: string, workflowId: string | undefined, documentId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { artifactId: string; decision: "approve" | "reject" | "revise" | "abandon"; feedback?: string; revisionBase?: "current" | "previous" }) => {
      await novelFetch(`/v2/workflows/${enc(workflowId!)}/tasks/${enc(input.artifactId)}/human-decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: input.decision, feedback: input.feedback, revisionBase: input.revisionBase }),
      });
    },
    onSuccess: (_data, input) => {
      if (!workflowId) return;
      const submittedStage = input.decision === "approve" ? "fact-extraction" : input.decision === "revise" ? "revision" : "manuscript-approval";
      const markRunning = (run: NovelWorkflowRunRecord): NovelWorkflowRunRecord => run.temporalWorkflowId === workflowId
        ? { ...run, status: input.decision === "abandon" ? "abandoned" : "running", payload: { ...run.payload, stage: submittedStage, pendingHumanDecisionSubmitted: true, ...(input.decision === "abandon" ? { reasonCode: "abandoned-by-author" } : {}) }, updatedAt: new Date().toISOString() }
        : run;
      qc.setQueryData<NovelRunState>(novelKeys.run(workflowId), (current) => current
        ? { ...current, status: input.decision === "abandon" ? "abandoned" : "running", record: current.record ? markRunning(current.record) : current.record }
        : current);
      qc.setQueryData<NovelWorkflowRunRecord[]>(novelKeys.runs(projectId), (current) => current?.map(markRunning));
      if (input.decision === "approve") {
        invalidateNovelProject(qc, projectId, documentId, workflowId);
        return;
      }
      void qc.invalidateQueries({ queryKey: novelKeys.run(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runEvents(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runArtifacts(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runReviews(workflowId) });
    },
  });
}

export function useReplacePendingArtifact(projectId: string, workflowId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { artifactId: string; plainText: string; authorId?: string }) =>
      novelFetch<{ artifact: NovelArtifactSummary; run: NovelWorkflowRunRecord; text: string; wordCount: number }>(`/v2/workflows/${enc(workflowId!)}/tasks/${enc(input.artifactId)}/replacement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plainText: input.plainText, authorId: input.authorId ?? "web-author" }),
      }),
    onSuccess: (data, input) => {
      if (!workflowId) return;
      qc.setQueryData<NovelRunState>(novelKeys.run(workflowId), (current) => current
        ? { ...current, status: data.run.status, record: data.run }
        : current);
      qc.setQueryData<NovelWorkflowRunRecord[]>(novelKeys.runs(projectId), (current) => current?.map((run) => run.temporalWorkflowId === workflowId ? data.run : run));
      qc.setQueryData(novelKeys.runArtifacts(workflowId), (current: NovelArtifactSummary[] | undefined) => current ? [data.artifact, ...current.filter((artifact) => artifact.id !== data.artifact.id)] : current);
      qc.setQueryData(["novel", "artifact", data.artifact.id, "text"] as const, { text: data.text, kind: data.artifact.kind, artifactId: data.artifact.id, wordCount: data.wordCount });
      void qc.invalidateQueries({ queryKey: ["novel", "artifact", input.artifactId, "text"] as const });
      void qc.invalidateQueries({ queryKey: novelKeys.run(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runs(projectId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runArtifacts(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.runReviews(workflowId) });
      void qc.invalidateQueries({ queryKey: novelKeys.project(projectId) });
    },
  });
}

export function useDecideFactCandidate(projectId: string, documentId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { claimId: string; decision: "approve" | "reject" }) => {
      await novelFetch(`/v2/projects/${enc(projectId)}/fact-candidates/${enc(input.claimId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: input.decision, actorId: "web-author" }),
      });
    },
    onSuccess: () => {
      if (documentId) void qc.invalidateQueries({ queryKey: novelKeys.factCandidates(projectId, documentId) });
    },
  });
}
