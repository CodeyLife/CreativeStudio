import { useState, type ReactNode } from "react";
import {
  ApiOutlined,
  FileTextOutlined,
  NodeIndexOutlined,
  PictureOutlined,
  SettingOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Form, Input, InputNumber, Segmented, Tabs } from "antd";
import { useUIStore, getEffectiveApiConfig, type ImageGenAdapter } from "@/stores/ui";
import { DEFAULT_GREENSCREEN_PROMPT, DEFAULT_SPRITESHEET_PROMPT } from "@/config/defaults";
import { PageHeader } from "@/components/showtime";
import { ChatModelSelect } from "@/components/ChatModelSelect";
import { NovelModelRoutingSettings } from "@/components/NovelModelRoutingSettings";

const { TextArea } = Input;

/** 核心设置统一由一个 Form 保存；小说模型路由保留独立保存入口（见 NovelModelRoutingSettings）。 */
type SettingsFormValues = {
  api_base_url: string;
  api_key: string;
  chat_model: string;
  model_context_window: number | null;
  thumb_size: number | null;
  image_gen_adapter: ImageGenAdapter;
  greenscreen_prompt: string;
  spritesheet_prompt: string;
};

type SettingsTabKey = "api" | "imagegen" | "prompts" | "routing";

/** Tab 顺序即板块顺序；key 同时用作 URL hash，支持从外部直达对应板块。 */
const SETTINGS_TABS: { key: SettingsTabKey; label: string; icon: ReactNode }[] = [
  { key: "api", label: "接口与模型", icon: <ApiOutlined /> },
  { key: "imagegen", label: "生图偏好", icon: <PictureOutlined /> },
  { key: "prompts", label: "提示词模板", icon: <FileTextOutlined /> },
  { key: "routing", label: "小说模型路由", icon: <NodeIndexOutlined /> },
];

