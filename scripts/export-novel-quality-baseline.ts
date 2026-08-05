import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";

type JsonRow = Record<string, unknown>;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 80);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const projectId = option("--project-id") ?? "novel-create-wanfa-20260801";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp";
const bucket = process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "ymcp-novel";
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? "ymcp",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "ymcp-minio-local",
  },
});

async function getText(key: string): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error(`Object has no body: ${key}`);
  return object.Body.transformToString();
}

async function queryRows(pool: Pool, sql: string, values: unknown[] = []): Promise<JsonRow[]> {
  return (await pool.query<JsonRow>(sql, values)).rows;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const projects = await queryRows(pool, "SELECT * FROM novel_projects WHERE id=$1", [projectId]);
    if (projects.length !== 1) throw new Error(`Project not found: ${projectId}`);
    const revision = Number(projects[0].current_revision);
    const output = path.resolve(option("--output") ?? path.join(".novel-bench", "baselines", `${safeName(projectId)}-r${revision}`));
    if (await pathExists(output) && (await readdir(output)).length > 0) {
      throw new Error(`Output directory is not empty: ${output}`);
    }
    await mkdir(path.join(output, "chapters"), { recursive: true });
    await mkdir(path.join(output, "prompts"), { recursive: true });

    const documents = await queryRows(pool, `
      SELECT d.*,mr.revision,mr.base_revision,mr.content_hash,mr.artifact_id,cb.object_key,cb.byte_length,cb.word_count
      FROM manuscript_documents d
      JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      WHERE d.project_id=$1 ORDER BY d.narrative_order
    `, [projectId]);

    for (const document of documents) {
      const text = await getText(String(document.object_key));
      const file = `${String(document.narrative_order).padStart(3, "0")}-${safeName(String(document.title))}.txt`;
      await writeFile(path.join(output, "chapters", file), text, "utf8");
      document.textFile = `chapters/${file}`;
    }

    const workflows = await queryRows(pool, "SELECT * FROM workflow_runs WHERE project_id=$1 ORDER BY created_at,id", [projectId]);
    const workflowIds = workflows.map((row) => String(row.id));
    const promptExecutions = workflowIds.length
      ? await queryRows(pool, "SELECT * FROM prompt_executions WHERE workflow_run_id=ANY($1::text[]) ORDER BY created_at,id", [workflowIds])
      : [];
    for (const execution of promptExecutions) {
      for (const field of ["prompt_object_key", "response_object_key"] as const) {
        const key = execution[field];
        if (typeof key !== "string" || !key) continue;
        try {
          const suffix = field === "prompt_object_key" ? "prompt" : "response";
          const file = `${safeName(String(execution.id))}.${suffix}.txt`;
          await writeFile(path.join(output, "prompts", file), await getText(key), "utf8");
          execution[`${suffix}_file`] = `prompts/${file}`;
        } catch (error) {
          execution[`${field}_read_error`] = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const [artifacts, reviews, modelInvocations, skillBundles, executionBlueprints, memoryBundles] = await Promise.all([
      queryRows(pool, "SELECT * FROM artifacts WHERE project_id=$1 ORDER BY created_at,id", [projectId]),
      queryRows(pool, "SELECT * FROM reviews WHERE project_id=$1 ORDER BY created_at,id", [projectId]),
      workflowIds.length ? queryRows(pool, "SELECT * FROM model_invocations WHERE workflow_run_id=ANY($1::text[]) ORDER BY created_at,id", [workflowIds]) : [],
      queryRows(pool, "SELECT * FROM skill_bundles WHERE project_id=$1 ORDER BY created_at,id", [projectId]),
      queryRows(pool, "SELECT * FROM execution_blueprints WHERE project_id=$1 ORDER BY created_at,id", [projectId]),
      queryRows(pool, "SELECT * FROM memory_bundles WHERE project_id=$1 ORDER BY created_at,id", [projectId]),
    ]);

    const manifest = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: { projectId, databaseUrl: databaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@"), bucket },
      project: projects[0],
      documents,
      artifacts,
      reviews,
      workflows,
      promptExecutions,
      modelInvocations,
      skillBundles,
      executionBlueprints,
      memoryBundles,
      evaluationSamples: [
        { narrativeOrder: 1, chapterFunction: "high-pressure-action", title: documents.find((row) => Number(row.narrative_order) === 1)?.title },
        { narrativeOrder: 6, chapterFunction: "low-action-observation-and-deliberation", title: documents.find((row) => Number(row.narrative_order) === 6)?.title },
      ],
    };
    await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, output, projectId, revision, documents: documents.length, reviews: reviews.length, prompts: promptExecutions.length }, null, 2));
  } finally {
    await pool.end();
  }
}

await main();
