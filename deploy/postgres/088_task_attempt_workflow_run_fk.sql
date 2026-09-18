-- 088_task_attempt_workflow_run_fk.sql
-- 根因修复（product-audit 追加批次④收尾时暴露）：task_attempts.workflow_run_id 的
-- FK 指向 workflow_runs(id)，但外部任务链路的全部真实写入方写的都是 Temporal
-- workflowId（=workflow_runs.temporal_workflow_id）：
--   claimModelTask 复制 model_tasks.workflow_run_id（来自 ModelWorkPackage.workflowRunId
--   =activities input.workflowId）；upsertTaskAttempt/updateTaskAttempt 的调用方
--   （temporal/workflows.ts）同样传 workflowId；对账与过期回收也按
--   WHERE temporal_workflow_id=$1 join。010 注释"存的是业务 id"从未在外部任务链路
--   成立——生产未爆雷只因 putWorkflowRun 各调用方恰好 id===temporalWorkflowId，
--   一旦两列不同值（测试即如此构造）claim 必 FK 违例。
-- 修复：把约束改指到事实语义 temporal_workflow_id（已有 UNIQUE 约束，CASCADE 语义
-- 不变：deleteProject 删 run 行仍级联清租约）。010 的注释是历史陈述，不回改；
-- 以本文件为权威说明。prompt_executions/model_tasks 该列无 FK（子查询兼容两种
-- 写法），不受影响。
-- 审核 N8 修正：① 不写 BEGIN/COMMIT——migrate() 已按文件包事务（内嵌 COMMIT 会提前
-- 提交、绕过 ROLLBACK 记账）；② 改约束前先做机械漂移修正（旧语义行 workflow_run_id
-- =workflow_runs.id 且两列不同值 → 改写为 temporal_workflow_id，同一行同一事实的
-- 两种列值，无信息损失）；③ 漂移修正后仍有残行（指向已删 run 等真孤儿）时带计数
-- RAISE，让失败可诊断而不是吞在裸 FK 违例里。
UPDATE task_attempts ta SET workflow_run_id = wr.temporal_workflow_id
  FROM workflow_runs wr
 WHERE ta.workflow_run_id = wr.id AND wr.id <> wr.temporal_workflow_id;
DO $$
DECLARE
  residual integer;
  samples text;
BEGIN
  SELECT count(*) INTO residual
    FROM task_attempts ta
   WHERE ta.workflow_run_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM workflow_runs wr WHERE wr.temporal_workflow_id = ta.workflow_run_id);
  IF residual > 0 THEN
    SELECT string_agg(s, ', ') INTO samples
      FROM (SELECT DISTINCT left(ta.workflow_run_id, 40) AS s FROM task_attempts ta
             WHERE ta.workflow_run_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM workflow_runs wr WHERE wr.temporal_workflow_id = ta.workflow_run_id)
             LIMIT 5) t;
    RAISE EXCEPTION '088: task_attempts 存在 % 行 workflow_run_id 无法解析到 temporal_workflow_id（样例：%）；先修数据再迁移', residual, samples;
  END IF;
END $$;
ALTER TABLE task_attempts DROP CONSTRAINT IF EXISTS task_attempts_workflow_run_id_fkey;
ALTER TABLE task_attempts ADD CONSTRAINT task_attempts_workflow_run_id_fkey
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(temporal_workflow_id) ON DELETE CASCADE;
