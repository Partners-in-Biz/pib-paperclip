import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const SOCIAL_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-account",
    displayName: "Create social account",
    description: "Record an org or personal social account. Pass a secret ref, never the token itself.",
    parametersSchema: schema(["platform", "displayName", "scope"], {
      platform: text,
      displayName: text,
      scope: text,
      secretRef: text,
    }),
  },
  {
    name: "create-post",
    displayName: "Create post",
    description: "Draft one post. Scope is org or personal.",
    parametersSchema: schema(["body"], { body: text, scope: text }),
  },
  {
    name: "attach-destination",
    displayName: "Attach destination",
    description: "Target an account from a post. An org post cannot target a personal account.",
    parametersSchema: schema(["postId", "accountId"], { postId: text, accountId: text }),
  },
  {
    name: "request-review",
    displayName: "Request review",
    description: "Move a draft post to review.",
    parametersSchema: schema(["postId"], { postId: text }),
  },
  {
      name: "schedule-post",
      displayName: "Schedule post",
      description: "Schedule an approved post. Do not include tokens.",
      parametersSchema: schema(["postId", "scheduledAt"], { postId: text, scheduledAt: text }),
    },
    {
      name: "create-template",
      displayName: "Create post template",
      description: "Save reusable post copy. Use it to draft consistent posts.",
      parametersSchema: schema(["name", "body"], {
        name: text,
        body: text,
        platform: text,
      }),
    },
    {
      name: "list-templates",
      displayName: "List post templates",
      description: "Return the saved post templates for this workspace.",
      parametersSchema: schema([], {}),
    },
    {
    name: "record-post-metrics",
    displayName: "Record post metrics",
    description: "Record engagement metrics for a published post. All counts are non-negative integers.",
    parametersSchema: schema(["postId"], {
      postId: text,
      views: { type: "integer" },
      likes: { type: "integer" },
      comments: { type: "integer" },
      shares: { type: "integer" },
    }),
  },
  {
    name: "post-analytics",
    displayName: "Post analytics",
    description: "Return aggregated engagement metrics for a post or for the whole workspace.",
    parametersSchema: schema([], {
      postId: text,
    }),
  },
  {
    name: "create-media-asset",
    displayName: "Create media asset",
    description: "Add an image or video asset to the media vault for reuse in posts.",
    parametersSchema: schema(["name", "url"], {
      name: text,
      url: text,
      kind: text,
    }),
  },
  {
    name: "list-media-assets",
    displayName: "List media assets",
    description: "Return the media assets in the vault for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "create-rss-feed",
    displayName: "Create RSS feed",
    description: "Track an RSS feed to repurpose its items as posts.",
    parametersSchema: schema(["url"], {
      url: text,
      accountId: text,
    }),
  },
  {
    name: "list-rss-feeds",
    displayName: "List RSS feeds",
    description: "Return the tracked RSS feeds for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "pause-rss-feed",
    displayName: "Pause RSS feed",
    description: "Stop tracking an RSS feed.",
    parametersSchema: schema(["feedId"], {
      feedId: text,
    }),
  },
  {
    name: "resume-rss-feed",
    displayName: "Resume RSS feed",
    description: "Re-enable a paused RSS feed.",
    parametersSchema: schema(["feedId"], {
      feedId: text,
    }),
  },
  {
    name: "record-inbox-item",
    displayName: "Record inbox item",
    description: "Record a mention, comment, or message for the social inbox.",
    parametersSchema: schema(["kind", "body"], {
      kind: text,
      body: text,
      accountId: text,
      author: text,
    }),
  },
  {
    name: "list-inbox",
    displayName: "List social inbox",
    description: "Return the mentions, comments, and messages for this workspace, newest first.",
    parametersSchema: schema([], {
      limit: { type: "integer" },
    }),
  },
  {
    name: "mark-inbox-read",
    displayName: "Mark inbox item read",
    description: "Mark a social inbox item as read.",
    parametersSchema: schema(["itemId"], {
      itemId: text,
    }),
  },
  {
    name: "bulk-schedule",
    displayName: "Bulk schedule posts",
    description: "Schedule several approved posts at once. Pass postIds and a scheduledAt time.",
    parametersSchema: schema(["postIds", "scheduledAt"], {
      postIds: { type: "array", items: { type: "string" } },
      scheduledAt: text,
    }),
  },
  {
    name: "reply-inbox",
    displayName: "Reply to inbox item",
    description: "Mark an inbox item as replied and create a draft post with the reply body.",
    parametersSchema: schema(["itemId", "body"], {
      itemId: text,
      body: text,
    }),
  },
];
