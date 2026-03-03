import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAgentEventSubscription } from "../useAgentEventSubscription";
import { AgentClient } from "../../services/chat/AgentService";

// Type for mock selectors
type MockSelector = (state: any) => any;

// Mock dependencies - all variables must be inside the factory function
vi.mock("../../pages/ChatPage/store", () => {
  const mockStore = Object.assign(vi.fn(), {
    getState: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    setState: vi.fn(),
    destroy: vi.fn(),
  });
  return { useAppStore: mockStore };
});

vi.mock("../../services/chat/AgentService", () => {
  // SSE subscriptions are long-lived; default to a never-resolving promise so the hook
  // doesn't interpret the stream as "ended" and attempt to reconnect in tests.
  const mockSubscribeToEvents = vi.fn().mockImplementation(
    () => new Promise<void>(() => {}),
  );
  return {
    AgentClient: class MockAgentClient {
      subscribeToEvents = mockSubscribeToEvents;
    },
  };
});

// Mock state factory
const createMockState = (overrides: Partial<any> = {}) => ({
  chats: [
    {
      id: "session-1",
      messages: [],
    },
  ],
  processingChats: new Set<string>(),
  addMessage: vi.fn(),
  setChatProcessing: vi.fn(),
  updateTokenUsage: vi.fn(),
  setTruncationInfo: vi.fn(),
  updateChat: vi.fn(),
  updateMessage: vi.fn(),
  setTodoList: vi.fn(),
  updateTodoListDelta: vi.fn(),
  setEvaluationState: vi.fn(),
  clearEvaluationState: vi.fn(),
  upsertSubSessionProgress: vi.fn(),
  clearSubSessionProgress: vi.fn(),
  refreshChats: vi.fn(),
  loadChatHistory: vi.fn(),
  subSessionsByParent: {},
  ...overrides,
});

