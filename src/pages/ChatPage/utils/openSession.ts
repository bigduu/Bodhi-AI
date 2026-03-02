import { findLeafIdByChatId, useUILayoutStore } from "@shared/store/uiLayoutStore";
import { uiLayoutDebug } from "@shared/utils/debugFlags";

import { useAppStore } from "../store";

type OpenSessionOptions = {
  // For schedule-created sessions, the UI may not be subscribed to background events.
  // Let callers force a one-time index refresh before loading history.
  forceRefreshIndex?: boolean;
  // Load full history regardless of current messageCount (useful when session summary is stale).
  forceLoadHistory?: boolean;
  // If the backend says the session is currently running, enable SSE subscription.
  subscribeIfRunning?: boolean;
  // Force a (best-effort) SSE subscription even when `isRunning` is false.
  // This only works well if the backend emits an immediate terminal event for completed sessions.
  forceSubscribe?: boolean;
};

const ensureSessionVisibleAndLoaded = async (
  sessionId: string,
  options?: OpenSessionOptions,
) => {
  const store = useAppStore.getState();

  const wasMissing = !store.chats.some((c) => c.id === sessionId);

  // If the session isn't in the in-memory list (e.g. created by schedules in background),
  // refresh from backend so Sidebar can render it.
  if (options?.forceRefreshIndex || wasMissing) {
    try {
      await store.refreshChats();
    } catch (e) {
      console.warn("[openSession] refreshChats failed:", e);
    }
  }

  const chat = useAppStore.getState().chats.find((c) => c.id === sessionId);
  if (!chat) return;

  // Lazy-load history:
  // - forced (schedule sessions; summary can be stale), or
  // - session just got pulled into memory (avoid requiring a full page reload), or
  // - when backend indicates there is content.
  if (
    options?.forceLoadHistory ||
    wasMissing ||
    ((chat.messages?.length || 0) === 0 && (chat.messageCount || 0) > 0)
  ) {
    try {
      await store.loadChatHistory(sessionId);
    } catch (e) {
      console.warn("[openSession] loadChatHistory failed:", e);
    }
  }

  // Optionally enable SSE subscription when the backend runner is active.
  // This is best-effort and won't start execution.
  if (options?.forceSubscribe) {
    store.setChatProcessing(sessionId, true);
    return;
  }

  const shouldSubscribeIfRunning = options?.subscribeIfRunning ?? true;
  if (shouldSubscribeIfRunning && chat.isRunning) {
    store.setChatProcessing(sessionId, true);
  }
};

/**
 * Open a session in the UI layout (multi-pane) and set it as the global selection.
 *
 * Important: some callers (e.g. buttons inside ChatView) run inside a pane whose
 * onMouseDownCapture may also set selection. We always assign the leaf mapping first,
 * then update the global selection to avoid "sidebar selected but view not switched".
 */
export const openSession = (sessionId: string, options?: OpenSessionOptions) => {
  const {
    activeLeafId,
    leafChatIds,
    setLeafChatId,
    setActiveLeafId,
  } = useUILayoutStore.getState();

  const existingLeafId = findLeafIdByChatId(leafChatIds, sessionId);
  const activeLeafChatId = leafChatIds[activeLeafId] ?? null;

  uiLayoutDebug("openSession (input)", {
    activeLeafId,
    activeLeafChatId,
    sessionId,
    existingLeafId,
  });

  if (existingLeafId) {
    if (existingLeafId === activeLeafId) {
      // Already visible in the focused pane.
      uiLayoutDebug("openSession (decision)", {
        action: "noop_already_active",
        leafId: activeLeafId,
        sessionId,
      });
    } else if (!activeLeafChatId) {
      // Prefer filling empty active pane even if session is open elsewhere.
      setLeafChatId(activeLeafId, sessionId);
      setActiveLeafId(activeLeafId);
      uiLayoutDebug("openSession (decision)", {
        action: "assign_to_empty_active_leaf",
        fromLeafId: existingLeafId,
        toLeafId: activeLeafId,
        sessionId,
      });
    } else {
      // Focus the pane where the session already exists.
      setActiveLeafId(existingLeafId);
      uiLayoutDebug("openSession (decision)", {
        action: "focus_existing_leaf",
        leafId: existingLeafId,
        sessionId,
      });
    }
  } else {
    setLeafChatId(activeLeafId, sessionId);
    uiLayoutDebug("openSession (decision)", {
      action: "assign_to_active_leaf",
      leafId: activeLeafId,
      sessionId,
    });
  }

  useAppStore.getState().selectChat(sessionId);

  // Best-effort background sync so Sidebar + view can render even for sessions
  // that were created while the UI wasn't watching.
  void ensureSessionVisibleAndLoaded(sessionId, options);
};
