/**
 * Pure helpers for the CRM pages (no React, no host hooks), so the rules the
 * pages show are unit tested: what a tab badge means, money typed by a
 * person, who a deal is for, where "Draft a quote" goes, which module cards
 * a client page shows and whether email steps can go out.
 */

// ---------------------------------------------------------------------------
// Tab badges: a tinted count is "needs you"; a plain count is just a count.
// ---------------------------------------------------------------------------

export interface TabBadge {
  count: number | null;
  countTone?: "warn";
}

/** `needsYou` items tint the badge and show their own number; otherwise the plain total. */
export function tabBadge(total: number, needsYou = 0): TabBadge {
  if (needsYou > 0) return { count: needsYou, countTone: "warn" };
  return { count: total };
}

/**
 * A contact needs a follow-up when its next action is due now or earlier:
 * the same rule as the Cockpit's "Contacts needing follow-up".
 */
export function followUpDue(contact: { nextActionDueAt?: string | null }, now: number = Date.now()): boolean {
  if (!contact.nextActionDueAt) return false;
  const due = Date.parse(contact.nextActionDueAt);
  return !Number.isNaN(due) && due <= now;
}

export interface CrmCounts {
  companies: number;
  contacts: number;
  deals: number;
  sequences: number;
  products: number;
  /** Contacts whose next action is due. */
  followUps: number;
  /** Deals with no value yet. */
  dealsWithoutValue: number;
  /** Email sequences a person has not approved yet. */
  sequencesAwaitingApproval: number;
}

export type CrmTab = "overview" | "companies" | "contacts" | "deals" | "sequences" | "products";

/** Every CRM tab's badge. The Overview only shows what needs you. */
export function crmTabBadges(counts: CrmCounts): Record<CrmTab, TabBadge> {
  const needsYou = counts.followUps + counts.dealsWithoutValue + counts.sequencesAwaitingApproval;
  return {
    overview: needsYou > 0 ? { count: needsYou, countTone: "warn" } : { count: null },
    companies: tabBadge(counts.companies),
    contacts: tabBadge(counts.contacts, counts.followUps),
    deals: tabBadge(counts.deals, counts.dealsWithoutValue),
    sequences: tabBadge(counts.sequences, counts.sequencesAwaitingApproval),
    products: tabBadge(counts.products),
  };
}

// ---------------------------------------------------------------------------
// Money a person types
// ---------------------------------------------------------------------------

/**
 * A value typed in rand (or any currency's major unit) as integer minor units:
 * "15000", "15 000", "R 15,000.50", "15000,50" and "1.500,50" all work.
 * Empty is 0 (no value yet). Anything else, or a negative, is null.
 */
