import { useEffect, useState } from "react";
import { Button, Flex, Layout, Tabs, Typography, message, theme } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useChatManager } from "../../../ChatPage/hooks/useChatManager";
import { serviceFactory } from "../../../../services/common/ServiceFactory";
import {
  getSystemPromptEnhancement,
  setSystemPromptEnhancement,
} from "../../../../shared/utils/systemPromptEnhancement";
import {
  isMermaidEnhancementEnabled,
  setMermaidEnhancementEnabled,
} from "../../../../shared/utils/mermaidUtils";
import {
  isTodoEnhancementEnabled,
  setTodoEnhancementEnabled,
} from "../../../../shared/utils/todoEnhancementUtils";
import SystemSettingsConfigTab from "./SystemSettingsConfigTab";
import SystemSettingsPromptsTab from "./SystemSettingsPromptsTab";
import SystemSettingsAppTab from "./SystemSettingsAppTab";
import SystemSettingsKeywordMaskingTab from "./SystemSettingsKeywordMaskingTab";
import SystemSettingsWorkflowsTab from "./SystemSettingsWorkflowsTab";
import SystemSettingsMcpTab from "./SystemSettingsMcpTab";
import SystemSettingsMetricsTab from "./SystemSettingsMetricsTab";
import SystemSettingsHooksTab from "./SystemSettingsHooksTab";
import MermaidSettingsTab from "./MermaidSettingsTab";
import SystemSettingsSchedulesTab from "./SystemSettingsSchedulesTab";
import SystemSettingsSessionsTab from "./SystemSettingsSessionsTab";
import { ProviderSettings } from "../ProviderSettings";
import { SkillManager } from "../../../../components/Skill";

const { Text } = Typography;
const { useToken } = theme;

const DARK_MODE_KEY = "bamboo_dark_mode";

