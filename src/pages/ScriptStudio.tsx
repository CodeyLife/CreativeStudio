/* ============================================================
 * 剧本创作独立板块（左侧主导航入口，与小说创作平级）
 *
 * 独立短剧（不含小说派生章节短剧）数据全部存浏览器 IndexedDB（见 shortDramaStore）：
 * - 创作台 / 公用素材 / 剧情历史均本地存储，无需任何小说项目、无需 Postgres
 * - 生成走后端 stateless 端点（POST /v2/short-script-h3，不落库），产物落本地 store
 * - 已取消「关联作品」能力（浏览器化后独立短剧不再关联小说项目）
 * 小说创作侧的章节转剧本能力保留在章节工作台「剧本提示词」弹窗
 * ============================================================ */
import { lazy, Suspense } from "react";
import { Skeleton } from "antd";
import "./novel-v2.css";
import "./novel-v2/workspace-command.css";

const ScriptStudioPanel = lazy(() => import("./novel-v2/ScriptStudioPanel"));

function PanelFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} />;
}

export default function ScriptStudio() {
  return (
    <div className="nwc-page nwc-script-studio-page">
      <header className="nwc-library-topbar">
        <div>
          <span className="nwc-kicker">剧本创作</span>
          <h1>短剧工作台</h1>
          <p>从一个核心创意直接生成可拍的短剧分镜剧本（MiniMax H3 · Ref2VA），无需任何小说作品；创作台、公用素材与剧情历史均保存在本机浏览器（IndexedDB）。章节转剧本入口在小说创作的章节工作台。</p>
        </div>
      </header>

      <Suspense fallback={<PanelFallback />}>
        <ScriptStudioPanel />
      </Suspense>
    </div>
  );
}