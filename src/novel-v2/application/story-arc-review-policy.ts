import type { StoryArcBundle, StoryArcRebaseTarget } from "./story-arc";

/** Story Arc checks stay structural; literary preferences remain open to the writer. */
export const CHAPTER_PLAN_CHECK_DIMENSIONS = ["state-continuity", "causal-fit", "function-fit", "authority-boundary"] as const;
export type ChapterPlanCheckDimension = (typeof CHAPTER_PLAN_CHECK_DIMENSIONS)[number];
export const ARC_PLAN_CHECK_DIMENSIONS = ["arc-boundary", "window-rhythm", "longform-hierarchy"] as const;
export type ArcPlanCheckDimension = (typeof ARC_PLAN_CHECK_DIMENSIONS)[number];

export interface ChapterPlanValidationCheck {
  chapterIndex: number;
  dimension: ChapterPlanCheckDimension;
  verdict: "passed" | "revise" | "blocked";
  evidence: string;
  reason: string;
}

export interface ArcPlanValidationCheck {
  dimension: ArcPlanCheckDimension;
  verdict: "passed" | "revise" | "blocked";
  evidence: string;
  reason: string;
}

export interface ChapterPlanValidationReport {
  passed: boolean;
  checks: ChapterPlanValidationCheck[];
  missingChecks: Array<{ chapterIndex: number; dimension: ChapterPlanCheckDimension }>;
  blockingChecks: ChapterPlanValidationCheck[];
  arcChecks: ArcPlanValidationCheck[];
  missingArcChecks: ArcPlanCheckDimension[];
  blockingArcChecks: ArcPlanValidationCheck[];
}

export interface StoryArcReviewOutput {
  verdict: "passed" | "revise" | "blocked";
  summary: string;
  issues: Array<{ severity: "blocker" | "major" | "warning"; title: string; evidence: string; suggestion: string }>;
  chapterChecks: ChapterPlanValidationCheck[];
  arcChecks: ArcPlanValidationCheck[];
  authorityChecks: Array<{
    chapterIndex: number;
    verdict: "passed" | "revise" | "blocked";
    unresolvedAtClose: string[];
    checkedPaths: string[];
    candidateClaims: string[];
    frozenEvidence: string[];
    certaintyUpgrades: Array<{ candidateClaim: string; frozenBoundary: string; reason: string }>;
    reason: string;
  }>;
}

export function storyArcAuthorityPaths(chapter: StoryArcBundle["chapters"][number]): string[] {
  const paths = ["stateTransition.before", "stateTransition.after", "stateTransition.evidence"];
  chapter.scenes.forEach((_, sceneIndex) => {
    paths.push(
      `scenes[${sceneIndex}].situation`,
      `scenes[${sceneIndex}].observableActions`,
      `scenes[${sceneIndex}].outcome`,
    );
  });
  return paths;
}

export function storyArcAuthorityClaims(chapter: StoryArcBundle["chapters"][number]): string[] {
  return [
    chapter.stateTransition.before,
    chapter.stateTransition.after,
    chapter.stateTransition.evidence,
    ...chapter.scenes.flatMap((scene) => [scene.situation, scene.observableActions.join("；"), scene.outcome]),
  ];
}

function stablePlannedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePlannedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(key === "unresolvedAtClose" && Array.isArray(item) && item.length === 0))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stablePlannedValue(item)]));
}

function frozenBlueprint(targetChapter: StoryArcRebaseTarget["chapters"][number] | undefined) {
  if (!targetChapter) return undefined;
  return targetChapter.plannedBlueprint && !targetChapter.revisionId && !targetChapter.committedMemory
    ? targetChapter.plannedBlueprint
    : targetChapter.committedBlueprint;
}

function matchesFrozenBlueprint(chapter: StoryArcBundle["chapters"][number], targetChapter: StoryArcRebaseTarget["chapters"][number] | undefined): boolean {
  const frozen = frozenBlueprint(targetChapter);
  return Boolean(frozen && JSON.stringify(stablePlannedValue(chapter)) === JSON.stringify(stablePlannedValue(frozen)));
}

function frozenAuthorityEvidence(chapter: StoryArcBundle["chapters"][number], targetChapter: StoryArcRebaseTarget["chapters"][number] | undefined): string[] {
  const frozen = frozenBlueprint(targetChapter);
  if (!frozen) return [];
  return storyArcAuthorityPaths(frozen)
    .map((path, index) => `${path}=${storyArcAuthorityClaims(frozen)[index] ?? ""}`)
    .filter((entry) => entry.slice(entry.indexOf("=") + 1).trim())
    .concat(`第 ${chapter.index} 章沿用已冻结的因果和状态边界。`);
}

