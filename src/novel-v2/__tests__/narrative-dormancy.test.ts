/**
 * 线索静默账本（narrative-dormancy）双向测试。
 *
 * 判据形态（2026-09-18 P1，见 docs/novel-v2/p1-foreshadowing-survey-20260918.md）：
 * 曾活跃 → 近 silentWindow 章完全消失 = silent；埋后从未提及 = never-mentioned；
 * 近期仍在推进 = running；关键词缺失/过短 = unmeasurable（不猜）。
 */
import { describe, expect, it } from "vitest";
import { assessNarrativePresence, summarizeDormancy, DORMANCY_POLICY } from "../narrative-dormancy";

/** 构造章节正文：第 order 章含 markers 中的关键词。 */
function chapterWith(order: number, ...markers: string[]) {
  return { narrativeOrder: order, text: `第${order}章正文。${markers.join("")}` };
}

describe("assessNarrativePresence 单条线索在场判定", () => {
  it("埋后从未被提及 → never-mentioned（抽取即孤儿）", () => {
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "别的"), chapterWith(3, "别的")];
    const presence = assessNarrativePresence(1, ["从未出现的词"], chapters, 3);
    expect(presence.status).toBe("never-mentioned");
    expect(presence.mentionOrders).toEqual([]);
    expect(presence.lastMentionOrder).toBeNull();
    expect(presence.silentFor).toBeNull();
  });

  it("曾活跃且近章仍在推进 → running", () => {
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "老槐树"), chapterWith(3, "老槐树")];
    const presence = assessNarrativePresence(1, ["老槐树"], chapters, 3);
    expect(presence.status).toBe("running");
    expect(presence.lastMentionOrder).toBe(3);
    expect(presence.silentFor).toBe(0);
  });

  it("曾活跃但末次提及已达窗口 → silent，且 silentFor 按当前章计算", () => {
    // 埋 1，提及 2 与 5，当前 30，窗口 20 → 30-5=25 >= 20
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "老槐树"), chapterWith(5, "老槐树"), chapterWith(29, "别的"), chapterWith(30, "别的")];
    const presence = assessNarrativePresence(1, ["老槐树"], chapters, 30);
    expect(presence.status).toBe("silent");
    expect(presence.lastMentionOrder).toBe(5);
    expect(presence.silentFor).toBe(25);
  });

  it("边界：恰好等于窗口即判 silent（>= 语义，非 >）", () => {
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "老槐树"), chapterWith(10, "老槐树")];
    // 当前 30 - 末次 10 = 20 = silentWindow
    expect(assessNarrativePresence(1, ["老槐树"], chapters, 30).status).toBe("silent");
    // 当前 29 - 末次 10 = 19 < 窗口 → 仍在推进（反方向）
    expect(assessNarrativePresence(1, ["老槐树"], chapters, 29).status).toBe("running");
  });

  it("边界：窗口少 1 章不应误判为静默（防过度告警）", () => {
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "老槐树")];
    // 末次提及 2；当前章 = 2 + 窗口 - 1 → silentFor = 窗口 - 1，恰在窗口内
    const current = 2 + DORMANCY_POLICY.silentWindow - 1;
    const justInside = assessNarrativePresence(1, ["老槐树"], chapters, current);
    expect(justInside.silentFor).toBe(DORMANCY_POLICY.silentWindow - 1);
    expect(justInside.status).toBe("running");
    // 反方向：再多一章即跨过窗口 → silent
    expect(assessNarrativePresence(1, ["老槐树"], chapters, current + 1).status).toBe("silent");
  });

  it("只统计埋设章之后的提及：埋设章自身不算在场证据", () => {
    // 仅第 1 章（埋设章）出现关键词，之后从未出现 → 应为 never-mentioned 而非 running
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "无关"), chapterWith(3, "无关")];
    expect(assessNarrativePresence(1, ["老槐树"], chapters, 3).status).toBe("never-mentioned");
  });

  it("关键词为空或全为单字 → unmeasurable，不猜", () => {
    const chapters = [chapterWith(1, "老槐树"), chapterWith(2, "老槐树")];
    // 空关键词：不可测
    expect(assessNarrativePresence(1, [], chapters, 50).status).toBe("unmeasurable");
    // 全部短于 minKeywordLength：不可测（1 字词包含扫描误报率高，刻意不登记）
    expect(assessNarrativePresence(1, ["树"], chapters, 50).status).toBe("unmeasurable");
    // 混入一个够长的词 → 恢复可测，且按该长词的实际提及判定（末次 2、当前 50 → 静默）
    expect(assessNarrativePresence(1, ["树", "老槐树"], chapters, 50).status).toBe("silent");
    // 反方向：当前章贴近末次提及 → 同一关键词集合判为仍在推进
    expect(assessNarrativePresence(1, ["树", "老槐树"], chapters, 3).status).toBe("running");
  });

  it("埋设章序缺失 → unmeasurable（不假设章序）", () => {
    const chapters = [chapterWith(1, "老槐树")];
    expect(assessNarrativePresence(null, ["老槐树"], chapters, 50).status).toBe("unmeasurable");
  });

  it("提及顺序无关：输入章节乱序仍得到正确 lastMentionOrder", () => {
    const chapters = [chapterWith(9, "老槐树"), chapterWith(2, "老槐树"), chapterWith(5, "老槐树")];
    const presence = assessNarrativePresence(1, ["老槐树"], chapters, 40);
    expect(presence.mentionOrders).toEqual([2, 5, 9]);
    expect(presence.lastMentionOrder).toBe(9);
  });
});

