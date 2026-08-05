import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const runs = await pool.query(`SELECT id, status, payload FROM workflow_runs WHERE id=ANY($1::text[])`, [["chapter-review-96030693-8344-4c35-ba4d-aadc86189f9e-pilot-ch3-tech-metaphor-targeted-20260805", "chapter-review-a2c9116c-7dfe-41d2-a219-93d3f81ac830-pilot-ch8-tech-metaphor-targeted-20260805"]]);
  for (const r of runs.rows) {
    const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
    console.log(`RUN=${r.id.slice(0,60)} status=${r.status}`);
    console.log("  error:", p.error, "| stage:", p.stage, "| missing:", JSON.stringify(p.missingReviewerRoles));
    console.log("  failed:", JSON.stringify(p.failedReviewIds));
  }
  const tasks = await pool.query(`SELECT id, workflow_run_id, purpose, status, error_category, error_message FROM model_tasks WHERE workflow_run_id=ANY($1::text[]) AND status='failed' ORDER BY created_at DESC LIMIT 8`, [["chapter-review-96030693-8344-4c35-ba4d-aadc86189f9e-pilot-ch3-tech-metaphor-targeted-20260805", "chapter-review-a2c9116c-7dfe-41d2-a219-93d3f81ac830-pilot-ch8-tech-metaphor-targeted-20260805"]]);
  for (const t of tasks.rows) console.log(`  TASK purpose=${t.purpose} status=${t.status} cat=${t.error_category} msg=${(t.error_message ?? "").slice(0,120)}`);
  await pool.end();
}
void main();
