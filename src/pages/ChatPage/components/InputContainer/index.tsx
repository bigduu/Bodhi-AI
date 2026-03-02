import React, {
  useMemo,
  useEffect,
  lazy,
  Suspense,
  useRef,
  useCallback,
} from "react";
import { App as AntApp, Space, theme, Tag, Alert, Spin } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { ToolOutlined, RobotOutlined, SettingOutlined } from "@ant-design/icons";
import { MessageInput } from "../MessageInput";
import InputPreview from "./InputPreview";
import { useMessageStreaming } from "../../hooks/useChatManager/useMessageStreaming";
import { selectChatById, useAppStore } from "../../store";
import { useSystemPrompt } from "../../hooks/useSystemPrompt";
import { useChatInputHistory } from "../../hooks/useChatInputHistory";
import { useInputContainerCommand } from "./useInputContainerCommand";
import { useInputContainerFileReferences } from "./useInputContainerFileReferences";
import { useInputContainerAttachments } from "./useInputContainerAttachments";
import { useInputContainerSubmit } from "./useInputContainerSubmit";
import { useInputContainerHistory } from "./useInputContainerHistory";
import { getInputContainerPlaceholder } from "./inputContainerPlaceholder";
import { useActiveModel } from "../../hooks/useActiveModel";
import { useSettingsViewStore } from "@shared/store/settingsViewStore";

const FilePreview = lazy(() => import("../FilePreview"));
const CommandSelector = lazy(() => import("../CommandSelector"));
const WorkspacePathModal = lazy(() => import("../WorkspacePathModal"));
const FileReferenceSelector = lazy(() => import("../FileReferenceSelector"));

const { useToken } = theme;
const CHAT_SEND_MESSAGE_EVENT = "chat-send-message";

type ChatSendMessageEventDetail = {
  content: string;
  chatId?: string | null;
  handled?: boolean;
  resolve?: () => void;
  reject?: (error: unknown) => void;
};

export type WorkflowDraft = {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  type?: "workflow" | "skill" | "mcp"; // Add command type
  displayName?: string; // Add display name for better prompts
  category?: string; // Add category for skills
};

interface InputContainerProps {
  chatId?: string | null;
  isCenteredLayout?: boolean;
  onWorkflowDraftChange?: (workflow: WorkflowDraft | null) => void;
}

