import { canonicalJson, canonicalSha256 } from "../canonical-json";
import type { FactExtractionOutput } from "../prompts/schemas";

type Fact = FactExtractionOutput["facts"][number];

export function normalizeFactToken(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const PRESET_PREDICATE_ALIASES: ReadonlyArray<readonly [canonical: string, aliases: ReadonlySet<string>]> = [
  ["持有", new Set(["持有", "拥有", "携带", "保管", "握有", "持有物品", "拥有物品", "发现并持有", "识海中拥有"])],
  ["位于", new Set(["位于", "身处", "所在地为", "抵达地点"])],
  // character-knows 是 character-enrichment 管道写入知识边界声明的固定谓词；纳入"知晓"
  // 别名集使两条提取管道对同一"谁知道什么"事实落入同一身份槽位（identityHash 一致），
  // 检索层 value 合并键与同槽位聚簇统计才能跨管道对账。这是跨管道对账契约，不是题材规则。
  ["知晓", new Set(["知道", "知晓", "得知", "获知", "意识到", "character-knows"])],
  ["隶属", new Set(["隶属", "隶属于", "属于", "所属组织"])],
  ["给予", new Set(["给予", "赠予", "交付", "给予物品"])],
  ["状态变化", new Set(["状态变化", "出现反应", "产生反应", "发生异动"])],
];

/** Normalize common relation wording while preserving project-specific predicates. */
export function canonicalizeFactPredicate(value: string): string {
  const normalized = normalizeFactToken(value);
  for (const [canonical, aliases] of PRESET_PREDICATE_ALIASES) {
    if (aliases.has(normalized)) return canonical;
  }
  return normalized;
}

/**
 * 单值状态谓词：同一身份槽位的多个取值是**同一状态维度的不同时点取值**，
 * 检索时只应让最新取值代表"当前状态"。
 *
 * 设计依据（state-audit-20261013 §3，运行库实证）：同一身份槽位（主体+谓词+知识域）下，
 * 替换型状态的旧值会与当前值并存为 active 断言。实测典型形态：某主体的"持有"槽下并存着
 * 上百条逐章库存快照（不同章各记一次身上有什么），"位于"槽下并存着多处位置快照，
 * "状态变化"槽下并存着数百条角色处境快照。三者都是**同一状态维度的取值序列**，
 * 而非并列成立的多个事实。具体条数与逐条样本见该节取证。
 *
 * 与累积型谓词的区别是**语义而非结构**：两类谓词的身份槽形状完全相同（主体+谓词固定、
 * 取值变化），"知晓"的多个取值可以同时为真（知道 A 与知道 B 并存），"持有"的多个取值互斥。
 * 因此该分类必须由谓词语义给出，不能从槽位基数或结构推出。
 *
 * 边界（刻意不覆盖）：
 * - 只认 PRESET_PREDICATE_ALIASES 的规范谓词（经 canonicalizeFactPredicate 归一，故
 *   "拥有"/"身处"/"出现反应" 等别名同样命中）。项目自定谓词（身份/状态/使用策略/约定…）
 *   是开放词表，用固定清单去枚举它们等于把个案固化成规则；未归类即保持既有排序行为。
 * - 不读 content 做语义判断，不引入模糊匹配——谓词是提取层给出的结构化契约。
 * - "给予"刻意排除：实测其取值是**离散历史事件**（哪一章交付了什么），彼此可同时为真，
 *   属累积型而非同一维度的时点序列。
 * - "隶属"刻意排除：运行库无 active 取值，且"能否同时隶属多个组织"是项目层设定，
 *   证据不足时不替项目裁决。
 */
const STATE_LIKE_PREDICATES: ReadonlySet<string> = new Set(["持有", "位于", "状态变化"]);

/** 该谓词是否为单值状态维度（"当前值"语义）。未归类或缺失一律返回 false。 */
export function isStateLikePredicate(predicate: string | undefined): boolean {
  if (!predicate) return false;
  return STATE_LIKE_PREDICATES.has(canonicalizeFactPredicate(predicate));
}

function normalizeFactValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeFactToken(value);
  if (Array.isArray(value)) return value.map(normalizeFactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeFactValue(item)]));
  }
  return value;
}

/**
 * 身份/取值指纹的最小输入形状。
 *
 * 设计依据：memory-governance-audit-20260909 §5.1.2——character-enrichment 管道此前
 * 只有字符串 contentHash、无 identityHash，与 fact-extraction 的结构化哈希体系不兼容，
 * 导致同章双管道重复无法在任何层对账。放宽参数类型让两条管道复用同一指纹函数，
 * 这是"统一事实指纹契约"的最低共享层实现；不改 fact-extraction 存量行的哈希算法，
 * 同一管道内新旧行 identityHash 保持可比。
 */
type FactIdentitySource = Pick<Fact, "subject" | "predicate">;
type FactValueSource = FactIdentitySource & Pick<Fact, "object" | "polarity" | "truthStatus">;

/**
 * 主体 kind 归一：`character` 与 `entity` 在指纹层等价。
 *
 * 设计依据（state-audit-20261013 §3.6）：`character` 是为"名册外人物登记"新增的判别位，
 * 让提取侧能区分人物与地点/物件，从而只把人物登记为待补全实体。但它若进入身份指纹，
 * 同一人物会因 kind 写法不同（旧数据 `entity`、新数据 `character`）被拆成两个槽——
 * 正是本次要消除的碎片化。故指纹层把 `character` 折叠回 `entity`：判别位只服务于登记
 * 决策，不参与身份哈希。其余 kind 原样保留（各有自己的键空间）。
 */
function normalizeSubjectKind(kind: string): string {
  return kind === "character" ? "entity" : kind;
}

export function factIdentityPayload(fact: FactIdentitySource): Record<string, unknown> {
  return {
    subject: { kind: normalizeSubjectKind(fact.subject.kind), id: normalizeFactToken(fact.subject.id) },
    predicate: canonicalizeFactPredicate(fact.predicate),
    knowledgeScope: "author",
  };
}

export function factValuePayload(fact: FactValueSource): Record<string, unknown> {
  return {
    ...factIdentityPayload(fact),
    object: { kind: fact.object.kind, value: normalizeFactValue(fact.object.value) },
    polarity: fact.polarity,
    truthStatus: fact.truthStatus,
  };
}

export function factIdentityHash(fact: FactIdentitySource): string {
  return canonicalSha256(factIdentityPayload(fact));
}

export function factValueHash(fact: FactValueSource): string {
  return canonicalSha256(factValuePayload(fact));
}

export function factCanonicalValue(fact: FactValueSource): string {
  return canonicalJson(factValuePayload(fact));
}
