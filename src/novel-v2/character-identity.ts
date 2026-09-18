export type CharacterIdentityStatus = "identified" | "pending";

export interface FoundationCharacter extends Record<string, unknown> {
  id?: unknown;
  name?: unknown;
}

export interface CharacterIdentityEntity {
  id: string;
  name: string;
  payload?: Record<string, unknown> | null;
}

export interface CharacterIdentity {
  entityId: string;
  canonicalId: string;
  displayName: string;
  status: CharacterIdentityStatus;
  sourceId: string;
}

export type CharacterIdentityIndex = Map<string, CharacterIdentity>;

const UNNAMED_CHARACTER = "未命名角色";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function entityIdFor(projectId: string, canonicalId: string): string {
  return `entity:${projectId}:character:${canonicalId}`;
}

function canonicalIdFromEntityId(projectId: string, entityId: string): string | undefined {
  const prefix = `entity:${projectId}:character:`;
  return entityId.startsWith(prefix) ? entityId.slice(prefix.length) || undefined : undefined;
}

function looksLikeStableIdentifier(value: string): boolean {
  return /^(?:[a-z][a-z0-9]*[-_])+[a-z0-9]+$/u.test(value) || value.startsWith("entity:");
}

function addAlias(index: CharacterIdentityIndex, alias: string | undefined, identity: CharacterIdentity): void {
  if (alias) index.set(alias, identity);
}

function identityForFoundation(projectId: string, character: FoundationCharacter): CharacterIdentity | undefined {
  const canonicalId = text(character.id) ?? text(character.name);
  const displayName = text(character.name) ?? canonicalId;
  if (!canonicalId || !displayName) return undefined;
  return {
    entityId: entityIdFor(projectId, canonicalId),
    canonicalId,
    displayName,
    status: "identified",
    sourceId: canonicalId,
  };
}

function identityForEntity(projectId: string, entity: CharacterIdentityEntity): CharacterIdentity | undefined {
  const payload = entity.payload ?? {};
  const canonicalId = text(payload.canonicalCharacterId)
    ?? canonicalIdFromEntityId(projectId, entity.id)
    ?? text(entity.name);
  if (!canonicalId) return undefined;
  const pending = payload.pendingEnrichment === true || payload.displayNameStatus === "pending";
  const persistedDisplayName = text(payload.displayName);
  const displayName = persistedDisplayName
    ?? (pending || looksLikeStableIdentifier(entity.name) ? UNNAMED_CHARACTER : text(entity.name))
    ?? UNNAMED_CHARACTER;
  return {
    entityId: entity.id,
    canonicalId,
    displayName,
    status: pending || displayName === UNNAMED_CHARACTER ? "pending" : "identified",
    sourceId: canonicalId,
  };
}

export function buildCharacterIdentityIndex(
  projectId: string,
  entities: CharacterIdentityEntity[],
  foundationCharacters: FoundationCharacter[],
): CharacterIdentityIndex {
  const index: CharacterIdentityIndex = new Map();

  for (const character of foundationCharacters) {
    const identity = identityForFoundation(projectId, character);
    if (!identity) continue;
    addAlias(index, identity.canonicalId, identity);
    addAlias(index, identity.displayName, identity);
    addAlias(index, identity.entityId, identity);
  }

  for (const entity of entities) {
    // 已归并退役的实体（payload.mergedInto 指向规范实体）不参与身份索引：
    // 避免历史别名重复注册、档案摘要重复列出与消费方读到分裂的声部数据
    // （memory-governance-audit-20260909 §5.4.1）。
    if (entity.payload?.mergedInto) continue;
    const identity = identityForEntity(projectId, entity);
    if (!identity) continue;
    const canonicalIdentity = index.get(identity.entityId) ?? index.get(identity.canonicalId) ?? identity;
    addAlias(index, entity.id, canonicalIdentity);
    addAlias(index, entity.name, canonicalIdentity);
    addAlias(index, identity.canonicalId, canonicalIdentity);
    addAlias(index, text(entity.payload?.displayName), canonicalIdentity);
  }

  return index;
}

export function resolveCharacterIdentity(projectId: string, reference: string, index: CharacterIdentityIndex): CharacterIdentity {
  const sourceId = reference.trim();
  const exact = index.get(sourceId);
  if (exact) return { ...exact, sourceId };

  const canonicalId = canonicalIdFromEntityId(projectId, sourceId) ?? sourceId;
  const entityId = sourceId.startsWith(`entity:${projectId}:character:`)
    ? sourceId
    : entityIdFor(projectId, canonicalId);
  const byEntityId = index.get(entityId);
  if (byEntityId) return { ...byEntityId, sourceId };

  const displayName = looksLikeStableIdentifier(sourceId) ? UNNAMED_CHARACTER : sourceId || UNNAMED_CHARACTER;
  return {
    entityId,
    canonicalId,
    displayName,
    status: displayName === UNNAMED_CHARACTER ? "pending" : "identified",
    sourceId,
  };
}

export function uniqueCharacterIdentities(index: CharacterIdentityIndex): CharacterIdentity[] {
  const seen = new Set<string>();
  return [...index.values()].filter((identity) => {
    if (seen.has(identity.entityId)) return false;
    seen.add(identity.entityId);
    return true;
  });
}

export function characterIdentityPayload(identity: CharacterIdentity): Record<string, unknown> {
  return {
    canonicalCharacterId: identity.canonicalId,
    displayName: identity.displayName,
    displayNameStatus: identity.status,
    ...(identity.status === "pending" ? { sourceCharacterId: identity.sourceId } : {}),
  };
}

/**
 * 人物在正文中的可指称名集合（PL-4 正文可指认门，product-audit-20260910 B4）。
 * 从身份索引收集映射到同一实体的所有人类可读别名（显示名、注册名、登记别名），
 * 过滤机器标识（char_xxx / entity:…）、单字噪声与"未命名角色"占位。这些是判断
 * "该人物是否真的在正文出现"的唯一结构依据——模型把泛指（"高瘦的"）映射到规划专名
 * 时，规划专名在正文 0 命中即可被此门识破。
 */
export function humanMentionNamesFor(index: CharacterIdentityIndex, identity: CharacterIdentity): string[] {
  const names = new Set<string>();
  const accept = (value: string | undefined): void => {
    const candidate = value?.trim();
    if (!candidate || candidate === UNNAMED_CHARACTER || candidate.length < 2) return;
    if (looksLikeStableIdentifier(candidate)) return;
    names.add(candidate);
  };
  for (const [key, value] of index) {
    if (value.entityId === identity.entityId) accept(key);
  }
  accept(identity.displayName);
  return [...names];
}

/** 正文是否以任一可指称名提到该人物（子串命中，跨题材通用，不依赖分词/词表）。 */
export function isCharacterMentionedIn(bodyText: string, names: string[]): boolean {
  return names.some((name) => bodyText.includes(name));
}

export { UNNAMED_CHARACTER };
