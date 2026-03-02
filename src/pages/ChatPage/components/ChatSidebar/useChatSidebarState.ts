import { useCallback, useMemo, useState } from "react";
import { Modal } from "antd";

import {
  getChatCountByDate,
  getChatIdsByDate,
  getDateGroupKeyForChat,
  getSortedDateKeys,
  groupChatsByDate,
} from "../../utils/chatUtils";
import { useSettingsViewStore } from "../../../../shared/store/settingsViewStore";
import { useChatTitleGeneration } from "../../hooks/useChatManager/useChatTitleGeneration";
import { selectChatById, useAppStore } from "../../store";
import type { ChatItem, UserSystemPrompt } from "../../types/chat";
import { useUILayoutStore } from "@shared/store/uiLayoutStore";
import { openSession } from "../../utils/openSession";

export const useChatSidebarState = () => {
  const chats = useAppStore((state) => state.chats);
  const currentChatId = useAppStore((state) => state.currentChatId);
  const deleteChat = useAppStore((state) => state.deleteChat);
  const deleteChats = useAppStore((state) => state.deleteChats);
  const pinChat = useAppStore((state) => state.pinChat);
  const unpinChat = useAppStore((state) => state.unpinChat);
  const updateChat = useAppStore((state) => state.updateChat);
  const addChat = useAppStore((state) => state.addChat);
  const lastSelectedPromptId = useAppStore(
    (state) => state.lastSelectedPromptId,
  );
  const systemPrompts = useAppStore((state) => state.systemPrompts);

  const sidebarCollapsed = useUILayoutStore((s) => s.sidebar.collapsed);
  const setSidebarCollapsed = useUILayoutStore((s) => s.setSidebarCollapsed);
  const clearChatFromAllLeaves = useUILayoutStore(
    (s) => s.clearChatFromAllLeaves,
  );

  const { generateChatTitle, titleGenerationState } = useChatTitleGeneration({
    chats,
    updateChat,
  });

  const createNewChat = useCallback(
    async (title?: string, options?: Partial<Omit<ChatItem, "id">>) => {
      const selectedPrompt = systemPrompts.find(
        (p) => p.id === lastSelectedPromptId,
      );

      const systemPromptId =
        selectedPrompt?.id ||
        (systemPrompts.length > 0
          ? systemPrompts.find((p) => p.id === "general_assistant")?.id ||
            systemPrompts[0].id
          : "");

      const newChatData: Omit<ChatItem, "id"> = {
        title: title || "New Session",
        createdAt: Date.now(),
        messages: [],
        config: {
          systemPromptId,
          baseSystemPrompt:
            selectedPrompt?.content ||
            (systemPrompts.length > 0
              ? systemPrompts.find((p) => p.id === "general_assistant")
                  ?.content || systemPrompts[0].content
              : ""),
          lastUsedEnhancedPrompt: null,
        },
        currentInteraction: null,
        ...options,
      };
      const newChatId = await addChat(newChatData);

      // Assign the new chat to the currently active pane (read from store to
      // avoid stale closures when the user just split panes).
      const { activeLeafId: targetLeafId } = useUILayoutStore.getState();
      useUILayoutStore.getState().setLeafChatId(targetLeafId, newChatId);
      useUILayoutStore.getState().setActiveLeafId(targetLeafId);
    },
    [
      addChat,
      lastSelectedPromptId,
      systemPrompts,
    ],
  );

  const [isNewChatSelectorOpen, setIsNewChatSelectorOpen] = useState(false);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(
    new Set(["Today"]),
  );

  const currentChat = useAppStore(selectChatById(currentChatId));

  const currentDateGroupKey = useMemo(() => {
    return currentChat ? getDateGroupKeyForChat(currentChat) : null;
  }, [currentChat]);

  // Always keep the currently selected chat's group expanded, without causing
  // an effect-driven setState loop.
  const expandedKeys = useMemo(() => {
    const next = new Set(expandedDates);
    if (currentDateGroupKey) {
      next.add(currentDateGroupKey);
    }
    return Array.from(next);
  }, [currentDateGroupKey, expandedDates]);

  const handleCollapseChange = (keys: string | string[]) => {
    const next = new Set(Array.isArray(keys) ? keys : [keys]);
    setExpandedDates((prev) => {
      if (prev.size !== next.size) return next;
      for (const k of next) {
        if (!prev.has(k)) return next;
      }
      return prev;
    });
  };

  // Folder model: sidebar groups only root sessions by date.
  // Child sessions are rendered nested under their root.
  const rootSessions = useMemo(
    () => chats.filter((c) => c.kind !== "child"),
    [chats],
  );

  const childrenByRoot = useMemo(() => {
    const map: Record<string, ChatItem[]> = {};
    for (const c of chats) {
      if (c.kind !== "child") continue;
      const rootId = c.parentSessionId || c.rootSessionId;
      if (!rootId) continue;
      if (!map[rootId]) map[rootId] = [];
      map[rootId].push(c);
    }
    Object.keys(map).forEach((rootId) => {
      map[rootId].sort((a, b) => {
        // pinned first, then most recently updated
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const aTime = Date.parse(a.updatedAt || "") || a.createdAt || 0;
        const bTime = Date.parse(b.updatedAt || "") || b.createdAt || 0;
        return bTime - aTime;
      });
    });
    return map;
  }, [chats]);

  const groupedChatsByDate = groupChatsByDate(rootSessions);
  const sortedDateKeys = getSortedDateKeys(groupedChatsByDate);

  const handlePinChat = useCallback(
    (chatId: string) => {
      pinChat(chatId);
      // Pinned chats move into the "Pinned" group; expand it so the chat doesn't
      // appear to "disappear" immediately after pinning.
      setExpandedDates((prev) => {
        if (prev.has("Pinned")) return prev;
        const next = new Set(prev);
        next.add("Pinned");
        return next;
      });
    },
    [pinChat],
  );

  const handleUnpinChat = useCallback(
    (chatId: string) => {
      // Compute the destination group key (best-effort) so the chat remains visible.
      const chat = chats.find((c) => c.id === chatId);
      const nextGroupKey = chat
        ? getDateGroupKeyForChat({ ...chat, pinned: false })
        : null;

      unpinChat(chatId);

      if (!nextGroupKey) return;
      setExpandedDates((prev) => {
        if (prev.has(nextGroupKey)) return prev;
        const next = new Set(prev);
        next.add(nextGroupKey);
        return next;
      });
    },
    [chats, unpinChat],
  );

  const handleDelete = (chatId: string) => {
    Modal.confirm({
      title: "Delete Session",
      content:
        "Are you sure you want to delete this session? This action cannot be undone.",
      okText: "Delete",
      okType: "danger",
      cancelText: "Cancel",
      onOk: () => {
        clearChatFromAllLeaves(chatId);
        deleteChat(chatId);
      },
    });
  };

  const openSettings = useSettingsViewStore((state) => state.open);

  const handleOpenSettings = () => {
    openSettings("chat");
  };

  const handleEditTitle = (chatId: string, newTitle: string) => {
    updateChat(chatId, { title: newTitle });
  };

  const handleGenerateTitle = async (chatId: string) => {
    try {
      await generateChatTitle(chatId, { force: true });
    } catch (error) {
      console.error("Failed to generate title:", error);
    }
  };

  const handleDeleteByDate = (dateKey: string) => {
    const chatIds = getChatIdsByDate(groupedChatsByDate, dateKey);
    const chatCount = getChatCountByDate(groupedChatsByDate, dateKey);

    Modal.confirm({
      title: `Delete all sessions from ${dateKey}`,
      content: `Are you sure you want to delete all ${chatCount} sessions from ${dateKey}? This action cannot be undone.`,
      okText: "Delete",
      okType: "danger",
      cancelText: "Cancel",
      onOk: () => {
        chatIds.forEach((id) => clearChatFromAllLeaves(id));
        deleteChats(chatIds);
      },
    });
  };

  const handleNewChat = () => {
    setIsNewChatSelectorOpen(true);
  };

  const handleNewChatSelectorClose = () => {
    setIsNewChatSelectorOpen(false);
  };

  const handleSystemPromptSelect = async (preset: UserSystemPrompt) => {
    try {
      await createNewChat(`New Session - ${preset.name}`, {
        config: {
          systemPromptId: preset.id,
          baseSystemPrompt: preset.content,
          lastUsedEnhancedPrompt: null,
        },
      });
      setIsNewChatSelectorOpen(false);
    } catch (error) {
      console.error("Failed to create chat:", error);
      Modal.error({
        title: "Failed to Create Chat",
        content:
          error instanceof Error
            ? error.message
            : "Unknown error, please try again",
      });
    }
  };

  const selectChat = useCallback((chatId: string) => openSession(chatId), []);

  // Root -> expanded children state (UI-only)
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(new Set());

  const expandedRootIds = useMemo(() => {
    const next = new Set(expandedRoots);

    // Ensure current selection is visible.
    const current = chats.find((c) => c.id === currentChatId);
    if (current) {
      const rootId =
        current.kind === "child"
          ? current.parentSessionId || current.rootSessionId
          : current.id;
      if (rootId) next.add(rootId);
    }

    // Pinned child implies its root should stay expanded (pin == "keep visible").
    for (const c of chats) {
      if (c.kind === "child" && c.pinned) {
        const rootId = c.parentSessionId || c.rootSessionId;
        if (rootId) next.add(rootId);
      }
    }

    return next;
  }, [chats, currentChatId, expandedRoots]);

  const toggleRootExpanded = useCallback((rootId: string) => {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }, []);

  return {
    chats: rootSessions,
    childrenByRoot,
    expandedRootIds,
    toggleRootExpanded,
    collapsed: sidebarCollapsed,
    currentChatId,
    expandedKeys,
    groupedChatsByDate,
    handleCollapseChange,
    handleDelete,
    handleDeleteByDate,
    handleEditTitle,
    handleGenerateTitle,
    handleNewChat,
    handleNewChatSelectorClose,
    handleOpenSettings,
    handleSystemPromptSelect,
    isNewChatSelectorOpen,
    pinChat: handlePinChat,
    selectChat,
    setCollapsed: setSidebarCollapsed,
    sortedDateKeys,
    systemPrompts,
    titleGenerationState,
    unpinChat: handleUnpinChat,
  };
};
