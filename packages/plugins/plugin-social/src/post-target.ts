/**
 * Reply and quote targets on a draft (`replyToUrl`, `quoteUrl`) and the
 * internal `note`. X is the only platform that publishes a target today.
 */
import { SocialError } from "./domain.js";

/** A string param, trimmed. Not imported from service.ts: the X provider imports this file. */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SocialError(`${key} must be text`);
  return value.trim();
}

export interface TweetRef {
  id: string;
  /** The author handle from the URL, without "@". Null for /i/web/status links. */
  handle: string | null;
  /** The canonical x.com link. */
  url: string;
}

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

/** The tweet an x.com / twitter.com status link points at, or null when it is not one. */
export function parseTweetUrl(raw: string): TweetRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!X_HOSTS.has(url.hostname.toLowerCase().replace(/^www\./, ""))) return null;
  const match = /^\/(?:([A-Za-z0-9_]{1,15})|i\/web)\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  const handle = match[1] ?? null;
  return { id: match[2]!, handle, url: `https://x.com/${handle ?? "i/web"}/status/${match[2]}` };
}

export const MAX_NOTE_LENGTH = 500;

export interface TargetFields {
  reply_to_url?: string | null;
  quote_url?: string | null;
}

function targetParam(params: Record<string, unknown>, key: "replyToUrl" | "quoteUrl"): string | null | undefined {
  if (params[key] === undefined) return undefined;
  const value = optionalString(params, key);
  if (value == null || value === "") return null;
  const ref = parseTweetUrl(value);
  if (!ref) throw new SocialError(`${key} must be an x.com post link like https://x.com/<handle>/status/<id>. Only X replies and quotes are supported.`);
  return ref.url;
}

/** The reply, quote and note a create or update call sets. `undefined` = not passed (keep), `null` = cleared. */
export function targetFromParams(params: Record<string, unknown>): { replyToUrl?: string | null; quoteUrl?: string | null; note?: string | null } {
  const replyToUrl = targetParam(params, "replyToUrl");
  const quoteUrl = targetParam(params, "quoteUrl");
  if (replyToUrl && quoteUrl) throw new SocialError("A post is either a reply (replyToUrl) or a quote (quoteUrl), not both.");
  let note: string | null | undefined;
  if (params.note !== undefined) {
    note = optionalString(params, "note")?.trim() || null;
    if (note && note.length > MAX_NOTE_LENGTH) throw new SocialError(`note is at most ${MAX_NOTE_LENGTH} characters`);
  }
  return { replyToUrl, quoteUrl, note };
}
