/**
 * The daily calendar check (Peet, 17 Nov 2026: "how can things get scheduled that are not ready to go out?").
 *
 * Only a `scheduled` post is ever published. A draft, a post in review or an approved post without a schedule keeps a
 * proposed time and sits on the calendar at that slot, so nobody noticed when the slot passed, and copies of one post piled
 * up next to the copy that went out. Once a day (first hourly upkeep after 06:00 in the company's time zone) this lists, per
 * scope, on one issue for the Social agent:
 * - missed: proposed time passed, never approved (last 14 days);
 * - next 48 hours: proposed, not approved yet (it will not go out unless it is approved in time);
 * - same opening: posts in the same scope with the same first words (a stale copy of a post that went out, or two
 *   scheduled copies that would both publish to one account).
 * It changes no post: a proposed time is part of the content hash, so clearing it would void the Reviewer's pass. The
 * agent archives copies (`archive-post`) and moves or chases the rest.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientPrefix, formatClientParam, scopeOfRow } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { iso, table } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, projectIdForRow, socialAssignee } from "./issues.js";
import { socialPath } from "./oauth/flow.js";
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { cadenceGaps, cadenceSection, getCadence } from "./cadence.js";
import { PLATFORM_LABELS, type SocialPlatform } from "./platforms.js";
import { whenText } from "./schedule.js";

const DAY_MS = 86_400_000;
/** How far back a missed post is still listed. */
export const MISSED_WINDOW_MS = 14 * DAY_MS;
/** How far ahead a post that is not approved yet is listed. */
export const UPCOMING_WINDOW_MS = 2 * DAY_MS;
/** Hour of the company's day from which the check runs (it runs once a day). */
export const CHECK_HOUR = 6;
/** Characters of the normalised opening that make two posts "the same opening". */
export const OPENING_CHARS = 40;
const MAX_LINES = 40;

const NOT_SCHEDULED = new Set(["draft", "review", "approved"]);
const GOING_OUT = new Set(["scheduled", "publishing"]);
const WENT_OUT = new Set(["published", "partially_published"]);

export interface CalendarRow {
  id: string;
  status: string;
  /** The slot: the proposed or scheduled time, or when it was published. */
  at: string;
  body: string;
  scopeKey: string;
  accounts: string[];
}

export interface DuplicateGroup {
  opening: string;
  rows: CalendarRow[];
  /** Two scheduled copies share an account: both would publish there. */
  doublePublish: boolean;
}

export interface CalendarFindings {
  missed: CalendarRow[];
  upcoming: CalendarRow[];
  duplicates: DuplicateGroup[];
}

/** The first words of a post, lower case, letters and digits only. Short openings ("Hi.") never match. Pure. */
export function openingOf(body: string): string | null {
  const text = body.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, OPENING_CHARS).trim();
  return text.length >= 15 ? text : null;
}

/** What the check reports for one scope's rows. Pure. */
export function calendarFindings(rows: CalendarRow[], now: number): CalendarFindings {
  const missed: CalendarRow[] = [];
  const upcoming: CalendarRow[] = [];
  const byOpening = new Map<string, CalendarRow[]>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    if (NOT_SCHEDULED.has(row.status)) {
      if (at < now && at >= now - MISSED_WINDOW_MS) missed.push(row);
      else if (at >= now && at <= now + UPCOMING_WINDOW_MS) upcoming.push(row);
    }
    const opening = openingOf(row.body);
    if (opening) byOpening.set(`${row.scopeKey}|${opening}`, [...(byOpening.get(`${row.scopeKey}|${opening}`) ?? []), row]);
  }
  const duplicates: DuplicateGroup[] = [];
  for (const [key, group] of byOpening) {
    if (group.length < 2) continue;
    // Something is still to do: a copy not out yet. A group that only went out is history.
    if (!group.some((row) => NOT_SCHEDULED.has(row.status) || GOING_OUT.has(row.status))) continue;
    const scheduled = group.filter((row) => GOING_OUT.has(row.status));
    const doublePublish = scheduled.some((a, i) => scheduled.slice(i + 1).some((b) => a.accounts.some((acc) => b.accounts.includes(acc))));
    const sorted = [...group].sort((a, b) => a.at.localeCompare(b.at));
    duplicates.push({ opening: key.slice(key.indexOf("|") + 1), rows: sorted, doublePublish });
  }
  const byTime = (a: CalendarRow, b: CalendarRow) => a.at.localeCompare(b.at);
  duplicates.sort((a, b) => Number(b.doublePublish) - Number(a.doublePublish) || a.rows[0]!.at.localeCompare(b.rows[0]!.at));
  return { missed: missed.sort(byTime), upcoming: upcoming.sort(byTime), duplicates };
}

/** True when there is nothing to report. Pure. */
export function findingsEmpty(f: CalendarFindings): boolean {
  return f.missed.length === 0 && f.upcoming.length === 0 && f.duplicates.length === 0;
}

