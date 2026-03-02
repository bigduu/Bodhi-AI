import { useMemo, useState } from "react";
import { App as AntApp } from "antd";
import { Button, Card, Flex, Switch, Typography } from "antd";

import { AgentClient } from "../../../ChatPage/services/AgentService";
import { useAppStore } from "../../../ChatPage/store";

const { Text } = Typography;

const agentClient = AgentClient.getInstance();

export default function SystemSettingsSessionsTab() {
  const { modal, message } = AntApp.useApp();

  const chats = useAppStore((s) => s.chats);
  const currentChatId = useAppStore((s) => s.currentChatId);
  const refreshChats = useAppStore((s) => s.refreshChats);
  const loadChats = useAppStore((s) => s.loadChats);
  const loadChatHistory = useAppStore((s) => s.loadChatHistory);

  const [keepPinned, setKeepPinned] = useState(true);
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => {
    if (!currentChatId) return null;
    return chats.find((c) => c.id === currentChatId) ?? null;
  }, [chats, currentChatId]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex vertical gap={16}>
      <Card size="small" title="Current Session">
        {current ? (
          <Flex vertical gap={4}>
            <Text strong ellipsis>
              {current.title}
            </Text>
            <Text type="secondary" ellipsis>
              id: {current.id}
              {"  "}•{"  "}kind: {current.kind}
            </Text>
            <Flex gap={8} wrap="wrap" style={{ marginTop: 8 }}>
              <Button
                danger
                loading={busy}
                onClick={() => {
                  modal.confirm({
                    title: "Clear Session Messages",
                    content:
                      "This clears messages/attachments for the current session but keeps the session entry.",
                    okText: "Clear",
                    okButtonProps: { danger: true },
                    cancelText: "Cancel",
                    onOk: async () => {
                      await run(async () => {
                        await agentClient.clearSession(current.id);
                        await loadChatHistory(current.id);
                        await refreshChats();
                        message.success("Session cleared");
                      });
                    },
                  });
                }}
              >
                Clear Messages
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Text type="secondary">No active session.</Text>
        )}
      </Card>

      <Card size="small" title="Bulk Cleanup">
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <Text>Keep pinned</Text>
          <Switch checked={keepPinned} onChange={setKeepPinned} />
        </Flex>

        <Flex gap={8} wrap="wrap">
          <Button
            danger
            loading={busy}
            onClick={() => {
              modal.confirm({
                title: "Delete All Sessions",
                content: keepPinned
                  ? "Deletes all sessions except pinned."
                  : "Deletes all sessions including pinned.",
                okText: "Delete",
                okButtonProps: { danger: true },
                cancelText: "Cancel",
                onOk: async () => {
                  await run(async () => {
                    await agentClient.cleanupSessions("all", keepPinned);
                    await loadChats();
                    message.success("Cleanup complete");
                  });
                },
              });
            }}
          >
            Delete All
          </Button>

          <Button
            danger
            loading={busy}
            onClick={() => {
              modal.confirm({
                title: "Delete Empty Sessions",
                content: keepPinned
                  ? "Deletes empty sessions except pinned."
                  : "Deletes empty sessions including pinned.",
                okText: "Delete",
                okButtonProps: { danger: true },
                cancelText: "Cancel",
                onOk: async () => {
                  await run(async () => {
                    await agentClient.cleanupSessions("empty", keepPinned);
                    await loadChats();
                    message.success("Cleanup complete");
                  });
                },
              });
            }}
          >
            Delete Empty
          </Button>

          <Button
            danger
            loading={busy}
            onClick={() => {
              modal.confirm({
                title: "Delete Child Sessions",
                content: keepPinned
                  ? "Deletes all child sessions except pinned."
                  : "Deletes all child sessions including pinned.",
                okText: "Delete",
                okButtonProps: { danger: true },
                cancelText: "Cancel",
                onOk: async () => {
                  await run(async () => {
                    await agentClient.cleanupSessions("children", keepPinned);
                    await loadChats();
                    message.success("Cleanup complete");
                  });
                },
              });
            }}
          >
            Delete Children
          </Button>
        </Flex>
      </Card>

      <Card size="small" title="Development Reset">
        <Text type="secondary">
          Greenfield reset for session storage (deletes sessions/ and resets sessions.json).
        </Text>
        <Flex style={{ marginTop: 12 }}>
          <Button
            danger
            type="primary"
            loading={busy}
            onClick={() => {
              modal.confirm({
                title: "Reset Session Storage (Dev)",
                content:
                  "This deletes ALL sessions (including pinned/child) and resets the sessions index. A new empty session will be created after refresh.",
                okText: "Reset",
                okButtonProps: { danger: true },
                cancelText: "Cancel",
                onOk: async () => {
                  await run(async () => {
                    await agentClient.devResetSessions();
                    await loadChats();
                    message.success("Session storage reset");
                  });
                },
              });
            }}
          >
            Dev Reset Sessions
          </Button>
        </Flex>
      </Card>
    </Flex>
  );
}
