/** TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon, Dribbble. */
import type { AccountTokenBundle, ProviderContext, PublishInput, PublishResult } from "../types.js";
import { basicAuth, bearer, formPost, jfetch, jsonOrThrow, percentEncode } from "../http.js";
import type { SocialProviderImpl } from "./base.js";

// ── TikTok ──────────────────────────────────────────────────────────────────
export const tiktokProvider: SocialProviderImpl = {
  platform: "tiktok",
  oauth2: true,
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      client_key: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      response_type: "code",
      scope: "user.info.basic,video.publish",
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const data = await formPost("https://open.tiktokapis.com/v2/oauth/token/", {
      client_key: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
    }, { Authorization: basicAuth(ctx.cfg.clientId, ctx.cfg.clientSecret ?? "") });
    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      scopes: String(data.scope ?? "").split(",").filter(Boolean),
      externalId: String(data.open_id ?? ""),
      name: String(data.name ?? "TikTok"),
      handle: String(data.display_name ?? data.open_id ?? ""),
      avatarUrl: data.avatar_url ? String(data.avatar_url) : undefined,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async refresh(ctx: ProviderContext, bundle: AccountTokenBundle): Promise<AccountTokenBundle> {
    if (!bundle.refreshToken) throw new Error("No TikTok refresh token");
    const data = await formPost("https://open.tiktokapis.com/v2/oauth/token/", {
      client_key: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
    }, { Authorization: basicAuth(ctx.cfg.clientId, ctx.cfg.clientSecret ?? "") });
    return {
      ...bundle,
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : bundle.refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    if (!input.mediaUrls?.length) return { ok: false, error: "TikTok posts require a video" };
    const videoUrl = input.mediaUrls[0]!;
    // Pre-check the URL is fetchable by TikTok
    const check = await jfetch(videoUrl, { method: "HEAD" }).catch(() => null);
    if (!check?.ok) return { ok: false, error: `TikTok could not reach the video URL (${videoUrl})` };
    const init = await jfetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        post_info: {
          title: input.title ?? input.text.slice(0, 200),
          description: input.text.slice(0, 2000),
          privacy_level: "SELF_ONLY",
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
      }),
    });
    if (!init.ok) return { ok: false, error: (await init.text()).slice(0, 300) };
    const idata = (await jsonOrThrow(init)) as { data?: { publish_id?: string; upload_url?: string } };
    const publishId = idata.data?.publish_id;
    if (!publishId) return { ok: false, error: "TikTok did not return a publish id" };
    if (idata.data?.upload_url) {
      const up = await jfetch(idata.data.upload_url, { method: "PUT" }).catch(() => null);
      if (!up) return { ok: false, error: "TikTok upload_url PUT failed" };
    }
    await new Promise((r) => setTimeout(r, 3000));
    const status = await jfetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ publish_id: publishId }),
    });
    if (!status.ok) return { ok: false, error: (await status.text()).slice(0, 300) };
    const sdata = (await jsonOrThrow(status)) as { data?: { status?: string; fail_reason?: string } };
    if (sdata.data?.status === "FAILED") return { ok: false, error: sdata.data.fail_reason ?? "TikTok publish failed" };
    return { ok: true, externalId: publishId, url: `https://www.tiktok.com/@${t.handle}` };
  },
};

// ── YouTube ─────────────────────────────────────────────────────────────────
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

