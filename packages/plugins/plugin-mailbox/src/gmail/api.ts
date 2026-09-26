/**
 * Google OAuth + Gmail REST API with native `fetch` (fixed Google hosts),
 * a timeout and an injectable fetch for tests. The sync never asks for
 * bodies: `format=metadata` for headers, and a parts-only partial response
 * (no `data`) when a message may carry attachments.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];
export const GMAIL_MODIFY_SCOPE = GMAIL_SCOPES[0]!;
export const GMAIL_SEND_SCOPE = GMAIL_SCOPES[1]!;
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_UPLOAD_API = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

/** Headers the sync reads. Nothing else of a message leaves Gmail during sync. */
export const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "Content-Type",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "X-Failed-Recipients",
];

/** Partial-response mask for attachment names: part tree without any `data`. */
const PART_FIELDS = "partId,filename,mimeType,body(attachmentId,size)";
export const PARTS_MASK = `id,payload(${PART_FIELDS},parts(${PART_FIELDS},parts(${PART_FIELDS},parts(${PART_FIELDS}))))`;
/** For delivery failure notices: the part tree plus part headers (the bounced message's headers), still no `data`. */
const REPORT_FIELDS = `${PART_FIELDS},headers(name,value)`;
export const REPORT_MASK = `id,payload(${PART_FIELDS},parts(${REPORT_FIELDS},parts(${REPORT_FIELDS},parts(${REPORT_FIELDS}))))`;

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The grant no longer works; a person must reconnect. */
    readonly reconnect: boolean,
    /** Worth retrying later (rate limit, 5xx, timeout). */
    readonly retryable: boolean,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export function buildGoogleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; loginHint?: string | null }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function timed(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs = 25_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new GmailApiError(`Google did not answer within ${Math.round(timeoutMs / 1000)} s`, 504, false, true);
    throw new GmailApiError(`Could not reach Google: ${error instanceof Error ? error.message : String(error)}`, 0, false, true);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function errorDetail(body: Record<string, unknown>, status: number): { message: string; reason: string | null } {
  const err = body.error;
  if (typeof err === "string") {
    return { message: `${err}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}`, reason: err };
  }
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; status?: unknown; errors?: Array<{ reason?: unknown }> };
    const reason = typeof e.errors?.[0]?.reason === "string" ? String(e.errors[0].reason) : typeof e.status === "string" ? e.status : null;
    return { message: typeof e.message === "string" ? e.message : `HTTP ${status}`, reason };
  }
  return { message: `HTTP ${status}`, reason: null };
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

