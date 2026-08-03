import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { canonicalSha256 } from "./canonical-json";
import type {
  MemoryBundle,
  MemoryKind,
  NovelStage,
  PreflightPlan,
  SkillBundle,
  SkillDescriptor,
  SkillExecutionPoint,
  SkillPriority,
  SkillProvider,
  SkillResolutionManifest,
  StageContextSection,
} from "./protocol";

export interface SkillStagePolicy {
  taskClasses: readonly PreflightPlan["taskClass"][];
  requiredCapabilities: readonly string[];
}

export const SKILL_EXECUTION_POLICIES: Record<SkillExecutionPoint, SkillStagePolicy> = {
  "foundation.book-plan": { taskClasses: ["foundation", "planning"], requiredCapabilities: ["planning"] },
  "arc.plan": { taskClasses: ["planning"], requiredCapabilities: ["planning"] },
  "arc.review": { taskClasses: ["review"], requiredCapabilities: ["review"] },
  "arc.revision": { taskClasses: ["revision"], requiredCapabilities: ["revision"] },
  "chapter.blueprint": { taskClasses: ["planning"], requiredCapabilities: ["planning"] },
  "chapter.drafting": { taskClasses: ["drafting"], requiredCapabilities: ["draft"] },
  "chapter.review.structure": { taskClasses: ["review"], requiredCapabilities: ["review"] },
  "chapter.review.character": { taskClasses: ["review"], requiredCapabilities: ["review"] },
  "chapter.review.prose": { taskClasses: ["review"], requiredCapabilities: ["review"] },
  "chapter.revision": { taskClasses: ["revision"], requiredCapabilities: ["revision"] },
  "chapter.fact-extraction": { taskClasses: ["memory-maintenance"], requiredCapabilities: ["memory"] },
  "character.enrichment": { taskClasses: ["memory-maintenance"], requiredCapabilities: ["memory"] },
  "learning.assessment": { taskClasses: ["review"], requiredCapabilities: ["learning"] },
  "skill.iteration": { taskClasses: ["review"], requiredCapabilities: ["learning"] },
};

const TASK_CLASS_POINTS: Record<string, SkillExecutionPoint[]> = {
  foundation: ["foundation.book-plan"],
  planning: ["foundation.book-plan", "arc.plan", "chapter.blueprint"],
  drafting: ["chapter.drafting"],
  review: ["arc.review", "chapter.review.structure", "chapter.review.character", "chapter.review.prose", "learning.assessment"],
  revision: ["arc.revision", "chapter.revision"],
  "memory-maintenance": ["chapter.fact-extraction", "character.enrichment"],
};

const COARSE_STAGE: Record<SkillExecutionPoint, NovelStage> = {
  "foundation.book-plan": "foundation",
  "arc.plan": "planning",
  "arc.review": "review",
  "arc.revision": "revision",
  "chapter.blueprint": "planning",
  "chapter.drafting": "drafting",
  "chapter.review.structure": "review",
  "chapter.review.character": "review",
  "chapter.review.prose": "review",
  "chapter.revision": "revision",
  "chapter.fact-extraction": "fact-extraction",
  "character.enrichment": "fact-extraction",
  "learning.assessment": "review",
  "skill.iteration": "review",
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function deriveExecutionPoints(input: { executionPoints?: unknown; applicableTasks?: unknown }): SkillExecutionPoint[] {
  const explicit = asStringArray(input.executionPoints).filter((item): item is SkillExecutionPoint => item in SKILL_EXECUTION_POLICIES);
  if (explicit.length) return [...new Set(explicit)];
  return [...new Set(asStringArray(input.applicableTasks).flatMap((task) => TASK_CLASS_POINTS[task] ?? []))];
}

function normalizePromptSections(raw: unknown, executionPoints: SkillExecutionPoint[]): Partial<Record<string, string>> {
  const sections: Partial<Record<string, string>> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.trim()) sections[key] = value.trim();
    }
  }
  for (const point of executionPoints) {
    const coarse = COARSE_STAGE[point];
    if (!sections[point] && sections[coarse]) sections[point] = sections[coarse];
    if (!sections[coarse] && sections[point]) sections[coarse] = sections[point];
  }
  return sections;
}

