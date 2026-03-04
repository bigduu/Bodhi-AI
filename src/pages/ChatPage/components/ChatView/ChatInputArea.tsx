import React from "react";
import { Flex } from "antd";

import { InputContainer } from "../InputContainer";
import type { WorkflowDraft } from "../InputContainer";
import ActiveToolMessageCard, {
  type PendingToolCall,
} from "./ActiveToolMessageCard";

type ChatInputAreaProps = {
  chatId: string | null;
  isCenteredLayout: boolean;
  maxWidth: string;
  onWorkflowDraftChange: (draft: WorkflowDraft | null) => void;
  showMessagesView: boolean;
  pendingToolCalls: PendingToolCall[];
};

export const ChatInputArea: React.FC<ChatInputAreaProps> = ({
  chatId,
  isCenteredLayout,
  maxWidth,
  onWorkflowDraftChange,
  showMessagesView,
  pendingToolCalls,
}) => {
  return (
    <Flex
      justify="center"
      className={`chat-view-input-container-wrapper ${
        showMessagesView ? "messages-view" : "centered-view"
      }`}
    >
      <div
        style={{
          width: "100%",
          maxWidth,
          margin: showMessagesView ? "0 auto" : undefined,
          position: "relative",
        }}
      >
        {showMessagesView && (
          <ActiveToolMessageCard pendingToolCalls={pendingToolCalls} />
        )}
        <InputContainer
          chatId={chatId}
          isCenteredLayout={isCenteredLayout}
          onWorkflowDraftChange={onWorkflowDraftChange}
        />
      </div>
    </Flex>
  );
};
