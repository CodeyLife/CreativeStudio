import { describe, expect, it } from "vitest";
import {
  normalizeStyleContractPayload,
  renderStyleContract,
  STYLE_DIMENSION_KEYS,
  STYLE_DIMENSION_LABELS,
  styleContractAsMemoryHit,
  styleContractFingerprint,
  validateStyleContractPayload,
  type StyleContract,
} from "../style-contract";
import { renderExecutionMemoryClaim } from "../prompts/chapter-planning-context";

const sampleContract = (overrides: Partial<StyleContract> = {}): StyleContract => ({
  id: "style-contract:p1:1",
  projectId: "p1",
  version: 1,
  label: "卷一 冷峻限知",
  payload: {
    dimensions: {
      pov: { value: "限知第三人称" },
      narrationDistance: { value: "贴近身体/意识" },
      sentenceRhythm: { value: "短促" },
    },
    note: "仅适用于第一卷高压力行动场景；安静关系章可偏离节奏取值。",
  },
  fingerprint: "fp",
  status: "draft",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("style contract module", () => {
  it("normalizes payload and drops unknown dimensions and blank values", () => {
    const payload = normalizeStyleContractPayload({
      dimensions: {
        pov: { value: "限知" },
        unknownDimension: { value: "应被丢弃" },
        restraintLevel: { value: "  " },
      },
      note: " 适用说明 ",
    });
    expect(payload.dimensions).toEqual({ pov: { value: "限知", note: undefined } });
    expect(payload.note).toBe("适用说明");
  });

  it("validates missing dimensions as a soft gap list, not a blocker", () => {
    const empty = normalizeStyleContractPayload({});
    expect(validateStyleContractPayload(empty)).toEqual(STYLE_DIMENSION_KEYS);
    const partial = normalizeStyleContractPayload({ dimensions: { pov: { value: "限知" } } });
    expect(validateStyleContractPayload(partial)).toHaveLength(STYLE_DIMENSION_KEYS.length - 1);
  });

  it("produces a stable fingerprint and a readable render", () => {
    const a = normalizeStyleContractPayload(sampleContract().payload);
    const b = normalizeStyleContractPayload(JSON.parse(JSON.stringify(sampleContract().payload)));
    expect(styleContractFingerprint(a)).toBe(styleContractFingerprint(b));
    const text = renderStyleContract(sampleContract());
    expect(text).toContain("文风契约 v1：卷一 冷峻限知");
    expect(text).toContain(STYLE_DIMENSION_LABELS.pov);
    expect(text).toContain("适用范围：仅适用于第一卷高压力行动场景");
    expect(text).toContain("不强制每章逐维满足");
  });

  it("turns an active contract into a style-facet memory hit", () => {
    const hit = styleContractAsMemoryHit(sampleContract({ status: "active" }), "p1");
    expect(hit.kind).toBe("author");
    expect(hit.matchedFacet).toBe("style");
    expect(hit.matchedFacets).toContain("author-preference");
    expect(hit.reason).toBe("active-style-contract");
    expect(hit.contentHash).toBe(sampleContract().fingerprint);
  });

  it("renders style memory hits as a reference baseline, not a fact", () => {
    const hit = styleContractAsMemoryHit(sampleContract(), "p1");
    const rendered = renderExecutionMemoryClaim(hit);
    expect(rendered.title).toContain("文风契约 v1");
    expect(rendered.text).toContain("对照参考");
    expect(rendered.text).not.toContain("作者侧冻结背景");
    expect(rendered.text).toContain("逐章清单");
  });
});
