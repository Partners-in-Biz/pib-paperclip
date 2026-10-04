/**
 * The scheduled work of the client care features, and what they add to the
 * Cockpit. Every job acts for a company by name and only for companies whose
 * CRM settings are saved (host rule: a job has no company scope of its own), and
 * one failing company never stops the rest.
 *
 * - `site-monitor` (every 5 minutes): uptime, certificate and domain checks.
 * - `client-care` (every 15 minutes): approvals without an issue, emails the Mailbox
 *   never confirmed, support SLA breaches, reminders to clients, and (in the first
 *   ten days of a month) a catch-up of last month's reports. Once an hour it also
 *   asks the modules that have not answered an erasure again and seeds the register.
 * - `client-health` (daily 05:20 SAST): scores every customer and opens churn-risk issues.
 * - `client-report-monthly` (1st of the month, 06:00 SAST): last month's report for every customer.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, readConfig, type HealthCheck, type MailReceived, type WaitingItem } from "@partnersinbiz/pib-plugin-kit";
import { onClientMailReply, settleStuckMessages } from "./care-approvals.js";
import { approvalsByStatus, listActionsByStatus } from "./care-store.js";
import { clientActionsHealth, repliedActionItems, runActionReminders } from "./client-actions.js";
import { clientsAtRiskHealth, runHealthScores } from "./health-score.js";
import { esignHealth, runEsignCare } from "./esign.js";
import { syncAllPages } from "./esign-sync.js";
import { asMailReceived, matchContact } from "./mail.js";
import { runSiteMonitor, siteMonitorHealth } from "./monitor.js";
import { PLUGIN_ID } from "./namespace.js";
import { repairApprovalIssues } from "./outbound.js";
import { privacyHealth, reannounceAll } from "./privacy.js";
import { seedRegister } from "./register.js";
import { reportsHealth, runMonthlyReports } from "./report.js";
import { supportHealth, onSupportMail, runSupportSla } from "./support.js";
import { crmCompanyIds } from "./sync.js";

/** Companies with CRM records, the CRM switched on and its settings saved: the ones a job may act for. */
export async function careCompanies(ctx: PluginContext): Promise<string[]> {
  const out: string[] = [];
  for (const companyId of [...new Set(await crmCompanyIds(ctx).catch(() => [] as string[]))]) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      out.push(companyId);
    } catch {
      // not ready for this company
    }
  }
  return out;
}

