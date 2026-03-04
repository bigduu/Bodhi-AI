import React, { useMemo } from "react";
import { Descriptions, Table, Typography, theme } from "antd";

import { safeStringify } from "../../../pages/ChatPage/utils/resultFormatters";
import { summarizeJsonSchema, type JsonSchemaField } from "../../utils/jsonSchema";

const { Text } = Typography;

type JsonSchemaViewerProps = {
  schema: unknown;
};

const renderValue = (value: unknown): string => {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return safeStringify(value, 0);
};

export const JsonSchemaViewer: React.FC<JsonSchemaViewerProps> = ({ schema }) => {
  const { token } = theme.useToken();

  const summary = useMemo(() => summarizeJsonSchema(schema), [schema]);

  if (!summary) {
    return (
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {safeStringify(schema, 2)}
      </pre>
    );
  }

  const columns = [
    {
      title: "Field",
      dataIndex: "name",
      key: "name",
      width: 180,
      render: (name: string) => <Text code>{name}</Text>,
    },
    {
      title: "Type",
      dataIndex: "type",
      key: "type",
      width: 140,
      render: (t: string) => <Text>{t}</Text>,
    },
    {
      title: "Required",
      dataIndex: "required",
      key: "required",
      width: 110,
      render: (req: boolean) =>
        req ? (
          <Text strong style={{ color: token.colorError }}>
            Yes
          </Text>
        ) : (
          <Text type="secondary">No</Text>
        ),
    },
    {
      title: "Default",
      dataIndex: "defaultValue",
      key: "default",
      width: 160,
      render: (v: unknown) =>
        v === undefined ? <Text type="secondary">-</Text> : <Text>{renderValue(v)}</Text>,
    },
    {
      title: "Description",
      dataIndex: "description",
      key: "description",
      render: (d?: string) =>
        d ? (
          <Text style={{ whiteSpace: "pre-wrap" }}>{d}</Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
  ] as const;

  const dataSource = (summary.fields ?? []).map((f: JsonSchemaField) => ({
    ...f,
    key: f.name,
  }));

  return (
    <div style={{ width: "100%" }}>
      <Descriptions
        size="small"
        column={1}
        items={[
          summary.schemaUri
            ? {
                key: "schema",
                label: "$schema",
                children: <Text code>{summary.schemaUri}</Text>,
              }
            : null,
          typeof summary.additionalProperties === "boolean"
            ? {
                key: "additionalProperties",
                label: "additionalProperties",
                children: (
                  <Text>
                    {summary.additionalProperties ? "true" : "false"}
                  </Text>
                ),
              }
            : null,
        ].filter(Boolean) as any}
      />

      <Table
        size="small"
        pagination={false}
        columns={columns as any}
        dataSource={dataSource}
        locale={{ emptyText: "No properties in schema" }}
        style={{ marginTop: token.marginSM }}
      />
    </div>
  );
};

export default JsonSchemaViewer;