export function normalizeSkillDescriptor(input: Partial<SkillDescriptor> & { skillId: string; version: string }, sourceRef?: string): SkillDescriptor {
  const executionPoints = deriveExecutionPoints(input);
  const applicableTasks = asStringArray(input.applicableTasks) as PreflightPlan["taskClass"][];
  const normalized: SkillDescriptor = {
    skillId: input.skillId,
    version: input.version,
    capabilities: asStringArray(input.capabilities),
    applicableTasks: applicableTasks.length ? applicableTasks : [...new Set(executionPoints.flatMap((point) => SKILL_EXECUTION_POLICIES[point].taskClasses))],
    requiredMemoryKinds: asStringArray(input.requiredMemoryKinds) as SkillDescriptor["requiredMemoryKinds"],
    conflicts: asStringArray(input.conflicts),
    qualityGates: asStringArray(input.qualityGates),
    promptSections: normalizePromptSections(input.promptSections, executionPoints),
    enabled: input.enabled !== false,
    executionPoints,
    roles: asStringArray(input.roles),
    dependsOn: asStringArray(input.dependsOn),
    priority: input.priority,
    applicableGenres: asStringArray(input.applicableGenres),
    sourceRef: sourceRef ?? input.sourceRef,
  };
  normalized.contentFingerprint = canonicalSha256({
    skillId: normalized.skillId,
    version: normalized.version,
    capabilities: normalized.capabilities,
    applicableTasks: normalized.applicableTasks,
    requiredMemoryKinds: normalized.requiredMemoryKinds,
    conflicts: normalized.conflicts,
    qualityGates: normalized.qualityGates,
    promptSections: normalized.promptSections,
    executionPoints: normalized.executionPoints,
    roles: normalized.roles,
    dependsOn: normalized.dependsOn,
    priority: normalized.priority,
    applicableGenres: normalized.applicableGenres,
  });
  return normalized;
}

async function listSkillFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listSkillFiles(fullPath));
    else if (/\.(yaml|yml|json)$/iu.test(entry.name)) files.push(fullPath);
  }
  return files.sort();
}

export function createWorkspaceSkillProvider(root = path.resolve(process.cwd(), "skills", "novel-v2")): SkillProvider {
  return {
    source: "workspace",
    async list() {
      let files: string[];
      try {
        files = await listSkillFiles(root);
      } catch (error) {
        throw new Error(`workspace Skill 目录不可用：${root}；${error instanceof Error ? error.message : String(error)}`);
      }
      if (!files.length) throw new Error(`workspace Skill 目录为空：${root}`);
      const descriptors = await Promise.all(files.map(async (file) => {
        const rawText = await readFile(file, "utf8");
        const raw = parse(rawText) as Partial<SkillDescriptor> | null;
        if (!raw || typeof raw !== "object" || typeof raw.skillId !== "string" || typeof raw.version !== "string") {
          throw new Error(`Skill 文件缺少 skillId/version：${file}`);
        }
        return normalizeSkillDescriptor(raw as Partial<SkillDescriptor> & { skillId: string; version: string }, path.relative(process.cwd(), file));
      }));
      const ids = new Set<string>();
      for (const skill of descriptors) {
        if (ids.has(skill.skillId)) throw new Error(`workspace Skill 重复：${skill.skillId}`);
        ids.add(skill.skillId);
      }
      return descriptors;
    },
  };
}

export function createDatabaseSkillProvider(list: (projectId: string) => Promise<SkillDescriptor[]>): SkillProvider {
  return {
    source: "database",
    async list(projectId) {
      const descriptors = await list(projectId);
      if (!descriptors.length) throw new Error(`database Skill 为空：projectId=${projectId}`);
      return descriptors.map((skill) => normalizeSkillDescriptor(skill, skill.sourceRef ?? "database:skill_definitions"));
    },
  };
}

