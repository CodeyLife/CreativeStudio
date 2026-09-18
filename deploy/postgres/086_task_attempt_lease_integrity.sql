-- OR-B2（product-audit-20260910 E3）：外部任务租约链路自洽。
-- 症状：task_attempts 300/300 的 lease 字段为 NULL、claim/heartbeat/submit 从未
-- 跑通。根因：租约行用 workflow 侧业务 taskId 语义与外部 model_task id 混写一列，
-- reopen join（ta.task_id = mt.id）恒空、心跳守卫必 0 行；且"无 owner 却
-- claimed/running"的僵尸行（138 条挂 completed run）从未被约束禁掉。
-- 修复：显式 model_task_id 关联列（外部任务租约行唯一 join 键，与业务 task_id
-- 语义解耦），回填历史 claim 行（payload.modelTaskId），僵尸租约判 failed，
-- 最后加 CHECK 把"claimed/running 无 owner"设为不可能状态。
ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS model_task_id TEXT;

-- Backfill: claim 写路径把 model task id 存进了 payload.modelTaskId。
UPDATE task_attempts
SET model_task_id = payload->>'modelTaskId'
WHERE model_task_id IS NULL
  AND jsonb_typeof(payload) = 'object'
  AND jsonb_typeof(payload->'modelTaskId') = 'string';

-- 僵尸租约：claimed/running 却没有 owner 的**外部任务租约行**既不可能被心跳续期
-- 也不可能被提交，统一落 failed（保留行做审计，payload 记 reason）。
-- 限定 model_task_id 非空（回填后）：workflow 侧业务 attempt 的 running 是进度
-- 标记、无租约语义，不属僵尸，绝不能被这次清理误伤。
UPDATE task_attempts
SET status = 'failed',
    payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('reason', 'zombie-lease-cleanup', 'expired', true)
WHERE model_task_id IS NOT NULL
  AND status IN ('claimed','running') AND (lease_owner IS NULL OR lease_owner = '');

CREATE INDEX IF NOT EXISTS task_attempts_model_task_idx ON task_attempts(model_task_id) WHERE model_task_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_attempts_owner_required') THEN
    -- "无 owner 却 claimed/running"自此在数据层不可能——边界只对外部任务租约行
    -- （model_task_id 非空）：workflow 侧业务 attempt 是进度标记，无租约语义。
    ALTER TABLE task_attempts ADD CONSTRAINT task_attempts_owner_required
      CHECK (model_task_id IS NULL OR status NOT IN ('claimed','running') OR (lease_owner IS NOT NULL AND lease_owner <> ''));
  END IF;
END
$$;
