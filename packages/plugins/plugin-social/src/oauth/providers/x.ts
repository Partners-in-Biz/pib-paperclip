/**
 * X: OAuth 2.0 authorization code with PKCE (S256), v2 media upload and
 * v2 posts. OAuth 1.0a is not supported; create an OAuth 2.0 client.
 */
import { createHash, randomBytes } from "node:crypto";
import { clip } from "../../domain.js";
import {
  basicAuth,
  downloadMedia,
  expiresAtFrom,
  getJson,
  guessMime,
  pollUntil,
  postForm,
  postJson,
  ProviderHttpError,
  PublishRejected,
  readJson,
  request,
  str,
} from "../http.js";
import {
  scopesFor,
  type ExchangeResult,
  type InboxCandidate,
  type MetricsSnapshot,
  type ProviderAccount,
  type ProviderEnv,
  type PublishOutcome,
  type PublishRequest,
  type SocialProvider,
} from "../types.js";
import { bestEffort, count, guard, optionalCount, requireCode, videos, withLink } from "./common.js";

const API = "https://api.x.com";
const TOKEN_URL = `${API}/2/oauth2/token`;
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
const CHUNK_BYTES = 4 * 1024 * 1024;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Approximate X's weighted length: every URL counts 23, CJK and emoji count
 * 2, everything else 1.
 */
export function xWeightedLength(text: string): number {
  let total = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    total += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    total += light ? 1 : 2;
  }
  return total;
}

function tokenHeaders(env: ProviderEnv): Record<string, string> {
  return env.app.clientSecret ? { Authorization: basicAuth(env.app.clientId, env.app.clientSecret) } : {};
}

