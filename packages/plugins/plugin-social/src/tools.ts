import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { ALL_PLATFORMS, OVERRIDE_FIELDS, POST_STATUSES } from "./platforms.js";

/** Every param has a short, exact description, and an enum where the values are fixed. */
const text = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });
const ids = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const choice = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });

const POST_ID = text("Post id (from create-post, list-posts or the issue)");
const ACCOUNT_ID = text("Account id (from list-connected-accounts)");
const FEED_ID = text("Feed id (from list-rss-feeds)");
const ITEM_ID = text("Inbox item id (from list-inbox or the reply issue)");
const ISO_TIME = "ISO date-time with offset, e.g. 2026-10-05T07:30:00+02:00";

/** Which override fields each platform takes, for the description. */
const FIELDS_BY_PLATFORM = ALL_PLATFORMS.map((p) => `${p}: ${OVERRIDE_FIELDS[p].join("/")}`).join("; ");

/**
 * The per-platform override schema, defined once and shared by create-post
 * and update-post: one entry schema for every platform key (the service
 * refuses unknown platforms and fields a platform does not take).
 */
export const OVERRIDE_ENTRY: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: text("Post text for this platform instead of the main body"),
    title: text("Title (YouTube, TikTok, Pinterest, Reddit, Dribbble)"),
    link: text("https:// link: link card or pin destination"),
    privacy: text("youtube: private|unlisted|public; tiktok: SELF_ONLY|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|PUBLIC_TO_EVERYONE; mastodon: public|unlisted|private"),
    subreddit: text("Reddit subreddit name, e.g. smallbusiness"),
    boardId: text("Pinterest board id"),
  },
};

export const OVERRIDES: JsonSchema = {
  type: "object",
  description: `Per-platform overrides keyed by platform (${ALL_PLATFORMS.join(", ")}). Fields per platform: ${FIELDS_BY_PLATFORM}. Anything not overridden uses the main body.`,
  additionalProperties: OVERRIDE_ENTRY,
};

/**
 * Scope params: own work (no client) or one CRM client. Pass either
 * `client: "company:<id>"` / `"contact:<id>"`, or `clientKind` + `clientRef`.
 */
const scope: Record<string, JsonSchema> = {
  client: text('The client this is for: "company:<id>" or "contact:<id>" (the `client` value from list-clients). Omit for PiB\'s own work.'),
  clientKind: choice(["company", "contact"], "With clientRef: the kind of CRM record (default company). Prefer client."),
  clientRef: text("CRM company or contact id (from list-clients), with clientKind. Prefer client."),
};

const OWN = " Omit the client for PiB's own work; pass client for a client. Never mix clients.";

/** Growth Lab tag on a post. */
const experimentTag: Record<string, JsonSchema> = {
  experimentId: text("Growth Lab experiment this post tests (from list-experiments or propose-experiment). Empty string clears the tag."),
  arm: choice(["control", "variant"], "Which arm of the experiment the post is: control (what we do now) or variant (the change)."),
};

const post: Record<string, JsonSchema> = {
  accountIds: ids("Destination account ids of the post's scope (list-connected-accounts; status connected)"),
  mediaAssetIds: ids("Media asset ids of the post's scope (list-media-assets or import-media-from-url); order = carousel order"),
  firstComment: text("Posted as the first comment (X: a reply to the post) where the platform allows"),
  scheduledAt: text(`Proposed publish time, ${ISO_TIME}. When a person approves the post it is scheduled for this time if it is still ahead.`),
  overrides: OVERRIDES,
};

const arms: JsonSchema = {
  type: "array",
  description: 'Exactly two arms: [{"key":"control","description":"what we do now"},{"key":"variant","description":"the one change"}].',
  items: {
    type: "object",
    required: ["key", "description"],
    additionalProperties: false,
    properties: {
      key: choice(["control", "variant"], "control (what we do now) or variant (the change)"),
      description: text("What posts in this arm do, in one line"),
    },
  },
};

