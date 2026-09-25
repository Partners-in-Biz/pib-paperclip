/** LinkedIn (OAuth2) + X/Twitter (OAuth 1.0a). */
import type { AccountTokenBundle, ProviderContext, PublishInput, PublishResult } from "../types.js";
import { basicAuth, bearer, formPost, jfetch, jsonOrThrow, oauth1Header, percentEncode, type OAuth1Token } from "../http.js";
import type { SocialProviderImpl } from "./base.js";

// ── LinkedIn ────────────────────────────────────────────────────────────────
export const linkedinProvider: SocialProviderImpl = {
  platform: "linkedin",
  oauth2: true,
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      state,
      scope: "openid,profile,w_member_social",
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const data = await formPost("https://www.linkedin.com/oauth/v2/accessToken", {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
    });
    const accessToken = String(data.access_token);
    const expiresIn = data.expires_in ? Number(data.expires_in) : undefined;
    const me = await jfetch("https://api.linkedin.com/v2/userinfo", { headers: bearer(accessToken) });
    const profile = (await jsonOrThrow(me)) as { sub?: string; name?: string; email?: string };
    if (!profile.sub) throw new Error("LinkedIn profile could not be resolved (openid scope required)");
    return {
      accessToken,
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      scopes: String(data.scope ?? "openid,profile,w_member_social").split(" ").filter(Boolean),
      externalId: profile.sub,
      name: profile.name ?? "LinkedIn",
      handle: profile.email,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      extra: { personUrn: `urn:li:person:${profile.sub}` },
    };
  },
  async refresh(ctx: ProviderContext, bundle: AccountTokenBundle): Promise<AccountTokenBundle> {
    if (!bundle.refreshToken) throw new Error("No refresh token available");
    const data = await formPost("https://www.linkedin.com/oauth/v2/accessToken", {
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
    });
    return {
      ...bundle,
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : bundle.refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const personUrn = String((t.extra as Record<string, unknown> | undefined)?.personUrn ?? `urn:li:person:${t.externalId}`);
    const share: Record<string, unknown> = { text: input.text };
    let category = "NONE";
    const media: Record<string, unknown>[] = [];
    if (input.mediaUrls?.length) {
      category = "IMAGE";
      for (const url of input.mediaUrls) {
        media.push({ status: "READY", description: input.text.slice(0, 300), media: url });
      }
    }
    const body = {
      author: personUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: share,
          shareMediaCategory: category,
          ...(category === "IMAGE" ? { media } : {}),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    };
    const res = await jfetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    const data = (await jsonOrThrow(res)) as { id?: string };
    return { ok: true, externalId: data.id, url: `https://www.linkedin.com/feed/update/${data.id}` };
  },
};

// ── X / Twitter (OAuth 1.0a) ───────────────────────────────────────────────
const TW_REQUEST = "https://api.twitter.com/oauth/request_token";
const TW_ACCESS = "https://api.twitter.com/oauth/access_token";
const TW_AUTH = "https://api.twitter.com/oauth/authorize";
const TW_API = "https://api.twitter.com";

