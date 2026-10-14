import { describe, expect, it } from "vitest";
import { prependWithCap } from "../cappedList";

const item = (id: string) => ({ id });

describe("prependWithCap", () => {
  it("keeps everything and evicts nothing below the cap", () => {
    const { kept, evicted } = prependWithCap([item("a"), item("b")], item("c"), 5);

    expect(kept.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(evicted).toEqual([]);
  });

  it("evicts the tail entry when the merged list exceeds the cap", () => {
    const { kept, evicted } = prependWithCap([item("a"), item("b")], item("c"), 2);

    expect(kept.map((i) => i.id)).toEqual(["c", "a"]);
    expect(evicted.map((i) => i.id)).toEqual(["b"]);
  });

  it("still reports the evicted entry when the existing list is already at the cap", () => {
    // 回归点：旧实现用 `existing.slice(kept.length)` 反推淘汰项，列表已满时恒为空数组。
    const full = [item("a"), item("b")];
    const { kept, evicted } = prependWithCap(full, item("c"), 2);

    expect(kept).toHaveLength(2);
    expect(evicted.map((i) => i.id)).toEqual(["b"]);
  });

  it("evicts the incoming entry itself when the cap is zero", () => {
    const { kept, evicted } = prependWithCap([item("a")], item("b"), 0);

    expect(kept).toEqual([]);
    expect(evicted.map((i) => i.id)).toEqual(["b", "a"]);
  });
});
