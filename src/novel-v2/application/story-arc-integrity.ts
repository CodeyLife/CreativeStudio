import { createHash } from "node:crypto";

/**
 * Shared structural diagnostics for story-arc planning.
 *
 * These checks operate on persisted references and chapter windows. They do
 * not prescribe chapter length, scene count, hooks, or literary treatment.
 */

export type StoryArcIntegritySeverity = "blocking" | "warning";

export interface StoryArcIntegrityIssue {
  code: "invalid-range" | "duplicate-batch" | "overlapping-batch" | "unknown-reference" | "ambiguous-reference";
  severity: StoryArcIntegritySeverity;
  message: string;
  batchIndex?: number;
  reference?: string;
  candidateIds?: string[];
}

export interface StoryArcBatchRange {
  batchIndex: number;
  startChapterIndex: number;
  endChapterIndex: number;
  status?: string;
}

export interface NamedReferenceCandidate {
  id: string;
  labels: string[];
}

export interface NamedReferenceResolution {
  input: string;
  status: "resolved" | "unknown" | "ambiguous";
  canonicalId?: string;
  candidateIds: string[];
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function activeRange(range: StoryArcBatchRange): boolean {
  return range.status !== "failed";
}

function overlaps(left: StoryArcBatchRange, right: StoryArcBatchRange): boolean {
  return left.startChapterIndex <= right.endChapterIndex && right.startChapterIndex <= left.endChapterIndex;
}

export function auditStoryArcBatchRanges(ranges: StoryArcBatchRange[]): StoryArcIntegrityIssue[] {
  const issues: StoryArcIntegrityIssue[] = [];
  const seen = new Set<number>();
  const active = ranges.filter(activeRange).slice().sort((left, right) => left.startChapterIndex - right.startChapterIndex || left.batchIndex - right.batchIndex);

  for (const range of ranges) {
    if (!Number.isInteger(range.batchIndex) || range.batchIndex < 1 || !Number.isInteger(range.startChapterIndex) || range.startChapterIndex < 1 || !Number.isInteger(range.endChapterIndex) || range.endChapterIndex < range.startChapterIndex) {
      issues.push({ code: "invalid-range", severity: "blocking", batchIndex: range.batchIndex, message: `批次 ${range.batchIndex} 的章节区间无效：${range.startChapterIndex}-${range.endChapterIndex}` });
    }
    if (seen.has(range.batchIndex)) {
      issues.push({ code: "duplicate-batch", severity: "blocking", batchIndex: range.batchIndex, message: `批次 ${range.batchIndex} 重复出现` });
    }
    seen.add(range.batchIndex);
  }

  let previous = active[0];
  for (let index = 1; index < active.length; index += 1) {
    const current = active[index];
    if (overlaps(previous, current)) {
      issues.push({
        code: "overlapping-batch",
        severity: "blocking",
        batchIndex: current.batchIndex,
        message: `批次 ${previous.batchIndex}（${previous.startChapterIndex}-${previous.endChapterIndex}）与批次 ${current.batchIndex}（${current.startChapterIndex}-${current.endChapterIndex}）存在章节区间重叠`,
      });
    }
    if (current.endChapterIndex > previous.endChapterIndex) previous = current;
  }
  return issues;
}

export function resolveNamedReference(input: string, candidates: NamedReferenceCandidate[]): NamedReferenceResolution {
  const value = input.trim();
  if (!value) return { input, status: "unknown", candidateIds: [] };

  const exactId = candidates.filter((candidate) => candidate.id === value).map((candidate) => candidate.id);
  if (exactId.length === 1) return { input, status: "resolved", canonicalId: exactId[0], candidateIds: exactId };

  const normalized = normalizedLabel(value);
  const matches = candidates
    .filter((candidate) => [candidate.id, ...candidate.labels].some((label) => normalizedLabel(label) === normalized))
    .map((candidate) => candidate.id)
    .filter((id, index, all) => all.indexOf(id) === index);
  if (matches.length === 1) return { input, status: "resolved", canonicalId: matches[0], candidateIds: matches };
  if (matches.length > 1) return { input, status: "ambiguous", candidateIds: matches };
  return { input, status: "unknown", candidateIds: [] };
}

export function normalizeThreadResponsibilityReferences<T extends { threadRef: string }>(
  responsibilities: T[],
  candidates: NamedReferenceCandidate[],
): T[] {
  return responsibilities.map((responsibility) => {
    const resolution = resolveNamedReference(responsibility.threadRef, candidates);
    if (resolution.status === "ambiguous") {
      throw new Error(`剧情线责任引用“${responsibility.threadRef}”匹配多个对象：${resolution.candidateIds.join("、")}`);
    }
    return resolution.status === "resolved" && resolution.canonicalId
      ? { ...responsibility, threadRef: resolution.canonicalId }
      : responsibility;
  });
}

export function canonicalReferenceId(kind: "thread" | "foreshadowing", projectId: string, input: string): string {
  const digest = createHash("sha256").update(`${projectId}\n${normalizedLabel(input)}`).digest("hex").slice(0, 16);
  return `${kind}:${projectId}:${digest}`;
}

export function auditNamedReferences(input: string[], candidates: NamedReferenceCandidate[]): { resolutions: NamedReferenceResolution[]; issues: StoryArcIntegrityIssue[] } {
  const resolutions = input.map((value) => resolveNamedReference(value, candidates));
  const issues: StoryArcIntegrityIssue[] = resolutions.flatMap((resolution): StoryArcIntegrityIssue[] => {
    if (resolution.status === "resolved") return [];
    if (resolution.status === "ambiguous") return [{ code: "ambiguous-reference" as const, severity: "blocking" as const, reference: resolution.input, candidateIds: resolution.candidateIds, message: `引用“${resolution.input}”匹配多个对象：${resolution.candidateIds.join("、")}` }];
    return [{ code: "unknown-reference" as const, severity: "blocking" as const, reference: resolution.input, candidateIds: [], message: `引用“${resolution.input}”无法解析为当前项目对象` }];
  });
  return { resolutions, issues };
}
