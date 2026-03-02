import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStoreState: any = {
  currentChatId: null,
  chats: [],
  deleteMessage: vi.fn(),
  updateChat: vi.fn(),
  loadChatHistory: vi.fn(),
  subSessionsByParent: {},
  selectChat: vi.fn(),
  setChatProcessing: vi.fn(),
  isChatProcessing: vi.fn(() => false),
  processingChats: new Set<string>(),
  tokenUsages: {},
  truncationOccurred: {},
  segmentsRemoved: {},
};

vi.mock("antd", async () => {
  const actual = await vi.importActual<any>("antd");
  return {
    ...actual,
    Grid: {
      ...actual.Grid,
      useBreakpoint: () => ({ xs: false }),
    },
  };
});

vi.mock("../../store", () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mockStoreState) => unknown) =>
      selector(mockStoreState),
    {
      subscribe: vi.fn(() => vi.fn()), // Return unsubscribe function
      getState: vi.fn(() => mockStoreState),
      setState: vi.fn(),
    },
  ),
  selectChatById:
    (chatId: string | null) => (state: typeof mockStoreState) =>
      chatId ? state.chats.find((c: any) => c.id === chatId) || null : null,
}));

vi.mock("../ChatView/useChatViewMessages", () => ({
  useChatViewMessages: () => ({
    systemPromptMessage: null,
    renderableMessages: [],
    convertRenderableEntry: vi.fn(),
  }),
}));

vi.mock("../ChatView/useChatViewScroll", () => ({
  useChatViewScroll: () => ({
    handleMessagesScroll: vi.fn(),
    resetUserScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToTop: vi.fn(),
    showScrollToBottom: false,
    showScrollToTop: true,
  }),
}));

vi.mock("../ChatView/ChatMessagesList", () => ({
  ChatMessagesList: () => <div data-testid="chat-messages-list" />,
}));

vi.mock("../ChatView/ChatInputArea", () => ({
  ChatInputArea: () => <div data-testid="chat-input-area" />,
}));

vi.mock("../ChatView/SubSessionsPanel", () => ({
  SubSessionsPanel: () => null,
}));

vi.mock("@components/QuestionDialog", () => ({
  QuestionDialog: () => null,
}));

vi.mock("@components/TodoList", () => ({
  TodoList: () => null,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}));

import { ChatView } from "../ChatView";

describe("ChatView scroll button group", () => {
  beforeEach(() => {
    mockStoreState.deleteMessage.mockReset();
    mockStoreState.updateChat.mockReset();
  });

  it("renders a FloatButton.Group with the expected fixed position", () => {
    const { container } = render(<ChatView />);
    const group = container.querySelector(".ant-float-btn-group");

    expect(group).toBeTruthy();
    expect((group as HTMLElement).style.bottom).toBe("180px");
    expect((group as HTMLElement).style.right).toBe("32px");
  });
});
