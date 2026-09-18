-- 092_hot_path_indexes.sql
-- 主链路查询索引缺口（product-audit-20260910 P2「热 payload/项目面缺索引」的取证收尾）。
--
-- 取证方式：对运行库（ymcp，545 workflow_runs / 1433 artifacts 时点）跑只读 EXPLAIN，
-- 六个热形状**全部**落在顺序扫描上：
--   ① 弧并发门禁 assertNoActiveStoryArcWorkflow（project_id + workflow_type + arcId + 活跃态）
--   ② 弧 run 列表 getStoryArcWorkflowRun（project_id + workflow_type + arcId，按 created_at 取最近）
--   ③ 修订去重 findChapterReviewRunForDocument（project_id + documentId + workflow_type，按 updated_at 取最近）
--   ④ 周期对账 reconcileStaleWorkflowRuns（status IN (活跃态) + updated_at 墙钟）
--   ⑤ 项目 run 总览（project_id 按 updated_at 排序）
--   ⑥ 按 run 列举/级联删除产物（project_id + payload workflowId/runId 二选一）
-- 现状：public.artifacts 只有主键索引，public.workflow_runs 只有主键 + temporal_workflow_id
-- 唯一键——两张表都是**每次章节写入与每次运行改态**的必经面，行数单调增长，代价随项目寿命
-- 线性劣化（"新库不显、老库必崩"的一类）。
--
-- 刻意不建（避免无证据的写放大）：
--   · payload 表达式索引（arcId/documentId/workflowId）：上面三个形状都先被
--     (project_id, workflow_type) 收到"该项目该类型的 run"这一小集合，payload 只是残余过滤，
--     表达式索引收益低于其每次 run 改态的维护成本。若单项目 run 数增长到残余过滤再次变热，
--     再按 (project_id, (payload->>'arcId')) 形态补，属可延后的第二步。
--   · outbox_events 的 workflowId/runId 谓词：只服务级联删除，表由 publisher 持续清空。
--   · 带 status 清单的 partial index：workflow_runs 的状态词表在 TS 侧单源
--     （run-lifecycle.ts），把状态清单抄进迁移必然与之漂移，故建全量 (status, updated_at)。
-- 不用 CONCURRENTLY：migrate() 按文件包事务，事务内不能建并发索引（迁移事务纪律见
-- workflow-map「迁移文件内禁止自管事务」）。
-- 全幂等；索引名沿用 <table>_<col>_idx 惯例。
CREATE INDEX IF NOT EXISTS workflow_runs_project_type_created_idx
  ON workflow_runs(project_id, workflow_type, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_project_updated_at_idx
  ON workflow_runs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_status_updated_at_idx
  ON workflow_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS artifacts_project_idx
  ON artifacts(project_id);
