import React, { memo, useMemo, useState } from "react";
import {
  Collapse,
  Space,
  Typography,
  theme,
  Badge,
  CollapseProps,
  Tag,
} from "antd";
import type { GlobalToken } from "antd/es/theme/interface";
import {
  ToolOutlined,
  DownOutlined,
  RightOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import ToolCallCard from "../ToolCallCard";
import ToolResultCard from "../ToolResultCard";
import type {
  AssistantToolCallMessage,
  AssistantToolResultMessage,
} from "../../types/chat";
import { parseMcpToolAlias } from "../../utils/mcpAlias";

const { Text } = Typography;

export interface ToolSessionItem {
  call: AssistantToolCallMessage;
  result?: AssistantToolResultMessage;
}

export interface ToolSessionCardProps {
  tools: ToolSessionItem[];
  sessionId: string;
  createdAt: string;
  defaultExpanded?: boolean;
}

interface ToolItemStatus {
  icon: React.ReactNode;
  color: string;
  text: string;
}

function getToolStatus(
  item: ToolSessionItem,
  token: GlobalToken,
): ToolItemStatus {
  if (!item.result) {
    return {
      icon: <LoadingOutlined spin style={{ color: token.colorPrimary }} />,
      color: token.colorPrimary,
      text: "Running",
    };
  }

  if (item.result.isError) {
    return {
      icon: <ExclamationCircleOutlined style={{ color: token.colorError }} />,
      color: token.colorError,
      text: "Error",
    };
  }

  return {
    icon: <CheckCircleOutlined style={{ color: token.colorSuccess }} />,
    color: token.colorSuccess,
    text: "Done",
  };
}

function generateToolIntent(
  toolName: string,
  params: Record<string, any>,
): string {
  const mcpParts = parseMcpToolAlias(toolName);
  if (mcpParts) {
    return `MCP ${mcpParts.serverId}: ${mcpParts.toolName}`;
  }

  const truncate = (value: unknown, maxLen: number) => {
    const str = typeof value === "string" ? value : String(value ?? "");
    if (!str || str.length <= maxLen) return str;
    return str.substring(0, maxLen).trimEnd() + "…";
  };

  const nameMap: Record<string, (p: typeof params) => string> = {
    file_read: (p) =>
      `Reading: ${truncate(p.path || p.file_path || "unknown", 35)}`,
    file_write: (p) =>
      `Writing: ${truncate(p.path || p.file_path || "unknown", 35)}`,
    file_edit: (p) =>
      `Editing: ${truncate(p.path || p.file_path || "unknown", 35)}`,
    bash: (p) => `Executing: ${truncate(p.command, 35)}`,
    grep: (p) => `Searching: "${truncate(p.pattern, 25)}"`,
    glob: (p) => `Finding: "${p.pattern}"`,
    read: (p) => `Reading: ${p.file_path || "file"}`,
    write: (p) => `Writing: ${p.file_path || "file"}`,
    edit: (p) => `Editing: ${p.file_path || "file"}`,
    search: (p) => `Searching: "${truncate(p.query || p.pattern, 25)}"`,
    default: () => `${toolName}`,
  };

  const generator = nameMap[toolName] || nameMap["default"];
  return generator(params);
}

const ToolSessionCardComponent: React.FC<ToolSessionCardProps> = ({
  tools,
  defaultExpanded = false,
}) => {
  const { token } = theme.useToken();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => {
    // Expand the last tool by default if there's a pending one
    const pendingTool = tools.find((t) => !t.result);
    if (pendingTool) {
      return new Set([pendingTool.call.id]);
    }
    return new Set();
  });

  const { completedCount, pendingCount, hasErrors } = useMemo(() => {
    let completed = 0;
    let pending = 0;
    let errors = false;

    tools.forEach((item) => {
      if (item.result) {
        completed++;
        if (item.result.isError) {
          errors = true;
        }
      } else {
        pending++;
      }
    });

    return {
      completedCount: completed,
      pendingCount: pending,
      hasErrors: errors,
    };
  }, [tools]);

  const sessionStatus = useMemo(() => {
    if (pendingCount > 0) {
      return {
        color: "processing" as const,
        text: `${completedCount}/${tools.length} completed`,
      };
    }
    if (hasErrors) {
      return {
        color: "warning" as const,
        text: `${completedCount} completed with errors`,
      };
    }
    return {
      color: "success" as const,
      text: `${completedCount} completed`,
    };
  }, [completedCount, pendingCount, hasErrors, tools.length]);

  const collapseItems: CollapseProps["items"] = useMemo(() => {
    return tools
      .map((item, index) => {
        const toolCall = item.call.toolCalls[0];
        if (!toolCall) return null;

        const status = getToolStatus(item, token);
        const intent = generateToolIntent(
          toolCall.toolName,
          toolCall.parameters,
        );
        const mcpParts = parseMcpToolAlias(toolCall.toolName);

        return {
          key: item.call.id,
          label: (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: token.marginSM,
                width: "100%",
              }}
            >
              <span
                style={{
                  fontSize: token.fontSizeSM,
                  color: token.colorTextTertiary,
                  minWidth: 20,
                }}
              >
                {index + 1}.
              </span>
              <span style={{ flexShrink: 0 }}>{status.icon}</span>
              {mcpParts ? (
                <Space size="small" wrap={false}>
                  <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                    MCP
                  </Tag>
                  <Text strong style={{ fontSize: token.fontSizeSM }}>
                    {mcpParts.toolName}
                  </Text>
                  <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    <Text code style={{ fontSize: token.fontSizeSM }}>
                      {mcpParts.serverId}
                    </Text>
                  </Text>
                </Space>
              ) : (
                <Text
                  strong
                  style={{ fontSize: token.fontSizeSM, flexShrink: 0 }}
                >
                  {toolCall.toolName}
                </Text>
              )}
              <Text
                type="secondary"
                ellipsis
                style={{ flex: 1, minWidth: 0, fontSize: token.fontSizeSM }}
              >
                {intent}
              </Text>
            </div>
          ),
          children: (
            <Space
              direction="vertical"
              style={{ width: "100%" }}
              size={token.marginSM}
            >
              <ToolCallCard
                toolName={toolCall.toolName}
                parameters={toolCall.parameters}
                toolCallId={toolCall.toolCallId}
                streamingOutput={toolCall.streamingOutput}
                defaultExpanded={true}
              />
              {item.result &&
                item.result.result.display_preference !== "Hidden" && (
                  <ToolResultCard
                    content={item.result.result.result}
                    toolName={toolCall.toolName}
                    status={item.result.isError ? "error" : "success"}
                    timestamp={item.result.createdAt}
                    defaultCollapsed={false}
                  />
                )}
            </Space>
          ),
          style: {
            borderBottom:
              index < tools.length - 1
                ? `1px solid ${token.colorBorderSecondary}`
                : undefined,
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [tools, expandedTools, token]);

  return (
    <div
      style={{
        backgroundColor: token.colorBgElevated,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadiusLG,
        overflow: "hidden",
      }}
    >
      {/* Session Header */}
      <div
        style={{
          padding: `${token.paddingSM}px ${token.paddingMD}px`,
          backgroundColor: token.colorBgContainer,
          borderBottom: isExpanded
            ? `1px solid ${token.colorBorder}`
            : undefined,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: token.marginSM,
        }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <ToolOutlined style={{ color: token.colorPrimary }} />
        <Text strong style={{ flex: 1 }}>
          Tool Session
        </Text>
        <Badge
          count={tools.length}
          style={{ backgroundColor: token.colorPrimary }}
        />
        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {sessionStatus.text}
        </Text>
        <div style={{ marginLeft: token.marginXS }}>
          {isExpanded ? (
            <DownOutlined style={{ color: token.colorTextSecondary }} />
          ) : (
            <RightOutlined style={{ color: token.colorTextSecondary }} />
          )}
        </div>
      </div>

      {/* Tools List */}
      {isExpanded && (
        <div style={{ padding: token.paddingSM }}>
          <Collapse
            ghost
            activeKey={Array.from(expandedTools)}
            onChange={(keys) => {
              // keys 是 string | string[]
              const newExpandedKeys = new Set<string>(
                Array.isArray(keys) ? keys : keys ? [keys] : [],
              );
              setExpandedTools(newExpandedKeys);
            }}
            items={collapseItems}
          />
        </div>
      )}
    </div>
  );
};

export const ToolSessionCard = memo(ToolSessionCardComponent);
ToolSessionCard.displayName = "ToolSessionCard";

export default ToolSessionCard;
