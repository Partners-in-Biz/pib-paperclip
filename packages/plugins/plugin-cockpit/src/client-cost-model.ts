/**
 * Effort against revenue per client, pure part (no node imports) (Q1b-14).
 *
 * Client work is one Paperclip project per client, and the host already reports
 * tokens per project, but nothing set what a client's work costs against what
 * the client pays, so a retainer that costs more in agent effort than it brings
 * in could not be seen. This joins three things the Cockpit already has:
 * notional AI spend per project (heartbeat usage), the client's projects (the
 * CRM's client-to-project links, else a project named after the client), and
 * what the client paid (Billing's `invoice.paid` events, kept in
 * `client_revenue`).
 *
 * Honest limits, said in the output: notional spend is list price, not a bill;
 * Billing does not publish retainer amounts, so revenue is what was PAID in the
 * window; amounts in a currency other than ZAR or USD are left out; the
 * exchange rate is a setting, not a market rate.
 */
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { formatUsd, round } from "./measure-model.js";

export const EFFORT = {
  /** Days of work and payments compared. */
  days: 30,
  /** Warn when notional spend is at least this share of what the client paid. */
  alertRatio: 0.5,
  /** Ignore clients whose spend is under this: noise, not effort. */
  minUsd: 20,
  /** A customer with spend over this and nothing paid in the window is flagged. */
  noRevenueUsd: 100,
  /** ZAR per USD when the settings give none (a planning figure, not a quote). */
  defaultUsdRate: 18,
} as const;

export interface ProjectSpend {
  projectId: string | null;
  name: string | null;
  usd: number;
  runs: number;
  doneIssues: number;
}

export interface ClientRef {
  /** `company:<crm id>` */
  clientRef: string;
  name: string;
  lifecycle: string | null;
  /** Projects the CRM linked to the client. */
  linkedProjectIds: string[];
}

export interface Payment {
  clientRef: string | null;
  totalMinor: number;
  currency: string;
}

