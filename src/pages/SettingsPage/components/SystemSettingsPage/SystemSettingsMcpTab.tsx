import { CopyOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Modal,
  Radio,
  Space,
  Tag,
  Input,
  Typography,
  message,
  theme,
} from "antd";
import { useMemo, useState } from "react";
import {
  ServerStatus,
  mcpService,
  type McpServer,
  type McpImportResponse,
} from "../../../../services/mcp";
import { useMcpSettings } from "./hooks/useMcpSettings";
import { McpServerTable } from "./mcp/McpServerTable";
import { McpServerFormModal } from "./mcp/McpServerFormModal";
import { McpToolList } from "./mcp/McpToolList";
import { copyText } from "@shared/utils/clipboard";

const { Text } = Typography;
const { useToken } = theme;
const { TextArea } = Input;

type ImportMode = "merge" | "replace";

const statusLabelMap: Record<ServerStatus, string> = {
  [ServerStatus.Connecting]: "Connecting",
  [ServerStatus.Ready]: "Ready",
  [ServerStatus.Degraded]: "Degraded",
  [ServerStatus.Stopped]: "Stopped",
  [ServerStatus.Error]: "Error",
};

const statusColorMap: Record<ServerStatus, string> = {
  [ServerStatus.Connecting]: "blue",
  [ServerStatus.Ready]: "green",
  [ServerStatus.Degraded]: "orange",
  [ServerStatus.Stopped]: "default",
  [ServerStatus.Error]: "red",
};

const makeStatusCounters = (): Record<ServerStatus, number> => ({
  [ServerStatus.Connecting]: 0,
  [ServerStatus.Ready]: 0,
  [ServerStatus.Degraded]: 0,
  [ServerStatus.Stopped]: 0,
  [ServerStatus.Error]: 0,
});

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
};

type MainstreamMcpServersChunk = {
  mcpServers: Record<string, unknown>;
};

const toMainstreamMcpServersChunk = (
  servers: McpServer[],
): MainstreamMcpServersChunk => {
  const mcpServers: Record<string, unknown> = {};

  for (const server of servers) {
    const id = server.id?.trim();
    if (!id) continue;

    const enabled = server.enabled ?? server.config.enabled;
    const disabled = !enabled;

    const transport = server.config.transport;
    if (transport.type === "sse") {
      const headers: Record<string, string> = {};
      for (const h of transport.headers ?? []) {
        const name = h.name?.trim();
        if (!name) continue;
        headers[name] = h.value ?? "";
      }

      const entry: Record<string, unknown> = {
        url: transport.url,
      };
      if (disabled) entry.disabled = true;
      if (Object.keys(headers).length) entry.headers = headers;
      mcpServers[id] = entry;
      continue;
    }

    const entry: Record<string, unknown> = {
      command: transport.command,
    };
    if (disabled) entry.disabled = true;
    if (transport.args?.length) entry.args = transport.args;
    if (transport.cwd) entry.cwd = transport.cwd;
    if (transport.env && Object.keys(transport.env).length) entry.env = transport.env;
    mcpServers[id] = entry;
  }

  return { mcpServers };
};

