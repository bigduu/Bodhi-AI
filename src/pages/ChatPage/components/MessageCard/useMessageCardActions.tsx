import type { MouseEvent, RefObject } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  BookOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { App as AntApp } from "antd";
import { MessageExportService } from "../../services/MessageExportService";
import { copyText } from "@shared/utils/clipboard";

interface UseMessageCardActionsProps {
  messageText: string;
  messageId?: string;
  currentChatId?: string | null;
  onDelete?: (messageId: string) => void;
  cardRef: RefObject<HTMLDivElement>;
}

export const useMessageCardActions = ({
  messageText,
  messageId,
  currentChatId,
  onDelete,
  cardRef,
}: UseMessageCardActionsProps) => {
  const { message: appMessage } = AntApp.useApp();
  const [selectedText, setSelectedText] = useState<string>("");

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await copyText(text);
    } catch (e) {
      console.error("Failed to copy text:", e);
    }
  }, []);

  const createReference = useCallback((text: string) => {
    return `> ${text.replace(/\n/g, "\n> ")}`;
  }, []);

  const referenceMessage = useCallback(() => {
    if (!currentChatId) return;
    const referenceText = selectedText
      ? createReference(selectedText)
      : createReference(messageText);
    const event = new CustomEvent("reference-text", {
      detail: { text: referenceText, chatId: currentChatId },
    });
    window.dispatchEvent(event);
  }, [createReference, currentChatId, messageText, selectedText]);

  const exportContent = useCallback(
    async (format: "markdown" | "pdf") => {
      const text = selectedText || messageText;
      if (!text) {
        appMessage.warning("Nothing to export");
        return;
      }

      const result = await MessageExportService.exportMessageText({
        format,
        content: text,
        chatId: currentChatId ?? null,
        messageId: messageId ?? null,
      });

      if (result.success) {
        appMessage.success(`Saved: ${result.filename}`);
      } else {
        // "User cancelled" is not actionable; keep it quiet.
        if (result.error?.toLowerCase().includes("cancel")) {
          return;
        }
        appMessage.error(result.error || "Export failed");
      }
    },
    [appMessage, currentChatId, messageId, messageText, selectedText],
  );

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const selection = window.getSelection();
      const text = selection ? selection.toString() : "";
      if (
        text &&
        cardRef.current &&
        selection &&
        cardRef.current.contains(selection.anchorNode)
      ) {
        setSelectedText(text);
      } else {
        setSelectedText("");
      }
    },
    [cardRef],
  );

  const contextMenuItems = useMemo(() => {
    const baseItems: NonNullable<MenuProps["items"]> = [
      {
        key: "copy",
        label: "Copy",
        icon: <CopyOutlined />,
        onClick: () => {
          if (selectedText) {
            copyToClipboard(selectedText);
          } else {
            copyToClipboard(messageText);
          }
        },
      },
      {
        key: "reference",
        label: "Reference message",
        icon: <BookOutlined />,
        onClick: referenceMessage,
      },
      { type: "divider" },
      {
        key: "export-md",
        label: "Export as Markdown",
        icon: <DownloadOutlined />,
        onClick: () => exportContent("markdown"),
      },
      {
        key: "export-pdf",
        label: "Export as PDF",
        icon: <DownloadOutlined />,
        onClick: () => exportContent("pdf"),
      },
    ];

    if (onDelete && messageId) {
      baseItems.push({
        key: "delete",
        label: "Delete message",
        icon: <DeleteOutlined />,
        onClick: () => onDelete(messageId),
        danger: true,
      });
    }

    return baseItems;
  }, [
    copyToClipboard,
    exportContent,
    messageId,
    messageText,
    onDelete,
    referenceMessage,
    selectedText,
  ]);

  return {
    contextMenuItems,
    handleMouseUp,
    copyToClipboard,
    referenceMessage,
  };
};
