import { createHash } from "node:crypto";

/**
 * Shared structural diagnostics for story-arc planning.
 *
 * These checks operate on persisted references and chapter windows. They do
 * not prescribe chapter length, scene count, hooks, or literary treatment.
 */

export type StoryArcIntegritySeverity = "blocking" | "warning";

export interface StoryArcIntegrityIssue {
  code: "invalid-range" | "duplicate-batch" | "overlapping-batch" | "unknown-reference" | "ambiguous-reference" | "embedded-identifier" | "completion-count-mismatch" | "ledger-inconsistency" | "foreshadowing-duplicate" | "foreshadowing-arc-orphan" | "stale-foundation-contract" | "serialization-gap" | "arc-planning-failures" | "phase-binding-missing";
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

  // 复合引用自愈（product-audit-20260910 A4/PL-2）：历史快照把 canonicalId 与显示名
  // 拼成复合串（"<threadId> <slug>"）并逐轮复制放大。只要串内嵌了恰好一个已存在的
  // id token，就以该 id 为准——id 是结构事实，显示名是易变文本，冲突面永远取前者。
  const idTokens = value.split(/[\s,，、;；|]+/u).filter((token) => candidates.some((candidate) => candidate.id === token));
  const distinctIds = [...new Set(idTokens)];
  if (distinctIds.length === 1) return { input, status: "resolved", canonicalId: distinctIds[0], candidateIds: distinctIds };
  if (distinctIds.length > 1) return { input, status: "ambiguous", candidateIds: distinctIds };

  // typed-id 键代际容错（弧10 批准双代际键实证）：账本混有早期 `foreshadowing:proj:HASH`
  // 与 PL-5③ 的 `foreshadowing:proj:anchor:HASH` 两种键形，planner 按列表中的主导格式
  // 拼引用，另一代际的行就整批悬空。typed id 的尾段即项目内对象身份（内容/锚点哈希，
  // 12 hex 域内无碰撞）：精确匹配未中时按尾段重试一次——唯一命中才 resolved，多命中仍
  // ambiguous，零命中仍 unknown；不对自然语言名放宽任何引用面。
  const segments = value.split(":");
  if (segments.length >= 3) {
    const tail = segments[segments.length - 1];
    if (tail) {
      const tailHits = [...new Set(candidates.filter((candidate) => candidate.id.split(":").pop() === tail).map((candidate) => candidate.id))];
      if (tailHits.length === 1) return { input, status: "resolved", canonicalId: tailHits[0], candidateIds: tailHits };
      if (tailHits.length > 1) return { input, status: "ambiguous", candidateIds: tailHits };
      // ID 语法归一（弧14 批准现场实证：planner 在真实 12-hex 哈希后拖挂 `_ref_unused`
      // 一类自造装饰标记，制造出"半个真 id"的悬空引用）：对象哈希域的语法是 12 位
      // hex、装饰不是——把 `HEX12_任意尾巴` 归一为 HEX12 再按尾段重试一次，命中规则
      // 与上方完全一致（唯一才 resolved，多命中 ambiguous，零命中继续走不放宽）。
      const bare = /^([0-9a-f]{12})[_].+$/u.exec(tail);
      if (bare) {
        const bareHits = [...new Set(candidates.filter((candidate) => candidate.id.split(":").pop() === bare[1]).map((candidate) => candidate.id))];
        if (bareHits.length === 1) return { input, status: "resolved", canonicalId: bareHits[0], candidateIds: bareHits };
        if (bareHits.length > 1) return { input, status: "ambiguous", candidateIds: bareHits };
      }
    }
  }

  const normalized = normalizedLabel(value);
  const matches = candidates
    .filter((candidate) => [candidate.id, ...candidate.labels].some((label) => normalizedLabel(label) === normalized))
    .map((candidate) => candidate.id)
    .filter((id, index, all) => all.indexOf(id) === index);
  if (matches.length === 1) return { input, status: "resolved", canonicalId: matches[0], candidateIds: matches };
  if (matches.length > 1) return { input, status: "ambiguous", candidateIds: matches };
  return { input, status: "unknown", candidateIds: [] };
}

/**
 * 引用字段的结构净化（PL-2 修复③的引用面）。只按形态规则处理，不做语义改写：
 * - 显式新建通道：`new:` / `新建:` 前缀 = 作者/planner 有意识的新建对象意图（保留，
 *   见 parseExplicitNewReference）；
 * - 前导序号标签剥离：模型回显列表时的 `弧3：`、`Arc 2:`、`3、` 等编号前缀不是名称
 *   的一部分。限定"序号+分隔冒号/点"形态，不误吃"第一章的雨"这类合法标题。
 */
const EXPLICIT_NEW_PATTERN = /^(?:new|新建|新增)\s*[:：]\s*/iu;
const LEADING_INDEX_LABEL_PATTERN = /^(?:弧|卷|部|幕|阶段|phase|arc|part|act|chapter|章)\s*\d+\s*[:：.、-]\s*/iu;
const LEADING_ENUMERATION_PATTERN = /^\d{1,2}\s*[.、:：)）]\s*(?=[^\s\d])/u;

export function parseExplicitNewReference(input: string): { name: string } | undefined {
  const match = input.trim().match(EXPLICIT_NEW_PATTERN);
  if (!match) return undefined;
  const name = input.trim().slice(match[0].length).trim();
  return name ? { name } : undefined;
}

export function sanitizeReferenceToken(input: string): string {
  let value = input.trim();
  for (;;) {
    const stripped = value.replace(LEADING_INDEX_LABEL_PATTERN, "").replace(LEADING_ENUMERATION_PATTERN, "").trim();
    if (stripped === value) return value;
    value = stripped;
  }
}

