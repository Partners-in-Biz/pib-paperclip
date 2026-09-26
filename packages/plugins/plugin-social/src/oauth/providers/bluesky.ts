/**
 * Bluesky (AT Protocol): handle + app password, custom PDS supported.
 * A session is created per publish. Links, mentions and hashtags become
 * facets with UTF-8 byte offsets; up to 4 images upload as blobs.
 */
import {
  downloadMedia,
  getJson,
  guessMime,
  postJson,
  ProviderHttpError,
  PublishRejected,
  publicOrigin,
  readJson,
  request,
} from "../http.js";
import type {
  ConnectCandidate,
  InboxCandidate,
  MetricsSnapshot,
  ProviderAccount,
  ProviderEnv,
  PublishOutcome,
  PublishRequest,
  SocialProvider,
} from "../types.js";
import { bestEffort, count, guard, images, videos } from "./common.js";

export const BLUESKY_PUBLIC_API = "https://public.api.bsky.app";
const MAX_GRAPHEMES = 300;
const MAX_BLOB_BYTES = 1_000_000;

interface Session {
  accessJwt: string;
  did: string;
  handle: string;
}

export function graphemeLength(text: string): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment(t: string): Iterable<unknown> } }).Segmenter;
  if (!Segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n += 1;
  return n;
}

export interface DetectedFacet {
  type: "link" | "mention" | "tag";
  byteStart: number;
  byteEnd: number;
  value: string;
}

function byteOffset(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), "utf8");
}

