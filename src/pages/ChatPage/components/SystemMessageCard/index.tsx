import React, { useCallback } from "react";
import { Button, Card, Flex, Space, Typography, theme } from "antd";
import { CopyOutlined, EyeOutlined } from "@ant-design/icons";

import type { ChatItem, Message } from "../../types/chat";
import { useAppStore } from "../../store";
import { SystemPromptMarkdown } from "./SystemPromptMarkdown";
import { useSystemPromptContent } from "./useSystemPromptContent";
import { copyText } from "@shared/utils/clipboard";

const { Text } = Typography;
const { useToken } = theme;

interface SystemMessageCardProps {
  currentChat: ChatItem | null;
  message: Message;
}

const SystemMessageCard: React.FC<SystemMessageCardProps> = ({
  currentChat,
  message,
}) => {
  const { token } = useToken();
  const systemPrompts = useAppStore((state) => state.systemPrompts);

  const {
    basePrompt,
    loadingEnhanced,
    loadEnhancedPrompt,
    promptToDisplay,
    showEnhanced,
    setShowEnhanced,
  } = useSystemPromptContent({ currentChat, message, systemPrompts });

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await copyText(text);
    } catch (e) {
      console.error("Failed to copy text:", e);
    }
  }, []);

  return (
    <Card
      style={{
        width: "100%",
        maxWidth: "100%",
        background: token.colorBgContainer,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadow,
      }}
    >
      <Space
        direction="vertical"
        size={token.marginSM}
        style={{ width: "100%" }}
      >
        <Flex justify="space-between" align="center">
          <Flex align="center" gap={token.marginXS}>
            <Text
              type="secondary"
              strong
              style={{ fontSize: token.fontSizeSM }}
            >
              System Prompt
            </Text>
          </Flex>
          <Space>
            {basePrompt && !showEnhanced ? (
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                onClick={loadEnhancedPrompt}
                loading={loadingEnhanced}
              >
                View Enhanced
              </Button>
            ) : null}
            {basePrompt && showEnhanced ? (
              <Button
                type="text"
                size="small"
                onClick={() => setShowEnhanced(false)}
              >
                View Base
              </Button>
            ) : null}
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(promptToDisplay)}
            >
              Copy
            </Button>
          </Space>
        </Flex>

        <Flex
          vertical
          style={{
            maxHeight: showEnhanced ? 400 : 300,
            overflowY: "auto",
            paddingRight: token.paddingXS,
          }}
        >
          <SystemPromptMarkdown
            content={promptToDisplay}
            token={token}
            headingColor={token.colorPrimary}
          />
        </Flex>
      </Space>
    </Card>
  );
};

export default SystemMessageCard;
