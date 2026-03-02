import { useCallback, useRef, useState } from "react";
import { App as AntApp } from "antd";
import { useAppStore } from "../../store";
import { getOpenAIClient } from "../../services/openaiClient";
import type { AssistantTextMessage, Message } from "../../types/chat";
import type { UseChatState } from "./types";
import { useActiveModel } from "../useActiveModel";

/**
 * Hook for chat title generation and validation
 * Handles both auto and manual title generation
 */
export interface UseChatTitleGeneration {
  titleGenerationState: Record<
    string,
    { status: "idle" | "loading" | "error"; error?: string }
  >;
  autoGenerateTitles: boolean;
  isUpdatingAutoTitlePreference: boolean;
  generateChatTitle: (
    chatId: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  setAutoGenerateTitlesPreference: (enabled: boolean) => Promise<void>;
  isDefaultTitle: (title: string | undefined | null) => boolean;
}

type ChatTitleState = Pick<UseChatState, "chats" | "updateChat">;

export function useChatTitleGeneration(
  state: ChatTitleState,
): UseChatTitleGeneration {
  const { message: appMessage } = AntApp.useApp();

  const autoGenerateTitles = useAppStore((state) => state.autoGenerateTitles);
  const activeModel = useActiveModel();
  const setAutoGenerateTitlesPreference = useAppStore(
    (state) => state.setAutoGenerateTitlesPreference,
  );
  const isUpdatingAutoTitlePreference = useAppStore(
    (state) => state.isUpdatingAutoTitlePreference,
  );

  const autoTitleGeneratedRef = useRef<Set<string>>(new Set());
  const titleGenerationInFlightRef = useRef<Set<string>>(new Set());
  const [titleGenerationState, setTitleGenerationState] = useState<
    Record<string, { status: "idle" | "loading" | "error"; error?: string }>
  >({});

  const isDefaultTitle = useCallback((title: string | undefined | null) => {
    if (!title) return true;
    const normalized = title.trim().toLowerCase();
    if (normalized.length === 0) return true;
    // Keep this list aligned with backend defaults + UI create flows.
    if (normalized === "new session" || normalized === "new chat") return true;
    if (normalized === "main") return true;
    return normalized.startsWith("new session -") || normalized.startsWith("new chat -");
  }, []);

  const generateChatTitle = useCallback(
    async (chatId: string, options?: { force?: boolean }) => {
      const chat = state.chats.find((c) => c.id === chatId);
      if (!chat) {
        return;
      }

      const userAssistantMessages = chat.messages.filter((msg: Message) => {
        if (msg.role === "user") return true;
        if (msg.role === "assistant" && "type" in msg) {
          return (msg as AssistantTextMessage).type === "text";
        }
        return false;
      });

      const isAuto = !options?.force;
      if (isAuto && !autoGenerateTitles) {
        return;
      }
      const MAX_AUTO_MESSAGES = 6;

      if (isAuto) {
        if (titleGenerationInFlightRef.current.has(chatId)) {
          return;
        }
        if (autoTitleGeneratedRef.current.has(chatId)) {
          return;
        }
        if (!isDefaultTitle(chat.title)) {
          return;
        }
        if (userAssistantMessages.length === 0) {
          return;
        }
        if (userAssistantMessages.length > MAX_AUTO_MESSAGES) {
          return;
        }
      }

      titleGenerationInFlightRef.current.add(chatId);
      setTitleGenerationState((prev) => ({
        ...prev,
        [chatId]: { status: "loading" },
      }));

      try {
        const candidate = await generateTitleWithAI(
          userAssistantMessages,
          activeModel,
        );
        if (!candidate) {
          throw new Error("Generated title is empty");
        }

        state.updateChat(chatId, { title: candidate });
        if (!isAuto || candidate.toLowerCase() !== "new chat") {
          autoTitleGeneratedRef.current.add(chatId);
        }

        setTitleGenerationState((prev) => ({
          ...prev,
          [chatId]: { status: "idle" },
        }));

        if (options?.force) {
          appMessage?.success?.("Chat title updated");
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to generate title";
        setTitleGenerationState((prev) => ({
          ...prev,
          [chatId]: { status: "error", error: errorMessage },
        }));
        if (options?.force) {
          appMessage?.error?.(errorMessage);
        } else {
          appMessage?.warning?.(errorMessage);
        }
      } finally {
        titleGenerationInFlightRef.current.delete(chatId);
      }
    },
    [appMessage, autoGenerateTitles, isDefaultTitle, activeModel, state],
  );

  return {
    titleGenerationState,
    autoGenerateTitles,
    isUpdatingAutoTitlePreference,
    generateChatTitle,
    setAutoGenerateTitlesPreference,
    isDefaultTitle,
  };
}

const MAX_TITLE_CHARS = 60;
const MAX_TITLE_TOKENS = 20;
const MAX_MESSAGES_FOR_TITLE = 8;
const MAX_MESSAGE_CHARS = 220;

const buildTitleContext = (messages: Message[]): string => {
  const slice = messages.slice(0, MAX_MESSAGES_FOR_TITLE);
  const lines = slice
    .map((message) => {
      const role = message.role === "user" ? "User" : "Assistant";
      const text = (() => {
        if ("content" in message && typeof message.content === "string") {
          return message.content.trim();
        }
        if ("displayText" in message) {
          const displayText = message.displayText;
          if (typeof displayText === "string") {
            return displayText.trim();
          }
        }
        return "";
      })();
      if (!text) return "";
      const trimmed =
        text.length > MAX_MESSAGE_CHARS
          ? `${text.slice(0, MAX_MESSAGE_CHARS - 3)}...`
          : text;
      return `${role}: ${trimmed}`;
    })
    .filter((line) => line.length > 0);

  return lines.join("\n");
};

const normalizeTitle = (title: string): string => {
  const singleLine = title.split(/\r?\n/)[0]?.trim() ?? "";
  const unquoted = singleLine.replace(/^["']+|["']+$/g, "");
  if (unquoted.length <= MAX_TITLE_CHARS) {
    return unquoted;
  }
  return `${unquoted.slice(0, MAX_TITLE_CHARS - 3)}...`;
};

const generateTitleWithAI = async (
  messages: Message[],
  model?: string | null,
): Promise<string> => {
  const context = buildTitleContext(messages);
  if (!context) {
    return "";
  }

  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    // Use provided model, or use "default" to let backend use its configured default
    model: model || "default",
    temperature: 0.2,
    max_tokens: MAX_TITLE_TOKENS,
    messages: [
      {
        role: "system",
        content:
          "You generate concise English chat titles. Return only the title text, no quotes or punctuation.",
      },
      {
        role: "user",
        content: `Create a short descriptive title (max ${MAX_TITLE_CHARS} characters) for this chat:\n\n${context}`,
      },
    ],
  });

  const candidate = response.choices?.[0]?.message?.content?.trim() ?? "";
  return normalizeTitle(candidate);
};
