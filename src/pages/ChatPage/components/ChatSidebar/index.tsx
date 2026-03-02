import React, { useEffect } from "react";
import { Flex, theme } from "antd";
import { MenuFoldOutlined, MenuUnfoldOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { Grid } from "antd";

import SystemPromptSelector from "../SystemPromptSelector";
import { ChatSidebarCollapsedMenu } from "./ChatSidebarCollapsedMenu";
import { ChatSidebarDateGroups } from "./ChatSidebarDateGroups";
import { ChatSidebarFooter } from "./ChatSidebarFooter";
import { useChatSidebarState } from "./useChatSidebarState";

const { useBreakpoint } = Grid;
const { useToken } = theme;

export const ChatSidebar: React.FC = () => {
  const { token } = useToken();
  const screens = useBreakpoint();

  const {
    chats,
    childrenByRoot,
    expandedRootIds,
    toggleRootExpanded,
    collapsed,
    currentChatId,
    expandedKeys,
    groupedChatsByDate,
    handleCollapseChange,
    handleDelete,
    handleDeleteByDate,
    handleEditTitle,
    handleGenerateTitle,
    handleNewChat,
    handleNewChatSelectorClose,
    handleOpenSettings,
    handleSystemPromptSelect,
    isNewChatSelectorOpen,
    pinChat,
    selectChat,
    setCollapsed,
    sortedDateKeys,
    systemPrompts,
    titleGenerationState,
    unpinChat,
  } = useChatSidebarState();

  useEffect(() => {
    // `useBreakpoint()` returns a fresh object reference very frequently.
    // Depend only on the primitive booleans to avoid effect re-running every render.
    const { xs, sm } = screens;
    if (typeof xs !== "boolean" || typeof sm !== "boolean") return;
    if (xs === false && sm === false) {
      setCollapsed(true);
    }
  }, [screens.xs, screens.sm, setCollapsed]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Flex
        justify={collapsed ? "center" : "flex-end"}
        style={{
          position: "absolute",
          right: collapsed ? 0 : 8,
          left: collapsed ? 0 : "auto",
          top: 8,
          zIndex: 10,
        }}
      >
        <Button
          type="text"
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={() => setCollapsed(!collapsed)}
          size={screens.xs ? "small" : "middle"}
        />
      </Flex>

      <Flex
        vertical
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: collapsed ? "40px 10px 0 10px" : "40px 12px 0 12px",
        }}
      >
        {!collapsed ? (
          <ChatSidebarDateGroups
            groupedChatsByDate={groupedChatsByDate}
            childrenByRoot={childrenByRoot}
            expandedRootIds={expandedRootIds}
            onToggleRootExpanded={toggleRootExpanded}
            sortedDateKeys={sortedDateKeys}
            expandedKeys={expandedKeys}
            onCollapseChange={handleCollapseChange}
            currentChatId={currentChatId}
            onSelectChat={selectChat}
            onDeleteChat={handleDelete}
            onDeleteByDate={handleDeleteByDate}
            onPinChat={pinChat}
            onUnpinChat={unpinChat}
            onEditTitle={handleEditTitle}
            onGenerateTitle={handleGenerateTitle}
            titleGenerationState={titleGenerationState}
            token={token}
          />
        ) : (
          <ChatSidebarCollapsedMenu
            chats={chats}
            currentChatId={currentChatId}
            onSelectChat={selectChat}
            screens={screens}
            token={token}
          />
        )}
      </Flex>

      <ChatSidebarFooter
        collapsed={collapsed}
        onNewChat={handleNewChat}
        onOpenSettings={handleOpenSettings}
        screens={screens}
        token={token}
      />

      <SystemPromptSelector
        open={isNewChatSelectorOpen}
        onClose={handleNewChatSelectorClose}
        onSelect={handleSystemPromptSelect}
        prompts={systemPrompts}
        title="Create New Session - Select System Prompt"
        showCancelButton={true}
      />
    </div>
  );
};