export const InputContainer: React.FC<InputContainerProps> = ({
  chatId: chatIdProp,
  isCenteredLayout = false,
  onWorkflowDraftChange,
}) => {
  const textAreaRef = useRef<TextAreaRef>(null); // Add ref for cursor position
  const { token } = useToken();
  const openSettings = useSettingsViewStore((state) => state.open);
  const chatId = useAppStore((state) => chatIdProp ?? state.currentChatId);
  const activeChatId = useAppStore((state) => state.currentChatId);
  const currentChat = useAppStore(selectChatById(chatId));
  const currentMessages = currentChat?.messages || [];
  const addMessage = useAppStore((state) => state.addMessage);
  const updateChat = useAppStore((state) => state.updateChat);
  const deleteMessage = useAppStore((state) => state.deleteMessage);
  const processingChats = useAppStore((state) => state.processingChats);
  const setChatProcessing = useAppStore((state) => state.setChatProcessing);
  const activeModel = useActiveModel();

  // Get input state from Zustand slice (persisted per session)
  const inputState = useAppStore((state) =>
    chatId ? state.inputStates[chatId] : undefined,
  );
  const setInputContent = useAppStore((state) => state.setInputContent);
  const setReferenceText = useAppStore((state) => state.setReferenceText);

  // Use persisted state or empty defaults
  const content = inputState?.content || "";
  const referenceText = inputState?.referenceText || null;
  const setContent = useCallback(
    (newContent: string) => {
      if (chatId) {
        setInputContent(chatId, newContent);
      }
    },
    [chatId, setInputContent],
  );
  const setReferenceTextPersisted = useCallback(
    (newRefText: string | null) => {
      if (chatId) {
        setReferenceText(chatId, newRefText);
      }
    },
    [chatId, setReferenceText],
  );

  const isProcessing = chatId
    ? processingChats.has(chatId)
    : false;

  const {
    sendMessage,
    cancel: cancelMessage,
    agentAvailable,
  } = useMessageStreaming({
    chatId,
    addMessage,
    setChatProcessing,
    updateChat,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleExternalSend = (event: Event) => {
      const customEvent = event as CustomEvent<ChatSendMessageEventDetail>;
      if (!customEvent.detail) {
        return;
      }

      // If a target chatId is provided, only the matching pane should handle it.
      // Otherwise, default to the globally active chat to avoid sending from all panes.
      const targetChatId =
        typeof customEvent.detail.chatId === "string"
          ? customEvent.detail.chatId
          : null;
      const shouldHandle = targetChatId
        ? chatId === targetChatId
        : chatId !== null && chatId === activeChatId;
      if (!shouldHandle) {
        return;
      }

      customEvent.detail.handled = true;
      const contentValue = customEvent.detail?.content;

      if (
        typeof contentValue !== "string" ||
        contentValue.trim().length === 0
      ) {
        customEvent.detail?.reject?.(
          new Error("External send message content is empty"),
        );
        return;
      }

      sendMessage(contentValue)
        .then(() => {
          customEvent.detail?.resolve?.();
        })
        .catch((error: unknown) => {
          customEvent.detail?.reject?.(error);
        });
    };

    window.addEventListener(
      CHAT_SEND_MESSAGE_EVENT,
      handleExternalSend as EventListener,
    );

    return () => {
      window.removeEventListener(
        CHAT_SEND_MESSAGE_EVENT,
        handleExternalSend as EventListener,
      );
    };
  }, [activeChatId, chatId, sendMessage]);

  const isStreaming = isProcessing;
  // Use the global Ant App context message API to avoid mounting a per-pane
  // rc-notification container (which can cause update-depth loops in some layouts).
  const { message: messageApi } = AntApp.useApp();

  const systemPromptId = currentChat?.config.systemPromptId || null;
  useSystemPrompt(systemPromptId);

  const isToolSpecificMode = false;
  const isRestrictConversation = false;
  const allowedTools: string[] = [];
  const autoToolPrefix = undefined;

  const { recordEntry, navigate, acknowledgeManualInput } =
    useChatInputHistory(chatId);

  const {
    attachments,
    setAttachments,
    handleAttachmentsAdded,
    handleAttachmentRemove,
    handleClearAttachments,
  } = useInputContainerAttachments();

  const commandState = useInputContainerCommand({
    setContent,
    onWorkflowDraftChange,
    acknowledgeManualInput,
    currentChatId: chatId,
    textAreaRef,
    content,
  });

  const fileReferenceState = useInputContainerFileReferences({
    content,
    setContent,
    currentChatId: chatId,
    currentChat,
    updateChat,
    messageApi,
  });

  const { setShowFileSelector } = fileReferenceState;

  useEffect(() => {
    if (commandState.showCommandSelector) {
      setShowFileSelector(false);
    }
  }, [commandState.showCommandSelector, setShowFileSelector]);

  const { handleSubmit } = useInputContainerSubmit({
    attachments,
    selectedWorkflow: commandState.selectedCommand,
    matchesWorkflowToken: commandState.matchesCommandToken,
    fileReferences: fileReferenceState.fileReferences,
    sendMessage,
    recordEntry,
    clearWorkflowDraft: commandState.clearCommandDraft,
    setContent,
    setReferenceText: setReferenceTextPersisted,
    setAttachments,
    setFileReferences: fileReferenceState.setFileReferences,
  });

  const { retryLastMessage, handleHistoryNavigate } = useInputContainerHistory({
    currentChatId: chatId,
    currentChat,
    currentMessages,
    deleteMessage,
    sendMessage,
    navigate,
  });

  // Agent status indicator config
  const agentStatusConfig = useMemo(() => {
    if (!activeModel) {
      return {
        color: "warning",
        icon: <RobotOutlined />,
        text: "No Model Selected",
        actionable: true,
      };
    }
    if (agentAvailable === null) {
      return { color: "default", icon: <RobotOutlined />, text: "Checking...", actionable: false };
    }
    if (agentAvailable) {
      return { color: "success", icon: <RobotOutlined />, text: "Agent Mode", actionable: false };
    }
    return { color: "red", icon: <RobotOutlined />, text: "Agent Unavailable", actionable: false };
  }, [activeModel, agentAvailable]);

  // Handle clicking on model status to open settings
  const handleModelStatusClick = useCallback(() => {
    if (!activeModel) {
      openSettings("chat");
    }
  }, [activeModel, openSettings]);

  const handleCloseReferencePreview = () => setReferenceTextPersisted(null);

  const placeholder = useMemo(() => {
    return getInputContainerPlaceholder({
      referenceText,
      isToolSpecificMode,
      isRestrictConversation,
      allowedTools,
      autoToolPrefix,
    });
  }, [
    referenceText,
    isToolSpecificMode,
    isRestrictConversation,
    allowedTools,
    autoToolPrefix,
  ]);

  return (
    <div
      style={{
        // Keep the input area compact; the inner MessageInput already enforces a sensible min-height.
        padding: `${token.paddingXXS}px ${token.paddingSM}px`,
        background: token.colorBgContainer,
        borderTop: isCenteredLayout
          ? "none"
          : `1px solid ${token.colorBorderSecondary}`,
        boxShadow: isCenteredLayout ? "none" : "0 -2px 8px rgba(0,0,0,0.06)",
        width: "100%",
        position: "relative",
        overflow: "visible",
      }}
    >
      {/* Model Configuration Alert */}
      {!activeModel && (
        <Alert
          type="warning"
          showIcon
          icon={<SettingOutlined />}
          message="No model configured"
          description="Please configure a model in Settings to start chatting."
          action={
            <Space>
              <a onClick={() => openSettings("chat")}>Open Settings</a>
            </Space>
          }
          style={{ marginBottom: token.marginSM }}
        />
      )}

      {isToolSpecificMode && (
        <Alert
          type={isRestrictConversation ? "warning" : "info"}
          showIcon
          style={{ marginBottom: token.marginSM }}
          message={
            <Space wrap>
              <span>
                {isRestrictConversation
                  ? "Strict Mode: Tool calls only"
                  : "Tool-specific Mode"}
              </span>
              {autoToolPrefix && (
                <Tag color="blue">
                  <ToolOutlined /> Auto-prefix: {autoToolPrefix}
                </Tag>
              )}
            </Space>
          }
          description={
            allowedTools.length > 0 && (
              <Space wrap>
                <span>Allowed tools:</span>
                {allowedTools.map((tool: string) => (
                  <Tag key={tool} color="green">
                    /{tool}
                  </Tag>
                ))}
              </Space>
            )
          }
        />
      )}

      {referenceText && (
        <InputPreview
          text={referenceText}
          onClose={handleCloseReferencePreview}
        />
      )}
      {attachments.length > 0 && (
        <Suspense fallback={<Spin size="small" />}>
          <FilePreview
            files={attachments}
            onRemove={handleAttachmentRemove}
            onClear={handleClearAttachments}
          />
        </Suspense>
      )}
      <MessageInput
        value={content}
        onChange={commandState.handleInputChange}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        allowImages={true}
        disabled={!activeModel}
        statusIndicator={
          <Tag
            color={agentStatusConfig.color}
            icon={agentStatusConfig.icon}
            style={{
              fontSize: "11px",
              cursor: agentStatusConfig.actionable ? "pointer" : "default",
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={agentStatusConfig.text}
            onClick={handleModelStatusClick}
          >
            {agentStatusConfig.text}
          </Tag>
        }
        isWorkflowSelectorVisible={commandState.showCommandSelector}
        textAreaRef={textAreaRef}
        validateMessage={(message) => {
          if (isRestrictConversation && autoToolPrefix) {
            const trimmed = message.trim();
            if (!trimmed.startsWith(autoToolPrefix)) {
              return {
                isValid: false,
                errorMessage: `Messages must start with '${autoToolPrefix}'.`,
              };
            }
          }
          return { isValid: true };
        }}
        onAttachmentsAdded={handleAttachmentsAdded}
        onWorkflowCommandChange={commandState.handleCommandChange}
        onFileReferenceChange={fileReferenceState.handleFileReferenceChange}
        onFileReferenceButtonClick={
          fileReferenceState.handleFileReferenceButtonClick
        }
        maxCharCount={8000}
        interaction={{
          isStreaming,
          hasMessages: currentMessages.length > 0,
          allowRetry: true,
          onRetry: retryLastMessage,
          onCancel: cancelMessage,
          onHistoryNavigate: handleHistoryNavigate,
        }}
      />

      <Suspense fallback={null}>
        <CommandSelector
          visible={commandState.showCommandSelector}
          onSelect={commandState.handleCommandSelect}
          onCancel={commandState.handleCommandSelectorCancel}
          onAutoComplete={commandState.handleAutoComplete}
          searchText={commandState.commandSearchText}
        />
      </Suspense>

      {fileReferenceState.showFileSelector && (
        <Suspense fallback={<Spin size="small" />}>
          <FileReferenceSelector
            visible={fileReferenceState.showFileSelector}
            files={fileReferenceState.workspaceFiles}
            searchText={fileReferenceState.fileSearchText}
            loading={fileReferenceState.isWorkspaceLoading}
            error={fileReferenceState.workspaceError}
            onSelect={fileReferenceState.handleFileReferenceSelect}
            onCancel={fileReferenceState.handleFileSelectorCancel}
            onChangeWorkspace={() => {
              fileReferenceState.setWorkspacePathInput(
                currentChat?.config.workspacePath ?? "",
              );
              fileReferenceState.setIsWorkspaceModalVisible(true);
            }}
          />
        </Suspense>
      )}

      <Suspense fallback={null}>
        <WorkspacePathModal
          open={fileReferenceState.isWorkspaceModalVisible}
          initialPath={fileReferenceState.workspacePathInput}
          loading={fileReferenceState.isSavingWorkspace}
          onSubmit={fileReferenceState.handleWorkspaceModalSubmit}
          onCancel={fileReferenceState.handleWorkspaceModalCancel}
        />
      </Suspense>
    </div>
  );
};

export default InputContainer;
