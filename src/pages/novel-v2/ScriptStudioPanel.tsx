/* ============================================================
 * 剧本创作板块（MiniMax H3 · Ref2VA · 核心创意模式，契约 v2）
 *
 * 完全独立于小说项目的短剧创作面板：
 * - 创作区：核心创意（≥10 字符，须含谁/何处/冲突）+ 目标时长 10-180s
 *   + 可选改编指令 → POST 同步生成（幂等：同创意+时长+作用域复用既有产物）
 * - 关联作品（可选）：填写时产物关联该作品（衍生短剧），仅影响 prompt
 *   的作品标题注入与历史列表过滤；缺省为独立短剧
 * - 历史区（左侧栏）：全部创意短剧摘要卡片，点击加载完整产物，支持删除
 * - 详情区（右侧主区）：核心创意卡片（支持一键复制）+ 完整产物视图
 *   （复用章节剧本的 ScriptGeneratedView，横向 Tabs 逐段 promptText）
 * ============================================================ */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Popconfirm, Slider, Tag, Tooltip, message } from "antd";
import { BulbOutlined, CopyOutlined, DeleteOutlined, LoadingOutlined, ReloadOutlined, VideoCameraOutlined } from "@ant-design/icons";

import {
  deleteShortScript,
  fetchShortScript,
  fetchShortScriptList,
  generateShortScript,
  type NovelShortScriptSummaryView,
  type NovelShortScriptView,
} from "../../lib/novelApi";
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

/** 创作表单（导出以便后续 SSR 单测渲染） */
export function ShortScriptCreateForm({ idea, onIdeaChange, instruction, onInstructionChange, duration, onDurationChange, generating, error, onGenerate }: {
  idea: string;
  onIdeaChange: (value: string) => void;
  instruction: string;
  onInstructionChange: (value: string) => void;
  duration: number;
  onDurationChange: (value: number) => void;
  generating: boolean;
  error?: string;
  onGenerate: () => void;
}) {
  const segmentRange = deriveSegmentRange(duration);
  const ideaTooShort = idea.trim().length > 0 && idea.trim().length < MIN_IDEA_LENGTH;
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
        <span className="pb-script-duration-hint">约 {segmentRange.min}-{segmentRange.max} 个片段（每段 10-15 秒）</span>
      </div>
      <Input.TextArea
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        maxLength={2000}
        autoSize={{ minRows: 2, maxRows: 5 }}
        placeholder="改编指令（可选）：例如节奏偏好、特写重点、需要强化的情绪走向等"
        aria-label="剧本改编指令"
      />
      {error && <Alert type="error" showIcon message="生成失败" description={error} />}
      <Tooltip title="同一创意 + 指令 + 时长 + 契约版本会复用既有产物；同步生成，通常需要一到两分钟">
        <Button type="primary" icon={<VideoCameraOutlined />} loading={generating} disabled={idea.trim().length < MIN_IDEA_LENGTH} onClick={onGenerate}>
          {generating ? "正在生成分镜剧本…" : "生成短剧剧本"}
        </Button>
      </Tooltip>
    </div>
  );
}