const SystemSettingsMcpTab: React.FC = () => {
  const { token } = useToken();
  const [msgApi, contextHolder] = message.useMessage();
  const {
    servers,
    selectedServerId,
    selectedServerTools,
    isLoadingServers,
    isMutatingConfig,
    isRefreshingAll,
    isSelectedServerToolsLoading,
    error,
    setSelectedServerId,
    addServer,
    updateServer,
    deleteServer,
    connectServer,
    disconnectServer,
    refreshServerTools,
    refreshAll,
    isServerActionLoading,
  } = useMcpSettings();

  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [serverModalMode, setServerModalMode] = useState<"create" | "edit">(
    "create",
  );
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [importJson, setImportJson] = useState<string>("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const selectedServer = useMemo(() => {
    if (!selectedServerId) {
      return null;
    }
    return servers.find((server) => server.id === selectedServerId) ?? null;
  }, [selectedServerId, servers]);

  const statusSummary = useMemo(() => {
    const byStatus = makeStatusCounters();
    let toolCount = 0;

    servers.forEach((server) => {
      const status = server.runtime?.status ?? ServerStatus.Stopped;
      byStatus[status] += 1;
      toolCount += server.runtime?.tool_count ?? 0;
    });

    return {
      byStatus,
      totalServers: servers.length,
      totalTools: toolCount,
    };
  }, [servers]);

  const handleDeleteServer = async (server: McpServer) => {
    try {
      await deleteServer(server.id);
      msgApi.success("MCP server deleted");
    } catch (deleteError) {
      msgApi.error(getErrorMessage(deleteError, "Failed to delete MCP server"));
    }
  };

  const handleConnectServer = async (server: McpServer) => {
    try {
      await connectServer(server.id);
      msgApi.success(`Connected to ${server.name || server.id}`);
    } catch (connectError) {
      msgApi.error(
        getErrorMessage(connectError, "Failed to connect MCP server"),
      );
    }
  };

  const handleDisconnectServer = async (server: McpServer) => {
    try {
      await disconnectServer(server.id);
      msgApi.success(`Disconnected ${server.name || server.id}`);
    } catch (disconnectError) {
      msgApi.error(
        getErrorMessage(disconnectError, "Failed to disconnect MCP server"),
      );
    }
  };

  const handleRefreshServerTools = async (server: McpServer) => {
    try {
      await refreshServerTools(server.id);
      msgApi.success(`Tools refreshed for ${server.name || server.id}`);
    } catch (refreshError) {
      msgApi.error(getErrorMessage(refreshError, "Failed to refresh tools"));
    }
  };

  const handleRefreshAll = async () => {
    try {
      await refreshAll();
      msgApi.success("MCP status refreshed");
    } catch (refreshError) {
      msgApi.error(
        getErrorMessage(refreshError, "Failed to refresh MCP status"),
      );
    }
  };

  const openCreateServerModal = () => {
    setEditingServer(null);
    setServerModalMode("create");
    setIsServerModalOpen(true);
  };

  const openEditServerModal = (server: McpServer) => {
    setEditingServer(server);
    setServerModalMode("edit");
    setIsServerModalOpen(true);
  };

  const handleSubmitServer = async (config: McpServer["config"]) => {
    try {
      if (serverModalMode === "edit") {
        if (!editingServer) {
          msgApi.error("No server selected for editing");
          return;
        }
        await updateServer(editingServer.id, config);
        msgApi.success(`Saved ${editingServer.name || editingServer.id}`);
      } else {
        await addServer(config);
        msgApi.success(`Added ${config.name || config.id}`);
      }
      setIsServerModalOpen(false);
      setEditingServer(null);
    } catch (e) {
      msgApi.error(getErrorMessage(e, "Failed to save MCP server"));
    }
  };

  const openImportModal = () => {
    setIsImportOpen(true);
    setImportError(null);
    setImportMode("merge");
    setImportJson("");
  };

  const handleExport = async () => {
    const chunk = toMainstreamMcpServersChunk(servers);
    const text = JSON.stringify(chunk, null, 2);

    try {
      await copyText(text);
      msgApi.success("Copied MCP config to clipboard");
    } catch {
      // Clipboard can be blocked depending on platform/webview permissions.
      // Fall back to showing the exported JSON in the modal for manual copy.
      setIsImportOpen(true);
      setImportError(null);
      setImportMode("merge");
      setImportJson(text);
      msgApi.warning("Clipboard not available. Export is shown in the modal.");
    }
  };

  const handleImport = async () => {
    setImportError(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(importJson);
    } catch (e) {
      setImportError(
        `Invalid JSON: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      setImportError("JSON must be an object");
      return;
    }

    const record = parsed as Record<string, unknown>;
    const mcpServers = record.mcpServers;
    if (!mcpServers || typeof mcpServers !== "object") {
      setImportError(
        "Missing 'mcpServers'. Paste a full Claude Desktop-style config chunk: { \"mcpServers\": { ... } }",
      );
      return;
    }

    setIsImporting(true);
    try {
      const response: McpImportResponse = await mcpService.importServers({
        mcpServers,
        mode: importMode,
      });

      const startFailures = response.start_errors?.length ?? 0;
      msgApi.success(
        `Imported ${response.server_ids.length} server(s) (${response.added} added, ${response.updated} updated, ${response.removed} removed).` +
          (startFailures ? ` ${startFailures} failed to start.` : ""),
      );
      if (startFailures) {
        msgApi.warning(
          `Some servers did not start. Config is saved; open the server list to see errors.`,
        );
      }

      setIsImportOpen(false);
      setImportJson("");
      await handleRefreshAll();
    } catch (error) {
      setImportError(getErrorMessage(error, "Failed to import MCP servers"));
      // Keep textarea content so the user can fix and retry.
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Space direction="vertical" size={token.marginMD} style={{ width: "100%" }}>
      {contextHolder}

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card size="small" title="MCP Overview">
        <Space
          direction="vertical"
          size={token.marginXS}
          style={{ width: "100%" }}
        >
          <Text type="secondary">
            Configure external MCP servers and inspect registered tool aliases.
          </Text>
          <Space wrap>
            <Tag>Total servers: {statusSummary.totalServers}</Tag>
            <Tag>Total tools: {statusSummary.totalTools}</Tag>
            {Object.values(ServerStatus).map((status) => (
              <Tag key={status} color={statusColorMap[status]}>
                {statusLabelMap[status]}: {statusSummary.byStatus[status]}
              </Tag>
            ))}
          </Space>
        </Space>
      </Card>

      <Card
        size="small"
        title="MCP Servers"
        extra={
          <Space>
            <Button type="primary" onClick={openCreateServerModal}>
              Add Server
            </Button>
            <Button
              icon={<ReloadOutlined />}
              loading={isRefreshingAll}
              onClick={() => {
                void handleRefreshAll();
              }}
            >
              Refresh All
            </Button>
            <Button icon={<CopyOutlined />} onClick={() => void handleExport()}>
              Export
            </Button>
            <Button icon={<UploadOutlined />} onClick={openImportModal}>
              Import
            </Button>
          </Space>
        }
      >
        <McpServerTable
          servers={servers}
          loading={isLoadingServers}
          selectedServerId={selectedServerId}
          onSelectServer={setSelectedServerId}
          onEditServer={openEditServerModal}
          onDeleteServer={handleDeleteServer}
          onConnectServer={handleConnectServer}
          onDisconnectServer={handleDisconnectServer}
          onRefreshTools={handleRefreshServerTools}
          isServerActionLoading={isServerActionLoading}
        />
      </Card>

      <McpToolList
        server={selectedServer}
        tools={selectedServerTools}
        loading={isSelectedServerToolsLoading}
      />

      <McpServerFormModal
        open={isServerModalOpen}
        mode={serverModalMode}
        initialConfig={editingServer?.config ?? null}
        confirmLoading={isMutatingConfig}
        onCancel={() => {
          if (isMutatingConfig) return;
          setIsServerModalOpen(false);
          setEditingServer(null);
        }}
        onSubmit={(config) => void handleSubmitServer(config)}
      />

      <Modal
        open={isImportOpen}
        title="Import MCP Servers"
        okText="Import"
        onOk={() => void handleImport()}
        okButtonProps={{ loading: isImporting }}
        onCancel={() => {
          if (isImporting) return;
          setIsImportOpen(false);
          setImportError(null);
        }}
        width={800}
        destroyOnClose={false}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Text type="secondary">
            Paste a Claude Desktop-style config chunk. Example:
            <br />
            <Text code>{`{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "..."] } } }`}</Text>
          </Text>

          <Radio.Group
            value={importMode}
            onChange={(e) => setImportMode(e.target.value as ImportMode)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="merge">
              Merge (Upsert)
            </Radio.Button>
            <Radio.Button value="replace">
              Replace (Delete Others)
            </Radio.Button>
          </Radio.Group>

          {importMode === "replace" ? (
            <Alert
              type="warning"
              showIcon
              message="Replace mode will remove existing MCP servers not present in the imported mcpServers."
            />
          ) : null}

          {importError ? <Alert type="error" showIcon message={importError} /> : null}

          <TextArea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            rows={14}
            placeholder='{"mcpServers": { "filesystem": { "command": "...", "args": [], "env": {} } }}'
            spellCheck={false}
          />
        </Space>
      </Modal>
    </Space>
  );
};

export default SystemSettingsMcpTab;
