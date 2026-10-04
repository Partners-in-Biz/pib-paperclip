/**
 * Source-to-revenue attribution (audit Q10-8, Q1a-14, Q10-3): which channel brought the leads, the customers and the money.
 *
 * Two views, one model.
 * - OURS (no client): our own website forms. `lead_captures` (campaign tags, referrer, landing page) -> the contact -> the
 *   deals -> the invoices Billing told us are paid (`revenue_events`, written when `invoice.paid` arrives). This is where the
 *   whole chain is on record.
 * - A CLIENT's: the enquiries on that client's own forms (`client_leads`) and what the client told us became of each
 *   (`record-lead-outcome`: qualified, won with a value, lost). We never see a client's sales, so its revenue is only what it reports.
 *
 * The model, and its limits (the report repeats them):
 * - A lead's channel comes from the campaign tags and the referring site of the visit the form was on (`channels.ts`). First and
 *   last touch are the same visit unless the visitor's site banner allowed the site script to remember earlier visits.
 * - A customer's first touch is its earliest lead capture; its last touch is its latest capture before the sale (the win, or the payment). A
 *   sale with no capture behind it (a client who came by referral and was added by hand) is `unattributed`: it is never guessed.
 * - One sale is credited once under each model, never split. Costs are only the ones recorded with `record-channel-cost`.
 * - Money is kept per currency and never converted.
 *
 * `buildOwnAttribution` and `buildClientAttribution` are pure (no database), so the model is tested on its own; the loaders below read
 * the rows and call them.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor, readConfig } from "@partnersinbiz/pib-plugin-kit";
import { CHANNEL_LABELS, channelOfSource, CHANNELS, leadTouches, UNATTRIBUTED, type Channel, type ChannelOrUnattributed } from "./channels.js";
import { isCanaryId } from "./canary-flag.js";
import { clientInfo } from "./care-clients.js";
import { asRecord, listLinks, table } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import {
  clientLeadByKey,
  clientLeadsBetween,
  costsOf,
  LEAD_OUTCOMES,
  ownCaptures,
  putCost,
  revenueBetween,
  setLeadOutcome,
  type CaptureRow,
  type ClientLeadAttribution,
  type CostRow,
  type LeadOutcome,
  type RevenueRow,
} from "./attribution-store.js";
import { parseClientRef, requireClient } from "./lookup.js";
import { periodBounds, type ReportSection } from "./report-render.js";
import { refOf, type ClientKind } from "./refs.js";
import { eventsSummaryFor, rangeOf, type EventsSummary } from "./site-events.js";
import { periodDays } from "./site-events-form.js";
import { getClientProfile } from "./store.js";
import { hostOf } from "./channels.js";

export type Money = Record<string, number>;

const add = (money: Money, currency: string, minor: number): void => {
  if (!Number.isFinite(minor) || minor === 0) return;
  money[currency] = (money[currency] ?? 0) + minor;
};

export interface Cell {
  /** Leads (form enquiries) in the period. */
  leads: number;
  /** Of those, the ones that went on: a contact who became a prospect or customer or has a deal (ours), or a lead the client called qualified or won (theirs). */
  qualified: number;
  /** Deals won in the period (ours) or leads the client says it won (theirs). */
  won: number;
  wonValue: Money;
  /** Money paid in the period: invoices Billing says are paid (ours) or what the client reported on won leads (theirs). */
  revenue: Money;
}

const emptyCell = (): Cell => ({ leads: 0, qualified: 0, won: 0, wonValue: {}, revenue: {} });

export interface ChannelRow {
  channel: ChannelOrUnattributed;
  label: string;
  first: Cell;
  last: Cell;
  /** Recorded cost of the channel in the period. */
  cost: Money;
  /** Cost per first-touch lead, when the cost is in one currency and there are leads. */
  costPerLead: Money | null;
}

