import { createHash } from "node:crypto";
import type { Artifact, Review, ReviewIssue } from "../protocol";
import { ENDING_RITUAL_POLICY } from "../word-count";

const RETIRED_STRUCTURAL_RULES = new Set(["manuscript.length"]);

export interface ManuscriptStructuralMetrics {
  characterCount: number;
  paragraphCount: number;
  medianParagraphCharacters: number;
  shortParagraphRatio: number;
  repeatedParagraphCount: number;
  repeatedBlockCount: number;
}

export interface ManuscriptStructuralReport {
  passed: boolean;
  fingerprint: string;
  blockers: ReviewIssue[];
  warnings: ReviewIssue[];
  metrics: ManuscriptStructuralMetrics;
}

export interface InspectManuscriptInput {
  text: string;
  stopReason?: string;
  /**
   * 可选：同书近若干章的结尾正文（末段），供 manuscript.ending-ritual 做跨章重复度测量。
   * 缺省（undefined/空）时该通道整体不触发，既有调用方零影响；跨章语境只有编排方能提供。
   */
  priorEndings?: string[];
}

function activeStructuralIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter((item) => !item.rule || !RETIRED_STRUCTURAL_RULES.has(item.rule));
}

/** Keep persisted reviews from retired validators from affecting current workflows. */
export function normalizeManuscriptStructuralReview(review: Review): Review {
  if (review.role !== "structural-validator") return review;
  const issues = activeStructuralIssues(review.issues);
  if (issues.length === review.issues.length) return review;
  return {
    ...review,
    issues,
    verdict: issues.some((item) => item.severity === "blocker") ? "blocked" : "passed",
  };
}

