import { ChatItem } from "../types/chat";

export const generateChatTitle = (chatNumber: number): string => {
  const now = new Date();
  const date = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `Chat ${chatNumber} - ${date}`;
};

// Date utility functions for chat grouping
export const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.toDateString() === today.toDateString();
};

export const isYesterday = (date: Date): boolean => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return date.toDateString() === yesterday.toDateString();
};

export const isThisWeek = (date: Date): boolean => {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  return date >= startOfWeek && date <= endOfWeek;
};

export const isThisMonth = (date: Date): boolean => {
  const today = new Date();
  return (
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
};

export const getDateGroupKey = (date: Date): string => {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  if (isThisWeek(date)) return "This Week";
  if (isThisMonth(date)) return "This Month";

  // For older dates, group by month
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });
};

export const getDateGroupWeight = (dateKey: string): number => {
  const weights: Record<string, number> = {
    Today: 0,
    Yesterday: 1,
    "This Week": 2,
    "This Month": 3,
  };

  return weights[dateKey] ?? 4; // Older dates get weight 4+
};

export const groupChatsByDate = (
  chats: ChatItem[],
): Record<string, ChatItem[]> => {
  const grouped: Record<string, ChatItem[]> = {};
  // Add pinned group at the top if any pinned chats
  const pinnedChats = chats.filter((chat) => chat.pinned);
  if (pinnedChats.length > 0) {
    grouped["Pinned"] = pinnedChats.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Group scheduled sessions separately so they appear under a special section.
  const scheduledChats = chats.filter(
    (chat) => !chat.pinned && Boolean(chat.createdByScheduleId),
  );
  if (scheduledChats.length > 0) {
    grouped["Scheduled"] = scheduledChats.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Group the rest by date
  chats
    .filter((chat) => !chat.pinned && !chat.createdByScheduleId)
    .forEach((chat) => {
      const date = new Date(chat.createdAt);
      const dateString = date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      if (!grouped[dateString]) {
        grouped[dateString] = [];
      }
      grouped[dateString].push(chat);
    });
  // Sort each group by createdAt in descending order (newest first)
  Object.keys(grouped).forEach((date) => {
    grouped[date].sort((a, b) => b.createdAt - a.createdAt);
  });
  return grouped;
};

/**
 * Group chats by tool category, sort by time within each category
 */
export const groupChatsByToolCategory = (
  chats: ChatItem[],
): Record<string, ChatItem[]> => {
  const grouped: Record<string, ChatItem[]> = {};

  // Handle pinned chats first
  const pinnedChats = chats.filter((chat) => chat.pinned);
  if (pinnedChats.length > 0) {
    grouped["Pinned"] = pinnedChats.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Group non-pinned chats by tool category
  chats
    .filter((chat) => !chat.pinned)
    .forEach((chat) => {
      const category = chat.config.systemPromptId || "General";
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(chat);
    });

  // Sort by time within each category (newest first)
  Object.keys(grouped).forEach((category) => {
    if (category !== "Pinned") {
      grouped[category].sort((a, b) => b.createdAt - a.createdAt);
    }
  });

  return grouped;
};

/**
 * Group chats by date and then by category within each date
 * Returns a nested structure: { dateKey: { category: ChatItem[] } }
 */
export interface DateCategoryGroup {
  [dateKey: string]: {
    [category: string]: ChatItem[];
  };
}

/**
 * Get sorted date keys for consistent ordering
 */
export const getSortedDateKeys = (
  grouped: Record<string, ChatItem[]> | DateCategoryGroup,
): string[] => {
  const getLatestTimestamp = (
    group: ChatItem[] | Record<string, ChatItem[]>,
  ): number => {
    if (Array.isArray(group)) {
      return group.reduce((max, chat) => Math.max(max, chat.createdAt), 0);
    }
    return Object.values(group).reduce((max, chats) => {
      const groupMax = chats.reduce(
        (innerMax, chat) => Math.max(innerMax, chat.createdAt),
        0,
      );
      return Math.max(max, groupMax);
    }, 0);
  };

  return Object.keys(grouped).sort((a, b) => {
    if (a === "Pinned") return -1;
    if (b === "Pinned") return 1;
    if (a === "Scheduled") return -1;
    if (b === "Scheduled") return 1;

    const aGroup = grouped[a];
    const bGroup = grouped[b];
    if (!aGroup || !bGroup) return 0;

    const aTime = getLatestTimestamp(
      aGroup as ChatItem[] | Record<string, ChatItem[]>,
    );
    const bTime = getLatestTimestamp(
      bGroup as ChatItem[] | Record<string, ChatItem[]>,
    );

    if (aTime !== bTime) return bTime - aTime;

    return getDateGroupWeight(a) - getDateGroupWeight(b);
  });
};

/**
 * Get all chat IDs from a specific date group
 */
export const getChatIdsByDate = (
  grouped: Record<string, ChatItem[]>,
  dateKey: string,
): string[] => {
  if (!grouped[dateKey]) return [];
  return grouped[dateKey].map((chat) => chat.id);
};

/**
 * Get chat count for a date group
 */
export const getChatCountByDate = (
  grouped: Record<string, ChatItem[]>,
  dateKey: string,
): number => {
  if (!grouped[dateKey]) return 0;
  return grouped[dateKey].length;
};

/**
 * Get the date group key for a specific chat
 * Returns the same format as used in groupChatsByDate
 */
export const getDateGroupKeyForChat = (chat: ChatItem): string => {
  if (chat.pinned) {
    return "Pinned";
  }
  if (chat.createdByScheduleId) {
    return "Scheduled";
  }
  const date = new Date(chat.createdAt);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};
