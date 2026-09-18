import { projectChapterForExecution, type ChapterPlanningContext } from "../application/story-arc";
import type { MemoryBundle, MemoryHit, NarrativeRhythmSnapshot, SerialContextSnapshot, StageContextPriority } from "../protocol";

function list(items: string[], empty = "无"): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

/**
 * SK-11 承接口径统一（product-audit-20260910 C6）：未解清单的唯一权威读法。
 * 单一声明源挂在 draft/review/revision 三面共用的蓝图解释器（renderChapterExecutionContract）
 * 里，三面逐字同源；写作侧不产生"每章必须推进"的必填压力，审核侧不把它当从严承接清单，
 * 安静章/余波章的合法消化路径显式成立。双向测试断言三面 prompt 都含本常量。
 */
export const UNRESOLVED_THREADS_READING_CONTRACT =
  "章末未解清单的读法（写作与审核同一口径）：这是本章留给后续章节的冻结边界，不是逐章必须推进的承接清单。后续章节以什么方式处理——推进、保持、换视角侧写、或以安静章/余波章消化——都是合法的章节功能选择；安静章不触碰未解项不构成违例。可报告的承接问题只有两种：本章蓝图声明了承接责任而正文没有承载；或承接与冻结边界冲突（提前回答、抹平合理未知、改写既定悬置状态）。除此之外，不以“未明确承接”本身作为问题报告。";

export function renderNarrativeRhythm(rhythm: NarrativeRhythmSnapshot | undefined): string {
  if (!rhythm?.chapters.length) return "- 当前没有已定稿的前序章节节奏摘要。";
  return rhythm.chapters.map((chapter) =>
    `- 第 ${chapter.narrativeOrder} 章《${chapter.title}》：${chapter.narrativeFunction ?? "未标记功能"}；只用于位置衔接，具体连续性以冻结事实为准。`,
  ).join("\n");
}

const SERIAL_STATE_SNAPSHOT_MAX_CHARS = 40; // TODO P3: 序列证据渲染截断长度，应可配置

function truncate(value: string, max = SERIAL_STATE_SNAPSHOT_MAX_CHARS): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

/**
 * 渲染跨章序列证据：描述性统计信号，不是短语黑名单。
 *
 * 设计依据：AGENTS.md「问题要在机制层解决」——单章审核结构上看不见跨章模式，
 * 本函数把最近 N 章的状态重述、功能密度、物件/主题跨度投影为可核对信号。
 * 判断"母题还是疲劳"（原则 13：重复必须改变层级/意义/代价）留给 reviewer，
 * 本渲染不要求任何状态变化，不把任何词表变成硬性要求。
 */
export function renderSerialContext(serial: SerialContextSnapshot | undefined): string {
  if (!serial?.chapters.length) return "- 当前没有可用的跨章序列证据。";
  const lines: string[] = [];
  lines.push(`- 窗口：最近 ${serial.window} 章（第 ${serial.chapters[0].narrativeOrder}-${serial.chapters.at(-1)?.narrativeOrder} 章）。本段是跨章统计信号，只用于发现重述/密度/跨度模式，不是逐章要求；单次出现或母题式变化不算问题。`);
  const functions = serial.chapters.map((chapter) => `第${chapter.narrativeOrder}章=${chapter.narrativeFunction ?? "未标记"}`).join("；");
  lines.push(`- 功能序列：${functions}`);
  if (serial.functionRuns.length) {
    lines.push(`- 连续同类功能：${serial.functionRuns.map((run) => `${run.narrativeFunction}×${run.narrativeOrders.length}（第${run.narrativeOrders.join("、")}章）`).join("；")}；连续同类功能不等于问题，检查是否因此缺少压力推进或回报。`);
  }
  if (serial.characterSpans.length) {
    lines.push(`- 角色状态跨度：${serial.characterSpans.map((span) => `${span.characterId}（第${span.states.map((state) => state.narrativeOrder).join("、")}章）：${span.states.map((state) => truncate(state.stateSnapshot)).join(" → ")}`).join("；")}；同一状态连续多章出现时，检查是否有恶化/愈合/消耗/转移等可观察增量，无增量且措辞相近才报告节奏疲劳。`);
  }
  if (serial.subjectSpans.length) {
    lines.push(`- 物件/主题跨度：${serial.subjectSpans.map((span) => `${span.subject}（第${span.narrativeOrders.join("、")}章）：${truncate(span.latestExcerpt)}`).join("；")}；同一物件/主题跨章出现是正常的，检查每次出现是否承担新选择/新因果/新信息。`);
  }
  if (serial.openPromises?.length) {
    lines.push(`- 未兑现承诺/期限：${serial.openPromises.map((promise) => `${truncate(promise.statement)}（${promise.establishedAtOrder ? `建立于第${promise.establishedAtOrder}章` : "建立章未知"}）`).join("；")}；对照检查：正文对该承诺/期限的任何引用不得早于其建立章，时限与条件不得与陈述矛盾；已兑现的承诺不应仍以未决语气出现。`);
  }
  if (serial.assetSpans?.length) {
    lines.push(`- 可数资产数量对照：${serial.assetSpans.slice(0, 8).map((span) => `${span.subject}（${span.entries.map((entry) => `第${entry.narrativeOrder}章=${entry.quantity}`).join("、")}）`).join("；")}；对照检查：同一实体的数量在各章间应连续一致（获得/消耗/被夺须有交代），出现无交代的增减时报连续性问题。数量为模糊量（几/些）时不参与精确对照。`);
  }
  return lines.join("\n");
}

