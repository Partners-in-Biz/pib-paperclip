/**
 * Receiving side of the cross-plugin contracts (kit contracts.ts):
 * - `ledger.post.requested` from Billing / Payroll → post (or reverse) →
 *   `ledger.post.result`. Handled once per key with the kit `receiveOnce`;
 *   when the company switched Accounting off in Setup, the request is
 *   refused ("Accounting is switched off for this company") and nothing is
 *   stored, so the sender's retry after switching it back on posts it;
 *   a repeat delivery re-emits the stored result. A rejected posting is
 *   stored too, but a later delivery of the same key runs again, so fixing
 *   the cause (map the role, reopen the period) and retrying works.
 * - Rejections open ONE issue per company ("Accounting: postings were
 *   rejected"); later ones are added to it as comments.
 * - `open-item.upserted` keeps the receivable/payable projection (last
 *   updatedAt wins).
 * - `bank.match.result` settles the outbox entry for a bank match.
 * - `mail.received` with category bank_statement opens a "statement
 *   received" issue.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  createWorkIssue,
  isModuleEnabled,
  LEDGER_EVENTS,
  receiveOnce,
  settleOutbox,
  type BankMatchResult,
  type LedgerPostRequested,
  type LedgerPostResult,
  type MailReceived,
  type OpenItemUpserted,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { AccountingError, isIsoDate } from "../domain/util.js";
import { PLUGIN_ID } from "../namespace.js";
import { ensureBook } from "./books.js";
import { closeIssue, commentOn, errorMessage, issueStatus, ORIGIN, withLock } from "./common.js";
import { postJournal, reverseJournal } from "./journals.js";

const REJECTION_TITLE = "Accounting: postings were rejected";
export const MODULE_OFF_ERROR = "Accounting is switched off for this company";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function inboxKeyForPosting(key: string): string {
  return `ledger:${key}`;
}

/** The plugin that sent an event, from its type `plugin.<key>.<name>`. */
export function senderOf(eventType: string, name: string): string {
  const prefix = "plugin.";
  const suffix = `.${name}`;
  return eventType.startsWith(prefix) && eventType.endsWith(suffix) ? eventType.slice(prefix.length, eventType.length - suffix.length) : "";
}

/**
 * Post one requested journal. Returns the result that is stored and emitted.
 * Validation problems become `rejected` results; infrastructure errors throw
 * (nothing is stored, so the sender's retry runs it again).
 */
export async function postRequested(ctx: PluginContext, companyId: string, sender: string, req: LedgerPostRequested): Promise<LedgerPostResult> {
  const source = {
    plugin: sender || String(req.source?.plugin ?? ""),
    kind: String(req.source?.kind ?? "event"),
    id: String(req.source?.id ?? req.key),
  };
  try {
    if (!isIsoDate(req.date)) throw new AccountingError("date must be YYYY-MM-DD");
    if (req.reverseKey) {
      const original = await db.journalBySourceKey(ctx.db, companyId, req.reverseKey);
      if (!original) throw new AccountingError(`Nothing was posted under ${req.reverseKey}, so there is nothing to reverse yet.`, "not_found");
      const { journal } = await reverseJournal(ctx, companyId, original.id, {
        date: req.date,
        memo: req.memo || null,
        sourceKey: req.key,
        source,
        postedBy: { kind: "plugin", plugin: source.plugin },
      });
      return { key: req.key, status: "posted", journalId: journal.id, journalNumber: journal.number, error: null, source: req.source };
    }
    const { journal } = await postJournal(ctx, companyId, {
      sourceKey: req.key,
      source,
      kind: "event",
      date: req.date,
      memo: req.memo ?? "",
      currency: req.currency,
      fxRate: req.fxRate ?? null,
      lines: req.lines,
      postedBy: { kind: "plugin", plugin: source.plugin },
    });
    return { key: req.key, status: "posted", journalId: journal.id, journalNumber: journal.number, error: null, source: req.source };
  } catch (error) {
    if (!(error instanceof AccountingError)) throw error;
    return { key: req.key, status: "rejected", journalId: null, journalNumber: null, error: error.message, source: req.source };
  }
}

