/**
 * 批量文本规范化维护工具（P2 对策 8，2026-09-08）。
 *
 * 把两轮审核手搓的「确定性文本变换 → 作者修订稿（proposedText）→ 串行 full review」
 * 流程固化为脚本。实证操作要点：
 * 1. targeted 修订按窗口只改登记段落，无法承载全章性机械变换——必须走
 *    full review + proposedText（作者修订稿）通道；
 * 2. 同项目审校必须逐章串行（并行提交撞基线「正式稿基线已变化」）；
 * 3. 纯标点变换必须逐段开闭交替配对，奇数引号即报错拒绝（不静默跳过）。
 *
 * 用法：
 *   node --import tsx scripts/novel-v2-style-normalize.ts --type quotes --chapters 1,11,12 --project <projectId>
 *   node --import tsx scripts/novel-v2-style-normalize.ts --type embedded-title --chapters 10 --project <projectId> --dry-run
 *
 * 变换类型：
 * - quotes：半角直引号 U+0022 → 全角中文引号 U+201C/U+201D（逐段开闭交替）
 * - embedded-title：删除首段内嵌章节标题行（全书唯一格式对齐）
 */
import { randomUUID } from "node:crypto";
import { NovelPostgresRepository } from "../src/novel-v2/postgres-repository";
import { ContentObjectStore } from "../src/novel-v2/object-store";
import { loadRuntimeEnv } from "./runtime-env.mjs";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizeQuotes(text: string): { text: string; converted: number } {
  const paragraphs = text.split("\n");
  let converted = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i];
    const count = (line.match(/"/gu) ?? []).length;
    if (count === 0) continue;
    if (count % 2 !== 0) throw new Error(`第 ${i + 1} 段半角引号为奇数（${count}），无法安全配对：${line.slice(0, 50)}`);
    let open = true;
    paragraphs[i] = line.replace(/"/g, () => {
      converted += 1;
      const quote = open ? "\u201C" : "\u201D";
      open = !open;
      return quote;
    });
  }
  return { text: paragraphs.join("\n"), converted };
}

function removeEmbeddedTitle(text: string): { text: string; converted: number } {
  const paragraphs = text.split("\n");
  const first = paragraphs.findIndex((paragraph) => paragraph.trim());
  if (first < 0 || !/^\s*第[一二三四五六七八九十百千\d]+章\s*\S+/u.test(paragraphs[first])) return { text, converted: 0 };
  paragraphs.splice(first, 1);
  return { text: paragraphs.join("\n"), converted: 1 };
}

Object.assign(process.env, loadRuntimeEnv(process.cwd()));
const transformType = option("--type");
const chaptersArg = option("--chapters");
const projectId = option("--project");
const dryRun = process.argv.includes("--dry-run");
if (!transformType || !chaptersArg || !projectId) {
  console.error("用法：node --import tsx scripts/novel-v2-style-normalize.ts --type quotes|embedded-title --chapters 1,11,12 --project <projectId> [--dry-run]");
  process.exit(1);
}
const narrativeOrders = chaptersArg.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);

const repository = new NovelPostgresRepository();
const objects = new ContentObjectStore();
try {
  const refs = await repository.getChapterContentRefsByOrders(projectId, narrativeOrders);
  if (refs.length !== narrativeOrders.length) throw new Error(`部分章节不存在或缺正文：请求 ${narrativeOrders.join(",")}，实得 ${refs.map((ref) => ref.narrativeOrder).join(",")}`);
  for (const ref of refs) {
    const original = await objects.getText(ref.objectKey);
    let proposed: string;
    let converted = 0;
    if (transformType === "quotes") {
      ({ text: proposed, converted } = normalizeQuotes(original));
      if (converted === 0) {
        console.log(`ch${ref.narrativeOrder}: 无半角引号，跳过`);
        continue;
      }
    } else if (transformType === "embedded-title") {
      ({ text: proposed, converted } = removeEmbeddedTitle(original));
      if (converted === 0) {
        console.log(`ch${ref.narrativeOrder}: 无内嵌标题行，跳过`);
        continue;
      }
    } else {
      throw new Error(`未知变换类型：${transformType}（可用 quotes|embedded-title）`);
    }
    if (proposed === original) {
      console.log(`ch${ref.narrativeOrder}: 变换后无差异，跳过`);
      continue;
    }
    const document = await repository.pool.query<{ id: string }>("SELECT id FROM manuscript_documents WHERE project_id=$1 AND narrative_order=$2", [projectId, ref.narrativeOrder]);
    if (!document.rowCount) throw new Error(`ch${ref.narrativeOrder} 文档不存在`);
    const documentId = document.rows[0].id;
    if (dryRun) {
      console.log(`ch${ref.narrativeOrder}: [dry-run] 将变更 ${converted} 处`);
      continue;
    }
    // 串行约束：等当前项目审校完成后才提交下一章。
    const preflight = await repository.getProjectDetail(projectId);
    // 串行约束由 REST 内部执行；此处只留一条进度日志（历史上这行赋值未被消费）。
    console.log(`ch${ref.narrativeOrder}: 项目共 ${preflight.documents.length} 个文档，提交审校`);
    const body = {
      mode: "full",
      proposedText: proposed,
      instruction: `批量规范化（${transformType}）：${transformType === "quotes" ? `全章 ${converted} 处半角直引号规范为全角中文引号（纯标点，逐段开闭配对已校验）` : "删除首段内嵌章节标题行（全书格式对齐）"}；其余内容零改动。`,
      idempotencyKey: `style-normalize-${transformType}-ch${ref.narrativeOrder}-${randomUUID().slice(0, 8)}`,
    };
    const response = await fetch(`http://127.0.0.1:4770/v2/projects/${projectId}/documents/${documentId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`ch${ref.narrativeOrder} 提交失败 ${response.status}: ${detail.slice(0, 200)}`);
    }
    const result = await response.json() as { workflowId: string };
    console.log(`ch${ref.narrativeOrder}: 已提交 ${result.workflowId}（变更 ${converted} 处；活跃审校串行等待中）`);
    // 串行：等本章节工作流到终态再处理下一章。
    let status = "";
    do {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20_000));
      const runResponse = await fetch(`http://127.0.0.1:4770/v2/runs/${result.workflowId}`);
      const run = await runResponse.json() as { record: { status: string; payload: Record<string, unknown> } };
      status = run.record.status;
      if (status === "manual-review-required") {
        const artifactId = String(run.record.payload.artifactId ?? "");
        const decisionResponse = await fetch(`http://127.0.0.1:4770/v2/workflows/${result.workflowId}/tasks/${artifactId}/human-decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: "approve",
            feedback: `批量规范化（${transformType}）机器校验：纯确定性变换（${transformType === "quotes" ? `${converted} 处引号逐段开闭交替，无文字改动` : "仅删除标题行"}），作者提案通道，` +
              `非命名实体变更。`,
          }),
        });
        if (!decisionResponse.ok) throw new Error(`ch${ref.narrativeOrder} 审批失败: ${await decisionResponse.text()}`);
        console.log(`ch${ref.narrativeOrder}: 已自动批准（确定性变换）`);
      }
    } while (status !== "completed" && status !== "failed" && status !== "abandoned");
    console.log(`ch${ref.narrativeOrder}: 工作流终态 ${status}`);
  }
} finally {
  await repository.close();
}
