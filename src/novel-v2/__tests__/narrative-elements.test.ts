import { describe, expect, it } from "vitest";
import { dedupeByNarrativeText, foreshadowingContentKey, foreshadowingLedgerId, formatPayoffWindow, mergeForeshadowingLedgerPayload, narrativeTextKey, parsePayoffWindow, promiseContentKey, type ForeshadowingLedgerPayload } from "../narrative-elements";

describe("narrative-elements 内容键", () => {
  it("同一描述的不同空白/标点变体得到相同内容键（跨修订重提取不再生成新 ID）", () => {
    const base = "楚衡通过三次复现确认气海折返是功法固有缺陷，并提出十二正经可能普遍存在冗余路径的猜想。";
    const variant = "楚衡通过三次复现确认气海折返是功法固有缺陷，  并提出十二正经可能普遍存在冗余路径的猜想";
    expect(foreshadowingContentKey(base)).toBe(foreshadowingContentKey(variant));
    expect(foreshadowingContentKey(base)).not.toContain("-"); // 12 hex，不含来源标识
  });

  it("不同描述得到不同内容键（不误合并语义不同的伏笔）", () => {
    const a = foreshadowingContentKey("旧门刻痕在月圆夜渗出寒气");
    const b = foreshadowingContentKey("天枢峰灵光与主角灵气波动共振");
    expect(a).not.toBe(b);
  });

  it("承诺内容键区分承诺者与受诺者（同一陈述不同主体不合并）", () => {
    const a = promiseContentKey("楚衡", "执事弟子", "三天内凑齐三块下品灵石");
    const b = promiseContentKey("执事弟子", "楚衡", "三天内凑齐三块下品灵石");
    expect(a).not.toBe(b);
    expect(promiseContentKey("楚衡", "执事弟子", "三天内凑齐三块下品灵石")).toBe(
      promiseContentKey(" 楚衡 ", "执事弟子", "三天内，凑齐三块下品灵石。"),
    );
  });

  it("narrativeTextKey 只服务内容键，输出与展示无关的规范化文本", () => {
    expect(narrativeTextKey("  测试　文本，带标点。 ")).toBe("测试文本带标点");
  });
});

describe("dedupeByNarrativeText 读取层去重", () => {
  const textOf = (item: { text: string }) => item.text;

  it("保留首条（调用方已按叙事顺序排序），丢弃后续同文条目", () => {
    const kept = dedupeByNarrativeText(
      [
        { text: "灵堂地砖下存在规律性震颤", extra: "first" },
        { text: "灵堂地砖下  存在规律性震颤。", extra: "dup" },
        { text: "完全不同的另一条线索", extra: "other" },
      ],
      textOf,
    );
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ extra: "first" });
    expect(kept[1]).toMatchObject({ extra: "other" });
  });

  it("规范化后为空的条目不参与合并（各自保留，交由上游校验）", () => {
    const kept = dedupeByNarrativeText([{ text: "，。" }, { text: "  " }, { text: "正常线索" }], textOf);
    expect(kept).toHaveLength(3);
  });

  it("空输入返回空数组（边界）", () => {
    expect(dedupeByNarrativeText([], textOf)).toEqual([]);
  });
});

describe("parsePayoffWindow 兑现窗口形态解析（PL-5① 读取面）", () => {
  it("相对章数换算为绝对上界", () => {
    expect(parsePayoffWindow("5 章内", 8)).toEqual({ kind: "chapter", horizonOrder: 13 });
    expect(parsePayoffWindow("第10-20章之间回收", 8)).toEqual({ kind: "chapter", horizonOrder: 20 });
    expect(parsePayoffWindow("第15章末", 8)).toEqual({ kind: "chapter", horizonOrder: 15 });
  });

  it("卷/书边界与无界意图不猜绝对上界", () => {
    expect(parsePayoffWindow("本卷末", 8).kind).toBe("volume");
    expect(parsePayoffWindow("长篇后期", 8).kind).toBe("book");
    expect(parsePayoffWindow("不限", 8).kind).toBe("unbounded");
    expect(parsePayoffWindow("本卷末", 8).horizonOrder).toBeNull();
  });

  it("解析不了的形态归 unknown 而非伪造窗口（反例守卫）", () => {
    expect(parsePayoffWindow("在主角实力足够时", 8)).toEqual({ kind: "unknown", horizonOrder: null });
    expect(parsePayoffWindow(undefined, 8).kind).toBe("unknown");
    expect(parsePayoffWindow("", 8).kind).toBe("unknown");
  });

  it("结构化 {scope,from,to,count} 新形态优先按数值收敛", () => {
    expect(parsePayoffWindow({ scope: "chapter", to: 24 }, 8)).toEqual({ kind: "chapter", horizonOrder: 24 });
    expect(parsePayoffWindow({ scope: "within", count: 3 }, 8)).toEqual({ kind: "chapter", horizonOrder: 11 });
    expect(parsePayoffWindow({ scope: "volume" }, 8).kind).toBe("volume");
  });

  it("缺埋设序时相对窗口不换算（horizon 留空交人工）", () => {
    expect(parsePayoffWindow("5 章内", null)).toEqual({ kind: "chapter", horizonOrder: null });
  });
});

