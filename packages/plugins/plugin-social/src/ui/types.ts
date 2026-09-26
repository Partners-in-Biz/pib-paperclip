import type { PlatformOverride, SocialPlatform } from "../platforms.js";

export interface Account {
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
  clientRef: string | null;
  clientName: string | null;
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

export interface Post {
  id: string;
  body: string;
  status: "draft" | "review" | "approved" | "scheduled" | "publishing" | "published" | "partially_published" | "failed";
  scope: string;
  ownerUserId: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  clientRef: string | null;
  clientName: string | null;
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

export interface MediaAsset {
  id: string;
  name: string;
  url: string;
  kind: "image" | "video";
  mime: string | null;
  bytes: number | null;
  altText: string | null;
  clientRef: string | null;
  clientName: string | null;
}

export interface Feed {
  id: string;
  url: string;
  title: string | null;
  accountIds: string[];
  isActive: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  clientRef: string | null;
  clientName: string | null;
}

export interface InboxItem {
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
  clients: Array<{ id: string; name: string; domain: string | null }>;
  agent: { agentKey: string; agentId: string | null; status: string | null; active: boolean };
  pendingPickers: Array<{ pickerId: string; platform: string }>;
  viewer: { userId: string | null };
}

export type RunAction = (key: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;
