import { createConfiguredSkillProvider, createWorkspaceSkillProvider, listCurrentSkillDescriptors, resolveStageSkillBundle, SKILL_EXECUTION_POLICIES } from "../src/novel-v2/skill-runtime";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import type { SkillExecutionPoint, SkillPriority } from "../src/novel-v2/protocol";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function target(): "workspace" | "database" {
  const value = option("--target") ?? process.env.NOVEL_SKILL_SOURCE ?? "workspace";
  if (value !== "workspace" && value !== "database") throw new Error(`--target 必须是 workspace 或 database，当前为 ${value}`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function loadDatabase(): Promise<{ repository: NovelPostgresRepository; skills: Awaited<ReturnType<NovelPostgresRepository["listSkills"]>> }> {
  const repository = new NovelPostgresRepository();
  await repository.migrate();
  return { repository, skills: await listCurrentSkillDescriptors({ source: "database", list: (projectId) => repository.listSkills(projectId) }, option("--project") ?? "skill-cli") };
}

async function validateWorkspace(): Promise<void> {
  const provider = createWorkspaceSkillProvider(option("--root"));
  const skills = await listCurrentSkillDescriptors(provider, option("--project") ?? "skill-cli");
  const results = [];
  for (const executionPoint of Object.keys(SKILL_EXECUTION_POLICIES) as SkillExecutionPoint[]) {
    const bundle = await resolveStageSkillBundle({ projectId: option("--project") ?? "skill-cli", provider, executionPoint });
    results.push({ executionPoint, skillIds: bundle.skills.map((skill) => skill.skillId), fingerprint: bundle.fingerprint });
  }
  print({ source: "workspace", skillCount: skills.length, executionPoints: results });
}

async function syncDatabase(): Promise<void> {
  const provider = createWorkspaceSkillProvider(option("--root"));
  const skills = await listCurrentSkillDescriptors(provider, option("--project") ?? "skill-cli");
  const repository = new NovelPostgresRepository();
  try {
    await repository.migrate();
    for (const skill of skills) {
      await repository.upsertKnowledgeRecord("skill-sync", "skills", {
        id: skill.skillId,
        version: skill.version,
        capabilities: skill.capabilities,
        applicableTasks: skill.applicableTasks,
        requiredMemoryKinds: skill.requiredMemoryKinds,
        conflicts: skill.conflicts,
        qualityGates: skill.qualityGates,
        promptSections: skill.promptSections,
        applicableGenres: skill.applicableGenres,
        executionPoints: skill.executionPoints,
        roles: skill.roles,
        dependsOn: skill.dependsOn,
        priority: skill.priority ?? "required",
        contentFingerprint: skill.contentFingerprint,
        sourceRef: skill.sourceRef,
        enabled: skill.enabled,
      });
    }
    print({ target: "database", synced: skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: skill.contentFingerprint })) });
  } finally {
    await repository.close();
  }
}

async function checkDatabase(): Promise<void> {
  const workspace = await listCurrentSkillDescriptors(createWorkspaceSkillProvider(option("--root")), option("--project") ?? "skill-cli");
  const loaded = await loadDatabase();
  try {
    const database = new Map(loaded.skills.map((skill) => [skill.skillId, skill]));
    const mismatches = workspace.flatMap((skill) => {
      const current = database.get(skill.skillId);
      if (!current) return [{ skillId: skill.skillId, reason: "missing-in-database" }];
      if (current.contentFingerprint !== skill.contentFingerprint || current.version !== skill.version) return [{ skillId: skill.skillId, reason: "content-or-version-drift", workspace: { version: skill.version, contentFingerprint: skill.contentFingerprint }, database: { version: current.version, contentFingerprint: current.contentFingerprint } }];
      return [];
    });
    if (mismatches.length) throw new Error(`Skill database drift:\n${JSON.stringify(mismatches, null, 2)}`);
    print({ target: "database", status: "ok", checked: workspace.length });
  } finally {
    await loaded.repository.close();
  }
}

async function explain(): Promise<void> {
  const executionPoint = option("--execution-point") as SkillExecutionPoint | undefined;
  if (!executionPoint || !(executionPoint in SKILL_EXECUTION_POLICIES)) throw new Error("必须提供有效的 --execution-point");
  const source = target();
  const projectId = option("--project") ?? "skill-cli";
  const repository = source === "database" ? new NovelPostgresRepository() : undefined;
  if (repository) await repository.migrate();
  try {
    const provider = source === "workspace"
      ? createWorkspaceSkillProvider(option("--root"))
      : createConfiguredSkillProvider({ source: "database", databaseList: (id) => repository!.listSkills(id) });
    const bundle = await resolveStageSkillBundle({ projectId, provider, executionPoint, role: option("--role") });
    print({ source, executionPoint, role: option("--role"), resolution: bundle.resolution, skills: bundle.skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, priority: skill.priority as SkillPriority, sourceRef: skill.sourceRef, contentFingerprint: skill.contentFingerprint, dependsOn: skill.dependsOn })) });
  } finally {
    await repository?.close();
  }
}

const command = process.argv[2] ?? "validate";
if (command === "validate") await validateWorkspace();
else if (command === "sync") await syncDatabase();
else if (command === "check") await checkDatabase();
else if (command === "explain") await explain();
else throw new Error(`未知命令：${command}（可用：validate/sync/check/explain）`);
