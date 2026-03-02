import React, { useMemo } from "react";
import { Button, Card, Flex, Tag, Typography, theme } from "antd";

import { useAppStore } from "../../store";
import { openSession } from "../../utils/openSession";

const { Text } = Typography;
const { useToken } = theme;

export interface SubSessionsPanelProps {
  parentSessionId: string;
}

export const SubSessionsPanel: React.FC<SubSessionsPanelProps> = ({
  parentSessionId,
}) => {
  const { token } = useToken();

  const subSessionsByParent = useAppStore((s) => s.subSessionsByParent);
  const chats = useAppStore((s) => s.chats);
  const loadChatHistory = useAppStore((s) => s.loadChatHistory);
  const pinChat = useAppStore((s) => s.pinChat);
  const unpinChat = useAppStore((s) => s.unpinChat);

  // In-memory progress (lost on restart).
  const progressItems = useMemo(() => {
    const map = subSessionsByParent[parentSessionId] || {};
    return Object.entries(map).map(([childSessionId, v]) => ({
      childSessionId,
      ...v,
    }));
  }, [parentSessionId, subSessionsByParent]);

  // Persisted children (reconstructable after restart from backend index).
  const persistedChildren = useMemo(() => {
    return chats
      .filter((c) => c.kind === "child" && c.parentSessionId === parentSessionId)
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || "") || 0;
        const bTime = Date.parse(b.updatedAt || "") || 0;
        return bTime - aTime;
      });
  }, [chats, parentSessionId]);

  const mergedItems = useMemo(() => {
    const progressById = new Map(progressItems.map((x) => [x.childSessionId, x]));
    const out: Array<{
      childSessionId: string;
      title?: string;
      status?: string;
      error?: string;
      lastHeartbeatAt?: string;
      lastEventAt?: string;
      outputPreview?: string;
      pinned?: boolean;
      updatedAt?: string;
    }> = [];

    for (const child of persistedChildren) {
      const p = progressById.get(child.id);
      out.push({
        childSessionId: child.id,
        title: p?.title || child.title,
        status: p?.status,
        error: p?.error,
        lastHeartbeatAt: p?.lastHeartbeatAt,
        lastEventAt: p?.lastEventAt,
        outputPreview: p?.outputPreview,
        pinned: child.pinned,
        updatedAt: child.updatedAt,
      });
      progressById.delete(child.id);
    }

    // Include progress-only entries (rare; e.g. list hasn't refreshed yet).
    for (const p of progressById.values()) {
      out.push({
        childSessionId: p.childSessionId,
        title: p.title,
        status: p.status,
        error: p.error,
        lastHeartbeatAt: p.lastHeartbeatAt,
        lastEventAt: p.lastEventAt,
        outputPreview: p.outputPreview,
      });
    }

    return out;
  }, [persistedChildren, progressItems]);

  if (mergedItems.length === 0) return null;

  return (
    <Card
      size="small"
      style={{ marginBottom: token.marginMD }}
      title={<Text strong>Child Sessions</Text>}
    >
      <Flex vertical gap={token.marginSM}>
        {mergedItems.map((it) => (
          <Flex
            key={it.childSessionId}
            align="flex-start"
            justify="space-between"
            gap={token.marginSM}
            style={{
              padding: token.paddingSM,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
            }}
          >
            <Flex vertical style={{ flex: 1, minWidth: 0 }}>
              <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
                <Text strong ellipsis style={{ minWidth: 0 }}>
                  {it.title || "Child Session"}{" "}
                  <Text type="secondary">({it.childSessionId})</Text>
                </Text>
                <Tag
                  color="geekblue"
                  style={{ marginInlineEnd: 0, flex: "0 0 auto" }}
                >
                  Child
                </Tag>
                {it.pinned ? (
                  <Tag
                    color="gold"
                    style={{ marginInlineEnd: 0, flex: "0 0 auto" }}
                  >
                    Pinned
                  </Tag>
                ) : null}
              </Flex>

              <Text type="secondary">
                Status: {it.status || "unknown"}
                {it.updatedAt ? ` • updated: ${it.updatedAt}` : ""}
                {it.lastHeartbeatAt ? ` • heartbeat: ${it.lastHeartbeatAt}` : ""}
              </Text>

              {it.outputPreview ? (
                <Text style={{ marginTop: token.marginXS }} ellipsis>
                  {it.outputPreview}
                </Text>
              ) : null}

              {it.error ? (
                <Text type="danger" style={{ marginTop: token.marginXS }}>
                  {it.error}
                </Text>
              ) : null}
            </Flex>

            <Flex gap={8}>
              <Button
                size="small"
                onClick={() => {
                  openSession(it.childSessionId);
                  void loadChatHistory(it.childSessionId);
                }}
              >
                Open
              </Button>
              {typeof it.pinned === "boolean" ? (
                <Button
                  size="small"
                  onClick={() => {
                    if (it.pinned) unpinChat(it.childSessionId);
                    else pinChat(it.childSessionId);
                  }}
                >
                  {it.pinned ? "Unpin" : "Pin"}
                </Button>
              ) : null}
            </Flex>
          </Flex>
        ))}
      </Flex>
    </Card>
  );
};
