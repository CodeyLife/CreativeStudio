import type { Artifact } from "../protocol";
import { chapterStateDeltaSchema, type ChapterStateDelta } from "../prompts/schemas";

/**
 * V2 事实提取 prompt 构造器。
 *
 * 与 v1 [facts.ts] 的 LLM 提取 prompt 等价，但参数化为 v2 数据结构。
 *
 * 提取目标：从章节正文中识别结构化事实（subject/predicate/object + 元数据），
 * 用于：
 * - 写入 memory_claims 表（v2 替代 v1 factAssertions/knowledgeAssertions）
 * - 在 qdrant-memory 中建立语义索引供后续检索
 * - 检测与既有 MemoryBundle 的冲突（conflict=true）
 */

export interface FactExtractionPromptInput {
  artifact: Artifact;
  text: string;
  existingClaimsDigest?: string;
  openNarrativeElements?: {
    foreshadowings: Array<{ id: string; description: string; triggerKeywords: string[]; expectedPayoffWindow: string }>;
    promises: Array<{ id: string; promiser: string; promisee: string; statement: string }>;
  };
}

/**
 * 构建事实提取 prompt。
 *
 * 设计依据：AGENTS.md「root-cause analysis」要求 reusable contracts over
 * case-specific examples。本 prompt 只描述通用提取规则，不嵌入任何 fixture。
 *
 */