export function createConfiguredSkillProvider(input: {
  source?: string;
  databaseList: (projectId: string) => Promise<SkillDescriptor[]>;
  workspaceRoot?: string;
}): SkillProvider {
  const source = input.source ?? (process.env.NODE_ENV === "production" ? "database" : "workspace");
  if (source === "workspace") return createWorkspaceSkillProvider(input.workspaceRoot);
  if (source === "database") return createDatabaseSkillProvider(input.databaseList);
  throw new Error(`NOVEL_SKILL_SOURCE 必须是 workspace 或 database，当前为 ${source}`);
}

export function skillPromptSection(skill: Pick<SkillDescriptor, "promptSections">, executionPoint: string): string {
  const coarse = executionPoint in COARSE_STAGE ? COARSE_STAGE[executionPoint as SkillExecutionPoint] : undefined;
  return skill.promptSections[executionPoint]?.trim() || (coarse ? skill.promptSections[coarse]?.trim() ?? "" : "");
}

export function skillResolutionManifest(bundle: SkillBundle): SkillResolutionManifest | undefined {
  return bundle.resolution;
}

export async function listCurrentSkillDescriptors(provider: SkillProvider, projectId: string): Promise<SkillDescriptor[]> {
  return (await provider.list(projectId)).map((skill) => normalizeSkillDescriptor(skill, skill.sourceRef));
}

