/**
 * 把 MCP 短剧生成的报告 JSON（tmp/mcp-smoke-report.json）导出为独立可读的
 * emerald + 深色风格 HTML，便于脱离 JSON 直接浏览/分享。
 *
 * 兼容两种报告形态：
 *   - 单生成：{ idea, instruction, targetDurationSeconds, generated }
 *   - 候选模式：{ candidates: [ { idea, instruction, targetDurationSeconds, generated }, ... ] }
 * 每种形态下每个 generated 各导出一份 <scriptId>.html。
 *
 * 用法：npx tsx scripts/export-short-script.ts [报告路径] [输出目录]
 * 默认读取 tmp/mcp-smoke-report.json，输出到 outputs/novel-v2-short-scripts/
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const reportPath = process.argv[2] ?? "tmp/mcp-smoke-report.json";
const outDir = process.argv[3] ?? "outputs/novel-v2-short-scripts";

interface Segment { index: number; title: string; synopsis: string; durationSeconds: number; promptText: string }
interface Beat { id: string; kind: string; summary: string }
interface Char { name: string; appearanceEn: string }
interface GenRecord {
  scriptId: string; sourceFingerprint: string; reused: boolean; mode: string;
  targetDurationSeconds: number; plotBeats: Beat[]; cinematicHints: string[];
  characterBaselines: Char[]; segments: Segment[]; nextAction?: string;
}
interface Entry { idea: string; instruction?: string; targetDurationSeconds?: number; generated: GenRecord | null; error?: string }

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const entries: Entry[] = Array.isArray(report.candidates)
  ? report.candidates.filter((c: Entry) => c && c.generated)
  : (report.generated ? [report as Entry] : []);

if (!entries.length) {
  console.log("报告无可导出内容（无 generated 记录）。");
  process.exit(0);
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SECTION_LABELS: Record<string, string> = {
  subject_definitions: "主体定义 · Subject Definitions",
  summary: "概要 · Summary",
  retention_analysis: "一致性分析 · Retention Analysis",
  detailed_description: "镜头详述 · Detailed Description",
  overall_soundscape: "整体声景 · Soundscape",
  non_diegetic_music: "非叙事音乐 · Music",
};

function renderPrompt(text: string): string {
  const headerRe = /^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):$/m;
  const parts = text.split(headerRe);
  let html = "";
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i];
    const body = (parts[i + 1] ?? "").trim();
    html += `<div class="sec"><div class="sec-label">${SECTION_LABELS[key] ?? key}</div><pre>${escapeHtml(body)}</pre></div>`;
  }
  return html || `<pre>${escapeHtml(text)}</pre>`;
}

const renderBeats = (beats: Beat[]): string =>
  beats.map((b) => `<li><span class="beat-kind">${escapeHtml(b.kind)}</span> <span class="beat-id">${escapeHtml(b.id)}</span> — ${escapeHtml(b.summary)}</li>`).join("");

const renderChars = (chars: Char[]): string =>
  !chars.length ? `<p class="muted">（无角色基线）</p>`
    : chars.map((c) => `<li><strong>${escapeHtml(c.name)}</strong><br><span class="muted">${escapeHtml(c.appearanceEn)}</span></li>`).join("");

const renderHints = (hints: string[]): string =>
  !hints.length ? `<p class="muted">（无）</p>` : hints.map((h) => `<li>${escapeHtml(h)}</li>`).join("");

const buildHtml = (entry: Entry, gen: GenRecord): string => {
  const segmentsHtml = gen.segments.map((seg) => `
  <article class="segment">
    <header class="seg-head">
      <span class="seg-index">片段 #${seg.index}</span>
      <h3>${escapeHtml(seg.title)}</h3>
      <span class="seg-dur">${seg.durationSeconds}s</span>
    </header>
    <p class="seg-synopsis">${escapeHtml(seg.synopsis)}</p>
    <div class="prompt">${renderPrompt(seg.promptText)}</div>
  </article>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>短剧脚本 · ${escapeHtml(gen.scriptId)}</title>
<style>
  :root { --bg:#0b0f0e; --panel:#111a17; --panel-2:#0e1513; --emerald:#34d399; --emerald-dim:#10b981;
    --text:#d7e4df; --muted:#7c8b85; --line:#1d2a25; --gold:#e8c87a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font-family: ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; line-height:1.65; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 1.6rem; color: var(--emerald); margin: 0 0 4px; letter-spacing:.5px; }
  .sub { color: var(--muted); font-size: .9rem; margin-bottom: 24px; }
  .meta { display:flex; flex-wrap:wrap; gap:8px 18px; background:var(--panel-2);
    border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:24px; font-size:.85rem; }
  .meta b { color:var(--emerald); font-weight:600; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:22px; }
  .card h2 { margin:0 0 12px; font-size:1.05rem; color:var(--emerald); border-left:3px solid var(--emerald-dim); padding-left:10px; }
  ul { margin:8px 0; padding-left:20px; } li { margin:4px 0; }
  .beat-kind, .beat-id { font-family: ui-monospace, monospace; font-size:.8rem; color:var(--emerald); }
  .beat-id { color:var(--muted); }
  .muted { color:var(--muted); }
  .segment { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin-bottom:22px; }
  .seg-head { display:flex; align-items:baseline; gap:12px; border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:12px; }
  .seg-index { font-family:ui-monospace,monospace; color:var(--emerald); font-size:.85rem; }
  .seg-head h3 { margin:0; font-size:1.1rem; color:var(--text); flex:1; }
  .seg-dur { font-family:ui-monospace,monospace; color:var(--gold); font-size:.85rem; }
  .seg-synopsis { color:var(--text); margin: 0 0 14px; }
  .sec { margin: 12px 0; }
  .sec-label { font-size:.78rem; text-transform:uppercase; letter-spacing:.8px; color:var(--emerald-dim); margin-bottom:4px; }
  pre { background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:12px 14px;
    white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "SFMono-Regular", monospace;
    font-size:.82rem; color:#c9d8d2; margin:0; }
  .next { color:var(--muted); font-size:.82rem; border-top:1px dashed var(--line); padding-top:14px; margin-top:8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>短剧脚本 · 云上奇观</h1>
  <div class="sub">MiniMax H3 Ref2VA 全参考模式 · 通过 novel-v2 MCP 网关生成</div>
  <div class="meta">
    <span><b>scriptId</b> ${escapeHtml(gen.scriptId)}</span>
    <span><b>模式</b> ${escapeHtml(gen.mode)}</span>
    <span><b>时长</b> ${gen.targetDurationSeconds}s</span>
    <span><b>片段数</b> ${gen.segments.length}</span>
    <span><b>复用</b> ${gen.reused ? "是（既有产物）" : "否（新建）"}</span>
    <span><b>源指纹</b> <code>${escapeHtml(gen.sourceFingerprint.slice(0, 16))}…</code></span>
  </div>
  <div class="card">
    <h2>创意 & 导演指令</h2>
    <p><b>核心创意：</b>${escapeHtml(entry.idea ?? "")}</p>
    ${entry.instruction ? `<p><b>导演指令：</b>${escapeHtml(entry.instruction)}</p>` : ""}
  </div>
  <div class="card">
    <h2>剧情节拍（${gen.plotBeats.length}）</h2>
    <ul>${renderBeats(gen.plotBeats)}</ul>
  </div>
  <div class="card">
    <h2>角色基线（${gen.characterBaselines.length}）</h2>
    <ul>${renderChars(gen.characterBaselines)}</ul>
  </div>
  <h2 style="color:var(--emerald); margin:8px 0 14px;">片段详情</h2>
  ${segmentsHtml}
  <div class="card">
    <h2>零阻断结构观察（cinematicHints）</h2>
    <ul>${renderHints(gen.cinematicHints)}</ul>
  </div>
  ${gen.nextAction ? `<div class="next">${escapeHtml(gen.nextAction)}</div>` : ""}
</div>
</body>
</html>`;
};

mkdirSync(outDir, { recursive: true });
for (const entry of entries) {
  const gen = entry.generated as GenRecord;
  const html = buildHtml(entry, gen);
  const outPath = resolve(outDir, `${gen.scriptId}.html`);
  writeFileSync(outPath, html, "utf8");
  console.log(`已导出：${outPath}（${Buffer.byteLength(html, "utf8")} bytes）`);
}
