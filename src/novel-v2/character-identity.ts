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

export { UNNAMED_CHARACTER };