function initialTabKey(): SettingsTabKey {
  const hash = window.location.hash.replace(/^#/, "");
  return SETTINGS_TABS.some((tab) => tab.key === hash) ? (hash as SettingsTabKey) : "api";
}

function SectionHeader({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="settings-section-head">
      <span className="settings-section-icon" aria-hidden>{icon}</span>
      <div className="settings-section-copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

/** 板块内保存操作行：每个核心板块底部一组；重置仅在存在未保存更改时可用。 */
function SettingsActions({ dirty, onReset }: { dirty: boolean; onReset: () => void }) {
  return (
    <div className="settings-form-actions">
      <span className={`settings-dirty-note${dirty ? " is-dirty" : ""}`} role="status">
        有未保存的更改
      </span>
      <div className="settings-form-actions-buttons">
        <Button disabled={!dirty} icon={<UndoOutlined />} onClick={onReset}>重置</Button>
        <Button type="primary" htmlType="submit">保存更改</Button>
      </div>
    </div>
  );
}

export default function Settings() {
  const { message } = App.useApp();
  const [form] = Form.useForm<SettingsFormValues>();
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(initialTabKey);

  const apiBaseUrl = useUIStore((s) => s.apiBaseUrl);
  const apiKey = useUIStore((s) => s.apiKey);
  const chatModel = useUIStore((s) => s.chatModel);
  const modelContextWindow = useUIStore((s) => s.modelContextWindow);
  const thumbSize = useUIStore((s) => s.thumbSize);
  const greenscreenPrompt = useUIStore((s) => s.greenscreenPrompt);
  const spritesheetPrompt = useUIStore((s) => s.spritesheetPrompt);
  const imageGenAdapter = useUIStore((s) => s.imageGenAdapter);
  const setApiBaseUrl = useUIStore((s) => s.setApiBaseUrl);
  const setApiKey = useUIStore((s) => s.setApiKey);
  const setChatModel = useUIStore((s) => s.setChatModel);
  const setModelContextWindow = useUIStore((s) => s.setModelContextWindow);
  const setThumbSize = useUIStore((s) => s.setThumbSize);
  const setGreenscreenPrompt = useUIStore((s) => s.setGreenscreenPrompt);
  const setSpritesheetPrompt = useUIStore((s) => s.setSpritesheetPrompt);
  const setImageGenAdapter = useUIStore((s) => s.setImageGenAdapter);
  const { hasOwnKey, hasDefaultKey, usesDefaultBaseUrl } = getEffectiveApiConfig();

  const handleTabChange = (key: string) => {
    setActiveTab(key as SettingsTabKey);
    // hash 仅作板块直达锚点，replaceState 不触发路由导航
    window.history.replaceState(null, "", `#${key}`);
  };

  async function onSave(values: SettingsFormValues) {
    setApiBaseUrl(values.api_base_url || "");
    setApiKey(values.api_key || "");
    setChatModel(values.chat_model || "gpt-5-5");
    setModelContextWindow(values.model_context_window || 0);
    setThumbSize(values.thumb_size || 256);
    setImageGenAdapter(values.image_gen_adapter ?? "task");
    setGreenscreenPrompt(values.greenscreen_prompt || "");
    setSpritesheetPrompt(values.spritesheet_prompt || "");
    setDirty(false);
    message.success("设置已保存");
  }

  function handleReset() {
    form.resetFields();
    setDirty(false);
    message.info("已还原为上次保存的设置");
  }

  // 留空即表示使用默认模板（占位符展示默认内容）
  function restorePromptDefault(field: "greenscreen_prompt" | "spritesheet_prompt") {
    form.setFieldValue(field, "");
    // setFieldValue 不触发 onValuesChange，dirty 需手动标记
    setDirty(true);
  }

  const apiKeyHelp = apiKey
    ? "使用自有 Key"
    : usesDefaultBaseUrl && hasDefaultKey
      ? "留空使用部署提供的默认 Key（不显示）"
      : "当前没有可用的默认 Key，请填写";

  const tabLabel = (tab: (typeof SETTINGS_TABS)[number]) => (
    <span className="settings-tab-label">
      <span className="settings-tab-icon" aria-hidden>{tab.icon}</span>
      <span>{tab.label}</span>
    </span>
  );

  return (
    <div className="settings-page">
      <PageHeader
        title="设置"
        description="接口凭证、生图偏好与提示词模板集中管理。修改后点击保存生效，并自动持久化到本地。"
        icon={<SettingOutlined />}
      />

      {/* 核心 3 个板块共用一个 Form；forceRender 保证未激活 pane 的字段也注册，
          否则用户未访问过的 tab 在保存时会被默认值覆盖。路由板块有自己的保存语义。 */}
      <Form<SettingsFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        className="settings-form-flow"
        initialValues={{
          api_base_url: apiBaseUrl,
          api_key: apiKey,
          chat_model: chatModel,
          model_context_window: modelContextWindow,
          thumb_size: thumbSize,
          image_gen_adapter: imageGenAdapter,
          greenscreen_prompt: greenscreenPrompt,
          spritesheet_prompt: spritesheetPrompt,
        }}
        onValuesChange={() => setDirty(true)}
        onFinish={onSave}
      >
        <div className="settings-topbar">
          <Tabs
            className="settings-tabs"
            activeKey={activeTab}
            onChange={handleTabChange}
            items={[
              {
                key: "api",
                label: tabLabel(SETTINGS_TABS[0]),
                forceRender: true,
                children: (
                  <section className="settings-panel">
                    <SectionHeader
                      icon={<ApiOutlined />}
                      title="接口与模型"
                      description="OpenAI 兼容接口凭证与对话模型。API Key 仅保存在本地浏览器，不会上传。"
                    />
                    {!hasOwnKey && usesDefaultBaseUrl && hasDefaultKey && (
                      <Alert
                        className="settings-alert"
                        type="info"
                        showIcon
                        message="当前使用默认接口，生图数量限制为 1。配置自有 Key 后可解锁完整功能。"
                      />
                    )}
                    {!hasOwnKey && (!usesDefaultBaseUrl || !hasDefaultKey) && (
                      <Alert
                        className="settings-alert"
                        type="warning"
                        showIcon
                        message={usesDefaultBaseUrl
                          ? "当前部署未提供默认 API Key，请填写可用的 API Key。"
                          : "当前使用自定义接口地址，请填写该接口对应的 API Key。"}
                      />
                    )}
                    <div className="settings-form-grid">
                      <Form.Item label="API Base URL" name="api_base_url" help="留空使用默认接口地址">
                        <Input placeholder="https://api.openai.com/v1" allowClear />
                      </Form.Item>
                      <Form.Item label="API Key" name="api_key" help={apiKeyHelp}>
                        <Input.Password placeholder="sk-..." autoComplete="new-password" />
                      </Form.Item>
                      <Form.Item label="对话模型" name="chat_model" help="新配置默认 gpt-5-5；仍可选择 auto 由接口自动选择可用模型">
                        <ChatModelSelect style={{ width: "100%" }} />
                      </Form.Item>
                      <Form.Item
                        label="模型上下文硬上限"
                        name="model_context_window"
                        help="留空或 0 时自动读取 /models 能力字段；自定义接口未返回时可手动填写"
                      >
                        <InputNumber
                          min={0}
                          step={1000}
                          precision={0}
                          style={{ width: "100%" }}
                          addonAfter="tokens"
                          placeholder="自动检测"
                        />
                      </Form.Item>
                    </div>
                    <SettingsActions dirty={dirty} onReset={handleReset} />
                  </section>
                ),
              },
              {
                key: "imagegen",
                label: tabLabel(SETTINGS_TABS[1]),
                forceRender: true,
                children: (
                  <section className="settings-panel">
                    <SectionHeader
                      icon={<PictureOutlined />}
                      title="生图偏好"
                      description="生图任务的传输模式，以及素材库与历史记录的缩略图尺寸。"
                    />
                    <Form.Item
                      label="生图调用模式"
                      name="image_gen_adapter"
                      help="任务模式：后端异步任务接口，支持断线恢复；直连模式：标准 OpenAI 兼容 /images/generations，不支持后台恢复"
                    >
                      <Segmented
                        block
                        options={[
                          { label: "任务模式", value: "task" },
                          { label: "直连模式", value: "direct" },
                        ]}
                      />
                    </Form.Item>
                    <div className="settings-field-narrow">
                      <Form.Item label="缩略图尺寸" name="thumb_size" help="素材库和历史记录的缩略图边长">
                        <InputNumber min={64} max={512} style={{ width: "100%" }} addonAfter="px" />
                      </Form.Item>
                    </div>
                    <SettingsActions dirty={dirty} onReset={handleReset} />
                  </section>
                ),
              },
              {
                key: "prompts",
                label: tabLabel(SETTINGS_TABS[2]),
                forceRender: true,
                children: (
                  <section className="settings-panel">
                    <SectionHeader
                      icon={<FileTextOutlined />}
                      title="提示词模板"
                      description="生成时自动插入到用户提示词前。留空使用默认模板。"
                    />
                    <Form.Item
                      label={
                        <span className="settings-label-row">
                          绿幕模式提示词
                          <button
                            type="button"
                            className="settings-label-action"
                            onClick={() => restorePromptDefault("greenscreen_prompt")}
                          >
                            恢复默认
                          </button>
                        </span>
                      }
                      name="greenscreen_prompt"
                      help="要求纯绿背景、无光影与反差"
                    >
                      <TextArea rows={3} style={{ resize: "vertical" }} placeholder={DEFAULT_GREENSCREEN_PROMPT} />
                    </Form.Item>
                    <Form.Item
                      label={
                        <span className="settings-label-row">
                          序列帧模式提示词
                          <button
                            type="button"
                            className="settings-label-action"
                            onClick={() => restorePromptDefault("spritesheet_prompt")}
                          >
                            恢复默认
                          </button>
                        </span>
                      }
                      name="spritesheet_prompt"
                      help="要求输出 NxN 网格序列帧图集"
                    >
                      <TextArea rows={5} style={{ resize: "vertical" }} placeholder={DEFAULT_SPRITESHEET_PROMPT} />
                    </Form.Item>
                    <SettingsActions dirty={dirty} onReset={handleReset} />
                  </section>
                ),
              },
              {
                key: "routing",
                label: tabLabel(SETTINGS_TABS[3]),
                children: <NovelModelRoutingSettings />,
              },
            ]}
          />
        </div>
      </Form>
    </div>
  );
}