export const xProvider: SocialProviderImpl = {
  platform: "x",
  oauth2: false,
  requiresClientSecret: true,
  async start(ctx: ProviderContext, state: string): Promise<{ authorizeUrl: string; sessionExtra?: Record<string, unknown> }> {
    const callback = `${ctx.publicBaseUrl}${ctx.redirectPath}?pstate=${state}`;
    const empty: OAuth1Token = { token: "", tokenSecret: "" };
    const auth = oauth1Header("POST", TW_REQUEST, { oauth_callback: callback }, ctx.cfg.clientId, ctx.cfg.clientSecret ?? "", empty);
    const res = await jfetch(TW_REQUEST, { method: "POST", headers: { Authorization: auth } });
    const text = await res.text();
    if (!res.ok) throw new Error(`X request token failed: ${text.slice(0, 300)}`);
    const params = new URLSearchParams(text);
    const oauthToken = params.get("oauth_token");
    const oauthTokenSecret = params.get("oauth_token_secret");
    if (!oauthToken || !oauthTokenSecret) throw new Error(`X request token missing fields: ${text.slice(0, 300)}`);
    return {
      authorizeUrl: `${TW_AUTH}?oauth_token=${encodeURIComponent(oauthToken)}`,
      sessionExtra: { requestTokenSecret: oauthTokenSecret, requestToken: oauthToken },
    };
  },
  async exchangeCode(ctx: ProviderContext, code: string, extra?: Record<string, string>): Promise<AccountTokenBundle> {
    // code = "<oauth_token>:<oauth_verifier>"; extra carries requestTokenSecret
    const idx = code.indexOf(":");
    const oauthToken = code.slice(0, idx);
    const verifier = code.slice(idx + 1);
    if (!oauthToken || !verifier) throw new Error("Missing X oauth_token or oauth_verifier");
    const reqTokenSecret = extra?.requestTokenSecret ?? "";
    const reqToken: OAuth1Token = { token: oauthToken, tokenSecret: reqTokenSecret };
    const auth = oauth1Header("POST", TW_ACCESS, { oauth_verifier: verifier }, ctx.cfg.clientId, ctx.cfg.clientSecret ?? "", reqToken);
    const res = await jfetch(TW_ACCESS, { method: "POST", headers: { Authorization: auth } });
    const text = await res.text();
    if (!res.ok) throw new Error(`X access token failed: ${text.slice(0, 300)}`);
    const params = new URLSearchParams(text);
    const oauthTokenF = params.get("oauth_token") ?? "";
    const oauthTokenSecretF = params.get("oauth_token_secret") ?? "";
    const userId = params.get("user_id") ?? "";
    const screenName = params.get("screen_name") ?? "";
    const token: OAuth1Token = { token: oauthTokenF, tokenSecret: oauthTokenSecretF };
    let name = screenName;
    let avatarUrl: string | undefined;
    try {
      const auth2 = oauth1Header("GET", `${TW_API}/2/users/me`, { "user.fields": "profile_image_url,name" }, ctx.cfg.clientId, ctx.cfg.clientSecret ?? "", token);
      const me = await jfetch(`${TW_API}/2/users/me?user.fields=profile_image_url,name`, { headers: { Authorization: auth2 } });
      const mdata = (await jsonOrThrow(me)) as { data?: { name?: string; username?: string; profile_image_url?: string } };
      name = mdata.data?.name ?? mdata.data?.username ?? screenName;
      avatarUrl = mdata.data?.profile_image_url;
    } catch {
      // profile fetch optional
    }
    return {
      accessToken: oauthTokenF,
      accessTokenSecret: oauthTokenSecretF,
      scopes: ["tweet.read", "tweet.write", "users.read"],
      externalId: userId,
      name,
      handle: screenName,
      avatarUrl,
    };
  },
  getAuthorizeUrl(): string {
    throw new Error("X uses start() flow");
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const token: OAuth1Token = { token: t.accessToken, tokenSecret: t.accessTokenSecret ?? "" };
    let mediaIds: string[] = [];
    const mediaUrls = input.mediaUrls ?? [];
    for (const url of mediaUrls.slice(0, 4)) {
      const mediaRes = await jfetch(url);
      if (!mediaRes.ok) return { ok: false, error: `Could not download media for X: ${mediaRes.status}` };
      const buf = Buffer.from(await mediaRes.arrayBuffer());
      const contentType = mediaRes.headers.get("content-type") ?? "image/jpeg";
      const body = new FormData();
      body.append("media", new Blob([buf], { type: contentType }), "media." + (contentType.split("/")[1] ?? "jpg"));
      const auth = oauth1Header("POST", "https://upload.twitter.com/1.1/media/upload.json", {}, ctx.cfg.clientId, ctx.cfg.clientSecret ?? "", token);
      const up = await jfetch("https://upload.twitter.com/1.1/media/upload.json", { method: "POST", headers: { Authorization: auth }, body });
      if (!up.ok) return { ok: false, error: (await up.text()).slice(0, 300) };
      const udata = (await jsonOrThrow(up)) as { media_id_string?: string };
      if (udata.media_id_string) mediaIds.push(udata.media_id_string);
    }
    const tweetBody: Record<string, unknown> = { text: input.text };
    if (mediaIds.length) tweetBody.media = { media_ids: mediaIds };
    if (input.replyToId) tweetBody.reply = { in_reply_to_tweet_id: input.replyToId };
    const auth = oauth1Header("POST", `${TW_API}/2/tweets`, {}, ctx.cfg.clientId, ctx.cfg.clientSecret ?? "", token);
    const res = await jfetch(`${TW_API}/2/tweets`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(tweetBody),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    const data = (await jsonOrThrow(res)) as { data?: { id?: string; text?: string } };
    return { ok: true, externalId: data.data?.id, url: data.data?.id ? `https://x.com/${t.handle}/status/${data.data.id}` : undefined };
  },
};
