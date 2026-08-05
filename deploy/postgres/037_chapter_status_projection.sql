-- Keep the denormalized chapter lifecycle marker aligned with committed prose.
-- manuscript_documents.current_revision_id plus status='final' is authoritative;
-- this repairs historical rows left as planned by protected story-arc rebases.
UPDATE chapters c
SET status='final',updated_at=now()
FROM manuscript_documents d
WHERE c.project_id=d.project_id
  AND c.document_id=d.id
  AND d.status='final'
  AND d.current_revision_id IS NOT NULL
  AND c.status<>'final';
