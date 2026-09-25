import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const SEO_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-sprint",
    displayName: "Create SEO sprint",
    description: "Open a sprint for one site.",
    parametersSchema: schema(["name", "siteUrl"], { name: text, siteUrl: text }),
  },
  {
    name: "record-rank",
    displayName: "Record keyword rank",
    description: "Store a keyword and its rank on a sprint.",
    parametersSchema: schema(["sprintId", "phrase"], { sprintId: text, phrase: text, rank: { type: "integer" } }),
  },
  {
    name: "record-audit",
    displayName: "Record audit finding",
    description: "Store an audit finding on a sprint.",
    parametersSchema: schema(["sprintId", "finding"], { sprintId: text, finding: text, severity: text }),
  },
  {
    name: "open-task",
    displayName: "Open sprint task",
    description: "Open a Paperclip issue for work a person must do. The issue is tagged with the sprint id.",
    parametersSchema: schema(["sprintId", "title"], { sprintId: text, title: text }),
  },
];
