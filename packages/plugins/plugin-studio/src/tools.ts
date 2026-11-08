import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { LINK_TARGETS } from "./assets.js";
import { MAX_BRIEF_ASSETS, MAX_BRIEF_PROMPTS } from "./canvas-brief.js";
import { MAX_TEXT } from "./canvas-rules.js";
import { MAX_BATCH } from "./generation.js";
import { PHOTO_PRESETS } from "./presets.js";
import { MAX_START_ASSETS } from "./video-edit/actions.js";
import { MAX_OPS, OP_NAMES } from "./video-edit/ops.js";
import { SIZES } from "./video-edit/timeline.js";

const text = (description: string): JsonSchema => ({ type: "string", description });
const CLIENT = text('"company:<id>" or "contact:<id>". Omit it to use the client of the issue\'s project, or own work if it has none.');
const ISSUE = text("The issue this is for. Defaults to the issue of your current run.");

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", additionalProperties: false, required, properties };
}

const GENERATE_FIELDS = {
  model: text("Provider model path, e.g. higgsfield-ai/soul/v2/standard"),
  prompt: text("What to make. With a preset, this is only an optional extra note (up to 400 characters) added to the style's own prompt."),
  preset: { type: "string", enum: PHOTO_PRESETS.map((preset) => preset.id), description: "Optional Photo Studio style. It builds the prompt and sets the default model and ratio (1:1)." } as JsonSchema,
  params: { type: "object", description: 'The model\'s own fields, flat, e.g. {"aspect_ratio":"9:16"}' } as JsonSchema,
  batchSize: { type: "integer", minimum: 1, maximum: MAX_BATCH, description: `How many to make (1 to ${MAX_BATCH}). Each is charged separately.` } as JsonSchema,
  referenceAssetIds: {
    type: "array",
    items: { type: "string" },
    maxItems: 10,
    description: "Optional Studio library image asset ids to use as reference images, from the same client as the generation. Studio passes them to the model; only some models take them, and how many.",
  } as JsonSchema,
  client: CLIENT,
  issueId: ISSUE,
};


const EDIT_ID = text("The video edit, from video-edit-create or video-edit-list");
const RENDER_ID = text("The render, from video-edit-render");

/** The video edit tools (PAR-8276 A8b). Granted to no agent yet: an agent needs an explicit grant, and render time is the company's machine. */
const VIDEO_EDIT_TOOLS: PluginToolDeclaration[] = [
  {
    name: "video-edit-create",
    displayName: "Create a video edit",
    description:
      "Start a video edit (a timeline of clips, text, captions and sound). Give assetIds (Studio library videos, pictures or sound, same client, up to " + MAX_START_ASSETS + ") to lay them end to end, or give a doc, or neither for an empty timeline. Free: nothing renders until video-edit-render. Returns the edit with its revision.",
    parametersSchema: schema(["title"], {
      title: text("Name of the edit, up to 200 characters"),
      assetIds: { type: "array", items: { type: "string" }, maxItems: MAX_START_ASSETS, description: "Library assets to start from, in order. Not with doc." } as JsonSchema,
      doc: { type: "object", description: "A whole timeline document. Not with assetIds." } as JsonSchema,
      project: { type: "object", description: `Optional project settings for assetIds: {"size": ${Object.keys(SIZES).join(" | ")}, "fps": number}` } as JsonSchema,
      projectId: text("Optional project. Defaults to the project of the issue."),
      client: CLIENT,
      issueId: ISSUE,
    }),
  },
  {
    name: "video-edit-get",
    displayName: "Open a video edit",
    description: "A video edit with its timeline document, duration and current revision. Read-only.",
    parametersSchema: schema(["editId"], { editId: EDIT_ID }),
  },
  {
    name: "video-edit-list",
    displayName: "List video edits",
    description: "Video edits for a client (or own work), newest first. Read-only.",
    parametersSchema: schema([], {
      client: CLIENT,
      projectId: text("Only this project's edits"),
      limit: { type: "integer", minimum: 1, maximum: 200, description: "At most this many (default 50)" } as JsonSchema,
    }),
  },
  {
    name: "video-edit-apply-ops",
    displayName: "Change a video edit",
    description:
      "Apply a list of edit operations to a video edit at the revision you read. All or nothing: if one op is refused, none apply and the message names it. Refused if someone saved since baseRevision: reload with video-edit-get. Each op is an object with op set to one of " + OP_NAMES.join(", ") + " plus that op's fields (e.g. {op:'trim',clipId,in,out}, {op:'split',clipId,at}). Free.",
    parametersSchema: schema(["editId", "baseRevision", "ops"], {
      editId: EDIT_ID,
      baseRevision: { type: "integer", minimum: 1, description: "The revision your changes start from" } as JsonSchema,
      ops: {
        type: "array",
        minItems: 1,
        maxItems: MAX_OPS,
        items: { type: "object", required: ["op"], properties: { op: { type: "string", enum: [...OP_NAMES] } } },
        description: "Operations, applied in order",
      } as JsonSchema,
    }),
  },
  {
    name: "video-edit-render",
    displayName: "Render a video edit",
    description:
      "Queue a render of the edit as saved now. It takes the company's render machine (one at a time, a few waiting at most) and, when done, saves an mp4 as a Studio asset. Returns a render id: don't poll in a loop; check video-edit-render-status later. Pass baseRevision to render only if nobody saved since.",
    parametersSchema: schema(["editId"], { editId: EDIT_ID, baseRevision: { type: "integer", minimum: 1, description: "Render only if the edit is still at this revision" } as JsonSchema }),
  },
  {
    name: "video-edit-render-status",
    displayName: "Video render status",
    description: "Where a render is: queued, running, succeeded, failed or cancelled, with the result asset id once it has succeeded. Read-only.",
    parametersSchema: schema(["renderId"], { renderId: RENDER_ID }),
  },
  {
    name: "video-edit-cancel-render",
    displayName: "Cancel a video render",
    description: "Drop a queued render, or stop a running one.",
    parametersSchema: schema(["renderId"], { renderId: RENDER_ID }),
  },
];

