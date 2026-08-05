import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const reviews = await pool.query(`SELECT id, artifact_id, role, verdict, score, created_at FROM reviews WHERE id=ANY($1::text[])`, [["130d7f23-92d6-48eb-97bb-6983f3e6af68", "9fcedd9b-6a88-4902-9ed8-b82451914998", "0892d191-a0c4-43cd-b79c-ae507ec98c16", "404d43a7-7014-428f-a7c8-a155b68682f0", "20919f09-ba8c-4ae4-a66c-74d29b668f87"]]);
  for (const r of reviews.rows) console.log(`${r.id.slice(0,8)} artifact=${r.artifact_id?.slice(0,8)} role=${r.role} verdict=${r.verdict} score=${r.score} at=${r.created_at}`);
  await pool.end();
}
void main();
