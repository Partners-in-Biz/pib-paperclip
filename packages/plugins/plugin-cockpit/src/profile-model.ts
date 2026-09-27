/**
 * The company profile (pure: fields, labels and validation; no node imports,
 * shared by the worker and the Cockpit page). Owners edit it on the Cockpit's
 * Profile tab; agents read it with `company-profile` and may only fill empty
 * fields with `update-company-profile` (changing a set value is the owner's
 * call, asked with `ask-owner`).
 */

export type ProfileFieldKey =
  | "legalName"
  | "tradingName"
  | "vatNumber"
  | "address"
  | "website"
  | "bookingLink"
  | "senderName"
  | "senderEmail"
  | "whatWeSell"
  | "audience"
  | "brandVoice"
  | "bannedWords";

export type ProfileGroup = "identity" | "online" | "email" | "offer" | "voice";

export interface ProfileField {
  key: ProfileFieldKey;
  label: string;
  group: ProfileGroup;
  /** text: one line; long: a paragraph; url, email, vat: checked; list: words or phrases. */
  kind: "text" | "long" | "url" | "email" | "vat" | "list";
  max: number;
  /** For agents and the form: what goes in it. */
  hint: string;
  placeholder?: string;
}

export const PROFILE_FIELDS: ProfileField[] = [
  { key: "legalName", label: "Legal name", group: "identity", kind: "text", max: 200, hint: "As registered, for invoices, quotes and contracts.", placeholder: "Partners in Biz (Pty) Ltd" },
  { key: "tradingName", label: "Trading name", group: "identity", kind: "text", max: 200, hint: "The name clients know, for posts and emails.", placeholder: "Partners in Biz" },
  { key: "vatNumber", label: "VAT number", group: "identity", kind: "vat", max: 20, hint: "10 digits starting with 4. Leave empty when not VAT registered.", placeholder: "4123456789" },
  { key: "address", label: "Address", group: "identity", kind: "long", max: 500, hint: "Postal or physical address for invoices and email footers." },
  { key: "website", label: "Website", group: "online", kind: "url", max: 300, hint: "The main website.", placeholder: "https://example.co.za" },
  { key: "bookingLink", label: "Booking link", group: "online", kind: "url", max: 300, hint: "Where clients book a call or meeting; agents point leads here.", placeholder: "https://cal.com/…" },
  { key: "senderName", label: "Sender name", group: "email", kind: "text", max: 120, hint: "The name email goes out under.", placeholder: "Peet at Partners in Biz" },
  { key: "senderEmail", label: "Sender email", group: "email", kind: "email", max: 200, hint: "The address replies go to.", placeholder: "hello@example.co.za" },
  { key: "whatWeSell", label: "What we sell", group: "offer", kind: "long", max: 1000, hint: "Services or products, with prices or ranges when they are public." },
  { key: "audience", label: "Audience", group: "offer", kind: "long", max: 1000, hint: "Who the ideal clients are: industry, size, region, the problem they have." },
  { key: "brandVoice", label: "Brand voice", group: "voice", kind: "long", max: 1000, hint: "How we sound: tone, spelling (en-ZA), words we like, how formal." },
  { key: "bannedWords", label: "Banned words", group: "voice", kind: "list", max: 60, hint: "Words or phrases never to use, one per line or separated by commas." },
];

export const PROFILE_GROUPS: Array<{ key: ProfileGroup; title: string; description: string }> = [
  { key: "identity", title: "Who we are", description: "For invoices, quotes and email footers." },
  { key: "online", title: "Online", description: "Where people find and book us." },
  { key: "email", title: "Email", description: "Who outgoing email is from." },
  { key: "offer", title: "What we do", description: "What agents may say we sell, and to whom." },
  { key: "voice", title: "Brand voice", description: "How posts, emails and replies must sound." },
];

/** The fields the setup item needs before agents can write in the company's name. */
export const CORE_PROFILE_FIELDS: ProfileFieldKey[] = ["legalName", "website", "senderEmail", "whatWeSell", "brandVoice"];

/** At most this many banned words or phrases. */
export const BANNED_WORDS_MAX = 50;

export type CompanyProfile = Partial<Record<Exclude<ProfileFieldKey, "bannedWords">, string>> & { bannedWords?: string[] };

/** Who set each field last: a person on the Profile tab, or an agent with `update-company-profile`. */
export type FilledBy = Partial<Record<ProfileFieldKey, { by: "person" | "agent"; id: string | null; at: string }>>;

export class ProfileError extends Error {}

export function profileField(key: string): ProfileField | null {
  return PROFILE_FIELDS.find((field) => field.key === key) ?? null;
}

/** Banned words from a list, or text split on commas and new lines; trimmed, deduped (any case). */
export function parseWordList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,;]+/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const word = item.replace(/\s+/g, " ").trim();
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
  }
  return out;
}

/** `example.co.za` → `https://example.co.za`; null when it is not a web address. */
export function normalizeUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString().replace(/\/$/, url.pathname === "/" && !url.search && !url.hash ? "" : "/");
  } catch {
    return null;
  }
}

/**
 * One field's value, cleaned and checked. Empty input clears the field
 * (returns undefined). Throws ProfileError with a message for the form or
 * the agent.
 */
