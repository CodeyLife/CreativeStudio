/* ============================================================
 * 章节短剧剧本提示词弹窗（MiniMax H3 · Ref2VA）
 *
 * 定稿章节的只读派生产物展示与生成入口：
 * - 打开时读取既有产物 + 项目级共享 subject_definitions 预设
 * - 共享定义由作者手动编辑预设（<Subject N> 行格式，项目级复用）；
 *   片段生成时直接复用共享主体（不重复定义），片段内只写新增主体
 * - 尚未生成时提供指令输入 + 生成按钮（POST 同步生成）
 * - 已生成时按横向 Tabs 展示片段 promptText，支持逐段/整章复制
 * - 幂等键绑定 定稿内容 + 共享定义内容：改稿或修改共享定义后重新生成生效
 * ============================================================ */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Tabs, Tag, Tooltip, Typography, message } from "antd";
import { CopyOutlined, LoadingOutlined, ReloadOutlined, SaveOutlined, VideoCameraOutlined } from "@ant-design/icons";

import {
  fetchNovelChapterScript,
  fetchNovelChapterScriptSubjectPreset,
  generateNovelChapterScript,
  saveNovelChapterScriptSubjectPreset,
  type NovelChapterScriptCharacterView,
  type NovelChapterScriptSegmentView,
  type NovelChapterScriptSharedSubjectsView,
  type NovelChapterScriptView,
} from "../../lib/novelApi";
import { relativeTime } from "./presentation";

/** 剪贴板复制 hook（降级 execCommand；导出供剧本创作板块复用） */
export function useCopyToClipboard(): (text: string, label?: string) => Promise<void> {
  return useCallback(async (text: string, label = "已复制到剪贴板") => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(label);
    } catch {
      const holder = document.createElement("textarea");
      holder.value = text;
      document.body.appendChild(holder);
      holder.select();
      document.execCommand("copy");
      holder.remove();
      message.success(label);
    }
  }, []);
}

export function ScriptSegmentCard({ segment, index, onCopy }: { segment: NovelChapterScriptSegmentView; index: number; onCopy: (text: string, label?: string) => Promise<void> }) {
  return (
    <article className="pb-script-segment">
      <header className="pb-script-segment-head">
        <strong>{index}. {segment.title}</strong>
        <span className="pb-script-segment-meta">
          <Tag color="geekblue">{segment.durationSeconds}s</Tag>
          <Tooltip title="复制本片段完整 H3 提示词（subjectDefinitions 仅含新增主体，共享定义请用「复制共享定义库」前置）"><Button size="small" type="text" icon={<CopyOutlined />} aria-label={`复制片段 ${index}`} onClick={() => void onCopy(segment.promptText)} /></Tooltip>
        </span>
      </header>
      {segment.synopsis && <p className="pb-script-synopsis">{segment.synopsis}</p>}
      <pre className="pb-script-prompt">{segment.promptText}</pre>
    </article>
  );
}

/** 共享定义编辑区（项目级，生成前预设；导出供 SSR 单测渲染） */
export function SharedSubjectsEditor({ value, saving, error, onChange, onSave, onCopy, maxLabel }: {
  value: string;
  saving: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCopy: (text: string, label?: string) => Promise<void>;
  maxLabel: number;
}) {
  return (
    <div className="pb-script-shared">
      <div className="pb-script-shared-head">
        <span className="pb-script-shared-title">
          共享定义库（项目级）
          {maxLabel > 0 && <Tag color="cyan">{maxLabel} 个共享主体</Tag>}
          <Tag>片段仅含新增主体</Tag>
        </span>
        <span className="pb-script-shared-actions">
          {value.trim() && <Tooltip title="复制共享定义库（H3 生成时前置粘贴；片段内不再重复这些定义）"><Button size="small" icon={<CopyOutlined />} onClick={() => void onCopy(value.trim(), "已复制共享定义库")}>复制共享定义库</Button></Tooltip>}
          <Button size="small" icon={<SaveOutlined />} loading={saving} onClick={onSave}>保存预设</Button>
        </span>
      </div>
      <Input.TextArea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoSize={{ minRows: 3, maxRows: 8 }}
        placeholder={"每行一条，格式：<Subject N> 描述（编号从 1 连续递增）\n例如：<Subject 1> 用一段英文固定外形与服装描述主要角色或核心场景，跨片段复用\n留空表示无共享定义；保存后点「重新生成」生效"}
        aria-label="共享定义库"
      />
      {error && <Alert type="error" showIcon message="共享定义保存失败" description={error} />}
    </div>
  );
}

