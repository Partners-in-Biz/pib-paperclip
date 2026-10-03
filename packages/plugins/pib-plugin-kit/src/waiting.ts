/**
 * The waiting list nobody sees (critic: the Needs-you backlog).
 *
 * Peet's visible queue looked small (11 assigned issues, 1 open ask, 0 pending
 * approvals) while the invisible waiting list was about three times that: after
 * retry exhaustion the host moves an issue to `blocked` with no unblock
 * descriptor and no owner notification (19 of 20 blocked PAR issues, all 14 PARA
 * ones), and approvals that opened unassigned sat in nobody's inbox. This module
 * finds both so the Cockpit can count them as waiting, and escalates a block that
 * has no way out.
 *
 * Read-only: it lists and classifies. Re-waking an issue when its condition
 * clears, and escalating a block older than 24 h, are the Cockpit's sweeper's job
 * (it owns the owner relationship); it uses these results.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { unblockPath, type UnblockPath } from "./asking.js";
import { findUnroutedApprovals, type UnroutedApproval } from "./approvals.js";
import { stampMs, type HealthCheck, type WaitingItem } from "./cockpit.js";

export interface BlockedIssue {
  id: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  /** When it became blocked (the host's `blockedTransitionAt`, else its last update). */
  blockedSince: string | null;
  ageHours: number;
  /** How it gets unblocked; null when nothing will unblock it; `unknown` when its blockers could not be read (never escalated). */
  path: UnblockPath | "unknown" | null;
}

/** A blocked issue with no way out older than this is escalated. */
export const BLOCKED_ESCALATE_HOURS = 24;

/**
 * Which of `issueIds` have an open blocker issue: returns their ids. The host's
 * issue list carries no blocker relations, and reading them one by one through
 * the SDK (`ctx.issues.relations.get`) needs the `issue.relations.read`
 * capability, which no PiB plugin declares. A plugin that can read the
 * relations another way passes that here; the Cockpit has `issue_relations` in
 * its `coreReadTables`, so it passes `dbBlockedByLookup(ctx)` and needs no new
 * capability.
 */
export type BlockedByLookup = (companyId: string, issueIds: string[]) => Promise<Iterable<string>>;

/**
 * A `BlockedByLookup` that reads `public.issue_relations` through `ctx.db`
 * (needs `database.namespace.read` and `issue_relations` + `issues` in the
 * manifest's `coreReadTables`). Scoped by company; a blocker that is done or
 * cancelled no longer blocks. Throws when the plugin may not read those
 * tables; `listBlockedIssues` then reports the issues as `unknown`.
 */
