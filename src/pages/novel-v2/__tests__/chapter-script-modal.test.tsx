/**
 * ChapterScriptModal 单元测试（SSR 渲染）。
 *
 * 策略：Modal 使用手动 fetch（不依赖 react-query provider），
 * SSR 下 useEffect 不执行，因此：
 * - 直接渲染导出的 ScriptSegmentCard / ScriptGeneratedView 验证产物展示分支
 * - 渲染默认 Modal 验证空态入口文案与改编指令输入
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigProvider } from "antd";
import { ChapterScriptBody, ScriptGeneratedView, ScriptSegmentCard, SharedSubjectsEditor } from "../ChapterScriptModal";

vi.stubGlobal("fetch", vi.fn());

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<ConfigProvider>{node}</ConfigProvider>);
}

const copy = async () => undefined;

const COURIER_EN = "The middle-aged courier has short black hair, stubble, a faded grey uniform jacket and a scuffed delivery satchel.";

const segment = {
  index: 2,
  title: "雨巷收音机",
  synopsis: "快递员向站点上报包裹丢失。",
  durationSeconds: 8,
  promptText: "subject_definitions:\n<Subject 1> is the middle-aged courier...\nsummary:\n[reference generation] ...",
};

describe("ChapterScriptModal", () => {
  it("renders a segment card with title, duration and prompt body", () => {
    const html = render(<ScriptSegmentCard segment={segment} index={segment.index} onCopy={copy} />);
    expect(html).toContain("雨巷收音机");
    expect(html).toContain("8s");
    expect(html).toContain("subject_definitions:");
    expect(html).toContain('aria-label="复制片段 2"');
  });

  it("renders the generated view with toolbar metadata across segments", () => {
    const html = render(
      <ScriptGeneratedView
        view={{ exists: true, mode: "ref2va", createdAt: Date.parse("2026-08-20T10:00:00Z"), segments: [segment], characters: [{ name: "陈默", appearanceEn: COURIER_EN }] }}
        onCopy={copy}
      />,
    );
    expect(html).toContain("ref2va");
    expect(html).toContain("1 个片段");
    expect(html).toContain("1 个人物基线");
    expect(html).toContain("复制全部");
  });

  it("shows the empty-state generation entry inside the modal body", () => {
    const html = render(
      <ChapterScriptBody documentId="d-1" loading={false} instruction="" onInstructionChange={() => undefined} onGenerate={() => undefined} generating={false} onCopy={copy} presetText="" presetSaving={false} onPresetChange={() => undefined} onPresetSave={() => undefined} />,
    );
    expect(html).toContain("本章尚未生成短剧剧本");
    expect(html).toContain("生成剧本提示词");
    expect(html).toContain('aria-label="剧本改编指令"');
    expect(html).toContain("Ref2VA");
  });

  it("prompts document selection when documentId is missing", () => {
    const html = render(
      <ChapterScriptBody loading={false} instruction="" onInstructionChange={() => undefined} onGenerate={() => undefined} generating={false} onCopy={copy} presetText="" presetSaving={false} onPresetChange={() => undefined} onPresetSave={() => undefined} />,
    );
    expect(html).toContain("先选择一个章节");
  });

  it("shows the shared subjects editor inside the body with preset controls", () => {
    const html = render(
      <ChapterScriptBody
        documentId="d-1"
        loading={false}
        instruction=""
        onInstructionChange={() => undefined}
        onGenerate={() => undefined}
        generating={false}
        onCopy={copy}
        presetText="<Subject 1> Chu Heng, a gaunt young cultivator in a worn grey robe."
        presetSaving={false}
        onPresetChange={() => undefined}
        onPresetSave={() => undefined}
      />,
    );
    expect(html).toContain("共享定义库（项目级）");
    expect(html).toContain("保存预设");
    expect(html).toContain('aria-label="共享定义库"');
    expect(html).toContain("复制共享定义库");
  });

  it("renders the shared subjects editor with copy and save actions", () => {
    const html = render(
      <SharedSubjectsEditor
        value="<Subject 1> Chu Heng, a gaunt young cultivator in a worn grey robe."
        saving={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onCopy={copy}
        maxLabel={2}
      />,
    );
    expect(html).toContain("共享定义库（项目级）");
    expect(html).toContain("2 个共享主体");
    expect(html).toContain("片段仅含新增主体");
    expect(html).toContain("复制共享定义库");
    expect(html).toContain("保存预设");
    expect(html).toContain('aria-label="共享定义库"');
  });

  it("shows shared-subject reuse state in the generated view", () => {
    const html = render(
      <ScriptGeneratedView
        view={{ exists: true, mode: "ref2va", createdAt: Date.parse("2026-08-20T10:00:00Z"), segments: [segment], characters: [{ name: "陈默", appearanceEn: COURIER_EN }], sharedSubjects: { definitionText: "<Subject 1> x", maxLabel: 2 } }}
        onCopy={copy}
      />,
    );
    expect(html).toContain("2 个共享主体（复用）");
  });
});
