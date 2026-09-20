-- 094_outbox_event_ledger_face.sql
-- 撤掉 outbox_events 上"计划中的 publisher"遗留：published_at 列、与之绑定的重复索引；
-- 同时给两条真实读补上它们实际需要的索引。（作者 2026-09-20 裁决：撤半截 publisher 机制 + 加保留）
--
-- 判据（全部只读取证，`ymcp` 只 SELECT，2026-09-20）：
-- - `published_at` 非空行数 **0 / 21,807**，全仓代码零引用（写侧与读侧都没有）⇒ 这一列承载的
--   "已被投递方取走"语义从未存在过。表本身不是 outbox（没有任何投递进程），它是**域事件账本**：
--   REST 用 `listRunOutbox` 按 id 游标轮询本 run 的事件，学习闭环用 `NOT EXISTS` 查"这条候选的
--   停滞通报是否已发过"。审核 §E7 当年给的两句判据"要么实现 publisher 要么更名 domain_events"
--   里，前一句是在为一个不存在的外部消费者建机制，后一句的名字问题本轮用表注释钉住真实语义
--   （整表更名要动 10 处 SQL、EXPERIMENT_RUNTIME_TABLES 与在跑沙箱的克隆表名，收益只有名字）。
-- - `outbox_unpublished ON outbox_events(id) WHERE published_at IS NULL`：谓词在真实数据上恒真
--   ⇒ 它与 `outbox_events_pkey`（同键 btree）逐页重复，只给每次 INSERT 加一份维护成本。列一走它
--   就失去存在理由，必须先删索引再删列（反序则索引谓词不存在，DDL 直接报错）。
--
-- 补的索引不是猜的，是两条真实读的执行计划要求的（EXPLAIN (ANALYZE, BUFFERS) 实跑）：
-- - `listRunOutbox`：Seq Scan on outbox_events，21,803/21,807 行被过滤，18.4ms / 4,961 buffers
--   ——这条是 REST 轮询面，随账本线性变慢；
-- - 学习闭环的停滞去重：Seq Scan 2.8ms / 1,514 buffers，且外层是 22 次 Nested Loop Anti Join 的
--   Materialize。
--   两者都按 `(aggregate_type, aggregate_id)` 收敛，故建这一条复合索引。
--
-- 幂等：DROP IF EXISTS + CREATE IF NOT EXISTS，重复 migrate 为 no-op；迁移文件内不自管事务（本仓纪律）。
-- 不可逆面：只丢一列全 NULL 的数据与一个重复索引；`BIGSERIAL` 序列与主键不动，历史事件行不删
--   （清理属应用侧的保留策略，见 `OUTBOX_RETENTION_DAYS`——那里要受停滞去重判据约束，不在 DDL 里赌）。
-- 范围外：083 建的 `outbox_events_project_idx` 保留（deleteProject 的按项目清理与 NULL 归属行的
--   保留策略都走它）。

DROP INDEX IF EXISTS outbox_unpublished;

ALTER TABLE outbox_events DROP COLUMN IF EXISTS published_at;

CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx ON outbox_events(aggregate_type, aggregate_id);

COMMENT ON TABLE outbox_events IS
  '域事件账本（不是待投递 outbox）：REST 按 id 游标轮询本 run 的事件，学习闭环按 (aggregate_type, aggregate_id) 做通报幂等去重。无外部投递方；published_at 与 outbox_unpublished 索引属未实现的 publisher 遗留，已由迁移 094 撤除。';
