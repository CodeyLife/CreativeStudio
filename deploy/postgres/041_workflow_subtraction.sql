-- Novel V2 subtraction baseline. Applied after all historical migrations.

-- Only structurally complete legacy artifacts remain active.
UPDATE artifacts
SET kind='review'
WHERE kind='summary'
  AND jsonb_typeof(payload->'issues')='array'
  AND (payload ? 'verdict' OR payload ? 'score');

UPDATE artifacts
SET kind='chapter-blueprint'
WHERE kind='arc-plan'
  AND jsonb_typeof(payload->'arc')='object'
  AND jsonb_typeof(payload->'batch')='object'
  AND jsonb_typeof(payload->'chapters')='array';

-- Unverifiable legacy kinds are invalidated by deletion; dependent evidence is
-- no longer authoritative and is removed through the existing FK cascade.
DELETE FROM artifacts WHERE kind IN ('summary','arc-plan');

-- Narrative state is an arc/ledger boundary. Chapter summary, events and
-- character states remain exclusively owned by chapter_memories.
UPDATE narrative_state_snapshots
SET payload = payload - ARRAY['chapterSummary','keyEvents','characterStates']::text[]
WHERE payload ?| ARRAY['chapterSummary','keyEvents','characterStates'];

-- The chapter blueprint lives in chapters.payload. Keep only author-entered
-- chapter goals in the workspace projection.
ALTER TABLE chapter_production_specs DROP COLUMN IF EXISTS blueprint;
ALTER TABLE chapter_production_specs DROP COLUMN IF EXISTS blueprint_fingerprint;
ALTER TABLE chapter_production_specs DROP COLUMN IF EXISTS source_artifact_id;

-- payoff_curve had no active consumer. Foreshadowing, promises and payoffs in
-- narrativeElements remain the authoritative fulfillment model.
DROP TABLE IF EXISTS payoff_curve;

-- Existing active runs were compiled against the removed contracts and must be
-- restarted explicitly by the new runtime.
UPDATE workflow_runs
SET status='needs-restart',
    payload=payload || jsonb_build_object('reasonCode','schema-subtraction-restart-required','restartRequired',true),
    updated_at=now()
WHERE status IN ('accepted','pending','running','waiting-external','manual-review-required');

-- Do not infer missing thread responsibilities from the old plotThreadRefs
-- array. Such arcs require explicit regeneration and review.
UPDATE arcs
SET planning_status='stale',
    context_fingerprint=NULL,
    payload=payload || jsonb_build_object('staleReason','thread-responsibilities-required-after-schema-subtraction'),
    updated_at=now()
WHERE planning_status IN ('approved','awaiting-review')
  AND (NOT (payload ? 'threadResponsibilities') OR jsonb_typeof(payload->'threadResponsibilities') <> 'array');

-- Remove duplicated and deprecated JSONB fields after the explicit stale mark.
UPDATE arcs
SET payload = (
  jsonb_set(
    payload - 'plotThreadRefs',
    '{phases}',
    COALESCE((
      SELECT jsonb_agg(phase - 'exitCondition')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'phases')='array' THEN payload->'phases' ELSE '[]'::jsonb END) AS phase
    ), '[]'::jsonb),
    true
  )
)
WHERE payload ? 'plotThreadRefs' OR jsonb_typeof(payload->'phases')='array';

UPDATE chapters
SET payload = payload - ARRAY[
  'summary','chapterPurpose','readerExperience','thematicTreatment',
  'romanceTreatment','humorTreatment','dramaticQuestion','emotionalMovement',
  'stateDeltaBudget','narrativeScale','optionalBeats','setupRefs','payoffRefs',
  'closingForce','freedom','participantStakes','goal','turn'
]::text[]
WHERE payload ?| ARRAY[
  'summary','chapterPurpose','readerExperience','thematicTreatment',
  'romanceTreatment','humorTreatment','dramaticQuestion','emotionalMovement',
  'stateDeltaBudget','narrativeScale','optionalBeats','setupRefs','payoffRefs',
  'closingForce','freedom','participantStakes','goal','turn'
]::text[];

UPDATE artifacts
SET payload = payload - ARRAY['payoffMoments','summary','chapterMemory','characterDeltas']::text[]
WHERE kind='fact-extraction'
  AND payload ?| ARRAY['payoffMoments','summary','chapterMemory','characterDeltas'];
