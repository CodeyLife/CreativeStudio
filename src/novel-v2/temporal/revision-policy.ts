import type { ChapterChangeScope, Review } from "../protocol";
import { reviewExecutionsForScope } from "../application/review-concurrency";
import type { ManuscriptStructuralReport } from "../application/manuscript-structure";
import { buildRevisionBrief } from "../application/revision-brief";
import { MIN_LENGTH_RATIO } from "../word-count";

/**
 * 历史常量（E4 前"三类 reviewer 全量"的同义词）。评审面单一真源已移至
 * `reviewExecutionsForScope`（review-concurrency）——新代码按档位取期望角色，
 * 勿再直接引用本常量造第二权威。
 */
export const REQUIRED_CHAPTER_REVIEWERS = [
  { role: "structure-reviewer", identity: "internal" },
  { role: "character-reviewer", identity: "independent" },
  { role: "prose-reviewer", identity: "independent" },
] as const;

/**
 * V2 修订决策模块。
 *
 * 与 v1 [workflow-shared.ts] 的 shouldAutoRevise 等价，但参数化为 v2 Review 结构。
 *
 * 决策规则：
 * - 所有 review verdict=passed → 才视为整体通过
 * - blocker issue 存在 → 必须修订（直到无 blocker 或达到上限）
 * - major issue 存在 + 改善度 ≥ 0.15 → 继续修订
 * - 低分且有 grounded warning → 纳入 warning 证据后修订
 * - 低分但没有可定位证据 → 不盲目重写，进入人工队列
 * - 改善度 < 0.15（连续两轮无显著改善）→ 停止修订，避免无限循环
 * - 达到 maxAutoRevisions 上限 → 停止修订，进入人工队列
 */

export interface RevisionDecision {
  readonly shouldRevise: boolean;
  readonly reason: string;
  readonly evidence: RevisionEvidence;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly currentScore: number;
  readonly previousScore?: number;
  readonly improvement: number;
  readonly hasBlocker: boolean;
  readonly hasMajor: boolean;
}

export type RevisionEvidence = "blocker" | "major" | "quality-warning" | "none";

/**
 * 自动修订轮数上限。每轮修订都要重跑三份审校与修订模型调用，成本是"轮数 × 全审核面"。
 * 上限过小会把仍可收敛的稿子过早推给人工门（作者收到的是系统本可自查自修的退化稿）；
 * 过大则在模型不收敛时反复消耗审核成本、并让 run 长期停在修订循环里不被对账收编。
 * 2 轮的判据是"第一轮修结构、第二轮修语言/一致性"两类问题各一次机会，第三轮起多为
 * 同题反复而非新增改善。
 * TODO 可配置：应按模型档位与题材（重设定文 vs 强情节文）可调，现为全局单值。
 */
export const DEFAULT_MAX_AUTO_REVISIONS = 2;
/**
 * 采用修订稿所需的最小改善度（综合分相对基线的提升）。
 * 根因：审校分数本身有噪声（同稿重跑即可见小幅抖动），若任何正向抖动都算"改善"，
 * 修订循环会用抖动稿覆写上一稿，出现"越修越差却每次都算进步"。0.15 定在噪声带之上、
 * 又低于 PARTIAL_IMPROVEMENT_THRESHOLD（后者是"允许局部退化换取整体跃升"的更高门槛）。
 * TODO 可配置：噪声带随 reviewer 模型变，须可按路由档位校准。
 */
export const MIN_IMPROVEMENT_THRESHOLD = 0.15;
/**
 * 自动定稿的综合分门槛：低于此值即使三份审校都无 blocker/major，也不自动定稿，
 * 转人工门（reject/manual-review-required）。
 * 根因：三审全绿但综合平庸的稿会被静默定稿并进入长篇基线——后续章节以它为事实与
 * 文体参照，退化的代价是复利的，因此"无人工介入"必须要求明确的质量余量而非及格线。
 * TODO 可配置：门槛应随题材基线与全书历史分分布可调。
 */
