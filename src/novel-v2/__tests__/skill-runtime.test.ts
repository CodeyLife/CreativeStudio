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
      expect(byId.get(skillId)?.version).toBe(skillId === "prose-craft" ? "1.15.0" : skillId === "reader-emotion" ? "1.2.0" : skillId === "review-gate" ? "1.1.0" : "1.1.0");
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
   * 情绪节拍不得默认落在面部表情上（2026-10-14 复核轮 round 19）。
   *
   * 读者视角实测（`tmp/state-audit/measure-gesture-idioms.mts`）：面部微表情族
   * （嘴角/眉头/眉心/眼神/眼底/眼皮）密度与章节强度**负相关**——
   * 含不合格的混合带 0.58/千字、全书最强的 099-127 带 0.05、全书均值 0.27，
   * 且**已排除"独处章没有第二张脸可写"这一混杂**：非独处章层内 0.77 vs 0.27，差距不消失
   * （`verify-gesture-confounded-by-solo.mts`）。原始计数 115 处，非小样本噪声。
   *
   * 与既有"叙述者不替读者论证"的分工：那条治的是**段落级**解释，
   * 本条治**小句级**的"表情 + 一句说明它意味着什么"。
   *
   * 三面接线 + 反例（不得写成词表禁用——表情本身完全合法）。
   */
  /**
   * "叙述者替读者论证"的实测定性：全书几乎绝迹，且不可被读成"可以总结"（round 36）。
   *
   * 实测（measure-reconstruction-density.mts）：全书 168 章里总结连接词
   * （因此/所以/总之/说到底/这意味着/这便是/可见）共 **32 处（0.07/千字）**，
   * 合格带 0.10 / 混合带 0.08 / 最强带 0.09——密度极低且与质量无关，
   * 说明这条禁令**从未被真正触发过**（与 round 33 的问句收尾零计数同族）。
   *
   * 同时记录了**反向代理的失败**：用"可观察要素密度"（身体+接触+空间方位）测复原度
   * 得到全书 102/千字、四带比值 0.92，毫无区分度——因为"左右/上下/里外"等单字
   * 在中文里本就高频，代理被常用二元组淹没。⇒ 本条的可靠执行面仍是**语义判断**，
   * 不得改成可计算的密度门。这把锁钉住这个"不可计算"的结论，
   * 防止后人照那次失败的代理去立一个密度门。
   */

  /**
   * review-gate 的十项必须与审核 prompt 的检查项**双向对齐**（2026-10-14 round 41）。
   *
   * round 41 用语义对应（不是字面子串——首版字面比对得出"8 项只到 2 项"是错的：
   * prompt 用了不同标题表达同一内容，如 skill 的"欲望-阻力-选择-代价闭环"对应 prompt 的
   * "最小动力闭环"）核验后得到两个真实结论：
   *   ① **承诺兑现**：skill 十项在 prompt 里逐项有对应检查项，且 foundation-contract 的
   *      error 级门只有结构契约字段 ⇒ "是检查方向而非硬门"的承诺成立；
   *   ② **反向缺口**：prompt 有 2 项 skill 未登记（表层大众化、揭示物分层）
   *      ⇒ skill 清单落后于 prompt，已补齐为十项。
   *
   * 这把锁双向都钉：skill 必须含两项新增；且 skill 声明的十项必须真在 prompt 里
   * （防止 skill 单方面膨胀出 prompt 没有的项）。
   */
  it("review-gate 十项与审核 prompt 双向对齐：补齐两项新增，且不得单方面膨胀", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const text = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "foundation.book-plan", role: "foundation-reviewer" }),
      "foundation.book-plan",
    );
    // ① 两项新增必须在 skill 里。
    expect(text, "skill 须登记 prompt 已有的'表层大众化'").toContain("表层大众化");
    expect(text, "skill 须登记 prompt 已有的'揭示物分层'").toContain("揭示物分层");
    // ② 十项的措辞都要在（原八项 + 两项新增）。
    for (const item of ["承诺可兑现", "主题进入选择", "欲望-阻力-选择-代价闭环", "配角独立欲望与关系网络", "世界观规则改变人物可选集合", "感情线靠行动累积而非宣言", "重复与升级是否改变层级", "读者不确定性是否有可推断证据"]) {
      expect(text, `skill 十项缺项：${item}`).toContain(item);
    }
    // ③ 口径对应（skill 措辞 ↔ prompt 标题）必须写明，否则后人又会用字面比对误判。
    expect(text, "须写明与 prompt 的口径对应关系").toContain("最小动力闭环");
    expect(text, "须写明口径对应已核验").toContain("口径对应已核验");
    // ④ 反向：prompt 里必须有这些对应项（防 skill 单方面膨胀）。
    const prompt = readFileSync("src/novel-v2/prompts/foundation-review.ts", "utf8");
    for (const anchor of ["读者承诺可兑现", "主题进入选择", "最小动力闭环", "群像独立", "世界观压力系统", "感情线行动累积", "疲劳管理", "留白证据", "表层大众化", "揭示物分层"]) {
      expect(prompt, `审核 prompt 缺项：${anchor}`).toContain(anchor);
    }
  });

  /**
   * reader-emotion 的实测与代理边界（2026-10-14 复核轮 round 40）。
   *
   * `reader-emotion.yaml` 是三面共用的 required skill，从 1.1.0 起从未单独取证
   * （12 个 skill 里此前只有 fact-memory 与 prose-craft 有实测）。本轮取证后：
   *   - **宣告型**（情绪词后只跟抽象名词、无承载物）全书 **1 处**，
   *     合格带 0、**最强带 0** ⇒ 与 round 33 问句收尾、round 36 总结连接词同族的
   *     **零计数确认**：这条禁令从未被真正触发过，本书本来就不宣布情绪。
   *   - **代理边界必须一起写**：情绪词基数只有 27 处（0.054/千字），因为情绪主要由
   *     动作/物件/空间承担（正是本条要求的），所以以情绪词为分母的密度指标**没有分辨力**。
   *     不写这条，后人会误读成"情绪浓度低＝缺情绪推进"。
   *   - 章内疑问句 0.566/千字 与 round 33 的"章尾问句 0 处"是**两个口径**。
   *
   * 本锁钉住这三条，防止实测被简化成"情绪越少越好"这种反向误读。
   */
  it("reader-emotion 带着零值实测与代理边界：不得读成情绪越少越好", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const text = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(text, "必须带上宣告型的零值实测").toContain("全书仅 **1 处**");
    expect(text, "必须写明最强带为 0").toContain("最强带 0");
    // 关键防误读：代理边界必须写在同一条。
    expect(text, "必须写明该密度代理没有分辨力").toContain("没有分辨力");
    expect(text, "必须禁止读成情绪浓度低等于缺情绪推进").toContain("情绪浓度低");
    // 两个口径的区分也要在（防止与 round 33 的章尾问句结论冲突）。
    expect(text, "须区分章内疑问与章尾问句两个口径").toContain("章内疑问句");
  });

  /**
   * 全仓 skill 不得出现"承诺持久保证但数据模型交付不了"的措辞（round 38 + 39）。
   *
   * round 38 在 fact-memory 抓到一处：spec 说"每条事实都要有正文逐字证据、来源段落"，
   * 而 evidence 只在写入前做过滤/去重、**落库即弃**（memory_claims 无该列）。
   * round 39 把同一类别扫全部 12 个 skill（tmp/state-audit/audit-skill-promises.mts），
   * 候选逐一人工核过：其余均为行为要求，或有真实落点（如 narrative-continuity 的
   * "报告为证据越界"经审核 issue 的 rule 字段落库到 chapter_review_snapshot，可回溯）
   * ⇒ **无新增同类缺陷**。
   *
   * 本锁把那次扫描结论固化为常态守卫：抓"逐字证据 + 来源段落"这类听起来像持久保证的
   * 组合措辞，并要求一旦提到逐字证据就必须同段说明其边界。
   */
  it("任何 skill 不得承诺持久保证而数据模型无落点（round 39 全仓扫描结论固化）", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const points: Array<[SkillExecutionPoint, string]> = [
      ["chapter.fact-extraction", "fact-extractor"],
      ["character.enrichment", "character-enricher"],
      ["chapter.drafting", "writer"],
      ["chapter.review.prose", "prose-reviewer"],
      ["chapter.revision", "reviser"],
      ["foundation.book-plan", "foundation-planner"],
      ["arc.plan", "arc-planner"],
    ];
    for (const [executionPoint, role] of points) {
      const text = renderSkillInstruction(
        await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role }),
        executionPoint,
      );
      expect(text, `${executionPoint} 不得承诺逐字证据会被持久保存`).not.toContain("每条事实都要有正文逐字证据、来源段落");
      if (text.includes("逐字证据")) {
        expect(text, `${executionPoint} 提到逐字证据时必须说明其边界`).toMatch(/不被持久化|无法回溯|将来不可核对/u);
      }
    }
  });

  /**
   * fact-memory 的证据边界：spec 不得承诺数据模型交付不了的保证（2026-10-14 round 38）。
   *
   * 实测的错配：`fact-memory.yaml` 原写"每条事实都要有正文逐字证据、来源段落和 novelty 判断"，
   * 而管线实际只做到：
   *   - `prompt.ts:70` 要求 evidence ≥8 字逐字、`dedupe.ts:99` 用它**丢弃**、`:127` 用它**去重**；
   *   - 但 `recordMemoryClaims` 落库时**不写 evidence**——`memory_claims` 无该列，
   *     `memory_claim_sources` 只存 document/revision/artifact 链接（真库实测列清单）。
   * ⇒ 证据是**写入前的过滤凭据**，落库后**不可回溯**。这是 round 15 的同族：
   * "不阻塞主路径"与"不留痕迹"是两件事——过滤做了，痕迹没留。
   */
  it("fact-memory 证据边界：写明不持久化、不可回溯，且不得承诺成存档保证", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const text = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.fact-extraction", role: "fact-extractor" }),
      "chapter.fact-extraction",
    );
    expect(text, "必须写明 evidence 不被持久化").toContain("不被持久化");
    expect(text, "必须写明落库后不可回溯核对").toContain("无法回溯核对");
    expect(text, "须给出可执行的自我约束").toContain("将来不可核对");
    // 反向：不得把过滤承诺成存档保证。
    expect(text, "不得承诺每条事实都有持久化的逐字证据").not.toContain("每条事实都要有正文逐字证据");
    const enrichment = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "character.enrichment", role: "character-enricher" }),
      "character.enrichment",
    );
    expect(enrichment, "人物增量的证据边界也要写明").toContain("将来不可核对");
  });

  /**
   * 审核面的"边界"必须集中在列表之后，不穿插在必查项里（2026-10-14 复核轮 round 37）。
   *
   * round 30/31/33 收窄了表情判据（只报"表情+释义"）、retract 了数数禁令、
   * round 30 加了序数是正面声音。**但那些窄化说明原先是穿插在评测项列表内部的**，
   * 于是审阅者按顺序读列表时，先读到的是收窄前的宽表述（"而该节拍本可由动作、
   * 选择或对白后果承担"），窄化说明反而在其后作为括注出现——括注在注意力上输给主句。
   *
   * 这是同一条指令内部的"两处口径"（round 14 的跨面同族缺陷）：
   * 宽表述在列表里（会被执行的那一份），窄表述在括注里（会被跳过的那一份）。
   *
   * 本锁钉住结构：列表项只保留收窄后的短形式 + 指路；三条边界集中在
   * "**下面是上面各项的边界**"段内，且各带编号①②③。
   */
  it("审核面边界集中在列表后，必查项列表不携带未收窄表述", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const reviewText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.review.prose", role: "prose-reviewer" }),
      "chapter.review.prose",
    );

    // ① 集中的边界段必须在场，三条边界各带编号。
    expect(reviewText, "必须有集中的边界段").toContain("下面是上面各项的边界");
    expect(reviewText, "边界① 面部表情").toContain("① **面部表情**");
    expect(reviewText, "边界② 数数").toContain("② **数数");
    expect(reviewText, "边界③ 序数").toContain("③ **序数作推演编号");

    // ② 必查项列表里**不得**再出现未收窄的宽表述（取列表段做反向断言）。
    const listStart = reviewText.indexOf("是必查项：");
    const listEnd = reviewText.indexOf("这些机制已造成");
    expect(listStart, "必须能定位必查项列表").toBeGreaterThan(-1);
    expect(listEnd, "必须能定位列表终点").toBeGreaterThan(listStart);
    const list = reviewText.slice(listStart, listEnd);
    expect(list, "列表内不得出现未收窄的'本可由动作、选择或对白后果承担'").not.toContain("本可由动作、选择或对白后果承担");
    expect(list, "列表内不得内嵌窄化说明（round 31 窄化）").not.toContain("round 31 窄化");
    expect(list, "列表内的表情项只保留收窄后的短形式并指路").toContain("只报这一种，见下方边界①");
  });
  it("复原判据注明：总结连接词全书绝迹，且反向代理已证失败（不得立密度门）", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText, "必须带上总结连接词的实测零值").toContain("32 处");
    expect(draftText, "必须写明不得据此认为可以写总结段").toContain("不可据此认为");
    expect(draftText, "必须记录反向代理失败").toContain("反向代理");
    expect(draftText, "结论须是执行面仍归语义判断、不得立密度门").toMatch(/语义判断|不得改成可计算的密度门/u);
  });

  /**
   * 群像判据的实测定性：是已守住的基线，不是区分质量的杠杆（2026-10-14 复核轮 round 35）。
   *
   * round 2 写入"每个具名角色都要有至少一个独立于主角观察的可观察反应"，此后从未取证。
   * 本轮用**事实记忆层的真实主体名**（21 个）覆盖 144/168 章多人场后测得：
   * 配角充当句子主语的占比在四个合格带 0.537、混合带 0.584、最强带 0.550——**基本持平**
   * （最强带绝对句数更低只因它更短，不是群像更塌）。
   * 直读最强带样本确认机制真实：ch116「来接的还是话房人。」「"存注，"繁主事开口了」。
   *
   * 定性结论比数值更重要：**这是已守住的基线，不是区分质量的杠杆**——
   * 要盯的是占比掉下去（塌成主角视角回声），不是它有多高。
   * 这把锁防的是把这条读成"占比越高越好"而去给配角加戏（那会稀释主线）。
   */
  it("群像判据已注明是基线而非杠杆：盯下降不盯升高", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText, "必须带上实测占比与持平结论").toContain("0.550");
    expect(draftText, "定性须是'基线而非杠杆'").toMatch(/基线.{0,6}杠杆|杠杆/u);
    expect(draftText, "须写明盯下降不盯升高").toMatch(/占比掉下去|不要盯它有多高|盯的是.{0,12}占比掉下去/u);
    // 判据本身（独立反应）必须仍在。
    expect(draftText).toContain("独立于主角观察的可观察反应");
  });

  /**
   * 章尾纪律的机制拆分依据（2026-10-14 复核轮 round 33）。
   *
   * round 30/31/32 用"按机制拆族"分别处理了"数数""面部表情""道具盘点"，
   * 三次结论依次是推翻 / 收窄 / 确认。本轮审 round 2 写入、此后一直没被单独取过证的
   * **章尾收束纪律**——结论又是**确认**，且带一个必须防的读窄风险：
   *
   * | 机制 | 原始计数 | 全书 | 合格带 | 混合带 | **最强带** | 混/合 |
   * |---|---|---|---|---|---|---|
   * | A 短句收尾（≤8字） | 38 | 0.226 | 0.228 | 0.176 | **0.276** | 0.77 |
   * | B 长句收尾 | 130 | 0.774 | 0.772 | 0.824 | 0.724 | 1.07 |
   * | C 问句收尾 | **0** | 0 | 0 | 0 | 0 | — |
   *
   * 短句收尾在**最强带最高（0.276，比混合带高 1.6 倍）**且越往后越多
   * （ch72 前 10 章 → ch73 后 28 章）；而**把这 38 处按"宣告 vs 单拍"分类后，
   * 最强带 8 处全部是单拍落点、零宣告**（ch112「他没挪。」、ch127「两个字入册。」）。
   *
   * ⇒ 纪律禁止的是**宣告**，不是**短**。这把锁防的是把纪律读窄成
   * "不得短句收尾"——那会禁掉本书的标志性手法。
   */
  it("章尾纪律带着机制拆分依据：禁止的是宣告不是短，短句单拍是标志性手法", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText, "必须带上收束机制拆分依据").toContain("短句收尾");
    // 三条硬事实：最强带最高、问句全书为零、最强带全是单拍。
    expect(draftText, "须写明短句收尾在最强带最高").toContain("最强带 0.276");
    expect(draftText, "须写明问句收尾全书为零").toContain("问句收尾全书 0 处");
    expect(draftText, "须写明最强带全是单拍落点、零宣告").toMatch(/单拍落点.{0,12}零宣告|零宣告/u);
    // 结论：禁止宣告而非禁止短。
    expect(draftText, "结论须是'禁止宣告而非禁止短'").toContain("不是**短**");
    expect(draftText, "须明确不得因短句结尾而报").toContain("不得因");
  });

  /**
   * 清点条款的机制拆分依据（2026-10-14 复核轮 round 32）。
   *
   * round 30/31 用"按机制拆族"修正了"数数"、收窄了"面部表情"。本轮用它复查
   * round 2 最早指控、也一直没被拆过的**道具盘点**族——结论是**确认而非推翻**，
   * 而且是最硬的一种确认：把清点按机制拆开后，
   *   A 清点即情报（点名后紧跟状态/位置变化）全书 127 处、ch73 后仍有 21 章在用
   *   B 清点即存在感（只摸不报变化）全书 53 处、ch73 后只剩 6 章、**最强带 0.000**
   *   C 温度判定（配一次"凉/冷"）全书 317 处、合格带 0.63 vs 混合带 1.25（1.97 倍）
   * 而**最强带 29 章里 A 型 15 处、B 型 0 处**——最好的章只用 A、从不用 B。
   *
   * ⇒ "必须带来新信息/新选择/新代价"这条判据不是限制，而是**本书最好手法的定义式**。
   * 这把锁钉住这个依据，防止后续修订把判据放宽回"可以清点"（那会放回 B）。
   */
  it("清点条款带着机制拆分依据：A 是定义式、B 在最强带为零、C 是本族最强信号", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText, "必须带上机制拆分实测依据").toContain("清点即情报");
    expect(draftText, "必须写明 B 型（只摸不报变化）在最强带为零").toContain("最强带 099-127 为 0.000");
    expect(draftText, "必须写明 C（温度判定）是本族基数最大、信号最强的一族").toMatch(/C 温度判定/);
    expect(draftText, "结论须是\"判据即最好手法的定义式\"").toMatch(/定义式/u);
    // 判据本身三条件必须仍在（这是条款的执行核心）。
    expect(draftText).toContain("新信息");
    expect(draftText).toContain("新选择");
    expect(draftText).toContain("新代价");
  });

  /**
   * 序数作推演编号是正面声音，不得被"理顺"（2026-10-14 复核轮 round 30）。
   *
   * 由来：直读最强章 ch103 时我一度把"第二遍/第三遍/第三十二步/四十七步"读成
   * "用计数代替论证"的偷懒。按 round 20 的判据（先问"最强带是否也在用"）拆族实测后
   * 结论**相反**：分析型计数在最强带 099-127 达 **1.23/千字**，是混合带 0.36 的 **3.4 倍**，
   * 原始计数 326 处（非小样本）；而节律型 0.13、时间戳型 0.23 都与强度无关。
   * 直读峰值章 ch123 确认机制：`第一遍，他先走量词的路／第二遍，他走另一条路` 是穷举假设，
   * `第一步到第七步，檐影…第八步到第十九步，过井台` 是带证据的空间复原——**计数即论证**。
   *
   * 意义：一次善意的"把序号改成他想了想"的修订会删掉本书最可靠的严谨感。
   * 这把锁防止那种退化（round 20 撤回数数禁令的同一逻辑，但方向相反：
   * 那次是"别把声音当病"，这次是"别把机制当冗余"）。
   */
  it("序数作推演编号被列为正面声音：写作/审核/修订三面都不得建议改写成概述", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const faces: Array<[SkillExecutionPoint, string]> = [
      ["chapter.drafting", "writer"],
      ["chapter.review.prose", "prose-reviewer"],
      ["chapter.revision", "reviser"],
    ];
    for (const [executionPoint, role] of faces) {
      const text = renderSkillInstruction(
        await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role }),
        executionPoint,
      );
      expect(text, `${executionPoint} 缺少"序数作推演编号是正面声音"的判据`).toContain("序数作推演编号");
    }
    // 写作/修订侧必须写明不得改写成概述（这条是防退化的关键）。
    const revisionText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.revision", role: "reviser" }),
      "chapter.revision",
    );
    expect(revisionText, "修订侧必须禁止把序数改成概述").toContain("不得");
    expect(revisionText, "必须给出被禁止的改写形态（他想了想/反复推敲）").toMatch(/他想了想|反复推敲/);
  });

  /**
   * 面部表情的病灶被窄化到"表情 + 释义"这一种机制（2026-10-14 复核轮 round 31）。
   *
   * round 19 把 `嘴角|眉头|眉心|眼神|眼底|眼皮|眼角` **按用词并成一族**，判它与章节强度
   * 负相关并写了"情绪节拍不要默认落在面部表情"的指引。round 30 的判据（**拆族要按机制拆，
   * 不按用词拆**）要求复查它。round 31 拆开后结论差别很大：
   *
   * | 机制 | 全书 | 合格带 | 混合带 | 最强带 099-127 | 混合/合格 |
   * |---|---|---|---|---|---|
   * | A 表情+释义 | 27 | 0.055 | 0.186 | **0.000** | 3.40 |
   * | B 单标记不解释 | 76 | 0.133 | 0.278 | 0.051 | 2.09 |
   * | C 表情捆在肢体里 | 22 | 0.027 | 0.166 | **0.000** | 6.05 |
   *
   * 且 A 的 27 处**全部落在 ch2—ch72、ch73 以后一处都没有**（逐章核过），
   * 而 B 在 ch73 后仍有 26 处、合格带 30 处 vs 混合带 27 处（基本持平）。
   *
   * ⇒ **只有 A 是确凿病灶**；B/C 是稳定手艺。把 B/C 一并列进指引是"并族"造成的过宽——
   * 若照旧执行，会抽掉本书可观察的线索。故判据收窄为：
   * 写作/审核/修订三面都只针对"表情 + 一句解释它意味着什么"，且明确声明
   * **单标记与肢体捆绑的表情不报**。
   */
  it("面部表情的判据只针对'表情+释义'，单标记与肢体捆绑的表情不报", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    for (const [executionPoint, role] of [
      ["chapter.drafting", "writer"],
      ["chapter.review.prose", "prose-reviewer"],
      ["chapter.revision", "reviser"],
    ] as Array<[SkillExecutionPoint, string]>) {
      const text = renderSkillInstruction(
        await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role }),
        executionPoint,
      );
      expect(text, `${executionPoint} 应只针对'表情+释义'这一种机制`).toMatch(/表情 \+ 一句(?:释义|解释)/u);
    }
    // 写作侧必须写明"单标记不解释"与"肢体捆绑"两种都**不**报（防并族退化）。
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    expect(draftText, "必须写明单标记不解释不是病").toMatch(/单一个标记不解释|单标记/u);
    expect(draftText, "必须写明捆在肢体动作里的表情不是病").toMatch(/肢体/u);
    // 审核侧：不得再把"又一个表情标记"当报点。
    const reviewText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.review.prose", role: "prose-reviewer" }),
      "chapter.review.prose",
    );
    expect(reviewText, "审核侧须声明单标记与肢体捆绑的表情都不报").toMatch(/都不报|不报/u);
  });

  it("情绪节拍默认落在面部表情上的判据在写作、审核、修订三面都在场", async () => {
    const provider = createWorkspaceSkillProvider(path.resolve(process.cwd(), "skills", "novel-v2"));
    const faces: Array<[SkillExecutionPoint, string]> = [
      ["chapter.drafting", "writer"],
      ["chapter.review.prose", "prose-reviewer"],
      ["chapter.revision", "reviser"],
    ];
    for (const [executionPoint, role] of faces) {
      const text = renderSkillInstruction(
        await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint, role }),
        executionPoint,
      );
      expect(text, `${executionPoint} 缺少面部表情节拍判据`).toContain("面部表情");
    }
    const draftText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.drafting", role: "writer" }),
      "chapter.drafting",
    );
    // 可执行判据：删掉这个表情，读者是失去可观察线索还是只失去一个标签。
    expect(draftText).toContain("读者是会失去一个可观察的线索");
    // round 31 窄化后的形态断言：只有"表情 + 一句释义"是病灶。
    expect(draftText).toMatch(/表情 \+ 一句释义/u);
    const reviewText = renderSkillInstruction(
      await resolveStageSkillBundle({ projectId: "test-project", provider, executionPoint: "chapter.review.prose", role: "prose-reviewer" }),
      "chapter.review.prose",
    );
    expect(reviewText, "审核侧须只针对'表情+释义'并声明另两种不报").toMatch(/都不报|不报/u);
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