function novelCharacterCount(value: string): number {
  return [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

function normalizeParagraph(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function splitParagraphs(value: string): string[] {
  return value.split(/\n\s*\n/gu).map(normalizeParagraph).filter(Boolean);
}

function issue(severity: ReviewIssue["severity"], title: string, evidence: string, rule: string, paragraph?: number): ReviewIssue {
  return { severity, title, evidence, rule, ...(paragraph ? { paragraph } : {}) };
}

function repeatedBlocks(paragraphs: string[]): Array<{ start: number; duplicateStart: number; length: number; characters: number }> {
  const blocks: Array<{ start: number; duplicateStart: number; length: number; characters: number }> = [];
  for (let left = 0; left < paragraphs.length; left += 1) {
    for (let right = left + 1; right < paragraphs.length; right += 1) {
      let length = 0;
      let characters = 0;
      while (left + length < right && right + length < paragraphs.length && paragraphs[left + length] === paragraphs[right + length]) {
        characters += novelCharacterCount(paragraphs[left + length]);
        length += 1;
      }
      if (length >= 2 && characters >= 120) blocks.push({ start: left, duplicateStart: right, length, characters });
    }
  }
  return blocks.filter((block, index, all) => !all.some((candidate, candidateIndex) => candidateIndex < index
    && candidate.start <= block.start
    && candidate.duplicateStart <= block.duplicateStart
    && candidate.start + candidate.length >= block.start + block.length
    && candidate.duplicateStart + candidate.length >= block.duplicateStart + block.length));
}

// TODO: move these structural thresholds to shared output-policy configuration.
const OUTPUT_WRAPPER_SCAN_LINES = 5;
const OUTPUT_WRAPPER_TITLE_LENGTH = 30;
const OUTPUT_WRAPPER_PREFIX_LENGTH = 18;
/** 工件指涉：对文本本身施作的词（包装泄漏必然谈论工件），与故事世界叙述正交。 */
const ARTIFACT_DEIXIS = /(正文|如下|以下|输出|改写|修订|替换|审核|按要求|按指令|调整如下|删去|保留|以下为)/u;

function hasLeadingOutputWrapper(text: string): boolean {
  if (/^```|```\s*$/u.test(text)) return true;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < Math.min(OUTPUT_WRAPPER_SCAN_LINES, lines.length); index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    if (/^#{1,3}\s+\S/u.test(trimmed)) return true;
    if (trimmed.length <= OUTPUT_WRAPPER_TITLE_LENGTH && /[:：]\s*$/u.test(trimmed)) return true;
    const colonMatch = trimmed.match(/^([^\n:：]{2,24})[:：]\s*(.*)$/u);
    if (colonMatch && colonMatch[1].length <= OUTPUT_WRAPPER_PREFIX_LENGTH && !/[。！？…—]/u.test(colonMatch[1])) return true;
    // 短引导句+同行长续写的形状在中文叙事里合法（"黑屋里没有灯。楚衡靠着墙根…"，
    // ch55 误报实证）：要求续写携带工件指涉（对文本本身施作的词：正文/输出/替换/审核…），
    // 真包装必然谈论工件本身，叙事句谈论故事世界——形态学区分而非短语黑名单。
    if (trimmed.length <= 60 && /^[^。\n]{1,8}。\s*\S{8,}/u.test(trimmed) && ARTIFACT_DEIXIS.test(trimmed)) return true;
    break;
  }
  return false;
}

/**
 * 取一章正文的结尾末段（未剥标点的原样文本），供跨章语境加载方复用。
 *
 * 与通道判据的分工：本函数负责"取哪一段"（splitParagraphs 与判据共用同一分段口径，
 * 避免两处分段规则漂移），句切与信号计算仍由判据内部完成。
 * 跨章语境加载方（activities.loadPriorChapterEndings）只传末段而非全章，
 * 保证"取段口径"只有一个定义处。
 */
export function extractChapterEnding(value: string): string {
  const paragraphs = splitParagraphs(value).filter((item) => novelCharacterCount(item) > 0);
  return paragraphs[paragraphs.length - 1] ?? "";
}

/**
 * 末段内的句子切分（供章末仪式化判据使用）。
 * 用标点边界切句，与题材无关；过滤掉无有效字的残片（如残留的引号）。
 */
function splitSentences(value: string): string[] {
  return value.split(/(?<=[。！？…])/u).map((item) => item.trim()).filter((item) => novelCharacterCount(item) > 0);
}

/**
 * 章末仪式化信号：末段末句短促（纯长度判据，与具体用字无关）。
 * 短句是"章末被压成一个孤立动作/留白断章"的最直接结构证据。
 *
 * 校准依据：以 12 批次逐章精修记录为 ground truth，在 6 个候选判据中，
 * 本信号（末句 ≤8 字）在滑窗占比 ≥0.5 时精确率 1.00、召回率 0.58、F1 0.73，
 * 且对前 45 章（用户认可的正文）**零误报**；而"末段总长"类指标精确率仅 0.24、
 * 早期误报 18 章——说明病在"末句被压短"，不在"末段本身短"。
 */
function hasShortClosingSentence(ending: string): boolean {
  const sentences = splitSentences(ending);
  const last = sentences[sentences.length - 1] ?? ending;
  return novelCharacterCount(last) <= ENDING_RITUAL_POLICY.shortSentenceMax;
}

/**
 * 章末仪式化比例：当前章与窗口内前章的末段中，「末句短促」成立的比例。
 *
 * 关键：按**窗口比例**而非单章命中判定。单章以短句收尾是合法的利落笔法
 * （如 `他低下头，继续除草。`），只有连续复现（窗口内占比超阈值）才构成惯性。
 * 这也决定了它在口癖段落的**内部**触发，而非在蔓延的第一章触发——
 * 段落边缘章不命中是窗口判据的固有行为，不是缺陷。
 */
function endingRitualRatio(current: string, prior: string[]): number {
  const all = [...prior, current].filter((item) => novelCharacterCount(item) > 0);
  if (!all.length) return 0;
  const hits = all.filter(hasShortClosingSentence).length;
  return hits / all.length;
}

export function inspectManuscript(input: InspectManuscriptInput): ManuscriptStructuralReport {
  const text = input.text.trim();
  const paragraphs = splitParagraphs(text);
  const paragraphLengths = paragraphs.map(novelCharacterCount).sort((left, right) => left - right);
  const characterCount = novelCharacterCount(text);
  const blockers: ReviewIssue[] = [];
  const warnings: ReviewIssue[] = [];

  if (!text) blockers.push(issue("blocker", "正文为空", "正文没有任何有效内容", "manuscript.empty"));
  if (hasLeadingOutputWrapper(text)) {
    blockers.push(issue("blocker", "正文包含输出包装或指令文本泄漏", text.slice(0, 120), "manuscript.wrapper"));
  }
  if (input.stopReason && /(?:length|max[_ -]?tokens?|token[_ -]?limit)/iu.test(input.stopReason)) {
    blockers.push(issue("blocker", "正文因输出上限截断", input.stopReason, "manuscript.truncated"));
  }

  const paragraphOccurrences = new Map<string, number[]>();
  paragraphs.forEach((paragraph, index) => {
    const locations = paragraphOccurrences.get(paragraph) ?? [];
    locations.push(index);
    paragraphOccurrences.set(paragraph, locations);
  });
  const longRepeatedParagraphs = [...paragraphOccurrences.entries()].filter(([paragraph, locations]) => novelCharacterCount(paragraph) >= 80 && locations.length > 1);
  for (const [paragraph, locations] of longRepeatedParagraphs) {
    blockers.push(issue("blocker", "长段落重复", `第 ${locations.map((index) => index + 1).join("、")} 段重复：${paragraph.slice(0, 120)}`, "manuscript.repeated-paragraph", locations[1] + 1));
  }

  const blocks = repeatedBlocks(paragraphs);
  for (const block of blocks) {
    blockers.push(issue("blocker", "连续段落块重复", `第 ${block.start + 1}-${block.start + block.length} 段与第 ${block.duplicateStart + 1}-${block.duplicateStart + block.length} 段重复，共 ${block.characters} 个有效字符`, "manuscript.repeated-block", block.duplicateStart + 1));
  }

  const shortParagraphCount = paragraphLengths.filter((length) => length <= 20).length;
  const shortParagraphRatio = paragraphs.length ? shortParagraphCount / paragraphs.length : 0;
  const medianParagraphCharacters = paragraphLengths.length ? paragraphLengths[Math.floor((paragraphLengths.length - 1) / 2)] : 0;
  if (paragraphs.length >= 100 && shortParagraphRatio >= 0.85) {
    warnings.push(issue("warning", "段落结构高度碎片化", `${paragraphs.length} 段中 ${(shortParagraphRatio * 100).toFixed(1)}% 不超过 20 个有效字符，中位数 ${medianParagraphCharacters}`, "manuscript.fragmentation"));
  }

  // Style-sheet 确定性门（2026-09-08，warning 级）：全书表层约定类问题。
  // 边界：只做结构与码位级检查（引号配对、内嵌标题行），不做错字词表（泛化红线：
  // 堆叠 case-specific 词表违反 AGENTS.md）；提示级输出，由维护通道批量修复。
  for (const [index, paragraph] of paragraphs.entries()) {
    const straightQuotes = (paragraph.match(/"/gu) ?? []).length;
    if (straightQuotes % 2 !== 0) {
      warnings.push(issue("warning", "引号配对异常（段内半角直引号为奇数）", `第 ${index + 1} 段：${paragraph.slice(0, 80)}`, "manuscript.quote-pairing", index + 1));
      break;
    }
  }
  if (/^\s*第[一二三四五六七八九十百千\d]+章\s*\S+/u.test(paragraphs[0] ?? "")) {
    warnings.push(issue("warning", "正文内嵌章节标题行", `首段：${(paragraphs[0] ?? "").slice(0, 60)}`, "manuscript.embedded-title", 1));
  }
  // Markdown 泄漏（ch52 实证：正文出现 **粗体星号**）：叙事散文正文不含 Markdown 标记，
  // 出现即为模型输出包装残留候选。码位级结构判据，跨题材复用；warning 级（引文/信札
  // 题材若合法使用星号分节需人工放行）。TODO: 判据进 output-policy 配置。
  const markdownMarks = text.match(/\*\*[^*\n]{2,}|^#{1,4}\s+\S/gmu) ?? [];
  if (markdownMarks.length) {
    warnings.push(issue("warning", "正文出现 Markdown 标记（输出包装泄漏候选）", `${markdownMarks.length} 处：${markdownMarks.slice(0, 2).map((m) => m.slice(0, 40)).join(" / ")}——叙事正文应去除标记或转为题材排版（分隔符用空行）`, "manuscript.markdown-leak"));
  }

  // 句法 tic 检查（2026-09-16 质量梳理 L3 的机制端落点）：语料扫描确诊"不是A，是B"
  // 对比句与"X息"计时词是本书密度最高的两类模型口癖（后者 16 倍增长），且软预算指令
  // 拦不住（ch120 带预算生成仍越线）——移入确定性 warning 通道。泛化边界：只认结构式
  // （对照复句/计量词家族）+千字密度阈值（取语料分布的离群点），不做词表黑名单、
  // 不影响 passed（warning 级），跨题材复用。
  //
  // 2026-09-17 全量复扫修正（docs/novel-v2/ai-taint-diagnosis-20260917.md F2）：
  // 原判据只写 /[一二三四五六七八十半]息/，实测只是"计量刻度"家族的**一式**。
  // 该家族在语料里的完整形态是「半 + 度量单位」，而"息"只是单位之一：
  // 半拍/半寸/半分/半步与"三息"同族同源，都是把体验折算成刻度的同一机制。
  // 单测"息"式产生了**改述绕过**：治理期内"息"式密度 0.68→0.17 下降，家族总量
  // 却从 0.34 涨到 3.66/千字（10.8 倍），新高全在最晚的章节——即检测器被绕开，
  // 而指标读数持续报"改善"。修复=**补上零覆盖的那几式**，两式各自独立计数。
  //
  // 首次接线实测（tmp/gate-tune.mjs，决定性校准）：
  //   · 把「任意数量词 + 任意单位」都收入 → 命中 127/168，把「三步」「一分」「几句」
  //     这类正常中文全判成口癖。开放集必须收窄：刻度前饰只认「半」（把体验切成
  //     半份是本族独有机制），数量词一侧只保留既有的「X息」。
  //   · 两式**不得合并计数**：合并会把「息式已治住」与「半式仍在涨」两个相反趋势
  //     互相抵消，正是原判据"读数报改善、实际在恶化"的成因。
  //   · 两式阈值也不同，因为治理史不同：
  //     ①「半+非息单位」全新覆盖，min=8/perK=4 → 命中 14/168，1-20 章零命中
  //       （不外溢到未染期），141-168 命中 4 章——正是本次复扫确诊的高发区。
  //     ②「X息」保持 min=5/perK=3 零回归；实测该式已被治住，141-168 零命中，
  //       命中 11 章全在 60-135 的历史存量带。
  // 单位集合是**中文通用度量语汇**（空间/时间/力度刻度），与题材无关。
  // TODO: 单位集合与两组阈值应进 output-policy 配置。
  const MEASURE_UNITS = "拍寸分步刻晌指口";
  const ticChecks: Array<{ name: string; pattern: RegExp; minCount: number; perK: number }> = [
    { name: "『不是A，是B』对比复句", pattern: /(?<!是)不是[^，。；！？\u201D]{1,14}[，,]\s*是/gu, minCount: 4, perK: 2 },
    { name: "计量刻度词（半拍·半寸·半分·半步等）", pattern: new RegExp(`半[${MEASURE_UNITS}]`, "gu"), minCount: 8, perK: 4 },
    { name: "数息计时词（一息/半息/三息…）", pattern: /[一二三四五六七八十半]息/gu, minCount: 5, perK: 3 },
  ];
  for (const tic of ticChecks) {
    const count = (text.match(tic.pattern) ?? []).length;
    const density = characterCount ? (count * 1000) / characterCount : 0;
    if (count >= tic.minCount && density >= tic.perK) {
      warnings.push(issue("warning", `句法口癖超密度：${tic.name}`, `全章 ${count} 处（${density.toFixed(1)}/千字，阈值 ${tic.perK}/千字），建议留最有力处、其余改直陈或换句式`, "manuscript.syntactic-tic"));
    }
  }

  // 编排元数据与外来符号泄漏（2026-09-16 全量审校的机制端）：语料确诊正文出现
  // "第70章/第95章"式阿拉伯章序（4 章——编排指令的章号被复述进正文）与英文残留
  // （shrug/rehears——模型语言混染）。判据基于码位形态而非词表：中文叙事正文的章序
  // 惯例是汉字（"第七章"，由 embedded-title 通道管），阿拉伯章序与 ≥3 连拉丁字母
  // 出现在正文即泄漏候选。边界：warning 级不拦截——系统面板、书信引文等确属题材
  // 需要的用法人工放行。TODO: 判据阈值应进 output-policy 配置。
  const metaReferences = text.match(/第\d+章/gu) ?? [];
  if (metaReferences.length) {
    warnings.push(issue("warning", "正文出现阿拉伯章序引用（编排元数据泄漏候选）", `${metaReferences.length} 处：${[...new Set(metaReferences)].slice(0, 3).join("、")}——正文指涉章节应转叙内事件锚（"那日""上账那晚"），引用书内章题需确认为剧情文本`, "manuscript.meta-reference"));
  }
  const latinWords = [...new Set((text.match(/[A-Za-z]{3,}/gu) ?? []).map((word) => word.toLowerCase()))];
  if (latinWords.length) {
    warnings.push(issue("warning", "正文出现拉丁词残留", `${latinWords.slice(0, 5).join("、")}——中文叙事正文的拉丁词是语言混染候选；确属题材需要（界面板、专有名词）人工放行`, "manuscript.latin-residue"));
  }

  // 元叙述残留（2026-09-18 全本逐章精读确诊，docs/novel-v2/full-read-quality-review-20260918.md P0）：
  // 147 章末出现"约三千字。骨架十拍齐备，两断不判，三物只排不并看，未解三条原样悬置。"
  // ——把**章节规格清单**（字数、骨架拍数、未解条目数）复述进正文。这是最严重的破壁：
  // 读者在本该是故事的地方看见作者清点自己的作业。与 meta-reference（第N章）同源
  // （都是编排/规格指令被模型回显），但形态不同（章序 vs 自陈），故另立通道独立计数。
  //
  // 判据取"叙述者对文本自身作陈述"这一**语域特征**，词条是写作指令的通用语汇，与题材无关：
  //   ① 字数自陈：章节指称 + 量词 + 字（"约三千字/本章 2800 字"）——人物不会清点本章字数；
  //      （刻意不含"共/计"，避免误伤正文里清点文书字数的合法叙事，如"批语四个字"。）
  //   ② 结构自评：骨架/结构/节拍/章法 + 齐备/完整/闭环/达标；
  //   ③ 悬置清单：未解/未决/悬置 + 条数或"原样"——这是**清单**，不是叙述。
  // 边界：warning 级不拦截；正文人物确在清点自己的文书时人工放行。
  // TODO: 三组词条与阈值应进 output-policy 配置。
  const metaNarrativeChecks: Array<{ name: string; pattern: RegExp }> = [
    { name: "字数自陈", pattern: /(?:约|全章|本章|全文|全篇|本篇)\s*[0-9零一二三四五六七八九十百千]+\s*字/gu },
    { name: "结构自评", pattern: /(?:骨架|结构|节拍|章法)[^。；\n]{0,12}(?:齐备|完整|闭环|达标|就位)/gu },
    { name: "悬置清单", pattern: /(?:未解|未决|悬置)[^。；\n]{0,8}(?:[一二三四五六七八九十\d]+\s*条|原样)/gu },
  ];
  for (const check of metaNarrativeChecks) {
    const hits = text.match(check.pattern) ?? [];
    if (hits.length) {
      warnings.push(issue("warning", `元叙述残留：${check.name}`, `${hits.length} 处：${[...new Set(hits)].slice(0, 3).join("、")}——正文不应出现叙述者对本章字数/结构/未解条目数的自陈，整句删除即可`, "manuscript.meta-narrative"));
    }
  }
  // 段制坍缩（fragmentation 的镜像病例，ch88 实证：中位段长 344 字 vs 全书 p90≈83）：
  // 场景未换气，读者视线无落点。与碎片化共用段落长度分布这一结构事实，阈值取离群带。
  // TODO: 200 为语料校准的魔法值，应配置化。
  if (paragraphs.length >= 5 && medianParagraphCharacters >= 200) {
    warnings.push(issue("warning", "段落结构坍缩（中位段长超离群阈值）", `中位数 ${medianParagraphCharacters} 字/段（阈值 200；全书正文中位段长 p90≈83），场景未换气`, "manuscript.paragraph-fusion"));
  }

  // 段落呼吸扁平（2026-09-17 全量复扫新增，docs/novel-v2/ai-taint-diagnosis-20260917.md F1）：
  // 症状是"节拍器呼吸"——全章每段长度趋同，读起来像工序表逐格填满，没有长段造压、
  // 也没有短段落刀。根因在下游：逐章创作指令一律写成**等量配额**（"六段各≥550字"
  // "每段 220-280 字"），而等量配额的最省力满足方式就是把每段写到配额线附近；
  // 本通道测量段落长度的**变异度**，此前从未被任何通道测量。
  //
  // 判据取两个结构事实的合取，都是分布形态而非任何词表：
  //   ① 变异系数 cv = sd/mean 低于离群带（168 章实测 p25=0.653、p10=0.564）；
  //   ② **全章无真正的短段**（≤20 有效字）——节奏张力的最直接缺失证据。
  // ②是必要项：短段（"呈。"/"没有填。"）是长段压力的释放阀，缺它就只剩匀速推进。
  // 实测（cv<0.60 且无短段）命中 7/168，全部落在 88 章之后，且 1-50 章零命中
  // ——不外溢到用户认可的早期正文。阈值与短段上限是语料校准值，应配置化。
  // 边界：仅对段数 ≥8 的章生效（短章样本不足以判断呼吸形态）；warning 级不拦截。
  if (paragraphs.length >= 8) {
    const meanParagraphCharacters = paragraphLengths.reduce((sum, value) => sum + value, 0) / paragraphLengths.length;
    const variance = paragraphLengths.reduce((sum, value) => sum + (value - meanParagraphCharacters) ** 2, 0) / paragraphLengths.length;
    const paragraphCv = meanParagraphCharacters ? Math.sqrt(variance) / meanParagraphCharacters : 0;
    const hasRealShortParagraph = paragraphLengths.some((length) => length <= 20);
    if (paragraphCv < 0.6 && !hasRealShortParagraph) {
      warnings.push(issue(
        "warning",
        "段落呼吸扁平（全章段长趋同且无短段）",
        `段长变异系数 ${paragraphCv.toFixed(2)}（阈值 0.60），${paragraphs.length} 段中位 ${medianParagraphCharacters} 字、无一段 ≤20 字——长段造压与短段落刀同时缺席，全章呈匀速推进；建议把最重的一拍写成独立长段，并在停顿处留出真正的短段`,
        "manuscript.paragraph-rhythm",
      ));
    }
  }

  // 章末仪式（2026-09-18 全本逐章精读 P1 + 同日 168 章实测校准，见
  // docs/novel-v2/cross-chapter-quality-engineering-20260918.md §3.1）：
  // 症状是"章末反复以同一形态收束"——留白短句收尾单看是本书的优点（留白恰是底色），
  // 跨章才暴露为口癖。**这是本通道必须跨章的原因**：单章内留白与口癖形态相同，
  // 任何单章判据都会把优点一起打掉，故不设单章版本。
  //
  // 判据是**单一结构信号在滑窗内的占比**，不是字面相似度：
  //   末段末句 ≤ shortSentenceMax 字（短促收尾）。与用字无关，只看句长。
  // 原「末段字符二元组 Jaccard」判据已废弃：168 章实测全书两两最高相似度仅 0.294，
  // 任何阈值命中数均为 0（同族异形句如 `吹灯。`/`吹了灯。` 相似度 0.000）——
  // 字面仪器测不出语义层的仪式，会得到一个"看似激活、永远沉默"的通道。
  //
  // 为什么不加"末段整段短"这一附加条件：同日用人工精修记录作 ground truth 对照 6 个候选，
  // 附加"整段只有一句"会令召回从 0.58 掉到 0.20（仪式主要以"多句铺陈 + 末句短促"表达）；
  // 而改用"末段总长"类指标则精确率从 1.00 掉到 0.24 并在前 45 章误报 18 章——
  // 长度本身不是病，**末句被压成短促断章**才是。
  //
  // 为什么按窗口比例而非单章命中：单章以短句收尾是合法的利落笔法
  // （如 ch012 `他低下头，继续除草。`），只有连续复现（窗口内占比超阈值）才是惯性。
  // 校准证据（真实通道回放，tmp/ending-ritual-e2e.mts）：168 章命中 20 章，分布
  // 001-040=0/40、041-080=8、081-120=9、121-168=3；命中区间
  // `071-081 / 087-091 / 116-118 / 135-136 / 168` 与人工标记逐一吻合。
  // 晚期命中下降是因那些章已在批次 1-12 手工改写收尾——本身即判据有效性的独立证据。
  // 本判据在一段口癖的**内部**触发，故段落边缘章（048-052/108-112/126-130）不命中，
  // 属窗口判据固有行为。
  // 边界：仅在调用方传入 priorEndings 时生效（跨章语境只有编排方能提供），缺省不触发，
  // 既有调用方与存量测试零影响；warning 级不拦截。
  if (input.priorEndings && input.priorEndings.length) {
    const currentEnding = extractChapterEnding(text);
    const ratio = endingRitualRatio(currentEnding, input.priorEndings);
    if (ratio >= ENDING_RITUAL_POLICY.minRatio) {
      const hits = [...input.priorEndings, currentEnding].filter(hasShortClosingSentence).length;
      warnings.push(issue(
        "warning",
        "章末收束仪式化（近章收尾形态趋同）",
        `含本章在内的近 ${input.priorEndings.length + 1} 章中，有 ${hits} 章的结尾都以一个短促断句收束（末句 ≤ ${ENDING_RITUAL_POLICY.shortSentenceMax} 字，占比 ${Math.round(ratio * 100)}%，阈值 ${Math.round(ENDING_RITUAL_POLICY.minRatio * 100)}%）——收尾形态已被复用；收束方式应由本章实际发生的事件决定（判定/落空/被打断/转向），而不是一律以短促断句收章`,
        "manuscript.ending-ritual",
      ));
    }
  }

  const metrics: ManuscriptStructuralMetrics = {
    characterCount,
    paragraphCount: paragraphs.length,
    medianParagraphCharacters,
    shortParagraphRatio,
    repeatedParagraphCount: longRepeatedParagraphs.length,
    repeatedBlockCount: blocks.length,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({ text, blockers, warnings, metrics })).digest("hex");
  return { passed: blockers.length === 0, fingerprint, blockers, warnings, metrics };
}

export function structuralReviewFromReport(projectId: string, artifact: Artifact, report: ManuscriptStructuralReport, createdAt = Date.now()): Review {
  return normalizeManuscriptStructuralReview({
    id: `structural:${artifact.id}:${report.fingerprint.slice(0, 16)}`,
    projectId,
    artifactId: artifact.id,
    reviewerId: "deterministic-manuscript-inspector",
    identity: "internal",
    role: "structural-validator",
    verdict: report.passed ? "passed" : "blocked",
    issues: [...report.blockers, ...report.warnings],
    artifactFingerprint: artifact.fingerprint,
    createdAt,
  });
}
