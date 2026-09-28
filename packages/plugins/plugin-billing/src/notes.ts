/**
 * Follow-up notes: what an agent did or decided about an invoice, quote, bill
 * or won deal that leaves no other trace in Billing (a reply drafted in the
 * Mailbox, what the owner decided, a promise to pay, "this email is not a
 * bill"). Internal only: never printed on a document or emailed.
 *
 * The done checks count a note made since their issue was opened as the work
 * being handled (`donechecks.ts`).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { iso } from "./balances.js";
import { table } from "./db.js";
import { BillingError } from "./domain.js";
import { requireOwnInvoice, requireQuote } from "./invoices.js";
import { WORK_ORIGINS } from "./origins.js";
import { getBill } from "./settle.js";
import { actorLabel, optionalString, requiredCompany, requiredString } from "./util.js";

export const FOLLOW_UP_SUBJECTS = ["invoice", "quote", "bill", "deal"] as const;
export type FollowUpSubject = (typeof FOLLOW_UP_SUBJECTS)[number];

const PARAM: Record<FollowUpSubject, string> = { invoice: "invoiceId", quote: "quoteId", bill: "billId", deal: "dealId" };

export interface FollowUpNote {
  id: string;
  note: string;
  mailDraftId: string | null;
  by: string | null;
  at: string | null;
}

/** The one subject a call names: exactly one of invoiceId, quoteId, billId, dealId. */
export function followUpSubject(params: Record<string, unknown>): { kind: FollowUpSubject; id: string } {
  const given = FOLLOW_UP_SUBJECTS.filter((kind) => typeof params[PARAM[kind]] === "string" && String(params[PARAM[kind]]).trim());
  if (given.length !== 1) throw new BillingError("Pass exactly one of invoiceId, quoteId, billId or dealId");
  const kind = given[0]!;
  return { kind, id: String(params[PARAM[kind]]).trim() };
}

/** `log-follow-up`: store a note on an invoice, quote, bill or won deal of this company. */
export async function logFollowUp(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const subject = followUpSubject(params);
  const note = requiredString(params, "note").slice(0, 1000);
  const mailDraftId = optionalString(params, "mailDraftId")?.slice(0, 200) ?? null;
  let label: string;
  if (subject.kind === "invoice") label = `invoice ${(await requireOwnInvoice(ctx, companyId, subject.id)).number}`;
  else if (subject.kind === "quote") label = `quote ${(await requireQuote(ctx, companyId, subject.id)).number}`;
  else if (subject.kind === "bill") {
    const bill = await getBill(ctx, subject.id);
    if (!bill || bill.company_id !== companyId) throw new BillingError("Bill was not found");
    label = `the bill from ${bill.supplier_name}`;
  } else {
    // A deal Billing knows: a won-deal issue, or a quote or invoice linked to it.
    const known = await ctx.db.query<{ n: string }>(
      `SELECT ((SELECT count(*) FROM ${table(ctx, "work_issues")} WHERE company_id = $1 AND key = $2)
             + (SELECT count(*) FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND deal_id = $3)
             + (SELECT count(*) FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND deal_id = $3))::text AS n`,
      [companyId, `${WORK_ORIGINS.dealWon}${subject.id}`, subject.id],
    );
    if (Number(known[0]?.n ?? 0) === 0) throw new BillingError(`Billing knows no deal ${subject.id} (no won-deal issue, quote or invoice for it). Use the CRM deal id from the Deal won issue.`);
    label = `deal ${subject.id}`;
  }
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "follow_ups")} (id, company_id, subject_kind, subject_id, note, mail_draft_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, subject.kind, subject.id, note, mailDraftId, actorLabel(context)],
  );
  return {
    logged: true,
    id,
    subject: `${subject.kind}:${subject.id}`,
    on: label,
    note,
    mailDraftId,
    next: "Logged. If this was the last thing an issue asked for, mark that issue done.",
  };
}

/** The latest notes on one subject, newest first (for the detail tools). */
export async function followUpsFor(ctx: PluginContext, companyId: string, kind: FollowUpSubject, id: string, limit = 10): Promise<FollowUpNote[]> {
  const rows = await ctx.db.query<{ id: string; note: string; mail_draft_id: string | null; created_by: string | null; created_at: unknown }>(
    `SELECT id, note, mail_draft_id, created_by, created_at FROM ${table(ctx, "follow_ups")}
      WHERE company_id = $1 AND subject_kind = $2 AND subject_id = $3 ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 50))}`,
    [companyId, kind, id],
  );
  return rows.map((row) => ({ id: row.id, note: row.note, mailDraftId: row.mail_draft_id, by: row.created_by, at: iso(row.created_at) }));
}

/** Which of these subjects have a note made at or after `since` (ISO). */
export async function notedSince(ctx: PluginContext, companyId: string, kind: FollowUpSubject, ids: string[], since: string | null): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ctx.db.query<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM ${table(ctx, "follow_ups")}
      WHERE company_id = $1 AND subject_kind = $2 AND subject_id IN (SELECT jsonb_array_elements_text($3::jsonb)) AND created_at >= $4::timestamptz`,
    [companyId, kind, JSON.stringify(ids), since ?? "epoch"],
  );
  return new Set(rows.map((row) => row.subject_id));
}