export interface AttributionReport {
  scope: "own" | "client";
  client: string | null;
  clientName: string | null;
  period: string;
  range: { from: string; to: string };
  rows: ChannelRow[];
  totals: { first: Cell; last: Cell; cost: Money };
  /** Share of the period's leads whose first and last touch came from remembered visits, not just the one the form was on (0 to 1). */
  persistedShare: number | null;
  campaigns: Array<{ campaign: string; leads: number }>;
  notes: string[];
}

function newRows(): Map<ChannelOrUnattributed, ChannelRow> {
  const rows = new Map<ChannelOrUnattributed, ChannelRow>();
  for (const channel of [...CHANNELS, UNATTRIBUTED] as ChannelOrUnattributed[]) rows.set(channel, { channel, label: CHANNEL_LABELS[channel], first: emptyCell(), last: emptyCell(), cost: {}, costPerLead: null });
  return rows;
}

const inRange = (at: string | null | undefined, from: string, to: string): boolean => {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(time) && time >= Date.parse(from) && time < Date.parse(to);
};

/** The `YYYY-MM` months a range touches, in South African time. */
export function periodsIn(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to) - 1;
  for (let t = Date.parse(from) + 2 * 3_600_000; t <= end + 2 * 3_600_000; ) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return [...new Set(out)];
}

function finish(rows: Map<ChannelOrUnattributed, ChannelRow>, costs: readonly CostRow[], periods: readonly string[]): { rows: ChannelRow[]; totals: AttributionReport["totals"] } {
  for (const cost of costs) {
    if (!periods.includes(cost.period)) continue;
    const channel = (CHANNELS as readonly string[]).includes(cost.channel) ? (cost.channel as Channel) : UNATTRIBUTED;
    add(rows.get(channel)!.cost, cost.currency, cost.amountMinor);
  }
  const totals: AttributionReport["totals"] = { first: emptyCell(), last: emptyCell(), cost: {} };
  const out: ChannelRow[] = [];
  for (const row of rows.values()) {
    const currencies = Object.keys(row.cost);
    row.costPerLead = currencies.length === 1 && row.first.leads > 0 ? { [currencies[0]!]: Math.round(row.cost[currencies[0]!]! / row.first.leads) } : null;
    for (const [target, source] of [[totals.first, row.first], [totals.last, row.last]] as const) {
      target.leads += source.leads;
      target.qualified += source.qualified;
      target.won += source.won;
      for (const [currency, minor] of Object.entries(source.wonValue)) add(target.wonValue, currency, minor);
      for (const [currency, minor] of Object.entries(source.revenue)) add(target.revenue, currency, minor);
    }
    for (const [currency, minor] of Object.entries(row.cost)) add(totals.cost, currency, minor);
    const empty = row.first.leads + row.last.leads + row.first.won + row.last.won + currencies.length + Object.keys(row.first.revenue).length + Object.keys(row.last.revenue).length;
    // A channel with nothing in it is left out, except the ones that always show (unattributed only when it has something).
    if (empty > 0) out.push(row);
  }
  out.sort((a, b) => b.first.leads + b.last.leads - (a.first.leads + a.last.leads));
  return { rows: out, totals };
}

// ---------------------------------------------------------------------------
// Ours
// ---------------------------------------------------------------------------

export interface OwnInput {
  from: string;
  to: string;
  captures: CaptureRow[];
  contacts: Array<{ id: string; lifecycle: string; accountIds: string[] }>;
  deals: Array<{ id: string; contactId: string | null; accountId: string | null; amountMinor: number; currency: string; won: boolean; wonAt: string | null }>;
  revenue: RevenueRow[];
  costs: CostRow[];
  ownHosts?: readonly string[];
}

