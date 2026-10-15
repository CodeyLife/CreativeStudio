import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileStageContext, StageContextBudgetError } from "../stage-context";
import {
  SKILL_EXECUTION_POLICIES,
  SKILL_ROLES,
  compareSkillVersions,
  createDatabaseSkillProvider,
  createWorkspaceSkillProvider,
  buildSkillContextSections,
  listCurrentSkillDescriptors,
  normalizeSkillDescriptor,
  renderSkillInstruction,
  resolveStageSkillBundle,
} from "../skill-runtime";
import type { SkillDescriptor, SkillExecutionPoint } from "../protocol";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporarySkillRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "novel-v2-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function draftSkill(prompt: string, overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    skillId: "test-drafting",
    version: "1.0.0",
    capabilities: ["draft"],
    applicableTasks: ["drafting"],
    requiredMemoryKinds: [],
    conflicts: [],
    qualityGates: ["test"],
    promptSections: { "chapter.drafting": prompt },
    enabled: true,
    executionPoints: ["chapter.drafting"],
    roles: ["writer"],
    dependsOn: [],
    priority: "required",
    ...overrides,
  };
}

describe("Skill runtime resolution", () => {
  it("resolves every declared execution point to a required Skill", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    for (const executionPoint of Object.keys(SKILL_EXECUTION_POLICIES) as Array<keyof typeof SKILL_EXECUTION_POLICIES>) {
      const bundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint });
      expect(bundle.resolution?.source).toBe("workspace");
      expect(bundle.skills.some((skill) => skill.priority === "required")).toBe(true);
      expect(bundle.resolution?.skills.every((skill) => skill.contentFingerprint)).toBe(true);
    }
  });

  it("SK-5/C5 双向：标题轻量点只挂显式声明的命名 skill，蓝图契约不再出现在标题上下文", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const title = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.title", role: "planner" });
    const titleText = renderSkillInstruction(title, "chapter.title");
    expect(titleText).toContain("这一章");
    expect(titleText).not.toContain("本章目标、阻力、行动、选择、代价和结果"); // plot-causality 蓝图段
    expect(title.skills.every((skill) => skill.executionPoints?.includes("chapter.title"))).toBe(true);
    // 反向：蓝图执行点仍解析到蓝图契约（storyArcChapters 改绑后的真实供给面）。
    const blueprint = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.blueprint", role: "planner" });
    const blueprintText = renderSkillInstruction(blueprint, "chapter.blueprint");
    expect(blueprintText).toContain("选择窗口");
    // 2026-10-13（state-audit-20261013.md §7 第 4 项）：title 由蓝图路径产出，命名技艺必须同点可达。
    // 此前 chapter-naming 只声明 chapter.title，而该执行点只被手动"AI 更名"工作流消费——
    // 实测本项目 168 章零次 chapter-title 工作流运行，全部标题出自蓝图，故命名指引从未生效。
    expect(blueprintText).toContain("命名\"这一章\"而不是\"这一类情节\"");
    expect(blueprint.skills.some((skill) => skill.skillId === "chapter-naming")).toBe(true);
  });

  it("keeps workspace Skill execution points aligned with the live reviewer contract", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const descriptors = await provider.list("test-project");
    const validPoints = new Set(Object.keys(SKILL_EXECUTION_POLICIES));
    for (const descriptor of descriptors) {
      for (const point of descriptor.executionPoints ?? []) expect(validPoints.has(point)).toBe(true);
    }
  });

  it("resolves a role-specific Skill for every chapter reviewer", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const reviewers = [
      ["structure-reviewer", "chapter.review.structure"],
      ["character-reviewer", "chapter.review.character"],
      ["prose-reviewer", "chapter.review.prose"],
    ] as const;
    for (const [role, executionPoint] of reviewers) {
      const bundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role });
      expect(bundle.skills.some((skill) => skill.priority === "required")).toBe(true);
      expect(bundle.skills.some((skill) => skill.roles?.includes(role))).toBe(true);
    }
  });

  it("injects the cross-layer anti-degeneration craft Skills with fresh fingerprints", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const descriptors = await provider.list("test-project");
    const byId = new Map(descriptors.map((skill) => [skill.skillId, skill]));

    for (const skillId of ["prose-craft", "reader-emotion", "plot-causality"]) {
      // 守卫值随 workspace yaml 版本演进（prose-craft 曾升 1.4.0 未同步本守卫，属存量断链修复）；
      // 断言的仍是"清单能解析出版本与指纹"这一契约，非具体措辞。
      expect(byId.get(skillId)?.version).toBe(skillId === "prose-craft" ? "1.6.0" : "1.1.0");
      expect(byId.get(skillId)?.contentFingerprint).toBeTruthy();
    }

    const draft = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" });
    const draftText = renderSkillInstruction(draft, "chapter.drafting");
    expect(draftText).toContain("当前 POV");
    expect(draftText).toContain("检测器结果");

    const planning = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.blueprint", role: "planner" });
    expect(renderSkillInstruction(planning, "chapter.blueprint")).toContain("选择窗口");

    const arcPlanning = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "arc.plan", role: "planner" });
    const arcPlanningText = renderSkillInstruction(arcPlanning, "arc.plan");
    expect(arcPlanningText).not.toContain("固定顺序");
    expect(arcPlanningText).not.toContain("现场过程");

    const arcReview = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "arc.review", role: "structure-reviewer" });
    const arcReviewText = renderSkillInstruction(arcReview, "arc.review");
    expect(arcReviewText).toContain("问题阶梯");
    expect(arcReviewText).toContain("不可逆出口");
    expect(arcReviewText).toContain("读者回报");
    expect(arcReviewText).toContain("安静、关系、背景、铺垫和余波弧与行动弧同样合法");
    expect(arcReviewText).not.toContain("缺失任一契约按 major 报告");

    const arcRevision = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "arc.revision", role: "reviser" });
    const arcRevisionText = renderSkillInstruction(arcRevision, "arc.revision");
    expect(arcRevisionText).toContain("补问题阶梯");
    expect(arcRevisionText).toContain("安静弧按其功能证据修订而不是改造成行动弧");

    const review = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.review.prose", role: "prose-reviewer" });
    const reviewText = renderSkillInstruction(review, "chapter.review.prose");
    expect(reviewText).toContain("当前功能失效");
    expect(reviewText).toContain("信息差");
    expect(reviewText).toContain("摘要式结论");
  });

  /**
   * 跨章清点惯性（2026-10-14 复核轮读者视角实测，state-audit §8.1）三面接线。
   *
   * 读者证据：主角独处章反复以同一套动作序列清点随身物件并逐件配同类温度/质感判定，
   * 章级密度实测道具盘点族全书均值 2.16/千字而 21-40 章达 5.30（6.6× 全书），
   * 温度族 61-80 章 1.52/千字——两族峰值正好落在商业基准对照确诊的"死亡象限"。
   * 该形态与对白崩落同源：对手戏缺席，章节以物件与内省填充。
   *
   * 三面必须都有，否则规则只落在写作侧而审核侧看不见（或反之无法执行）。
   * 断言的是"判据在三面都在场"，不是具体措辞——措辞可演进，缺席即回归。
   */
  it("跨章清点惯性判据在写作、审核、修订三面都在场", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const faces: Array<[SkillExecutionPoint, string]> = [
      ["chapter.drafting", "writer"],
      ["chapter.review.prose", "prose-reviewer"],
      ["chapter.revision", "reviser"],
    ];
    for (const [executionPoint, role] of faces) {
      const bundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role });
      const text = renderSkillInstruction(bundle, executionPoint);
      expect(text, `${executionPoint} 缺少清点惯性判据`).toContain("清点");
    }
    // 写作侧的定性：这是"该有的现场没发生"，不是动作出现次数禁令——
    // 写成禁用表即违反 prose-craft 自身的"不以固定句式、字词禁用表代替判断"。
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText).toContain("新信息");
    expect(draftText).toContain("新选择");
    expect(draftText).toContain("新代价");
    // 审核侧必须要求指明"挤掉了什么"，否则动刀理由会退化成频率统计。
    const reviewText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.review.prose", role: "prose-reviewer" }),
      "chapter.review.prose",
    );
    expect(reviewText).toContain("挤掉了什么");
  });

  /**
   * "数数"必须从清点惯性里除名（2026-10-14 复核轮 round 10 的误判撤回）。
   *
   * round 2 把"以数数收束一章"与清点惯性并列为同族病（"一处是留白，多处是模板"）。
   * 可达性验证推翻了这个归类：数数与章节强度**正相关**——四个合格带均值 0.57/千字
   * 高于含不合格的混合带 0.44；全书最强的 099-127 带 0.75 为各带最高；
   * 质量最差的 001-014 带仅 0.05。直读最强带样本可见数数常是章的核心意象与认知
   * 过程本身（ch124「数着自己的步子，又数着笔声的拍子」；ch123「翻出一串数字，
   * 四十七…答案不是新路，答案是旧路」）。
   *
   * 若不撤回，规则会命令作者/审核面去"修"一个本该保留的声音特征——本书的克制底色
   * 很大程度就建立在这种节律上。这与 AGENTS.md"禁止把个案固化成硬门"同族：
   * **把有效声音误判成瑕疵**。
   *
   * 双向覆盖：
   *  - 写作侧必须写明"数数不是同族惯性"，且给出数据依据的方向（不是禁令）；
   *  - 审核侧必须写明"不得仅因又出现数数而报"；
   *  - 反向：不得再把"一处是留白，多处是模板"这类**频率判据**套在数数上。
   */
  it("数数已从清点惯性除名（不得仅因频率报它）", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText, "写作侧必须写明数数不是同族惯性").toContain("数数不是同族惯性");
    expect(draftText, "必须给出它与质量正相关的方向，而非只说'撤回了'").toContain("与章节强度正相关");

    const reviewText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.review.prose", role: "prose-reviewer" }),
      "chapter.review.prose",
    );
    expect(reviewText, "审核侧必须写明不得仅因频率报数数").toContain("不得仅因");
    // 反向：频率式套话不得回来（round 2 的原措辞）。
    expect(draftText, "数数不得再被套上'一处是留白，多处是模板'的频率判据").not.toContain("一处是留白，多处是模板");
    expect(reviewText, "数数不得再被列为必报惯性").not.toContain("以数数收束一章而在近章已反复出现");
  });

  it("gives foundation review its own role-specific evidence Skill without changing planning resolution", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const planning = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "foundation.book-plan", role: "planner" });
    const review = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "foundation.book-plan", role: "foundation-reviewer" });
    expect(planning.skills.some((skill) => skill.skillId === "review-gate")).toBe(false);
    expect(review.skills.some((skill) => skill.skillId === "review-gate")).toBe(true);
    expect(review.skills.some((skill) => skill.roles?.includes("foundation-reviewer"))).toBe(true);
    expect(renderSkillInstruction(review, "foundation.book-plan")).toContain("项目级架构审核");
    expect(renderSkillInstruction(review, "foundation.book-plan")).toContain("承诺可兑现");
    expect(renderSkillInstruction(review, "foundation.book-plan")).toContain("不是必须全部成立的硬门");
  });

  it("binds chapter.script and short.script exclusively to the H3 script skill and keeps drafting skills out", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const descriptors = await provider.list("test-project");
    expect(descriptors.some((skill) => skill.skillId === "h3-video-prompt")).toBe(true);
    for (const descriptor of descriptors) {
      if (descriptor.skillId !== "h3-video-prompt") {
        expect(descriptor.executionPoints ?? []).not.toContain("chapter.script");
        expect(descriptor.executionPoints ?? []).not.toContain("short.script");
      }
    }

    for (const executionPoint of ["chapter.script", "short.script"] as const) {
      const bundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint });
      expect(bundle.skills.map((skill) => skill.skillId)).toEqual(["h3-video-prompt"]);
      const instruction = renderSkillInstruction(bundle, executionPoint);
      for (const section of ["subjectDefinitions", "summary", "retentionAnalysis", "detailedDescription", "overallSoundscape", "nonDiegeticMusic"]) {
        expect(instruction).toContain(section);
      }
      expect(instruction).toContain("[Shot N]");
      expect(instruction).toContain("Ref2VA");
    }
    // 创意入口专属指引：无定稿正文，从核心创意自拟节拍
    const shortBundle = await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "short.script" });
    expect(renderSkillInstruction(shortBundle, "short.script")).toContain("核心创意");
  });

  it("reads workspace Skill content on every resolution without a process cache", async () => {
    const root = await temporarySkillRoot();
    const file = path.join(root, "draft.yaml");
    await writeFile(file, "skillId: test-drafting\nversion: 1.0.0\nexecutionPoints: [chapter.drafting]\nroles: [writer]\ncapabilities: [draft]\npriority: required\npromptSections:\n  chapter.drafting: first prompt\n", "utf8");
    const provider = createWorkspaceSkillProvider(root);
    const first = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    await writeFile(file, "skillId: test-drafting\nversion: 1.0.1\nexecutionPoints: [chapter.drafting]\nroles: [writer]\ncapabilities: [draft]\npriority: required\npromptSections:\n  chapter.drafting: second prompt\n", "utf8");
    const second = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    expect(second.resolution?.skills[0].version).toBe("1.0.1");
    expect(second.resolution?.fingerprint).not.toBe(first.resolution?.fingerprint);
    expect(renderSkillInstruction(second, "chapter.drafting")).toContain("second prompt");
  });

  it("reads database Skill content on every resolution and has no local fallback", async () => {
    let current = draftSkill("database prompt one");
    const provider = createDatabaseSkillProvider(async () => [current]);
    const first = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    current = draftSkill("database prompt two", { version: "1.0.1" });
    const second = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    expect(second.resolution?.fingerprint).not.toBe(first.resolution?.fingerprint);
    expect(renderSkillInstruction(second, "chapter.drafting")).toContain("database prompt two");

    const emptyDatabase = createDatabaseSkillProvider(async () => []);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider: emptyDatabase, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow("database Skill 为空");
  });

  it("keeps invalid database execution points visible and refuses runtime resolution", async () => {
    const descriptor = normalizeSkillDescriptor({ ...draftSkill("draft"), executionPoints: ["chapter.drafting", "stale.execution-point"] as unknown as SkillDescriptor["executionPoints"] });
    expect(descriptor.executionPoints).toEqual(["chapter.drafting"]);
    expect(descriptor.invalidExecutionPoints).toEqual(["stale.execution-point"]);
    const provider = createDatabaseSkillProvider(async () => [descriptor]);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow(/stale.execution-point/);
  });

  /**
   * role 词表必须闭合（2026-10-14 复核轮 round 16）。
   *
   * 背景：role 此前是**开放字符串**——调用点写字面量（`role: "writer"`），审校三面通过
   * `chapter-review.ts` 的 `ReviewerRole` 联合类型传（故**不出现在字面量里**），技能侧在
   * YAML 里自行声明。于是"某个 role 是不是活的"只能靠临时扫源码回答，而**扫漏文件就会
   * 得出错结论**：本轮首版漏了 `prompts/chapter-review.ts` 的枚举与
   * `evaluation/skill-iteration.ts` 的调用点，把 `character-reviewer` / `prose-reviewer` /
   * `skill-iterator` 三个**活的** role 误报成死声明。这是本会话第四次"枚举不全 ⇒ 假结论"。
   *
   * 故把词表变成契约（`SKILL_ROLES`），并**把枚举固化成测试**：三条判据同时成立才算闭合——
   * ① 每个技能声明的 role 都在词表内（否则该技能在那个角色下被静默排除）；
   * ② 每个生产调用点传的 role 都在词表内（含 `ReviewerRole` 联合类型与 `reviewExecutionPoint`
   *    的映射键——**这两种形态不会以字面量出现，必须显式枚举，正是首版翻车处**）；
   * ③ 词表里每个 role 都**确实有**调用点会传（否则是死词条，会诱使技能去声明一个永不匹配的 role）。
   * 判据 ③ 是防"再犯"的关键：将来新增调用点形态时它会逼作者把该形态纳入枚举。
   */
  it("role 词表闭合：技能声明、调用点实参、词表三者互相覆盖", async () => {
    const readSource = (file: string) => readFileSync(file, "utf8").split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

    // ② 调用点实参——三种形态都要枚举。
    const callSiteFiles = [
      "src/novel-v2/temporal/activities.ts",
      "src/novel-v2/evaluation/skill-iteration.ts",
      "src/novel-v2/prompts/chapter-review.ts",
    ];
    const passed = new Set<string>();
    for (const file of callSiteFiles) {
      const source = readSource(file);
      for (const match of source.matchAll(/role:\s*"([a-z-]+)"/gu)) passed.add(match[1]);
    }
    // 形态二：ReviewerRole 联合类型的成员（经 reviewExecutionPoint(input.role) 传入）。
    const reviewSource = readSource("src/novel-v2/prompts/chapter-review.ts");
    const reviewerUnion = reviewSource.match(/export type ReviewerRole =([^;]+);/u)?.[1] ?? "";
    const reviewerRoles = [...reviewerUnion.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]);
    expect(reviewerRoles.length, "ReviewerRole 联合类型没解析到，锁会空转").toBeGreaterThan(1);
    for (const role of reviewerRoles) passed.add(role);
    // 形态三：reviewExecutionPoint 映射表的键（与联合类型同源，防只改一处）。
    for (const match of reviewSource.matchAll(/^\s*"([a-z-]+)":\s*"chapter\.review\./gmu)) passed.add(match[1]);

    // ① 技能声明。
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const declared = new Set<string>();
    for (const skill of await listCurrentSkillDescriptors(provider, "p1")) for (const role of skill.roles ?? []) declared.add(role);

    // ① 技能声明的 role 必须在词表内。
    const registry = new Set<string>(SKILL_ROLES);
    expect([...declared].filter((role) => !registry.has(role)).sort(), "技能声明了词表外的 role（该角色下会被静默排除）").toEqual([]);
    // ② 调用点传的 role 必须在词表内。
    expect([...passed].filter((role) => !registry.has(role)).sort(), "调用点传了词表外的 role").toEqual([]);
    // ③ 词表每个成员都必须有调用点会传（否则是死词条）。
    expect([...registry].filter((role) => !passed.has(role)).sort(), "词表里有调用点从不使用的 role（死词条）").toEqual([]);
    // 反向兜底：技能声明的 role 必须真的有调用点会传（否则声明再合法也没用）。
    expect([...declared].filter((role) => !passed.has(role)).sort(), "技能声明的 role 没有任何调用点会传").toEqual([]);
  });

  /**
   * 题材匹配是**软偏好**，两条解析路径必须同口径（2026-10-14 复核轮 round 17）。
   *
   * 失效形态（实测）：同一判据在两处实现成**相反兜底**——
   *   `cognition.resolveSkillBundle`：`input.genre ? ...includes(genre) : true`（不知道就不排除）
   *   `skillRuntime.resolveStageSkillBundle`：`: false`（不知道就排除）
   * 而后者是**生产路径**，且 21 个调用点里 19 个不传 genre（章节级阶段全不传）。
   * ⇒ 任何声明了 `applicableGenres` 的 skill 在生产上**永不生效**。
   * 这不是理论风险：学习闭环能把题材相关规则晋升为 skill
   * （`promotion-service` 持久化 `applicable_genres`，learning 提示词还明确要求模型填题材标签）。
   * cognition 的 Phase 3.3 注释已明写契约是"软偏好：若无匹配 genre 的 skill，仍回退到题材无关的 skill"。
   *
   * 四条判据（前两条是修复点，后两条防过度纠正）：
   *  ① 未知题材 ⇒ 保留（"不知道"不等于"不匹配"）；
   *  ② 题材命中 ⇒ 保留；
   *  ③ 题材不匹配且**存在**题材无关替代 ⇒ 排除特化技能（软偏好的方向仍然生效）；
   *  ④ 全被题材过滤掉 ⇒ 回退到未过滤集，**不抛错**（软偏好而非硬门）。
   */
  it("题材匹配是软偏好：未知题材不排除、全被过滤时回退（与 cognition 同口径）", async () => {
    const restricted = { ...draftSkill("题材特化指引"), skillId: "genre-skill", applicableGenres: ["仙侠"] };
    const generic = { ...draftSkill("题材无关指引"), skillId: "generic-skill", applicableGenres: [] };
    const bundleOf = async (skills: SkillDescriptor[], genre?: string) => {
      const provider = createDatabaseSkillProvider(async () => skills);
      return renderSkillInstruction(
        await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer", ...(genre === undefined ? {} : { genre }) }),
        "chapter.drafting",
      );
    };

    // ① 未知题材 ⇒ 保留（修复前此处抛错/排除）。
    expect(await bundleOf([restricted]), "未知题材不得排除题材特化技能").toContain("题材特化指引");
    // ② 题材命中 ⇒ 保留。
    expect(await bundleOf([restricted], "仙侠")).toContain("题材特化指引");
    // ③ 题材不匹配且有题材无关替代 ⇒ 排除特化技能，保留通用的。
    const mismatched = await bundleOf([restricted, generic], "都市");
    expect(mismatched, "题材不匹配时应让位给题材无关技能").not.toContain("题材特化指引");
    expect(mismatched).toContain("题材无关指引");
    // ④ 全被题材过滤掉 ⇒ 回退到未过滤集，不抛错。
    expect(await bundleOf([restricted], "都市"), "全被题材过滤时应回退而非抛错").toContain("题材特化指引");
  });

  /**
   * promptSections 的"查不到的键"必须被检出（2026-10-14 复核轮 round 15）。
   *
   * 失效形态：渲染口径是 `promptSections[executionPoint] ?? promptSections[coarse]`，
   * 故一个拼写错的键（`chapter.draftng`）永远查不到 ⇒ **那段指引静默丢失**。
   * 而既有的"该执行点无 prompt 内容就抛"（:343）**盖不住它**：只要同技能另有一个
   * coarse 键（如 `drafting`）兜底，该执行点就有内容、不抛，错键就藏在后面。
   *
   * **分档（与执行点漂移刻意不同）**：执行点无效 ⇒ 技能挂不上任何阶段，是硬错、解析抛；
   * promptSections 错键 ⇒ 技能照常工作、只是少一段指引，故**只报告不抛**。
   * 理由：在解析处抛会让一个历史遗留夹具行打断整条链（实测：共享测试库的
   * `test-craft-skill` 用 `chapter.review` 这个不存在的中间名，抛错立刻打断三例与
   * 技能迭代无关的用例）。报告面是 skills CLI 的 check 与 doctor 的 skill-drift。
   *
   * 双向覆盖：
   *  - 命中面：coarse 兜底在场时错键仍须被检出，且**解析照常成功**（不升级成停摆）；
   *  - 反例一：合法键（执行点 + coarse）不得被误报；
   *  - 反例二：归一化补出的 coarse 别名不得被判非法（判定必须在归一化之前）；
   *  - 反例三：12 个生产技能真源体检零错键。
   */
  it("检出永远不会被渲染的 promptSections 键（coarse 兜底掩盖不住；只报告不抛）", async () => {
    // 命中面：coarse 兜底在场（drafting），错键仍须被检出。
    const typo = normalizeSkillDescriptor({
      ...draftSkill("兜底内容"),
      promptSections: { drafting: "兜底内容", "chapter.draftng": "拼错的键，永远不会被渲染" } as SkillDescriptor["promptSections"],
    });
    expect(typo.invalidPromptSectionKeys).toEqual(["chapter.draftng"]);
    // 分档：解析**不得**因错键失败——技能照常工作，缺的只是那一段指引。
    const provider = createDatabaseSkillProvider(async () => [typo]);
    const bundle = await resolveStageSkillBundle({ projectId: "p1", provider, executionPoint: "chapter.drafting", role: "writer" });
    expect(renderSkillInstruction(bundle, "chapter.drafting")).toContain("兜底内容");
    // 且错键内容确实没进 prompt（证明它真的是死键，不是"其实渲染了"）。
    expect(renderSkillInstruction(bundle, "chapter.drafting")).not.toContain("拼错的键");

    // 反例一：合法键（执行点 + coarse）都不得被误报。
    const valid = normalizeSkillDescriptor({
      ...draftSkill("正文指引"),
      promptSections: { drafting: "粗粒度兜底", "chapter.drafting": "正文指引", review: "审核指引", "chapter.review.prose": "散文审核" } as SkillDescriptor["promptSections"],
    });
    expect(valid.invalidPromptSectionKeys).toBeUndefined();

    // 反例二：归一化补出的 coarse 别名不得被判非法（判定必须在归一化之前）。
    const propagated = normalizeSkillDescriptor({ ...draftSkill("x"), promptSections: { "chapter.drafting": "x" } as SkillDescriptor["promptSections"] });
    expect(propagated.promptSections.drafting, "归一化会补 coarse 别名").toBe("x");
    expect(propagated.invalidPromptSectionKeys).toBeUndefined();

    // 反例三：全部生产技能都不得有错键（真源体检）。
    const workspace = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const offenders = (await listCurrentSkillDescriptors(workspace, "p1")).filter((skill) => skill.invalidPromptSectionKeys?.length);
    expect(offenders.map((skill) => `${skill.skillId}=[${skill.invalidPromptSectionKeys!.join(",")}]`)).toEqual([]);
  });

  it("rejects missing dependencies and conflicts", async () => {
    const missingDependency = createDatabaseSkillProvider(async () => [draftSkill("draft", { dependsOn: ["missing"] })]);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider: missingDependency, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow("缺少依赖");

    const conflicting = createDatabaseSkillProvider(async () => [
      draftSkill("draft", { conflicts: ["conflict"] }),
      draftSkill("conflict", { skillId: "conflict", conflicts: [], capabilities: ["draft"], promptSections: { "chapter.drafting": "conflict" } }),
    ]);
    await expect(resolveStageSkillBundle({ projectId: "p1", provider: conflicting, executionPoint: "chapter.drafting", role: "writer" })).rejects.toThrow("Skill 冲突");
  });

  it("fails instead of silently dropping a required Skill when the context budget is too small", () => {
    expect(() => compileStageContext({
      projectId: "p1",
      workflowId: "w1",
      purpose: "writing.draft",
      stage: "drafting",
      maxInputTokens: 32,
      reservedOutputTokens: 16,
      skillManifest: {
        source: "workspace",
        executionPoint: "chapter.drafting",
        resolvedAt: 1,
        skills: [{ skillId: "required", version: "1.0.0", contentFingerprint: "fp", priority: "required" }],
        dependencyClosure: ["required"],
        omittedOptionalSkills: [],
        fingerprint: "manifest-fp",
      },
      sections: [{ id: "required-skill", kind: "skill", title: "required", text: "a required Skill instruction that cannot fit", priority: "required", provenanceRefs: ["required"] }],
    })).toThrow(StageContextBudgetError);
  });

  it("records resolved and actually injected Skills separately", () => {
    const result = compileStageContext({
      projectId: "p1",
      workflowId: "w-manifest",
      purpose: "writing.draft",
      stage: "drafting",
      maxInputTokens: 1_000,
      reservedOutputTokens: 100,
      skillManifest: {
        source: "workspace",
        executionPoint: "chapter.drafting",
        resolvedAt: 1,
        skills: [
          { skillId: "required", version: "1.0.0", contentFingerprint: "required-fp", priority: "required" },
          { skillId: "optional", version: "1.0.0", contentFingerprint: "optional-fp", priority: "optional" },
        ],
        dependencyClosure: ["required", "optional"],
        omittedOptionalSkills: [],
        fingerprint: "manifest-fp",
      },
      sections: [{ id: "required-skill", kind: "skill", title: "required", text: "required Skill instruction", priority: "required", provenanceRefs: ["required@1.0.0"] }],
    });
    expect(result.manifest.skillManifest?.skills.map((skill) => skill.skillId)).toEqual(["required", "optional"]);
    expect(result.manifest.skillManifest?.injectedSkills?.map((skill) => skill.skillId)).toEqual(["required"]);
  });

  it("compiles each Skill section independently so budget and manifest stay aligned", () => {
    const bundle = {
      skills: [
        draftSkill("required instruction", { priority: "required" }),
        draftSkill("optional instruction that should be excluded by the section budget", { skillId: "optional", priority: "optional" }),
      ],
    };
    const sections = buildSkillContextSections(bundle, "chapter.drafting");
    expect(sections.map((section) => [section.id, section.priority])).toEqual([
      ["skill:test-drafting@1.0.0", "required"],
      ["skill:optional@1.0.0", "soft"],
    ]);

    const result = compileStageContext({
      projectId: "p1",
      workflowId: "w-skill-sections",
      purpose: "writing.draft",
      stage: "drafting",
      maxInputTokens: 80,
      reservedOutputTokens: 10,
      skillManifest: {
        source: "workspace",
        executionPoint: "chapter.drafting",
        resolvedAt: 1,
        skills: bundle.skills.map((skill) => ({ skillId: skill.skillId, version: skill.version, contentFingerprint: "fp", priority: skill.priority! })),
        dependencyClosure: bundle.skills.map((skill) => skill.skillId),
        omittedOptionalSkills: [],
        fingerprint: "manifest-fp",
      },
      sections: [{ id: "manuscript", kind: "manuscript", title: "正文", text: "正文", priority: "critical", provenanceRefs: ["artifact-1"] }, ...sections],
    });
    expect(result.instruction).toContain("required instruction");
    expect(result.instruction).not.toContain("optional instruction");
    expect(result.manifest.skillManifest?.injectedSkills?.map((skill) => skill.skillId)).toEqual(["test-drafting"]);
  });
});

describe("skill 版本比较（SK-2 单一真源 sync 护栏）", () => {
  it("数值段比较：晋升版本判为超前、seed 旧版不覆盖；等版本持平", () => {
    expect(compareSkillVersions("1.4.0", "1.3.9")).toBeGreaterThan(0);
    expect(compareSkillVersions("1.10.0", "1.9.0")).toBeGreaterThan(0); // 数值段不是字典序
    expect(compareSkillVersions("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compareSkillVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareSkillVersions("1.4", "1.4.1")).toBeLessThan(0); // 缺段视为更旧
    expect(compareSkillVersions("1.4.0-beta", "1.4.0-alpha")).toBeGreaterThan(0); // 非数值段退回字典序不崩溃
  });
});
