export type NativeJsonSchema = Record<string, unknown>;

export class NativeSchemaCompatibilityError extends Error {
  readonly category = "schema-incompatible";

  constructor(readonly schemaName: string, readonly problems: string[]) {
    super(`原生结构化 schema 不兼容（${schemaName}）：${problems.join("；")}`);
    this.name = "NativeSchemaCompatibilityError";
  }
}

const DISALLOWED_COMBINATORS = ["anyOf", "oneOf", "allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walk(schema: unknown, path: string, problems: string[]): void {
  if (!isRecord(schema)) {
    problems.push(`${path} 必须是对象 schema`);
    return;
  }

  for (const keyword of DISALLOWED_COMBINATORS) {
    if (keyword in schema) problems.push(`${path} 不允许使用 ${keyword}`);
  }

  // enum/const-only nodes are completed with an inferable primitive type by
  // normalizeProviderJsonSchema; every other node must declare its shape.
  if (typeof schema.type !== "string" && !(Array.isArray(schema.enum) || "const" in schema)) problems.push(`${path} 必须声明 type，不能使用动态 schema 节点`);

  if (schema.type === "object") {
    if (schema.additionalProperties !== false) problems.push(`${path} 必须设置 additionalProperties=false`);
    const properties = schema.properties;
    if (!isRecord(properties) || Object.keys(properties).length === 0) problems.push(`${path} 必须声明非空 properties`);
    const keys = isRecord(properties) ? Object.keys(properties) : [];
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    if (required.length !== keys.length || keys.some((key) => !required.includes(key))) problems.push(`${path} 的 properties 必须全部出现在 required`);
    for (const [key, child] of Object.entries(properties ?? {})) walk(child, `${path}.${key}`, problems);
  }

  if (schema.type === "array") {
    if (!("items" in schema)) problems.push(`${path} 必须声明 items`);
    else walk(schema.items, `${path}[]`, problems);
  }

  if ("enum" in schema && !Array.isArray(schema.enum)) problems.push(`${path}.enum 必须是数组`);
  if ("properties" in schema && schema.type !== "object") problems.push(`${path} 声明 properties 时必须是 object`);
}

export function assertNativeJsonSchema(schema: NativeJsonSchema, schemaName = "model_output"): void {
  const problems: string[] = [];
  if (schema.type !== "object") problems.push("根 schema 必须是 object");
  walk(schema, "$", problems);
  if (problems.length) throw new NativeSchemaCompatibilityError(schemaName, [...new Set(problems)]);
}
