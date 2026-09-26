/** Pinterest v5: one account per chosen board; image and multi-image pins. */
import { clip } from "../../domain.js";
import { basicAuth, expiresAtFrom, getJson, postForm, postJson, PublishRejected, str } from "../http.js";
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
import { count, guard, images, optionalCount, requireCode, videos } from "./common.js";

const API = "https://api.pinterest.com/v5";
export const PINTEREST_SCOPES = ["boards:read", "pins:read", "pins:write", "user_accounts:read"];

function auth(env: ProviderEnv): Record<string, string> {
  return { Authorization: basicAuth(env.app.clientId, env.app.clientSecret ?? "") };
}

async function pinterestPublish(_env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const boardId = req.boardId || str(account.meta.boardId);
  if (!boardId) throw new PublishRejected("Choose a Pinterest board (account default or post override)");
  if (videos(req.media).length) throw new PublishRejected("Video pins are not supported yet; use an image");
  const imgs = images(req.media);
  if (imgs.length === 0) throw new PublishRejected("A Pinterest pin needs an image");
  if (imgs.length > 5) throw new PublishRejected("A Pinterest carousel takes up to 5 images");
  const title = clip((req.title ?? req.text.split("\n")[0] ?? "").trim(), 100);
  const body: Record<string, unknown> = {
    board_id: boardId,
    title: title || undefined,
    description: clip(req.text, 800),
    link: req.link,
    alt_text: imgs[0]!.altText ? clip(imgs[0]!.altText, 500) : undefined,
    media_source: imgs.length === 1
      ? { source_type: "image_url", url: imgs[0]!.url }
      : { source_type: "multiple_image_urls", items: imgs.map((img) => ({ url: img.url, title: title || undefined, description: img.altText ? clip(img.altText, 500) : undefined, link: req.link })) },
  };
  const pin = await postJson<{ id?: string }>(`${API}/pins`, body, { Authorization: `Bearer ${account.token.accessToken}` }, "Pinterest pin");
  if (!pin.id) throw new Error("Pinterest did not return a pin id");
  return { ok: true, externalId: pin.id, url: `https://www.pinterest.com/pin/${pin.id}/` };
}

export const pinterestProvider: SocialProvider = {
  platform: "pinterest",
  refreshKind: "refresh_token",
  defaultScopes: () => PINTEREST_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      response_type: "code",
      scope: scopesFor(pinterestProvider, env).join(","),
      state,
    });
    return { url: `https://www.pinterest.com/oauth/?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "Pinterest");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string }>(
      `${API}/oauth/token`,
      { grant_type: "authorization_code", code, redirect_uri: env.redirectUri },
      auth(env),
      "Pinterest code exchange",
    );
    if (!data.access_token) throw new Error("Pinterest did not return an access token");
    const bearer = { Authorization: `Bearer ${data.access_token}` };
    const user = await getJson<{ username?: string; profile_image?: string; id?: string }>(`${API}/user_account`, bearer, "Pinterest profile");
    const boards: Array<{ id: string; name: string; privacy?: string }> = [];
    let bookmark: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await getJson<{ items?: Array<{ id: string; name: string; privacy?: string }>; bookmark?: string | null }>(
        `${API}/boards?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ""}`,
        bearer,
        "Pinterest boards",
      );
      boards.push(...(page.items ?? []));
      if (!page.bookmark) break;
      bookmark = page.bookmark;
    }
    if (boards.length === 0) throw new Error("This Pinterest account has no boards. Create a board, then connect again.");
    const scopes = data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : scopesFor(pinterestProvider, env);
    const expiresAt = expiresAtFrom(data.expires_in);
    const token = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, refreshExpiresAt: expiresAtFrom(data.refresh_token_expires_in), scopes };
    const username = user.username ?? "pinterest";
    return {
      candidates: boards.map((board) => ({
        key: `board:${board.id}`,
        platform: "pinterest" as const,
        kind: "board",
        externalId: board.id,
        displayName: `${username} · ${board.name}`,
        handle: username,
        avatarUrl: user.profile_image ?? null,
        token,
        expiresAt,
        scopes,
        meta: { boardId: board.id, boardName: board.name, boardPrivacy: board.privacy ?? null, username },
      })),
    };
  },
  async refresh(env, account) {
    if (!account.token.refreshToken) throw new Error("No Pinterest refresh token stored; reconnect the account");
    const data = await postForm<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }>(
      `${API}/oauth/token`,
      { grant_type: "refresh_token", refresh_token: account.token.refreshToken },
      auth(env),
      "Pinterest token refresh",
    );
    if (!data.access_token) throw new Error("Pinterest did not return a refreshed token");
    const expiresAt = expiresAtFrom(data.expires_in);
    return {
      token: {
        ...account.token,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? account.token.refreshToken,
        expiresAt,
        refreshExpiresAt: expiresAtFrom(data.refresh_token_expires_in) ?? account.token.refreshExpiresAt ?? null,
      },
      expiresAt,
    };
  },
  publish: (env, account, req) => guard(() => pinterestPublish(env, account, req)),
  async metrics(_env, account, externalId): Promise<MetricsSnapshot | null> {
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 24 * 3600_000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const data = await getJson<Record<string, { summary_metrics?: Record<string, number> }>>(
      `${API}/pins/${encodeURIComponent(externalId)}/analytics?start_date=${day(start)}&end_date=${day(end)}&metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK`,
      { Authorization: `Bearer ${account.token.accessToken}` },
      "Pinterest analytics",
    );
    const m = data.all?.summary_metrics ?? {};
    return {
      views: count(m.IMPRESSION),
      likes: 0,
      comments: 0,
      shares: count(m.SAVE),
      impressions: optionalCount(m.IMPRESSION),
      saves: optionalCount(m.SAVE),
      clicks: optionalCount((m.PIN_CLICK ?? 0) + (m.OUTBOUND_CLICK ?? 0)),
      raw: { summary: m },
    };
  },
};
