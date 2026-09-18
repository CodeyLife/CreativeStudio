import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 仓储消费面切线的守卫（slice 拆分第一步的护栏）。
 *
 * 拆分 god-object 之前，先得让"谁真的需要什么"变成不可回退的事实：本文件的断言不检查
 * 运行时行为（这一刀是纯类型改动，构造侧照旧传完整 repository），它检查的是**边界是否
 * 又长回 god-object**。这类回退不会因为编译失败被发现——把注解改回
 * `NovelPostgresRepository` 或者给"只要一条连接"的消费方加一个领域方法调用，都静默通过。
 */

/** 只需 SQL 通道的消费面：出现任何领域方法调用即说明连接面被当成了领域面。 */
const CONNECTION_ONLY = [
  "src/novel-v2/craft-rule/index.ts",
  "src/novel-v2/craft-rule/promotion-service.ts",
  "src/novel-v2/creative/review-gate.ts",
  "src/novel-v2/creative/run-manager.ts",
  "src/novel-v2/creative/snapshot.ts",
  "src/novel-v2/evaluation/project-snapshot.ts",
  "src/novel-v2/evaluation/skill-iteration.ts",
];

/** 已声明能力面的消费方：不得再回到整类型依赖。 */
const NARROWED = [
  ...CONNECTION_ONLY,
  "src/novel-v2/application/book-synopsis-workflow.ts",
  "src/novel-v2/application/bootstrap.ts",
  "src/novel-v2/application/chapter-script-h3.ts",
  "src/novel-v2/application/chapter-state-rebuild.ts",
  "src/novel-v2/application/chapter-title-workflow.ts",
  "src/novel-v2/application/story-arc-workflow.ts",
  "src/novel-v2/chapter-memory/index.ts",
  "src/novel-v2/character-enrichment/index.ts",
  "src/novel-v2/commit-service.ts",
  "src/novel-v2/creative/command-router.ts",
  "src/novel-v2/creative/work-item.ts",
  "src/novel-v2/model-runtime.ts",
  "src/novel-v2/runtime-object-store.ts",
];

const CAPABILITIES = "src/novel-v2/repository-capabilities.ts";
const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("仓储 slice 切线守卫", () => {
  it("连接面消费方只用 pool，不碰任何领域方法", () => {
    for (const file of CONNECTION_ONLY) {
      const source = read(file);
      // 只认"方法调用"，避免把散文里的 `repository.ts` 之类文件名当成越界。
      const offenders = [...source.matchAll(/\b(?:repository|repo)\.(?!pool\b)([a-zA-Z_]\w*)\s*\(/g)].map((match) => match[1]);
      expect(offenders, `${file} 通过连接面调用了领域方法`).toEqual([]);
      expect(source, file).toContain("RepositoryQueryClient");
    }
  });

  it("已收窄的消费方不得再声明整类型依赖", () => {
    for (const file of NARROWED) {
      expect(read(file), file).not.toMatch(/\bNovelPostgresRepository\b/);
    }
  });

  it("RepositoryQueryClient 永远只有 pool 一个成员", () => {
    const source = read(CAPABILITIES);
    expect(source).toMatch(/export type RepositoryQueryClient = Pick<NovelPostgresRepository, "pool">;/);
  });

  it("能力类型不得长成第二个 god-object（每个 ≤14 个成员）", () => {
    const source = read(CAPABILITIES);
    const types = [...source.matchAll(/export type (\w+) = Pick<[\s\S]*?>/g)];
    expect(types.length).toBeGreaterThanOrEqual(10);
    for (const match of types) {
      const members = (match[0].match(/"[a-zA-Z]\w*"/g) ?? []).length;
      expect(members, `${match[1]} 有 ${members} 个成员`).toBeGreaterThan(0);
      expect(members, `${match[1]} 已经不像一片 slice，更像整个仓储`).toBeLessThanOrEqual(14);
    }
  });

  it("每条能力都有消费方（无人的能力=拆分开采前的噪声，要么接线要么删）", () => {
    const source = read(CAPABILITIES);
    const names = [...source.matchAll(/export type (\w+) = Pick</g)].map((match) => match[1]);
    const consumers = NARROWED.map((file) => read(file));
    for (const name of names) {
      expect(consumers.some((text) => text.includes(name)), `${name} 无消费方`).toBe(true);
    }
  });

  it("能力清单只在单一真源里，消费方不得就地内联 Pick 造第二份", () => {
    const inliners = NARROWED.filter((file) => /Pick<\s*NovelPostgresRepository/.test(read(file)));
    expect(inliners).toEqual([]);
  });
});
