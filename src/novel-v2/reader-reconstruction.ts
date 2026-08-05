import type { ReaderReconstructionEvidence, ReviewIssue } from "./protocol";

export const READER_RECONSTRUCTION_MISSING_EVIDENCE = [
  "body",
  "space",
  "object",
  "action",
  "consequence",
  "relationship",
] as const;

export const READER_RECONSTRUCTION_CONTRACT = [
  "表达可以有风格，现场信息不能缺失。普通读者不必立即理解每个陌生词，但应能从上下文复原人物正在经历什么、为何行动以及行动造成的结果。",
  "重要变化只需提供当前叙事功能所需的现场证据，不要求每段同时加入身体、空间、物件和感官；安静、抒情、回忆和余波段落也不因抽象而自动失败。",
  "技术、制度或理论化认知可以保留，但只有在改变即时选择、表达角色独有认知或承担不可替代的世界观功能时，才让它承担正文信息。否则应通过自然中文的动作、感受、空间关系、对白或结果呈现。",
  "技术认知是人物对已经发生之事的理解方式，不是新的动作、原因或结果；它不能成为当前行动的唯一主语、唯一动因或唯一后果。身体危机和动作场景先让必要的身体或物理反应成立，技术判断只能作为随后的一次认知，并且必须改变下一步选择或提供不可替代的信息。",
  "同一局部节拍中，如果多条技术标签只是重复命名同一痛感、恐惧、意志或动作，删去多余标签；如果删掉技术句后事实、选择和因果都不变，就不要把它留在正文。修订时补现场证据，不用另一组术语替换原术语。",
  ].join("\n");

export function normalizeReaderReconstruction(value: unknown): ReaderReconstructionEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const impact = item.impact === "core" || item.impact === "local" ? item.impact : undefined;
  const missingEvidence = Array.isArray(item.missingEvidence)
    ? item.missingEvidence.filter((entry): entry is ReaderReconstructionEvidence["missingEvidence"][number] =>
      typeof entry === "string" && (READER_RECONSTRUCTION_MISSING_EVIDENCE as readonly string[]).includes(entry),
    )
    : [];
  const blockedQuestion = typeof item.blockedQuestion === "string" ? item.blockedQuestion.trim() : "";
  if (!impact || !missingEvidence.length || !blockedQuestion) return null;
  return { impact, missingEvidence: [...new Set(missingEvidence)], blockedQuestion };
}

export function mergeReaderReconstructionEvidence(
  current: ReaderReconstructionEvidence | null | undefined,
  incoming: ReaderReconstructionEvidence | null | undefined,
): ReaderReconstructionEvidence | null {
  if (!current) return incoming ?? null;
  if (!incoming) return current;
  const impact = current.impact === "core" || incoming.impact === "core" ? "core" : "local";
  const blockedQuestion = current.impact === "core"
    ? current.blockedQuestion
    : incoming.impact === "core"
      ? incoming.blockedQuestion
      : current.blockedQuestion;
  return {
    impact,
    missingEvidence: [...new Set([...current.missingEvidence, ...incoming.missingEvidence])],
    blockedQuestion,
  };
}

export function normalizeReviewIssueReaderEvidence<T extends Pick<ReviewIssue, "severity"> & { readerReconstruction?: unknown }>(issue: T): T & { severity: ReviewIssue["severity"]; readerReconstruction: ReaderReconstructionEvidence | null } {
  const readerReconstruction = normalizeReaderReconstruction(issue.readerReconstruction);
  const severity = readerReconstruction?.impact === "core" && issue.severity === "warning" ? "major" : issue.severity;
  return { ...issue, severity, readerReconstruction };
}
