/**
 * Scheduled work that loops over companies (jobs have no company scope).
 */
import { configSaved, isModuleEnabled, publishSetupStatus, tryLinkPendingHire } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { CLERK_ROLE, type clerkOnLinked } from "../hire.js";
import { PLUGIN_ID } from "../namespace.js";
import { errorMessage, type Env } from "./env.js";
import { generatePayslips, queuePayslipEmails } from "./payslips.js";
import { publishCockpit } from "./cockpit.js";
import { requireRun } from "./runs.js";
import { setupStatus } from "./setup.js";
import { payrollTriggers } from "./triggers.js";

/**
 * Job: payslips a locked run is still missing (emailed too when "Email
 * payslips when a run is locked" is on), pending clerk hires, the monthly
 * "Prepare pay run" and "EMP201 due" issues, and the hourly setup status
 * and Cockpit snapshot. Jobs have no company scope. Companies that switched
 * Payroll off in Setup get no new automatic work.
 */
export async function followUp(e: Env, onLinked: ReturnType<typeof clerkOnLinked>, published: Map<string, number> = setupPublished, cockpitPushed?: Map<string, number>) {
  const { ctx } = e;
  const enabled = new Map<string, boolean>();
  const isOn = async (companyId: string) => {
    if (!enabled.has(companyId)) enabled.set(companyId, await isModuleEnabled(ctx, companyId, PLUGIN_ID));
    return enabled.get(companyId)!;
  };
  for (const run of await db.runsNeedingFollowUp(ctx)) {
    if (!(await configSaved(ctx, run.companyId)) || !(await isOn(run.companyId))) continue;
    try {
      const made = await generatePayslips(e, run.companyId, run.id);
      await emailMadePayslips(e, run.companyId, run.id, made);
    } catch (error) {
      ctx.logger.info("Payslip follow-up failed", { runId: run.id, error: errorMessage(error) });
    }
  }
  for (const companyId of await payrollCompanies(e)) {
    if (!(await configSaved(ctx, companyId)) || !(await isOn(companyId))) continue;
    await tryLinkPendingHire(ctx, companyId, CLERK_ROLE, onLinked).catch(() => null);
    await payrollTriggers(e, companyId);
    await publishStatus(e, companyId, published);
    await publishCockpit(e, companyId, cockpitPushed);
  }
}

/**
 * Payslips this job just made are emailed like the ones made at lock time,
 * when "Email payslips when a run is locked" is on. Only ready payslips
 * (never re-sends one already sent).
 */
export async function emailMadePayslips(e: Env, companyId: string, runId: string, made: { created: number; skipped: string | null }): Promise<number> {
  if (!made.created || made.skipped) return 0;
  const config = await e.config(companyId);
  if (!config.payslipEmail.sendOnLock) return 0;
  const ready = (await db.listPayslips(e.ctx, companyId, runId)).filter((p) => p.status === "ready").map((p) => p.id);
  if (!ready.length) return 0;
  const run = await requireRun(e, companyId, runId);
  return (await queuePayslipEmails(e, companyId, run, ready)).queued;
}

const SETUP_PUBLISH_EVERY_MS = 60 * 60 * 1000;
const setupPublished = new Map<string, number>();

/** Pushes the setup checklist to the Setup plugin, at most hourly per company. Never throws. */
async function publishStatus(e: Env, companyId: string, published: Map<string, number>) {
  const now = e.now().getTime();
  const last = published.get(companyId);
  if (last !== undefined && now - last < SETUP_PUBLISH_EVERY_MS) return;
  published.set(companyId, now);
  try {
    await publishSetupStatus(e.ctx, companyId, await setupStatus(e, companyId));
  } catch (error) {
    e.ctx.logger.info("Payroll setup status failed", { companyId, error: errorMessage(error) });
  }
}

/** Companies with payroll rows, plus companies that saved the Payroll settings but have none yet. */
async function payrollCompanies(e: Env): Promise<string[]> {
  const { ctx } = e;
  const ids = new Set<string>();
  for (const load of [db.companiesWithRuns, db.companiesWithEmployees]) {
    try {
      for (const id of await load(ctx)) ids.add(id);
    } catch (error) {
      ctx.logger.info("Payroll company list failed", { error: errorMessage(error) });
    }
  }
  try {
    for (const company of await ctx.companies.list({ limit: 100 })) {
      if (!ids.has(company.id) && (await configSaved(ctx, company.id))) ids.add(company.id);
    }
  } catch (error) {
    ctx.logger.info("Payroll company list unavailable", { error: errorMessage(error) });
  }
  return [...ids];
}
