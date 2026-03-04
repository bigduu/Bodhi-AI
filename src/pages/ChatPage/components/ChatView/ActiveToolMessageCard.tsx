import React, { useEffect, useMemo, useState } from "react";
import { Card, Space, Typography, theme } from "antd";
import { ToolOutlined } from "@ant-design/icons";
import ToolCallCard from "../ToolCallCard";

const { Text } = Typography;

export type PendingToolCall = {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, any>;
  streamingOutput?: string;
};

type ActiveToolMessageCardProps = {
  pendingToolCalls: PendingToolCall[];
};

const EXIT_ANIMATION_MS = 220;

export const ActiveToolMessageCard: React.FC<ActiveToolMessageCardProps> = ({
  pendingToolCalls,
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
        bodyStyle={{ padding: token.paddingSM }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: token.marginSM,
            }}
          >
            <ToolOutlined style={{ color: token.colorPrimary }} />
            <Text strong>Tools running</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              ({normalizedCalls.length})
            </Text>
          </div>

          <Space direction="vertical" style={{ width: "100%" }} size="small">
            {normalizedCalls.map((call) => (
              <ToolCallCard
                key={call.toolCallId}
                toolName={call.toolName}
                parameters={call.parameters}
                toolCallId={call.toolCallId}
                streamingOutput={call.streamingOutput}
                defaultExpanded={false}
              />
            ))}
          </Space>
        </Space>
      </Card>
    </div>
  );
};

export default ActiveToolMessageCard;
