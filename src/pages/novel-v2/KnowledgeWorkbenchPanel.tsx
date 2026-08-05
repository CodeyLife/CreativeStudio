import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Popconfirm, Segmented, Space, Table, Tabs, Tag, Tooltip, message } from "antd";
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, ExclamationCircleOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TeamOutlined } from "@ant-design/icons";
import { motion } from "motion/react";
import "../novel-v2.css";
import { novelFetch as readJson } from "../../lib/novelApi";
import { knowledgeKindMeta, shortId } from "./presentation";
import KnowledgeRecordForm, { type KnowledgeFormKind } from "./KnowledgeRecordForm";

type KnowledgeKind = "characters" | "relations" | "claims" | "chapter-memories" | "project-skills" | "skills";
type EditableKnowledgeKind = "characters" | "relations" | "claims" | "skills";
type KnowledgeRecord = Record<string, unknown> & { id?: string; readOnly?: boolean; source?: string; displayName?: string; canonicalId?: string; displayNameStatus?: "identified" | "pending" };

const KINDS: Array<{ key: KnowledgeKind; label: string }> = [
  { key: "characters", label: "角色" },
  { key: "relations", label: "关系" },
  { key: "claims", label: "叙事事实" },
  { key: "chapter-memories", label: "章节记忆" },
  { key: "project-skills", label: "本项目 Skill" },
  { key: "skills", label: "全局 Skill 治理" },
];

const NEW_RECORD: Record<EditableKnowledgeKind, KnowledgeRecord> = {
  characters: {
    name: "",
    payload: {
      role: "",
      motivation: "",
      fear: "",
      secret: "",
      voiceAnchor: { sentenceLength: "", vocabulary: "", directness: "", avoidance: "" },
      arc: { start: "", end: "" },
      independentAction: { desire: "", strategy: "", choice: "", cost: "", knowledgeBoundary: "" },
    },
  },
  relations: { subjectId: "", predicate: "", objectId: "" },
  claims: { title: "", subjectRefs: [], predicate: "", content: "", narrativeStart: undefined, narrativeEnd: undefined },
  skills: { id: "", version: "1.0.0", capabilities: [], applicableTasks: [], qualityGates: [], promptSections: {}, enabled: true },
};

export function isEditableKnowledgeKind(kind: KnowledgeKind): kind is EditableKnowledgeKind {
  return kind === "characters" || kind === "relations" || kind === "claims" || kind === "skills";
}

function labelOf(record: KnowledgeRecord) {
  return String(record.displayName ?? record.name ?? record.title ?? record.skillId ?? record.predicate ?? record.documentId ?? record.taskKey ?? record.id ?? "未命名记录");
}

function recordId(record: KnowledgeRecord) {
  return String(record.id ?? record.skill_id ?? "");
}

function payloadOf(record: KnowledgeRecord): Record<string, unknown> {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const foundation = record.foundation;
  return foundation && typeof foundation === "object" && !Array.isArray(foundation)
    ? { ...(foundation as Record<string, unknown>), ...payload }
    : payload;
}

/** 编辑时把只读的 Foundation 档案并入 payload，确保结构化表单和 JSON 模式都不丢字段。 */
export function toEditableKnowledgeRecord(record: KnowledgeRecord): KnowledgeRecord {
  const foundation = record.foundation;
  if (!foundation || typeof foundation !== "object" || Array.isArray(foundation)) return record;
  const foundationPayload = Object.fromEntries(Object.entries(foundation as Record<string, unknown>).filter(([key]) => key !== "id" && key !== "name"));
  const editable = { ...record };
  delete editable.foundation;
  const payload = editable.payload && typeof editable.payload === "object" && !Array.isArray(editable.payload)
    ? editable.payload as Record<string, unknown>
    : {};
  return { ...editable, payload: { ...foundationPayload, ...payload } };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function roleLabel(value: unknown): string {
  const role = textOf(value);
  const labels: Record<string, string> = {
    protagonist: "主角",
    antagonist: "对手",
    ally: "盟友",
    rival: "竞争者",
    guardian: "守护者",
    wildcard: "变量",
    mentor: "引导者",
  };
  return (labels[role] ?? role) || "未设定身份";
}

function characterStatus(record: KnowledgeRecord): { label: string; color: string; pending: boolean } {
  const payload = payloadOf(record);
  const pending = payload.pendingEnrichment === true || record.displayNameStatus === "pending";
  return pending
    ? { label: "待补全", color: "gold", pending: true }
    : { label: "已建档", color: "green", pending: false };
}

function canonicalCharacterId(record: KnowledgeRecord): string {
  const payload = payloadOf(record);
  const fromPayload = textOf(payload.canonicalCharacterId);
  if (fromPayload) return fromPayload;
  if (textOf(record.canonicalId)) return textOf(record.canonicalId);
  const id = recordId(record);
  const marker = ":character:";
  return id.includes(marker) ? id.slice(id.indexOf(marker) + marker.length) : id;
}

function voiceSummary(record: KnowledgeRecord): string {
  const voice = payloadOf(record).voiceAnchor;
  if (!voice || typeof voice !== "object" || Array.isArray(voice)) return "尚未形成声部锚点";
  const values = Object.entries(voice as Record<string, unknown>).flatMap(([key, value]) => {
    const source = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).latest
      : value;
    const text = textOf(source);
    if (!text) return [];
    const labels: Record<string, string> = { sentenceLength: "句式", vocabulary: "词汇", directness: "直率", avoidance: "回避" };
    return [`${labels[key] ?? key}：${text}`];
  });
  return values.join(" · ") || "尚未形成声部锚点";
}