export const youtubeProvider: SocialProviderImpl = {
  platform: "youtube",
  oauth2: true,
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${GOOGLE_AUTH}?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const data = await formPost(GOOGLE_TOKEN, {
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
    });
    const accessToken = String(data.access_token);
    const me = await jfetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: bearer(accessToken) });
    const mdata = (await jsonOrThrow(me)) as { items?: Array<{ id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> } }> };
    const channel = mdata.items?.[0];
    return {
      accessToken,
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      scopes: ["youtube.upload", "youtube.readonly"],
      externalId: channel?.id ?? "",
      name: channel?.snippet?.title ?? "YouTube",
      avatarUrl: channel?.snippet?.thumbnails?.default?.url,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async refresh(ctx: ProviderContext, bundle: AccountTokenBundle): Promise<AccountTokenBundle> {
    if (!bundle.refreshToken) throw new Error("No YouTube refresh token");
    const data = await formPost(GOOGLE_TOKEN, {
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      refresh_token: bundle.refreshToken,
      grant_type: "refresh_token",
    });
    return {
      ...bundle,
      accessToken: String(data.access_token),
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const videoUrl = input.mediaUrls?.[0];
    if (!videoUrl) return { ok: false, error: "YouTube requires a video URL" };
    const vid = await jfetch(videoUrl);
    if (!vid.ok) return { ok: false, error: `Could not download video for YouTube: ${vid.status}` };
    const bytes = Buffer.from(await vid.arrayBuffer());
    const mime = vid.headers.get("content-type") ?? "video/mp4";
    const title = input.title ?? input.text.slice(0, 100);
    const meta = JSON.stringify({
      snippet: { title, description: input.text.slice(0, 5000) },
      status: { privacyStatus: input.visibility ?? "private", selfDeclaredMadeForKids: false },
    });
    const init = await jfetch(
      `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
      {
        method: "POST",
        headers: {
          ...bearer(t.accessToken),
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mime,
          "X-Upload-Content-Length": String(bytes.length),
        },
        body: meta,
      },
    );
    if (!init.ok) return { ok: false, error: (await init.text()).slice(0, 300) };
    const uploadUrl = init.headers.get("location");
    if (!uploadUrl) return { ok: false, error: "YouTube did not return an upload URL" };
    const up = await jfetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: new Uint8Array(bytes) });
    if (!up.ok && up.status !== 201) return { ok: false, error: (await up.text()).slice(0, 300) };
    const udata = (await jsonOrThrow(up).catch(() => null)) as { id?: string } | null;
    return { ok: true, externalId: udata?.id, url: udata?.id ? `https://www.youtube.com/watch?v=${udata.id}` : undefined };
  },
};

// ── Pinterest ───────────────────────────────────────────────────────────────
export const pinterestProvider: SocialProviderImpl = {
  platform: "pinterest",
  oauth2: true,
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      response_type: "code",
      scope: "boards:read,pins:read,pins:write,user_accounts:read",
      state,
    });
    return `https://www.pinterest.com/oauth/?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const data = await formPost("https://api.pinterest.com/v5/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
    }, { Authorization: basicAuth(ctx.cfg.clientId, ctx.cfg.clientSecret ?? "") });
    const accessToken = String(data.access_token);
    const me = await jfetch("https://api.pinterest.com/v5/user_account", { headers: bearer(accessToken) });
    const mdata = (await jsonOrThrow(me)) as { id?: string; username?: string; full_name?: string; profile_image?: string; };
    return {
      accessToken,
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      scopes: String(data.scope ?? "").split(",").filter(Boolean),
      externalId: String(mdata.id ?? ""),
      name: mdata.full_name ?? mdata.username ?? "Pinterest",
      handle: mdata.username,
      avatarUrl: mdata.profile_image,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async refresh(ctx: ProviderContext, bundle: AccountTokenBundle): Promise<AccountTokenBundle> {
    if (!bundle.refreshToken) throw new Error("No Pinterest refresh token");
    const data = await formPost("https://api.pinterest.com/v5/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
    }, { Authorization: basicAuth(ctx.cfg.clientId, ctx.cfg.clientSecret ?? "") });
    return {
      ...bundle,
      accessToken: String(data.access_token),
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    if (!input.mediaUrls?.length) return { ok: false, error: "Pinterest requires an image" };
    const boardId = String((t.extra as Record<string, unknown> | undefined)?.boardId ?? "");
    const body: Record<string, unknown> = {
      board_id: boardId,
      title: input.title ?? input.text.slice(0, 100),
      description: input.text.slice(0, 500),
      media_source: { source_type: "image_url", url: input.mediaUrls[0] },
    };
    if (input.link) body.link = input.link;
    const res = await jfetch("https://api.pinterest.com/v5/pins", {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    const data = (await jsonOrThrow(res)) as { id?: string };
    return { ok: true, externalId: data.id, url: `https://www.pinterest.com/pin/${data.id}` };
  },
};

