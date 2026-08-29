/* ============================================================
 * 剧本创作独立板块（左侧主导航入口，与小说创作平级）
 *
 * 完全独立于小说项目（契约 v2）：
 * - 无需选择作品即可创作独立短剧；顶部「关联作品」选择器可选——
 *   选中时产物关联该作品（衍生短剧），历史列表按作品过滤
 * - 选择记忆在 localStorage；清除选择回到独立模式（显示全部短剧）
 * - 小说创作侧的章节转剧本能力保留在章节工作台「剧本提示词」弹窗
 * ============================================================ */
import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Select, Skeleton } from "antd";
import { useNovelProjects } from "@/lib/novelApi";
import "./novel-v2.css";
import "./novel-v2/workspace-command.css";
import { projectDisplayTitle } from "./novel-v2/presentation";

const ScriptStudioPanel = lazy(() => import("./novel-v2/ScriptStudioPanel"));

const STORAGE_KEY = "script-studio:selected-project";

function PanelFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} />;
}

export default function ScriptStudio() {
  const projectsQ = useNovelProjects();
  const [projectId, setProjectId] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? "");

  // 记住选择（清除时移除记忆）
  useEffect(() => {
    if (projectId) localStorage.setItem(STORAGE_KEY, projectId);
    else localStorage.removeItem(STORAGE_KEY);
  }, [projectId]);

  // 已记忆的项目不在列表中（被删除）时清空选择
  const projectExists = projectsQ.data?.some((project) => project.id === projectId);
  useEffect(() => {
    if (projectsQ.isSuccess && projectId && !projectExists) setProjectId("");
  }, [projectsQ.isSuccess, projectExists, projectId]);

  const projects = projectsQ.data ?? [];

  return (
    <div className="nwc-page nwc-script-studio-page">
      <header className="nwc-library-topbar">
        <div>
          <span className="nwc-kicker">剧本创作</span>
          <h1>短剧工作台</h1>
          <p>从一个核心创意直接生成可拍的短剧分镜剧本（MiniMax H3 · Ref2VA），无需任何小说作品；为某部小说拍衍生短剧时可选关联作品。章节转剧本入口在小说创作的章节工作台。</p>
        </div>
        <div className="nwc-topbar-actions">
          <Select
            style={{ minWidth: 240 }}
            placeholder="关联作品（可选：衍生短剧）"
            value={projectId || undefined}
            loading={projectsQ.isLoading}
            showSearch
            optionFilterProp="label"
            options={projects.map((project) => ({
              value: project.id,
              label: projectDisplayTitle(project.title, project.id),
            }))}
            onChange={(value: string) => setProjectId(value ?? "")}
            allowClear
            aria-label="关联作品（可选）"
          />
        </div>
      </header>

      {projectsQ.isError && (
        <Alert type="error" showIcon message="加载作品列表失败" description={projectsQ.error instanceof Error ? projectsQ.error.message : undefined} />
      )}
      {projectsQ.isError && !projectId && (
        <Alert type="info" showIcon message="独立模式可用" description="作品列表加载失败不影响独立短剧创作；如需关联作品请稍后重试。" />
      )}

      <Suspense fallback={<PanelFallback />}>
        <ScriptStudioPanel projectId={projectId || undefined} />
      </Suspense>
    </div>
  );
}
