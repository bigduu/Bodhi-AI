import { useCallback, useEffect, useRef } from "react";
import { App as AntApp } from "antd";
import { AgentClient } from "../../services/AgentService";
import type { ChatItem, Message, UserMessage } from "../../types/chat";
import type { ImageFile } from "../../utils/imageUtils";
import { streamingMessageBus } from "../../utils/streamingMessageBus";
import { useAppStore } from "../../store";
import { getSystemPromptEnhancementText } from "@shared/utils/systemPromptEnhancement";
import { useActiveModel } from "../useActiveModel";

export interface UseMessageStreaming {
  sendMessage: (content: string, images?: ImageFile[]) => Promise<void>;
  cancel: () => void;
  agentAvailable: boolean | null;
}

interface UseMessageStreamingDeps {
  chatId: string | null;
  addMessage: (chatId: string, message: Message) => Promise<void>;
  setChatProcessing: (chatId: string, isProcessing: boolean) => void;
  updateChat: (chatId: string, updates: Partial<ChatItem>) => void;
}

/**
 * Unified chat streaming hook
 *
 * Agent-only flow using the local agent endpoints (localhost:8080).
 */
export function useMessageStreaming(
  deps: UseMessageStreamingDeps,
): UseMessageStreaming {
  const { modal, message: appMessage } = AntApp.useApp();
  const abortRef = useRef<AbortController | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const streamingContentRef = useRef<string>("");
  const agentClientRef = useRef(new AgentClient());

  const agentAvailable = useAppStore((state) => state.agentAvailability);
  const setAgentAvailability = useAppStore(
    (state) => state.setAgentAvailability,
  );
  const checkAgentAvailability = useAppStore(
    (state) => state.checkAgentAvailability,
  );
  const startAgentHealthCheck = useAppStore(
    (state) => state.startAgentHealthCheck,
  );
  const activeModel = useActiveModel();

  // Fetch chat internally based on chatId
  const currentChat = useAppStore((state) =>
    deps.chatId
      ? state.chats.find((chat) => chat.id === deps.chatId) || null
      : null,
  );

  useEffect(() => {
    startAgentHealthCheck();
  }, [startAgentHealthCheck]);

  const cancel = useCallback(() => {
    // Abort local streaming
    abortRef.current?.abort();

    // Also tell backend to stop agent execution
    const sessionId = currentChat?.id;
    if (sessionId) {
      agentClientRef.current.stopGeneration(sessionId).catch((error) => {
        console.error(
          "[useMessageStreaming] Failed to stop generation:",
          error,
        );
      });
    }
  }, [currentChat?.id]);

  /**
   * Send message using Agent Server
   * Note: Event subscription is handled by useAgentEventSubscription hook in ChatView
   */
  const sendWithAgent = useCallback(
    async (content: string, chatId: string, userMessage: UserMessage) => {
      // Validate model is available (TypeScript type guard)
      if (!activeModel) {
        throw new Error("Model not selected");
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const enhancePrompt = getSystemPromptEnhancementText().trim();
        // Normalize workspace path: remove trailing slashes, handle cross-platform
        const rawWorkspacePath = currentChat?.config?.workspacePath || "";
        const workspacePath = rawWorkspacePath
          .trim()
          .replace(/\/+$/, "") // Remove trailing slashes (Unix/Windows)
          .replace(/\\+$/, ""); // Remove trailing backslashes (Windows)

        // Step 1: Send message to Agent
        const response = await agentClientRef.current.sendMessage({
          message: content,
          session_id: chatId,
          enhance_prompt: enhancePrompt || undefined,
          workspace_path: workspacePath || undefined,
          images: userMessage.images
            ?.filter((img) => Boolean(img.base64))
            .map((img) => ({
              base64: img.base64 as string,
              name: img.name,
              size: img.size,
              type: img.type,
            })),
          model: activeModel,
        });

        const { session_id } = response;
        if (session_id !== chatId) {
          console.warn(
            `[useMessageStreaming] Backend returned unexpected session_id=${session_id} for chatId=${chatId}`,
          );
        }

        // Step 2: Trigger execution (idempotent)
        const executeResult = await agentClientRef.current.execute(chatId, activeModel);
        console.log("[Agent] Execute status:", executeResult.status);

        // Step 3: Set processing flag to activate event subscription (handled by useAgentEventSubscription)
        if (["started", "already_running"].includes(executeResult.status)) {
          deps.setChatProcessing(chatId, true);
        } else if (executeResult.status === "completed") {
          // Session already completed, no need to process
          console.log("[Agent] Session already completed");
          deps.setChatProcessing(chatId, false);
        } else {
          // Error or other status
          console.error("[Agent] Execute failed:", executeResult.status);
          deps.setChatProcessing(chatId, false);
          throw new Error(`Execute failed: ${executeResult.status}`);
        }
      } catch (error) {
        throw error; // Re-throw to trigger fallback
      }
    },
    [deps, activeModel, currentChat],
  );

  const sendMessage = useCallback(
    async (content: string, images?: ImageFile[]) => {
      if (!currentChat) {
        modal.info({
          title: "No Active Chat",
          content: "Please create or select a chat before sending a message.",
        });
        return;
      }

      if (!deps.chatId) {
        modal.info({
          title: "No Chat ID",
          content: "Chat ID is required to send a message.",
        });
        return;
      }

      // Validate model is available
      if (!activeModel) {
        modal.error({
          title: "No Model Selected",
          content: "Please select a model before sending a message.",
        });
        return;
      }

      let isAgentAvailable = agentAvailable;
      if (isAgentAvailable === null) {
        isAgentAvailable = await checkAgentAvailability();
      }

      if (!isAgentAvailable) {
        appMessage.error("Agent unavailable. Please try again later.");
        return;
      }

      // Check if active model is loaded
      if (!activeModel) {
        appMessage.error(
          "Model configuration not loaded. Please wait or reload the page.",
        );
        return;
      }

      const chatId = deps.chatId;
      const messageImages =
        images?.map((img) => ({
          id: img.id,
          base64: img.base64,
          name: img.name,
          size: img.size,
          type: img.type,
        })) || [];

      const userMessage: UserMessage = {
        role: "user",
        content,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        images: messageImages,
      };

      await deps.addMessage(chatId, userMessage);

      deps.setChatProcessing(chatId, true);

      try {
        console.log("[useChatStreaming] Using Agent Server");
        await sendWithAgent(content, chatId, userMessage);
        // Note: Don't set processing false here - let useAgentEventSubscription handle it
      } catch (error) {
        if (streamingMessageIdRef.current) {
          streamingMessageBus.clear(chatId, streamingMessageIdRef.current);
        }
        streamingMessageIdRef.current = null;
        streamingContentRef.current = "";

        if (error instanceof Error && error.name === "AbortError") {
          appMessage.info("Request cancelled");
        } else {
          console.error("[useChatStreaming] Failed to send message:", error);
          appMessage.error("Failed to send message. Please try again.");
          setAgentAvailability(false);
        }
        deps.setChatProcessing(chatId, false); // Only set false on error
      } finally {
        abortRef.current = null;
        if (streamingMessageIdRef.current) {
          streamingMessageBus.clear(chatId, streamingMessageIdRef.current);
        }
        streamingMessageIdRef.current = null;
        streamingContentRef.current = "";
        // Removed: deps.setChatProcessing(chatId, false) - useAgentEventSubscription handles this
      }
    },
    [
      agentAvailable,
      appMessage,
      checkAgentAvailability,
      deps,
      currentChat,
      modal,
      sendWithAgent,
      setAgentAvailability,
      activeModel,
    ],
  );

  return {
    sendMessage,
    cancel,
    agentAvailable,
  };
}