/** Builds our own attribution report from the rows (pure). */
export function buildOwnAttribution(input: OwnInput): Omit<AttributionReport, "scope" | "client" | "clientName" | "period" | "range"> {
  const hosts = input.ownHosts ?? [];
  const contacts = new Map(input.contacts.map((contact) => [contact.id, contact]));
  const customerOfContact = (id: string): string => {
    const contact = contacts.get(id);
    return contact && contact.accountIds.length > 0 ? `account:${contact.accountIds[0]}` : `contact:${id}`;
  };
  const dealById = new Map(input.deals.map((deal) => [deal.id, deal]));
  const customerOfDeal = (deal: OwnInput["deals"][number]): string | null => (deal.accountId ? `account:${deal.accountId}` : deal.contactId ? customerOfContact(deal.contactId) : null);

  // Captures grouped by customer, oldest first (the loader orders them).
  const byCustomer = new Map<string, CaptureRow[]>();
  for (const capture of input.captures) {
    if (!capture.contactId) continue;
    const key = customerOfContact(capture.contactId);
    (byCustomer.get(key) ?? byCustomer.set(key, []).get(key)!).push(capture);
  }
  const customersWithDeals = new Set(input.deals.map(customerOfDeal).filter((key): key is string => Boolean(key)));

  const rows = newRows();
  const firstOf = (key: string | null): ChannelOrUnattributed => {
    const first = key ? byCustomer.get(key)?.[0] : undefined;
    return (first ? leadTouches(first.attribution, hosts).first : null) ?? UNATTRIBUTED;
  };
  const lastOf = (key: string | null, at: string): ChannelOrUnattributed => {
    const list = key ? byCustomer.get(key) : undefined;
    if (!list || list.length === 0) return UNATTRIBUTED;
    const before = [...list].reverse().find((capture) => Date.parse(capture.createdAt) <= Date.parse(at)) ?? list[0]!;
    return leadTouches(before.attribution, hosts).last ?? UNATTRIBUTED;
  };

  // Leads in the period, by the touches on each capture.
  let persisted = 0;
  let counted = 0;
  const campaigns = new Map<string, number>();
  for (const capture of input.captures) {
    if (!inRange(capture.createdAt, input.from, input.to)) continue;
    const touches = leadTouches(capture.attribution, hosts);
    const first = touches.first ?? UNATTRIBUTED;
    const last = touches.last ?? UNATTRIBUTED;
    rows.get(first)!.first.leads += 1;
    rows.get(last)!.last.leads += 1;
    counted += 1;
    if (touches.basis === "persisted") persisted += 1;
    if (touches.campaign) campaigns.set(touches.campaign, (campaigns.get(touches.campaign) ?? 0) + 1);
    const contact = capture.contactId ? contacts.get(capture.contactId) : undefined;
    const customer = capture.contactId ? customerOfContact(capture.contactId) : null;
    const qualified = (contact && (contact.lifecycle === "prospect" || contact.lifecycle === "customer")) || (customer != null && customersWithDeals.has(customer));
    if (qualified) {
      rows.get(first)!.first.qualified += 1;
      rows.get(last)!.last.qualified += 1;
    }
  }

  // Deals won in the period: credited to the customer's first touch, and to its last touch before the win.
  for (const deal of input.deals) {
    if (!deal.won || !inRange(deal.wonAt, input.from, input.to)) continue;
    const key = customerOfDeal(deal);
    const first = rows.get(firstOf(key))!.first;
    const last = rows.get(lastOf(key, deal.wonAt!))!.last;
    for (const cell of [first, last]) {
      cell.won += 1;
      add(cell.wonValue, deal.currency, deal.amountMinor);
    }
  }

  // Money paid in the period: credited the same way, by the customer behind the invoice.
  for (const payment of input.revenue) {
    if (!inRange(payment.paidAt, input.from, input.to)) continue;
    const deal = payment.dealId ? dealById.get(payment.dealId) : undefined;
    const key = deal ? customerOfDeal(deal) : payment.clientKind === "company" && payment.clientRef ? `account:${payment.clientRef}` : payment.clientKind === "contact" && payment.clientRef ? customerOfContact(payment.clientRef) : null;
    add(rows.get(firstOf(key))!.first.revenue, payment.currency, payment.totalMinor);
    add(rows.get(lastOf(key, payment.paidAt))!.last.revenue, payment.currency, payment.totalMinor);
  }

  const { rows: out, totals } = finish(rows, input.costs, periodsIn(input.from, input.to));
  return {
    rows: out,
    totals,
    persistedShare: counted > 0 ? Math.round((persisted / counted) * 100) / 100 : null,
    campaigns: [...campaigns.entries()].map(([campaign, leads]) => ({ campaign, leads })).sort((a, b) => b.leads - a.leads).slice(0, 5),
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// A client's
// ---------------------------------------------------------------------------

export interface ClientInput {
  leads: ClientLeadAttribution[];
  costs: CostRow[];
  from: string;
  to: string;
  ownHosts?: readonly string[];
}

/** Builds a client's attribution report from its leads and what it reported about them (pure). */
export function buildClientAttribution(input: ClientInput): Omit<AttributionReport, "scope" | "client" | "clientName" | "period" | "range"> {
  const hosts = input.ownHosts ?? [];
  const rows = newRows();
  let persisted = 0;
  let formLeads = 0;
  const campaigns = new Map<string, number>();
  for (const lead of input.leads) {
    if (!inRange(lead.capturedAt, input.from, input.to)) continue;
    let first: ChannelOrUnattributed;
    let last: ChannelOrUnattributed;
    if (lead.source === "form") {
      const touches = leadTouches(lead.attribution, hosts);
      first = touches.first ?? UNATTRIBUTED;
      last = touches.last ?? UNATTRIBUTED;
      formLeads += 1;
      if (touches.basis === "persisted") persisted += 1;
      if (touches.campaign) campaigns.set(touches.campaign, (campaigns.get(touches.campaign) ?? 0) + 1);
    } else {
      first = last = channelOfSource(lead.source) ?? UNATTRIBUTED;
    }
    const qualified = lead.outcome === "qualified" || lead.outcome === "won";
    const won = lead.outcome === "won";
    for (const cell of [rows.get(first)!.first, rows.get(last)!.last]) {
      cell.leads += 1;
      if (qualified) cell.qualified += 1;
      if (won) {
        cell.won += 1;
        if (lead.valueMinor != null && lead.currency) {
          add(cell.wonValue, lead.currency, lead.valueMinor);
          add(cell.revenue, lead.currency, lead.valueMinor);
        }
      }
    }
  }
  const { rows: out, totals } = finish(rows, input.costs, periodsIn(input.from, input.to));
  return {
    rows: out,
    totals,
    persistedShare: formLeads > 0 ? Math.round((persisted / formLeads) * 100) / 100 : null,
    campaigns: [...campaigns.entries()].map(([campaign, leads]) => ({ campaign, leads })).sort((a, b) => b.leads - a.leads).slice(0, 5),
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface DealDbRow {
  id: string;
  contact_id: string | null;
  account_id: string | null;
  amount_minor: unknown;
  currency: string;
  stage_id: string;
  won_at: unknown;
  custom: unknown;
}

/** The canary client's test records (its company, contact, deal or payment) are never counted: they are a rehearsal, not sales. */
function isCanaryDeal(deal: DealDbRow): boolean {
  return isCanaryId(deal.account_id) || isCanaryId(deal.contact_id) || asRecord(deal.custom).canary === true;
}

/** The most rows the own report reads of each kind (the store caps them). Reaching a cap is said in the report's notes. */
const OWN_READ_LIMITS = { captures: 20_000, deals: 5_000, contacts: 20_000 } as const;

async function loadOwnInput(ctx: PluginContext, companyId: string, range: { from: string; to: string }): Promise<{ input: OwnInput; limitNotes: string[] }> {
  const [captures, links, deals, stages, revenue, costs, contacts] = await Promise.all([
    ownCaptures(ctx, companyId, range.to),
    listLinks(ctx, companyId),
    ctx.db.query<DealDbRow>(`SELECT id, contact_id, account_id, amount_minor, currency, stage_id, won_at, custom FROM ${table(ctx, "deals")} WHERE company_id = $1 LIMIT 5000`, [companyId]),
    ctx.db.query<{ id: string; kind: string }>(`SELECT id, kind FROM ${table(ctx, "pipeline_stages")} WHERE company_id = $1 LIMIT 200`, [companyId]),
    revenueBetween(ctx, companyId, range.from, range.to),
    costsOf(ctx, companyId, "own"),
    ctx.db.query<{ id: string; lifecycle: string }>(`SELECT id, lifecycle FROM ${table(ctx, "contacts")} WHERE company_id = $1 LIMIT 20000`, [companyId]),
  ]);
  const accountsOf = new Map<string, string[]>();
  for (const link of links) (accountsOf.get(link.contactId) ?? accountsOf.set(link.contactId, []).get(link.contactId)!).push(link.accountId);
  const kinds = new Map(stages.map((stage) => [stage.id, stage.kind]));
  const realDeals = deals.filter((deal) => !isCanaryDeal(deal));
  const canaryDeals = new Set(deals.filter(isCanaryDeal).map((deal) => deal.id));
  const limitNotes: string[] = [];
  if (captures.length >= OWN_READ_LIMITS.captures) limitNotes.push(`This report read only the oldest ${OWN_READ_LIMITS.captures} lead captures, so the newest leads may be missing.`);
  if (deals.length >= OWN_READ_LIMITS.deals) limitNotes.push(`This report read only ${OWN_READ_LIMITS.deals} deals, so some deals may be missing.`);
  if (contacts.length >= OWN_READ_LIMITS.contacts) limitNotes.push(`This report read only ${OWN_READ_LIMITS.contacts} contacts, so some leads may count as unqualified.`);
  const input: OwnInput = {
    ...range,
    captures,
    contacts: contacts.filter((contact) => !isCanaryId(contact.id)).map((contact) => ({ id: contact.id, lifecycle: contact.lifecycle, accountIds: accountsOf.get(contact.id) ?? [] })),
    deals: realDeals.map((deal) => ({ id: deal.id, contactId: deal.contact_id ?? null, accountId: deal.account_id ?? null, amountMinor: Number(deal.amount_minor ?? 0), currency: deal.currency, won: kinds.get(deal.stage_id) === "won", wonAt: deal.won_at ? new Date(String(deal.won_at)).toISOString() : null })),
    revenue: revenue.filter((row) => !isCanaryId(row.clientRef) && !(row.dealId && canaryDeals.has(row.dealId))),
    costs,
  };
  return { input, limitNotes };
}

/** The attribution report for ours (`client` null) or one client's. */
export async function attributionFor(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string } | null, range: { from: string; to: string }, label: string): Promise<AttributionReport> {
  if (!client) {
    const { input, limitNotes } = await loadOwnInput(ctx, companyId, range);
    const built = buildOwnAttribution(input);
    return { scope: "own", client: null, clientName: null, period: label, range, ...built, notes: [...modelNotes("own", built.persistedShare), ...limitNotes] };
  }
  const info = await clientInfo(ctx, companyId, client);
  const profile = await getClientProfile(ctx, companyId, client.kind, client.id).catch(() => null);
  const site = hostOf(profile?.website ?? info?.website ?? null);
  const [leads, costs] = await Promise.all([clientLeadsBetween(ctx, companyId, client, range.from, range.to), costsOf(ctx, companyId, refOf(client.kind, client.id))]);
  const built = buildClientAttribution({ ...range, leads, costs, ownHosts: site ? [site] : [] });
  return { scope: "client", client: refOf(client.kind, client.id), clientName: info?.name ?? null, period: label, range, ...built, notes: modelNotes("client", built.persistedShare) };
}

function modelNotes(scope: "own" | "client", persistedShare: number | null): string[] {
  const notes = [
    "A lead's channel comes from the campaign tags and the referring site of the visit its form was on. A visit with neither is direct; a lead with nothing on record at all is unattributed. Nothing is guessed.",
    persistedShare === null
      ? "No lead in this period came with remembered earlier visits, so first and last touch are the same visit for every lead."
      : `${Math.round(persistedShare * 100)}% of the period's form leads came with remembered earlier visits (the visitor's site banner allowed it); for the rest first and last touch are the one visit the form was on.`,
    "Each sale is credited once under each model, never split between channels. A sale with no lead capture behind it is unattributed.",
    "Costs are only the ones recorded with record-channel-cost. Money is kept per currency and never converted.",
  ];
  if (scope === "own") notes.push("Revenue is what Billing told the CRM was paid (invoice.paid): invoices not yet paid are not counted. The canary client's test records (its deal and its test payment) are never counted.");
  else notes.push("A client's revenue is only what the client told us about each lead (record-lead-outcome): we do not see their sales. Enquiries from social messages and email are counted by where they arrived (social, direct).");
  return notes;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const moneyText = (money: Money): string => {
  const parts = Object.entries(money).map(([currency, minor]) => formatMoneyMinor(minor, currency));
  return parts.length ? parts.join(" + ") : "none";
};

function cellOut(cell: Cell) {
  return { leads: cell.leads, qualified: cell.qualified, won: cell.won, wonValue: moneyText(cell.wonValue), wonValueMinor: cell.wonValue, revenue: moneyText(cell.revenue), revenueMinor: cell.revenue };
}

/** The report as a tool returns it: plain numbers and money text, with the model's limits. */
export function attributionOut(report: AttributionReport, events?: EventsSummary | null) {
  return {
    scope: report.scope,
    client: report.client,
    clientName: report.clientName,
    period: report.period,
    channels: report.rows.map((row) => ({ channel: row.channel, label: row.label, firstTouch: cellOut(row.first), lastTouch: cellOut(row.last), cost: moneyText(row.cost), costMinor: row.cost, costPerLead: row.costPerLead ? moneyText(row.costPerLead) : null })),
    totals: { firstTouch: cellOut(report.totals.first), lastTouch: cellOut(report.totals.last), cost: moneyText(report.totals.cost) },
    topCampaigns: report.campaigns,
    ...(events ? { siteEvents: { visits: events.entrances, pageviews: events.pageviews, conversions: events.conversions.total, byChannel: events.channels.map((c) => ({ channel: c.channel, visits: c.entrances, conversions: c.conversions, conversionRate: c.conversionRate })) } } : {}),
    notes: report.notes,
  };
}

/** `attribution-report`: our own (no client) or one client's source-to-revenue report, per channel, first and last touch. */
export async function attributionReportTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  const range = rangeOf(params);
  const bounds = typeof params.period === "string" && params.period.trim() ? periodBounds(params.period.trim()) : { from: new Date(Date.parse(`${range.from}T00:00:00Z`) - 2 * 3_600_000).toISOString(), to: new Date(Date.parse(`${range.to}T00:00:00Z`) - 2 * 3_600_000).toISOString() };
  const report = await attributionFor(ctx, viewer.companyId, client, bounds, range.label);
  const events = client ? (await eventsSummaryFor(ctx, viewer.companyId, client, range)).summary : null;
  return attributionOut(report, events && events.entrances + events.conversions.total > 0 ? events : null);
}

const CHANNEL_VALUES = [...CHANNELS, UNATTRIBUTED] as const;

/** `record-channel-cost`: what a channel cost for a month (an agency fee, ad spend a client told us about). Replaces the month's earlier figure. */
export async function recordChannelCostTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  const channel = typeof params.channel === "string" ? params.channel : "";
  if (!(CHANNEL_VALUES as readonly string[]).includes(channel)) throw new CrmError(`channel must be one of ${CHANNEL_VALUES.join(", ")}`);
  const period = typeof params.period === "string" ? params.period.trim() : "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new CrmError("period must be YYYY-MM, e.g. 2026-09");
  const amount = Number(params.amountMinor);
  if (!Number.isInteger(amount) || amount < 0) throw new CrmError("amountMinor must be a whole number of cents (150000 is R 1,500.00)");
  const config = await readConfig(ctx, viewer.companyId).catch(() => ({} as Record<string, unknown>));
  const currency = typeof params.currency === "string" && params.currency.trim() ? params.currency.trim().toUpperCase() : typeof config.defaultCurrency === "string" ? config.defaultCurrency : "ZAR";
  if (!/^[A-Z]{3}$/.test(currency)) throw new CrmError("currency must be a 3-letter code, e.g. ZAR");
  const note = typeof params.note === "string" && params.note.trim() ? params.note.trim().slice(0, 300) : null;
  const scope = client ? refOf(client.kind, client.id) : "own";
  const result = await putCost(ctx, viewer.companyId, { scope, channel, period, amountMinor: amount, currency, note }, viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null);
  return { recorded: result, scope, channel, period, cost: formatMoneyMinor(amount, currency), note: "It replaces any figure already recorded for this channel and month, and shows in attribution-report." };
}

/** `list-client-leads`: a client's enquiries with where each came from and what became of it (no email or phone). */
export async function listClientLeadsTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const range = rangeOf({ ...params, days: params.days ?? 90 });
  const bounds = typeof params.period === "string" && params.period.trim() ? periodBounds(params.period.trim()) : { from: new Date(Date.parse(`${range.from}T00:00:00Z`) - 2 * 3_600_000).toISOString(), to: new Date(Date.parse(`${range.to}T00:00:00Z`) - 2 * 3_600_000).toISOString() };
  const wanted = typeof params.outcome === "string" && params.outcome ? params.outcome : null;
  if (wanted && !(LEAD_OUTCOMES as readonly string[]).includes(wanted)) throw new CrmError(`outcome must be one of ${LEAD_OUTCOMES.join(", ")}`);
  const leads = (await clientLeadsBetween(ctx, viewer.companyId, client, bounds.from, bounds.to, 200)).filter((lead) => !wanted || lead.outcome === wanted);
  return {
    client: refOf(client.kind, client.id),
    clientName: name,
    period: range.label,
    count: leads.length,
    leads: leads.slice(-100).reverse().map((lead) => {
      const touches = lead.source === "form" ? leadTouches(lead.attribution) : null;
      return { key: lead.key, at: lead.capturedAt, from: lead.source === "form" ? "website form" : lead.source, firstTouch: touches?.first ?? channelOfSource(lead.source) ?? UNATTRIBUTED, lastTouch: touches?.last ?? channelOfSource(lead.source) ?? UNATTRIBUTED, name: lead.name, outcome: lead.outcome, value: lead.valueMinor != null && lead.currency ? formatMoneyMinor(lead.valueMinor, lead.currency) : null };
    }),
    next: "When the client tells you what became of an enquiry, record-lead-outcome (key, outcome, and the value in cents when won). That is what lets the report show which channel brought work.",
  };
}

/** `record-lead-outcome`: what the client says became of one of its enquiries. */
export async function recordLeadOutcomeTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  await requireClient(ctx, viewer, client);
  const key = typeof params.key === "string" ? params.key.trim() : "";
  if (!key) throw new CrmError("key is required (list-client-leads shows each enquiry's key)");
  const lead = await clientLeadByKey(ctx, viewer.companyId, client, key);
  if (!lead) throw new CrmError("That enquiry was not found for this client (list-client-leads shows them)");
  const outcome = typeof params.outcome === "string" ? params.outcome : "";
  if (!(LEAD_OUTCOMES as readonly string[]).includes(outcome)) throw new CrmError(`outcome must be one of ${LEAD_OUTCOMES.join(", ")}`);
  let valueMinor: number | null = null;
  let currency: string | null = null;
  if (params.valueMinor != null && params.valueMinor !== "") {
    if (outcome !== "won") throw new CrmError("A value goes only with outcome won");
    valueMinor = Number(params.valueMinor);
    if (!Number.isInteger(valueMinor) || valueMinor < 0) throw new CrmError("valueMinor must be a whole number of cents (150000 is R 1,500.00)");
    const config = await readConfig(ctx, viewer.companyId).catch(() => ({} as Record<string, unknown>));
    currency = typeof params.currency === "string" && params.currency.trim() ? params.currency.trim().toUpperCase() : typeof config.defaultCurrency === "string" ? config.defaultCurrency : "ZAR";
    if (!/^[A-Z]{3}$/.test(currency)) throw new CrmError("currency must be a 3-letter code, e.g. ZAR");
  }
  await setLeadOutcome(ctx, viewer.companyId, key, { outcome: outcome as LeadOutcome, valueMinor, currency });
  return { key, outcome, value: valueMinor != null && currency ? formatMoneyMinor(valueMinor, currency) : null };
}

