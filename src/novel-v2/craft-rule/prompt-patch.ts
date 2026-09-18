export type CraftRulePromptSections = Record<string, string>;

/**
 * Craft Rule 的 afterText 可以是 execution-point patch，也可以是旧版本的
 * 普通文本。解析集中在这里，确保实验和正式晋升使用同一套兼容规则。
 */
export function parseCraftRulePromptPatch(afterText: string): CraftRulePromptSections {
  try {
    const parsed: unknown = JSON.parse(afterText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const sections = Object.entries(parsed).reduce<CraftRulePromptSections>((result, [key, value]) => {
        if (typeof value === "string" && value.trim()) result[key] = value.trim();
        return result;
      }, {});
      if (Object.keys(sections).length) return sections;
    }
  } catch {
    // Legacy plain-text candidates are normalized below.
  }
  return { drafting: afterText.trim() };
}

export function mergeCraftRulePromptSections(
  current: Record<string, unknown> | null | undefined,
  patch: CraftRulePromptSections,
): CraftRulePromptSections {
  const existing: CraftRulePromptSections = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string") existing[key] = value;
    }
  }
  return { ...existing, ...patch };
}

/**
 * afterText 格式与目标 skill 快照形状的兼容性告警（2026-09-11 实证）：
 * beforeText 是多执行点 JSON map 时，纯文本 afterText 经 parseCraftRulePromptPatch
 * 的旧版回退规则会变成 {drafting: afterText}——promote 不新增目标执行点，而是
 * 整体覆盖 drafting 段现有内容。多段快照与纯文本 afterText 组合几乎必然是格式
 * 错误，在候选创建入口给出可读告警；格式兼容时返回 undefined。
 */
export function describePromptPatchFormatWarning(beforeText: string | undefined, afterText: string): string | undefined {
  let beforeSections: unknown;
  try {
    beforeSections = JSON.parse(beforeText ?? "");
  } catch {
    return undefined;
  }
  if (!beforeSections || typeof beforeSections !== "object" || Array.isArray(beforeSections)) return undefined;
  const keys = Object.keys(beforeSections).filter((key) => typeof (beforeSections as Record<string, unknown>)[key] === "string");
  if (keys.length < 2) return undefined;
  let afterParsed: unknown;
  try {
    afterParsed = JSON.parse(afterText);
  } catch {
    afterParsed = undefined;
  }
  const afterIsPatch = Boolean(afterParsed) && typeof afterParsed === "object" && !Array.isArray(afterParsed)
    && Object.values(afterParsed as Record<string, unknown>).every((value) => typeof value === "string");
  if (afterIsPatch) return undefined;
  return `afterText 是纯文本，而目标 skill 当前版本是多执行点 JSON 结构（${keys.length} 段：${keys.join("、")}）。按 parseCraftRulePromptPatch 的旧版回退规则，promote 会把整段文本写入 drafting 段并覆盖该段现有内容，而不是落到目标执行点。请改为 execution-point patch JSON（如 {"chapter.review.structure": "..."}）`;
}

/** 结构等价（保守）：空白折叠后逐段比较。语义近义改写不在本判定范围——那是审核员的活。 */
export function sameCraftRuleSectionText(left: string, right: string): boolean {
  return normalizeCraftRuleWhitespace(left) === normalizeCraftRuleWhitespace(right);
}

/** 重合候选的规范化文本（幂等 id 与结构比较共用，保证"换空白写法命中同一行"）。 */
export function normalizeCraftRuleWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** 重合候选的规范化补丁形态（稳定 JSON）：幂等 id 的哈希输入，与逐段比较同一语义。 */
export function craftRuleNormalizedPatchText(targetKind: "skill" | "system-prompt", afterText: string): string {
  if (targetKind === "system-prompt") return normalizeCraftRuleWhitespace(afterText);
  const sections = parseCraftRulePromptPatch(afterText);
  return JSON.stringify(Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, normalizeCraftRuleWhitespace(value)]).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * SK-2 重合判定（product-audit-20260910 C1，僵尸候选根因）：
 * "人工 yaml 演进先行、闭环候选仍排队"的机制形态 = 补丁**合并后**与当前目标内容逐段
 * 结构等价（规则已在目标版本里）。注意必须按合并语义判定而非整文比对——craft 候选是
 * 分执行点 patch，全字段 JSON 相等几乎不成立，逐段等价才是真实的"无净变化"。
 * 本判定只覆盖机械重合形态；"几乎同义但换了措辞"仍由审核/回归拦截（宁放行不误杀）。
 */
export function isCraftRuleNoopChange(targetKind: "skill" | "system-prompt", beforeText: string, afterText: string): boolean {
  if (targetKind === "system-prompt") return sameCraftRuleSectionText(beforeText, afterText);
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(beforeText);
  } catch {
    return sameCraftRuleSectionText(beforeText, afterText);
  }
  const before = mergeCraftRulePromptSections(parsed as Record<string, unknown>, {});
  const merged = mergeCraftRulePromptSections(parsed as Record<string, unknown>, parseCraftRulePromptPatch(afterText));
  const keys = new Set([...Object.keys(before), ...Object.keys(merged)]);
  if (!keys.size) return false;
  for (const key of keys) {
    const left = before[key];
    const right = merged[key];
    if (left === undefined || right === undefined || !sameCraftRuleSectionText(left, right)) return false;
  }
  return true;
}
