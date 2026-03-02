import { StateCreator } from "zustand";
import {
  ChatItem,
  Message,
  SystemMessage,
  UserMessage,
  AssistantTextMessage,
  AssistantToolCallMessage,
  AssistantToolResultMessage,
  MessageImage,
} from "../../types/chat";
import { AgentClient, SessionSummary } from "../../services/AgentService";
import { getDefaultSystemPrompts } from "../../utils/defaultSystemPrompts";
import { getBackendBaseUrlSync } from "@shared/utils/backendBaseUrl";
import type { AppState } from "../";

const AUTO_TITLE_KEY = "copilot_auto_generate_titles";
const agentClient = AgentClient.getInstance();
const DEFAULT_BASE_SYSTEM_PROMPT =
  getDefaultSystemPrompts()[0]?.content?.trim() || "";

const safeRandomId = (): string => {
  try {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    // ignore
  }
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const getAgentApiBaseUrlSync = (): string => {
  let normalized = getBackendBaseUrlSync().trim().replace(/\/+$/, "");
  // Remove /v1 suffix if present, then add /api/v1
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return `${normalized}/api/v1`;
};

const parseBambooAttachmentUrl = (
  url: string,
): { sessionId: string; attachmentId: string } | null => {
  const trimmed = url.trim();
  if (!trimmed.startsWith("bamboo-attachment://")) return null;
  const rest = trimmed.slice("bamboo-attachment://".length);
  const [sessionId, attachmentId] = rest.split("/", 2);
  if (!sessionId || !attachmentId) return null;
  return { sessionId, attachmentId };
};

const resolveImageUrlForRender = (rawUrl: string): string => {
  const ref = parseBambooAttachmentUrl(rawUrl);
  if (!ref) return rawUrl;
  const base = getAgentApiBaseUrlSync();
  return `${base}/sessions/${encodeURIComponent(ref.sessionId)}/attachments/${encodeURIComponent(ref.attachmentId)}`;
};

const sessionSummaryToChatItem = (s: SessionSummary): ChatItem => {
  const createdAtMs = Number.isFinite(Date.parse(s.created_at))
    ? Date.parse(s.created_at)
    : Date.now();

  const tokenUsage = s.token_usage
    ? {
        systemTokens: s.token_usage.system_tokens,
        summaryTokens: s.token_usage.summary_tokens,
        windowTokens: s.token_usage.window_tokens,
        totalTokens: s.token_usage.total_tokens,
        budgetLimit: s.token_usage.budget_limit,
      }
    : undefined;
  return {
    id: s.id,
    kind: s.kind,
    parentSessionId: s.parent_session_id ?? null,
    rootSessionId: s.root_session_id,
    spawnDepth: s.spawn_depth,
    createdByScheduleId: s.created_by_schedule_id ?? null,
    isRunning: s.is_running,
    updatedAt: s.updated_at,
    lastActivityAt: s.last_activity_at,
    messageCount: s.message_count,
    hasAttachments: s.has_attachments,
    title: s.title || "Session",
    createdAt: createdAtMs,
    pinned: s.pinned,
    messages: [],
    config: {
      systemPromptId: "general_assistant",
      baseSystemPrompt: DEFAULT_BASE_SYSTEM_PROMPT,
      lastUsedEnhancedPrompt: null,
      tokenUsage,
      truncationOccurred: s.token_usage?.truncation_occurred,
      segmentsRemoved: s.token_usage?.segments_removed,
    },
    currentInteraction: null,
  };
};

const mapHistoryMessagesToUi = (
  sessionId: string,
  history: Array<{
    id: string;
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    content_parts?: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail?: string } }
    >;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    created_at: string;
  }>,
): Message[] => {
  const toolNameByCallId = new Map<string, string>();
  const out: Message[] = [];

  for (const msg of history) {
    const createdAt = msg.created_at || new Date().toISOString();

    if (msg.role === "system") {
      const sys: SystemMessage = {
        role: "system",
        id: msg.id,
        createdAt,
        content: msg.content || "",
      };
      out.push(sys);
      continue;
    }

    if (msg.role === "user") {
      const images: MessageImage[] = [];
      for (const part of msg.content_parts || []) {
        if (part.type !== "image_url") continue;
        const rawUrl = part.image_url?.url || "";
        if (!rawUrl) continue;
        const resolved = resolveImageUrlForRender(rawUrl);
        const ref = parseBambooAttachmentUrl(rawUrl);
        images.push({
          id: safeRandomId(),
          url: resolved,
          name: ref ? `attachment-${ref.attachmentId}` : "image",
          size: 0,
          type: "image/*",
        });
      }

      const user: UserMessage = {
        role: "user",
        id: msg.id,
        createdAt,
        content: msg.content || "",
        images: images.length ? images : undefined,
      };
      out.push(user);
      continue;
    }

    if (msg.role === "assistant") {
      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          toolNameByCallId.set(call.id, call.function?.name || "unknown");
        }
        const toolCallMsg: AssistantToolCallMessage = {
          role: "assistant",
          type: "tool_call",
          id: msg.id,
          createdAt,
          toolCalls: toolCalls.map((c) => ({
            toolCallId: c.id,
            toolName: c.function?.name || "unknown",
            parameters: (() => {
              try {
                return JSON.parse(c.function?.arguments || "{}") as any;
              } catch {
                return { raw: c.function?.arguments || "" };
              }
            })(),
            streamingOutput: "",
          })),
        };
        out.push(toolCallMsg);
        continue;
      }

      const asst: AssistantTextMessage = {
        role: "assistant",
        type: "text",
        id: msg.id,
        createdAt,
        content: msg.content || "",
      };
      out.push(asst);
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id || "unknown";
      const toolName = toolNameByCallId.get(toolCallId) || "unknown";
      const toolResult: AssistantToolResultMessage = {
        role: "assistant",
        type: "tool_result",
        id: msg.id,
        createdAt,
        toolName,
        toolCallId,
        result: {
          tool_name: toolName,
          result: msg.content || "",
          display_preference: "Default",
        },
        isError: false,
      };
      out.push(toolResult);
      continue;
    }
  }

  // Ensure we always have at least one message-less session - UI can still render.
  // The "sessionId" param is currently unused but kept for future mapping needs.
  void sessionId;
  return out;
};

