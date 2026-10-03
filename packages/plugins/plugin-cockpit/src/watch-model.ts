/**
 * The operations watch, pure part (no node imports): what the Cockpit's rules
 * over the host's runs and issues say, as health checks. Each rule answers one
 * question the Operator would otherwise ask by hand every morning:
 *
 * - run rate     an agent whose finished runs fail too often
 * - run streak   an agent that fails the same way run after run
 * - retry storm  one issue that fails again and again
 * - blocked      issues blocked for a day or more with no way out
 * - stalled      issues in progress that nobody works on
 *
 * Keys are stable (agent id, issue id), so the System health issue is updated
 * in place and the Operator is woken only when a new problem appears.
 * `watch.ts` reads the rows; the Operator skill says how to act on each.
 */
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { FAILED_RUN, hoursAgo } from "./merge.js";

export const WATCH = {
  /** Look-back of the run rules. */
  windowHours: 24,
  /** Run rate: more than this share of finished runs failed (warn), or at least `rateBad` of them (bad), over `rateMinRuns` or more. */
  rateWarn: 0.15,
  rateBad: 0.5,
  rateMinRuns: 20,
  /** Run streak: this many of an agent's latest finished runs ended with the same error code. `streakLookback` runs are read. */
  streakMin: 3,
  streakLookback: 10,
  /** Retry storm: this many failed runs on one issue within the window. */
  stormMin: 4,
  /** Blocked with no way out for this long. */
  blockedHours: 24,
  /** In progress, assignee idle and without a run for this long. */
  stalledHours: 12,
  /** Agents or issues that get their own check per rule (worst first); one check names up to `named` issues. */
  perRule: 5,
  named: 5,
} as const;

/** Run statuses that carry a verdict: the run ran to a result. Cancelled, interrupted, queued and running runs are not counted. */
export const FINISHED_RUN = ["succeeded", ...FAILED_RUN] as const;

export interface WatchAgent {
  id: string;
  name: string;
  status?: string | null;
  urlKey?: string | null;
}

/** Finished runs in the window: one row per agent, status and error code. */
export interface RateRow {
  agentId: string;
  status: string;
  errorCode: string | null;
  count: number;
}

/** One of an agent's latest finished runs (newest first when it has several). */
export interface StreakRun {
  agentId: string;
  status: string;
  errorCode: string | null;
  startedAt: string;
  issueId: string | null;
  identifier: string | null;
}

/** An issue with `stormMin` or more failed runs in the window whose latest finished run also failed. */
export interface StormRow {
  issueId: string;
  identifier: string | null;
  title: string | null;
  failed: number;
  errorCode: string | null;
  /** How many different error codes the failures had. */
  codes: number;
  agentId: string | null;
  firstFailedAt: string | null;
  lastError: string | null;
}

export interface BlockedIssue {
  id: string;
  identifier: string | null;
  title: string;
  /** When it became blocked. */
  since: string;
}

export interface StalledIssue {
  id: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string;
  updatedAt: string;
  /** The assignee's latest run, or null when it never ran. */
  lastRunAt: string | null;
}

const isFailed = (status: string) => FAILED_RUN.has(status);

function agentName(agents: Map<string, WatchAgent>, id: string | null | undefined): string {
  return (id && agents.get(id)?.name) || "An agent";
}

function agentHref(agents: Map<string, WatchAgent>, id: string): string {
  return `/agents/${agents.get(id)?.urlKey || id}`;
}

function issueRef(issue: { identifier: string | null; id?: string; issueId?: string }): string {
  return issue.identifier ?? "an issue";
}

function issueHref(issue: { identifier: string | null; id?: string; issueId?: string }): string {
  return `/issues/${issue.identifier ?? issue.id ?? issue.issueId}`;
}

/** `1 day`, `5 days`, `3 h` (pure, for lists). */
export function ageLabel(since: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(since));
  const hours = Math.floor(ms / 3_600_000);
  return hours < 48 ? `${Math.max(hours, 1)} h` : `${Math.floor(hours / 24)} days`;
}

