/**
 * SK-2 路线二（product-audit-20260910 C1 "promote 产出待审 patch"）：
 * workspace yaml 是 seed 真源、skill_definitions 是运行真源，学习闭环晋升只落 DB——
 * 晋升内容回写 yaml 此前依赖裁决者手工操作（f48c8df7 实证）。本模块把回写机械化：
 * 从晋升后的 descriptor 快照渲染**完整目标 yaml 文档**（待审 patch 工件），编排方
 * 审阅后显式应用（写盘）。刻意不做自动写盘：部署进程不应持有工作区写权，且"待审"
 * 是审计对该路线的原文定义（保留人的收口点）。
 *
 * 泛化边界：对任意 workspace skill 生效（按 descriptor 字段渲染），不含任何 skill
 * 专属分支；多 skill 同批晋升的次序性由调用方（逐 receipt 应用）保证——后应用者
 * 以当时的盘上文本为基线合并，段级互不干扰（DB 快照是累积真源，每次晋升快照都含
 * 全部前序内容）。
 */
import { parseDocument } from "yaml";
import type { SkillDescriptor } from "../protocol";

/** 生成注释的确定性文本段（幂等判据；裁决者手写的其他注释原样保留不触碰）。 */
export interface SkillYamlPatchProvenance {
  skillId: string;
  version: string;
  candidateId: string;
  receiptId: string;
  authorId: string;
}

export interface SkillYamlPatch {
  /** 应用后的完整 yaml 文档（含溯源注释头）。 */
  patchedYaml: string;
  /** patch 相对当前盘上文本是否引入变化（版本与内容全等则 false → 无需回写）。 */
  changed: boolean;
  /** 渲染进文档的 descriptor 字段键（审计面）。 */
  fields: string[];
}

function provenanceComment(p: SkillYamlPatchProvenance): string {
  return `# promoted:${p.skillId}@${p.version} candidate=${p.candidateId} receipt=${p.receiptId} author=${p.authorId}`;
}

/**
 * 渲染晋升后的目标 yaml。descriptor 必须是晋升后（新 sections+新 version）的快照
 * （调用方从 skill_definitions 行 mapSkillRow → normalizeSkillDescriptor 取）。
 * 手写非命名顶层字段保留（如项目私有扩展键）；命名核心字段以晋升快照为准。
 * Document AST 原位 set（审核 N3 修正）：只重写命中的顶层键节点，未触碰部分的裁决
 * 者手写注释与排版原样保留；被替换键自身的块内注释随旧节点消失（值以快照为准，
 * 注释不得为陈旧描述辩护）。同输入同输出（含固定溯源注释）⇒ 不动点成立：seed 文本
 * 已等于晋升快照时 changed=false（already-in-seed 分支因此可达）。
 */
export function renderPromotedSkillYaml(currentYamlText: string, descriptor: SkillDescriptor, provenance: SkillYamlPatchProvenance): SkillYamlPatch {
  const known: Record<string, unknown> = {
    skillId: descriptor.skillId,
    version: descriptor.version,
    executionPoints: descriptor.executionPoints,
    capabilities: descriptor.capabilities,
    applicableTasks: descriptor.applicableTasks,
    roles: descriptor.roles,
    dependsOn: descriptor.dependsOn,
    conflicts: descriptor.conflicts,
    requiredMemoryKinds: descriptor.requiredMemoryKinds,
    qualityGates: descriptor.qualityGates,
    priority: descriptor.priority,
    applicableGenres: descriptor.applicableGenres?.length ? descriptor.applicableGenres : undefined,
    enabled: descriptor.enabled === false ? false : undefined,
    promptSections: descriptor.promptSections,
  };
  const doc = parseDocument(currentYamlText || "{}");
  for (const [key, value] of Object.entries(known)) {
    if (value === undefined) continue;
    doc.set(key, value);
  }
  let body = doc.toString({ lineWidth: 0 }).replace(/\n+$/u, "\n");
  // 溯源注释：剥离既有 promoted 注释行后在首个非注释行前插入新行（幂等：同输入同输出）。
  const comment = provenanceComment(provenance);
  const lines = body.split("\n");
  const stripped = lines.filter((line) => !/^# promoted:\S+@\S+ candidate=\S+ receipt=\S+ author=\S+$/u.test(line));
  const firstContent = stripped.findIndex((line) => line.trim() !== "");
  const insertAt = firstContent < 0 ? stripped.length : firstContent;
  body = [...stripped.slice(0, insertAt), comment, ...stripped.slice(insertAt)].join("\n");
  const changed = body !== currentYamlText;
  return { patchedYaml: body, changed, fields: Object.keys(known).filter((k) => known[k] !== undefined) };
}