export interface ChatSlice {
  // State (backend session list)
  chats: ChatItem[];
  currentChatId: string | null;
  latestActiveChatId: string | null;
  processingChats: Set<string>;
  autoGenerateTitles: boolean;
  isUpdatingAutoTitlePreference: boolean;
  // parentSessionId -> childSessionId -> progress
  subSessionsByParent: Record<
    string,
    Record<
      string,
      {
        title?: string;
        status?: string;
        error?: string;
        lastHeartbeatAt?: string;
        lastEventAt?: string;
        // Small rolling preview of child output (token stream).
        outputPreview?: string;
      }
    >
  >;

  // Actions
  addChat: (chat: Omit<ChatItem, "id">) => Promise<string>;
  selectChat: (chatId: string | null) => void;
  deleteChat: (chatId: string) => Promise<void>;
  deleteChats: (chatIds: string[]) => Promise<void>;
  updateChat: (chatId: string, updates: Partial<ChatItem>) => void;
  pinChat: (chatId: string) => void;
  unpinChat: (chatId: string) => void;

  addMessage: (chatId: string, message: Message) => Promise<void>;
  setMessages: (chatId: string, messages: Message[]) => void;
  updateMessage: (
    chatId: string,
    messageId: string,
    updates: Partial<Message>,
  ) => void;
  deleteMessage: (chatId: string, messageId: string) => void;

  loadChats: () => Promise<void>;
  refreshChats: () => Promise<void>;
  loadChatHistory: (
    chatId: string,
    options?: {
      mode?: "replace" | "monotonic";
      retries?: number;
      retryDelayMs?: number;
      // When true, retry while backend history ends with a user message.
      // This helps avoid a race where SSE emits "complete" before the session is persisted.
      waitForAssistant?: boolean;
    },
  ) => Promise<void>;
  upsertSubSessionProgress: (
    parentSessionId: string,
    childSessionId: string,
    patch: Partial<{
      title?: string;
      status?: string;
      error?: string;
      lastHeartbeatAt?: string;
      lastEventAt?: string;
      outputPreview?: string;
    }>,
  ) => void;
  clearSubSessionProgress: (parentSessionId: string, childSessionId: string) => void;

