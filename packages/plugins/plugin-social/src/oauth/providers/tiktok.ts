/**
 * TikTok Content Posting API: direct post with PULL_FROM_URL from the R2
 * public domain (verify that domain in the TikTok developer portal).
 * Unaudited apps can only post SELF_ONLY.
 */
import { clip } from "../../domain.js";
import { expiresAtFrom, getJson, pollUntil, postForm, postJson, ProviderHttpError, PublishRejected, str } from "../http.js";
import {
  scopesFor,
  type ExchangeResult,
  type MetricsSnapshot,
  type ProviderAccount,
  type ProviderEnv,
  type PublishOutcome,
  type PublishRequest,
  type SocialProvider,
} from "../types.js";
import { count, guard, images, requireCode, videos } from "./common.js";

const API = "https://open.tiktokapis.com/v2";
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.list"];

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

function unwrap<T>(res: TikTokEnvelope<T>, label: string): T {
  if (res.error && res.error.code && res.error.code !== "ok") {
    const retryable = ["rate_limit_exceeded", "internal_error"].includes(res.error.code);
    const status = res.error.code === "access_token_invalid" ? 401 : retryable ? 503 : 400;
    throw new ProviderHttpError(status, JSON.stringify({ error: { message: `${res.error.code}: ${res.error.message ?? ""}`.trim() } }), label);
  }
  return (res.data ?? {}) as T;
}

interface PublishStatus {
  status?: string;
  fail_reason?: string;
  publicaly_available_post_id?: Array<string | number>;
}

const TIKTOK_JSON = { "Content-Type": "application/json; charset=UTF-8" };

/** Map a friendly privacy value onto the options this creator allows. */
export function chooseTikTokPrivacy(requested: string | undefined, options: string[]): string {
  const aliases: Record<string, string> = {
    public: "PUBLIC_TO_EVERYONE",
    everyone: "PUBLIC_TO_EVERYONE",
    friends: "MUTUAL_FOLLOW_FRIENDS",
    followers: "FOLLOWER_OF_CREATOR",
    private: "SELF_ONLY",
    self: "SELF_ONLY",
  };
  const wanted = requested ? aliases[requested.toLowerCase()] ?? requested.toUpperCase() : "SELF_ONLY";
  if (options.length === 0) return wanted;
  if (options.includes(wanted)) return wanted;
  if (requested) throw new PublishRejected(`TikTok does not allow privacy ${wanted} for this account. Allowed: ${options.join(", ")}`);
  return options.includes("SELF_ONLY") ? "SELF_ONLY" : options[0]!;
}

async function tiktokPublish(env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const auth = { Authorization: `Bearer ${account.token.accessToken}`, ...TIKTOK_JSON };
  const vids = videos(req.media);
  if (vids.length !== 1 || images(req.media).length) throw new PublishRejected("TikTok needs exactly one video");
  const creator = unwrap(await postJson<TikTokEnvelope<{
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
    creator_username?: string;
  }>>(`${API}/post/publish/creator_info/query/`, {}, auth, "TikTok creator info"), "TikTok creator info");
  const video = vids[0]!;
  if (creator.max_video_post_duration_sec && video.durationS && video.durationS > creator.max_video_post_duration_sec) {
    throw new PublishRejected(`This TikTok account allows videos up to ${creator.max_video_post_duration_sec}s`);
  }
  const privacy = chooseTikTokPrivacy(req.privacy, creator.privacy_level_options ?? []);
  const init = unwrap(await postJson<TikTokEnvelope<{ publish_id?: string }>>(`${API}/post/publish/video/init/`, {
    post_info: {
      title: clip(req.title ? `${req.title}\n\n${req.text}` : req.text, 2200),
      privacy_level: privacy,
      disable_comment: creator.comment_disabled ?? false,
      disable_duet: creator.duet_disabled ?? false,
      disable_stitch: creator.stitch_disabled ?? false,
    },
    source_info: { source: "PULL_FROM_URL", video_url: video.url },
  }, auth, "TikTok publish init"), "TikTok publish init");
  const publishId = init.publish_id;
  if (!publishId) throw new Error("TikTok did not return a publish id");
  // From here on, never report a retryable failure: a retry would post twice.
  let status: PublishStatus = {};
  try {
    status = await pollUntil<PublishStatus>(async () => {
      const s = unwrap(await postJson<TikTokEnvelope<PublishStatus>>(`${API}/post/publish/status/fetch/`, { publish_id: publishId }, auth, "TikTok publish status"), "TikTok publish status");
      if (s.status === "PUBLISH_COMPLETE" || s.status === "FAILED" || s.status === "SEND_TO_USER_INBOX") return { done: true, value: s };
      return { done: false };
    }, { intervalMs: 5_000, timeoutMs: 120_000, label: "TikTok processing" });
  } catch {
    return {
      ok: true,
      externalId: publishId,
      url: account.handle ? `https://www.tiktok.com/@${account.handle}` : undefined,
      detail: { publishId, state: "processing", privacy },
    };
  }
  if (status.status === "FAILED") return { ok: false, retryable: false, error: `TikTok rejected the video: ${status.fail_reason ?? "unknown reason"}` };
  const postId = status.publicaly_available_post_id?.[0];
  const handle = account.handle ?? str(creator.creator_username);
  return {
    ok: true,
    externalId: postId ? String(postId) : publishId,
    url: postId && handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : handle ? `https://www.tiktok.com/@${handle}` : undefined,
    detail: { publishId, state: status.status, privacy },
  };
}

