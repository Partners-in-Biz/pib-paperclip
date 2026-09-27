/**
 * Plain words for people: Google and Bing errors, the daily run's warnings and
 * older stored text. Pure and browser-safe: the SEO page and the Cockpit
 * snapshot use the same wording, and the raw text stays available for a
 * "Details" disclosure (never shown on its own).
 */

export type ErrorSource = "gsc" | "pagespeed" | "bing";

export interface PlainError {
  /** One plain sentence: what happened and what happens next. */
  text: string;
  tone: "info" | "warn" | "bad";
  /** A person has to act (otherwise it clears on its own). */
  needsPerson: boolean;
  /** The original error, for Details. */
  raw: string;
}

const SOURCE_NAME: Record<ErrorSource, string> = { gsc: "Google Search Console", pagespeed: "PageSpeed", bing: "Bing" };

/** An error from Google Search Console, PageSpeed Insights or Bing in plain words. */
export function plainError(raw: string | null | undefined, source?: ErrorSource | null): PlainError | null {
  const text = raw?.trim();
  if (!text) return null;
  const is = (re: RegExp) => re.test(text);
  const kind: ErrorSource | null = source ?? (is(/pagespeed/i) ? "pagespeed" : is(/bing/i) ? "bing" : is(/search console|gsc|searchconsole|webmasters/i) ? "gsc" : null);
  const out = (plain: string, tone: PlainError["tone"], needsPerson: boolean): PlainError => ({ text: plain, tone, needsPerson, raw: text });

  if (kind === "pagespeed" || is(/pagespeedonline/i)) {
    if (is(/quota|rate ?limit|RESOURCE_EXHAUSTED|too many requests|\b429\b/i)) return out("Google's free PageSpeed limit ran out; checks resume tomorrow.", "info", false);
    if (is(/took too long|timed? ?out|timeout|aborted/i)) return out("PageSpeed took too long to answer; the next daily run tries again.", "info", false);
    if (is(/api key not valid|API_KEY_INVALID|invalid api key|\b400\b.*key/i)) return out("Google turned down the PageSpeed API key. Check it in the SEO settings.", "warn", true);
    if (is(/unable to (?:process|resolve)|FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|net::ERR/i)) return out("PageSpeed could not load the page. Check that it opens in a browser; the next daily run tries again.", "warn", false);
    return out("The PageSpeed check failed; the next daily run tries again.", "warn", false);
  }
  if (kind === "bing") {
    if (is(/not set|missing/i)) return out("The Bing API key is not set yet (see Setup).", "warn", true);
    if (is(/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid ?api ?key|InvalidApiKey/i)) return out("Bing turned down the API key. Check the Bing key in the SEO settings.", "bad", true);
    if (is(/quota|throttl|too many requests|\b429\b/i)) return out("Bing's daily limit ran out; it resumes tomorrow.", "info", false);
    if (is(/not verified|verification/i)) return out("Bing has not verified the site yet; the agent retries once the file is live.", "info", false);
    return out("The Bing check failed; the next daily run tries again.", "warn", false);
  }
  if (kind === "gsc" || is(/google/i)) {
    if (is(/invalid_grant|revoked|token has been expired|reconnect/i)) return out("Google turned down the saved Search Console sign-in. Reconnect it on the Integrations tab.", "bad", true);
    if (is(/service account cannot be used|could not read the service account|invalid service account/i)) return out("The Google service account key does not work. Check it in the SEO settings.", "bad", true);
    if (is(/sufficient permission|does not have (?:access|permission)|has no access|not an owner|not a verified owner|forbidden|\b403\b/i)) {
      return out("The service account cannot read this site in Google Search Console yet: it needs access (the steps are on Needs you).", "warn", true);
    }
    if (is(/no property is selected/i)) return out("Search Console is connected, but no site is picked yet. Choose it on the Integrations tab.", "warn", true);
    if (is(/quota|rate ?limit|RESOURCE_EXHAUSTED|\b429\b/i)) return out("Google's Search Console limit ran out; the data updates tomorrow.", "info", false);
    if (is(/service account key|not set up for this sprint/i)) return out("Search Console waits for the Google service account key (see Setup).", "warn", true);
    return out(`${SOURCE_NAME.gsc} returned an error; the next daily run tries again.`, "warn", false);
  }
  if (is(/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network|getaddrinfo/i)) return out("The site or the service could not be reached; the next run tries again.", "info", false);
  return out("Something went wrong; the next daily run tries again.", "warn", false);
}

export interface PlainWarning extends PlainError {
  /** What part of the daily run it came from, in plain words. */
  area: string;
  /** Where on the sprint page to look: the Integrations tab for Google and Bing. */
  tab: "integrations" | null;
}

const WARNING_AREAS: Array<{ prefix: RegExp; area: string; source?: ErrorSource; tab?: "integrations" }> = [
  { prefix: /^PageSpeed:\s*/i, area: "Page speed", source: "pagespeed", tab: "integrations" },
  { prefix: /^GSC:\s*/i, area: "Google Search Console", source: "gsc", tab: "integrations" },
  { prefix: /^Bing:\s*/i, area: "Bing", source: "bing", tab: "integrations" },
  { prefix: /^Search Console:\s*/i, area: "Google Search Console", source: "gsc", tab: "integrations" },
  { prefix: /^Root issue:\s*/i, area: "Sprint issue" },
  { prefix: /^Plan upgrade:\s*/i, area: "Plan update" },
  { prefix: /^Snapshot:\s*/i, area: "Audit snapshot" },
  { prefix: /^Needs you:\s*/i, area: "Needs you" },
  { prefix: /^Indexing follow-up:\s*/i, area: "Indexing check" },
  { prefix: /^Measure:\s*/i, area: "Measuring results" },
  { prefix: /^Heal:\s*/i, area: "Issue sync" },
];

/** A line from the daily run's warnings ("PageSpeed: …quota exceeded…") in plain words. */
export function plainWarning(line: string): PlainWarning {
  const trimmed = line.trim();
  const hit = WARNING_AREAS.find((a) => a.prefix.test(trimmed));
  if (!hit) {
    const base = plainError(trimmed) ?? { text: trimmed, tone: "warn" as const, needsPerson: false, raw: trimmed };
    return { ...base, area: "Daily run", tab: null };
  }
  const rest = trimmed.replace(hit.prefix, "");
  if (hit.source) {
    // Google and Bing text that is already plain (e.g. "waiting for the service account key") keeps its words.
    const base = plainError(rest, hit.source)!;
    return { ...base, raw: trimmed, area: hit.area, tab: hit.tab ?? null };
  }
  return { text: fixPlurals(rest), tone: "warn", needsPerson: false, raw: trimmed, area: hit.area, tab: null };
}

/** "13 task(s)" → "13 tasks", "1 item(s)" → "1 item": for text stored before the wording changed. */
export function fixPlurals(text: string): string {
  return text.replace(/\b(\d+)\s+([A-Za-z-]+(?:\s[A-Za-z-]+)?)\(s\)/g, (_match, n: string, word: string) => (Number(n) === 1 ? `${n} ${word}` : `${n} ${word}s`));
}

/** Abbreviations spelled out for people ("GSC" → "Google Search Console"). */
export function plainTerms(text: string): string {
  return fixPlurals(text)
    .replace(/\bGSC\b/g, "Google Search Console")
    .replace(/\bDR (\d)/g, "domain rating $1")
    .replace(/\bDR\b/g, "domain rating");
}

/** "1 task" / "3 tasks". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Software (SaaS)" → "software (SaaS)": a name used mid-sentence keeps its acronyms. */
export function lowerFirst(text: string): string {
  return text ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;
}