/** 已生成剧本的展示数据子集：章节剧本与创意短剧产物共用该视图（结构兼容即可，不强绑具体视图类型） */
export interface ScriptGeneratedViewData {
  exists?: boolean;
  segments?: NovelChapterScriptSegmentView[];
  characters?: NovelChapterScriptCharacterView[];
  sharedSubjects?: NovelChapterScriptSharedSubjectsView;
  cinematicHints?: string[];
  mode?: string;
  createdAt?: number;
}

export function ScriptGeneratedView({ view, onCopy }: { view: ScriptGeneratedViewData; onCopy: (text: string, label?: string) => Promise<void> }) {
  const segments = view.segments ?? [];
  const fullText = segments.map((segment) => `${segment.index}. ${segment.title}\n${segment.promptText}`).join("\n\n---\n\n");
  const characterCount = view.characters?.length ?? 0;
  const sharedMax = view.sharedSubjects?.maxLabel ?? 0;
  const hints = view.cinematicHints ?? [];
  return (
    <div className="pb-script-generated">
      {hints.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${hints.length} 个镜头缺少影视镜头语言（提示级，不阻断）`}
          description={<ul className="pb-script-hints">{hints.map((hint, position) => <li key={position}>{hint}</li>)}</ul>}
        />
      )}
      <div className="pb-script-toolbar">
        <span className="pb-script-toolbar-info">
          <Tag color="purple">{view.mode ?? "ref2va"}</Tag>
          <Tag>{segments.length} 个片段</Tag>
          {sharedMax > 0 && <Tooltip title="片段 subjectDefinitions 只含新增主体，这些共享主体在上方共享定义库中定义"><Tag color="cyan">{sharedMax} 个共享主体（复用）</Tag></Tooltip>}
          {characterCount > 0 && <Tooltip title="各片段 subjectDefinitions 复用同一套英文外观基线，保证跨片段角色一致"><Tag color="blue">{characterCount} 个人物基线</Tag></Tooltip>}
          {view.createdAt && <span className="pb-script-time">生成于 {relativeTime(view.createdAt)}</span>}
        </span>
        <span>
          <Tooltip title="复制全部片段提示词（含片段标题分隔）"><Button size="small" icon={<CopyOutlined />} onClick={() => void onCopy(fullText)}>复制全部</Button></Tooltip>
        </span>
      </div>
      <Tabs
        className="pb-script-tabs"
        size="small"
        items={segments.map((segment, position) => ({
          key: String(segment.index ?? position + 1),
          label: `${segment.index ?? position + 1}. ${segment.title}`,
          children: <ScriptSegmentCard segment={segment} index={segment.index ?? position + 1} onCopy={onCopy} />,
        }))}
      />
    </div>
  );
}

export default function ChapterScriptModal({ open, onClose, projectId, documentId }: { open: boolean; onClose: () => void; projectId: string; documentId?: string }) {
  const copy = useCopyToClipboard();
  const [view, setView] = useState<NovelChapterScriptView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [presetText, setPresetText] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetError, setPresetError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    if (documentId) {
      setLoading(true);
      setError(undefined);
      fetchNovelChapterScript(projectId, documentId)
        .then((data) => { if (!cancelled) setView(data); })
        .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    fetchNovelChapterScriptSubjectPreset(projectId)
      .then((data) => { if (!cancelled) setPresetText(data.definitionText ?? ""); })
      .catch((err) => { if (!cancelled) setPresetError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open, projectId, documentId]);

  async function generate() {
    if (!documentId) return;
    setGenerating(true);
    setError(undefined);
    try {
      const body = await generateNovelChapterScript(projectId, documentId, instruction.trim() || undefined);
      const record = body.record;
      setView({
        exists: true,
        artifactId: record.artifactId,
        createdAt: Date.now(),
        sourceFingerprint: record.sourceFingerprint,
        mode: "ref2va",
        minSegments: record.minSegments,
        plotBeats: record.plotBeats ?? [],
        cinematicHints: record.cinematicHints ?? [],
        sharedSubjects: record.sharedSubjects ?? { definitionText: presetText.trim(), maxLabel: 0 },
        characters: record.characters ?? [],
        segments: record.segments ?? [],
      });
      message.success(record.reused ? "同一定稿已有剧本，直接复用既有产物" : "剧本提示词已生成");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function savePreset() {
    setPresetSaving(true);
    setPresetError(undefined);
    try {
      const saved = await saveNovelChapterScriptSubjectPreset(projectId, presetText);
      setPresetText(saved.definitionText);
      message.success("共享定义已保存；对已生成章节点「重新生成」后生效");
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : String(err));
    } finally {
      setPresetSaving(false);
    }
  }

  const exists = Boolean(view?.exists);
  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={880}
      title={<span><VideoCameraOutlined /> 短剧剧本提示词（MiniMax H3 · Ref2VA）</span>}
      footer={[
        exists ? (
          <Tooltip key="regen" title="正文改版或修改共享定义后重新生成生效；未变化时复用既有产物。">
            <Button key="regen" icon={<ReloadOutlined />} loading={generating} disabled={!documentId} onClick={() => void generate()}>重新生成</Button>
          </Tooltip>
        ) : null,
        <Button key="close" type="primary" onClick={onClose}>关闭</Button>,
      ]}
    >
      <ChapterScriptBody
        documentId={documentId}
        view={view}
        loading={loading}
        error={error}
        instruction={instruction}
        onInstructionChange={setInstruction}
        onGenerate={() => void generate()}
        generating={generating}
        onCopy={copy}
        presetText={presetText}
        presetSaving={presetSaving}
        presetError={presetError}
        onPresetChange={setPresetText}
        onPresetSave={() => void savePreset()}
      />
    </Modal>
  );
}

/** 弹窗主体（导出以便 SSR 单测直接渲染分支，绕过 antd Modal 的 Portal SSR 限制） */
export function ChapterScriptBody({ documentId, view, loading, error, instruction, onInstructionChange, onGenerate, generating, onCopy, presetText, presetSaving, presetError, onPresetChange, onPresetSave }: {
  documentId?: string;
  view?: NovelChapterScriptView;
  loading: boolean;
  error?: string;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onGenerate: () => void;
  generating: boolean;
  onCopy: (text: string, label?: string) => Promise<void>;
  presetText: string;
  presetSaving: boolean;
  presetError?: string;
  onPresetChange: (value: string) => void;
  onPresetSave: () => void;
}) {
  const exists = Boolean(view?.exists);
  return (
    <>
      {!documentId && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选择一个章节" />}
      {documentId && loading && <div className="pb-loading"><LoadingOutlined /> 读取剧本…</div>}
      {documentId && (
        <SharedSubjectsEditor
          value={presetText}
          saving={presetSaving}
          error={presetError}
          onChange={onPresetChange}
          onSave={onPresetSave}
          onCopy={onCopy}
          maxLabel={view?.sharedSubjects?.maxLabel ?? 0}
        />
      )}
      {documentId && !loading && !exists && (
        <div className="pb-script-empty">
          <Alert
            type="info"
            showIcon
            message="本章尚未生成短剧剧本"
            description="将按场景节拍把定稿正文拆分为多个 5-10 秒片段，每片段产出一条 MiniMax H3 全参考模式（Ref2VA）提示词；上方共享定义库中的主体在片段内直接复用（不重复定义），片段内只写新增主体；对白保留中文原文。该产物为只读派生，不会修改正文。"
          />
          <Input.TextArea
            value={instruction}
            onChange={(event) => onInstructionChange(event.target.value)}
            maxLength={2000}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="改编指令（可选）：例如节奏偏好、特写重点、需要淡化的支线等"
            aria-label="剧本改编指令"
          />
          {error && <Alert type="error" showIcon message="生成失败" description={error} />}
          <Button type="primary" icon={<VideoCameraOutlined />} loading={generating} onClick={onGenerate}>生成剧本提示词</Button>
        </div>
      )}
      {documentId && exists && view && (
        <>
          {error && <Alert type="error" showIcon message="操作失败" description={error} />}
          {view.sourceFingerprint && (
            <Typography.Paragraph type="secondary" className="pb-script-fingerprint">绑定定稿指纹：<code>{view.sourceFingerprint.slice(0, 16)}</code>…（正文改版或修改共享定义后用「重新生成」更新）</Typography.Paragraph>
          )}
          <ScriptGeneratedView view={view} onCopy={onCopy} />
        </>
      )}
    </>
  );
}
