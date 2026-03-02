import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Switch,
  Table,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";

import { AgentClient, ScheduleEntry } from "../../../ChatPage/services/AgentService";
import { useSettingsViewStore } from "../../../../shared/store/settingsViewStore";
import { openSession } from "../../../ChatPage/utils/openSession";

const { Text } = Typography;

const agentClient = AgentClient.getInstance();

export default function SystemSettingsSchedulesTab() {
  const [msgApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [sessionsModal, setSessionsModal] = useState<{
    open: boolean;
    scheduleId: string | null;
    sessions: Array<{ id: string; title: string; updated_at: string }>;
    loading: boolean;
  }>({ open: false, scheduleId: null, sessions: [], loading: false });
  const [editModal, setEditModal] = useState<{
    open: boolean;
    schedule: ScheduleEntry | null;
    saving: boolean;
  }>({ open: false, schedule: null, saving: false });

  const closeSettings = useSettingsViewStore((s) => s.close);

  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const refresh = async () => {
    setLoading(true);
    try {
      const resp = await agentClient.listSchedules();
      setSchedules(resp.schedules || []);
    } catch (e) {
      console.error("[Schedules] Failed to load schedules:", e);
      msgApi.error("Failed to load schedules");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns: ColumnsType<ScheduleEntry> = useMemo(
    () => [
      { title: "Name", dataIndex: "name", key: "name" },
      {
        title: "Auto Execute",
        key: "auto_execute",
        render: (_, row) => (
          <Text type={row.run_config?.auto_execute ? undefined : "secondary"}>
            {row.run_config?.auto_execute ? "Yes" : "No"}
          </Text>
        ),
      },
      {
        title: "Model",
        key: "model",
        render: (_, row) => (
          <Text type="secondary">
            {row.run_config?.model ? String(row.run_config.model) : "-"}
          </Text>
        ),
      },
      {
        title: "Enabled",
        key: "enabled",
        render: (_, row) => (
          <Switch
            checked={row.enabled}
            onChange={async (checked) => {
              try {
                await agentClient.patchSchedule(row.id, { enabled: checked });
                await refresh();
              } catch (e) {
                console.error("[Schedules] Failed to toggle:", e);
                msgApi.error("Failed to update schedule");
              }
            }}
          />
        ),
      },
      {
        title: "Interval (s)",
        key: "interval_seconds",
        render: (_, row) => (
          <InputNumber
            min={1}
            value={row.interval_seconds}
            onChange={async (value) => {
              const next = typeof value === "number" ? value : null;
              if (!next || next <= 0) return;
              try {
                await agentClient.patchSchedule(row.id, {
                  interval_seconds: next,
                });
                await refresh();
              } catch (e) {
                console.error("[Schedules] Failed to patch interval:", e);
                msgApi.error("Failed to update schedule");
              }
            }}
          />
        ),
      },
      {
        title: "Next Run",
        dataIndex: "next_run_at",
        key: "next_run_at",
        render: (v) => <Text type="secondary">{String(v)}</Text>,
      },
      {
        title: "Last Run",
        dataIndex: "last_run_at",
        key: "last_run_at",
        render: (v) => <Text type="secondary">{v ? String(v) : "-"}</Text>,
      },
      {
        title: "Actions",
        key: "actions",
        render: (_, row) => (
          <Flex gap={8} wrap="wrap">
            <Button
              size="small"
              onClick={() => {
                setEditModal({ open: true, schedule: row, saving: false });
                editForm.setFieldsValue({
                  name: row.name,
                  enabled: row.enabled,
                  interval_seconds: row.interval_seconds,
                  system_prompt: row.run_config?.system_prompt || "",
                  task_message: row.run_config?.task_message || "",
                  model: row.run_config?.model || "",
                  workspace_path: row.run_config?.workspace_path || "",
                  enhance_prompt: row.run_config?.enhance_prompt || "",
                  auto_execute: Boolean(row.run_config?.auto_execute),
                });
              }}
            >
              Edit
            </Button>
            <Button
              size="small"
              onClick={async () => {
                try {
                  await agentClient.runScheduleNow(row.id);
                  msgApi.success("Enqueued run");
                  await refresh();
                } catch (e) {
                  console.error("[Schedules] Failed to run now:", e);
                  msgApi.error("Failed to run schedule");
                }
              }}
            >
              Run Now
            </Button>
            <Button
              size="small"
              onClick={async () => {
                setSessionsModal((s) => ({
                  ...s,
                  open: true,
                  scheduleId: row.id,
                  loading: true,
                  sessions: [],
                }));
                try {
                  const resp = await agentClient.listScheduleSessions(row.id);
                  setSessionsModal((s) => ({
                    ...s,
                    open: true,
                    scheduleId: row.id,
                    loading: false,
                    sessions: (resp.sessions || []).map((x) => ({
                      id: x.id,
                      title: x.title,
                      updated_at: x.updated_at,
                    })),
                  }));
                } catch (e) {
                  console.error("[Schedules] Failed to list sessions:", e);
                  msgApi.error("Failed to load schedule sessions");
                  setSessionsModal((s) => ({ ...s, loading: false }));
                }
              }}
            >
              Sessions
            </Button>
            <Button
              danger
              size="small"
              onClick={async () => {
                try {
                  await agentClient.deleteSchedule(row.id);
                  msgApi.success("Deleted schedule");
                  await refresh();
                } catch (e) {
                  console.error("[Schedules] Failed to delete:", e);
                  msgApi.error("Failed to delete schedule");
                }
              }}
            >
              Delete
            </Button>
          </Flex>
        ),
      },
    ],
    [msgApi],
  );

  return (
    <Flex vertical gap={16}>
      {contextHolder}

      <Card title="Create Schedule">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            name: "My Schedule",
            interval_seconds: 3600,
            enabled: false,
            task_message: "",
            model: "",
            auto_execute: true,
          }}
          onFinish={async (values) => {
            try {
              const autoExecute = Boolean(values.auto_execute);
              const taskMessage = String(values.task_message || "").trim();
              const model = String(values.model || "").trim();
              if (autoExecute && !taskMessage) {
                msgApi.error("Task message is required when Auto Execute is enabled");
                return;
              }
              await agentClient.createSchedule({
                name: String(values.name || "").trim(),
                interval_seconds: Number(values.interval_seconds || 0),
                enabled: Boolean(values.enabled),
                run_config: {
                  task_message: taskMessage || undefined,
                  model: model || undefined,
                  auto_execute: autoExecute,
                },
              });
              msgApi.success("Schedule created");
              form.resetFields();
              await refresh();
            } catch (e) {
              console.error("[Schedules] Failed to create schedule:", e);
              msgApi.error("Failed to create schedule");
            }
          }}
        >
          <Flex gap={12} wrap="wrap">
            <Form.Item
              label="Name"
              name="name"
              rules={[{ required: true, message: "Name is required" }]}
              style={{ flex: "1 1 280px" }}
            >
              <Input />
            </Form.Item>
            <Form.Item
              label="Interval Seconds"
              name="interval_seconds"
              rules={[{ required: true, message: "Interval is required" }]}
              style={{ width: 200 }}
            >
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="Enabled" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Flex>

          <Flex gap={12} wrap="wrap">
            <Form.Item
              label="Task Message"
              name="task_message"
              style={{ flex: "1 1 480px" }}
            >
              <Input.TextArea rows={3} placeholder="(Optional) A task to run" />
            </Form.Item>
            <Form.Item label="Model" name="model" style={{ width: 240 }}>
              <Input placeholder="(Optional) e.g. gpt-4o-mini" />
            </Form.Item>
            <Form.Item
              label="Auto Execute"
              name="auto_execute"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Flex>

          <Button type="primary" htmlType="submit">
            Create
          </Button>
        </Form>
      </Card>

      <Card
        title="Schedules"
        extra={
          <Button onClick={() => refresh()} loading={loading}>
            Refresh
          </Button>
        }
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={schedules}
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title="Schedule Sessions"
        open={sessionsModal.open}
        onCancel={() =>
          setSessionsModal((s) => ({ ...s, open: false, scheduleId: null }))
        }
        footer={null}
      >
        {sessionsModal.loading ? (
          <Text type="secondary">Loading...</Text>
        ) : (
          <Flex vertical gap={8}>
            {sessionsModal.sessions.length === 0 ? (
              <Text type="secondary">No sessions yet.</Text>
            ) : (
              sessionsModal.sessions.map((s) => (
                <Flex key={s.id} justify="space-between" align="center">
                  <Flex vertical style={{ minWidth: 0 }}>
                    <Text strong ellipsis>
                      {s.title}
                    </Text>
                    <Text type="secondary" ellipsis>
                      {s.id} • {s.updated_at}
                    </Text>
                  </Flex>
                  <Button
                    size="small"
                    onClick={() => {
                      // openSession will refresh backend sessions if needed and lazy-load history.
                      void openSession(s.id, {
                        forceRefreshIndex: true,
                        forceLoadHistory: true,
                        subscribeIfRunning: true,
                        forceSubscribe: true,
                      });
                      closeSettings();
                    }}
                  >
                    Open
                  </Button>
                </Flex>
              ))
            )}
          </Flex>
        )}
      </Modal>

      <Modal
        title="Edit Schedule"
        open={editModal.open}
        onCancel={() => setEditModal({ open: false, schedule: null, saving: false })}
        okText="Save"
        confirmLoading={editModal.saving}
        onOk={() => editForm.submit()}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={async (values) => {
            const schedule = editModal.schedule;
            if (!schedule) return;

            const autoExecute = Boolean(values.auto_execute);
            const taskMessage = String(values.task_message || "").trim();
            const model = String(values.model || "").trim();
            if (autoExecute && !taskMessage) {
              msgApi.error("Task message is required when Auto Execute is enabled");
              return;
            }
            setEditModal((s) => ({ ...s, saving: true }));
            try {
              await agentClient.patchSchedule(schedule.id, {
                name: String(values.name || "").trim() || undefined,
                enabled: Boolean(values.enabled),
                interval_seconds: Number(values.interval_seconds || 0) || undefined,
                run_config: {
                  system_prompt: String(values.system_prompt || "").trim() || undefined,
                  task_message: taskMessage || undefined,
                  model: model || undefined,
                  workspace_path: String(values.workspace_path || "").trim() || undefined,
                  enhance_prompt: String(values.enhance_prompt || "").trim() || undefined,
                  auto_execute: autoExecute,
                },
              });
              msgApi.success("Schedule updated");
              setEditModal({ open: false, schedule: null, saving: false });
              await refresh();
            } catch (e) {
              console.error("[Schedules] Failed to patch schedule:", e);
              msgApi.error("Failed to update schedule");
              setEditModal((s) => ({ ...s, saving: false }));
            }
          }}
        >
          <Flex gap={12} wrap="wrap">
            <Form.Item
              label="Name"
              name="name"
              rules={[{ required: true, message: "Name is required" }]}
              style={{ flex: "1 1 280px" }}
            >
              <Input />
            </Form.Item>
            <Form.Item
              label="Interval Seconds"
              name="interval_seconds"
              rules={[{ required: true, message: "Interval is required" }]}
              style={{ width: 220 }}
            >
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="Enabled" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Flex>

          <Form.Item label="System Prompt" name="system_prompt">
            <Input.TextArea rows={2} placeholder="(optional)" />
          </Form.Item>

          <Form.Item label="Task Message" name="task_message">
            <Input.TextArea rows={3} placeholder="(optional)" />
          </Form.Item>

          <Flex gap={12} wrap="wrap">
            <Form.Item label="Model" name="model" style={{ flex: "1 1 260px" }}>
              <Input placeholder="Required if auto execute" />
            </Form.Item>
            <Form.Item label="Auto Execute" name="auto_execute" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Flex>

          <Form.Item label="Workspace Path" name="workspace_path">
            <Input placeholder="(optional)" />
          </Form.Item>
          <Form.Item label="Enhance Prompt" name="enhance_prompt">
            <Input.TextArea rows={2} placeholder="(optional)" />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
