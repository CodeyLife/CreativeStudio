import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Descriptions, Empty, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, message, type TableColumnsType } from "antd";
import { ArrowLeftOutlined, DownOutlined, ReloadOutlined, SendOutlined, ThunderboltOutlined, PlayCircleOutlined, FileTextOutlined, AuditOutlined, ApiOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { novelCommands, novelKeys, novelPaths, useNovelCommand, useNovelQuery } from "../../lib/novelApi";
import {
  commandTypeMeta,
  describeCreativeEvent,
  relativeTime,
  reviewVerdictMeta,
  runModeMeta,
  shortId,
  statusMeta,
  workItemStatusMeta,
} from "./presentation";

export interface CreativeRunPanelProps { projectId: string }

type RunMode = "chapter" | "segment-auto";
type RunStatus = "pending" | "running" | "paused" | "completed" | "cancelled";
type WorkItemStatus = "pending" | "running" | "accepted" | "revised" | "retried" | "recovered" | "failed";
type ReviewVerdict = "passed" | "revise" | "blocked";
type CommandType = "work.start" | "work.accept" | "work.revise" | "work.retry" | "work.recover" | "review.request" | "review.submit" | "run.pause" | "run.resume" | "run.cancel";

interface CreativePolicy { maxRetries?: number; reviewGate?: boolean; autoAcceptThreshold?: number }
interface CreativeWorkItem { id: string; kind: string; status: WorkItemStatus; instruction?: string; iteration?: number }
interface CreativeReview { id: string; reviewer?: string; verdict: ReviewVerdict; issueCount?: number; summary?: string }
interface CreativeRun {
  id: string; projectId?: string; mode: RunMode; status: RunStatus;
  policy?: CreativePolicy; payload?: Record<string, unknown>;
  createdAt: string; updatedAt?: string; workItems?: CreativeWorkItem[]; reviews?: CreativeReview[];
}
interface CreativeEvent {
  id?: number; sequence?: number; eventType?: string; event_type?: string;
  createdAt?: string; created_at?: string; payload?: unknown;
}
interface CreativeCommand {
  type: CommandType; idempotencyKey: string; workItemId?: string; instruction?: string; force?: boolean;
  review?: { subjectArtifactId?: string; reviewer?: string; verdict?: ReviewVerdict; issues?: string[]; summary?: string };
}

const eventSequence = (e: CreativeEvent) => e.sequence ?? e.id ?? 0;
const eventTimeOf = (e: CreativeEvent) => e.createdAt ?? e.created_at;
const eventTypeOf = (e: CreativeEvent) => e.eventType ?? e.event_type;

// work.* / review.* 针对 work item；run.* 作用于整个 run
const WORK_ITEM_COMMANDS: CommandType[] = ["work.start", "work.accept", "work.revise", "work.retry", "work.recover", "review.request", "review.submit"];
const RUN_COMMANDS: CommandType[] = ["run.pause", "run.resume", "run.cancel"];
const MODE_OPTIONS = [{ value: "chapter", label: "章节生成" }, { value: "segment-auto", label: "自动分段" }];
const VERDICT_OPTIONS: { value: ReviewVerdict; label: string }[] = [
  { value: "passed", label: "通过" },
  { value: "revise", label: "需修订" },
  { value: "blocked", label: "阻塞" },
];

/** 查询尚无数据时的稳定空数组：保持引用稳定，避免每次渲染都触发依赖它的 memo/effect。 */
const NO_RUNS: CreativeRun[] = [];

export default function CreativeRunPanel({ projectId }: CreativeRunPanelProps) {
  const queryClient = useQueryClient();
  const [selectedRun, setSelectedRun] = useState<CreativeRun>();
  const [events, setEvents] = useState<CreativeEvent[]>([]);
  const [lastSequence, setLastSequence] = useState(0);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  // TODO P2: 用 ref 维护 lastSequence 以避免轮询闭包捕获过期 state；state 仅用于 UI 展示
  const lastSequenceRef = useRef(0);
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [commandForm] = Form.useForm();
  const [createForm] = Form.useForm();
  const workItemId = Form.useWatch("workItemId", commandForm) as string | undefined;
  const commandType = Form.useWatch("type", commandForm) as CommandType | undefined;

  const selectedRunId = selectedRun?.id;

  // ---- 读：run 列表 ----
  // 原 `useEffect(() => { void loadRuns(); }, [projectId])` 由 key 承载：projectId 变则 key 变，自动取数。
  const runsQuery = useNovelQuery<{ runs: CreativeRun[] }>(
    novelKeys.creativeRuns(projectId),
    novelPaths.creativeRuns({ projectId }),
  );
  const runs = runsQuery.data?.runs ?? NO_RUNS;

  // ---- 读：选中 run 的详情（workItems / reviews）----
  // 原 `loadRunDetail` + 3000ms interval 由 `pollWhile` 承载：选中期间持续轮询（与原实现一致，不按状态收敛）。
  const runQuery = useNovelQuery<CreativeRun>(
    novelKeys.creativeRun(selectedRunId ?? ""),
    novelPaths.creativeRun({ runId: selectedRunId ?? "" }),
    { enabled: Boolean(selectedRunId), pollWhile: () => true },
  );
  // 详情优先取查询结果；首次返回前先展示列表里那条记录（等价于原 setSelectedRun(record) → loadRunDetail 的过渡）。
  // `run` 与 `selectedRun` 同时为真：无选中时 key 为 ""，该查询不会命中任何缓存条目。
  const run = runQuery.data ?? selectedRun;

  // ---- 读：增量事件流 ----
  // 事件流是**增量累积**的：`afterSequence` 是游标，响应只含游标之后的新事件，因此结果要 append 而非替换。
  // 这里刻意分工：**react-query 只负责取数与轮询**，**本地 state 负责累积**。
  // queryKey 不含 afterSequence——否则每来一批就多一个缓存条目；游标放在 path 里，取自 lastSequenceRef。
  const eventsQuery = useNovelQuery<{ events: CreativeEvent[] }>(
    novelKeys.creativeRunEvents(selectedRunId ?? ""),
    novelPaths.creativeRunEvents({ runId: selectedRunId ?? "", afterSequence: lastSequenceRef.current }),
    { enabled: Boolean(selectedRunId), pollWhile: () => true },
  );
  const eventsData = eventsQuery.data;
  useEffect(() => {
    const next = eventsData?.events ?? [];
    if (next.length === 0) return;
    const after = lastSequenceRef.current;
    setEvents((prev) => [...prev, ...next]);
    const maxSeq = next.reduce((max, event) => Math.max(max, eventSequence(event)), after);
    lastSequenceRef.current = maxSeq;
    setLastSequence(maxSeq);
  }, [eventsData]);

  // TODO P2: 轮询错误目前静默吞掉以避免刷屏；后续应做退避重试并仅在连续失败时上报
  const eventsError = eventsQuery.error;
  useEffect(() => {
    if (eventsError) console.warn("creative run events poll failed", eventsError);
  }, [eventsError]);

  // 读失败沿用原 loadRuns/loadRunDetail 的 catch：写进同一个 error 槽位（Alert 可关闭，关闭后同一错误不再弹回）。
  const queryError = runsQuery.error ?? runQuery.error;
  useEffect(() => {
    setError(queryError ? queryError.message : undefined);
  }, [queryError]);

  // 列表查询在飞＝原 `loading`（原 loadRunDetail 不置 loading，故详情刷新按钮不转圈，这里保持不变）。
  const loading = runsQuery.isFetching;

  // 事件流是**增量批次**而非完整资源：游标住在组件里，缓存条目就必须与游标同生命周期。
  // 否则重新进入同一 run 时会命中上一轮的批次，从中间续接而丢掉游标 0 到该批次之间的事件。
  function selectRun(record: CreativeRun) {
    queryClient.removeQueries({ queryKey: novelKeys.creativeRunEvents(record.id) });
    setEvents([]);
    lastSequenceRef.current = 0;
    setLastSequence(0);
    setSelectedRun(record);
  }

  function backToList() {
    setSelectedRun(undefined);
    setEvents([]);
    lastSequenceRef.current = 0;
    setLastSequence(0);
    setError(undefined);
    commandForm.resetFields();
    void runsQuery.refetch();
  }

  // ---- 写：路径 / 方法 / 请求体 / 失效面全部来自命令注册表，调用点只给业务入参 ----
  const createRunCommand = useNovelCommand<{ projectId: string; mode: RunMode; policy: CreativePolicy }>(novelCommands.creativeRunCreate);
  const sendCommand = useNovelCommand<{ projectId: string; runId: string; command: CreativeCommand }>(novelCommands.creativeRunCommand);

  async function createRun(values: { mode: RunMode; maxRetries?: number; reviewGate?: boolean; autoAcceptThreshold?: number }) {
    try {
      // 成功后按项目前缀失效，列表自动刷新（原 `await loadRuns()` 不再需要）
      await createRunCommand.mutateAsync({
        projectId,
        mode: values.mode,
        policy: { maxRetries: values.maxRetries, reviewGate: values.reviewGate, autoAcceptThreshold: values.autoAcceptThreshold },
      });
      setCreateOpen(false);
      createForm.resetFields();
      message.success("Creative run 已创建");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitCommand(values: {
    workItemId?: string; type: CommandType; instruction?: string; force?: boolean;
    reviewSubjectArtifactId?: string; reviewReviewer?: string; reviewVerdict?: ReviewVerdict; reviewIssues?: string; reviewSummary?: string;
  }) {
    if (!selectedRun) return;
    const runId = selectedRun.id;
    const command: CreativeCommand = {
      type: values.type,
      idempotencyKey: `${runId}:${values.workItemId ?? ""}:${values.type}:${Date.now()}`,
      workItemId: values.workItemId,
    };
    if (values.type === "work.revise" && values.instruction) command.instruction = values.instruction;
    if (values.type === "work.recover") command.force = Boolean(values.force);
    if (values.type === "review.submit") {
      command.review = {
        subjectArtifactId: values.reviewSubjectArtifactId,
        reviewer: values.reviewReviewer,
        verdict: values.reviewVerdict,
        // TODO P3: issues 目前按行拆分，后续可替换为 tag 输入控件
        issues: values.reviewIssues ? values.reviewIssues.split("\n").map((line) => line.trim()).filter(Boolean) : undefined,
        summary: values.reviewSummary,
      };
    }
    setSubmitting(true);
    try {
      // 成功后按命令声明的失效面失效：该 run 的详情 + 事件流，以及项目级列表（原 `await loadRunDetail(runId)` 不再需要）
      await sendCommand.mutateAsync({ projectId, runId, command });
      message.success(`命令 ${values.type} 已提交`);
      commandForm.resetFields();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const workItems = run?.workItems ?? [];
  const reviews = run?.reviews ?? [];
  const commandOptions = useMemo<CommandType[]>(() => (workItemId ? [...WORK_ITEM_COMMANDS, ...RUN_COMMANDS] : RUN_COMMANDS), [workItemId]);
  // work item 被清空后，已选的 work 级命令需要重置
  useEffect(() => {
    if (commandType && !commandOptions.includes(commandType)) commandForm.setFieldValue("type", undefined);
  }, [commandOptions, commandType, commandForm]);

  const runColumns: TableColumnsType<CreativeRun> = [
    { title: "运行", key: "run", render: (_: unknown, record: CreativeRun) => {
      const modeMeta = runModeMeta(record.mode);
      const stMeta = statusMeta(record.status);
      return (
        <div className="novel-table-cell-stack">
          <Space size={6} align="center">
            <span className="novel-run-item-icon">{modeMeta.icon}</span>
            <span className="novel-run-item-title">{modeMeta.label}</span>
            <span className={stMeta.pill}>{stMeta.label}</span>
          </Space>
          <code className="novel-table-cell-sub">{shortId(record.id)}</code>
        </div>
      );
    }},
    { title: "创建时间", dataIndex: "createdAt", render: (t: string) => <span className="novel-table-cell-sub">{relativeTime(t)}</span> },
    { title: "操作", key: "actions", width: 90, render: (_: unknown, record: CreativeRun) => <Button type="link" size="small" onClick={() => selectRun(record)}>查看详情</Button> },
  ];
  const workItemColumns: TableColumnsType<CreativeWorkItem> = [
    { title: "工作项", key: "work", render: (_: unknown, record: CreativeWorkItem) => {
      const stMeta = workItemStatusMeta(record.status);
      return (
        <div className="novel-table-cell-stack">
          <Space size={6} align="center">
            <span className="novel-run-item-icon"><FileTextOutlined /></span>
            <span className="novel-run-item-title">{record.kind}</span>
            <Tag color={stMeta.tag}>{stMeta.label}</Tag>
          </Space>
          <code className="novel-table-cell-sub">{shortId(record.id)}</code>
        </div>
      );
    }},
    { title: "指令", dataIndex: "instruction", ellipsis: true, render: (t?: string) => t ?? <span className="novel-table-cell-sub">—</span> },
    { title: "轮次", dataIndex: "iteration", width: 60, render: (v?: number) => v ?? 0 },
  ];
  const reviewColumns: TableColumnsType<CreativeReview> = [
    { title: "审核", key: "review", render: (_: unknown, record: CreativeReview) => {
      const vMeta = reviewVerdictMeta(record.verdict);
      return (
        <div className="novel-table-cell-stack">
          <Space size={6} align="center">
            <span className="novel-run-item-icon">{vMeta.icon}</span>
            <Tag color={vMeta.tag}>{vMeta.label}</Tag>
            {record.reviewer && <span className="novel-table-cell-sub">{record.reviewer}</span>}
          </Space>
          <code className="novel-table-cell-sub">{shortId(record.id)}</code>
        </div>
      );
    }},
    { title: "问题数", dataIndex: "issueCount", width: 70, render: (v?: number) => v ?? 0 },
    { title: "摘要", dataIndex: "summary", ellipsis: true, render: (t?: string) => t ?? <span className="novel-table-cell-sub">—</span> },
  ];
  const sortedEvents = useMemo(() => [...events].reverse(), [events]);
  const runningCount = runs.filter((r) => r.status === "running").length;
  const completedCount = runs.filter((r) => r.status === "completed").length;

  return (
    <div className="novel-creative-page">
      {/* ===== EDITORIAL TOPBAR ===== */}
      <motion.header
        className="novel-topbar"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={backToList} disabled={!run}>返回 Run 列表</Button>
        <div className="novel-topbar-body" style={{ minWidth: 0 }}>
          <span className="novel-eyebrow">创意执行</span>
          <h2 className="novel-display-h2" style={{ marginTop: 2 }}>
            {run ? `Run ${shortId(run.id)}` : "创意执行控制台"}
          </h2>
          <p className="novel-lede" style={{ margin: "8px 0 0" }}>
            {run
              ? "查看 Run 详情、工作项、审核记录与事件流；通过命令面板控制 work item 或整个 run。"
              : "创建 Creative Run，分章节或自动分段执行创作任务，实时观察工作项状态与审核闭环。"}
          </p>
        </div>
        <div className="novel-topbar-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void (run ? runQuery.refetch() : runsQuery.refetch())}>刷新</Button>
          {!run && <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setCreateOpen(true)}>创建 Run</Button>}
        </div>
      </motion.header>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" closable onClose={() => setError(undefined)} />}

      {!run ? (
        /* ===== LIST VIEW ===== */
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="novel-bento">
            <div className="novel-card-mini novel-bento-mini">
              <div className="novel-card-mini-label"><PlayCircleOutlined /> 总 Run 数</div>
              <div className="novel-card-mini-value">{runs.length}</div>
              <div className="novel-card-mini-hint">章节 / 自动分段</div>
            </div>
            <div className="novel-card-mini novel-bento-mini">
              <div className="novel-card-mini-label"><ThunderboltOutlined /> 运行中</div>
              <div className="novel-card-mini-value">{runningCount}</div>
              <div className="novel-card-mini-hint">活跃 creative run</div>
            </div>
            <div className="novel-card-mini novel-bento-mini">
              <div className="novel-card-mini-label"><FileTextOutlined /> 已完成</div>
              <div className="novel-card-mini-value">{completedCount}</div>
              <div className="novel-card-mini-hint">status=completed</div>
            </div>
            <div className="novel-card-mini novel-bento-mini">
              <div className="novel-card-mini-label"><AuditOutlined /> 其他</div>
              <div className="novel-card-mini-value">{runs.length - runningCount - completedCount}</div>
              <div className="novel-card-mini-hint">pending / paused / cancelled</div>
            </div>
          </div>

          <Card className="novel-v2-card novel-eval-data-card" title="Creative Run 列表" extra={<Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setCreateOpen(true)}>创建 Run</Button>}>
            <Table rowKey="id" size="small" loading={loading} dataSource={runs} columns={runColumns} pagination={{ pageSize: 10 }} locale={{ emptyText: "暂无创意执行 run" }} />
          </Card>
        </motion.section>
      ) : (
        /* ===== DETAIL VIEW: 2-COLUMN WORKSPACE ===== */
        <section className="novel-eval-workspace">
          {/* 左栏：Run 详情 + 命令焦点卡 */}
          <motion.section
            className="novel-eval-focal"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Run 详情支撑卡 */}
            <div className="novel-card-support">
              <div className="novel-card-head">
                <h3 className="novel-display-h3">Run 详情</h3>
                {(() => {
                  const stMeta = statusMeta(run.status);
                  return (
                    <span className={stMeta.pill}>
                      {stMeta.icon}
                      <span style={{ marginLeft: 4 }}>{stMeta.label}</span>
                    </span>
                  );
                })()}
              </div>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="模式">{runModeMeta(run.mode).label}</Descriptions.Item>
                <Descriptions.Item label="Run ID"><code>{shortId(run.id, 12)}</code></Descriptions.Item>
                <Descriptions.Item label="创建时间">{relativeTime(run.createdAt)}</Descriptions.Item>
                <Descriptions.Item label="最大重试">{run.policy?.maxRetries ?? "—"}</Descriptions.Item>
                <Descriptions.Item label="审核门控">{run.policy?.reviewGate ? "开启" : "关闭"}</Descriptions.Item>
                <Descriptions.Item label="自动采纳阈值">{run.policy?.autoAcceptThreshold ?? "—"}</Descriptions.Item>
              </Descriptions>
            </div>

            {/* 提交命令焦点卡 */}
            <div className="novel-focal-card">
              <div className="novel-focal-card-head">
                <h3>提交命令</h3>
                <span className="novel-status-pill novel-status-pill-done">实时控制 · 幂等键</span>
              </div>
              <div className="novel-focal-card-body">
                <Form form={commandForm} layout="vertical" onFinish={(values) => void submitCommand(values)}>
                  <Form.Item name="workItemId" label="工作项" tooltip="不选则仅可提交 run 级命令（暂停/恢复/取消）">
                    <Select allowClear placeholder="选择工作项" options={workItems.map((item) => {
                      const stMeta = workItemStatusMeta(item.status);
                      return { value: item.id, label: `${item.kind} · ${stMeta.label} · ${shortId(item.id)}` };
                    })} />
                  </Form.Item>
                  <Form.Item name="type" label="命令类型" rules={[{ required: true, message: "请选择命令类型" }]}>
                    <Select placeholder="选择命令类型" options={commandOptions.map((type) => ({ value: type, label: commandTypeMeta(type).label }))} />
                  </Form.Item>
                  {commandType === "work.revise" && (
                    <Form.Item name="instruction" label="修订指令" rules={[{ required: true, message: "请填写修订指令" }]}>
                      <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} placeholder="输入修订指令" />
                    </Form.Item>
                  )}
                  {commandType === "work.recover" && (
                    <Form.Item name="force" label="强制恢复" valuePropName="checked" tooltip="强制恢复，绕过常规守卫"><Switch /></Form.Item>
                  )}
                  {commandType === "review.submit" && (
                    <>
                      <Form.Item name="reviewSubjectArtifactId" label="审核对象 ID"><Input placeholder="被审核的 artifact id" /></Form.Item>
                      <Form.Item name="reviewReviewer" label="审核人"><Input placeholder="审核人标识" /></Form.Item>
                      <Form.Item name="reviewVerdict" label="裁决" rules={[{ required: true, message: "请选择裁决" }]}>
                        <Select options={VERDICT_OPTIONS} placeholder="选择裁决" />
                      </Form.Item>
                      <Form.Item name="reviewIssues" label="问题列表（每行一条）"><Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="每行一条 issue" /></Form.Item>
                      <Form.Item name="reviewSummary" label="审核摘要"><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="审核摘要" /></Form.Item>
                    </>
                  )}
                  <Button type="primary" size="large" htmlType="submit" icon={<SendOutlined />} loading={submitting} block>提交命令</Button>
                </Form>
              </div>
            </div>
          </motion.section>

          {/* 右栏：数据密集区 */}
          <motion.aside
            className="novel-eval-observer"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          >
            <Card className="novel-v2-card novel-eval-data-card" title={<Space><FileTextOutlined /><span>Work Items（{workItems.length}）</span></Space>} size="small">
              <Table rowKey="id" size="small" dataSource={workItems} columns={workItemColumns} pagination={false} locale={{ emptyText: "暂无工作项" }} />
            </Card>
            <Card className="novel-v2-card novel-eval-data-card" title={<Space><AuditOutlined /><span>Reviews（{reviews.length}）</span></Space>} size="small">
              <Table rowKey="id" size="small" dataSource={reviews} columns={reviewColumns} pagination={false} locale={{ emptyText: "暂无审核" }} />
            </Card>
            <Card className="novel-v2-card novel-eval-data-card" title={<Space><ApiOutlined /><span>事件流（seq={lastSequence}）</span></Space>} size="small">
              {sortedEvents.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无事件，等待轮询" />
              ) : (
                <div className="novel-event-timeline">
                  {sortedEvents.slice(0, 20).map((event, idx) => {
                    const key = String(event.id ?? event.sequence ?? idx);
                    const desc = describeCreativeEvent(eventTypeOf(event), event.payload);
                    const isExpanded = expandedEvents.has(key);
                    const hasPayload = event.payload !== undefined && event.payload !== null;
                    const hasFields = desc.fields && desc.fields.length > 0;
                    return (
                      <div className="novel-event-item" key={key}>
                        <div className="novel-event-item-header">
                          <Space size={6} align="center" wrap={false}>
                            <span className="novel-event-item-icon">{desc.icon}</span>
                            <span className="novel-event-item-title">{desc.label}</span>
                            <Tag className="novel-event-item-cat">{desc.category}</Tag>
                          </Space>
                          <div className="novel-event-item-time">
                            {eventTimeOf(event) ? relativeTime(eventTimeOf(event)) : ""}
                          </div>
                        </div>
                        <div className="novel-event-item-summary">{desc.summary}</div>
                        {hasFields && (
                          <div className="novel-event-item-fields">
                            {desc.fields!.map((field, fieldIdx) => (
                              <div className="novel-event-item-field" key={fieldIdx}>
                                <span className="novel-event-item-field-label">{field.label}</span>
                                <code className={field.mono ? "novel-event-item-field-value-mono" : "novel-event-item-field-value"}>{field.value}</code>
                              </div>
                            ))}
                          </div>
                        )}
                        {hasPayload && (
                          <div
                            className="novel-event-item-raw-toggle"
                            onClick={() => setExpandedEvents((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })}
                          >
                            <DownOutlined className={`novel-event-item-toggle ${isExpanded ? "is-open" : ""}`} />
                            <span>{isExpanded ? "收起原始数据" : "原始数据"}</span>
                          </div>
                        )}
                        {isExpanded && hasPayload && (
                          <pre className="novel-event-item-payload">{JSON.stringify(event.payload, null, 2)}</pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </motion.aside>
        </section>
      )}

      <Modal title="创建 Creative Run" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={createForm} layout="vertical" onFinish={(values) => void createRun(values)}>
          <Form.Item name="mode" label="执行模式" rules={[{ required: true }]} initialValue="chapter"><Select options={MODE_OPTIONS} /></Form.Item>
          <Form.Item name="maxRetries" label="最大重试次数"><InputNumber min={0} max={10} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="reviewGate" label="审核门控" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="autoAcceptThreshold" label="自动采纳阈值"><InputNumber min={0} max={1} step={0.1} style={{ width: "100%" }} /></Form.Item>
          <Button type="primary" htmlType="submit" block>创建</Button>
        </Form>
      </Modal>
    </div>
  );
}
