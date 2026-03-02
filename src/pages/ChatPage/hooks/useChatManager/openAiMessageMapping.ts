import type {
  Message,
  UserFileReferenceMessage,
  UserMessage,
} from "../../types/chat";
import { getEffectiveSystemPrompt } from "../../../../shared/utils/systemPromptEnhancement";
import type OpenAI from "openai";

export const buildUserContent = (message: UserMessage) => {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }
  return [
    { type: "text" as const, text: message.content },
    ...message.images
      .map((img) => img.base64 || img.url)
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => ({
        type: "image_url" as const,
        image_url: { url },
      })),
  ];
};

export const mapMessageToOpenAI = (
  message: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam | null => {
  if (message.role === "system") {
    return null;
  }
  if (message.role === "user") {
    const content =
      "content" in message
        ? message.content
        : (message as UserFileReferenceMessage).displayText;
    if (typeof content !== "string") return null;
    const userMessage: UserMessage = {
      id: message.id,
      role: "user",
      content,
      createdAt: message.createdAt,
      images: "images" in message ? message.images : undefined,
    };
    return {
      role: "user",
      content: buildUserContent(userMessage),
    };
  }
  if (message.role === "assistant" && "type" in message) {
    if (message.type === "tool_call") {
      return {
        role: "assistant",
        content: "",
        tool_calls: message.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: "function" as const,
          function: {
            name: call.toolName,
            arguments: JSON.stringify(call.parameters ?? {}),
          },
        })),
      };
    }
    if (message.type === "tool_result") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.result?.result ?? "",
      };
    }
    if (message.type === "text") {
      return {
        role: "assistant",
        content: message.content,
      };
    }
  }
  return null;
};

export const buildRequestMessages = (
  messages: Message[],
  baseSystemPrompt: string,
  workspacePath?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const systemPrompt = getEffectiveSystemPrompt(
    baseSystemPrompt || "",
    workspacePath,
  );
  const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [];
  if (systemPrompt) {
    openaiMessages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  messages.forEach((message) => {
    const mapped = mapMessageToOpenAI(message);
    if (mapped) {
      openaiMessages.push(mapped);
    }
  });

  return openaiMessages;
};
