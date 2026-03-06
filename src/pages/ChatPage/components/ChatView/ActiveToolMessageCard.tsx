import React, { useEffect, useMemo, useState } from "react";
import { Button, Card, Space, Typography, theme } from "antd";
import { ToolOutlined } from "@ant-design/icons";

const { Text } = Typography;

export type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, any>;
  streamingOutput?: string;
};

type ActiveToolMessageCardProps = {
  pendingToolCalls: PendingToolCall[];
  /**
   * Id of the active tool session entry in the message list.
   * Used to jump the user to the running tool output.
   */
  activeToolSessionId?: string | null;
};

const EXIT_ANIMATION_MS = 220;

export const ActiveToolMessageCard: React.FC<ActiveToolMessageCardProps> = ({
  pendingToolCalls,
  activeToolSessionId,
}) => {
  const { token } = theme.useToken();

  const normalizedCalls = useMemo(() => {
    // Ensure stable order + dedupe by toolCallId.
    const map = new Map<string, PendingToolCall>();
    for (const c of pendingToolCalls) map.set(c.toolCallId, c);
    return Array.from(map.values());
  }, [pendingToolCalls]);

  const hasPending = normalizedCalls.length > 0;

  // Presence/exit animation to avoid abrupt UI changes near the sticky input.
  const [shouldRender, setShouldRender] = useState(hasPending);
  const [isVisible, setIsVisible] = useState(hasPending);

  useEffect(() => {
    if (hasPending) {
      setShouldRender(true);
      // Next tick so CSS transition can kick in.
      const id = window.setTimeout(() => setIsVisible(true), 0);
      return () => window.clearTimeout(id);
    }

    setIsVisible(false);
    const id = window.setTimeout(
      () => setShouldRender(false),
      EXIT_ANIMATION_MS,
    );
    return () => window.clearTimeout(id);
  }, [hasPending]);

  if (!shouldRender) return null;

  const primaryToolName = normalizedCalls[0]?.toolName ?? "Tool";

  return (
    <div
      className={`active-tool-card-wrapper ${isVisible ? "visible" : ""}`}
      aria-hidden={!isVisible}
    >
      <Card
        size="small"
        style={{
          width: "100%",
          borderRadius: token.borderRadiusLG,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          boxShadow: token.boxShadowSecondary,
        }}
        bodyStyle={{ padding: `${token.paddingXS}px ${token.paddingSM}px` }}
      >
        <Space
          align="center"
          style={{ width: "100%", justifyContent: "space-between" }}
          size={token.marginSM}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: token.marginSM,
              minWidth: 0,
            }}
          >
            <ToolOutlined style={{ color: token.colorPrimary }} />
            <Text strong style={{ whiteSpace: "nowrap" }}>
              Tools running
            </Text>
            <Text
              type="secondary"
              style={{ fontSize: token.fontSizeSM, whiteSpace: "nowrap" }}
            >
              ({normalizedCalls.length})
            </Text>
            <Text
              type="secondary"
              ellipsis
              style={{
                fontSize: token.fontSizeSM,
                minWidth: 0,
                maxWidth: 520,
              }}
            >
              {primaryToolName}
            </Text>
          </div>

          <Button
            size="small"
            type="link"
            disabled={!activeToolSessionId}
            onClick={() => {
              if (!activeToolSessionId) return;
              window.dispatchEvent(
                new CustomEvent("navigate-to-message", {
                  detail: { messageId: activeToolSessionId },
                }),
              );
            }}
          >
            View output
          </Button>
        </Space>
      </Card>
    </div>
  );
};

export default ActiveToolMessageCard;