export const STUDIO_TOOLS: PluginToolDeclaration[] = [
  {
    name: "studio-review-asset",
    displayName: "Approve or reject a Studio asset",
    description:
      "Approve or reject an asset. Approving sends it to Social's media library for the asset's client (or own work), where list-media-assets shows it for a post. Approving twice does nothing the second time. An approved asset can't be rejected.",
    parametersSchema: schema(["assetId", "decision"], {
      assetId: text("The Studio asset"),
      decision: { type: "string", enum: ["approved", "rejected"], description: "approved sends it to Social; rejected keeps it out" },
    }),
  },
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
    parametersSchema: schema([], GENERATE_FIELDS),
  },
  {
    name: "studio-generate",
    displayName: "Generate images or video",
    description: "Queue an image or video. Credits are reserved against the monthly cap, and it's refused if they don't fit. The result is saved as a Studio asset linked to the issue, and a comment on the issue reports it and wakes you. Don't poll or sit waiting. Before ending your run, set an issue monitor as a fallback (kind external_service, about 15 minutes), as for any wait on a machine: an in-progress issue with nothing watching it gets sent for repair. Check the cost with studio-estimate first, because it counts against the company's monthly cap.",
    parametersSchema: schema([], { ...GENERATE_FIELDS, name: text("File name for the result (default: the start of the prompt)") }),
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
  {
    name: "studio-brand-kit",
    displayName: "Read a client's brand kit",
    description:
      "The client's brand kit from the CRM: voice, audience, tone, banned words, colours and fonts, plus promptText, the exact text to add to a studio-generate prompt. Free. Nothing is added for you: put promptText in your prompt yourself, and say so on the issue.",
    parametersSchema: schema([], { client: CLIENT, issueId: ISSUE }),
  },
  {
    name: "canvas-write-text",
    displayName: "Write the words on a Studio canvas Text card",
    description:
      "Deliver words you were asked to write for a Text card on a Studio canvas. They land on the card for a person to check; nothing is published. Use the canvasId and cardId from the task. Plain words only. For a card feeding several pages, put a line holding only --- between each page's words.",
    parametersSchema: schema(["canvasId", "cardId", "text"], {
      canvasId: text("The canvas, from the task"),
      cardId: text("The Text card, from the task"),
      text: text(`The words, up to ${MAX_TEXT} characters`),
    }),
  },
  {
    name: "canvas-create-from-brief",
    displayName: "Create a Studio canvas from a brief",
    description:
      "Lay out a new Studio canvas board: each prompt becomes a prompt card wired to an image or video card, and library assets become source cards feeding them. Free: it never generates or spends credits. A person opens the board in Studio and presses Generate.",
    parametersSchema: schema(["title", "prompts"], {
      title: text("Board title, up to 120 characters"),
      prompts: {
        type: "array",
        minItems: 1,
        maxItems: MAX_BRIEF_PROMPTS,
        description: "One card pair per prompt",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: text("What to make"),
            kind: { type: "string", enum: ["image", "video"], description: "Default image" },
            label: text("Short card name"),
            model: text("Optional provider model path, e.g. higgsfield-ai/soul/v2/standard"),
            ratio: text('Optional aspect ratio, e.g. "9:16"'),
          },
        },
      } as JsonSchema,
      assetIds: { type: "array", items: { type: "string" }, maxItems: MAX_BRIEF_ASSETS, description: "Optional Studio library asset ids (same client) to use as references" } as JsonSchema,
      projectId: text("Optional project. Defaults to the project of the issue."),
      client: CLIENT,
      issueId: ISSUE,
    }),
  },
  ...VIDEO_EDIT_TOOLS,
];
