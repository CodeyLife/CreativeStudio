import { projectChapterForExecution, type ChapterPlanningContext } from "../application/story-arc";
import type { MemoryBundle, MemoryClaim, NarrativeRhythmSnapshot, StageContextPriority } from "../protocol";

function list(items: string[], empty = "无"): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

export function renderNarrativeRhythm(rhythm: NarrativeRhythmSnapshot | undefined): string {
  if (!rhythm?.chapters.length) return "- 当前没有已定稿的前序章节节奏摘要。";
  return rhythm.chapters.map((chapter) =>
    `- 第 ${chapter.narrativeOrder} 章《${chapter.title}》：${chapter.narrativeFunction ?? "未标记功能"}；只用于位置衔接，具体连续性以冻结事实为准。`,
  ).join("\n");
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

export function renderExecutionMemoryClaim(claim: MemoryClaim): { title: string; text: string } {
  if (claim.knowledgeScope === "author") return { title: claim.title, text: claim.content };
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
export function memoryClaimPriority(memory: MemoryBundle, claim: MemoryClaim): StageContextPriority {
  const receipt = memory.selectionReceipts?.find((item) => item.claimId === claim.id && item.status === "included");
  if (receipt?.reason === "pinned-narrative" || receipt?.reason === "required-facet") return "required";
  if (!receipt && claim.authority === "author") return "required";
  return "normal";
}

/**
 * Single execution projection shared by draft, review and revision.
 * Editorial labels are intentionally absent; only causal state and observable scene material remains.
 */
export function renderChapterExecutionContract(context: ChapterPlanningContext): string {
  const chapter = context.chapter;
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
    `起始状态：${projection.stateTransition.before}`,
    `结束状态：${projection.stateTransition.after}`,
    `状态证据：${projection.stateTransition.evidence}`,
    "### 场景因果",
    scenes,
    "### 连续性边界",
    list(projection.continuityConstraints),
    "### 章末未解",
    list(projection.unresolvedAtClose, "无"),
    "### 相邻章节位置",
    neighbors,
    "以上是因果和事实边界，不是正文措辞、节拍清单或固定篇幅要求。未指定的表达、场景细节、节奏和情绪承载由作者根据人物与处境自然展开。",
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
