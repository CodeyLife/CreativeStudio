import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
const fileRoot = join(process.cwd(), ".data", "objects");
const s3 = new S3Client({ region: "us-east-1", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, credentials: { accessKeyId: "ymcp", secretAccessKey: "ymcp-minio-local" } });
async function readObject(key) { try { return await readFile(join(fileRoot, key.replaceAll("/", "\\")), "utf8"); } catch {} const r = await s3.send(new GetObjectCommand({ Bucket: "ymcp-novel", Key: key })); return (await r.Body.transformToString("utf8")) ?? ""; }
async function main() {
  const out = "C:/Users/admin/AppData/Local/Temp/opencode/pilot-candidates2.txt";
  const lines = [];
  for (const [label, artifactId] of [["CH3-V2", "404d43a7-7014-428f-a7c8-a155b68682f0"], ["CH8-V2", "20919f09-ba8c-4ae4-a66c-74d29b668f87"]]) {
    const art = await pool.query("SELECT object_key FROM artifacts WHERE id=$1", [artifactId]);
    const text = art.rows[0]?.object_key ? await readObject(art.rows[0].object_key) : "<<no object>>";
    lines.push(`===== ${label} ${artifactId} =====`);
    lines.push(text);
    lines.push("");
  }
  await (await import("node:fs/promises")).writeFile(out, lines.join("\n"), "utf8");
  console.log("written");
  await pool.end();
}
void main();
