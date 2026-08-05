import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='reviews'");
  console.log("COLS:", cols.rows.map(r=>r.column_name).join(","));
  const reviews = await pool.query(`SELECT id, role, verdict, score, issues FROM reviews WHERE artifact_id=ANY($1::text[])`, [["4a6b06ae-529a-43f4-a92c-0ade37e9e57e", "c31a193b-3098-47a0-9535-e38aa3258b69"]]);
  for (const row of reviews.rows) {
    console.log(`ART=${row.id.slice(0,8)} role=${row.role} verdict=${row.verdict} score=${row.score}`);
    const issues = typeof row.issues === "string" ? JSON.parse(row.issues) : row.issues;
    for (const i of issues ?? []) console.log(`  [${i.severity}] ${i.title} | ${(i.description ?? "").slice(0,140)}`);
  }
  await pool.end();
}
void main();
