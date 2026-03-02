import React from "react";
import { Button, Flex } from "antd";
import { PlusOutlined, SettingOutlined } from "@ant-design/icons";

type ChatSidebarFooterProps = {
  collapsed: boolean;
  onNewChat: () => void;
  onOpenSettings: () => void;
  screens: { xs?: boolean };
  token: any;
};

export const ChatSidebarFooter: React.FC<ChatSidebarFooterProps> = ({
  collapsed,
  onNewChat,
  onOpenSettings,
  screens,
  token,
}) => {
  const newChatLabel = "New Session";
  const settingsLabel = "System Settings";

  return (
    <Flex
      vertical
      gap={collapsed ? "small" : "middle"}
      style={{
        padding: collapsed ? 8 : 16,
        background: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={onNewChat}
        block={!collapsed}
        shape={collapsed ? "circle" : "default"}
        size={collapsed ? "large" : screens.xs ? "small" : "middle"}
        title={newChatLabel}
        aria-label={newChatLabel}
        style={
          collapsed ? { width: "44px", height: "44px", margin: "0 auto" } : {}
        }
      >
        {!collapsed && newChatLabel}
      </Button>

      <Button
        data-testid="open-settings"
        icon={<SettingOutlined />}
        onClick={onOpenSettings}
        block={!collapsed}
        shape={collapsed ? "circle" : "default"}
        size={collapsed ? "large" : screens.xs ? "small" : "middle"}
        title={settingsLabel}
        aria-label={settingsLabel}
        style={
          collapsed ? { width: "44px", height: "44px", margin: "0 auto" } : {}
        }
      >
        {!collapsed && settingsLabel}
      </Button>
    </Flex>
  );
};
