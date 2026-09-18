import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCompleteChapterReviewEvidence } from "../application/chapter-approval";
import { inspectManuscript } from "../application/manuscript-structure";
import type { Artifact, Review, ReviewIssue } from "../protocol";
import {
  allReviewsPassed,
  candidateQualityKey,
  decideRevision,
  DEFAULT_MAX_AUTO_REVISIONS,
  detectNamedEntityDrift,
  evaluateCommitGate,
  hasBlocker,
  hasBlockerOrMajor,
  isCandidateQualityBetter,
  scoreReviews,
} from "../temporal/revision-policy";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 0, createdAt: 1, fingerprint: "fp-1" };
const structuralReport = inspectManuscript({ text: "正文" });

function issue(severity: ReviewIssue["severity"], title = "issue"): ReviewIssue {
  return { severity, title, evidence: `evidence-${title}`, excerpt: `evidence-${title}`, revisionRanges: [{ start: 1, end: 1 }] };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: "review-1",
    projectId: "p1",
    artifactId: artifact.id,
    reviewerId: "internal-structure",
    identity: "internal",
    role: "structure-reviewer",
    verdict: "passed",
    issues: [],
    score: 4.2,
    createdAt: 2,
    artifactFingerprint: artifact.fingerprint,
    ...overrides,
  };
}

function completeReviews(overrides: Partial<Record<"structure" | "character" | "prose", Partial<Review>>> = {}): Review[] {
  return [
    makeReview({ id: "structure", role: "structure-reviewer", identity: "internal", ...(overrides.structure ?? {}) }),
    makeReview({ id: "character", role: "character-reviewer", identity: "independent", ...(overrides.character ?? {}) }),
    makeReview({ id: "prose", role: "prose-reviewer", identity: "independent", ...(overrides.prose ?? {}) }),
  ];
}

