/**
 * The settings of a newsletter lead source (intake newsletter, plan PAR-10817 "Validation when a source is written"),
 * checked when a tool writes them and again before each confirmation mail is sent. `confirm_secret` is not one of
 * them: the plugin makes it, and no caller sets or reads it.
 */
import { CrmError } from "./domain.js";
import { cleanText, isValidEmail, LIMITS } from "./lead-form.js";

/** The newsletter settings a tool takes. Any other intake refuses them. */
export const NEWSLETTER_PARAMS = ["applyTags", "confirmUrl", "confirmFrom", "confirmDailyCap"] as const;
export const MAX_APPLY_TAGS = 5;
export const MAX_TAG_LENGTH = 60;
export const DEFAULT_CONFIRM_DAILY_CAP = 300;
export const MAX_CONFIRM_DAILY_CAP = 5_000;
/** A newsletter source's per-hour bucket (plan PAR-10817, Limits): 100 an hour for signed calls. */
export const NEWSLETTER_RATE_LIMIT_PER_HOUR = 20;

export const CONFIRM_SECRET_REFUSED = "The confirmation-link secret is made by the plugin and is never set or shown. To replace it, run rotate-lead-key with newConfirmKey true.";

/** Refuses a call that names the confirmation-link secret in any spelling (confirmSecret, confirm_secret, ...). */
export function refuseConfirmSecret(params: Record<string, unknown>): void {
  if (Object.keys(params).some((key) => key.replace(/[^a-z]/gi, "").toLowerCase() === "confirmsecret")) throw new CrmError(CONFIRM_SECRET_REFUSED);
}

export function newsletterParamsIn(params: Record<string, unknown>): string[] {
  return NEWSLETTER_PARAMS.filter((key) => key in params && params[key] != null);
}

/** `confirm_url`: https, host exactly the host of the source's site, no userinfo, port, query or fragment. */
export function checkConfirmUrl(value: unknown, siteUrl: string | null): string {
  if (typeof value !== "string" || !value.trim()) throw new CrmError("confirmUrl is required for a newsletter form: the https page on the site that the confirmation link opens");
  const raw = value.trim();
  if (raw.length > LIMITS.url) throw new CrmError(`confirmUrl is longer than ${LIMITS.url} characters`);
  const bad = (why: string) => new CrmError(`confirmUrl ${why}: give the page as https://<the site's host>/<path>, e.g. https://example.co.za/subscribe/confirm`);
  if (!/^https:\/\//i.test(raw)) throw bad("must start with https://");
  // Read off the raw text as well: the URL parser drops a default port (:443) and an empty query or fragment.
  const authority = raw.slice("https://".length).split(/[/?#\\]/)[0] ?? "";
  if (authority.includes("@")) throw bad("must not carry a user name or password");
  if (authority.includes(":")) throw bad("must not name a port");
  if (raw.includes("?")) throw bad("must not have a query (?...)");
  if (raw.includes("#")) throw bad("must not have a fragment (#...)");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad("is not a web address");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw bad("must be a plain https page");
  let siteHost: string | null = null;
  try {
    siteHost = siteUrl ? new URL(siteUrl).hostname : null;
  } catch {
    siteHost = null;
  }
  if (!siteHost) throw new CrmError("A newsletter form needs its site (siteId or siteUrl): the confirmation page must be on that site");
  if (url.hostname !== siteHost) throw bad(`must be on ${siteHost} exactly (not another host or a subdomain)`);
  return url.toString();
}

/** `confirm_from`: one valid address. */
export function checkConfirmFrom(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new CrmError("confirmFrom is required for a newsletter form: the one address the confirmation mail is sent from");
  const address = value.trim();
  if (!isValidEmail(address)) throw new CrmError("confirmFrom must be one email address, e.g. hello@example.co.za (no name, no list)");
  return address;
}

/** `apply_tags`: 1 to 5 tags of 1 to 60 characters; a repeat (any case) counts once. */
export function checkApplyTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new CrmError(`applyTags is required for a newsletter form: 1 to ${MAX_APPLY_TAGS} tags a confirmed subscriber receives`);
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new CrmError("applyTags must be a list of text tags");
    if (entry.trim().length > MAX_TAG_LENGTH) throw new CrmError(`Each tag in applyTags is at most ${MAX_TAG_LENGTH} characters`);
    const tag = cleanText(entry, MAX_TAG_LENGTH);
    if (!tag) throw new CrmError("applyTags must not hold an empty tag");
    if (!tags.some((seen) => seen.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  if (tags.length > MAX_APPLY_TAGS) throw new CrmError(`applyTags takes at most ${MAX_APPLY_TAGS} tags`);
  return tags;
}

export function checkConfirmDailyCap(value: unknown): number {
  if (value == null || value === "") return DEFAULT_CONFIRM_DAILY_CAP;
  const cap = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > MAX_CONFIRM_DAILY_CAP) throw new CrmError(`confirmDailyCap must be a whole number from 1 to ${MAX_CONFIRM_DAILY_CAP}`);
  return cap;
}

export interface NewsletterSettings {
  applyTags: string[];
  confirmUrl: string;
  confirmFrom: string;
  confirmDailyCap: number;
}

/** Every newsletter setting a new source needs, checked against the source's site. */
export function newsletterSettingsOf(params: Record<string, unknown>, siteUrl: string | null): NewsletterSettings {
  return {
    applyTags: checkApplyTags(params.applyTags),
    confirmUrl: checkConfirmUrl(params.confirmUrl, siteUrl),
    confirmFrom: checkConfirmFrom(params.confirmFrom),
    confirmDailyCap: checkConfirmDailyCap(params.confirmDailyCap),
  };
}
