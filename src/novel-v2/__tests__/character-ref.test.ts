import { describe, expect, it } from "vitest";
import { buildCharacterRefIndex } from "../character-ref";

// 登记表形态仿真实体：URI 主键 + 短 id + 显示名（跨题材通用命名，不含本书专名逻辑）。
const index = buildCharacterRefIndex([
  { id: "entity:p1:character:char_lin_mo", name: "林墨" },
  { id: "entity:p1:character:char_lan", name: "蓝" },
  { id: "entity:p1:character:char_lan_shan", name: "蓝衫客" },
  { id: "entity:p1:character:守夜人", name: "守夜人" },
]);

describe("character-ref 人物引用归一（P4 最低共享层）", () => {
  it("精确命中：URI、短 id、显示名三形态一致解析", () => {
    for (const raw of ["entity:p1:character:char_lin_mo", "char_lin_mo", "林墨"]) {
      expect(index.resolve(raw)?.shortId).toBe("char_lin_mo");
      expect(index.resolve(raw)?.uri).toBe("entity:p1:character:char_lin_mo");
    }
  });

  it("token 包含命中漂移短 id（char_lin ⊆ char_lin_mo 唯一）", () => {
    expect(index.resolve("char_lin")?.shortId).toBe("char_lin_mo");
    expect(index.resolve("lin-mo")?.shortId).toBe("char_lin_mo");
  });

  it("编辑距离容忍打字漂移（char_linn_mo→char_lin_mo 距离 1；距离 2 边界内）", () => {
    expect(index.resolve("char_linn_mo")?.shortId).toBe("char_lin_mo");
  });

  it("歧义保护：包含面多命中不猜（token 'lan' 同时落 char_lan/char_lan_shan → undefined）", () => {
    expect(index.resolve("lan")).toBeUndefined();
    expect(index.resolve("char_lan_shan")?.shortId).toBe("char_lan_shan");
    expect(index.resolve("char_lan")?.shortId).toBe("char_lan"); // char_lan 本身是精确短 id → 命中自己
  });

  it("未登记值不发明：无 token 交集、超编辑距离、空值都返回 undefined", () => {
    expect(index.resolve("char_zhou_bu_cun_zai")).toBeUndefined();
    expect(index.resolve("")).toBeUndefined();
    expect(index.resolve(null)).toBeUndefined();
    // 显示名即短 id 的登记（守夜人）：任何面都归一稳定。
    expect(index.resolve("守夜人")?.shortId).toBe("守夜人");
  });
});
