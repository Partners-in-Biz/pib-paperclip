/**
 * The sales desk (CRM 0.37.0): the one list a person works through, and the
 * numbers behind it. Pure functions, no Node imports, so the UI bundle and the
 * worker share one set of rules and the tests run them without a database.
 *
 * What it answers:
 * - the queue: every contact and deal with a next action, in buckets
 *   (overdue, today, soon, later, undated), with the phone, email, company,
 *   lead band, the agent's latest brief and the last touch;
 * - what an outcome means: "no answer" suggests a call tomorrow, "spoke to
 *   them" an email in two days, and so on;
 * - the activity series (calls, emails, meetings, notes per day) and the
 *   lead funnel and lead-batch table for the overview.
 *
 * Phone and email helpers live here too: `telHref` for click-to-call and
 * `composeHref` for "Email" (the Mailbox opens a new draft to that address).
 */
import { leadBand, type LeadScore } from "./lead-levels.js";

export type DeskRecordType = "contact" | "deal";
export type DeskBucket = "overdue" | "today" | "soon" | "later" | "undated";
export const DESK_BUCKETS: DeskBucket[] = ["overdue", "today", "soon", "later", "undated"];
export const BUCKET_LABEL: Record<DeskBucket, string> = { overdue: "Overdue", today: "Today", soon: "Next 7 days", later: "Later", undated: "No date" };

/** Channels a person logs an outcome on. The activity kind is the channel. */
export const OUTCOME_CHANNELS = ["call", "email", "meeting", "message"] as const;
export type OutcomeChannel = (typeof OUTCOME_CHANNELS)[number];

/** What happened. Each one suggests the next step; the person can change it before saving. */
export const OUTCOMES = ["reached", "no_answer", "voicemail", "busy", "wrong_number", "meeting_booked", "sent", "replied", "not_interested"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  reached: "Spoke to them",
  no_answer: "No answer",
  voicemail: "Left a voicemail",
  busy: "Busy, call back",
  wrong_number: "Wrong number",
  meeting_booked: "Meeting booked",
  sent: "Sent",
  replied: "They replied",
  not_interested: "Not interested",
};

/** Which outcomes make sense on which channel (the modal shows only these). */
export const OUTCOMES_BY_CHANNEL: Record<OutcomeChannel, Outcome[]> = {
  call: ["reached", "no_answer", "voicemail", "busy", "wrong_number", "meeting_booked", "not_interested"],
  email: ["sent", "replied", "meeting_booked", "not_interested"],
  meeting: ["reached", "meeting_booked", "not_interested"],
  message: ["sent", "replied", "meeting_booked", "not_interested"],
};

export type NextKind = "call" | "email" | "meet";

export interface NextSuggestion {
  kind: NextKind | null;
  /** Days from now; null means no date (the person picks one, e.g. the meeting's). */
  inDays: number | null;
  /** Lifecycle to suggest with it (not applied unless the person ticks it). */
  lifecycle?: "prospect" | "churned";
}

/** The next step an outcome usually calls for. */
export function outcomeSuggestion(outcome: Outcome): NextSuggestion {
  switch (outcome) {
    case "reached": return { kind: "email", inDays: 2, lifecycle: "prospect" };
    case "no_answer": return { kind: "call", inDays: 1 };
    case "voicemail": return { kind: "call", inDays: 2 };
    case "busy": return { kind: "call", inDays: 1 };
    case "wrong_number": return { kind: null, inDays: null };
    case "meeting_booked": return { kind: "meet", inDays: null, lifecycle: "prospect" };
    case "sent": return { kind: "call", inDays: 3 };
    case "replied": return { kind: "email", inDays: 1 };
    case "not_interested": return { kind: null, inDays: null, lifecycle: "churned" };
  }
}

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

export function isOutcomeChannel(value: unknown): value is OutcomeChannel {
  return typeof value === "string" && (OUTCOME_CHANNELS as readonly string[]).includes(value);
}

/** "No answer · tried at 14:05, call back tomorrow" is the body the timeline shows. */
export function outcomeBody(channel: OutcomeChannel, outcome: Outcome, note: string | null | undefined): string {
  const label = OUTCOME_LABEL[outcome];
  const text = (note ?? "").trim();
  const head = channel === "call" ? label : `${channel === "meeting" ? "Meeting" : channel === "email" ? "Email" : "Message"}: ${label.toLowerCase()}`;
  return text ? `${head} · ${text}` : head;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

/** Midnight at the start of `now`'s day in `timezone` (UTC when unknown), as a timestamp. */
export function startOfDay(now: number, timezone: string | null | undefined): number {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const sinceMidnight = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
    return now - sinceMidnight - (now % 1000);
  } catch {
    return now - (now % DAY);
  }
}

