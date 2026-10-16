import type { FactExtractionOutput } from "../prompts/schemas";
import type { MemoryClaim, MemoryKind, MemoryAuthority } from "../protocol";
import { canonicalizeFactPredicate, factIdentityHash, factValueHash, normalizeFactToken } from "./fingerprint";

/**
 * V2 事实风险分类与 MemoryClaim 投影。
 *
 * 与 v1 [facts.ts] 的 classifyFactRisk 等价，但投影到 v2 的 MemoryClaim 结构
 * （而非 v1 FactAssertion/KnowledgeAssertion 双表）。
 *
 * 风险分类规则（与 v1 一致）：
 * - conflict=true → high risk（事实与现有资料冲突）
 * - truthStatus !== objective → high risk（声明、争议或开放谜题必须人工确认）
 * - novelty=update → medium risk（更新既有事实，需审核影响范围）
 * - novelty=duplicate → low risk（重复，仅记录）
 * - 其他 → low risk
 *
 * P0-A1 修复（2026-07-27）：supersedes 字段在 novelty=update 时填充被覆盖的旧 claim id。
 *   由 classifyFactCandidates 接收 existingClaimsDigest 解析出的 supersededIds 映射，
 *   按 subject.id + predicate 匹配旧 claim id，让 retrieval 层能屏蔽被覆盖的旧版本。
 *   设计依据：AGENTS.md「root-cause analysis」——supersedes 是长程一致性的核心契约，
 *   旧 claim 必须被屏蔽，否则 LLM 会看到自相矛盾的事实。
 *
 * P0-A3 修复（2026-07-27）：narrativeRange 不再用 fact.paragraph（段落号）填充，
 *   改为 undefined（由 recordFactExtraction 用 artifact 的 narrativeOrder 填充）。
 *   设计依据：narrativeRange 语义是章节序号（与 manuscript_documents.narrative_order 对齐），
 *   而非段落号；用段落号会导致第10段事实被当作"第10章"参与 narrativeCutoff 过滤，
 *   在第5章生成时本章事实被错误屏蔽。
 */

export type FactRisk = "low" | "medium" | "high";

export interface ClassifiedFact {
  readonly claim: MemoryClaim;
  readonly risk: FactRisk;
  readonly riskReason: string;
  /** 确定性矛盾核验命中时的审计信息：同槽位的冻结声明 id 列表（迭代 2）。 */
  readonly factContradiction?: { frozenClaimIds: string[] };
}

export interface ClassifyFactCandidatesInput {
  facts: FactExtractionOutput["facts"];
  projectId: string;
  artifactId: string;
  baseRevision: number;
  /**
   * P0-A1: 按 `${subject.id}|${predicate}` 映射到旧 claim id 列表。
   * 由上游从 existingClaimsDigest 构建，用于 novelty=update 时填充 supersedes。
   * 若未提供，supersedes 始终为空数组（与旧行为一致，但不满足长程一致性契约）。
   */
  existingClaimIndex?: Map<string, string[]>;
  /**
   * 确定性矛盾核验的取值指纹索引（improvement-plan-fact-injection-20260922 迭代 2）：
   * 冻结 claim id → value_hash。与 existingClaimIndex 同源（getFactExtractionContext）。
   * 缺省时不做异值判定（无法区分同值重复与异值矛盾，保持沉默由审批通道兜底）。
   */
  existingValueHashById?: Map<string, string | undefined>;
}

const CONTINUITY_PREDICATE_PATTERN = /身份|姓名|年龄|生死|死亡|存活|状态|位置|所在地|持有|拥有|失去|获得|知道|得知|隐瞒|关系|亲属|敌友|承诺|约定|时间|日期|先后|能力|限制|伤势|阵营|职位|修为/u;

