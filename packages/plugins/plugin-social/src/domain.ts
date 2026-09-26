/**
 * Pure domain rules: post transitions, the publish retry state machine,
 * post status rollup, token refresh scheduling and metric windows.
 * No I/O here, so every rule is unit tested directly.
 */
import { randomUUID } from "node:crypto";
import {
  POST_STATUSES,
  type DestinationStatus,
  type PostStatus,
  type SocialPlatform,
} from "./platforms.js";

export { POST_STATUSES };
export type { PostStatus };
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
  approved: ["scheduled", "draft"],
  scheduled: ["publishing", "approved", "draft"],
  publishing: ["published", "partially_published", "failed"],
  published: [],
  partially_published: ["publishing"],
  failed: ["publishing", "draft"],
};

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: PostStatus, to: PostStatus): void {
  if (!canTransition(from, to)) throw new SocialError(`A ${from.replace("_", " ")} post cannot move to ${to.replace("_", " ")}`);
}

export function assertAgentTransition(from: PostStatus, to: PostStatus): void {
  if (to === "approved" || to === "published" || to === "partially_published") {
    throw new SocialError("Agents draft and schedule. A person approves before publishing.");
  }
  assertTransition(from, to);
}

/** Post content can change only before it is approved. */
export function assertEditable(status: PostStatus): void {
  if (status !== "draft" && status !== "review") {
    throw new SocialError(`A ${status.replace("_", " ")} post cannot be edited. Move it back to draft first.`);
  }
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

// ── Publish retry state machine ─────────────────────────────────────────────

/** Wait after attempt 1, 2, 3, 4 fails. Attempt 5 failing is final. */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const MAX_PUBLISH_ATTEMPTS = 5;

export interface AttemptOutcome {
  ok: boolean;
  /** false for errors a retry cannot fix (validation, missing media, rejected content). */
  retryable?: boolean;
}

export interface NextDestinationState {
  status: Extract<DestinationStatus, "published" | "retrying" | "failed">;
  nextAttemptAt: Date | null;
  final: boolean;
}

/**
 * Decide what happens after an attempt. `attempts` already counts this one
 * (the claim increments it).
 */
export function nextDestinationState(attempts: number, outcome: AttemptOutcome, now: Date = new Date()): NextDestinationState {
  if (outcome.ok) return { status: "published", nextAttemptAt: null, final: true };
  if (outcome.retryable === false || attempts >= MAX_PUBLISH_ATTEMPTS) {
    return { status: "failed", nextAttemptAt: null, final: true };
  }
  const wait = RETRY_BACKOFF_MS[Math.max(0, Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1))]!;
  return { status: "retrying", nextAttemptAt: new Date(now.getTime() + wait), final: false };
}

/** Roll the destination statuses up into the post status. */
export function rollupPostStatus(statuses: DestinationStatus[]): PostStatus {
  if (statuses.length === 0) return "failed";
  if (statuses.some((s) => s === "pending" || s === "publishing" || s === "retrying")) return "publishing";
  const published = statuses.filter((s) => s === "published").length;
  if (published === statuses.length) return "published";
  if (published > 0) return "partially_published";
  return "failed";
}

// ── Token refresh scheduling ────────────────────────────────────────────────

export type RefreshKind = "refresh_token" | "long_lived" | "none";

export const REFRESH_TOKEN_HORIZON_MS = 48 * 3600_000;
export const LONG_LIVED_HORIZON_MS = 10 * 24 * 3600_000;
export const PUBLISH_REFRESH_MARGIN_MS = 5 * 60_000;
export const EXPIRING_WARNING_MS = 7 * 24 * 3600_000;

export interface RefreshCandidate {
  id: string;
  platform: SocialPlatform;
  status: string;
  expiresAt: string | null;
  refreshKind: RefreshKind;
  hasRefreshToken: boolean;
}

export type RefreshDecision =
  | { action: "refresh"; reason: string }
  | { action: "warn"; reason: string }
  | { action: "expired"; reason: string }
  | { action: "skip"; reason: string };

/** Pure decision used by the hourly refresh job. */
export function refreshDecision(candidate: RefreshCandidate, now: Date = new Date()): RefreshDecision {
  if (candidate.status === "disabled") return { action: "skip", reason: "disabled" };
  if (!candidate.expiresAt) return { action: "skip", reason: "no expiry" };
  const expires = new Date(candidate.expiresAt).getTime();
  if (Number.isNaN(expires)) return { action: "skip", reason: "bad expiry" };
  const left = expires - now.getTime();
  if (candidate.refreshKind === "refresh_token" && candidate.hasRefreshToken) {
    return left <= REFRESH_TOKEN_HORIZON_MS ? { action: "refresh", reason: "refresh token due" } : { action: "skip", reason: "not due" };
  }
  if (candidate.refreshKind === "long_lived") {
    if (left <= 0) return { action: "expired", reason: "long-lived token expired" };
    return left <= LONG_LIVED_HORIZON_MS ? { action: "refresh", reason: "long-lived token due" } : { action: "skip", reason: "not due" };
  }
  if (left <= 0) return { action: "expired", reason: "token expired and cannot be refreshed" };
  if (left <= EXPIRING_WARNING_MS) return { action: "warn", reason: "token expires soon and cannot be refreshed" };
  return { action: "skip", reason: "not due" };
}

