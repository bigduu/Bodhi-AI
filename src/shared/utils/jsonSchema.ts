export type JsonSchemaField = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  enumValues?: unknown[];
};

type JsonSchemaNode = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (obj: JsonSchemaNode, key: string): string | undefined => {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
};

const readBool = (obj: JsonSchemaNode, key: string): boolean | undefined => {
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
};

const readArray = (obj: JsonSchemaNode, key: string): unknown[] | undefined => {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
};

const summarizeType = (node: unknown): string => {
  if (!isRecord(node)) return "any";

  const type = node.type;
  if (typeof type === "string") {
    if (type === "array") {
      const items = node.items;
      return `array<${summarizeType(items)}>`;
    }
    if (type === "object") {
      return "object";
    }
    return type;
  }

  if (Array.isArray(type)) {
    const parts = type
      .filter((t): t is string => typeof t === "string")
      .map((t) => (t === "array" ? "array<any>" : t));
    return parts.length > 0 ? parts.join(" | ") : "any";
  }

  const oneOf = Array.isArray(node.oneOf) ? node.oneOf : null;
  if (oneOf) return oneOf.map(summarizeType).join(" | ") || "any";

  const anyOf = Array.isArray(node.anyOf) ? node.anyOf : null;
  if (anyOf) return anyOf.map(summarizeType).join(" | ") || "any";

  const allOf = Array.isArray(node.allOf) ? node.allOf : null;
  if (allOf) return allOf.map(summarizeType).join(" & ") || "any";

  return "any";
};

export type JsonSchemaSummary = {
  schemaUri?: string;
  title?: string;
  description?: string;
  additionalProperties?: boolean;
  fields: JsonSchemaField[];
};

/**
 * Minimal JSON Schema (draft-2020-12 compatible) summarizer for UI display.
 *
 * We intentionally only support the shapes we expect from MCP tool schemas:
 * - root: { type: "object", properties, required?, additionalProperties? }
 * - property nodes: { type, description?, default?, enum?, items?, oneOf/anyOf/allOf? }
 */
export const summarizeJsonSchema = (
  schema: unknown,
): JsonSchemaSummary | null => {
  if (!isRecord(schema)) return null;

  const properties = schema.properties;
  if (!isRecord(properties)) {
    return {
      schemaUri: readString(schema, "$schema"),
      title: readString(schema, "title"),
      description: readString(schema, "description"),
      additionalProperties: readBool(schema, "additionalProperties"),
      fields: [],
    };
  }

  const required = new Set(
    (readArray(schema, "required") ?? [])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v),
  );

  const fields: JsonSchemaField[] = Object.entries(properties).map(
    ([name, node]) => {
      const rec = isRecord(node) ? node : undefined;
      return {
        name,
        type: summarizeType(node),
        required: required.has(name),
        description: rec ? readString(rec, "description") : undefined,
        defaultValue: rec ? rec.default : undefined,
        enumValues: rec && Array.isArray(rec.enum) ? rec.enum : undefined,
      };
    },
  );

  fields.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    schemaUri: readString(schema, "$schema"),
    title: readString(schema, "title"),
    description: readString(schema, "description"),
    additionalProperties: readBool(schema, "additionalProperties"),
    fields,
  };
};

