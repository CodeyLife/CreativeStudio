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
