import { useState } from "react";
import { Alert, Button, Card, Collapse, Form, Input, Modal, Popconfirm, Space, Spin, Tag, message } from "antd";
import { CheckOutlined, PlusOutlined, ReadOutlined } from "@ant-design/icons";
import { useActivateStyleContract, useCreateStyleContract, useStyleContracts, type StyleContractView } from "../../lib/novelApi";

const DIMENSION_LABELS: Record<StyleContractView["payload"]["dimensions"] extends Partial<infer D> ? keyof D : never, string> = {
  pov: "POV 与叙述人称",
  narrationDistance: "叙述距离",
  timeMode: "时间方式",
  sentenceRhythm: "句式节奏",
  vocabularyLevel: "词汇层级",
  sensoryFocus: "感官重心",
  metaphorDensity: "比喻密度",
  dialogueRatio: "对白比例",
  restraintLevel: "留白程度",
  narrationAttitude: "叙述态度",
};

const DIMENSION_KEYS = Object.keys(DIMENSION_LABELS) as Array<keyof typeof DIMENSION_LABELS>;

function buildPayload(values: Record<string, string | undefined>, note: string): StyleContractView["payload"] {
  const dimensions: NonNullable<StyleContractView["payload"]["dimensions"]> = {};
  for (const key of DIMENSION_KEYS) {
    const value = values[key]?.trim();
    if (value) dimensions[key] = { value };
  }
  return { dimensions, note: note.trim() || undefined };
}

export default function StyleContractPanel({ projectId }: { projectId: string }) {
  const [form] = Form.useForm();
  const { data: contracts = [], isLoading, refetch } = useStyleContracts(projectId);
  const create = useCreateStyleContract(projectId);
  const activate = useActivateStyleContract(projectId);
  const [draftOpen, setDraftOpen] = useState(false);

  const active = contracts.find((contract) => contract.status === "active");

  async function submitDraft() {
    const values = await form.validateFields();
    const payload = buildPayload(values, values.note ?? "");
    try {
      await create.mutateAsync({ label: values.label, payload });
      message.success("已创建新版本文风契约草稿");
      setDraftOpen(false);
      form.resetFields();
      await refetch();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="nwc-panel" style={{ padding: 20 }}>
      <header className="nwc-section-head">
        <div><span className="nwc-kicker">文风契约</span><h2>书级叙述声音（可版本滑杆）</h2></div>
        <Space>
          <Button icon={<PlusOutlined />} type="primary" onClick={() => setDraftOpen(true)}>新建版本</Button>
        </Space>
      </header>
      <p className="nwc-muted" style={{ marginTop: -8 }}>
        文风契约是 draft / prose-review / revision 的叙述声音对照参考，不是逐章清单；滑杆取值不构成质量门。
      </p>
      <Alert
        style={{ marginTop: 12 }}
        type={active ? "success" : "warning"}
        showIcon
        message={active ? `当前生效：文风契约 v${active.version}「${active.label}」` : "尚未激活文风契约"}
        description={active ? (active.payload.note ?? "无适用范围说明") : "激活一个版本后，章节生成与文风审核会把该契约作为叙述声音基线注入。"}
      />
      {isLoading ? <Spin style={{ display: "block", margin: "32px auto" }} /> : (
        <Collapse style={{ marginTop: 16 }} defaultActiveKey={active?.id ? [active.id] : undefined}>
          {contracts.map((contract) => (
            <Collapse.Panel
              key={contract.id}
              header={
                <Space>
                  <ReadOutlined />
                  <strong>v{contract.version}：{contract.label}</strong>
                  {contract.status === "active" ? <Tag color="green">生效中</Tag> : <Tag>草稿</Tag>}
                  <span className="nwc-muted">指纹 {contract.fingerprint.slice(0, 10)}</span>
                </Space>
              }
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                {DIMENSION_KEYS.map((key) => {
                  const dimension = contract.payload.dimensions[key];
                  if (!dimension) return null;
                  return (
                    <Card key={key} size="small" title={DIMENSION_LABELS[key]}>
                      <div>{dimension.value}</div>
                      {dimension.note ? <div className="nwc-muted">{dimension.note}</div> : null}
                    </Card>
                  );
                })}
              </div>
              {contract.payload.note ? <Alert style={{ marginTop: 12 }} type="info" showIcon message="适用范围" description={contract.payload.note} /> : null}
              {contract.status !== "active" ? (
                <Popconfirm title="激活后，后续生成与文风审核将使用该版本" onConfirm={async () => {
                  try { await activate.mutateAsync(contract.id); message.success(`已激活 v${contract.version}`); await refetch(); }
                  catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
                }}>
                  <Button style={{ marginTop: 12 }} icon={<CheckOutlined />}>设为生效</Button>
                </Popconfirm>
              ) : null}
            </Collapse.Panel>
          ))}
        </Collapse>
      )}

      <Modal
        title="新建文风契约版本"
        open={draftOpen}
        onCancel={() => setDraftOpen(false)}
        onOk={() => void submitDraft()}
        confirmLoading={create.isPending}
        width={720}
        okText="创建草稿"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="label" label="契约名称" rules={[{ required: true, message: "请填写契约名称" }]}>
            <Input placeholder="如：卷一 冷峻限知 / 全卷 沉稳叙事" />
          </Form.Item>
          <Form.Item name="note" label="适用范围说明">
            <Input.TextArea rows={2} placeholder="说明该版本适用于哪些分卷/阶段、哪些内容不适用" />
          </Form.Item>
          <div className="nwc-kicker">十维滑杆（只填有把握的维度，缺失维度按未指定处理）</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            {DIMENSION_KEYS.map((key) => (
              <Form.Item key={key} name={key} label={DIMENSION_LABELS[key]}>
                <Input placeholder="取值或范围，如：贴近身体 / 短促 / 低" />
              </Form.Item>
            ))}
          </div>
        </Form>
      </Modal>
    </div>
  );
}
