export type McpToolAliasParts = {
  serverId: string;
  toolName: string;
};

/**
 * Parse MCP tool alias like `mcp__{serverId}__{toolName}`.
 *
 * Note: we intentionally only split on the first `__` after `mcp__` to avoid
 * breaking tool names that may contain `__` in the future.
 */
export const parseMcpToolAlias = (value: string): McpToolAliasParts | null => {
  if (typeof value !== "string") return null;
  if (!value.startsWith("mcp__")) return null;

  const rest = value.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;

  const serverId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (!serverId || !toolName) return null;

  return { serverId, toolName };
};