/** 历史剧本摘要卡片（导出以便后续 SSR 单测渲染）；删除按钮独立于卡片主体，避免 button 嵌套 */
export function ShortScriptHistoryCard({ script, active, loading, onClick }: { script: NovelShortScriptSummaryView; active: boolean; loading: boolean; onClick: () => void }) {
  const ideaPreview = script.idea.length > 40 ? `${script.idea.slice(0, 40)}…` : script.idea;
  return (
    <button type="button" className={`pb-script-history-card ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="pb-script-history-copy">
        <strong>{ideaPreview || "未记录创意"}</strong>
        <small>
          {script.targetDurationSeconds ? `${script.targetDurationSeconds}s` : "时长未知"} · {script.segmentCount} 个片段
          {script.cinematicHintCount > 0 && ` · ${script.cinematicHintCount} 个镜头提示`}
          {" · "}{relativeTime(script.createdAt)}
        </small>
      </span>
      <span className="pb-script-history-action">{loading ? <LoadingOutlined /> : "查看"}</span>
    </button>
  );
}

export default function ScriptStudioPanel({ projectId }: { projectId?: string }) {
  const copy = useCopyToClipboard();
  const [idea, setIdea] = useState("");
  const [instruction, setInstruction] = useState("");
  const [duration, setDuration] = useState(DEFAULT_TARGET_SECONDS);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | undefined>(undefined);
  const [view, setView] = useState<NovelShortScriptView | undefined>(undefined);
  const [history, setHistory] = useState<NovelShortScriptSummaryView[]>([]);
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);
  const [activeScriptId, setActiveScriptId] = useState<string | undefined>(undefined);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);

  const refreshHistory = useCallback(async () => {
    try {
      const data = await fetchShortScriptList(projectId);
      setHistory(data.scripts ?? []);
      setHistoryError(undefined);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    fetchShortScriptList(projectId)
      .then((data) => { if (!cancelled) setHistory(data.scripts ?? []); })
      .catch((err) => { if (!cancelled) setHistoryError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function generate() {
    if (idea.trim().length < MIN_IDEA_LENGTH) return;
    setGenerating(true);
    setGenerateError(undefined);
    try {
      const body = await generateShortScript({
        idea: idea.trim(),
        instruction: instruction.trim() || undefined,
        targetDurationSeconds: duration,
        projectId,
      });
      const record = body.record;
      setView(record);
      setActiveScriptId(record.scriptId);
      message.success(record.reused ? "同一创意已有剧本，直接复用既有产物" : "短剧剧本已生成");
      await refreshHistory();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function loadDetail(scriptId: string) {
    if (activeScriptId === scriptId && view?.exists) return;
    setActiveScriptId(scriptId);
    setDetailLoading(true);
    try {
      const data = await fetchShortScript(scriptId);
      setView(data);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }

  async function remove(scriptId: string) {
    setDeletingId(scriptId);
    try {
      await deleteShortScript(scriptId);
      message.success("已删除该短剧记录");
      setHistory((prev) => prev.filter((item) => item.scriptId !== scriptId));
      if (activeScriptId === scriptId) {
        setActiveScriptId(undefined);
        setView(undefined);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(undefined);
    }
  }

  return (
    <div className="pb-script-studio">
      <section className="pb-card">
        <header className="pb-card-head">
          <span className="pb-card-title"><VideoCameraOutlined /> 创作新剧本</span>
          <span className="pb-card-head-right">
            <Tag>MiniMax H3 · Ref2VA</Tag>
            <Tag color="geekblue">核心创意模式</Tag>
            <Tag>{projectId ? "关联作品" : "独立短剧"}</Tag>
          </span>
        </header>
        <ShortScriptCreateForm
          idea={idea}
          onIdeaChange={setIdea}
          instruction={instruction}
          onInstructionChange={setInstruction}
          duration={duration}
          onDurationChange={setDuration}
          generating={generating}
          error={generateError}
          onGenerate={() => void generate()}
        />
      </section>

      <div className="pb-script-studio-body">
        <section className="pb-card pb-script-history-pane">
          <header className="pb-card-head">
            <span className="pb-card-title">历史剧本{projectId ? "（本作品）" : "（全部）"}</span>
            <span className="pb-card-head-right">
              <Tooltip title="刷新历史列表"><Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshHistory()}>刷新</Button></Tooltip>
            </span>
          </header>
          {historyError && <Alert type="error" showIcon message="历史剧本读取失败" description={historyError} />}
          {!historyError && history.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={projectId ? "本作品还没有衍生短剧；在上方输入核心创意开始创作" : "还没有创意短剧；在上方输入核心创意开始创作（无需选择作品）"} />}
          {history.length > 0 && (
            <div className="pb-script-history-list">
              {history.map((script) => (
                <div key={script.scriptId} className={`pb-script-history-item ${activeScriptId === script.scriptId ? "is-active" : ""}`}>
                  <ShortScriptHistoryCard
                    script={script}
                    active={activeScriptId === script.scriptId}
                    loading={detailLoading && activeScriptId === script.scriptId}
                    onClick={() => void loadDetail(script.scriptId)}
                  />
                  <Popconfirm
                    title="删除这条短剧记录？"
                    description="删除后无法恢复，产物文件将一并清理"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true, loading: deletingId === script.scriptId }}
                    onConfirm={() => void remove(script.scriptId)}
                  >
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
          {!detailLoading && view?.exists && (
            <div className="pb-script-studio-detail">
              <div className="pb-script-detail-head">
                <div className="pb-script-detail-idea">
                  <span className="pb-script-detail-idea-label"><BulbOutlined /> 核心创意</span>
                  <p className="pb-script-detail-idea-text">{view.idea ?? "未记录创意"}</p>
                  {view.instruction && <p className="pb-script-detail-instruction">改编指令：{view.instruction}</p>}
                </div>
                <span className="pb-script-detail-actions">
                  <Tooltip title="复制核心创意文本，便于重写或迁移到其他工具">
                    <Button size="small" icon={<CopyOutlined />} disabled={!view.idea} onClick={() => void copy(view.idea ?? "", "核心创意")}>复制创意</Button>
                  </Tooltip>
                  {view.scriptId && (
                    <Popconfirm
                      title="删除这条短剧记录？"
                      description="删除后无法恢复，产物文件将一并清理"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true, loading: deletingId === view.scriptId }}
                      onConfirm={() => void remove(view.scriptId!)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                  )}
                </span>
              </div>
              <ScriptGeneratedView view={view} onCopy={copy} />
            </div>
          )}
          {!detailLoading && !view?.exists && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧历史列表选择一条记录查看，或在上方生成新剧本" />
          )}
        </section>
      </div>
    </div>
  );
}
