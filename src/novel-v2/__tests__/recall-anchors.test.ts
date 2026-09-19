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
    const text = "她记得三年前那次面试，评委只问了一个问题。先前她也想过要不要说实话。";
    expect(extractRecallSentences(text).map((item) => item.cue)).toEqual(["记得", "先前"]);
    const vocabulary = new Set(RECALL_CUES);
    for (const cue of ["云纹草", "灵石", "楚衡", "宗门", "修为"]) expect(vocabulary.has(cue as never)).toBe(false);
  });

  it("前瞻性的「之前」不算回述（真实正文实测的假阳性面，词表已不收）", () => {
    // 运行库正文实测样本型："即使被发现了行踪，他也要在被人抓住之前把自己彻底洗清"——
    // 语法上是前瞻连接词，不是回忆；若收进词表，审校者会拿到成批无效对照。
    const text = "他要在被人抓住之前把自己彻底洗清，那扇侧门之前也有人推开过。";
    expect(extractRecallSentences(text)).toEqual([]);
  });

  it("对照指向正确来源章：回忆所指的那一章排在候选首位", () => {
    const anchors = buildRecallAnchors({
      text: "膝部的隐痛随着走动一下一下地传来，每一步都让他想起昨夜灵气撞开经脉的那套走法。",
      priorChapters: [
        { narrativeOrder: 2, text: "他想起昨夜自己尝试的那套灵气运行路线——绕开淤塞的主经脉，走细支。" },
        { narrativeOrder: 3, text: "账房把册子合上，说例供欠着便要排守夜，无人替他说话。" },
      ],
    });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.sources[0]).toMatchObject({ narrativeOrder: 2 });
    // 无关章零重叠被过滤，不会以低分候选充数
    expect(anchors[0]!.sources.every((source) => source.narrativeOrder === 2)).toBe(true);
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
