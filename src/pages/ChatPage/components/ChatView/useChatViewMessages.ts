import { useCallback, useMemo } from "react";
import type {
  Message,
  AssistantToolCallMessage,
  AssistantToolResultMessage,
} from "../../types/chat";
import type { ChatItem } from "../../types/chat";
import type { ToolSessionItem } from "../ToolSessionCard";

export type MessageType =
  | "text"
  | "plan"
  | "question"
  | "tool_call"
  | "tool_result";

export type RenderableEntry =
  | {
      message: Message;
      messageType?: MessageType;
    }
  | {
      type: "tool_session";
      id: string;
      sessionId: string;
      tools: ToolSessionItem[];
      createdAt: string;
    };

export type ConvertedEntry =
  | {
      type: "message";
      message: Message;
      align: "flex-start" | "flex-end";
      messageType?: MessageType;
    }
  | {
      type: "tool_session";
      id: string;
      sessionId: string;
      tools: ToolSessionItem[];
      createdAt: string;
    };

/**
 * Type guard to check if entry is a tool session
 */
function isToolSessionEntry(
  entry: RenderableEntry,
): entry is Extract<RenderableEntry, { type: "tool_session" }> {
  return "type" in entry && entry.type === "tool_session";
}

/**
 * Check if a message is a tool-related message (call or result)
 */
function isToolMessage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  const type = (message as any).type;
  return type === "tool_call" || type === "tool_result";
}

/**
 * Check if a message is a tool call
 */
function isToolCallMessage(
  message: Message,
): message is AssistantToolCallMessage {
  return message.role === "assistant" && (message as any).type === "tool_call";
}

/**
 * Check if a message is a tool result
 */
function isToolResultMessage(
  message: Message,
): message is AssistantToolResultMessage {
  return (
    message.role === "assistant" && (message as any).type === "tool_result"
  );
}

/**
 * Group consecutive tool messages into sessions
 */
function groupToolMessages(
  messages: Message[],
): Array<Message | ToolSessionItem[]> {
  const result: Array<Message | ToolSessionItem[]> = [];
  let currentToolSession: ToolSessionItem[] = [];

  for (const message of messages) {
    if (isToolMessage(message)) {
      if (isToolCallMessage(message)) {
        // Start a new tool item for the call
        currentToolSession.push({ call: message });
      } else if (isToolResultMessage(message)) {
        // Find the matching call by toolCallId and add result
        const matchingCallIndex = currentToolSession.findIndex(
          (item) =>
            item.call.toolCalls?.some(
              (tc) => tc.toolCallId === message.toolCallId,
            ),
        );
        if (matchingCallIndex !== -1) {
          currentToolSession[matchingCallIndex].result = message;
        }
      }
    } else {
      // Not a tool message - flush current session if any
      if (currentToolSession.length > 0) {
        result.push(currentToolSession);
        currentToolSession = [];
      }
      result.push(message);
    }
  }

  // Flush remaining tool session
  if (currentToolSession.length > 0) {
    result.push(currentToolSession);
  }

  return result;
}

export const useChatViewMessages = (
  currentChat: ChatItem | null,
  currentMessages: Message[],
) => {
  const systemPromptMessage = useMemo(() => {
    const existingSystemMessage = currentMessages.find(
      (msg: Message) => msg.role === "system",
    );
    if (existingSystemMessage) {
      return existingSystemMessage as Message;
    }

    if (currentChat?.config?.baseSystemPrompt) {
      return {
        id: `system-prompt-${currentChat.id}`,
        role: "system" as const,
        content: currentChat.config.baseSystemPrompt,
        createdAt: new Date(currentChat.createdAt).toISOString(),
      };
    }

    return null;
  }, [currentChat, currentMessages]);

  const shouldHideMessage = useCallback((_item: Message): boolean => {
    // Keep tool_result messages even when `display_preference === "Hidden"` so
    // ToolSessionCard can accurately compute completion status.
    return false;
  }, []);

  const convertRenderableEntry = useCallback(
    (entry: RenderableEntry): ConvertedEntry => {
      // Handle tool session type
      if (isToolSessionEntry(entry)) {
        return {
          type: "tool_session",
          id: entry.id,
          sessionId: entry.sessionId,
          tools: entry.tools,
          createdAt: entry.createdAt,
        };
      }

      // Handle regular message type
      const align = entry.message.role === "user" ? "flex-end" : "flex-start";

      let resolvedType = entry.messageType;
      if (
        !resolvedType &&
        entry.message.role === "assistant" &&
        "type" in entry.message
      ) {
        const assistantType = (entry.message as any).type as string | undefined;
        if (
          assistantType === "text" ||
          assistantType === "plan" ||
          assistantType === "question" ||
          assistantType === "tool_call" ||
          assistantType === "tool_result"
        ) {
          resolvedType = assistantType;
        }
      }

      return {
        type: "message",
        message: entry.message,
        align,
        messageType: resolvedType,
      };
    },
    [],
  );

  const renderableMessages = useMemo<RenderableEntry[]>(() => {
    const filtered = currentMessages.filter((item) => {
      const role = item.role;

      if (
        role !== "user" &&
        role !== "assistant" &&
        role !== "system" &&
        role !== "tool"
      ) {
        return false;
      }

      if (shouldHideMessage(item)) {
        return false;
      }

      return true;
    });

    // Group consecutive tool messages into sessions
    const grouped = groupToolMessages(filtered);

    const entries: RenderableEntry[] = grouped.map((group, index) => {
      if (Array.isArray(group)) {
        // This is a tool session
        const firstTool = group[0];
        return {
          type: "tool_session",
          id: `tool-session-${firstTool?.call?.id || index}`,
          sessionId: `session-${firstTool?.call?.id || index}`,
          tools: group,
          createdAt: firstTool?.call?.createdAt || new Date().toISOString(),
        };
      }

      // This is a regular message
      const message = group as Message;
      let inferredType: MessageType | undefined;
      if (message.role === "assistant" && "type" in message) {
        const assistantType = (message as any).type as string | undefined;
        if (
          assistantType === "text" ||
          assistantType === "plan" ||
          assistantType === "question" ||
          assistantType === "tool_call" ||
          assistantType === "tool_result"
        ) {
          inferredType = assistantType;
        }
      }

      return {
        message,
        messageType: inferredType,
      };
    });

    const hasSystemMessage = filtered.some((item) => item.role === "system");
    if (!hasSystemMessage && systemPromptMessage) {
      entries.unshift({ message: systemPromptMessage });
    }

    return entries;
  }, [currentMessages, shouldHideMessage, systemPromptMessage]);

  return {
    systemPromptMessage,
    renderableMessages,
    convertRenderableEntry,
  };
};
