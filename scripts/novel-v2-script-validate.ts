/**
 * 剧本生成真实链路验证脚本（chapter-script / short-script 双路径）。
 *
 * 用途：以真实 LLM 跑一次（或两次）剧本生成，产出可重复的指标报告：
 * - repair 触发率（model_invocations 中同一 workflow 的调用次数与 schema-validation 失败）
 * - cinematicHints 密度（提示级镜头语言缺失 / 片段数）
 * - 时长窗口命中（创意短剧总时长 vs 目标偏差）
 * - 剧作层 LLM 评审（题材无关维度：开场钩子 / 情绪节点节奏 / 出口钩子 / 伏笔-反转配对；
 *   文本意见契约：通过只输出单行 PASSED，复用 parseTextReview 解析）
 *
 * 用法：
 *   npx tsx scripts/novel-v2-script-validate.ts --project <projectId> \
 *     [--document <docId>] [--idea <创意文本>] [--duration 30] [--json <输出路径>]
 *
 * 说明：
 * - 幂等：与正式链路一致，同输入重放复用既有产物（reused=true 时不产生新调用记录）。
 * - 调用归因按「本次脚本运行时间窗 + workflow_run_id 前缀」过滤，验证脚本假定
 *   运行窗口内没有并发的其他剧本生成任务。
 */
import { writeFileSync } from "node:fs";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { bindRuntimeObjectStore } from "../src/novel-v2/runtime-object-store";
import { createRuntimeModelGateway } from "../src/novel-v2/model-runtime";
import { createConfiguredSkillProvider } from "../src/novel-v2/skill-runtime";
import { resolveNovelRuntimeConfig } from "../src/novel-v2/runtime-config";
import { loadRuntimeEnv } from "./runtime-env.mjs";
import { generateChapterScriptH3 } from "../src/novel-v2/application/chapter-script-h3";
import { generateShortScriptH3, DEFAULT_SHORT_SCRIPT_TARGET_SECONDS, MIN_IDEA_LENGTH, SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS } from "../src/novel-v2/application/short-script-h3";
import { parseTextReview } from "../src/novel-v2/text-review";
import type { ModelPurpose } from "../src/novel-v2/model-purposes";

/** 跨题材通用默认创意（谁/何处/冲突齐备，不绑定任何特定作品、题材或角色名）。 */
const DEFAULT_IDEA = "深夜便利店的店主发现每晚十一点整都会来一位只买同一种关东煮的沉默客人，直到某晚对方留下一张写着他自己名字的字条，而字迹正是十年前失踪的合伙人留下的。";

interface CliArgs {
  /** 可选关联作品：章节路径（--document）必填；创意短剧路径缺省为独立模式。 */
  project?: string;
  document?: string;
  idea: string;
  duration: number;
  jsonPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { idea: DEFAULT_IDEA, duration: DEFAULT_SHORT_SCRIPT_TARGET_SECONDS };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--project" && value) { args.project = value; index += 1; }
    else if (flag === "--document" && value) { args.document = value; index += 1; }
    else if (flag === "--idea" && value) { args.idea = value; index += 1; }
    else if (flag === "--duration" && value) { args.duration = Math.round(Number(value)) || DEFAULT_SHORT_SCRIPT_TARGET_SECONDS; index += 1; }
    else if (flag === "--json" && value) { args.jsonPath = value; index += 1; }
  }
  return args;
}

interface WorkflowInvocationStats {
  workflowRunId: string;
  invocations: number;
  schemaValidationFailures: number;
  inputTokens: number;
  outputTokens: number;
  latencyMsTotal: number;
}

async function collectInvocationStats(repository: NovelPostgresRepository, sinceMs: number): Promise<WorkflowInvocationStats[]> {
  // 归因：时间窗 + purpose=writing.script + 剧本 workflow 前缀（chapter-script: / short-script:）。
  const result = await repository.pool.query<{
    workflow_run_id: string;
    status: string;
    error_category?: string | null;
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
  }>(
    `SELECT workflow_run_id, status, error_category, input_tokens, output_tokens, latency_ms
     FROM model_invocations
     WHERE purpose='writing.script' AND created_at >= $1
       AND (workflow_run_id LIKE 'chapter-script:%' OR workflow_run_id LIKE 'short-script:%')
     ORDER BY created_at`,
    [sinceMs],
  );
  const byWorkflow = new Map<string, WorkflowInvocationStats>();
  for (const row of result.rows) {
    const entry = byWorkflow.get(row.workflow_run_id) ?? {
      workflowRunId: row.workflow_run_id,
      invocations: 0,
      schemaValidationFailures: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMsTotal: 0,
    };
    entry.invocations += 1;
    if (row.error_category === "schema-validation") entry.schemaValidationFailures += 1;
    entry.inputTokens += row.input_tokens ?? 0;
    entry.outputTokens += row.output_tokens ?? 0;
    entry.latencyMsTotal += row.latency_ms ?? 0;
    byWorkflow.set(row.workflow_run_id, entry);
  }
  return [...byWorkflow.values()];
}