  setChatProcessing: (chatId: string, isProcessing: boolean) => void;
  isChatProcessing: (chatId: string) => boolean;
  setAutoGenerateTitlesPreference: (enabled: boolean) => Promise<void>;
}

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (
  set,
  get,
) => ({
  chats: [],
  currentChatId: null,
  latestActiveChatId: null,
  processingChats: new Set<string>(),
  autoGenerateTitles: true,
  isUpdatingAutoTitlePreference: false,
  subSessionsByParent: {},

  addChat: async (chatData) => {
    const title = (chatData.title || "New Session").trim();
    const basePrompt = chatData.config?.baseSystemPrompt?.trim() || "";

    const created = await agentClient.createSession({
      title,
      system_prompt: basePrompt || undefined,
      model: undefined,
    });

    const newChat: ChatItem = {
      ...sessionSummaryToChatItem(created.session),
      title,
      config: {
        ...chatData.config,
        // If the caller provided a base prompt, keep it; otherwise fall back.
        baseSystemPrompt: basePrompt || DEFAULT_BASE_SYSTEM_PROMPT,
      },
      messages: [],
      currentInteraction: null,
    };

    set((state) => {
      const chats = [newChat, ...state.chats.filter((c) => c.id !== newChat.id)];
      return {
        ...state,
        chats,
        currentChatId: newChat.id,
        latestActiveChatId: newChat.id,
      };
    });

    return newChat.id;
  },

  selectChat: (chatId) => {
    const prev = get();
    if (prev.currentChatId === chatId && prev.latestActiveChatId === chatId) {
      return;
    }
    set({ currentChatId: chatId, latestActiveChatId: chatId });
  },

  deleteChat: async (chatId) => {
    try {
      await agentClient.deleteSession(chatId);
    } catch (error) {
      console.error(`[ChatSlice] Failed to delete backend session ${chatId}:`, error);
    }

    set((state) => {
      const toDelete = new Set<string>();
      for (const chat of state.chats) {
        if (chat.id === chatId) toDelete.add(chat.id);
        if (chat.rootSessionId === chatId) toDelete.add(chat.id);
      }

      const newChats = state.chats.filter((c) => !toDelete.has(c.id));
      const nextCurrent =
        state.currentChatId && toDelete.has(state.currentChatId)
          ? null
          : state.currentChatId;
      const nextLatest =
        state.latestActiveChatId && toDelete.has(state.latestActiveChatId)
          ? (newChats[0]?.id ?? null)
          : state.latestActiveChatId;

      return {
        ...state,
        chats: newChats,
        currentChatId: nextCurrent,
        latestActiveChatId: nextLatest,
      };
    });
  },

  deleteChats: async (chatIds) => {
    for (const id of chatIds) {
      await get().deleteChat(id);
    }
  },

  updateChat: (chatId, updates) => {
    set((state) => {
      const chats = state.chats.map((chat) =>
        chat.id === chatId ? { ...chat, ...updates } : chat,
      );
      return { ...state, chats };
    });

    // Best-effort backend patch for title/pin updates.
    const patch: any = {};
    if (typeof (updates as any).title === "string") {
      patch.title = (updates as any).title;
    }
    if (typeof (updates as any).pinned === "boolean") {
      patch.pinned = (updates as any).pinned;
    }
    if (Object.keys(patch).length > 0) {
      agentClient.patchSession(chatId, patch).catch((e) => {
        console.warn(`[ChatSlice] Failed to patch session ${chatId}:`, e);
      });
    }
  },

  pinChat: (chatId) => {
    get().updateChat(chatId, { pinned: true });
  },

  unpinChat: (chatId) => {
    get().updateChat(chatId, { pinned: false });
  },

  setMessages: (chatId, messages) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (chat) {
      get().updateChat(chatId, { messages });
    }
  },

  addMessage: async (chatId, message) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;
    const updatedMessages = [...chat.messages, message];
    get().updateChat(chatId, { messages: updatedMessages });
  },

  updateMessage: (chatId, messageId, updates) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;

    const updatedMessages = chat.messages.map((msg) => {
      if (msg.id !== messageId) return msg;
      const updatedMsg = { ...(msg as any) };
      Object.keys(updates).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(updatedMsg, key)) {
          (updatedMsg as Record<string, unknown>)[key] = (
            updates as Record<string, unknown>
          )[key];
        }
      });
      return updatedMsg as Message;
    });

    get().updateChat(chatId, { messages: updatedMessages });
  },

  deleteMessage: (chatId, messageId) => {
    const chat = get().chats.find((c) => c.id === chatId);
    if (!chat) return;
    const updatedMessages = chat.messages.filter((msg) => msg.id !== messageId);
    get().updateChat(chatId, { messages: updatedMessages });
  },

  refreshChats: async () => {
    const list = await agentClient.listSessions();
    const next = list.sessions.map(sessionSummaryToChatItem);
    set((state) => {
      // Preserve in-memory messages when possible.
      const prevById = new Map(state.chats.map((c) => [c.id, c]));
      const merged = next.map((c) => {
        const prev = prevById.get(c.id);
        return prev ? { ...c, messages: prev.messages, config: prev.config } : c;
      });
      return { ...state, chats: merged };
    });
  },

  loadChats: async () => {
    const storedAutoTitles = localStorage.getItem(AUTO_TITLE_KEY);
    const autoGenerateTitles =
      storedAutoTitles === null
        ? get().autoGenerateTitles
        : storedAutoTitles === "true";

    let list = await agentClient.listSessions();
    if (!list.sessions || list.sessions.length === 0) {
      const created = await agentClient.createSession({
        title: "New Session",
        system_prompt: DEFAULT_BASE_SYSTEM_PROMPT || undefined,
      });
      list = { sessions: [created.session] };
    }

    const chats = list.sessions.map(sessionSummaryToChatItem);
    const currentChatId = chats[0]?.id ?? null;

    set({
      chats,
      latestActiveChatId: currentChatId,
      currentChatId,
      processingChats: new Set<string>(),
      autoGenerateTitles,
    });

    if (currentChatId) {
      // Lazy load history for the initial session.
      await get().loadChatHistory(currentChatId);
    }
  },

  loadChatHistory: async (chatId, options) => {
    const mode = options?.mode ?? "replace";
    const retries = Math.max(0, options?.retries ?? 0);
    const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 0);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        // Avoid spurious backend calls when the UI layout references a stale session id.
        // (e.g. after backend reset or manual data cleanup)
        const chat = get().chats.find((c) => c.id === chatId);
        if (!chat) return;

        const history = await agentClient.getHistory(chatId);

        const lastRole = history.messages[history.messages.length - 1]?.role;
        if (
          options?.waitForAssistant &&
          lastRole === "user" &&
          attempt < retries
        ) {
          // Backoff to give the backend time to persist the assistant reply.
          const delay = retryDelayMs > 0 ? retryDelayMs * (attempt + 1) : 200 * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const nextMessages = mapHistoryMessagesToUi(chatId, history.messages);

        if (mode === "monotonic") {
          const prevMessages = chat.messages || [];
          const prevLen = prevMessages.length;
          const nextLen = nextMessages.length;
          const nextLastRole = nextMessages[nextMessages.length - 1]?.role;
          const prevLastRole = prevMessages[prevMessages.length - 1]?.role;

          // Avoid wiping newer UI state with a stale backend snapshot.
          const shouldReplace =
            nextLen >= prevLen ||
            // If backend has a terminal-ish last role (assistant/tool/system), it's safe to replace.
            (typeof nextLastRole === "string" && nextLastRole !== "user") ||
            // If backend progressed past a "user-only tail", prefer backend.
            (prevLastRole === "user" && nextLastRole !== "user");

          if (!shouldReplace) {
            get().updateChat(chatId, {
              messageCount: Math.max(chat.messageCount ?? 0, history.messages.length),
            });
            return;
          }
        }

        get().updateChat(chatId, {
          messages: nextMessages,
          messageCount: history.messages.length,
        });
        return;
      } catch (error) {
        if (attempt >= retries) {
          console.warn(`[ChatSlice] Failed to load history for ${chatId}:`, error);
          return;
        }
        const delay = retryDelayMs > 0 ? retryDelayMs * (attempt + 1) : 200 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  },

  upsertSubSessionProgress: (parentSessionId, childSessionId, patch) => {
    set((state) => {
      const existingParent = state.subSessionsByParent[parentSessionId] || {};
      const existingChild = existingParent[childSessionId] || {};
      const nextParent = {
        ...existingParent,
        [childSessionId]: { ...existingChild, ...patch },
      };
      return {
        subSessionsByParent: {
          ...state.subSessionsByParent,
          [parentSessionId]: nextParent,
        },
      };
    });
  },

  clearSubSessionProgress: (parentSessionId, childSessionId) => {
    set((state) => {
      const existingParent = state.subSessionsByParent[parentSessionId];
      if (!existingParent || !existingParent[childSessionId]) return {};
      const { [childSessionId]: _removed, ...rest } = existingParent;
      return {
        subSessionsByParent: {
          ...state.subSessionsByParent,
          [parentSessionId]: rest,
        },
      };
    });
  },

  setChatProcessing: (chatId, isProcessing) => {
    set((state) => {
      const processingChats = new Set(state.processingChats);
      if (isProcessing) processingChats.add(chatId);
      else processingChats.delete(chatId);
      return { processingChats };
    });
  },

  isChatProcessing: (chatId) => get().processingChats.has(chatId),

  setAutoGenerateTitlesPreference: async (enabled) => {
    const previousValue = get().autoGenerateTitles;
    set({ autoGenerateTitles: enabled, isUpdatingAutoTitlePreference: true });
    try {
      localStorage.setItem(AUTO_TITLE_KEY, String(enabled));
    } catch (error) {
      console.warn("[ChatSlice] Failed to update auto-title preference:", error);
      set({ autoGenerateTitles: previousValue });
      throw error;
    } finally {
      set({ isUpdatingAutoTitlePreference: false });
    }
  },
});
