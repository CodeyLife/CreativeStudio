/* ============================================================
 * 剧本创作板块（MiniMax H3 · Ref2VA · 独立短剧 · 浏览器本地存储）
 *
 * 独立短剧板块（不含小说派生章节短剧）数据全部存浏览器 IndexedDB：
 * - 创作台（IndexedDB store `workspaces`）：公用素材库 + 多剧情容器
 * - 公用素材（materials）：参考图片 Blob + 简短描述，同创作台可被多部剧情复用
 * - 剧情（scripts）：每次生成的剧本记录
 * 生成仍走后端 stateless 端点（POST /v2/short-script-h3，不落库），返回的产物存
 * 本地 scripts store；前端按本地幂等键去重，重复同输入直接复用既有剧本。
 * ============================================================ */
import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent } from "react";
import { Alert, Button, Checkbox, Empty, Input, Popconfirm, Radio, Select, Slider, Tag, Tooltip, message } from "antd";
import { BoxPlotOutlined, BulbOutlined, CopyOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, LoadingOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, UploadOutlined, VideoCameraOutlined } from "@ant-design/icons";

import {
  addShortDramaMaterialLocal,
  clearShortDramaStoreLocal,
  computeShortDramaLocalKey,
  createShortDramaWorkspaceLocal,
  deleteShortDramaMaterialLocal,
  deleteShortDramaScriptLocal,
  deleteShortDramaWorkspaceLocal,
  findShortDramaScriptByLocalKey,
  getShortDramaScriptLocal,
  listShortDramaMaterialsLocal,
  listShortDramaScriptsLocal,
  listShortDramaRecentIdeas,
  listShortDramaWorkspacesLocal,
  saveShortDramaScriptLocal,
  updateShortDramaMaterialDescriptionLocal,
  type ShortDramaMaterialRecord,
  type ShortDramaScriptRecord,
  type ShortDramaWorkspaceRecord,
} from "../../lib/shortDramaStore";
import { generateShortScriptStateless, type NovelShortScriptView } from "../../lib/novelApi";
import { useShortDramaMaterialUrl } from "../../hooks/useShortDramaMaterialUrl";
import { relativeTime } from "./presentation";
import { ScriptGeneratedView, useCopyToClipboard } from "./ChapterScriptModal";
import "./pipeline-board.css";

/** 与后端 short-script-h3 常量对齐（仅前端提示用，校验以后端为准） */
const MIN_TARGET_SECONDS = 10;
const MAX_TARGET_SECONDS = 180;
const DEFAULT_TARGET_SECONDS = 30;
const MIN_IDEA_LENGTH = 10;
const MAX_SEGMENTS = 36;

/** 与后端 deriveShortScriptMin/MaxSegments 对齐：下限按最长单段 15s、上限按最短单段 10s 推导。 */
function deriveSegmentRange(targetSeconds: number) {
  return {
    min: Math.max(1, Math.ceil(targetSeconds / 15)),
    max: Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(targetSeconds / 10))),
  };
}