/** Find links, @handle.domain mentions and #tags with UTF-8 byte offsets. */
export function detectFacets(text: string): DetectedFacet[] {
  const out: DetectedFacet[] = [];
  const push = (type: DetectedFacet["type"], start: number, end: number, value: string) => {
    out.push({ type, byteStart: byteOffset(text, start), byteEnd: byteOffset(text, end), value });
  };
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  for (const m of text.matchAll(urlRe)) {
    let url = m[0];
    url = url.replace(/[.,;:!?'")\]]+$/, "");
    if (url.length < 10) continue;
    push("link", m.index!, m.index! + url.length, url);
  }
  const mentionRe = /(^|[\s(])(@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+))/g;
  for (const m of text.matchAll(mentionRe)) {
    const start = m.index! + m[1]!.length;
    const handle = m[3]!.replace(/\.+$/, "");
    if (!/\.[a-zA-Z]{2,}$/.test(handle)) continue;
    push("mention", start, start + 1 + handle.length, handle.toLowerCase());
  }
  const tagRe = /(^|\s)(#([^\s#­⁠ ​‌‍⃢]+))/gu;
  for (const m of text.matchAll(tagRe)) {
    const raw = m[3]!.replace(/\p{P}+$/gu, "");
    if (!raw || /^\d+$/.test(raw) || Array.from(raw).length > 64) continue;
    const start = m.index! + m[1]!.length;
    push("tag", start, start + 1 + raw.length, raw);
  }
  // Drop mentions/tags that sit inside a link.
  const links = out.filter((f) => f.type === "link");
  return out
    .filter((f) => f.type === "link" || !links.some((l) => f.byteStart >= l.byteStart && f.byteEnd <= l.byteEnd))
    .sort((a, b) => a.byteStart - b.byteStart);
}

async function createSession(pds: string, identifier: string, password: string): Promise<Session> {
  const res = await request(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (res.status === 401) {
    const body = await res.text();
    throw new ProviderHttpError(401, body, "Bluesky sign-in (check the handle and app password)");
  }
  const data = await readJson<{ accessJwt?: string; did?: string; handle?: string }>(res, "Bluesky sign-in");
  if (!data.accessJwt || !data.did) throw new Error("Bluesky did not return a session");
  return { accessJwt: data.accessJwt, did: data.did, handle: data.handle ?? identifier };
}

function pdsOf(account: ProviderAccount): string {
  const pds = typeof account.meta.pdsUrl === "string" && account.meta.pdsUrl ? account.meta.pdsUrl : "https://bsky.social";
  return pds.replace(/\/+$/, "");
}

async function sessionFor(account: ProviderAccount): Promise<Session> {
  const identifier = account.token.identifier;
  const password = account.token.appPassword;
  if (!identifier || !password) throw new ProviderHttpError(401, "", "Bluesky app password is missing; reconnect the account");
  return createSession(pdsOf(account), identifier, password);
}

async function resolveHandle(pds: string, handle: string): Promise<string | null> {
  for (const base of [pds, BLUESKY_PUBLIC_API]) {
    const res = await bestEffort(() => getJson<{ did?: string }>(`${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, {}, "Bluesky resolve handle"));
    if (res.value?.did) return res.value.did;
  }
  return null;
}

export async function buildFacets(text: string, pds: string): Promise<Array<Record<string, unknown>>> {
  const facets: Array<Record<string, unknown>> = [];
  for (const f of detectFacets(text)) {
    let feature: Record<string, unknown> | null = null;
    if (f.type === "link") feature = { $type: "app.bsky.richtext.facet#link", uri: f.value };
    if (f.type === "tag") feature = { $type: "app.bsky.richtext.facet#tag", tag: f.value };
    if (f.type === "mention") {
      const did = await resolveHandle(pds, f.value);
      if (did) feature = { $type: "app.bsky.richtext.facet#mention", did };
    }
    if (feature) facets.push({ index: { byteStart: f.byteStart, byteEnd: f.byteEnd }, features: [feature] });
  }
  return facets;
}

async function createPost(pds: string, session: Session, record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
  const data = await postJson<{ uri?: string; cid?: string }>(`${pds}/xrpc/com.atproto.repo.createRecord`, {
    repo: session.did,
    collection: "app.bsky.feed.post",
    record: { $type: "app.bsky.feed.post", createdAt: new Date().toISOString(), ...record },
  }, { Authorization: `Bearer ${session.accessJwt}` }, "Bluesky post");
  if (!data.uri || !data.cid) throw new Error("Bluesky did not return the post id");
  return { uri: data.uri, cid: data.cid };
}

function postUrl(handle: string, uri: string): string {
  return `https://bsky.app/profile/${handle}/post/${uri.split("/").pop()}`;
}

async function blueskyPublish(_env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  if (videos(req.media).length) throw new PublishRejected("Bluesky video posts are not supported yet; use up to 4 images");
  const imgs = images(req.media);
  if (imgs.length > 4) throw new PublishRejected("A Bluesky post takes up to 4 images");
  const text = req.text.trim();
  const length = graphemeLength(text);
  if (length > MAX_GRAPHEMES) throw new PublishRejected(`Bluesky posts are limited to ${MAX_GRAPHEMES} characters (this one has ${length}). Add a shorter Bluesky override.`);
  if (!text && imgs.length === 0 && !req.link) throw new PublishRejected("A Bluesky post needs text, a link or images");
  const pds = pdsOf(account);
  const session = await sessionFor(account);
  const record: Record<string, unknown> = { text, langs: ["en"] };
  const facets = await buildFacets(text, pds);
  if (facets.length) record.facets = facets;
  if (imgs.length) {
    const uploaded: Array<Record<string, unknown>> = [];
    for (const img of imgs) {
      const file = await downloadMedia(img.url, { maxBytes: MAX_BLOB_BYTES, fallbackMime: guessMime(img.url, "image"), label: "Bluesky image" });
      const res = await request(`${pds}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": file.mime },
        body: file.bytes,
      });
      const blob = await readJson<{ blob?: Record<string, unknown> }>(res, "Bluesky image upload");
      if (!blob.blob) throw new Error("Bluesky did not return the image blob");
      uploaded.push({
        alt: img.altText ?? "",
        image: blob.blob,
        ...(img.width && img.height ? { aspectRatio: { width: img.width, height: img.height } } : {}),
      });
    }
    record.embed = { $type: "app.bsky.embed.images", images: uploaded };
  } else if (req.link) {
    record.embed = { $type: "app.bsky.embed.external", external: { uri: req.link, title: req.title ?? req.link, description: "" } };
  }
  const post = await createPost(pds, session, record);
  const detail: Record<string, unknown> = { cid: post.cid };
  if (req.firstComment) {
    const reply = await bestEffort(async () => {
      const replyText = req.firstComment!.trim();
      const r: Record<string, unknown> = { text: replyText, reply: { root: post, parent: post } };
      const replyFacets = await buildFacets(replyText, pds);
      if (replyFacets.length) r.facets = replyFacets;
      return createPost(pds, session, r);
    });
    if (reply.value) detail.firstCommentId = reply.value.uri;
    if (reply.error) detail.firstCommentError = reply.error;
  }
  return { ok: true, externalId: post.uri, url: postUrl(session.handle, post.uri), detail };
}

/** Connect with handle + app password (no OAuth). */
export async function connectBluesky(input: { identifier: string; appPassword: string; pdsUrl?: string | null; defaultPds: string }): Promise<ConnectCandidate> {
  const identifier = input.identifier.trim().replace(/^@/, "");
  const appPassword = input.appPassword.trim();
  if (!identifier || !appPassword) throw new PublishRejected("Enter the Bluesky handle and an app password");
  const pds = await publicOrigin(input.pdsUrl?.trim() || input.defaultPds, "Bluesky PDS URL");
  const session = await createSession(pds, identifier, appPassword);
  const profile = await bestEffort(() => getJson<{ displayName?: string; avatar?: string; handle?: string }>(
    `${BLUESKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(session.did)}`,
    {},
    "Bluesky profile",
  ));
  const handle = profile.value?.handle ?? session.handle;
  return {
    key: `bsky:${session.did}`,
    platform: "bluesky",
    kind: "profile",
    externalId: session.did,
    displayName: profile.value?.displayName || `@${handle}`,
    handle,
    avatarUrl: profile.value?.avatar ?? null,
    token: { accessToken: "", identifier, appPassword, expiresAt: null, scopes: ["atproto"] },
    expiresAt: null,
    scopes: ["atproto"],
    meta: { pdsUrl: pds, did: session.did },
  };
}

export const blueskyProvider: SocialProvider = {
  platform: "bluesky",
  refreshKind: "none",
  defaultScopes: () => ["atproto"],
  publish: (env, account, req) => guard(() => blueskyPublish(env, account, req)),
  async metrics(_env, _account, externalId): Promise<MetricsSnapshot | null> {
    const data = await getJson<{ posts?: Array<{ likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }> }>(
      `${BLUESKY_PUBLIC_API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(externalId)}`,
      {},
      "Bluesky metrics",
    );
    const p = data.posts?.[0];
    if (!p) return null;
    return { views: 0, likes: count(p.likeCount), comments: count(p.replyCount), shares: count(p.repostCount) + count(p.quoteCount), raw: { post: p } };
  },
  async inbox(_env, account): Promise<InboxCandidate[]> {
    const session = await sessionFor(account);
    const data = await getJson<{
      notifications?: Array<{ uri: string; reason: string; indexedAt?: string; author?: { handle?: string; displayName?: string }; record?: { text?: string; reply?: { parent?: { uri?: string } } } }>;
    }>(`${pdsOf(account)}/xrpc/app.bsky.notification.listNotifications?limit=40`, { Authorization: `Bearer ${session.accessJwt}` }, "Bluesky notifications");
    return (data.notifications ?? [])
      .filter((n) => ["mention", "reply", "quote"].includes(n.reason) && n.record?.text)
      .map((n) => ({
        externalId: n.uri,
        parentExternalId: n.record?.reply?.parent?.uri ?? null,
        kind: n.reason === "reply" ? ("comment" as const) : ("mention" as const),
        author: n.author?.handle ? `@${n.author.handle}` : n.author?.displayName ?? "Bluesky user",
        body: n.record?.text ?? "",
        permalink: n.author?.handle ? postUrl(n.author.handle, n.uri) : null,
        receivedAt: n.indexedAt ?? null,
        destinationExternalId: n.record?.reply?.parent?.uri ?? null,
      }));
  },
  reply: (_env, account, target, text) =>
    guard(async () => {
      const pds = pdsOf(account);
      const session = await sessionFor(account);
      const found = await getJson<{ posts?: Array<{ uri: string; cid: string; record?: { reply?: { root?: { uri: string; cid: string } } } }> }>(
        `${BLUESKY_PUBLIC_API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(target.externalId)}`,
        {},
        "Bluesky reply target",
      );
      const parent = found.posts?.[0];
      if (!parent) throw new PublishRejected("The Bluesky post to reply to no longer exists");
      const root = parent.record?.reply?.root ?? { uri: parent.uri, cid: parent.cid };
      const trimmed = text.trim();
      if (graphemeLength(trimmed) > MAX_GRAPHEMES) throw new PublishRejected("Bluesky replies are limited to 300 characters");
      const record: Record<string, unknown> = { text: trimmed, reply: { root, parent: { uri: parent.uri, cid: parent.cid } } };
      const facets = await buildFacets(trimmed, pds);
      if (facets.length) record.facets = facets;
      const post = await createPost(pds, session, record);
      return { ok: true, externalId: post.uri, url: postUrl(session.handle, post.uri) };
    }),
};