// ── Reddit ──────────────────────────────────────────────────────────────────
export const redditProvider: SocialProviderImpl = {
  platform: "reddit",
  oauth2: true,
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      client_id: ctx.cfg.clientId,
      response_type: "code",
      state,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      duration: "permanent",
      scope: "submit,identity",
    });
    return `https://www.reddit.com/api/v1/authorize?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const data = await formPost("https://www.reddit.com/api/v1/access_token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
    }, { Authorization: basicAuth(ctx.cfg.clientId, ctx.cfg.clientSecret ?? "") });
    const accessToken = String(data.access_token);
    const me = await jfetch("https://oauth.reddit.com/api/v1/me", { headers: bearer(accessToken) });
    const mdata = (await jsonOrThrow(me)) as { name?: string; id?: string };
    return {
      accessToken,
      refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
      scopes: ["submit", "identity"],
      externalId: String(mdata.name ?? mdata.id ?? ""),
      name: mdata.name ?? "Reddit",
      handle: mdata.name,
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async refresh(ctx: ProviderContext, bundle: AccountTokenBundle): Promise<AccountTokenBundle> {
    if (!bundle.refreshToken) throw new Error("No Reddit refresh token");
    const data = await formPost("https://www.reddit.com/api/v1/access_token", {
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
    }, { Authorization: basicAuth(ctx.cfg.clientId, ctx.cfg.clientSecret ?? "") });
    return {
      ...bundle,
      accessToken: String(data.access_token),
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : undefined,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const subreddit = String((t.extra as Record<string, unknown> | undefined)?.subreddit ?? "");
    if (!subreddit) return { ok: false, error: "No subreddit configured for this Reddit account (set it when connecting)" };
    const kind = input.link ? "link" : "self";
    const params = new URLSearchParams({
      sr: subreddit,
      title: input.title ?? input.text.slice(0, 300),
      kind,
      api_type: "json",
      resubmit: "true",
    });
    if (kind === "self") params.set("text", input.text.slice(0, 40000));
    else params.set("url", input.link!);
    const res = await jfetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: text.slice(0, 300) };
    try {
      const j = JSON.parse(text) as { json?: { errors?: string[][] } };
      if (j.json?.errors?.length) return { ok: false, error: JSON.stringify(j.json.errors[0]) };
    } catch {
      // ignore
    }
    return { ok: true, url: `https://www.reddit.com/r/${subreddit}/` };
  },
};

// ── Bluesky (AT Protocol, app-password connect) ─────────────────────────────
const BSKY = "https://bsky.social";

export const blueskyProvider: SocialProviderImpl = {
  platform: "bluesky",
  oauth2: false,
  requiresClientSecret: false,
  getAuthorizeUrl(): string {
    throw new Error("Bluesky connects with handle + app password");
  },
  exchangeCode(): Promise<AccountTokenBundle> {
    throw new Error("Bluesky connects with handle + app password");
  },
  async connectWithCredentials(cfg: never, creds: Record<string, string>): Promise<AccountTokenBundle> {
    const identifier = creds.identifier ?? "";
    const password = creds.password ?? "";
    if (!identifier || !password) throw new Error("Bluesky handle and app password required");
    const res = await jfetch(`${BSKY}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    if (!res.ok) return Promise.reject(new Error(`Bluesky login failed: ${(await res.text()).slice(0, 200)}`));
    const data = (await jsonOrThrow(res)) as { accessJwt?: string; did?: string; handle?: string; displayName?: string; avatar?: string };
    if (!data.accessJwt || !data.did) throw new Error("Bluesky session failed");
    return {
      accessToken: data.accessJwt,
      scopes: ["atproto"],
      externalId: data.did,
      name: data.displayName ?? data.handle ?? "Bluesky",
      handle: data.handle,
      avatarUrl: data.avatar,
      extra: { identifier, appPassword: password },
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    // Re-login each publish (access JWT is short-lived) using stored app password
    const extra = (t.extra ?? {}) as Record<string, string>;
    if (extra.identifier && extra.appPassword) {
      const refreshed = await this.connectWithCredentials?.(undefined as never, { identifier: extra.identifier, password: extra.appPassword });
      if (refreshed) t.accessToken = refreshed.accessToken;
    }
    const record: Record<string, unknown> = {
      text: input.text.slice(0, 300),
      createdAt: new Date().toISOString(),
      langs: ["en"],
      $type: "app.bsky.feed.post",
    };
    const res = await jfetch(`${BSKY}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ repo: t.externalId, collection: "app.bsky.feed.post", record }),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    const data = (await jsonOrThrow(res)) as { uri?: string; cid?: string };
    return { ok: true, externalId: data.cid, url: data.uri };
  },
};

