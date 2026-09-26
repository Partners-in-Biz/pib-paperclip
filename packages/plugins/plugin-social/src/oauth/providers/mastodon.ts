/**
 * Mastodon: an OAuth app is registered once per instance (cached in
 * mastodon_apps by the connect flow). Media is uploaded, then polled until
 * processed; statuses use an Idempotency-Key so a retry never double-posts.
 */
import { clip } from "../../domain.js";
import {
  downloadMedia,
  getJson,
  guessMime,
  pollUntil,
  postForm,
  postJson,
  PublishRejected,
  readJson,
  request,
  str,
} from "../http.js";
import type {
  ExchangeResult,
  InboxCandidate,
  MetricsSnapshot,
  ProviderAccount,
  ProviderEnv,
  PublishOutcome,
  PublishRequest,
  SocialProvider,
} from "../types.js";
import { bestEffort, count, guard, requireCode } from "./common.js";

export const MASTODON_SCOPES = ["read", "write:statuses", "write:media"];

/** Register the Partners in Biz app on an instance (called once, then cached). */
export async function registerMastodonApp(instanceUrl: string, redirectUri: string, website: string): Promise<{ clientId: string; clientSecret: string }> {
  const app = await postJson<{ client_id?: string; client_secret?: string }>(`${instanceUrl}/api/v1/apps`, {
    client_name: "Partners in Biz Social",
    redirect_uris: redirectUri,
    scopes: MASTODON_SCOPES.join(" "),
    website,
  }, {}, `Mastodon app registration on ${new URL(instanceUrl).host}`);
  if (!app.client_id || !app.client_secret) throw new Error("Mastodon did not return app credentials");
  return { clientId: app.client_id, clientSecret: app.client_secret };
}

function instanceOf(account: ProviderAccount): string {
  const url = str(account.meta.instanceUrl);
  if (!url) throw new PublishRejected("This Mastodon account has no instance URL; reconnect it");
  return url.replace(/\/+$/, "");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

async function uploadMedia(instance: string, token: string, url: string, altText: string | null, kind: "image" | "video"): Promise<string> {
  const file = await downloadMedia(url, { maxBytes: kind === "video" ? 99 * 1024 * 1024 : 16 * 1024 * 1024, fallbackMime: guessMime(url, kind) });
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mime }), kind === "video" ? "video.mp4" : "image");
  if (altText) form.append("description", clip(altText, 1500));
  const res = await request(`${instance}/api/v2/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, timeoutMs: 300_000 });
  const media = await readJson<{ id?: string; url?: string | null }>(res, "Mastodon media upload");
  if (!media.id) throw new Error("Mastodon did not return a media id");
  if (res.status === 202 || !media.url) {
    await pollUntil<void>(async () => {
      const check = await request(`${instance}/api/v1/media/${media.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (check.status === 206) return { done: false };
      const body = await readJson<{ url?: string | null }>(check, "Mastodon media status");
      return body.url ? { done: true, value: undefined } : { done: false };
    }, { intervalMs: 3_000, timeoutMs: 180_000, label: "Mastodon media processing" });
  }
  return media.id;
}

