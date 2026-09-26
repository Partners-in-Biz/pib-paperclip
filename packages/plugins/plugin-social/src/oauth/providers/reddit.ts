/** Reddit: self and link posts to a subreddit (post override or account default). */
import { clip, normalizeSubreddit } from "../../domain.js";
import { basicAuth, expiresAtFrom, formBody, FORM_HEADERS, getJson, postForm, ProviderHttpError, PublishRejected, readJson, request, str } from "../http.js";
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
import { bestEffort, count, guard, images, requireCode, videos } from "./common.js";

export const REDDIT_USER_AGENT = "partnersinbiz-paperclip/1.0 (by /u/partnersinbiz)";
const OAUTH_API = "https://oauth.reddit.com";
export const REDDIT_SCOPES = ["identity", "submit", "read"];

function appAuth(env: ProviderEnv): Record<string, string> {
  return { Authorization: basicAuth(env.app.clientId, env.app.clientSecret ?? ""), "User-Agent": REDDIT_USER_AGENT };
}

function userAuth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_USER_AGENT };
}

interface RedditJson<T> {
  json?: { errors?: Array<[string, string, string?]>; data?: T };
}

async function redditPost<T>(token: string, path: string, params: Record<string, string | boolean | undefined>, label: string): Promise<T> {
  const res = await request(`${OAUTH_API}${path}`, {
    method: "POST",
    headers: { ...userAuth(token), ...FORM_HEADERS, Accept: "application/json" },
    body: formBody({ ...params, api_type: "json" }),
  });
  const data = await readJson<RedditJson<T>>(res, label);
  const errors = data.json?.errors ?? [];
  if (errors.length) {
    const [code, message] = errors[0]!;
    if (code === "RATELIMIT") throw new ProviderHttpError(429, JSON.stringify({ message }), label);
    throw new PublishRejected(`${label}: ${message ?? code}`);
  }
  return (data.json?.data ?? {}) as T;
}

async function redditPublish(_env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const sr = normalizeSubreddit(req.subreddit ?? str(account.meta.defaultSubreddit));
  if (!sr) throw new PublishRejected("Choose a subreddit (post override or the account's default subreddit)");
  if (videos(req.media).length) throw new PublishRejected("Reddit video posts are not supported; use a link or an image");
  const title = clip((req.title ?? req.text.split("\n")[0] ?? "").trim(), 300);
  if (!title) throw new PublishRejected("A Reddit post needs a title");
  const linkUrl = req.link ?? images(req.media)[0]?.url;
  const params: Record<string, string | boolean | undefined> = linkUrl
    ? { sr, kind: "link", title, url: linkUrl, resubmit: true, sendreplies: true }
    : { sr, kind: "self", title, text: clip(req.text, 40000), sendreplies: true };
  const data = await redditPost<{ url?: string; id?: string; name?: string }>(account.token.accessToken, "/api/submit", params, "Reddit submit");
  const name = data.name ?? (data.id ? `t3_${data.id}` : undefined);
  if (!name) throw new Error("Reddit did not return the post id");
  const detail: Record<string, unknown> = { subreddit: sr };
  const commentText = req.firstComment ?? (linkUrl && req.text && req.text.trim() !== title ? req.text : undefined);
  if (commentText) {
    const comment = await bestEffort(() => redditPost<{ things?: Array<{ data?: { name?: string } }> }>(
      account.token.accessToken, "/api/comment", { thing_id: name, text: clip(commentText, 10000) }, "Reddit first comment",
    ));
    if (comment.value?.things?.[0]?.data?.name) detail.firstCommentId = comment.value.things[0].data.name;
    if (comment.error) detail.firstCommentError = comment.error;
  }
  return { ok: true, externalId: name, url: data.url ?? `https://www.reddit.com/r/${sr}/`, detail };
}

export const redditProvider: SocialProvider = {
  platform: "reddit",
  refreshKind: "refresh_token",
  defaultScopes: () => REDDIT_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      response_type: "code",
      state,
      redirect_uri: env.redirectUri,
      duration: "permanent",
      scope: scopesFor(redditProvider, env).join(" "),
    });
    return { url: `https://www.reddit.com/api/v1/authorize?${qs.toString()}` };
  },
  async exchange(env, params, session): Promise<ExchangeResult> {
    const code = requireCode(params, "Reddit");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>(
      "https://www.reddit.com/api/v1/access_token",
      { grant_type: "authorization_code", code, redirect_uri: env.redirectUri },
      appAuth(env),
      "Reddit code exchange",
    );
    if (!data.access_token) throw new Error(data.error ?? "Reddit did not return an access token");
    const me = await getJson<{ name?: string; id?: string; icon_img?: string }>(`${OAUTH_API}/api/v1/me`, userAuth(data.access_token), "Reddit profile");
    if (!me.name) throw new Error("Reddit did not return the username");
    const scopes = data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : scopesFor(redditProvider, env);
    const expiresAt = expiresAtFrom(data.expires_in);
    const defaultSubreddit = normalizeSubreddit(str(session.defaultSubreddit));
    return {
      candidates: [{
        key: `reddit:${me.name}`,
        platform: "reddit",
        kind: "user",
        externalId: me.name,
        displayName: `u/${me.name}`,
        handle: me.name,
        avatarUrl: me.icon_img ? me.icon_img.split("?")[0]! : null,
        token: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, scopes },
        expiresAt,
        scopes,
        meta: defaultSubreddit ? { defaultSubreddit } : {},
      }],
    };
  },
  async refresh(env, account) {
    if (!account.token.refreshToken) throw new Error("No Reddit refresh token stored; reconnect the account");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number }>(
      "https://www.reddit.com/api/v1/access_token",
      { grant_type: "refresh_token", refresh_token: account.token.refreshToken },
      appAuth(env),
      "Reddit token refresh",
    );
    if (!data.access_token) throw new Error("Reddit did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in);
    return { token: { ...account.token, accessToken: data.access_token, refreshToken: data.refresh_token ?? account.token.refreshToken, expiresAt }, expiresAt };
  },
  publish: (env, account, req) => guard(() => redditPublish(env, account, req)),
  async metrics(_env, account, externalId): Promise<MetricsSnapshot | null> {
    const data = await getJson<{ data?: { children?: Array<{ data?: { ups?: number; score?: number; num_comments?: number; upvote_ratio?: number } }> } }>(
      `${OAUTH_API}/api/info?id=${encodeURIComponent(externalId)}`,
      userAuth(account.token.accessToken),
      "Reddit metrics",
    );
    const post = data.data?.children?.[0]?.data;
    if (!post) return null;
    return { views: 0, likes: count(post.ups ?? post.score), comments: count(post.num_comments), shares: 0, raw: { score: post.score, upvote_ratio: post.upvote_ratio } };
  },
};