export function dedupeNarrativeRhythmMemory(memory: MemoryBundle): MemoryBundle {
  const revisionIds = new Set((memory.narrativeRhythm?.chapters ?? [])
    .map((chapter) => chapter.revisionId)
    .filter((revisionId): revisionId is string => Boolean(revisionId)));
  const claims = memory.claims.filter((claim) => {
    // Foundation claims are the compact global planning source. Keep them here;
    // draft/revision consume them through MemoryBundle rather than a second macro payload.
    const isChapterDigest = claim.matchedFacet === "chapter-memory"
      || claim.id.startsWith("pinned:memory:chapter:")
      || claim.id.startsWith("memory:chapter:");
    return !isChapterDigest || !claim.sourceRevisionIds.some((revisionId) => revisionIds.has(revisionId));
  });
  return claims.length === memory.claims.length ? memory : { ...memory, id: `${memory.id}:without-rhythm-duplicates`, claims };
}

export function renderExecutionMemoryClaim(claim: MemoryHit): { title: string; text: string } {
  if (claim.matchedFacet === "style" || (claim.matchedFacets?.includes("style") ?? false)) {
    return {
      title: claim.title,
      text: `${claim.content}\n文风契约是叙述声音的对照参考：偏离时检查是否服务于当前 POV、人物、场景压力与章节功能，不把任何取值变成逐章清单，也不把偏离本身当作问题。`,
    };
  }
  if (claim.knowledgeScope === "author") {
    return {
      title: claim.title,
      text: `作者侧冻结背景（只用于事实、边界和取舍，不是正文措辞）：${claim.content}\n把其中的分析模型、标签或专业表达转化为当前 POV 可经历的动作、感官、空间、对白和后果，不要原样复制为叙述。`,
    };
  }
  const characterId = claim.knowledgeScope.characterId;
  const proposition = claim.content.split(/\n证据：/u, 1)[0].replace(/^.+?在第\d+章得知：/u, "").trim();
  return {
    title: `角色知识边界：${characterId}`,
    text: `可知命题：${proposition || claim.title}\n使用边界：只据此判断该角色能否知晓相关信息，不照搬为对白、叙述或客观规则。`,
  };
}

/**
 * Preserve the retrieval decision instead of treating authority alone as a
 * prompt priority. Approved ranked-fill claims remain available context, but
 * only pinned ledger items and required facets are hard stage requirements.
 */
export function memoryClaimPriority(memory: MemoryBundle, claim: MemoryHit): StageContextPriority {
  const receipt = memory.selectionReceipts?.find((item) => item.claimId === claim.id && item.status === "included");
  if (receipt?.reason === "pinned-narrative" || receipt?.reason === "required-facet") return "required";
  if (!receipt && claim.authority === "author") return "required";
  return "normal";
}

/**
 * Single execution projection shared by draft, review and revision.
 * Editorial labels are intentionally absent; only causal state and observable scene material remains.
 */

