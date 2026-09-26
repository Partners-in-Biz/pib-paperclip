/**
 * Meta: Facebook Pages (Facebook Login) and Instagram professional accounts.
 *
 * Facebook connect returns every Page the person manages plus the Instagram
 * business accounts linked to those Pages; each pick becomes an account with
 * its own Page token. Instagram can also connect directly with Instagram
 * Login (graph.instagram.com). All POST bodies are form-encoded with an
 * explicit Content-Type.
 */
import { DEFAULT_GRAPH_VERSION } from "../../config.js";
import type { MediaRef } from "../../db.js";
import { clip } from "../../domain.js";
import {
  expiresAtFrom,
  FORM_HEADERS,
  formBody,
  getJson,
  pollUntil,
  postForm,
  ProviderHttpError,
  PublishRejected,
  readJson,
  request,
  str,
} from "../http.js";
import {
  scopesFor,
  type ConnectCandidate,
  type ExchangeResult,
  type InboxCandidate,
  type MetricsSnapshot,
  type ProviderAccount,
  type ProviderEnv,
  type PublishOutcome,
  type PublishRequest,
  type SocialProvider,
  type TokenBundle,
} from "../types.js";
import { bestEffort, count, guard, images, optionalCount, requireCode, videos, withLink } from "./common.js";

const DAY = 24 * 3600_000;

export function graphVersion(env: ProviderEnv): string {
  const v = env.app.apiVersion?.trim() || DEFAULT_GRAPH_VERSION;
  return v.startsWith("v") ? v : `v${v}`;
}

function graph(env: ProviderEnv, host = "graph.facebook.com"): string {
  return `https://${host}/${graphVersion(env)}`;
}

async function metaPost<T = Record<string, unknown>>(url: string, params: Record<string, string | number | boolean | undefined>, label: string): Promise<T> {
  const res = await request(url, { method: "POST", headers: { ...FORM_HEADERS, Accept: "application/json" }, body: formBody(params) });
  return readJson<T>(res, label);
}

async function metaGet<T = Record<string, unknown>>(url: string, params: Record<string, string | number | undefined>, label: string): Promise<T> {
  const qs = formBody(params);
  return getJson<T>(`${url}${url.includes("?") ? "&" : "?"}${qs}`, {}, label);
}

// ── Facebook ────────────────────────────────────────────────────────────────

export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
];

interface MetaPage {
  id: string;
  name: string;
  username?: string;
  access_token?: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
}

async function exchangeLongLived(env: ProviderEnv, token: string): Promise<{ accessToken: string; expiresAt: string }> {
  const data = await metaGet<{ access_token?: string; expires_in?: number }>(`${graph(env)}/oauth/access_token`, {
    grant_type: "fb_exchange_token",
    client_id: env.app.clientId,
    client_secret: env.app.clientSecret ?? "",
    fb_exchange_token: token,
  }, "Facebook long-lived token");
  if (!data.access_token) throw new Error("Facebook did not return a long-lived token");
  return { accessToken: data.access_token, expiresAt: expiresAtFrom(data.expires_in) ?? new Date(Date.now() + 60 * DAY).toISOString() };
}

