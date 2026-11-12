/**
 * The People and Results tabs of a campaign: everyone enrolled with where they
 * stand and what happened to them, and the numbers per step and version.
 *
 * Reads only. The state of a person and the results table are pure functions,
 * so the screen says the same thing the tests check.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isoTime, table } from "./db.js";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type PersonStateKey =
  | "held"
  | "waiting-agent"
  | "sending"
  | "due"
  | "scheduled"
  | "replied"
  | "opted-out"
  | "bounced"
  | "finished"
  | "stopped";

export type PersonTone = "ok" | "warn" | "bad" | "info" | "neutral";

export interface PersonEvent {
  /** `sent`, `delivered`, `open`, `click`, `reply`, `bounce`, `soft_bounce`, `complaint`, `unsubscribe`, `failed`. */
  type: string;
  stepPosition: number;
  count: number;
  /** When it last happened (ISO), or null when the row has no time. */
  at: string | null;
}

export interface PersonRow {
  enrollmentId: string;
  contactId: string;
  /** From the CRM copy; null when the contact is no longer there. */
  name: string | null;
  email: string | null;
  status: string;
  stepPosition: number;
  variant: string;
  nextDueAt: string | null;
  enrolledAt: string | null;
  /** The open task for this person's step, when an agent sends it by hand. */
  task: { id: string; identifier: string | null; status: string } | null;
  sending: boolean;
  events: PersonEvent[];
}

export interface PersonState {
  key: PersonStateKey;
  /** A few plain words: "Email 2 sent, replied". */
  label: string;
  /** What comes next for this person, or why nothing does. */
  next: string;
  tone: PersonTone;
}

export interface PersonView extends PersonRow {
  state: PersonState;
  /** Emails that went out to this person. */
  sent: number;
}

const DUE_SOON_MS = 5 * 60_000;

function count(events: PersonEvent[], type: string): number {
  return events.filter((event) => event.type === type).reduce((total, event) => total + event.count, 0);
}

/** "Email 2" from a step position, numbered as the screen numbers the steps (1, 2, 3 even when positions skip). */
export function stepLabel(position: number, numbers: Map<number, number>): string {
  return `Email ${numbers.get(position) ?? position}`;
}

function shortDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Where one person stands, in plain words. `numbers` maps a step position to
 * its number on the screen. Pure: `now` is passed in.
 */
export function personState(row: PersonRow, numbers: Map<number, number>, now: Date = new Date()): PersonState {
  const sent = count(row.events, "sent");
  const lastSent = row.events.filter((event) => event.type === "sent").sort((a, b) => b.stepPosition - a.stepPosition)[0] ?? null;
  const sentText = lastSent ? `${stepLabel(lastSent.stepPosition, numbers)} sent` : "Nothing sent";
  const current = stepLabel(row.stepPosition, numbers);

  if (row.status !== "running") {
    if (count(row.events, "unsubscribe") > 0 || count(row.events, "complaint") > 0) {
      return { key: "opted-out", label: `${sentText}, opted out`, next: "Stopped: opted out. Never emailed by this sender again.", tone: "warn" };
    }
    if (count(row.events, "bounce") > 0) {
      return { key: "bounced", label: `${sentText}, bounced`, next: "Stopped: the address does not work.", tone: "bad" };
    }
    if (count(row.events, "reply") > 0) {
      return { key: "replied", label: `${sentText}, replied`, next: "Stopped: they replied.", tone: "ok" };
    }
    if (row.status === "done") return { key: "finished", label: sent ? `All ${sent === 1 ? "1 email" : `${sent} emails`} sent` : "Finished", next: "Finished. Nothing more goes out.", tone: "neutral" };
    return { key: "stopped", label: sent ? `${sentText}, then stopped` : "Stopped before the first email", next: "Stopped. Nothing more goes out.", tone: "neutral" };
  }

  if (row.task) {
    if (row.task.status === "blocked") {
      return { key: "held", label: `${current} held`, next: `${row.task.identifier ? `Task ${row.task.identifier}` : "Its task"} is blocked. Nothing goes out until that is fixed.`, tone: "bad" };
    }
    return { key: "waiting-agent", label: `${current} waiting for the agent`, next: `The agent sends it from task ${row.task.identifier ?? "(open)"}.`, tone: "warn" };
  }
  if (row.sending) return { key: "sending", label: `${current} sending now`, next: "Going out now.", tone: "info" };
  const due = row.nextDueAt ? Date.parse(row.nextDueAt) : Number.NaN;
  if (Number.isFinite(due) && due > now.getTime() + DUE_SOON_MS) {
    return { key: "scheduled", label: sent ? sentText : "Enrolled", next: `${current} on ${shortDay(row.nextDueAt!)}.`, tone: sent ? "ok" : "neutral" };
  }
  return { key: "due", label: sent ? sentText : "Enrolled", next: `${current} is due now.`, tone: "info" };
}