/**
 * 值槽谓词（单一当前值的排他性状态槽）：更新语义 = 旧值被取代，允许整槽清扫
 * supersedes。事件累积型谓词（状态变化/知晓/承诺/给予…）在同一主体+谓词槽位里
 * 每行记录的是**不同事件**，单条 update 无权退役整槽——product-audit-20260910
 * A1/FM-1 的直接根因之一：ch21「旁路当前状态」候选仅与 ch19「缴清灵石欠项」同落
 * `char|状态变化` 槽就把后者整体退役，资产账本凭空断线。
 * 分类基于叙事功能（状态槽 vs 事件账）而非题材词表；边界：关系类（师徒/敌对）由
 * relations 表承载不在此列；未列入的谓词一律按事件累积处理（安全偏置——宁可少退役，
 * 由事实梳理/审批通道兜底），需要扩展时在此处按同一"单当前值"判据评估。
 *
 * 命名边界（与 `fingerprint.ts` 的 `isStateSnapshotPredicate` 区分）：两者都涉及"单值槽"，
 * 但判据与消费方不同——本函数答"更新能否整槽清扫 supersedes"（成员 13，宽，且**不含**
 * `状态变化`：它是事件账）；`isStateSnapshotPredicate` 答"多个取值是否属同一维度的逐时点
 * 快照"（成员 3，窄，消费方是检索排序）。名字须各自说出判据，故不用近似的 `is*Slot*` /
 * `is*State*` 泛称（2026-10-16 复核轮按此改名）。
 */
const EXCLUSIVE_VALUE_SLOT_PREDICATES = new Set([
  "持有",
  "位于",
  "隶属",
  "所属组织",
  "修为",
  "境界",
  "身份",
  "职位",
  "阵营",
  "年龄",
  "所在地",
  "所在地为",
  "生死",
]);

export function isExclusiveValueSlotPredicate(predicate: string): boolean {
  return EXCLUSIVE_VALUE_SLOT_PREDICATES.has(canonicalizeFactPredicate(predicate));
}

/** Facts that can alter later causal/state decisions need stronger evidence. */
export function isContinuitySensitiveFact(fact: FactExtractionOutput["facts"][number]): boolean {
  return fact.subject.kind === "relation"
    || fact.subject.kind === "timeline"
    || fact.subject.kind === "thread"
    || fact.subject.kind === "foreshadowing"
    || CONTINUITY_PREDICATE_PATTERN.test(fact.predicate);
}

/**
 * 把 LLM 提取的事实投影为 MemoryClaim + 风险等级。
 */