export interface ClientEffort {
  clientRef: string;
  name: string;
  lifecycle: string | null;
  /** How the projects were tied to the client: the CRM link, or the project's name. */
  matchedBy: "link" | "name";
  projects: Array<{ projectId: string; name: string | null; usd: number }>;
  usd: number;
  runs: number;
  doneIssues: number;
  /** Paid in the window, in ZAR (USD invoices converted at the rate). */
  paidZar: number;
  /** Invoices in other currencies were left out. */
  skippedCurrencies: string[];
  /** Notional spend (in ZAR at the rate) over what was paid; null when nothing was paid. */
  ratio: number | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Ties each client to its projects and sets their notional spend against what they paid. Clients with no spend are left out. */
export function clientEfforts(input: { projects: ProjectSpend[]; clients: ClientRef[]; payments: Payment[]; usdRate: number }): ClientEffort[] {
  const byId = new Map(input.projects.filter((p) => p.projectId).map((p) => [p.projectId!, p]));
  const byName = new Map<string, ProjectSpend[]>();
  for (const p of input.projects) if (p.projectId && p.name) byName.set(norm(p.name), [...(byName.get(norm(p.name)) ?? []), p]);
  const taken = new Set<string>();
  const out: ClientEffort[] = [];
  for (const client of input.clients) {
    let matched: ProjectSpend[] = client.linkedProjectIds.map((id) => byId.get(id)).filter((p): p is ProjectSpend => !!p && !taken.has(p.projectId!));
    let matchedBy: ClientEffort["matchedBy"] = "link";
    if (matched.length === 0) {
      matched = (byName.get(norm(client.name)) ?? []).filter((p) => !taken.has(p.projectId!));
      matchedBy = "name";
    }
    if (matched.length === 0) continue;
    for (const p of matched) taken.add(p.projectId!);
    const mine = input.payments.filter((p) => p.clientRef === client.clientRef);
    const skipped = [...new Set(mine.filter((p) => !["ZAR", "USD"].includes(p.currency.toUpperCase())).map((p) => p.currency.toUpperCase()))];
    const paidZar = mine.reduce((sum, p) => (p.currency.toUpperCase() === "ZAR" ? sum + p.totalMinor / 100 : p.currency.toUpperCase() === "USD" ? sum + (p.totalMinor / 100) * input.usdRate : sum), 0);
    const usd = matched.reduce((sum, p) => sum + p.usd, 0);
    out.push({
      clientRef: client.clientRef,
      name: client.name,
      lifecycle: client.lifecycle,
      matchedBy,
      projects: matched.map((p) => ({ projectId: p.projectId!, name: p.name, usd: round(p.usd) })),
      usd: round(usd),
      runs: matched.reduce((sum, p) => sum + p.runs, 0),
      doneIssues: matched.reduce((sum, p) => sum + p.doneIssues, 0),
      paidZar: round(paidZar),
      skippedCurrencies: skipped,
      ratio: paidZar > 0 ? round((usd * input.usdRate) / paidZar, 2) : null,
    });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

const zar = (x: number): string => `R ${Math.round(x).toLocaleString("en-US")}`;

/**
 * Health checks, only for customers (a lead's effort is a sales cost, not a
 * client's): effort over `alertRatio` of what they paid, or real effort and no
 * payment at all in the window.
 */
export function clientEffortChecks(rows: ClientEffort[], options: { alertRatio?: number; usdRate?: number; days?: number } = {}): HealthCheck[] {
  const alertRatio = options.alertRatio ?? EFFORT.alertRatio;
  const rate = options.usdRate ?? EFFORT.defaultUsdRate;
  const days = options.days ?? EFFORT.days;
  const out: HealthCheck[] = [];
  for (const row of rows) {
    if (row.lifecycle !== "customer" || row.usd < EFFORT.minUsd) continue;
    const href = `/cockpit?client=${row.clientRef}`;
    if (row.ratio !== null && row.ratio >= alertRatio) {
      out.push({
        key: `client-effort:${row.clientRef}`,
        title: `${row.name}: agent effort is ${Math.round(row.ratio * 100)}% of what they paid`,
        status: row.ratio >= 1 ? "bad" : "warn",
        detail: `In the last ${days} days the agents' notional spend on ${row.name} was ${formatUsd(row.usd)} (about ${zar(row.usd * rate)} at ${rate} per USD) against ${zar(row.paidZar)} paid. Notional spend is list price, not a bill, and only invoices paid in the window count (Billing does not publish retainer amounts).${row.skippedCurrencies.length ? ` Invoices in ${row.skippedCurrencies.join(", ")} are left out.` : ""}`,
        href,
        fix: "Look at what the work in this client's project cost and whether it was needed: narrow it, change the retainer, or move the repeated work to a routine. Do not stop client-facing work without telling the owner.",
      });
    } else if (row.paidZar === 0 && row.usd >= EFFORT.noRevenueUsd) {
      out.push({
        key: `client-effort:${row.clientRef}`,
        title: `${row.name}: ${formatUsd(row.usd)} of agent effort and nothing paid in ${days} days`,
        status: "warn",
        detail: `${row.name} is a customer, but no invoice for them was paid in the last ${days} days while the agents spent ${formatUsd(row.usd)} (notional) on their projects. Check whether an invoice is overdue or the work is outside the agreement.`,
        href,
        fix: "Open the client's Billing page: send or chase the invoice, or agree the scope. The Account Manager follows up on overdue invoices.",
      });
    }
  }
  return out;
}

/** The ranking the weekly retro prints: top clients by notional spend with what they paid. */
export function effortBrief(rows: ClientEffort[], usdRate: number): Array<Record<string, unknown>> {
  return rows.slice(0, 12).map((r) => ({
    client: r.name,
    ref: r.clientRef,
    lifecycle: r.lifecycle,
    notionalUsd: r.usd,
    runs: r.runs,
    doneIssues: r.doneIssues,
    paidZar: r.paidZar,
    effortVsPaid: r.ratio,
    projects: r.projects,
    matchedBy: r.matchedBy,
    ...(r.skippedCurrencies.length ? { skippedCurrencies: r.skippedCurrencies } : {}),
    rateUsed: usdRate,
  }));
}
