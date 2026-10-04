/**
 * How much a sending domain may send, and when its record says it is hurting the sender's reputation.
 *
 * **Warm-up.** A domain that has never sent mail has no reputation, and mailbox providers treat a sudden volume from a new
 * domain as spam. So a new domain's daily cap ramps up. Day 1 is the UTC day of its first send:
 *
 *   day  1    2    3    4    5     6     7     8     9     10    11    12    13    14+
 *   cap  50   100  200  400  700   1000  1500  2000  3000  4000  5000  6000  8000  the steady cap
 *
 * The steady cap is the Mailbox setting `esp.steadyDailyCap` (default 10,000). These numbers are deliberately below
 * Resend's own guide for a new domain (150 to 400 a day for days 1 to 3, 700 to 2,000 for days 4 to 7): a client's
 * list is small and an agency cannot afford a damaged domain. A domain that has not sent for 30 days starts again at
 * day 1 (its reputation has gone cold). A person can mark a domain as already established (no schedule) or give it a cap of their own;
 * an agent cannot.
 *
 * The cap counts every recipient handed to the provider that UTC day. It is ENFORCED for marketing mail: over the cap the
 * send is deferred and the plugin that asked retries it (its outbox retries for about three days). Transactional mail
 * (invoices, payslips, replies) is counted but never held back by the cap: it is low volume and the person is waiting for it.
 *
 * **Reputation.** Over the last 7 UTC days, of the recipients handed to the provider:
 * - the hard bounce rate (Permanent bounces) is a problem at 2% or more;
 * - the complaint rate is a problem at 0.1% or more.
 * A rate is judged only on a sample big enough to mean something: the bounce rate needs 100 recipients in the window and the
 * complaint rate 1,000 (on a new domain's first day, 50 recipients, ONE bounce is 2% and one complaint 2%, and holding a client's
 * marketing for a week over one address would punish the client for a typo). Under the sample, an absolute floor applies instead: three
 * hard bounces, or two complaints, are a problem on their own. Resend itself acts on its own limits (it asks for under 4% bounces and
 * under 0.08% complaints), so a domain close to ours is already close to its.
 * A reputation problem blocks MARKETING from that domain (never transactional mail) until the window clears, and is reported
 * as a health problem on the domain, which is also what Campaigns reads before it launches.
 */
import type { EspDayRow, EspDomainRow } from "./types.js";

export const WARMUP_SCHEDULE: ReadonlyArray<number> = [50, 100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000];
export const DEFAULT_STEADY_CAP = 10_000;
/** A domain idle this long starts its warm-up again. */
export const WARMUP_IDLE_RESET_DAYS = 30;

export const BOUNCE_RATE_LIMIT = 0.02;
export const COMPLAINT_RATE_LIMIT = 0.001;
export const REPUTATION_WINDOW_DAYS = 7;
/** Recipients in the window before the hard bounce rate is judged, and before the complaint rate is (it is a tenth as big, so it needs ten times the sample). */
export const REPUTATION_MIN_SENDS_BOUNCE = 100;
export const REPUTATION_MIN_SENDS_COMPLAINT = 1000;
/** Under those samples, this many events are a problem whatever the rate says. */
export const SMALL_SAMPLE_HARD_BOUNCES = 3;
export const SMALL_SAMPLE_COMPLAINTS = 2;

export const DAY_MS = 86_400_000;

/** `2026-10-03` for a moment, in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The 1-based warm-up day of a domain, or 1 for a domain that has not sent (or has gone cold). */
export function warmupDay(row: Pick<EspDomainRow, "first_sent_at" | "last_sent_at">, nowMs: number): number {
  const first = Date.parse(row.first_sent_at ?? "");
  if (!Number.isFinite(first)) return 1;
  const last = Date.parse(row.last_sent_at ?? "");
  if (Number.isFinite(last) && nowMs - last > WARMUP_IDLE_RESET_DAYS * DAY_MS) return 1;
  return Math.max(1, Math.floor((dayStart(utcDay(nowMs)) - dayStart(utcDay(first))) / DAY_MS) + 1);
}

export interface DailyCap {
  /** Recipients the domain may be handed to the provider today. */
  cap: number;
  /** The warm-up day (null: no schedule applies). */
  day: number | null;
  warming: boolean;
  /** Where the cap comes from, in words. */
  source: "warm-up" | "steady" | "override" | "established";
}

export function dailyCap(row: Pick<EspDomainRow, "first_sent_at" | "last_sent_at" | "warmup_exempt" | "daily_cap_override">, steady: number, nowMs: number): DailyCap {
  if (row.daily_cap_override != null && row.daily_cap_override > 0) return { cap: row.daily_cap_override, day: null, warming: false, source: "override" };
  if (row.warmup_exempt) return { cap: steady, day: null, warming: false, source: "established" };
  const day = warmupDay(row, nowMs);
  if (day > WARMUP_SCHEDULE.length) return { cap: steady, day, warming: false, source: "steady" };
  return { cap: Math.min(WARMUP_SCHEDULE[day - 1]!, steady), day, warming: true, source: "warm-up" };
}

/**
 * The most recipients the domain can ever be handed in one day: a person's own cap, else the steady cap (the top of the warm-up). A
 * single message with more recipients than this can never go out, however long it waits.
 */