export function classifyFactRisk(params: {
  fact: FactExtractionOutput["facts"][number];
  projectId: string;
  artifactId: string;
  baseRevision: number;
  existingClaimIndex?: Map<string, string[]>;
  existingValueHashById?: Map<string, string | undefined>;
}): ClassifiedFact {
  const { fact, projectId } = params;

  // P0-A1: novelty=update 时按 subject.id+predicate 查 existingClaimIndex 填充 supersedes。
  // FM-1 收紧（product-audit-20260910 A1）：仅值槽谓词（单一当前值）允许整槽退役；
  // 事件累积型谓词的多行同属不同事件，单条 update 不得清扫整槽，否则会把未提及的
  // 既有派生事实连带逐出检索面（实测资产账本断线根因）。
  let supersedes: string[] = [];
  if (fact.novelty === "update" && params.existingClaimIndex && isExclusiveValueSlotPredicate(fact.predicate)) {
    const key = `${normalizeFactToken(fact.subject.id)}|${canonicalizeFactPredicate(fact.predicate)}`;
    supersedes = params.existingClaimIndex.get(key) ?? [];
  }

  const identityHash = factIdentityHash(fact);
  const valueHash = factValueHash(fact);

  // 确定性矛盾核验（improvement-plan-fact-injection-20260922 迭代 2，零模型调用）。
  //
  // 根因：supersedes 只在 LLM 声明 novelty=update 且谓词属值槽时填充——LLM 把
  // "改写冻结事实"误声明为 novelty=new 时（020 账册日期 / 021 交易条款 / 024
  // 玉牌归属的漏网通道），同槽异值矛盾会以低风险 derived 静默入库并进入检索面。
  //
  // 判定（与 FM-1 同一语义边界，只覆盖值槽谓词；事件累积型谓词同槽多值合法，
  // 交由 asset-ledger 对照与三审，此处刻意不覆盖）：
  //   同 `subject|predicate` 键命中冻结表 + 值槽谓词 + 新取值指纹与全部已知冻结
  //   取值不同 + 未携带合法 supersedes → fact-contradiction：强制 high risk +
  //   authority=candidate，复用既有"冲突须人工裁决"晋升门（candidate 不进检索面，
  //   见 memory-visibility.ts VISIBLE_CLAIM_AUTHORITIES）。
  //   同值（指纹相同）→ 归去重不报；冻结取值未知（其他管道写入）→ 保持沉默
  //   （宁可少报，与 classify 的"安全偏置"同向）。
  let factContradiction = false;
  let contradictionFrozenIds: string[] = [];
  if (!fact.conflict && fact.truthStatus === "objective" && fact.polarity === "affirmed" && !supersedes.length && params.existingClaimIndex && params.existingValueHashById && isExclusiveValueSlotPredicate(fact.predicate)) {
    const key = `${normalizeFactToken(fact.subject.id)}|${canonicalizeFactPredicate(fact.predicate)}`;
    const frozenIds = params.existingClaimIndex.get(key) ?? [];
    const knownFrozenHashes = frozenIds
      .map((id) => params.existingValueHashById?.get(id))
      .filter((hash): hash is string => typeof hash === "string");
    if (frozenIds.length > 0 && knownFrozenHashes.length > 0 && !knownFrozenHashes.includes(valueHash)) {
      factContradiction = true;
      contradictionFrozenIds = frozenIds;
    }
  }

  let risk: FactRisk = "low";
  let riskReason = "新增客观事实，自动入库";

  if (fact.conflict) {
    risk = "high";
    riskReason = "事实与现有资料冲突，必须人工确认";
  } else if (fact.truthStatus !== "objective") {
    risk = "high";
    riskReason = `${fact.truthStatus} 陈述必须人工确认`;
  } else if (fact.novelty === "update") {
    risk = "medium";
    riskReason = "更新既有事实，需审核影响范围";
  } else if (factContradiction) {
    risk = "high";
    riskReason = "确定性矛盾核验：与冻结事实同槽异值且未声明覆盖（supersedes），须人工裁决后方可晋升";
  } else if (fact.confidence < 0.75 && isContinuitySensitiveFact(fact)) {
    risk = "medium";
    riskReason = "低置信连续性事实可能改变角色、关系、时间线或承诺状态，需人工确认";
  } else if (fact.novelty === "duplicate") {
    risk = "low";
    riskReason = "重复事实，仅记录";
  }

  // kind 推断：承诺/约定/誓言/伏笔/线索 → hierarchical；其他 → episodic
  const hierarchicalPattern = /承诺|约定|誓言|伏笔|线索|秘密|谜题|预言|禁忌/u;
  const kind: MemoryKind = hierarchicalPattern.test(fact.humanReadable) || hierarchicalPattern.test(fact.predicate)
    ? "hierarchical"
    : "episodic";

  // Only low-risk objective facts may enter retrieval automatically. Updates,
  // conflicts and non-objective statements remain candidates until an explicit
  // fact-approval path promotes them.
  const authority: MemoryAuthority = risk === "low" && fact.truthStatus === "objective" && fact.polarity === "affirmed"
    ? "derived"
    : "candidate";

  const claim: MemoryClaim = {
    id: `claim:${projectId}:${valueHash.slice(0, 24)}`,
    projectId,
    kind,
    title: fact.humanReadable.slice(0, 32),
    content: fact.humanReadable,
    subjectRefs: [fact.subject.id],
    // P0-A3: narrativeRange 不再用段落号；由 recordFactExtraction 用 narrativeOrder 填充
    narrativeRange: undefined,
    knowledgeScope: "author",
    authority,
    confidence: fact.confidence,
    sourceRevisionIds: [],
    contentHash: valueHash,
    supersedes,
    predicate: fact.predicate,
    identityHash,
    valueHash,
  };

  return { claim, risk, riskReason, ...(factContradiction ? { factContradiction: { frozenClaimIds: contradictionFrozenIds } } : {}) };
}

/**
 * 批量分类：把 LLM 输出转换为 MemoryClaim 列表。
 *
 * 返回 (claim, risk) 元组列表——上游 recordFactExtraction 根据 risk 决定写入路径：
 * - low: 直接写入 memory_claims（authority=derived）
 * - medium: 写入 memory_claims 但 authority=candidate（需人工审核）
 * - high: 写入 memory_claims 且标记 conflict=true（需人工审核）
 */
export function classifyFactCandidates(params: ClassifyFactCandidatesInput): ClassifiedFact[] {
  return params.facts.map((fact) => classifyFactRisk({
    fact,
    projectId: params.projectId,
    artifactId: params.artifactId,
    baseRevision: params.baseRevision,
    existingClaimIndex: params.existingClaimIndex,
    existingValueHashById: params.existingValueHashById,
  }));
}
