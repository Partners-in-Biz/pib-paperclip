/**
 * Google responsive search ad copy limits. One place, used twice: when the proposal is written (so a bad ad never reaches the Reviewer)
 * and again inside the provider before anything is sent (so no other caller can skip it).
 */
import { AdsError } from "./domain.js";

export const RSA_LIMITS = {
  minHeadlines: 3,
  maxHeadlines: 15,
  headlineChars: 30,
  minDescriptions: 2,
  maxDescriptions: 4,
  descriptionChars: 90,
  pathChars: 15,
  finalUrlChars: 2048,
} as const;

/** The UTM parameters every paid landing URL must carry, so the click can be traced to the campaign. */
export const RSA_REQUIRED_UTM = ["utm_source", "utm_medium", "utm_campaign"] as const;

export interface ResponsiveSearchAdCopy {
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
  path1?: string;
  path2?: string;
}

const PATH_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const chars = (text: string) => [...text].length;

function textList(raw: unknown, label: string, min: number, max: number, maxChars: number): string[] {
  const items = Array.isArray(raw) ? raw : [];
  if (items.length < min || items.length > max) throw new AdsError(`${label}s must have ${min} to ${max} items, not ${items.length}`);
  const out: string[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const text = typeof item === "string" ? item.trim() : "";
    if (text.length === 0) throw new AdsError(`${label} ${index + 1} must not be empty`);
    if (chars(text) > maxChars) throw new AdsError(`${label} ${index + 1} is too long (${chars(text)} characters, Google allows ${maxChars} at most)`);
    const key = text.toLowerCase();
    if (seen.has(key)) throw new AdsError(`${label} ${index + 1} repeats an earlier ${label} ("${text}"); Google rejects duplicates`);
    seen.add(key);
    out.push(text);
  });
  return out;
}

function pathField(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return undefined;
  if (chars(text) > RSA_LIMITS.pathChars) throw new AdsError(`${label} is too long (${chars(text)} characters, Google allows ${RSA_LIMITS.pathChars} at most)`);
  if (!PATH_PATTERN.test(text)) throw new AdsError(`${label} may only hold letters, numbers, hyphens and underscores`);
  return text;
}

function finalUrlOf(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) throw new AdsError("finalUrl is required");
  if (text.length > RSA_LIMITS.finalUrlChars) throw new AdsError(`finalUrl is too long (${RSA_LIMITS.finalUrlChars} characters at most)`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AdsError("finalUrl is not a valid URL");
  }
  if (url.protocol !== "https:") throw new AdsError("finalUrl must be an https link");
  const missing = RSA_REQUIRED_UTM.filter((key) => !url.searchParams.get(key)?.trim());
  if (missing.length > 0) throw new AdsError(`finalUrl needs UTM tracking: add ${missing.join(", ")}`);
  return text;
}

/** Checks the Google limits and returns the trimmed copy. Throws an AdsError that names the first thing wrong. */
export function validateResponsiveSearchAd(input: Record<string, unknown>): ResponsiveSearchAdCopy {
  const headlines = textList(input.headlines, "headline", RSA_LIMITS.minHeadlines, RSA_LIMITS.maxHeadlines, RSA_LIMITS.headlineChars);
  const descriptions = textList(input.descriptions, "description", RSA_LIMITS.minDescriptions, RSA_LIMITS.maxDescriptions, RSA_LIMITS.descriptionChars);
  const finalUrl = finalUrlOf(input.finalUrl);
  const path1 = pathField(input.path1, "path1");
  const path2 = pathField(input.path2, "path2");
  if (path2 && !path1) throw new AdsError("path2 needs path1: Google shows the paths in order");
  return { headlines, descriptions, finalUrl, ...(path1 ? { path1 } : {}), ...(path2 ? { path2 } : {}) };
}
