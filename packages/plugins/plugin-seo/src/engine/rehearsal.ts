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

/** The answer of a tool that would open an issue for, or build something on, a rehearsal sprint. */
export const REHEARSAL_REFUSAL = "This is a rehearsal sprint (a fixture site or the canary client): no issue is opened for it and nothing is built, previewed or handed to a person or an agent.";
