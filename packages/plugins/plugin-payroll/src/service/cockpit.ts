/**
 * Company Cockpit snapshot for Payroll (`GET /cockpit`, pushed hourly as
 * `cockpit.snapshot`): next pay date, last run cost, headcount, the EMP201
 * due, job and posting health, approvals waiting on a board member, recent
 * activity and run quality.
 *
 * NEVER carries personal data: no employee names, emails, ID, tax or bank
 * details, leave types or reasons, and no per-employee amounts. Only counts,
 * run numbers, dates and company totals. Read-only (SELECTs through db.ts);
 * each part is wrapped so one failing query never breaks the snapshot.
 */
import {
  configSaved,
  emptySnapshot,
  formatMoneyMinor,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  type CockpitSnapshot,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { variances } from "../domain.js";
import { PLUGIN_ID } from "../namespace.js";
import { ruleVersionFor } from "../rules.js";
import { emp201DueDate } from "../statutory.js";
import { errorMessage, today, type Env } from "./env.js";
import { rulesReviewed } from "./setup.js";
import { emp201Series } from "./statutory.js";

/** Scheduled jobs and their interval in minutes (from the manifest schedules). */
export const PAYROLL_JOBS: Array<{ key: string; title: string; everyMinutes: number }> = [
  { key: "redeliver", title: "Re-send to Accounting and Mailbox", everyMinutes: 5 },
  { key: "follow-up", title: "Payroll follow-up", everyMinutes: 15 },
];

const PAGE = "/payroll";
const OPEN = new Set(["draft", "calculated", "pending_approval", "approved"]);
const issueHref = (issueId: string) => `/issues/${issueId}`;
const money = (minor: number) => formatMoneyMinor(minor, "ZAR");
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The next date on `payDay` (clamped to the month's last day) on or after `from`. */
export function nextPayDay(from: string, payDay: number): string {
  const [y, m] = from.split("-").map(Number) as [number, number];
  for (let i = 0; i < 2; i += 1) {
    const year = y + Math.floor((m - 1 + i) / 12);
    const month = ((m - 1 + i) % 12) + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(payDay, last)).padStart(2, "0")}`;
    if (date >= from) return date;
  }
  return from;
}

export async function cockpitSnapshot(e: Env, companyId: string): Promise<CockpitSnapshot> {
  const { ctx } = e;
  const snap = emptySnapshot(PLUGIN_ID, "Payroll");
  const failed: string[] = [];
  const part = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failed.push(`${label}: ${errorMessage(error)}`);
    }
  };
  const date = today(e);

  const saved = await configSaved(ctx, companyId).catch(() => false);
  if (!saved) {
    snap.health.push({
      key: "settings",
      title: "Payroll settings",
      status: "warn",
      detail: "Payroll settings were never saved for this company, so its scheduled jobs skip it.",
      href: "/setup",
      fix: "Open Setup (or Payroll settings), fill in the employer details and encryption key, and click Save Configuration.",
    });
  }

  let runs: db.PayRun[] = [];
  await part("runs", async () => {
    runs = await db.listRuns(ctx, companyId, 24);
  });
  const lastLocked = runs.find((r) => r.status === "locked" && r.kind !== "reversal") ?? null;

  // ── KPIs ────────────────────────────────────────────────────────────────
  await part("next pay date", async () => {
    const open = runs.filter((r) => OPEN.has(r.status)).sort((a, b) => a.payDate.localeCompare(b.payDate));
    const next = open[0] ?? null;
    let payDate: string;
    let tone: Tone = "neutral";
    if (next) {
      payDate = next.payDate;
      const days = daysBetween(date, payDate);
      tone = days < 0 ? "bad" : days <= 2 && next.status !== "approved" ? "warn" : "neutral";
    } else {
      payDate = nextPayDay(date, (await e.config(companyId)).defaultPayDay);
    }
    snap.kpis.push({ key: "next_pay_date", label: next ? `Next pay date (${next.number})` : "Next pay date", value: payDate, raw: daysBetween(date, payDate), tone, href: `${PAGE}?tab=runs`, group: "people" });
  });

  if (lastLocked) {
    snap.kpis.push({ key: "last_run_cost", label: `Last run cost (${lastLocked.number})`, value: money(lastLocked.totals.employerCostMinor), raw: lastLocked.totals.employerCostMinor, tone: "neutral", href: `${PAGE}?tab=runs`, group: "money" });
  }

  await part("employees", async () => {
    const active = (await db.listEmployees(ctx, companyId, { status: "active" })).length;
    snap.kpis.push({ key: "employees_active", label: "Employees", value: String(active), raw: active, tone: "neutral", href: `${PAGE}?tab=employees`, group: "people" });
  });

  await part("emp201", async () => {
    // The EMP201 for the month of the latest locked run is due by the 7th of the next month.
    if (!lastLocked) return;
    const month = lastLocked.payDate.slice(0, 7);
    const due = emp201DueDate(month);
    if (due < date) return;
    const series = await emp201Series(e, companyId, month);
    const last = series[series.length - 1];
    if (!last) return;
    const days = daysBetween(date, due);
    snap.kpis.push({ key: "emp201", label: `EMP201 for ${month}`, value: `${money(last.totalPayableMinor)} by ${due}`, raw: last.totalPayableMinor, tone: days <= 3 ? "warn" : "neutral", href: `${PAGE}?tab=statutory`, group: "money" });
  });

  // ── Health ──────────────────────────────────────────────────────────────
  await part("jobs", async () => {
    for (const job of PAYROLL_JOBS) snap.health.push(await jobHealth(ctx, job.key, job.title, job.everyMinutes));
  });
  await part("outbox", async () => {
    snap.health.push({ ...(await outboxHealth(ctx, companyId)), href: PAGE });
  });

  {
    const bad = runs.filter((r) => r.status === "locked" && (r.ledgerStatus === "rejected" || r.ledgerStatus === "failed"));
    snap.health.push(bad.length
      ? { key: "ledger", title: "Pay runs in the books", status: "bad", detail: `${plural(bad.length, "locked run")} not posted to Accounting (${bad.map((r) => r.number).join(", ")}).`, href: `${PAGE}?tab=runs`, fix: "Fix the cause in Accounting (roles, closed period), then press Post again on the run." }
      : { key: "ledger", title: "Pay runs in the books", status: "ok" });
  }

  await part("payslips", async () => {
    const failedSlips = (await db.listPayslips(ctx, companyId)).filter((p) => p.status === "failed").length;
    snap.health.push(failedSlips > 0
      ? { key: "payslips", title: "Payslip emails", status: "warn", detail: `${plural(failedSlips, "payslip")} could not be emailed.`, href: `${PAGE}?tab=payslips`, fix: "Check Gmail is connected in the Mailbox and the employees' email addresses, then email the payslips again." }
      : { key: "payslips", title: "Payslip emails", status: "ok" });
  });

  await part("rules", async () => {
    const version = ruleVersionFor(await db.listRuleVersions(ctx), date);
    if (!version) {
      snap.health.push({ key: "rules", title: "Tax rules", status: "bad", detail: `No payroll tax rules are loaded for ${date}, so pay runs cannot be calculated.`, href: `${PAGE}?tab=statutory`, fix: "Update the Payroll plugin to a version with this tax year's rules." });
      return;
    }
    snap.health.push({ key: "rules", title: "Tax rules", status: "ok", detail: `Tax year ${version.taxYear}.` });
    const reviewed = await rulesReviewed(e, companyId);
    snap.health.push(reviewed
      ? { key: "rules_review", title: "Unverified tax rules", status: "ok" }
      : { key: "rules_review", title: "Unverified tax rules", status: "warn", detail: `${plural(version.unverified.length, "rule")} in this tax year are not confirmed against SARS yet and nobody has reviewed them.`, href: `${PAGE}?tab=statutory`, fix: "A board member reads the flagged rules under Payroll → Statutory and marks them reviewed." });
  });

  // ── Waiting on a person ─────────────────────────────────────────────────
  for (const run of runs.filter((r) => r.status === "pending_approval" && r.approvalIssueId)) {
    snap.waiting.push({
      key: `approval:${run.approvalIssueId}`,
      title: `Approve pay run ${run.number}`,
      why: `Paying ${plural(run.totals.employeeCount, "employee")} ${money(run.totals.netPayMinor)} on ${run.payDate} needs a board member who did not prepare it.`,
      href: issueHref(run.approvalIssueId!),
      issueId: run.approvalIssueId,
      kind: "money",
      since: run.approvalRequestedAt,
    });
  }
  await part("leave", async () => {
    for (const leave of (await db.listLeave(ctx, companyId, { status: "pending" })).filter((l) => l.approvalIssueId)) {
      snap.waiting.push({ key: `leave:${leave.approvalIssueId}`, title: "Approve a leave request", why: "Leave is approved by the leave approver.", href: issueHref(leave.approvalIssueId!), issueId: leave.approvalIssueId, kind: "judgement", since: leave.createdAt });
    }
  });

  // ── Activity ────────────────────────────────────────────────────────────
  await part("activity", async () => {
    const items: Array<{ at: string; text: string; href: string }> = [];
    for (const run of runs) {
      if (run.lockedAt && run.status !== "cancelled") items.push({ at: run.lockedAt, text: `Locked pay run ${run.number} (${plural(run.totals.employeeCount, "employee")})`, href: `${PAGE}?tab=runs` });
    }
    const byRun = new Map<string, { count: number; at: string }>();
    for (const slip of await db.listPayslips(ctx, companyId)) {
      if (slip.status !== "sent" || !slip.emailedAt) continue;
      const cur = byRun.get(slip.runId) ?? { count: 0, at: slip.emailedAt };
      byRun.set(slip.runId, { count: cur.count + 1, at: slip.emailedAt > cur.at ? slip.emailedAt : cur.at });
    }
    const numbers = new Map(runs.map((r) => [r.id, r.number]));
    for (const [runId, v] of byRun) items.push({ at: v.at, text: `Emailed ${plural(v.count, "payslip")}${numbers.get(runId) ? ` for ${numbers.get(runId)}` : ""}`, href: `${PAGE}?tab=payslips` });
    items.sort((a, b) => b.at.localeCompare(a.at));
    snap.activity.push(...items.slice(0, 10).map((i) => ({ at: new Date(i.at).toISOString(), text: i.text, href: i.href })));
  });

  // ── Quality ─────────────────────────────────────────────────────────────
  await part("quality", async () => {
    const latest = runs.find((r) => r.kind === "regular" && (r.status === "locked" || OPEN.has(r.status)) && r.status !== "draft") ?? null;
    if (!latest) return;
    const inputs = await db.getInputs(ctx, latest.id);
    const adjusted = [...inputs.values()].filter((v) => v && Object.keys(v).length > 0).length;
    snap.quality.push({ key: "adjustments", label: `Employees adjusted on ${latest.number}`, value: String(adjusted), raw: adjusted, tone: "neutral" });

    const previous = runs.find((r) => r.id !== latest.id && r.frequency === latest.frequency && r.kind !== "reversal" && r.status === "locked" && r.payDate <= latest.payDate);
    if (!previous) return;
    const row = (i: db.RunItem) => ({ employeeId: i.employeeId, name: i.employeeId, grossMinor: i.grossMinor, netMinor: i.netMinor, payeMinor: i.payeMinor });
    const [now, before] = await Promise.all([db.listItems(ctx, companyId, latest.id), db.listItems(ctx, companyId, previous.id)]);
    const v = variances(now.filter((i) => i.status === "ok").map(row), before.filter((i) => i.status === "ok").map(row));
    const flagged = new Set(v.changes.map((c) => c.employeeId)).size + v.added.length + v.missing.length;
    snap.quality.push({ key: "variance_flags", label: `Variance flags on ${latest.number} (vs ${previous.number})`, value: String(flagged), raw: flagged, tone: flagged > 0 ? "warn" : "ok" });
  });

  if (failed.length) {
    snap.health.push({ key: "snapshot", title: "Cockpit numbers", status: "warn", detail: `Some numbers could not be read: ${failed.join("; ").slice(0, 400)}` });
  }
  snap.checkedAt = e.now().toISOString();
  return snap;
}

const PUSH_EVERY_MS = 60 * 60 * 1000;
const cockpitPushed = new Map<string, number>();

/** Pushes the snapshot to the Cockpit, at most hourly per company (module on, settings saved). Never throws. */
export async function publishCockpit(e: Env, companyId: string, pushed: Map<string, number> = cockpitPushed): Promise<boolean> {
  const now = e.now().getTime();
  const last = pushed.get(companyId);
  if (last !== undefined && now - last < PUSH_EVERY_MS) return false;
  pushed.set(companyId, now);
  try {
    if (!(await isModuleEnabled(e.ctx, companyId, PLUGIN_ID)) || !(await configSaved(e.ctx, companyId))) return false;
    await publishCockpitSnapshot(e.ctx, companyId, await cockpitSnapshot(e, companyId));
    return true;
  } catch (error) {
    e.ctx.logger.info("Payroll cockpit snapshot failed", { companyId, error: errorMessage(error) });
    return false;
  }
}
