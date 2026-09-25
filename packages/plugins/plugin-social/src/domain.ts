import { randomUUID } from "node:crypto";

export const POST_STATUSES = ["draft", "review", "approved", "scheduled", "publishing", "published", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export type AccountScope = "org" | "personal";

export class SocialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialError";
  }
}

const TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ["review"],
  review: ["approved", "draft"],
  approved: ["scheduled"],
  scheduled: ["publishing"],
  publishing: ["published", "failed"],
  published: [],
  failed: ["draft"],
};

export function assertTransition(from: PostStatus, to: PostStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new SocialError(`A ${from} post cannot move to ${to}`);
}

export function assertAgentTransition(from: PostStatus, to: PostStatus): void {
  if (to === "approved" || to === "publishing" || to === "published") {
    throw new SocialError("Agents draft and schedule. A person approves before publishing.");
  }
  assertTransition(from, to);
}

export function assertDestination(input: {
  postScope: AccountScope;
  accountScope: AccountScope;
  accountOwnerUserId: string | null;
  actorUserId: string | null;
}): void {
  if (input.postScope === "org" && input.accountScope === "personal") {
    throw new SocialError("An organisation post cannot target a personal account");
  }
  if (input.accountScope === "personal" && input.accountOwnerUserId !== input.actorUserId) {
    throw new SocialError("A personal account can only be used by its owner");
  }
}

export function publishResult(secretRef: string | null, now = new Date()): { status: "published" | "failed"; result: Record<string, unknown> } {
  if (!secretRef) return { status: "failed", result: { reason: "Account has no credential reference" } };
  return { status: "published", result: { acceptedAt: now.toISOString() } };
}

export function createPost(input: { companyId: string; body: string; scope?: AccountScope; ownerUserId: string | null }): {
  id: string;
  companyId: string;
  body: string;
  status: PostStatus;
  scope: AccountScope;
  ownerUserId: string | null;
  scheduledAt: string | null;
} {
  const body = input.body.trim();
  if (!body) throw new SocialError("Post body is required");
  return {
    id: randomUUID(),
    companyId: input.companyId,
    body,
    status: "draft",
    scope: input.scope ?? "org",
    ownerUserId: input.ownerUserId,
    scheduledAt: null,
  };
}

export interface TemplateDraft {
  id: string;
  companyId: string;
  name: string;
  body: string;
  platform: string | null;
}

export function createTemplate(input: {
  companyId: string;
  name: string;
  body: string;
  platform?: string | null;
  id?: string;
}): TemplateDraft {
  const name = input.name.trim();
  if (!name) throw new SocialError("Template name is required");
  const body = input.body.trim();
  if (!body) throw new SocialError("Template body is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    body,
    platform: input.platform?.trim() || null,
  };
}

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

export function assertMetric(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new SocialError(`${key} must be a non-negative integer`);
  }
  return amount;
}

export function aggregateMetrics(rows: PostMetrics[]): PostMetrics {
  return rows.reduce(
    (sum, row) => ({
      views: sum.views + row.views,
      likes: sum.likes + row.likes,
      comments: sum.comments + row.comments,
      shares: sum.shares + row.shares,
    }),
    { views: 0, likes: 0, comments: 0, shares: 0 },
  );
}

export interface MediaAssetDraft {
  id: string;
  companyId: string;
  name: string;
  url: string;
  kind: string;
}

export function createMediaAsset(input: {
  companyId: string;
  name: string;
  url: string;
  kind?: string;
  id?: string;
}): MediaAssetDraft {
  const name = input.name.trim();
  if (!name) throw new SocialError("Asset name is required");
  const url = input.url.trim();
  if (!url) throw new SocialError("Asset URL is required");
  const kind = (input.kind ?? "image").trim().toLowerCase();
  if (kind !== "image" && kind !== "video") throw new SocialError("Asset kind must be image or video");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    url,
    kind,
  };
}

export interface RssFeedDraft {
  id: string;
  companyId: string;
  url: string;
  accountId: string | null;
  isActive: boolean;
}

export function createRssFeed(input: {
  companyId: string;
  url: string;
  accountId?: string | null;
  id?: string;
}): RssFeedDraft {
  const url = input.url.trim();
  if (!url) throw new SocialError("Feed URL is required");
  if (!/^https?:\/\//i.test(url)) throw new SocialError("Feed URL must start with http(s)");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    url,
    accountId: input.accountId?.trim() || null,
    isActive: true,
  };
}

export interface InboxItemDraft {
  id: string;
  companyId: string;
  accountId: string | null;
  kind: "mention" | "comment" | "message";
  author: string;
  body: string;
  status: "new" | "read" | "replied";
}

export function assertInboxKind(value: string): "mention" | "comment" | "message" {
  if (value !== "mention" && value !== "comment" && value !== "message") {
    throw new SocialError("Inbox kind must be mention, comment, or message");
  }
  return value;
}

export function createInboxItem(input: {
  companyId: string;
  kind: string;
  body: string;
  accountId?: string | null;
  author?: string;
  id?: string;
}): InboxItemDraft {
  const body = input.body.trim();
  if (!body) throw new SocialError("Inbox item body is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    accountId: input.accountId?.trim() || null,
    kind: assertInboxKind(input.kind),
    author: (input.author ?? "").trim(),
    body,
    status: "new",
  };
}
