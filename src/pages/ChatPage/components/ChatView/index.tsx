import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FloatButton, Grid, Layout, theme, Flex } from "antd";
import { DownOutlined, UpOutlined } from "@ant-design/icons";
import { useVirtualizer } from "@tanstack/react-virtual";

import { selectChatById, useAppStore } from "../../store";
import type { Message } from "../../types/chat";
import { ChatInputArea } from "./ChatInputArea";
import { ChatMessagesList } from "./ChatMessagesList";
import { TodoList } from "@components/TodoList";
import { QuestionDialog } from "@components/QuestionDialog";
import { TokenUsageDisplay } from "../TokenUsageDisplay";
import { SubSessionsPanel } from "./SubSessionsPanel";
import "./styles.css";
import { useChatViewScroll } from "./useChatViewScroll";
import type { WorkflowDraft } from "../InputContainer";
import {
  useChatViewMessages,
  type RenderableEntry,
} from "./useChatViewMessages";

const { useToken } = theme;
const { useBreakpoint } = Grid;

export type ChatViewProps = {
  /**
   * If omitted, falls back to the globally selected chat.
   * Multi-pane mode should always pass an explicit chatId.
   */
  chatId?: string | null;
  /**
   * When embedded in split panes, use full width and tighter spacing.
   */
  embedded?: boolean;
};

