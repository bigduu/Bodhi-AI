export const formatUserToolCall = (toolCall: string): string => {
  if (!toolCall.startsWith("/")) return toolCall;

  const parts = toolCall.split(" ");
  const toolName = parts[0].substring(1);
  const description = parts.slice(1).join(" ");

  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      const serverId = rest.slice(0, sep);
      const originalName = rest.slice(sep + 2);
      if (serverId && originalName) {
        return `🔌 MCP ${serverId}/${originalName}: ${description}`;
      }
    }
  }

  const friendlyToolName = toolName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());

  return `🔧 ${friendlyToolName}: ${description}`;
};