async function tokenRequest(fetchImpl: FetchLike, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await timed(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJson(res);
  if (!res.ok) {
    const { message, reason } = errorDetail(body, res.status);
    const reconnect = body.error === "invalid_grant" || body.error === "unauthorized_client" || body.error === "invalid_client" || res.status === 401;
    throw new GmailApiError(`Google token request failed: ${message}`, res.status, reconnect, !reconnect && res.status >= 500, reason);
  }
  return body;
}

function tokensFrom(body: Record<string, unknown>, fallbackRefresh: string | null, now: number): GoogleTokens {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new GmailApiError("Google returned no access token", 502, false, true);
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

export async function exchangeGoogleCode(
  fetchImpl: FetchLike,
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  now = Date.now(),
): Promise<GoogleTokens> {
  const body = await tokenRequest(fetchImpl, {
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  return tokensFrom(body, null, now);
}

export async function refreshGoogleToken(
  fetchImpl: FetchLike,
  input: { clientId: string; clientSecret: string; refreshToken: string },
  now = Date.now(),
): Promise<GoogleTokens> {
  const body = await tokenRequest(fetchImpl, {
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
  });
  return tokensFrom(body, input.refreshToken, now);
}

export function tokenNeedsRefresh(tokens: Pick<GoogleTokens, "expiresAt">, now = Date.now()): boolean {
  return !tokens.expiresAt || tokens.expiresAt - 120_000 <= now;
}

type Query = Record<string, string | number | boolean | string[] | null | undefined>;

function withQuery(url: string, query?: Query): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function gmail(
  fetchImpl: FetchLike,
  accessToken: string,
  method: string,
  path: string,
  options: { query?: Query; body?: unknown; base?: string; rawBody?: string; contentType?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const url = withQuery(`${options.base ?? GMAIL_API}${path}`, options.query);
  const hasJson = options.body !== undefined;
  const res = await timed(
    fetchImpl,
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(hasJson ? { "Content-Type": "application/json" } : {}),
        ...(options.contentType ? { "Content-Type": options.contentType } : {}),
      },
      body: options.rawBody ?? (hasJson ? JSON.stringify(options.body) : undefined),
    },
    options.timeoutMs,
  );
  const json = await readJson(res);
  if (!res.ok) {
    const { message, reason } = errorDetail(json, res.status);
    const insufficient = res.status === 403 && /insufficient|scope/i.test(`${message} ${reason ?? ""}`);
    const rateLimited = res.status === 429 || (res.status === 403 && /rate|quota|limit/i.test(`${reason ?? ""} ${message}`));
    throw new GmailApiError(`Gmail: ${message}`, res.status, res.status === 401 || insufficient, rateLimited || res.status >= 500, reason);
  }
  return json;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export async function getProfile(fetchImpl: FetchLike, token: string): Promise<GmailProfile> {
  const body = await gmail(fetchImpl, token, "GET", "/profile");
  return { emailAddress: String(body.emailAddress ?? "").toLowerCase(), historyId: String(body.historyId ?? "") };
}

export interface HistoryPage {
  added: Array<{ id: string; threadId: string }>;
  labelChanges: Array<{ id: string; labelIds: string[] }>;
  lastRecordId: string | null;
  historyId: string;
  nextPageToken: string | null;
}

/** One page of `users.history.list`. A 404 means the cursor is too old: resync. */
export async function listHistory(fetchImpl: FetchLike, token: string, startHistoryId: string, pageToken?: string | null, maxResults = 100): Promise<HistoryPage> {
  const body = await gmail(fetchImpl, token, "GET", "/history", {
    query: {
      startHistoryId,
      historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
      maxResults,
      pageToken: pageToken ?? null,
    },
  });
  const added: HistoryPage["added"] = [];
  const labelChanges: HistoryPage["labelChanges"] = [];
  let lastRecordId: string | null = null;
  for (const record of Array.isArray(body.history) ? (body.history as Array<Record<string, unknown>>) : []) {
    if (record.id != null) lastRecordId = String(record.id);
    for (const item of Array.isArray(record.messagesAdded) ? (record.messagesAdded as Array<{ message?: Record<string, unknown> }>) : []) {
      const m = item.message;
      if (m && typeof m.id === "string") added.push({ id: m.id, threadId: String(m.threadId ?? m.id) });
    }
    for (const key of ["labelsAdded", "labelsRemoved"]) {
      for (const item of Array.isArray(record[key]) ? (record[key] as Array<{ message?: Record<string, unknown> }>) : []) {
        const m = item.message;
        if (m && typeof m.id === "string" && Array.isArray(m.labelIds)) labelChanges.push({ id: m.id, labelIds: (m.labelIds as unknown[]).map(String) });
      }
    }
  }
  return {
    added,
    labelChanges,
    lastRecordId,
    historyId: String(body.historyId ?? lastRecordId ?? startHistoryId),
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
  };
}

export async function listMessages(
  fetchImpl: FetchLike,
  token: string,
  q: string,
  options: { pageToken?: string | null; maxResults?: number } = {},
): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken: string | null }> {
  const body = await gmail(fetchImpl, token, "GET", "/messages", {
    query: { q, maxResults: options.maxResults ?? 100, pageToken: options.pageToken ?? null },
  });
  const messages = (Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [])
    .filter((m) => typeof m.id === "string")
    .map((m) => ({ id: String(m.id), threadId: String(m.threadId ?? m.id) }));
  return { messages, nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null };
}

export interface GmailPart {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string | null;
  historyId: string | null;
  payload: GmailPart | null;
}

function toMessage(body: Record<string, unknown>): GmailMessage {
  return {
    id: String(body.id ?? ""),
    threadId: String(body.threadId ?? body.id ?? ""),
    labelIds: Array.isArray(body.labelIds) ? (body.labelIds as unknown[]).map(String) : [],
    snippet: typeof body.snippet === "string" ? body.snippet : "",
    internalDate: body.internalDate != null ? String(body.internalDate) : null,
    historyId: body.historyId != null ? String(body.historyId) : null,
    payload: body.payload && typeof body.payload === "object" ? (body.payload as GmailPart) : null,
  };
}

export async function getMessageMetadata(fetchImpl: FetchLike, token: string, id: string, headers = METADATA_HEADERS): Promise<GmailMessage> {
  const body = await gmail(fetchImpl, token, "GET", `/messages/${encodeURIComponent(id)}`, {
    query: { format: "metadata", metadataHeaders: headers },
  });
  return toMessage(body);
}

/** Part tree with file names, types and sizes; the mask leaves out every `data` field. */
export async function getMessageParts(fetchImpl: FetchLike, token: string, id: string, mask = PARTS_MASK): Promise<GmailPart | null> {
  const body = await gmail(fetchImpl, token, "GET", `/messages/${encodeURIComponent(id)}`, {
    query: { format: "full", fields: mask },
  });
  return body.payload && typeof body.payload === "object" ? (body.payload as GmailPart) : null;
}

/** Whole message, for reading a body on demand (never in the sync job). */
export async function getMessageFull(fetchImpl: FetchLike, token: string, id: string): Promise<GmailMessage> {
  return toMessage(await gmail(fetchImpl, token, "GET", `/messages/${encodeURIComponent(id)}`, { query: { format: "full" } }));
}

/** Message-ID and References of every message in a thread (oldest first), for follow-ups. */
export async function getThreadMetadata(fetchImpl: FetchLike, token: string, threadId: string): Promise<GmailMessage[]> {
  const body = await gmail(fetchImpl, token, "GET", `/threads/${encodeURIComponent(threadId)}`, {
    query: { format: "metadata", metadataHeaders: ["Message-ID", "References"] },
  });
  return (Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []).map(toMessage);
}

export interface GmailLabel {
  id: string;
  name: string;
}

export async function listLabels(fetchImpl: FetchLike, token: string): Promise<GmailLabel[]> {
  const body = await gmail(fetchImpl, token, "GET", "/labels");
  return (Array.isArray(body.labels) ? (body.labels as Array<Record<string, unknown>>) : [])
    .filter((l) => typeof l.id === "string" && typeof l.name === "string")
    .map((l) => ({ id: String(l.id), name: String(l.name) }));
}

export async function createLabel(fetchImpl: FetchLike, token: string, name: string): Promise<GmailLabel> {
  const body = await gmail(fetchImpl, token, "POST", "/labels", {
    body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return { id: String(body.id ?? ""), name: String(body.name ?? name) };
}

export async function batchModify(fetchImpl: FetchLike, token: string, ids: string[], add: string[], remove: string[] = []): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    await gmail(fetchImpl, token, "POST", "/messages/batchModify", {
      body: { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove },
    });
  }
}

export async function modifyMessage(fetchImpl: FetchLike, token: string, id: string, add: string[], remove: string[] = []): Promise<string[]> {
  const body = await gmail(fetchImpl, token, "POST", `/messages/${encodeURIComponent(id)}/modify`, {
    body: { addLabelIds: add, removeLabelIds: remove },
  });
  return Array.isArray(body.labelIds) ? (body.labelIds as unknown[]).map(String) : [];
}

/** JSON `raw` up to this size; larger messages go through the upload endpoint (35 MB limit). */
export const RAW_JSON_LIMIT = 4_500_000;

export async function sendRaw(
  fetchImpl: FetchLike,
  token: string,
  mime: string,
  threadId?: string | null,
): Promise<{ id: string; threadId: string; labelIds: string[] }> {
  const raw = Buffer.from(mime, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let body: Record<string, unknown>;
  if (raw.length <= RAW_JSON_LIMIT) {
    body = await gmail(fetchImpl, token, "POST", "/messages/send", {
      body: threadId ? { raw, threadId } : { raw },
      timeoutMs: 60_000,
    });
  } else {
    const boundary = `pib_upload_${Math.random().toString(36).slice(2)}`;
    const multipartBody = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(threadId ? { threadId } : {}),
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "",
      mime,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    body = await gmail(fetchImpl, token, "POST", "/messages/send", {
      base: GMAIL_UPLOAD_API,
      query: { uploadType: "multipart" },
      rawBody: multipartBody,
      contentType: `multipart/related; boundary=${boundary}`,
      timeoutMs: 120_000,
    });
  }
  return {
    id: String(body.id ?? ""),
    threadId: String(body.threadId ?? ""),
    labelIds: Array.isArray(body.labelIds) ? (body.labelIds as unknown[]).map(String) : [],
  };
}
