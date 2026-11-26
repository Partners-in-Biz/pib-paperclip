/**
 * Take over and resume (PAR-14514 design 3, stage S4): the Cockpit half of ending a take-over.
 *
 * - `browser.takeover.done {identity}`: `/release` on the daemon (ends the lease if live, closes the window, runs the
 *   session check). On `ok`: the identity is marked verified in the credentials register, its "Log in again" card is
 *   closed, and every task on the daemon's waiting list for the identity that passes the checks gets one comment
 *   ("Browser login for <identity> works again") and one `requestWakeup` (reason `browser_session_restored`). No
 *   status changes. Then those entries are cleared on the daemon. On not ok nothing is woken.
 * - `browser.takeover.stop {identity}`: `/release`, wakes nothing.
 * - `browser.takeover.waiting {identity}`: the tasks Done would wake, for the drawer. Reads only.
 * - All three work at every setting, so a take-over can always be ended.
 * - Setting change: `off` with anything live calls `/release {all:true}`; `view` with a live take-over ends it.
 *
 * The waiting list is read from the daemon at the moment of the write (the release answer), never from the browser.
 * One lock per identity: two admins or a double click give one comment and one wake per task. The activity log holds
 * identity, person and issue only; never screen content or input.
 */
import { randomBytes } from "node:crypto";
import type { Issue, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isOwnerCompany, type AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import {
  BrowserDaemonError,
  clearBrowserWaiting,
  parseWaiting,
  readBrowserDaemonStatus,
  releaseBrowserTakeover,
  type ReleaseResult,
  type WaitingEntry,
} from "./browser-daemon-client.js";
import { checkPerson, forgetTakeoverStream, isBrowserIdentity, readBrowserLiveSetting, type BrowserLiveSetting } from "./browser-live.js";
import { markBrowserIdentityVerified } from "./credentials.js";
import { CockpitError, message, type Env } from "./env.js";

export const SESSION_RESTORED_REASON = "browser_session_restored";
export const SESSION_RESTORED_SOURCE = "cockpit.browser_takeover";
const WAKEABLE = new Set<Issue["status"]>(["blocked", "in_progress"]);
/** The daemon keeps entries 7 days; a handled entry is remembered a little longer. */
const HANDLED_MS = 8 * 24 * 3600_000;

export const sessionRestoredComment = (identity: string) => `Browser login for ${identity} works again.`;

// ---------------------------------------------------------------------------
// Per-identity lock and the handled-entry memory (per worker)
// ---------------------------------------------------------------------------

const LOCKS = new WeakMap<object, Map<string, Promise<unknown>>>();
const HANDLED = new WeakMap<object, Map<string, number>>();

/** Runs `fn` after every earlier call for the same identity has finished. */
async function withIdentityLock<T>(env: Env, identity: string, fn: () => Promise<T>): Promise<T> {
  let locks = LOCKS.get(env.ctx);
  if (!locks) LOCKS.set(env.ctx, (locks = new Map()));
  const run = (locks.get(identity) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(identity, tail);
  void tail.then(() => { if (locks!.get(identity) === tail) locks!.delete(identity); });
  return run;
}

/** One waiting entry is commented on and woken once, even when clearing it on the daemon failed. */
function handledEntries(env: Env): Map<string, number> {
  let map = HANDLED.get(env.ctx);
  if (!map) HANDLED.set(env.ctx, (map = new Map()));
  const now = env.now().getTime();
  for (const [key, at] of map) if (now - at > HANDLED_MS) map.delete(key);
  return map;
}
const entryKey = (e: WaitingEntry) => `${e.identity}|${e.issue}|${e.at ?? ""}`;

// ---------------------------------------------------------------------------
// Which waiting tasks may be woken
// ---------------------------------------------------------------------------

export type SkipReason = "not_found" | "no_agent" | "status" | "open_blockers";
export interface WakeCandidate { entry: WaitingEntry; issue: Issue }
export interface WaitingSplit {
  wake: WakeCandidate[];
  skipped: Array<{ issue: string; why: SkipReason }>;
  /** The issue or its blockers could not be read: neither woken nor cleared. */
  unreadable: string[];
}

/**
 * The tasks on `waiting` for `identity` that are in this company, have an agent assignee, are `blocked` or
 * `in_progress` and have no unresolved blocker. One entry per issue.
 */
export async function splitWaiting(env: Env, companyId: string, identity: string, waiting: WaitingEntry[]): Promise<WaitingSplit> {
  const out: WaitingSplit = { wake: [], skipped: [], unreadable: [] };
  const seen = new Set<string>();
  for (const entry of waiting) {
    if (entry.identity !== identity || seen.has(entry.issue)) continue;
    seen.add(entry.issue);
    let issue: Issue | null;
    try {
      // The daemon records identifiers (PAR-123); the host resolves them, inside this company only.
      issue = await env.ctx.issues.get(entry.issue, companyId);
    } catch {
      out.unreadable.push(entry.issue);
      continue;
    }
    if (!issue || issue.companyId !== companyId) { out.skipped.push({ issue: entry.issue, why: "not_found" }); continue; }
    if (!issue.assigneeAgentId) { out.skipped.push({ issue: entry.issue, why: "no_agent" }); continue; }
    if (!WAKEABLE.has(issue.status)) { out.skipped.push({ issue: entry.issue, why: "status" }); continue; }
    try {
      const relations = await env.ctx.issues.relations.get(issue.id, companyId);
      if (relations.blockedBy.some((b) => b.status !== "done")) { out.skipped.push({ issue: entry.issue, why: "open_blockers" }); continue; }
    } catch {
      out.unreadable.push(entry.issue);
      continue;
    }
    out.wake.push({ entry, issue });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function requireIdentity(value: unknown): string {
  if (!isBrowserIdentity(value)) throw new CockpitError("identity is not valid");
  return value;
}

async function requirePerson(env: Env, context: PluginPerformActionContext): Promise<{ userId: string; companyId: string }> {
  const who = await checkPerson(env, context.companyId, context.actor?.type, context.actor?.userId);
  if (!who.ok) throw new CockpitError(who.reason);
  return { userId: who.userId, companyId: context.companyId! };
}

async function release(body: Parameters<typeof releaseBrowserTakeover>[0]): Promise<ReleaseResult> {
  try {
    return await releaseBrowserTakeover(body);
  } catch (error) {
    if (error instanceof BrowserDaemonError) throw new CockpitError(`${error.message}. Nothing was woken.`);
    throw error;
  }
}

/** One activity line; a failed write is logged and never stops the release that already happened. */
async function note(env: Env, companyId: string, key: string, text: string): Promise<void> {
  await recordActivity(env.ctx, companyId, { key: `browser-live:${key}`.slice(0, 300), kind: "browser_live", at: env.now().toISOString(), text, href: "/cockpit", agentId: null })
    .catch((error: unknown) => env.ctx.logger.warn("Browser take-over activity not recorded", { companyId, error: message(error) }));
}
const once = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

/** Lease end and check result, as two activity lines. */
async function noteRelease(env: Env, companyId: string, identity: string, userId: string | null, how: "Done" | "Stop" | "setting", r: ReleaseResult): Promise<void> {
  const id = once();
  const by = how === "setting" ? "the Cockpit setting changed" : `${how} by user ${userId}`;
  await note(env, companyId, `takeover-end:${identity}:${id}`, `Take-over for ${identity} ended: ${by}`);
  await note(env, companyId, `takeover-check:${identity}:${id}`, `Browser session check for ${identity}: ${r.ok ? "logged in" : "not logged in"} (${r.reason})`);
}

export interface DoneResult {
  ok: boolean;
  reason: string;
  /** Issue identifiers that got the comment and the wake. */
  woken: string[];
  /** Commented on, but the host refused the wake (budget, a race on status). */
  wakeFailed: string[];
  skipped: WaitingSplit["skipped"];
  message: string;
}

const REASON_WORDS: Record<string, string> = {
  session_expired: "the site still shows the login page",
  no_take_over: "there was no take-over to end",
  take_over_other_identity: "another login is being taken over right now",
};

export async function takeoverDone(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<DoneResult> {
  const { userId, companyId } = await requirePerson(env, context);
  const identity = requireIdentity(params.identity);
  return withIdentityLock(env, identity, async () => {
    const r = await release({ identity });
    forgetTakeoverStream(env, identity);
    await noteRelease(env, companyId, identity, userId, "Done", r);
    if (!r.ok) {
      return { ok: false, reason: r.reason, woken: [], wakeFailed: [], skipped: [], message: `The login for ${identity} did not hold (${REASON_WORDS[r.reason] ?? r.reason}). Nothing was woken. Take over again and log in.` };
    }
    await markBrowserIdentityVerified(env, companyId, identity).catch((error: unknown) => env.ctx.logger.warn("Browser login not marked verified", { companyId, identity, error: message(error) }));

    const handled = handledEntries(env);
    const mine = r.waiting.filter((e) => e.identity === identity);
    const split = await splitWaiting(env, companyId, identity, mine.filter((e) => !handled.has(entryKey(e))));
    const woken: string[] = [];
    const wakeFailed: string[] = [];
    // Skipped entries go too (the login works now); an entry handled before but not cleared then is cleared now.
    const clear = new Set<string>([...split.skipped.map((s) => s.issue), ...mine.filter((e) => handled.has(entryKey(e))).map((e) => e.issue)]);
    for (const { entry, issue } of split.wake) {
      const ref = issue.identifier ?? entry.issue;
      handled.set(entryKey(entry), env.now().getTime());
      try {
        await env.ctx.issues.createComment(issue.id, sessionRestoredComment(identity), companyId);
      } catch (error) {
        handled.delete(entryKey(entry));
        env.ctx.logger.warn("Browser take-over: comment not posted, task not woken", { companyId, issue: ref, error: message(error) });
        continue;
      }
      clear.add(entry.issue);
      try {
        await env.ctx.issues.requestWakeup(issue.id, companyId, {
          reason: SESSION_RESTORED_REASON,
          contextSource: SESSION_RESTORED_SOURCE,
          idempotencyKey: `${SESSION_RESTORED_REASON}:${identity}:${issue.id}:${entry.at ?? ""}`,
        });
        woken.push(ref);
        await note(env, companyId, `takeover-woken:${identity}:${entry.issue}:${entry.at ?? once()}`, `Woke ${ref}: browser login for ${identity} restored by user ${userId}`);
      } catch (error) {
        wakeFailed.push(ref);
        env.ctx.logger.warn("Browser take-over: task not woken", { companyId, issue: ref, error: message(error) });
      }
    }
    if (clear.size) {
      await clearBrowserWaiting(identity, [...clear]).catch((error: unknown) => env.ctx.logger.warn("Browser waiting list not cleared", { identity, error: message(error) }));
    }
    const words = woken.length ? `Woke ${woken.join(", ")}.` : "No task was waiting for it.";
    return {
      ok: true,
      reason: r.reason,
      woken,
      wakeFailed,
      skipped: split.skipped,
      message: `The login for ${identity} works. ${words}${wakeFailed.length ? ` Could not wake ${wakeFailed.join(", ")}.` : ""}`,
    };
  });
}

export async function takeoverStop(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<{ ok: boolean; reason: string; message: string }> {
  const { userId, companyId } = await requirePerson(env, context);
  const identity = requireIdentity(params.identity);
  return withIdentityLock(env, identity, async () => {
    const r = await release({ identity });
    forgetTakeoverStream(env, identity);
    await noteRelease(env, companyId, identity, userId, "Stop", r);
    return { ok: r.ok, reason: r.reason, message: `Take-over for ${identity} stopped. Nothing was woken.` };
  });
}

/** For the drawer: the tasks Done would wake now (identifier and title only). Reads only. */
export async function takeoverWaiting(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext, readStatus = readBrowserDaemonStatus): Promise<{ tasks: Array<{ identifier: string; title: string }> }> {
  const { companyId } = await requirePerson(env, context);
  const identity = requireIdentity(params.identity);
  let status: Record<string, unknown>;
  try {
    status = await readStatus();
  } catch {
    return { tasks: [] };
  }
  const split = await splitWaiting(env, companyId, identity, parseWaiting(status.waiting));
  return { tasks: split.wake.map(({ entry, issue }) => ({ identifier: issue.identifier ?? entry.issue, title: String(issue.title ?? "").slice(0, 120) })) };
}

/**
 * The setting changed. `off`: anything live (a take-over or a viewer) ends with `/release {all:true}`. `view`: a live
 * take-over ends (`/release {identity}`), viewers stay. Nothing is woken. Only the owner company's setting counts.
 * Never throws: a failed call is logged.
 */
export async function browserLiveConfigChanged(env: Env, config: Record<string, unknown> | null | undefined, companyId: string | null, readStatus = readBrowserDaemonStatus): Promise<void> {
  try {
    if (companyId && !(await isOwnerCompany(env.ctx, companyId))) return;
    const raw = config?.browserLive;
    const setting: BrowserLiveSetting = raw === "view" || raw === "takeover" ? raw : companyId ? await readBrowserLiveSetting(env, companyId) : "off";
    if (setting === "takeover") return;
    const status = await readStatus().catch(() => null);
    const lease = status?.lease && typeof status.lease === "object" ? (status.lease as Record<string, unknown>) : null;
    const live = lease?.state === "live" && isBrowserIdentity(lease.identity) ? lease.identity : null;
    const viewers = typeof status?.viewers === "number" ? status.viewers : 0;
    let r: ReleaseResult | null = null;
    // Status unreadable at `off`: release everything anyway (fail closed).
    if (setting === "off" && (!status || live || viewers > 0)) r = await releaseBrowserTakeover({ all: true });
    else if (setting === "view" && live) r = await releaseBrowserTakeover({ identity: live });
    if (!r) return;
    forgetTakeoverStream(env);
    env.ctx.logger.info("Browser live ended by the setting", { setting, reason: r.reason });
    if (live && companyId) await noteRelease(env, companyId, live, null, "setting", r);
  } catch (error) {
    env.ctx.logger.warn("Browser live: ending the take-over after a setting change failed", { companyId, error: message(error) });
  }
}

export function registerBrowserTakeover(env: Env, guard: AccessGuard): void {
  guard.action("browser.takeover.done", async (params, context) => takeoverDone(env, params, context));
  guard.action("browser.takeover.stop", async (params, context) => takeoverStop(env, params, context));
  guard.action("browser.takeover.waiting", async (params, context) => takeoverWaiting(env, params, context));
}