export function highestDailyCap(row: Pick<EspDomainRow, "daily_cap_override">, steady: number): number {
  return row.daily_cap_override != null && row.daily_cap_override > 0 ? row.daily_cap_override : steady;
}

/** True when the day's cap is used up for this many more recipients. */
export function overCap(sentToday: number, adding: number, cap: number): boolean {
  return sentToday + adding > cap;
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export interface ReputationProblem {
  code: "esp_bounce_rate" | "esp_complaint_rate";
  severity: "bad";
  message: string;
  fix: string;
  /** Marketing is held back; transactional mail still goes. */
  blocks: "marketing";
}

export interface ReputationReport {
  windowDays: number;
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  complaints: number;
  /** null while there is nothing sent in the window. */
  bounceRate: number | null;
  complaintRate: number | null;
  /** Enough recipients to judge the hard bounce rate (otherwise only its absolute floor applies). */
  judged: boolean;
  /** Enough recipients to judge the complaint rate (otherwise only its absolute floor applies). */
  complaintsJudged: boolean;
  problems: ReputationProblem[];
  computedAt: string;
}

const pct = (rate: number) => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

/** The last `REPUTATION_WINDOW_DAYS` UTC days up to and including `nowMs`, from a domain's day rows. */
export function reputationOf(rows: Array<Pick<EspDayRow, "day" | "sent" | "delivered" | "hard_bounces" | "soft_bounces" | "complaints">>, domain: string, nowMs: number): ReputationReport {
  const since = dayStart(utcDay(nowMs - (REPUTATION_WINDOW_DAYS - 1) * DAY_MS));
  const until = dayStart(utcDay(nowMs));
  const sum = { sent: 0, delivered: 0, hardBounces: 0, softBounces: 0, complaints: 0 };
  for (const row of rows) {
    if (dayStart(row.day) < since || dayStart(row.day) > until) continue;
    sum.sent += Number(row.sent);
    sum.delivered += Number(row.delivered);
    sum.hardBounces += Number(row.hard_bounces);
    sum.softBounces += Number(row.soft_bounces);
    sum.complaints += Number(row.complaints);
  }
  const judged = sum.sent >= REPUTATION_MIN_SENDS_BOUNCE;
  const complaintsJudged = sum.sent >= REPUTATION_MIN_SENDS_COMPLAINT;
  const bounceRate = sum.sent > 0 ? sum.hardBounces / sum.sent : null;
  const complaintRate = sum.sent > 0 ? sum.complaints / sum.sent : null;
  const problems: ReputationProblem[] = [];
  const bounceBad = judged ? (bounceRate ?? 0) >= BOUNCE_RATE_LIMIT : sum.hardBounces >= SMALL_SAMPLE_HARD_BOUNCES;
  const complaintBad = complaintsJudged ? (complaintRate ?? 0) >= COMPLAINT_RATE_LIMIT : sum.complaints >= SMALL_SAMPLE_COMPLAINTS;
  if (bounceBad) {
    problems.push({
      code: "esp_bounce_rate",
      severity: "bad",
      message: `${domain}: ${sum.hardBounces} of ${sum.sent} recipients hard bounced in the last ${REPUTATION_WINDOW_DAYS} days${bounceRate != null ? ` (${pct(bounceRate)}; the limit is ${pct(BOUNCE_RATE_LIMIT)})` : ""}, so marketing mail from it is held back.`,
      fix: "Stop adding addresses that were never verified: check where the list came from, remove the dead addresses, and let the 7-day window clear. Transactional mail still goes.",
      blocks: "marketing",
    });
  }
  if (complaintBad) {
    problems.push({
      code: "esp_complaint_rate",
      severity: "bad",
      message: `${domain}: ${sum.complaints} of ${sum.sent} recipients marked the mail as spam in the last ${REPUTATION_WINDOW_DAYS} days${complaintRate != null ? ` (${pct(complaintRate)}; the limit is ${pct(COMPLAINT_RATE_LIMIT)})` : ""}, so marketing mail from it is held back.`,
      fix: "Look at who the campaign went to and why they did not expect it: tighten the audience, make the unsubscribe link easy to see, and let the 7-day window clear. Transactional mail still goes.",
      blocks: "marketing",
    });
  }
  return { windowDays: REPUTATION_WINDOW_DAYS, ...sum, bounceRate, complaintRate, judged, complaintsJudged, problems, computedAt: new Date(nowMs).toISOString() };
}

// ---------------------------------------------------------------------------
// Soft bounces
// ---------------------------------------------------------------------------

/** Hours mail to an address waits after its 1st, 2nd and 3rd soft bounce. */
export const SOFT_BOUNCE_BACKOFF_HOURS: ReadonlyArray<number> = [6, 24, 72];
/** The third soft bounce within the window puts the address on the marketing do-not-email list: it is not delivering. */
export const SOFT_BOUNCE_LIMIT = 3;
/** Soft bounces older than this are forgotten. */
export const SOFT_BOUNCE_WINDOW_DAYS = 14;

/** When mail to an address may resume after its `count`-th soft bounce. */
export function softBounceBackoffUntil(count: number, nowMs: number): string {
  const hours = SOFT_BOUNCE_BACKOFF_HOURS[Math.min(Math.max(count, 1), SOFT_BOUNCE_BACKOFF_HOURS.length) - 1]!;
  return new Date(nowMs + hours * 3_600_000).toISOString();
}
