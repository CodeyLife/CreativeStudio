import { compareSkillVersions, createConfiguredSkillProvider, normalizeSkillDescriptor, createWorkspaceSkillProvider, listCurrentSkillDescriptors, resolveStageSkillBundle, SKILL_EXECUTION_POLICIES } from "../src/novel-v2/skill-runtime";
import path from "node:path";
import { formatSkillHygieneFindings, inspectSkillProjection, compareSkillProjections } from "../src/novel-v2/skill-hygiene";
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

/**
 * 观测面专用装载：**不得 `migrate()`**。migrate 尾的 `seedWorkspaceSkills` 会把
 * workspace seed 写进 `skill_definitions`，于是"比对"发生在"写入"之后——seed 领先的
 * 漂移被命令自己抹平（check 恒 print ok），且一个名为 check 的命令实际改了运行库
 * （2026-09-19 在运行库上实证）。写库只属于 sync/patch 的显式语义。
 */
async function loadDatabase(): Promise<{ repository: NovelPostgresRepository; skills: Awaited<ReturnType<NovelPostgresRepository["listSkills"]>> }> {
  const repository = new NovelPostgresRepository();
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
  const projectId = option("--project");
  if (!projectId) throw new Error("同步数据库 Skill 必须提供真实项目：--project <projectId>");
  const skills = await listCurrentSkillDescriptors(provider, projectId);
  const repository = new NovelPostgresRepository();
  try {
    await repository.migrate();
    // SK-2 单一真源护栏（product-audit-20260910 C1）：skill_definitions 是运行真源
    // （学习闭环 promote 的落点），workspace yaml 是 seed。seed 同步不得把更高版本的
    // 晋升内容覆盖回旧版——"一旦晋升后再 sync 即回滚"根因的结构性封堵。
    const databaseSkills = (await repository.listSkills(projectId)).map((row) => normalizeSkillDescriptor(row)).filter((skill) => !("invalidExecutionPoints" in skill));
    const databaseVersions = new Map(databaseSkills.map((skill) => [skill.skillId, skill.version]));
    const skippedStaleSeed: Array<{ skillId: string; workspace: string; database: string }> = [];
    for (const skill of skills) {
      const promotedAhead = databaseVersions.get(skill.skillId);
      if (promotedAhead && compareSkillVersions(promotedAhead, skill.version) > 0) {
        skippedStaleSeed.push({ skillId: skill.skillId, workspace: skill.version, database: promotedAhead });
        continue;
      }
      await repository.upsertKnowledgeRecord(projectId, "skills", {
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
    print({ target: "database", synced: skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: skill.contentFingerprint })), skippedStaleSeed });
  } finally {
    await repository.close();
  }
}

async function checkDatabase(): Promise<void> {
  const workspace = await listCurrentSkillDescriptors(createWorkspaceSkillProvider(option("--root")), option("--project") ?? "skill-cli");
  const loaded = await loadDatabase();
  try {
    const invalidExecutionPoints = loaded.skills.flatMap((skill) => skill.invalidExecutionPoints?.length
      ? [{ skillId: skill.skillId, version: skill.version, invalidExecutionPoints: skill.invalidExecutionPoints }]
      : []);
    if (invalidExecutionPoints.length) {
      print({ target: "database", status: "invalid-execution-points", invalidExecutionPoints });
      throw new Error(`Skill database 包含未知 execution point：${JSON.stringify(invalidExecutionPoints)}`);
    }
    const projection = compareSkillProjections(
      workspace.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: skill.contentFingerprint })),
      loaded.skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: skill.contentFingerprint })),
      compareSkillVersions,
    );
    const mismatches = projection.drift;
    const promotionAhead = projection.promotionAhead;
    if (mismatches.length) throw new Error(`Skill database drift:\n${JSON.stringify(mismatches, null, 2)}`);
    if (promotionAhead.length) print({ target: "database", status: "promotion-ahead", promotionAhead, note: "skill_definitions 版本高于 workspace yaml（学习闭环晋升）；把晋升内容回写 yaml 并提交后消失" });
    // Reverse check: the forward drift check only compares workspace rows; without
    // this, enabled leftovers that no yaml owns could serve stale guidance forever.
    const hygiene = inspectSkillProjection(
      workspace.map((skill) => skill.skillId),
      loaded.skills.map((skill) => ({ skillId: skill.skillId, sourceRef: (skill as { sourceRef?: string | null }).sourceRef ?? null, enabled: true })),
    );
    const findings = formatSkillHygieneFindings(hygiene);
    if (findings.length) {
      print({ target: "database", status: "hygiene-findings", findings });
      throw new Error(`Skill database hygiene 违规（无溯源或孤儿 enabled 行）：\n${findings.join("\n")}`);
    }
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

async function patchSkill(): Promise<void> {
  // SK-2 路线二应用端：列出晋升 sidecar（待审 patch 工件），--apply 审阅后落位。
  // 落位后 check 的 promotion-ahead 消失；DB 仍是运行真源，本命令只同步 seed。
  // sidecar 是 renderPromotedSkillYaml 的完整目标文档（parseDocument 原位 set，文档级
  // 注释已保留）⇒ 直写落位，不做文本合并启发式（旧版把 promptSections 块内 `#` 行
  // 当顶层注释搬移，且 .yml seed 被 regex 换成 .yaml 产生幽灵文件——审核 N2）。
  // 版本守卫：seed 比 sidecar 新 = seed 已被手工前移，直写即回退，拒绝（--force 覆盖）。
  const { readdir, readFile, writeFile, unlink } = await import("node:fs/promises");
  const root = option("--root") ?? "skills/novel-v2";
  const suffix = ".promoted.yaml";
  const files = (await readdir(root)).filter((f) => f.endsWith(suffix));
  if (!files.length) { print({ target: "patch", pending: [] }); return; }
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const results = [];
  for (const file of files) {
    const seedFile = path.join(root, file.slice(0, file.length - suffix.length));
    const sidecar = path.join(root, file);
    const promoted = await readFile(sidecar, "utf8");
    let seedExists = true;
    let seed = "";
    try { seed = await readFile(seedFile, "utf8"); } catch { seedExists = false; }
    const version = promoted.match(/^version:\s*(\S+)/mu)?.[1] ?? "?";
    const seedVersion = seed.match(/^version:\s*(\S+)/mu)?.[1] ?? (seedExists ? "?" : "missing");
    if (!apply) { results.push({ sidecar: file, skillVersion: version, seedVersion, applied: false }); continue; }
    if (seedExists && seedVersion !== "?" && version !== "?" && compareSkillVersions(version, seedVersion) < 0 && !force) {
      results.push({ sidecar: file, skillVersion: version, seedVersion, applied: false, refused: "seed-ahead（sidecar 版本低于 seed，直写会回退；确认后用 --force）" });
      continue;
    }
    await writeFile(seedFile, promoted, "utf8");
    await unlink(sidecar);
    results.push({ sidecar: file, skillVersion: version, seedVersion, applied: true });
  }
  print({ target: "patch", apply, results });
}

const command = process.argv[2] ?? "validate";
if (command === "validate") await validateWorkspace();
else if (command === "sync") await syncDatabase();
else if (command === "check") await checkDatabase();
else if (command === "explain") await explain();
else if (command === "patch") await patchSkill();
else throw new Error(`未知命令：${command}（可用：validate/sync/check/explain/patch）`);
