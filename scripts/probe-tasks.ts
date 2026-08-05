import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const tasks = await pool.query(`SELECT id, task_id, purpose, status, result FROM model_tasks WHERE workflow_run_id=ANY($1::text[]) ORDER BY created_at DESC LIMIT 20`, [["chapter-review-96030693-8344-4c35-ba4d-aadc86189f9e-pilot-ch3-tech-metaphor-targeted-20260805", "chapter-review-a2c9116c-7dfe-41d2-a219-93d3f81ac830-pilot-ch8-tech-metaphor-targeted-20260805"]]);
  console.log("COUNT:", tasks.rowCount);
  for (const t of tasks.rows) {
    const r = typeof t.result === "string" ? t.result.slice(0, 220) : JSON.stringify(t.result ?? {}).slice(0, 220);
    console.log(`TASK ${t.id.slice(0,12)} ${t.task_id?.slice(0,60)} status=${t.status} result=${r}`);
  }
  await pool.end();
}
void main();