describe("summarizeDormancy 账本汇总", () => {
  const chapters = [
    chapterWith(1, "老槐树", "玉牌"),
    chapterWith(2, "老槐树"),
    chapterWith(30, "老槐树"),   // 老槐树活着
    chapterWith(3, "树洞"),
    chapterWith(5, "树洞"),      // 树洞末次 5 → 静默
    // 铜钱只在埋设章出现 → never-mentioned
  ];
  it("四类分层各自归位，计数守恒", () => {
    const ledger = summarizeDormancy(
      [
        { id: "a", description: "老槐树的异常", plantedOrder: 1, keywords: ["老槐树"] },
        { id: "b", description: "树洞蓝光的性质", plantedOrder: 3, keywords: ["树洞"] },
        { id: "c", description: "原主遗留的铜钱", plantedOrder: 1, keywords: ["铜钱"] },
        { id: "d", description: "无关键词条目", plantedOrder: 1, keywords: [] },
      ],
      chapters,
      40,
    );
    expect(ledger.silent.map((item) => item.id)).toEqual(["b"]);
    expect(ledger.neverMentioned.map((item) => item.id)).toEqual(["c"]);
    expect(ledger.running).toBe(1);      // a
    expect(ledger.unmeasurable).toBe(1); // d
    expect(ledger.measured).toBe(3);
    expect(ledger.silent.length + ledger.neverMentioned.length + ledger.running + ledger.unmeasurable).toBe(4);
  });

  it("静默清单按沉默章数降序（最久的先面对规划者）", () => {
    const wide = [
      chapterWith(1, "甲线", "乙线"), chapterWith(2, "甲线", "乙线"), chapterWith(9, "甲线"),   // 甲末次 9
      chapterWith(11, "乙线"),                                                                // 乙末次 11
    ];
    const ledger = summarizeDormancy(
      [
        { id: "old", description: "甲线", plantedOrder: 1, keywords: ["甲线"] },
        { id: "newer", description: "乙线", plantedOrder: 1, keywords: ["乙线"] },
      ],
      wide,
      60,
    );
    expect(ledger.silent.map((item) => item.id)).toEqual(["old", "newer"]);
    expect(ledger.silent[0]!.silentFor).toBeGreaterThan(ledger.silent[1]!.silentFor!);
  });

  it("静默带按末次提及章分桶（识别成片失线）", () => {
    const bands = [
      chapterWith(1, "甲线", "乙线", "丙线"), chapterWith(2, "甲线", "乙线", "丙线"),
      chapterWith(10, "甲线"), chapterWith(12, "乙线"), chapterWith(35, "丙线"),
    ];
    const ledger = summarizeDormancy(
      [
        { id: "a", description: "甲线", plantedOrder: 1, keywords: ["甲线"] },
        { id: "b", description: "乙线", plantedOrder: 1, keywords: ["乙线"] },
        { id: "c", description: "丙线", plantedOrder: 1, keywords: ["丙线"] },
      ],
      bands,
      80,
    );
    // 末次 10 与 12 落在 0-19 桶；末次 35 落在 20-39 桶
    expect(ledger.silentBands).toEqual([
      { fromOrder: 0, toOrder: 19, count: 2 },
      { fromOrder: 20, toOrder: 39, count: 1 },
    ]);
  });

  it("反例：全部线索仍在推进时不产生任何静默（防假阳性）", () => {
    const alive = [chapterWith(1, "甲线"), chapterWith(2, "甲线"), chapterWith(39, "甲线")];
    const ledger = summarizeDormancy(
      [{ id: "a", description: "甲线", plantedOrder: 1, keywords: ["甲线"] }],
      alive,
      40,
    );
    expect(ledger.silent).toEqual([]);
    expect(ledger.neverMentioned).toEqual([]);
    expect(ledger.silentBands).toEqual([]);
    expect(ledger.running).toBe(1);
  });
});
