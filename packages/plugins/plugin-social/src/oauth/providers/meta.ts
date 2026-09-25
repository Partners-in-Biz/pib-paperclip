/** Meta providers: Facebook, Instagram, Threads (Graph API v21). */
import type { AccountTokenBundle, PlatformAppConfig, ProviderContext, PublishInput, PublishResult, SocialPlatform } from "../types.js";
import { bearer, formPost, jfetch, jsonOrThrow, percentEncode } from "../http.js";
import type { SocialProviderImpl } from "./base.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const AUTH = "https://www.facebook.com/v21.0/dialog/oauth";

async function metaToken(params: Record<string, string>): Promise<{ access_token: string; expires_in?: number }> {
  const qs = new URLSearchParams(params).toString();
  const res = await jfetch(`${GRAPH}/oauth/access_token?${qs}`);
  return (await jsonOrThrow(res)) as { access_token: string; expires_in?: number };
}

async function longLived(accessToken: string, cfg: PlatformAppConfig): Promise<string> {
  try {
    const t = await metaToken({
      grant_type: "fb_exchange_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret ?? "",
      fb_exchange_token: accessToken,
    });
    return t.access_token;
  } catch {
    return accessToken; // some apps already return long-lived
  }
}

interface MetaPage {
  id: string;
  name: string;
  link?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
}

async function resolvePages(accessToken: string): Promise<MetaPage[]> {
  const res = await jfetch(
    `${GRAPH}/me/accounts?fields=id,name,link,access_token&limit=100&access_token=${percentEncode(accessToken)}`,
  );
  const data = (await jsonOrThrow(res)) as { data?: MetaPage[] };
  const pages = data.data ?? [];
  const out: MetaPage[] = [];
  for (const page of pages.slice(0, 25)) {
    try {
      const igRes = await jfetch(
        `${GRAPH}/${page.id}?fields=instagram_business_account{id,username,profile_picture_url}&access_token=${percentEncode(page.access_token ?? accessToken)}`,
      );
      const ig = (await jsonOrThrow(igRes)) as { instagram_business_account?: MetaPage["instagram_business_account"] };
      out.push({ ...page, instagram_business_account: ig.instagram_business_account });
    } catch {
      out.push(page);
    }
  }
  return out;
}

export const facebookProvider: SocialProviderImpl = {
  oauth2: true,
  platform: "facebook",
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string, extra?: Record<string, string>): string {
    const scopes = (extra?.scopes ?? "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_metadata,instagram_basic,instagram_content_publish")
      .split(",");
    const qs = new URLSearchParams({
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      response_type: "code",
      state,
      scope: scopes.join(","),
    });
    return `${AUTH}?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const first = await metaToken({
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      code,
    });
    const accessToken = await longLived(first.access_token, ctx.cfg);
    const pages = await resolvePages(accessToken);
    const page = pages[0];
    if (!page) throw new Error("No Facebook Page found for this account. Create a Page or grant manage access to one.");
    const pageToken = page.access_token ?? accessToken;
    return {
      accessToken,
      scopes: ["pages_show_list", "pages_manage_posts", "instagram_basic", "instagram_content_publish"],
      externalId: page.id,
      name: page.name,
      handle: page.name,
      avatarUrl: page.instagram_business_account?.profile_picture_url,
      pageToken,
      pageId: page.id,
      igUserId: page.instagram_business_account?.id,
      expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(), // ~60d long-lived token
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const token = t.pageToken ?? t.accessToken;
    const body = new URLSearchParams({ message: input.text, access_token: token });
    if (input.link) body.set("link", input.link);
    const res = await jfetch(`${GRAPH}/${t.pageId ?? t.externalId}/feed`, { method: "POST", body: body.toString() });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text.slice(0, 300) };
    }
    const data = (await jsonOrThrow(res)) as { id?: string };
    return { ok: true, externalId: data.id, url: `https://www.facebook.com/${t.pageId ?? t.externalId}` };
  },
};

export const instagramProvider: SocialProviderImpl = {
  oauth2: true,
  platform: "instagram",
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      response_type: "code",
      state,
      scope: "instagram_basic,instagram_content_publish,pages_show_list",
    });
    return `${AUTH}?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const first = await metaToken({
      client_id: ctx.cfg.clientId,
      client_secret: ctx.cfg.clientSecret ?? "",
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      code,
    });
    const accessToken = await longLived(first.access_token, ctx.cfg);
    const pages = await resolvePages(accessToken);
    const page = pages.find((p) => p.instagram_business_account) ?? pages[0];
    if (!page?.instagram_business_account) {
      throw new Error("No connected Instagram business account was found. Link an Instagram business profile to a Facebook Page the token can manage.");
    }
    const ig = page.instagram_business_account;
    return {
      accessToken,
      scopes: ["instagram_basic", "instagram_content_publish"],
      externalId: ig.id,
      name: ig.username ?? page.name,
      handle: ig.username,
      avatarUrl: ig.profile_picture_url,
      pageToken: page.access_token ?? accessToken,
      pageId: page.id,
      igUserId: ig.id,
      expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    const token = t.pageToken ?? t.accessToken;
    const igId = t.igUserId ?? t.externalId;
    if (!input.mediaUrls?.length) {
      return { ok: false, error: "Instagram requires at least one image or video." };
    }
    let creationId: string | undefined;
    for (let i = 0; i < input.mediaUrls.length; i++) {
      const url = input.mediaUrls[i]!;
      const isVideo = /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url);
      const params = new URLSearchParams({ access_token: token });
      if (i === 0) {
        if (isVideo) {
          const isReel = !!input.extra?.reel;
          params.set("media_type", "VIDEO");
          params.set("video_url", url);
          if (input.text) params.set("caption", input.text.slice(0, 2200));
          if (isReel) params.set("share_to_feed", "true");
        } else {
          const isCarousel = input.mediaUrls.length > 1;
          params.set("image_url", url);
          if (input.text) params.set("caption", input.text.slice(0, 2200));
          if (isCarousel) params.set("is_carousel_item", "true");
        }
      } else {
        const isVideo = /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url);
        if (isVideo) params.set("media_type", "VIDEO"), params.set("video_url", url);
        else params.set("image_url", url);
        params.set("is_carousel_item", "true");
      }
      const res = await jfetch(`${GRAPH}/${igId}/media`, { method: "POST", body: params.toString() });
      if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
      const data = (await jsonOrThrow(res)) as { id: string };
      creationId = data.id;
    }
    if (!creationId) return { ok: false, error: "Failed to create media container" };
    if (input.mediaUrls.length > 1) {
      const carousel = new URLSearchParams({ access_token: token, media_type: "CAROUSEL", children: "" }).toString();
      // children must be a comma list; rebuild manually
      return { ok: false, error: "IG carousel composition not yet supported; will add in next batch" };
    }
    const pub = new URLSearchParams({ access_token: token, creation_id: creationId });
    const pres = await jfetch(`${GRAPH}/${igId}/media_publish`, { method: "POST", body: pub.toString() });
    if (!pres.ok) return { ok: false, error: (await pres.text()).slice(0, 300) };
    const pdata = (await jsonOrThrow(pres)) as { id: string };
    return { ok: true, externalId: pdata.id, url: `https://www.instagram.com/p/${pdata.id}/` };
  },
};

