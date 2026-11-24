/**
 * Rehearsal sprints (gap audit wave 6): pure, no database.
 *
 * The acceptance agent proves the SEO flow on the canary client with a fixture site (https://canary.invalid): it creates a sprint,
 * reads its tasks and archives it. That run must be harmless, so a rehearsal sprint keeps its rows (plan, tasks, keywords) for the
 * journey to read but never opens a Paperclip issue, never asks a person for anything and never wakes an agent. Before this, one
 * run left ten open issues in the owner's queue (the sprint's root issue and the nine week-0 tasks).
 *
 * A sprint is a rehearsal when either mark is true. Both are names no real client can hold, so a real sprint never matches:
 *
 * - the site's host is `.invalid` (RFC 2606 reserves the name: it can never resolve, so no real site lives there);
 * - the client ref is a canary id. The CRM gives its canary company `canary-<8 hex>` (and its contact `canary-contact-<8 hex>`);
 *   real CRM ids are UUIDs, so they never start with `canary-`. The ref is stored as the bare id, and `company:<id>` /
 *   `contact:<id>` is the form tools take. That shape is restated from plugin-crm/src/canary-flag.ts (plugins never import
 *   each other); keep the two in step.
 *
 * Only the whole shape matches: a host that merely contains `invalid` or `canary`, or a ref that merely contains the word
 * `canary` (a client called "Canary Wharf Ltd" has a UUID id), is a real sprint.
 */

/** A host ending in this can never exist. */
export const REHEARSAL_HOST_SUFFIX = ".invalid";
/** The CRM's canary id prefix (plugin-crm/src/canary-flag.ts CANARY_PREFIX). */
export const CANARY_PREFIX = "canary-";

/** The bare ref or `company:<ref>` / `contact:<ref>`; after the prefix at least one more character, in the CRM's id alphabet. */
const CANARY_REF = /^(?:(?:company|contact):)?canary-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The host of a site address (lower case, no trailing dot), or null when it has none. */
function hostOf(siteUrl: unknown): string | null {
  if (typeof siteUrl !== "string") return null;
  const text = siteUrl.trim();
  if (!text) return null;
  try {
    const host = new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/** True for a name that is reserved so it can never be a real site: `invalid`, or anything under it. */
export function isRehearsalHost(host: string | null): boolean {
  return host === "invalid" || (host != null && host.endsWith(REHEARSAL_HOST_SUFFIX));
}

/** True for the CRM's canary ids, bare or as `company:<id>` / `contact:<id>`. */
export function isCanaryRef(ref: unknown): boolean {
  return typeof ref === "string" && CANARY_REF.test(ref);
}

export interface RehearsalSubject {
  siteUrl?: unknown;
  clientRef?: unknown;
}

/** Whether a sprint (or the site and client a sprint is about to be created for) is a rehearsal. */
export function isRehearsalSprint(subject: RehearsalSubject): boolean {
  return isCanaryRef(subject.clientRef) || isRehearsalHost(hostOf(subject.siteUrl));
}

/** What `create-sprint`, `get-sprint` and the daily plan say about a rehearsal sprint. */
export const REHEARSAL_NOTE =
  "Rehearsal sprint (a fixture site on .invalid, or the canary client): its plan, tasks and keywords exist so the journey can read them, but no Paperclip issue is opened for it and no person or agent is asked for anything. archive-sprint ends it.";

/** True for a page address on a fixture host (`.invalid`): it never resolves, so it is never fetched. */
export function isRehearsalUrl(url: unknown): boolean {
  return isRehearsalHost(hostOf(url));
}

/** The note on a preview built on the canned fixture page (PAR-13387). */
export const REHEARSAL_PAGE_NOTE = "Rehearsal fixture: the host is .invalid, so nothing was fetched; the preview is built on the plugin's canned page for this address.";

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The canned live page for a fixture address (PAR-13387): create-preview, its repeat check and list-previews checkLive read this
 * instead of the network, so a rehearsal sprint can hold real previews. Same address, same page, so the live check stays "unchanged".
 * Plain HTML (no scripts): the source is what a visitor's browser shows, so the kept-text figure is final when the preview is made.
 */
export function rehearsalPageHtml(pageUrl: string): string {
  let path = "/";
  try {
    path = new URL(pageUrl).pathname || "/";
  } catch {
    // keep "/"
  }
  const where = escapeHtml(path);
  const paragraphs = [
    "This is a rehearsal fixture page. No real business lives at this address and nothing here is ever published.",
    "The fixture lists a few services so a preview has ordinary copy to keep: planning, delivery, support and yearly reviews.",
    "Each service has a short description, a price on request and a link to the contact page, like a small local business site.",
    "Visitors can read about the team, the areas the business serves and the questions customers ask most often.",
    "The page keeps a menu, a heading, several paragraphs and a footer, so the kept-text check has something to measure.",
    "Use it to rehearse previews, reviews and decisions in the cockpit without touching a client site or sending an email.",
  ];
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>Fixture page ${where} | Rehearsal site</title>`,
    `<meta name="description" content="Rehearsal fixture page for ${where}. Nothing here is real or published.">`,
    "</head><body>",
    '<header><nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>',
    `<main><h1>Fixture page ${where}</h1><div class="entry-content">`,
    ...paragraphs.map((p) => `<p>${p}</p>`),
    "</div></main>",
    "<footer><p>Rehearsal site. Not a real business.</p></footer>",
    "</body></html>",
  ].join("\n");
}

/** The answer of a tool that would open an issue for, or build something on, a rehearsal sprint. */
export const REHEARSAL_REFUSAL = "This is a rehearsal sprint (a fixture site or the canary client): no issue is opened for it and nothing is built, previewed or handed to a person or an agent.";