// ---------------------------------------------------------------------------
// The monthly client report
// ---------------------------------------------------------------------------

/**
 * The "where your enquiries came from" section of a client's monthly report, from the client's site counts and the enquiries on its
 * forms. Null when there is nothing to say (no counts and no enquiries). Only what the client may see: no costs, no internal notes.
 */
export async function growthSection(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }, period: string): Promise<ReportSection | null> {
  const bounds = periodBounds(period);
  const days = periodDays(period);
  const [report, events] = await Promise.all([attributionFor(ctx, companyId, client, bounds, period), eventsSummaryFor(ctx, companyId, client, days).then((r) => r.summary).catch(() => null)]);
  const leads = report.totals.first.leads;
  const visits = events?.entrances ?? 0;
  if (leads === 0 && visits === 0 && (events?.conversions.total ?? 0) === 0) return null;
  const headline: ReportSection["headline"] = [];
  if (visits > 0) headline.push({ label: "Website visits", value: visits.toLocaleString("en-US"), delta: null });
  if (events && events.conversions.total > 0) headline.push({ label: "Actions on your site", value: events.conversions.total.toLocaleString("en-US"), delta: events.entrances > 0 ? `${Math.round((events.conversions.total / events.entrances) * 1000) / 10}% of visits` : null });
  // The enquiry total is in the "Enquiries for your business" section already; this one says where they came from.
  if (report.totals.first.won > 0) headline.push({ label: "Enquiries that became work", value: String(report.totals.first.won), delta: Object.keys(report.totals.first.wonValue).length ? moneyText(report.totals.first.wonValue) : null });
  const bullets: string[] = [];
  for (const row of report.rows.filter((r) => r.first.leads > 0).slice(0, 4)) {
    const bits = [`${row.first.leads} enquir${row.first.leads === 1 ? "y" : "ies"}`];
    if (row.first.qualified > 0) bits.push(`${row.first.qualified} serious`);
    if (row.first.won > 0) bits.push(`${row.first.won} became work${Object.keys(row.first.wonValue).length ? ` (${moneyText(row.first.wonValue)})` : ""}`);
    bullets.push(`${row.label}: ${bits.join(", ")}.`);
  }
  if (events && events.channels.length > 0) {
    for (const channel of events.channels.filter((c) => c.entrances > 0).slice(0, 3)) bullets.push(`${channel.label} brought ${channel.entrances.toLocaleString("en-US")} visit${channel.entrances === 1 ? "" : "s"}${channel.conversions > 0 ? ` and ${channel.conversions} action${channel.conversions === 1 ? "" : "s"} on your site` : ""}.`);
  }
  // The counts are estimates, the way the tools say: a client reading "Website visits" must not take it for an exact figure.
  const notes: string[] = [];
  if (visits > 0 || (events?.conversions.total ?? 0) > 0) notes.push("Visit and action counts are estimates: visitors whose browser asks not to be tracked are not counted.");
  if (leads > 0 && report.persistedShare === null) notes.push("Each enquiry is counted by the visit it came on.");
  return { module: "growth", title: "Where your enquiries came from", source: "crm", headline, bullets, note: notes.length > 0 ? notes.join(" ") : undefined };
}