function CharacterDetail({ record }: { record: KnowledgeRecord }) {
  const payload = payloadOf(record);
  const status = characterStatus(record);
  const motivation = textOf(payload.motivation);
  return (
    <div className="novel-character-detail">
      <div className="novel-character-detail-hero">
        <div>
          <span className="novel-eyebrow"><TeamOutlined /> 角色档案</span>
          <h3>{labelOf(record)}</h3>
          <code>{canonicalCharacterId(record) || "未生成规范 ID"}</code>
        </div>
        <Tag color={status.color} icon={status.pending ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}>{status.label}</Tag>
      </div>
      <div className="novel-character-detail-grid">
        <div><span>身份</span><strong>{roleLabel(payload.role)}</strong></div>
        <div><span>来源</span><strong>{payload.autoCreated === true ? "关系推导" : "角色档案"}</strong></div>
        <div className="is-wide"><span>动机</span><p>{motivation || "尚未记录"}</p></div>
        <div className="is-wide"><span>声部锚点</span><p>{voiceSummary(record)}</p></div>
      </div>
    </div>
  );
}

// 按知识库类型提取人话摘要，避免直接 dump JSON
function describeRecord(kind: KnowledgeKind, record: KnowledgeRecord): string {
  const p = (kind === "characters" ? payloadOf(record) : (record.payload ?? record)) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null || v === "") ? "" : String(v);
  const arrLen = (v: unknown) => Array.isArray(v) ? v.length : 0;
  const compact = (v: unknown, max = 180) => {
    const text = str(v).replace(/\s+/gu, " ").trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
  };

  switch (kind) {
    case "characters":
      return [str(p.role), str(p.motivation)].filter(Boolean).join(" · ") || "角色档案";
    case "relations":
      return `${str(record.subjectId) || "?"} → ${str(record.predicate) || "?"} → ${str(record.objectId) || "?"}`;
    case "claims": {
      const authority = str(record.authority) || "candidate";
      const conf = typeof record.confidence === "number" ? record.confidence.toFixed(2) : "";
      return [compact(record.content), authority, conf ? `置信度 ${conf}` : ""].filter(Boolean).join(" · ");
    }
    case "chapter-memories":
      return compact(record.summary) || `第 ${str(record.narrativeStart) || "?"} 章 · ${arrLen(record.keyEvents)} 个关键事件`;
    case "project-skills":
    case "skills": {
      const ver = str(record.version);
      const caps = arrLen(record.capabilities);
      const enabled = record.enabled === false ? "已禁用" : "已启用";
      return `${enabled}${ver ? ` · v${ver}` : ""} · ${caps} 项能力`;
    }
    default:
      return str(record.name) || "记录";
  }
}

function sourceLabel(source: unknown): string {
  switch (source) {
    case "project-plan": return "当前契约";
    case "fact-extraction": return "章节抽取";
    case "manual-claim": return "作者维护";
    case "chapter-memory": return "章节派生";
    case "skill-bundle": return "当前 Bundle";
    case "skill-definition": return "全局定义";
    default: return "项目投影";
  }
}