/** A due date `inDays` from now as an ISO date (YYYY-MM-DD), in the company's timezone. */
export function dueDateInDays(now: number, inDays: number, timezone: string | null | undefined): string {
  const at = new Date(startOfDay(now, timezone) + inDays * DAY + 12 * 3_600_000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function bucketOf(dueAt: string | null | undefined, now: number, timezone: string | null | undefined): DeskBucket {
  if (!dueAt) return "undated";
  const t = Date.parse(dueAt);
  if (Number.isNaN(t)) return "undated";
  const start = startOfDay(now, timezone);
  if (t < start) return "overdue";
  if (t < start + DAY) return "today";
  if (t < start + 7 * DAY) return "soon";
  return "later";
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface DeskContact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  lifecycle: string;
  tags?: string[];
  nextActionKind?: string | null;
  nextActionDueAt?: string | null;
  leadScore?: LeadScore | null;
  emailStatus?: string | null;
}
export interface DeskDeal {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  stageId: string;
  contactId: string | null;
  accountId: string | null;
  nextActionKind?: string | null;
  nextActionDueAt?: string | null;
}
export interface DeskAccount { id: string; name: string; phone?: string | null; billingEmail?: string | null }
export interface DeskLink { contactId: string; accountId: string; roleLabel?: string }
export interface DeskActivity { id: string; recordType: string; recordId: string; kind: string; body: string; createdAt: string; issueId?: string | null }

export interface QueueItem {
  key: string;
  recordType: DeskRecordType;
  recordId: string;
  /** The contact behind a deal row, when there is one (its phone and email are used). */
  contactId: string | null;
  name: string;
  company: string | null;
  companyId: string | null;
  phone: string | null;
  email: string | null;
  emailOk: boolean;
  kind: string;
  dueAt: string | null;
  bucket: DeskBucket;
  lifecycle: string | null;
  band: "hot" | "warm" | "cold" | null;
  deal: { id: string; title: string; amountMinor: number; currency: string } | null;
  /** The agent's latest brief on the record (full text), if any. */
  brief: { body: string; at: string } | null;
  /** The newest activity that is not a brief. */
  lastTouch: { kind: string; body: string; at: string } | null;
}

export interface QueueInput {
  contacts: DeskContact[];
  deals: DeskDeal[];
  accounts: DeskAccount[];
  links: DeskLink[];
  /** Open stage ids: a won or lost deal leaves the queue even with a next action set. */
  openStageIds: Set<string>;
  /** Recent activities (any record), newest first. Briefs and last touches come from here. */
  activities: DeskActivity[];
  now: number;
  timezone: string | null | undefined;
}

const BUCKET_ORDER: Record<DeskBucket, number> = { overdue: 0, today: 1, soon: 2, later: 3, undated: 4 };

function firstCompany(contactId: string, links: DeskLink[], accounts: Map<string, DeskAccount>): DeskAccount | null {
  const link = links.find((row) => row.contactId === contactId);
  return link ? accounts.get(link.accountId) ?? null : null;
}

export function buildQueue(input: QueueInput): QueueItem[] {
  const accounts = new Map(input.accounts.map((row) => [row.id, row]));
  const contacts = new Map(input.contacts.map((row) => [row.id, row]));
  const briefs = new Map<string, { body: string; at: string }>();
  const touches = new Map<string, { kind: string; body: string; at: string }>();
  // Newest first: the first one seen per record wins.
  for (const row of input.activities) {
    const key = `${row.recordType}:${row.recordId}`;
    if (row.kind === "brief") {
      if (!briefs.has(key)) briefs.set(key, { body: row.body, at: row.createdAt });
    } else if (row.kind !== "given" && !touches.has(key)) {
      touches.set(key, { kind: row.kind, body: row.body, at: row.createdAt });
    }
  }
  const items: QueueItem[] = [];
  for (const contact of input.contacts) {
    if (!contact.nextActionKind) continue;
    const company = firstCompany(contact.id, input.links, accounts);
    items.push({
      key: `contact:${contact.id}`,
      recordType: "contact",
      recordId: contact.id,
      contactId: contact.id,
      name: contact.name,
      company: company?.name ?? null,
      companyId: company?.id ?? null,
      phone: contact.phones[0] ?? company?.phone ?? null,
      email: contact.emails[0] ?? null,
      emailOk: (contact.emailStatus ?? "ok") === "ok",
      kind: contact.nextActionKind,
      dueAt: contact.nextActionDueAt ?? null,
      bucket: bucketOf(contact.nextActionDueAt, input.now, input.timezone),
      lifecycle: contact.lifecycle,
      band: contact.leadScore ? leadBand(contact.leadScore) : null,
      deal: null,
      brief: briefs.get(`contact:${contact.id}`) ?? null,
      lastTouch: touches.get(`contact:${contact.id}`) ?? null,
    });
  }
  for (const deal of input.deals) {
    if (!deal.nextActionKind || !input.openStageIds.has(deal.stageId)) continue;
    const contact = deal.contactId ? contacts.get(deal.contactId) ?? null : null;
    const company = (deal.accountId ? accounts.get(deal.accountId) : null) ?? (contact ? firstCompany(contact.id, input.links, accounts) : null);
    items.push({
      key: `deal:${deal.id}`,
      recordType: "deal",
      recordId: deal.id,
      contactId: contact?.id ?? null,
      name: contact?.name ?? company?.name ?? deal.title,
      company: company?.name ?? null,
      companyId: company?.id ?? null,
      phone: contact?.phones[0] ?? company?.phone ?? null,
      email: contact?.emails[0] ?? company?.billingEmail ?? null,
      emailOk: (contact?.emailStatus ?? "ok") === "ok",
      kind: deal.nextActionKind,
      dueAt: deal.nextActionDueAt ?? null,
      bucket: bucketOf(deal.nextActionDueAt, input.now, input.timezone),
      lifecycle: contact?.lifecycle ?? null,
      band: contact?.leadScore ? leadBand(contact.leadScore) : null,
      deal: { id: deal.id, title: deal.title, amountMinor: deal.amountMinor, currency: deal.currency },
      brief: briefs.get(`deal:${deal.id}`) ?? (contact ? briefs.get(`contact:${contact.id}`) ?? null : null),
      lastTouch: touches.get(`deal:${deal.id}`) ?? (contact ? touches.get(`contact:${contact.id}`) ?? null : null),
    });
  }
  return items.sort((a, b) => {
    const order = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (order !== 0) return order;
    const at = (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
    if (at !== 0 && Number.isFinite(at)) return at;
    return a.name.localeCompare(b.name);
  });
}

export interface QueueCounts { overdue: number; today: number; soon: number; later: number; undated: number; now: number }

export function queueCounts(items: QueueItem[]): QueueCounts {
  const out: QueueCounts = { overdue: 0, today: 0, soon: 0, later: 0, undated: 0, now: 0 };
  for (const item of items) out[item.bucket] += 1;
  out.now = out.overdue + out.today;
  return out;
}

// ---------------------------------------------------------------------------
// Activity series, funnel, batches
// ---------------------------------------------------------------------------

export const TOUCH_KINDS = ["call", "email", "meeting", "message", "note"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];
/** Outbound emails logged by the CRM itself count as emails too. */
const EMAIL_LIKE = new Set(["email", "email_sent", "speed_to_lead_sent"]);

export interface ActivityDay { date: string; call: number; email: number; meeting: number; message: number; note: number }
export interface ActivitySeries {
  /** One entry per day, oldest first, `days` long, ending today. */
  days: ActivityDay[];
  thisWeek: Record<TouchKind, number>;
  lastWeek: Record<TouchKind, number>;
}

function dayKey(t: number, timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

function touchKind(kind: string): TouchKind | null {
  if (EMAIL_LIKE.has(kind)) return "email";
  return (TOUCH_KINDS as readonly string[]).includes(kind) ? (kind as TouchKind) : null;
}

const zero = (): Record<TouchKind, number> => ({ call: 0, email: 0, meeting: 0, message: 0, note: 0 });

export function activitySeries(activities: Array<{ kind: string; createdAt: string }>, now: number, timezone: string | null | undefined, days = 28): ActivitySeries {
  const start = startOfDay(now, timezone);
  const byDay = new Map<string, ActivityDay>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = dayKey(start - i * DAY + 12 * 3_600_000, timezone);
    byDay.set(date, { date, call: 0, email: 0, meeting: 0, message: 0, note: 0 });
  }
  const thisWeek = zero();
  const lastWeek = zero();
  for (const row of activities) {
    const kind = touchKind(row.kind);
    if (!kind) continue;
    const t = Date.parse(row.createdAt);
    if (Number.isNaN(t) || t > now) continue;
    const day = byDay.get(dayKey(t, timezone));
    if (day) day[kind] += 1;
    if (t >= now - 7 * DAY) thisWeek[kind] += 1;
    else if (t >= now - 14 * DAY) lastWeek[kind] += 1;
  }
  return { days: [...byDay.values()], thisWeek, lastWeek };
}

export interface Funnel { leads: number; contacted: number; prospects: number; withDeal: number; won: number }

/** Leads → contacted (any call, email, meeting or message on the record) → prospects → with an open or won deal → customers. */
export function funnel(input: { contacts: DeskContact[]; deals: DeskDeal[]; touchedContactIds: Set<string>; wonStageIds: Set<string>; lostStageIds: Set<string> }): Funnel {
  const withDeal = new Set<string>();
  const won = new Set<string>();
  for (const deal of input.deals) {
    if (!deal.contactId || input.lostStageIds.has(deal.stageId)) continue;
    withDeal.add(deal.contactId);
    if (input.wonStageIds.has(deal.stageId)) won.add(deal.contactId);
  }
  let leads = 0;
  let contacted = 0;
  let prospects = 0;
  let wonCount = 0;
  let dealCount = 0;
  for (const contact of input.contacts) {
    if (contact.lifecycle === "churned") continue;
    leads += 1;
    if (input.touchedContactIds.has(contact.id)) contacted += 1;
    if (contact.lifecycle === "prospect" || contact.lifecycle === "customer") prospects += 1;
    if (withDeal.has(contact.id)) dealCount += 1;
    if (won.has(contact.id) || contact.lifecycle === "customer") wonCount += 1;
  }
  return { leads, contacted, prospects, withDeal: dealCount, won: wonCount };
}

export interface BatchRow { tag: string; contacts: number; called: number; replied: number; deals: number; overdue: number }

/** One row per `lead-batch-*` tag: how far the agents' lead batches got. Newest batch first. */
export function batchRows(input: { contacts: DeskContact[]; deals: DeskDeal[]; activities: DeskActivity[]; now: number; timezone: string | null | undefined }): BatchRow[] {
  const called = new Set<string>();
  const replied = new Set<string>();
  for (const row of input.activities) {
    if (row.recordType !== "contact") continue;
    if (row.kind === "call" || row.kind === "meeting") called.add(row.recordId);
    if (row.kind === "email_received" || row.kind === "replied") replied.add(row.recordId);
  }
  const dealContacts = new Set(input.deals.map((deal) => deal.contactId).filter((id): id is string => Boolean(id)));
  const rows = new Map<string, BatchRow>();
  for (const contact of input.contacts) {
    for (const tag of contact.tags ?? []) {
      if (!tag.startsWith("lead-batch-")) continue;
      const row = rows.get(tag) ?? { tag, contacts: 0, called: 0, replied: 0, deals: 0, overdue: 0 };
      row.contacts += 1;
      if (called.has(contact.id)) row.called += 1;
      if (replied.has(contact.id)) row.replied += 1;
      if (dealContacts.has(contact.id)) row.deals += 1;
      if (bucketOf(contact.nextActionDueAt, input.now, input.timezone) === "overdue") row.overdue += 1;
      rows.set(tag, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.tag.localeCompare(a.tag));
}

// ---------------------------------------------------------------------------
// Calling and emailing from a record
// ---------------------------------------------------------------------------

/** `tel:` link for a phone number: South African 0xx numbers become +27, other numbers keep their digits. Null when it is not a number. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.trim().replace(/[\s\-().]/g, "");
  if (/^0\d{9}$/.test(digits)) digits = `+27${digits.slice(1)}`;
  if (/^00\d{8,}$/.test(digits)) digits = `+${digits.slice(2)}`;
  if (!/^\+?\d{7,15}$/.test(digits)) return null;
  return `tel:${digits}`;
}

/** The Mailbox page with a new draft to `email` open (`?compose=1&to=`), plus a subject when given. */
export function composeHref(email: string | null | undefined, subject?: string | null): string | null {
  const to = (email ?? "").trim();
  if (!to || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) return null;
  const params = new URLSearchParams({ compose: "1", to });
  if (subject?.trim()) params.set("subject", subject.trim());
  return `/mailbox?${params.toString()}`;
}

/** The record's CRM page (a deal opens its contact or company). */
export function recordPath(item: Pick<QueueItem, "recordType" | "recordId" | "contactId" | "companyId">): string | null {
  if (item.recordType === "contact") return `/crm?client=contact%3A${encodeURIComponent(item.recordId)}`;
  if (item.contactId) return `/crm?client=contact%3A${encodeURIComponent(item.contactId)}`;
  if (item.companyId) return `/crm?client=company%3A${encodeURIComponent(item.companyId)}`;
  return null;
}