/** The rows the People tab shows: each person with their state, people who need a fix first. */
export function peopleView(rows: PersonRow[], steps: Array<{ position: number; variant?: string | null }>, now: Date = new Date()): PersonView[] {
  const numbers = stepNumbers(steps);
  const order: Record<PersonStateKey, number> = { held: 0, "waiting-agent": 1, sending: 2, due: 3, scheduled: 4, replied: 5, "opted-out": 6, bounced: 7, finished: 8, stopped: 9 };
  return rows
    .map((row) => ({ ...row, state: personState(row, numbers, now), sent: count(row.events, "sent") }))
    .sort((a, b) => order[a.state.key] - order[b.state.key] || (a.name ?? "~").localeCompare(b.name ?? "~"));
}

/** How many people are in each state, for the cards above the list. */
export function peopleSummary(people: PersonView[]): { total: number; waiting: number; held: number; emailed: number; replied: number; optedOut: number; bounced: number; finished: number } {
  const summary = { total: people.length, waiting: 0, held: 0, emailed: 0, replied: 0, optedOut: 0, bounced: 0, finished: 0 };
  for (const person of people) {
    if (person.sent > 0) summary.emailed += 1;
    if (person.state.key === "held") summary.held += 1;
    if (person.state.key === "waiting-agent" || person.state.key === "due" || person.state.key === "sending") summary.waiting += 1;
    if (person.state.key === "replied") summary.replied += 1;
    if (person.state.key === "opted-out") summary.optedOut += 1;
    if (person.state.key === "bounced") summary.bounced += 1;
    if (person.state.key === "finished") summary.finished += 1;
  }
  return summary;
}

/** Step positions numbered 1, 2, 3 in send order, as the screen numbers them (positions may skip). */
export function stepNumbers(steps: Array<{ position: number }>): Map<number, number> {
  const positions = [...new Set(steps.map((step) => step.position))].sort((x, y) => x - y);
  return new Map(positions.map((position, index) => [position, index + 1]));
}