export default function KnowledgeWorkbenchPanel({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<KnowledgeKind>("characters");
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<KnowledgeRecord>();
  const [viewing, setViewing] = useState<KnowledgeRecord>();
  const [draft, setDraft] = useState<KnowledgeRecord>({});
  const [jsonText, setJsonText] = useState("");
  const [editorMode, setEditorMode] = useState<"form" | "json">("form");
  const [characterQuery, setCharacterQuery] = useState("");

  async function load(nextKind = kind) {
    setLoading(true);
    try {
      const body = await readJson<{ records: KnowledgeRecord[] }>(`/v2/projects/${encodeURIComponent(projectId)}/knowledge/${nextKind}`);
      setRecords(body.records ?? []);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(kind); }, [projectId, kind]);

  function openCreate() {
    if (!isEditableKnowledgeKind(kind)) return;
    setEditing({});
    const initial = JSON.parse(JSON.stringify(NEW_RECORD[kind])) as KnowledgeRecord;
    setDraft(initial);
    setJsonText(JSON.stringify(initial, null, 2));
    setEditorMode("form");
  }

  function openEdit(record: KnowledgeRecord) {
    setEditing(record);
    const editable = toEditableKnowledgeRecord(record);
    setDraft(editable);
    setJsonText(JSON.stringify(editable, null, 2));
    setEditorMode("form");
  }

  async function save() {
    if (!editing || !isEditableKnowledgeKind(kind)) return;
    let value: KnowledgeRecord;
    if (editorMode === "json") {
      try {
        value = JSON.parse(jsonText) as KnowledgeRecord;
      } catch {
        message.error("JSON 格式无效");
        return;
      }
    } else {
      value = draft;
    }
    const id = recordId(editing);
    const path = `/v2/projects/${encodeURIComponent(projectId)}/knowledge/${kind}${id ? `/${encodeURIComponent(id)}` : ""}`;
    try {
      await readJson(path, { method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
      setEditing(undefined);
      await load();
      message.success(id ? "记录已更新" : "记录已创建");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function remove(record: KnowledgeRecord) {
    const id = recordId(record);
    if (!id) return;
    try {
      await readJson(`/v2/projects/${encodeURIComponent(projectId)}/knowledge/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
      message.success("记录已删除");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  const kindMeta = knowledgeKindMeta(kind);
  const visibleRecords = useMemo(() => {
    if (kind !== "characters" || !characterQuery.trim()) return records;
    const query = characterQuery.trim().toLocaleLowerCase();
    return records.filter((record) => [labelOf(record), canonicalCharacterId(record), textOf(payloadOf(record).role), textOf(payloadOf(record).motivation)]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [characterQuery, kind, records]);
  const characterStats = useMemo(() => {
    const identified = records.filter((record) => !characterStatus(record).pending).length;
    return { total: records.length, identified, pending: records.length - identified };
  }, [records]);
  const columns = useMemo(() => [
    ...(kind === "characters" ? [
      { title: "角色", key: "label", width: 250, render: (_: unknown, record: KnowledgeRecord) => {
        const status = characterStatus(record);
        return <div className="novel-character-name-cell">
          <div className="novel-character-name-line"><span className="novel-run-item-icon"><TeamOutlined /></span><strong>{labelOf(record)}</strong><Tag color={status.color}>{status.label}</Tag></div>
          <code className="novel-table-cell-sub">规范 ID · {canonicalCharacterId(record) || "未生成"}</code>
        </div>;
      }},
      { title: "身份与动机", key: "profile", width: 390, render: (_: unknown, record: KnowledgeRecord) => {
        const payload = payloadOf(record);
        return <div className="novel-character-profile-cell"><Tag>{roleLabel(payload.role)}</Tag><span>{textOf(payload.motivation) || "尚未记录动机"}</span></div>;
      }},
      { title: "声部", key: "voice", width: 300, render: (_: unknown, record: KnowledgeRecord) => <span className="novel-character-voice-cell">{voiceSummary(record)}</span> },
    ] : [
      { title: "记录", key: "label", width: 200, render: (_: unknown, record: KnowledgeRecord) => (
        <div className="novel-table-cell-stack">
          <Space size={6} align="center">
            <span className="novel-run-item-icon">{kindMeta.icon}</span>
            <strong>{labelOf(record)}</strong>
          </Space>
          <code className="novel-table-cell-sub">{recordId(record) ? shortId(recordId(record)) : "自动生成"}</code>
        </div>
      )},
    ]),
    { title: "来源", key: "source", width: 110, render: (_: unknown, record: KnowledgeRecord) => <Tag>{sourceLabel(record.source)}</Tag> },
    { title: "详情", key: "data", render: (_: unknown, record: KnowledgeRecord) => (
      <span className="novel-table-cell-sub" style={{ fontSize: 12, color: "#a1a1aa" }}>{describeRecord(kind, record)}</span>
    )},
    {
      title: "操作", key: "actions", width: 120,
      render: (_: unknown, record: KnowledgeRecord) => (
        <Space size="small">
          <Tooltip title="查看详情"><Button type="text" icon={<EyeOutlined />} aria-label="查看详情" onClick={() => setViewing(record)} /></Tooltip>
          {isEditableKnowledgeKind(kind) && record.readOnly !== true ? <>
            <Tooltip title="编辑"><Button type="text" icon={<EditOutlined />} aria-label="编辑" onClick={() => openEdit(record)} /></Tooltip>
            <Popconfirm title="删除此记录？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void remove(record)}>
              <Tooltip title="删除"><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除" /></Tooltip>
            </Popconfirm>
          </> : null}
        </Space>
      ),
    },
  ], [kind, kindMeta.icon]);

  return (
    <motion.section
      className="novel-knowledge-workbench"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="novel-card-head" style={{ marginBottom: 14 }}>
        <div>
          <span className="novel-eyebrow">{kindMeta.icon} {kindMeta.label} · 正式知识库</span>
          <h2 className="novel-display-h2" style={{ marginTop: 3 }}>创作资料工作台</h2>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          {isEditableKnowledgeKind(kind) ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增记录</Button> : null}
        </Space>
      </div>
      <Tabs activeKey={kind} items={KINDS.map((item) => ({ key: item.key, label: item.label }))} onChange={(value) => setKind(value as KnowledgeKind)} />
      {kind === "characters" ? <div className="novel-character-overview">
        <div className="novel-character-overview-head">
          <div><strong>角色档案</strong><span>{characterStats.total} 条记录 · {characterStats.pending ? `${characterStats.pending} 条待补全` : "档案完整"}</span></div>
          <Input allowClear prefix={<SearchOutlined />} value={characterQuery} onChange={(event) => setCharacterQuery(event.target.value)} placeholder="搜索角色名、规范 ID 或动机" style={{ maxWidth: 310 }} />
        </div>
        <div className="novel-character-metrics">
          <div><span>角色总数</span><strong>{characterStats.total}</strong></div>
          <div><span>已建档</span><strong className="is-positive">{characterStats.identified}</strong></div>
          <div><span>待补全</span><strong className={characterStats.pending ? "is-warning" : ""}>{characterStats.pending}</strong></div>
        </div>
      </div> : null}
      <Table rowKey={(record) => recordId(record) || JSON.stringify(record)} loading={loading} dataSource={visibleRecords} columns={columns} pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: kind === "characters" ? 1180 : 900 }} />
      <Modal title={viewing ? labelOf(viewing) : "资料详情"} open={Boolean(viewing)} onCancel={() => setViewing(undefined)} footer={<Button onClick={() => setViewing(undefined)}>关闭</Button>} width={820} destroyOnHidden>
        {viewing && kind === "characters" ? <CharacterDetail record={viewing} /> : <pre style={{ margin: 0, maxHeight: "62vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.65 }}>{viewing ? JSON.stringify(viewing, null, 2) : ""}</pre>}
      </Modal>
      <Modal className="novel-knowledge-edit-modal" title={recordId(editing ?? {}) ? "编辑记录" : "新增记录"} open={Boolean(editing)} onCancel={() => setEditing(undefined)} onOk={() => void save()} okText="保存" width={820} destroyOnHidden>
        <Segmented
          value={editorMode}
          onChange={(v) => {
            const next = v as "form" | "json";
            if (next === "json") setJsonText(JSON.stringify(draft, null, 2));
            else {
              try { setDraft(JSON.parse(jsonText) as KnowledgeRecord); } catch { /* 保留 draft，非法 JSON 不回灌 */ }
            }
            setEditorMode(next);
          }}
          options={[{ value: "form", label: "结构化" }, { value: "json", label: "JSON" }]}
          style={{ marginBottom: 14 }}
        />
        {editorMode === "form" ? (
          <KnowledgeRecordForm kind={kind as KnowledgeFormKind} value={draft} onChange={setDraft} />
        ) : (
          <Input.TextArea value={jsonText} onChange={(event) => setJsonText(event.target.value)} autoSize={{ minRows: 16, maxRows: 28 }} spellCheck={false} style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }} />
        )}
      </Modal>
    </motion.section>
  );
}