async function listPages(env: ProviderEnv, userToken: string): Promise<MetaPage[]> {
  const pages: MetaPage[] = [];
  let next: string | null =
    `${graph(env)}/me/accounts?${formBody({
      fields: "id,name,username,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
      limit: 100,
      access_token: userToken,
    })}`;
  for (let i = 0; next && i < 20; i += 1) {
    const page: { data?: MetaPage[]; paging?: { next?: string } } = await getJson(next, {}, "Facebook Pages");
    pages.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return pages;
}

export function metaCandidates(pages: MetaPage[], user: { accessToken: string; expiresAt: string }, scopes: string[]): ConnectCandidate[] {
  const out: ConnectCandidate[] = [];
  for (const page of pages) {
    if (!page.access_token) continue;
    const token: TokenBundle = { accessToken: page.access_token, userAccessToken: user.accessToken, expiresAt: null, scopes };
    out.push({
      key: `page:${page.id}`,
      platform: "facebook",
      kind: "page",
      externalId: page.id,
      displayName: page.name,
      handle: page.username ?? null,
      avatarUrl: page.picture?.data?.url ?? null,
      token,
      expiresAt: user.expiresAt,
      scopes,
      meta: { pageId: page.id, via: "facebook_login" },
    });
    const ig = page.instagram_business_account;
    if (ig?.id) {
      out.push({
        key: `ig:${ig.id}`,
        platform: "instagram",
        kind: "instagram_business",
        externalId: ig.id,
        displayName: ig.username ? `@${ig.username}` : ig.name ?? `Instagram (${page.name})`,
        handle: ig.username ?? null,
        avatarUrl: ig.profile_picture_url ?? null,
        token,
        expiresAt: user.expiresAt,
        scopes,
        meta: { pageId: page.id, pageName: page.name, igUserId: ig.id, apiHost: "graph.facebook.com", via: "facebook_login" },
      });
    }
  }
  return out;
}

/** Re-exchange the long-lived user token and fetch a fresh Page token. */
async function refreshViaFacebook(env: ProviderEnv, account: ProviderAccount) {
  const pageId = str(account.meta.pageId) ?? account.externalId;
  const pageToken = account.token.accessToken;
  const user = account.token.userAccessToken;
  try {
    if (!user) throw new Error("No Facebook user token stored; reconnect the account");
    const long = await exchangeLongLived(env, user);
    const page = await metaGet<{ access_token?: string }>(`${graph(env)}/${pageId}`, { fields: "access_token", access_token: long.accessToken }, "Facebook Page token");
    return {
      token: { ...account.token, accessToken: page.access_token ?? pageToken, userAccessToken: long.accessToken },
      expiresAt: long.expiresAt,
    };
  } catch (error) {
    // Page tokens minted from a long-lived user token do not expire. If the
    // Page token still works, keep publishing and stop scheduling refreshes.
    try {
      await metaGet(`${graph(env)}/${pageId}`, { fields: "id", access_token: pageToken }, "Facebook Page token check");
      return { token: account.token, expiresAt: null, meta: { userTokenLapsedAt: new Date().toISOString() } };
    } catch {
      throw error;
    }
  }
}

async function facebookPublish(env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const base = graph(env);
  const token = account.token.accessToken;
  const pageId = str(account.meta.pageId) ?? account.externalId;
  const imgs = images(req.media);
  const vids = videos(req.media);
  if (vids.length > 1 || (vids.length && imgs.length)) throw new PublishRejected("A Facebook post takes one video or up to 10 images, not both");
  if (imgs.length > 10) throw new PublishRejected("A Facebook post takes up to 10 images");
  let externalId: string;
  let url: string;
  if (vids.length === 1) {
    const res = await metaPost<{ id?: string }>(`https://graph-video.facebook.com/${graphVersion(env)}/${pageId}/videos`, {
      file_url: vids[0]!.url,
      description: withLink(req.text, req.link),
      title: req.title,
      access_token: token,
    }, "Facebook video");
    if (!res.id) throw new Error("Facebook did not return a video id");
    externalId = res.id;
    url = `https://www.facebook.com/${pageId}/videos/${res.id}`;
  } else if (imgs.length === 1) {
    const res = await metaPost<{ id?: string; post_id?: string }>(`${base}/${pageId}/photos`, {
      url: imgs[0]!.url,
      caption: withLink(req.text, req.link),
      alt_text_custom: imgs[0]!.altText ?? undefined,
      access_token: token,
    }, "Facebook photo");
    externalId = res.post_id ?? res.id ?? "";
    if (!externalId) throw new Error("Facebook did not return a post id");
    url = `https://www.facebook.com/${externalId}`;
  } else if (imgs.length > 1) {
    const ids: string[] = [];
    for (const img of imgs) {
      const res = await metaPost<{ id?: string }>(`${base}/${pageId}/photos`, {
        url: img.url,
        published: false,
        alt_text_custom: img.altText ?? undefined,
        access_token: token,
      }, "Facebook photo upload");
      if (!res.id) throw new Error("Facebook did not return a photo id");
      ids.push(res.id);
    }
    const params: Record<string, string> = { message: withLink(req.text, req.link), access_token: token };
    ids.forEach((id, i) => {
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    });
    const res = await metaPost<{ id?: string }>(`${base}/${pageId}/feed`, params, "Facebook post");
    if (!res.id) throw new Error("Facebook did not return a post id");
    externalId = res.id;
    url = `https://www.facebook.com/${externalId}`;
  } else {
    if (!req.text && !req.link) throw new PublishRejected("A Facebook post needs text, a link or media");
    const res = await metaPost<{ id?: string }>(`${base}/${pageId}/feed`, { message: req.text, link: req.link, access_token: token }, "Facebook post");
    if (!res.id) throw new Error("Facebook did not return a post id");
    externalId = res.id;
    url = `https://www.facebook.com/${externalId}`;
  }
  const detail: Record<string, unknown> = {};
  if (req.firstComment) {
    const comment = await bestEffort(() =>
      metaPost<{ id?: string }>(`${base}/${externalId}/comments`, { message: req.firstComment, access_token: token }, "Facebook first comment"),
    );
    if (comment.value?.id) detail.firstCommentId = comment.value.id;
    if (comment.error) detail.firstCommentError = comment.error;
  }
  return { ok: true, externalId, url, detail };
}

export const facebookProvider: SocialProvider = {
  platform: "facebook",
  refreshKind: "long_lived",
  defaultScopes: () => FACEBOOK_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      state,
      response_type: "code",
      scope: scopesFor(facebookProvider, env).join(","),
    });
    return { url: `https://www.facebook.com/${graphVersion(env)}/dialog/oauth?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "Facebook");
    const short = await metaGet<{ access_token?: string }>(`${graph(env)}/oauth/access_token`, {
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      redirect_uri: env.redirectUri,
      code,
    }, "Facebook code exchange");
    if (!short.access_token) throw new Error("Facebook did not return an access token");
    const long = await exchangeLongLived(env, short.access_token);
    const pages = await listPages(env, long.accessToken);
    const candidates = metaCandidates(pages, long, scopesFor(facebookProvider, env));
    if (candidates.length === 0) {
      throw new Error("No Facebook Pages were shared. Create a Page, or choose your Pages when Facebook asks, then connect again.");
    }
    return { candidates };
  },
  refresh: refreshViaFacebook,
  publish: (env, account, req) => guard(() => facebookPublish(env, account, req)),
  async metrics(env, account, externalId): Promise<MetricsSnapshot | null> {
    const base = graph(env);
    const token = account.token.accessToken;
    const data = await metaGet<{
      shares?: { count?: number };
      comments?: { summary?: { total_count?: number } };
      reactions?: { summary?: { total_count?: number } };
    }>(`${base}/${externalId}`, {
      fields: "shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)",
      access_token: token,
    }, "Facebook metrics");
    const snapshot: MetricsSnapshot = {
      views: 0,
      likes: count(data.reactions?.summary?.total_count),
      comments: count(data.comments?.summary?.total_count),
      shares: count(data.shares?.count),
      raw: { fields: data },
    };
    const insights = await bestEffort(() =>
      metaGet<{ data?: Array<{ name: string; values?: Array<{ value?: number }> }> }>(`${base}/${externalId}/insights`, {
        metric: "post_impressions,post_impressions_unique,post_clicks",
        access_token: token,
      }, "Facebook insights"),
    );
    for (const row of insights.value?.data ?? []) {
      const value = optionalCount(row.values?.[0]?.value);
      if (row.name === "post_impressions") {
        snapshot.impressions = value;
        snapshot.views = value ?? 0;
      }
      if (row.name === "post_impressions_unique") snapshot.reach = value;
      if (row.name === "post_clicks") snapshot.clicks = value;
    }
    return snapshot;
  },
  async inbox(env, account, published): Promise<InboxCandidate[]> {
    const base = graph(env);
    const pageId = str(account.meta.pageId) ?? account.externalId;
    const out: InboxCandidate[] = [];
    for (const post of published) {
      const data = await metaGet<{
        data?: Array<{ id: string; message?: string; created_time?: string; permalink_url?: string; from?: { id?: string; name?: string } }>;
      }>(`${base}/${post.externalId}/comments`, {
        fields: "id,message,created_time,permalink_url,from{id,name}",
        order: "reverse_chronological",
        filter: "stream",
        limit: 25,
        access_token: account.token.accessToken,
      }, "Facebook comments");
      for (const c of data.data ?? []) {
        if (!c.message || c.from?.id === pageId) continue;
        out.push({
          externalId: c.id,
          parentExternalId: post.externalId,
          kind: "comment",
          author: c.from?.name ?? "Facebook user",
          body: c.message,
          permalink: c.permalink_url ?? null,
          receivedAt: c.created_time ?? null,
          destinationExternalId: post.externalId,
        });
      }
    }
    return out;
  },
  reply: (env, account, target, text) =>
    guard(async () => {
      const res = await metaPost<{ id?: string }>(`${graph(env)}/${target.externalId}/comments`, {
        message: text,
        access_token: account.token.accessToken,
      }, "Facebook reply");
      return { ok: true, externalId: res.id };
    }),
};

// ── Instagram ───────────────────────────────────────────────────────────────

export const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
];

function igHost(account: ProviderAccount): string {
  return account.meta.apiHost === "graph.facebook.com" ? "graph.facebook.com" : "graph.instagram.com";
}

function igUserId(account: ProviderAccount): string {
  return str(account.meta.igUserId) ?? account.externalId;
}

type ContainerStatus = { status_code?: string; status?: string };

async function waitForIgContainer(base: string, id: string, token: string, timeoutMs: number): Promise<void> {
  await pollUntil<void>(async () => {
    const s = await metaGet<ContainerStatus>(`${base}/${id}`, { fields: "status_code,status", access_token: token }, "Instagram container status");
    const code = s.status_code ?? "";
    if (code === "FINISHED" || code === "PUBLISHED") return { done: true, value: undefined };
    if (code === "ERROR" || code === "EXPIRED") throw new PublishRejected(`Instagram could not process the media (${s.status ?? code})`);
    return { done: false };
  }, { intervalMs: 5_000, timeoutMs, label: "Instagram media processing" });
}

async function igContainer(base: string, igId: string, params: Record<string, string | boolean | undefined>, token: string, label: string): Promise<string> {
  const res = await metaPost<{ id?: string }>(`${base}/${igId}/media`, { ...params, access_token: token }, label);
  if (!res.id) throw new Error(`${label}: no container id`);
  return res.id;
}

function igMediaParams(item: MediaRef, carouselItem: boolean): Record<string, string | boolean | undefined> {
  if (item.kind === "video") {
    return carouselItem
      ? { media_type: "VIDEO", video_url: item.url, is_carousel_item: true }
      : { media_type: "REELS", video_url: item.url, share_to_feed: true };
  }
  return { image_url: item.url, is_carousel_item: carouselItem ? true : undefined, alt_text: item.altText ?? undefined };
}

async function instagramPublish(env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const base = graph(env, igHost(account));
  const token = account.token.accessToken;
  const igId = igUserId(account);
  const media = req.media;
  if (media.length === 0) throw new PublishRejected("Instagram needs at least one image or video");
  if (media.length > 10) throw new PublishRejected("An Instagram carousel takes up to 10 items");
  const caption = clip(withLink(req.text, req.link), 2200);
  let creationId: string;
  if (media.length === 1) {
    creationId = await igContainer(base, igId, { ...igMediaParams(media[0]!, false), caption }, token, "Instagram container");
    await waitForIgContainer(base, creationId, token, media[0]!.kind === "video" ? 300_000 : 60_000);
  } else {
    const children: string[] = [];
    for (const item of media) {
      const id = await igContainer(base, igId, igMediaParams(item, true), token, "Instagram carousel item");
      if (item.kind === "video") await waitForIgContainer(base, id, token, 300_000);
      children.push(id);
    }
    creationId = await igContainer(base, igId, { media_type: "CAROUSEL", children: children.join(","), caption }, token, "Instagram carousel");
    await waitForIgContainer(base, creationId, token, 120_000);
  }
  const published = await metaPost<{ id?: string }>(`${base}/${igId}/media_publish`, { creation_id: creationId, access_token: token }, "Instagram publish");
  if (!published.id) throw new Error("Instagram did not return a media id");
  const permalink = await bestEffort(() => metaGet<{ permalink?: string }>(`${base}/${published.id}`, { fields: "permalink", access_token: token }, "Instagram permalink"));
  const detail: Record<string, unknown> = { creationId };
  if (req.firstComment) {
    const comment = await bestEffort(() =>
      metaPost<{ id?: string }>(`${base}/${published.id}/comments`, { message: req.firstComment, access_token: token }, "Instagram first comment"),
    );
    if (comment.value?.id) detail.firstCommentId = comment.value.id;
    if (comment.error) detail.firstCommentError = comment.error;
  }
  return { ok: true, externalId: published.id, url: permalink.value?.permalink ?? `https://www.instagram.com/${account.handle ?? ""}`, detail };
}

