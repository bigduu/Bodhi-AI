import React, { useEffect, useMemo, useRef } from "react";
import { Button, Flex, theme } from "antd";
import {
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  CloseOutlined,
} from "@ant-design/icons";

import { useAppStore } from "../../store";
import { ChatView } from "../ChatView";
import {
  type LayoutNode,
  type LayoutSplitNode,
  getLeafIdsFromTree,
  useUILayoutStore,
} from "@shared/store/uiLayoutStore";
import { ResizableSplit } from "@shared/components/ResizableSplit";
import { uiLayoutDebug } from "@shared/utils/debugFlags";

import "./styles.css";

const { useToken } = theme;

const MAX_PANES = 4;

const PaneShell: React.FC<{ leafId: string }> = ({ leafId }) => {
  const { token } = useToken();

  const tree = useUILayoutStore((s) => s.tree);
  const leafChatIds = useUILayoutStore((s) => s.leafChatIds);
  const activeLeafId = useUILayoutStore((s) => s.activeLeafId);
  const setActiveLeafId = useUILayoutStore((s) => s.setActiveLeafId);
  const splitLeaf = useUILayoutStore((s) => s.splitLeaf);
  const closeLeaf = useUILayoutStore((s) => s.closeLeaf);

  const selectChat = useAppStore((s) => s.selectChat);

  const leafCount = useMemo(() => getLeafIdsFromTree(tree).length, [tree]);
  const canSplit = leafCount < MAX_PANES;
  const canClose = leafCount > 1;

  const chatId = leafChatIds[leafId] ?? null;
  const isActive = activeLeafId === leafId;

  return (
    <div
      className="chat-pane-shell"
      onMouseDownCapture={() => {
        uiLayoutDebug("pane focus (mouse)", {
          leafId,
          chatId,
          prevActiveLeafId: activeLeafId,
        });
        setActiveLeafId(leafId);
        if (chatId) {
          selectChat(chatId);
        }
      }}
      onFocusCapture={() => {
        uiLayoutDebug("pane focus (focus)", {
          leafId,
          chatId,
          prevActiveLeafId: activeLeafId,
        });
        setActiveLeafId(leafId);
      }}
      style={{
        height: "100%",
        minHeight: 0,
        border: `1px solid ${
          isActive ? token.colorPrimaryBorder : token.colorBorderSecondary
        }`,
        borderRadius: token.borderRadiusLG,
        overflow: "hidden",
        background: token.colorBgContainer,
        position: "relative",
      }}
    >
      <div
        className="chat-pane-actions"
        style={{
          background: token.colorBgElevated,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 10,
          padding: "2px 4px",
        }}
      >
        <Flex gap={token.marginXS}>
          <Button
            size="small"
            type="text"
            icon={<BorderHorizontalOutlined />}
            disabled={!canSplit}
            title="左右分屏"
            aria-label="左右分屏"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              uiLayoutDebug("pane split request", { leafId, layout: "horizontal" });
              splitLeaf(leafId, "horizontal");
              // New pane becomes active; keep global selection consistent.
              const next = useUILayoutStore.getState();
              const nextChatId = next.leafChatIds[next.activeLeafId] ?? null;
              if (nextChatId) selectChat(nextChatId);
            }}
          />

          <Button
            size="small"
            type="text"
            icon={<BorderVerticleOutlined />}
            disabled={!canSplit}
            title="上下分屏"
            aria-label="上下分屏"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              uiLayoutDebug("pane split request", { leafId, layout: "vertical" });
              splitLeaf(leafId, "vertical");
              const next = useUILayoutStore.getState();
              const nextChatId = next.leafChatIds[next.activeLeafId] ?? null;
              if (nextChatId) selectChat(nextChatId);
            }}
          />

          <Button
            size="small"
            type="text"
            danger
            icon={<CloseOutlined />}
            disabled={!canClose}
            title="关闭"
            aria-label="关闭"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              uiLayoutDebug("pane close request", { leafId });
              closeLeaf(leafId);
              const next = useUILayoutStore.getState();
              const nextChatId = next.leafChatIds[next.activeLeafId] ?? null;
              selectChat(nextChatId);
            }}
          />
        </Flex>
      </div>

      {chatId ? (
        <ChatView chatId={chatId} embedded={true} />
      ) : (
        <Flex
          vertical
          align="center"
          justify="center"
          style={{ height: "100%", minHeight: 0, padding: token.paddingLG }}
        >
          <div style={{ color: token.colorTextSecondary }}>
            选择一个会话开始聊天
          </div>
          <div style={{ color: token.colorTextTertiary, fontSize: 12 }}>
            悬停右上角可以分屏/关闭
          </div>
        </Flex>
      )}
    </div>
  );
};

