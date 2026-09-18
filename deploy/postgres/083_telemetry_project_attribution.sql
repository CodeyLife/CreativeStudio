-- Telemetry and event rows were the only project-bearing stores without a
-- project_id column: deleting a project orphaned their rows (FK cascade could
-- not reach them) and per-project accounting had nothing to filter on.
-- Add the column, backfill from the owning run or payload, purge rows whose
-- project no longer exists, then make the cascade structural.
ALTER TABLE model_tasks ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE prompt_executions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS project_id TEXT;

-- Backfill from the owning workflow run; the run may be referenced by either
-- its internal id or its Temporal workflow id.
WITH run_projects AS (
  SELECT id AS match_id, project_id FROM workflow_runs
  UNION SELECT temporal_workflow_id, project_id FROM workflow_runs WHERE temporal_workflow_id IS NOT NULL
)
UPDATE model_tasks t SET project_id = rp.project_id
FROM run_projects rp
WHERE t.project_id IS NULL AND t.workflow_run_id = rp.match_id;

WITH run_projects AS (
  SELECT id AS match_id, project_id FROM workflow_runs
  UNION SELECT temporal_workflow_id, project_id FROM workflow_runs WHERE temporal_workflow_id IS NOT NULL
)
UPDATE model_invocations t SET project_id = rp.project_id
FROM run_projects rp
WHERE t.project_id IS NULL AND t.workflow_run_id = rp.match_id;

WITH run_projects AS (
  SELECT id AS match_id, project_id FROM workflow_runs
  UNION SELECT temporal_workflow_id, project_id FROM workflow_runs WHERE temporal_workflow_id IS NOT NULL
)
UPDATE prompt_executions t SET project_id = rp.project_id
FROM run_projects rp
WHERE t.project_id IS NULL AND t.workflow_run_id = rp.match_id;

UPDATE outbox_events
SET project_id = payload->>'projectId'
WHERE project_id IS NULL
  AND jsonb_typeof(payload) = 'object'
  AND jsonb_typeof(payload->'projectId') = 'string';

-- Purge telemetry of already-deleted projects; those rows can never be
-- attributed to a living project and would block the FK below.
DELETE FROM model_tasks WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM novel_projects p WHERE p.id = model_tasks.project_id);
DELETE FROM model_invocations WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM novel_projects p WHERE p.id = model_invocations.project_id);
DELETE FROM prompt_executions WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM novel_projects p WHERE p.id = prompt_executions.project_id);
DELETE FROM outbox_events WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM novel_projects p WHERE p.id = outbox_events.project_id);

-- Work-package tasks whose owning run row is gone can never be claimed or
-- reconciled; they are undispatchable zombies left by deleted projects.
DELETE FROM model_tasks
WHERE project_id IS NULL AND workflow_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workflow_runs r
    WHERE r.id = model_tasks.workflow_run_id OR r.temporal_workflow_id = model_tasks.workflow_run_id
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_tasks_project_fkey') THEN
    ALTER TABLE model_tasks ADD CONSTRAINT model_tasks_project_fkey
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_invocations_project_fkey') THEN
    ALTER TABLE model_invocations ADD CONSTRAINT model_invocations_project_fkey
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_executions_project_fkey') THEN
    ALTER TABLE prompt_executions ADD CONSTRAINT prompt_executions_project_fkey
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbox_events_project_fkey') THEN
    ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_project_fkey
      FOREIGN KEY (project_id) REFERENCES novel_projects(id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS model_tasks_project_idx ON model_tasks(project_id);
CREATE INDEX IF NOT EXISTS model_invocations_project_idx ON model_invocations(project_id);
CREATE INDEX IF NOT EXISTS prompt_executions_project_idx ON prompt_executions(project_id);
CREATE INDEX IF NOT EXISTS outbox_events_project_idx ON outbox_events(project_id);