/** 剧作层评审 prompt（题材无关维度；意见契约与规划级审核一致：通过只输出单行 PASSED）。 */
function buildDramaturgyReviewPrompt(kind: "chapter-script" | "short-script", scriptText: string): string {
  return [
    `你是短剧分镜剧本的剧作层审核员。以下是一条${kind === "chapter-script" ? "由小说章节改编" : "由核心创意生成"}的短剧分镜剧本（每个片段为一条 MiniMax H3 视频生成提示词）。`,
    "只从剧作层审核，忽略提示词格式与镜头语言细节：",
    "1. 开场钩子：第 1 个片段的前 3 秒是否落在冲突现场或临界点（直接冲突、强悬念、极致反差、身份落差、倒计时压力之一）；铺垫性开场视为失败。",
    "2. 情绪节点节奏：是否每 2-4 个片段落一个情绪节点（对话冲突、动作冲突或信息揭示），且前 1/3 片段内完成第一次小反转。",
    "3. 出口即钩子：每个片段的出口是否抛出问题或抬高压（未揭的身份、被推翻的假设、逼近的危险、两难抉择、逼近的期限）。",
    "4. 伏笔与反转：每个反转是否有前文已呈现的伏笔支撑（plant → overlook → detonate）。",
    "判定契约：全部达标时只输出单行 PASSED；任一维度不达标时，输出可执行的意见清单（每条注明片段序号、违反的维度、如何修改），不要输出其他总结。",
    "",
    "剧本全文：",
    scriptText,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.document && !args.project) {
    console.error("用法：npx tsx scripts/novel-v2-script-validate.ts [--project <projectId>（章节路径必填，创意路径可选关联）] [--document <docId>] --idea <创意文本> [--duration 30] [--json <输出路径>]");
    console.error("--document（章节剧本验证）必须与 --project 同用；创意短剧路径可独立运行（无 --project = 独立模式）");
    process.exit(1);
  }
  if (args.idea.trim().length < MIN_IDEA_LENGTH) {
    console.error(`--idea 至少 ${MIN_IDEA_LENGTH} 个字符（须写清谁、何处、什么冲突）`);
    process.exit(1);
  }

  Object.assign(process.env, loadRuntimeEnv(process.cwd()));
  const runtime = resolveNovelRuntimeConfig(process.env);
  const repository = new NovelPostgresRepository(runtime.databaseUrl);
  const skillProvider = createConfiguredSkillProvider({ source: process.env.NOVEL_SKILL_SOURCE, databaseList: (projectId) => repository.listSkills(projectId) });
  const objects = new ContentObjectStore();
  await bindRuntimeObjectStore(repository, objects, "api");
  const { gateway: model } = await createRuntimeModelGateway(repository, objects);

  const startedAt = Date.now();
  interface PathResult { ok: boolean; reused?: boolean; error?: string; reviewText?: string; [key: string]: unknown }
  const paths: Record<string, PathResult> = {};

  // ---------- 路径一：章节剧本（可选，须同时提供 --project） ----------
  if (args.document && args.project) {
    try {
      const record = await generateChapterScriptH3(
        { projectId: args.project, documentId: args.document },
        { repository, objects, model, skillProvider },
      );
      paths.chapterScript = {
        ok: true,
        reused: record.reused ?? false,
        artifactId: record.artifactId,
        segmentCount: record.segments.length,
        cinematicHintCount: record.cinematicHints.length,
        reviewText: record.segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n"),
      };
    } catch (error) {
      paths.chapterScript = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ---------- 路径二：创意短剧（--project 可选：缺省为独立模式） ----------
  try {
    const record = await generateShortScriptH3(
      { projectId: args.project, idea: args.idea, targetDurationSeconds: args.duration },
      { repository, objects, model, skillProvider },
    );
    const totalSeconds = record.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    paths.shortScript = {
      ok: true,
      reused: record.reused ?? false,
      scriptId: record.scriptId,
      targetDurationSeconds: record.targetDurationSeconds,
      totalSeconds,
      durationDeviationSeconds: Math.abs(totalSeconds - record.targetDurationSeconds),
      durationWithinTolerance: Math.abs(totalSeconds - record.targetDurationSeconds) <= SHORT_SCRIPT_TOTAL_DURATION_TOLERANCE_SECONDS,
      segmentCount: record.segments.length,
      cinematicHintCount: record.cinematicHints.length,
      cinematicHintDensity: record.segments.length ? Number((record.cinematicHints.length / record.segments.length).toFixed(2)) : 0,
      reviewText: record.segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n"),
    };
  } catch (error) {
    paths.shortScript = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // ---------- 指标采集：调用记录 ----------
  const invocations = (await collectInvocationStats(repository, startedAt)).map((workflow) => ({
    ...workflow,
    firstPassSuccess: workflow.invocations === 1 && workflow.schemaValidationFailures === 0,
  }));

  // ---------- 剧作层 LLM 评审 ----------
  // TODO P2: 评审结论回流 learning assessment 后，此报告同时作为闭环证据源。
  const reviewPurposes: ModelPurpose[] = ["review.prose", "review.structure", "writing.script"];
  for (const [kind, path] of Object.entries(paths)) {
    if (!path.ok || !path.reviewText) continue;
    const prompt = buildDramaturgyReviewPrompt(kind as "chapter-script" | "short-script", path.reviewText);
    let verdict: string | undefined;
    let opinion: string | undefined;
    let error: string | undefined;
    for (const purpose of reviewPurposes) {
      try {
        const result = await model.generateText({ purpose, prompt });
        const parsed = parseTextReview(result.text);
        verdict = parsed.verdict;
        opinion = parsed.opinion;
        break;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    delete path.reviewText; // 全文不入报告，评审结论与指标为准
    path.dramaturgyReview = verdict ? { verdict, opinion: opinion || "" } : { verdict: "error", opinion: error ?? "评审调用失败" };
  }

  // ---------- 输出 ----------
  const lines: string[] = [
    "===== 剧本生成真实链路验证报告 =====",
    `作用域：${args.project ? `关联作品 ${args.project}` : "独立模式（无关联作品）"}`,
    `时间：${new Date().toISOString()}`,
    "",
  ];
  if (paths.chapterScript) {
    lines.push(`[章节剧本] ${paths.chapterScript.ok ? "成功" : "失败"}${paths.chapterScript.reused ? "（复用既有产物）" : ""}`);
    if (paths.chapterScript.ok) {
      lines.push(`  片段数：${paths.chapterScript.segmentCount}；镜头语言提示：${paths.chapterScript.cinematicHintCount} 个`);
    } else {
      lines.push(`  错误：${paths.chapterScript.error}`);
    }
    if (paths.chapterScript.dramaturgyReview) lines.push(`  剧作层评审：${JSON.stringify(paths.chapterScript.dramaturgyReview)}`);
    lines.push("");
  }
  if (paths.shortScript) {
    lines.push(`[创意短剧] ${paths.shortScript.ok ? "成功" : "失败"}${paths.shortScript.reused ? "（复用既有产物）" : ""}`);
    if (paths.shortScript.ok) {
      lines.push(`  时长：目标 ${paths.shortScript.targetDurationSeconds}s / 实际 ${paths.shortScript.totalSeconds}s（偏差 ${paths.shortScript.durationDeviationSeconds}s，容差内=${paths.shortScript.durationWithinTolerance}）`);
      lines.push(`  片段数：${paths.shortScript.segmentCount}；镜头语言提示：${paths.shortScript.cinematicHintCount} 个（密度 ${paths.shortScript.cinematicHintDensity}）`);
    } else {
      lines.push(`  错误：${paths.shortScript.error}`);
    }
    if (paths.shortScript.dramaturgyReview) lines.push(`  剧作层评审：${JSON.stringify(paths.shortScript.dramaturgyReview)}`);
    lines.push("");
  }
  if (invocations.length) {
    lines.push("[模型调用]");
    for (const workflow of invocations) {
      lines.push(`  ${workflow.workflowRunId}：${workflow.invocations} 次调用，schema-validation 失败 ${workflow.schemaValidationFailures} 次，一次通过=${workflow.firstPassSuccess}，输入 ${workflow.inputTokens} tok / 输出 ${workflow.outputTokens} tok，总耗时 ${workflow.latencyMsTotal}ms`);
    }
    lines.push("");
  }
  console.log(lines.join("\n"));
  if (args.jsonPath) {
    writeFileSync(args.jsonPath, JSON.stringify({ startedAt: new Date(startedAt).toISOString(), projectId: args.project ?? null, scope: args.project ? "linked" : "independent", paths, invocations }, null, 2), "utf8");
    console.log(`JSON 报告已写入：${args.jsonPath}`);
  }
  process.exit(0);
}

await main();