export const MIN_AUTOMATIC_COMMIT_SCORE = 4.0;
/**
 * 单个 reviewer 分数下限。综合分达标但任一 reviewer 塌到此线以下时仍拦。
 * 根因：综合分是均值口径，会掩盖单维塌陷（例如结构与文笔 5.0、角色一致性 2.0 的稿
 * 综合仍在合格线上方，而角色一致性正是长篇跨章最贵的维度）。同一常量兼作
 * `isCandidateQualityBetter` 部分改善通道的最低分守卫：整体跃升不得把任何一维
 * 拉到合格线以下来换分。
 * TODO 可配置：与 structural-validator 的豁免面（不参与评分）绑定，需随 reviewer
 * 角色集合变化重估。
 */
export const MIN_REVIEWER_SCORE = 3.5;

/**
 * 计算 review 列表的综合质量分数（0-5）。
 *
 * Prefer the role-specific score persisted by the reviewer. Legacy reviews
 * without a score retain the severity-derived fallback.
 */
export function scoreReviews(reviews: Review[]): number {
  const scoredReviews = reviews.filter((review) => review.role !== "structural-validator");
  if (!scoredReviews.length) return 0;
  const scores = scoredReviews.map((review) => {
    if (typeof review.score === "number" && Number.isFinite(review.score)) return Math.max(0, Math.min(5, review.score));
    let fallback = 5;
    for (const issue of review.issues) {
      if (issue.severity === "blocker") fallback -= 1.5;
      else if (issue.severity === "major") fallback -= 0.5;
    }
    return Math.max(0, fallback);
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function hasQualityScoreFailure(reviews: Review[]): boolean {
  const scoredReviews = reviews.filter((review) => review.role !== "structural-validator");
  return scoreReviews(scoredReviews) < MIN_AUTOMATIC_COMMIT_SCORE
    || scoredReviews.some((review) => scoreReviews([review]) < MIN_REVIEWER_SCORE);
}

/**
 * 判断是否还有 blocker 或 major。
 */
export function hasBlockerOrMajor(reviews: Review[]): boolean {
  return reviews.some((review) => review.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major"));
}

export function hasBlocker(reviews: Review[]): boolean {
  return reviews.some((review) => review.issues.some((issue) => issue.severity === "blocker"));
}

/**
 * 记录触发修订决策的最低层证据来源。
 * warning 只有在质量门确实因低分失败时才升级为可执行修订证据。
 */
export function classifyRevisionEvidence(reviews: Review[]): RevisionEvidence {
  if (hasBlocker(reviews)) return "blocker";
  if (hasBlockerOrMajor(reviews)) return "major";
  return hasQualityScoreFailure(reviews) && reviews.some((review) => review.issues.some((issue) => issue.severity === "warning"))
    ? "quality-warning"
    : "none";
}

/**
 * 判断是否所有 review verdict 都是 passed。
 */
export function allReviewsPassed(reviews: Review[]): boolean {
  return reviews.length > 0 && reviews.every((review) => review.verdict === "passed");
}

export function evaluateCommitGate(
  reviews: Review[],
  artifactFingerprint: string,
  structuralReport: ManuscriptStructuralReport,
  changeScope?: ChapterChangeScope,
  length?: { plainTextLength: number; targetWordCount?: number },
) {
  const currentReviews = reviews.filter((review) => review.artifactFingerprint === artifactFingerprint);
  // E4：期望评审角色与评审面同源（reviewExecutionsForScope）——机械/局部意图下
  // 被合法收窄掉的角色不计 missing，门禁宽度与执行宽度一处定义。
  const required = reviewExecutionsForScope(changeScope);
  const requiredReviews = required.map(({ role, identity }) =>
    currentReviews.find((review) => review.role === role && review.identity === identity),
  );
  const missingRoles = required
    .filter((_, index) => !requiredReviews[index])
    .map(({ role }) => role);
  const overallScore = scoreReviews(requiredReviews.filter((review): review is Review => Boolean(review)));
  const lowReviewer = requiredReviews.find((review) => review && scoreReviews([review]) < MIN_REVIEWER_SCORE);
  const hasBlockingIssue = requiredReviews.some((review) => review?.issues.some((issue) => issue.severity === "blocker" || issue.severity === "major"));
  // 篇幅欠量（弧7 ch49 与弧5 ch32 成对实证）：蓝图声明 targetWordCount 后正文长度是
  // 系统可推导事实，reject→重出路径两次产出 1.4k 字骨架稿全绿过审——审校面（叙事
  // 质量）对计划兑现欠账失明。比率进 gate（拦而不杀：作者通道仍可批准），与
  // complete 旗/窗口同族：可推导事实不留裁量权。
  // 兑现率常量住 word-count.ts（唯一事实源）：项目级声明下限由它与稀疏线推导，两侧不得各持一份。
  const lengthUnderTarget = Boolean(
    length?.targetWordCount && length.targetWordCount >= 500
    && length.plainTextLength < Math.floor(length.targetWordCount * MIN_LENGTH_RATIO),
  );
  const qualityFailure = hasBlockingIssue
    ? "blocking-issue"
    : lowReviewer
      ? "reviewer-score"
      : requiredReviews.length > 0 && overallScore < MIN_AUTOMATIC_COMMIT_SCORE
        ? "overall-score"
        : lengthUnderTarget
          ? "length-under-target"
          : undefined;
  return {
    passed: missingRoles.length === 0
    && requiredReviews.every((review) => review?.verdict === "passed")
      && structuralReport.passed
      && !qualityFailure,
    reviewIds: currentReviews.map((review) => review.id),
    failedReviewIds: currentReviews.filter((review) => review.verdict !== "passed").map((review) => review.id),
    missingRoles,
    ...(qualityFailure ? { qualityFailure } : {}),
    ...(!structuralReport.passed ? { structuralFailure: "structural-blocker" as const } : {}),
    overallScore,
  };
}

export interface CandidateQualityKey {
  structuralPassed: boolean;
  blockerCount: number;
  majorCount: number;
  minimumReviewerScore: number;
  overallScore: number;
  /** Per-reviewer scores let the local degradation guard inspect every role, not just the minimum. */
  reviewerScores: Record<string, number>;
  /** warning 族计数：作全字段平手后的终位决胜（ch67 实证：一字之外全同的修订
   *  因质量键看不见 warning 级修复被判"未更好"而回滚，token 级修正永远活不下来）。 */
  warningCount: number;
}

export function candidateQualityKey(reviews: Review[], structuralReport: ManuscriptStructuralReport): CandidateQualityKey {
  const current = reviews.filter((review) => review.role !== "structural-validator");
  const scores = current.map((review) => scoreReviews([review]));
  const issueFamilies = buildRevisionBrief(current).clusters.map(({ issue }) => issue);
  const reviewerScores = Object.fromEntries(current.map((review) => [`${review.role}:${review.identity}`, scoreReviews([review])]));
  return {
    structuralPassed: structuralReport.passed,
    blockerCount: issueFamilies.filter((item) => item.severity === "blocker").length,
    majorCount: issueFamilies.filter((item) => item.severity === "major").length,
    minimumReviewerScore: scores.length ? Math.min(...scores) : 0,
    overallScore: scoreReviews(current),
    reviewerScores,
    warningCount: issueFamilies.filter((item) => item.severity === "warning").length,
  };
}

/**
 * 修订质量改善阈值：当修订稿的综合分数比基线高出此值，
 * 且未引入新 blocker/major、最低 reviewer 分数仍达标时，
 * 即使某个 reviewer 分数下降也接受修订。
 *
 * 根因：严格字典序比较会拒绝"整体改善但某维度略降"的修订，
 * 导致有效的部分改善被丢弃，修订流程陷入停滞。
 */
export const PARTIAL_IMPROVEMENT_THRESHOLD = 0.2;

/**
 * 单个 reviewer 分数最大允许下降幅度。
 * 与 PARTIAL_IMPROVEMENT_THRESHOLD 配合使用：即使整体改善达标，
 * 任何单个 reviewer 的分数下降不得超过此值，防止局部质量退化被整体改善掩盖。
 * 对齐 workflow-map.md §6.3"同类最高分"回退原则。
 */
export const MAX_REVIEWER_SCORE_DROP = 0.5;

export function isCandidateQualityBetter(candidate: CandidateQualityKey, currentBest: CandidateQualityKey): boolean {
  if (candidate.structuralPassed !== currentBest.structuralPassed) return candidate.structuralPassed;
  if (candidate.blockerCount !== currentBest.blockerCount) return candidate.blockerCount < currentBest.blockerCount;
  if (candidate.majorCount !== currentBest.majorCount) return candidate.majorCount < currentBest.majorCount;

  const baselineReviewerScores = Object.keys(currentBest.reviewerScores ?? {});
  const reviewerScoreDrop = baselineReviewerScores.length
    ? Math.max(...baselineReviewerScores.map((reviewer) => (currentBest.reviewerScores[reviewer] ?? 0) - (candidate.reviewerScores?.[reviewer] ?? 0)), 0)
    : currentBest.minimumReviewerScore - candidate.minimumReviewerScore;
  if (reviewerScoreDrop > MAX_REVIEWER_SCORE_DROP) return false;

  // Partial improvement acceptance: when the candidate has no more blockers/majors
  // than the current best (guaranteed by checks above), accept it if the overall
  // score improves meaningfully AND the minimum reviewer score stays above the
  // commit-gate threshold AND no single reviewer's score drops beyond the guarded
  // delta. This prevents rejecting revisions that improve overall quality but
  // slightly lower one reviewer's score, while preventing excessive local regression.
  const overallImprovement = candidate.overallScore - currentBest.overallScore;
  if (
    overallImprovement >= PARTIAL_IMPROVEMENT_THRESHOLD
    && candidate.minimumReviewerScore >= MIN_REVIEWER_SCORE
    && reviewerScoreDrop <= MAX_REVIEWER_SCORE_DROP
  ) {
    return true;
  }

  if (candidate.minimumReviewerScore !== currentBest.minimumReviewerScore) return candidate.minimumReviewerScore > currentBest.minimumReviewerScore;
  if (candidate.overallScore !== currentBest.overallScore) return candidate.overallScore > currentBest.overallScore;
  // 终位决胜（ch74 二次实证扩宽）：warning 更少者胜；warning 相等时保留新候选——
  // 填充/扩写/词级替换这类定向修订天然不移动任何键字段（质量不变即平手），旧语义
  // "平手即回退"让它们永远白烧一轮（ch58/ch65/ch74 三例同型）。退化维度已被上方
  // blocker/major/score/min 各层拦截，键全等意味着"可测维度无差异"，此时新候选
  // 承载的是作者点名的具体指令（配额/替换），保新是唯一能让这类修订存活的语义。
  return (candidate.warningCount ?? 0) <= (currentBest.warningCount ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// RC5: Named Entity Drift Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 提取文本中引号包裹的专有名词（角色名、物品名、地名等）。
 *
 * 检测中文引号「」、『』、""、'' 中长度 2-10 的内容，
 * 过滤掉明显不是专有名词的内容（如完整句子、常见词组）。
 */
function extractQuotedNames(text: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /「([^」]{2,10})」/g,
    /『([^』]{2,10})』/g,
    /\u201c([^\u201d]{2,10})\u201d/g, // "..."
    /\u2018([^\u2019]{2,10})\u2019/g, // '...'
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1].trim();
      // 引号也承载内省、疑问和动作概念；只把更接近命名标签的内容纳入漂移检测，
      // 避免普通叙事短语被误报为专名。该过滤按语言结构分类，不依赖具体作品词表。
      if (/^[我你他她它这那]|^(?:什|怎|哪|谁|何|为|是否|能否)/u.test(value)) continue;
      names.add(value);
    }
  }
  return names;
}

/**
 * 检测修订前后命名实体的漂移。
 *
 * 根因（RC5）：修订 LLM 在修复非一致性问题时，可能顺手改变其他已建立的
 * 专有名词（如把"枯荣"改成"定风波"）。这种事实漂移不会被质量分数检测到，
 * 因为分数只反映审核维度的改善，不检测未触及事实是否被保留。
 *
 * 检测策略：比较源文本和修订文本中引号包裹的专有名词集合。
 * - disappeared: 源文本有但修订文本没有的名称（可能被错误替换）
 * - appeared: 修订文本有但源文本没有的名称（可能是幻觉引入的新名称）
 *
 * 注意：这是一次检测，不自动拒绝修订。漂移结果应由调用方结合审核问题
 * 判断是否为预期变更（如一致性约束要求统一名称）。
 */
export interface NamedEntityDrift {
  disappeared: string[];
  appeared: string[];
  hasDrift: boolean;
}

export function detectNamedEntityDrift(sourceText: string, revisedText: string): NamedEntityDrift {
  const sourceNames = extractQuotedNames(sourceText);
  const revisedNames = extractQuotedNames(revisedText);
  const disappeared = [...sourceNames].filter((name) => !revisedNames.has(name));
  const appeared = [...revisedNames].filter((name) => !sourceNames.has(name));
  return {
    disappeared,
    appeared,
    hasDrift: disappeared.length > 0 || appeared.length > 0,
  };
}

/**
 * 修订决策：是否需要继续修订。
 *
 * 与 v1 shouldAutoRevise 等价但返回更丰富的决策对象（含 reason）。
 *
 * @param params.reviews 当前轮的 review 列表
 * @param params.iteration 当前修订轮次（0=首次审核，1=第一次修订后审核，...）
 * @param params.maxIterations 最大修订轮次（默认 2）
 * @param params.previousScore 上一轮分数（首次为 undefined）
 */
export function decideRevision(params: {
  reviews: Review[];
  iteration: number;
  maxIterations?: number;
  previousScore?: number;
}): RevisionDecision {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_AUTO_REVISIONS;
  const scoredReviews = params.reviews.filter((review) => review.role !== "structural-validator");
  const currentScore = scoreReviews(scoredReviews);
  const previousScore = params.previousScore;
  const improvement = previousScore === undefined ? Number.POSITIVE_INFINITY : currentScore - previousScore;
  const blocker = hasBlocker(params.reviews);
  const major = hasBlockerOrMajor(params.reviews);
  const evidence = classifyRevisionEvidence(params.reviews);
  const passed = allReviewsPassed(params.reviews);
  const belowQualityScore = hasQualityScoreFailure(params.reviews);

  let shouldRevise = false;
  let reason = "";

  if (passed && !belowQualityScore) {
    shouldRevise = false;
    reason = "所有 reviewer 通过";
  } else if (params.iteration >= maxIterations) {
    shouldRevise = false;
    reason = `达到修订上限 ${maxIterations} 轮，进入人工队列`;
  } else if (blocker) {
    shouldRevise = true;
    reason = `存在 blocker，必须修订（第 ${params.iteration + 1}/${maxIterations} 轮）`;
  } else if (belowQualityScore && (evidence === "major" || evidence === "quality-warning")) {
    shouldRevise = true;
    reason = evidence === "quality-warning"
      ? `质量分未达到自动定稿门槛，已有 warning 证据可执行修订（综合 ${currentScore.toFixed(2)} / ${MIN_AUTOMATIC_COMMIT_SCORE.toFixed(2)}）`
      : `质量分未达到自动定稿门槛，按 major 证据修订（综合 ${currentScore.toFixed(2)} / ${MIN_AUTOMATIC_COMMIT_SCORE.toFixed(2)}）`;
  } else if (belowQualityScore) {
    shouldRevise = false;
    reason = `质量分未达到自动定稿门槛但没有可定位审核证据（综合 ${currentScore.toFixed(2)} / ${MIN_AUTOMATIC_COMMIT_SCORE.toFixed(2)}），进入人工队列`;
  } else if (!major) {
    shouldRevise = false;
    reason = "无 blocker 或 major，仅 warning 可人工微调";
  } else if (improvement < MIN_IMPROVEMENT_THRESHOLD) {
    shouldRevise = false;
    reason = `改善度 ${improvement.toFixed(2)} < 阈值 ${MIN_IMPROVEMENT_THRESHOLD}，停止修订避免无限循环`;
  } else {
    shouldRevise = true;
    reason = previousScore === undefined
      ? `初始审校存在 major，建立修订基线（第 ${params.iteration + 1}/${maxIterations} 轮）`
      : `存在 major 且改善度 ${improvement.toFixed(2)} ≥ ${MIN_IMPROVEMENT_THRESHOLD}，继续修订（第 ${params.iteration + 1}/${maxIterations} 轮）`;
  }

  return {
    shouldRevise,
    reason,
    evidence,
    iteration: params.iteration,
    maxIterations,
    currentScore,
    previousScore,
    improvement: improvement === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : improvement,
    hasBlocker: blocker,
    hasMajor: major,
  };
}
