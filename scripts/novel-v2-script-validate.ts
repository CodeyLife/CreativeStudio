/**
 * 剧本生成真实链路验证脚本（chapter-script / short-script 双路径）。
 *
 * 用途：以真实 LLM 跑一次（或两次）剧本生成，产出可重复的指标报告：
 * - repair 触发率（model_invocations 中同一 workflow 的调用次数与 schema-validation 失败）
 * - cinematicHints 密度（提示级镜头语言缺失 / 片段数）
 * - 时长窗口命中（创意短剧总时长 vs 目标偏差）
 * 产物内容质量不在此评审（2026-09-03 用户指令删除剧作层 LLM 评审），
 * 以生成指标与人工复核为准。
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
  // sinceMs 是 Date.now() 毫秒值；PG timestamp 无法解析毫秒整数（22008 out of range），
  // 须转 ISO 字符串再绑定参数（此前直接绑毫秒值导致统计阶段必然崩溃，报告永远无法产出）。
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
    [new Date(sinceMs).toISOString()],
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

/** 剧作层 LLM 评审已按用户指令删除（2026-09-03）：产物质量以生成指标与人工复核为准。 */

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
  interface PathResult { ok: boolean; reused?: boolean; error?: string; [key: string]: unknown }
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
    };
  } catch (error) {
    paths.shortScript = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // ---------- 指标采集：调用记录 ----------
  const invocations = (await collectInvocationStats(repository, startedAt)).map((workflow) => ({
    ...workflow,
    firstPassSuccess: workflow.invocations === 1 && workflow.schemaValidationFailures === 0,
  }));

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
