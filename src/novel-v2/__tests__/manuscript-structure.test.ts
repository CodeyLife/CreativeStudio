import { describe, expect, it } from "vitest";
import { inspectManuscript, normalizeManuscriptStructuralReview } from "../application/manuscript-structure";
import type { Review } from "../protocol";

describe("manuscript structural inspection", () => {
  it("blocks a repeated multi-paragraph sequence", () => {
    const first = "他沿着潮湿的石阶向下，每一步都先用刀鞘试探落脚处，直到墙后的机括声彻底停住。石缝里渗出的水沿着刀鞘往下淌，他等最后一滴落地，才把重量交给前脚。";
    const second = "水线退去以后，木牌背面的刻痕才显出来，他没有伸手，只把位置和方向一笔一笔记进册中。同行的人在门外催促，他仍等潮气散尽，确认刻痕没有被浮泥改过形状。";
    const text = [first, second, "他们绕过倒塌的门楼。", first, second].join("\n\n");
    const report = inspectManuscript({ text });
    expect(report.passed).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "manuscript.repeated-block" })]));
  });

  it("allows short dialogue refrains and reports fragmentation without blocking", () => {
    const paragraphs = Array.from({ length: 110 }, (_, index) => index % 10 === 0 ? "“还去吗？”" : `“第${index}步。”`);
    const report = inspectManuscript({ text: paragraphs.join("\n\n") });
    expect(report.passed).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "manuscript.fragmentation" })]));
  });

  it("does not impose any chapter length rule", () => {
    expect(inspectManuscript({ text: "灯下有人翻完一页旧案。" }).passed).toBe(true);
    expect(inspectManuscript({ text: "他们继续向前。".repeat(20_000) }).passed).toBe(true);
  });

  it("retires persisted chapter length blockers", () => {
    const review: Review = {
      id: "legacy-length-review",
      projectId: "p1",
      artifactId: "a1",
      reviewerId: "deterministic-manuscript-inspector",
      identity: "internal",
      role: "structural-validator",
      verdict: "blocked",
      issues: [{ severity: "blocker", title: "正文长度偏离章节约束", evidence: "有效字符 2706，约束 8000-12000", rule: "manuscript.length" }],
      artifactFingerprint: "fp1",
      createdAt: 1,
    };

    expect(normalizeManuscriptStructuralReview(review)).toMatchObject({ verdict: "passed", issues: [] });
  });

  it("blocks model-limit truncation and output wrappers", () => {
    expect(inspectManuscript({ text: "```\n正文\n```" }).passed).toBe(false);
    expect(inspectManuscript({ text: "审核说明：\n真正的正文。" }).passed).toBe(false);
    expect(inspectManuscript({ text: "顾。根据审核记录完成本轮替换。\n真正的正文。" }).passed).toBe(false);
    expect(inspectManuscript({ text: "正文\n\n结构如断齿般卡住" }).passed).toBe(true);
    expect(inspectManuscript({ text: "真正的正文", stopReason: "max_tokens" }).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "manuscript.truncated" })]));
  });

  it("短引导句叙事先头不是包装（ch55 误报实证：形状须叠工件指涉才判）", () => {
    expect(inspectManuscript({ text: "黑屋里没有灯。楚衡靠着墙根坐着，左膝布条底下跳得钝。窗外风声紧了一阵。" }).passed).toBe(true);
    // 反例保持：同形状但续写在谈论工件本身 → 仍拦。
    expect(inspectManuscript({ text: "明白。以下为按要求改写后的正文，保留原有节奏与全部事实不变。" }).passed).toBe(false);
  });

  it("句法 tic warning：高密度对比复句/计量刻度词点名，阈值下与干净文本不误伤（2026-09-16 语料确诊）", () => {
    const clean = "楚衡把呈本放回案头。灯下他翻开册末那页，四个字是他自己落进官档里的。他把那页边角按实，停了片刻，收手，吹灯。";
    expect(inspectManuscript({ text: clean.repeat(8) }).warnings.some((w) => w.rule === "manuscript.syntactic-tic")).toBe(false);
    const tics = "这不是笔歇的静，是笔也竖着耳朵的静。他站了一息。又一息。半息。屋里静了三息。不是腿不行，是脚底不对。不是雨，是汗。这一顿不是停，是落款。".repeat(6);
    const report = inspectManuscript({ text: tics });
    expect(report.warnings.some((w) => w.rule === "manuscript.syntactic-tic")).toBe(true);
    // 反例：「是不是A，是不是B」枚举不得计入对比复句（ch118 ¶12 误伤实证收口）——
    // 纯枚举高密度重复不触发；真实对比的触发用例见上。
    const enumeration = "他的眼先奔字去——是不是哪个字族他追过的，是不是旧式案头的写法，是不是哪个格子里的代号。眼在字上走了半遍，落空。他把册页合上，重新点了灯。".repeat(8);
    expect(inspectManuscript({ text: enumeration }).warnings.some((w) => w.rule === "manuscript.syntactic-tic")).toBe(false);
    // warning 级不拦截：passed 不受 tic 影响。
    expect(report.passed).toBe(true);
  });

  it("计量刻度词按单位开放集计数（F2：单测「息」式会被改述绕过，2026-09-17 全量复扫修正）", () => {
    // 命中面：同族计量词——半拍/半步/半寸/半分/三瞬/两晌/几刻，都是「刻度词+度量单位」，
    // 与「三息」同机制。旧判据只认「息」式，这些全部漏过（语料实测家族总量 10.8 倍增长
    // 而「息」式读数持续下降）。
    const halfFamily = "他站了半拍。往前挪了半步。袖口压下去半寸。笔尖收了半分。停了两晌，又过了三瞬，才起身。".repeat(6);
    const halfReport = inspectManuscript({ text: halfFamily });
    expect(halfReport.warnings.some((w) => w.rule === "manuscript.syntactic-tic")).toBe(true);
    // 反例面：不含刻度词的正常叙事（含"半天""一半""半步难移"等非计量用法之外的语汇）
    // 不得误伤——单位集只收度量单字，不收"天/年/半"等可独立成词的语素。
    const cleanScale = "他把案上那摞册子搬到里屋，擦了一遍柜面。半天过去，雨停了，窗外的人开始收摊。他把该做的事做完，合门回屋，点灯睡下。".repeat(8);
    expect(inspectManuscript({ text: cleanScale }).warnings.some((w) => w.rule === "manuscript.syntactic-tic")).toBe(false);
  });

  it("段落呼吸扁平 warning：全章段长趋同且无短段才报（F1：等量配额的产物，2026-09-17 新增）", () => {
    // 命中形态（照 ch167 泛化：17 段、cv≈0.07、无一段 ≤20 字）：每段一个动作、长度接近。
    const flat = "他把镇纸从案面挪开，手指压住纸角，等纸面平下来，才把笔从架上取下。\n\n"
      + "灯芯正过，火苗立稳，光圈的边收齐了，他把袖口挽到腕后，露出写字的手腕。\n\n"
      + "他把刻本翻到旧例那条，压在台角，又看了一眼案面，确认再没有别的东西。\n\n"
      + "笔尖悬在纸上方，悬了一会儿才落，落下去的第一笔很慢，慢得能看清笔画的走向。\n\n"
      + "每一个转折处他都要停一下，不提笔，等一口气匀匀过完，再接着往下走。\n\n"
      + "写到收笔，他把习惯的那个钩收住了，笔尖离开纸面前驻了一下，墨没有荡开。\n\n"
      + "他把笔搁回架里，没有再蘸第二回，纸上除了那一个字，什么都没有。\n\n"
      + "写完他把纸翻过来，正面对着自己看，那道反痕很淡，不凑近看不清。\n\n"
      + "吹灯之前，他把镇纸挪开三分，没有再看第二眼，俯身把灯吹熄了。";
    expect(inspectManuscript({ text: flat }).warnings.some((w) => w.rule === "manuscript.paragraph-rhythm")).toBe(true);
    // 反例一：有真正的短段（长段造压+短段落刀）→ 不报。
    const withShort = flat + "\n\n完。";
    expect(inspectManuscript({ text: withShort }).warnings.some((w) => w.rule === "manuscript.paragraph-rhythm")).toBe(false);
    // 反例二：段长本身有张力（长段与短段共存）→ 不报。
    const varied = "他把案上三样东西按次序摆开，先摆刻本，再摆草纸，最后把笔搁在右手边一指处，"
      + "每一样都摆得与平日分毫不差，像是怕案面记住他今日的不同。\n\n收。\n\n"
      + "然后他坐着，等天光从窗纸那头一点点移过来，照到案沿，照到笔杆，照到他压在膝上的手背。\n\n"
      + "雨意从西边压过来的时候，他已经把该收的都收了，只留一页空纸在案心，等明日的人来取。";
    expect(inspectManuscript({ text: varied }).warnings.some((w) => w.rule === "manuscript.paragraph-rhythm")).toBe(false);
    // 反例三：段数不足 8（短章样本不足以判断呼吸形态）→ 不报。
    expect(inspectManuscript({ text: "他把笔搁下。\n\n停了一会儿。\n\n又拿起来。" }).warnings.some((w) => w.rule === "manuscript.paragraph-rhythm")).toBe(false);
  });

  it("元数据/拉丁/段制坍缩三类结构 warning 双向（ch94、ch35、ch88 实证形态，泛化判据）", () => {
    // 命中面：阿拉伯章序、英文残留（正文形态照 ch94/ch35 泛化，不用专名）。
    const leaking = [
      "他把呈本放回案头，想起第70章进格的那个人，手停了一下。",
      "邻座的人 shrug 了一下，继续翻册子。",
    ].join("\n\n");
    const report = inspectManuscript({ text: leaking });
    expect(report.warnings.some((w) => w.rule === "manuscript.meta-reference")).toBe(true);
    expect(report.warnings.some((w) => w.rule === "manuscript.latin-residue")).toBe(true);
    expect(report.passed).toBe(true); // warning 级不拦截
    // 反例面：汉字章序指涉（叙内合法称呼）与纯中文正文不误伤。
    const clean = "他想起第七章里写的那条规矩，落笔照办。窗外雨声匀了又停，他把纸角按实，收手，吹灯。";
    const cleanReport = inspectManuscript({ text: clean.repeat(30) });
    expect(cleanReport.warnings.some((w) => w.rule === "manuscript.meta-reference")).toBe(false);
    expect(cleanReport.warnings.some((w) => w.rule === "manuscript.latin-residue")).toBe(false);
    // 段制坍缩面：ch88 形态（超长段、无换行）与正常段长分布双向。
    const fusedParagraph = "他把白日的每一件事按顺序摆开，先是从岗棚前那一格空白说起，说到新墨框边上那道极浅的弧，说到折纸慢下来的那一线，说到袖口里按过两次的闩声，说到暗层里换了位置的窄纸，说到膝盖不疼这件事本身。".repeat(6);
    expect(inspectManuscript({ text: [fusedParagraph, fusedParagraph, fusedParagraph, fusedParagraph, fusedParagraph].join("\n\n") }).warnings.some((w) => w.rule === "manuscript.paragraph-fusion")).toBe(true);
    const normalParagraphs = ["雨没下来，云压得低。", "他在棚前报了名，画押，退开。", "回屋路上数完四十七步，落脚进屋。", "闩门，点灯，摊开存形录。", "今夜只添一行：空，被人碰过。"].join("\n\n");
    expect(inspectManuscript({ text: normalParagraphs }).warnings.some((w) => w.rule === "manuscript.paragraph-fusion")).toBe(false);
    // Markdown 泄漏双向：ch52 形态命中；中文正文含"首行缩进两格"不误伤（# 不在文中）。
    expect(inspectManuscript({ text: "他按名册点验。**丙后第三日，补发房收。**灯下再读一遍。" }).warnings.some((w) => w.rule === "manuscript.markdown-leak")).toBe(true);
    expect(inspectManuscript({ text: normalParagraphs }).warnings.some((w) => w.rule === "manuscript.markdown-leak")).toBe(false);
  });

  it("章末仪式化 warning：近章末句普遍短促达阈值才报，缺省无跨章语境不触发（2026-09-18 新增）", () => {
    // 命中面：含本章在内的窗口内，多数章的末段以短促断句收束（纯长度判据，不用任何词表）。
    const chapter = [
      "天光从窗纸那头移过来的时候，他才把案上的东西一一归位，又把册子合上压平。",
      "他躺下了。",
    ].join("\n\n");
    const repeated = [
      "他把案上三样东西按次序点了一遍，又把册子归回暗层，确认没有别的东西留在外面。他躺下了。",
      "灯芯正过。他看了那页纸一眼，慢慢把灯放下。他闭上了眼。",
      "他站在原地想了很久，还是把那张单子折好收进袖子。他往里挪了挪。",
      "雨点打在檐下。他听了半晌，确认外面没有再响。他收起了笔。",
      "他把笔搁回架上，吹了灯。黑里那点浆屑安安静静地躺着。他睡了。",
    ];
    const hit = inspectManuscript({ text: chapter, priorEndings: repeated });
    expect(hit.warnings.some((w) => w.rule === "manuscript.ending-ritual")).toBe(true);
    expect(hit.passed).toBe(true); // warning 级不拦截

    // 反例一：窗口内末句形态各异（长句铺陈、多句、疑问、场景描写）→ 不报。
    const varied = inspectManuscript({
      text: chapter,
      priorEndings: [
        "他把药碗砸在地上，碎片溅了满鞋，血从指缝里渗出来，他没有去擦。",
        "她没回头。脚步在门外停住了，良久，才有一声极轻的叹息传进来。",
        "灯忽然灭了，没有人去点，也没有人问一句为什么。",
        "那句话他终究没有说出口，转身去牵马的缰绳在手里攥得很紧。",
        "窗外雨势渐急，打在檐下的青石上，溅起一层细密的水雾。",
      ],
    });
    expect(varied.warnings.some((w) => w.rule === "manuscript.ending-ritual")).toBe(false);

    // 反例二：窗口占比不足（只有少数章以短句收尾）→ 不报。
    const sparse = inspectManuscript({
      text: chapter,
      priorEndings: [
        "他把药碗砸在地上，碎片溅了满鞋，血从指缝里渗出来，他没有去擦。",
        "她没回头。脚步在门外停住了，良久，才有一声极轻的叹息传进来。",
        "灯忽然灭了，没有人去点，也没有人问一句为什么。",
        "他躺下了。",
        "那句话他终究没有说出口，转身去牵马的缰绳在手里攥得很紧。",
      ],
    });
    expect(sparse.warnings.some((w) => w.rule === "manuscript.ending-ritual")).toBe(false);

    // 反例三：缺省 priorEndings（单章语境）→ 该通道整体不触发，存量调用方零影响。
    const noContext = inspectManuscript({ text: chapter });
    expect(noContext.warnings.some((w) => w.rule === "manuscript.ending-ritual")).toBe(false);
  });
});
