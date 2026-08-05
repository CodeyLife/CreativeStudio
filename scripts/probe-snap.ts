import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp" });
  const snapshots = await pool.query(`SELECT s.document_id, s.verdict, s.overall_score, i.severity, i.title, i.description, i.evidence_quote FROM chapter_review_snapshots s JOIN chapter_review_snapshot_issues i ON i.snapshot_id=s.id WHERE s.document_id=ANY($1::text[]) AND s.reviewed_content_hash=(SELECT mr.content_hash FROM manuscript_revisions mr WHERE mr.id=s.revision_id)`, [["96030693-8344-4c35-ba4d-aadc86189f9e", "a2c9116c-7dfe-41d2-a219-93d3f81ac830"]]);
  for (const row of snapshots.rows) {
    console.log(`DOC=${row.document_id.slice(0,8)} verdict=${row.verdict} score=${row.overall_score} [${row.severity}] ${row.title}`);
    if (row.description) console.log(`  desc: ${row.description.slice(0,200)}`);
  }
  await pool.end();
}
void main();
