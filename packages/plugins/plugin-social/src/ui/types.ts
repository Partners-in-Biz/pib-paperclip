import type { PlatformOverride, SocialPlatform } from "../platforms.js";

/** Scope fields every scoped record carries. `client` is "company:<id>" / "contact:<id>", null for own work. */
export interface Scoped {
  client: string | null;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
}

/** A CRM company or contact, for "Belongs to" pickers. */
export interface ClientOption {
  kind: "company" | "contact";
  id: string;
  name: string;
  domain: string | null;
  email: string | null;
  lifecycle: string | null;
  client: string;
}

export interface Account extends Scoped {
  id: string;
  platform: SocialPlatform;
  scope: string;
  status: "connected" | "expiring" | "needs_reconnect" | "disabled";
  displayName: string;
  handle: string | null;
  externalId: string | null;
  avatarUrl: string | null;
  connected: boolean;
  tokenExpiresAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
  kind: string | null;
  via: string | null;
  boardId: string | null;
  boardName: string | null;
  defaultSubreddit: string | null;
  instanceUrl: string | null;
  pageName: string | null;
  reconnectIssueId: string | null;
}

export interface MediaRef {
  assetId: string | null;
  url: string;
  kind: "image" | "video";
  mime: string | null;
  altText: string | null;
}

export interface Destination {
  id: string;
  accountId: string;
  platform: SocialPlatform | null;
  accountName: string;
  accountStatus: string | null;
  status: "pending" | "publishing" | "retrying" | "published" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  externalId: string | null;
  externalUrl: string | null;
  lastError: string | null;
  publishedAt: string | null;
  issueId: string | null;
}

export interface Post extends Scoped {
  id: string;
  body: string;
  status: "draft" | "review" | "approved" | "scheduled" | "publishing" | "published" | "partially_published" | "failed";
  scope: string;
  ownerUserId: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  firstComment: string | null;
  media: MediaRef[];
  overrides: Partial<Record<SocialPlatform, PlatformOverride>>;
  source: string;
  error: string | null;
  failureIssueId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  destinations: Destination[];
}

export interface MediaAsset extends Scoped {
  id: string;
  name: string;
  url: string;
  kind: "image" | "video";
  mime: string | null;
  bytes: number | null;
  altText: string | null;
}

export interface Feed extends Scoped {
  id: string;
  url: string;
  title: string | null;
  accountIds: string[];
  isActive: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface InboxItem extends Scoped {
  id: string;
  accountId: string | null;
  platform: string | null;
  kind: string;
  author: string;
  body: string;
  status: string;
  permalink: string | null;
  postId: string | null;
  replyDraft: string | null;
  replyBody: string | null;
  repliedAt: string | null;
  receivedAt: string | null;
  canReply: boolean;
}

export interface Template {
  id: string;
  name: string;
  body: string;
  platform: string | null;
}

export interface PlatformInfo {
  platform: SocialPlatform;
  label: string;
  mode: "oauth" | "credentials" | "instance";
  configured: boolean;
  missing: string[];
}

export interface Snapshot {
  /** The page's scope as sent to the worker ("company:<id>" / "contact:<id>"), null for own work. */
  scope: string | null;
  /** The client this page works for, null for own work. */
  client: ClientOption | null;
  config: {
    saved: boolean;
    publicBaseUrl: string | null;
    publicBaseUrlError: string | null;
    redirectUri: string | null;
    encryptionKey: boolean;
    r2: boolean;
    timezone: string;
    linkedinOrgPages: boolean;
    allowAgentReplies: boolean;
    blueskyDefaultPds: string;
    mastodonDefaultInstance: string | null;
  };
  platforms: PlatformInfo[];
  accounts: Account[];
  posts: Post[];
  templates: Template[];
  media: MediaAsset[];
  feeds: Feed[];
  inbox: InboxItem[];
  agent: SocialAgent;
  pendingPickers: Array<{ pickerId: string; platform: string }>;
  viewer: { userId: string | null };
}

/** An agent in the company (hire popup assignees, link picker). */
export interface AgentOption {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
  icon: string | null;
  createdAt: string | null;
  /** Social skill slugs the agent does not have (hire-options only). */
  missingSkills?: string[];
}

/** The hire task the plugin opened (kit agent-hire). */
export interface HireRecord {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  status: "open" | "linked" | "cancelled";
}

export type LinkedBy = "auto" | "manual" | "managed" | null;

/** The Social agent card. `hire` and `candidates` are only filled on the own page. */
export interface SocialAgent {
  agentKey: string;
  agentId: string | null;
  name: string | null;
  status: string | null;
  active: boolean;
  linkedBy: LinkedBy;
  hire: HireRecord | null;
  candidates: AgentOption[];
  missingSkills: string[];
}

/** `social.hire-options`. */
export interface HireOptions {
  draft: { title: string; description: string };
  agents: AgentOption[];
  defaultAssigneeAgentId: string | null;
  status: { agent: AgentOption | null; linkedBy: LinkedBy; hire: HireRecord | null; candidates: AgentOption[] };
}

export type RunAction = (key: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;
