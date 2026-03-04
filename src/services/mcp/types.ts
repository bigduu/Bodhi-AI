export enum ServerStatus {
  Connecting = "connecting",
  Ready = "ready",
  Degraded = "degraded",
  Stopped = "stopped",
  Error = "error",
}

export interface HeaderConfig {
  name: string;
  value: string;
}

export interface ReconnectConfig {
  enabled: boolean;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  max_attempts: number;
}

export interface StdioTransportConfig {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  startup_timeout_ms?: number;
}

export interface SseTransportConfig {
  type: "sse";
  url: string;
  headers: HeaderConfig[];
  connect_timeout_ms?: number;
}

export type TransportConfig = StdioTransportConfig | SseTransportConfig;

export interface McpServerConfig {
  id: string;
  name?: string;
  enabled: boolean;
  transport: TransportConfig;
  request_timeout_ms: number;
  healthcheck_interval_ms: number;
  reconnect?: ReconnectConfig;
  allowed_tools: string[];
  denied_tools: string[];
}

export interface RuntimeInfo {
  status: ServerStatus;
  last_error?: string;
  connected_at?: string;
  disconnected_at?: string;
  tool_count: number;
  restart_count: number;
  last_ping_at?: string;
}

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  config: McpServerConfig;
  runtime?: RuntimeInfo;
}

export interface McpTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface McpToolInfo {
  alias: string;
  server_id: string;
  original_name: string;
  description: string;
  // JSON Schema describing expected arguments for this MCP tool.
  // Optional for backward compatibility with older backends.
  parameters?: unknown;
}

// Raw tool record returned by the backend. Historically this used snake_case
// fields, but newer MCP-compatible backends may return `name` + `inputSchema`.
export type McpToolApiRecord = Partial<{
  alias: string;
  server_id: string;
  serverId: string;
  original_name: string;
  originalName: string;
  name: string;
  description: string;
  parameters: unknown;
  inputSchema: unknown;
  input_schema: unknown;
}>;

export interface McpServerApiRecord {
  id: string;
  name?: string;
  enabled?: boolean;
  status?: string;
  tool_count?: number;
  last_error?: string;
  restart_count?: number;
  config?: Partial<McpServerConfig>;
  runtime?: Partial<RuntimeInfo>;
}

export interface ServerListResponse {
  servers: McpServerApiRecord[];
}

export interface ToolListResponse {
  tools: McpToolApiRecord[];
}

export interface McpActionResponse {
  message: string;
  server_id: string;
  tool_count?: number;
  error?: string;
}

export interface McpImportResponse {
  message: string;
  mode: "merge" | "replace";
  added: number;
  updated: number;
  removed: number;
  server_ids: string[];
  start_errors?: Array<{ server_id: string; error: string }>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_HEALTHCHECK_INTERVAL_MS = 30_000;
export const DEFAULT_STDIO_STARTUP_TIMEOUT_MS = 20_000;
export const DEFAULT_SSE_CONNECT_TIMEOUT_MS = 10_000;

export const createDefaultMcpServerConfig = (id: string): McpServerConfig => ({
  id,
  enabled: true,
  transport: {
    type: "stdio",
    command: "",
    args: [],
    env: {},
    startup_timeout_ms: DEFAULT_STDIO_STARTUP_TIMEOUT_MS,
  },
  request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
  healthcheck_interval_ms: DEFAULT_HEALTHCHECK_INTERVAL_MS,
  allowed_tools: [],
  denied_tools: [],
});

export const createDefaultRuntimeInfo = (): RuntimeInfo => ({
  status: ServerStatus.Stopped,
  tool_count: 0,
  restart_count: 0,
});