function earliest(times: Array<string | null | undefined>): string | null {
  const valid = times.filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  return valid.length ? valid.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/**
 * Adapter errors can echo a command line or an environment, and this text goes
 * into the System health issue and the Operator's brief. Replace anything that
 * looks like a credential before it is copied: user:password@ in a URL, GitHub,
 * Slack, Stripe/OpenAI-style and AWS keys, bearer tokens, and name=value pairs
 * whose name says token, secret, password or key.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|apikey|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1$2[redacted]");
}

function more(total: number, shown: number): string {
  return total > shown ? ` and ${total - shown} more` : "";
}

// ---------------------------------------------------------------------------
// Run rate
// ---------------------------------------------------------------------------

/** More than 15% of an agent's finished runs failed or timed out over at least 20 runs in 24 hours. */
export function runRateChecks(rows: RateRow[], agents: Map<string, WatchAgent>): HealthCheck[] {
  const byAgent = new Map<string, { finished: number; failed: number; codes: Map<string, number> }>();
  for (const row of rows) {
    const entry = byAgent.get(row.agentId) ?? { finished: 0, failed: 0, codes: new Map<string, number>() };
    entry.finished += row.count;
    if (isFailed(row.status)) {
      entry.failed += row.count;
      if (row.errorCode) entry.codes.set(row.errorCode, (entry.codes.get(row.errorCode) ?? 0) + row.count);
    }
    byAgent.set(row.agentId, entry);
  }
  return [...byAgent.entries()]
    .filter(([, e]) => e.finished >= WATCH.rateMinRuns && e.failed / e.finished > WATCH.rateWarn)
    .sort(([, a], [, b]) => b.failed / b.finished - a.failed / a.finished)
    .slice(0, WATCH.perRule)
    .map(([agentId, e]): HealthCheck => {
      const rate = e.failed / e.finished;
      const top = [...e.codes.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        key: `run-rate:${agentId}`,
        title: `${agentName(agents, agentId)} failed ${Math.round(rate * 100)}% of its runs`,
        status: rate >= WATCH.rateBad ? "bad" : "warn",
        detail: `${e.failed} of ${e.finished} finished runs in the last ${WATCH.windowHours} hours failed or timed out${top ? `; most often ${top[0]} (${top[1]})` : ""}.`,
        href: agentHref(agents, agentId),
        fix: "Open its failed runs and find what they share. Fix that cause (or hand it to the agent that can) instead of retrying. One issue failing again and again shows as its own retry storm entry.",
      };
    });
}

// ---------------------------------------------------------------------------
// Run streak
// ---------------------------------------------------------------------------

/** The same error code on three or more of an agent's latest finished runs in a row (a success or another code ends the streak). */
export function runStreakChecks(runs: StreakRun[], agents: Map<string, WatchAgent>): HealthCheck[] {
  const byAgent = new Map<string, StreakRun[]>();
  for (const run of runs) byAgent.set(run.agentId, [...(byAgent.get(run.agentId) ?? []), run]);
  const out: Array<{ check: HealthCheck; length: number }> = [];
  for (const [agentId, list] of byAgent) {
    const newestFirst = [...list].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const code = newestFirst[0]?.errorCode;
    if (!code || !isFailed(newestFirst[0]!.status)) continue;
    const streak: StreakRun[] = [];
    for (const run of newestFirst) {
      if (!isFailed(run.status) || run.errorCode !== code) break;
      streak.push(run);
    }
    if (streak.length < WATCH.streakMin) continue;
    const issues = new Set(streak.map((r) => r.issueId ?? ""));
    const ref = issues.size === 1 && streak[0]!.issueId ? ` on ${issueRef({ identifier: streak[0]!.identifier })}` : issues.size > 1 ? ` on ${issues.size} issues` : "";
    const count = streak.length >= WATCH.streakLookback ? `${WATCH.streakLookback} or more` : String(streak.length);
    out.push({
      length: streak.length,
      check: {
        key: `run-streak:${agentId}:${code}`,
        title: `${agentName(agents, agentId)} failed ${count} times in a row with ${code}`,
        status: "bad",
        detail: `Its last ${count} runs all ended with ${code}${ref}. The same error each time means retrying will not help.`,
        href: agentHref(agents, agentId),
        fix: "Read the latest failed run, fix the cause (or change the work), then let the agent run again. Do not leave it retrying.",
        since: earliest(streak.map((r) => r.startedAt)),
      },
    });
  }
  return out.sort((a, b) => b.length - a.length).slice(0, WATCH.perRule).map((o) => o.check);
}

// ---------------------------------------------------------------------------
// Retry storm
// ---------------------------------------------------------------------------

/** One issue with four or more failed runs in 24 hours, still failing: named with its error code. */
export function retryStormChecks(rows: StormRow[], agents: Map<string, WatchAgent>): HealthCheck[] {
  return [...rows]
    .sort((a, b) => b.failed - a.failed)
    .slice(0, WATCH.perRule)
    .map((row): HealthCheck => {
      const what = row.title ? `${issueRef(row)} "${row.title.slice(0, 80)}"` : issueRef(row);
      const code = row.errorCode ? `, error ${row.errorCode}${row.codes > 1 ? ` (${row.codes} different errors in all)` : ""}` : "";
      return {
        key: `retry-storm:${row.issueId}`,
        title: `${issueRef(row)} keeps failing: ${row.failed} failed runs in ${WATCH.windowHours} hours`,
        status: "bad",
        detail: `${row.failed} runs${row.agentId ? ` of ${agentName(agents, row.agentId)}` : ""} on ${what} failed in the last ${WATCH.windowHours} hours${code}, and the latest run failed too.${row.lastError ? ` Latest error: ${redactSecrets(row.lastError.replace(/\s+/g, " ")).slice(0, 160)}` : ""}`,
        href: issueHref(row),
        fix: "Stop the loop: read the latest failed run. The same error each time means retrying will not help: fix the cause, split the work, or set the issue aside with a way out. For spawn E2BIG the thread is too long: close it and open a continuation issue with a short summary.",
        since: row.firstFailedAt,
      };
    });
}

// ---------------------------------------------------------------------------
// Blocked with no way out
// ---------------------------------------------------------------------------

/** Issues blocked for more than a day with no unblock owner, no open blocker issue and no question to the owner: one check, oldest first. */
export function blockedCheck(items: BlockedIssue[], total: number, now: Date): HealthCheck | null {
  if (items.length === 0) return null;
  const shown = [...items].sort((a, b) => Date.parse(a.since) - Date.parse(b.since)).slice(0, WATCH.named);
  const list = shown.map((i) => `${issueRef(i)} "${i.title.slice(0, 50)}" (${ageLabel(i.since, now)})`).join(", ");
  return {
    key: "blocked-no-way-out",
    title: `${total} ${total === 1 ? "issue is" : "issues are"} blocked with no way out`,
    status: "warn",
    detail: `Blocked for more than ${WATCH.blockedHours} hours with no unblock owner, no blocker issue and no question to the owner, so nothing will wake them: ${list}${more(total, shown.length)}.`,
    href: issueHref(shown[0]!),
    fix: "Give each one a way out: an unblock owner and action on the issue, a blocker issue, or a question to the owner. If nothing is left to wait for, set it back to todo or cancel it with a reason.",
    since: shown[0]!.since,
  };
}

// ---------------------------------------------------------------------------
// Stalled in progress
// ---------------------------------------------------------------------------

/** Issues in progress whose idle assignee has had no run for 12 hours: one check, longest stall first. */
export function stalledCheck(items: StalledIssue[], total: number, agents: Map<string, WatchAgent>, now: Date): HealthCheck | null {
  if (items.length === 0) return null;
  const since = (i: StalledIssue) => (i.lastRunAt && Date.parse(i.lastRunAt) > Date.parse(i.updatedAt) ? i.lastRunAt : i.updatedAt);
  const shown = [...items].sort((a, b) => Date.parse(since(a)) - Date.parse(since(b))).slice(0, WATCH.named);
  const list = shown.map((i) => `${issueRef(i)} "${i.title.slice(0, 50)}" (${agentName(agents, i.assigneeAgentId)}, ${i.lastRunAt ? `last run ${hoursAgo(now.getTime() - Date.parse(i.lastRunAt))}` : "never ran"})`).join(", ");
  return {
    key: "stalled-in-progress",
    title: `${total} ${total === 1 ? "issue is" : "issues are"} in progress with nobody working on ${total === 1 ? "it" : "them"}`,
    status: "warn",
    detail: `The idle assignee has had no run for more than ${WATCH.stalledHours} hours: ${list}${more(total, shown.length)}.`,
    href: issueHref(shown[0]!),
    fix: "Wake the assignee with a comment saying what to do next. If it cannot do the work, reassign it to the role that owns it; if the work is finished, close it with evidence.",
    since: since(shown[0]!),
  };
}

/** A rule whose rows could not be read: say so instead of silently checking nothing. */
export function unreadableCheck(rule: string, what: string, error: string): HealthCheck {
  return {
    key: `watch-unreadable:${rule}`,
    title: `The Cockpit could not check ${what}`,
    status: "warn",
    detail: `Reading ${what} failed: ${redactSecrets(error.replace(/\s+/g, " ")).slice(0, 160)}`,
    fix: "Check the Cockpit plugin is up to date (Settings → Plugins → Cockpit → Upgrade); it reads issues, issue relations and heartbeat runs. The next hourly check tries again.",
  };
}