export function parseMoneyInput(text: string): number | null {
  // Spaces go; so does a leading currency ("R", "ZAR", "$") in front of the number.
  let value = text.replace(/[\s ]/g, "").replace(/^(?:[A-Za-z]{1,3}|[$€£])(?=[\d.,])/, "");
  if (value === "") return 0;
  if (!/^[0-9.,]+$/.test(value)) return null;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: the later one is the decimal mark.
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    value = value.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    const parts = value.split(",");
    // "1,500" and "1,500,000" are thousands; "1500,5" and "1500,50" are decimals.
    value = parts.length === 2 && parts[1]!.length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join("");
  } else if (lastDot >= 0) {
    const parts = value.split(".");
    // "1.500.000" is thousands; one dot is a decimal point.
    if (parts.length > 2) value = parts.join("");
  }
  if (!/^\d*(\.\d{0,2})?$/.test(value) || value === "." || value === "") return null;
  const [whole, cents = ""] = value.split(".");
  const minor = Number(whole || "0") * 100 + Number(cents.padEnd(2, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units as the text a money field starts with: "1500" or "1500.50"; empty for 0. */
export function moneyInputValue(minor: number): string {
  if (!Number.isFinite(minor) || minor <= 0) return "";
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return cents ? `${whole}.${String(cents).padStart(2, "0")}` : String(whole);
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export interface DealLike {
  id: string;
  accountId: string | null;
  contactId: string | null;
}

/** Who the deal is for: its company, else its contact, else nobody yet. */
export function dealClient(deal: DealLike): { kind: "company" | "contact"; id: string } | null {
  if (deal.accountId) return { kind: "company", id: deal.accountId };
  if (deal.contactId) return { kind: "contact", id: deal.contactId };
  return null;
}

/** "Northwind", "Ada Lovelace", or "Northwind · Ada Lovelace" when both are set. */
export function dealClientLabel(deal: DealLike, companyName: (id: string) => string | null, contactName: (id: string) => string | null): string | null {
  const company = deal.accountId ? companyName(deal.accountId) : null;
  const contact = deal.contactId ? contactName(deal.contactId) : null;
  if (company && contact) return `${company} · ${contact}`;
  return company ?? contact ?? null;
}

/**
 * "Draft a quote": Billing's quotes for the deal's client (`tab` and
 * `client`). With `prefill`, `new=1` and `dealId` also open Billing's quote
 * form with the client and this deal filled in.
 */
export function quoteHref(deal: DealLike, prefill = false): string | null {
  const client = dealClient(deal);
  if (!client) return null;
  const params = new URLSearchParams({ tab: "quotes", client: `${client.kind}:${client.id}` });
  if (prefill) {
    params.set("new", "1");
    params.set("dealId", deal.id);
  }
  return `/billing?${params.toString()}`;
}

export interface StageLike {
  id: string;
  name: string;
  kind: string;
  position: number;
}

/** Stages in order with their deals: open stages first, then won and lost. */
export function dealsByStage<T extends { stageId: string }>(stages: StageLike[], deals: T[]): Array<{ stage: StageLike; deals: T[] }> {
  const rank = (kind: string) => (kind === "open" ? 0 : kind === "won" ? 1 : 2);
  return [...stages]
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.position - b.position)
    .map((stage) => ({ stage, deals: deals.filter((deal) => deal.stageId === stage.id) }));
}

// ---------------------------------------------------------------------------
// Locks: fields only people may change
// ---------------------------------------------------------------------------

/** The owned list after locking or unlocking `keys` (other entries are kept). */
export function toggleOwned(owned: string[], keys: string[], lock: boolean): string[] {
  const set = new Set(owned);
  for (const key of keys) {
    if (lock) set.add(key);
    else set.delete(key);
  }
  return [...set];
}

/** A row is locked when every key behind it is. */
export function isLocked(owned: string[], keys: string[]): boolean {
  return keys.length > 0 && keys.every((key) => owned.includes(key));
}

// ---------------------------------------------------------------------------
// Other modules
// ---------------------------------------------------------------------------

export interface Contribution {
  pluginKey: string;
  slots?: Array<{ type?: string }>;
}

/**
 * Whether a module's page is installed. `undefined` (still loading) is
 * unknown: nothing is shown yet. `null` (could not be read) shows it, like the
 * workspace tabs do.
 */
export function moduleInstalled(contributions: Contribution[] | null | undefined, pluginKey: string): boolean | null {
  if (contributions === undefined) return null;
  if (contributions === null) return true;
  return contributions.some((c) => c.pluginKey === pluginKey && (c.slots ?? []).some((slot) => slot.type === "page"));
}

export type GmailState = "connected" | "missing" | "reconnect" | "off" | "unknown";

/**
 * Can email steps go out? From the Mailbox's own setup checklist (its `gmail`
 * item) and whether the Mailbox module is on. `null` while loading.
 */
export function gmailState(
  status: { items: Array<{ key: string; status: string }> } | null | undefined,
  mailboxEnabled: boolean | null,
): GmailState | null {
  if (mailboxEnabled === false) return "off";
  if (status === undefined || mailboxEnabled === null) return null;
  const item = status?.items.find((row) => row.key === "gmail");
  if (!item) return "unknown";
  if (item.status === "done") return "connected";
  if (item.status === "blocked") return "reconnect";
  return "missing";
}

/** The one line a page shows when email steps cannot go out; null when they can (or it is unknown). */
export function gmailLine(state: GmailState | null, emailSequences: number): string | null {
  if (state === "off") return "The Mailbox is switched off, so email steps can't go out.";
  if (state === "reconnect") return "Gmail needs reconnecting, so email steps can't go out.";
  if (state !== "missing") return null;
  return emailSequences > 0
    ? `Gmail isn't connected, so ${emailSequences === 1 ? "1 email sequence" : `${emailSequences} email sequences`} can't send.`
    : "Gmail isn't connected, so email steps can't go out yet.";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Another module's summary text as this page shows money and dates:
 * "ZAR 7,500.00" is "R 7,500.00" and an ISO date is "28 Sep" (with the year
 * when it is not this year). Anything else is left as it is.
 */
export function displayText(value: string, now: Date = new Date()): string {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (iso) {
    // A date stays that calendar day; a timestamp is shown on the viewer's day.
    const at = iso[4] ? new Date(text) : null;
    const [year, month, day] = at && !Number.isNaN(at.getTime())
      ? [at.getFullYear(), at.getMonth() + 1, at.getDate()]
      : [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${day} ${MONTHS[month - 1]}${year === now.getFullYear() ? "" : ` ${year}`}`;
  }
  return value.replace(/\bZAR\s?(?=-?\d)/g, "R ");
}

// ---------------------------------------------------------------------------
// Sequences in plain words
// ---------------------------------------------------------------------------

/** "Right away", "After 2 hours", "After 3 days". */
export function delayText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Right away";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `After ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `After ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `After ${minutes} min`;
}
