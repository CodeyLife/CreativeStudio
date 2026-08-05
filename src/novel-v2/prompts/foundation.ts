import { creativeBriefPrompt, type CreativeBriefSeed } from "../application/creative-brief";
import { foundationRequiredFields } from "../application/foundation-contract";

type FoundationGuidance = {
  dimension: string;
  focus: string[];
  structuredDataHint: string;
  root: string;
};

const TASK_KEY_GUIDANCE: Record<string, FoundationGuidance> = {
  "project-positioning": {
    dimension: "确立作品定位、核心承诺、读者方向和作者边界。",
    focus: ["正式书名与命名依据", "核心叙事承诺", "目标读者与阅读期待", "基调、差异化和核心冲突", "区分已确认决策、推导判断和待确认事项"],
    structuredDataHint: "positioning: {bookTitle, namingRationale, sellingPoints, corePromise, targetReader, tone, differentiation, coreConflict, activePressureSource, themeQuestion, protagonistNeed, centralOpposition, emotionalContract}",
    root: "positioning",
  },
  architecture: {
    dimension: "设计全书层级、长期承诺和阶段边界，为故事弧与章节蓝图提供方向，而不是把未来正文压缩成固定目录。",
    focus: [
      "整体叙事结构及选择理由：说明全书、卷、故事弧、章节和场景各自负责什么",
      "全书承诺与终局边界：读者期待被回应的核心问题、情感方向、必须解决的矛盾、允许保留的开放性和多种抵达方式",
      "卷级职责与状态边界：每个阶段的入口状态、主要压力、关键选择、代价、退出状态和承诺回收窗口",
      "线索层级：主线、支线、人物线、关系线和世界压力如何耦合、交汇、退出或转化；暂缓的线记录下一次推进责任",
      "视角策略和知识边界：叙述距离、视角切换规则、不同人物可知与不可知的信息范围",
      "时间跨度与长期收束：记录故事时间、叙事顺序和状态证据，不以章节数量或固定密度代替结构",
      "保留后续调整空间，不生成固定章节表；章节数量只能作为资源估计，不是质量目标",
    ],
    structuredDataHint: "architecture: {structure, volumes: [{name, theme, function, entryState, exitState, pressures, promiseWindows, chapterCount?}], povStrategy, timeSpan, longHorizonBoundaries, endingEnvelope?, lineHierarchy?, uncertainty?}",
    root: "architecture",
  },
  characters: {
    dimension: "设计主要人物、动机、声部、知识边界、关系压力和变化可能。",
    focus: ["主要人物的外部欲望、内部需要、恐惧/限制、核心矛盾和弧线方向", "人物惯用但会失败的策略，以及会如何在选择中承担代价", "人物声部与表达差异：句长、词汇、直接度、回避方式和注意力", "人物独立行动、知识边界、价值与关系压力", "关系网络中每个人的互惠、冲突、误解、边界和不可被主角随意调用的选择"],
    structuredDataHint: "characters: [{id, name, role, motivation, fear, voiceAnchor, arc, independentAction: {desire, choice, cost, knowledgeBoundary}, relations}]",
    root: "characters",
  },
  worldview: {
    dimension: "构建世界事实、规则、代价、边界和社会质地。",
    focus: ["地理、制度、势力与生活环境如何改变行动成本和人物选择", "可预测的规则、限制、例外来源与违规后果", "规则的代价与边界，谁承担代价以及制度如何反应", "文化、语言、行业、信仰和历史记忆的具体来源", "外部威胁与内部矛盾", "哪些内容是冻结事实，哪些仍待故事中发现"],
    structuredDataHint: "worldview: {geography, politics, factions, rules, threats, socialTexture}",
    root: "worldview",
  },
  "plot-design": {
    dimension: "形成可长期校准的主线、支线、信息释放和终局战略。",
    focus: ["叙事承诺的长期回应：读者问题、建立证据、回收窗口、意义变化和代价", "主线、支线、关系线与世界压力的因果方向、交汇/退出/转化条件", "人物终点区间、独立欲望和不可接受的捷径", "区分隐藏信息、尚未设计的信息和开放问题；记录不可提前消费的边界", "必须解决、允许开放和可多路径抵达的终局条件", "每项战略决策如何改变人物选择或读者理解"],
    structuredDataHint: "plotStrategy: {narrativePromises, longHorizonThreads, characterDestinations, informationBoundaries, endingEnvelope, nonNegotiables}",
    root: "plotStrategy",
  },
};

export function buildFoundationPrompt(input: {
  taskKey: string;
  instruction: string;
  projectTitle: string;
  premise?: string;
  genre?: string;
  objective?: string;
  priorArtifacts: Array<{ taskKey: string; title: string; summary: string }>;
  creativeBrief?: CreativeBriefSeed;
}): string {
  const guidance = TASK_KEY_GUIDANCE[input.taskKey];
  const requiredFields = foundationRequiredFields(input.taskKey);
  const lines = [
    "你是长篇小说全书规划师。",
    "当前规划阶段只负责全书层面的方向和可验证边界，不把未来章节压缩成固定任务清单。",
    "只输出符合 foundationSchema 的 JSON，不输出 Markdown、解释文字或指令回显。",
    "",
    "## 当前阶段：" + (guidance ? input.taskKey : "通用规划"),
    guidance ? "职责：" + guidance.dimension : "依据项目上下文形成可审计的规划产出。",
    guidance ? "关注：" + guidance.focus.join("；") : "",
    guidance ? "结构化数据参考：" + guidance.structuredDataHint : "",
    requiredFields.length ? "当前阶段的必要信息：" + requiredFields.join("、") : "",
    "",
    "## 项目上下文",
    "项目：" + input.projectTitle,
    input.genre ? "题材：" + input.genre : "",
    input.premise ? "前提：" + input.premise : "",
    input.objective ? "目标：" + input.objective : "",
    "当前指令：" + input.instruction,
    "",
    "## 创作简报",
    creativeBriefPrompt(input.creativeBrief),
    "简报是作者意图输入；不确定的内容必须标记为待确认，不得伪装成冻结事实。",
  ].filter(Boolean);

  if (input.priorArtifacts.length) {
    lines.push("", "## 已有规划上下文");
    for (const prior of input.priorArtifacts) lines.push("[" + prior.taskKey + "] " + prior.title + "：", prior.summary);
  }
  lines.push(
    "",
    "## 输出边界",
    "title、summary、sections 和 structuredData 必须相互一致；structuredData 必须是可解析为 JSON 对象的字符串，根键使用当前 taskKey 对应的结构化数据容器。sections[].items 没有条目时返回空数组。",
    guidance ? "structuredData 的主要容器为 " + guidance.root + "，不得把未确认内容写成确定事实。" : "",
    "对主要决策尽量显式记录‘欲望/压力 → 选择 → 代价 → 可观察状态变化 → 新问题或承诺’；没有自然变化时说明其体验功能。",
    "区分已确认事实、基于事实的推导方案和待作者确认项；不以章节数、钩子密度、爽点密度或感情线数量掩盖因果、人物或世界压力缺口。",
    "不为满足数量、篇幅或形式而填充空洞内容；不生成逐章章节表。",
  );
  return lines.filter(Boolean).join("\n");
}

export const FOUNDATION_SYSTEM_PROMPT =
  "你是长篇小说全书规划师。依据当前阶段和项目上下文生成结构化规划。" +
  "只输出严格符合 foundationSchema 的 JSON，保持前后规划连贯，并区分冻结事实、推导判断和待确认内容。";
