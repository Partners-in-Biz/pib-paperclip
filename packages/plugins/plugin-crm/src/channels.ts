/**
 * Which channel a visit or a lead came from (audit Q10-8, Q1a-14): pure, no database.
 *
 * One classifier for everything that reads attribution: the lead form's campaign tags, the site events
 * snippet and the report. A visit is described by what the browser told us (campaign tags, the referring
 * site, an ad click id); the rules below are the usual ones, in this order, so the first match wins:
 *
 * 1. the campaign medium says what it is (cpc, email, social, organic, referral);
 * 2. an ad click id (Google `gclid`, Microsoft `msclkid`) means paid;
 * 3. the campaign source names a known search engine, social network or email tool;
 * 4. the referring site: a search engine, a social network, a webmail, any other site (referral);
 * 5. a Facebook click id with nothing else is social (it cannot tell an ad from a post);
 * 6. some other campaign tag we do not know is `other`;
 * 7. nothing at all is `direct`.
 *
 * `unattributed` is not a channel a visit can have: it is the bucket for money or leads with no touch on record.
 */

export const CHANNELS = ["organic_search", "social", "email", "paid", "referral", "direct", "other"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Leads and revenue with no touch on record (a contact added by hand, a lead from before the form, a sale with no capture). */
export const UNATTRIBUTED = "unattributed" as const;
export type ChannelOrUnattributed = Channel | typeof UNATTRIBUTED;

export const CHANNEL_LABELS: Record<ChannelOrUnattributed, string> = {
  organic_search: "Organic search",
  social: "Social media",
  email: "Email",
  paid: "Paid",
  referral: "Referral",
  direct: "Direct",
  other: "Other",
  unattributed: "Unattributed",
};

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

/** What a visit is described by. Every part is optional; the click ids are only "was there one". */
export interface Touch {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  /** The host of the referring page (`www.google.com`), never the whole address. */
  referrerHost?: string | null;
  /** `g` Google `gclid`, `m` Microsoft `msclkid`, `f` Facebook `fbclid`. */
  click?: "g" | "m" | "f" | null;
}

const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid[-_ ]?search|paid[-_ ]?social|paidsocial|display|cpm|cpv|banner|retargeting|remarketing|ads?)$/;
const EMAIL_MEDIUM = /^(e-?mail|newsletter|edm)$/;
const SOCIAL_MEDIUM = /^(social|social[-_ ]?network|social[-_ ]?media|sm|organic[-_ ]?social)$/;
const ORGANIC_MEDIUM = /^(organic|seo)$/;
const REFERRAL_MEDIUM = /^(referral|link|partner)$/;

const SEARCH_SOURCES = /^(google|bing|duckduckgo|yahoo|yandex|ecosia|startpage|brave|baidu|qwant|ask|aol|naver|seznam)$/;
const SOCIAL_SOURCES = /^(facebook|fb|instagram|ig|linkedin|twitter|x|tiktok|pinterest|youtube|reddit|threads|bluesky|whatsapp|telegram|snapchat|tumblr|quora)$/;
const EMAIL_SOURCES = /^(newsletter|e-?mail|mailchimp|sendgrid|klaviyo|mailerlite|campaign[-_ ]?monitor|brevo|sendinblue|activecampaign|convertkit|resend)$/;

const WEBMAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.proton\.me|webmail\.[a-z0-9.-]+)$/;
const SEARCH_HOSTS = /(^|\.)((google|bing|yahoo|yandex|ecosia|startpage|baidu|qwant|naver|seznam|aol|ask)\.[a-z.]{2,}|duckduckgo\.com|search\.brave\.com)$/;
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linkedin\.com|lnkd\.in|twitter\.com|t\.co|x\.com|tiktok\.com|pinterest\.[a-z.]{2,}|youtube\.com|youtu\.be|reddit\.com|threads\.net|bsky\.app|whatsapp\.com|wa\.me|telegram\.org|t\.me|snapchat\.com|tumblr\.com|quora\.com)$/;
/** Google hosts that are not search (mail is handled first; these are tools, so a visit from them is a plain referral). */
const GOOGLE_TOOLS = /^(docs|drive|sites|calendar|meet|maps|photos|play|accounts|translate|classroom)\./;

