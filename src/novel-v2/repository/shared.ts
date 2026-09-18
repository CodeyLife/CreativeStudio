/**
 * 跨 slice 共享的行映射原语。
 *
 * 为什么单独一个文件而不是让 slice 直接 import 仓储：`workflowFromRow` 一类映射原本住在
 * `postgres-repository.ts` 里，slice 模块要用它就会形成 **仓储 ↔ slice 的循环 import**
 * （仓储委托给 slice，slice 又回头取仓储的映射）。把映射放这里，依赖方向就只有一条：
 * postgres-repository → slice → shared。
 *
 * 边界：只放"行 → 记录"的纯映射与其计时工具，不放 SQL、不放业务规则——那些属于各自的
 * slice。新 slice 需要新映射时加在这里，而不是复制一份。
 */
import type { WorkflowRunRecord } from "../protocol";
import { toWorkflowRunStatus } from "../run-lifecycle";

/** outbox 追加器（由仓储提供，保证事件归属规则只有一份实现）。 */
export type OutboxWriter = (aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) => Promise<number>;

export type WorkflowRunRow = { id: string; workflow_type: string; project_id: string; temporal_workflow_id: string; status: string; payload: Record<string, unknown>; created_at: Date | string; updated_at: Date | string };

export function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : value; }

export function workflowFromRow(row: WorkflowRunRow): WorkflowRunRecord {
  return { id: row.id, workflowType: row.workflow_type, projectId: row.project_id, temporalWorkflowId: row.temporal_workflow_id, status: toWorkflowRunStatus(row.status), payload: row.payload ?? {}, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
