/**
 * PAR-13992: rows that are not hard stops wait on the seat that decides them, not the owner.
 * Pure. The seats are the company's decision-rights settings (`decisionRights.seats`, agent ids): the existing mechanism,
 * read here for rows that plugins and the host list without a `waitsOn` of their own. No seat set for the class (nor
 * for `other`) leaves the row with the owner. A row whose title reads as a hard stop is never routed. A row that
 * already names who it waits on keeps that.
 */
import { classify, type DecisionClass, type DecisionRights } from "./decision-rights-model.js";
import type { WaitingEntry } from "./merge.js";

const BRAND_PREFIX = /^\s*\[([^\]]{1,60})\]\s*/;

/** Studio dogfood approvals on test data (a person closes them by design, but they decide nothing of the company's). */
const DOGFOOD = /^(?:[A-Z][A-Z0-9]*-\d+ )?Approval: .*\bStudio dogfood\b/i;

/** The decision class a row belongs to, or null when it is not a kind that is routed. */
export function seatClassOf(entry: Pick<WaitingEntry, "key" | "title" | "originKind">, ownProducts: readonly string[] = []): DecisionClass | null {
  const { key, title } = entry;
  const origin = entry.originKind ?? "";
  if (key.startsWith("seo:optimization:") || /^seo:needs-you:[^:]+:playbook_changes$/.test(key)) return "seo";
  if (key.startsWith("social:experiment:") || key.startsWith("social:playbook-change:")) return "social";
  if (key.startsWith("social:review:")) {
    // Own-brand posts only: a post under a client's name needs the client's written yes and stays with the owner.
    const brand = BRAND_PREFIX.exec(title)?.[1];
    if (/^Waiting for the client/i.test(title.replace(BRAND_PREFIX, ""))) return null;
    return !brand || ownProducts.some((p) => p.toLowerCase() === brand.toLowerCase()) ? "social" : null;
  }
  if (origin === "plugin:partnersinbiz.cockpit:closeout" || origin === "plugin:partnersinbiz.cockpit:brief" || origin === "plugin:partnersinbiz.cockpit:digest") return "other";
  if (origin === "plugin:partnersinbiz.social") return "social";
  if (origin === "plugin:partnersinbiz.campaigns") return "planBusiness";
  if ((origin === "" || origin === "manual") && DOGFOOD.test(title)) return "other";
  return null;
}

/** Entries of a routed kind get `waitsOn` set to the seat for their class. Everything else is returned as it was. */
export function routeToSeats(entries: WaitingEntry[], rights: DecisionRights | null | undefined): WaitingEntry[] {
  if (!rights?.enabled) return entries;
  return entries.map((entry) => {
    if (entry.waitsOn) return entry;
    const decisionClass = seatClassOf(entry, rights.ownProducts);
    if (!decisionClass) return entry;
    // A title that reads as a hard stop (a login, money, a client send, legal) is the owner's, whatever its kind.
    if (classify({ kind: "decision", text: entry.title }, rights.ownProducts).hardStop) return entry;
    const seat = rights.seats[decisionClass] ?? rights.seats.other ?? null;
    return seat ? { ...entry, waitsOn: { kind: "agent", agentId: seat } } : entry;
  });
}
