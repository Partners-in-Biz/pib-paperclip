/**
 * How much waits on the owner, and for how long (critic: the Needs-you
 * backlog), pure part (no node imports).
 *
 * The owner's visible queue looked small (11 assigned issues, 1 open ask, 0
 * pending approvals) while the real list, counting blocked issues nothing
 * could wake and approvals nobody was assigned, was about three times that.
 * This counts all of it once (each issue once) and says when it is too big or
 * too old, because a long list nobody reads is a stalled company.
 */
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";

export const BACKLOG = {
  /** Warn at this many items waiting on the owner; red at `badCount`. */
  warnCount: 10,
  badCount: 25,
  /** Warn when the oldest has waited this long; red at `badDays`. */
  warnDays: 3,
  badDays: 7,
  /** An ask this old whose issue nobody touched for as long is "unhandled". */
  unhandledDays: 3,
} as const;

export type BacklogKind = "ask" | "issue" | "approval" | "blocked" | "unrouted";

export interface BacklogItem {
  /** An issue id (so the same issue is counted once) or an approval id. */
  id: string;
  kind: BacklogKind;
  since: string | null;
}

const KIND_LABEL: Record<BacklogKind, string> = { ask: "questions", issue: "issues assigned to them", approval: "approvals", blocked: "blocked issues nothing can wake", unrouted: "approvals nobody was assigned" };

const DAY = 86_400_000;

/** Each id once (the first kind seen wins: asks before plain issues). */
export function dedupeBacklog(items: BacklogItem[]): BacklogItem[] {
  const seen = new Set<string>();
  const order: BacklogKind[] = ["ask", "unrouted", "blocked", "approval", "issue"];
  const out: BacklogItem[] = [];
  for (const item of [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function backlogCheck(rawItems: BacklogItem[], now: Date): HealthCheck | null {
  const items = dedupeBacklog(rawItems);
  const oldestMs = items.reduce((oldest, i) => {
    const t = i.since ? Date.parse(i.since) : Number.NaN;
    return Number.isFinite(t) && t < oldest ? t : oldest;
  }, Number.POSITIVE_INFINITY);
  const oldestDays = Number.isFinite(oldestMs) ? Math.floor((now.getTime() - oldestMs) / DAY) : 0;
  const bad = items.length >= BACKLOG.badCount || oldestDays >= BACKLOG.badDays;
  const warn = items.length >= BACKLOG.warnCount || oldestDays >= BACKLOG.warnDays;
  if (!bad && !warn) return null;
  const counts = (Object.keys(KIND_LABEL) as BacklogKind[])
    .map((kind) => [kind, items.filter((i) => i.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${KIND_LABEL[kind]}`);
  return {
    key: "backlog:needs-you",
    title: `${items.length} ${items.length === 1 ? "thing waits" : "things wait"} on the owner${oldestDays >= BACKLOG.warnDays ? `, the oldest for ${oldestDays} days` : ""}`,
    status: bad ? "bad" : "warn",
    detail: `${counts.join(", ")}. A long or old list is a company waiting on one person: the agents' work stops behind it.`,
    href: "/cockpit",
    fix: "Open Waiting on you: the Operator hands what an agent can do back to an agent and answers from context; batch what is left into one sitting. Nothing here should wait more than a few days.",
    since: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
  };
}

export interface UnhandledAsk {
  identifier: string | null;
  issueId: string;
  askedAt: string;
}

/** Questions to the owner older than three days on issues nobody has touched for as long: nobody chased them. */
export function unhandledAsksCheck(asks: UnhandledAsk[]): HealthCheck | null {
  if (asks.length === 0) return null;
  const sorted = [...asks].sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
  const refs = sorted.slice(0, 4).map((a) => a.identifier ?? "an issue").join(", ");
  return {
    key: "asks:unhandled",
    title: `${asks.length} ${asks.length === 1 ? "question to the owner has" : "questions to the owner have"} gone unhandled for ${BACKLOG.unhandledDays} days`,
    status: "warn",
    detail: `${refs}${asks.length > 4 ? " and more" : ""}: asked more than ${BACKLOG.unhandledDays} days ago and nothing has happened on the issue since: nobody answered, chased or escalated it.`,
    href: asks.length === 1 ? `/issues/${sorted[0]!.identifier ?? sorted[0]!.issueId}` : "/cockpit",
    fix: "The Operator answers from context where it can, otherwise puts it first on the daily brief with the answer it recommends. The owner answers on the issue.",
    since: sorted[0]!.askedAt,
  };
}
