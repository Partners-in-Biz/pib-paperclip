/**
 * Payslips: rendered to PDF for every employee in a locked run, stored in
 * the private bucket, emailed through the Mailbox plugin (outbox event
 * `mail.send.requested` with a 7-day presigned attachment link) and
 * downloadable by board members through a short-lived link.
 */
import { enqueue, MAIL_EVENTS, PIB_PLUGINS, settleOutbox, type MailSendRequested, type MailSendResult } from "@partnersinbiz/pib-plugin-kit";
import { createHash } from "node:crypto";
import { fillTemplate } from "../config.js";
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { leaveBalances } from "../leave.js";
import { PayrollError } from "../money.js";
import { PLUGIN_ID } from "../namespace.js";
import { renderPayslip, type PayslipData } from "../payslip.js";
import { taxYearBounds } from "../rules.js";
import { documentKey, DOWNLOAD_LINK_SECONDS, MAIL_LINK_SECONDS, presignGet, putPrivate } from "../storage.js";
import { errorMessage, reqStr, requireUser, type Env } from "./env.js";
import { requireRun } from "./runs.js";

export function payslipNumber(run: db.PayRun, employeeNumber: string): string {
  return `${run.number}-${employeeNumber}`;
}

/** Year-to-date sums per line code and totals, from locked runs in the tax year up to `payDate`, plus the cut-over opening. */
export function ytdFor(items: db.PostedItem[], opening: db.YtdRow | null) {
  const byCode: Record<string, number> = {};
  const ytd = { grossMinor: 0, taxableMinor: 0, payeMinor: 0, uifEmployeeMinor: 0, netMinor: 0 };
  for (const item of items) {
    for (const line of item.result?.lines ?? []) byCode[line.code] = (byCode[line.code] ?? 0) + line.amountMinor;
    ytd.grossMinor += item.grossMinor;
    ytd.taxableMinor += item.taxableMinor;
    ytd.payeMinor += item.payeMinor;
    ytd.uifEmployeeMinor += item.uifEmployeeMinor;
    ytd.netMinor += item.netMinor;
  }
  if (opening) {
    ytd.grossMinor += opening.grossMinor;
    ytd.payeMinor += opening.payeMinor;
    ytd.taxableMinor += opening.codes["3699"] ?? opening.grossMinor;
    byCode.PAYE = (byCode.PAYE ?? 0) + opening.payeMinor;
  }
  return { byCode, ytd };
}

/** Renders and stores the payslips a locked run is missing. Returns how many were made. */
export async function generatePayslips(env: Env, companyId: string, runId: string): Promise<{ created: number; skipped: string | null }> {
  const { ctx } = env;
  const run = await requireRun(env, companyId, runId);
  if (run.kind === "reversal") return { created: 0, skipped: "Reversal runs have no payslips" };
  if (run.status !== "locked" && run.status !== "reversed") throw new PayrollError("Payslips are made when the pay run is locked");
  const config = await env.config(companyId);
  if (!config.r2Configured) return { created: 0, skipped: "Private storage is not set up in the Payroll settings, so payslips cannot be stored yet." };
  const r2 = await config.r2();
  const items = (await db.listItems(ctx, companyId, run.id)).filter((i) => i.status === "ok");
  const existing = new Map((await db.listPayslips(ctx, companyId, run.id)).map((p) => [p.employeeId, p]));
  const { startDate } = taxYearBounds(run.taxYear);
  const [posted, openings, leave, leaveOpenings, terms] = await Promise.all([
    db.postedItems(ctx, companyId, startDate, run.payDate),
    db.listYtd(ctx, companyId, run.taxYear),
    db.listLeave(ctx, companyId),
    db.listLeaveOpenings(ctx, companyId),
    db.termsOn(ctx, companyId, run.periodEnd),
  ]);
  let created = 0;
  for (const item of items) {
    const current = existing.get(item.employeeId);
    if (current && current.status !== "pending" && current.status !== "failed") continue;
    const id = current?.id ?? db.newId("slip");
    const number = payslipNumber(run, item.snapshot.employeeNumber);
    try {
      const employee = await db.getEmployee(ctx, companyId, item.employeeId);
      if (!employee || !item.result) throw new PayrollError("The employee or the calculation is missing");
      const mine = posted.filter((p) => p.employeeId === item.employeeId);
      const { byCode, ytd } = ytdFor(mine, openings.find((o) => o.employeeId === item.employeeId) ?? null);
      const t = terms.get(item.employeeId);
      const balances = leaveBalances({
        employmentStart: employee.startDate,
        asOf: run.periodEnd,
        daysPerWeek: t?.daysPerWeek ?? 5,
        annualDaysPerYear: t?.annualLeaveDays ?? null,
        requests: leave.filter((l) => l.employeeId === employee.id),
        openings: leaveOpenings.filter((o) => o.employeeId === employee.id),
      });
      const data: PayslipData = {
        number,
        employer: { legalName: config.employer.legalName || config.employer.tradingName, address: config.employer.address, payeReference: config.employer.payeReference },
        employee: {
          name: employee.name,
          employeeNumber: employee.employeeNumber,
          jobTitle: employee.jobTitle,
          taxReferenceMask: employee.masks.taxReference,
          bankName: employee.masks.bankName,
          accountMask: employee.masks.accountNumber,
        },
        run: { number: run.number, periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate, taxYear: run.taxYear, kind: run.kind },
        lines: item.result.lines,
        totals: item.result.totals,
        ytdByCode: byCode,
        ytd,
        leave: balances,
      };
      const pdf = await renderPayslip(data);
      const key = documentKey(r2, companyId, "payslips", id, `${number}.pdf`, run.payDate.slice(0, 7));
      await putPrivate(r2, key, pdf, "application/pdf");
      await db.upsertPayslip(ctx, companyId, {
        id, runId: run.id, employeeId: item.employeeId, number, status: "ready", r2Key: key, bytes: pdf.byteLength,
        sha256: createHash("sha256").update(pdf).digest("hex"), mailKey: null, emailedTo: null, emailedAt: null, error: null, createdAt: null,
      });
      created += 1;
    } catch (error) {
      await db.upsertPayslip(ctx, companyId, {
        id, runId: run.id, employeeId: item.employeeId, number, status: "failed", r2Key: null, bytes: 0, sha256: null,
        mailKey: null, emailedTo: null, emailedAt: null, error: errorMessage(error).slice(0, 500), createdAt: null,
      });
      ctx.logger.error("Payslip failed", { runId: run.id, employeeId: item.employeeId, error: errorMessage(error) });
    }
  }
  return { created, skipped: null };
}

