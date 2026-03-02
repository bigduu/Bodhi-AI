import React from "react";
import { Button, Flex } from "antd";
import { SendOutlined, StopOutlined, SyncOutlined } from "@ant-design/icons";
import type { ImageFile } from "../../utils/imageUtils";

interface MessageInputControlsRightProps {
  allowRetry: boolean;
  hasMessages: boolean;
  isStreaming: boolean;
  disabled: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
  onSubmit: () => void;
  value: string;
  images: ImageFile[];
  isOverCharLimit: boolean;
  token: any;
  statusIndicator?: React.ReactNode;
}

const MessageInputControlsRight: React.FC<MessageInputControlsRightProps> = ({
  allowRetry,
  hasMessages,
  isStreaming,
  disabled,
  onRetry,
  onCancel,
  onSubmit,
  value,
  images,
  isOverCharLimit,
  token,
  statusIndicator,
}) => {
  const canSend = !value.trim() && images.length === 0;

  return (
    <Flex
      align="center"
      style={{
        alignSelf: "center",
        gap: token.marginXS,
      }}
    >
      {statusIndicator ? (
        <span style={{ flex: "0 0 auto" }}>{statusIndicator}</span>
      ) : null}

      {allowRetry && hasMessages && (
        <Button
          data-testid="regenerate-button"
          type="text"
          icon={<SyncOutlined spin={isStreaming} />}
          onClick={onRetry}
          disabled={isStreaming || disabled || !onRetry}
          title="Regenerate last AI response"
          size="small"
          style={{
            minWidth: "auto",
            padding: "4px",
            height: 32,
            width: 32,
            color: token.colorTextSecondary,
          }}
        />
      )}

      <Button
        data-testid={isStreaming ? "cancel-button" : "send-button"}
        type="primary"
        icon={isStreaming ? <StopOutlined /> : <SendOutlined />}
        onClick={isStreaming ? onCancel : onSubmit}
        loading={isStreaming && !onCancel}
        disabled={
          isStreaming
            ? !onCancel || disabled
            : canSend || disabled || isOverCharLimit
        }
        size="small"
        danger={isStreaming}
        style={{
          minWidth: "auto",
          padding: "4px 6px",
          height: 32,
          width: 40,
        }}
        title={isStreaming ? "Cancel request" : "Send message"}
      />
    </Flex>
  );
};

export default MessageInputControlsRight;