export function buildFactExtractionPrompt(input: FactExtractionPromptInput): string {
  const sections: string[] = [
    `从下面章节正文中提取结构化事实与叙事元素。只提取正文实际呈现的内容，不提取隐喻、修辞或读者推断。`,
    "",
  ];

  sections.push(
    `## 顶层输出合同（不可省略）`,
    `- 顶层必须始终输出 facts 和 narrativeElements；没有内容时输出空数组或包含三个空数组的对象。`,
    `- 只输出一个 JSON 对象，不输出 Markdown、解释文字或代码围栏。`,
    "",
    `## 提取规则（facts）`,
    `- 准入原则：只有后续章节为避免矛盾、延续因果或维护角色知识边界而需要再次使用的信息，才是叙事事实。正文中出现过不等于值得沉淀。`,
    `- 必须至少属于一类长期用途：身份/世界规则，关系或能力边界，持续状态，明确的状态变化，角色知识变化，尚未履行的承诺，或会约束后续行动的因果结果。`,
    `- 一次性动作、临时站位、普通行程过程、服饰、天气、表情和无后续影响的环境细节不提取；只有它们改变持续状态或形成后续约束时才提取变化后的事实。`,
    `- 同一持续状态在后续章节被再次提及但没有变化时必须省略，不得换一种谓词重复写入。`,
    `- subject.kind 限定为：project/entity/relation/outline/scene/thread/foreshadowing/timeline。`,
    `- subject.id 必须是正文中可指认的对象（人物名、地点名、关系名等）；不得用"主角""反派"等代词。`,
    `- predicate 只写稳定、最短的关系词，不得夹带主体、客体、时间或原因；同类关系优先复用已存在记忆中的谓词。系统预置关系使用"身份/持有/位于/知晓/隶属/给予/状态变化"，确有不同语义时才使用项目自定义谓词。`,
    `- object.kind 限定为：entity-ref/string/number/boolean/json。value 始终是字符串：entity-ref/string 直接写值，number/boolean/json 写规范化 JSON 文本。`,
    `- polarity=affirmed 表示正面陈述；negated 表示正文明确否定（如"并未出生于此"）。`,
    `- truthStatus：objective=客观事实（地点、时间、物件状态）；claim=人物声明（可能不可靠）；contested=多方冲突陈述；open-question=正文留白。`,
    `- humanReadable 是事实的自然语言描述，便于人工审核。`,
    `- evidence 必须引用正文逐字证据（不少于 8 字），不得概括。`,
    `- confidence 0-1：直接陈述=0.9+，转述=0.7+，暗示=0.5+；低于 0.5 不提取。`,
    `- novelty=new/update/duplicate：相对于已存在记忆的新增/更新/重复。`,
    `- conflict=true：与既有冻结记忆冲突（需要后续人工审核）。`,
    "",
    `## 提取规则（narrativeElements，Phase 3.1）`,
    `除了 facts，还要提取本章的叙事装置：伏笔、承诺、兑现。`,
    "",
    `### foreshadowings（本章埋设的伏笔）`,
    `- 只提取正文实际暗示但未明确揭示的内容（如"她注意到墙上那幅画似乎在动"）。`,
    `- triggerKeywords 是后续兑现时应出现的关键词（如"画""动""隐藏"）。`,
    `- expectedPayoffWindow 是预期兑现时机（如"5 章内""本卷末""长篇后期"）。`,
    `- 不提取：明显的剧情推进、角色内心独白、修辞意象。`,
    "",
    `### promises（本章作出的承诺）`,
    `- 只提取正文明确陈述的承诺（如"我一定会回来""三个月后还你"）。`,
    `- promiser/promisee 必须是正文中可指认的角色名（不用"主角""他"）。`,
    `- statement 是承诺的自然语言描述。`,
    "",
    `### payoffs（本章兑现的伏笔/承诺）`,
    `- 只提取本章实际兑现的内容，不提取"即将兑现"的暗示。`,
    `- payoffType=foreshadowing：兑现了之前的伏笔；matchedTriggerKeywords 填匹配到的伏笔触发关键词。`,
    `- payoffType=promise：兑现了之前的承诺；matchedPromiser 填承诺者角色名。`,
    `- 如果下方提供了开放叙事元素，明确兑现时填写对应的精确 ID（matchedForeshadowingIds 或 matchedPromiseId）；没有明确对应关系时 matchedPromiseId 写空字符串、matchedForeshadowingIds 写空数组，不要猜测。`,
    `- matchedTriggerKeywords、matchedForeshadowingIds 始终为数组；matchedPromiseId、matchedPromiser 始终为字符串；没有可靠关联时使用空值。intensity 使用 0 表示没有可靠判断，否则为 1-5。`,
    "",
    `## 优先级`,
    `1. 人物身份、关系、能力、知识边界（影响后续叙事连续性）。`,
    `2. 时间、地点、物件状态（影响事实账本）。`,
    `3. 伏笔、承诺、兑现、未解之谜（影响长篇追读）。`,
    `4. 角色认知变化（谁知道了什么、何时知道）。`,
    "",
    `## 不提取`,
    `- 修辞、隐喻、意象（如"她的心像落叶"）。`,
    `- 读者推断（如"作者暗示她会后悔"）。`,
    `- 已在冻结记忆中存在且无更新的事实（novelty=duplicate 必须省略）。`,
      `- narrativeElements 中的三个数组可以为空——不要为了凑数虚构伏笔或承诺。`,
    "",
    `## 已存在记忆摘要（用于 novelty/conflict 判断）`,
    input.existingClaimsDigest ?? "- 暂无已存在记忆。所有事实 novelty=new。",
    "",
    `## 已知开放叙事元素（只用于兑现关联，不代表本章必须处理）`,
    input.openNarrativeElements
      ? [
        `伏笔：${input.openNarrativeElements.foreshadowings.map((item) => `${item.id}｜${item.description}｜关键词=${item.triggerKeywords.join("、") || "未指定"}｜窗口=${item.expectedPayoffWindow}`).join("\n") || "无"}`,
        `承诺：${input.openNarrativeElements.promises.map((item) => `${item.id}｜${item.promiser}->${item.promisee}｜${item.statement}`).join("\n") || "无"}`,
      ].join("\n")
      : "- 未提供；兑现关联只能保留为未关联的结构记录。",
    "",
    `## 章节正文（段落编号仅用于定位）`,
    buildNumberedText(input.text),
    "",
  );
  return sections.join("\n");
}

function buildNumberedText(text: string): string {
  const paragraphs = text.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  return paragraphs.map((paragraph, index) => `### 段落 ${index + 1}\n${paragraph}`).join("\n\n");
}

export { chapterStateDeltaSchema, type ChapterStateDelta };
