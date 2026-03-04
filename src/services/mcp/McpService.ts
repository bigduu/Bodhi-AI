import { agentApiClient } from "../api";
import {
  createDefaultMcpServerConfig,
  createDefaultRuntimeInfo,
  DEFAULT_HEALTHCHECK_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SSE_CONNECT_TIMEOUT_MS,
  DEFAULT_STDIO_STARTUP_TIMEOUT_MS,
  ServerStatus,
  type McpActionResponse,
  type McpImportResponse,
  type McpServer,
  type McpServerApiRecord,
  type McpServerConfig,
  type McpToolInfo,
  type RuntimeInfo,
  type ServerListResponse,
  type ToolListResponse,
  type TransportConfig,
} from "./types";

const parseStatus = (value: unknown): ServerStatus => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case ServerStatus.Connecting:
      return ServerStatus.Connecting;
    case ServerStatus.Ready:
      return ServerStatus.Ready;
    case ServerStatus.Degraded:
      return ServerStatus.Degraded;
    case ServerStatus.Error:
      return ServerStatus.Error;
    case ServerStatus.Stopped:
    default:
      return ServerStatus.Stopped;
  }
};

const toNumber = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const normalizeTransport = (
  value: unknown,
  fallback: TransportConfig,
): TransportConfig => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const transport = value as Record<string, unknown>;
  if (transport.type === "sse") {
    const headers = Array.isArray(transport.headers)
      ? transport.headers
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const pair = item as Record<string, unknown>;
            if (
              typeof pair.name !== "string" ||
              typeof pair.value !== "string"
            ) {
              return null;
            }
            return {
              name: pair.name,
              value: pair.value,
            };
          })
          .filter((item): item is { name: string; value: string } =>
            Boolean(item),
          )
      : [];

    return {
      type: "sse",
      url: typeof transport.url === "string" ? transport.url : "",
      headers,
      connect_timeout_ms: toNumber(
        transport.connect_timeout_ms,
        DEFAULT_SSE_CONNECT_TIMEOUT_MS,
      ),
    };
  }

  const args = Array.isArray(transport.args)
    ? transport.args.filter((item): item is string => typeof item === "string")
    : [];

  const envEntries =
    transport.env && typeof transport.env === "object"
      ? Object.entries(transport.env as Record<string, unknown>)
      : [];

  return {
    type: "stdio",
    command: typeof transport.command === "string" ? transport.command : "",
    args,
    cwd: typeof transport.cwd === "string" ? transport.cwd : undefined,
    env: envEntries.reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === "string") {
        acc[key] = value;
      }
      return acc;
    }, {}),
    startup_timeout_ms: toNumber(
      transport.startup_timeout_ms,
      DEFAULT_STDIO_STARTUP_TIMEOUT_MS,
    ),
  };
};

