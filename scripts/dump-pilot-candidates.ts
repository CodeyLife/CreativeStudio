import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const PROJECT_ID = "novel-create-wanfa-20260801";
const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
const fileRoot = join(process.cwd(), ".data", "objects");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, credentials: { accessKeyId: "ymcp", secretAccessKey: "ymcp-minio-local" } });

async function readObject(key: string): Promise<string> {
  try { return await readFile(join(fileRoot, key.replaceAll("/", "\\")), "utf8"); } catch { }
  const resp = await s3.send(new GetObjectCommand({ Bucket: "ymcp-novel", Key: key }));
  return (await resp.Body!.transformToString("utf8")) ?? "";
}

async function main() {
  const out = process.argv[2] ?? "C:/Users/admin/AppData/Local/Temp/opencode/pilot-candidates.txt";
  const lines: string[] = [];
  for (const [label, artifactId, docId] of [
    ["CH3-CANDIDATE", "4a6b06ae-529a-43f4-a92c-0ade37e9e57e", "96030693-8344-4c35-ba4d-aadc86189f9e"],
    ["CH8-CANDIDATE", "c31a193b-3098-47a0-9535-e38aa3258b69", "a2c9116c-7dfe-41d2-a219-93d3f81ac830"],
  ] as const) {
    const art = await pool.query("SELECT object_key FROM artifacts WHERE id=$1", [artifactId]);
    const text = art.rows[0]?.object_key ? await readObject(art.rows[0].object_key) : "<<no object>>";
    lines.push(`===== ${label} ${artifactId} =====`);
    lines.push(text);
    lines.push("");
  }
  const cur = await pool.query(`SELECT d.title, d.current_revision_id, mr.revision FROM manuscript_documents d JOIN manuscript_revisions mr ON mr.id=d.current_revision_id WHERE d.id=ANY($1::text[])`, [["96030693-8344-4c35-ba4d-aadc86189f9e", "a2c9116c-7dfe-41d2-a219-93d3f81ac830"]]);
  lines.push(`CURRENT_REVISIONS=${JSON.stringify(cur.rows)}`);
  await (await import("node:fs/promises")).writeFile(out, lines.join("\n"), "utf8");
  console.log(`written ${out}`);
  await pool.end();
}

void main();