function statusText(status: string): string {
  return status === "review" ? "in review" : status.replace("_", " ");
}

function line(row: CalendarRow, timeZone: string): string {
  return `- ${whenText(row.at, timeZone)} · ${statusText(row.status)} · \`${row.id.slice(0, 8)}\` · ${clip(row.body.replace(/\s+/g, " ").trim(), 70)}`;
}

function capped(lines: string[]): string[] {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- … and ${lines.length - MAX_LINES} more (list-posts shows them all).`] : lines;
}

/** The issue text for one scope. Pure. */
export function calendarCheckDescription(f: CalendarFindings, timeZone: string, pagePath: string | null, fill: string[] = []): string {
  const out: string[] = [
    "Only a **scheduled** post is published. Drafts, posts in review and approved posts without a schedule only *propose* a time: the calendar shows them at that slot (dashed), but nothing goes out until the post is approved and scheduled.",
    "",
    ...fill,
  ];
  const doubles = f.duplicates.filter((g) => g.doublePublish);
  if (doubles.length) {
    out.push("## Will publish twice", "Two scheduled copies go to the same account. Take one off with `unschedule-post` (give the reason), then `archive-post` it.", "");
    for (const group of doubles) out.push(...group.rows.map((row) => line(row, timeZone)), "");
  }
  if (f.missed.length) {
    out.push("## Missed: the proposed time passed, never approved", "Each one either gets a new time (`update-post`, then `request-review` again) or, when it is a stale copy or no longer wanted, `archive-post` (reversible).", "");
    out.push(...capped(f.missed.map((row) => line(row, timeZone))), "");
  }
  if (f.upcoming.length) {
    out.push("## Next 48 hours, not approved yet", "These go out only if they are approved before their time. Get each through review and approval, or move it.", "");
    out.push(...capped(f.upcoming.map((row) => line(row, timeZone))), "");
  }
  const copies = f.duplicates.filter((g) => !g.doublePublish);
  if (copies.length) {
    out.push("## Same opening on the calendar", "Posts in this scope that start with the same words. Keep the one that is going out (or went out) and `archive-post` the stale copies; rewrite the opening if both should stay.", "");
    for (const group of copies.slice(0, 15)) out.push(...group.rows.map((row) => line(row, timeZone)), "");
  }
  out.push(pagePath ? `Open the calendar: [Social → Posts](${pagePath})` : "Open the calendar on the Social page → Posts.", "Close this issue when each line is dealt with. A new check runs tomorrow.");
  return out.join("\n");
}

const STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "social-calendar-check", stateKey: "last-day" });

/** The company's calendar day and hour. Pure. */
export function localDayHour(now: Date, timeZone: string): { day: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
  } catch {
    return { day: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
  }
}

interface QueryRow {
  id: string;
  status: string;
  scheduled_at: unknown;
  published_at: unknown;
  body: string;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  accounts: string | null;
}

interface AccountQueryRow {
  id: string;
  platform: string;
  display_name: string;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
}

type ScopeRow = Pick<QueryRow, "client_kind" | "client_ref" | "client_name">;

const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const ISSUE_STATE = (companyId: string, scopeKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "social-calendar-check", stateKey: `issue:${scopeKey}` });

/**
 * Runs the check once a day per company: the first call at or after CHECK_HOUR local time reports, per scope with
 * findings or cadence gaps, to the Social agent. A scope whose check issue from an earlier day is still open gets the
 * new report as a comment there (and a wake-up) instead of a second issue. Never throws.
 */
export async function runCalendarCheck(ctx: PluginContext, companyId: string, now: Date = new Date()): Promise<{ ran: boolean; opened: number; commented: number }> {
  const none = { ran: false, opened: 0, commented: 0 };
  try {
    const config = await loadSocialConfig(ctx, companyId);
    const timeZone = config.timezone || "UTC";
    const { day, hour } = localDayHour(now, timeZone);
    if (hour < CHECK_HOUR) return none;
    const last = await ctx.state.get(STATE(companyId)).catch(() => null);
    if (last === day) return none;
    // Mark the day first: a failure below must not report every hour.
    await ctx.state.set(STATE(companyId), day);
    const [rows, accountRows] = await Promise.all([
      ctx.db.query<QueryRow>(
        `SELECT p.id, p.status, p.scheduled_at, p.published_at, p.body, p.client_kind, p.client_ref, p.client_name,
                (SELECT string_agg(d.account_id, ',') FROM ${table(ctx, "destinations")} d WHERE d.post_id = p.id) AS accounts
           FROM ${table(ctx, "posts")} p
          WHERE p.company_id = $1 AND p.archived_at IS NULL AND p.scope = 'org'
            AND coalesce(p.published_at, p.scheduled_at) BETWEEN now() - interval '14 days' AND now() + interval '9 days'
            AND p.status IN ('draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'partially_published')`,
        [companyId],
      ),
      ctx.db.query<AccountQueryRow>(
        `SELECT id, platform, display_name, client_kind, client_ref, client_name FROM ${table(ctx, "accounts")}
          WHERE company_id = $1 AND scope = 'org' AND status <> 'disabled'`,
        [companyId],
      ),
    ]);
    const keyOf = (row: ScopeRow) => {
      const scope = scopeOfRow(row);
      return scope ? formatClientParam(scope) : "own";
    };
    const byScope = new Map<string, { rows: CalendarRow[]; sample: ScopeRow; accounts: AccountQueryRow[] }>();
    const entryFor = (row: ScopeRow) => {
      const key = keyOf(row);
      const entry = byScope.get(key) ?? { rows: [], sample: { client_kind: row.client_kind, client_ref: row.client_ref, client_name: row.client_name }, accounts: [] };
      byScope.set(key, entry);
      return { key, entry };
    };
    for (const row of rows) {
      const at = WENT_OUT.has(row.status) ? iso(row.published_at) ?? iso(row.scheduled_at) : iso(row.scheduled_at);
      if (!at) continue;
      const { key, entry } = entryFor(row);
      entry.rows.push({ id: row.id, status: row.status, at, body: row.body ?? "", scopeKey: key, accounts: row.accounts ? row.accounts.split(",") : [] });
    }
    for (const account of accountRows) entryFor(account).entry.accounts.push(account);
    let opened = 0;
    let commented = 0;
    for (const [scopeKey, { rows: scoped, sample, accounts }] of byScope) {
      const scope = scopeOfRow(sample);
      // The 14-day look-back belongs to the findings; the cadence counts every row it is given.
      const findings = calendarFindings(scoped.filter((r) => Date.parse(r.at) <= now.getTime() + 3 * DAY_MS), now.getTime());
      const cadence = accounts.length ? await getCadence(ctx, companyId, scope) : null;
      const names = new Map(accounts.map((a) => [a.id, `${PLATFORM_LABELS[a.platform as SocialPlatform] ?? a.platform} (${a.display_name})`]));
      const gaps = cadence ? cadenceGaps(cadence, accounts.map((a) => ({ id: a.id, platform: a.platform, name: names.get(a.id)! })), scoped.map((r) => ({ at: r.at, accounts: r.accounts })), now, timeZone) : [];
      const fill = cadence ? cadenceSection(cadence, gaps, names) : [];
      const freeSlots = gaps.reduce((n, d) => n + d.free.length, 0);
      if (findingsEmpty(findings) && freeSlots === 0) continue;
      try {
        const pagePath = await socialPath(ctx, companyId, { tab: "calendar" }, scope).catch(() => null);
        const counts = [freeSlots ? `${freeSlots} free slots to fill` : "", findings.missed.length ? `${findings.missed.length} missed` : "", findings.upcoming.length ? `${findings.upcoming.length} not approved for the next 48 h` : "", findings.duplicates.length ? `${findings.duplicates.length} same-opening groups` : ""].filter(Boolean).join(", ");
        const description = calendarCheckDescription(findings, timeZone, pagePath, fill);
        const existing = await ctx.state.get(ISSUE_STATE(companyId, scopeKey)).catch(() => null);
        if (typeof existing === "string" && existing) {
          const issue = (await ctx.issues.get(existing, companyId).catch(() => null)) as { status?: string; assigneeAgentId?: string | null } | null;
          if (issue && OPEN_ISSUE.has(String(issue.status))) {
            await ctx.issues.createComment(existing, `**Calendar check ${day}: ${counts}**\n\n${description}`, companyId);
            if (issue.assigneeAgentId) await wakeIssue(ctx, existing, companyId, "Daily social calendar check");
            commented += 1;
            continue;
          }
        }
        const assignee = await socialAssignee(ctx, companyId);
        const created = await createIssueSafely(ctx, {
          companyId,
          projectId: await projectIdForRow(ctx, companyId, sample),
          title: `${clientPrefix(sample)}Social calendar check ${day}: ${counts}`,
          description,
          priority: findings.duplicates.some((g) => g.doublePublish) ? "high" : "medium",
          originKind: ORIGIN_KIND,
          originId: `calendar-check:${scopeKey}:${day}`,
          assigneeAgentId: assignee.assigneeAgentId,
          assigneeUserId: assignee.assigneeUserId,
          wakeReason: "Daily social calendar check",
        });
        await ctx.state.set(ISSUE_STATE(companyId, scopeKey), created.id).catch(() => undefined);
        opened += 1;
      } catch (error) {
        ctx.logger.info("Social calendar check issue not opened", { companyId, scope: scopeKey, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ran: true, opened, commented };
  } catch (error) {
    ctx.logger.info("Social calendar check skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    return none;
  }
}