export const ChatView: React.FC<ChatViewProps> = ({
  chatId: chatIdProp,
  embedded = false,
}) => {
  const chatId = useAppStore((state) => chatIdProp ?? state.currentChatId);
  const currentChat = useAppStore(selectChatById(chatId));
  const deleteMessage = useAppStore((state) => state.deleteMessage);
  const loadChatHistory = useAppStore((state) => state.loadChatHistory);
  const processingChats = useAppStore((state) => state.processingChats);
  const tokenUsages = useAppStore((state) => state.tokenUsages);
  const truncationOccurred = useAppStore((state) => state.truncationOccurred);
  const segmentsRemoved = useAppStore((state) => state.segmentsRemoved);
  const currentMessages = useMemo(
    () => currentChat?.messages || [],
    [currentChat],
  );
  const hasTodoList = useAppStore((state) =>
    chatId ? Boolean(state.todoLists[chatId]) : false,
  );
  const hasSubSessions = useAppStore((state) => {
    if (!chatId) return false;
    const progressMap = state.subSessionsByParent[chatId];
    if (progressMap && Object.keys(progressMap).length > 0) return true;
    return state.chats.some(
      (c) => c.kind === "child" && c.parentSessionId === chatId,
    );
  });

  // Lazy-load history when switching sessions (backend is source of truth).
  useEffect(() => {
    if (!chatId) return;
    const chat = useAppStore.getState().chats.find((c) => c.id === chatId);
    if (chat && Array.isArray(chat.messages) && chat.messages.length > 0) {
      return;
    }
    void loadChatHistory(chatId);
  }, [chatId, loadChatHistory]);

  const isProcessing = chatId
    ? processingChats.has(chatId)
    : false;

  const interactionState = useMemo(() => {
    const value: "IDLE" | "THINKING" | "AWAITING_APPROVAL" = isProcessing
      ? "THINKING"
      : "IDLE";
    return {
      value,
      context: {
        streamingContent: null,
        toolCallRequest: null,
        parsedParameters: null,
      },
      matches: (stateName: "IDLE" | "THINKING" | "AWAITING_APPROVAL") =>
        stateName === value,
    };
  }, [isProcessing]);

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      if (chatId) {
        deleteMessage(chatId, messageId);
      }
    },
    [chatId, deleteMessage],
  );

  const messagesListRef = useRef<HTMLDivElement>(null);
  const { token } = useToken();
  const screens = useBreakpoint();
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(
    null,
  );

  const getContainerMaxWidth = () => {
    if (embedded) return "100%";
    if (screens.xs) return "100%";
    if (screens.sm) return "100%";
    if (screens.md) return "90%";
    if (screens.lg) return "85%";
    return "1024px";
  };

  const getContainerPadding = () => {
    if (embedded) return token.paddingSM;
    if (screens.xs) return token.paddingXS;
    if (screens.sm) return token.paddingSM;
    return token.padding;
  };

  useEffect(() => {
    setWorkflowDraft(null);
  }, [chatId]);

  const { systemPromptMessage, renderableMessages, convertRenderableEntry } =
    useChatViewMessages(currentChat, currentMessages);

  const hasMessages = currentMessages.length > 0;
  const hasWorkflowDraft = Boolean(workflowDraft?.content);
  const hasSystemPrompt = Boolean(systemPromptMessage);
  const showMessagesView =
    chatId && (hasMessages || hasSystemPrompt || hasWorkflowDraft);

  // In split-pane mode, the PaneShell shows floating split/close buttons at the top-right.
  // Reserve some horizontal space so token usage (also top-right) isn't covered on hover.
  const paneActionOverlayRightPadding = embedded ? 110 : 0;

  const renderableMessagesWithDraft = useMemo<RenderableEntry[]>(() => {
    if (!workflowDraft?.content) {
      return renderableMessages;
    }

    const draftEntry: RenderableEntry = {
      message: {
        id: workflowDraft.id,
        role: "user",
        content: workflowDraft.content,
        createdAt: workflowDraft.createdAt,
      } as Message,
      messageType: "text" as const,
    };

    return [...renderableMessages, draftEntry];
  }, [renderableMessages, workflowDraft]);

  // In v2, frontend chat id === backend session id.
  const agentSessionId = currentChat?.id;

  // Get token usage - prefer store (real-time), fallback to chat config (persisted)
  const storeTokenUsage = chatId ? tokenUsages[chatId] : null;
  const configTokenUsage = currentChat?.config?.tokenUsage;
  const currentTokenUsage = storeTokenUsage || configTokenUsage || null;

  const storeTruncation = chatId
    ? truncationOccurred[chatId]
    : false;
  const configTruncation = currentChat?.config?.truncationOccurred;
  const currentTruncationOccurred =
    storeTruncation || configTruncation || false;

  const storeSegments = chatId ? segmentsRemoved[chatId] : 0;
  const configSegments = currentChat?.config?.segmentsRemoved;
  const currentSegmentsRemoved = storeSegments || configSegments || 0;

  // IMPORTANT: keep virtualizer option callbacks stable.
  // If these functions change on every render, react-virtual can repeatedly update
  // internal state during effect flushes and trigger "Maximum update depth exceeded".
  const estimateRowSize = useCallback(() => 320, []);
  const getScrollElement = useCallback(() => messagesListRef.current, []);
  const getItemKey = useCallback(
    (index: number) => {
      const entry = renderableMessagesWithDraft[index];
      if (!entry) return index;

      // stable key: matches React row key logic
      if ("type" in entry && entry.type === "tool_session") return entry.id;
      if ("message" in entry && entry.message) return entry.message.id;
      return index;
    },
    [renderableMessagesWithDraft],
  );

  const virtualizerOptions = useMemo(
    () => ({
      count: renderableMessagesWithDraft.length,
      getScrollElement,
      estimateSize: estimateRowSize,
      overscan: 2,
      getItemKey,
    }),
    [
      estimateRowSize,
      getItemKey,
      getScrollElement,
      renderableMessagesWithDraft.length,
    ],
  );

  const rowVirtualizer = useVirtualizer(virtualizerOptions);

  const rowGap = token.marginMD;

  const {
    handleMessagesScroll,
    resetUserScroll,
    scrollToBottom,
    scrollToTop,
    showScrollToBottom,
    showScrollToTop,
  } = useChatViewScroll({
    currentChatId: chatId,
    interactionState,
    messagesListRef,
    renderableMessages: renderableMessagesWithDraft,
    rowVirtualizer,
  });

  const getScrollButtonPosition = () => {
    return screens.xs ? 16 : 32;
  };

  return (
    <Layout
      style={{
        flex: 1,
        minHeight: 0,
        height: "100%",
        background: token.colorBgContainer,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Flex
        vertical
        style={{
          flex: 1,
          minHeight: 0,
          height: "100%",
        }}
      >
        {/* TodoList - show when there is an active agent session */}
        {agentSessionId && hasTodoList && (
          <div
            style={{
              paddingTop: getContainerPadding(),
              paddingRight: getContainerPadding(),
              paddingBottom: 0,
              paddingLeft: getContainerPadding(),
              maxWidth: getContainerMaxWidth(),
              margin: "0 auto",
              width: "100%",
            }}
          >
            <TodoList sessionId={agentSessionId} initialCollapsed={true} />
          </div>
        )}

        {/* Token Usage Display - show when there's token usage data */}
        {currentTokenUsage && currentTokenUsage.budgetLimit > 0 && (
          <div
            style={{
              paddingTop: agentSessionId
                ? token.paddingXS
                : getContainerPadding(),
              paddingRight:
                getContainerPadding() + paneActionOverlayRightPadding,
              paddingBottom: 0,
              paddingLeft: getContainerPadding(),
              maxWidth: getContainerMaxWidth(),
              margin: "0 auto",
              width: "100%",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: token.marginXS,
              }}
            >
              <TokenUsageDisplay
                usage={currentTokenUsage}
                showDetails={true}
                size="small"
              />
              {currentTruncationOccurred && (
                <span
                  style={{
                    fontSize: 11,
                    color: token.colorTextSecondary,
                  }}
                >
                  ({currentSegmentsRemoved} truncated)
                </span>
              )}
            </div>
          </div>
        )}

        {chatId && hasSubSessions && (
          <div
            style={{
              paddingTop: token.paddingXS,
              paddingRight: getContainerPadding(),
              paddingBottom: 0,
              paddingLeft: getContainerPadding(),
              maxWidth: getContainerMaxWidth(),
              margin: "0 auto",
              width: "100%",
            }}
          >
            <SubSessionsPanel parentSessionId={chatId} />
          </div>
        )}

        <ChatMessagesList
          currentChat={currentChat}
          currentChatId={chatId}
          convertRenderableEntry={convertRenderableEntry}
          handleDeleteMessage={handleDeleteMessage}
          handleMessagesScroll={handleMessagesScroll}
          hasSystemPrompt={hasSystemPrompt}
          messagesListRef={messagesListRef}
          renderableMessages={renderableMessagesWithDraft}
          rowGap={rowGap}
          rowVirtualizer={rowVirtualizer}
          showMessagesView={Boolean(showMessagesView)}
          screens={screens}
          workflowDraftId={workflowDraft?.id}
          interactionState={interactionState}
          padding={getContainerPadding()}
        />

        {/* 滚动按钮组 - 都在右下角 */}
        {!embedded && (showScrollToTop || showScrollToBottom) && (
          <FloatButton.Group
            style={{
              right: getScrollButtonPosition(),
              bottom: screens.xs ? 160 : 180,
              gap: token.marginSM,
              zIndex: 1000,
            }}
          >
            {showScrollToTop && (
              <FloatButton
                type="default"
                icon={<UpOutlined />}
                onClick={() => {
                  scrollToTop();
                }}
              />
            )}
            {showScrollToBottom && (
              <FloatButton
                type="primary"
                icon={<DownOutlined />}
                onClick={() => {
                  resetUserScroll();
                  scrollToBottom();
                }}
              />
            )}
          </FloatButton.Group>
        )}

        {/* QuestionDialog - show above input area when there's an active agent session */}
        {agentSessionId && (
          <div
            style={{
              padding: `0 ${getContainerPadding()}px`,
              maxWidth: showMessagesView ? getContainerMaxWidth() : "100%",
              margin: "0 auto",
              width: "100%",
            }}
          >
            <QuestionDialog sessionId={agentSessionId} />
          </div>
        )}

        <ChatInputArea
          chatId={chatId}
          isCenteredLayout={!showMessagesView}
          maxWidth={showMessagesView ? getContainerMaxWidth() : "100%"}
          onWorkflowDraftChange={setWorkflowDraft}
          showMessagesView={Boolean(showMessagesView)}
        />
      </Flex>
    </Layout>
  );
};
