import { describe, expect, it } from "vitest";
import { buildRecallAnchors, extractRecallSentences, RECALL_CUES, RECALL_REPORT_POLICY } from "../recall-anchors";

describe("回述对照诊断（D2 只读投影）", () => {
  it("抽回述句：命中功能词才收，短句与无触发词句不进，同句取最靠前的触发词", () => {
    const text = "他想起那夜的雨声。门闩落了三次。上次有人替他挡了一下，他没回头看。记得。";
    const anchors = extractRecallSentences(text);
    expect(anchors.map((item) => item.cue)).toEqual(["想起", "上次"]);
    expect(anchors[0]!.sentence).toContain("那夜的雨声");
    // "记得。" 短于最小句长（无可比对事件信息）；"门闩落了三次" 无回述触发词，属当场叙述。
    expect(anchors.some((item) => item.sentence.includes("门闩"))).toBe(false);
  });

  it("跨题材泛化：现代口语样本同样触发，触发词表不含专名或题材词", () => {
    const text = "她记得三年前那次面试，评委只问了一个问题。之前她也想过要不要说实话。";
    expect(extractRecallSentences(text).map((item) => item.cue)).toEqual(["记得", "之前"]);
    const vocabulary = new Set(RECALL_CUES);
    for (const cue of ["云纹草", "灵石", "楚衡", "宗门", "修为"]) expect(vocabulary.has(cue as never)).toBe(false);
  });

  it("给对照：近窗最相似原句按相似度降序，附章号；逐字复述保留，零相似不输出", () => {
    const priorChapters = [
      { narrativeOrder: 4, documentId: "doc-4", text: "楚衡把两株云纹草塞回袖口，转身时听见廊下有脚步声。他记得那夜的雨声，也记得瓦上的水一直滴到三更。" },
      { narrativeOrder: 5, documentId: "doc-5", text: "账房把册子合上，说例供欠着便要排守夜。" },
    ];
    const anchors = buildRecallAnchors({
      text: "他想起那夜的雨声，也想起瓦上滴水到三更。上次欠着例供的人被排去守夜了。那一回他替师弟挡了搜身，没人看见。",
      priorChapters,
    });
    expect(anchors).toHaveLength(3);

    const rain = anchors[0]!;
    expect(rain.cue).toBe("想起");
    expect(rain.sources.length).toBeGreaterThan(0);
    expect(rain.sources[0]).toMatchObject({ narrativeOrder: 4, documentId: "doc-4" });
    expect(rain.sources.map((source) => source.similarity)).toEqual([...rain.sources.map((source) => source.similarity)].sort((a, b) => b - a));

    const duty = anchors[1]!;
    expect(duty.sources[0]!.narrativeOrder).toBe(5);

    // 近窗无可比对内容时列空，由审校者判"回述无据"——机械层不代替人下这个结论。
    expect(anchors[2]!.sources).toEqual([]);
  });

  it("逐字复述不被当成自匹配丢弃（跨章复读是最强信号）", () => {
    const echoed = "他想起那夜的雨声，也记得瓦上的水一直滴到三更。";
    const anchors = buildRecallAnchors({ text: echoed, priorChapters: [{ narrativeOrder: 3, text: echoed }] });
    expect(anchors[0]!.sources[0]).toMatchObject({ narrativeOrder: 3, similarity: 1 });
  });

  it("体量上限：回述句数与每条候选数受策略约束", () => {
    const sentences = Array.from({ length: RECALL_REPORT_POLICY.maxSentences + 5 }, (_, index) => `他记得第${index + 1}次登记的名牌写着不同的名字。`).join("");
    expect(buildRecallAnchors({ text: sentences, priorChapters: [{ narrativeOrder: 1, text: "名牌上的字与登记簿不一致。" }] })).toHaveLength(RECALL_REPORT_POLICY.maxSentences);
    const many = buildRecallAnchors({
      text: "他想起雨夜里数过的那些瓦。",
      priorChapters: Array.from({ length: 6 }, (_, index) => ({ narrativeOrder: index + 1, text: `雨夜里数瓦第${index + 1}回，瓦上水声不断。` })),
    });
    expect(many[0]!.sources.length).toBeLessThanOrEqual(RECALL_REPORT_POLICY.maxSources);
  });
});
