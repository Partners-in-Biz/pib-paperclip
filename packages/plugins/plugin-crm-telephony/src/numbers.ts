/**
 * The company's Twilio numbers: a list in the plugin settings, not fixed
 * secret names. Each number says which country calling codes it serves and
 * what it is for (voice, SMS, WhatsApp). One is the default: it is used when
 * no number serves the lead's country.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveTelephonySecret } from "./secrets.js";

export type NumberPurpose = "voice" | "sms" | "whatsapp";
export const NUMBER_PURPOSES: readonly NumberPurpose[] = ["voice", "sms", "whatsapp"];
export const MAX_NUMBERS = 20;

export interface TelephonyNumber {
  /** E.164, for example +27105550100. */
  e164: string;
  /** For people: "PiB Cape Town", "US sales". */
  label: string;
  /** Country calling codes served, digits only ("27", "1"). Empty means "default only". */
  regions: string[];
  purposes: NumberPurpose[];
  enabled: boolean;
  /** Exactly one enabled number is the default; it serves any region nothing else serves. */
  isDefault: boolean;
}

/** Where the list came from, for the readiness block. */
export type NumbersSource = "settings" | "secrets" | "none";

const E164 = /^\+[1-9]\d{6,14}$/;

/** A few ISO codes people type instead of calling codes. */
const ISO_TO_CODE: Record<string, string> = {
  ZA: "27", US: "1", CA: "1", GB: "44", UK: "44", IE: "353", AU: "61", NZ: "64", DE: "49", NL: "31", FR: "33",
  NA: "264", BW: "267", ZW: "263", ZM: "260", MZ: "258", KE: "254", NG: "234", GH: "233", AE: "971", IN: "91",
};

/** "+27", "27", "ZA", " za " → "27"; anything else → null. */
export function normalizeRegion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().replace(/^\+/, "");
  if (!s) return null;
  if (/^[1-9]\d{0,3}$/.test(s)) return s;
  return ISO_TO_CODE[s] ?? null;
}

/** Calling-code candidates for a destination, longest first: +27821… → ["278", "27", "2"]. */
export function callingCodeCandidates(e164: string): string[] {
  const digits = e164.replace(/^\+/, "");
  const out: string[] = [];
  for (let n = Math.min(4, digits.length); n >= 1; n--) out.push(digits.slice(0, n));
  return out;
}

/** The best-known calling code of a destination (longest region any number declares, else the first digit group). */
export function leadCallingCode(e164: string, numbers: TelephonyNumber[]): string {
  const candidates = callingCodeCandidates(e164);
  for (const c of candidates) if (numbers.some((n) => n.regions.includes(c))) return c;
  // Common one-digit and two-digit codes: 1 (NANP), 7 (RU/KZ); the rest are two or three digits.
  const d = candidates[candidates.length - 1];
  if (d === "1" || d === "7") return d;
  return candidates.find((c) => c.length === 2) ?? d;
}

export type NumberPick =
  | { ok: true; number: TelephonyNumber; matchedBy: "region" | "default" }
  | { ok: false; reason: "no_numbers" | "no_match" };

/** The number to use for a destination and a purpose: region match first, else the default. */
export function pickNumber(toE164: string, numbers: TelephonyNumber[], purpose: NumberPurpose): NumberPick {
  const usable = numbers.filter((n) => n.enabled && n.purposes.includes(purpose) && E164.test(n.e164));
  if (usable.length === 0) return { ok: false, reason: "no_numbers" };
  for (const code of callingCodeCandidates(toE164)) {
    const hit = usable.find((n) => n.regions.includes(code));
    if (hit) return { ok: true, number: hit, matchedBy: "region" };
  }
  const fallback = usable.find((n) => n.isDefault) ?? (usable.length === 1 ? usable[0] : undefined);
  if (fallback) return { ok: true, number: fallback, matchedBy: "default" };
  return { ok: false, reason: "no_match" };
}

export interface NumbersValidation {
  numbers: TelephonyNumber[];
  /** One sentence per rejected entry, by position. Empty when every entry was kept. */
  errors: string[];
}

