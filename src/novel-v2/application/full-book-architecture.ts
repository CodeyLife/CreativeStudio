export type FullBookArchitectureSeverity = "blocker" | "major" | "warning";

export interface FullBookArchitectureIssue {
  code: string;
  severity: FullBookArchitectureSeverity;
  path: string;
  message: string;
  mechanism: string;
  affectedInputClass: string;
  suggestion: string;
}

export interface FullBookArchitectureReport {
  passed: boolean;
  metrics: {
    volumeCount: number;
    estimatedChapterCount: number;
    characterCount: number;
    longHorizonThreadCount: number;
  };
  issues: FullBookArchitectureIssue[];
}

export interface FullBookArchitectureInput {
  architecture?: unknown;
  characters?: unknown;
  worldview?: unknown;
  plotStrategy?: unknown;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function meaningful(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function issue(
  code: string,
  severity: FullBookArchitectureSeverity,
  path: string,
  message: string,
  mechanism: string,
  affectedInputClass: string,
  suggestion: string,
): FullBookArchitectureIssue {
  return { code, severity, path, message, mechanism, affectedInputClass, suggestion };
}

function auditVolumes(architecture: JsonRecord | undefined, issues: FullBookArchitectureIssue[]): { count: number; estimatedChapterCount: number } {
  const volumes = list(architecture?.volumes);
  let estimatedChapterCount = 0;
  const incomplete: string[] = [];
  for (const [index, value] of volumes.entries()) {
    const volume = record(value);
    if (!volume) {
      incomplete.push(`volumes[${index}]`);
      continue;
    }
    const name = text(volume.name) ?? `volumes[${index}]`;
    const chapterCount = typeof volume.chapterCount === "number" && Number.isFinite(volume.chapterCount) ? volume.chapterCount : 0;
    estimatedChapterCount += chapterCount;
    const missing = ["entryState", "exitState", "pressures", "promiseWindows"]
      .filter((key) => key === "pressures" || key === "promiseWindows" ? !Array.isArray(volume[key]) : !text(volume[key]));
    if (missing.length) incomplete.push(`${name}: ${missing.join(", ")}`);
    const promiseWindows = list(volume.promiseWindows);
    if (promiseWindows.length) {
      const ungrounded: string[] = [];
      for (const [windowIndex, windowValue] of promiseWindows.entries()) {
        const window = record(windowValue);
        if (!window) {
          ungrounded.push(`promiseWindows[${windowIndex}]`);
          continue;
        }
        const hasReference = meaningful(window.promiseRef) || meaningful(window.id) || meaningful(window.description);
        const hasWindow = meaningful(window.windowOrdinals) || meaningful(window.window) || meaningful(window.payoffWindow);
        if (!hasReference || !hasWindow) ungrounded.push(`promiseWindows[${windowIndex}]${window.promiseRef ?? window.id ?? window.description ? `（${window.promiseRef ?? window.id ?? window.description}）` : ""}`);
      }
      if (ungrounded.length) {
        issues.push(issue(
          "promise-window-ungrounded",
          "warning",
          "architecture.volumes.promiseWindows",
          `承诺窗口缺少可解析引用或阶段窗口：${ungrounded.join("、")}`,
          "承诺窗口只写标题级占位时，故事弧无法把它转成可验证的兑现责任，长线回收仍依赖模型自行记忆。",
          "卷级承诺窗口只有描述性占位、无法定位到具体伏笔/承诺或兑现阶段的长篇架构",
          "每条承诺窗口至少提供 promiseRef/id/description 之一作为引用，并提供 windowOrdinals 或 payoffWindow 作为阶段边界；无法确定的边界保持 open，不编造窗口。",
        ));
      }
    }
  }
  if (incomplete.length) {
    issues.push(issue(
      "volume-transition-contract-incomplete",
      "major",
      "architecture.volumes",
      `卷级入口、压力、出口和承诺窗口不完整：${incomplete.join("；")}`,
      "卷只有主题和功能描述时，故事弧生成只能自行猜测阶段状态，长期因果无法稳定下传。",
      "缺少阶段边界、承诺回收或压力责任的长篇架构",
      "为每卷补充入口状态、主要压力、退出状态和承诺窗口；chapterCount 只保留为资源估计，不作为质量目标。",
    ));
  }
  return { count: volumes.length, estimatedChapterCount };
}

function auditCharacters(characters: JsonRecord | undefined, issues: FullBookArchitectureIssue[]): { count: number; names: Map<string, string[]> } {
  const entries = list(characters?.characters);
  const names = new Map<string, string[]>();
  const incomplete: string[] = [];
  for (const [index, value] of entries.entries()) {
    const character = record(value);
    if (!character) {
      incomplete.push(`characters[${index}]`);
      continue;
    }
    const id = text(character.id);
    const name = text(character.name);
    if (id) names.set(id, [...(names.get(id) ?? []), id]);
    if (name) names.set(name, [...(names.get(name) ?? []), id ?? name]);
    const action = record(character.independentAction);
    const missing = ["fear"].filter((key) => !character[key] || (typeof character[key] === "string" && !text(character[key])));
    if (!action) missing.push("independentAction");
    else {
      for (const key of ["desire", "choice", "cost", "knowledgeBoundary"]) {
        if (!meaningful(action[key])) missing.push(`independentAction.${key}`);
      }
    }
    if (missing.length) incomplete.push(`${name ?? `characters[${index}]`}: ${missing.join(", ")}`);
  }
  if (incomplete.length) {
    issues.push(issue(
      "character-agency-contract-incomplete",
      "major",
      "characters.characters",
      `重要人物缺少限制或独立行动契约：${incomplete.join("；")}`,
      "只有角色动机和终点没有失败策略、独立选择与代价时，人物弧会退化成主角主线的功能标签。",
      "人物弧、群像和关系线无法独立运行的长篇规划",
      "为每个重要人物补充 fear/限制、独立欲望、可选行动、选择代价和知识边界。",
    ));
  }
  return { count: entries.length, names };
}

function auditWorldview(worldview: JsonRecord | undefined, issues: FullBookArchitectureIssue[]): void {
  const rules = list(worldview?.rules);
  const incomplete: string[] = [];
  for (const [index, value] of rules.entries()) {
    const rule = record(value);
    if (!rule || !text(rule.statement) || !text(rule.cost) || !text(rule.boundary)) incomplete.push(`rules[${index}]`);
  }
  if (incomplete.length) {
    issues.push(issue(
      "world-rule-cost-boundary-incomplete",
      "major",
      "worldview.rules",
      `世界规则缺少可执行的代价或边界：${incomplete.join("、")}`,
      "规则没有代价和违规边界时，只能承担百科设定，不能稳定地产生人物选择和可预测后果。",
      "依赖世界规则制造冲突、限制和认知差的长篇架构",
      "把每条冻结规则写成 statement、cost、boundary；未知例外另标为待设计，不把例外偷偷写成事实。",
    ));
  }
  const layers = [
    { key: "resourcesAndTechnology", label: "资源与技术（力量/信息/交通/医疗/货币/生产如何分配）" },
    { key: "valuesAndConflicts", label: "价值与冲突（世界奖励/惩罚什么、对谁不公平、后果）" },
  ];
  const missingLayers = layers.filter((layer) => !list(worldview?.[layer.key]).length);
  if (missingLayers.length) {
    issues.push(issue(
      "worldview-pressure-layer-incomplete",
      "warning",
      "worldview",
      `世界观压力层未结构化：${missingLayers.map((layer) => layer.key).join("、")}`,
      "只有规则与地理而缺少资源分配和价值冲突时，设定只能提供‘能做什么’，不能稳定地改变人物‘必须选择什么’；资源稀缺与不公平会制造选择压力。",
      "设定只回答规则、不回答资源与价值分配的长篇世界",
      "为缺失层补充条目：资源层记录谁掌握/谁稀缺/谁可及，价值层记录奖励/惩罚/不公平及后果；确实不适用时保持 open，不编造条目。",
    ));
  }
}

function auditPlotStrategy(plotStrategy: JsonRecord | undefined, characterNames: Map<string, string[]>, issues: FullBookArchitectureIssue[]): number {
  const threads = list(plotStrategy?.longHorizonThreads);
  const unresolvedCharacters: string[] = [];
  const ambiguousCharacters: string[] = [];
  for (const [index, value] of list(plotStrategy?.characterDestinations).entries()) {
    const destination = record(value);
    const reference = text(destination?.characterRef) ?? text(value);
    if (!reference) {
      unresolvedCharacters.push(`characterDestinations[${index}]`);
      continue;
    }
    const candidates = characterNames.get(reference) ?? [];
    if (candidates.length === 0) unresolvedCharacters.push(reference);
    if (candidates.length > 1) ambiguousCharacters.push(reference);
  }
  if (unresolvedCharacters.length) {
    issues.push(issue(
      "unresolved-character-destination",
      "major",
      "plotStrategy.characterDestinations",
      `人物终点引用无法解析：${unresolvedCharacters.join("、")}`,
      "人物档案与长程战略使用不同身份，后续弧规划无法判断谁承担哪个终点和代价。",
      "跨 Foundation 人物弧、关系线和终局责任引用",
      "使用项目内规范人物 ID；自然语言别名只能作为输入兼容层，不能作为最终引用。",
    ));
  }
  if (ambiguousCharacters.length) {
    issues.push(issue(
      "ambiguous-character-destination",
      "blocker",
      "plotStrategy.characterDestinations",
      `人物终点引用存在歧义：${ambiguousCharacters.join("、")}`,
      "同一别名对应多个角色时自动合并会把人物弧和终局责任写入错误对象。",
      "存在同名或别名冲突的长篇规划",
      "由作者将引用改为唯一规范人物 ID，不自动合并。",
    ));
  }
  const missingThreadWindow: string[] = [];
  const missingThreadCoupling: string[] = [];
  for (const [index, value] of threads.entries()) {
    const thread = record(value);
    const hasResponsibility = Array.isArray(thread?.responsibleVolumeOrdinals)
      || Array.isArray(thread?.volumeWindows)
      || text(thread?.nextResponsibility);
    if (!thread || !text(thread.threadRef) || !text(thread.direction) || !text(thread.closureCondition) || !hasResponsibility) missingThreadWindow.push(`longHorizonThreads[${index}]`);
    if (thread && text(thread.threadRef) && !text(thread.coupling) && !text(thread.mergePoint) && !text(thread.exitPoint) && !text(thread.transformPoint)) {
      missingThreadCoupling.push(`longHorizonThreads[${index}]（${thread.threadRef}）`);
    }
  }
  if (missingThreadWindow.length) {
    issues.push(issue(
      "long-horizon-thread-window-incomplete",
      "major",
      "plotStrategy.longHorizonThreads",
      `长线剧情线缺少阶段责任或下一次推进窗口：${missingThreadWindow.join("、")}`,
      "只有方向和结局条件没有中间责任时，支线会在章节生成中反复被提及或长期悬空。",
      "跨卷推进、伏笔回收和支线交汇的长篇规划",
      "为每条线记录推动者、当前问题、负责卷/阶段、下一次可见变化、交汇/退出/转化条件。",
    ));
  }
  if (missingThreadCoupling.length) {
    issues.push(issue(
      "long-horizon-thread-coupling-incomplete",
      "warning",
      "plotStrategy.longHorizonThreads",
      `长线剧情线缺少耦合机制或生命周期条件：${missingThreadCoupling.join("、")}`,
      "只有方向与责任而没有与主线的耦合方式和交汇/退出/转化条件时，支线可以维持存在却不改变主线选择、资源、认知、关系或世界规则。",
      "多条支线长期并行、只靠新增角色和地点维持存在感的长篇架构",
      "为每条线补充 coupling（改变人物选择/资源/认知/关系/世界规则之一）和 mergePoint/exitPoint/transformPoint 中的适用项；没有确定的交汇点保持 open，不编造窗口。",
    ));
  }
  const informationBoundaries = record(plotStrategy?.informationBoundaries);
  if (!informationBoundaries) {
    issues.push(issue(
      "information-boundary-map-missing",
      "warning",
      "plotStrategy.informationBoundaries",
      "长程信息边界未建立，隐藏信息、尚未设计信息和开放问题没有分层。",
      "没有信息状态地图时，模型容易把人物未知、作者未决定和读者延迟揭示混成同一种‘神秘’。",
      "依赖渐进揭示、误读和多阶段回收的长篇架构",
      "补充 hidden、notDesigned、open 三类边界，并为重要问题记录当前证据和最早可升级窗口。",
    ));
  }
  return threads.length;
}

export function auditFullBookArchitecture(input: FullBookArchitectureInput): FullBookArchitectureReport {
  const issues: FullBookArchitectureIssue[] = [];
  const architecture = record(input.architecture);
  const characters = record(input.characters);
  const worldview = record(input.worldview);
  const plotStrategy = record(input.plotStrategy);
  const missingRoots = [
    !architecture || !list(architecture.volumes).length ? "architecture.volumes" : undefined,
    !characters || !list(characters.characters).length ? "characters.characters" : undefined,
    !worldview || !list(worldview.rules).length ? "worldview.rules" : undefined,
    !plotStrategy || !list(plotStrategy.characterDestinations).length ? "plotStrategy.characterDestinations" : undefined,
    !plotStrategy || !list(plotStrategy.longHorizonThreads).length ? "plotStrategy.longHorizonThreads" : undefined,
  ].filter((path): path is string => Boolean(path));
  if (missingRoots.length) {
    issues.push(issue(
      "full-book-root-contract-incomplete",
      "major",
      "fullBookArchitecture",
      `全书架构缺少必需的根数据：${missingRoots.join("、")}`,
      "缺少 Foundation 根数据时，后续故事弧无法从持久化状态读取阶段责任、人物主体、世界约束或长线推进窗口，只能临时猜测。",
      "Foundation 阶段缺失或数组为空的全书架构输入",
      "先补齐列出的根对象和非空集合，再提交故事弧审批；空集合不能作为已设计架构。",
    ));
  }
  const volumeMetrics = auditVolumes(architecture, issues);
  const characterMetrics = auditCharacters(characters, issues);
  auditWorldview(worldview, issues);
  const longHorizonThreadCount = auditPlotStrategy(plotStrategy, characterMetrics.names, issues);
  const blocking = issues.some((item) => item.severity === "blocker" || item.severity === "major");
  return {
    passed: !blocking,
    metrics: {
      volumeCount: volumeMetrics.count,
      estimatedChapterCount: volumeMetrics.estimatedChapterCount,
      characterCount: characterMetrics.count,
      longHorizonThreadCount,
    },
    issues,
  };
}