/** Event handler body for `plugin.<sender>.ledger.post.requested`. */
export async function receivePostRequest(ctx: PluginContext, companyId: string, eventType: string, payload: unknown): Promise<LedgerPostResult | null> {
  if (!isObject(payload) || typeof payload.key !== "string" || !payload.key) {
    ctx.logger.warn("Ledger posting without a key ignored", { eventType });
    return null;
  }
  const req = payload as unknown as LedgerPostRequested;
  const sender = senderOf(eventType, LEDGER_EVENTS.postRequested);
  const inboxKey = inboxKeyForPosting(req.key);
  if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) {
    // Switched off in Setup: refuse without touching the inbox, the rejection
    // list or issues. The sender marks its outbox row failed; after the module
    // is switched back on, its retry (retryOutbox, same key) posts normally.
    // A key that was already posted still gets its stored answer.
    const earlier = (await db.inboxResult(ctx.db, inboxKey)) as unknown as LedgerPostResult | null;
    if (earlier?.status === "posted") {
      await emitResult(ctx, companyId, earlier);
      return earlier;
    }
    const off: LedgerPostResult = { key: req.key, status: "rejected", journalId: null, journalNumber: null, error: MODULE_OFF_ERROR, source: req.source };
    await emitResult(ctx, companyId, off);
    return off;
  }
  await ensureBook(ctx, companyId);
  // A stored rejection is not final: run it again on redelivery.
  const stored = await db.inboxResult(ctx.db, inboxKey);
  if (stored && stored.status === "rejected") await db.deleteInbox(ctx.db, inboxKey);
  const { result } = await receiveOnce(ctx, companyId, eventType, inboxKey, async () => {
    const r = await postRequested(ctx, companyId, sender, req);
    return r as unknown as Record<string, unknown>;
  });
  const out = result as unknown as LedgerPostResult;
  if (out.status === "rejected") {
    await noteRejection(ctx, companyId, { key: req.key, event: eventType, source: req.source, payload: req, error: out.error ?? "Rejected" });
  } else {
    await resolveIfRejected(ctx, companyId, req.key, out.journalId ?? null);
  }
  await emitResult(ctx, companyId, out);
  return out;
}

