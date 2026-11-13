/**
 * The Mailbox's answer for a newsletter confirmation mail (keys `crm:nl:<capture key>`; plan PAR-10817 "Send result"), and the
 * `redeliver-mail` step that removes a confirmation mail the outbox gave up on. The CRM outbox row holds the address and the link,
 * so it goes as soon as the send settles: it is never kept as a record of the send (the Mailbox keeps that).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { outboxStatus, type MailSendResult } from "@partnersinbiz/pib-plugin-kit";
import { asRecord, noteOutboxError, table } from "./db.js";
import { bumpSource, failCapture } from "./lead-store.js";
import { PLUGIN_ID } from "./namespace.js";
import { SIGNUP_MAIL_PREFIX } from "./newsletter-signup.js";

/** The Mailbox lists the recipients it left out because they are on the do-not-email list. */
type SignupMailResult = MailSendResult & { suppressed?: unknown };

function asSignupResult(payload: unknown): SignupMailResult | null {
  const body = asRecord(payload);
  if (typeof body.key !== "string" || !body.key.startsWith(SIGNUP_MAIL_PREFIX)) return null;
  const context = asRecord(body.context);
  if (context.plugin !== undefined && context.plugin !== PLUGIN_ID) return null;
  if (body.status !== "sent" && body.status !== "failed") return null;
  return body as unknown as SignupMailResult;
}

export async function onNewsletterSendResult(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const result = asSignupResult(event.payload);
  if (!result) return;
  try {
    await handleNewsletterSendResult(ctx, result, event.companyId);
  } catch (error) {
    // The outbox row stays pending, so the redeliver job asks again and the Mailbox answers again.
    ctx.logger.error("CRM newsletter confirmation result failed", { key: result.key, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Sent: the outbox row goes. Failed for good, or every recipient suppressed (a confirmation mail has one): the signup is marked
 * `confirmation_failed`, one rejection is counted on its source, and the outbox row goes. A failure that a retry may fix changes
 * nothing but the row's last error. A repeated answer finds nothing left to mark, so it counts nothing twice.
 */
export async function handleNewsletterSendResult(ctx: PluginContext, result: SignupMailResult, companyId: string): Promise<"sent" | "failed" | "retrying" | "ignored"> {
  const row = await outboxStatus(ctx, result.key);
  // One company's answer never settles another company's mail.
  if (row && row.company_id !== companyId) return "ignored";
  const suppressed = Array.isArray(result.suppressed) && result.suppressed.length > 0;
  if (result.status === "failed" && !result.permanent && !suppressed) {
    if (row) await noteOutboxError(ctx, result.key, result.error ?? "Send failed; will retry");
    return "retrying";
  }
  if (result.status === "sent") {
    await deleteSignupMail(ctx, companyId, result.key);
    return row ? "sent" : "ignored";
  }
  // Marked before the row goes: should this fail, the row stays pending and the next answer repeats the whole step.
  const failed = await failCapture(ctx, companyId, result.key.slice(SIGNUP_MAIL_PREFIX.length));
  if (failed) await bumpSource(ctx, failed.sourceId, false);
  await deleteSignupMail(ctx, companyId, result.key);
  return failed || row ? "failed" : "ignored";
}

async function deleteSignupMail(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "outbox")} WHERE company_id = $1 AND key = $2`, [companyId, key]);
}

/**
 * Step of the `redeliver-mail` job: a confirmation mail the outbox gave up on (no answer came) is deleted with the address and link
 * it holds. Pending rows, and rows of every other key, are left alone.
 */
export async function purgeSettledSignupMails(ctx: PluginContext): Promise<number> {
  const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "outbox")} WHERE key LIKE $1 AND status <> 'pending'`, [`${SIGNUP_MAIL_PREFIX}%`]);
  return res.rowCount ?? 0;
}