async function mastodonPublish(env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const instance = instanceOf(account);
  const token = account.token.accessToken;
  if (req.media.length > 4) throw new PublishRejected("A Mastodon post takes up to 4 attachments");
  const text = req.link && !req.text.includes(req.link) ? `${req.text}\n\n${req.link}`.trim() : req.text;
  if (Array.from(text).length > 500) throw new PublishRejected("Mastodon posts are limited to 500 characters on most instances. Add a shorter Mastodon override.");
  const mediaIds: string[] = [];
  for (const item of req.media) mediaIds.push(await uploadMedia(instance, token, item.url, item.altText, item.kind));
  const visibility = req.privacy && ["public", "unlisted", "private"].includes(req.privacy) ? req.privacy : "public";
  const res = await request(`${instance}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(env.idempotencyKey ? { "Idempotency-Key": env.idempotencyKey } : {}),
    },
    body: JSON.stringify({ status: text, media_ids: mediaIds, visibility }),
  });
  const status = await readJson<{ id?: string; url?: string }>(res, "Mastodon post");
  if (!status.id) throw new Error("Mastodon did not return the post id");
  const detail: Record<string, unknown> = {};
  if (req.firstComment) {
    const reply = await bestEffort(() => postJson<{ id?: string }>(`${instance}/api/v1/statuses`, {
      status: clip(req.firstComment!, 500),
      in_reply_to_id: status.id,
      visibility,
    }, { Authorization: `Bearer ${token}` }, "Mastodon first reply"));
    if (reply.value?.id) detail.firstCommentId = reply.value.id;
    if (reply.error) detail.firstCommentError = reply.error;
  }
  return { ok: true, externalId: status.id, url: status.url, detail };
}

export const mastodonProvider: SocialProvider = {
  platform: "mastodon",
  refreshKind: "none",
  defaultScopes: () => MASTODON_SCOPES,
  authorize(env, state, input) {
    const instanceUrl = input.instanceUrl;
    if (!instanceUrl) throw new Error("Mastodon needs an instance URL");
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      response_type: "code",
      scope: MASTODON_SCOPES.join(" "),
      state,
    });
    return { url: `${instanceUrl}/oauth/authorize?${qs.toString()}`, sessionExtra: { instanceUrl } };
  },
  async exchange(env, params, session): Promise<ExchangeResult> {
    const code = requireCode(params, "Mastodon");
    const instanceUrl = str(session.instanceUrl);
    if (!instanceUrl) throw new Error("The Mastodon sign-in session lost its instance URL. Start again.");
    const data = await postForm<{ access_token?: string; scope?: string }>(`${instanceUrl}/oauth/token`, {
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      redirect_uri: env.redirectUri,
      grant_type: "authorization_code",
      code,
      scope: MASTODON_SCOPES.join(" "),
    }, {}, "Mastodon code exchange");
    if (!data.access_token) throw new Error("Mastodon did not return an access token");
    const me = await getJson<{ id?: string; username?: string; acct?: string; display_name?: string; avatar?: string }>(
      `${instanceUrl}/api/v1/accounts/verify_credentials`,
      { Authorization: `Bearer ${data.access_token}` },
      "Mastodon profile",
    );
    if (!me.id) throw new Error("Mastodon did not return the account id");
    const host = new URL(instanceUrl).host;
    const scopes = data.scope ? data.scope.split(/\s+/).filter(Boolean) : MASTODON_SCOPES;
    return {
      candidates: [{
        key: `mastodon:${host}:${me.id}`,
        platform: "mastodon",
        kind: "profile",
        externalId: `${host}:${me.id}`,
        displayName: me.display_name || `@${me.username}@${host}`,
        handle: `${me.username ?? me.acct}@${host}`,
        avatarUrl: me.avatar ?? null,
        token: { accessToken: data.access_token, expiresAt: null, scopes },
        expiresAt: null,
        scopes,
        meta: { instanceUrl, accountId: me.id },
      }],
    };
  },
  publish: (env, account, req) => guard(() => mastodonPublish(env, account, req)),
  async metrics(_env, account, externalId): Promise<MetricsSnapshot | null> {
    const s = await getJson<{ favourites_count?: number; reblogs_count?: number; replies_count?: number }>(
      `${instanceOf(account)}/api/v1/statuses/${encodeURIComponent(externalId)}`,
      { Authorization: `Bearer ${account.token.accessToken}` },
      "Mastodon metrics",
    );
    return { views: 0, likes: count(s.favourites_count), comments: count(s.replies_count), shares: count(s.reblogs_count), raw: { status: s } };
  },
  async inbox(_env, account): Promise<InboxCandidate[]> {
    const instance = instanceOf(account);
    const items = await getJson<Array<{ id: string; type: string; created_at?: string; account?: { acct?: string }; status?: { id: string; content?: string; url?: string; in_reply_to_id?: string | null } }>>(
      `${instance}/api/v1/notifications?types[]=mention&limit=30`,
      { Authorization: `Bearer ${account.token.accessToken}` },
      "Mastodon notifications",
    );
    return (Array.isArray(items) ? items : [])
      .filter((n) => n.type === "mention" && n.status)
      .map((n) => ({
        externalId: n.status!.id,
        parentExternalId: n.status!.in_reply_to_id ?? null,
        kind: "mention" as const,
        author: n.account?.acct ? `@${n.account.acct}` : "Mastodon user",
        body: stripHtml(n.status!.content ?? ""),
        permalink: n.status!.url ?? null,
        receivedAt: n.created_at ?? null,
        destinationExternalId: n.status!.in_reply_to_id ?? null,
      }));
  },
  reply: (_env, account, target, text) =>
    guard(async () => {
      const mention = target.author && target.author.startsWith("@") && !text.includes(target.author) ? `${target.author} ` : "";
      const res = await postJson<{ id?: string; url?: string }>(`${instanceOf(account)}/api/v1/statuses`, {
        status: clip(`${mention}${text}`, 500),
        in_reply_to_id: target.externalId,
      }, { Authorization: `Bearer ${account.token.accessToken}` }, "Mastodon reply");
      return { ok: true, externalId: res.id, url: res.url };
    }),
};
