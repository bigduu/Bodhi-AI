import React, { memo } from "react";
import { Space, Typography, Button, Alert, Tag } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import {
  isAssistantToolCallMessage,
  isAssistantToolResultMessage,
  isWorkflowResultMessage,
  type Message,
} from "../../types/chat";
import ToolResultCard from "../ToolResultCard";
import ToolCallCard from "../ToolCallCard";
import WorkflowResultCard from "../WorkflowResultCard";
import { parseMcpToolAlias } from "../../utils/mcpAlias";

const { Text } = Typography;

type SelectionHint =
  | { type: "mcp"; label: string; serverId?: string; toolName?: string }
  | { type: "skill"; label: string; category?: string };

const extractSelectionHints = (
  input: string,
): { cleanText: string; hints: SelectionHint[] } => {
  if (!input) return { cleanText: input, hints: [] };

  const lines = input.split("\n");
  const hints: SelectionHint[] = [];
  const keptLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const mcpMatch = line.match(
      /^\[User explicitly selected MCP tool:\s*(.+?)\s*\]$/,
    );
    if (mcpMatch) {
      const label = mcpMatch[1] ?? "";
      const parsed = parseMcpToolAlias(label);
      hints.push({
        type: "mcp",
        label,
        serverId: parsed?.serverId,
        toolName: parsed?.toolName,
      });
      continue;
    }

    const skillMatch = line.match(
      /^\[User explicitly selected skill:\s*(.+?)\s*\]$/,
    );
    if (skillMatch) {
      const label = skillMatch[1] ?? "";
      const categoryMatch = label.match(/\(Category:\s*(.+?)\s*\)\s*$/);
      const category = categoryMatch?.[1];
      hints.push({
        type: "skill",
        label,
        category,
      });
      continue;
    }

    keptLines.push(rawLine);
  }

  const cleanText = keptLines.join("\n").trimStart();
  return { cleanText, hints };
};

interface MessageCardContentProps {
  message: Message;
  messageText: string;
  isUserToolCall: boolean;
  formatUserToolCall: (toolCall: string) => string;
  markdownComponents: Components;
  markdownPlugins: PluggableList;
  rehypePlugins: PluggableList;
}

const MessageCardContent: React.FC<MessageCardContentProps> = ({
  message,
  messageText,
  isUserToolCall,
  formatUserToolCall,
  markdownComponents,
  markdownPlugins,
  rehypePlugins,
}) => {
  if (isAssistantToolResultMessage(message)) {
    const toolResultContent = message.result.result ?? "";
    const toolResultErrorMessage = message.isError
      ? toolResultContent || "Tool execution failed."
      : undefined;
    const toolResultIsLoading =
      !toolResultErrorMessage && toolResultContent.trim().length === 0;

    if (message.result.display_preference === "Hidden") {
      return null;
    }

    return (
      <ToolResultCard
        content={toolResultContent}
        toolName={message.toolName}
        status={
          message.isError
            ? "error"
            : toolResultIsLoading
              ? "warning"
              : "success"
        }
        timestamp={message.createdAt}
        defaultCollapsed={true}
        isLoading={toolResultIsLoading}
        errorMessage={toolResultErrorMessage}
      />
    );
  }

  if (isWorkflowResultMessage(message)) {
    const workflowContent = message.content ?? "";
    const workflowErrorMessage =
      message.status === "error"
        ? workflowContent || "Workflow execution failed."
        : undefined;
    const workflowIsLoading =
      !workflowErrorMessage && workflowContent.trim().length === 0;

    return (
      <WorkflowResultCard
        content={workflowContent}
        workflowName={message.workflowName}
        parameters={message.parameters}
        status={workflowIsLoading ? "warning" : (message.status ?? "success")}
        timestamp={message.createdAt}
        isLoading={workflowIsLoading}
        errorMessage={workflowErrorMessage}
      />
    );
  }

  if (isAssistantToolCallMessage(message)) {
    return (
      <Space direction="vertical" style={{ width: "100%" }}>
        {message.toolCalls.map((call) => (
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
    );
  }

  if (message.role === "assistant" && !messageText) {
    return <Text italic>Assistant is thinking...</Text>;
  }

  // Check if this is an authentication error message
  if (message.isAuthError) {
    return (
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Alert
          message="Authentication Required"
          description={
            <ReactMarkdown
              remarkPlugins={markdownPlugins}
              rehypePlugins={rehypePlugins}
              components={markdownComponents}
            >
              {messageText}
            </ReactMarkdown>
          }
          type="error"
          showIcon
        />
        <Button
          type="primary"
          icon={<SettingOutlined />}
          onClick={() => {
            // Navigate to settings - assuming there's a way to do this
            // In Tauri/Electron, we might need to use IPC to switch tabs
            window.location.hash = "/settings";
          }}
        >
          Go to Settings
        </Button>
      </Space>
    );
  }

  const { cleanText, hints } =
    message.role === "user"
      ? extractSelectionHints(messageText)
      : { cleanText: messageText, hints: [] };

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="small">
      {hints.map((hint, idx) => {
        if (hint.type === "mcp") {
          return (
            <Alert
              key={`hint-mcp-${idx}`}
              type="info"
              showIcon={false}
              message={
                <Space wrap size="small">
                  <Tag color="purple">MCP</Tag>
                  <Text strong>Selected tool</Text>
                  {hint.serverId && (
                    <Text type="secondary">
                      <Text code>{hint.serverId}</Text>
                    </Text>
                  )}
                  {hint.toolName && (
                    <Text type="secondary">
                      <Text code>{hint.toolName}</Text>
                    </Text>
                  )}
                </Space>
              }
              style={{ marginBottom: 0 }}
            />
          );
        }

        return (
          <Alert
            key={`hint-skill-${idx}`}
            type="success"
            showIcon={false}
            message={
              <Space wrap size="small">
                <Tag color="green">Skill</Tag>
                <Text strong>Selected</Text>
                {hint.category && (
                  <Text type="secondary">
                    <Text code>{hint.category}</Text>
                  </Text>
                )}
              </Space>
            }
            style={{ marginBottom: 0 }}
          />
        );
      })}

      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {isUserToolCall ? formatUserToolCall(cleanText) : cleanText}
      </ReactMarkdown>
    </Space>
  );
};

export default memo(MessageCardContent);