/**
 * 自由文本中内联的内部标识符检测（PL-2 修复③的展示面）：canonical id、hex 片段、
 * 内部章节引用等机器记号泄漏进人类可读文本，会让下游模型把它们当可复制的引用值
 * 而自我放大。按通用形态（kind:prefix、≥12位hex、ch/章+数字）报告，不用词表。
 */
export function findEmbeddedInternalIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:thread|foreshadowing|promise|claim|foundation|artifact|arc|chapter|document|revision):[A-Za-z0-9:_-]{8,}/gu)) found.add(match[0]);
  for (const match of text.matchAll(/\b[0-9a-f]{12,}\b/gu)) found.add(match[0]);
  for (const match of text.matchAll(/\bch\d+\b/giu)) found.add(match[0]);
  return [...found];
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

/**
 * 伏笔→剧情线归属计划（PL-5④ 的判据面收口，2026-09-19）。
 *
 * `foreshadowing.thread_id` 是单值列，"哪条线承担这条伏笔"因此只能是**声明**，不能是推断。
 * 旧判据"本弧恰好一条线程责任时把本弧引用的开放伏笔全绑过去"在真实数据上恒不命中：
 * 实测本项目 24 条弧的 threadResponsibilities 全部声明 4-7 条线 ⇒ 可绑弧 0 条、
 * 全表 thread_id 绑定 0 行（见 product-audit-20260910 §五）。归属证据改由线程自己带
 * （threadResponsibilities[].foreshadowingRefs），本函数只做保守判定，不碰数据库，
 * 因此弧审核面与回填面可共用同一判据。
 *
 * 规则：
 * - 线程只能认领**本弧伏笔账内**的引用（入参应已完成 raw→canonical 翻译）；账外认领
 *   返回 violations 交调用方按 blocking 回流，既不静默丢弃也不新建对象；
 * - 同一条伏笔被多条线同时认领 ⇒ 单值列无法表达共同承担，不绑定，但计入 ambiguous
 *   留痕（静默跳过与静默失败同罪），由作者/下弧修订收敛为单一承担者。
 */
export function planThreadForeshadowingBindings(input: {
  arcForeshadowingRefs: readonly string[];
  responsibilities: readonly { threadRef: string; foreshadowingRefs?: readonly string[] }[];
}): { bindings: Array<{ threadId: string; foreshadowingIds: string[] }>; violations: Array<{ threadRef: string; input: string }>; ambiguous: string[] } {
  const allowed = new Set(input.arcForeshadowingRefs);
  const violations: Array<{ threadRef: string; input: string }> = [];
  const owners = new Map<string, Set<string>>();
  for (const responsibility of input.responsibilities) {
    for (const ref of responsibility.foreshadowingRefs ?? []) {
      if (!allowed.has(ref)) {
        violations.push({ threadRef: responsibility.threadRef, input: ref });
        continue;
      }
      owners.set(ref, (owners.get(ref) ?? new Set<string>()).add(responsibility.threadRef));
    }
  }
  const byThread = new Map<string, string[]>();
  const ambiguous: string[] = [];
  for (const [foreshadowingId, threadRefs] of owners) {
    if (threadRefs.size !== 1) {
      ambiguous.push(foreshadowingId);
      continue;
    }
    const threadId = [...threadRefs][0]!;
    byThread.set(threadId, [...(byThread.get(threadId) ?? []), foreshadowingId]);
  }
  return { bindings: [...byThread].map(([threadId, foreshadowingIds]) => ({ threadId, foreshadowingIds })), violations, ambiguous: ambiguous.sort() };
}

export function canonicalReferenceId(kind: "thread" | "foreshadowing", projectId: string, input: string): string {
  const digest = createHash("sha256").update(`${projectId}\n${normalizedLabel(input)}`).digest("hex").slice(0, 16);
  return `${kind}:${projectId}:${digest}`;
}

/**
 * 弧完成判定的单一真源 SQL（product-audit-20260910 B1/PL-1）。
 *
 * 根因：旧谓词把**全局章序**（末个已批准批次的 end_chapter_index）与**弧内期望章数**
 * （expectedChapterCount）直接比较——弧 2 起点 ch8、窗口 8–15、期望 15，`15>=15` 恒真，
 * 弧在 complete=false 时被静默宣告 completed，4 个 phase 腰斩。量纲必须统一到"弧内"：
 * - 人工权威：末个已批准批次 payload.complete=true → 完成（优先级最高，不被数量校验覆盖）；
 * - 否则按弧内实际落籍章数（COUNT chapters）与 expectedChapterCount 比较；
 * - 不再从全局 end_chapter_index 推断任何弧长。
 * 所有弧完成转移（commit 管线与 migrate 修复）必须共用本片段，禁止再抄写变体。
 */
export function arcCompletionPredicateSql(arcAlias = "a", batchAlias = "b"): string {
  return `EXISTS (
    SELECT 1 FROM story_arc_batches ${batchAlias}
    WHERE ${batchAlias}.arc_id = ${arcAlias}.id
      AND ${batchAlias}.batch_index = (SELECT MAX(sb.batch_index) FROM story_arc_batches sb WHERE sb.arc_id = ${arcAlias}.id AND sb.status = 'approved')
      AND ${batchAlias}.status = 'approved'
      AND (
        COALESCE((${batchAlias}.payload->>'complete')::boolean, false) = true
        OR (
          COALESCE((${arcAlias}.payload->>'expectedChapterCount')::integer, 0) > 0
          AND (SELECT COUNT(*)::int FROM chapters lc WHERE lc.arc_id = ${arcAlias}.id) >= (${arcAlias}.payload->>'expectedChapterCount')::integer
        )
      )
  )`;
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
