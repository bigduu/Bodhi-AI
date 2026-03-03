import { useEffect, useRef, useCallback } from "react";
import {
  AgentClient,
  TokenBudgetUsage,
  ContextSummaryInfo,
  TodoList,
  TodoListDelta,
  AgentEvent,
} from "../services/chat/AgentService";
import { useAppStore } from "../pages/ChatPage/store";
import { streamingMessageBus } from "../pages/ChatPage/utils/streamingMessageBus";
import { message } from "antd";

type SubscriptionEntry = {
  chatId: string;
  sessionId: string;
  controller: AbortController;
};

const isAbortError = (err: unknown) =>
  (err as any)?.name === "AbortError" || (err as any)?.code === 20;

export function useAgentEventSubscription() {
  const processingChats = useAppStore((state) => state.processingChats);

  // Stable store actions
  const addMessage = useAppStore((state) => state.addMessage);
  const setChatProcessing = useAppStore((state) => state.setChatProcessing);
  const updateTokenUsage = useAppStore((state) => state.updateTokenUsage);
  const setTruncationInfo = useAppStore((state) => state.setTruncationInfo);
  const updateChat = useAppStore((state) => state.updateChat);
  const updateMessage = useAppStore((state) => state.updateMessage);
  const setTodoList = useAppStore((state) => state.setTodoList);
  const updateTodoListDelta = useAppStore((state) => state.updateTodoListDelta);
  const setEvaluationState = useAppStore((state) => state.setEvaluationState);
  const clearEvaluationState = useAppStore(
    (state) => state.clearEvaluationState,
  );
  const upsertSubSessionProgress = useAppStore(
    (state) => state.upsertSubSessionProgress,
  );
  const clearSubSessionProgress = useAppStore(
    (state) => state.clearSubSessionProgress,
  );
  const refreshChats = useAppStore((state) => state.refreshChats);

  const agentClientRef = useRef(new AgentClient());

  // chatId -> subscription
  const subscriptionsByChatRef = useRef<Map<string, SubscriptionEntry>>(
    new Map(),
  );

  // sessionId -> streaming state
  const streamingStateBySessionRef = useRef<
    Map<string, { chatId: string; messageId: string; content: string }>
  >(new Map());

  // parentSessionId -> { children, parentDone }
  const backgroundChildrenByParentRef = useRef<
    Map<string, { children: Set<string>; parentDone: boolean }>
  >(new Map());

  // toolCallId -> toolName mapping for tracking tool names across start/complete
  const toolNamesByCallIdRef = useRef<Map<string, string>>(new Map());
  // toolCallId -> messageId mapping so we can update the tool call card in-place
  const toolCallMessageIdByCallIdRef = useRef<Map<string, string>>(new Map());

  // Chats that are processing but we couldn't subscribe yet (missing sessionId)
  const pendingChatIdsRef = useRef<Set<string>>(new Set());

  // Reconnect backoff state (chatId -> state)
  const reconnectStateByChatRef = useRef<
    Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> | null }>
  >(new Map());

  const clearReconnect = useCallback((chatId: string) => {
    const existing = reconnectStateByChatRef.current.get(chatId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    reconnectStateByChatRef.current.delete(chatId);
  }, []);

  const cleanupChat = useCallback((chatId: string, opts?: { clearDraft?: boolean }) => {
    clearReconnect(chatId);
    pendingChatIdsRef.current.delete(chatId);

    const existing = subscriptionsByChatRef.current.get(chatId);
    if (!existing) return;

    subscriptionsByChatRef.current.delete(chatId);

    // Abort SSE
    existing.controller.abort();

    // Clear streaming placeholder only when we really want to discard the draft.
    // This lets us preserve in-memory draft content across view switches and
    // transient resubscribe cycles (e.g. network hiccups) without touching storage.
    const streaming = streamingStateBySessionRef.current.get(existing.sessionId);
    if (streaming) {
      if (opts?.clearDraft) {
        streamingMessageBus.clear(streaming.chatId, streaming.messageId);
      }
      streamingStateBySessionRef.current.delete(existing.sessionId);
    } else if (opts?.clearDraft) {
      streamingMessageBus.clear(chatId, `streaming-${chatId}`);
    }
  }, []);

  const startSubscription = useCallback(
    (chatId: string, sessionId: string) => {
      // If a reconnect was scheduled, starting a new subscription supersedes it.
      clearReconnect(chatId);

      const controller = new AbortController();
      subscriptionsByChatRef.current.set(chatId, {
        chatId,
        sessionId,
        controller,
      });

      const messageId = `streaming-${chatId}`;
      const existingDraft = streamingMessageBus.getLatest(messageId);
      streamingStateBySessionRef.current.set(sessionId, {
        chatId,
        messageId,
        content: existingDraft ?? "",
      });

      // Only publish an empty placeholder if we don't already have a draft.
      // If we do, keep it as-is so remounting the view doesn't "blink" to empty.
      if (existingDraft === null) {
        streamingMessageBus.publish({ chatId, messageId, content: "" });
      }

      agentClientRef.current
        .subscribeToEvents(
          sessionId,
          {
            onToken: (tokenContent: string) => {
              const state = streamingStateBySessionRef.current.get(sessionId);
              if (!state) return;
              state.content += tokenContent;
              streamingMessageBus.publish({
                chatId: state.chatId,
                messageId: state.messageId,
                content: state.content,
              });
            },

            onToolStart: (toolCallId, toolName, args) => {
              // Track tool name for later use in onToolComplete
              toolNamesByCallIdRef.current.set(toolCallId, toolName);

              const messageId = crypto.randomUUID();
              toolCallMessageIdByCallIdRef.current.set(toolCallId, messageId);

              void addMessage(chatId, {
                id: messageId,
                role: "assistant",
                type: "tool_call",
                toolCalls: [
                  {
                    toolCallId,
                    toolName,
                    parameters: args || {},
                    streamingOutput: "",
                  },
                ],
                createdAt: new Date().toISOString(),
              });
            },

            onToolToken: (toolCallId: string, tokenContent: string) => {
              const messageId =
                toolCallMessageIdByCallIdRef.current.get(toolCallId);
              if (!messageId) return;

              const chat = useAppStore
                .getState()
                .chats.find((c) => c.id === chatId);
              if (!chat) return;
              const msg = chat?.messages.find((m) => m.id === messageId) as any;
              if (!msg || msg.type !== "tool_call" || !Array.isArray(msg.toolCalls)) {
                return;
              }

              const updatedToolCalls = msg.toolCalls.map((call: any) => {
                if (call.toolCallId !== toolCallId) return call;
                const next = (call.streamingOutput || "") + (tokenContent || "");
                return { ...call, streamingOutput: next };
              });

              updateMessage(chatId, messageId, {
                toolCalls: updatedToolCalls,
              });
            },

            onToolComplete: (toolCallId, result: AgentEvent["result"]) => {
              // Retrieve tool name tracked in onToolStart
              const toolName = toolNamesByCallIdRef.current.get(toolCallId) || "unknown";
              toolNamesByCallIdRef.current.delete(toolCallId);
              toolCallMessageIdByCallIdRef.current.delete(toolCallId);

              const displayPreference =
                (result?.display_preference as
                  | "Default"
                  | "Collapsible"
                  | "Hidden") || "Default";

              void addMessage(chatId, {
                id: crypto.randomUUID(),
                role: "assistant",
                type: "tool_result",
                toolName,
                toolCallId,
                result: {
                  tool_name: toolName,
                  result: result?.result ?? "",
                  display_preference: displayPreference,
                },
                isError: !result?.success,
                createdAt: new Date().toISOString(),
              });
            },

            onToolError: (toolCallId, error: string) => {
              toolNamesByCallIdRef.current.delete(toolCallId);
              toolCallMessageIdByCallIdRef.current.delete(toolCallId);
              void addMessage(chatId, {
                id: crypto.randomUUID(),
                role: "assistant",
                type: "tool_result",
                toolName: "unknown",
                toolCallId,
                result: {
                  tool_name: "unknown",
                  result: error,
                  display_preference: "Default",
                },
                isError: true,
                createdAt: new Date().toISOString(),
              });
            },

            onTokenBudgetUpdated: (usage: TokenBudgetUsage) => {
              const tokenUsage = {
                systemTokens: usage.system_tokens,
                summaryTokens: usage.summary_tokens,
                windowTokens: usage.window_tokens,
                totalTokens: usage.total_tokens,
                budgetLimit: usage.budget_limit,
              };

              updateTokenUsage(chatId, tokenUsage);
              setTruncationInfo(
                chatId,
                usage.truncation_occurred,
                usage.segments_removed,
              );

              // Persist in chat config without causing resubscribe:
              const chat = useAppStore
                .getState()
                .chats.find((c) => c.id === chatId);

              if (chat) {
                updateChat(chatId, {
                  config: {
                    ...chat.config,
                    tokenUsage,
                    truncationOccurred: usage.truncation_occurred,
                    segmentsRemoved: usage.segments_removed,
                  },
                });
              }
            },

            onContextSummarized: (summaryInfo: ContextSummaryInfo) => {
              message.info(
                `Conversation summarized: ${summaryInfo.messages_summarized} messages compressed, saved ${summaryInfo.tokens_saved.toLocaleString()} tokens`,
                5,
              );
            },

            onTodoListUpdated: (todoList: TodoList) => {
              if (todoList.session_id) {
                setTodoList(todoList.session_id, todoList);
              }
            },

            onTodoListItemProgress: (delta: TodoListDelta) => {
              if (delta.session_id) {
                updateTodoListDelta(delta.session_id, delta);
              }
            },

            onTodoListCompleted: (_sid, totalRounds, totalToolCalls) => {
              message.success(
                `All tasks completed! Total rounds: ${totalRounds}, Tool calls: ${totalToolCalls}`,
                3,
              );
            },

            onTodoEvaluationStarted: (sid, itemsCount) => {
              setEvaluationState(sid, {
                isEvaluating: true,
                reasoning: null,
                timestamp: Date.now(),
              });
              message.info(`Evaluating ${itemsCount} task(s)...`, 2);
            },

            onTodoEvaluationCompleted: (sid, updatesCount, reasoning) => {
              setEvaluationState(sid, {
                isEvaluating: false,
                reasoning,
                timestamp: Date.now(),
              });

              setTimeout(() => clearEvaluationState(sid), 5000);

              if (updatesCount > 0) {
                message.success(
                  `Evaluation complete: ${updatesCount} task(s) updated. ${reasoning}`,
                  4,
                );
              } else {
                message.info(`Evaluation complete: No updates needed`, 2);
              }
            },

            onComplete: () => {
              void (async () => {
                const state = streamingStateBySessionRef.current.get(sessionId);
                const streamedRaw = state?.content || "";
                const hasStreamedContent = streamedRaw.trim().length > 0;

                // Convert the streaming draft into a normal assistant message immediately so it
                // doesn't "disappear" when we turn off processing UI.
                if (hasStreamedContent) {
                  const chat = useAppStore.getState().chats.find((c) => c.id === chatId);
                  const last = chat?.messages?.[chat.messages.length - 1] as any;
                  const lastIsSame =
                    last?.role === "assistant" &&
                    last?.type === "text" &&
                    typeof last?.content === "string" &&
                    last.content === streamedRaw;

                  if (!lastIsSame) {
                    await addMessage(chatId, {
                      id: `assistant-${Date.now()}`,
                      role: "assistant",
                      type: "text",
                      content: streamedRaw,
                      createdAt: new Date().toISOString(),
                      metadata: { sessionId, model: "agent" },
                    });
                  }
                }

                // Sync with persisted history. Use retries because the backend can emit "complete"
                // before it finishes persisting the final assistant message.
                await useAppStore.getState().loadChatHistory(chatId, {
                  mode: hasStreamedContent ? "monotonic" : "replace",
                  retries: 4,
                  retryDelayMs: 200,
                  waitForAssistant: true,
                });

              // Mark parent completed. If there are background children, keep the SSE
              // subscription alive to forward sub-session progress.
              const bg =
                backgroundChildrenByParentRef.current.get(sessionId) ??
                ({ children: new Set<string>(), parentDone: false } as const);
              backgroundChildrenByParentRef.current.set(sessionId, {
                children: new Set(bg.children),
                parentDone: true,
              });

              if (bg.children.size === 0) {
                cleanupChat(chatId, { clearDraft: true });
                setChatProcessing(chatId, false);
              } else {
                // Clear the draft but keep subscription.
                const entry = subscriptionsByChatRef.current.get(chatId);
                if (entry) {
                  streamingMessageBus.clear(chatId, `streaming-${chatId}`);
                  streamingStateBySessionRef.current.delete(entry.sessionId);
                }
              }
              })();
            },

            onError: async (errorMessage: string) => {
              await addMessage(chatId, {
                id: `error-${Date.now()}`,
                role: "assistant",
                type: "text",
                content: `❌ **Error**: ${errorMessage}`,
                createdAt: new Date().toISOString(),
                finishReason: "error",
              });

              const bg =
                backgroundChildrenByParentRef.current.get(sessionId) ??
                ({ children: new Set<string>(), parentDone: false } as const);
              backgroundChildrenByParentRef.current.set(sessionId, {
                children: new Set(bg.children),
                parentDone: true,
              });

              if (bg.children.size === 0) {
                cleanupChat(chatId, { clearDraft: true });
                setChatProcessing(chatId, false);
              }
            },

            onSubSessionStarted: (parentSessionId, childSessionId, title) => {
              const bg =
                backgroundChildrenByParentRef.current.get(parentSessionId) ??
                ({ children: new Set<string>(), parentDone: false } as const);
              const children = new Set(bg.children);
              children.add(childSessionId);
              backgroundChildrenByParentRef.current.set(parentSessionId, {
                children,
                parentDone: bg.parentDone,
              });

              // Keep the parent subscribed while children are running.
              setChatProcessing(chatId, true);

              upsertSubSessionProgress(parentSessionId, childSessionId, {
                title,
                status: "running",
                lastEventAt: new Date().toISOString(),
              });

              // Ensure the child session appears in the session list.
              void refreshChats();
            },

            onSubSessionEvent: (parentSessionId, childSessionId, evt: AgentEvent) => {
              // Maintain a small rolling preview for fast UI feedback.
              if (evt.type === "token" && typeof evt.content === "string") {
                const prev =
                  useAppStore.getState().subSessionsByParent?.[parentSessionId]?.[
                    childSessionId
                  ]?.outputPreview || "";
                const next = (prev + evt.content).slice(-2000);
                upsertSubSessionProgress(parentSessionId, childSessionId, {
                  outputPreview: next,
                  lastEventAt: new Date().toISOString(),
                });
              } else {
                upsertSubSessionProgress(parentSessionId, childSessionId, {
                  lastEventAt: new Date().toISOString(),
                });
              }
            },

            onSubSessionHeartbeat: (parentSessionId, childSessionId, ts) => {
              upsertSubSessionProgress(parentSessionId, childSessionId, {
                lastHeartbeatAt: ts,
              });
            },

            onSubSessionCompleted: (parentSessionId, childSessionId, status, error) => {
              const bg =
                backgroundChildrenByParentRef.current.get(parentSessionId) ??
                ({ children: new Set<string>(), parentDone: false } as const);
              const children = new Set(bg.children);
              children.delete(childSessionId);
              backgroundChildrenByParentRef.current.set(parentSessionId, {
                children,
                parentDone: bg.parentDone,
              });

              upsertSubSessionProgress(parentSessionId, childSessionId, {
                status,
                error,
                lastEventAt: new Date().toISOString(),
              });

              // If parent already completed and no more background children, stop subscription.
              if (bg.parentDone && children.size === 0) {
                clearSubSessionProgress(parentSessionId, childSessionId);
                cleanupChat(chatId, { clearDraft: true });
                setChatProcessing(chatId, false);
              }

              void refreshChats();
            },
          },
          controller,
        )
        .then(() => {
          // Stream ended without throwing. Backend SSE should be long-lived; treat this as a
          // disconnect and attempt to resubscribe (unless we were explicitly aborted).
          if (controller.signal.aborted) return;
          const stillProcessing = useAppStore.getState().processingChats.has(chatId);
          if (!stillProcessing) {
            cleanupChat(chatId, { clearDraft: true });
            return;
          }

          // Restart subscription with backoff.
          const prev = reconnectStateByChatRef.current.get(chatId);
          const attempt = prev?.attempt ?? 0;
          const delayMs = Math.min(5000, 250 * Math.pow(2, attempt));

          cleanupChat(chatId, { clearDraft: false });
          const timer = setTimeout(() => {
            reconnectStateByChatRef.current.delete(chatId);
            if (!useAppStore.getState().processingChats.has(chatId)) return;
            const chat = useAppStore.getState().chats.find((c) => c.id === chatId);
            const sid = chat?.id?.trim();
            if (!sid) return;
            startSubscription(chatId, sid);
          }, delayMs);
          reconnectStateByChatRef.current.set(chatId, { attempt: attempt + 1, timer });
        })
        .catch((err) => {
          // If we explicitly aborted, do nothing (normal cleanup path).
          if (controller.signal.aborted) return;

          // Some runtimes surface network disconnects as AbortError even when we didn't abort.
          // In that case, attempt to resubscribe instead of tearing down processing state.
          if (isAbortError(err)) {
            const stillProcessing = useAppStore.getState().processingChats.has(chatId);
            if (!stillProcessing) {
              cleanupChat(chatId, { clearDraft: true });
              return;
            }

            const prev = reconnectStateByChatRef.current.get(chatId);
            const attempt = prev?.attempt ?? 0;
            const delayMs = Math.min(5000, 250 * Math.pow(2, attempt));

            cleanupChat(chatId, { clearDraft: false });
            const timer = setTimeout(() => {
              reconnectStateByChatRef.current.delete(chatId);
              if (!useAppStore.getState().processingChats.has(chatId)) return;
              const chat = useAppStore.getState().chats.find((c) => c.id === chatId);
              const sid = chat?.id?.trim();
              if (!sid) return;
              startSubscription(chatId, sid);
            }, delayMs);
            reconnectStateByChatRef.current.set(chatId, { attempt: attempt + 1, timer });
            return;
          }

          console.error("[useAgentEventSubscription] Subscription error:", err);
          cleanupChat(chatId, { clearDraft: true });
          setChatProcessing(chatId, false);
        });
    },
    [
      addMessage,
      setChatProcessing,
      updateTokenUsage,
      setTruncationInfo,
      updateChat,
      updateMessage,
      setTodoList,
      updateTodoListDelta,
      setEvaluationState,
      clearEvaluationState,
      cleanupChat,
      clearReconnect,
    ],
  );

  const ensureSubscription = useCallback(
    (chatId: string) => {
      const chat = useAppStore.getState().chats.find((c) => c.id === chatId);
      const sessionId = chat?.id?.trim();

      if (!sessionId) {
        pendingChatIdsRef.current.add(chatId);
        return;
      }

      pendingChatIdsRef.current.delete(chatId);

      const existing = subscriptionsByChatRef.current.get(chatId);
      if (existing?.sessionId === sessionId) return;

      // If we need to restart the SSE connection (e.g. sessionId changed),
      // keep any existing draft in-memory so the UI doesn't lose what it already rendered.
      if (existing) cleanupChat(chatId, { clearDraft: false });
      startSubscription(chatId, sessionId);
    },
    [cleanupChat, startSubscription],
  );

  // Effect A: reconcile active subscriptions when processingChats changes (NO global cleanup return)
  useEffect(() => {
    // Start needed subscriptions
    processingChats.forEach((chatId) => ensureSubscription(chatId));

    // Stop subscriptions for chats no longer processing
    for (const chatId of Array.from(subscriptionsByChatRef.current.keys())) {
      if (!processingChats.has(chatId)) {
        cleanupChat(chatId, { clearDraft: true });
      }
    }

    // Drop pending chats that are no longer processing
    for (const chatId of Array.from(pendingChatIdsRef.current)) {
      if (!processingChats.has(chatId)) {
        pendingChatIdsRef.current.delete(chatId);
      }
    }
  }, [processingChats, ensureSubscription, cleanupChat]);

  // Retry pending processing chats when chats/config updates (e.g. sessionId arrives)
  useEffect(() => {
    return useAppStore.subscribe(
      (s) => s.chats,
      () => {
        if (pendingChatIdsRef.current.size === 0) return;

        for (const chatId of Array.from(pendingChatIdsRef.current)) {
          if (!useAppStore.getState().processingChats.has(chatId)) {
            pendingChatIdsRef.current.delete(chatId);
            continue;
          }
          ensureSubscription(chatId);
        }
      },
    );
  }, [ensureSubscription]);

  // Effect B: unmount cleanup only
  useEffect(() => {
    return () => {
      for (const chatId of Array.from(subscriptionsByChatRef.current.keys())) {
        cleanupChat(chatId, { clearDraft: true });
      }
    };
  }, [cleanupChat]);
}
