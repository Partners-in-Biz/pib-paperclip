/**
 * YouTube Data API v3: resumable upload streamed straight from the media URL
 * (no buffering), privacy from the post override (default private).
 * Unverified Google apps can only upload private videos.
 */
import { clip } from "../../domain.js";
import {
  expiresAtFrom,
  fetchPublic,
  getJson,
  postForm,
  postJson,
  ProviderHttpError,
  PublishRejected,
  readJson,
  readText,
  request,
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
import { bestEffort, count, guard, images, requireCode, videos } from "./common.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

function privacyOf(value: string | undefined): "private" | "unlisted" | "public" {
  const v = (value ?? "private").toLowerCase();
  if (v === "public" || v === "unlisted" || v === "private") return v;
  throw new PublishRejected("YouTube privacy must be private, unlisted or public");
}

async function youtubePublish(_env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const vids = videos(req.media);
  if (vids.length !== 1 || images(req.media).length) throw new PublishRejected("YouTube needs exactly one video");
  const video = vids[0]!;
  const token = account.token.accessToken;
  const source = await fetchPublic(video.url, { label: "Video URL", timeoutMs: 3_600_000 });
  const length = source.headers.get("content-length");
  const mime = (source.headers.get("content-type") ?? video.mime ?? "video/mp4").split(";")[0]!;
  const title = clip((req.title ?? req.text.split("\n")[0] ?? "").trim() || "Untitled", 100);
  const init = await request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      ...(length ? { "X-Upload-Content-Length": length } : {}),
    },
    body: JSON.stringify({
      snippet: { title, description: clip(req.text, 5000), categoryId: "22" },
      status: { privacyStatus: privacyOf(req.privacy), selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) {
    await source.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError(init.status, await readText(init), "YouTube upload init");
  }
  const uploadUrl = init.headers.get("location");
  if (!uploadUrl || !source.body) throw new Error("YouTube did not return an upload URL");
  const put = await request(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mime, ...(length ? { "Content-Length": length } : {}) },
    body: source.body,
    duplex: "half",
    timeoutMs: 3_600_000,
  } as RequestInit & { duplex: "half"; timeoutMs: number });
  const created = await readJson<{ id?: string }>(put, "YouTube upload");
  if (!created.id) throw new Error("YouTube did not return a video id");
  const detail: Record<string, unknown> = { privacy: privacyOf(req.privacy) };
  if (req.firstComment) {
    const comment = await bestEffort(() => postJson<{ id?: string }>(`${API}/commentThreads?part=snippet`, {
      snippet: { videoId: created.id, topLevelComment: { snippet: { textOriginal: clip(req.firstComment!, 10000) } } },
    }, { Authorization: `Bearer ${token}` }, "YouTube first comment"));
    if (comment.value?.id) detail.firstCommentId = comment.value.id;
    if (comment.error) detail.firstCommentError = comment.error;
  }
  return { ok: true, externalId: created.id, url: `https://www.youtube.com/watch?v=${created.id}`, detail };
}

export const youtubeProvider: SocialProvider = {
  platform: "youtube",
  refreshKind: "refresh_token",
  defaultScopes: () => YOUTUBE_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      scope: scopesFor(youtubeProvider, env).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "Google");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(TOKEN_URL, {
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: env.redirectUri,
    }, {}, "Google code exchange");
    if (!data.access_token) throw new Error("Google did not return an access token");
    const channels = await getJson<{ items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> } }> }>(
      `${API}/channels?part=snippet&mine=true&maxResults=50`,
      { Authorization: `Bearer ${data.access_token}` },
      "YouTube channels",
    );
    const items = channels.items ?? [];
    if (items.length === 0) throw new Error("This Google account has no YouTube channel. Create one, then connect again.");
    const scopes = data.scope ? data.scope.split(/\s+/).filter(Boolean) : scopesFor(youtubeProvider, env);
    const expiresAt = expiresAtFrom(data.expires_in);
    return {
      candidates: items.map((ch) => ({
        key: `channel:${ch.id}`,
        platform: "youtube" as const,
        kind: "channel",
        externalId: ch.id,
        displayName: ch.snippet?.title ?? "YouTube channel",
        handle: ch.snippet?.customUrl ?? null,
        avatarUrl: ch.snippet?.thumbnails?.default?.url ?? null,
        token: { accessToken: data.access_token!, refreshToken: data.refresh_token, expiresAt, scopes },
        expiresAt,
        scopes,
        meta: { channelId: ch.id },
      })),
    };
  },
  async refresh(env, account) {
    if (!account.token.refreshToken) throw new Error("No Google refresh token stored; reconnect the account");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number }>(TOKEN_URL, {
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      refresh_token: account.token.refreshToken,
      grant_type: "refresh_token",
    }, {}, "Google token refresh");
    if (!data.access_token) throw new Error("Google did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in);
    return { token: { ...account.token, accessToken: data.access_token, refreshToken: data.refresh_token ?? account.token.refreshToken, expiresAt }, expiresAt };
  },
  publish: (env, account, req) => guard(() => youtubePublish(env, account, req)),
  async metrics(_env, account, externalId): Promise<MetricsSnapshot | null> {
    const data = await getJson<{ items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string } }> }>(
      `${API}/videos?part=statistics&id=${encodeURIComponent(externalId)}`,
      { Authorization: `Bearer ${account.token.accessToken}` },
      "YouTube metrics",
    );
    const s = data.items?.[0]?.statistics;
    if (!s) return null;
    return { views: count(s.viewCount), likes: count(s.likeCount), comments: count(s.commentCount), shares: 0, raw: { statistics: s } };
  },
  async inbox(_env, account, published): Promise<InboxCandidate[]> {
    const out: InboxCandidate[] = [];
    for (const post of published) {
      const data = await getJson<{
        items?: Array<{ id: string; snippet?: { topLevelComment?: { id?: string; snippet?: { textDisplay?: string; textOriginal?: string; authorDisplayName?: string; authorChannelId?: { value?: string }; publishedAt?: string } } } }>;
      }>(
        `${API}/commentThreads?part=snippet&videoId=${encodeURIComponent(post.externalId)}&maxResults=20&order=time`,
        { Authorization: `Bearer ${account.token.accessToken}` },
        "YouTube comments",
      );
      for (const thread of data.items ?? []) {
        const c = thread.snippet?.topLevelComment?.snippet;
        if (!c || c.authorChannelId?.value === account.externalId) continue;
        out.push({
          externalId: thread.id,
          parentExternalId: post.externalId,
          kind: "comment",
          author: c.authorDisplayName ?? "YouTube user",
          body: c.textOriginal ?? c.textDisplay ?? "",
          permalink: `https://www.youtube.com/watch?v=${post.externalId}&lc=${thread.id}`,
          receivedAt: c.publishedAt ?? null,
          destinationExternalId: post.externalId,
        });
      }
    }
    return out;
  },
  reply: (_env, account, target, text) =>
    guard(async () => {
      const res = await postJson<{ id?: string }>(`${API}/comments?part=snippet`, {
        snippet: { parentId: target.externalId, textOriginal: clip(text, 10000) },
      }, { Authorization: `Bearer ${account.token.accessToken}` }, "YouTube reply");
      return { ok: true, externalId: res.id };
    }),
};