function issueMentionsChapter(issue: StoryArcReviewOutput["issues"][number], chapterIndex: number): boolean {
  return new RegExp(`第\\s*${chapterIndex}\\s*章`).test(`${issue.title}\n${issue.evidence}\n${issue.suggestion}`);
}

export function normalizeStoryArcReviewAuthority(bundle: StoryArcBundle, review: StoryArcReviewOutput, rebaseTarget?: StoryArcRebaseTarget): StoryArcReviewOutput {
  const frozen = new Set(bundle.chapters
    .filter((chapter) => matchesFrozenBlueprint(chapter, rebaseTarget?.chapters.find((target) => target.globalOrder === chapter.index)))
    .map((chapter) => chapter.index));
  return {
    ...review,
    issues: review.issues.filter((issue) => ![...frozen].some((index) => issueMentionsChapter(issue, index))),
    chapterChecks: review.chapterChecks.map((check) => frozen.has(check.chapterIndex) ? { ...check, verdict: "passed" as const, reason: "本次重基线沿用冻结章节因果和状态边界。" } : check),
    authorityChecks: review.authorityChecks.map((check) => {
      const chapter = bundle.chapters.find((candidate) => candidate.index === check.chapterIndex);
      const target = rebaseTarget?.chapters.find((candidate) => candidate.globalOrder === check.chapterIndex);
      if (!chapter || !frozen.has(chapter.index)) return check;
      return {
        ...check,
        unresolvedAtClose: [...(chapter.unresolvedAtClose ?? [])],
        checkedPaths: storyArcAuthorityPaths(chapter),
        candidateClaims: storyArcAuthorityClaims(chapter),
        verdict: "passed" as const,
        frozenEvidence: frozenAuthorityEvidence(chapter, target),
        certaintyUpgrades: [],
        reason: "候选与重基线冻结的因果和状态边界一致。",
      };
    }),
  };
}

const VERDICT_RANK = { passed: 0, revise: 1, blocked: 2 } as const;

export function mergeStoryArcReviews(bundle: StoryArcBundle, reviews: StoryArcReviewOutput[], rebaseTarget?: StoryArcRebaseTarget): StoryArcReviewOutput {
  if (!reviews.length) throw new Error("故事弧审核合并至少需要一份审核结果");
  const normalized = reviews.map((review) => normalizeStoryArcReviewAuthority(bundle, review, rebaseTarget));
  const worst = <T extends { verdict: "passed" | "revise" | "blocked" }>(items: T[]) => {
    if (!items.length) throw new Error("故事弧审核缺少必需检查");
    return items.reduce((selected, item) => VERDICT_RANK[item.verdict] > VERDICT_RANK[selected.verdict] ? item : selected);
  };
  const chapterChecks = bundle.chapters.flatMap((chapter) => CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => worst(normalized.map((review) => review.chapterChecks.find((check) => check.chapterIndex === chapter.index && check.dimension === dimension)).filter((check): check is ChapterPlanValidationCheck => Boolean(check)))));
  const arcChecks = ARC_PLAN_CHECK_DIMENSIONS.map((dimension) => worst(normalized.map((review) => review.arcChecks.find((check) => check.dimension === dimension)).filter((check): check is ArcPlanValidationCheck => Boolean(check))));
  const authorityChecks = bundle.chapters.map((chapter) => {
    const checks = normalized.map((review) => review.authorityChecks.find((check) => check.chapterIndex === chapter.index)).filter((check): check is StoryArcReviewOutput["authorityChecks"][number] => Boolean(check));
    const selected = worst(checks);
    const upgrades = checks.flatMap((check) => check.certaintyUpgrades).filter((upgrade, index, all) => index === all.findIndex((item) => item.candidateClaim === upgrade.candidateClaim && item.frozenBoundary === upgrade.frozenBoundary));
    return { ...selected, verdict: upgrades.length ? "revise" as const : selected.verdict, frozenEvidence: [...new Set(checks.flatMap((check) => check.frozenEvidence))], certaintyUpgrades: upgrades, reason: [...new Set(checks.map((check) => check.reason))].join("；") };
  });
  const issues = normalized.flatMap((review) => review.issues).filter((issue, index, all) => index === all.findIndex((item) => item.title === issue.title && item.evidence === issue.evidence));
  for (const check of authorityChecks) for (const upgrade of check.certaintyUpgrades) issues.push({ severity: "major", title: `第 ${check.chapterIndex} 章存在未获事实支持的确定性升级`, evidence: upgrade.candidateClaim, suggestion: `退回冻结边界：${upgrade.frozenBoundary}。${upgrade.reason}` });
  const verdict = issues.some((issue) => issue.severity === "blocker") || authorityChecks.some((check) => check.verdict === "blocked")
    ? "blocked" as const
    : issues.some((issue) => issue.severity === "major") || chapterChecks.some((check) => check.verdict !== "passed") || arcChecks.some((check) => check.verdict !== "passed") || authorityChecks.some((check) => check.verdict !== "passed")
      ? "revise" as const
      : "passed" as const;
  return { verdict, summary: normalized.map((review) => review.summary).join("\n"), issues, chapterChecks, arcChecks, authorityChecks };
}

