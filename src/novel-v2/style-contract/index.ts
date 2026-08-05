import type { MemoryHit } from "../protocol";
import { canonicalSha256 } from "../canonical-json";

/**
 * 文风契约：书级、可版本的叙述声音约束。
 *
 * 设计依据：参考手册 §7.1 把文风记录为一组可解释滑杆而不是作者名或固定范文。
 * 本模块提供十维滑杆的载荷类型、校验、指纹、prompt 渲染和记忆注入。
 * 滑杆是 prose-reviewer 与 draft/revision 的对照参考基线，不是逐章清单，
 * 也不把任何取值变成质量门（与 REVIEW_COVERAGE 只做内部映射的模式一致）。
 */

export const STYLE_DIMENSION_KEYS = [
  "pov",
  "narrationDistance",
  "timeMode",
  "sentenceRhythm",
  "vocabularyLevel",
  "sensoryFocus",
  "metaphorDensity",
  "dialogueRatio",
  "restraintLevel",
  "narrationAttitude",
] as const;

export type StyleDimensionKey = (typeof STYLE_DIMENSION_KEYS)[number];

export const STYLE_DIMENSION_LABELS: Record<StyleDimensionKey, string> = {
  pov: "POV 与叙述人称",
  narrationDistance: "叙述距离",
  timeMode: "时间方式",
  sentenceRhythm: "句式节奏",
  vocabularyLevel: "词汇层级",
  sensoryFocus: "感官重心",
  metaphorDensity: "比喻密度",
  dialogueRatio: "对白比例",
  restraintLevel: "留白程度",
  narrationAttitude: "叙述态度",
};

export interface StyleDimension {
  /** 当前取值或范围（如"贴近身体/意识""短促"）。 */
  value: string;
  /** 可选：该维度的审校关注点。 */
  note?: string;
}

export interface StyleContractPayload {
  /** 十维滑杆；缺失的维度按未指定处理，不阻断。 */
  dimensions: Partial<Record<StyleDimensionKey, StyleDimension>>;
  /** 可选：适用范围与边界说明。 */
  note?: string;
}

export type StyleContractStatus = "draft" | "active";

export interface StyleContract {
  id: string;
  projectId: string;
  version: number;
  label: string;
  payload: StyleContractPayload;
  fingerprint: string;
  status: StyleContractStatus;
  createdAt: string;
  updatedAt?: string;
}

export interface StyleContractDraft {
  label: string;
  payload: StyleContractPayload;
  sourceArtifactId?: string;
}

const RECOGNIZED_KEYS = new Set<string>(STYLE_DIMENSION_KEYS);

export function normalizeStyleContractPayload(value: unknown): StyleContractPayload {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const dimensions: StyleContractPayload["dimensions"] = {};
  const source = record.dimensions && typeof record.dimensions === "object" && !Array.isArray(record.dimensions)
    ? record.dimensions as Record<string, unknown>
    : {};
  for (const key of Object.keys(source)) {
    if (!RECOGNIZED_KEYS.has(key)) continue;
    const item = source[key];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const dim = item as Record<string, unknown>;
    const value = typeof dim.value === "string" && dim.value.trim() ? dim.value.trim() : "";
    if (!value) continue;
    dimensions[key as StyleDimensionKey] = {
      value,
      note: typeof dim.note === "string" && dim.note.trim() ? dim.note.trim() : undefined,
    };
  }
  return {
    dimensions,
    note: typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined,
  };
}

/** 返回非空维度名列表；只提示缺口，不作为逐章必填。 */
export function validateStyleContractPayload(payload: StyleContractPayload): string[] {
  return STYLE_DIMENSION_KEYS.filter((key) => !payload.dimensions[key]);
}

export function styleContractFingerprint(payload: StyleContractPayload): string {
  return canonicalSha256(payload).slice(0, 24);
}

export function renderStyleContract(contract: { label: string; version: number; payload: StyleContractPayload }): string {
  const lines = [`文风契约 v${contract.version}：${contract.label}`];
  for (const key of STYLE_DIMENSION_KEYS) {
    const dimension = contract.payload.dimensions[key];
    if (!dimension) continue;
    const note = dimension.note ? `；关注：${dimension.note}` : "";
    lines.push(`- ${STYLE_DIMENSION_LABELS[key]}：${dimension.value}${note}`);
  }
  if (contract.payload.note) lines.push(`适用范围：${contract.payload.note}`);
  lines.push(
    "这些滑杆是当前文风版本的叙述声音参考基线。用它统一全书底色并判断偏离是否服务于当前 POV、人物、场景压力与章节功能；只作为对照，不强制每章逐维满足，也不把任何取值变成质量门。",
  );
  return lines.join("\n");
}

export function styleContractAsMemoryHit(contract: StyleContract, projectId: string): MemoryHit {
  return {
    id: contract.id,
    projectId,
    kind: "author",
    title: `文风契约 v${contract.version}：${contract.label}`,
    content: renderStyleContract(contract),
    subjectRefs: [],
    knowledgeScope: "author",
    authority: "derived",
    confidence: 0.9,
    sourceRevisionIds: [],
    contentHash: contract.fingerprint,
    supersedes: [],
    score: 1.0,
    matchedFacet: "style",
    matchedFacets: ["style", "author-preference"],
    reason: "active-style-contract",
    semanticRank: 1.0,
  };
}
