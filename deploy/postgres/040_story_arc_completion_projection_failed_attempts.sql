-- A failed or abandoned generation attempt must not hide an earlier approved
-- complete batch from the arc completion projection.
UPDATE arcs a
SET execution_status='completed',
    completed_at=COALESCE(completed_at,now()),
    updated_at=now()
WHERE a.execution_status='active'
  AND EXISTS (SELECT 1 FROM chapters c WHERE c.arc_id=a.id)
  AND NOT EXISTS (
    SELECT 1
    FROM chapters c
    LEFT JOIN manuscript_documents d ON d.id=c.document_id AND d.project_id=c.project_id
    WHERE c.arc_id=a.id
      AND (d.id IS NULL OR d.status<>'final' OR d.current_revision_id IS NULL)
  )
  AND EXISTS (
    SELECT 1
    FROM story_arc_batches b
    WHERE b.arc_id=a.id
      AND b.batch_index=(SELECT MAX(last_approved_batch.batch_index) FROM story_arc_batches last_approved_batch WHERE last_approved_batch.arc_id=a.id AND last_approved_batch.status='approved')
      AND b.status='approved'
      AND COALESCE((b.payload->>'complete')::boolean,false)=true
      AND b.end_chapter_index >= CASE
        WHEN COALESCE((a.payload->>'expectedChapterCount')::integer,0)>0
          THEN (a.payload->>'expectedChapterCount')::integer
        ELSE b.end_chapter_index
      END
  );
