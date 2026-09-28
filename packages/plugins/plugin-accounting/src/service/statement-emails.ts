/**
 * Bank statement emails from the Mailbox and what became of each one: the
 * "Statements to import" stage in the Cockpit and the done-check of the
 * "Bank statement received" issue both read this.
 *
 * - `received`: the email arrived and its issue opened (nothing imported yet);
 * - `imported`: `import-statement` with its `messageId` added lines;
 * - `duplicate`: its statement was imported before (same file, or every line
 *   already in the books), or someone said so with `mark-statement-email`;
 * - `not_statement`: the email holds no statement (`mark-statement-email`);
 * - `closed`: a person closed or cancelled its issue without an import linked
 *   to the email (their call; an agent's close is checked instead).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MailReceived } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { AccountingError } from "../domain/util.js";
import { actorRecord, errorMessage, withLock, type Actor } from "./common.js";

export const STATEMENT_EMAIL_OUTCOMES = ["duplicate", "not_statement"] as const;
export type StatementEmailOutcome = (typeof STATEMENT_EMAIL_OUTCOMES)[number];

/** The email that opened a "Bank statement received" issue. Never throws: the issue matters more than the row. */
export async function recordStatementEmail(ctx: PluginContext, companyId: string, mail: MailReceived, issueId: string | null): Promise<void> {
  try {
    const from = mail.from?.name ? `${mail.from.name} <${mail.from.email}>` : mail.from?.email ?? "";
    const receivedAt = typeof mail.receivedAt === "string" && !Number.isNaN(Date.parse(mail.receivedAt)) ? mail.receivedAt : null;
    await db.insertStatementEmail(ctx.db, companyId, { messageId: mail.messageId, subject: mail.subject ?? "", sender: from, receivedAt, issueId });
  } catch (error) {
    ctx.logger.warn("Could not record the statement email", { companyId, messageId: mail.messageId, error: errorMessage(error) });
  }
}

/**
 * `import-statement` with a `messageId`: link the statement to its email.
 * Lines added → imported; nothing new (the same file, or every line already
 * in the books) → duplicate, unless an earlier file from the same email
 * already added lines.
 */
export async function linkImportToEmail(ctx: PluginContext, companyId: string, messageId: string, statementId: string | null, added: number, actor: Actor): Promise<db.StatementEmailStatus> {
  return withLock(`statement-email:${companyId}:${messageId}`, async () => {
    const row = await db.getStatementEmail(ctx.db, companyId, messageId);
    const ids = [...new Set([...(row?.statementIds ?? []), ...(statementId ? [statementId] : [])])];
    const status: Exclude<db.StatementEmailStatus, "received"> = added > 0 || row?.status === "imported" ? "imported" : "duplicate";
    const note = status === "duplicate" ? "Its statement was already imported, so nothing new was added." : null;
    await db.saveStatementEmailOutcome(ctx.db, companyId, messageId, { status, statementIds: ids, note, resolvedBy: actorRecord(actor) });
    return status;
  });
}

/**
 * A person closed (or cancelled) a "Bank statement received" issue while its
 * email still waits: their decision stands, so the email no longer counts as
 * a statement to import. Returns true when the email changed.
 */
export async function closeStatementEmailByPerson(ctx: PluginContext, companyId: string, messageId: string, issueStatus: "done" | "cancelled", userId: string | null): Promise<boolean> {
  return withLock(`statement-email:${companyId}:${messageId}`, async () => {
    const row = await db.getStatementEmail(ctx.db, companyId, messageId);
    if (!row || row.status !== "received") return false;
    await db.saveStatementEmailOutcome(ctx.db, companyId, messageId, {
      status: "closed",
      statementIds: row.statementIds,
      note: issueStatus === "done" ? "A person closed its issue." : "A person cancelled its issue.",
      resolvedBy: { kind: "user", userId },
    });
    return true;
  });
}

/** The `mark-statement-email` tool: the email holds no statement, or its statement was already imported. */
export async function markStatementEmail(ctx: PluginContext, companyId: string, actor: Actor, input: { messageId?: unknown; outcome?: unknown; reason?: unknown }) {
  const messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
  if (!messageId) throw new AccountingError("messageId is required: the message id on the \"Bank statement received\" issue");
  const outcome = String(input.outcome ?? "");
  if (!(STATEMENT_EMAIL_OUTCOMES as readonly string[]).includes(outcome)) throw new AccountingError("outcome must be duplicate or not_statement");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (reason.length < 5) throw new AccountingError("Say why in reason, e.g. \"Only a marketing email from the bank\" or \"Same statement as the one imported on 3 Oct\"");
  return withLock(`statement-email:${companyId}:${messageId}`, async () => {
    const row = await db.getStatementEmail(ctx.db, companyId, messageId);
    if (row?.status === "imported") {
      return { messageId, status: row.status, statementIds: row.statementIds, next: "Its lines are already imported, so it stays imported. Close the statement issue with the import result." };
    }
    await db.saveStatementEmailOutcome(ctx.db, companyId, messageId, { status: outcome as StatementEmailOutcome, statementIds: row?.statementIds ?? [], note: reason, resolvedBy: actorRecord(actor) });
    return {
      messageId,
      status: outcome,
      statementIds: row?.statementIds ?? [],
      next: row ? "Recorded. Close the statement issue with this reason." : "Recorded (this message was not on a statement issue). Close the issue you are working on with this reason.",
    };
  });
}
