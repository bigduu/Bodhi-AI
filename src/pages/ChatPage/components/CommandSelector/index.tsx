import React from "react";
import { Spin, Tag, theme } from "antd";
import { useCommandSelectorState } from "./useCommandSelectorState";
import type { CommandItem } from "../../types/command";
import { parseMcpToolAlias } from "../../utils/mcpAlias";
import "./index.css";

const { useToken } = theme;

interface CommandSelectorProps {
  visible: boolean;
  onSelect: (command: { name: string; type: string; id: string }) => void;
  onCancel: () => void;
  searchText: string;
  onAutoComplete?: (commandName: string) => void;
}

const TYPE_CONFIG = {
  workflow: {
    color: "blue",
    icon: "📁",
    label: "Workflow",
  },
  skill: {
    color: "green",
    icon: "⚡",
    label: "Skill",
  },
  mcp: {
    color: "purple",
    icon: "🔌",
    label: "MCP",
  },
} as const;

const CommandSelector: React.FC<CommandSelectorProps> = ({
  visible,
  onSelect,
  onCancel,
  searchText,
  onAutoComplete,
}) => {
  const { token } = useToken();
  const {
    containerRef,
    selectedItemRef,
    filteredCommands,
    selectedIndex,
    setSelectedIndex,
    isLoading,
    handleCommandSelect,
  } = useCommandSelectorState({
    visible,
    searchText,
    onSelect,
    onCancel,
    onAutoComplete,
  });

  if (!visible) {
    return null;
  }

  if (isLoading) {
    return (
      <div
        style={{
          position: "absolute",
          bottom: "100%",
          left: 0,
          right: 0,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusSM,
          boxShadow: token.boxShadowSecondary,
          padding: `${token.paddingSM}px ${token.paddingMD}px`,
          zIndex: 1000,
          marginBottom: token.marginXS,
          textAlign: "center",
        }}
      >
        <Spin size="small" /> Loading commands...
      </div>
    );
  }

  if (filteredCommands.length === 0) {
    return (
      <div
        style={{
          position: "absolute",
          bottom: "100%",
          left: 0,
          right: 0,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusSM,
          boxShadow: token.boxShadowSecondary,
          padding: `${token.paddingSM}px ${token.paddingMD}px`,
          zIndex: 1000,
          marginBottom: token.marginXS,
          textAlign: "center",
          color: token.colorTextSecondary,
        }}
      >
        {searchText
          ? `No commands found matching "${searchText}"`
          : "No commands available."}
      </div>
    );
  }

  const renderCommandItem = (command: CommandItem, index: number) => {
    const typeConfig = TYPE_CONFIG[command.type];
    const isSelected = index === selectedIndex;

    const mcpParts =
      command.type === "mcp" ? parseMcpToolAlias(command.name) : null;
    const mcpToolName =
      command.type === "mcp"
        ? command.metadata?.originalName ||
          mcpParts?.toolName ||
          command.displayName ||
          command.name
        : null;
    const mcpServerLabel =
      command.type === "mcp"
        ? command.metadata?.serverName ||
          command.metadata?.serverId ||
          mcpParts?.serverId ||
          null
        : null;

    return (
      <div
        key={command.id}
        ref={isSelected ? selectedItemRef : null}
        className={`command-selector-item ${isSelected ? "selected" : ""}`}
        onClick={() => handleCommandSelect(command)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        <div className="command-selector-item-header">
          <div
            className="command-selector-item-name"
            style={{
              color: token.colorPrimary,
            }}
          >
            /{command.type === "mcp" && mcpToolName ? mcpToolName : command.name}
          </div>
          <div style={{ display: "flex", gap: token.marginXS }}>
            {command.type === "mcp" && mcpServerLabel && (
              <Tag color="geekblue">{mcpServerLabel}</Tag>
            )}
            <Tag color={typeConfig.color}>
              {typeConfig.icon} {typeConfig.label}
            </Tag>
          </div>
        </div>

        <div
          className="command-selector-item-description"
          style={{
            color: token.colorTextSecondary,
          }}
        >
          {command.description}
        </div>

        {command.type === "mcp" && mcpServerLabel && (
          <div
            className="command-selector-item-category"
            style={{
              color: token.colorTextTertiary,
            }}
          >
            Server: {mcpServerLabel}
          </div>
        )}

        {command.category && (
          <div
            className="command-selector-item-category"
            style={{
              color: token.colorTextTertiary,
            }}
          >
            Category: {command.category}
          </div>
        )}

        {command.tags && command.tags.length > 0 && (
          <div className="command-selector-item-tags">
            {command.tags.slice(0, 3).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="command-selector-container"
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusSM,
        boxShadow: token.boxShadowSecondary,
      }}
    >
      <div
        style={{
          padding: `${token.paddingXXS}px ${token.paddingSM}px`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
          fontSize: token.fontSizeSM,
          color: token.colorTextTertiary,
        }}
      >
        Navigation: Up/Down or Ctrl+P/N | Select: Enter | Complete: Space/Tab |
        Cancel: Esc
      </div>
      {filteredCommands.map((command, index) =>
        renderCommandItem(command, index),
      )}
    </div>
  );
};

export default CommandSelector;
