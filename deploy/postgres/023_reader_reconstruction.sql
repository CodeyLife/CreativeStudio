ALTER TABLE chapter_review_snapshot_issues
  ADD COLUMN IF NOT EXISTS reader_reconstruction JSONB;