/** Refresh right before publishing when the token is about to lapse. */
export function needsRefreshBeforePublish(expiresAt: string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt).getTime();
  return !Number.isNaN(expires) && expires - now.getTime() <= PUBLISH_REFRESH_MARGIN_MS;
}

// ── Metric windows ──────────────────────────────────────────────────────────

export const METRIC_WINDOWS = [
  { key: "1h", ms: 3600_000 },
  { key: "24h", ms: 24 * 3600_000 },
  { key: "7d", ms: 7 * 24 * 3600_000 },
  { key: "30d", ms: 30 * 24 * 3600_000 },
] as const;

/**
 * Which snapshot to take now. Only the latest passed window is captured, so a
 * late run never labels day-3 numbers as the 1h snapshot; missed earlier
 * windows are marked skipped.
 */
export function dueMetricWindow(publishedAt: string | null, done: string[], now: Date = new Date()): { capture: string | null; skip: string[] } {
  if (!publishedAt) return { capture: null, skip: [] };
  const start = new Date(publishedAt).getTime();
  if (Number.isNaN(start)) return { capture: null, skip: [] };
  const age = now.getTime() - start;
  const passed = METRIC_WINDOWS.filter((w) => age >= w.ms && !done.includes(w.key));
  if (passed.length === 0) return { capture: null, skip: [] };
  const latest = passed[passed.length - 1]!;
  return { capture: latest.key, skip: passed.slice(0, -1).map((w) => w.key) };
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface TemplateDraft {
  id: string;
  companyId: string;
  name: string;
  body: string;
  platform: string | null;
}

export function createTemplate(input: { companyId: string; name: string; body: string; platform?: string | null; id?: string }): TemplateDraft {
  const name = input.name.trim();
  if (!name) throw new SocialError("Template name is required");
  const body = input.body.trim();
  if (!body) throw new SocialError("Template body is required");
  return { id: input.id ?? randomUUID(), companyId: input.companyId, name, body, platform: input.platform?.trim() || null };
}

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

export function assertMetric(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount < 0) throw new SocialError(`${key} must be a non-negative integer`);
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
  kind: "image" | "video";
}

export function createMediaAsset(input: { companyId: string; name: string; url: string; kind?: string; id?: string }): MediaAssetDraft {
  const name = input.name.trim();
  if (!name) throw new SocialError("Asset name is required");
  const url = input.url.trim();
  if (!url) throw new SocialError("Asset URL is required");
  if (!/^https:\/\//i.test(url)) throw new SocialError("Asset URL must start with https://");
  const kind = (input.kind ?? "image").trim().toLowerCase();
  if (kind !== "image" && kind !== "video") throw new SocialError("Asset kind must be image or video");
  return { id: input.id ?? randomUUID(), companyId: input.companyId, name, url, kind };
}

export function mediaKindFromMime(mime: string): "image" | "video" {
  return mime.startsWith("video/") ? "video" : "image";
}

export interface RssFeedDraft {
  id: string;
  companyId: string;
  url: string;
  accountId: string | null;
  isActive: boolean;
}

export function createRssFeed(input: { companyId: string; url: string; accountId?: string | null; id?: string }): RssFeedDraft {
  const url = input.url.trim();
  if (!url) throw new SocialError("Feed URL is required");
  if (!/^https?:\/\//i.test(url)) throw new SocialError("Feed URL must start with http(s)");
  return { id: input.id ?? randomUUID(), companyId: input.companyId, url, accountId: input.accountId?.trim() || null, isActive: true };
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

export function createInboxItem(input: { companyId: string; kind: string; body: string; accountId?: string | null; author?: string; id?: string }): InboxItemDraft {
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

/** Normalise a subreddit input: "r/foo", "/r/foo/" and "foo" all become "foo". */
export function normalizeSubreddit(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^\/?r\//i, "").replace(/\/+$/, "").trim();
  return /^[A-Za-z0-9_]{2,32}$/.test(cleaned) ? cleaned : null;
}

/** Trim to the platform limit without cutting a surrogate pair. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