export function renderSkillInstruction(bundle: SkillBundle, executionPoint: string): string {
  return bundle.skills
    .map((skill) => {
      const text = skillPromptSection(skill, executionPoint);
      return text ? `### ${skill.skillId}@${skill.version}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

type SkillPromptSource = {
  skillId: string;
  version?: string;
  priority?: SkillPriority;
  promptSections: Partial<Record<string, string>>;
};

/**
 * 把已解析 Skill 转成可独立计量的上下文 sections。
 * 每个 Skill 保留自己的优先级和 provenance，避免聚合文本绕过预算淘汰与 manifest 对账。
 */
export function buildSkillContextSections(
  bundle: { skills: readonly SkillPromptSource[] },
  executionPoint: string,
  titlePrefix = "当前执行点 Skill",
): StageContextSection[] {
  return bundle.skills.flatMap((skill) => {
    const text = skillPromptSection(skill, executionPoint);
    if (!text) return [];
    const version = skill.version ?? "legacy";
    const priority = skill.priority === "required" ? "required" : skill.priority === "optional" ? "soft" : "normal";
    return [{
      id: `skill:${skill.skillId}@${version}`,
      kind: "skill",
      title: `${titlePrefix}：${skill.skillId}@${version}`,
      text,
      priority,
      provenanceRefs: [`${skill.skillId}@${version}`],
    } satisfies StageContextSection];
  });
}

export async function resolveStageSkillBundle(input: {
  projectId: string;
  provider: SkillProvider;
  executionPoint: SkillExecutionPoint;
  role?: string;
  genre?: string;
  memory?: MemoryBundle;
  memoryKinds?: MemoryKind[];
  requestedCapabilities?: string[];
  preflightId?: string;
  now?: number;
}): Promise<SkillBundle> {
  const policy = SKILL_EXECUTION_POLICIES[input.executionPoint];
  const available = (await input.provider.list(input.projectId)).map((skill) => normalizeSkillDescriptor(skill, skill.sourceRef));
  const direct = available.filter((skill) => skill.enabled
    && skill.executionPoints?.includes(input.executionPoint)
    && (!skill.roles?.length || !input.role || skill.roles.includes(input.role))
    && (!skill.applicableGenres?.length || (input.genre ? skill.applicableGenres.includes(input.genre) : false)));
  if (!direct.length) throw new Error(`没有可用于 ${input.executionPoint}${input.role ? `/${input.role}` : ""} 的 Skill`);

  const byId = new Map(available.map((skill) => [skill.skillId, skill]));
  const selected = new Map<string, SkillDescriptor>();
  const visiting = new Set<string>();
  const visit = (skill: SkillDescriptor): void => {
    if (selected.has(skill.skillId)) return;
    if (visiting.has(skill.skillId)) throw new Error(`Skill 依赖循环：${skill.skillId}`);
    visiting.add(skill.skillId);
    for (const dependencyId of skill.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency || !dependency.enabled) throw new Error(`Skill ${skill.skillId} 缺少依赖：${dependencyId}`);
      visit(dependency);
    }
    visiting.delete(skill.skillId);
    selected.set(skill.skillId, skill);
  };
  direct.forEach(visit);

  const selectedSkills = [...selected.values()];
  const priorityOf = (skill: SkillDescriptor): SkillPriority => skill.priority
    ?? (skill.capabilities.some((capability) => policy.requiredCapabilities.includes(capability)) ? "required" : "normal");
  const capabilities = new Set(selectedSkills.flatMap((skill) => skill.capabilities));
  const requiredCapabilities = [...new Set([...(policy.requiredCapabilities ?? []), ...(input.requestedCapabilities ?? [])])];
  const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missingCapabilities.length) throw new Error(`Skill ${input.executionPoint} 缺少能力：${missingCapabilities.join(", ")}`);

  const memoryKinds = new Set(input.memory?.claims.map((claim) => claim.kind) ?? input.memoryKinds ?? []);
  for (const skill of selectedSkills) {
    const missingMemory = (skill.requiredMemoryKinds ?? []).filter((kind) => !memoryKinds.has(kind));
    if (missingMemory.length && priorityOf(skill) === "required") throw new Error(`Skill ${skill.skillId} 缺少必要记忆：${missingMemory.join(", ")}`);
    if (!skillPromptSection(skill, input.executionPoint) && priorityOf(skill) !== "optional") throw new Error(`Skill ${skill.skillId} 没有执行点 ${input.executionPoint} 的 prompt 内容`);
  }

  const conflicts = selectedSkills.flatMap((skill) => (skill.conflicts ?? [])
    .filter((conflict) => selected.has(conflict))
    .map((conflict) => ({ skillId: skill.skillId, conflictsWith: conflict })));
  if (conflicts.length) throw new Error(`Skill 冲突：${conflicts.map((item) => `${item.skillId}/${item.conflictsWith}`).join(", ")}`);

  const resolvedAt = input.now ?? Date.now();
  const source = input.provider.source ?? "database";
  const dependencyClosure = selectedSkills.map((skill) => skill.skillId);
  const resolutionBase = {
    source,
    executionPoint: input.executionPoint,
    role: input.role,
    genre: input.genre,
    memoryKinds: [...memoryKinds].sort(),
    resolvedAt,
    skills: selectedSkills.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: skill.contentFingerprint ?? "", sourceRef: skill.sourceRef, priority: priorityOf(skill) })),
    dependencyClosure,
    omittedOptionalSkills: available.filter((skill) => skill.enabled && priorityOf(skill) === "optional" && !selected.has(skill.skillId)).map((skill) => skill.skillId),
  } satisfies Omit<SkillResolutionManifest, "fingerprint">;
  const resolution: SkillResolutionManifest = { ...resolutionBase, fingerprint: canonicalSha256(resolutionBase) };
  const preflightId = input.preflightId ?? `stage:${input.executionPoint}`;
  const bundle: SkillBundle = {
    id: `skills:${input.executionPoint}:${resolvedAt}`,
    projectId: input.projectId,
    preflightId,
    skills: selectedSkills.map((skill) => ({ ...skill, priority: priorityOf(skill) })),
    conflicts,
    missingCapabilities,
    fingerprint: "",
    createdAt: resolvedAt,
    skillSource: source,
    executionPoint: input.executionPoint,
    role: input.role,
    resolution,
    availableSkills: available.filter((skill) => skill.enabled).map((skill) => ({ skillId: skill.skillId, capabilities: skill.capabilities })),
  };
  bundle.fingerprint = canonicalSha256({ ...bundle, fingerprint: undefined, createdAt: undefined });
  return bundle;
}
