/** Pure helpers for the page: chart data, tones and wording. Kept out of the component so they are tested without a browser. */
import type { ToneInput } from "@partnersinbiz/pib-plugin-ui";
import type { BudgetInfo, Summary } from "./types.js";

/** Daily spend of one currency (the first one present) as labelled points for a trend chart; days with no row are zero. */
export function spendSeries(daily: Summary | null | undefined, days = 30): { currency: string | null; labels: string[]; values: number[]; others: number } {
  if (!daily || daily.groups.length === 0) return { currency: null, labels: [], values: [], others: 0 };
  const currency = daily.groups[0]!.currency;
  const byDay = new Map<string, number>();
  let others = 0;
  for (const g of daily.groups) {
    if (g.currency !== currency) {
      others += 1;
      continue;
    }
    byDay.set(g.key, (byDay.get(g.key) ?? 0) + g.spendMinor);
  }
  const labels: string[] = [];
  const values: number[] = [];
  const until = Date.parse(`${daily.period.until}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(until - i * 86_400_000).toISOString().slice(0, 10);
    labels.push(day.slice(5));
    values.push((byDay.get(day) ?? 0) / 100);
  }
  return { currency, labels, values, others };
}

export function budgetToneOf(b: Pick<BudgetInfo, "state">): ToneInput {
  return b.state === "over" ? "bad" : b.state === "alert" ? "warn" : b.state === "watch" ? "warn" : b.state === "no_cap" ? "neutral" : "ok";
}

export const BUDGET_STATE_TEXT: Record<BudgetInfo["state"], string> = {
  no_cap: "No cap set",
  ok: "On track",
  watch: "Spending ahead of the month",
  alert: "Budget nearly used",
  over: "Budget used up",
};

export function statusTone(status: string): ToneInput {
  if (status === "executed" || status === "cleared" || status === "approved") return "ok";
  if (status === "failed" || status === "rejected") return "bad";
  if (status === "needs_changes" || status === "in_review" || status === "executing") return "warn";
  return "neutral";
}

export function connectionTone(status: string): ToneInput {
  return status === "connected" ? "ok" : status === "expiring" ? "warn" : status === "needs_reconnect" ? "bad" : "neutral";
}

export const CONNECTION_TEXT: Record<string, string> = { connected: "Connected", expiring: "Expiring soon", needs_reconnect: "Sign in again", disabled: "Removed" };

/** `12.5` from `1250` minor units for an input box, and back: money fields take major units like a person writes them. */
export function minorFromInput(text: string, exponent = 2): number | null {
  const t = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 10 ** exponent + Number(frac.padEnd(exponent, "0").slice(0, exponent));
}

export function inputFromMinor(minor: number | null, exponent = 2): string {
  if (minor === null) return "";
  const scale = 10 ** exponent;
  return `${Math.floor(minor / scale)}${exponent ? `.${String(minor % scale).padStart(exponent, "0")}` : ""}`;
}

export const ACTION_TEXT: Record<string, string> = {
  "write.executed": "Ran an approved change",
  "write.failed": "A change did not complete",
  "write.refused": "Refused to run a change",
  "proposal.created": "Proposed a change",
  "proposal.approved": "Approved a change",
  "proposal.rejected": "Refused a change",
  "proposal.cancelled": "Cancelled a change",
  "proposal.expired": "A change expired",
  "proposal.done_manually": "Marked a change done by hand",
  "writes.enabled": "Switched changes on",
  "writes.disabled": "Switched changes off",
  "budget.cap_set": "Set the monthly cap",
  "budget.month_cap_set": "Set one month's cap",
  "signoffs.set": "Changed who must sign",
  "connection.created": "Connected a platform",
  "connection.removed": "Removed a connection",
  "connection.needs_reconnect": "A connection needs signing in again",
  "account.registered": "Registered an ad account",
  "account.removed": "Removed an ad account",
  pause_requested: "Asked to pause ads",
  "alert.raised": "Raised an alert",
};
