import { useCallback, useEffect, useState } from "react";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { CommandService } from "../../services/CommandService";
import type { WorkflowCommandInfo } from "../../utils/inputHighlight";
import type { WorkflowDraft } from "./index";
import type { CommandItem } from "../../types/command";
import { parseMcpToolAlias } from "../../utils/mcpAlias";

interface UseInputContainerCommandProps {
  setContent: (value: string) => void;
  onWorkflowDraftChange?: (workflow: WorkflowDraft | null) => void;
  acknowledgeManualInput: () => void;
  currentChatId: string | null;
  textAreaRef: React.RefObject<TextAreaRef>;
  content: string;
}

export const useInputContainerCommand = ({
  setContent,
  onWorkflowDraftChange,
  acknowledgeManualInput,
  currentChatId,
  textAreaRef,
  content,
}: UseInputContainerCommandProps) => {
  const [showCommandSelector, setShowCommandSelector] = useState(false);
  const [commandSearchText, setCommandSearchText] = useState("");
  const [selectedCommand, setSelectedCommand] = useState<WorkflowDraft | null>(
    null,
  );

  useEffect(() => {
    setSelectedCommand(null);
    onWorkflowDraftChange?.(null);
  }, [currentChatId, onWorkflowDraftChange]);

  const matchesCommandToken = useCallback(
    (value: string, commandName: string) => {
      const trimmedValue = value.trimStart();
      const token = `/${commandName}`;
      if (!trimmedValue.startsWith(token)) {
        return false;
      }
      const nextChar = trimmedValue.charAt(token.length);
      return !nextChar || /\s/.test(nextChar);
    },
    [],
  );

  const clearCommandDraft = useCallback(() => {
    setSelectedCommand(null);
    onWorkflowDraftChange?.(null);
  }, [onWorkflowDraftChange]);

  const updateCommandDraftPreview = useCallback(
    (value: string, command: WorkflowDraft) => {
      if (!matchesCommandToken(value, command.name)) {
        return;
      }
      const token = `/${command.name}`;
      const trimmedValue = value.trim();
      const extraInput = trimmedValue.slice(token.length).trim();
      const content = [command.content, extraInput]
        .filter(Boolean)
        .join("\n\n");
      onWorkflowDraftChange?.({ ...command, content });
    },
    [matchesCommandToken, onWorkflowDraftChange],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      acknowledgeManualInput();
      if (
        selectedCommand &&
        !matchesCommandToken(value, selectedCommand.name)
      ) {
        clearCommandDraft();
      }
      if (selectedCommand && matchesCommandToken(value, selectedCommand.name)) {
        updateCommandDraftPreview(value, selectedCommand);
      }
      setContent(value);
    },
    [
      acknowledgeManualInput,
      clearCommandDraft,
      matchesCommandToken,
      selectedCommand,
      updateCommandDraftPreview,
      setContent,
    ],
  );

  const handleCommandChange = useCallback((info: WorkflowCommandInfo) => {
    setShowCommandSelector(info.isTriggerActive);
    setCommandSearchText(info.isTriggerActive ? info.searchText : "");
  }, []);

  const applyCommandDraft = useCallback(
    async (command: CommandItem) => {
      setShowCommandSelector(false);

      const getInsertToken = (cmd: CommandItem): string => {
        if (cmd.type !== "mcp") return cmd.name;
        // Prefer server-provided original tool name (short, user-friendly).
        const original = cmd.metadata?.originalName;
        if (typeof original === "string" && original.trim()) {
          return original.trim();
        }
        // Fallback: parse from alias (mcp__server__tool).
        const parsed = parseMcpToolAlias(cmd.name);
        if (parsed?.toolName) return parsed.toolName;
        // Last resort.
        return cmd.displayName || cmd.name;
      };

      const insertToken = getInsertToken(command);

      // Get current cursor position
      const textArea = textAreaRef.current?.resizableTextArea?.textArea;
      const cursorPosition = textArea?.selectionStart ?? content.length;

      // Smart insertion logic
      let newValue: string;
      let newCursorPos: number;

      // Check if we're currently typing a command (e.g., "/cod" should be replaced)
      const beforeCursor = content.substring(0, cursorPosition);
      const commandMatch = beforeCursor.match(/\/([a-zA-Z0-9_-]*)$/);

      if (commandMatch) {
        // Case 1: Replacing an incomplete command
        const startIndex = cursorPosition - commandMatch[0].length;
        const before = content.substring(0, startIndex);
        const after = content.substring(cursorPosition);
        newValue = `${before}/${insertToken} ${after}`;
        newCursorPos = `${before}/${insertToken} `.length;
      } else if (content.trim() === "") {
        // Case 2: Empty input, just set the command
        newValue = `/${insertToken} `;
        newCursorPos = newValue.length;
      } else {
        // Case 3: Insert at cursor position
        const before = content.substring(0, cursorPosition);
        const after = content.substring(cursorPosition);
        newValue = `${before}/${insertToken} ${after}`;
        newCursorPos = `${before}/${insertToken} `.length;
      }

      // Update content
      setContent(newValue);

      // Set cursor position in next tick to ensure DOM is updated
      setTimeout(() => {
        if (textArea) {
          textArea.selectionStart = newCursorPos;
          textArea.selectionEnd = newCursorPos;
          textArea.focus();
        }
      }, 0);

      // Only workflows need to load and preview content
      // Skills and MCP tools don't need content preview
      if (command.type !== "workflow") {
        // For skills and MCP: just mark the selection, no content preview
        // But we store the command info for use in submit
        const draft: WorkflowDraft = {
          id: `command-draft-${command.id}`,
          name: insertToken,
          content: "", // No content preview for skills/mcp
          createdAt: new Date().toISOString(),
          type: command.type,
          displayName: command.displayName,
          category: command.category,
          mcpAlias: command.type === "mcp" ? command.name : undefined,
          mcpServerId:
            command.type === "mcp" ? command.metadata?.serverId : undefined,
          mcpServerName:
            command.type === "mcp" ? command.metadata?.serverName : undefined,
          mcpOriginalName:
            command.type === "mcp"
              ? command.metadata?.originalName
              : undefined,
        };
        setSelectedCommand(draft);
        onWorkflowDraftChange?.(draft);
        return;
      }

      // Workflow: load content for preview
      const commandService = CommandService.getInstance();

      try {
        // Extract the real ID (remove type prefix from command.id)
        // command.id format: "workflow-xxx"
        const realId = command.id.startsWith("workflow-")
          ? command.id.slice("workflow-".length)
          : command.id;

        const fullCommand = await commandService.getCommand(
          command.type,
          realId,
        );
        const workflowContent = fullCommand.content?.trim() || "";

        if (workflowContent) {
          const draft: WorkflowDraft = {
            id: `command-draft-${command.id}`,
            name: command.name,
            content: workflowContent,
            createdAt: new Date().toISOString(),
            type: command.type,
            displayName: command.displayName,
          };
          setSelectedCommand(draft);
          onWorkflowDraftChange?.(draft);
        } else {
          clearCommandDraft();
        }
      } catch (error) {
        console.error(
          `[InputContainer] Failed to apply command '${command.name}':`,
          error,
        );
        clearCommandDraft();
      }
    },
    [
      clearCommandDraft,
      onWorkflowDraftChange,
      setContent,
      content,
      textAreaRef,
    ],
  );

  const handleCommandSelect = useCallback(
    async (commandInfo: { name: string; type: string; id: string }) => {
      try {
        const commandService = CommandService.getInstance();
        const commands = await commandService.listCommands();
        const command = commands.find(
          (c) => c.id === commandInfo.id && c.type === commandInfo.type,
        );

        if (!command) {
          console.error(
            `[InputContainer] Command '${commandInfo.id}' of type '${commandInfo.type}' not found`,
          );
          setContent(`/${commandInfo.name} `);
          clearCommandDraft();
          return;
        }

        await applyCommandDraft(command);
      } catch (error) {
        console.error(
          `[InputContainer] Failed to select command '${commandInfo.name}':`,
          error,
        );
        setContent(`/${commandInfo.name} `);
        clearCommandDraft();
      }
    },
    [applyCommandDraft, clearCommandDraft, setContent],
  );

  const handleCommandSelectorCancel = useCallback(() => {
    setShowCommandSelector(false);
  }, []);

  const handleAutoComplete = useCallback(
    async (commandName: string) => {
      setShowCommandSelector(false);
      try {
        const commandService = CommandService.getInstance();
        const commands = await commandService.listCommands();
        const command = commands.find((c) => c.name === commandName);

        if (command) {
          await applyCommandDraft(command);
        } else {
          console.error(
            `[InputContainer] Command '${commandName}' not found in auto-complete`,
          );
          setContent(`/${commandName} `);
          clearCommandDraft();
        }
      } catch (error) {
        console.error(
          `[InputContainer] Failed to load command '${commandName}' in auto-complete:`,
          error,
        );
        setContent(`/${commandName} `);
        clearCommandDraft();
      }
    },
    [applyCommandDraft, clearCommandDraft, setContent],
  );

  return {
    selectedCommand,
    showCommandSelector,
    commandSearchText,
    clearCommandDraft: clearCommandDraft,
    matchesCommandToken,
    handleInputChange,
    handleCommandChange,
    handleCommandSelect,
    handleCommandSelectorCancel,
    handleAutoComplete,
    setShowCommandSelector,
  };
};
