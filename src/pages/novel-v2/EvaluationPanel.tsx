import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Tag, Tooltip, Typography, message } from "antd";
import {
  ArrowRightOutlined,
  CameraOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  LockOutlined,
  ReloadOutlined,
  RocketOutlined,
  SwapOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { decisionMeta, experimentStatusMeta, receiptStatusMeta, shortId } from "./presentation";
import { novelCommands, novelKeys, novelPaths, useNovelCommand, useNovelProject, useNovelQuery } from "../../lib/novelApi";

type SnapshotHead = {
  projectRevision?: number;
  finalDocumentHashes?: string[];
};

type SnapshotRow = {
  id: string;
  project_id: string;
  hash: string;
  head: SnapshotHead | string;
  created_at: string;
};

type SnapshotDetail = SnapshotRow & {
  payload?: {
    documents?: unknown[];
    memoryClaims?: unknown[];
    skillDefinitions?: unknown[];
    entities?: unknown[];
    relations?: unknown[];
    revisions?: unknown[];
    artifacts?: unknown[];
    reviews?: unknown[];
  };
  createdAt?: number;
  projectId?: string;
};

type Experiment = {
  id: string;
  projectId: string;
  schemaName: string;
  baseSnapshotId: string;
  baseSnapshotHash: string;
  status: "active" | "closed" | "deleted";
  createdAt: number;
};

type DocumentSummary = {
  id: string;
  title: string;
  narrativeOrder: number;
  status?: string;
};

type PromotableFact = { sourceClaimId: string; payload: { title: string; subjectRefs: string[]; kind: string } };
type IteratedSkill = { id: string; skillId: string; beforePrompt: string; afterPrompt: string; rationale: string };
type CandidateBundle = {
  id: string;
  experimentId: string;
  sourceProjectId: string;
  baseSnapshotId?: string;
  target: { documentId: string; baseRevision: number; baseContentHash: string };
  manuscript: { title: string; plainText: string; contentHtml: string; wordCount: number; contentHash: string };
  acceptedFacts: PromotableFact[];
  iteratedSkills: IteratedSkill[];
  qualityEvidence?: { reviewIds?: string[]; scores?: Record<string, number>; issueSummary?: Record<string, number> };
  provenance: { codeRevision: string; createdAt: number; workflowRunId: string };
};

type Receipt = {
  id: string;
  candidateId: string;
  projectId: string;
  status: "promoted" | "rolled-back" | "failed";
  result: { revisionId?: string; skillUpdates?: string[]; factIds?: string[] };
  failureReason?: string;
  createdAt: number;
};

export interface EvaluationPanelProps {
  projectId: string;
}

function formatDate(value: string | number | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function snapshotHead(snapshot: SnapshotRow): SnapshotHead {
  if (typeof snapshot.head === "string") {
    try {
      return JSON.parse(snapshot.head) as SnapshotHead;
    } catch {
      return {};
    }
  }
  return snapshot.head ?? {};
}

function snapshotName(snapshot: { created_at?: string; createdAt?: number }): string {
  return `作品基线 · ${formatDate(snapshot.created_at ?? snapshot.createdAt)}`;
}

function experimentName(experiment: Experiment, snapshot?: SnapshotRow): string {
  return snapshot ? `隔离实验 · ${formatDate(snapshot.created_at)} 基线` : `隔离实验 · ${formatDate(experiment.createdAt)}`;
}

function documentName(document: DocumentSummary | undefined, documentId?: string): string {
  return document ? `第 ${document.narrativeOrder} 章 · ${document.title}` : `目标章节 · ${shortId(documentId, 8)}`;
}

function candidateIssueCount(candidate: CandidateBundle): number {
  return Object.values(candidate.qualityEvidence?.issueSummary ?? {}).reduce((total, value) => total + Number(value || 0), 0);
}

function candidateEvidenceLabel(candidate: CandidateBundle): string {
  const reviews = candidate.qualityEvidence?.reviewIds?.length ?? 0;
  const issues = candidateIssueCount(candidate);
  if (!reviews && !issues) return "已生成，等待作者判断";
  return `${reviews} 份审核证据 · ${issues} 个待关注问题`;
}

function statusColor(status: Experiment["status"]): string {
  return status === "active" ? "green" : status === "deleted" ? "red" : "default";
}

export default function EvaluationPanel({ projectId }: EvaluationPanelProps) {
  // ---- 本地 UI 状态（数据不再自持：项目/快照/实验/候选/收据一律由 react-query 提供） ----
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>();
  const [createExperimentOpen, setCreateExperimentOpen] = useState(false);
  const [experimentSnapshotId, setExperimentSnapshotId] = useState<string>();
  const [selectedExperimentId, setSelectedExperimentId] = useState<string>();
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [currentCandidate, setCurrentCandidate] = useState<CandidateBundle>();
  const [expandedManuscript, setExpandedManuscript] = useState(false);
  const [promoteCandidate, setPromoteCandidate] = useState<CandidateBundle>();
  /** 错误 Alert 的「已关闭」标记：错误文本本身来自 react-query，本地只记用户是否已关掉它。 */
  const [dismissedError, setDismissedError] = useState<string>();
  const [promoteForm] = Form.useForm<{ authorId: string; decision: "accept" | "reject"; reason: string }>();

  // ---- 读：五个项目级资源 + 按需的快照详情，调用点只给 key 与路径表 ----
  const projectQuery = useNovelProject(projectId);
  const snapshotsQuery = useNovelQuery<{ snapshots: SnapshotRow[] }>(novelKeys.snapshots(projectId), novelPaths.snapshots({ projectId }), { enabled: Boolean(projectId) });
  const experimentsQuery = useNovelQuery<{ experiments: Experiment[] }>(novelKeys.experiments(projectId), novelPaths.experiments({ projectId }), { enabled: Boolean(projectId) });
  const candidatesQuery = useNovelQuery<{ candidates: CandidateBundle[] }>(novelKeys.candidates(projectId), novelPaths.candidates({ projectId }), { enabled: Boolean(projectId) });
  const receiptsQuery = useNovelQuery<{ receipts: Receipt[] }>(novelKeys.receipts(projectId), novelPaths.receipts({ projectId }), { enabled: Boolean(projectId) });
  // 快照详情按需请求：只有点开某个快照时才 enabled；未选中时用哨兵 key/path 占位，不发请求。
  const snapshotQuery = useNovelQuery<{ snapshot: SnapshotDetail }>(
    novelKeys.snapshot(selectedSnapshotId ?? "none"),
    novelPaths.snapshot({ snapshotId: selectedSnapshotId ?? "none" }),
    { enabled: Boolean(selectedSnapshotId) },
  );

  // ---- 写：路径/方法/请求体/失效面都来自命令注册表，调用点只给业务入参 ----
  const snapshotCaptureCmd = useNovelCommand<{ projectId: string }>(novelCommands.snapshotCapture);
  const experimentCreateCmd = useNovelCommand<{ projectId: string; snapshotId: string }>(novelCommands.experimentCreate);
  const experimentDeleteCmd = useNovelCommand<{ projectId: string; experimentId: string }>(novelCommands.experimentDelete);
  const experimentCloseCmd = useNovelCommand<{ projectId: string; experimentId: string }>(novelCommands.experimentClose);
  const candidateGenerateCmd = useNovelCommand<{ projectId: string; experimentId: string; documentId: string }, { candidate: CandidateBundle }>(novelCommands.candidateGenerate);
  const candidatePromoteCmd = useNovelCommand<{ projectId: string; candidateId: string; authorId?: string; decision: string; reason?: string }>(novelCommands.candidatePromote);

  // ---- 派生数据（渲染面与迁移前逐项对齐） ----
  const project = projectQuery.data;
  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const experiments = experimentsQuery.data?.experiments ?? [];
  const candidates = candidatesQuery.data?.candidates ?? [];
  const receipts = receiptsQuery.data?.receipts ?? [];
  const snapshotDetail = snapshotQuery.data?.snapshot;
  const loading = projectQuery.isFetching || snapshotsQuery.isFetching || experimentsQuery.isFetching || candidatesQuery.isFetching || receiptsQuery.isFetching;
  const allLoaded = !projectQuery.isLoading && !snapshotsQuery.isLoading && !experimentsQuery.isLoading && !candidatesQuery.isLoading && !receiptsQuery.isLoading;
  const loadError = projectQuery.error ?? snapshotsQuery.error ?? experimentsQuery.error ?? candidatesQuery.error ?? receiptsQuery.error;
  const error = loadError && loadError.message !== dismissedError ? loadError.message : undefined;

  /**
   * loadAll 的「统一重算」语义：原实现用 Promise.all 等 5 个 GET 全部回来后，**一次性**重算
   * selected 系状态与 currentCandidate（含各自的兜底）。这里保留同一时点——依赖这 5 个 data，
   * 且首轮只在全部就绪（!isLoading）后执行，此后任一 data 变化（含写操作按失效面重取）再统一重算一次。
   *
   * 刻意不把这些重算塞进各 query 的 onSuccess/各自的 effect：那会退化成「谁先回来谁先算」，
   * 丢掉"5 个 GET 都回来"这一并发语义（例如章节兜底会先于实验列表到达而提前落定）。
   */
  useEffect(() => {
    if (!projectId || !allLoaded) return;
    const nextExperiments = experimentsQuery.data?.experiments ?? [];
    const nextCandidates = candidatesQuery.data?.candidates ?? [];
    const nextDocuments = projectQuery.data?.documents ?? [];
    const nextActiveExperiment = nextExperiments.find((item) => item.status === "active");
    setCurrentCandidate((previous) => (previous ? nextCandidates.find((item) => item.id === previous.id) ?? nextCandidates[0] : nextCandidates[0]));
    setSelectedExperimentId((previous) => previous && nextExperiments.some((item) => item.id === previous && item.status === "active") ? previous : nextActiveExperiment?.id);
    setSelectedDocumentId((previous) => previous && nextDocuments.some((item) => item.id === previous) ? previous : nextDocuments[0]?.id);
  }, [projectId, allLoaded, projectQuery.data, snapshotsQuery.data, experimentsQuery.data, candidatesQuery.data, receiptsQuery.data]);

  /** 快照详情取用失败保留原来的 message.error 提示（原 viewSnapshot 的 catch 分支）。 */
  useEffect(() => {
    if (snapshotQuery.error) message.error(snapshotQuery.error.message);
  }, [snapshotQuery.error]);

  function refreshAll() {
    void projectQuery.refetch();
    void snapshotsQuery.refetch();
    void experimentsQuery.refetch();
    void candidatesQuery.refetch();
    void receiptsQuery.refetch();
  }

  async function captureSnapshot() {
    try {
      await snapshotCaptureCmd.mutateAsync({ projectId });
      message.success("作品基线已保存");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  function viewSnapshot(snapshotId: string) {
    // 同一份快照再次点开＝重取，对齐原来"每次点击都发一次请求"的行为。
    if (snapshotId === selectedSnapshotId) {
      void snapshotQuery.refetch();
      return;
    }
    setSelectedSnapshotId(snapshotId);
  }

  async function createExperiment() {
    if (!experimentSnapshotId) {
      message.warning("请先选择一个作品基线");
      return;
    }
    try {
      await experimentCreateCmd.mutateAsync({ projectId, snapshotId: experimentSnapshotId });
      message.success("隔离实验已创建，可以开始生成候选稿");
      setCreateExperimentOpen(false);
      setExperimentSnapshotId(undefined);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteExperiment(experimentId: string) {
    try {
      await experimentDeleteCmd.mutateAsync({ projectId, experimentId });
      message.success("隔离实验已删除");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function closeExperiment(experimentId: string) {
    try {
      await experimentCloseCmd.mutateAsync({ projectId, experimentId });
      message.success("隔离实验已关闭，正式作品不受影响");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function generateCandidate() {
    if (!selectedExperimentId || !selectedDocumentId) {
      message.warning("请先选择隔离实验和目标章节");
      return;
    }
    try {
      const body = await candidateGenerateCmd.mutateAsync({ projectId, experimentId: selectedExperimentId, documentId: selectedDocumentId });
      setCurrentCandidate(body.candidate);
      setExpandedManuscript(false);
      message.success("候选稿已生成，正式作品尚未改变");
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitPromotion(values: { authorId: string; decision: "accept" | "reject"; reason: string }) {
    if (!promoteCandidate) return;
    try {
      await candidatePromoteCmd.mutateAsync({ projectId, candidateId: promoteCandidate.id, authorId: values.authorId, decision: values.decision, reason: values.reason });
      message.success(values.decision === "accept" ? "候选稿已提交晋升" : "候选稿已拒绝，正式作品未改变");
      setPromoteCandidate(undefined);
      promoteForm.resetFields();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }

  const documents = project?.documents ?? [];
  const activeExperiments = experiments.filter((experiment) => experiment.status === "active");
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const selectedExperiment = experiments.find((experiment) => experiment.id === selectedExperimentId);
  const selectedBaseSnapshot = selectedExperiment ? snapshotMap.get(selectedExperiment.baseSnapshotId) : undefined;
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId);
  const currentCandidateDocument = currentCandidate ? documents.find((document) => document.id === currentCandidate.target.documentId) : undefined;
  const promotedCount = receipts.filter((receipt) => receipt.status === "promoted").length;
  const rollbackCount = receipts.filter((receipt) => receipt.status === "rolled-back").length;
  const manuscriptPreview = currentCandidate
    ? expandedManuscript
      ? currentCandidate.manuscript.plainText
      : currentCandidate.manuscript.plainText.slice(0, 720)
    : "";
  const snapshotOptions = snapshots.map((snapshot) => ({
    value: snapshot.id,
    label: `${snapshotName(snapshot)} · ${snapshotHead(snapshot).finalDocumentHashes?.length ?? 0} 章`,
  }));
  const documentOptions = documents.map((document) => ({
    value: document.id,
    label: documentName(document),
    disabled: document.status === "planned",
  }));
  const experimentOptions = activeExperiments.map((experiment) => ({
    value: experiment.id,
    label: experimentName(experiment, snapshotMap.get(experiment.baseSnapshotId)),
  }));

  return (
    <div className="novel-eval-page">
      <motion.header
        className="novel-topbar novel-eval-topbar"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="novel-topbar-body" style={{ minWidth: 0 }}>
          <span className="novel-eyebrow">评估闭环</span>
          <h2 className="novel-display-h2" style={{ marginTop: 2 }}>把一次失败，变成可验证的改进</h2>
          <p className="novel-lede" style={{ margin: "8px 0 0" }}>
            在作品副本里试写和对比，只有你确认后，候选章节与可复用经验才会进入正式作品。
          </p>
          <div className="novel-eval-project-context">
            <FileTextOutlined />
            <span>当前作品</span>
            <strong>{project?.title ?? "正在读取作品"}</strong>
            {project?.currentRevision !== undefined && <span className="novel-eval-muted">修订 {project.currentRevision}</span>}
          </div>
        </div>
        <div className="novel-topbar-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refreshAll()}>刷新</Button>
          <Button type="primary" aria-label="捕获快照，保存当前基线" icon={<CameraOutlined />} loading={snapshotCaptureCmd.isPending} onClick={() => void captureSnapshot()}>保存当前基线</Button>
        </div>
      </motion.header>

      {error && <Alert type="error" showIcon message={error} className="novel-v2-alert" closable onClose={() => setDismissedError(loadError?.message)} />}

      <motion.section
        className="novel-eval-steps"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className={`novel-eval-step ${snapshots.length ? "is-ready" : "is-current"}`}>
          <span className="novel-eval-step-number">01</span>
          <div><strong>保存作品基线</strong><p>锁定这次正式作品状态</p></div>
          {snapshots.length ? <CheckOutlined /> : <CameraOutlined />}
        </div>
        <ArrowRightOutlined className="novel-eval-step-arrow" />
        <div className={`novel-eval-step ${activeExperiments.length ? "is-ready" : snapshots.length ? "is-current" : ""}`}>
          <span className="novel-eval-step-number">02</span>
          <div><strong>创建隔离实验</strong><p>在副本里尝试，不污染主线</p></div>
          {activeExperiments.length ? <CheckOutlined /> : <ExperimentOutlined />}
        </div>
        <ArrowRightOutlined className="novel-eval-step-arrow" />
        <div className={`novel-eval-step ${currentCandidate ? "is-ready" : activeExperiments.length ? "is-current" : ""}`}>
          <span className="novel-eval-step-number">03</span>
          <div><strong>生成候选稿</strong><p>得到一份可以阅读的修改结果</p></div>
          {currentCandidate ? <CheckOutlined /> : <ThunderboltOutlined />}
        </div>
        <ArrowRightOutlined className="novel-eval-step-arrow" />
        <div className={`novel-eval-step ${promotedCount ? "is-ready" : ""}`}>
          <span className="novel-eval-step-number">04</span>
          <div><strong>审核并应用</strong><p>确认后才写入正式作品</p></div>
          {promotedCount ? <CheckOutlined /> : <RocketOutlined />}
        </div>
      </motion.section>

      <section className="novel-eval-stats" aria-label="闭环概览">
        <div className="novel-eval-stat"><span>可用作品基线</span><strong>{snapshots.length}</strong><small>实验从这里复制，不覆盖正文</small></div>
        <div className="novel-eval-stat"><span>正在进行的隔离实验</span><strong>{activeExperiments.length}</strong><small>可继续生成候选稿</small></div>
        <div className="novel-eval-stat"><span>待你判断的候选稿</span><strong>{candidates.length}</strong><small>每份都对应一个章节结果</small></div>
        <div className="novel-eval-stat is-accent"><span>已应用的改进</span><strong>{promotedCount}</strong><small>{rollbackCount ? `${rollbackCount} 次回滚记录` : "正式作品暂无回滚"}</small></div>
      </section>

      <section className="novel-eval-workspace">
        <motion.main
          className="novel-eval-focal"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        >
          <section className="novel-eval-builder" id="candidate-builder">
            <div className="novel-eval-section-heading">
              <div>
                <span className="novel-eval-section-kicker">下一步</span>
                <h3>生成一份候选稿</h3>
                <p>选择隔离实验和目标章节。系统会把结果留在副本里，方便你先读完再决定。</p>
              </div>
              <span className="novel-eval-safe-badge"><LockOutlined /> 不影响正式作品</span>
            </div>

            <div className="novel-eval-form-grid">
              <label className="novel-eval-field">
                <span>使用哪个隔离实验</span>
                <Select
                  value={selectedExperimentId}
                  onChange={setSelectedExperimentId}
                  options={experimentOptions}
                  placeholder={activeExperiments.length ? "选择隔离实验" : "请先创建隔离实验"}
                  disabled={!activeExperiments.length}
                />
                <small>{selectedBaseSnapshot ? `基于 ${snapshotName(selectedBaseSnapshot)}` : selectedExperiment ? "这份实验的基线已归档" : "隔离实验会使用一份固定基线"}</small>
              </label>
              <label className="novel-eval-field">
                <span>要改进哪一章</span>
                <Select
                  value={selectedDocumentId}
                  onChange={setSelectedDocumentId}
                  options={documentOptions}
                  placeholder={documents.length ? "选择目标章节" : "暂无可用章节"}
                  disabled={!documents.length}
                />
                <small>{selectedDocument ? `当前版本第 ${selectedDocument.narrativeOrder} 章，生成后可与原稿对照` : "章节名称会显示在候选结果中"}</small>
              </label>
            </div>
            <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={candidateGenerateCmd.isPending} disabled={!selectedExperimentId || !selectedDocumentId} block onClick={() => void generateCandidate()}>
              生成候选稿
            </Button>
            {!activeExperiments.length && (
              <div className="novel-eval-inline-help">
                <ExperimentOutlined />
                <span>还没有可用的隔离实验。先保存基线，再点击右侧“创建”建立一个不会影响正式作品的副本。</span>
                <Button type="link" onClick={() => setCreateExperimentOpen(true)}>去创建 <ArrowRightOutlined /></Button>
              </div>
            )}
          </section>

          <section className="novel-eval-preview">
            <div className="novel-eval-section-heading">
              <div>
                <span className="novel-eval-section-kicker">阅读结果</span>
                <h3>候选预览</h3>
                <p>这里看到的是实验结果，不是已经写入的正文。阅读后再决定是否晋升。</p>
              </div>
              {currentCandidate && <Tag color="green">待作者判断</Tag>}
            </div>

            {currentCandidate ? (
              <div className="novel-candidate-preview novel-eval-preview-body">
                <div className="novel-eval-candidate-title-row">
                  <div>
                    <Typography.Title level={4} style={{ color: "#f4f4f5", margin: 0 }}>{currentCandidate.manuscript.title}</Typography.Title>
                    <div className="novel-eval-candidate-meta">
                      <span>{documentName(currentCandidateDocument, currentCandidate.target.documentId)}</span>
                      <span>{currentCandidate.manuscript.wordCount.toLocaleString("zh-CN")} 字</span>
                      <span>{candidateEvidenceLabel(currentCandidate)}</span>
                    </div>
                  </div>
                  <Button type="primary" icon={<RocketOutlined />} onClick={() => { promoteForm.resetFields(); setPromoteCandidate(currentCandidate); }}>
                    审核并决定
                  </Button>
                </div>
                <div className="novel-manuscript-text">
                  {manuscriptPreview}
                  {currentCandidate.manuscript.plainText.length > 720 && (
                    <Button type="link" size="small" onClick={() => setExpandedManuscript(!expandedManuscript)}>{expandedManuscript ? "收起正文" : "展开全文"}</Button>
                  )}
                </div>

                <div className="novel-eval-result-grid">
                  <div className="novel-eval-result-block">
                    <div className="novel-eval-result-label"><FileSearchOutlined /> 这份候选带来的事实</div>
                    <strong>{currentCandidate.acceptedFacts.length} 条</strong>
                    <p>会在晋升时写入事实账本，拒绝则不会进入正式库。</p>
                    {currentCandidate.acceptedFacts.length > 0 && <div className="novel-fact-list">{currentCandidate.acceptedFacts.slice(0, 3).map((fact) => <div key={fact.sourceClaimId} className="novel-fact-item"><Tag color="blue">{fact.payload.kind}</Tag><Typography.Text strong>{fact.payload.title}</Typography.Text></div>)}</div>}
                  </div>
                  <div className="novel-eval-result-block">
                    <div className="novel-eval-result-label"><SwapOutlined /> 这份候选带来的写法改进</div>
                    <strong>{currentCandidate.iteratedSkills.length} 项</strong>
                    <p>会更新对应 Skill 的正式版本，后续章节可复用。</p>
                    {currentCandidate.iteratedSkills.length > 0 && <div className="novel-skill-list">{currentCandidate.iteratedSkills.slice(0, 2).map((skill) => <div key={skill.id} className="novel-skill-item"><div className="novel-skill-item-head"><SwapOutlined /><Typography.Text strong>{skill.skillId}</Typography.Text></div><Typography.Text type="secondary">{skill.rationale}</Typography.Text></div>)}</div>}
                  </div>
                </div>

                <details className="novel-eval-technical-details">
                  <summary><CodeOutlined /> 查看技术追踪信息</summary>
                  <div className="novel-eval-technical-grid">
                    <span>候选稿 ID</span><code>{currentCandidate.id}</code>
                    <span>工作流运行</span><code>{currentCandidate.provenance.workflowRunId}</code>
                    <span>基线版本</span><code>revision {currentCandidate.target.baseRevision} · {shortId(currentCandidate.target.baseContentHash, 12)}</code>
                  </div>
                </details>
              </div>
            ) : (
              <div className="novel-empty novel-eval-empty-preview">
                <div className="novel-empty-mark"><ThunderboltOutlined /></div>
                <div className="novel-empty-title">还没有候选稿</div>
                <div className="novel-empty-desc">候选稿是可以阅读和比较的实验结果。先选择隔离实验与章节，再生成一份。</div>
              </div>
            )}
          </section>
        </motion.main>

        <motion.aside
          className="novel-eval-observer"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
        >
          <section className="novel-eval-side-panel">
            <div className="novel-eval-side-heading">
              <div><span className="novel-eval-section-kicker">实验起点</span><h3>项目快照 <small>快照列表</small></h3></div>
              <Tag>{snapshots.length}</Tag>
            </div>
            <p className="novel-eval-side-description">快照是正式作品的只读基线，用来保证实验前后有明确的对照。</p>
            <div className="novel-eval-record-list">
              {snapshots.slice(0, 4).map((snapshot, index) => {
                const head = snapshotHead(snapshot);
                return (
                  <div className="novel-eval-record" key={snapshot.id}>
                    <div className="novel-eval-record-icon"><CameraOutlined /></div>
                    <div className="novel-eval-record-main">
                      <strong>{index === 0 ? "最近的作品基线" : snapshotName(snapshot)}</strong>
                      <span>{formatDate(snapshot.created_at)} · 修订 {head.projectRevision ?? "未知"} · {head.finalDocumentHashes?.length ?? 0} 章</span>
                    </div>
                    <Button type="link" icon={<EyeOutlined />} aria-label={`查看${snapshotName(snapshot)}`} onClick={() => viewSnapshot(snapshot.id)}>查看组成</Button>
                  </div>
                );
              })}
              {!snapshots.length && <div className="novel-eval-side-empty"><CameraOutlined /><span>还没有作品基线</span><small>点击页面右上角“保存当前基线”开始</small></div>}
            </div>
          </section>

          <section className="novel-eval-side-panel">
            <div className="novel-eval-side-heading">
              <div><span className="novel-eval-section-kicker">安全试写</span><h3>实验工作区 <small>实验工作区</small></h3></div>
              <Button size="small" type="primary" aria-label="操作：创建隔离实验" icon={<ExperimentOutlined />} onClick={() => setCreateExperimentOpen(true)}>创建</Button>
            </div>
            <p className="novel-eval-side-description">每个工作区都是一份独立副本。关闭或删除它，都不会改动正式作品。</p>
            <div className="novel-eval-record-list">
              {experiments.slice(0, 5).map((experiment) => {
                const meta = experimentStatusMeta(experiment.status);
                const baseSnapshot = snapshotMap.get(experiment.baseSnapshotId);
                const isSelected = experiment.id === selectedExperimentId;
                return (
                  <div className={`novel-eval-record ${isSelected ? "is-selected" : ""}`} key={experiment.id}>
                    <div className="novel-eval-record-icon"><ExperimentOutlined /></div>
                    <div className="novel-eval-record-main">
                      <strong>{experimentName(experiment, baseSnapshot)}</strong>
                      <span><Tag color={statusColor(experiment.status)}>{meta.label}</Tag>{baseSnapshot ? `基于 ${snapshotName(baseSnapshot)}` : "基线已归档"}</span>
                    </div>
                    <div className="novel-eval-record-actions">
                      {experiment.status === "active" && <Tooltip title="继续使用"><Button type="text" icon={<ArrowRightOutlined />} aria-label="继续使用此实验" onClick={() => { setSelectedExperimentId(experiment.id); document.getElementById("candidate-builder")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} /></Tooltip>}
                      {experiment.status === "active" && <Tooltip title="关闭实验"><Button type="text" icon={<CloseOutlined />} aria-label="关闭此实验" onClick={() => void closeExperiment(experiment.id)} /></Tooltip>}
                      <Popconfirm title="删除这个隔离实验？" description="删除后无法继续查看其中的实验数据。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void deleteExperiment(experiment.id)}>
                        <Tooltip title="删除实验"><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除此实验" /></Tooltip>
                      </Popconfirm>
                    </div>
                  </div>
                );
              })}
              {!experiments.length && <div className="novel-eval-side-empty"><ExperimentOutlined /><span>还没有隔离实验</span><small>从已保存的作品基线创建一个副本</small></div>}
            </div>
          </section>

          <section className="novel-eval-side-panel">
            <div className="novel-eval-side-heading">
              <div><span className="novel-eval-section-kicker">待处理</span><h3>候选包列表 <small>候选稿件</small></h3></div>
              <Tag>{candidates.length}</Tag>
            </div>
            <div className="novel-eval-record-list">
              {candidates.slice(0, 5).map((candidate) => {
                const candidateDocument = documents.find((document) => document.id === candidate.target.documentId);
                const receipt = receipts.find((item) => item.candidateId === candidate.id);
                const isCurrent = currentCandidate?.id === candidate.id;
                return (
                  <div className={`novel-eval-candidate-record ${isCurrent ? "is-selected" : ""}`} key={candidate.id}>
                    <div className="novel-eval-candidate-record-main" onClick={() => setCurrentCandidate(candidate)}>
                      <strong>{candidate.manuscript.title}</strong>
                      <span>{documentName(candidateDocument, candidate.target.documentId)} · {candidate.manuscript.wordCount.toLocaleString("zh-CN")} 字</span>
                      <small>{receipt ? receiptStatusMeta(receipt.status).label : candidateEvidenceLabel(candidate)}</small>
                    </div>
                    <Button size="small" type={isCurrent ? "primary" : "default"} onClick={() => { setCurrentCandidate(candidate); if (!receipt) { promoteForm.resetFields(); setPromoteCandidate(candidate); } }}>{receipt ? "查看" : "审核"}</Button>
                  </div>
                );
              })}
              {!candidates.length && <div className="novel-eval-side-empty"><FileTextOutlined /><span>还没有候选稿</span><small>生成后会在这里保留，方便回看和决策</small></div>}
            </div>
          </section>

          <section className="novel-eval-side-panel">
            <div className="novel-eval-side-heading">
              <div><span className="novel-eval-section-kicker">已发生</span><h3>晋升收据</h3></div>
              <Tag>{receipts.length}</Tag>
            </div>
            <div className="novel-eval-receipt-list">
              {receipts.slice(0, 4).map((receipt) => {
                const meta = receiptStatusMeta(receipt.status);
                const receiptCandidate = candidates.find((candidate) => candidate.id === receipt.candidateId);
                return (
                  <div className="novel-eval-receipt" key={receipt.id}>
                    <span className={meta.pill}>{meta.icon}<span>{meta.label}</span></span>
                    <div><strong>{receiptCandidate?.manuscript.title ?? "候选稿"}</strong><small>{formatDate(receipt.createdAt)} · {receipt.result.skillUpdates?.length ?? 0} 项写法改进 · {receipt.result.factIds?.length ?? 0} 条事实</small></div>
                  </div>
                );
              })}
              {!receipts.length && <div className="novel-eval-side-empty compact"><CheckCircleOutlined /><span>完成晋升后会留下记录</span></div>}
            </div>
          </section>
        </motion.aside>
      </section>

      <Modal title="项目基线组成" open={Boolean(snapshotDetail)} onCancel={() => setSelectedSnapshotId(undefined)} footer={null} width={720} destroyOnHidden>
        {snapshotDetail && (
          <div className="novel-eval-snapshot-detail">
            <div className="novel-eval-modal-intro"><CameraOutlined /><div><strong>{snapshotName(snapshotDetail)}</strong><p>这份只读副本保存了当时的章节、事实、角色关系和写作规则，实验会从它开始。</p></div></div>
            <div className="novel-eval-modal-stats">
              <div><strong>{snapshotDetail.payload?.documents?.length ?? 0}</strong><span>章节</span></div>
              <div><strong>{snapshotDetail.payload?.memoryClaims?.length ?? 0}</strong><span>事实记录</span></div>
              <div><strong>{snapshotDetail.payload?.skillDefinitions?.length ?? 0}</strong><span>写作规则</span></div>
              <div><strong>{snapshotDetail.payload?.reviews?.length ?? 0}</strong><span>审核记录</span></div>
            </div>
            <details className="novel-eval-technical-details"><summary><CodeOutlined /> 查看完整校验信息</summary><pre>{JSON.stringify(snapshotDetail, null, 2)}</pre></details>
          </div>
        )}
      </Modal>

      <Modal title="创建隔离实验" open={createExperimentOpen} onCancel={() => setCreateExperimentOpen(false)} footer={null} destroyOnHidden>
        <div className="novel-eval-modal-intro"><LockOutlined /><div><strong>先复制，再试写</strong><p>实验会从选定的作品基线复制一份独立数据。实验中的生成、事实提取和规则迭代都不会写入正式作品。</p></div></div>
        <Form layout="vertical" style={{ marginTop: 20 }}>
          <Form.Item label="从哪份作品基线开始" required><Select placeholder="选择作品基线" value={experimentSnapshotId} onChange={setExperimentSnapshotId} options={snapshotOptions} /></Form.Item>
          <Button type="primary" block icon={<ExperimentOutlined />} disabled={!experimentSnapshotId} onClick={() => void createExperiment()}>创建隔离实验</Button>
        </Form>
      </Modal>

      <Modal title="审核候选稿" open={Boolean(promoteCandidate)} onCancel={() => { setPromoteCandidate(undefined); promoteForm.resetFields(); }} footer={null} destroyOnHidden>
        {promoteCandidate && (
          <>
            <div className="novel-eval-modal-intro"><RocketOutlined /><div><strong>{promoteCandidate.manuscript.title}</strong><p>接受会把候选章节和其中已验证的改进写入正式作品。拒绝只会留下审计记录，不改变现有正文。</p></div></div>
            <Form form={promoteForm} layout="vertical" initialValues={{ authorId: "web-author", decision: "accept" }} onFinish={(values) => void submitPromotion(values)} style={{ marginTop: 20 }}>
              <Form.Item name="authorId" label="记录人" rules={[{ required: true, message: "请输入记录人" }]}><Input placeholder="web-author" /></Form.Item>
              <Form.Item name="decision" label="你的决定" rules={[{ required: true }]}><Select options={[{ value: "accept", label: decisionMeta("accept").label + "，写入正式作品" }, { value: "reject", label: decisionMeta("reject").label + "，保持现状" }]} /></Form.Item>
              <Form.Item name="reason" label="判断依据"><Input.TextArea rows={3} placeholder="记录你为什么接受或拒绝这份候选稿" /></Form.Item>
              <Button type="primary" htmlType="submit" block loading={candidatePromoteCmd.isPending} icon={<CheckCircleOutlined />}>提交决定</Button>
            </Form>
          </>
        )}
      </Modal>
    </div>
  );
}
