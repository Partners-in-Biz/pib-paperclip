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
 *   rejected"), for the Bookkeeper (else the Operator or the owner); later
 *   ones are added to it as comments.
 * - `open-item.upserted` keeps the receivable/payable projection (last
 *   updatedAt wins).
 * - `bank.match.result` settles the outbox entry for a bank match and moves
 *   the bank line. Billing often answers twice (`needs_review`, then a
 *   person's `settled` or `rejected`): the later answer still applies to the
 *   line even though the first one already settled the outbox row.
 * - `mail.received` with category bank_statement opens a "Bank statement
 *   received" issue for the Bookkeeper with the exact import steps.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ASK_OWNER_TOOL,
  isModuleEnabled,
  LEDGER_EVENTS,
  outboxStatus,
  receiveOnce,
  settleOutbox,
  type BankMatched,
  type BankMatchResult,
  type LedgerPostRequested,
  type LedgerPostResult,
  type MailReceived,
  type OpenItemUpserted,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { AccountingError, isIsoDate } from "../domain/util.js";
import { PLUGIN_ID } from "../namespace.js";
import { routeBookkeeping } from "./agent.js";
import { refreshSuggestions } from "./bank.js";
import { ensureBook } from "./books.js";
import { closeIssue, commentOn, errorMessage, issueStatus, openIssue, ORIGIN, withLock, WORK_ORIGINS } from "./common.js";
import { postJournal, reverseJournal } from "./journals.js";
import { recordStatementEmail } from "./statement-emails.js";

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
      const route = await routeBookkeeping(ctx, companyId);
      const issue = await openIssue(ctx, {
        companyId,
        title: REJECTION_TITLE,
        description: [
          "Accounting refused one or more journals that another plugin asked it to post, so the books are missing them until someone fixes the cause.",
          "",
          line,
          "",
          "Common fixes: map the missing role (Accounting → Chart & roles), reopen a closed period, or correct the document in Billing / Payroll.",
          "Then open **Accounting → Journals → Rejected** and click **Retry**. This issue closes itself when nothing is left to fix.",
          "",
          `**Bookkeeper:** read each error, work out the fix (\`list-accounts\` shows the role map; \`period-close-checklist\` shows closed months), and ask once with \`${ASK_OWNER_TOOL}\` for the person-only steps (map the role, reopen the period, then Retry), with the exact accounts, months and link. Do not re-post these journals by hand.`,
        ].join("\n"),
        priority: "high",
        originKind: ORIGIN,
        originId: WORK_ORIGINS.rejections,
        wakeReason: "Postings were rejected",
      }, route);
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

/**
 * Billing's answer to a bank match (`bank.match.result`).
 *
 * The first answer settles the outbox row. Billing often answers again
 * later: `needs_review` first, then `settled` or `rejected` once a person
 * decides in Billing. `settleOutbox` ignores a row that is already settled,
 * so for a known `bank:` key the later answer is recorded on our row here
 * and still applied to the line. A rejection returns the line to
 * unreconciled with a note, and that invoice or bill is no longer
 * suggested for it.
 */
export async function receiveMatchResult(ctx: PluginContext, companyId: string, payload: unknown): Promise<"applied" | "ignored"> {
  if (!isObject(payload) || typeof payload.key !== "string" || !payload.key.startsWith("bank:")) return "ignored";
  const result = payload as unknown as BankMatchResult;
  // A refusal is a final business answer, not a failed delivery, so the row settles as done either way.
  const settled = await settleOutbox(ctx, result.key, result as unknown as Record<string, unknown>, "done");
  const row = settled ?? (await outboxStatus(ctx, result.key));
  if (!row) return "ignored";
  if (!settled) await db.recordOutboxAnswer(ctx.db, result.key, result);
  const request = row.payload as Partial<BankMatched>;
  const lineId = request.bankTxId;
  if (!lineId) return "ignored";
  const line = await db.getBankLine(ctx.db, companyId, lineId);
  if (!line || line.status !== "matching") return "ignored";
  const current = (line.match ?? {}) as { outboxKey?: string; number?: string };
  // The line was matched again since (or by hand): an old answer must not move it.
  if (current.outboxKey && current.outboxKey !== result.key) return "ignored";
  const what = current.number ? `the match to ${current.number}` : "the match";
  if (result.status === "rejected") {
    const moved = await db.setLineState(ctx.db, companyId, lineId, ["matching"], {
      status: "unreconciled",
      match: null,
      journalId: null,
      note: `Billing refused ${what}: ${result.error ?? "no reason given"}. Match the line to something else or categorise it.`,
    });
    if (moved) await refreshSuggestions(ctx, companyId, { lineIds: [lineId], useJev: false }).catch(() => undefined);
    return moved ? "applied" : "ignored";
  }
  const match = { ...(line.match ?? {}), billing: { status: result.status, paymentId: result.paymentId ?? null, error: result.error ?? null } };
  const moved = await db.setLineState(ctx.db, companyId, lineId, ["matching"], {
    status: "matching",
    match,
    journalId: null,
    note: result.status === "needs_review"
      ? `Billing wants a person to check this payment before it posts${result.error ? `: ${result.error}` : ""}.`
      : "Billing recorded the payment; waiting for its journal.",
  });
  return moved ? "applied" : "ignored";
}

// ---------------------------------------------------------------------------
// Statement emails from the Mailbox
// ---------------------------------------------------------------------------

function kb(bytes: number | null | undefined): string {
  const n = Math.max(0, Number(bytes ?? 0));
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The "Bank statement received" issue body: the files and the exact steps. */
export function statementIssueText(mail: MailReceived): string {
  const from = mail.from?.name ? `${mail.from.name} <${mail.from.email}>` : mail.from?.email ?? "an unknown sender";
  const files = mail.attachments ?? [];
  const table = files.length
    ? ["| File | Type | Size | Attachment id |", "|---|---|---:|---|", ...files.map((a) => `| ${a.filename} | ${a.mime} | ${kb(a.bytes)} | \`${a.attachmentId}\` |`)].join("\n")
    : "No attachments. The statement may be a link in the email: read it with `partnersinbiz.mailbox:get-message`.";
  return [
    `A bank statement arrived${mail.accountAddress ? ` in the mailbox ${mail.accountAddress}` : ""} from ${from} on ${mail.receivedAt}.`,
    "",
    table,
    "",
    `Message id: \`${mail.messageId}\``,
    "",
    "## Steps (Bookkeeper)",
    `1. Get each CSV, OFX or MT940 file with \`partnersinbiz.mailbox:get-attachment\` (message id \`${mail.messageId}\` and the attachment id above).`,
    `2. Import it with \`partnersinbiz.accounting:import-statement\`: the file text as \`content\` (or the link it returned as \`url\`), the \`fileName\`, the \`bankAccountId\` from \`list-bank-accounts\` and \`messageId: "${mail.messageId}"\` (this links the import to this email). Importing the same file again is safe: duplicates are skipped.`,
    "3. Reconcile: the import opens a \"Reconcile N new bank lines\" issue for the new lines. Work it with `list-bank-lines` and `accept-categorisation`.",
    "4. Mark this issue done with the result (lines imported, duplicates skipped, the reconcile issue).",
    "",
    `No statement in this email, or its statement was already imported? Record it with \`partnersinbiz.accounting:mark-statement-email\` (\`messageId: "${mail.messageId}"\`, \`outcome\` \`not_statement\` or \`duplicate\`, and the \`reason\`), then close this issue.`,
    "",
    `A PDF? Read it with your pdf skill, write the rows as CSV (\`Date,Description,Reference,Amount,Balance\`, a balance on every row), then \`import-statement\` with that CSV as \`content\`, \`checkRunningBalance: true\` and this \`messageId\`. Several PDFs: oldest first, and each opening balance must equal the previous closing balance. A PDF you cannot read (a scan the OCR route cannot read either): ask once with \`${ASK_OWNER_TOOL}\` for a clearer copy.`,
    "",
    "A person doing this by hand: download the file from the email and import it under **Accounting → Bank → Import statement**.",
  ].join("\n");
}

export async function receiveMail(ctx: PluginContext, companyId: string, eventType: string, payload: unknown): Promise<boolean> {
  if (!isObject(payload) || typeof payload.key !== "string") return false;
  const mail = payload as unknown as MailReceived;
  if (mail.triage?.category !== "bank_statement") return false;
  const { repeat } = await receiveOnce(ctx, companyId, eventType, `mail:${mail.key}`, async () => {
    const route = await routeBookkeeping(ctx, companyId);
    const issue = await openIssue(ctx, {
      companyId,
      title: `Bank statement received: ${(mail.subject || "(no subject)").slice(0, 120)}`,
      description: statementIssueText(mail),
      originKind: ORIGIN,
      originId: `${WORK_ORIGINS.statement}${mail.messageId}`,
      wakeReason: "Bank statement to import",
    }, route);
    // What became of the email (the "Statements to import" stage and the issue's done-check read it).
    await recordStatementEmail(ctx, companyId, mail, issue.id);
    return { issueId: issue.id, via: route.via };
  });
  return !repeat;
}
