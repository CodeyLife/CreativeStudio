import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type SampleProvenance = {
  workflowId: string;
  workflowStatus: "completed";
  artifactId: string;
  promptFingerprint: string;
  skillBundleFingerprint: string;
  model: string;
};

type VariantSample = {
  text: string;
  provenance: SampleProvenance;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function assertProvenance(value: unknown, source: string): asserts value is SampleProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid provenance: ${source}`);
  const item = value as Record<string, unknown>;
  for (const field of ["workflowId", "artifactId", "promptFingerprint", "skillBundleFingerprint", "model"] as const) {
    if (typeof item[field] !== "string" || !item[field]) throw new Error(`Missing ${field}: ${source}`);
  }
  if (item.workflowStatus !== "completed") throw new Error(`Workflow must be completed: ${source}`);
}

async function loadSample(root: string, chapter: number, run: number): Promise<VariantSample> {
  const directory = path.join(root, `chapter-${String(chapter).padStart(3, "0")}`);
  const textPath = path.join(directory, `run-${run}.txt`);
  const provenancePath = path.join(directory, `run-${run}.json`);
  const [text, rawProvenance] = await Promise.all([readFile(textPath, "utf8"), readFile(provenancePath, "utf8")]);
  if (!text.trim()) throw new Error(`Empty sample: ${textPath}`);
  const provenance: unknown = JSON.parse(rawProvenance);
  assertProvenance(provenance, provenancePath);
  return { text, provenance };
}

async function main(): Promise<void> {
  const baselineRoot = requiredOption("--baseline");
  const candidateRoot = requiredOption("--candidate");
  const output = path.resolve(option("--output") ?? path.join(".novel-bench", "comparisons", new Date().toISOString().replace(/[:.]/g, "-")));
  const pairs: Array<Record<string, unknown>> = [];
  const privateMapping: Array<Record<string, unknown>> = [];
  await mkdir(path.join(output, "pairs"), { recursive: true });

  let pairIndex = 0;
  for (const chapter of [1, 6]) {
    for (const run of [1, 2, 3]) {
      pairIndex += 1;
      const [baseline, candidate] = await Promise.all([loadSample(baselineRoot, chapter, run), loadSample(candidateRoot, chapter, run)]);
      const candidateFirst = (randomBytes(1)[0] & 1) === 1;
      const a = candidateFirst ? candidate : baseline;
      const b = candidateFirst ? baseline : candidate;
      const prefix = `pair-${String(pairIndex).padStart(2, "0")}`;
      await Promise.all([
        writeFile(path.join(output, "pairs", `${prefix}-A.txt`), a.text, "utf8"),
        writeFile(path.join(output, "pairs", `${prefix}-B.txt`), b.text, "utf8"),
      ]);
      pairs.push({ id: prefix, chapter, run, a: `pairs/${prefix}-A.txt`, b: `pairs/${prefix}-B.txt` });
      privateMapping.push({ id: prefix, chapter, run, A: candidateFirst ? "candidate" : "baseline", B: candidateFirst ? "baseline" : "candidate", baseline: baseline.provenance, candidate: candidate.provenance });
    }
  }

  const publicManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pairs,
    dimensions: [
      { id: "D1", name: "世界观", allowNotApplicable: true },
      { id: "D2", name: "故事性", allowNotApplicable: false },
      { id: "D3", name: "群像", allowNotApplicable: true },
      { id: "D4", name: "感情线", allowNotApplicable: true },
      { id: "D5", name: "幽默", allowNotApplicable: true },
    ],
    crossCuttingChecks: ["scene-embodiment", "causal-credibility", "interiority", "register-coherence", "rhythm", "continuity"],
  };
  const reviewForm = [
    "# 小说质量盲评",
    "",
    "每组只依据文本与章节功能选择 A、B 或持平。每个判断必须引用文本证据；D1/D3/D4/D5 可以标记不适用，不得为凑维度制造问题。",
    "",
    ...pairs.flatMap((pair) => [
      `## ${pair.id} · 第 ${pair.chapter} 章 · 第 ${pair.run} 次`,
      "",
      "- 总体偏好：A / B / 持平",
      "- D1 世界观：A / B / 持平 / 不适用；证据：",
      "- D2 故事性：A / B / 持平；证据：",
      "- D3 群像：A / B / 持平 / 不适用；证据：",
      "- D4 感情线：A / B / 持平 / 不适用；证据：",
      "- D5 幽默：A / B / 持平 / 不适用；证据：",
      "- 场景承载、因果可信度、内心活动、语域、节奏、连续性：",
      "- blocker/major 回归：",
      "",
    ]),
  ].join("\n");
  await Promise.all([
    writeFile(path.join(output, "manifest.json"), JSON.stringify(publicManifest, null, 2), "utf8"),
    writeFile(path.join(output, "review.md"), reviewForm, "utf8"),
    writeFile(path.join(output, "mapping.private.json"), JSON.stringify({ baselineRoot, candidateRoot, pairs: privateMapping }, null, 2), "utf8"),
  ]);
  console.log(JSON.stringify({ ok: true, output, pairs: pairs.length }, null, 2));
}

await main();
