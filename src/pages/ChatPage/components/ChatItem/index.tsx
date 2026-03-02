import React, { memo, useState } from "react";
import { List, Button, Input, Tag, Tooltip, theme } from "antd";
import {
  DeleteOutlined,
  PushpinFilled,
  PushpinOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  BulbOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { ChatItem as ChatItemType } from "../../types/chat";

interface ChatItemProps {
  chat: ChatItemType;
  isSelected: boolean;
  onSelect: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  onPin: (chatId: string) => void;
  onUnpin: (chatId: string) => void;
  onEdit?: (chatId: string, newTitle: string) => void;
  onGenerateTitle?: (chatId: string) => void;
  isGeneratingTitle?: boolean;
  titleGenerationError?: string;
}

const ChatItemComponent: React.FC<ChatItemProps> = ({
  chat,
  isSelected,
  onSelect,
  onDelete,
  onPin,
  onUnpin,
  onEdit,
  onGenerateTitle,
  isGeneratingTitle,
  titleGenerationError,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(chat.title);
  const [isHovered, setIsHovered] = useState(false);
  const { token } = theme.useToken();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(chat.id);
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  };

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit && editValue.trim()) {
      onEdit(chat.id, editValue.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(chat.title);
    setIsEditing(false);
  };

  // Dynamic style calculation
  const itemStyle: React.CSSProperties = {
    padding: token.paddingXS,
    borderRadius: token.borderRadiusSM,
    marginBottom: token.marginXXS,
    cursor: "pointer",
    transition: "background-color 0.2s ease",
    backgroundColor: isSelected ? token.colorPrimaryBg : "transparent",
    borderLeft: isSelected
      ? `3px solid ${token.colorPrimary}`
      : "3px solid transparent",
  };

  const titleStyle: React.CSSProperties = {
    flex: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: token.fontSizeSM,
    fontWeight: isSelected ? token.fontWeightStrong : "normal",
    color: isSelected ? token.colorPrimary : token.colorText,
  };

  const editInputStyle: React.CSSProperties = {
    flex: 1,
    fontSize: token.fontSizeSM,
    marginRight: token.marginSM,
  };

  // Build List.Item actions - only show when hovered or editing
  const actions =
    isHovered || isEditing
      ? [
          // Pin/Unpin button
          <Tooltip key="pin" title={chat.pinned ? "Unpin" : "Pin"}>
            <Button
              type="text"
              size="small"
              icon={
                chat.pinned ? (
                  <PushpinFilled style={{ color: token.colorWarning }} />
                ) : (
                  <PushpinOutlined />
                )
              }
              onClick={(e) => {
                e.stopPropagation();
                chat.pinned ? onUnpin(chat.id) : onPin(chat.id);
              }}
              style={{
                opacity: chat.pinned ? 1 : undefined, // Always show when pinned
              }}
            />
          </Tooltip>,

          // Edit related buttons
          ...(isEditing
            ? [
                <Tooltip key="save" title="Save">
                  <Button
                    type="text"
                    size="small"
                    icon={
                      <CheckOutlined style={{ color: token.colorSuccess }} />
                    }
                    onClick={handleSave}
                  />
                </Tooltip>,
                <Tooltip key="cancel" title="Cancel">
                  <Button
                    type="text"
                    size="small"
                    icon={<CloseOutlined style={{ color: token.colorError }} />}
                    onClick={handleCancel}
                  />
                </Tooltip>,
              ]
            : [
                <Tooltip key="edit" title="Edit">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={handleEdit}
                  />
                </Tooltip>,
                ...(onGenerateTitle
                  ? [
                      <Tooltip
                        key="generate-title"
                        title={titleGenerationError || "Generate AI Title"}
                        color={
                          titleGenerationError ? token.colorError : undefined
                        }
                      >
                        <Button
                          type="text"
                          size="small"
                          data-testid="generate-title-button"
                          icon={
                            isGeneratingTitle ? (
                              <LoadingOutlined />
                            ) : (
                              <BulbOutlined
                                style={
                                  titleGenerationError
                                    ? { color: token.colorError }
                                    : undefined
                                }
                              />
                            )
                          }
                          disabled={isGeneratingTitle}
                          onClick={(e) => {
                            e.stopPropagation();
                            onGenerateTitle(chat.id);
                          }}
                        />
                      </Tooltip>,
                    ]
                  : []),
              ]),

          // Delete button
          <Tooltip key="delete" title="Delete">
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={handleDelete}
              danger
            />
          </Tooltip>,
        ]
      : [];

  return (
    <List.Item
      style={itemStyle}
      onClick={() => !isEditing && onSelect(chat.id)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      actions={actions}
      data-testid="chat-item"
    >
      <List.Item.Meta
        title={
          isEditing ? (
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPressEnter={(e) => {
                e.preventDefault();
                handleSave(e as any);
              }}
              autoFocus
              style={editInputStyle}
              variant="borderless"
              size="small"
            />
          ) : (
            <div
              style={{
                ...titleStyle,
                display: "flex",
                alignItems: "center",
                gap: token.marginXS,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {chat.title}
              </span>
              {chat.kind === "child" ? (
                <Tag
                  color="geekblue"
                  style={{ marginInlineEnd: 0, flex: "0 0 auto" }}
                >
                  Child
                </Tag>
              ) : null}
            </div>
          )
        }
      />
    </List.Item>
  );
};

// Custom comparison function to ensure re-render when title changes
const arePropsEqual = (
  prevProps: ChatItemProps,
  nextProps: ChatItemProps,
): boolean => {
  // Return true if props are equal (skip re-render)
  // Return false if props are different (re-render)
  return (
    prevProps.chat.id === nextProps.chat.id &&
    prevProps.chat.title === nextProps.chat.title &&
    prevProps.chat.pinned === nextProps.chat.pinned &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isGeneratingTitle === nextProps.isGeneratingTitle &&
    prevProps.titleGenerationError === nextProps.titleGenerationError
  );
};

export const ChatItem = memo(ChatItemComponent, arePropsEqual);
ChatItem.displayName = "ChatItem";

export default ChatItem;
