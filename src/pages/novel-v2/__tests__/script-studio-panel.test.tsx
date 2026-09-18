/**
 * ScriptStudioPanel 创作表单与历史卡片单元测试（SSR 渲染）。
 *
 * 策略：面板组件使用手动 fetch 与 antd message（不依赖 react-query provider），
 * SSR 下 useEffect 不执行，因此只渲染导出的纯展示子组件：
 * - ShortScriptCreateForm：固定时长（滑杆 + 片段预算提示）与不限时长（无滑杆 +
 *   自行编排提示）两种时长模式的渲染分支
 * - ShortScriptHistoryCard：fixed 与 auto 产物的时长摘要文案
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigProvider } from "antd";
import { ShortScriptCreateForm, ShortScriptHistoryCard } from "../ScriptStudioPanel";

vi.stubGlobal("fetch", vi.fn());

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<ConfigProvider>{node}</ConfigProvider>);
}

const IDEA = "深夜便利店店员发现连续三晚同一时刻进店的顾客们买走的商品首字拼成同一句警告，而第四晚进店的是他自己。";

function formProps(durationMode: "fixed" | "auto") {
  return {
    idea: IDEA,
    onIdeaChange: () => undefined,
    instruction: "",
    onInstructionChange: () => undefined,
    duration: 30,
    onDurationChange: () => undefined,
    durationMode,
    onDurationModeChange: () => undefined,
    generating: false,
    onGenerate: () => undefined,
  };
}

describe("ShortScriptCreateForm 时长模式", () => {
  it("renders the fixed-duration slider with the segment budget hint", () => {
    const html = render(<ShortScriptCreateForm {...formProps("fixed")} />);
    expect(html).toContain("固定时长");
    expect(html).toContain("不限时长");
    expect(html).toContain("目标时长");
    expect(html).toContain("约 2-3 个片段（每段 10-15 秒）");
    expect(html).toContain("30s");
  });

  it("hides the duration slider in auto mode and explains the model-decided budget", () => {
    const html = render(<ShortScriptCreateForm {...formProps("auto")} />);
    expect(html).toContain("固定时长");
    expect(html).toContain("不限时长");
    expect(html).toContain("由大模型依据核心创意自行编排总时长与片段数");
    // auto 模式不渲染固定时长滑杆与片段预算提示
    expect(html).not.toContain("目标时长");
    expect(html).not.toContain("个片段（每段 10-15 秒）");
  });
});

describe("ShortScriptHistoryCard 时长摘要", () => {
  it("labels auto-duration scripts with the actual total seconds", () => {
    const html = render(
      <ShortScriptHistoryCard
        script={{ scriptId: "s-auto", idea: IDEA, durationMode: "auto", targetDurationSeconds: 72, segmentCount: 6, cinematicHintCount: 0, createdAt: Date.parse("2026-08-20T10:00:00Z") }}
        active={false}
        loading={false}
        onClick={() => undefined}
      />,
    );
    expect(html).toContain("不限时长 · 实际约 72s");
  });

  it("keeps the fixed-duration summary unchanged", () => {
    const html = render(
      <ShortScriptHistoryCard
        script={{ scriptId: "s-fixed", idea: IDEA, durationMode: "fixed", targetDurationSeconds: 30, segmentCount: 2, cinematicHintCount: 0, createdAt: Date.parse("2026-08-20T10:00:00Z") }}
        active={false}
        loading={false}
        onClick={() => undefined}
      />,
    );
    expect(html).toContain("30s");
    expect(html).not.toContain("不限时长");
  });
});
