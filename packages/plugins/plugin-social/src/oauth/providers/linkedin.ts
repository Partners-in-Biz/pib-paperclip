/**
 * LinkedIn: OpenID sign-in, personal posting (w_member_social) and, when the
 * Community Management API is approved, organization pages. Uses the
 * versioned REST API (`/rest/posts`, `/rest/images`, `/rest/videos`).
 */
import { clip } from "../../domain.js";
import {
  downloadMedia,
  expiresAtFrom,
  getJson,
  guessMime,
  pollUntil,
  postForm,
  ProviderHttpError,
  PublishRejected,
  readJson,
  readText,
  request,
  str,
} from "../http.js";
import {
  scopesFor,
  type ConnectCandidate,
  type ExchangeResult,
  type MetricsSnapshot,
  type ProviderAccount,
  type ProviderEnv,
  type PublishOutcome,
  type PublishRequest,
  type SocialProvider,
} from "../types.js";
import { bestEffort, count, guard, images, requireCode, videos } from "./common.js";

const API = "https://api.linkedin.com";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

export const LINKEDIN_PERSONAL_SCOPES = ["openid", "profile", "email", "w_member_social"];
export const LINKEDIN_ORG_SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin"];

/**
 * LinkedIn-Version candidates: the configured one, else recent months
 * (LinkedIn supports each monthly version for at least a year).
 */
