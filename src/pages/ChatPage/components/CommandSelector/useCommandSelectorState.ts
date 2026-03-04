import { useEffect, useRef, useState } from "react";
import { CommandService } from "../../services/CommandService";
import type { CommandItem } from "../../types/command";

interface UseCommandSelectorStateProps {
  visible: boolean;
  searchText: string;
  onSelect: (command: { name: string; type: string; id: string }) => void;
  onCancel: () => void;
  onAutoComplete?: (commandName: string) => void;
}

export const useCommandSelectorState = ({
  visible,
  searchText,
  onSelect,
  onCancel,
  onAutoComplete,
}: UseCommandSelectorStateProps) => {
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<CommandItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;

    const commandService = CommandService.getInstance();
    const fetchCommands = async () => {
      setIsLoading(true);
      try {
        const fetchedCommands = await commandService.listCommands();
        console.log("[CommandSelector] Fetched commands:", fetchedCommands);
        setCommands(fetchedCommands);
        setSelectedIndex(0);
      } catch (error) {
        console.error("[CommandSelector] Failed to fetch commands:", error);
        setCommands([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchCommands();
  }, [visible]);

  useEffect(() => {
    const filtered = commands.filter((command) => {
      const searchLower = searchText.toLowerCase();
      const displayNameLower = (command.displayName ?? "").toLowerCase();
      return (
        command.name.toLowerCase().includes(searchLower) ||
        displayNameLower.includes(searchLower) ||
        command.description.toLowerCase().includes(searchLower) ||
        (command.type === "mcp" &&
          [
            command.metadata?.serverId,
            command.metadata?.serverName,
            command.metadata?.originalName,
          ]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(searchLower))) ||
        (command.category?.toLowerCase().includes(searchLower) ?? false) ||
        (command.tags?.some((tag: string) =>
          tag.toLowerCase().includes(searchLower),
        ) ??
          false)
      );
    });
    setFilteredCommands(filtered);
    setSelectedIndex(0);
  }, [commands, searchText]);

  useEffect(() => {
    if (!selectedItemRef.current || !containerRef.current) return;
    const container = containerRef.current;
    const selectedItem = selectedItemRef.current;

    const containerRect = container.getBoundingClientRect();
    const selectedRect = selectedItem.getBoundingClientRect();

    if (selectedRect.top < containerRect.top) {
      selectedItem.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (selectedRect.bottom > containerRect.bottom) {
      selectedItem.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [selectedIndex, filteredCommands]);

  const handleCommandSelect = async (command: CommandItem) => {
    try {
      onSelect({
        name: command.name,
        type: command.type,
        id: command.id,
      });
    } catch (error) {
      console.error(
        `[CommandSelector] Failed to select command '${command.name}':`,
        error,
      );
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!visible) return;

      switch (event.key) {
        case "ArrowDown":
        case "n":
          if (event.key === "n" && !event.ctrlKey) break;
          event.preventDefault();
          event.stopPropagation();
          setSelectedIndex((prev) =>
            prev < filteredCommands.length - 1 ? prev + 1 : 0,
          );
          break;
        case "ArrowUp":
        case "p":
          if (event.key === "p" && !event.ctrlKey) break;
          event.preventDefault();
          event.stopPropagation();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : filteredCommands.length - 1,
          );
          break;
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          if (filteredCommands[selectedIndex]) {
            handleCommandSelect(filteredCommands[selectedIndex]);
          }
          break;
        case " ":
        case "Tab":
          event.preventDefault();
          event.stopPropagation();
          if (filteredCommands[selectedIndex] && onAutoComplete) {
            onAutoComplete(filteredCommands[selectedIndex].name);
          }
          break;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onCancel();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [visible, filteredCommands, selectedIndex, onCancel, onAutoComplete]);

  return {
    containerRef,
    selectedItemRef,
    filteredCommands,
    selectedIndex,
    setSelectedIndex,
    isLoading,
    handleCommandSelect,
  };
};
