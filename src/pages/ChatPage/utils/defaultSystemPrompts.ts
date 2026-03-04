import type { UserSystemPrompt } from "../types/chat";

const DEFAULT_SYSTEM_PROMPT: UserSystemPrompt = {
  // Keep this aligned with the app-wide default prompt id used in chat configs.
  id: "general_assistant",
  name: "Bamboo",
  description: "Default system prompt.",
  content:
    "You are Bamboo, a highly capable AI assistant.\n\n" +
    "You help users solve problems quickly and correctly. Be concise, practical, and proactive.\n" +
    "If requirements are unclear, ask focused clarifying questions before proceeding.",
  isDefault: true,
};

export const getDefaultSystemPrompts = (): UserSystemPrompt[] => [
  { ...DEFAULT_SYSTEM_PROMPT },
];