export function compileChapterPlanValidationReport(bundle: StoryArcBundle, checks: ChapterPlanValidationCheck[], arcChecks: ArcPlanValidationCheck[] = []): ChapterPlanValidationReport {
  const expected = bundle.chapters.flatMap((chapter) => CHAPTER_PLAN_CHECK_DIMENSIONS.map((dimension) => ({ chapterIndex: chapter.index, dimension })));
  const validChapterIndices = new Set(bundle.chapters.map((chapter) => chapter.index));
  const normalized = checks.filter((check, index, all) => validChapterIndices.has(check.chapterIndex) && CHAPTER_PLAN_CHECK_DIMENSIONS.includes(check.dimension) && index === all.findIndex((candidate) => candidate.chapterIndex === check.chapterIndex && candidate.dimension === check.dimension));
  const missingChecks = expected.filter((item) => !normalized.some((check) => check.chapterIndex === item.chapterIndex && check.dimension === item.dimension));
  const normalizedArcChecks = arcChecks.filter((check, index, all) => ARC_PLAN_CHECK_DIMENSIONS.includes(check.dimension) && index === all.findIndex((candidate) => candidate.dimension === check.dimension));
  const missingArcChecks = ARC_PLAN_CHECK_DIMENSIONS.filter((dimension) => !normalizedArcChecks.some((check) => check.dimension === dimension));
  const blockingChecks = normalized.filter((check) => check.verdict !== "passed");
  const blockingArcChecks = normalizedArcChecks.filter((check) => check.verdict !== "passed");
  return { passed: !missingChecks.length && !blockingChecks.length && !missingArcChecks.length && !blockingArcChecks.length, checks: normalized, missingChecks, blockingChecks, arcChecks: normalizedArcChecks, missingArcChecks, blockingArcChecks };
}

export function validateStoryArcReview(bundle: StoryArcBundle, review: StoryArcReviewOutput): ChapterPlanValidationReport {
  const report = compileChapterPlanValidationReport(bundle, review.chapterChecks, review.arcChecks);
  if (report.missingChecks.length) throw new Error(`故事弧审核缺少逐章校验：${report.missingChecks.map((item) => `第${item.chapterIndex}章/${item.dimension}`).join("、")}`);
  if (report.missingArcChecks.length) throw new Error(`故事弧审核缺少整弧校验：${report.missingArcChecks.join("、")}`);
  for (const chapter of bundle.chapters) {
    const checks = review.authorityChecks.filter((check) => check.chapterIndex === chapter.index);
    if (checks.length !== 1) throw new Error(`故事弧审核缺少第${chapter.index}章唯一的事实权威校验`);
    const check = checks[0];
    if (!check.candidateClaims.length || !check.frozenEvidence.length || !check.reason.trim()) throw new Error(`第${chapter.index}章事实权威校验证据不完整`);
    if (JSON.stringify(check.checkedPaths) !== JSON.stringify(storyArcAuthorityPaths(chapter)) || check.candidateClaims.length !== storyArcAuthorityPaths(chapter).length) throw new Error(`第${chapter.index}章事实权威校验未覆盖因果边界`);
    if (JSON.stringify(check.unresolvedAtClose) !== JSON.stringify(chapter.unresolvedAtClose ?? [])) throw new Error(`第${chapter.index}章事实权威校验未覆盖 unresolvedAtClose`);
    if (check.certaintyUpgrades.length && check.verdict === "passed") throw new Error(`第${chapter.index}章发现确定性升级却标记通过`);
  }
  const blocking = review.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major") || review.authorityChecks.some((check) => check.verdict !== "passed");
  if ((!report.passed || blocking) && review.verdict === "passed") throw new Error("故事弧审核结论与结构校验不一致");
  return report;
}

export function storyArcReviewStrategy(reviewPolicy: "manual" | "auto") {
  return { automaticReview: true as const, automaticRevision: reviewPolicy === "auto", humanApproval: reviewPolicy === "manual" };
}
