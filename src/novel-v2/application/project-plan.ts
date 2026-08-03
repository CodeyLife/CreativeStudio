import type { Artifact } from "../protocol";

export type ProjectPlanStatus =
  | "locked"
  | "ready"
  | "generating"
  | "awaiting-confirmation"
  | "approved"
  | "stale"
  | "failed";

export interface ProjectPlanSection {
  projectId: string;
  taskKey: ProjectPlanTaskKey;
  workItemId?: string;
  sourceArtifactId?: string;
  status: ProjectPlanStatus;
  payload: Record<string, unknown>;
  editRevision: number;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_PLAN_STAGES = [
  { taskKey: "project-positioning", label: "项目定位", dependsOn: [], instruction: "完成项目定位、目标读者与核心叙事承诺" },
  { taskKey: "architecture", label: "全书架构", dependsOn: ["project-positioning"], instruction: "设计整体叙事架构、卷级推进与章节布局" },
  { taskKey: "characters", label: "主要人物与关系", dependsOn: ["project-positioning"], instruction: "设计主要人物、动机、声部、关系网络与变化可能" },
  { taskKey: "worldview", label: "世界观", dependsOn: ["project-positioning"], instruction: "构建世界观、力量规则与不可违反的事实" },
  { taskKey: "plot-design", label: "长程叙事战略", dependsOn: ["architecture", "characters", "worldview"], instruction: "确定主线、支线、时间锚点、伏笔、信息释放与终局边界，不生成固定章节表" },
] as const;

export type ProjectPlanStageTaskKey = (typeof PROJECT_PLAN_STAGES)[number]["taskKey"];
export type ProjectPlanTaskKey = ProjectPlanStageTaskKey | "chapter-plan";

/** 历史 Foundation key 只用于读取旧 artifact，不允许新 work item 使用。 */
export const RETIRED_FOUNDATION_TASK_KEYS = [
  "chapter-plan",
  "relations",
  "plot-threads",
  "foreshadowing",
  "timeline",
  "story-control",
] as const;

export function isRetiredFoundationTaskKey(value: string | undefined): boolean {
  return Boolean(value && RETIRED_FOUNDATION_TASK_KEYS.includes(value as (typeof RETIRED_FOUNDATION_TASK_KEYS)[number]));
}

/** Foundation 阶段中必须由作者确认的方向性契约。 */
export const FOUNDATION_AUTHOR_CONFIRMATION_TASK_KEYS = [
  "project-positioning",
  "architecture",
  "characters",
  "worldview",
  "plot-design",
] as const satisfies readonly ProjectPlanStageTaskKey[];

export function requiresFoundationAuthorConfirmation(taskKey: string | undefined): boolean {
  return Boolean(taskKey && FOUNDATION_AUTHOR_CONFIRMATION_TASK_KEYS.includes(taskKey as (typeof FOUNDATION_AUTHOR_CONFIRMATION_TASK_KEYS)[number]));
}

export const REQUIRED_APPROVED_PLAN_TASK_KEYS = [
  "project-positioning",
  "architecture",
  "characters",
  "worldview",
  "plot-design",
] as const satisfies readonly ProjectPlanTaskKey[];

const stageByKey = new Map<string, (typeof PROJECT_PLAN_STAGES)[number]>(
  PROJECT_PLAN_STAGES.map((stage) => [stage.taskKey, stage]),
);

export function isProjectPlanTaskKey(value: string): value is ProjectPlanTaskKey {
  return value === "chapter-plan" || stageByKey.has(value);
}

export function planStage(taskKey: ProjectPlanTaskKey) {
  return stageByKey.get(taskKey);
}

export function transitivePlanDependents(taskKey: ProjectPlanTaskKey): ProjectPlanTaskKey[] {
  const result = new Set<ProjectPlanTaskKey>();
  const visit = (key: ProjectPlanTaskKey) => {
    for (const stage of PROJECT_PLAN_STAGES) {
      if (stage.dependsOn.includes(key as never) && !result.has(stage.taskKey)) {
        result.add(stage.taskKey);
        visit(stage.taskKey);
      }
    }
  };
  visit(taskKey);
  return [...result];
}

export function foundationTaskKey(artifact: Artifact): ProjectPlanTaskKey | undefined {
  const value = artifact.structuredData?.taskKey;
  if (typeof value === "string" && isProjectPlanTaskKey(value)) return value;
  return undefined;
}

/**
 * 从已通过人工/运行时审批的项目定位中读取正式中文书名。
 * 书名必须由 positioning 明确产出，不从摘要、题材或项目 ID 猜测。
 */
export function approvedProjectBookTitle(payload: Record<string, unknown>): string | undefined {
  const structuredData = payload.structuredData;
  if (!structuredData || typeof structuredData !== "object" || Array.isArray(structuredData)) return undefined;
  const positioning = (structuredData as Record<string, unknown>).positioning;
  if (!positioning || typeof positioning !== "object" || Array.isArray(positioning)) return undefined;
  const raw = (positioning as Record<string, unknown>).bookTitle;
  if (typeof raw !== "string") return undefined;
  const title = raw.trim().replace(/^《|》$/gu, "").trim();
  if (!title || title.length > 40 || !/\p{Script=Han}/u.test(title)) return undefined;
  return title;
}

/**
 * 恢复历史项目中仍使用技术 ID 的展示标题，不覆盖已经明确保存的人工作品名。
 */
export function resolveProjectTitle(projectId: string, title: string, positioningPayload?: Record<string, unknown>): string {
  const normalized = title.trim();
  const isTechnicalPlaceholder = !normalized || normalized === projectId || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(normalized);
  if (!isTechnicalPlaceholder) return title;
  return approvedProjectBookTitle(positioningPayload ?? {}) ?? title;
}