async function emitResult(ctx: PluginContext, companyId: string, out: LedgerPostResult): Promise<void> {
  try {
    await ctx.events.emit(LEDGER_EVENTS.postResult, companyId, out as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("ledger.post.result emit failed (the sender will retry)", { key: out.key, error: errorMessage(error) });
  }
}

/** Record a rejection and keep ONE open issue for a person to fix them. */
export async function noteRejection(ctx: PluginContext, companyId: string, r: { key: string; event: string; source: unknown; payload: unknown; error: string }): Promise<void> {
  await withLock(`rejections:${companyId}`, async () => {
    const isNew = await db.upsertRejection(ctx.db, companyId, r);
    if (!isNew) return;
    const book = await ensureBook(ctx, companyId);
    const status = await issueStatus(ctx, companyId, book.rejectionIssueId);
    const line = `- \`${r.key}\` (${(r.source as { plugin?: string } | null)?.plugin ?? "plugin"}): ${r.error}`;
    if (book.rejectionIssueId && status && status !== "done" && status !== "cancelled") {
      await commentOn(ctx, companyId, book.rejectionIssueId, `Another posting was rejected:\n\n${line}`);
      return;
    }
    try {
      const issue = await createWorkIssue(ctx, {
        companyId,
        title: REJECTION_TITLE,
        description: [
          "Accounting refused one or more journals that another plugin asked it to post, so the books are missing them until someone fixes the cause.",
          "",
          line,
          "",
          "Common fixes: map the missing role (Accounting → Chart & roles), reopen a closed period, or correct the document in Billing / Payroll.",
          "Then open **Accounting → Journals → Rejected** and click **Retry**. This issue closes itself when nothing is left to fix.",
        ].join("\n"),
        priority: "high",
        originKind: ORIGIN,
        originId: "rejections",
        wake: false,
      });
      await db.setRejectionIssue(ctx.db, companyId, issue.id);
    } catch (error) {
      ctx.logger.warn("Could not open the rejected-postings issue", { companyId, error: errorMessage(error) });
    }
  });
}

async function resolveIfRejected(ctx: PluginContext, companyId: string, key: string, journalId: string | null): Promise<void> {
  const rejection = await db.getRejection(ctx.db, companyId, key);
  if (!rejection || rejection.status !== "open") return;
  await db.resolveRejection(ctx.db, companyId, key, "resolved", journalId);
  await closeRejectionIssueWhenClear(ctx, companyId);
}

export async function closeRejectionIssueWhenClear(ctx: PluginContext, companyId: string): Promise<void> {
  const open = await db.listRejections(ctx.db, companyId, "open");
  if (open.length > 0) return;
  const book = await db.getBook(ctx.db, companyId);
  if (!book?.rejectionIssueId) return;
  await closeIssue(ctx, companyId, book.rejectionIssueId, "done", "Every rejected posting has been posted or dismissed.");
  await db.setRejectionIssue(ctx.db, companyId, null);
}

/** "Retry" from the page: post the stored request again and re-send the result. */
export async function retryRejection(ctx: PluginContext, companyId: string, key: string): Promise<LedgerPostResult> {
  const rejection = await db.getRejection(ctx.db, companyId, key);
  if (!rejection) throw new AccountingError("Rejected posting not found", "not_found");
  await db.deleteInbox(ctx.db, inboxKeyForPosting(key));
  const result = await receivePostRequest(ctx, companyId, rejection.event, rejection.payload);
  if (!result) throw new AccountingError("The stored request is not valid");
  if (result.status === "rejected") throw new AccountingError(`Still rejected: ${result.error}`);
  return result;
}

export async function dismissRejection(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  await db.resolveRejection(ctx.db, companyId, key, "dismissed", null);
  await closeRejectionIssueWhenClear(ctx, companyId);
}

// ---------------------------------------------------------------------------
// Open items
// ---------------------------------------------------------------------------

export function parseOpenItem(payload: unknown): OpenItemUpserted {
  if (!isObject(payload)) throw new AccountingError("Open item must be an object");
  const p = payload as Partial<OpenItemUpserted>;
  if (typeof p.key !== "string" || !p.key) throw new AccountingError("Open item needs a key");
  if (p.kind !== "receivable" && p.kind !== "payable") throw new AccountingError("Open item kind must be receivable or payable");
  if (!Number.isSafeInteger(p.totalMinor) || !Number.isSafeInteger(p.outstandingMinor)) throw new AccountingError("Open item amounts must be whole cents");
  if (typeof p.currency !== "string" || !/^[A-Z]{3}$/.test(p.currency)) throw new AccountingError("Open item currency must be a 3-letter code");
  if (typeof p.updatedAt !== "string" || Number.isNaN(Date.parse(p.updatedAt))) throw new AccountingError("Open item needs updatedAt");
  return p as OpenItemUpserted;
}

export async function receiveOpenItem(ctx: PluginContext, companyId: string, sender: string, payload: unknown): Promise<boolean> {
  let item: OpenItemUpserted;
  try {
    item = parseOpenItem(payload);
  } catch (error) {
    ctx.logger.warn("Open item ignored", { error: errorMessage(error) });
    return false;
  }
  return db.upsertOpenItem(ctx.db, companyId, {
    key: item.key,
    kind: item.kind,
    itemId: String(item.id ?? item.key),
    number: String(item.number ?? ""),
    counterpartyName: String(item.counterpartyName ?? ""),
    clientKind: item.clientKind ?? null,
    clientRef: item.clientRef ?? null,
    currency: item.currency,
    totalMinor: item.totalMinor,
    outstandingMinor: item.outstandingMinor,
    issueDate: isIsoDate(item.issueDate) ? item.issueDate : null,
    dueDate: isIsoDate(item.dueDate) ? item.dueDate : null,
    refs: Array.isArray(item.references) ? item.references.map(String).slice(0, 20) : [],
    status: String(item.status ?? ""),
    sourcePlugin: sender,
    updatedAt: item.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Bank match results from Billing
// ---------------------------------------------------------------------------

export async function receiveMatchResult(ctx: PluginContext, companyId: string, payload: unknown): Promise<void> {
  if (!isObject(payload) || typeof payload.key !== "string") return;
  const result = payload as unknown as BankMatchResult;
  const settled = await settleOutbox(ctx, result.key, result as unknown as Record<string, unknown>, result.status === "rejected" ? "failed" : "done");
  if (!settled) return;
  const request = settled.payload as { bankTxId?: string };
  const lineId = request.bankTxId;
  if (!lineId) return;
  const line = await db.getBankLine(ctx.db, companyId, lineId);
  if (!line || line.status !== "matching") return;
  const match = { ...(line.match ?? {}), billing: { status: result.status, paymentId: result.paymentId ?? null, error: result.error ?? null } };
  if (result.status === "rejected") {
    await db.setLineState(ctx.db, companyId, lineId, ["matching"], {
      status: "unreconciled",
      match: null,
      journalId: null,
      note: `Billing refused the match: ${result.error ?? "no reason given"}`,
    });
    return;
  }
  await db.setLineState(ctx.db, companyId, lineId, ["matching"], {
    status: "matching",
    match,
    journalId: null,
    note: result.status === "needs_review" ? "Billing wants a person to check this payment before it posts." : "Billing recorded the payment; waiting for its journal.",
  });
}

// ---------------------------------------------------------------------------
// Statement emails from the Mailbox
// ---------------------------------------------------------------------------

export async function receiveMail(ctx: PluginContext, companyId: string, eventType: string, payload: unknown): Promise<boolean> {
  if (!isObject(payload) || typeof payload.key !== "string") return false;
  const mail = payload as unknown as MailReceived;
  if (mail.triage?.category !== "bank_statement") return false;
  const { repeat } = await receiveOnce(ctx, companyId, eventType, `mail:${mail.key}`, async () => {
    const attachments = (mail.attachments ?? []).map((a) => `- ${a.filename} (${a.mime}, ${Math.round((a.bytes ?? 0) / 1024)} KB)`).join("\n") || "- (no attachments)";
    const issue = await createWorkIssue(ctx, {
      companyId,
      title: `Bank statement received: ${(mail.subject || "(no subject)").slice(0, 120)}`,
      description: [
        `A bank statement arrived in the mailbox from ${mail.from?.name ? `${mail.from.name} <${mail.from.email}>` : mail.from?.email ?? "an unknown sender"} on ${mail.receivedAt}.`,
        "",
        attachments,
        "",
        "Download the CSV, OFX or MT940 file from the email and import it under **Accounting → Bank → Import statement**. PDF statements need a CSV/OFX export from the bank.",
      ].join("\n"),
      originKind: ORIGIN,
      originId: `mail:${mail.messageId}`,
      wake: false,
    });
    return { issueId: issue.id };
  });
  return !repeat;
}
