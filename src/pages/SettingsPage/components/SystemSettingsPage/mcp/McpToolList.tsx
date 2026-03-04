import { Card, Collapse, Empty, List, Space, Typography } from "antd";
import type { McpServer, McpToolInfo } from "../../../../../services/mcp";
import JsonSchemaViewer from "../../../../../shared/components/JsonSchemaViewer";

const { Text } = Typography;

interface McpToolListProps {
  server: McpServer | null;
  tools: McpToolInfo[];
  loading?: boolean;
}

const buildExpectedAlias = (serverId: string, toolName: string): string =>
  `mcp__${serverId}__${toolName}`;

export const McpToolList: React.FC<McpToolListProps> = ({
  server,
  tools,
  loading = false,
}) => {
  return (
    <Card title="MCP Tools" size="small">
      {!server ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Select a server to inspect its MCP tools"
        />
      ) : (
        <List
          loading={loading}
          dataSource={tools}
          locale={{ emptyText: "No tools found for this server" }}
          renderItem={(tool) => {
            const expectedAlias = buildExpectedAlias(
              tool.server_id,
              tool.original_name,
            );
            return (
              <List.Item>
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Text strong>{tool.original_name}</Text>
                  <Text type="secondary">
                    {tool.description || "No description available"}
                  </Text>
                  <Text code>{tool.alias}</Text>
                  <Text type="secondary">
                    Alias mapping: <Text code>{expectedAlias}</Text>
                  </Text>
                  {tool.parameters !== undefined && (
                    <Collapse
                      size="small"
                      items={[
                        {
                          key: "schema",
                          label: "Parameters schema",
                          children: (
                            <JsonSchemaViewer schema={tool.parameters} />
                          ),
                        },
                      ]}
                    />
                  )}
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
};