/** 素材卡片：内部调用 objectURL hook（规避 hooks 循环调用限制）。 */
function MaterialCard({ material, editing, editValue, editSaving, onStartEdit, onEditChange, onSaveEdit, onCancelEdit, onDelete }: {
  material: ShortDramaMaterialRecord;
  editing: boolean;
  editValue: string;
  editSaving: boolean;
  onStartEdit: () => void;
  onEditChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  const url = useShortDramaMaterialUrl(material.blob);
  return (
    <div className="pb-material-card">
      <img className="pb-material-preview" src={url} alt={material.description} loading="lazy" />
      <div className="pb-material-meta">
        {editing ? (
          <div className="pb-material-edit">
            <Input.TextArea value={editValue} onChange={(event) => onEditChange(event.target.value)} autoSize={{ minRows: 1, maxRows: 3 }} maxLength={2000} />
            <div className="pb-material-edit-actions">
              <Button size="small" type="primary" icon={<LoadingOutlined />} loading={editSaving} disabled={editValue.trim().length < 2} onClick={() => void onSaveEdit()}>保存</Button>
              <Button size="small" onClick={onCancelEdit}>取消</Button>
            </div>
          </div>
        ) : (
          <span className="pb-material-desc" title="点击铅笔编辑描述">{material.description}</span>
        )}
        <div className="pb-material-tags">
          <Tag>{material.fileName ?? material.mimeType ?? "图片"}</Tag>
          <span className="pb-material-card-actions">
            <Tooltip title="编辑素材描述（影响后续生成注入的 <Subject N> 文本）">
              <Button size="small" type="text" icon={<EditOutlined />} aria-label={`编辑素材：${material.description.slice(0, 20)}`} onClick={onStartEdit} />
            </Tooltip>
            <Popconfirm title="删除这个素材？" description="删除后无法恢复" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => onDelete()}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除素材：${material.description.slice(0, 20)}`} />
            </Popconfirm>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 从本地脚本记录映射为详情渲染所需的视图形状。 */
function scriptRecordToView(script: ShortDramaScriptRecord): NovelShortScriptView {
  return {
    exists: true,
    scriptId: script.scriptId,
    workspaceId: script.workspaceId,
    materialRefs: script.materialRefs,
    idea: script.idea,
    instruction: script.instruction,
    durationMode: script.durationMode,
    targetDurationSeconds: script.targetDurationSeconds,
    plotBeats: script.plotBeats as never,
    ...(script.creativeStrategy ? { creativeStrategy: script.creativeStrategy as never } : {}),
    cinematicHints: script.cinematicHints,
    characters: script.characters as never,
    segments: script.segments as never,
  };
}

/** 创作表单（导出以便 SSR 单测渲染）；提供 availableMaterials 时展示「引入素材」勾选区 */
export function ShortScriptCreateForm({ idea, onIdeaChange, instruction, onInstructionChange, duration, onDurationChange, durationMode, onDurationModeChange, generating, error, onGenerate, availableMaterials, selectedMaterialIds, onMaterialIdsChange, workspaceTitle }: {
  idea: string;
  onIdeaChange: (value: string) => void;
  instruction: string;
  onInstructionChange: (value: string) => void;
  duration: number;
  onDurationChange: (value: number) => void;
  durationMode: "fixed" | "auto";
  onDurationModeChange: (mode: "fixed" | "auto") => void;
  generating: boolean;
  error?: string;
  onGenerate: () => void;
  availableMaterials?: ShortDramaMaterialRecord[];
  selectedMaterialIds?: string[];
  onMaterialIdsChange?: (ids: string[]) => void;
  workspaceTitle?: string;
}) {
  const segmentRange = deriveSegmentRange(duration);
  // 以下 maxLength/切片为 UI 展示守卫（TODO P2: 魔法值，应与后端长度常量一处对齐维护）
  const ideaTooShort = idea.trim().length > 0 && idea.trim().length < MIN_IDEA_LENGTH;
  const withMaterials = Boolean(availableMaterials && availableMaterials.length > 0);
  return (
    <div className="pb-script-create">
      <Input.TextArea
        value={idea}
        onChange={(event) => onIdeaChange(event.target.value)}
        autoSize={{ minRows: 3, maxRows: 8 }}
        maxLength={2000}
        showCount
        placeholder={`核心创意（必填，至少 ${MIN_IDEA_LENGTH} 个字符）：写清谁、在何处、陷入什么冲突，如「某身份的主角在某场所发现一个本不该出现的反常事实或对手」`}
        aria-label="核心创意"
      />
      {ideaTooShort && <Alert type="warning" showIcon message={`创意过短：至少 ${MIN_IDEA_LENGTH} 个字符，须写清谁、何处、什么冲突`} />}
      <div className="pb-script-duration">
        <span className="pb-script-duration-label">时长模式</span>
        <Radio.Group
          value={durationMode}
          onChange={(event) => onDurationModeChange(event.target.value)}
          optionType="button"
          buttonStyle="solid"
          options={[
            { label: "固定时长", value: "fixed" },
            { label: "不限时长", value: "auto" },
          ]}
        />
        <span className="pb-script-duration-hint">
          {durationMode === "auto"
            ? "由大模型依据核心创意自行编排总时长与片段数（节拍完整优先）"
            : `约 ${segmentRange.min}-${segmentRange.max} 个片段（每段 10-15 秒）`}
        </span>
      </div>
      {durationMode === "fixed" && (
        <div className="pb-script-duration">
          <span className="pb-script-duration-label">目标时长</span>
          <Slider
            min={MIN_TARGET_SECONDS}
            max={MAX_TARGET_SECONDS}
            step={5}
            value={duration}
            onChange={(value) => onDurationChange(value)}
            marks={{ [MIN_TARGET_SECONDS]: `${MIN_TARGET_SECONDS}s`, [DEFAULT_TARGET_SECONDS]: `${DEFAULT_TARGET_SECONDS}s`, [MAX_TARGET_SECONDS]: `${MAX_TARGET_SECONDS}s` }}
            tooltip={{ formatter: (value) => `${value} 秒` }}
          />
        </div>
      )}
      {withMaterials && onMaterialIdsChange && availableMaterials && (
        <div className="pb-script-materials-select">
          <span className="pb-script-materials-label">
            <PictureOutlined /> 引入公用素材（{workspaceTitle ?? "本创作台"}，选中素材以 {"<Subject N>"} 参考帧注入提示词）
          </span>
          <Checkbox.Group
            className="pb-script-materials-check"
            value={selectedMaterialIds ?? []}
            onChange={(values) => onMaterialIdsChange(values as string[])}
            options={availableMaterials.map((material) => ({
              label: `${material.description.slice(0, 32)}${material.description.length > 32 ? "…" : ""}`,
              value: material.materialId,
            }))}
          />
        </div>
      )}
      <Input.TextArea
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        maxLength={2000}
        autoSize={{ minRows: 2, maxRows: 5 }}
        placeholder="改编指令（可选）：例如节奏偏好、特写重点、需要强化的情绪走向等"
        aria-label="剧本改编指令"
      />
      {error && <Alert type="error" showIcon message="生成失败" description={error} />}
      <Tooltip title="同一创意 + 指令 + 时长模式（固定时长含目标值）+ 选中素材 + 契约版本会复用既有产物（浏览器本地幂等）；同步生成，通常需要一到两分钟">
        <Button type="primary" icon={<VideoCameraOutlined />} loading={generating} disabled={idea.trim().length < MIN_IDEA_LENGTH} onClick={onGenerate}>
          {generating ? "正在生成分镜剧本…" : "生成短剧剧本"}
        </Button>
      </Tooltip>
    </div>
  );
}

/** 历史剧本摘要卡片（导出以便 SSR 单测渲染）；删除按钮独立于卡片主体，避免 button 嵌套 */
export function ShortScriptHistoryCard({ script, active, loading, onClick }: {
  script: { scriptId: string; idea: string; durationMode?: "fixed" | "auto"; targetDurationSeconds?: number; segmentCount?: number; cinematicHintCount?: number; materialRefs?: Array<{ materialId: string; description: string; subjectTag: string }>; createdAt: number };
  active: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const ideaPreview = script.idea.length > 40 ? `${script.idea.slice(0, 40)}…` : script.idea;
  return (
    <button type="button" className={`pb-script-history-card ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="pb-script-history-copy">
        <strong>{ideaPreview || "未记录创意"}</strong>
        <small>
          {script.durationMode === "auto"
            ? `不限时长 · 实际约 ${script.targetDurationSeconds ?? "?"}s`
            : script.targetDurationSeconds ? `${script.targetDurationSeconds}s` : "时长未知"}
          {" · "}{script.segmentCount ?? 0} 个片段
          {(script.cinematicHintCount ?? 0) > 0 && ` · ${script.cinematicHintCount} 个镜头提示`}
          {" · "}{relativeTime(script.createdAt)}
        </small>
        {(script.materialRefs?.length ?? 0) > 0 && (
          <em className="pb-script-history-materials">
            {script.materialRefs!.map((ref) => (
              <span key={ref.materialId} title={`${ref.subjectTag}：${ref.description}`}>
                {ref.subjectTag}：{ref.description.length > 14 ? `${ref.description.slice(0, 14)}…` : ref.description}
              </span>
            ))}
          </em>
        )}
      </span>
      <span className="pb-script-history-action">{loading ? <LoadingOutlined /> : "查看"}</span>
    </button>
  );
}