export const instagramProvider: SocialProvider = {
  platform: "instagram",
  refreshKind: "long_lived",
  defaultScopes: () => INSTAGRAM_LOGIN_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      response_type: "code",
      scope: scopesFor(instagramProvider, env).join(","),
      state,
    });
    return { url: `https://www.instagram.com/oauth/authorize?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "Instagram");
    const raw = await postForm<{ access_token?: string; user_id?: string | number; data?: Array<{ access_token?: string; user_id?: string | number }> }>(
      "https://api.instagram.com/oauth/access_token",
      { client_id: env.app.clientId, client_secret: env.app.clientSecret ?? "", grant_type: "authorization_code", redirect_uri: env.redirectUri, code },
      {},
      "Instagram code exchange",
    );
    const first = raw.data?.[0] ?? raw;
    if (!first.access_token) throw new Error("Instagram did not return an access token");
    const long = await metaGet<{ access_token?: string; expires_in?: number }>("https://graph.instagram.com/access_token", {
      grant_type: "ig_exchange_token",
      client_secret: env.app.clientSecret ?? "",
      access_token: first.access_token,
    }, "Instagram long-lived token");
    const accessToken = long.access_token ?? first.access_token;
    const expiresAt = expiresAtFrom(long.expires_in) ?? new Date(Date.now() + 60 * DAY).toISOString();
    const me = await metaGet<{ id?: string; user_id?: string | number; username?: string; name?: string; profile_picture_url?: string }>(
      `${graph(env, "graph.instagram.com")}/me`,
      { fields: "id,user_id,username,name,profile_picture_url,account_type", access_token: accessToken },
      "Instagram profile",
    );
    const igId = str(me.user_id) ?? str(me.id) ?? str(first.user_id);
    if (!igId) throw new Error("Instagram did not return the account id");
    const scopes = scopesFor(instagramProvider, env);
    return {
      candidates: [{
        key: `ig:${igId}`,
        platform: "instagram",
        kind: "instagram_professional",
        externalId: igId,
        displayName: me.username ? `@${me.username}` : me.name ?? "Instagram",
        handle: me.username ?? null,
        avatarUrl: me.profile_picture_url ?? null,
        token: { accessToken, expiresAt, scopes },
        expiresAt,
        scopes,
        meta: { igUserId: igId, apiHost: "graph.instagram.com", via: "instagram_login" },
      }],
    };
  },
  async refresh(env, account) {
    if (account.meta.via === "facebook_login") return refreshViaFacebook(env, account);
    const data = await metaGet<{ access_token?: string; expires_in?: number }>("https://graph.instagram.com/refresh_access_token", {
      grant_type: "ig_refresh_token",
      access_token: account.token.accessToken,
    }, "Instagram token refresh");
    if (!data.access_token) throw new Error("Instagram did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in) ?? new Date(Date.now() + 60 * DAY).toISOString();
    return { token: { ...account.token, accessToken: data.access_token, expiresAt }, expiresAt };
  },
  publish: (env, account, req) => guard(() => instagramPublish(env, account, req)),
  async metrics(env, account, externalId): Promise<MetricsSnapshot | null> {
    const base = graph(env, igHost(account));
    const token = account.token.accessToken;
    const data = await metaGet<{ like_count?: number; comments_count?: number; permalink?: string }>(`${base}/${externalId}`, {
      fields: "like_count,comments_count,permalink",
      access_token: token,
    }, "Instagram metrics");
    const snapshot: MetricsSnapshot = { views: 0, likes: count(data.like_count), comments: count(data.comments_count), shares: 0, url: data.permalink };
    const insights = await bestEffort(() =>
      metaGet<{ data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> }>(`${base}/${externalId}/insights`, {
        metric: "reach,saved,shares,views",
        access_token: token,
      }, "Instagram insights"),
    );
    for (const row of insights.value?.data ?? []) {
      const value = optionalCount(row.values?.[0]?.value ?? row.total_value?.value);
      if (row.name === "reach") snapshot.reach = value;
      if (row.name === "saved") snapshot.saves = value;
      if (row.name === "shares") snapshot.shares = value ?? 0;
      if (row.name === "views") snapshot.views = value ?? 0;
    }
    return snapshot;
  },
  async inbox(env, account, published): Promise<InboxCandidate[]> {
    const base = graph(env, igHost(account));
    const out: InboxCandidate[] = [];
    for (const post of published) {
      const data = await metaGet<{ data?: Array<{ id: string; text?: string; username?: string; timestamp?: string }> }>(`${base}/${post.externalId}/comments`, {
        fields: "id,text,username,timestamp",
        limit: 25,
        access_token: account.token.accessToken,
      }, "Instagram comments");
      for (const c of data.data ?? []) {
        if (!c.text || (account.handle && c.username === account.handle)) continue;
        out.push({
          externalId: c.id,
          parentExternalId: post.externalId,
          kind: "comment",
          author: c.username ? `@${c.username}` : "Instagram user",
          body: c.text,
          permalink: null,
          receivedAt: c.timestamp ?? null,
          destinationExternalId: post.externalId,
        });
      }
    }
    return out;
  },
  reply: (env, account, target, text) =>
    guard(async () => {
      const res = await metaPost<{ id?: string }>(`${graph(env, igHost(account))}/${target.externalId}/replies`, {
        message: text,
        access_token: account.token.accessToken,
      }, "Instagram reply");
      return { ok: true, externalId: res.id };
    }),
};

// ── Threads ─────────────────────────────────────────────────────────────────

const THREADS = "https://graph.threads.net";

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies", "threads_manage_insights"];

function threadsBase(env: ProviderEnv): string {
  const v = env.app.apiVersion?.trim() || "v1.0";
  return `${THREADS}/${v.startsWith("v") ? v : `v${v}`}`;
}

async function threadsContainer(env: ProviderEnv, account: ProviderAccount, params: Record<string, string | boolean | undefined>, label: string): Promise<string> {
  const res = await metaPost<{ id?: string }>(`${threadsBase(env)}/${account.externalId}/threads`, { ...params, access_token: account.token.accessToken }, label);
  if (!res.id) throw new Error(`${label}: no container id`);
  return res.id;
}

async function waitForThreadsContainer(env: ProviderEnv, id: string, token: string, timeoutMs: number): Promise<void> {
  await pollUntil<void>(async () => {
    const s = await metaGet<{ status?: string; error_message?: string }>(`${threadsBase(env)}/${id}`, { fields: "status,error_message", access_token: token }, "Threads container status");
    if (s.status === "FINISHED" || s.status === "PUBLISHED") return { done: true, value: undefined };
    if (s.status === "ERROR" || s.status === "EXPIRED") throw new PublishRejected(`Threads could not process the media (${s.error_message ?? s.status})`);
    return { done: false };
  }, { intervalMs: 3_000, timeoutMs, label: "Threads media processing" });
}

async function threadsPublishContainer(env: ProviderEnv, account: ProviderAccount, creationId: string): Promise<string> {
  const res = await metaPost<{ id?: string }>(`${threadsBase(env)}/${account.externalId}/threads_publish`, {
    creation_id: creationId,
    access_token: account.token.accessToken,
  }, "Threads publish");
  if (!res.id) throw new Error("Threads did not return a post id");
  return res.id;
}

async function threadsPublish(env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const token = account.token.accessToken;
  const text = clip(req.text, 500);
  let creationId: string;
  if (req.media.length === 0) {
    if (!text) throw new PublishRejected("A Threads post needs text or media");
    creationId = await threadsContainer(env, account, { media_type: "TEXT", text, link_attachment: req.link }, "Threads container");
    await waitForThreadsContainer(env, creationId, token, 60_000);
  } else if (req.media.length === 1) {
    const item = req.media[0]!;
    creationId = await threadsContainer(env, account, item.kind === "video"
      ? { media_type: "VIDEO", video_url: item.url, text }
      : { media_type: "IMAGE", image_url: item.url, text, alt_text: item.altText ?? undefined }, "Threads container");
    await waitForThreadsContainer(env, creationId, token, item.kind === "video" ? 300_000 : 60_000);
  } else {
    if (req.media.length > 20) throw new PublishRejected("A Threads carousel takes up to 20 items");
    const children: string[] = [];
    for (const item of req.media) {
      const id = await threadsContainer(env, account, item.kind === "video"
        ? { media_type: "VIDEO", video_url: item.url, is_carousel_item: true }
        : { media_type: "IMAGE", image_url: item.url, is_carousel_item: true, alt_text: item.altText ?? undefined }, "Threads carousel item");
      await waitForThreadsContainer(env, id, token, item.kind === "video" ? 300_000 : 60_000);
      children.push(id);
    }
    creationId = await threadsContainer(env, account, { media_type: "CAROUSEL", children: children.join(","), text }, "Threads carousel");
    await waitForThreadsContainer(env, creationId, token, 120_000);
  }
  const id = await threadsPublishContainer(env, account, creationId);
  const permalink = await bestEffort(() => metaGet<{ permalink?: string }>(`${threadsBase(env)}/${id}`, { fields: "permalink", access_token: token }, "Threads permalink"));
  const detail: Record<string, unknown> = {};
  if (req.firstComment) {
    const reply = await bestEffort(async () => {
      const c = await threadsContainer(env, account, { media_type: "TEXT", text: clip(req.firstComment!, 500), reply_to_id: id }, "Threads first reply");
      await waitForThreadsContainer(env, c, token, 60_000);
      return threadsPublishContainer(env, account, c);
    });
    if (reply.value) detail.firstCommentId = reply.value;
    if (reply.error) detail.firstCommentError = reply.error;
  }
  return {
    ok: true,
    externalId: id,
    url: permalink.value?.permalink ?? (account.handle ? `https://www.threads.net/@${account.handle}/post/${id}` : undefined),
    detail,
  };
}