// ── Mastodon (OAuth2, per-instance app registration) ────────────────────────
export const mastodonProvider: SocialProviderImpl = {
  platform: "mastodon",
  getAuthorizeUrl(): string {
    throw new Error("Mastodon registers an app per instance via start()");
  },
  oauth2: true,
  requiresClientSecret: false,
  async start(ctx: ProviderContext, state: string, extra?: Record<string, string>): Promise<{ authorizeUrl: string; sessionExtra?: Record<string, unknown> }> {
    const instance = String(extra?.instance ?? ctx.cfg.extra?.instance ?? "https://mastodon.social").replace(/\/$/, "");
    const redirectUri = `${ctx.publicBaseUrl}${ctx.redirectPath}`;
    const appRes = await jfetch(`${instance}/api/v1/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Partners in Biz Social",
        redirect_uris: redirectUri,
        scopes: "read write:statuses write:media",
        website: ctx.publicBaseUrl,
      }),
    });
    if (!appRes.ok) throw new Error(`Mastodon app registration failed on ${instance}: ${(await appRes.text()).slice(0, 200)}`);
    const app = (await jsonOrThrow(appRes)) as { client_id?: string; client_secret?: string };
    if (!app.client_id || !app.client_secret) throw new Error("Mastodon app registration missing client credentials");
    const qs = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "read write:statuses write:media",
      state,
    });
    return { authorizeUrl: `${instance}/oauth/authorize?${qs.toString()}`, sessionExtra: { clientId: app.client_id, clientSecret: app.client_secret, instance } };
  },
  async exchangeCode(ctx: ProviderContext, code: string, extra?: Record<string, string>): Promise<AccountTokenBundle> {
    const instance = String(extra?.instance ?? "").replace(/\/$/, "");
    const clientId = extra?.clientId ?? "";
    const clientSecret = extra?.clientSecret ?? "";
    if (!instance || !clientId || !clientSecret) throw new Error("Mastodon session missing app credentials");
    const data = await formPost(`${instance}/oauth/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      grant_type: "authorization_code",
      code,
      scope: "read write:statuses write:media",
    });
    const accessToken = String(data.access_token);
    const me = await jfetch(`${instance}/api/v1/accounts/verify_credentials`, { headers: bearer(accessToken) });
    const mdata = (await jsonOrThrow(me)) as { id?: string; username?: string; display_name?: string; avatar?: string };
    return {
      accessToken,
      scopes: ["read", "write:statuses", "write:media"],
      externalId: String(mdata.id ?? ""),
      name: mdata.display_name ?? mdata.username ?? "Mastodon",
      handle: mdata.username ?? "",
      avatarUrl: mdata.avatar,
      instanceUrl: instance,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const instance = (t.instanceUrl ?? "https://mastodon.social").replace(/\/$/, "");
    let mediaIds: string[] = [];
    for (const url of input.mediaUrls ?? []) {
      const dl = await jfetch(url);
      if (!dl.ok) continue;
      const buf = Buffer.from(await dl.arrayBuffer());
      const mime = dl.headers.get("content-type") ?? "image/jpeg";
      const form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), "media." + (mime.split("/")[1] ?? "jpg"));
      const up = await jfetch(`${instance}/api/v2/media`, { method: "POST", headers: bearer(t.accessToken), body: form });
      if (up.ok) {
        const udata = (await jsonOrThrow(up)) as { id?: string };
        if (udata.id) mediaIds.push(udata.id);
      }
    }
    const body: Record<string, unknown> = {
      status: input.text.slice(0, 500),
      visibility: input.visibility ?? "public",
      language: "en",
    };
    if (mediaIds.length) body.media_ids = mediaIds;
    const res = await jfetch(`${instance}/api/v1/statuses`, {
      method: "POST",
      headers: { ...bearer(t.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    const data = (await jsonOrThrow(res)) as { id?: string; url?: string };
    return { ok: true, externalId: data.id, url: data.url };
  },
};

// ── Dribbble ────────────────────────────────────────────────────────────────
export const dribbbleProvider: SocialProviderImpl = {
  platform: "dribbble",
  oauth2: true,
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      state,
      scope: "public write",
    });
    return `https://dribbble.com/oauth/authorize?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const data = await formPost("https://dribbble.com/oauth/token", {
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
    });
    const accessToken = String(data.access_token);
    const me = await jfetch(`https://api.dribbble.com/v2/user?access_token=${percentEncode(accessToken)}`);
    const mdata = (await jsonOrThrow(me)) as { id?: number; name?: string; username?: string; avatar_url?: string };
    return {
      accessToken,
      scopes: ["public", "write"],
      externalId: String(mdata.id ?? ""),
      name: mdata.name ?? mdata.username ?? "Dribbble",
      handle: mdata.username,
      avatarUrl: mdata.avatar_url,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const imageUrl = input.mediaUrls?.[0];
    if (!imageUrl) return { ok: false, error: "Dribbble requires an image" };
    const dl = await jfetch(imageUrl);
    if (!dl.ok) return { ok: false, error: `Could not download image for Dribbble: ${dl.status}` };
    const buf = Buffer.from(await dl.arrayBuffer());
    const mime = dl.headers.get("content-type") ?? "image/png";
    const form = new FormData();
    form.append("title", input.title ?? input.text.slice(0, 80));
    form.append("description", input.text.slice(0, 400));
    form.append("image", new Blob([buf], { type: mime }), "shot." + (mime.split("/")[1] ?? "png"));
    const res = await jfetch(`https://api.dribbble.com/v2/shots?access_token=${percentEncode(t.accessToken)}`, { method: "POST", body: form });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    const data = (await jsonOrThrow(res)) as { id?: number; html_url?: string };
    return { ok: true, externalId: String(data.id ?? ""), url: data.html_url };
  },
};