export const tiktokProvider: SocialProvider = {
  platform: "tiktok",
  refreshKind: "refresh_token",
  defaultScopes: () => TIKTOK_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_key: env.app.clientId,
      scope: scopesFor(tiktokProvider, env).join(","),
      response_type: "code",
      redirect_uri: env.redirectUri,
      state,
    });
    return { url: `https://www.tiktok.com/v2/auth/authorize/?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "TikTok");
    const data = await postForm<{
      access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; open_id?: string; scope?: string;
      error?: string; error_description?: string;
    }>(`${API}/oauth/token/`, {
      client_key: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: env.redirectUri,
    }, {}, "TikTok code exchange");
    if (!data.access_token) throw new Error(data.error_description ?? data.error ?? "TikTok did not return an access token");
    const info = unwrap(await getJson<TikTokEnvelope<{ user?: { open_id?: string; display_name?: string; avatar_url?: string; username?: string } }>>(
      `${API}/user/info/?fields=open_id,display_name,avatar_url,username`,
      { Authorization: `Bearer ${data.access_token}` },
      "TikTok profile",
    ), "TikTok profile");
    const openId = info.user?.open_id ?? data.open_id;
    if (!openId) throw new Error("TikTok did not return the account id");
    const scopes = data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : scopesFor(tiktokProvider, env);
    const expiresAt = expiresAtFrom(data.expires_in);
    return {
      candidates: [{
        key: `tiktok:${openId}`,
        platform: "tiktok",
        kind: "profile",
        externalId: openId,
        displayName: info.user?.display_name ?? info.user?.username ?? "TikTok",
        handle: info.user?.username ?? null,
        avatarUrl: info.user?.avatar_url ?? null,
        token: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, refreshExpiresAt: expiresAtFrom(data.refresh_expires_in), scopes },
        expiresAt,
        scopes,
        meta: {},
      }],
    };
  },
  async refresh(env, account) {
    if (!account.token.refreshToken) throw new Error("No TikTok refresh token stored; reconnect the account");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; error_description?: string }>(`${API}/oauth/token/`, {
      client_key: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      grant_type: "refresh_token",
      refresh_token: account.token.refreshToken,
    }, {}, "TikTok token refresh");
    if (!data.access_token) throw new Error(data.error_description ?? "TikTok did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in);
    return {
      token: {
        ...account.token,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? account.token.refreshToken,
        expiresAt,
        refreshExpiresAt: expiresAtFrom(data.refresh_expires_in) ?? account.token.refreshExpiresAt ?? null,
      },
      expiresAt,
    };
  },
  publish: (env, account, req) => guard(() => tiktokPublish(env, account, req)),
  async metrics(_env, account, externalId): Promise<MetricsSnapshot | null> {
    const auth = { Authorization: `Bearer ${account.token.accessToken}`, ...TIKTOK_JSON };
    let videoId = externalId;
    let url: string | undefined;
    if (!/^\d+$/.test(videoId)) {
      // Still a publish id: ask TikTok whether the public post id is known yet.
      const s = unwrap(await postJson<TikTokEnvelope<{ publicaly_available_post_id?: Array<string | number> }>>(`${API}/post/publish/status/fetch/`, { publish_id: externalId }, auth, "TikTok publish status"), "TikTok publish status");
      const id = s.publicaly_available_post_id?.[0];
      if (!id) return null;
      videoId = String(id);
      url = account.handle ? `https://www.tiktok.com/@${account.handle}/video/${videoId}` : undefined;
    }
    const data = unwrap(await postJson<TikTokEnvelope<{ videos?: Array<{ id?: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number; share_url?: string }> }>>(
      `${API}/video/query/?fields=id,view_count,like_count,comment_count,share_count,share_url`,
      { filters: { video_ids: [videoId] } },
      auth,
      "TikTok metrics",
    ), "TikTok metrics");
    const v = data.videos?.[0];
    if (!v) return null;
    return {
      views: count(v.view_count),
      likes: count(v.like_count),
      comments: count(v.comment_count),
      shares: count(v.share_count),
      externalId: videoId !== externalId ? videoId : undefined,
      url: v.share_url ?? url,
      raw: { video: v },
    };
  },
};
