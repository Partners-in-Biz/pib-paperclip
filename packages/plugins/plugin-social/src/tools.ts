import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { ALL_PLATFORMS } from "./platforms.js";

const text = { type: "string" } satisfies JsonSchema;
const ids = { type: "array", items: { type: "string" } } satisfies JsonSchema;
const override: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text,
    title: text,
    link: text,
    privacy: text,
    subreddit: text,
    boardId: text,
  },
};
const overrides: JsonSchema = {
  type: "object",
  description: `Per-platform overrides keyed by platform (${ALL_PLATFORMS.join(", ")}).`,
  properties: Object.fromEntries(ALL_PLATFORMS.map((p) => [p, override])),
  additionalProperties: false,
};

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const SOCIAL_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-clients",
    displayName: "List clients",
    description: "Return the clients (CRM companies) this workspace posts for. Use the id as clientRef.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-connected-accounts",
    displayName: "List connected accounts",
    description: "List social accounts with platform, handle, client, status (connected, expiring, needs_reconnect, disabled) and token expiry. Filter by clientRef or platform.",
    parametersSchema: schema([], { clientRef: text, platform: text }),
  },
  {
    name: "connect-account",
    displayName: "Connect social account",
    description: "Accounts are connected by a person on the Social page. Returns the steps to tell them.",
    parametersSchema: schema(["platform"], { platform: text }),
  },
  {
    name: "refresh-account",
    displayName: "Refresh account token",
    description: "Refresh an account's access token now (platforms with refresh tokens or long-lived tokens).",
    parametersSchema: schema(["accountId"], { accountId: text }),
  },
  {
    name: "create-post",
    displayName: "Create post",
    description:
      "Draft one post. Pass clientRef (CRM company id), accountIds (destinations), mediaAssetIds (order = carousel order), firstComment and per-platform overrides. Scope is org (default) or personal.",
    parametersSchema: schema(["body"], {
      body: text,
      scope: text,
      clientRef: text,
      accountIds: ids,
      mediaAssetIds: ids,
      firstComment: text,
      overrides,
    }),
  },
  {
    name: "update-post",
    displayName: "Update post",
    description: "Change a draft or in-review post: body, clientRef, mediaAssetIds (replaces the list), firstComment, overrides (replaces them).",
    parametersSchema: schema(["postId"], {
      postId: text,
      body: text,
      clientRef: text,
      mediaAssetIds: ids,
      firstComment: text,
      overrides,
    }),
  },
  {
    name: "get-post",
    displayName: "Get post",
    description: "Return a post with its media, overrides and each destination's status, attempts, link and last error.",
    parametersSchema: schema(["postId"], { postId: text }),
  },
  {
    name: "list-posts",
    displayName: "List posts",
    description: "List posts, newest first. Filter by status or clientRef.",
    parametersSchema: schema([], { status: text, clientRef: text, limit: { type: "integer" } }),
  },
  {
    name: "validate-post",
    displayName: "Validate post",
    description: "Check a post against every destination's platform rules (length, media, subreddit, board). Returns the problems to fix.",
    parametersSchema: schema(["postId"], { postId: text }),
  },
  {
    name: "attach-destination",
    displayName: "Attach destination",
    description: "Add an account as a destination of a post. An org post cannot target a personal account.",
    parametersSchema: schema(["postId", "accountId"], { postId: text, accountId: text }),
  },
  {
    name: "detach-destination",
    displayName: "Detach destination",
    description: "Remove a pending or failed destination from a post.",
    parametersSchema: schema(["postId", "accountId"], { postId: text, accountId: text }),
  },
  {
    name: "request-review",
    displayName: "Request review",
    description: "Move a draft post to review. A person approves it.",
    parametersSchema: schema(["postId"], { postId: text }),
  },
  {
    name: "schedule-post",
    displayName: "Schedule post",
    description: "Schedule an approved post at an ISO time. Fails if a destination would certainly fail (validate-post).",
    parametersSchema: schema(["postId", "scheduledAt"], { postId: text, scheduledAt: text }),
  },
  {
    name: "bulk-schedule",
    displayName: "Bulk schedule posts",
    description: "Schedule several approved posts at the same time.",
    parametersSchema: schema(["postIds", "scheduledAt"], { postIds: ids, scheduledAt: text }),
  },
  {
    name: "retry-post",
    displayName: "Retry post",
    description: "Retry the failed destinations of a failed or partially published post. Published destinations are never published again.",
    parametersSchema: schema(["postId"], { postId: text }),
  },
  {
    name: "create-template",
    displayName: "Create post template",
    description: "Save reusable post copy.",
    parametersSchema: schema(["name", "body"], { name: text, body: text, platform: text }),
  },
  {
    name: "list-templates",
    displayName: "List post templates",
    description: "Return the saved post templates.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-media-assets",
    displayName: "List media assets",
    description: "Return media assets (id, url, kind, size, alt text, client). Use ids as mediaAssetIds.",
    parametersSchema: schema([], { clientRef: text }),
  },
  {
    name: "create-media-asset",
    displayName: "Create media asset",
    description: "Register an image or video that is already hosted on a public https URL (prefer import-media-from-url so platforms can fetch it from R2).",
    parametersSchema: schema(["url"], { url: text, name: text, kind: text, altText: text, clientRef: text }),
  },
  {
    name: "import-media-from-url",
    displayName: "Import media from URL",
    description: "Download a public https image (JPEG, PNG, GIF, WebP) or video (MP4, MOV) up to 512 MB and store it on the R2 media domain. Returns the asset id.",
    parametersSchema: schema(["url"], { url: text, name: text, altText: text, clientRef: text }),
  },
  {
    name: "create-rss-feed",
    displayName: "Create RSS feed",
    description: "Track an RSS or Atom feed. New items become draft posts (with the given destination accounts) for review.",
    parametersSchema: schema(["url"], { url: text, accountIds: ids, accountId: text, clientRef: text }),
  },
  {
    name: "list-rss-feeds",
    displayName: "List RSS feeds",
    description: "Return tracked RSS feeds with their last check and error.",
    parametersSchema: schema([], {}),
  },
  {
    name: "pause-rss-feed",
    displayName: "Pause RSS feed",
    description: "Stop polling an RSS feed.",
    parametersSchema: schema(["feedId"], { feedId: text }),
  },
  {
    name: "resume-rss-feed",
    displayName: "Resume RSS feed",
    description: "Resume polling an RSS feed.",
    parametersSchema: schema(["feedId"], { feedId: text }),
  },
  {
    name: "record-inbox-item",
    displayName: "Record inbox item",
    description: "Record a mention, comment or message by hand.",
    parametersSchema: schema(["kind", "body"], { kind: text, body: text, accountId: text, author: text }),
  },
  {
    name: "list-inbox",
    displayName: "List social inbox",
    description: "Return comments and mentions, newest first. Filter by status (new, read, replied).",
    parametersSchema: schema([], { status: text, limit: { type: "integer" } }),
  },
  {
    name: "mark-inbox-read",
    displayName: "Mark inbox item read",
    description: "Mark an inbox item as read.",
    parametersSchema: schema(["itemId"], { itemId: text }),
  },
  {
    name: "reply-inbox",
    displayName: "Reply to inbox item",
    description:
      "Reply to a comment or mention through the platform. Unless agent replies are enabled in settings, the reply is saved as a suggestion that a person sends. Platforms without a reply API get a draft post.",
    parametersSchema: schema(["itemId", "body"], { itemId: text, body: text }),
  },
  {
    name: "record-post-metrics",
    displayName: "Record post metrics",
    description: "Record engagement for a post by hand (non-negative integers).",
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
    description: "Latest engagement per destination for one post, or totals for the workspace, from snapshots at 1h, 24h, 7d and 30d.",
    parametersSchema: schema([], { postId: text }),
  },
  {
    name: "account-analytics",
    displayName: "Account analytics",
    description: "Engagement totals per account (latest snapshot per destination).",
    parametersSchema: schema([], {}),
  },
];