export function dbBlockedByLookup(ctx: PluginContext): BlockedByLookup {
  return async (companyId, issueIds) => {
    if (issueIds.length === 0) return [];
    const marks = issueIds.map((_, index) => `$${index + 2}::uuid`).join(", ");
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT DISTINCT r.related_issue_id::text AS id
         FROM public.issue_relations r JOIN public.issues b ON b.id = r.issue_id
        WHERE r.company_id = $1::uuid AND r.type = 'blocks' AND r.related_issue_id IN (${marks})
          AND b.status NOT IN ('done', 'cancelled')`,
      [companyId, ...issueIds],
    );
    return rows.map((row) => String(row.id));
  };
}

export interface ListBlockedOptions {
  /** Issues that have an open ask (the Cockpit knows them). */
  askIssueIds?: Set<string>;
  limit?: number;
  now?: number;
  /**
   * How to learn which issues have an open blocker (see `BlockedByLookup`).
   * Without it the blockers are read one issue at a time through the SDK, which
   * needs `issue.relations.read`; a plugin without it gets `unknown` rows.
   */
  blockedBy?: BlockedByLookup;
  /** false: do not try the SDK relations call (an issue with no descriptor and no ask is `unknown`). */
  checkRelations?: boolean;
}

/**
 * Every blocked issue of the company with how it gets unblocked. The host's
 * issue list carries the unblock descriptor but not the blocker relations, so
 * for an issue with no descriptor and no ask the blockers are read: through
 * `options.blockedBy` (one call for all of them) when given, else through
 * `ctx.issues.relations.get` (one call each, needs `issue.relations.read`).
 * When neither can be read the issue is `unknown`: never escalated, but
 * `blockersUnreadableCheck` makes that visible instead of reporting nothing.
 */
export async function listBlockedIssues(ctx: PluginContext, companyId: string, options: ListBlockedOptions = {}): Promise<BlockedIssue[]> {
  const now = options.now ?? Date.now();
  const issues = (await ctx.issues.list({ companyId, status: "blocked", limit: options.limit ?? 200 })) as unknown as Array<Record<string, unknown>>;
  const paths = new Map<string, BlockedIssue["path"]>();
  for (const issue of issues) paths.set(String(issue.id), unblockPath(issue as Parameters<typeof unblockPath>[0], { hasOpenAsk: options.askIssueIds?.has(String(issue.id)) }));
  const undecided = [...paths].filter(([, path]) => path === null).map(([id]) => id);
  if (undecided.length > 0 && options.blockedBy) {
    try {
      const blocked = new Set([...(await options.blockedBy(companyId, undecided))].map(String));
      for (const id of undecided) paths.set(id, blocked.has(id) ? "blocked-by" : null);
    } catch (error) {
      ctx.logger.warn("Blocked issues: the blocker lookup failed, so they cannot be judged", { companyId, error: error instanceof Error ? error.message : String(error) });
      for (const id of undecided) paths.set(id, "unknown");
    }
  } else if (undecided.length > 0) {
    let relationsReadable = options.checkRelations !== false;
    for (const id of undecided) {
      if (!relationsReadable) {
        paths.set(id, "unknown");
        continue;
      }
      try {
        const relations = (await ctx.issues.relations.get(id, companyId)) as { blockedBy?: unknown[] } | null;
        if (Array.isArray(relations?.blockedBy) && relations.blockedBy.length > 0) paths.set(id, "blocked-by");
      } catch {
        relationsReadable = false;
        paths.set(id, "unknown");
      }
    }
  }
  const rows: BlockedIssue[] = [];
  for (const issue of issues) {
    const id = String(issue.id);
    const since = stampMs(issue.blockedTransitionAt ?? issue.updatedAt);
    const path = paths.get(id) ?? null;
    rows.push({
      id,
      identifier: typeof issue.identifier === "string" ? issue.identifier : null,
      title: String(issue.title ?? ""),
      assigneeAgentId: typeof issue.assigneeAgentId === "string" ? issue.assigneeAgentId : null,
      blockedSince: Number.isFinite(since) ? new Date(since).toISOString() : null,
      ageHours: Number.isFinite(since) ? Math.max(0, (now - since) / 3_600_000) : 0,
      path,
    });
  }
  return rows;
}

/** Blocked issues with no way out, older than `olderThanHours` (default 24), oldest first. */
export function blockedWithoutPath(rows: BlockedIssue[], options: { olderThanHours?: number } = {}): BlockedIssue[] {
  const min = options.olderThanHours ?? BLOCKED_ESCALATE_HOURS;
  return rows.filter((row) => row.path === null && row.ageHours >= min).sort((a, b) => b.ageHours - a.ageHours);
}

/**
 * Cockpit health check: blocked issues whose blockers could not be read, so
 * nothing could be said about them. Without this a plugin that cannot read the
 * relations looks exactly like a company with no stuck issues. Null when every
 * blocked issue could be judged.
 */
export function blockersUnreadableCheck(rows: BlockedIssue[]): HealthCheck | null {
  const unknown = rows.filter((row) => row.path === "unknown");
  if (unknown.length === 0) return null;
  const judged = rows.length - unknown.length;
  return {
    key: "issues:blockers-unreadable",
    title: "Blocked issues that cannot be checked",
    status: "warn",
    detail: `${unknown.length} blocked issue${unknown.length === 1 ? " has" : "s have"} no unblock reason and no question to the owner, and the Cockpit cannot read which issues block which, so it cannot tell whether ${unknown.length === 1 ? "it is" : "they are"} stuck${judged > 0 ? ` (${judged} other blocked issue${judged === 1 ? " was" : "s were"} checked)` : ""}: ${unknown.slice(0, 5).map((u) => `${u.identifier ?? u.id} (${Math.round(u.ageHours)} h)`).join(", ")}${unknown.length > 5 ? ", ..." : ""}.`,
    fix: "Open Issues, filter Blocked, and check each has a reason and an owner who can move it. (For the plugin: pass blockedBy: dbBlockedByLookup(ctx) to listBlockedIssues; the Cockpit may read issue_relations.)",
    since: unknown[0]?.blockedSince ?? null,
  };
}

/** Cockpit health check: blocked issues nothing can unblock. Null when there are none. */
export function blockedWithoutPathCheck(rows: BlockedIssue[], options: { olderThanHours?: number } = {}): HealthCheck | null {
  const stuck = blockedWithoutPath(rows, options);
  if (stuck.length === 0) return null;
  return {
    key: "issues:blocked-no-path",
    title: "Blocked issues with no way out",
    status: "bad",
    detail: `${stuck.length} issue${stuck.length === 1 ? " is" : "s are"} blocked with no unblock descriptor, no blocker and no open ask, so nothing will ever wake ${stuck.length === 1 ? "it" : "them"}: ${stuck.slice(0, 5).map((s) => `${s.identifier ?? s.id} (${Math.round(s.ageHours)} h)`).join(", ")}${stuck.length > 5 ? ", ..." : ""}.`,
    fix: "Open each: say what unblocks it (set the unblock descriptor), ask the owner with ask-owner, or close it. The Operator escalates these after 24 hours.",
    since: stuck[0]?.blockedSince ?? null,
  };
}

export interface WaitingBacklog {
  unroutedApprovals: UnroutedApproval[];
  blockedNoPath: BlockedIssue[];
  /** Blocked issues whose blockers could not be read: not counted in `total`, but publish `blockersUnreadableCheck`. */
  blockedUnknown: BlockedIssue[];
  total: number;
}

/**
 * Everything that waits on a person without being in their queue: approvals
 * with no assignee (over an hour old) and blocked issues with no way out (over
 * 24 h). Count it next to the owner's visible list so the real size shows.
 */
export async function waitingBacklog(ctx: PluginContext, companyId: string, options: { askIssueIds?: Set<string>; now?: number; blockedBy?: BlockedByLookup } = {}): Promise<WaitingBacklog> {
  const [unroutedApprovals, blocked] = await Promise.all([
    findUnroutedApprovals(ctx, companyId, { now: options.now }).catch(() => [] as UnroutedApproval[]),
    listBlockedIssues(ctx, companyId, { askIssueIds: options.askIssueIds, now: options.now, blockedBy: options.blockedBy }).catch(() => [] as BlockedIssue[]),
  ]);
  const blockedNoPath = blockedWithoutPath(blocked);
  return { unroutedApprovals, blockedNoPath, blockedUnknown: blocked.filter((row) => row.path === "unknown"), total: unroutedApprovals.length + blockedNoPath.length };
}

/** The backlog as Needs-you items (one per issue, keyed so the Cockpit dedupes). */
export function backlogWaitingItems(backlog: WaitingBacklog, options: { prefix?: string | null } = {}): WaitingItem[] {
  const base = options.prefix ? `/${options.prefix}` : "";
  return [
    ...backlog.unroutedApprovals.map((a): WaitingItem => ({
      key: `approval:${a.id}`,
      title: a.title,
      why: "An approval opened with nobody assigned, so it was not in anyone's queue. A person has to approve or refuse it.",
      href: a.identifier ? `${base}/issues/${a.identifier}` : null,
      issueId: a.id,
      kind: "review",
      since: a.createdAt,
    })),
    ...backlog.blockedNoPath.map((b): WaitingItem => ({
      key: `blocked:${b.id}`,
      title: `${b.identifier ? `${b.identifier}: ` : ""}${b.title}`,
      why: "Blocked with no unblock descriptor, no blocker and no ask, so nothing will wake it. Say what unblocks it, or close it.",
      href: b.identifier ? `${base}/issues/${b.identifier}` : null,
      issueId: b.id,
      kind: "judgement",
      since: b.blockedSince,
    })),
  ];
}