/** The bare host of an address or a host (`https://www.Acme.co.za/x` and `ACME.co.za` both give `acme.co.za`), or null. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  let host = text;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return host && /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : null;
}

function isOwn(host: string, ownHosts: readonly string[]): boolean {
  return ownHosts.some((own) => host === own || host.endsWith(`.${own}`));
}

const clean = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/** The channel of one touch. `ownHosts` are the client's own sites: a visit referred by its own site is not a referral. */
export function classifyChannel(touch: Touch, ownHosts: readonly string[] = []): Channel {
  const medium = clean(touch.medium);
  const source = clean(touch.source);
  const referrer = hostOf(touch.referrerHost);
  const external = referrer && !isOwn(referrer, ownHosts) ? referrer : null;

  if (medium) {
    if (PAID_MEDIUM.test(medium)) return "paid";
    if (EMAIL_MEDIUM.test(medium)) return "email";
    if (SOCIAL_MEDIUM.test(medium)) return "social";
    if (ORGANIC_MEDIUM.test(medium)) return "organic_search";
    if (REFERRAL_MEDIUM.test(medium)) return "referral";
  }
  if (touch.click === "g" || touch.click === "m") return "paid";
  if (source) {
    if (SEARCH_SOURCES.test(source) && !medium) return "organic_search";
    if (SOCIAL_SOURCES.test(source)) return "social";
    if (EMAIL_SOURCES.test(source)) return "email";
  }
  if (external) {
    if (WEBMAIL_HOSTS.test(external)) return "email";
    if (SEARCH_HOSTS.test(external) && !GOOGLE_TOOLS.test(external)) return "organic_search";
    if (SOCIAL_HOSTS.test(external)) return "social";
    return "referral";
  }
  if (touch.click === "f") return "social";
  if (medium || source || clean(touch.campaign)) return "other";
  return "direct";
}

/** The touch the lead form stored, from its flat attribution fields (`utmSource`, `gclid`, `referrer`...). Null when there is nothing to classify. */
export function touchFromAttribution(attr: Record<string, unknown>, prefix: "" | "ft" | "lt" = ""): Touch | null {
  const read = (name: string): string | null => {
    const key = prefix ? `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}` : name;
    const value = attr[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  if (prefix) {
    const click = read("click");
    const touch: Touch = { source: read("source"), medium: read("medium"), campaign: read("campaign"), referrerHost: hostOf(read("referrer")), click: click === "g" || click === "m" || click === "f" ? click : null };
    return touch.source || touch.medium || touch.campaign || touch.referrerHost || touch.click ? touch : null;
  }
  const touch: Touch = {
    source: typeof attr.utmSource === "string" ? attr.utmSource : null,
    medium: typeof attr.utmMedium === "string" ? attr.utmMedium : null,
    campaign: typeof attr.utmCampaign === "string" ? attr.utmCampaign : null,
    referrerHost: hostOf(typeof attr.referrer === "string" ? attr.referrer : null),
    click: attr.gclid ? "g" : attr.fbclid ? "f" : null,
  };
  return touch.source || touch.medium || touch.campaign || touch.referrerHost || touch.click ? touch : null;
}

/** What a stored lead says about where it came from: the visit it came on (the form always has one), and the persisted first and last touch when the visitor allowed it. */
export interface LeadTouches {
  /** The channel of the first touch, or null when the lead carries nothing at all (it is unattributed). */
  first: Channel | null;
  last: Channel | null;
  /** `persisted` when the first and last touch come from the visitor's remembered visits (consent), `visit` when both are the one visit the form saw. */
  basis: "persisted" | "visit" | "none";
  campaign: string | null;
}

/** First- and last-touch channels of a lead from its stored attribution. Without remembered visits both are the visit's. */
export function leadTouches(attr: Record<string, unknown>, ownHosts: readonly string[] = []): LeadTouches {
  const visit = touchFromAttribution(attr);
  const first = touchFromAttribution(attr, "ft");
  const last = touchFromAttribution(attr, "lt");
  // A landing page address with no referrer and no tags is still a direct visit: the form was reached, so a visit existed.
  const hasVisit = Boolean(visit) || typeof attr.landingUrl === "string" || typeof attr.pageUrl === "string";
  if (first || last) {
    const f = first ?? last ?? visit;
    const l = last ?? first ?? visit;
    return { first: f ? classifyChannel(f, ownHosts) : "direct", last: l ? classifyChannel(l, ownHosts) : "direct", basis: "persisted", campaign: campaignOf(first ?? visit) };
  }
  if (!visit) return hasVisit ? { first: "direct", last: "direct", basis: "visit", campaign: null } : { first: null, last: null, basis: "none", campaign: null };
  const channel = classifyChannel(visit, ownHosts);
  return { first: channel, last: channel, basis: "visit", campaign: campaignOf(visit) };
}

function campaignOf(touch: Touch | null): string | null {
  const text = touch?.campaign?.trim();
  return text ? text.slice(0, 60) : null;
}

/** The channel a lead from another source (a social DM, an inbound email) belongs to. Anything else has none on record. */
export function channelOfSource(source: string | null | undefined): Channel | null {
  if (source === "social") return "social";
  if (source === "email") return "direct";
  return null;
}
