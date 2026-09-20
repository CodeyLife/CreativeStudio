import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSkillProjections } from "../skill-hygiene";
import { compareSkillVersions } from "../skill-runtime";

/**
 * seed↔DB 投影漂移判定（SK-2 单一真源的观测面）。
 *
 * 回归对象是 2026-09-19 在运行库上抓到的自毁式守卫：`novel:skills:check` 先
 * `migrate()` 再比对，而 migrate 尾的 `seedWorkspaceSkills` 会把 seed 写进
 * `skill_definitions`——比对发生在写入之后，seed 领先的漂移被命令自己抹平
 * （实测 check 打印 ok，而库内该技能仍是旧版本），同时一个名为 check 的命令
 * 悄悄改了运行库。判据抽成纯函数后，方向规则与"观测命令不得 migrate"都能被测。
 */
const row = (skillId: string, version: string, fingerprint: string) => ({ skillId, version, contentFingerprint: fingerprint });

describe("skill seed↔DB 漂移判定", () => {
  it("同版本同指纹不算漂移，也不制造 promotion-ahead 噪声", () => {
    const seed = [row("foundation-planning", "1.0.3", "aaa")];
    const db = [row("foundation-planning", "1.0.3", "aaa")];
    expect(compareSkillProjections(seed, db, compareSkillVersions)).toEqual({ drift: [], promotionAhead: [] });
  });

  it("seed 领先（含只改文案并抬版本）判为漂移——旧实现因先写库而永远看不到这一支", () => {
    const seed = [row("foundation-planning", "1.0.3", "bbb")];
    const db = [row("foundation-planning", "1.0.2", "aaa")];
    const result = compareSkillProjections(seed, db, compareSkillVersions);
    expect(result.promotionAhead).toEqual([]);
    expect(result.drift).toEqual([expect.objectContaining({ skillId: "foundation-planning", reason: "content-or-version-drift" })]);
  });

  it("同版本但内容指纹不同判为漂移（抬版本而忘改内容、或反之，都不可静默）", () => {
    const result = compareSkillProjections([row("prose-craft", "1.4.0", "new")], [row("prose-craft", "1.4.0", "old")], compareSkillVersions);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({ reason: "content-or-version-drift", database: { contentFingerprint: "old" } });
  });

  it("DB 版本更高=学习闭环晋升领先，归 promotion-ahead 而非漂移", () => {
    const result = compareSkillProjections([row("prose-craft", "1.4.0", "aaa")], [row("prose-craft", "1.4.1", "zzz")], compareSkillVersions);
    expect(result.drift).toEqual([]);
    expect(result.promotionAhead).toEqual([{ skillId: "prose-craft", workspace: "1.4.0", database: "1.4.1" }]);
  });

  it("库内缺行判 missing-in-database，且不影响同批其他技能的判定", () => {
    const result = compareSkillProjections(
      [row("chapter-naming", "1.0.0", "a"), row("foundation-planning", "1.0.0", "b")],
      [row("foundation-planning", "1.0.0", "b")],
      compareSkillVersions,
    );
    expect(result.drift).toEqual([expect.objectContaining({ skillId: "chapter-naming", reason: "missing-in-database" })]);
  });

  it("旧库行没有内容指纹时按漂移处理（缺指纹不等于内容相同）", () => {
    const result = compareSkillProjections(
      [row("foundation-planning", "1.0.0", "aaa")],
      [{ skillId: "foundation-planning", version: "1.0.0", contentFingerprint: null }],
      compareSkillVersions,
    );
    expect(result.drift).toEqual([expect.objectContaining({
      reason: "content-or-version-drift",
      database: { skillId: "foundation-planning", version: "1.0.0", contentFingerprint: null },
    })]);
  });
});

describe("skills CLI 的读写面分离", () => {
  const source = readFileSync("scripts/novel-v2-skills.ts", "utf8");
  const body = (name: string) => {
    const start = source.indexOf(`async function ${name}(`);
    // 找不到函数头时 slice(-1) 只有尾字符，not.toContain 会恒真 ⇒ 先锁"切片非空转"。
    expect(start, `源里必须存在 async function ${name}(`).toBeGreaterThan(-1);
    const next = source.indexOf("\nasync function ", start + 1);
    return source.slice(start, next < 0 ? source.length : next);
  };

  it("只有 sync 的写库路径调用 migrate，观测命令（loadDatabase/check/explain）一律不调", () => {
    expect([...source.matchAll(/\.migrate\(\)/g)]).toHaveLength(1);
    expect(body("syncDatabase")).toContain(".migrate()");
    for (const observed of ["loadDatabase", "checkDatabase", "explain", "validateWorkspace"]) {
      expect(body(observed), observed).not.toContain(".migrate()");
    }
  });

  it("漂移判据不在 CLI 里重写一遍（单一真源在 skill-hygiene）", () => {
    expect(body("checkDatabase")).toContain("compareSkillProjections(");
    expect(body("checkDatabase")).not.toContain("missing-in-database");
  });
});
