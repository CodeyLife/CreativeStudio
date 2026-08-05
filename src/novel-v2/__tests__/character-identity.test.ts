import { describe, expect, it } from "vitest";
import {
  buildCharacterIdentityIndex,
  resolveCharacterIdentity,
  type CharacterIdentityEntity,
  type FoundationCharacter,
} from "../character-identity";

describe("character identity projection", () => {
  const foundation: FoundationCharacter[] = [{ id: "char-chen-yuan", name: "陈渊" }];
  const entities: CharacterIdentityEntity[] = [];

  it("keeps the stable foundation id separate from the Chinese display name", () => {
    const index = buildCharacterIdentityIndex("p1", entities, foundation);

    expect(resolveCharacterIdentity("p1", "char-chen-yuan", index)).toMatchObject({
      entityId: "entity:p1:character:char-chen-yuan",
      canonicalId: "char-chen-yuan",
      displayName: "陈渊",
      status: "identified",
    });
    expect(resolveCharacterIdentity("p1", "陈渊", index)).toMatchObject({
      entityId: "entity:p1:character:char-chen-yuan",
      canonicalId: "char-chen-yuan",
      displayName: "陈渊",
    });
  });

  it("does not invent a name when a relation target has no canonical mapping", () => {
    const index = buildCharacterIdentityIndex("p1", entities, foundation);

    expect(resolveCharacterIdentity("p1", "unknown_stalker", index)).toMatchObject({
      entityId: "entity:p1:character:unknown_stalker",
      canonicalId: "unknown_stalker",
      displayName: "未命名角色",
      status: "pending",
    });
  });

  it("uses an existing human-readable entity name as a compatibility alias", () => {
    const index = buildCharacterIdentityIndex("p1", [{
      id: "entity:p1:character:night-watchman",
      name: "值夜人",
      payload: {},
    }], []);

    expect(resolveCharacterIdentity("p1", "值夜人", index)).toMatchObject({
      entityId: "entity:p1:character:night-watchman",
      canonicalId: "night-watchman",
      displayName: "值夜人",
      status: "identified",
    });
  });
});