const SplitNodeView: React.FC<{ node: LayoutSplitNode }> = ({ node }) => {
  const sizes = useUILayoutStore((s) => s.splitSizesPx[node.id] ?? null);
  const setSplitSizesPx = useUILayoutStore((s) => s.setSplitSizesPx);

  return (
    <ResizableSplit
      layout={node.layout}
      sizesPx={sizes}
      defaultSplitRatio={0.5}
      minFirstPx={240}
      minSecondPx={240}
      style={{ height: "100%", minHeight: 0 }}
      onResizeEnd={(nextSizes) => {
        setSplitSizesPx(node.id, nextSizes);
      }}
      first={<LayoutNodeView node={node.children[0]} />}
      second={<LayoutNodeView node={node.children[1]} />}
    />
  );
};

const LayoutNodeView: React.FC<{ node: LayoutNode }> = ({ node }) => {
  if (node.type === "leaf") {
    return <PaneShell leafId={node.id} />;
  }

  return <SplitNodeView node={node} />;
};

export const MultiPaneChatView: React.FC = () => {
  const { token } = useToken();

  const tree = useUILayoutStore((s) => s.tree);
  const leafChatIds = useUILayoutStore((s) => s.leafChatIds);
  const activeLeafId = useUILayoutStore((s) => s.activeLeafId);
  const setActiveLeafId = useUILayoutStore((s) => s.setActiveLeafId);
  const setLeafChatId = useUILayoutStore((s) => s.setLeafChatId);
  const clearChatFromAllLeaves = useUILayoutStore((s) => s.clearChatFromAllLeaves);

  const chats = useAppStore((s) => s.chats);
  const currentChatId = useAppStore((s) => s.currentChatId);

  const didSeedInitialChatRef = useRef(false);
  const leafIds = useMemo(() => getLeafIdsFromTree(tree), [tree]);
  const chatIdSet = useMemo(() => new Set(chats.map((c) => c.id)), [chats]);

  // Ensure active leaf is always valid.
  useEffect(() => {
    if (leafIds.length === 0) return;
    if (!leafIds.includes(activeLeafId)) {
      setActiveLeafId(leafIds[0]);
    }
  }, [activeLeafId, leafIds, setActiveLeafId]);

  // Prune deleted chats from pane assignments.
  useEffect(() => {
    for (const [leafId, mappedChatId] of Object.entries(leafChatIds)) {
      if (mappedChatId && !chatIdSet.has(mappedChatId)) {
        setLeafChatId(leafId, null);
      }
    }
  }, [chatIdSet, leafChatIds, setLeafChatId]);

  // Seed initial pane assignment once so fresh sessions aren't blank.
  useEffect(() => {
    if (!currentChatId) return;
    if (didSeedInitialChatRef.current) return;
    const hasAny = Object.values(leafChatIds).some(Boolean);
    if (!hasAny) {
      setLeafChatId(activeLeafId, currentChatId);
      didSeedInitialChatRef.current = true;
      return;
    }
    didSeedInitialChatRef.current = true;
  }, [activeLeafId, currentChatId, leafChatIds, setLeafChatId]);

  // NOTE: We intentionally avoid "two-way binding" between global `currentChatId`
  // and pane assignments. The sidebar and pane click handlers already coordinate
  // `setLeafChatId(...)` and `selectChat(...)`. Extra sync effects here can create
  // selection ping-pong (especially during Create New Session) and trigger
  // "Maximum update depth exceeded".

  // Clear assignments for chats when they are deleted via store actions elsewhere.
  useEffect(() => {
    // This is intentionally coarse: it keeps UI layout consistent if some other flow
    // deletes chats without going through ChatSidebar handlers.
    const mappedChatIds = new Set(
      Object.values(leafChatIds).filter(Boolean) as string[],
    );
    for (const mappedChatId of mappedChatIds) {
      if (!chatIdSet.has(mappedChatId)) {
        clearChatFromAllLeaves(mappedChatId);
      }
    }
  }, [chatIdSet, clearChatFromAllLeaves, leafChatIds]);

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        padding: token.paddingSM,
      }}
    >
      <LayoutNodeView node={tree} />
    </div>
  );
};