/** Queues payslip emails through the Mailbox. Only ready payslips of employees with an email address. */
export async function emailPayslips(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person must send payslips");
  requireUser(actor);
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  return queuePayslipEmails(env, companyId, run, Array.isArray(params.payslipIds) ? params.payslipIds.map(String) : null);
}

export async function queuePayslipEmails(env: Env, companyId: string, run: db.PayRun, only: string[] | null) {
  const { ctx } = env;
  const config = await env.config(companyId);
  if (!config.r2Configured) throw new PayrollError("Set up private storage in the Payroll settings first");
  const r2 = await config.r2();
  const payslips = (await db.listPayslips(ctx, companyId, run.id)).filter((p) => (!only || only.includes(p.id)) && (p.status === "ready" || p.status === "failed" || (only && p.status === "sent")));
  const queued: string[] = [];
  const skipped: Array<{ payslip: string; reason: string }> = [];
  for (const slip of payslips) {
    if (!slip.r2Key) {
      skipped.push({ payslip: slip.number, reason: "not rendered yet" });
      continue;
    }
    const employee = await db.getEmployee(ctx, companyId, slip.employeeId);
    if (!employee?.email) {
      skipped.push({ payslip: slip.number, reason: "no email address" });
      continue;
    }
    const period = `${run.periodStart} to ${run.periodEnd}`;
    const values = { firstName: employee.firstName, employer: config.employer.tradingName || config.employer.legalName || "your employer", period, payDate: run.payDate };
    const body = fillTemplate(config.payslipEmail.body, values);
    const key = `payroll:payslip:${slip.id}:${Date.now()}`;
    // Claim the payslip first so a double click cannot send it twice.
    const claimed = await db.claimPayslip(ctx, companyId, slip.id, only ? ["ready", "failed", "sent"] : ["ready", "failed"], key, employee.email);
    if (!claimed) {
      skipped.push({ payslip: slip.number, reason: "already being sent" });
      continue;
    }
    const request: MailSendRequested = {
      key,
      from: config.payslipEmail.from,
      to: [{ email: employee.email, name: employee.name }],
      subject: fillTemplate(config.payslipEmail.subject, values),
      text: body,
      html: body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join(""),
      attachments: [{ url: presignGet(r2, slip.r2Key, MAIL_LINK_SECONDS, `${slip.number}.pdf`), filename: `${slip.number}.pdf`, mime: "application/pdf", bytes: slip.bytes }],
      context: { plugin: PLUGIN_ID, kind: "payslip", id: slip.id },
      labels: ["PiB/Payroll"],
    };
    await enqueue(ctx, companyId, MAIL_EVENTS.sendRequested, request as unknown as { key: string } & Record<string, unknown>);
    queued.push(slip.number);
  }
  return { runId: run.id, queued: queued.length, skipped };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `plugin.partnersinbiz.mailbox.mail.send.result` for one of our payslips. */
export async function onMailResult(env: Env, companyId: string, payload: unknown): Promise<void> {
  const result = payload as Partial<MailSendResult> | null;
  if (!result || typeof result.key !== "string" || result.context?.plugin !== PLUGIN_ID || result.context.kind !== "payslip") return;
  const sent = result.status === "sent";
  await settleOutbox(env.ctx, result.key, result as Record<string, unknown>, sent ? "done" : "failed");
  const slip = await db.getPayslipByMailKey(env.ctx, result.key);
  if (!slip || slip.companyId !== companyId) return;
  await db.updatePayslip(env.ctx, companyId, slip.id, sent
    ? { status: "sent", emailed_at: result.sentAt ?? new Date().toISOString(), error: null }
    : { status: "failed", error: (result.error ?? "The Mailbox could not send it").slice(0, 500) });
}

/** Board download: a 15-minute link to the stored PDF. */
export async function payslipDownload(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const slip = await db.getPayslip(env.ctx, companyId, reqStr(params, "payslipId", 64));
  if (!slip) throw new PayrollError("Payslip not found");
  if (!slip.r2Key) throw new PayrollError(slip.error ?? "The payslip has not been made yet");
  const r2 = await (await env.config(companyId)).r2();
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "payslip.downloaded", "payslip", slip.id, {});
  return { url: presignGet(r2, slip.r2Key, DOWNLOAD_LINK_SECONDS, `${slip.number}.pdf`), fileName: `${slip.number}.pdf`, expiresInSeconds: DOWNLOAD_LINK_SECONDS };
}

export const MAILBOX_RESULT_EVENT = `plugin.${PIB_PLUGINS.mailbox}.${MAIL_EVENTS.sendResult}` as const;
