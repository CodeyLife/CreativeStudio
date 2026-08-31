/**
 * 核心创意短剧脚本（short-script-h3）单元测试（契约 v2：独立存储 + 零阻断契约）。
 *
 * 契约：与章节剧本共用六段式片段结构与零阻断组装（结构观察全部只进 hints，
 * 不回灌 repair、不阻止落库）；目标时长预算（分段数上下限 + 总时长容差窗口）
 * 仅作为 prompt 预算约束与人工复核观察存在，不再抛错。
 * v2 起完全独立于小说项目：projectId 可选（缺省=独立短剧），产物落 short_scripts 表。
 * 夹具说明：使用虚构人物与通用都市题材的示例性内容作结构校验样本；被测的
 * 结构规则、校验逻辑与断言全部题材无关（泛化优先约束针对规则文本，
 * 不禁止测试样本携带题材）。
 */
import { describe, expect, it, vi } from "vitest";
import { NovelPostgresRepository, type StoredShortScript } from "../postgres-repository";
import {
  buildShortScriptPrompt,
  buildShortScriptSchema,
  clampShortScriptTargetSeconds,
  DEFAULT_SHORT_SCRIPT_TARGET_SECONDS,
  deriveShortScriptMaxSegments,
  deriveShortScriptMinSegments,
  generateShortScriptH3,
  MAX_SHORT_SCRIPT_TARGET_SECONDS,
  MIN_IDEA_LENGTH,
  MIN_SHORT_SCRIPT_TARGET_SECONDS,
  SHORT_SCRIPT_CONTRACT_VERSION,
  ShortScriptInputError,
  SHORT_SCRIPT_KIND,
  SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS,
  observeShortScriptTotalDuration,
} from "../application/short-script-h3";

const IDEA = "深夜便利店店员发现连续三晚同一时刻进店的顾客们买走的商品首字拼成同一句警告，而第四晚进店的是他自己。";

