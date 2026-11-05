import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { LINK_TARGETS } from "./assets.js";
import { MAX_BATCH } from "./generation.js";

const text = (description: string): JsonSchema => ({ type: "string", description });
const CLIENT = text('"company:<id>" or "contact:<id>". Omit it to use the client of the issue\'s project, or own work if it has none.');
const ISSUE = text("The issue this is for. Defaults to the issue of your current run.");

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", additionalProperties: false, required, properties };
}

const GENERATE_FIELDS = {
  model: text("Provider model path, e.g. higgsfield-ai/soul/v2/standard"),
  prompt: text("What to make"),
  params: { type: "object", description: 'The model\'s own fields, flat, e.g. {"aspect_ratio":"9:16"}' } as JsonSchema,
  batchSize: { type: "integer", minimum: 1, maximum: MAX_BATCH, description: `How many to make (1 to ${MAX_BATCH}). Each is charged separately.` } as JsonSchema,
  client: CLIENT,
  issueId: ISSUE,
};

export const STUDIO_TOOLS: PluginToolDeclaration[] = [
  {
    name: "studio-usage",
    displayName: "Studio usage",
    description: "This month's credits used, the monthly cap that applies, and what's left. Read-only: only a company owner can change a cap, on the Studio page.",
    parametersSchema: schema([], { client: CLIENT }),
  },
  {
    name: "studio-estimate",
    displayName: "Estimate a generation",
    description: "Price an image or video before making it. Free. Also shows what's left under the monthly cap.",
    parametersSchema: schema(["model", "prompt"], GENERATE_FIELDS),
  },
  {
    name: "studio-generate",
    displayName: "Generate images or video",
    description: "Queue an image or video. Credits are reserved against the monthly cap, and it's refused if they don't fit. The result is saved as a Studio asset linked to the issue, and a comment on the issue reports it and wakes you. Don't poll or sit waiting. Before ending your run, set an issue monitor as a fallback (kind external_service, about 15 minutes), as for any wait on a machine: an in-progress issue with nothing watching it gets sent for repair. Check the cost with studio-estimate first, because it counts against the company's monthly cap.",
    parametersSchema: schema(["model", "prompt"], { ...GENERATE_FIELDS, name: text("File name for the result (default: the start of the prompt)") }),
  },
  {
    name: "studio-generation-status",
    displayName: "Generation status",
    description: "Where a generation or batch is: queued, submitted, storing, succeeded or failed, with its cost and asset id.",
    parametersSchema: schema([], { generationId: text("From studio-generate"), groupId: text("From studio-generate, for a whole batch") }),
  },
  {
    name: "studio-list-assets",
    displayName: "List Studio assets",
    description: "Assets for the issue's client, or own work when there's none. Filter by project, kind, or what they're linked to.",
    parametersSchema: schema([], {
      client: CLIENT,
      projectId: text("Only this project's assets"),
      kind: { type: "string", enum: ["image", "video"], description: "Only images or only videos" },
      targetType: { type: "string", enum: [...LINK_TARGETS], description: "With targetId: only assets linked to this" },
      targetId: text("With targetType: only assets linked to this"),
      limit: { type: "integer", description: "At most this many (default 50, up to 200)" },
    }),
  },
  {
    name: "studio-get-asset",
    displayName: "Open a Studio asset",
    description: "An asset's details and a local file path you can read. Not a link: use this path, and don't share it outward. Files are removed after a day; ask again if one is gone.",
    parametersSchema: schema(["assetId"], { assetId: text("Asset id") }),
  },
  {
    name: "studio-import-from-attachment",
    displayName: "Save an attachment to Studio",
    description: "Save a file you made as a Studio asset: attach it to the issue, then pass its attachment id. Images (JPEG, PNG, GIF, WebP) and videos (MP4, MOV). Importing the same attachment again returns the same asset.",
    parametersSchema: schema(["attachmentId"], {
      issueId: ISSUE,
      attachmentId: text("The attachment's id on that issue"),
      name: text("File name (default: the attachment's)"),
      altText: text("What it shows, for screen readers"),
      client: CLIENT,
    }),
  },
  {
    name: "studio-link-asset",
    displayName: "Link a Studio asset",
    description: "Record where an asset is used: an issue, goal, project, campaign, social post, ad, SEO page, video or book.",
    parametersSchema: schema(["assetId", "targetType", "targetId"], {
      assetId: text("Asset id"),
      targetType: { type: "string", enum: [...LINK_TARGETS], description: "What it's linked to" },
      targetId: text("That thing's id"),
    }),
  },
];