/** Everyone enrolled in one campaign, with their open step task and what happened to them. At most `limit` people. */
export async function enrollmentPeople(ctx: PluginContext, companyId: string, campaignId: string, limit = 500): Promise<PersonRow[]> {
  const cap = Math.max(1, Math.min(limit, 1000));
  const rows = await ctx.db.query<{
    id: string; contact_id: string; status: string; step_position: number; variant: string | null; next_due_at: unknown; created_at: unknown;
    open_issue_id: string | null; sending_key: string | null; name: string | null; emails: string[] | null;
    issue_identifier: string | null; issue_status: string | null;
  }>(
    `SELECT e.id, e.contact_id, e.status, e.step_position, e.variant, e.next_due_at, e.created_at, e.open_issue_id, e.sending_key,
            c.name, c.emails, i.identifier AS issue_identifier, i.status AS issue_status
       FROM ${table(ctx, "campaign_enrollments")} e
       LEFT JOIN ${table(ctx, "crm_contacts")} c ON c.id = e.contact_id AND c.company_id = e.company_id
       LEFT JOIN public.issues i ON i.id::text = e.open_issue_id
      WHERE e.company_id = $1 AND e.campaign_id = $2
      ORDER BY (e.status = 'running') DESC, e.next_due_at ASC NULLS LAST, e.created_at
      LIMIT ${cap}`,
    [companyId, campaignId],
  );
  const events = await ctx.db.query<{ enrollment_id: string; event_type: string; step_position: number; count: string | number; last_at: unknown }>(
    `SELECT enrollment_id, event_type, step_position, count(*) AS count, max(occurred_at) AS last_at
       FROM ${table(ctx, "campaign_step_events")}
      WHERE company_id = $1 AND campaign_id = $2
      GROUP BY enrollment_id, event_type, step_position
      ORDER BY max(occurred_at)`,
    [companyId, campaignId],
  );
  const byEnrollment = new Map<string, PersonEvent[]>();
  for (const event of events) {
    const list = byEnrollment.get(event.enrollment_id) ?? [];
    list.push({ type: event.event_type, stepPosition: Number(event.step_position), count: Number(event.count ?? 0), at: isoTime(event.last_at) });
    byEnrollment.set(event.enrollment_id, list);
  }
  return rows.map((row) => ({
    enrollmentId: row.id,
    contactId: row.contact_id,
    name: row.name ?? null,
    email: Array.isArray(row.emails) && row.emails.length > 0 ? row.emails[0]! : null,
    status: row.status,
    stepPosition: Number(row.step_position),
    variant: row.variant ?? "a",
    nextDueAt: isoTime(row.next_due_at),
    enrolledAt: isoTime(row.created_at),
    // A closed task is about to be picked up by the due-steps job: it no longer holds the person.
    task: row.open_issue_id && row.issue_status !== "done" && row.issue_status !== "cancelled"
      ? { id: row.open_issue_id, identifier: row.issue_identifier ?? null, status: row.issue_status ?? "todo" }
      : null,
    sending: Boolean(row.sending_key),
    events: byEnrollment.get(row.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ResultCounts {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  softBounces: number;
  complaints: number;
  unsubscribes: number;
  failed: number;
}

export interface StepResult {
  position: number;
  /** The step's number on the screen. */
  number: number;
  subject: string;
  /** Subject of the B version, when the step has one. */
  subjectB: string | null;
  channel: string;
  totals: ResultCounts;
  /** Per version, only when the step has a B version. */
  versions: { a: ResultCounts; b: ResultCounts } | null;
}

export interface CampaignResults {
  totals: ResultCounts;
  steps: StepResult[];
  /** True when the email provider told us about deliveries (Gmail sends report none). */
  providerReports: boolean;
  /** True when at least one open or click was recorded (tracking is off unless someone switched it on). */
  tracked: boolean;
}

const EVENT_KEY: Record<string, keyof ResultCounts> = {
  sent: "sent", delivered: "delivered", open: "opens", click: "clicks", reply: "replies", bounce: "bounces",
  soft_bounce: "softBounces", complaint: "complaints", unsubscribe: "unsubscribes", failed: "failed",
};

export function emptyCounts(): ResultCounts {
  return { sent: 0, delivered: 0, opens: 0, clicks: 0, replies: 0, bounces: 0, softBounces: 0, complaints: 0, unsubscribes: 0, failed: 0 };
}

/** A share of the emails sent, or null when nothing was sent. */
export function rate(part: number, sent: number): number | null {
  return sent > 0 ? part / sent : null;
}

export interface ResultRow { stepPosition: number; variant: string | null; eventType: string; count: number }

/** The results table: totals, then one row per step in order, split by version where a step has a B. Pure. */
export function resultsView(
  steps: Array<{ position: number; subject: string; variant?: string | null; channel?: string | null }>,
  rows: ResultRow[],
): CampaignResults {
  const totals = emptyCounts();
  const byStep = new Map<number, { all: ResultCounts; a: ResultCounts; b: ResultCounts }>();
  for (const row of rows) {
    const key = EVENT_KEY[row.eventType];
    if (!key) continue;
    const bucket = byStep.get(row.stepPosition) ?? { all: emptyCounts(), a: emptyCounts(), b: emptyCounts() };
    bucket.all[key] += row.count;
    bucket[row.variant === "b" ? "b" : "a"][key] += row.count;
    totals[key] += row.count;
    byStep.set(row.stepPosition, bucket);
  }
  const numbers = stepNumbers(steps);
  const known = new Set(numbers.keys());
  const result: StepResult[] = [...numbers.entries()].map(([position, number]) => {
    const versions = steps.filter((step) => step.position === position);
    const a = versions.find((step) => step.variant !== "b") ?? versions[0]!;
    const b = versions.find((step) => step.variant === "b" && step !== a) ?? null;
    const hasB = Boolean(b);
    const bucket = byStep.get(position);
    return {
      position,
      number,
      subject: a.subject,
      subjectB: b?.subject ?? null,
      channel: a.channel ?? "email",
      totals: bucket?.all ?? emptyCounts(),
      versions: hasB ? { a: bucket?.a ?? emptyCounts(), b: bucket?.b ?? emptyCounts() } : null,
    };
  });
  // Events of a step that was since removed still count in the totals; show them so the rows add up.
  for (const [position, bucket] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
    if (!known.has(position)) result.push({ position, number: position, subject: "(a step that was removed)", subjectB: null, channel: "email", totals: bucket.all, versions: null });
  }
  return { totals, steps: result, providerReports: totals.delivered + totals.softBounces + totals.complaints > 0, tracked: totals.opens + totals.clicks > 0 };
}

export async function resultRows(ctx: PluginContext, companyId: string, campaignId: string): Promise<ResultRow[]> {
  const rows = await ctx.db.query<{ step_position: number; variant: string | null; event_type: string; count: string | number }>(
    `SELECT step_position, variant, event_type, count(*) AS count
       FROM ${table(ctx, "campaign_step_events")}
      WHERE company_id = $1 AND campaign_id = $2
      GROUP BY step_position, variant, event_type`,
    [companyId, campaignId],
  );
  return rows.map((row) => ({ stepPosition: Number(row.step_position), variant: row.variant ?? null, eventType: row.event_type, count: Number(row.count ?? 0) }));
}

// ---------------------------------------------------------------------------
// Step tasks per campaign (for the list and the "needs attention" strip)
// ---------------------------------------------------------------------------

export interface TaskCounts { waiting: number; blocked: number; oldestAt: string | null }

/** Open step tasks per campaign in one company: how many people wait on an agent, how many of those tasks are blocked, and since when. */
export async function stepTaskCounts(ctx: PluginContext, companyId: string): Promise<Map<string, TaskCounts>> {
  const rows = await ctx.db.query<{ campaign_id: string; waiting: string | number; blocked: string | number; oldest: unknown }>(
    `SELECT e.campaign_id, count(*) AS waiting, count(*) FILTER (WHERE i.status = 'blocked') AS blocked, min(i.created_at) AS oldest
       FROM ${table(ctx, "campaign_enrollments")} e JOIN public.issues i ON i.id::text = e.open_issue_id
      WHERE e.company_id = $1 AND e.status = 'running' AND i.status NOT IN ('done', 'cancelled')
      GROUP BY e.campaign_id`,
    [companyId],
  );
  return new Map(rows.map((row) => [row.campaign_id, { waiting: Number(row.waiting ?? 0), blocked: Number(row.blocked ?? 0), oldestAt: isoTime(row.oldest) }]));
}
