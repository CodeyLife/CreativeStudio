import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";

export interface ToolInfo {
  short: string;
  full: string;
}

export interface ToolGroup {
  key: string;
  title: string;
  tools: ToolName[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  { key: "run-action", title: "Run / Action 主体", tools: ["novel_run_create", "novel_action_execute"] },
  { key: "project-inspect", title: "项目观测", tools: ["novel_project_inspect"] },
  { key: "craft-rule", title: "Craft Rule 候选演进", tools: ["novel_rule_candidate_create", "novel_rule_candidate_advance"] },
  { key: "project", title: "项目生命周期", tools: ["novel_project_list"] },
  { key: "bootstrap", title: "规划与创作", tools: ["novel_bootstrap_run", "novel_chapter_review", "novel_chapter_generate", "novel_story_arc_start", "novel_story_arc_get", "novel_story_arc_review", "novel_foreshadowing_list", "novel_foreshadowing_triage"] },
  { key: "observability", title: "产物与工作流观测", tools: ["novel_artifact_query", "novel_workflow_query"] },
  { key: "workflow-decision", title: "Workflow 决策", tools: ["novel_workflow_decision"] },
  { key: "external-llm", title: "外部 LLM 深度参与：上下文查询", tools: ["novel_memory_query", "novel_fact_candidate_queue", "novel_fact_candidate_decide", "novel_skill_query"] },
];

const SHORT_LABELS: Partial<Record<ToolName, string>> = {
  novel_run_create: "创建 CreativeRun",
  novel_action_execute: "执行 action",
  novel_project_inspect: "项目观测",
  novel_rule_candidate_create: "创建规则候选",
  novel_rule_candidate_advance: "推进规则候选",
  novel_project_list: "列出项目",
  novel_bootstrap_run: "启动基础+规划",
  novel_chapter_review: "章节审校工作流",
  novel_chapter_generate: "生成章节",
  novel_story_arc_start: "规划故事弧",
  novel_story_arc_get: "查询故事弧",
  novel_story_arc_review: "审核故事弧",
  novel_foreshadowing_list: "伏笔分流视图",
  novel_foreshadowing_triage: "伏笔账本分流",
  novel_artifact_query: "产物观测",
  novel_workflow_query: "工作流观测",
  novel_workflow_decision: "工作流门决策",
  novel_memory_query: "记忆查询",
  novel_skill_query: "技能查询",
  novel_fact_candidate_queue: "事实候选积压面板",
  novel_fact_candidate_decide: "裁决事实候选",
};

export const TOOL_DESCRIPTIONS: Record<string, ToolInfo> = Object.fromEntries(
  TOOL_DEFINITIONS.map((definition) => [
    definition.name,
    {
      short: SHORT_LABELS[definition.name as ToolName] ?? definition.name,
      full: definition.description,
    },
  ]),
) as Record<string, ToolInfo>;

export const DIRECT_EXEC_TOOLS = new Set<string>([
  "novel_project_list",
  "novel_run_create",
  "novel_chapter_review",
  "novel_chapter_generate",
  "novel_story_arc_start",
  "novel_story_arc_get",
  "novel_story_arc_review",
  "novel_foreshadowing_list",
  "novel_foreshadowing_triage",
]);

export const TOOL_COUNT = TOOL_DEFINITIONS.length;
export const TOOL_GROUP_COUNT = TOOL_GROUPS.length;

function defaultSchemaValue(schema: Record<string, unknown>): unknown {
  if ("default" in schema) return schema.default;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) return enumValues[0];
  if (schema.type === "array") return [];
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [];
    return Object.fromEntries(required.map((key) => [key, defaultSchemaValue(properties[key] ?? {})]));
  }
  return "";
}

export function buildToolArgumentSkeleton(toolName: string): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
  if (!definition) return {};
  const skeleton = defaultSchemaValue(definition.inputSchema);
  return skeleton && typeof skeleton === "object" && !Array.isArray(skeleton)
    ? skeleton as Record<string, unknown>
    : {};
}