async function eachCompany(ctx: PluginContext, job: string, run: (companyId: string) => Promise<unknown>): Promise<number> {
  let done = 0;
  for (const companyId of await careCompanies(ctx)) {
    try {
      await run(companyId);
      done += 1;
    } catch (error) {
      ctx.logger.info(`CRM ${job} skipped a company`, { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return done;
}

/** Every five minutes. */
export async function runSiteMonitorJob(ctx: PluginContext): Promise<{ companies: number; checked: number; down: number }> {
  const total = { companies: 0, checked: 0, down: 0 };
  total.companies = await eachCompany(ctx, "site monitor", async (companyId) => {
    const run = await runSiteMonitor(ctx, companyId);
    total.checked += run.checked;
    total.down += run.down;
  });
  return total;
}

export interface CareRun {
  companies: number;
  breaches: number;
  reminders: number;
  settled: number;
  reports: number;
  /** E-sign: documents expired, reminders drafted, signed documents finished. */
  esign: number;
}

/** Every 15 minutes. `now` is the clock (tests set it). */
export async function runClientCareJob(ctx: PluginContext, now = new Date()): Promise<CareRun> {
  const total: CareRun = { companies: 0, breaches: 0, reminders: 0, settled: 0, reports: 0, esign: 0 };
  const hourly = now.getUTCMinutes() < 15;
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  total.companies = await eachCompany(ctx, "client care", async (companyId) => {
    // Each step on its own, so one broken step leaves the others running.
    const step = async (label: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        ctx.logger.info("CRM client care step failed", { companyId, step: label, error: error instanceof Error ? error.message : String(error) });
      }
    };
    await step("approval issues", async () => void (await repairApprovalIssues(ctx, companyId, await approvalsByStatus(ctx, companyId, "open"))));
    await step("messages", async () => void (total.settled += await settleStuckMessages(ctx, companyId)));
    await step("support", async () => {
      const sla = await runSupportSla(ctx, companyId, now);
      total.breaches += sla.firstBreaches + sla.resolutionBreaches;
    });
    await step("reminders", async () => {
      const run = await runActionReminders(ctx, companyId, now);
      total.reminders += run.drafted;
    });
    await step("e-sign", async () => {
      const run = await runEsignCare(ctx, companyId, now);
      total.esign += run.expired + run.reminders + run.escalated + run.effects;
    });
    // The 1st is the monthly job's; days 2 to 10 catch up whatever it missed.
    if (hourly && sast.getUTCDate() >= 2 && sast.getUTCDate() <= 10) {
      await step("report catch-up", async () => void (total.reports += (await runMonthlyReports(ctx, companyId, now, 8)).opened));
    }
    if (hourly) {
      await step("erasures", async () => void (await reannounceAll(ctx, companyId)));
      await step("register", async () => void (await seedRegister(ctx, companyId)));
    }
  });
  // The signing pages are files that a deploy removes: written again from the records (one pass for every company).
  await syncAllPages(ctx).catch((error) => ctx.logger.info("CRM signing pages sync failed", { error: error instanceof Error ? error.message : String(error) }));
  return total;
}

/** Daily. */
export async function runClientHealthJob(ctx: PluginContext, now = new Date()): Promise<{ companies: number; scored: number; alerts: number }> {
  const total = { companies: 0, scored: 0, alerts: 0 };
  total.companies = await eachCompany(ctx, "client health", async (companyId) => {
    const run = await runHealthScores(ctx, companyId, now);
    total.scored += run.scored;
    total.alerts += run.alerts;
  });
  return total;
}

/** The 1st of the month. */
export async function runMonthlyReportJob(ctx: PluginContext, now = new Date()): Promise<{ companies: number; opened: number }> {
  const total = { companies: 0, opened: 0 };
  total.companies = await eachCompany(ctx, "monthly report", async (companyId) => {
    total.opened += (await runMonthlyReports(ctx, companyId, now, 40)).opened;
  });
  return total;
}

/** A mail the Mailbox announced: a reply to one of our client emails, or a support request that becomes a case. Never throws. */
export async function onMailForCare(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const mail: MailReceived | null = asMailReceived(event.payload);
  if (!mail || !event.companyId) return;
  try {
    if (await onClientMailReply(ctx, event.companyId, mail)) return;
    await onSupportMail(ctx, event.companyId, mail, (companyId, m) => matchContact(ctx, companyId, m));
  } catch (error) {
    ctx.logger.info("CRM care mail handling failed", { messageId: mail.messageId, error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// The Cockpit
// ---------------------------------------------------------------------------

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("CRM cockpit care part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

/** Health checks the care features add to the CRM snapshot. */
export async function careHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const add = async (label: string, run: () => Promise<HealthCheck | HealthCheck[] | null>) => {
    const result = await part(ctx, label, run, null as HealthCheck | HealthCheck[] | null);
    if (Array.isArray(result)) checks.push(...result);
    else if (result) checks.push(result);
  };
  await add("support", () => supportHealth(ctx, companyId));
  await add("client actions", () => clientActionsHealth(ctx, companyId));
  await add("sites", () => siteMonitorHealth(ctx, companyId));
  await add("customer health", () => clientsAtRiskHealth(ctx, companyId));
  await add("reports", () => reportsHealth(ctx, companyId));
  await add("privacy", () => privacyHealth(ctx, companyId));
  await add("e-sign", () => esignHealth(ctx, companyId));
  return checks;
}

/** What waits on a person or a read: client answers nobody has read yet. */
export async function careWaiting(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  return part(ctx, "waiting", async () => repliedActionItems(await listActionsByStatus(ctx, companyId, "replied")), [] as WaitingItem[]);
}