const SystemSettingsPage = ({
  themeMode,
  onThemeModeChange,
  onBack,
}: {
  themeMode: "light" | "dark";
  onThemeModeChange: (mode: "light" | "dark") => void;
  onBack: () => void;
}) => {
  const { token } = useToken();
  const {
    deleteAllUnpinnedChats,
    deleteEmptyChats,
    deleteAllChats,
    autoGenerateTitles,
    setAutoGenerateTitlesPreference,
    isUpdatingAutoTitlePreference,
  } = useChatManager();
  const [isResetting, setIsResetting] = useState(false);
  const [msgApi, contextHolder] = message.useMessage();
  const [promptEnhancement, setPromptEnhancement] = useState("");
  const [mermaidEnhancementEnabled, setMermaidEnhancementEnabledState] =
    useState(isMermaidEnhancementEnabled());
  const [todoEnhancementEnabled, setTodoEnhancementEnabledState] = useState(
    isTodoEnhancementEnabled(),
  );

  const handleDeleteAll = () => {
    void deleteAllUnpinnedChats();
    msgApi.success("All sessions deleted (except pinned)");
  };

  const handleDeleteEmpty = () => {
    void deleteEmptyChats();
    msgApi.success("Empty sessions deleted (except pinned)");
  };

  const handleClearLocalStorage = () => {
    localStorage.clear();
    msgApi.success("Local storage has been cleared");
  };

  const handleResetApp = async () => {
    setIsResetting(true);
    try {
      // 1. Delete all chats (including pinned)
      await deleteAllChats();

      // 2. Reset setup status to force re-initialization on next launch
      await serviceFactory.resetSetupStatus();

      // 3. Reset config.json on backend
      await serviceFactory.resetBambooConfig();

      // 4. Clear localStorage
      localStorage.clear();

      msgApi.success("Application reset successful. Reloading...");

      // 5. Reload the page after a short delay
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error("Failed to reset application:", error);
      msgApi.error(
        error instanceof Error ? error.message : "Failed to reset application",
      );
      setIsResetting(false);
    }
  };

  const handleAutoTitleToggle = async (checked: boolean) => {
    try {
      await setAutoGenerateTitlesPreference(checked);
      msgApi.success(
        checked
          ? "Auto title generation enabled"
          : "Auto title generation disabled",
      );
    } catch (error) {
      msgApi.error("Failed to update auto title preference");
    }
  };

  const handleSaveEnhancement = () => {
    setSystemPromptEnhancement(promptEnhancement);
    msgApi.success("System prompt enhancement saved");
  };

  const handleMermaidToggle = (checked: boolean) => {
    setMermaidEnhancementEnabledState(checked);
    setMermaidEnhancementEnabled(checked);
  };

  const handleTodoToggle = (checked: boolean) => {
    setTodoEnhancementEnabledState(checked);
    setTodoEnhancementEnabled(checked);
  };

  useEffect(() => {
    setPromptEnhancement(getSystemPromptEnhancement());
    setMermaidEnhancementEnabledState(isMermaidEnhancementEnabled());
    setTodoEnhancementEnabledState(isTodoEnhancementEnabled());
  }, []);

  return (
    <Flex
      vertical
      style={{
        height: "100vh",
        overflow: "hidden",
        background: token.colorBgContainer,
      }}
    >
      {contextHolder}
      <Flex
        align="center"
        justify="space-between"
        style={{
          padding: token.padding,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex align="center" gap={token.marginSM}>
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
            Back
          </Button>
          <Text strong>System Settings</Text>
        </Flex>
      </Flex>
      <Layout.Content
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: token.padding,
        }}
      >
        <Tabs
          tabPosition="left"
          items={[
            {
              key: "config",
              label: "Config",
              children: <SystemSettingsConfigTab msgApi={msgApi} />,
            },
            {
              key: "prompts",
              label: "Prompts",
              children: (
                <SystemSettingsPromptsTab
                  promptEnhancement={promptEnhancement}
                  onPromptEnhancementChange={setPromptEnhancement}
                  mermaidEnhancementEnabled={mermaidEnhancementEnabled}
                  todoEnhancementEnabled={todoEnhancementEnabled}
                  onMermaidToggle={handleMermaidToggle}
                  onTodoToggle={handleTodoToggle}
                  onSaveEnhancement={handleSaveEnhancement}
                />
              ),
            },
            {
              key: "mermaid",
              label: "Mermaid",
              children: <MermaidSettingsTab />,
            },
            {
              key: "skills",
              label: "Skills",
              children: <SkillManager />,
            },
            {
              key: "workflows",
              label: "Workflows",
              children: <SystemSettingsWorkflowsTab />,
            },
            {
              key: "mcp",
              label: "MCP",
              children: <SystemSettingsMcpTab />,
            },
            {
              key: "metrics",
              label: "Metrics",
              children: <SystemSettingsMetricsTab />,
            },
            {
              key: "schedules",
              label: "Schedules",
              children: <SystemSettingsSchedulesTab />,
            },
            {
              key: "sessions",
              label: "Sessions",
              children: <SystemSettingsSessionsTab />,
            },
            {
              key: "app",
              label: "App",
              children: (
                <SystemSettingsAppTab
                  autoGenerateTitles={autoGenerateTitles}
                  isUpdatingAutoTitlePreference={isUpdatingAutoTitlePreference}
                  onAutoTitleToggle={handleAutoTitleToggle}
                  themeMode={themeMode}
                  onThemeModeChange={onThemeModeChange}
                  onDeleteAll={handleDeleteAll}
                  onDeleteEmpty={handleDeleteEmpty}
                  onClearLocalStorage={handleClearLocalStorage}
                  onResetApp={handleResetApp}
                  isResetting={isResetting}
                  darkModeKey={DARK_MODE_KEY}
                />
              ),
            },
            {
              key: "provider",
              label: "Provider",
              children: <ProviderSettings />,
            },
            {
              key: "hooks",
              label: "Hooks",
              children: <SystemSettingsHooksTab />,
            },
            {
              key: "masking",
              label: "Masking",
              children: <SystemSettingsKeywordMaskingTab />,
            },
          ]}
        />
      </Layout.Content>
    </Flex>
  );
};

export { SystemSettingsPage };
