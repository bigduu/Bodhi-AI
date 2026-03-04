import { describe, expect, it } from "vitest";

import { summarizeJsonSchema } from "../jsonSchema";

describe("summarizeJsonSchema", () => {
  it("summarizes object properties and required fields", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        includeStatic: {
          default: false,
          description: "Include static resources",
          type: "boolean",
        },
        filename: {
          description: "Filename to save to",
          type: "string",
        },
      },
      required: ["includeStatic"],
      type: "object",
    };

    const summary = summarizeJsonSchema(schema);
    expect(summary?.schemaUri).toContain("2020-12");
    expect(summary?.additionalProperties).toBe(false);
    expect(summary?.fields.map((f) => f.name)).toEqual([
      "includeStatic",
      "filename",
    ]);
    expect(summary?.fields[0]).toEqual(
      expect.objectContaining({
        name: "includeStatic",
        type: "boolean",
        required: true,
        defaultValue: false,
      }),
    );
  });

  it("summarizes array item type", () => {
    const schema = {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    };
    const summary = summarizeJsonSchema(schema);
    expect(summary?.fields[0]).toEqual(
      expect.objectContaining({
        name: "paths",
        type: "array<string>",
        required: false,
      }),
    );
  });
});

