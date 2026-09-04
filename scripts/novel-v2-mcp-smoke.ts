/**
 * MCP 网关冒烟测试：通过 novel-v2 MCP 网关 executeTool 真实驱动短剧创意生成。
 *
 * 与 scripts/novel-v2-script-validate.ts 区别：validate 直接调应用层
 * generateShortScriptH3；本脚本走 MCP 网关分派 executeTool（与真实 MCP server
 * 同一段代码），验证「外部 MCP 接手短剧内容产出」的工具链路本身可用。
 *
 * 两种模式：
 *   A. 单生成（默认）：novel_short_script_h3(idea, targetDurationSeconds[, instruction])
 *      - 真实 LLM 生成成功 → 打印片段 promptText
 *      - 失败（沙箱无外网/密钥不可用）→ 降级走 novel_short_script_h3_submit 双轨
 *   B. 候选模式（--candidates N ≥ 2）：先直接调模型网关穷举 N 个截然不同的具体奇观，
 *      再逐个走 novel_short_script_h3 真实生成，用于证明开放命题也能产出多样非默认母题。
 *
 * 参数：--idea "..."  --duration 15  --instruction "..."  --candidates 3
 */
import { writeFileSync } from "node:fs";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { resolveNovelRuntimeConfig } from "../src/novel-v2/runtime-config";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { bindRuntimeObjectStore } from "../src/novel-v2/runtime-object-store";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import { createConfiguredSkillProvider } from "../src/novel-v2/skill-runtime";
import { executeTool } from "../src/novel-v2/mcp";
import type { ToolContext } from "../src/novel-v2/mcp/types";

const pickArg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// 默认复用便利店创意；--idea 覆盖，--duration 改时长（秒），--instruction 改变源指纹绕过幂等，
// --candidates N（≥2）进入候选模式。
const IDEA =
  pickArg(
    "idea",
    "深夜便利店的店主发现每晚十一点整都会来一位只买同一种关东煮的沉默客人，直到某晚对方留下一张写着他自己名字的字条，而字迹正是十年前失踪的合伙人留下的。",
  );
