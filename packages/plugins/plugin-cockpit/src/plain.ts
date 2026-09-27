/**
 * Raw technical errors in plain words (pure, no node imports; the page and the
 * worker both use it). A health check or an agent error often carries the
 * service's own message ("Quota exceeded for quota metric 'Queries'…
 * project_number:583797351490", "Hermes exited with code 1"). People see one
 * plain sentence; the raw text stays available under "Details".
 */

export interface PlainDetail {
  /** What to show. */
  text: string;
  /** The raw error, for a Details disclosure; null when the text was already plain. */
  raw: string | null;
}

/** Signs that a text is a raw error from a service, an adapter or code (not a sentence a plugin wrote for people). */
const RAW_MARKERS: RegExp[] = [
  /quota exceeded|quota metric|rate ?limit(?:ed| exceeded)|RESOURCE_EXHAUSTED|too many requests|\b(?:HTTP|status(?: code)?)\s*429\b/i,
  /exited with code -?\d+/i,
  /\b(?:HTTP|status(?: code)?)\s*40[13]\b|\bunauthori[sz]ed\b|\bforbidden\b|permission[_ ]denied|invalid[_ ]grant|invalid (?:api )?key|api key not valid|UNAUTHENTICATED/i,
  /\bE(?:TIMEDOUT|CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN)\b|socket hang up|fetch failed|network error/i,
  /\b(?:HTTP|status(?: code)?)\s*5\d\d\b|internal server error|service unavailable|bad gateway|gateway time-?out/i,
  /project_number:|googleapis\.com|\{\s*"error"|\b[A-Z][A-Za-z]+Error\b|\bat [\w.<>]+ \(/,
];

/** The first place a raw error starts in `text`, or -1. */
export function rawErrorAt(text: string): number {
  let at = -1;
  for (const marker of RAW_MARKERS) {
    const match = marker.exec(text);
    if (match && (at < 0 || match.index < at)) at = match.index;
  }
  return at;
}

/** One plain sentence for a raw error, by kind. `context` (the whole detail) helps name the service. */
export function plainError(raw: string, context: string = raw): string {
  const text = raw.toLowerCase();
  const about = `${context} ${raw}`.toLowerCase();
  if (/quota|rate ?limit|resource_exhausted|too many requests|\b429\b/.test(text)) {
    if (about.includes("pagespeed")) return "Google's free PageSpeed limit ran out; checks resume tomorrow.";
    if (/google|project_number/.test(about)) return "Google's daily limit ran out; it resets tomorrow.";
    return "The service's usage limit ran out; it resets on its own.";
  }
  if (/exited with code/.test(text)) return "Stopped with an error.";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|permission[_ ]denied|invalid[_ ]grant|invalid (api )?key|api key not valid|unauthenticated/.test(text)) {
    return "The service turned down the key or sign-in. Check the key, or connect it again.";
  }
  if (/etimedout|econnrefused|econnreset|enotfound|eai_again|socket hang up|fetch failed|network error|timed out/.test(text)) {
    return "Could not reach the service. It tries again on its own.";
  }
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway time-?out/.test(text)) {
    return "The service had a problem on its side. It tries again on its own.";
  }
  return "Something went wrong.";
}

/**
 * A detail as people read it. "Last error: <raw>" (job health) becomes "The
 * last run failed." plus the reason; "<lead-in>: <raw>" keeps the lead-in
 * ("PageSpeed Insights failed for https://example.com/: Google's free
 * PageSpeed limit ran out; …"). Plain details pass through unchanged.
 */
export function plainDetail(detail: string | null | undefined): PlainDetail | null {
  const text = typeof detail === "string" ? detail.trim() : "";
  if (!text) return null;
  const last = /^last error:\s*([\s\S]+)$/i.exec(text);
  if (last) {
    const raw = last[1]!.trim();
    const reason = rawErrorAt(raw) >= 0 ? ` ${plainError(raw)}` : "";
    return { text: `The last run failed.${reason === " Something went wrong." ? "" : reason}`, raw };
  }
  const at = rawErrorAt(text);
  if (at < 0) return { text, raw: null };
  const colon = text.lastIndexOf(": ", at);
  const lead = colon > 0 ? text.slice(0, colon).trim() : "";
  const raw = colon > 0 ? text.slice(colon + 2).trim() : text;
  const sentence = plainError(raw, text);
  return { text: lead ? `${lead}: ${sentence}` : sentence, raw };
}
