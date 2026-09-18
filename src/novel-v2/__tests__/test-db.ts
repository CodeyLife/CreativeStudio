/**
 * DB 集成套件共享判据：beforeAll 连接测试库时，只有"数据库不存在/不可达"才允许
 * 静默跳过（CI 无 PG 环境）。schema、SQL 占位符、权限、约束类错误正是集成测试要
 * 暴露的证据，必须让它炸出来——吞掉任何异常会把整个 DB 套件变成"空过"：
 * 3103da7 的 reconcileStaleWorkflowRuns 参数占位 bug 与 task_attempts FK 语义
 * 漂移（010 指 workflow_runs.id，外部任务链路实际全写 temporal_workflow_id，
 * 生产靠 id===temporal 的巧合未爆）就是被这种空过掩盖的。判据拿不准时宁炸勿默。
 * 审核 N9：`database "..." does not exist` 不能无条件算"环境缺失"——TEST_DATABASE_URL
 * 指错/拼错库名同样命中该消息，全库瞬间静默变绿。仅当缺失的库名本身是测试库命名
 * （含 "test" 段，如 ymcp_test/test_2）才视为"测试环境未建库"可跳过；
 * 生产/任意其他库名缺库 = 配置事故，必须炸。
 */
export function isPostgresUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const missing = /database "([^"]*)" does not exist/iu.exec(message);
  if (missing) return /(^|[_\-.])test([0-9]*)$/iu.test(missing[1]);
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|could not connect to server|connection terminated|server closed the connection/iu.test(message);
}
