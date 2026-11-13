/**
 * The settings of a newsletter lead source (intake `newsletter`, double opt-in), checked whenever a
 * source is written (plan PAR-10817, "Validation when a source is written"). Pure: no database, no context.
 * The confirmation-link secret is never a setting: the plugin makes it, and no caller can pass or read it.
 */
import { CrmError } from "./domain.js";
import { cleanText, isValidEmail } from "./lead-form.js";
import { DEFAULT_CONFIRM_DAILY_CAP } from "./lead-store.js";
import { MAX_CONFIRM_URL_LENGTH } from "./newsletter-token.js";

/** `confirmUrl` is short enough that `confirmUrl#t=<token>` stays under the link limit of the token module. */
export const NEWSLETTER_LIMITS = { tags: 5, tagLength: 60, confirmUrl: MAX_CONFIRM_URL_LENGTH, dailyCap: 300 } as const;

/** The tool parameters only a newsletter source has. */
export const NEWSLETTER_PARAMS = ["applyTags", "confirmUrl", "confirmFrom", "confirmDailyCap"] as const;

export interface NewsletterSettings {
  applyTags: string[];
  confirmUrl: string | null;
  confirmFrom: string | null;
  confirmDailyCap: number;
}

/** The settings of every source that is not a newsletter (the CHECK `lead_sources_newsletter` wants them empty). */
export const NO_NEWSLETTER: NewsletterSettings = { applyTags: [], confirmUrl: null, confirmFrom: null, confirmDailyCap: DEFAULT_CONFIRM_DAILY_CAP };

const given = (params: Record<string, unknown>, key: string) => key in params && params[key] != null && params[key] !== "";

/** Refuses a call that tries to set the confirmation-link secret, in any spelling. */
export function refuseConfirmSecret(params: Record<string, unknown>): void {
  if (given(params, "confirmSecret") || given(params, "confirm_secret")) {
    throw new CrmError("confirmSecret is made by the plugin and is never set or shown. rotate-lead-key with newConfirmKey true replaces it.");
  }
}

/** Refuses newsletter settings on a source that is not a newsletter. */
export function refuseNewsletterParams(params: Record<string, unknown>, intake: string): void {
  const extra = NEWSLETTER_PARAMS.filter((key) => given(params, key));
  if (extra.length) throw new CrmError(`${extra.join(", ")} belong to a newsletter form (intake newsletter); this form's intake is ${intake}`);
}

/** 1 to 5 tags of 1 to 60 characters, duplicates (case-insensitive) removed. */
export function parseApplyTags(value: unknown): string[] {
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) throw new CrmError("applyTags must be a list of tags, e.g. [\"remotesaffa-subscribers\"]");
  const tags: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") throw new CrmError("applyTags must be a list of text tags");
    const tag = raw.trim();
    if (!tag || tag.length > NEWSLETTER_LIMITS.tagLength || cleanText(tag, NEWSLETTER_LIMITS.tagLength) !== tag) {
      throw new CrmError(`Each tag in applyTags is 1 to ${NEWSLETTER_LIMITS.tagLength} characters on one line`);
    }
    if (!tags.some((seen) => seen.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  if (tags.length < 1 || tags.length > NEWSLETTER_LIMITS.tags) throw new CrmError(`applyTags takes 1 to ${NEWSLETTER_LIMITS.tags} tags`);
  return tags;
}

/** An https page on exactly the host of the source's site: no other host or subdomain, no userinfo, port, query or fragment. */
export function parseConfirmUrl(value: unknown, siteUrl: string | null): string {
  if (typeof value !== "string" || !value.trim()) throw new CrmError("confirmUrl is required: the https page on the form's site that confirms a signup");
  const raw = value.trim();
  if (!siteUrl) throw new CrmError("A newsletter form needs siteUrl (or siteId): confirmUrl must be on that site");
  let url: URL;
  let site: URL;
  try {
    url = new URL(raw);
    site = new URL(siteUrl);
  } catch {
    throw new CrmError("confirmUrl must be a full https address, e.g. https://example.co.za/subscribe/confirm");
  }
  if (raw.length > NEWSLETTER_LIMITS.confirmUrl) throw new CrmError(`confirmUrl is at most ${NEWSLETTER_LIMITS.confirmUrl} characters`);
  if (url.protocol !== "https:") throw new CrmError("confirmUrl must use https");
  if (url.username || url.password || /^https:\/\/[^/]*@/i.test(raw)) throw new CrmError("confirmUrl must not carry a user name or password");
  if (url.port || /^https:\/\/[^/?#]*:\d*(?:[/?#]|$)/i.test(raw)) throw new CrmError("confirmUrl must not name a port");
  if (raw.includes("?") || raw.includes("#")) throw new CrmError("confirmUrl must not carry a query (?) or a fragment (#): the link adds its own");
  if (url.hostname !== site.hostname) throw new CrmError(`confirmUrl must be on ${site.hostname} exactly (no other host or subdomain)`);
  return url.toString();
}

/** One valid address, lower-cased. */
export function parseConfirmFrom(value: unknown): string {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!address || !isValidEmail(address)) throw new CrmError("confirmFrom must be one email address, e.g. hello@example.co.za");
  return address;
}

/** 1 to 300 confirmation mails in 24 hours. */
export function parseDailyCap(value: unknown): number {
  const cap = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(cap) || cap < 1 || cap > NEWSLETTER_LIMITS.dailyCap) throw new CrmError(`confirmDailyCap is a whole number from 1 to ${NEWSLETTER_LIMITS.dailyCap}`);
  return cap;
}

/**
 * The newsletter settings after this call: `current` with whatever `params` changes, every field checked again
 * (a new site address must still match the stored confirmUrl). On a new source pass `current` null: tags, confirmUrl and confirmFrom are required.
 */
export function newsletterSettings(params: Record<string, unknown>, siteUrl: string | null, current: NewsletterSettings | null): NewsletterSettings {
  const applyTags = given(params, "applyTags") ? parseApplyTags(params.applyTags) : current ? parseApplyTags(current.applyTags) : parseApplyTags(undefined);
  const confirmUrl = parseConfirmUrl(given(params, "confirmUrl") ? params.confirmUrl : current?.confirmUrl, siteUrl);
  const confirmFrom = parseConfirmFrom(given(params, "confirmFrom") ? params.confirmFrom : current?.confirmFrom);
  const confirmDailyCap = given(params, "confirmDailyCap") ? parseDailyCap(params.confirmDailyCap) : current?.confirmDailyCap ?? DEFAULT_CONFIRM_DAILY_CAP;
  return { applyTags, confirmUrl, confirmFrom, confirmDailyCap };
}
