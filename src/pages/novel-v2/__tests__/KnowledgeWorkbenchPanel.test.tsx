import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { describe, expect, it, vi } from "vitest";
import KnowledgeRecordForm from "../KnowledgeRecordForm";
import KnowledgeWorkbenchPanel, { isEditableKnowledgeKind, toEditableKnowledgeRecord } from "../KnowledgeWorkbenchPanel";

vi.stubGlobal("fetch", vi.fn());

describe("KnowledgeWorkbenchPanel", () => {
  it("exposes project material sources without duplicating the plan workspace", () => {
    const html = renderToStaticMarkup(<ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><App><KnowledgeWorkbenchPanel projectId="p1" /></App></ConfigProvider>);
    for (const label of ["角色", "关系", "叙事事实", "章节记忆", "本项目 Skill", "全局 Skill 治理"]) expect(html).toContain(label);
    expect(html).not.toContain("创作契约");
    expect(html).not.toContain("事实账本");
    expect(html).toContain("创作资料工作台");
  });

  it("allows authors to govern narrative facts through the workbench", () => {
    expect(isEditableKnowledgeKind("claims")).toBe(true);
  });

  it("renders nested character structures without coercing objects to [object Object]", () => {
    const html = renderToStaticMarkup(
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
        <KnowledgeRecordForm
          kind="characters"
          value={{
            name: "陈渊",
            payload: {
              role: "protagonist",
              motivation: "寻找真相",
              voiceAnchor: {
                sentenceLength: { latest: "短句为主", history: ["早期偏长句"] },
                vocabulary: "克制",
                directness: "直接",
                avoidance: "不说破",
              },
              arc: { start: "求生", end: "承担" },
              independentAction: { desire: "查明真相", choice: "独自调查" },
            },
          }}
          onChange={vi.fn()}
        />
      </ConfigProvider>,
    );
    expect(html).not.toContain("[object Object]");
    for (const label of ["句式 / 节奏", "历史值", "人物弧光", "独立行动", "认知边界"]) expect(html).toContain(label);
    expect(html).toContain("短句为主");
    expect(html).toContain("早期偏长句");
  });

  it("merges the read-only foundation projection into the editable payload", () => {
    const editable = toEditableKnowledgeRecord({
      id: "entity:p:character:char-chen-yuan",
      name: "陈渊",
      payload: { motivation: "动态动机" },
      foundation: { id: "char-chen-yuan", name: "陈渊", role: "protagonist", fear: "失去同伴" },
    });
    expect(editable.foundation).toBeUndefined();
    expect(editable.payload).toMatchObject({ role: "protagonist", fear: "失去同伴", motivation: "动态动机" });
  });
});