const DURATION = Number(pickArg("duration", "30")) || 30;
const INSTRUCTION = pickArg("instruction", "");
const CANDIDATES = Number(pickArg("candidates", "0")) || 0;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）——沙箱可能无法访问外部模型网关`)), ms),
    ),
  ]);

function summarizeResponse(response: { isError?: boolean; content?: Array<{ text: string }> }): any {
  const text = response.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const buildWonderSchema = (n: number) => ({
  type: "object",
  properties: { wonders: { type: "array", items: { type: "string" }, minItems: n, maxItems: n } },
  required: ["wonders"],
  additionalProperties: false,
});

/** 直接调模型网关，从开放创意方向穷举 N 个截然不同的具体奇观。 */
async function brainstormWonders(ctx: ToolContext, idea: string, n: number): Promise<string[]> {
  const system =
    "你是东方仙侠短剧的创意策划，擅长把开放的世界观方向转化为具体、可拍、有视觉奇观的短剧创意。";
  const prompt =
    `给定一句开放的核心创意方向，请穷举提出 ${n} 个彼此截然不同、各自拥有独立核心奇观意象的短剧创意。\n` +
    `要求：\n` +
    `1. 每个创意必须是具体可拍的视觉奇观，明确写出"核心意象是什么"（如某种悬浮建筑、自然现象、法器、生灵、天地异象）；\n` +
    `2. 各创意之间核心意象必须明显不同，不得雷同；\n` +
    `3. 避免出现"倒悬巨钟/钟"这类已被用烂的母题；\n` +
    `4. 保持东方仙侠气质与"云上"场景。\n` +
    `核心创意方向：${idea}\n` +
    `请直接输出 ${n} 个创意字符串（每个一两句话，含具体核心意象）。`;
  const result = await ctx.model.generateStructured<{ wonders: string[] }>({
    purpose: "writing.script",
    system,
    prompt,
    schema: buildWonderSchema(n),
    schemaName: "short-script-wonders",
    maxTokens: 2000,
  });
  return (result.value?.wonders ?? []).slice(0, n);
}

/** 单生成模式：真实 LLM 生成，失败降级到 submit 外部产出双轨。返回生成的记录对象。 */
async function runSingleMode(ctx: ToolContext): Promise<unknown> {
  console.log(`\n===== [2/3] novel_short_script_h3(idea, targetDurationSeconds=${DURATION}${INSTRUCTION ? `, instruction="${INSTRUCTION}"` : ""}) 真实 LLM 生成 =====`);
  try {
    const genResp = await withTimeout(
      executeTool("novel_short_script_h3", { idea: IDEA, instruction: INSTRUCTION, targetDurationSeconds: DURATION }, ctx),
      120_000,
      "novel_short_script_h3",
    );
    const gen = summarizeResponse(genResp) as { isError?: boolean; segments?: unknown[]; scriptId?: string; reused?: boolean; error?: string };
    if (genResp.isError || gen.error) throw new Error(gen.error ?? "unknown error");
    console.log(`  ✓ 生成成功（scriptId=${gen.scriptId}，复用=${gen.reused ?? false}，片段数=${(gen.segments ?? []).length}）`);
    const sample = (gen.segments ?? [])[0] as { index?: number; title?: string; promptText?: string } | undefined;
    if (sample) {
      console.log(`  --- 片段 #${sample.index ?? 0}（${sample.title ?? ""}）promptText 预览 ---`);
      console.log("  " + (sample.promptText ?? "").slice(0, 400).replace(/\n/g, "\n  "));
    }
    return gen;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ 真实 LLM 生成失败：${msg}`);
    console.log("  → 降级演示「外部 MCP 产出」双轨：用手写模型形态 JSON 走 novel_short_script_h3_submit\n");

    console.log("===== [3/3] novel_short_script_h3_submit(idea, 手写 payload) 外部产出双轨 =====");
    const payload = {
      plotBeats: [
        { beat: "opening", description: "便利店夜间常态，沉默客人第十一次出现" },
        { beat: "turn", description: "客人留下写有自己名字的字条" },
      ],
      characters: [
        { name: "店主", appearanceEn: "middle-aged convenience store owner in apron", role: "witness" },
        { name: "沉默客人", appearanceEn: "pale regular in dark coat", role: "the vanished partner" },
      ],
      segments: [
        {
          index: 0,
          title: "夜班常态",
          synopsis: "便利店灯光下，店主与沉默客人的固定仪式",
          durationSeconds: 12,
          subjectDefinitions: "<Subject 1> is the silence-locked convenience store at 23:00, fluorescent hum over aisles.",
          summary: "[reference generation] 店主身后货架，沉默客人取走关东煮，不抬头。",
          retentionAnalysis: "<Subject 1> fully_preserved: 灯色与货架秩序在每镜延续。",
          detailedDescription:
            "[Shot 1] 中景，店主擦柜台（构图：柜台横线分割画面），暖白顶光落在手背；[Shot 2] 客人入画取关东煮，侧光勾出大衣轮廓，无对白；运镜缓慢前推，停留于他放下零钱的手。",
          overallSoundscape: "底层：便利店白噪与远处车声；间歇：关东煮沸腾声。",
          nonDiegeticMusic: "低音钢琴单音，重复如心跳。",
        },
        {
          index: 1,
          title: "字条",
          synopsis: "客人留下写有自己名字的字条，字迹属于十年前失踪的合伙人",
          durationSeconds: 13,
          subjectDefinitions: "<Subject 1> is the handwritten note, ink trembling at the edges.",
          summary: "[reference generation] 字条特写，店主瞳孔收缩。",
          retentionAnalysis: "<Subject 1> fully_preserved: 姓名与笔迹特征成为后续钩子。",
          detailedDescription:
            "[Shot 1] 客人推门离开，风铃响；[Shot 2] 特写字条，姓名清晰，笔锋与旧合伙人的签批一致；[Shot 3] 店主抬头，瞳孔收缩，暖光转冷。运镜：字条停留 2 秒后急推瞳孔。",
          overallSoundscape: "风铃余响后骤停，环境声抽离。",
          nonDiegeticMusic: "钢琴单音悬停，不解决。",
        },
      ],
    };
    const subResp = await executeTool(
      "novel_short_script_h3_submit",
      { idea: IDEA, instruction: INSTRUCTION, payload, targetDurationSeconds: DURATION },
      ctx,
    );
    const sub = summarizeResponse(subResp) as { isError?: boolean; scriptId?: string; origin?: string; segments?: unknown[]; error?: string };
    if (subResp.isError || sub.error) {
      console.log("  ✗ submit 失败：", sub.error ?? JSON.stringify(sub).slice(0, 300));
      return null;
    }
    console.log(`  ✓ 外部产出落库成功（scriptId=${sub.scriptId}，origin=${sub.origin}，片段数=${(sub.segments ?? []).length}）`);
    return sub;
  }
}

/** 候选模式：穷举 N 个具体奇观 → 逐个走 MCP 真实生成。 */
async function runCandidateMode(ctx: ToolContext, n: number): Promise<unknown[]> {
  console.log(`\n===== [2] 穷举 ${n} 个候选奇观（直接调模型网关 brainstorm）=====`);
  const wonders = await withTimeout(brainstormWonders(ctx, IDEA, n), 120_000, "brainstorm");
  console.log(`  ✓ 穷举出 ${wonders.length} 个候选：`);
  wonders.forEach((w, i) => console.log(`    ${i + 1}. ${w}`));

  console.log(`\n===== [3] 逐候选走 novel_short_script_h3 真实生成 =====`);
  const candidates: unknown[] = [];
  for (let i = 0; i < wonders.length; i++) {
    const w = wonders[i];
    console.log(`\n--- 候选 ${i + 1}/${wonders.length}：${w.slice(0, 56)}${w.length > 56 ? "…" : ""} ---`);
    try {
      const resp = await withTimeout(
        executeTool("novel_short_script_h3", { idea: w, targetDurationSeconds: DURATION }, ctx),
        120_000,
        `gen#${i + 1}`,
      );
      const gen = summarizeResponse(resp) as { isError?: boolean; segments?: unknown[]; scriptId?: string; reused?: boolean; error?: string; title?: string };
      if (resp.isError || gen.error) throw new Error(gen.error ?? "unknown error");
      const title = (gen.segments ?? [])[0] ? ((gen.segments as any[])[0].title ?? "") : "";
      console.log(`  ✓ 生成成功（scriptId=${gen.scriptId}，复用=${gen.reused ?? false}，片段数=${(gen.segments ?? []).length}，标题=${title}）`);
      candidates.push({ idea: w, instruction: "", targetDurationSeconds: DURATION, generated: gen });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ 候选 ${i + 1} 生成失败：${msg}`);
      candidates.push({ idea: w, instruction: "", targetDurationSeconds: DURATION, generated: null, error: msg });
    }
  }
  return candidates;
}

async function main() {
  Object.assign(process.env, loadRuntimeEnv(process.cwd()));
  const runtime = resolveNovelRuntimeConfig(process.env);
  const repository = new NovelPostgresRepository(runtime.databaseUrl);
  const skillProvider = createConfiguredSkillProvider({
    source: process.env.NOVEL_SKILL_SOURCE,
    databaseList: (projectId) => repository.listSkills(projectId),
  });
  const objects = new ContentObjectStore();
  await bindRuntimeObjectStore(repository, objects, "api");
  const { gateway: model } = await createRuntimeModelGateway(repository, objects);

  const ctx: ToolContext = { repository, model, objects, skills: skillProvider };

  console.log("===== [1/3] novel_skill_get(executionPoint=short.script) =====");
  const skillResp = await executeTool("novel_skill_get", { executionPoint: "short.script" }, ctx);
  const skill = summarizeResponse(skillResp) as { skillText?: string; resolvedSkills?: unknown[]; isError?: boolean };
  if (skillResp.isError || !skill.skillText) {
    console.log("  ✗ skill 读取失败：", JSON.stringify(skill).slice(0, 300));
  } else {
    console.log(`  ✓ 已读取 skill 方法论（字符数 ${skill.skillText.length}）`);
    console.log(`  resolvedSkills: ${(skill.resolvedSkills as unknown[] | undefined)?.map((s) => (s as { skillId: string }).skillId).join(", ")}`);
  }

  let reportInput: unknown;
  if (CANDIDATES >= 2) {
    const candidates = await runCandidateMode(ctx, CANDIDATES);
    reportInput = { mode: "candidates", idea: IDEA, candidates };
  } else {
    const generated = await runSingleMode(ctx);
    reportInput = { idea: IDEA, instruction: INSTRUCTION, targetDurationSeconds: DURATION, generated };
  }

  const reportPath = "tmp/mcp-smoke-report.json";
  writeFileSync(reportPath, JSON.stringify(reportInput, null, 2), "utf8");
  console.log(`\n报告已写入 ${reportPath}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("harness 异常：", error);
  process.exit(1);
});
