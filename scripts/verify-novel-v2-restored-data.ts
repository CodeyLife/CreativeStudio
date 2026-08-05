import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";

type CliOptions = {
  projectId: string;
  expectedRevision: number;
  expectedFinalDocuments: number;
  skipRuntime: boolean;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const options: CliOptions = {
  projectId: option("--project-id") ?? "novel-create-wanfa-20260801",
  expectedRevision: Number(option("--expected-revision") ?? 22),
  expectedFinalDocuments: Number(option("--expected-final-documents") ?? 6),
  skipRuntime: process.argv.includes("--skip-runtime"),
};

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

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function checkHttp(label: string, url: string): Promise<void> {
  const response = await fetch(url);
  invariant(response.ok, `${label} is not ready: ${response.status} ${response.statusText}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const databases = await pool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname",
      [["ymcp", "temporal", "temporal_visibility"]],
    );
    const databaseNames = databases.rows.map((row) => row.datname);
    invariant(databaseNames.length === 3, `Missing PostgreSQL databases: expected ymcp, temporal, temporal_visibility; found ${databaseNames.join(", ")}`);

    const project = await pool.query<{ current_revision: string | number; title: string }>(
      "SELECT title,current_revision FROM novel_projects WHERE id=$1",
      [options.projectId],
    );
    invariant(project.rowCount === 1, `Project not found: ${options.projectId}`);
    invariant(Number(project.rows[0].current_revision) === options.expectedRevision, `Project revision mismatch: expected ${options.expectedRevision}, got ${project.rows[0].current_revision}`);

    const documents = await pool.query<{
      id: string;
      title: string;
      narrative_order: string | number;
      status: string;
      content_hash: string;
      object_key: string;
    }>(`
      SELECT d.id,d.title,d.narrative_order,d.status,mr.content_hash,cb.object_key
      FROM manuscript_documents d
      JOIN manuscript_revisions mr ON mr.id=d.current_revision_id
      JOIN content_blobs cb ON cb.content_hash=mr.content_hash
      WHERE d.project_id=$1
      ORDER BY d.narrative_order
    `, [options.projectId]);
    invariant(documents.rowCount === options.expectedFinalDocuments, `Document count mismatch: expected ${options.expectedFinalDocuments}, got ${documents.rowCount}`);
    invariant(documents.rows.every((row) => row.status === "final"), "Not every restored document is final");

    for (const document of documents.rows) {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: document.object_key }));
      invariant(object.Body, `MinIO object has no body: ${document.object_key}`);
      const bytes = await object.Body.transformToByteArray();
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      invariant(actualHash === document.content_hash, `Content hash mismatch for chapter ${document.narrative_order} (${document.title})`);
    }

    const qdrantUrl = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
    const collection = process.env.QDRANT_COLLECTION ?? "novel-memory-current";
    const qdrant = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collection)}`);
    invariant(qdrant.ok, `Qdrant collection is unavailable: ${collection} (${qdrant.status})`);

    if (!options.skipRuntime) {
      await Promise.all([
        checkHttp("Novel API", process.env.NOVEL_API_READY_URL ?? "http://127.0.0.1:4770/ready"),
        checkHttp("Novel worker", process.env.NOVEL_WORKER_READY_URL ?? "http://127.0.0.1:4771/ready"),
        checkHttp("Web", process.env.NOVEL_WEB_URL ?? "http://127.0.0.1:5173"),
      ]);
    }

    console.log(JSON.stringify({
      ok: true,
      project: { id: options.projectId, title: project.rows[0].title, revision: options.expectedRevision },
      databases: databaseNames,
      documents: documents.rows.map((row) => ({ order: Number(row.narrative_order), title: row.title, status: row.status, contentHash: row.content_hash, objectKey: row.object_key })),
      qdrantCollection: collection,
      runtimeChecked: !options.skipRuntime,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

await main();
