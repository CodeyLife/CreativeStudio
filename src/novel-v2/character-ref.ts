/**
 * 人物引用归一（2026-09-16 全书审核 P4 的最低共享层）。
 *
 * 根因：同一人物的引用形态在各数据面长期并存——蓝图 povCharacterId 是模型幻觉出的
 * 四变体（char_chu_heng/char_chu/chu-heng/char_hu_cheng），memory_claims.knowledge_scope
 * 存短 id 或显示名，chapter_memories.character_states 存显示名，relations.subject_id 存
 * 完整实体 URI，qdrant payload 存短 id。任何"字符串相等"的跨面匹配都会静默漏配——
 * POV 作用域召回与状态钉挂因此在漂移章节上饿死，且无报错（上下文层供给断裂比错供更难发现）。
 *
 * 本模块只做**登记表内可判定**的归一：精确 URI/短 id/显示名 → 唯一 token 包含 →
 * 唯一编辑距离 ≤2（打字漂移）。歧义与无命中返回 undefined——宁缺毋伪，不发明人物。
 * 消费方拿 CharacterRefForms 按面选形态，禁止再写字面相等跨面匹配。
 */

export interface CharacterRefForms {
  /** 实体表主键形态（entity:<project>:character:<shortId>） */
  uri: string;
  /** URI 末段短 id（claims/qdrant 消费形态） */
  shortId: string;
  /** 显示名（正文与状态快照消费形态） */
  name: string;
}

interface IndexedRef extends CharacterRefForms {
  tokens: Set<string>;
}

/** 泛用 token：实体 id 的结构前缀，不参与包含判定。 */
const GENERIC_TOKENS = new Set(["char", "character", "entity", "persona", "cast"]);

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/u)
      .filter((token) => token.length > 0 && token !== "character" && token !== "entity"),
  );
}

/** 有界编辑距离：只关心 ≤max，超过按 max+1 返回（省全矩阵早停）。 */
function editDistanceWithin(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      rowMin = Math.min(rowMin, current[j]!);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[right.length]!;
}

function shortOfUri(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1);
}

export function buildCharacterRefIndex(records: Array<{ id: string; name: string }>): {
  /** 把任意引用形态解析为登记表的规范三形态；歧义/无登记返回 undefined。 */
  resolve(value: string | null | undefined): CharacterRefForms | undefined;
  /** 登记表快照（迁移与投影复用）。 */
  forms(): CharacterRefForms[];
} {
  const indexed: IndexedRef[] = records.map((record) => ({
    uri: record.id,
    shortId: shortOfUri(record.id),
    name: record.name,
    tokens: tokenize(shortOfUri(record.id)),
  }));
  const unique = (candidates: IndexedRef[]): CharacterRefForms | undefined => {
    const distinct = new Set(candidates.map((candidate) => candidate.uri));
    return distinct.size === 1 ? candidates[0] : undefined;
  };
  return {
    forms: () => indexed.map(({ tokens: _tokens, ...rest }) => rest),
    resolve(value) {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw) return undefined;
      // ① 精确：URI、短 id、显示名。
      const exact = indexed.find((item) => item.uri === raw || item.shortId === raw);
      if (exact) return exact;
      const byName = unique(indexed.filter((item) => item.name === raw));
      if (byName) return byName;
      // ② token 包含：漂移值是登记短 id 的 token 子集（char_chu ⊆ char_chu_heng、
      // chu-heng ⊆ char_chu_heng），要求唯一命中。
      const valueTokens = tokenize(raw);
      for (const token of GENERIC_TOKENS) valueTokens.delete(token);
      if (valueTokens.size) {
        const contained = indexed.filter((item) => {
          const candidate = new Set(item.tokens);
          for (const token of GENERIC_TOKENS) candidate.delete(token);
          for (const token of valueTokens) if (!candidate.has(token)) return false;
          return true;
        });
        const hit = unique(contained);
        if (hit) return hit;
        // 包含面歧义（多个人物共享 token 前缀）→ 不做编辑距离猜测，直接放弃。
        if (contained.length > 1) return undefined;
      }
      // ③ 打字漂移：与短 id 的编辑距离 ≤2 且唯一（char_hu_cheng→char_chu_heng）。
      const normalized = raw.toLowerCase();
      const typo = indexed.filter((item) => editDistanceWithin(normalized, item.shortId.toLowerCase(), 2) <= 2 && normalized !== item.shortId.toLowerCase());
      return unique(typo);
    },
  };
}
