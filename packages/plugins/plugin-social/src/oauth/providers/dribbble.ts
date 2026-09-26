/** Dribbble v2: shots from one image. The upload scope needs Dribbble approval. */
import { clip } from "../../domain.js";
import { downloadMedia, getJson, guessMime, postForm, ProviderHttpError, PublishRejected, readText, request } from "../http.js";
import {
  scopesFor,
  type ExchangeResult,
  type ProviderAccount,
  type ProviderEnv,
  type PublishOutcome,
  type PublishRequest,
  type SocialProvider,
} from "../types.js";
import { guard, images, requireCode, videos } from "./common.js";

export const DRIBBBLE_SCOPES = ["public", "upload"];

async function dribbblePublish(_env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const imgs = images(req.media);
  if (videos(req.media).length || imgs.length !== 1) throw new PublishRejected("A Dribbble shot needs exactly one image");
  const file = await downloadMedia(imgs[0]!.url, { maxBytes: 8 * 1024 * 1024, fallbackMime: guessMime(imgs[0]!.url, "image") });
  const tags = Array.from(new Set((req.text.match(/#([\p{L}\p{N}_-]+)/gu) ?? []).map((t) => t.slice(1).toLowerCase()))).slice(0, 12);
  const form = new FormData();
  form.append("image", new Blob([file.bytes], { type: file.mime }), "shot");
  form.append("title", clip((req.title ?? req.text.split("\n")[0] ?? "Shot").trim() || "Shot", 100));
  form.append("description", req.text);
  for (const tag of tags) form.append("tags[]", tag);
  const res = await request("https://api.dribbble.com/v2/shots", { method: "POST", headers: { Authorization: `Bearer ${account.token.accessToken}` }, body: form, timeoutMs: 180_000 });
  if (res.status !== 202 && !res.ok) throw new ProviderHttpError(res.status, await readText(res), "Dribbble shot");
  const location = res.headers.get("location") ?? "";
  const id = location.split("/").filter(Boolean).pop();
  return { ok: true, externalId: id, url: id ? `https://dribbble.com/shots/${id}` : undefined, detail: { state: "processing" } };
}

export const dribbbleProvider: SocialProvider = {
  platform: "dribbble",
  refreshKind: "none",
  defaultScopes: () => DRIBBBLE_SCOPES,
  authorize(env, state) {
    const qs = new URLSearchParams({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      scope: scopesFor(dribbbleProvider, env).join(" "),
      state,
    });
    return { url: `https://dribbble.com/oauth/authorize?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "Dribbble");
    const data = await postForm<{ access_token?: string; scope?: string }>("https://dribbble.com/oauth/token", {
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
      code,
      redirect_uri: env.redirectUri,
    }, {}, "Dribbble code exchange");
    if (!data.access_token) throw new Error("Dribbble did not return an access token");
    const me = await getJson<{ id?: number; name?: string; login?: string; avatar_url?: string }>(
      "https://api.dribbble.com/v2/user",
      { Authorization: `Bearer ${data.access_token}` },
      "Dribbble profile",
    );
    if (!me.id) throw new Error("Dribbble did not return the account id");
    const scopes = data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : scopesFor(dribbbleProvider, env);
    return {
      candidates: [{
        key: `dribbble:${me.id}`,
        platform: "dribbble",
        kind: "profile",
        externalId: String(me.id),
        displayName: me.name ?? me.login ?? "Dribbble",
        handle: me.login ?? null,
        avatarUrl: me.avatar_url ?? null,
        token: { accessToken: data.access_token, expiresAt: null, scopes },
        expiresAt: null,
        scopes,
        meta: {},
      }],
    };
  },
  publish: (env, account, req) => guard(() => dribbblePublish(env, account, req)),
};