/** Growth Lab experiment statuses (list-experiments filter). */
export const EXPERIMENT_STATUSES = ["proposed", "running", "measured", "rejected", "abandoned"] as const;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const SOCIAL_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-clients",
    displayName: "List clients",
    description:
      "Return the clients this workspace posts for: CRM companies, then CRM contacts (sole traders). Each has kind, id and client (\"company:<id>\" / \"contact:<id>\"). Pass client to the other tools. PiB's own work needs no client.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-connected-accounts",
    displayName: "List connected accounts",
    description: `List the social accounts of one scope with platform, handle, status (connected, expiring, needs_reconnect, disabled) and token expiry.${OWN}`,
    parametersSchema: schema([], { ...scope, platform: choice(ALL_PLATFORMS, "Only accounts on this platform") }),
  },
  {
    name: "connect-account",
    displayName: "Connect social account",
    description:
      "A person connects accounts (signing in is a one-time grant). Returns the deep link and exact steps to put in one partnersinbiz.cockpit:ask-owner request, and the effect to pass on that ask. Pass the issue you are working on: when the account is connected the plugin comments on it, hands it back to you and wakes you, so do not poll.",
    parametersSchema: schema(["platform"], {
      platform: choice(ALL_PLATFORMS, "Platform to connect"),
      issueId: text("The issue you are working on (id or identifier). Default: read from your run."),
      ...scope,
    }),
  },
  {
    name: "refresh-account",
    displayName: "Refresh account token",
    description: "Refresh an account's access token now (platforms with refresh tokens or long-lived tokens).",
    parametersSchema: schema(["accountId"], { accountId: ACCOUNT_ID }),
  },
  {
    name: "create-post",
    displayName: "Create post",
    description:
      `Draft one post with destinations (accountIds), media (mediaAssetIds), a proposed time (scheduledAt), firstComment and per-platform overrides. Accounts and media must belong to the post's client (or all be own work).${OWN} For a "Repurpose for social" issue pass its handoffKey: the draft is linked to that page and stays in its scope. Tag a Growth Lab experiment arm with experimentId + arm (same client). Then validate-post and request-review.`,
    parametersSchema: schema(["body"], {
      body: text("Main post text (used by every platform without a text override)"),
      ...scope,
      handoffKey: text("Repurpose issue's hand-off key (seo:content:<id>): links the draft to that page"),
      visibility: choice(["org", "personal"], "org (default): a company or client page. personal: a person's own profile, only that person's accounts."),
      ...post,
      ...experimentTag,
    }),
  },
  {
    name: "update-post",
    displayName: "Update post",
    description:
      "Change a draft or in-review post: body, mediaAssetIds (replaces the list), accountIds (adds destinations), firstComment, scheduledAt (\"\" clears it), overrides (replaces them). Leave the client out to keep the post's client; moving it to another client (client \"own\" for own work) only works once it has no accounts or media of the old one. experimentId + arm tag the Growth Lab arm (experimentId \"\" clears it).",
    parametersSchema: schema(["postId"], {
      postId: POST_ID,
      body: text("New main post text"),
      ...scope,
      ...post,
      ...experimentTag,
    }),
  },
  {
    name: "get-post",
    displayName: "Get post",
    description: "Return a post with its media, overrides, proposed or scheduled time and each destination's status, attempts, link and last error.",
    parametersSchema: schema(["postId"], { postId: POST_ID }),
  },
  {
    name: "list-posts",
    displayName: "List posts",
    description: `List the posts of one scope, newest first.${OWN}`,
    parametersSchema: schema([], {
      status: choice(POST_STATUSES, "Only posts in this status (approved = approved but not scheduled yet)"),
      ...scope,
      limit: int("Most posts to return, 1–1000 (default 50)"),
    }),
  },
  {
    name: "validate-post",
    displayName: "Validate post",
    description: "Check a post against every destination's platform rules (length, media, subreddit, board, account connected). Returns the problems to fix.",
    parametersSchema: schema(["postId"], { postId: POST_ID }),
  },
  {
    name: "attach-destination",
    displayName: "Attach destination",
    description: "Add an account as a destination of a post. The account must belong to the post's client (or both be own work). An org post cannot target a personal account.",
    parametersSchema: schema(["postId", "accountId"], { postId: POST_ID, accountId: ACCOUNT_ID }),
  },
  {
    name: "detach-destination",
    displayName: "Detach destination",
    description: "Remove a pending or failed destination from a post.",
    parametersSchema: schema(["postId", "accountId"], { postId: POST_ID, accountId: ACCOUNT_ID }),
  },
  {
    name: "request-review",
    displayName: "Request review",
    description:
      "Send a draft for approval. Who approves is the scope's policy (get-approval-policy): by default a person (the Reviewer checks first when the Cockpit has one); for a client it can be the client, on a link (request-client-approval). Approval schedules the post at its proposed time. Editing a post after a sign-off makes that sign-off stale.",
    parametersSchema: schema(["postId"], { postId: POST_ID }),
  },
  {
    name: "get-approval-policy",
    displayName: "Get approval policy",
    description: `Who approves posts in one scope: whether the Reviewer's pass, a team member's approval and/or the client's approval are needed, and how long a client link stays open. Read it before you promise anyone a timeline. Only a person sets it; you cannot.${OWN}`,
    parametersSchema: schema([], { ...scope }),
  },
  {
    name: "get-approval-status",
    displayName: "Get approval status",
    description: "Where one post's approval stands: the policy, each sign-off for the post's CURRENT version (approved, changes, stale or none), what is still missing, and the client's links (status and answer; never the link itself).",
    parametersSchema: schema(["postId"], { postId: POST_ID }),
  },
  {
    name: "request-client-approval",
    displayName: "Request client approval",
    description:
      "Make the client's approval link for a post in review (only when the scope's policy asks for the client). Returns the link, the people at the client with an email, and a ready email text. The link opens a page showing the post exactly as it will appear, with Approve and Request changes. Email it ONLY as a Mailbox draft (partnersinbiz.mailbox:create-draft): never send it yourself. Editing the post afterwards voids the link. The plugin comments on the review issue and wakes you when the client answers.",
    parametersSchema: schema(["postId"], {
      postId: POST_ID,
      recipientEmail: text("The client's email the link is meant for (kept on the record). Default: none."),
      draft: choice(["me", "account-manager"], "Who drafts the Mailbox email. Leave it out: the plugin opens a drafting task for the Account Manager (who holds a mailbox delegation) when the company has one, otherwise you draft it. me: you create the Mailbox draft yourself (only if you hold a delegation). account-manager: always open the task for the Account Manager (or the Operator or owner when none is staffed)."),
    }),
  },
  {
    name: "record-review-verdict",
    displayName: "Record review verdict",
    description:
      "Reviewer only. Record your verdict on a post in review: pass (it is ready for whoever approves) or changes (with notes: one line per problem). A pass is a check, not an approval. The plugin hands the review issue on: after a pass to the person or the Social agent the policy names; after changes back to the Social agent with the post returned to draft. Do not reassign the issue yourself.",
    parametersSchema: schema(["postId", "verdict"], {
      postId: POST_ID,
      verdict: choice(["pass", "changes"], "pass: ready to approve. changes: send it back to draft with your notes."),
      notes: text("changes: what to fix, one line per problem. pass: optional remarks."),
    }),
  },
  {
    name: "review-outcomes",
    displayName: "Review outcomes",
    description: `First-pass rates, change requests and approval streaks per post type (original, repurpose, rss, reply by format) for each stage (Reviewer, team member, client), for one scope. These are inputs for a later autonomy policy: auto-approval is off and you never approve.${OWN}`,
    parametersSchema: schema([], { ...scope, days: int("Days to look back, 7-365 (default 90)") }),
  },
  {
    name: "schedule-post",
    displayName: "Schedule post",
    description: "Schedule an approved post that has no time yet. Fails if a destination would certainly fail (see validate-post).",
    parametersSchema: schema(["postId", "scheduledAt"], { postId: POST_ID, scheduledAt: text(`Publish time, ${ISO_TIME}; now or earlier publishes within 5 minutes`) }),
  },
  {
    name: "bulk-schedule",
    displayName: "Bulk schedule posts",
    description: "Schedule several approved posts at the same time. Returns one result per post.",
    parametersSchema: schema(["postIds", "scheduledAt"], { postIds: ids("Approved post ids"), scheduledAt: text(`Publish time for all of them, ${ISO_TIME}`) }),
  },
  {
    name: "retry-post",
    displayName: "Retry post",
    description: "Retry the failed destinations of a failed or partially published post. Published destinations are never published again.",
    parametersSchema: schema(["postId"], { postId: POST_ID }),
  },
  {
    name: "create-template",
    displayName: "Create post template",
    description: "Save reusable post copy. Templates are shared by every scope: never put a client's name, offer or claims in one.",
    parametersSchema: schema(["name", "body"], {
      name: text("Template name"),
      body: text("The reusable copy"),
      platform: choice(ALL_PLATFORMS, "Platform it is written for (omit for any)"),
    }),
  },
  {
    name: "list-templates",
    displayName: "List post templates",
    description: "Return the saved post templates (shared by every scope).",
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
    parametersSchema: schema(["url"], {
      url: text("Public https URL of the file"),
      name: text("Display name (default: the file name)"),
      kind: choice(["image", "video"], "Media kind (default: from the file type)"),
      altText: text("What the image or video shows, for screen readers"),
      ...scope,
    }),
  },
  {
    name: "import-media-from-url",
    displayName: "Import media from URL",
    description: `Download a public https image (JPEG, PNG, GIF, WebP) or video (MP4, MOV) up to 512 MB and store it on the R2 media domain. Returns the asset id.${OWN}`,
    parametersSchema: schema(["url"], {
      url: text("Public https URL to download"),
      name: text("Display name (default: the file name)"),
      altText: text("What the image or video shows, for screen readers"),
      ...scope,
    }),
  },
  {
    name: "list-issue-attachments",
    displayName: "List issue attachments",
    description: "The files attached to an issue (usually the one you are working on): id, name, size and whether it looks like an importable image or video. No links, no bytes. Use it to find the attachment id for import-media-from-attachment.",
    parametersSchema: schema(["issueId"], { issueId: text("Issue id or identifier") }),
  },
  {
    name: "import-media-from-attachment",
    displayName: "Import media from an issue attachment",
    description: `Turn a file you attached to an issue (a carousel slide, a branded image, a short video you made) into a media asset on R2, so a post can use it. Takes the issue id and attachment id; returns the asset id (never a link to private storage). The type is read from the file's bytes (an attachment stored as application/octet-stream is fine); JPEG, PNG, GIF, WebP, MP4 or MOV up to 64 MB. Width, height and video length are read and shape problems reported (not 9:16, under 1080 px). Importing the same attachment again returns the same asset. To use a file from your workspace, attach it to the issue first.${OWN}`,
    parametersSchema: schema(["issueId", "attachmentId"], {
      issueId: text("The issue the file is attached to"),
      attachmentId: text("Attachment id from list-issue-attachments"),
      name: text("Display name (default: the file name)"),
      altText: text("What the image or video shows, for screen readers"),
      ...scope,
    }),
  },
  {
    name: "create-rss-feed",
    displayName: "Create RSS feed",
    description: `Track an RSS or Atom feed. New items become draft posts (with the given destination accounts, all of the feed's scope) for review.${OWN}`,
    parametersSchema: schema(["url"], {
      url: text("Feed URL (RSS or Atom)"),
      accountIds: ids("Destination account ids for the drafts (organisation accounts of the feed's scope)"),
      accountId: text("One destination account id (older form of accountIds)"),
      ...scope,
    }),
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
    parametersSchema: schema(["feedId"], { feedId: FEED_ID }),
  },
  {
    name: "resume-rss-feed",
    displayName: "Resume RSS feed",
    description: "Resume polling an RSS feed.",
    parametersSchema: schema(["feedId"], { feedId: FEED_ID }),
  },
  {
    name: "record-inbox-item",
    displayName: "Record inbox item",
    description: `Record a mention, comment or message by hand (from a platform the inbox does not poll). With accountId it belongs to that account's scope; it is triaged on the next inbox run.${OWN}`,
    parametersSchema: schema(["kind", "body"], {
      kind: choice(["comment", "mention", "message"], "What it is"),
      body: text("The text, as written"),
      accountId: text("The account it came in on (from list-connected-accounts)"),
      author: text("Who wrote it (name or handle)"),
      ...scope,
    }),
  },
  {
    name: "list-inbox",
    displayName: "List social inbox",
    description: `Return the comments and mentions of one scope, newest first. Every triaged item carries triage (needsReply, intent, sentiment, escalate, source jev or rules); never reply to escalated items.${OWN}`,
    parametersSchema: schema([], {
      status: choice(["new", "read", "replied"], "Only items in this status"),
      limit: int("Most items to return, 1–500 (default 50)"),
      ...scope,
    }),
  },
  {
    name: "mark-inbox-read",
    displayName: "Mark inbox item read",
    description: "Mark an inbox item as read (handled, or nothing to answer).",
    parametersSchema: schema(["itemId"], { itemId: ITEM_ID }),
  },
  {
    name: "reply-inbox",
    displayName: "Reply to inbox item",
    description:
      "Reply to a comment or mention through the platform. Unless agent replies are enabled in settings, the reply is saved as a suggestion that a person sends. Platforms without a reply API get a draft post.",
    parametersSchema: schema(["itemId", "body"], { itemId: ITEM_ID, body: text("The reply text") }),
  },
  {
    name: "record-post-metrics",
    displayName: "Record post metrics",
    description: "Record engagement you saw on the platform for a post the metrics job cannot read. Only numbers you observed; never estimates.",
    parametersSchema: schema(["postId"], {
      postId: POST_ID,
      views: int("Views or impressions seen (whole number ≥ 0)"),
      likes: int("Likes or reactions seen (whole number ≥ 0)"),
      comments: int("Comments seen (whole number ≥ 0)"),
      shares: int("Shares, reposts or saves seen (whole number ≥ 0)"),
    }),
  },
  {
    name: "post-analytics",
    displayName: "Post analytics",
    description: `Latest engagement per destination for one post, or totals for one scope, from snapshots at 1h, 24h, 7d and 30d.${OWN}`,
    parametersSchema: schema([], { postId: text("One post's numbers (omit for the scope's totals)"), ...scope }),
  },
  {
    name: "performance-review",
    displayName: "Performance review",
    description:
      `Growth Lab review of one scope: top and bottom 5 posts by 7-day engagement lift (vs the account's trailing 30-day median) with their features, median lift per feature value, running and proposed experiments, pending playbook changes, and hypothesis types ranked by UCB (untried first).${OWN}`,
    parametersSchema: schema([], { ...scope, periodDays: int("Days to review, 7–90 (default 28)") }),
  },
  {
    name: "get-playbook",
    displayName: "Get playbook",
    description: `The scope's playbook (markdown rules to follow when planning posts: rules, what to avoid, constraints such as brand voice and the booking link), its version, recent versions and pending changes. Created on first use.${OWN}`,
    parametersSchema: schema([], { ...scope }),
  },
  {
    name: "propose-playbook-change",
    displayName: "Propose playbook change",
    description:
      `Propose one playbook edit with a reason: op add (a line in a section), remove (the exact line) or replace (the whole markdown). A person keeps or discards it unless autopilot is full.${OWN}`,
    parametersSchema: schema(["reason"], {
      ...scope,
      op: choice(["add", "remove", "replace"], "add (default) a line, remove an exact line, or replace the whole playbook"),
      section: choice(["rules", "avoid", "open", "constraints", "goal"], "For add: rules we follow, things to avoid, open questions, constraints (brand voice, links, banned words) or the goal"),
      text: text("add: the rule, one line; remove: the exact line from get-playbook"),
      playbook: text("replace: the whole new playbook markdown"),
      reason: text("Why, with the evidence (post ids, measured lift)"),
    }),
  },
  {
    name: "decide-playbook-change",
    displayName: "Decide playbook change",
    description: "Keep (new playbook version) or discard a pending playbook change. Agents may only decide when the program's autopilot is full; otherwise a person decides on the Growth tab.",
    parametersSchema: schema(["changeId", "decision"], {
      changeId: text("Pending change id (from get-playbook)"),
      decision: choice(["keep", "discard"], "keep writes a new playbook version; discard drops the change"),
      note: text("Why (shown with the decision)"),
    }),
  },
  {
    name: "list-experiments",
    displayName: "List experiments",
    description: `Growth Lab experiments of one scope with arms, tagged/published/scored post counts per arm, verdicts and the scoreboard.${OWN}`,
    parametersSchema: schema([], {
      ...scope,
      status: { type: "array", items: { type: "string", enum: [...EXPERIMENT_STATUSES] }, description: "Only experiments in these statuses (default all)" },
    }),
  },
  {
    name: "propose-experiment",
    displayName: "Propose experiment",
    description:
      `Propose one experiment that changes one variable. At most 3 running and 3 proposed per scope. Safe autopilot: a person approves it from the weekly approval issue; full: it starts at once. Then tag posts with experimentId + arm.${OWN}`,
    parametersSchema: schema(["hypothesis", "hypothesisType", "variable", "arms"], {
      ...scope,
      hypothesis: text("What you expect and why, one sentence"),
      hypothesisType: text("feature:value being tested, e.g. hook:question (pick from performance-review's ranked types)"),
      variable: text("The one thing the variant changes"),
      arms,
      minPerArm: int("Posts needed per arm before measuring, 2–20 (default 3)"),
      windowDays: int("Scoring window in days; only 7 is supported (the default)"),
    }),
  },
  {
    name: "approve-experiment",
    displayName: "Approve experiment",
    description: "Start a proposed experiment. Only on full autopilot may an agent approve; otherwise a person approves on the Growth tab.",
    parametersSchema: schema(["experimentId"], { experimentId: text("Proposed experiment id (from list-experiments)"), note: text("Why (shown with the decision)") }),
  },
  {
    name: "reject-experiment",
    displayName: "Reject experiment",
    description: "Reject a proposed experiment with a reason (its post tags are cleared). Only on full autopilot may an agent reject.",
    parametersSchema: schema(["experimentId", "reason"], { experimentId: text("Proposed experiment id (from list-experiments)"), reason: text("Why it is rejected") }),
  },
  {
    name: "propose-feature-question",
    displayName: "Propose feature question",
    description:
      `Feature discovery: add a question Jev answers about every post caption, or retire one. New questions apply to new posts and backfill the last 90 days; at most 12 active. Propose questions that separate the top posts from the bottom ones in performance-review.${OWN}`,
    parametersSchema: schema([], {
      ...scope,
      op: choice(["add", "retire"], "add (default) a question, or retire one by key"),
      key: text("Short snake_case key, e.g. has_price (retire: the key to retire)"),
      type: choice(["noul", "choice", "score"], "noul (yes/no), choice (one of options) or score (one of levels)"),
      question: text("The question about the caption, e.g. Does the caption mention a price?"),
      options: ids("choice: the allowed answers"),
      levels: ids("score: the levels, lowest first"),
    }),
  },
  {
    name: "account-analytics",
    displayName: "Account analytics",
    description: `Engagement totals per account of one scope (latest snapshot per destination).${OWN}`,
    parametersSchema: schema([], { ...scope }),
  },
];
