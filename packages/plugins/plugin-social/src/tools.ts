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

/**
 * Scope params: own work (no client) or one CRM client. Pass either
 * `client: "company:<id>"` / `"contact:<id>"`, or `clientKind` + `clientRef`.
 */
const scope: Record<string, JsonSchema> = {
  client: {
    type: "string",
    description: 'The client this is for: "company:<id>" or "contact:<id>" (the `client` value from list-clients). Omit for PiB\'s own work.',
  },
  clientKind: { type: "string", enum: ["company", "contact"], description: "Kind of clientRef. Default company." },
  clientRef: { type: "string", description: "CRM company or contact id from list-clients. Omit for PiB's own work." },
};

const OWN = " Omit the client for PiB's own work; pass client (or clientKind + clientRef) for a client. Never mix clients.";

/** Growth Lab tag on a post. */
const experimentTag: Record<string, JsonSchema> = {
  experimentId: { type: "string", description: "Growth Lab experiment this post tests (from list-experiments or propose-experiment). Empty string clears the tag." },
  arm: { type: "string", enum: ["control", "variant"], description: "Which arm of the experiment the post is: control (what we do now) or variant (the change)." },
};

const arms: JsonSchema = {
  type: "array",
  description: 'Exactly two arms: [{"key":"control","description":"what we do now"},{"key":"variant","description":"the one change"}].',
  items: {
    type: "object",
    required: ["key", "description"],
    additionalProperties: false,
    properties: { key: { type: "string", enum: ["control", "variant"] }, description: text },
  },
};

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const SOCIAL_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-clients",
    displayName: "List clients",
    description:
      "Return the clients this workspace posts for: CRM companies, then CRM contacts (sole traders). Each has kind, id and client (\"company:<id>\" / \"contact:<id>\"). Pass client, or clientKind + clientRef, to the other tools. PiB's own work needs no client.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-connected-accounts",
    displayName: "List connected accounts",
    description: `List the social accounts of one scope with platform, handle, status (connected, expiring, needs_reconnect, disabled) and token expiry. Filter by platform.${OWN}`,
    parametersSchema: schema([], { ...scope, platform: text }),
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
      `Draft one post with accountIds (destinations), mediaAssetIds (order = carousel order), firstComment and per-platform overrides. Accounts and media must belong to the same client as the post (or all be own work).${OWN} The separate scope field is org (default) or personal. Tag a Growth Lab experiment arm with experimentId + arm (same client).`,
    parametersSchema: schema(["body"], {
      body: text,
      scope: text,
      ...scope,
      accountIds: ids,
      mediaAssetIds: ids,
      firstComment: text,
      overrides,
      ...experimentTag,
    }),
  },
  {
    name: "update-post",
    displayName: "Update post",
    description:
      "Change a draft or in-review post: body, mediaAssetIds (replaces the list), accountIds (adds destinations), firstComment, overrides (replaces them). Leave the client out to keep the post's client. Moving a post to another client (client: \"own\" for own work) only works once it has no accounts or media of the old one. experimentId + arm tag (or with experimentId \"\" clear) the Growth Lab experiment arm.",
    parametersSchema: schema(["postId"], {
      postId: text,
      body: text,
      ...scope,
      accountIds: ids,
      mediaAssetIds: ids,
      firstComment: text,
      overrides,
      ...experimentTag,
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
    description: `List the posts of one scope, newest first. Filter by status.${OWN}`,
    parametersSchema: schema([], { status: text, ...scope, limit: { type: "integer" } }),
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
    description: "Add an account as a destination of a post. The account must belong to the post's client (or both be own work). An org post cannot target a personal account.",
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
    description: `Return the media assets of one scope (id, url, kind, size, alt text). Use ids as mediaAssetIds on posts of the same scope.${OWN}`,
    parametersSchema: schema([], { ...scope }),
  },
  {
    name: "create-media-asset",
    displayName: "Create media asset",
    description: `Register an image or video that is already hosted on a public https URL (prefer import-media-from-url so platforms can fetch it from R2).${OWN}`,
    parametersSchema: schema(["url"], { url: text, name: text, kind: text, altText: text, ...scope }),
  },
  {
    name: "import-media-from-url",
    displayName: "Import media from URL",
    description: `Download a public https image (JPEG, PNG, GIF, WebP) or video (MP4, MOV) up to 512 MB and store it on the R2 media domain. Returns the asset id.${OWN}`,
    parametersSchema: schema(["url"], { url: text, name: text, altText: text, ...scope }),
  },
  {
    name: "create-rss-feed",
    displayName: "Create RSS feed",
    description: `Track an RSS or Atom feed. New items become draft posts (with the given destination accounts, all of the feed's scope) for review.${OWN}`,
    parametersSchema: schema(["url"], { url: text, accountIds: ids, accountId: text, ...scope }),
  },
  {
    name: "list-rss-feeds",
    displayName: "List RSS feeds",
    description: `Return the tracked RSS feeds of one scope with their last check and error.${OWN}`,
    parametersSchema: schema([], { ...scope }),
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
    description: `Record a mention, comment or message by hand. With accountId it belongs to that account's scope.${OWN}`,
    parametersSchema: schema(["kind", "body"], { kind: text, body: text, accountId: text, author: text, ...scope }),
  },
  {
    name: "list-inbox",
    displayName: "List social inbox",
    description: `Return the comments and mentions of one scope, newest first. Filter by status (new, read, replied). With a Jev key, items carry triage (needsReply, intent, sentiment, escalate); never reply to escalated items.${OWN}`,
    parametersSchema: schema([], { status: text, limit: { type: "integer" }, ...scope }),
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
    description: `Latest engagement per destination for one post, or totals for one scope, from snapshots at 1h, 24h, 7d and 30d.${OWN}`,
    parametersSchema: schema([], { postId: text, ...scope }),
  },
  {
    name: "performance-review",
    displayName: "Performance review",
    description:
      `Growth Lab review of one scope: top and bottom 5 posts by 7-day engagement lift (vs the account's trailing 30-day median) with their features, median lift per feature value, running and proposed experiments, pending playbook changes, and hypothesis types ranked by UCB (untried first). periodDays 7-90 (default 28).${OWN}`,
    parametersSchema: schema([], { ...scope, periodDays: { type: "integer" } }),
  },
  {
    name: "get-playbook",
    displayName: "Get playbook",
    description: `The scope's playbook (markdown rules to follow when planning posts), its version, recent versions and pending changes. Created on first use.${OWN}`,
    parametersSchema: schema([], { ...scope }),
  },
  {
    name: "propose-playbook-change",
    displayName: "Propose playbook change",
    description:
      `Propose one playbook edit with a reason: op add (section rules, avoid, open, constraints or goal; text = the rule), remove (text = the exact line) or replace (playbook = the whole new markdown). A person keeps or discards it unless autopilot is full.${OWN}`,
    parametersSchema: schema(["reason"], {
      ...scope,
      op: { type: "string", enum: ["add", "remove", "replace"] },
      section: { type: "string", enum: ["rules", "avoid", "open", "constraints", "goal"] },
      text,
      playbook: text,
      reason: text,
    }),
  },
  {
    name: "decide-playbook-change",
    displayName: "Decide playbook change",
    description: "Keep (new playbook version) or discard a pending playbook change. Agents may only decide when the program's autopilot is full; otherwise a person decides on the Growth tab.",
    parametersSchema: schema(["changeId", "decision"], { changeId: text, decision: { type: "string", enum: ["keep", "discard"] }, note: text }),
  },
  {
    name: "list-experiments",
    displayName: "List experiments",
    description: `Growth Lab experiments of one scope with arms, tagged/published/scored post counts per arm, verdicts and the scoreboard. Filter by status (proposed, running, measured, rejected, abandoned; comma-separated).${OWN}`,
    parametersSchema: schema([], { ...scope, status: text }),
  },
  {
    name: "propose-experiment",
    displayName: "Propose experiment",
    description:
      `Propose one experiment that changes one variable: hypothesis, hypothesisType (feature:value, e.g. hook:question; pick from performance-review's ranked types), variable, arms control/variant with descriptions, minPerArm (default 3). At most 3 running and 3 proposed per scope. Safe autopilot: a person approves it from the weekly approval issue; full: it starts at once. Then tag posts with experimentId + arm.${OWN}`,
    parametersSchema: schema(["hypothesis", "hypothesisType", "variable", "arms"], {
      ...scope,
      hypothesis: text,
      hypothesisType: text,
      variable: text,
      arms,
      minPerArm: { type: "integer" },
      windowDays: { type: "integer" },
    }),
  },
  {
    name: "approve-experiment",
    displayName: "Approve experiment",
    description: "Start a proposed experiment. Only on full autopilot may an agent approve; otherwise a person approves on the Growth tab.",
    parametersSchema: schema(["experimentId"], { experimentId: text, note: text }),
  },
  {
    name: "reject-experiment",
    displayName: "Reject experiment",
    description: "Reject a proposed experiment with a reason (its post tags are cleared). Only on full autopilot may an agent reject.",
    parametersSchema: schema(["experimentId", "reason"], { experimentId: text, reason: text }),
  },
  {
    name: "propose-feature-question",
    displayName: "Propose feature question",
    description:
      `Feature discovery: add a question Jev answers about every post caption (op add: key, type noul/choice/score, question, options for choice, levels for score, lowest first), or retire one (op retire + key). New questions apply to new posts and backfill the last 90 days; at most 12 active. Propose questions that separate the top posts from the bottom ones in performance-review.${OWN}`,
    parametersSchema: schema([], {
      ...scope,
      op: { type: "string", enum: ["add", "retire"] },
      key: text,
      type: { type: "string", enum: ["noul", "choice", "score"] },
      question: text,
      options: ids,
      levels: ids,
    }),
  },
  {
    name: "account-analytics",
    displayName: "Account analytics",
    description: `Engagement totals per account of one scope (latest snapshot per destination).${OWN}`,
    parametersSchema: schema([], { ...scope }),
  },
];
