/**
 * 结构化 JSON 容错解析（跨 provider 通用）。
 *
 * 设计依据：AGENTS.md「reusable contracts」——LLM（尤其网页对话形态的
 * external-mcp 回填）输出的 JSON 常带格式污染：中文全角引号、尾随逗号、
 * 单引号、截断、代码围栏。在最低共享层做"结构修复 → 解析"，供
 * model-gateway 与 foundation-contract 复用，避免每处重复堆叠 case 修复。
 *
 * 修复基于纯结构特征（引号配对、逗号/括号位置），不识别任何具体内容，
 * 可跨 prompt 版本、题材与模型复用。修复失败时保持原样，由上层 schema
 * 校验或 repair 循环兜底。
 */

/** 提取代码围栏（```json ... ``` 或 ``` ... ```）内的文本；无围栏则返回原文。 */
function extractFencedJson(content: string): string[] {
  const blocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1].trim());
  return blocks.length ? blocks : [content];
}

/** 把 JSON 结构位置的 ASCII 双引号之外的"字符串边界"统一为合法双引号。 */
function normalizeSmartQuotes(json: string): string {
  // 扫描字符，在 JSON 结构位置（`{` `[` `:` `,` 之后 / `}` `]` 之前）把
  // 全角“”当作字符串边界转为 ASCII `"`；字符串内部的全角引号是合法内容，保留。
  let result = "";
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (!inString) {
      if (char === '"') { inString = true; result += char; continue; }
      if (char === "\u201c" || char === "\u201d") { result += '"'; continue; }
      result += char;
      continue;
    }
    if (char === "\\") { result += char + (json[index + 1] ?? ""); index += 1; continue; }
    if (char === '"') { inString = false; }
    result += char;
  }
  return result;
}

/** 去除对象/数组末尾的尾随逗号（`,}` `,]` 及 `},` 前的孤逗号）。 */
function stripTrailingCommas(json: string): string {
  // 只在结构位置（逗号后紧跟 } 或 ]）移除逗号；字符串内部的逗号不受影响。
  let result = "";
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (!inString) {
      if (char === '"') { inString = true; result += char; continue; }
      if (char === ",") {
        const next = json[index + 1] ?? "";
        if (next === "}" || next === "]") { continue; } // 跳过尾随逗号
      }
      result += char;
      continue;
    }
    if (char === "\\") { result += char + (json[index + 1] ?? ""); index += 1; continue; }
    if (char === '"') { inString = false; }
    result += char;
  }
  return result;
}

/** 单引号风格 → 双引号：仅当整个文本用单引号包裹字符串且无双引号时应用。 */
function normalizeSingleQuotes(json: string): string {
  const hasDoubleQuote = /(?<!\\)"/.test(json);
  const singleQuoteCount = (json.match(/'/g) ?? []).length;
  if (hasDoubleQuote || singleQuoteCount < 2) return json;
  // 逐字符把字符串边界单引号转双引号（字符串内单引号，如英文所有格，保留）。
  let result = "";
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (char === "\\") { result += char + (json[index + 1] ?? ""); index += 1; continue; }
    if (char === "'") {
      // 相邻两单引号视为字符串内转义（'' → '）
      if (json[index + 1] === "'") { result += "\\'"; index += 1; continue; }
      inString = !inString;
      result += '"';
      continue;
    }
    result += char;
  }
  return result;
}

/** 截断 JSON 的保守补全：补齐未闭合的字符串、对象、数组。仅尽力而为。 */
function closeUnterminatedJson(json: string): string {
  let result = "";
  let inString = false;
  const stack: Array<"{" | "[" | '"'> = [];
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (char === "\\") { result += char + (json[index + 1] ?? ""); index += 1; continue; }
      if (char === '"') { inString = false; stack.pop(); }
      result += char;
      continue;
    }
    if (char === '"') { inString = true; stack.push('"'); result += char; continue; }
    if (char === "{") { stack.push("{"); result += char; continue; }
    if (char === "[") { stack.push("["); result += char; continue; }
    if (char === "}") { if (stack[stack.length - 1] === "{") stack.pop(); result += char; continue; }
    if (char === "]") { if (stack[stack.length - 1] === "[") stack.pop(); result += char; continue; }
    result += char;
  }
  // 若字符串未闭合，补全引号（若字符串后有逗号/冒号残留则先剥离）
  if (inString) {
    result = result.replace(/,?\s*$/, "");
    result += '"';
    stack.pop();
  }
  // 从内向外补全闭合括号
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const open = stack[index];
    result += open === "{" ? "}" : open === "[" ? "]" : "";
  }
  return result;
}

/**
 * 修复并解析 JSON 文本。成功返回解析值，失败返回 undefined。
 *
 * 顺序：提取围栏 → 单引号归一 → 中文引号归一 → 去尾随逗号 → 原样解析 →
 * 截断补全后解析。任一步成功即返回。
 */
export function parseStructuredJson(raw: string): unknown {
  if (!raw || !raw.trim()) return undefined;
  for (const candidate of extractFencedJson(raw)) {
    if (!candidate.trim()) continue;
    const attempts = [
      candidate.trim(),
      normalizeSingleQuotes(candidate),
      normalizeSmartQuotes(candidate),
      stripTrailingCommas(normalizeSmartQuotes(candidate)),
      closeUnterminatedJson(stripTrailingCommas(normalizeSmartQuotes(normalizeSingleQuotes(candidate)))),
    ];
    for (const attempt of attempts) {
      try {
        let value: unknown = JSON.parse(attempt);
        if (typeof value === "string") value = JSON.parse(value.trim());
        if (value && typeof value === "object") return value;
      } catch {
        // 继续尝试下一个修复策略
      }
    }
  }
  return undefined;
}
