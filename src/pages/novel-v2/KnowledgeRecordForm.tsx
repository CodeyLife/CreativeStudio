/* ============================================================
 * KnowledgeRecordForm — 知识库记录结构化表单（替换裸 JSON 编辑）
 *
 * 现状：KnowledgeWorkbenchPanel 用一个 TextArea 手编整条 JSON，易错且门槛高。
 * 这里用「按类型的字段 schema 注册表」驱动表单渲染：
 * - 每种知识库（planning/worldview/characters/relations/timeline/facts/skills）
 *   声明自己的字段（路径/类型/选项/校验），表单据此渲染对应控件
 * - 复杂子结构（promptSections / objectValue / content）退化为「子字段级 JSON」编辑，
 *   而非整条记录 JSON —— 大幅降低出错面
 * - 字符串数组（constraints/capabilities/...）用 tags 输入，免手写 JSON 数组
 *
 * 设计依据：AGENTS.md「reusable contracts」—— 字段 schema 是领域内在结构，
 * 不是针对某条记录的特例；新增知识库类型只需在 SCHEMA 加一条注册项。
 * ============================================================ */

import { useEffect, useRef, useState } from "react";
import { Input, InputNumber, Select, Switch } from "antd";
import "./knowledge-form.css";

export type KnowledgeFormKind = "planning" | "worldview" | "characters" | "relations" | "timeline" | "facts" | "claims" | "skills";

type FieldType = "text" | "textarea" | "number" | "select" | "switch" | "stringList" | "json" | "object";

export interface FieldSchema {
  /** 记录在对象中的 dot 路径（支持 payload.xxx 嵌套） */
  path: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  help?: string;
  /** 2 = 占满整行，1 = 半行 */
  span?: 1 | 2;
  /** object 字段的已知子字段；未声明的键仍通过 JSON 保留和编辑 */
  children?: FieldSchema[];
}

