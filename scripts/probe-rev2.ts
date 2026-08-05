import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const reviews = await pool.query(`SELECT id, role, verdict, score, issues FROM reviews WHERE id=ANY($1::text[])`, [["130d7f23-92d6-48eb-97bb-6983f3e6af68", "9fcedd9b-6a88-4902-9ed8-b82451914998", "0892d191-a0c4-43cd-b79c-ae507ec98c16"]]);
  for (const row of reviews.rows) {
    console.log(`=== ${row.id.slice(0,8)} role=${row.role} verdict=${row.verdict} score=${row.score}`);
    const issues = typeof row.issues === "string" ? JSON.parse(row.issues) : row.issues;
    for (const i of issues ?? []) console.log(`  [${i.severity}] ${i.title}\n    ${(i.description ?? "").slice(0,220)}`);
  }
  await pool.end();
}
void main();