const normalizeServerConfig = (
  record: McpServerApiRecord,
  config: Partial<McpServerConfig> | undefined,
): McpServerConfig => {
  const base = createDefaultMcpServerConfig(record.id);
  const incoming = config ?? {};

  const merged: McpServerConfig = {
    ...base,
    ...incoming,
    id: record.id,
    name:
      typeof incoming.name === "string"
        ? incoming.name
        : typeof record.name === "string"
          ? record.name
          : undefined,
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : typeof incoming.enabled === "boolean"
          ? incoming.enabled
          : true,
    request_timeout_ms: toNumber(
      incoming.request_timeout_ms,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    healthcheck_interval_ms: toNumber(
      incoming.healthcheck_interval_ms,
      DEFAULT_HEALTHCHECK_INTERVAL_MS,
    ),
    allowed_tools: Array.isArray(incoming.allowed_tools)
      ? incoming.allowed_tools.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    denied_tools: Array.isArray(incoming.denied_tools)
      ? incoming.denied_tools.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    reconnect:
      incoming.reconnect && typeof incoming.reconnect === "object"
        ? {
            enabled:
              typeof incoming.reconnect.enabled === "boolean"
                ? incoming.reconnect.enabled
                : true,
            initial_backoff_ms: toNumber(
              incoming.reconnect.initial_backoff_ms,
              1000,
            ),
            max_backoff_ms: toNumber(incoming.reconnect.max_backoff_ms, 30_000),
            max_attempts: toNumber(incoming.reconnect.max_attempts, 0),
          }
        : undefined,
    transport: normalizeTransport(incoming.transport, base.transport),
  };

  return merged;
};

const normalizeRuntime = (record: McpServerApiRecord): RuntimeInfo => {
  const base = createDefaultRuntimeInfo();
  const runtime = record.runtime ?? {};

  const runtimeRecord = runtime as Record<string, unknown>;
  const statusCandidate = runtimeRecord.status ?? (record.status as unknown);

  return {
    status: parseStatus(statusCandidate),
    last_error:
      typeof runtimeRecord.last_error === "string"
        ? runtimeRecord.last_error
        : typeof record.last_error === "string"
          ? record.last_error
          : undefined,
    connected_at:
      typeof runtimeRecord.connected_at === "string"
        ? runtimeRecord.connected_at
        : undefined,
    disconnected_at:
      typeof runtimeRecord.disconnected_at === "string"
        ? runtimeRecord.disconnected_at
        : undefined,
    tool_count: toNumber(
      runtimeRecord.tool_count ?? record.tool_count,
      base.tool_count,
    ),
    restart_count: toNumber(
      runtimeRecord.restart_count ?? record.restart_count,
      base.restart_count,
    ),
    last_ping_at:
      typeof runtimeRecord.last_ping_at === "string"
        ? runtimeRecord.last_ping_at
        : undefined,
  };
};

const normalizeServer = (record: McpServerApiRecord): McpServer => {
  const config = normalizeServerConfig(record, record.config);
  return {
    id: record.id,
    name:
      typeof record.name === "string"
        ? record.name
        : typeof config.name === "string"
          ? config.name
          : record.id,
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : config.enabled,
    config,
    runtime: normalizeRuntime(record),
  };
};

const buildAlias = (serverId: string, toolName: string): string =>
  `mcp__${serverId}__${toolName}`;

const parseAlias = (
  value: string,
): { server_id: string; original_name: string } | null => {
  if (!value.startsWith("mcp__")) return null;
  const rest = value.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server_id = rest.slice(0, sep);
  const original_name = rest.slice(sep + 2);
  if (!server_id || !original_name) return null;
  return { server_id, original_name };
};

const normalizeToolInfo = (
  raw: unknown,
  serverIdFallback?: string,
  index = 0,
): McpToolInfo | null => {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const aliasCandidate =
    typeof record.alias === "string"
      ? record.alias
      : typeof record.name === "string" && record.name.startsWith("mcp__")
        ? record.name
        : undefined;

  const parsedFromAlias =
    aliasCandidate && typeof aliasCandidate === "string"
      ? parseAlias(aliasCandidate)
      : null;

  const server_id =
    (typeof record.server_id === "string" ? record.server_id : undefined) ??
    (typeof record.serverId === "string" ? record.serverId : undefined) ??
    parsedFromAlias?.server_id ??
    serverIdFallback ??
    "";

  const original_name =
    (typeof record.original_name === "string"
      ? record.original_name
      : undefined) ??
    (typeof record.originalName === "string"
      ? record.originalName
      : undefined) ??
    parsedFromAlias?.original_name ??
    (typeof record.name === "string" ? record.name : undefined) ??
    "";

  const alias =
    aliasCandidate ??
    (server_id && original_name ? buildAlias(server_id, original_name) : "");

  const description =
    typeof record.description === "string" ? record.description : "";

  const parameters =
    "parameters" in record
      ? (record as any).parameters
      : "inputSchema" in record
        ? (record as any).inputSchema
        : "input_schema" in record
          ? (record as any).input_schema
          : undefined;

  const safeAlias = alias || original_name || `mcp_tool_${index}`;

  return {
    alias: safeAlias,
    server_id: server_id || "unknown",
    original_name: original_name || safeAlias,
    description,
    parameters,
  };
};

export class McpService {
  async getServers(): Promise<McpServer[]> {
    const response =
      await agentApiClient.get<ServerListResponse>("mcp/servers");
    return Array.isArray(response.servers)
      ? response.servers.map(normalizeServer)
      : [];
  }

  async addServer(config: McpServerConfig): Promise<McpActionResponse> {
    return agentApiClient.post<McpActionResponse>("mcp/servers", config);
  }

  async updateServer(
    serverId: string,
    config: McpServerConfig,
  ): Promise<McpActionResponse> {
    const payload: McpServerConfig = {
      ...config,
      id: serverId,
    };
    return agentApiClient.put<McpActionResponse>(
      `mcp/servers/${serverId}`,
      payload,
    );
  }

  async deleteServer(serverId: string): Promise<McpActionResponse> {
    return agentApiClient.delete<McpActionResponse>(`mcp/servers/${serverId}`);
  }

  async connectServer(serverId: string): Promise<McpActionResponse> {
    return agentApiClient.post<McpActionResponse>(
      `mcp/servers/${serverId}/connect`,
    );
  }

  async disconnectServer(serverId: string): Promise<McpActionResponse> {
    return agentApiClient.post<McpActionResponse>(
      `mcp/servers/${serverId}/disconnect`,
    );
  }

  async refreshTools(serverId: string): Promise<McpActionResponse> {
    return agentApiClient.post<McpActionResponse>(
      `mcp/servers/${serverId}/refresh`,
    );
  }

  async getTools(serverId?: string): Promise<McpToolInfo[]> {
    const path = serverId ? `mcp/servers/${serverId}/tools` : "mcp/tools";
    const response = await agentApiClient.get<ToolListResponse>(path);
    const rawTools = Array.isArray(response.tools) ? response.tools : [];
    return rawTools
      .map((tool, index) => normalizeToolInfo(tool, serverId, index))
      .filter((tool): tool is McpToolInfo => Boolean(tool));
  }

  async importServers(payload: {
    mcpServers: unknown;
    mode?: "merge" | "replace";
  }): Promise<McpImportResponse> {
    return agentApiClient.post<McpImportResponse>("mcp/servers/import", payload);
  }
}

export const mcpService = new McpService();