async function uploadSimple(token: string, url: string, altText: string | null): Promise<string> {
  const file = await downloadMedia(url, { maxBytes: 5 * 1024 * 1024, fallbackMime: guessMime(url, "image") });
  const category = file.mime === "image/gif" ? "tweet_gif" : "tweet_image";
  const form = new FormData();
  form.append("media", new Blob([file.bytes], { type: file.mime }), "media");
  form.append("media_category", category);
  form.append("media_type", file.mime);
  const res = await request(`${API}/2/media/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const data = await readJson<{ data?: { id?: string } }>(res, "X media upload");
  const id = data.data?.id;
  if (!id) throw new Error("X did not return a media id");
  if (altText) {
    await bestEffort(() => postJson(`${API}/2/media/metadata`, { id, metadata: { alt_text: { text: clip(altText, 1000) } } }, { Authorization: `Bearer ${token}` }, "X alt text"));
  }
  return id;
}

async function uploadChunked(token: string, url: string): Promise<string> {
  const file = await downloadMedia(url, { maxBytes: 512 * 1024 * 1024, fallbackMime: guessMime(url, "video") });
  const auth = { Authorization: `Bearer ${token}` };
  const init = await postJson<{ data?: { id?: string } }>(`${API}/2/media/upload/initialize`, {
    media_type: file.mime === "video/quicktime" ? "video/mp4" : file.mime,
    total_bytes: file.size,
    media_category: "tweet_video",
  }, auth, "X media initialize");
  const id = init.data?.id;
  if (!id) throw new Error("X did not return a media id");
  for (let offset = 0, segment = 0; offset < file.size; offset += CHUNK_BYTES, segment += 1) {
    const form = new FormData();
    form.append("segment_index", String(segment));
    form.append("media", new Blob([file.bytes.slice(offset, offset + CHUNK_BYTES)], { type: "application/octet-stream" }), "chunk");
    const res = await request(`${API}/2/media/upload/${id}/append`, { method: "POST", headers: auth, body: form, timeoutMs: 180_000 });
    if (!res.ok) await readJson(res, "X media append");
  }
  const fin = await readJson<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(
    await request(`${API}/2/media/upload/${id}/finalize`, { method: "POST", headers: auth }),
    "X media finalize",
  );
  let state = fin.data?.processing_info?.state;
  if (state && state !== "succeeded") {
    await pollUntil<void>(async () => {
      const status = await getJson<{ data?: { processing_info?: { state?: string; error?: { message?: string } } } }>(
        `${API}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`,
        auth,
        "X media status",
      );
      state = status.data?.processing_info?.state;
      if (state === "succeeded" || !state) return { done: true, value: undefined };
      if (state === "failed") throw new PublishRejected(`X could not process the video: ${status.data?.processing_info?.error?.message ?? "failed"}`);
      return { done: false };
    }, { intervalMs: 5_000, timeoutMs: 300_000, label: "X video processing" });
  }
  return id;
}

async function postTweet(token: string, body: Record<string, unknown>, label: string): Promise<string> {
  const data = await postJson<{ data?: { id?: string } }>(`${API}/2/tweets`, body, { Authorization: `Bearer ${token}` }, label);
  const id = data.data?.id;
  if (!id) throw new Error(`${label}: no post id`);
  return id;
}

async function xPublish(_env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const token = account.token.accessToken;
  const vids = videos(req.media);
  if (req.media.length > 4) throw new PublishRejected("An X post takes up to 4 images");
  if (vids.length && req.media.length > 1) throw new PublishRejected("An X post takes one video or up to 4 images");
  const text = withLink(req.text, req.link);
  if (!text && req.media.length === 0) throw new PublishRejected("An X post needs text or media");
  const weighted = xWeightedLength(text);
  if (weighted > 280 && !account.meta.longPosts) {
    throw new PublishRejected(`X posts are limited to 280 characters (this one counts ${weighted}). Add a shorter X override.`);
  }
  const mediaIds: string[] = [];
  for (const item of req.media) {
    mediaIds.push(item.kind === "video" ? await uploadChunked(token, item.url) : await uploadSimple(token, item.url, item.altText));
  }
  const body: Record<string, unknown> = { text };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  const id = await postTweet(token, body, "X post");
  const detail: Record<string, unknown> = {};
  if (req.firstComment) {
    const reply = await bestEffort(() => postTweet(token, { text: clip(req.firstComment!, 280), reply: { in_reply_to_tweet_id: id } }, "X first reply"));
    if (reply.value) detail.firstCommentId = reply.value;
    if (reply.error) detail.firstCommentError = reply.error;
  }
  return { ok: true, externalId: id, url: `https://x.com/${account.handle ?? "i"}/status/${id}`, detail };
}

export const xProvider: SocialProvider = {
  platform: "x",
  refreshKind: "refresh_token",
  defaultScopes: () => X_SCOPES,
  authorize(env, state) {
    const { verifier, challenge } = pkcePair();
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      scope: scopesFor(xProvider, env).join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: `https://x.com/i/oauth2/authorize?${qs.toString()}`, sessionExtra: { codeVerifier: verifier } };
  },
  async exchange(env, params, session): Promise<ExchangeResult> {
    const code = requireCode(params, "X");
    const verifier = str(session.codeVerifier);
    if (!verifier) throw new Error("The X sign-in session lost its PKCE verifier. Start the connection again.");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: env.redirectUri,
      code_verifier: verifier,
      client_id: env.app.clientId,
    }, tokenHeaders(env), "X code exchange");
    if (!data.access_token) throw new Error("X did not return an access token");
    const me = await getJson<{ data?: { id?: string; name?: string; username?: string; profile_image_url?: string; verified_type?: string } }>(
      `${API}/2/users/me?user.fields=profile_image_url,username,name,verified_type`,
      { Authorization: `Bearer ${data.access_token}` },
      "X profile",
    );
    const user = me.data;
    if (!user?.id) throw new Error("X did not return the account id");
    const scopes = data.scope ? data.scope.split(/\s+/).filter(Boolean) : scopesFor(xProvider, env);
    const expiresAt = expiresAtFrom(data.expires_in);
    return {
      candidates: [{
        key: `x:${user.id}`,
        platform: "x",
        kind: "profile",
        externalId: user.id,
        displayName: user.name ?? `@${user.username}`,
        handle: user.username ?? null,
        avatarUrl: user.profile_image_url ?? null,
        token: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, scopes },
        expiresAt,
        scopes,
        meta: { longPosts: user.verified_type === "blue" || user.verified_type === "business" },
      }],
    };
  },
  async refresh(env, account) {
    if (!account.token.refreshToken) throw new Error("No X refresh token stored (offline.access missing); reconnect the account");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number }>(TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: account.token.refreshToken,
      client_id: env.app.clientId,
    }, tokenHeaders(env), "X token refresh");
    if (!data.access_token) throw new Error("X did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in);
    return { token: { ...account.token, accessToken: data.access_token, refreshToken: data.refresh_token ?? account.token.refreshToken, expiresAt }, expiresAt };
  },
  publish: (env, account, req) => guard(() => xPublish(env, account, req)),
  async metrics(_env, account, externalId): Promise<MetricsSnapshot | null> {
    const data = await getJson<{ data?: { public_metrics?: Record<string, number> } }>(
      `${API}/2/tweets/${encodeURIComponent(externalId)}?tweet.fields=public_metrics`,
      { Authorization: `Bearer ${account.token.accessToken}` },
      "X metrics",
    );
    const m = data.data?.public_metrics ?? {};
    return {
      views: count(m.impression_count),
      likes: count(m.like_count),
      comments: count(m.reply_count),
      shares: count(m.retweet_count) + count(m.quote_count),
      impressions: optionalCount(m.impression_count),
      saves: optionalCount(m.bookmark_count),
      raw: { public_metrics: m },
    };
  },
  async inbox(_env, account): Promise<InboxCandidate[]> {
    const data = await getJson<{
      data?: Array<{ id: string; text: string; author_id?: string; created_at?: string; conversation_id?: string }>;
      includes?: { users?: Array<{ id: string; username?: string; name?: string }> };
    }>(
      `${API}/2/users/${encodeURIComponent(account.externalId)}/mentions?max_results=20&tweet.fields=created_at,author_id,conversation_id&expansions=author_id&user.fields=username,name`,
      { Authorization: `Bearer ${account.token.accessToken}` },
      "X mentions",
    );
    const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u]));
    return (data.data ?? [])
      .filter((t) => t.author_id !== account.externalId)
      .map((t) => {
        const user = t.author_id ? users.get(t.author_id) : undefined;
        return {
          externalId: t.id,
          parentExternalId: t.conversation_id ?? null,
          kind: "mention" as const,
          author: user?.username ? `@${user.username}` : user?.name ?? "X user",
          body: t.text,
          permalink: `https://x.com/${user?.username ?? "i"}/status/${t.id}`,
          receivedAt: t.created_at ?? null,
          destinationExternalId: t.conversation_id ?? null,
        };
      });
  },
  reply: (_env, account, target, text) =>
    guard(async () => {
      const id = await postTweet(account.token.accessToken, { text: clip(text, 280), reply: { in_reply_to_tweet_id: target.externalId } }, "X reply");
      return { ok: true, externalId: id, url: `https://x.com/${account.handle ?? "i"}/status/${id}` };
    }),
};

export { ProviderHttpError };