export default function ScriptStudioPanel(_props: { projectId?: string }) {
  const copy = useCopyToClipboard();
  const [idea, setIdea] = useState("");
  const [instruction, setInstruction] = useState("");
  const [duration, setDuration] = useState(DEFAULT_TARGET_SECONDS);
  const [durationMode, setDurationMode] = useState<"fixed" | "auto">("fixed");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | undefined>(undefined);

  // 浏览器本地数据（IndexedDB）
  const [workspaces, setWorkspaces] = useState<ShortDramaWorkspaceRecord[]>([]);
  const [scripts, setScripts] = useState<ShortDramaScriptRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | undefined>(undefined);
  const [workspaceTitleInput, setWorkspaceTitleInput] = useState("");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [materials, setMaterials] = useState<ShortDramaMaterialRecord[]>([]);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [materialsError, setMaterialsError] = useState<string | undefined>(undefined);
  const [materialDescription, setMaterialDescription] = useState("");
  const [materialFile, setMaterialFile] = useState<File | undefined>(undefined);
  const [materialUploading, setMaterialUploading] = useState(false);
  const [materialDragActive, setMaterialDragActive] = useState(false);

  // 素材描述编辑（内联）
  const [editingMaterialId, setEditingMaterialId] = useState<string | undefined>(undefined);
  const [materialEditDescription, setMaterialEditDescription] = useState("");
  const [materialEditSaving, setMaterialEditSaving] = useState(false);

  // 详情（从 scripts store 读当前选中剧本的视图）
  const [activeScriptId, setActiveScriptId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<NovelShortScriptView | undefined>(undefined);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);

  // 剧情引入素材（缺省=当前创作台全部素材）
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);

  const reloadWorkspaces = useCallback(async () => {
    setWorkspaces(await listShortDramaWorkspacesLocal());
  }, []);

  const reloadScripts = useCallback(async (workspaceId?: string) => {
    setScripts(await listShortDramaScriptsLocal(workspaceId));
  }, []);

  const reloadMaterials = useCallback(async (workspaceId: string) => {
    setMaterialsLoading(true);
    try {
      const list = await listShortDramaMaterialsLocal(workspaceId);
      setMaterials(list);
      // 缺省全选当前创作台素材（用户可手动取消）
      setSelectedMaterialIds(list.map((material) => material.materialId));
      setMaterialsError(undefined);
    } catch (error) {
      setMaterialsError(error instanceof Error ? error.message : String(error));
    } finally {
      setMaterialsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reloadScripts(activeWorkspaceId);
    if (activeWorkspaceId) void reloadMaterials(activeWorkspaceId);
    else { setMaterials([]); setSelectedMaterialIds([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  async function createWorkspace() {
    if (workspaceTitleInput.trim().length === 0) return;
    setWorkspaceSaving(true);
    try {
      const workspace = await createShortDramaWorkspaceLocal({ title: workspaceTitleInput.trim() });
      await reloadWorkspaces();
      setActiveWorkspaceId(workspace.workspaceId);
      setWorkspaceTitleInput("");
      message.success("短剧创作台已创建（本地存储）");
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceSaving(false);
    }
  }

  async function removeWorkspace(workspaceId: string) {
    try {
      await deleteShortDramaWorkspaceLocal(workspaceId);
      message.success("已删除该创作台");
      await reloadWorkspaces();
      if (activeWorkspaceId === workspaceId) { setActiveWorkspaceId(undefined); setMaterials([]); setSelectedMaterialIds([]); }
      await reloadScripts();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function uploadMaterial() {
    if (!activeWorkspaceId) return;
    if (materialDescription.trim().length < 2) { message.error("素材描述至少 2 个字符"); return; }
    if (!materialFile) { message.error("请选择一张参考图片"); return; }
    setMaterialUploading(true);
    try {
      const { reused } = await addShortDramaMaterialLocal({ workspaceId: activeWorkspaceId, description: materialDescription.trim(), file: materialFile });
      message.success(reused ? "该图片在创作台已存在，直接复用" : "素材已加入创作台（本地存储）");
      setMaterialDescription("");
      setMaterialFile(undefined);
      await reloadMaterials(activeWorkspaceId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMaterialUploading(false);
    }
  }

  /** 拖拽图片上传：把拖入的首张图片设为待上传文件（拖拽即选图，仍需填描述后点「上传」）。 */
  function handleMaterialDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setMaterialDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) { message.error("仅支持图片文件"); return; }
    setMaterialFile(file);
  }

  async function removeMaterial(materialId: string) {
    if (!activeWorkspaceId) return;
    await deleteShortDramaMaterialLocal(activeWorkspaceId, materialId);
    setSelectedMaterialIds((prev) => prev.filter((id) => id !== materialId));
    await reloadMaterials(activeWorkspaceId);
  }

  function startEditMaterial(materialId: string, description: string) {
    setEditingMaterialId(materialId);
    setMaterialEditDescription(description);
  }

  async function saveMaterialDescription(materialId: string) {
    if (!activeWorkspaceId) return;
    if (materialEditDescription.trim().length < 2) { message.error("素材描述至少 2 个字符"); return; }
    setMaterialEditSaving(true);
    try {
      await updateShortDramaMaterialDescriptionLocal(activeWorkspaceId, materialId, materialEditDescription.trim());
      message.success("素材描述已更新");
      setEditingMaterialId(undefined);
      await reloadMaterials(activeWorkspaceId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMaterialEditSaving(false);
    }
  }

  async function generate() {
    if (idea.trim().length < MIN_IDEA_LENGTH) return;
    setGenerating(true);
    setGenerateError(undefined);
    try {
      // 选中素材 → <Subject N> 参考帧（保序）
      const refs = selectedMaterialIds
        .map((id) => materials.find((m) => m.materialId === id))
        .filter((m): m is ShortDramaMaterialRecord => Boolean(m))
        .map((m, index) => ({ materialId: m.materialId, description: m.description, subjectTag: `Subject ${index + 1}` }));

      // 前端本地幂等：同输入（workspace + idea + 素材）直接复用既有剧本
      const localKey = await computeShortDramaLocalKey({
        workspaceId: activeWorkspaceId,
        idea: idea.trim(),
        instruction: instruction.trim() || undefined,
        durationMode,
        targetDurationSeconds: durationMode === "auto" ? 0 : duration,
        materialRefs: refs,
      });
      const existing = await findShortDramaScriptByLocalKey(activeWorkspaceId, localKey);
      if (existing) {
        message.success("同一创意 + 素材已有本地剧本，直接复用");
        setView(scriptRecordToView(existing));
        setActiveScriptId(existing.scriptId);
        await reloadScripts(activeWorkspaceId);
        return;
      }

      const avoidMotifs = await listShortDramaRecentIdeas();
      const body = await generateShortScriptStateless({
        idea: idea.trim(),
        instruction: instruction.trim() || undefined,
        durationMode,
        targetDurationSeconds: durationMode === "auto" ? undefined : duration,
        referenceMaterials: refs.length ? refs.map(({ subjectTag, description }) => ({ subjectTag, description })) : undefined,
        materialRefs: refs.length ? refs : undefined,
        avoidMotifs: avoidMotifs.length ? avoidMotifs : undefined,
      });
      const record = body.record;
      const recordWithStrategy = record as NovelShortScriptView & { scriptId: string; creativeStrategy?: unknown };
      const saved = await saveShortDramaScriptLocal({
        scriptId: record.scriptId,
        workspaceId: activeWorkspaceId,
        materialRefs: refs.length ? refs : undefined,
        idea: record.idea ?? "",
        instruction: record.instruction,
        durationMode: record.durationMode ?? "fixed",
        targetDurationSeconds: record.targetDurationSeconds ?? duration,
        sourceFingerprint: record.sourceFingerprint ?? "",
        localKey,
        plotBeats: record.plotBeats as unknown[] ?? [],
        creativeStrategy: recordWithStrategy.creativeStrategy,
        cinematicHints: record.cinematicHints ?? [],
        characters: record.characters as unknown[] ?? [],
        segments: record.segments as unknown[] ?? [],
        createdAt: Date.now(),
      });
      setView(recordWithStrategy);
      setActiveScriptId(saved.scriptId);
      message.success("短剧剧本已生成并存入本地");
      await reloadScripts(activeWorkspaceId);
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  }

  async function loadDetail(scriptId: string) {
    if (activeScriptId === scriptId && view?.exists) return;
    setActiveScriptId(scriptId);
    setDetailLoading(true);
    try {
      const script = await getShortDramaScriptLocal(scriptId);
      setView(script ? scriptRecordToView(script) : undefined);
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  }

  async function removeScript(scriptId: string) {
    setDeletingId(scriptId);
    await deleteShortDramaScriptLocal(scriptId);
    message.success("已删除该短剧记录（本地）");
    setScripts((prev) => prev.filter((item) => item.scriptId !== scriptId));
    if (activeScriptId === scriptId) { setActiveScriptId(undefined); setView(undefined); }
    setDeletingId(undefined);
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId);

  return (
    <div className="pb-script-studio">
      {/* 创作台选择 */}
      <section className="pb-card">
        <header className="pb-card-head">
          <span className="pb-card-title"><FolderOpenOutlined /> 短剧创作台</span>
          <span className="pb-card-head-right">
            <Tag color="geekblue">浏览器本地存储</Tag>
            <Tag>{activeWorkspace ? `${scripts.length} 剧情 · ${materials.length} 素材` : "未选择创作台"}</Tag>
          </span>
        </header>
        <div className="pb-workspace-row">
          <Select
            className="pb-workspace-select"
            placeholder="选择一个创作台（或创建新创作台）"
            value={activeWorkspaceId}
            onChange={(value) => setActiveWorkspaceId(value || undefined)}
            allowClear
            optionLabelProp="label"
            options={workspaces.map((workspace) => ({ label: workspace.title, value: workspace.workspaceId }))}
            notFoundContent={workspaces.length === 0 ? "还没有创作台" : undefined}
          />
          <div className="pb-workspace-create">
            <Input value={workspaceTitleInput} onChange={(event) => setWorkspaceTitleInput(event.target.value)} placeholder="新建创作台标题" maxLength={50} onPressEnter={() => void createWorkspace()} />
            <Button type="primary" icon={<PlusOutlined />} loading={workspaceSaving} disabled={workspaceTitleInput.trim().length === 0} onClick={() => void createWorkspace()}>新建</Button>
          </div>
          {activeWorkspace && (
            <Popconfirm
              title="删除这个创作台？"
              description="将连同其中的全部公用素材一并删除（该创作台下的剧情会保留但解除归属）"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void removeWorkspace(activeWorkspace.workspaceId)}
            >
              <Button danger icon={<DeleteOutlined />}>删除创作台</Button>
            </Popconfirm>
          )}
        </div>
        {!activeWorkspace && (
          <div className="pb-workspace-hint"><Tag>提示</Tag>选择或新建创作台后，可上传公用素材并在多部剧情中复用；不选择创作台则按「独立剧情」生成。数据均存于本机浏览器。</div>
        )}
      </section>

      {/* 公用素材库 */}
      {activeWorkspace && (
        <section className="pb-card">
          <header className="pb-card-head">
            <span className="pb-card-title"><PictureOutlined /> 公用素材库{activeWorkspace ? ` · ${activeWorkspace.title}` : ""}</span>
            <span className="pb-card-head-right">
              <Tooltip title="素材在该创作台内为公用，可被多部剧情以 <Subject N> 参考帧复用"><Tag color="blue">可复用</Tag></Tooltip>
            </span>
          </header>
          {materialsError && <Alert type="error" showIcon message="素材读取失败" description={materialsError} />}
          <div
            className={`pb-material-upload${materialDragActive ? " is-dragging" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setMaterialDragActive(true); }}
            onDragLeave={() => setMaterialDragActive(false)}
            onDrop={handleMaterialDrop}
          >
            <div className="pb-material-dropzone">
              <div className="pb-material-dropzone-hint">
                <UploadOutlined /> {materialFile ? `已选图片：${materialFile.name}` : "拖拽图片到此处，或点击右侧选择文件"}
              </div>
              <Input value={materialDescription} onChange={(event) => setMaterialDescription(event.target.value)} placeholder="素材描述（≥2 字符，将注入生成提示词供模型对齐）" maxLength={300} />
              <div className="pb-material-dropzone-actions">
                <input type="file" accept="image/*" onChange={(event) => setMaterialFile(event.target.files?.[0])} aria-label="选择参考图片" />
                {/* TODO P1: 素材图片存本地浏览器 IndexedDB，无服务端权限问题；但同源同设备可见，若需跨设备同步请接入云存储 */}
                <Button type="primary" icon={<UploadOutlined />} loading={materialUploading} disabled={!materialFile || materialDescription.trim().length < 2} onClick={() => void uploadMaterial()}>上传素材</Button>
              </div>
            </div>
          </div>
          {materialsLoading && <div className="pb-loading"><LoadingOutlined /> 读取素材…</div>}
          {!materialsLoading && materials.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该创作台还没有公用素材；上传参考图片后即可在剧情创作时勾选引入" />}
          {materials.length > 0 && (
            <div className="pb-material-grid">
              {materials.map((material) => (
                <MaterialCard
                  key={material.materialId}
                  material={material}
                  editing={editingMaterialId === material.materialId}
                  editValue={materialEditDescription}
                  editSaving={materialEditSaving}
                  onStartEdit={() => startEditMaterial(material.materialId, material.description)}
                  onEditChange={setMaterialEditDescription}
                  onSaveEdit={() => void saveMaterialDescription(material.materialId)}
                  onCancelEdit={() => setEditingMaterialId(undefined)}
                  onDelete={() => void removeMaterial(material.materialId)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* 剧情创作 */}
      <section className="pb-card">
        <header className="pb-card-head">
          <span className="pb-card-title"><VideoCameraOutlined /> 创作新剧情</span>
          <span className="pb-card-head-right">
            <Tag>MiniMax H3 · Ref2VA</Tag>
            <Tag color="geekblue">核心创意模式</Tag>
            <Tag>{activeWorkspace ? `创作台：${activeWorkspace.title}` : "独立剧情"}</Tag>
          </span>
        </header>
        <ShortScriptCreateForm
          idea={idea}
          onIdeaChange={setIdea}
          instruction={instruction}
          onInstructionChange={setInstruction}
          duration={duration}
          onDurationChange={setDuration}
          durationMode={durationMode}
          onDurationModeChange={setDurationMode}
          generating={generating}
          error={generateError}
          onGenerate={() => void generate()}
          availableMaterials={activeWorkspace ? materials : undefined}
          selectedMaterialIds={selectedMaterialIds}
          onMaterialIdsChange={setSelectedMaterialIds}
          workspaceTitle={activeWorkspace?.title}
        />
      </section>

      <div className="pb-script-studio-body">
        <section className="pb-card pb-script-history-pane">
          <header className="pb-card-head">
            <span className="pb-card-title">历史剧情{activeWorkspace ? `（${activeWorkspace.title}）` : "（独立剧情）"}</span>
            <span className="pb-card-head-right">
              <Tooltip title="刷新历史列表"><Button size="small" icon={<ReloadOutlined />} onClick={() => void reloadScripts(activeWorkspaceId)}>刷新</Button></Tooltip>
            </span>
          </header>
          {scripts.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={activeWorkspace ? "该创作台还没有剧情；在上方输入核心创意开始创作" : "还没有独立剧情；在上方输入核心创意开始创作"} />}
          {scripts.length > 0 && (
            <div className="pb-script-history-list">
              {scripts.map((script) => (
                <div key={script.scriptId} className={`pb-script-history-item ${activeScriptId === script.scriptId ? "is-active" : ""}`}>
                  <ShortScriptHistoryCard
                    script={{ scriptId: script.scriptId, idea: script.idea, durationMode: script.durationMode, targetDurationSeconds: script.targetDurationSeconds, segmentCount: (script.segments ?? []).length, cinematicHintCount: script.cinematicHints?.length ?? 0, materialRefs: script.materialRefs, createdAt: script.createdAt }}
                    active={activeScriptId === script.scriptId}
                    loading={detailLoading && activeScriptId === script.scriptId}
                    onClick={() => void loadDetail(script.scriptId)}
                  />
                  <Popconfirm title="删除这条短剧记录？" description="删除后无法恢复" okText="删除" cancelText="取消" okButtonProps={{ danger: true, loading: deletingId === script.scriptId }} onConfirm={() => void removeScript(script.scriptId)}>
                    <Tooltip title="删除该记录">
                      <Button className="pb-script-history-remove" size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除剧本：${script.idea.slice(0, 20)}`} />
                    </Tooltip>
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="pb-card pb-script-detail-pane">
          <header className="pb-card-head">
            <span className="pb-card-title">剧本详情</span>
          </header>
          {detailLoading && <div className="pb-loading"><LoadingOutlined /> 读取剧本…</div>}
          {!detailLoading && view?.exists && (() => {
            const segments = view.segments ?? [];
            const totalSeconds = segments.length > 0
              ? segments.reduce((sum: number, segment: unknown) => sum + ((segment as { durationSeconds?: number })?.durationSeconds ?? 0), 0)
              : view.targetDurationSeconds;
            return (
              <div className="pb-script-studio-detail">
                <div className="pb-script-detail-head">
                  <div className="pb-script-detail-idea">
                    {/* 标签行自成一列，动作按钮不再与创意文本争抢同一 flex 行 */}
                    <div className="pb-script-detail-idea-top">
                      <span className="pb-script-detail-idea-label"><BulbOutlined /> 核心创意</span>
                      <span className="pb-script-detail-actions">
                        <Tooltip title="复制核心创意文本，便于重写或迁移到其他工具">
                          <Button size="small" icon={<CopyOutlined />} disabled={!view.idea} onClick={() => void copy(view.idea ?? "", "核心创意")}>复制创意</Button>
                        </Tooltip>
                        {view.scriptId && (
                          <Popconfirm title="删除这条短剧记录？" description="删除后无法恢复" okText="删除" cancelText="取消" okButtonProps={{ danger: true, loading: deletingId === view.scriptId }} onConfirm={() => void removeScript(view.scriptId!)}>
                            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                          </Popconfirm>
                        )}
                      </span>
                    </div>
                    <p className="pb-script-detail-idea-text">{view.idea ?? "未记录创意"}</p>
                    {view.instruction && <p className="pb-script-detail-instruction">改编指令：{view.instruction}</p>}
                  </div>
                  {/* 元信息条：独占一行，弹性换行，不参与文本列的宽度竞争 */}
                  <div className="pb-script-detail-meta">
                    <Tooltip title={view.durationMode === "auto" ? "不限时长：由大模型依据核心创意自行编排总时长与片段数" : "固定时长：按目标时长预算拆分片段"}>
                      <Tag>{view.durationMode === "auto" ? "不限时长" : "固定时长"}</Tag>
                    </Tooltip>
                    {segments.length > 0 && <Tag>{segments.length} 个片段 · 约 {totalSeconds ?? "?"}s</Tag>}
                    {(view.characters?.length ?? 0) > 0 && <Tag color="blue">{view.characters!.length} 个人物基线</Tag>}
                    {view.mode && <Tag color="purple">{view.mode}</Tag>}
                  </div>
                </div>
                {(view.materialRefs?.length ?? 0) > 0 && (
                  <div className="pb-script-detail-materials">
                    <span className="pb-script-detail-materials-label"><BoxPlotOutlined /> 本剧情引入的公用素材</span>
                    <div className="pb-script-detail-materials-list">
                      {view.materialRefs!.map((ref) => (
                        <Tag key={`${ref.materialId}`} color="blue">{ref.subjectTag}：{ref.description}</Tag>
                      ))}
                    </div>
                  </div>
                )}
                <ScriptGeneratedView view={view} onCopy={copy} />
              </div>
            );
          })()}
          {!detailLoading && !view?.exists && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧历史列表选择一条记录查看，或在上方生成新剧本" />}
          <div style={{ marginTop: 12, textAlign: "right" }}>
            <Popconfirm title="清空整个短剧板块本地数据？" description="删除所有本地创作台/素材/剧情，不可恢复" okText="清空" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => { void clearShortDramaStoreLocal().then(() => { void reloadWorkspaces(); void reloadScripts(); setMaterials([]); setSelectedMaterialIds([]); setView(undefined); }); }}>
              <Button size="small" danger>清空本地短剧板块</Button>
            </Popconfirm>
          </div>
        </section>
      </div>
    </div>
  );
}