/** Clean a list from the form or the API: valid E.164, unique, at most MAX_NUMBERS, exactly one default among the enabled ones. */
export function validateNumbers(input: unknown): NumbersValidation {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { numbers: [], errors: input == null ? [] : ["numbers must be a list"] };
  const seen = new Set<string>();
  const numbers: TelephonyNumber[] = [];
  input.forEach((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const e164 = typeof row.e164 === "string" ? row.e164.replace(/\s|-|\(|\)/g, "") : "";
    if (!E164.test(e164)) { errors.push(`Number ${index + 1}: not an E.164 number (like +27105550100)`); return; }
    if (seen.has(e164)) { errors.push(`Number ${index + 1}: ${e164} is listed twice`); return; }
    seen.add(e164);
    const label = typeof row.label === "string" ? row.label.trim().slice(0, 60) : "";
    const regionsRaw = Array.isArray(row.regions) ? row.regions : typeof row.regions === "string" ? row.regions.split(/[,\s]+/) : [];
    const regions = Array.from(new Set(regionsRaw.map(normalizeRegion).filter((r): r is string => Boolean(r))));
    const badRegion = regionsRaw.filter((r) => typeof r === "string" && r.trim() && !normalizeRegion(r));
    if (badRegion.length > 0) { errors.push(`Number ${index + 1}: unknown region ${badRegion.map(String).join(", ")} (use a calling code like 27 or 1)`); return; }
    const purposesRaw = Array.isArray(row.purposes) ? row.purposes : [];
    const purposes = NUMBER_PURPOSES.filter((p) => purposesRaw.includes(p));
    if (purposes.length === 0) { errors.push(`Number ${index + 1}: tick at least one of voice, SMS, WhatsApp`); return; }
    numbers.push({
      e164,
      label: label || e164,
      regions,
      purposes,
      enabled: row.enabled !== false,
      isDefault: row.isDefault === true,
    });
  });
  if (numbers.length > MAX_NUMBERS) {
    errors.push(`At most ${MAX_NUMBERS} numbers`);
    numbers.length = MAX_NUMBERS;
  }
  // Exactly one default among the enabled numbers.
  const enabled = numbers.filter((n) => n.enabled);
  const defaults = enabled.filter((n) => n.isDefault);
  if (enabled.length > 0 && defaults.length !== 1) {
    const keep = defaults[0] ?? enabled[0];
    for (const n of numbers) n.isDefault = n === keep;
  } else {
    for (const n of numbers) if (!n.enabled) n.isDefault = false;
  }
  return { numbers, errors };
}

/**
 * The old fixed secrets as a list, read once when the company has not saved
 * any numbers yet, so nothing that works today breaks. The readiness block
 * says the list comes from the secrets until it is saved.
 */
export async function seedNumbersFromSecrets(ctx: PluginContext, companyId: string): Promise<TelephonyNumber[]> {
  const seeds: Array<{ name: string; label: string; regions: string[]; purposes: NumberPurpose[] }> = [
    { name: "TWILIO_ZA_NUMBER", label: "South Africa (from secret TWILIO_ZA_NUMBER)", regions: ["27"], purposes: ["voice", "sms"] },
    { name: "TWILIO_US_NUMBER", label: "United States (from secret TWILIO_US_NUMBER)", regions: ["1"], purposes: ["voice", "sms"] },
    { name: "TWILIO_WHATSAPP_FROM", label: "WhatsApp sender (from secret TWILIO_WHATSAPP_FROM)", regions: [], purposes: ["whatsapp"] },
  ];
  const rows: Record<string, unknown>[] = [];
  for (const seed of seeds) {
    let value: string | null = null;
    try {
      value = await resolveTelephonySecret(ctx, companyId, seed.name);
    } catch {
      value = null;
    }
    if (!value) continue;
    const e164 = value.trim().replace(/^whatsapp:/i, "");
    if (!E164.test(e164)) continue;
    const existing = rows.find((r) => r.e164 === e164);
    if (existing) {
      existing.purposes = Array.from(new Set([...(existing.purposes as NumberPurpose[]), ...seed.purposes]));
      continue;
    }
    rows.push({ e164, label: seed.label, regions: seed.regions, purposes: seed.purposes, enabled: true, isDefault: rows.length === 0 });
  }
  return validateNumbers(rows).numbers;
}

/** "+27 → 27, 1" style text for a readiness line. */
export function describeNumber(n: TelephonyNumber): string {
  const regions = n.regions.length > 0 ? n.regions.map((r) => `+${r}`).join(", ") : "default only";
  return `${n.label} ${n.e164} (${regions}; ${n.purposes.join(", ")}${n.isDefault ? "; default" : ""}${n.enabled ? "" : "; disabled"})`;
}