describe("useAgentEventSubscription", () => {
  let mockSubscribeToEvents: ReturnType<typeof vi.fn>;
  let mockSetChatProcessing: ReturnType<typeof vi.fn>;
  let mockAddMessage: ReturnType<typeof vi.fn>;
  let mockState: any;
  let mockStore: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockSetChatProcessing = vi.fn();
    mockAddMessage = vi.fn();

    mockState = createMockState({
      addMessage: mockAddMessage,
      setChatProcessing: mockSetChatProcessing,
    });

    // Import the mocked modules to get the mocks
    const storeModule = await import("../../pages/ChatPage/store");
    mockStore = storeModule.useAppStore;

    // Set up mock implementations
    mockStore.mockImplementation((selector: MockSelector) => selector(mockState));
    mockStore.getState.mockReturnValue(mockState);

    // Get the subscribeToEvents mock from the AgentClient instance
    const client = new AgentClient();
    mockSubscribeToEvents = client.subscribeToEvents as ReturnType<typeof vi.fn>;
    mockSubscribeToEvents.mockImplementation(() => new Promise<void>(() => {}));
  });

  it("should not subscribe when processingChats is empty", () => {
    renderHook(() => useAgentEventSubscription());

    expect(mockSubscribeToEvents).not.toHaveBeenCalled();
  });

  it("should subscribe when chat is processing and session exists", async () => {
    mockState.processingChats = new Set(["session-1"]); // Session is processing
    mockStore.getState.mockReturnValue(mockState);
    mockSubscribeToEvents.mockImplementation(() => new Promise<void>(() => {}));

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          onToken: expect.any(Function),
          onComplete: expect.any(Function),
          onError: expect.any(Function),
        }),
        expect.any(AbortController),
      );
    });
  });

  it("should unsubscribe when isProcessing becomes false", async () => {
    mockState.processingChats = new Set(["session-1"]); // Session is processing
    mockStore.getState.mockReturnValue(mockState);
    mockSubscribeToEvents.mockResolvedValue(undefined);

    const { rerender } = renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });

    // Change back to not processing
    mockState.processingChats = new Set();
    mockStore.getState.mockReturnValue(mockState);
    rerender();

    // Should abort the subscription
    // (Hard to test directly without access to abort controller)
  });

  it("should handle subscription errors and reset state", async () => {
    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockSubscribeToEvents.mockRejectedValue(new Error("Connection failed"));

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        "[useAgentEventSubscription] Subscription error:",
        expect.any(Error),
      );

      // Should reset processing state on error
      expect(mockSetChatProcessing).toHaveBeenCalledWith("session-1", false);
    });

    consoleSpy.mockRestore();
  });

  it("should handle onComplete and save message", async () => {
    let completeHandler: any;
    mockSubscribeToEvents.mockImplementation(
      async (_sessionId: string, handlers: any) => {
        completeHandler = handlers.onComplete;
      },
    );

    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });

    // Simulate complete event
    await act(async () => {
      if (completeHandler) {
        await completeHandler();
      }
    });

    await waitFor(() => {
      expect(mockSetChatProcessing).toHaveBeenCalledWith("session-1", false);
    });
  });

  it("should handle onError and show error message", async () => {
    let errorHandler: any;
    mockSubscribeToEvents.mockImplementation(
      async (_sessionId: string, handlers: any) => {
        errorHandler = handlers.onError;
      },
    );

    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });

    // Simulate error event
    await act(async () => {
      if (errorHandler) {
        await errorHandler("Something went wrong");
      }
    });

    await waitFor(() => {
      // Verify that addMessage was called with error content
      expect(mockAddMessage).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          content: expect.stringContaining("Something went wrong"),
          finishReason: "error",
        }),
      );
      expect(mockSetChatProcessing).toHaveBeenCalledWith("session-1", false);
    });
  });

  it("should not create duplicate subscriptions", async () => {
    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);
    mockSubscribeToEvents.mockImplementation(() => new Promise<void>(() => {}));

    const { rerender } = renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
    });

    // Rerender should not create new subscription
    rerender();

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
    });
  });

  it("should reconnect on unexpected AbortError without clearing processing state", async () => {
    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);

    const abortErr = Object.assign(new Error("stream aborted"), {
      name: "AbortError",
    });
    mockSubscribeToEvents
      .mockRejectedValueOnce(abortErr)
      .mockImplementation(() => new Promise<void>(() => {}));

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalledTimes(1);
    });

    // Default backoff starts at 250ms; use a real-time sleep to avoid fake-timer + waitFor edge cases.
    await new Promise((r) => setTimeout(r, 350));

    await waitFor(() => {
      expect(mockSubscribeToEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    expect(mockSetChatProcessing).not.toHaveBeenCalledWith("session-1", false);
  });

  it("should handle token streaming", async () => {
    let tokenHandler: any;
    mockSubscribeToEvents.mockImplementation(
      (_sessionId: string, handlers: any) => {
        tokenHandler = handlers.onToken;
        return new Promise<void>(() => {});
      },
    );

    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });

    // Simulate token events
    act(() => {
      if (tokenHandler) {
        tokenHandler("Hello ");
        tokenHandler("World");
      }
    });

    // Should stream tokens (verified via streamingMessageBus, not mocked here)
  });

  it("should append tool_token output to the matching tool_call card", async () => {
    let capturedHandlers: any;
    mockSubscribeToEvents.mockImplementation(
      (_sessionId: string, handlers: any) => {
        capturedHandlers = handlers;
        return new Promise<void>(() => {});
      },
    );

    const updateMessage = vi.fn(
      (_chatId: string, messageId: string, patch: any) => {
        // Simulate store mutation so subsequent onToolToken calls can append.
        const msg = mockState.chats[0].messages.find((m: any) => m.id === messageId);
        if (!msg) return;
        if (patch?.toolCalls) {
          msg.toolCalls = patch.toolCalls;
        }
      },
    );
    let toolCallMessageId: string | undefined;
    const addMessage = vi.fn((_chatId: string, msg: any) => {
      // Simulate store mutation so onToolToken can find the message.
      toolCallMessageId = msg?.id;
      mockState.chats[0].messages.push(msg);
    });

    mockState = createMockState({
      addMessage,
      updateMessage,
      setChatProcessing: mockSetChatProcessing,
    });

    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);
    mockStore.mockImplementation((selector: MockSelector) => selector(mockState));

    renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
      expect(capturedHandlers).toBeTruthy();
    });

    act(() => {
      capturedHandlers.onToolStart?.("call_1", "claude_code", { project_path: "/tmp" });
    });

    act(() => {
      capturedHandlers.onToolToken?.("call_1", "hello");
      capturedHandlers.onToolToken?.("call_1", " world");
    });

    await waitFor(() => {
      expect(toolCallMessageId).toBeTruthy();
      expect(updateMessage).toHaveBeenCalled();

      const toolMsg = mockState.chats[0].messages.find(
        (m: any) => m.id === toolCallMessageId,
      );
      expect(toolMsg?.toolCalls?.[0]?.streamingOutput).toBe("hello world");
    });
  });

  it("should cleanup subscription on unmount", async () => {
    mockState.processingChats = new Set(["session-1"]);
    mockStore.getState.mockReturnValue(mockState);
    mockSubscribeToEvents.mockImplementation(() => new Promise<void>(() => {}));

    const { unmount } = renderHook(() => useAgentEventSubscription());

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });

    // Unmount should cleanup (abort controller)
    unmount();

    // Cleanup is internal, hard to verify without access to abort controller
  });
});