export function cleanField(key: ProfileFieldKey, value: unknown): string | string[] | undefined {
  const field = profileField(key);
  if (!field) throw new ProfileError(`Unknown profile field ${key}.`);
  if (field.kind === "list") {
    const words = parseWordList(value);
    if (words.length === 0) return undefined;
    if (words.length > BANNED_WORDS_MAX) throw new ProfileError(`${field.label}: at most ${BANNED_WORDS_MAX}, got ${words.length}.`);
    const long = words.find((word) => word.length > field.max);
    if (long) throw new ProfileError(`${field.label}: "${long.slice(0, 30)}…" is longer than ${field.max} characters.`);
    return words;
  }
  if (value !== undefined && value !== null && typeof value !== "string") throw new ProfileError(`${field.label} must be text.`);
  const text = field.kind === "long" ? (value ?? "").toString().replace(/\r\n?/g, "\n").trim() : (value ?? "").toString().replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length > field.max) throw new ProfileError(`${field.label} is ${text.length} characters; at most ${field.max}.`);
  if (field.kind === "url") {
    const url = normalizeUrl(text);
    if (!url) throw new ProfileError(`${field.label} must be a web address, e.g. https://example.co.za.`);
    return url;
  }
  if (field.kind === "email") {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) throw new ProfileError(`${field.label} must be an email address, e.g. hello@example.co.za.`);
    return text.toLowerCase();
  }
  if (field.kind === "vat") {
    const digits = text.replace(/[\s-]/g, "");
    if (!/^4\d{9}$/.test(digits)) throw new ProfileError(`${field.label}: a South African VAT number is 10 digits and starts with 4.`);
    return digits;
  }
  return text;
}

/** The profile from stored JSON (unknown keys and bad values dropped). */
export function parseProfile(value: unknown): CompanyProfile {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out: CompanyProfile = {};
  for (const field of PROFILE_FIELDS) {
    const raw = source[field.key];
    if (field.kind === "list") {
      const words = parseWordList(raw);
      if (words.length) out.bannedWords = words.slice(0, BANNED_WORDS_MAX);
    } else if (typeof raw === "string" && raw.trim()) {
      (out as Record<string, string>)[field.key] = raw;
    }
  }
  return out;
}

export function isFilled(profile: CompanyProfile, key: ProfileFieldKey): boolean {
  const value = profile[key];
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "";
}

export function missingFields(profile: CompanyProfile, keys: ProfileFieldKey[] = PROFILE_FIELDS.map((f) => f.key)): ProfileFieldKey[] {
  return keys.filter((key) => !isFilled(profile, key));
}

export function fieldLabels(keys: ProfileFieldKey[]): string {
  const labels = keys.map((key) => profileField(key)?.label.toLowerCase() ?? key);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function same(a: string | string[] | undefined, b: string | string[] | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = (Array.isArray(a) ? a : []).map((w) => w.toLowerCase()).sort().join("\n");
    const y = (Array.isArray(b) ? b : []).map((w) => w.toLowerCase()).sort().join("\n");
    return x === y;
  }
  return (a ?? "") === (b ?? "");
}

export interface FillResult {
  profile: CompanyProfile;
  filled: ProfileFieldKey[];
  unchanged: ProfileFieldKey[];
  /** Already set to something else: only the owner changes it. */
  kept: Array<{ field: ProfileFieldKey; current: string | string[]; proposed: string | string[] }>;
  invalid: Array<{ field: string; error: string }>;
}

/** What an agent may do: fill empty fields only. Pure. */
export function fillEmpty(current: CompanyProfile, input: Record<string, unknown>): FillResult {
  const profile: CompanyProfile = { ...current, ...(current.bannedWords ? { bannedWords: [...current.bannedWords] } : {}) };
  const result: FillResult = { profile, filled: [], unchanged: [], kept: [], invalid: [] };
  for (const [key, value] of Object.entries(input)) {
    const field = profileField(key);
    if (!field) {
      if (key !== "issueId") result.invalid.push({ field: key, error: `Unknown field ${key}.` });
      continue;
    }
    let clean: string | string[] | undefined;
    try {
      clean = cleanField(field.key, value);
    } catch (error) {
      result.invalid.push({ field: field.key, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (clean === undefined) continue;
    const existing = current[field.key];
    if (!isFilled(current, field.key)) {
      (profile as Record<string, unknown>)[field.key] = clean;
      result.filled.push(field.key);
    } else if (same(existing, clean)) {
      result.unchanged.push(field.key);
    } else {
      result.kept.push({ field: field.key, current: existing!, proposed: clean });
    }
  }
  return result;
}

/** What a person may do on the Profile tab: set or clear any field. Pure. */
export function applyEdit(current: CompanyProfile, input: Record<string, unknown>): { profile: CompanyProfile; changed: ProfileFieldKey[] } {
  const profile: CompanyProfile = { ...current };
  const changed: ProfileFieldKey[] = [];
  const errors: string[] = [];
  for (const field of PROFILE_FIELDS) {
    if (!(field.key in input)) continue;
    let clean: string | string[] | undefined;
    try {
      clean = cleanField(field.key, input[field.key]);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (same(current[field.key], clean)) continue;
    if (clean === undefined) delete (profile as Record<string, unknown>)[field.key];
    else (profile as Record<string, unknown>)[field.key] = clean;
    changed.push(field.key);
  }
  if (errors.length) throw new ProfileError(errors.join(" "));
  return { profile, changed };
}
