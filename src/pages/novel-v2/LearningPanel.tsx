import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Popconfirm, Select, Tag, message } from "antd";
import {
  CheckOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  useNovelLearningCenter,
  usePromoteCraftRuleCandidate,
  useRunCraftRuleCandidateExperiment,
  useSubmitCraftRuleCandidateReview,
  type NovelCraftRuleCandidate,
  type NovelDocumentSummary,
} from "@/lib/novelApi";

const STATUS_META: Record<NovelCraftRuleCandidate["status"], { label: string; color: string }> = {
  proposed: { label: "待回归", color: "default" },
  evidencing: { label: "回归中", color: "processing" },
  reviewing: { label: "待审核", color: "warning" },
  promoted: { label: "已晋升", color: "success" },
  "rolled-back": { label: "已回滚", color: "error" },
  rejected: { label: "已拒绝", color: "error" },
};

function text(value: string | undefined, fallback = "未记录"): string {
  return value?.trim() || fallback;
}

export default function LearningPanel({ projectId, documents }: { projectId: string; documents: NovelDocumentSummary[] }) {
  const centerQ = useNovelLearningCenter(projectId);
  const experiment = useRunCraftRuleCandidateExperiment(projectId);
  const review = useSubmitCraftRuleCandidateReview(projectId);
  const promote = usePromoteCraftRuleCandidate(projectId);
  const [selectedId, setSelectedId] = useState<string>();
  const [crossScenarioDocumentId, setCrossScenarioDocumentId] = useState<string>();

  const candidates = centerQ.data?.candidates ?? [];
  const assessments = centerQ.data?.assessments ?? [];
  const finalDocuments = useMemo(() => documents.filter((document) => document.status === "final"), [documents]);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0];
  const selectedAssessment = assessments.find((item) => item.candidate?.id === selected?.id || item.assessment.id === selected?.learningSource?.assessmentId);
  const sourceDocumentId = selectedAssessment?.sourceChapter?.id;

  useEffect(() => {
    if (!selectedId && candidates[0]) setSelectedId(candidates[0].id);
  }, [candidates, selectedId]);
  useEffect(() => {
    const validCrossScenario = crossScenarioDocumentId
      && crossScenarioDocumentId !== sourceDocumentId
      && finalDocuments.some((document) => document.id === crossScenarioDocumentId);
    if (!validCrossScenario) setCrossScenarioDocumentId(finalDocuments.find((document) => document.id !== sourceDocumentId)?.id);
  }, [crossScenarioDocumentId, finalDocuments, sourceDocumentId]);

  async function runExperiment() {
    if (!selected || !sourceDocumentId || !crossScenarioDocumentId) return;
    try {
      const result = await experiment.mutateAsync({ candidateId: selected.id, crossScenarioDocumentId });
      message[result.result?.passed ? "success" : "warning"](result.result?.passed ? "两类章节回归均通过，候选进入作者审核" : "回归未通过，正式 skill 未改变");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitReview(verdict: "passed" | "rejected") {
    if (!selected) return;
    try {
      await review.mutateAsync({ candidateId: selected.id, verdict, summary: verdict === "passed" ? "作者确认机制、边界与回归证据可接受" : "作者拒绝该经验候选" });
      message.success(verdict === "passed" ? "已通过作者审核" : "候选已拒绝");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function promoteCandidate() {
    if (!selected) return;
    try {
      await promote.mutateAsync({ candidateId: selected.id, authorId: "web-author" });
      message.success("已原子晋升；后续 drafting/revision 将读取新版本");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  if (centerQ.isLoading) return <div className="pb-context-info"><p>正在加载经验沉淀...</p></div>;
  if (centerQ.isError) return <Alert type="error" showIcon message="经验沉淀加载失败" description={centerQ.error instanceof Error ? centerQ.error.message : undefined} />;

  return <div className="pb-context-info pb-learning-panel">
    <div className="pb-learning-summary">
      <div><strong>{assessments.length}</strong><span>次评估</span></div>
      <div><strong>{candidates.length}</strong><span>条候选</span></div>
      <div><strong>{candidates.filter((candidate) => candidate.status === "promoted").length}</strong><span>已晋升</span></div>
    </div>

    <section>
      <header>Learning assessment</header>
      {assessments.length ? <div className="pb-learning-assessments">{assessments.slice(0, 12).map((item) => <div key={item.assessment.id}>
        <div><Tag color={item.assessment.conclusion === "propose-improvement" ? "gold" : "default"}>{item.assessment.conclusion === "propose-improvement" ? "提出改进" : "无共享经验"}</Tag><span>{item.sourceChapter?.title ?? item.assessment.source.workflowId}</span></div>
        <p>{text(item.assessment.underlyingMechanism, item.assessment.symptom ?? "未记录机制")}</p>
        {item.assessment.candidate && <small>{item.assessment.candidate.targetKind} / {item.assessment.candidate.targetId}</small>}
      </div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 learning assessment" />}
    </section>

    <section>
      <header><ExperimentOutlined /> 候选队列</header>
      {candidates.length ? <div className="pb-learning-candidates">
        {candidates.map((candidate) => <button key={candidate.id} type="button" className={`pb-learning-candidate ${selected?.id === candidate.id ? "is-selected" : ""}`} onClick={() => setSelectedId(candidate.id)}>
          <span>{candidate.targetId}</span>
          <Tag color={STATUS_META[candidate.status].color}>{STATUS_META[candidate.status].label}</Tag>
          <small>{candidate.beforeVersion} → {candidate.proposedVersion}</small>
        </button>)}
      </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无改进候选" />}
    </section>

    {selected && <>
      <section>
        <header><SafetyCertificateOutlined /> 候选详情 <Tag color={STATUS_META[selected.status].color}>{STATUS_META[selected.status].label}</Tag></header>
        <dl>
          <div><dt>目标</dt><dd>{selected.targetKind} / {selected.targetId}</dd></div>
          <div><dt>来源章节</dt><dd>{selectedAssessment?.sourceChapter?.title ?? "未关联"}</dd></div>
          <div><dt>影响输入类</dt><dd>{text(selected.scope.affectedInputClass, selectedAssessment?.assessment.affectedInputClass ?? "未记录")}</dd></div>
          <div><dt>底层机制</dt><dd>{text(selected.scope.underlyingMechanism, selectedAssessment?.assessment.underlyingMechanism ?? "未记录")}</dd></div>
          <div><dt>适用边界</dt><dd>{selected.scope.boundaries.length ? selected.scope.boundaries.join("；") : text(selectedAssessment?.assessment.boundaries)}</dd></div>
          <div><dt>回归风险</dt><dd>{selected.scope.regressionRisks.length ? selected.scope.regressionRisks.join("；") : "未记录"}</dd></div>
        </dl>
      </section>

      <section>
        <header><WarningOutlined /> Prompt 变更</header>
        <div className="pb-learning-prompt"><small>before · {selected.beforeVersion}</small><pre>{selected.beforeText}</pre></div>
        <div className="pb-learning-prompt"><small>after · {selected.proposedVersion}</small><pre>{selected.afterText}</pre></div>
      </section>

      <section>
        <header>隔离章节回归</header>
        {selected.targetKind === "system-prompt" && <Alert type="info" showIcon message="该候选尚未绑定章节实际消费点" description="当前章节实验只对 skill target 开放，正式版本保持不变。" />}
        {selected.targetKind === "skill" && <>
          {selectedAssessment?.sourceChapter
            ? <div className="pb-learning-source"><span>原失败场景</span><strong>{selectedAssessment.sourceChapter.narrativeOrder}. {selectedAssessment.sourceChapter.title}</strong></div>
            : <Alert type="warning" showIcon message="候选未关联原失败章节" style={{ marginBottom: 8 }} />}
          <Select placeholder="异构场景章节" value={crossScenarioDocumentId} onChange={setCrossScenarioDocumentId} options={finalDocuments.filter((document) => document.id !== sourceDocumentId).map((document) => ({ value: document.id, label: `${document.narrativeOrder}. ${document.title}` }))} style={{ width: "100%", marginBottom: 8 }} />
          <Button block icon={<ExperimentOutlined />} loading={experiment.isPending} disabled={!sourceDocumentId || !crossScenarioDocumentId || selected.status === "reviewing" || selected.status === "promoted" || selected.status === "rejected"} onClick={() => void runExperiment()}>开始隔离回归</Button>
          {experiment.isError && <Alert type="warning" showIcon message="异构场景不满足回归要求" description={experiment.error instanceof Error ? experiment.error.message : String(experiment.error)} style={{ marginTop: 8 }} />}
        </>}
        {selected.evidenceCases.length > 0 && <div className="pb-learning-evidence">{selected.evidenceCases.map((evidence, index) => <div key={`${evidence.experimentId ?? evidence.candidateWorkItemId}:${index}`}><span>{evidence.scenarioRole === "source-failure" ? "原失败场景" : "异构场景"} · {evidence.scenarioClass}</span><Tag color={evidence.regressionPassed ? "success" : "error"}>{evidence.regressionPassed ? "通过" : "失败"}</Tag><small>{evidence.summary}</small></div>)}</div>}
      </section>

      <section className="pb-learning-actions">
        <header>作者确认</header>
        <Button icon={<CheckOutlined />} disabled={selected.status !== "evidencing" && selected.status !== "reviewing"} loading={review.isPending} onClick={() => void submitReview("passed")}>通过规则审核</Button>
        <Popconfirm title="拒绝该候选？" onConfirm={() => void submitReview("rejected")}><Button danger disabled={selected.status !== "evidencing" && selected.status !== "reviewing"} loading={review.isPending}>拒绝候选</Button></Popconfirm>
        <Button type="primary" icon={<SafetyCertificateOutlined />} disabled={selected.status !== "reviewing" || !selected.reviews.some((item) => item.verdict === "passed")} loading={promote.isPending} onClick={() => void promoteCandidate()}>晋升正式版本</Button>
      </section>
    </>}
  </div>;
}
