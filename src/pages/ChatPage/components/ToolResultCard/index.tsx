import React, { memo, useMemo } from "react";
import {
  Alert,
  Button,
  Collapse,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import { RobotOutlined, CopyOutlined } from "@ant-design/icons";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  formatResultContent,
  createCompactPreview,
  getStatusColor,
  safeStringify,
} from "../../utils/resultFormatters";
import { ExecutionStatus } from "../../types/chat";
import { copyText } from "@shared/utils/clipboard";

const { Text } = Typography;

export interface ToolResultCardProps {
  content: string;
  toolName: string;
  status?: ExecutionStatus;
  timestamp?: string;
  defaultCollapsed?: boolean;
  isLoading?: boolean;
  errorMessage?: string;
}

const ToolResultCardComponent: React.FC<ToolResultCardProps> = ({
  content,
  toolName,
  status = "success",
  timestamp,
  defaultCollapsed = true,
  isLoading,
  errorMessage,
}) => {
  const { token } = theme.useToken();

  const formatted = useMemo(() => formatResultContent(content), [content]);

  const derivedIsLoading = useMemo(() => {
    if (typeof isLoading === "boolean") {
      return isLoading;
    }
    return formatted.formattedText.trim().length === 0;
  }, [formatted.formattedText, isLoading]);

  const preview = useMemo(
    () => createCompactPreview(formatted.formattedText),
    [formatted.formattedText],
  );

  const handleCopy = async () => {
    try {
      const textToCopy = formatted.isJson
        ? safeStringify(formatted.parsedJson)
        : formatted.formattedText;
      await copyText(textToCopy);
    } catch (error) {
      console.error("[ToolResultCard] Failed to copy result:", error);
    }
  };

  // Use stable key based on tool name and content hash for consistency
  const collapseKey = useMemo(() => {
    // Simple hash of content for stability
    const hash = content
      ? content.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "")
      : "empty";
    return `tool-result-${toolName}-${hash}`;
  }, [toolName, content]);

  return (
    <Collapse
      defaultActiveKey={defaultCollapsed ? [] : [collapseKey]}
      style={{
        backgroundColor: token.colorBgContainer,
        borderColor: token.colorBorderSecondary,
        borderWidth: 1,
        borderStyle: "solid",
        borderRadius: token.borderRadiusLG,
      }}
      items={[
        {
          key: collapseKey,
          label: (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: token.marginSM,
                width: "100%",
              }}
            >
              <RobotOutlined
                style={{ color: token.colorPrimary, flexShrink: 0 }}
              />
              <Text strong style={{ color: token.colorText, flexShrink: 0 }}>
                {toolName}
              </Text>
              <Text
                type="secondary"
                ellipsis
                style={{ flex: 1, minWidth: 0, fontSize: token.fontSizeSM }}
              >
                {derivedIsLoading ? "Waiting…" : preview}
              </Text>
              <Tag
                color={getStatusColor(status)}
                style={{ flexShrink: 0, margin: 0 }}
              >
                {status}
              </Tag>
            </div>
          ),
          children: (
            <Space
              direction="vertical"
              style={{ width: "100%" }}
              size={token.marginSM}
            >
              {/* Timestamp */}
              {timestamp && (
                <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  {new Date(timestamp).toLocaleString()}
                </Text>
              )}

              {/* Error Alert */}
              {errorMessage && (
                <Alert
                  type="error"
                  message="Tool execution failed"
                  description={errorMessage}
                  showIcon
                />
              )}

              {/* Content */}
              <div style={{ position: "relative" }}>
                <Tooltip title="Copy result">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    aria-label="Copy result"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy();
                    }}
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      zIndex: 1,
                    }}
                  />
                </Tooltip>

                {derivedIsLoading ? (
                  <Text type="secondary">Waiting for tool result...</Text>
                ) : formatted.isJson ? (
                  <SyntaxHighlighter
                    language="json"
                    style={oneDark}
                    wrapLongLines={true}
                    customStyle={{
                      margin: 0,
                      borderRadius: token.borderRadiusSM,
                      backgroundColor: token.colorBgContainer,
                      fontSize: token.fontSizeSM,
                      maxHeight: 400,
                      overflow: "auto",
                    }}
                    codeTagProps={{
                      style: {
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      },
                    }}
                  >
                    {formatted.formattedText}
                  </SyntaxHighlighter>
                ) : (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontSize: token.fontSizeSM,
                      backgroundColor: token.colorBgContainer,
                      padding: token.paddingSM,
                      borderRadius: token.borderRadiusSM,
                      margin: 0,
                      maxHeight: 400,
                      overflow: "auto",
                    }}
                  >
                    {formatted.formattedText}
                  </pre>
                )}
              </div>
            </Space>
          ),
        },
      ]}
    />
  );
};

export const ToolResultCard = memo(ToolResultCardComponent);
ToolResultCard.displayName = "ToolResultCard";

export default ToolResultCard;
