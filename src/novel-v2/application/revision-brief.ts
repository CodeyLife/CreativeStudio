import { canonicalSha256 } from "../canonical-json";
import type { Review, ReviewIssue } from "../protocol";

export interface RevisionIssueCluster {
  id: string;
  mechanism: string;
  issue: ReviewIssue;
  sourceIssueFingerprints: string[];
  sourceRoles: string[];
}

export interface RevisionDirectiveConflict {
  clusterId: string;
  mechanism: string;
  sourceIssueFingerprints: string[];
  directives: string[];
}

export interface RevisionBrief {
  issues: ReviewIssue[];
  clusters: RevisionIssueCluster[];
  conflicts: RevisionDirectiveConflict[];
}

interface SourceIssue {
  issue: ReviewIssue;
  role: string;
  fingerprint: string;
}

const severityRank: Record<ReviewIssue["severity"], number> = { warning: 1, major: 2, blocker: 3 };

function normalize(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function sourceIssueFingerprint(issue: ReviewIssue): string {
  return canonicalSha256([normalize(issue.title), normalize(issue.excerpt ?? issue.evidence), normalize(issue.rule)].join("\u0000"));
}

function rangeKey(issue: ReviewIssue): string {
  if (issue.revisionRanges?.length) {
    return issue.revisionRanges
      .map(({ start, end }) => `${Math.min(start, end)}-${Math.max(start, end)}`)
      .sort()
      .join(",");
  }
  if (issue.paragraph) return `${issue.paragraph}-${issue.paragraph}`;
  return canonicalSha256(normalize(issue.excerpt ?? issue.evidence)).slice(0, 16);
}

function mechanismKey(issue: ReviewIssue): string {
  const declaredRule = normalize(issue.rule);
  const mechanism = declaredRule || normalize(issue.title);
  return `${rangeKey(issue)}:${mechanism}`;
}

function evidenceBigrams(issue: ReviewIssue): Set<string> {
  const value = normalize(issue.excerpt ?? issue.evidence).replace(/[^\u4e00-\u9fffA-Za-z0-9]/gu, "");
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function evidenceSimilarity(left: ReviewIssue, right: ReviewIssue): number {
  const a = evidenceBigrams(left);
  const b = evidenceBigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function mechanismSimilarity(left: ReviewIssue, right: ReviewIssue): number {
  const value = (issue: ReviewIssue) => [issue.title, issue.description, issue.suggestion, issue.rule].filter(Boolean).join(" ");
  const similarity = (leftText: string, rightText: string): number => {
    const a = leftText.toLowerCase().replace(/[^\u4e00-\u9fffA-Za-z0-9]/gu, "");
    const b = rightText.toLowerCase().replace(/[^\u4e00-\u9fffA-Za-z0-9]/gu, "");
    const leftBigrams = new Set([...Array(Math.max(0, a.length - 1))].map((_, index) => a.slice(index, index + 2)));
    const rightBigrams = new Set([...Array(Math.max(0, b.length - 1))].map((_, index) => b.slice(index, index + 2)));
    if (!leftBigrams.size || !rightBigrams.size) return 0;
    let intersection = 0;
    for (const value of leftBigrams) if (rightBigrams.has(value)) intersection += 1;
    return intersection / new Set([...leftBigrams, ...rightBigrams]).size;
  };
  const combinedSimilarity = similarity(value(left), value(right));
  const titleSimilarity = similarity(left.title, right.title);
  const ruleSimilarity = similarity(left.rule ?? "", right.rule ?? "");
  // 长描述会稀释同一机制的短标题/规则。分别比较标签后再取最大值，
  // 才能把跨段落、跨 reviewer 的同类安全窗口合并起来。
  return Math.max(combinedSimilarity, titleSimilarity, ruleSimilarity);
}

function rangesOverlap(left: ReviewIssue, right: ReviewIssue): boolean {
  const leftRanges = left.revisionRanges ?? (left.paragraph ? [{ start: left.paragraph, end: left.paragraph }] : []);
  const rightRanges = right.revisionRanges ?? (right.paragraph ? [{ start: right.paragraph, end: right.paragraph }] : []);
  return leftRanges.some((a) => rightRanges.some((b) => Math.max(a.start, b.start) <= Math.min(a.end, b.end)));
}

function canMergeIssues(left: ReviewIssue, right: ReviewIssue): boolean {
  const leftRule = normalize(left.rule);
  const rightRule = normalize(right.rule);
  const leftEvidence = normalize(left.excerpt ?? left.evidence);
  const rightEvidence = normalize(right.excerpt ?? right.evidence);
  // 同一通用规则在不同段落出现时，必须共享一个修订簇，否则局部修订会被误当成全局修复。
  if (leftRule && leftRule === rightRule) return true;
  if (!rangesOverlap(left, right)) return mechanismSimilarity(left, right) >= 0.08;
  if (leftEvidence === rightEvidence) return Boolean(leftRule && leftRule === rightRule);
  return evidenceSimilarity(left, right) >= 0.2 || mechanismSimilarity(left, right) >= 0.08;
}

type DirectiveOperation = "preserve" | "remove" | "replace";

interface DirectiveAction {
  operation: DirectiveOperation;
  target: string;
}

const directivePatterns: Array<{ operation: DirectiveOperation; pattern: RegExp }> = [
  { operation: "remove", pattern: /(?:不得保留|不要保留|不得确认|不要确认|避免确认|删除|删去|移除|去掉|取消|remove|delete|omit)/giu },
  { operation: "preserve", pattern: /(?:不要改写|不得改写|不要改|不得改|保留|保持|维持|keep|preserve|retain)/giu },
  { operation: "replace", pattern: /(?:改写为|修正为|替换为|改为|改成|替换|replace|rename|change\s+to)/giu },
];

function directiveActions(value: string): DirectiveAction[] {
  const clauses = value
    .split(/[，。；;！!？?\n]|(?:但|同时|并且)/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const actions: DirectiveAction[] = [];
  for (const clause of clauses) {
    const matches = directivePatterns.flatMap(({ operation, pattern }) => {
      pattern.lastIndex = 0;
      return [...clause.matchAll(pattern)].map((match) => ({ operation, index: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
    }).sort((left, right) => left.index - right.index || right.end - left.end);
    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const target = normalize(clause.slice(current.end, next?.index ?? clause.length))
        .replace(/^(?:直接|仅仅|仅|只|应当|应该|应|必须|须|继续|仍然|将|把)\s*/u, "")
        .replace(/^(?:the\s+)?/u, "")
        .trim();
      if (target) actions.push({ operation: current.operation, target });
    }
  }
  return actions;
}

function targetBigrams(value: string): Set<string> {
  const compact = normalize(value).replace(/[^\u4e00-\u9fffA-Za-z0-9]/gu, "");
  const result = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) result.add(compact.slice(index, index + 2));
  return result;
}

function sameDirectiveTarget(left: string, right: string): boolean {
  const a = targetBigrams(left);
  const b = targetBigrams(right);
  if (!a.size || !b.size) return false;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / Math.min(a.size, b.size) >= 0.3;
}

function operationsConflict(left: DirectiveOperation, right: DirectiveOperation): boolean {
  if (left === right) return false;
  return left === "preserve" || right === "preserve" || left === "remove" || right === "remove";
}

function incompatibleDirectives(group: SourceIssue[]): boolean {
  const actions = group.map((source) => directiveActions(source.issue.suggestion ?? ""));
  for (let leftIndex = 0; leftIndex < actions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < actions.length; rightIndex += 1) {
      if (actions[leftIndex].some((left) => actions[rightIndex].some((right) => operationsConflict(left.operation, right.operation) && sameDirectiveTarget(left.target, right.target)))) return true;
    }
  }
  return false;
}

function mergeRanges(group: SourceIssue[]): Array<{ start: number; end: number }> | undefined {
  const ranges = group.flatMap(({ issue }) => issue.revisionRanges ?? (issue.paragraph ? [{ start: issue.paragraph, end: issue.paragraph }] : []));
  if (!ranges.length) return undefined;
  const sorted = ranges
    .map(({ start, end }) => ({ start: Math.min(start, end), end: Math.max(start, end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function mergeGroup(group: SourceIssue[]): RevisionIssueCluster {
  const ordered = [...group].sort((left, right) => severityRank[right.issue.severity] - severityRank[left.issue.severity] || left.fingerprint.localeCompare(right.fingerprint));
  const representative = ordered[0].issue;
  const suggestions = [...new Set(ordered.map(({ issue }) => issue.suggestion?.trim()).filter((value): value is string => Boolean(value)))];
  const sourceIssueFingerprints = [...new Set(ordered.map(({ fingerprint }) => fingerprint))].sort();
  const mechanism = normalize(representative.rule) || normalize(representative.title);
  const id = `revision-cluster:${canonicalSha256({ mechanism: mechanismKey(representative), sourceIssueFingerprints }).slice(0, 20)}`;
  return {
    id,
    mechanism,
    sourceIssueFingerprints,
    sourceRoles: [...new Set(ordered.map(({ role }) => role))].sort(),
    issue: {
      ...representative,
      severity: ordered[0].issue.severity,
      revisionRanges: mergeRanges(ordered),
      suggestion: suggestions.join("；") || representative.suggestion,
      sourceId: id,
    },
  };
}

export interface RevisionBriefOptions {
  /** 仅当质量门因低分触发修订时开启；普通自动修订仍聚焦 blocker/major。 */
  includeWarnings?: boolean;
  /** 定向修订时，把当前 reviewer 发现的同机制安全窗口并入作者选中的 issue。 */
  includeDirectedReviewEvidence?: boolean;
}

/**
 * 作者已经给出明确修订要求时，冲突的 reviewer 指令属于可丢弃的辅助证据；
 * 没有作者裁决时仍阻断自动修订，避免流程在互斥建议中自行选边。
 */
export function shouldBlockRevisionForConflicts(conflicts: RevisionDirectiveConflict[], hasAuthorInstruction: boolean): boolean {
  return conflicts.length > 0 && !hasAuthorInstruction;
}

export function buildRevisionBrief(reviews: Review[], directedIssues?: ReviewIssue[], options: RevisionBriefOptions = {}): RevisionBrief {
  const includedSeverities = options.includeWarnings ? new Set(["blocker", "major", "warning"]) : new Set(["blocker", "major"]);
  const reviewSources: SourceIssue[] = reviews.flatMap((review) => review.issues
    .filter((issue) => includedSeverities.has(issue.severity))
    .map((issue) => ({ issue, role: review.role ?? review.reviewerId, fingerprint: sourceIssueFingerprint(issue) })));
  const sources: SourceIssue[] = directedIssues
    ? [
        ...directedIssues.map((issue) => ({ issue, role: "directed", fingerprint: sourceIssueFingerprint(issue) })),
        ...(options.includeDirectedReviewEvidence ? reviewSources : []),
      ]
    : reviewSources;
  const groups: SourceIssue[][] = [];
  for (const source of sources) {
    const matchedIndexes = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.some((candidate) => canMergeIssues(candidate.issue, source.issue)))
      .map(({ index }) => index);
    if (!matchedIndexes.length) {
      groups.push([source]);
      continue;
    }
    const [targetIndex, ...mergedIndexes] = matchedIndexes;
    groups[targetIndex].push(source);
    for (const index of [...mergedIndexes].sort((left, right) => right - left)) {
      groups[targetIndex].push(...groups[index]);
      groups.splice(index, 1);
    }
  }

  const clusters: RevisionIssueCluster[] = [];
  const conflicts: RevisionDirectiveConflict[] = [];
  for (const group of groups) {
    const cluster = mergeGroup(group);
    clusters.push(cluster);
    if (incompatibleDirectives(group)) {
      conflicts.push({
        clusterId: cluster.id,
        mechanism: cluster.mechanism,
        sourceIssueFingerprints: cluster.sourceIssueFingerprints,
        directives: [...new Set(group.map(({ issue }) => issue.suggestion?.trim()).filter((value): value is string => Boolean(value)))],
      });
      continue;
    }
  }
  const conflictedIds = new Set(conflicts.map(({ clusterId }) => clusterId));
  const visibleClusters = options.includeDirectedReviewEvidence
    ? clusters.filter(({ sourceRoles }) => sourceRoles.includes("directed"))
    : clusters;
  return { issues: visibleClusters.filter(({ id }) => !conflictedIds.has(id)).map(({ issue }) => issue), clusters, conflicts };
}

export function buildRevisionDirection(input: { directedIssues?: ReviewIssue[]; authorInstruction?: string; chapterParagraphCount?: number }) {
  const authorInstruction = input.authorInstruction?.trim() || undefined;
  const directedIssues = input.directedIssues;
  const requiresWholeChapter = Boolean(directedIssues?.some((issue) =>
    issue.severity !== "warning"
      && !issue.revisionRanges?.length,
  ));
  // 当修订窗口覆盖比例过高（>40%）时，问题实际上是跨场景结构性的，
  // 局部窗口修补无法解决，应自动升级为整章修订。
  const windowedParagraphs = directedIssues?.flatMap((issue) => issue.revisionRanges ?? [])
    .reduce((acc, range) => acc + (range.end - range.start + 1), 0) ?? 0;
  const excessiveWindowCoverage = Boolean(input.chapterParagraphCount && input.chapterParagraphCount > 0
    && windowedParagraphs / input.chapterParagraphCount > 0.4);
  return {
    directedIssues,
    authorInstruction,
    strictRevisionWindows: Boolean(directedIssues?.length && !requiresWholeChapter && !excessiveWindowCoverage && directedIssues.every((issue) => issue.revisionRanges?.length)),
  };
}