export const threadsProvider: SocialProvider = {
  platform: "threads",
  refreshKind: "long_lived",
  defaultScopes: () => THREADS_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      scope: scopesFor(threadsProvider, env).join(","),
      response_type: "code",
      state,
    });
    return { url: `https://threads.net/oauth/authorize?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "Threads");
    const short = await postForm<{ access_token?: string; user_id?: string | number }>(`${THREADS}/oauth/access_token`, {
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      grant_type: "authorization_code",
      redirect_uri: env.redirectUri,
      code,
    }, {}, "Threads code exchange");
    if (!short.access_token) throw new Error("Threads did not return an access token");
    const long = await metaGet<{ access_token?: string; expires_in?: number }>(`${THREADS}/access_token`, {
      grant_type: "th_exchange_token",
      client_secret: env.app.clientSecret ?? "",
      access_token: short.access_token,
    }, "Threads long-lived token");
    const accessToken = long.access_token ?? short.access_token;
    const expiresAt = expiresAtFrom(long.expires_in) ?? new Date(Date.now() + 60 * DAY).toISOString();
    const me = await metaGet<{ id?: string; username?: string; name?: string; threads_profile_picture_url?: string }>(`${threadsBase(env)}/me`, {
      fields: "id,username,name,threads_profile_picture_url",
      access_token: accessToken,
    }, "Threads profile");
    const id = str(me.id) ?? str(short.user_id);
    if (!id) throw new Error("Threads did not return the account id");
    const scopes = scopesFor(threadsProvider, env);
    return {
      candidates: [{
        key: `threads:${id}`,
        platform: "threads",
        kind: "profile",
        externalId: id,
        displayName: me.username ? `@${me.username}` : me.name ?? "Threads",
        handle: me.username ?? null,
        avatarUrl: me.threads_profile_picture_url ?? null,
        token: { accessToken, expiresAt, scopes },
        expiresAt,
        scopes,
        meta: {},
      }],
    };
  },
  async refresh(_env, account) {
    const data = await metaGet<{ access_token?: string; expires_in?: number }>(`${THREADS}/refresh_access_token`, {
      grant_type: "th_refresh_token",
      access_token: account.token.accessToken,
    }, "Threads token refresh");
    if (!data.access_token) throw new Error("Threads did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in) ?? new Date(Date.now() + 60 * DAY).toISOString();
    return { token: { ...account.token, accessToken: data.access_token, expiresAt }, expiresAt };
  },
  publish: (env, account, req) => guard(() => threadsPublish(env, account, req)),
  async metrics(env, account, externalId): Promise<MetricsSnapshot | null> {
    const data = await metaGet<{ data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> }>(
      `${threadsBase(env)}/${externalId}/insights`,
      { metric: "views,likes,replies,reposts,quotes,shares", access_token: account.token.accessToken },
      "Threads insights",
    );
    const value = (name: string) => {
      const row = data.data?.find((r) => r.name === name);
      return count(row?.values?.[0]?.value ?? row?.total_value?.value);
    };
    return {
      views: value("views"),
      likes: value("likes"),
      comments: value("replies"),
      shares: value("reposts") + value("quotes") + value("shares"),
      raw: { data: data.data ?? [] },
    };
  },
  async inbox(env, account, published): Promise<InboxCandidate[]> {
    const out: InboxCandidate[] = [];
    for (const post of published) {
      const data = await metaGet<{ data?: Array<{ id: string; text?: string; username?: string; timestamp?: string; permalink?: string }> }>(
        `${threadsBase(env)}/${post.externalId}/replies`,
        { fields: "id,text,username,timestamp,permalink", access_token: account.token.accessToken },
        "Threads replies",
      );
      for (const r of data.data ?? []) {
        if (!r.text || (account.handle && r.username === account.handle)) continue;
        out.push({
          externalId: r.id,
          parentExternalId: post.externalId,
          kind: "comment",
          author: r.username ? `@${r.username}` : "Threads user",
          body: r.text,
          permalink: r.permalink ?? null,
          receivedAt: r.timestamp ?? null,
          destinationExternalId: post.externalId,
        });
      }
    }
    return out;
  },
  reply: (env, account, target, text) =>
    guard(async () => {
      const c = await threadsContainer(env, account, { media_type: "TEXT", text: clip(text, 500), reply_to_id: target.externalId }, "Threads reply");
      await waitForThreadsContainer(env, c, account.token.accessToken, 60_000);
      const id = await threadsPublishContainer(env, account, c);
      return { ok: true, externalId: id };
    }),
};

export { ProviderHttpError };
