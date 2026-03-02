import React from "react";
import {
  Button,
  Card,
  Flex,
  Popconfirm,
  Space,
  Switch,
  Typography,
  theme,
  Divider,
} from "antd";
import {
  DeleteOutlined,
  WarningOutlined,
  RedoOutlined,
} from "@ant-design/icons";

const { Text } = Typography;
const { useToken } = theme;

interface SystemSettingsAppTabProps {
  autoGenerateTitles: boolean;
  isUpdatingAutoTitlePreference: boolean;
  onAutoTitleToggle: (checked: boolean) => void;
  themeMode: "light" | "dark";
  onThemeModeChange: (mode: "light" | "dark") => void;
  onDeleteAll: () => void;
  onDeleteEmpty: () => void;
  onClearLocalStorage: () => void;
  onResetApp: () => void;
  isResetting: boolean;
  darkModeKey: string;
}

const SystemSettingsAppTab: React.FC<SystemSettingsAppTabProps> = ({
  autoGenerateTitles,
  isUpdatingAutoTitlePreference,
  onAutoTitleToggle,
  themeMode,
  onThemeModeChange,
  onDeleteAll,
  onDeleteEmpty,
  onClearLocalStorage,
  onResetApp,
  isResetting,
  darkModeKey,
}) => {
  const { token } = useToken();

  return (
    <Card size="small">
      <Space
        direction="vertical"
        size={token.marginSM}
        style={{ width: "100%" }}
      >
        <Flex align="center" gap={token.marginSM}>
          <Text strong>Auto-generate Session Titles</Text>
          <Switch
            checked={autoGenerateTitles}
            loading={isUpdatingAutoTitlePreference}
            onChange={onAutoTitleToggle}
            checkedChildren="ON"
            unCheckedChildren="OFF"
          />
        </Flex>
        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          When enabled, the app generates a descriptive title after the first
          assistant response.
        </Text>
        <Flex align="center" gap={token.marginSM}>
          <Text strong>Dark Mode</Text>
          <Switch
            data-testid="dark-mode-toggle"
            checked={themeMode === "dark"}
            onChange={(checked) => {
              const mode = checked ? "dark" : "light";
              onThemeModeChange(mode);
              localStorage.setItem(darkModeKey, mode);
            }}
            checkedChildren="Dark"
            unCheckedChildren="Light"
          />
        </Flex>
        <Popconfirm
          title="Delete all sessions"
          description="Are you sure? This will delete all sessions except pinned."
          onConfirm={onDeleteAll}
          okText="Yes, delete all"
          cancelText="Cancel"
          placement="top"
        >
          <Button danger block icon={<DeleteOutlined />}>
            Delete All Sessions
          </Button>
        </Popconfirm>
        <Popconfirm
          title="Delete empty sessions"
          description="Are you sure? This will delete all sessions with no messages (except pinned)."
          onConfirm={onDeleteEmpty}
          okText="Yes, delete empty"
          cancelText="Cancel"
          placement="top"
        >
          <Button danger block icon={<DeleteOutlined />}>
            Delete Empty Sessions
          </Button>
        </Popconfirm>
        <Popconfirm
          title="Clear Local Storage"
          description="Are you sure? This will delete all local storage data and reset the application."
          onConfirm={onClearLocalStorage}
          okText="Yes, clear it"
          cancelText="Cancel"
          placement="top"
        >
          <Button danger block icon={<DeleteOutlined />}>
            Clear Local Storage
          </Button>
        </Popconfirm>

        <Divider style={{ margin: `${token.marginSM}px 0` }} />

        <Flex align="center" gap={token.marginSM}>
          <WarningOutlined style={{ color: token.colorError }} />
          <Text strong style={{ color: token.colorError }}>
            Danger Zone
          </Text>
        </Flex>
        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          These actions cannot be undone. All data will be permanently deleted.
        </Text>

        <Popconfirm
          title="Reset Application"
          description={
            <div>
              <p>Are you sure? This will:</p>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                <li>Delete ALL sessions (including pinned)</li>
                <li>Clear all local storage data</li>
                <li>Reset config.json to default</li>
                <li>Trigger the initial setup flow on next launch</li>
                <li>Reload the application</li>
              </ul>
            </div>
          }
          onConfirm={onResetApp}
          okText="Yes, reset everything"
          cancelText="Cancel"
          placement="top"
          okButtonProps={{ danger: true }}
        >
          <Button
            data-testid="reset-to-defaults"
            danger
            block
            type="primary"
            icon={<RedoOutlined />}
            loading={isResetting}
          >
            Reset Application (All Data)
          </Button>
        </Popconfirm>
      </Space>
    </Card>
  );
};

export default SystemSettingsAppTab;