export const threadsProvider: SocialProviderImpl = {
  oauth2: true,
  platform: "threads",
  requiresClientSecret: true,
  getAuthorizeUrl(ctx: ProviderContext, state: string): string {
    const qs = new URLSearchParams({
      client_id: ctx.cfg.clientId,
      redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
      response_type: "code",
      state,
      scope: "threads_basic,threads_content_publish",
    });
    return `https://www.facebook.com/v21.0/dialog/oauth?${qs.toString()}`;
  },
  async exchangeCode(ctx: ProviderContext, code: string): Promise<AccountTokenBundle> {
    const res = await jfetch(
      `https://graph.threads.net/access_token?${new URLSearchParams({
        client_id: ctx.cfg.clientId,
        client_secret: ctx.cfg.clientSecret ?? "",
        grant_type: "authorization_code",
        redirect_uri: `${ctx.publicBaseUrl}${ctx.redirectPath}`,
        code,
      }).toString()}`,
      { method: "POST" },
    );
    const data = (await jsonOrThrow(res)) as { access_token: string; user_id: string; expires_in?: number };
    const meRes = await jfetch(`https://graph.threads.net/v1.0/${data.user_id}?fields=id,username,name&access_token=${percentEncode(data.access_token)}`);
    const me = (await jsonOrThrow(meRes)) as { id: string; username?: string; name?: string };
    return {
      accessToken: data.access_token,
      scopes: ["threads_basic", "threads_content_publish"],
      externalId: data.user_id,
      name: me.name ?? me.username ?? "Threads",
      handle: me.username,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    };
  },
  async publish(ctx: ProviderContext, t: AccountTokenBundle, input: PublishInput): Promise<PublishResult> {
    if (input.mediaUrls?.length) {
      const mediaType = /\.(mp4|mov|m4v|webm)/i.test(input.mediaUrls[0]!) ? "VIDEO" : "IMAGE";
      const cRes = await jfetch(
        `https://graph.threads.net/v1.0/${t.externalId}/threads?${new URLSearchParams({
          media_type: mediaType,
          [mediaType === "IMAGE" ? "image_url" : "video_url"]: input.mediaUrls[0]!,
          access_token: t.accessToken,
        }).toString()}`,
        { method: "POST" },
      );
      if (!cRes.ok) return { ok: false, error: (await cRes.text()).slice(0, 300) };
      const cdata = (await jsonOrThrow(cRes)) as { id: string };
      const pRes = await jfetch(
        `https://graph.threads.net/v1.0/${t.externalId}/threads/publish?${new URLSearchParams({
          creation_id: cdata.id,
          access_token: t.accessToken,
        }).toString()}`,
        { method: "POST" },
      );
      if (!pRes.ok) return { ok: false, error: (await pRes.text()).slice(0, 300) };
      const pdata = (await jsonOrThrow(pRes)) as { id: string };
      return { ok: true, externalId: pdata.id, url: `https://www.threads.net/@${t.handle}/post/${pdata.id}` };
    }
    const cRes = await jfetch(
      `https://graph.threads.net/v1.0/${t.externalId}/threads?${new URLSearchParams({
        media_type: "TEXT",
        text: input.text,
        access_token: t.accessToken,
      }).toString()}`,
      { method: "POST" },
    );
    if (!cRes.ok) return { ok: false, error: (await cRes.text()).slice(0, 300) };
    const cdata = (await jsonOrThrow(cRes)) as { id: string };
    const pRes = await jfetch(
      `https://graph.threads.net/v1.0/${t.externalId}/threads/publish?${new URLSearchParams({
        creation_id: cdata.id,
        access_token: t.accessToken,
      }).toString()}`,
      { method: "POST" },
    );
    if (!pRes.ok) return { ok: false, error: (await pRes.text()).slice(0, 300) };
    const pdata = (await jsonOrThrow(pRes)) as { id: string };
    return { ok: true, externalId: pdata.id, url: `https://www.threads.net/@${t.handle}/post/${pdata.id}` };
  },
};