/** 各知识库类型的字段 schema（领域内在结构，非特例） */
export const KNOWLEDGE_FORM_SCHEMA: Record<KnowledgeFormKind, FieldSchema[]> = {
  planning: [
    { path: "name", label: "规划名称", type: "text", span: 2, placeholder: "如：全书基调 / 第一卷主线" },
    { path: "payload.objective", label: "创作目标", type: "textarea", rows: 3, span: 2, placeholder: "这条规划要达成什么" },
    { path: "payload.constraints", label: "约束条件", type: "stringList", span: 2, help: "每条约束一项，回车添加" },
  ],
  worldview: [
    { path: "name", label: "设定名称", type: "text", span: 2, placeholder: "如：星环城的物理法则" },
    { path: "payload.rule", label: "规则", type: "textarea", rows: 3, span: 2, placeholder: "这个世界如何运作" },
    { path: "payload.boundary", label: "边界", type: "textarea", rows: 3, span: 2, placeholder: "什么不能发生 / 未明确定义的部分" },
  ],
  characters: [
    { path: "name", label: "角色名", type: "text", placeholder: "如：林晚" },
    { path: "payload.role", label: "定位 / 身份", type: "select", options: [
      { value: "protagonist", label: "主角" },
      { value: "antagonist", label: "对手" },
      { value: "ally", label: "盟友" },
      { value: "rival", label: "竞争者" },
      { value: "guardian", label: "守护者" },
      { value: "mentor", label: "引导者" },
      { value: "wildcard", label: "变量" },
    ] },
    { path: "payload.motivation", label: "动机", type: "textarea", rows: 3, span: 2, placeholder: "TA 想要什么、害怕什么" },
    { path: "payload.fear", label: "核心恐惧", type: "textarea", rows: 2, placeholder: "TA 最害怕失去什么" },
    { path: "payload.secret", label: "秘密", type: "textarea", rows: 2, placeholder: "尚未公开、但会影响选择的秘密" },
    {
      path: "payload.voiceAnchor", label: "声部锚点", type: "object", span: 2, help: "语气 / 用词 / 节奏 / 禁忌，供人物声音一致性",
      children: [
        { path: "sentenceLength", label: "句式 / 节奏", type: "textarea", rows: 2 },
        { path: "vocabulary", label: "词汇 / 用语", type: "textarea", rows: 2 },
        { path: "directness", label: "表达直率度", type: "textarea", rows: 2 },
        { path: "avoidance", label: "回避方式", type: "textarea", rows: 2 },
      ],
    },
    {
      path: "payload.arc", label: "人物弧光", type: "object", span: 2,
      children: [
        { path: "start", label: "起点", type: "textarea", rows: 2 },
        { path: "end", label: "终点", type: "textarea", rows: 2 },
      ],
    },
    {
      path: "payload.independentAction", label: "独立行动", type: "object", span: 2,
      children: [
        { path: "desire", label: "欲望", type: "textarea", rows: 2 },
        { path: "strategy", label: "策略", type: "textarea", rows: 2 },
        { path: "choice", label: "选择", type: "textarea", rows: 2 },
        { path: "cost", label: "代价", type: "textarea", rows: 2 },
        { path: "knowledgeBoundary", label: "认知边界", type: "textarea", rows: 2 },
      ],
    },
  ],
  relations: [
    { path: "subjectId", label: "主体", type: "text", placeholder: "如：林晚" },
    { path: "predicate", label: "关系", type: "text", placeholder: "如：师徒 / 敌对 / 守护" },
    { path: "objectId", label: "客体", type: "text", placeholder: "如：陆沉" },
  ],
  timeline: [
    { path: "narrativeTime", label: "章节序号", type: "number", min: 1, step: 1 },
    { path: "eventType", label: "事件类型", type: "text", placeholder: "如：转折 / 揭示 / 相遇" },
    { path: "content", label: "事件内容", type: "json", span: 2, help: "结构化事件描述（JSON）" },
  ],
  facts: [
    { path: "subjectId", label: "主体", type: "text", placeholder: "如：林晚" },
    { path: "predicate", label: "谓词", type: "text", placeholder: "如：持有 / 知晓 / 位于" },
    { path: "objectValue", label: "值", type: "json", span: 2, help: "事实的取值（可为字符串/对象 JSON）" },
    { path: "truthStatus", label: "真值状态", type: "select", options: [
      { value: "objective", label: "客观" },
      { value: "belief", label: "信念" },
      { value: "lie", label: "谎言" },
      { value: "candidate", label: "候选" },
    ] },
    { path: "confidence", label: "置信度", type: "number", min: 0, max: 1, step: 0.05 },
  ],
  claims: [
    { path: "title", label: "事实标题", type: "text", span: 2, placeholder: "简洁概括这条事实" },
    { path: "subjectRefs", label: "事实主体", type: "stringList", span: 2, help: "输入明确的人物、地点、组织或物品名，回车添加" },
    { path: "predicate", label: "关系谓词", type: "text", placeholder: "如：持有 / 位于 / 知晓" },
    { path: "narrativeStart", label: "首次成立章节", type: "number", min: 1, step: 1 },
    { path: "narrativeEnd", label: "成立截止章节", type: "number", min: 1, step: 1, help: "持续有效可留空" },
    { path: "content", label: "事实内容", type: "textarea", rows: 5, span: 2, placeholder: "写明正文已经建立、后续创作需要保持一致的事实" },
  ],
  skills: [
    { path: "id", label: "Skill ID", type: "text", placeholder: "如：chapter-draft" },
    { path: "version", label: "版本", type: "text", placeholder: "如：1.0.0" },
    { path: "capabilities", label: "能力", type: "stringList", span: 2 },
    { path: "applicableTasks", label: "适用任务", type: "stringList", span: 2 },
    { path: "qualityGates", label: "质量门", type: "stringList", span: 2 },
    { path: "enabled", label: "启用", type: "switch" },
    { path: "promptSections", label: "Prompt 段", type: "json", span: 2, help: "提示词分段（JSON 对象）" },
  ],
};

// ---------- dot 路径 get / set（不可变） ----------
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

function setPath(obj: unknown, path: string, value: unknown): unknown {
  const keys = path.split(".");
  const root: Record<string, unknown> = Array.isArray(obj) ? ([...obj] as unknown as Record<string, unknown>) : { ...(obj as Record<string, unknown>) };
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cur[k];
    cur[k] = Array.isArray(next) ? ([...next] as unknown as Record<string, unknown>) : { ...((next as Record<string, unknown>) ?? {}) };
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function isVersionedObject(value: unknown): value is Record<string, unknown> & { latest?: unknown; history?: unknown } {
  return isRecord(value) && ("latest" in value || "history" in value);
}

// ---------- 子字段级 JSON 编辑器（允许中间态非法，合法才上抛） ----------
function JsonField({ value, onChange, rows = 4, placeholder }: { value: unknown; onChange: (v: unknown) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  // 记录最近一次由本控件上抛的序列化值；外部值与之不同才回灌，避免打字时被重排
  const lastEmitted = useRef<string>(JSON.stringify(value ?? {}, null, 2));
  useEffect(() => {
    const serialized = JSON.stringify(value ?? {}, null, 2);
    if (serialized !== lastEmitted.current) {
      lastEmitted.current = serialized;
      setText(serialized);
      setInvalid(false);
    }
  }, [value]);
  return (
    <div className={`krf-json ${invalid ? "is-invalid" : ""}`}>
      <Input.TextArea
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder ?? "{ }"}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            lastEmitted.current = JSON.stringify(parsed, null, 2);
            onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 12 }}
      />
      {invalid && <div className="krf-json-error">JSON 格式无效，修正后才会保存</div>}
    </div>
  );
}

