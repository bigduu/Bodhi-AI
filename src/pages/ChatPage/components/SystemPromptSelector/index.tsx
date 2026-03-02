import React, { useEffect, useMemo, useState } from "react";
import { Empty, Modal, Space, Typography, message, theme } from "antd";
import { ToolOutlined } from "@ant-design/icons";

import {
  ModalFooter,
  createCancelButton,
  createOkButton,
} from "../ModalFooter";
import type { UserSystemPrompt } from "../../types/chat";
import { useAppStore } from "../../store";
import { SystemPromptListItem } from "./SystemPromptListItem";

const { Text } = Typography;
const { useToken } = theme;

interface SystemPromptSelectorProps {
  open: boolean;
  onClose: () => void;
  onSelect: (prompt: UserSystemPrompt) => void;
  prompts: UserSystemPrompt[];
  title?: string;
  showCancelButton?: boolean;
}

const SystemPromptSelector: React.FC<SystemPromptSelectorProps> = ({
  open,
  onClose,
  onSelect,
  prompts,
  title = "Select System Prompt",
  showCancelButton = true,
}) => {
  const { token } = useToken();
  const [messageApi, contextHolder] = message.useMessage();
  const lastSelectedPromptId = useAppStore(
    (state) => state.lastSelectedPromptId,
  );
  const setLastSelectedPromptId = useAppStore(
    (state) => state.setLastSelectedPromptId,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedPreviewId, setExpandedPreviewId] = useState<string | null>(
    null,
  );

  // Filter out prompts with empty or missing IDs - use useMemo to avoid recalculation
  const validPrompts = useMemo(
    () => prompts.filter((p) => p.id && p.id.trim() !== ""),
    [prompts],
  );

  const handleCopyPrompt = async (
    event: React.MouseEvent,
    prompt: UserSystemPrompt,
  ) => {
    event.stopPropagation();

    const content = prompt.content ?? "";

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      messageApi.success(`Copied "${prompt.name}" prompt`);
    } catch (error) {
      console.error("[SystemPromptSelector] Failed to copy prompt:", error);
      messageApi.error("Failed to copy prompt content");
    }
  };

  useEffect(() => {
    if (open) {
      const defaultPrompt = validPrompts.find((p) => p.isDefault);
      // Priority: last selected > default prompt > first available prompt
      const initialId =
        lastSelectedPromptId ||
        defaultPrompt?.id ||
        (validPrompts.length > 0 ? validPrompts[0].id : null);
      setSelectedId(initialId);
    }
  }, [open, lastSelectedPromptId, validPrompts.length]); // Use validPrompts.length instead of validPrompts to avoid unnecessary re-runs

  const handleSelect = (prompt: UserSystemPrompt) => {
    setSelectedId(prompt.id);
    setLastSelectedPromptId(prompt.id);
    onSelect(prompt);
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <>
      {contextHolder}
      <Modal
        title={
          <Space>
            <ToolOutlined />
            {title}
          </Space>
        }
        open={open}
        onCancel={handleCancel}
        width={700}
        footer={
          <ModalFooter
            buttons={[
              ...(showCancelButton ? [createCancelButton(handleCancel)] : []),
              createOkButton(
                () => {
                  const prompt = validPrompts.find((p) => p.id === selectedId);
                  if (prompt) {
                    handleSelect(prompt);
                  }
                },
                {
                  text: "Create New Session",
                  disabled: !selectedId,
                },
              ),
            ]}
          />
        }
        styles={{
          body: {
            maxHeight: "70vh",
            overflowY: "auto",
            padding: token.paddingMD,
          },
        }}
      >
        <div style={{ marginBottom: token.marginMD }}>
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Select a base system prompt for the AI. You can add or edit prompts
            in the System Settings.
          </Text>
        </div>

        {validPrompts.length === 0 ? (
          <Empty
            description="No system prompts found. Add one in System Settings."
            style={{ margin: token.marginLG }}
          />
        ) : (
          <div>
            {validPrompts.map((prompt) => (
              <SystemPromptListItem
                key={prompt.id}
                prompt={prompt}
                token={token}
                isSelected={selectedId === prompt.id}
                isExpanded={expandedPreviewId === prompt.id}
                onSelect={(promptId) => setSelectedId(promptId)}
                onToggleExpand={(promptId) =>
                  setExpandedPreviewId(
                    expandedPreviewId === promptId ? null : promptId,
                  )
                }
                onCopy={handleCopyPrompt}
              />
            ))}
          </div>
        )}
      </Modal>
    </>
  );
};

export default SystemPromptSelector;