describe("revision-policy", () => {
  it("scores persisted reviewer totals and falls back to severity when absent", () => {
    expect(scoreReviews(completeReviews())).toBeCloseTo(4.2, 5);
    expect(scoreReviews([makeReview({ score: undefined, issues: [issue("blocker"), issue("major")] })])).toBe(3);
  });

  it("commit gate requires the three current reviewer roles", () => {
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport)).toMatchObject({ passed: true, missingRoles: [] });
    expect(evaluateCommitGate(completeReviews().slice(0, 2), artifact.fingerprint, structuralReport)).toMatchObject({
      passed: false,
      missingRoles: ["prose-reviewer"],
    });
  });

  it("does not allow approval while a required reviewer is missing", () => {
    expect(() => assertCompleteChapterReviewEvidence("approve", ["structure-reviewer"])).toThrow(/缺少必要的审核证据/);
    expect(() => assertCompleteChapterReviewEvidence("revise", ["structure-reviewer"])).not.toThrow();
    expect(() => assertCompleteChapterReviewEvidence("approve", [])).not.toThrow();
  });

  it("rejects blockers, majors and low local reviewer scores", () => {
    expect(hasBlocker([makeReview({ issues: [issue("blocker")] })])).toBe(true);
    expect(hasBlockerOrMajor([makeReview({ issues: [issue("major")] })])).toBe(true);
    expect(evaluateCommitGate(completeReviews({ prose: { score: 3.2 } }), artifact.fingerprint, structuralReport)).toMatchObject({ passed: false, qualityFailure: "reviewer-score" });
  });

  it("篇幅欠量门：声明目标下不足 60% 拦、达标与未声明放行（弧7 ch49/弧5 ch32 重出短稿实证）", () => {    // 双向 1：全绿审稿 + 900/3000 字 → length-under-target 独扛拦截（此前该形态全过静默定稿）。
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport, undefined, { plainTextLength: 900, targetWordCount: 3000 }))
      .toMatchObject({ passed: false, qualityFailure: "length-under-target" });
    // 双向 2：达标比例放行；边界 1800/3000 = 恰好 60% 放行（floor 语义）。
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport, undefined, { plainTextLength: 2200, targetWordCount: 3000 }).passed).toBe(true);
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport, undefined, { plainTextLength: 1800, targetWordCount: 3000 }).passed).toBe(true);
    // 双向 3：未声明目标/低于 500 的小目标（安静过渡章合法声明）不检查。
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport, undefined, { plainTextLength: 200 }).passed).toBe(true);
    expect(evaluateCommitGate(completeReviews(), artifact.fingerprint, structuralReport, undefined, { plainTextLength: 200, targetWordCount: 400 }).passed).toBe(true);
    // 双向 4：优先级链不劫持——blocker/major 仍报 blocking-issue。
    expect(evaluateCommitGate(completeReviews({ prose: { issues: [issue("major")] } }), artifact.fingerprint, structuralReport, undefined, { plainTextLength: 300, targetWordCount: 3000 }))
      .toMatchObject({ passed: false, qualityFailure: "blocking-issue" });
  });

  it("workflow bundle 导入方向锁：workflows.ts 不得值导入 prompts/*（弧8 提交即炸 worker 实证）", async () => {
    // Temporal workflow bundle 只允许无 node 依赖的纯导入链；prompts 模块经
    // application/story-arc 的值导入会击穿 webpack（worker 起不来、task queue 停摆，
    // watchdog 按端口探测只会反复重启崩溃进程）。共享常量必须住叶子纯模块。
    const source = readFileSync(fileURLToPath(new URL("../temporal/workflows.ts", import.meta.url)), "utf8");
    // `import type` 被编译器擦除，webpack 不可见（现存的 prompts 类型导入合法）；
    // 值导入（命名/默认/副作用）才会把 prompts 依赖链拖进 bundle。
    const valueImports = source.split("\n").filter((line) => /from "\.\.\/prompts\//.test(line) && !/^\s*import\s+type\s/.test(line));
    expect(valueImports).toEqual([]);
    // 反例面自检：本轮修复确实把常量改从纯模块取用（导入存在且方向正确）。
    expect(source).toMatch(/from "\.\.\/word-count"/);
    // 篇幅门接线锁（ch52 1222 字漏网实证）：生成流 novelIntentWorkflow 的 lifecycle
    // 调用必须带 targetWordCount——首轮只接了 review 流，短稿照样静默定稿。
    const intentStart = source.indexOf("export async function novelIntentWorkflow");
    const intentEnd = source.indexOf("export async function bookSynopsisWorkflow", intentStart);
    const intentSection = source.slice(intentStart, intentEnd);
    expect(intentSection.match(/targetWordCount:/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps local degradation guard while allowing meaningful overall improvement", () => {
    const current = candidateQualityKey(completeReviews({ structure: { score: 4.0 }, character: { score: 4.0 }, prose: { score: 4.0 } }), structuralReport);
    const better = candidateQualityKey(completeReviews({ structure: { score: 3.8 }, character: { score: 4.7 }, prose: { score: 4.4 } }), structuralReport);
    const degraded = candidateQualityKey(completeReviews({ structure: { score: 3.0 }, character: { score: 5.0 }, prose: { score: 5.0 } }), structuralReport);
    expect(isCandidateQualityBetter(better, current)).toBe(true);
    expect(isCandidateQualityBetter(degraded, current)).toBe(false);
  });

  it("revision decisions stop after pass or max iteration", () => {
    expect(allReviewsPassed(completeReviews())).toBe(true);
    expect(decideRevision({ reviews: completeReviews(), iteration: 0 }).shouldRevise).toBe(false);
    expect(decideRevision({ reviews: [makeReview({ verdict: "blocked", issues: [issue("blocker")] })], iteration: DEFAULT_MAX_AUTO_REVISIONS }).shouldRevise).toBe(false);
  });

  it("does not treat quoted introspection as named-entity drift", () => {
    expect(detectNamedEntityDrift("他反复问‘我是谁’和‘为什么’，没有出现专名。", "他咽下疑问，改看向‘赤铜令’。")).toMatchObject({
      disappeared: [],
      appeared: ["赤铜令"],
      hasDrift: true,
    });
    expect(detectNamedEntityDrift("他握住‘赤铜令’。", "他松开手，空无一物。")).toMatchObject({
      disappeared: ["赤铜令"],
      appeared: [],
      hasDrift: true,
    });
  });

  it("全平手 warning 终位决胜+平 warning 保新（ch67 复读回滚与 ch74 填充回滚双实证）", () => {
    const base = { structuralPassed: true, blockerCount: 0, majorCount: 0, minimumReviewerScore: 4.5, overallScore: 4.5, reviewerScores: { "prose-reviewer:internal": 4.5 } };
    const withWarning = { ...base, warningCount: 1 };
    const clean = { ...base, warningCount: 0 };
    // 修掉 warning 的新候选在其余全平手中胜出。
    expect(isCandidateQualityBetter(clean, withWarning)).toBe(true);
    // 对称：新增 warning 者回退。
    expect(isCandidateQualityBetter(withWarning, clean)).toBe(false);
    // 全等（填充/扩写类修订的键形态）保新——作者点名的配额修订若不保新即永远白烧
    // （ch58/ch65/ch74 三例同型回滚）；退化维度已由上方 blocker/major/score 各层拦截。
    expect(isCandidateQualityBetter({ ...clean }, { ...clean })).toBe(true);
  });
});