function ScalarField({ field, value, onChange }: { field: FieldSchema; value: unknown; onChange: (v: unknown) => void }) {
  if (isVersionedObject(value)) {
    const history = Array.isArray(value.history) ? value.history.filter((item): item is string => typeof item === "string") : [];
    return (
      <div className="krf-history-field">
        <Input.TextArea
          value={textValue(value.latest)}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          onChange={(event) => onChange({ ...value, latest: event.target.value })}
        />
        <span className="krf-history-label">历史值</span>
        <Select
          mode="tags"
          style={{ width: "100%" }}
          value={history}
          placeholder="回车添加历史值"
          onChange={(next) => onChange({ ...value, history: next })}
          open={false}
          suffixIcon={null}
        />
      </div>
    );
  }
  if (isRecord(value) || Array.isArray(value)) {
    return <JsonField value={value} onChange={onChange} rows={field.rows ?? 4} placeholder={field.placeholder} />;
  }
  if (field.type === "text") {
    return <Input value={textValue(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />;
  }
  return <Input.TextArea value={textValue(value)} rows={field.rows ?? 3} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />;
}

function ObjectField({ field, value, onChange }: { field: FieldSchema; value: unknown; onChange: (v: unknown) => void }) {
  const objectValue = isRecord(value) ? value : {};
  const children = field.children ?? [];
  const knownKeys = new Set(children.map((child) => child.path.split(".")[0]));
  const extraValue = Object.fromEntries(Object.entries(objectValue).filter(([key]) => !knownKeys.has(key)));

  return (
    <div className="krf-object">
      {children.length > 0 ? (
        <div className="krf-object-grid">
          {children.map((child) => {
            const childValue = getPath(objectValue, child.path);
            return (
              <div key={child.path} className={`krf-object-field ${(child.span ?? 1) === 2 ? "is-span2" : ""}`}>
                <label className="krf-label">{child.label}</label>
                <FieldControl
                  field={child}
                  value={childValue}
                  onChange={(next) => onChange(setPath(objectValue, child.path, next))}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {Object.keys(extraValue).length > 0 ? (
        <div className="krf-object-extra">
          <label className="krf-label">其他结构字段</label>
          <JsonField
            value={extraValue}
            onChange={(next) => onChange({ ...objectValue, ...(isRecord(next) ? next : {}) })}
            rows={5}
          />
        </div>
      ) : null}
    </div>
  );
}

function FieldControl({ field, value, onChange }: { field: FieldSchema; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === "text" || field.type === "textarea") return <ScalarField field={field} value={value} onChange={onChange} />;
  if (field.type === "json") return <JsonField value={value} onChange={onChange} rows={field.rows ?? 4} placeholder={field.placeholder} />;
  if (field.type === "object") return <ObjectField field={field} value={value} onChange={onChange} />;
  if (field.type === "number") return <InputNumber style={{ width: "100%" }} value={typeof value === "number" ? value : undefined} min={field.min} max={field.max} step={field.step} onChange={onChange} />;
  if (field.type === "select") return <Select style={{ width: "100%" }} value={(value as string) ?? undefined} options={field.options} onChange={onChange} />;
  if (field.type === "switch") return <Switch checked={value !== false} onChange={onChange} />;
  return <Select mode="tags" style={{ width: "100%" }} value={Array.isArray(value) ? (value as string[]) : []} placeholder={field.placeholder ?? "回车添加"} onChange={onChange} open={false} suffixIcon={null} />;
}

export interface KnowledgeRecordFormProps {
  kind: KnowledgeFormKind;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function KnowledgeRecordForm({ kind, value, onChange }: KnowledgeRecordFormProps) {
  const fields = KNOWLEDGE_FORM_SCHEMA[kind] ?? [];
  const update = (path: string, v: unknown) => onChange(setPath(value, path, v) as Record<string, unknown>);

  return (
    <div className="krf-grid">
      {fields.map((f) => {
        const v = getPath(value, f.path);
        const span = f.span ?? 1;
        return (
          <div key={f.path} className={`krf-field ${span === 2 ? "is-span2" : ""}`}>
            <label className="krf-label">{f.label}</label>
            <FieldControl field={f} value={v} onChange={(next) => update(f.path, next)} />
            {f.help && <div className="krf-help">{f.help}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default KnowledgeRecordForm;