/** short_scripts 表存储行夹具（payload 结构与生成路径落库一致）。 */
function mockStoredScript(overrides: Partial<StoredShortScript> = {}): StoredShortScript {
  const output = shortScriptOutput(30);
  return {
    id: "script-stored",
    projectId: "project-1",
    idea: IDEA,
    instruction: undefined,
    targetDurationSeconds: 30,
    sourceFingerprint: "fingerprint-stored",
    contractVersion: SHORT_SCRIPT_CONTRACT_VERSION,
    objectKey: "objects/test-short-script",
    contentHash: "hash-stored",
    workflowId: "short-script:test",
    payload: {
      origin: "short-script-h3",
      mode: "ref2va",
      idea: IDEA,
      targetDurationSeconds: 30,
      sourceFingerprint: "fingerprint-stored",
      contractVersion: SHORT_SCRIPT_CONTRACT_VERSION,
      plotBeats: output.plotBeats,
      characters: output.characters,
      segments: output.segments,
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

function mockRepository(options: { existingStored?: StoredShortScript; missingProject?: boolean } = {}) {
  const repository = Object.create(NovelPostgresRepository.prototype) as NovelPostgresRepository;
  // pool.query 仅服务 loadProjectTitle（projectId 显式提供时才被调用）
  const projectQuery = vi.fn(async () =>
    options.missingProject ? { rows: [], rowCount: 0 } : { rows: [{ title: "深夜便利店" }], rowCount: 1 });
  const findShortScriptByFingerprint = vi.fn(async (_fingerprint: string) => options.existingStored);
  const recordShortScript = vi.fn(async (_script: StoredShortScript) => {});
  Object.defineProperty(repository, "pool", { value: { query: projectQuery } });
  Object.defineProperty(repository, "findShortScriptByFingerprint", { value: findShortScriptByFingerprint });
  Object.defineProperty(repository, "recordShortScript", { value: recordShortScript });
  return { repository, projectQuery, recordShortScript, findShortScriptByFingerprint };
}

const BASELINE = "A young night-shift clerk with tired eyes, a dark green store apron and a lanyard badge.";

function clerkSegment(durationSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    title: "货架异样",
    synopsis: "店员整理货架时发现商品缺口的规律。",
    durationSeconds,
    beatIds: ["beat-pattern"],
    subjectDefinitions: "<Subject 1> is the night-shift clerk, wearing a dark green store apron and a lanyard badge.\n<Subject 2> is the fluorescent-lit convenience store interior at 3 a.m.",
    summary: "[reference generation] <Subject 1> notices a pattern in the emptied shelves of <Subject 2>.",
    retentionAnalysis: "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - apron and badge retained.\n<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - store set dressing retained.",
    detailedDescription: [
      "Live-action cinematic look, cold fluorescent palette.",
      "[Shot 1] A medium shot frames <Subject 2>, shelves under cold fluorescent light, one strip flickering. <Subject 1>, the clerk in the green apron, restocks cans; the camera pushes in slowly as his eyes stop on a row of gaps.",
      "[Shot 2] At 00:05.000, the shot cuts to a close-up of <Subject 1> (S1) reading a receipt strip, muttering in Chinese, <d>[中文] 首字又对上了。</d> The fridge hum swells behind him.",
    ].join("\n"),
    overallSoundscape: "Fridge hum, freezer drone, and the beep of a register run in the background throughout.",
    nonDiegeticMusic: "A low synth pulse builds as the pattern becomes visible, cutting out at the last line.",
    ...overrides,
  };
}

function shortScriptOutput(targetDurationSeconds: number) {
  const segments: Array<ReturnType<typeof clerkSegment>> = [];
  let remaining = targetDurationSeconds;
  while (remaining > 0) {
    // 区间 10-15s（契约 v6）：余量不足 10s 时并入前一段由容差窗口吸收。
    const duration = Math.min(15, Math.max(10, remaining));
    segments.push(clerkSegment(duration));
    remaining -= duration;
  }
  return {
    plotBeats: [{ id: "beat-pattern", kind: "setup" as const, summary: "店员发现缺货商品的规律并拼出首字警告" }],
    characters: [{ name: "夜班店员", appearanceEn: BASELINE }],
    segments,
  };
}

describe("目标时长与分段预算", () => {
  it("clamps target duration into the operating window with a default", () => {
    expect(clampShortScriptTargetSeconds(undefined)).toBe(DEFAULT_SHORT_SCRIPT_TARGET_SECONDS);
    expect(clampShortScriptTargetSeconds(5)).toBe(MIN_SHORT_SCRIPT_TARGET_SECONDS);
    expect(clampShortScriptTargetSeconds(240)).toBe(MAX_SHORT_SCRIPT_TARGET_SECONDS);
    expect(clampShortScriptTargetSeconds(23.6)).toBe(24);
    expect(clampShortScriptTargetSeconds(Number.NaN)).toBe(DEFAULT_SHORT_SCRIPT_TARGET_SECONDS);
  });

  it("derives segment floors and caps from the target duration", () => {
    // v6 起区间 10-15s：下限按最长单段 15s、上限按最短单段 10s 推导。
    expect(deriveShortScriptMinSegments(30)).toBe(2);
    expect(deriveShortScriptMaxSegments(30)).toBe(3);
    expect(deriveShortScriptMinSegments(60)).toBe(4);
    expect(deriveShortScriptMaxSegments(60)).toBe(6);
    expect(deriveShortScriptMinSegments(12)).toBe(1);
    expect(deriveShortScriptMaxSegments(12)).toBe(2);
    // 180s（3 分钟上限）：下限 12（全按 15s），上限 18（全按 10s），未触及段数 cap 36。
    expect(deriveShortScriptMinSegments(MAX_SHORT_SCRIPT_TARGET_SECONDS)).toBe(12);
    expect(deriveShortScriptMaxSegments(MAX_SHORT_SCRIPT_TARGET_SECONDS)).toBe(18);
  });

  it("narrows the schema segment bounds around the budget", () => {
    const schema = buildShortScriptSchema(30) as { properties: { segments: { minItems: number; maxItems: number } } };
    expect(schema.properties.segments.minItems).toBe(2);
    expect(schema.properties.segments.maxItems).toBe(3);
  });

  it("observes totals inside the tolerance window and reports drift beyond it (no blocking)", () => {
    expect(observeShortScriptTotalDuration([clerkSegment(12), clerkSegment(12)], 24)).toBeNull();
    expect(observeShortScriptTotalDuration([clerkSegment(12), clerkSegment(12)], 24 + SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS)).toBeNull();
    const drift = observeShortScriptTotalDuration([clerkSegment(10), clerkSegment(10)], 40);
    expect(drift).toContain("偏离目标");
    expect(drift).toContain("容差");
    expect(drift).toContain("供人工复核");
  });
});

describe("buildShortScriptPrompt", () => {
  it("embeds the idea, duration budget, coverage and dramaturgy contracts, plus the idea-faithfulness boundary", () => {
    const prompt = buildShortScriptPrompt({
      projectTitle: "深夜便利店",
      idea: IDEA,
      instruction: "结尾停在第四晚开门瞬间",
      targetDurationSeconds: 30,
      minSegments: 3,
      maxSegments: 6,
    });
    expect(prompt).toContain(IDEA);
    expect(prompt).toContain("共 30 秒左右");
    expect(prompt).toContain("剧情覆盖契约");
    expect(prompt).toContain("信息呈现手段（硬性规则，剧情型创意适用");
    expect(prompt).toContain("片段数须落在 3-6 个之间");
    expect(prompt).toContain("创意意图忠实性");
    expect(prompt).toContain("展示型创意禁止自行注入对抗事件");
    expect(prompt).toContain("剧集剧作契约");
    expect(prompt).toContain("开场即冲突");
    expect(prompt).toContain("出口即钩子");
    expect(prompt).toContain("台词密度");
    expect(prompt).toContain("反转须有伏笔");
    expect(prompt).toContain("人物经济");
    expect(prompt).toContain("忠实于核心创意给定的设定");
    expect(prompt).toContain("作者指令");
    expect(prompt).toContain("结尾停在第四晚开门瞬间");
  });
});

describe("generateShortScriptH3（结构复用与幂等）", () => {
  function mockModel(value: unknown) {
    return { generateStructured: vi.fn(async () => ({ value })) };
  }
  const objects = { putText: vi.fn(async () => ({ key: "objects/test-short-script" })) };
  const skillProvider = {
    list: vi.fn(async () => [{
      skillId: "h3-video-prompt",
      version: "1.3.0",
      capabilities: ["script"],
      applicableTasks: ["drafting"],
      requiredMemoryKinds: [],
      conflicts: [],
      qualityGates: ["h3-six-section-order"],
      promptSections: { "short.script": "H3 指引占位" },
      enabled: true,
      executionPoints: ["chapter.script", "short.script"],
      roles: ["writer"],
      dependsOn: [],
      priority: "required",
    }]),
  };

  it("rejects an idea shorter than the minimum creative unit with a 400-style error", async () => {
    const { repository } = mockRepository();
    await expect(generateShortScriptH3(
      { projectId: "project-1", idea: "太短" },
      { repository, objects: objects as never, model: mockModel({}) as never, skillProvider: skillProvider as never },
    )).rejects.toThrow(ShortScriptInputError);
    await expect(generateShortScriptH3(
      { projectId: "project-1", idea: "太短" },
      { repository, objects: objects as never, model: mockModel({}) as never, skillProvider: skillProvider as never },
    )).rejects.toThrow(new RegExp(`至少 ${MIN_IDEA_LENGTH} 个字符`));
  });

  it("generates and persists a short_scripts row", async () => {
    const { repository, recordShortScript, projectQuery } = mockRepository();
    const record = await generateShortScriptH3(
      { projectId: "project-1", idea: IDEA, instruction: "结尾停在第四晚开门瞬间" },
      { repository, objects: objects as never, model: mockModel(shortScriptOutput(30)) as never, skillProvider: skillProvider as never },
    );
    expect(record.reused).toBeUndefined();
    expect(record.projectId).toBe("project-1");
    expect(record.scriptId).toEqual(expect.any(String));
    expect(record.targetDurationSeconds).toBe(30);
    expect(record.segments).toHaveLength(2);
    expect(record.segments[0].promptText).toContain("subject_definitions:");
    expect(record.plotBeats[0].id).toBe("beat-pattern");
    expect(recordShortScript).toHaveBeenCalledTimes(1);
    const stored = recordShortScript.mock.calls[0][0] as StoredShortScript;
    expect(stored.projectId).toBe("project-1");
    expect(stored.contractVersion).toBe(SHORT_SCRIPT_CONTRACT_VERSION);
    expect(stored.payload.origin).toBe("short-script-h3");
    expect(stored.payload.kind).toBe(SHORT_SCRIPT_KIND);
    // 创意来源落库：历史列表语义展示与幂等审计依据
    expect(stored.idea).toBe(IDEA);
    expect(stored.instruction).toBe("结尾停在第四晚开门瞬间");
    expect(record.idea).toBe(IDEA);
    expect(record.instruction).toBe("结尾停在第四晚开门瞬间");
    // 关联模式：项目标题注入 prompt（novel_projects 被查询）
    expect(projectQuery).toHaveBeenCalledTimes(1);
  });

  it("generates an independent short script without any novel project (contract v2)", async () => {
    const { repository, recordShortScript, projectQuery } = mockRepository();
    const record = await generateShortScriptH3(
      { idea: IDEA },
      { repository, objects: objects as never, model: mockModel(shortScriptOutput(30)) as never, skillProvider: skillProvider as never },
    );
    expect(record.projectId).toBeUndefined();
    expect(record.segments).toHaveLength(2);
    // 独立模式不查询 novel_projects（无项目依赖）
    expect(projectQuery).not.toHaveBeenCalled();
    const stored = recordShortScript.mock.calls[0][0] as StoredShortScript;
    expect(stored.projectId).toBeUndefined();
  });

  it("keeps the 404 semantics when an explicitly linked project does not exist", async () => {
    const { repository } = mockRepository({ missingProject: true });
    await expect(generateShortScriptH3(
      { projectId: "project-missing", idea: IDEA },
      { repository, objects: objects as never, model: mockModel(shortScriptOutput(30)) as never, skillProvider: skillProvider as never },
    )).rejects.toThrow(/项目不存在/);
  });

  it("persists drift output beyond the tolerance window without blocking (zero-blocking display)", async () => {
    const { repository, recordShortScript } = mockRepository();
    const drift = [clerkSegment(15), clerkSegment(15), clerkSegment(15)];
    const record = await generateShortScriptH3(
      { projectId: "project-1", idea: IDEA, targetDurationSeconds: 30 },
      { repository, objects: objects as never, model: mockModel({ ...shortScriptOutput(30), segments: drift }) as never, skillProvider: skillProvider as never },
    );
    expect(record.reused).toBeUndefined();
    expect(record.segments).toHaveLength(3);
    // 总时长 45s 偏离目标 30s 超容差：零阻断契约下只作为人工复核提示，不阻止落库展示。
    expect(record.cinematicHints.some((hint) => hint.includes("偏离目标"))).toBe(true);
    expect(recordShortScript).toHaveBeenCalledTimes(1);
  });

  it("reuses the stored script for identical creative input within the same scope", async () => {
    // 第一次：无既有产物 → 走生成
    const generateStructured = vi.fn(async () => ({ value: shortScriptOutput(30) }));
    const first = await generateShortScriptH3(
      { projectId: "project-1", idea: IDEA },
      { repository: mockRepository().repository, objects: objects as never, model: { generateStructured } as never, skillProvider: skillProvider as never },
    );
    expect(first.reused).toBeUndefined();
    // 第二次：命中幂等（同作用域同指纹）→ 复用，不再调模型
    const { repository: reuseRepository } = mockRepository({ existingStored: mockStoredScript() });
    const second = await generateShortScriptH3(
      { projectId: "project-1", idea: IDEA },
      { repository: reuseRepository, objects: objects as never, model: { generateStructured } as never, skillProvider: skillProvider as never },
    );
    expect(second.reused).toBe(true);
    expect(second.scriptId).toBe("script-stored");
    expect(second.segments).toHaveLength(2);
    expect(second.cinematicHints).toEqual([]);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("reuses an independent-scoped script for the same idea, isolated from the linked scope", async () => {
    // 独立作用域幂等：同创意再次独立提交 → 命中 independent 指纹复用
    const generateStructured = vi.fn(async () => ({ value: shortScriptOutput(30) }));
    const { repository: reuseRepository, findShortScriptByFingerprint } = mockRepository({
      existingStored: mockStoredScript({ id: "script-independent", projectId: undefined, sourceFingerprint: "fingerprint-independent" }),
    });
    const independent = await generateShortScriptH3(
      { idea: IDEA },
      { repository: reuseRepository, objects: objects as never, model: { generateStructured } as never, skillProvider: skillProvider as never },
    );
    expect(independent.reused).toBe(true);
    expect(independent.scriptId).toBe("script-independent");
    expect(generateStructured).not.toHaveBeenCalled();
    // 复用查询使用独立作用域指纹（independent 占位，非项目 id 拼接）
    const queriedFingerprint = findShortScriptByFingerprint.mock.calls[0][0] as string;
    expect(queriedFingerprint).not.toContain("project-1");
  });

  it("treats the same idea in independent and linked scopes as two distinct scripts", async () => {
    // 跨作用域隔离：同创意分别在独立与关联作用域提交 → 指纹不同 → 各自生成两个产物
    const generateStructured = vi.fn(async () => ({ value: shortScriptOutput(30) }));
    const linked = await generateShortScriptH3(
      { projectId: "project-1", idea: IDEA },
      { repository: mockRepository().repository, objects: objects as never, model: { generateStructured } as never, skillProvider: skillProvider as never },
    );
    const { repository: independentRepository, recordShortScript: recordIndependent } = mockRepository();
    const independent = await generateShortScriptH3(
      { idea: IDEA },
      { repository: independentRepository, objects: objects as never, model: { generateStructured } as never, skillProvider: skillProvider as never },
    );
    expect(linked.reused).toBeUndefined();
    expect(independent.reused).toBeUndefined();
    // 同创意两个作用域各生成一次、指纹互不相同（幂等键含作用域维度）
    expect(generateStructured).toHaveBeenCalledTimes(2);
    const fingerprints = new Set<string>();
    for (const call of [...(recordIndependent.mock.calls as unknown as [StoredShortScript][])]) fingerprints.add(call[0].sourceFingerprint);
    expect(fingerprints.size).toBe(1);
    const independentFingerprint = [...fingerprints][0];
    // 关联作用域指纹 ≠ 独立作用域指纹：同创意在两个作用域是两个产物
    expect(linked.sourceFingerprint ?? "").not.toBe(independentFingerprint);
    expect(linked.scriptId).not.toBe(independent.scriptId);
  });
});
