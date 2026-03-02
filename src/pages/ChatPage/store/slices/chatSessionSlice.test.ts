import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { ChatItem } from "../../types/chat";
import { createChatSlice, type ChatSlice } from "./chatSessionSlice";

const { deleteSessionMock } = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(),
}));

vi.mock("../../services/AgentService", () => ({
  AgentClient: {
    getInstance: vi.fn(() => ({
      deleteSession: deleteSessionMock,
      listSessions: vi.fn(async () => ({ sessions: [] })),
      createSession: vi.fn(async () => ({
        session: {
          id: "session-1",
          kind: "root",
          title: "New Session",
          pinned: false,
          root_session_id: "session-1",
          spawn_depth: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
          message_count: 0,
          has_attachments: false,
          is_running: false,
        },
      })),
      patchSession: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => ({ session_id: "session-1", messages: [] })),
    })),
  },
}));

const createChat = (id: string): ChatItem => ({
  id,
  title: `Chat ${id}`,
  createdAt: Date.now(),
  pinned: false,
  messages: [],
  config: {
    systemPromptId: "general_assistant",
    baseSystemPrompt: "Base prompt",
    lastUsedEnhancedPrompt: null,
  },
  currentInteraction: null,
});

const createTestStore = (): StoreApi<ChatSlice> => {
  const sliceCreator = createChatSlice as unknown as (
    set: StoreApi<ChatSlice>["setState"],
    get: StoreApi<ChatSlice>["getState"],
    api: StoreApi<ChatSlice>,
  ) => ChatSlice;

  return createStore<ChatSlice>()((set, get, api) =>
    sliceCreator(set, get, api),
  );
};

describe("chatSessionSlice deletion", () => {
  beforeEach(() => {
    deleteSessionMock.mockReset();
    deleteSessionMock.mockResolvedValue(undefined);
  });

  it("deletes the linked backend session before removing a chat", async () => {
    const store = createTestStore();
    const chat = createChat("session-1");

    store.setState((state) => ({
      ...state,
      chats: [chat],
      currentChatId: chat.id,
      latestActiveChatId: chat.id,
    }));

    await store.getState().deleteChat(chat.id);

    expect(deleteSessionMock).toHaveBeenCalledWith("session-1");
    expect(store.getState().chats).toHaveLength(0);
  });

  it("still removes chat locally when backend deletion fails", async () => {
    const store = createTestStore();
    const chat = createChat("session-1");
    deleteSessionMock.mockRejectedValueOnce(new Error("delete failed"));

    store.setState((state) => ({
      ...state,
      chats: [chat],
      currentChatId: chat.id,
      latestActiveChatId: chat.id,
    }));

    await expect(store.getState().deleteChat(chat.id)).resolves.toBeUndefined();

    expect(deleteSessionMock).toHaveBeenCalledWith("session-1");
    expect(store.getState().chats).toHaveLength(0);
  });

  it("deletes all linked backend sessions when removing multiple chats", async () => {
    const store = createTestStore();
    const chats = [
      createChat("session-1"),
      createChat("session-2"),
      createChat("session-3"),
    ];

    store.setState((state) => ({
      ...state,
      chats,
      currentChatId: chats[0].id,
      latestActiveChatId: chats[0].id,
    }));

    await store.getState().deleteChats(chats.map((chat) => chat.id));

    expect(deleteSessionMock).toHaveBeenCalledTimes(3);
    expect(deleteSessionMock).toHaveBeenNthCalledWith(1, "session-1");
    expect(deleteSessionMock).toHaveBeenNthCalledWith(2, "session-2");
    expect(deleteSessionMock).toHaveBeenNthCalledWith(3, "session-3");
    expect(store.getState().chats).toHaveLength(0);
  });
});