/** 单章建议性目标篇幅（字符数）；蓝图可经 targetWordCount 覆盖，正文产出时作为创作指引而非硬性上限。
 *  唯一定义在 ../word-count（workflow bundle 安全叶子模块，见该文件注释），此处 re-export 兼容 prompt 侧引用。 */
export { DEFAULT_TARGET_WORD_COUNT } from "../word-count";
import { DEFAULT_TARGET_WORD_COUNT } from "../word-count";

export function renderChapterExecutionContract(context: ChapterPlanningContext): string {  const chapter = context.chapter;
  const projection = projectChapterForExecution(chapter);
  const scenes = projection.scenes.map((scene, index) => [
    `### 场景 ${index + 1}：${scene.title}`,
    `- 处境：${scene.situation}`,
    `- 参与人物：${scene.participants.join("、") || "未限定"}`,
    `- 可观察行动：${scene.observableActions.join("；")}`,
    `- 阻力：${scene.opposition || "未指定，由人物处境自然形成"}`,
    `- 选择：${scene.decision || "未指定，不强制制造选择"}`,
    `- 结果：${scene.outcome}`,
    `- 代价：${scene.cost || "未指定"}`,
  ].join("\n")).join("\n\n");
  const neighbors = context.neighbors.length
    ? context.neighbors.map((item) => `- 第 ${item.globalOrder} 章《${item.title}》：${item.narrativeFunction ?? "未标记功能"}`).join("\n")
    : "- 无相邻章节蓝图。";
  return [
    "## 章节执行契约",
    `上下文指纹：${context.fingerprint}`,
    `目标章：第 ${chapter.globalOrder} 章《${chapter.title}》`,
    `叙事功能：${projection.narrativeFunction ?? "由正文自然形成"}`,
    `POV：${projection.povCharacterId || "未限定"}`,
    `目标篇幅：约 ${chapter.targetWordCount ?? DEFAULT_TARGET_WORD_COUNT} 字（建议性目标：以情节完整为优先，不因凑字或压字牺牲内容，也不设硬性上限）`,
    `起始状态：${projection.stateTransition.before}`,
    `结束状态：${projection.stateTransition.after}`,
    `状态证据：${projection.stateTransition.evidence}`,
    "### 场景因果",
    scenes,
    "### 连续性边界",
    list(projection.continuityConstraints),
    "### 章末未解",
    list(projection.unresolvedAtClose, "无"),
    // SK-11 承接口径统一（product-audit-20260910 C6）：写作/审核/修订三面对"未解清单"
    // 此前各读各的——reviewer 对"明确承接"从严、写作侧 skill 不禁必填，安静章易误伤。
    // 单一权威口径挂在这三 prompt 共用的唯一蓝图解释器里，三面逐字同源，漂移即破坏测试。
    UNRESOLVED_THREADS_READING_CONTRACT,
    "### 相邻章节位置",
    neighbors,
    "### 读者复原边界",
    "表达可以有风格，现场信息不能缺失。重要变化只需提供当前功能所需的现场证据，不要求每段同时具备身体、空间、物件和感官。技术、制度或理论化认知可以保留，但只有在改变即时选择、表达角色独有认知或承担不可替代的世界观功能时才让它承担信息；否则应通过自然中文的动作、感受、空间关系或结果呈现。普通读者不必立即理解每个陌生词，但应能从上下文复原人物正在经历什么、为何行动以及行动造成的结果。",
    "以上是因果和事实边界，不是正文措辞、节拍清单或固定篇幅要求。规划器内部的分析方法不属于正文执行材料；未指定的表达、场景细节、节奏和情绪承载由作者根据人物与处境自然展开。",
  ].join("\n\n");
}

export function renderChapterPlanningContext(context: ChapterPlanningContext, options: { includeMacro?: boolean } = {}): string {
  if (options.includeMacro === false) return renderChapterExecutionContract(context);
  return [
    renderChapterExecutionContract(context),
    "## 故事弧参考",
    `故事弧：${context.arc.title}`,
    `目标：${context.arc.objective}`,
    `核心冲突：${context.arc.centralConflict || "未指定"}`,
    `发展：${context.arc.development.join("；") || "未指定"}`,
    `离场状态：${context.arc.exitState || "未指定"}`,
  ].join("\n\n");
}