export function linkedinVersions(configured: string | undefined, now: Date = new Date()): string[] {
  const out: string[] = [];
  if (configured && /^\d{6}$/.test(configured.trim())) out.push(configured.trim());
  for (let back = 2; back <= 8; back += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const v = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

let workingVersion: string | null = null;
const deadVersions = new Set<string>();

function isVersionError(status: number, body: string): boolean {
  return status === 426 || (/version/i.test(body) && (status === 400 || status === 404));
}

/** Call the REST API: the configured version first, then the last one that worked, then recent months. */
async function li(env: ProviderEnv, token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const candidates = linkedinVersions(env.app.apiVersion);
  const ordered = env.app.apiVersion && /^\d{6}$/.test(env.app.apiVersion.trim())
    ? [candidates[0]!, ...(workingVersion ? [workingVersion] : []), ...candidates.slice(1)]
    : [...(workingVersion ? [workingVersion] : []), ...candidates];
  const versions = Array.from(new Set(ordered)).filter((v) => !deadVersions.has(v));
  let last: Response | null = null;
  for (const version of versions) {
    const res = await request(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "LinkedIn-Version": version,
        "X-Restli-Protocol-Version": "2.0.0",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.ok || !isVersionError(res.status, await res.clone().text().catch(() => ""))) {
      if (res.ok) workingVersion = version;
      return res;
    }
    if (res.status === 426) deadVersions.add(version);
    last = res;
  }
  if (!last) throw new Error("No active LinkedIn API version found; set platforms.linkedin.apiVersion to a current YYYYMM");
  return last;
}

async function liJson<T>(env: ProviderEnv, token: string, path: string, label: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return readJson<T>(await li(env, token, path, init), label);
}

/**
 * Escape LinkedIn "little text" reserved characters in commentary. `#` is
 * left alone so hashtags still render as hashtags.
 */
export function escapeLinkedInText(text: string): string {
  return text.replace(/([\\|{}@\[\]()<>*_~])/g, "\\$1");
}

function author(account: ProviderAccount): string {
  const urn = str(account.meta.authorUrn);
  if (urn) return urn;
  return account.externalId.startsWith("urn:li:") ? account.externalId : `urn:li:person:${account.externalId}`;
}

async function uploadImage(env: ProviderEnv, account: ProviderAccount, url: string): Promise<string> {
  const token = account.token.accessToken;
  const init = await liJson<{ value?: { uploadUrl?: string; image?: string } }>(env, token, "/rest/images?action=initializeUpload", "LinkedIn image upload", {
    method: "POST",
    body: { initializeUploadRequest: { owner: author(account) } },
  });
  const uploadUrl = init.value?.uploadUrl;
  const image = init.value?.image;
  if (!uploadUrl || !image) throw new Error("LinkedIn did not return an image upload URL");
  const file = await downloadMedia(url, { maxBytes: 36 * 1024 * 1024, fallbackMime: guessMime(url, "image") });
  const put = await request(uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": file.mime }, body: file.bytes });
  if (!put.ok) throw new ProviderHttpError(put.status, await readText(put), "LinkedIn image PUT");
  return image;
}

async function uploadVideo(env: ProviderEnv, account: ProviderAccount, url: string): Promise<string> {
  const token = account.token.accessToken;
  const file = await downloadMedia(url, { maxBytes: 500 * 1024 * 1024, fallbackMime: guessMime(url, "video") });
  const init = await liJson<{
    value?: { uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>; video?: string; uploadToken?: string };
  }>(env, token, "/rest/videos?action=initializeUpload", "LinkedIn video upload", {
    method: "POST",
    body: { initializeUploadRequest: { owner: author(account), fileSizeBytes: file.size, uploadCaptions: false, uploadThumbnail: false } },
  });
  const video = init.value?.video;
  const instructions = init.value?.uploadInstructions ?? [];
  if (!video || instructions.length === 0) throw new Error("LinkedIn did not return video upload instructions");
  const partIds: string[] = [];
  for (const part of instructions) {
    const chunk = file.bytes.slice(part.firstByte, part.lastByte + 1);
    const put = await request(part.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk, timeoutMs: 300_000 });
    if (!put.ok) throw new ProviderHttpError(put.status, await readText(put), "LinkedIn video PUT");
    const etag = put.headers.get("etag");
    if (etag) partIds.push(etag.replace(/"/g, ""));
  }
  const fin = await li(env, token, "/rest/videos?action=finalizeUpload", {
    method: "POST",
    body: { finalizeUploadRequest: { video, uploadToken: init.value?.uploadToken ?? "", uploadedPartIds: partIds } },
  });
  if (!fin.ok) throw new ProviderHttpError(fin.status, await readText(fin), "LinkedIn video finalize");
  await pollUntil<void>(async () => {
    const status = await liJson<{ status?: string }>(env, token, `/rest/videos/${encodeURIComponent(video)}`, "LinkedIn video status");
    if (status.status === "AVAILABLE") return { done: true, value: undefined };
    if (status.status === "PROCESSING_FAILED") throw new PublishRejected("LinkedIn could not process the video");
    return { done: false };
  }, { intervalMs: 5_000, timeoutMs: 180_000, label: "LinkedIn video processing" }).catch((error) => {
    // A video still processing can be posted; only a hard failure stops us.
    if (error instanceof PublishRejected) throw error;
  });
  return video;
}

async function linkedinPublish(env: ProviderEnv, account: ProviderAccount, req: PublishRequest): Promise<PublishOutcome> {
  const token = account.token.accessToken;
  const imgs = images(req.media);
  const vids = videos(req.media);
  if (vids.length > 1 || (vids.length && imgs.length)) throw new PublishRejected("A LinkedIn post takes one video or up to 20 images, not both");
  if (imgs.length > 20) throw new PublishRejected("A LinkedIn post takes up to 20 images");
  const body: Record<string, unknown> = {
    author: author(account),
    commentary: escapeLinkedInText(clip(req.text, 3000)),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (vids.length === 1) {
    const id = await uploadVideo(env, account, vids[0]!.url);
    body.content = { media: { id, title: req.title ?? clip(req.text, 200) } };
  } else if (imgs.length === 1) {
    const id = await uploadImage(env, account, imgs[0]!.url);
    body.content = { media: { id, altText: imgs[0]!.altText ?? undefined } };
  } else if (imgs.length > 1) {
    const ids: Array<{ id: string; altText?: string }> = [];
    for (const img of imgs) ids.push({ id: await uploadImage(env, account, img.url), altText: img.altText ?? undefined });
    body.content = { multiImage: { images: ids } };
  } else if (req.link) {
    body.content = { article: { source: req.link, title: req.title ?? req.link } };
  }
  const res = await li(env, token, "/rest/posts", { method: "POST", body });
  if (!res.ok) throw new ProviderHttpError(res.status, await readText(res), "LinkedIn post");
  const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
  if (!urn) throw new Error("LinkedIn did not return the post id");
  const detail: Record<string, unknown> = {};
  if (req.firstComment) {
    const comment = await bestEffort(async () => {
      const c = await li(env, token, `/rest/socialActions/${encodeURIComponent(urn)}/comments`, {
        method: "POST",
        body: { actor: author(account), object: urn, message: { text: escapeLinkedInText(req.firstComment!) } },
      });
      if (!c.ok) throw new ProviderHttpError(c.status, await readText(c), "LinkedIn first comment");
      return c.headers.get("x-restli-id");
    });
    if (comment.value) detail.firstCommentId = comment.value;
    if (comment.error) detail.firstCommentError = comment.error;
  }
  return { ok: true, externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/`, detail };
}

interface OrgAcl {
  organization?: string;
  role?: string;
  state?: string;
}

async function listOrganizations(env: ProviderEnv, token: string): Promise<Array<{ urn: string; id: string; name: string; vanity: string | null; logo: string | null }>> {
  const acl = await liJson<{ elements?: OrgAcl[] }>(env, token, "/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100", "LinkedIn organizations");
  const out: Array<{ urn: string; id: string; name: string; vanity: string | null; logo: string | null }> = [];
  const seen = new Set<string>();
  for (const el of acl.elements ?? []) {
    const urn = el.organization;
    if (!urn || seen.has(urn)) continue;
    if (el.role && !["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"].includes(el.role)) continue;
    seen.add(urn);
    const id = urn.split(":").pop() ?? urn;
    const org = await bestEffort(() => liJson<{ localizedName?: string; vanityName?: string }>(env, token, `/rest/organizations/${id}`, "LinkedIn organization"));
    out.push({ urn, id, name: org.value?.localizedName ?? `Organization ${id}`, vanity: org.value?.vanityName ?? null, logo: null });
  }
  return out;
}

export const linkedinProvider: SocialProvider = {
  platform: "linkedin",
  refreshKind: "refresh_token",
  defaultScopes: (env) => (env.linkedinOrgPages ? [...LINKEDIN_PERSONAL_SCOPES, ...LINKEDIN_ORG_SCOPES] : LINKEDIN_PERSONAL_SCOPES),
  authorize(env, state) {
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      state,
      scope: scopesFor(linkedinProvider, env).join(" "),
    });
    return { url: `https://www.linkedin.com/oauth/v2/authorization?${qs.toString()}` };
  },
  async exchange(env, params): Promise<ExchangeResult> {
    const code = requireCode(params, "LinkedIn");
    const data = await postForm<{ access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }>(TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: env.redirectUri,
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
    }, {}, "LinkedIn code exchange");
    if (!data.access_token) throw new Error("LinkedIn did not return an access token");
    const scopes = data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : scopesFor(linkedinProvider, env);
    const expiresAt = expiresAtFrom(data.expires_in);
    const token = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      refreshExpiresAt: expiresAtFrom(data.refresh_token_expires_in),
      scopes,
    };
    const me = await getJson<{ sub?: string; name?: string; picture?: string; email?: string }>(`${API}/v2/userinfo`, { Authorization: `Bearer ${data.access_token}` }, "LinkedIn profile");
    if (!me.sub) throw new Error("LinkedIn did not return the member id (openid scope missing?)");
    const personUrn = `urn:li:person:${me.sub}`;
    const candidates: ConnectCandidate[] = [{
      key: `person:${me.sub}`,
      platform: "linkedin",
      kind: "person",
      externalId: personUrn,
      displayName: me.name ?? "LinkedIn member",
      handle: me.email ?? null,
      avatarUrl: me.picture ?? null,
      token,
      expiresAt,
      scopes,
      meta: { authorUrn: personUrn, kind: "person" },
    }];
    if (env.linkedinOrgPages && scopes.some((s) => s.includes("organization"))) {
      const orgs = await bestEffort(() => listOrganizations(env, data.access_token!));
      for (const org of orgs.value ?? []) {
        candidates.push({
          key: `org:${org.id}`,
          platform: "linkedin",
          kind: "organization",
          externalId: org.urn,
          displayName: org.name,
          handle: org.vanity,
          avatarUrl: org.logo,
          token,
          expiresAt,
          scopes,
          meta: { authorUrn: org.urn, kind: "organization", memberUrn: personUrn },
        });
      }
    }
    return { candidates };
  },
  async refresh(env, account) {
    if (!account.token.refreshToken) throw new Error("LinkedIn did not issue a refresh token for this app; reconnect before the token expires");
    const data = await postForm<{ access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }>(TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: account.token.refreshToken,
      client_id: env.app.clientId,
      client_secret: env.app.clientSecret ?? "",
    }, {}, "LinkedIn token refresh");
    if (!data.access_token) throw new Error("LinkedIn did not return a refreshed token");
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
  publish: (env, account, req) => guard(() => linkedinPublish(env, account, req)),
  async metrics(env, account, externalId): Promise<MetricsSnapshot | null> {
    const data = await liJson<{
      likesSummary?: { totalLikes?: number };
      commentsSummary?: { totalFirstLevelComments?: number; aggregatedTotalComments?: number };
    }>(env, account.token.accessToken, `/rest/socialActions/${encodeURIComponent(externalId)}`, "LinkedIn social actions");
    return {
      views: 0,
      likes: count(data.likesSummary?.totalLikes),
      comments: count(data.commentsSummary?.aggregatedTotalComments ?? data.commentsSummary?.totalFirstLevelComments),
      shares: 0,
      raw: { socialActions: data },
    };
  },
};