describe("伏笔锚点身份与归并（PL-5③，product-audit-20260910 B2）", () => {
  const base = { description: "祠堂石阶裂缝在雷雨夜透出微光", triggerKeywords: ["石阶"], expectedPayoffWindow: "本卷末" as const, evidence: "他注意到祠堂石阶的裂缝在雷雨夜透出微光。" };

  it("同文档同锚点：描述措辞完全改写仍复用同一行（锚点是身份，描述不是）", () => {
    const a = foreshadowingLedgerId("p1", "doc1", { description: "祠堂石阶裂缝在雷雨夜透出微光", anchor: "祠堂石阶裂缝" });
    const b = foreshadowingLedgerId("p1", "doc1", { description: "石阶里有一道会发光的纹，像是刻上去的", anchor: "祠堂，石阶——裂缝" });
    expect(a).toBe(b);
    expect(a).toContain(":anchor:");
  });

  it("跨文档同锚点不合并（不同载体词面相同不代表同一伏笔，误并=丢账；近重复由 health 可见）", () => {
    expect(foreshadowingLedgerId("p1", "doc1", { description: "x", anchor: "青色玉佩" }))
      .not.toBe(foreshadowingLedgerId("p1", "doc2", { description: "x", anchor: "青色玉佩" }));
  });

  it("锚点缺失或句子形态退回描述内容键（旧输出保持身份，不拿整句当锚乱并）", () => {
    const fallback = `foreshadowing:p1:${foreshadowingContentKey("门槛刻痕")}`;
    expect(foreshadowingLedgerId("p1", "doc1", { description: "门槛刻痕" })).toBe(fallback);
    expect(foreshadowingLedgerId("p1", "doc1", { description: "门槛刻痕", anchor: " 　" })).toBe(fallback);
    expect(foreshadowingLedgerId("p1", "doc1", { description: "门槛刻痕", anchor: "那个雷雨夜里祠堂石阶上出现了谁也无法看懂的纹路连村口的狗都叫得很奇怪" })).toBe(fallback);
  });

  it("归并双向：最早信息保留、keywords/方向有序并集、被吸收改写进 mergedFrom；同文重放不产生并集噪声", () => {
    const first: ForeshadowingLedgerPayload = { ...base, possiblePayoffs: [] };
    const again: ForeshadowingLedgerPayload = { ...base, description: "石阶里有一道会发光的纹", triggerKeywords: ["微光", "石阶"], possiblePayoffs: ["纹是封印"] };
    const merged = mergeForeshadowingLedgerPayload(first, again);
    expect(merged.description).toBe(base.description);
    expect(merged.triggerKeywords).toEqual(["石阶", "微光"]);
    expect(merged.possiblePayoffs).toEqual(["纹是封印"]);
    expect(merged.mergedFrom).toEqual(["石阶里有一道会发光的纹"]);
    const replay = mergeForeshadowingLedgerPayload(first, { ...base, possiblePayoffs: [] });
    expect(replay.mergedFrom).toBeUndefined();
    expect(replay.triggerKeywords).toEqual(["石阶"]);
  });

  it("窗口显示形态：结构化对象渲染短句、历史字符串透传、无效值归未指定不抛错", () => {
    expect(formatPayoffWindow({ scope: "chapters", count: 5 })).toBe("5章内");
    expect(formatPayoffWindow({ scope: "chapters", from: 12, to: 15 })).toBe("第12-15章");
    expect(formatPayoffWindow({ scope: "volume" })).toBe("本卷内");
    expect(formatPayoffWindow({ scope: "book", note: "长篇后期" })).toBe("长篇后期");
    expect(formatPayoffWindow("本卷末")).toBe("本卷末");
    expect(formatPayoffWindow(null)).toBe("未指定");
  });
});
