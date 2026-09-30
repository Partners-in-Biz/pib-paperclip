/**
 * Bank accounts, statement import, suggestions and accepting them.
 *
 * Nothing posts on its own: rules, matches and Jev only suggest. A person
 * (or the Bookkeeper, when the setting allows) accepts a suggestion:
 * - open item → `bank.matched` to Billing through the outbox; Billing settles
 *   and posts the payment journal (dimensions.bankTxId), which reconciles the
 *   line when it arrives;
 * - journal → the line is reconciled against a journal already on the bank;
 * - category → a bank journal is posted here (bank vs account, VAT split).
 */
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  amountBucket,
  ASK_OWNER_TOOL,
  confidenceOf,
  correctDecision,
  decide,
  decideMany,
  decisionConfig,
  enqueue,
  OPEN_ITEM_EVENTS,
  outboxStatus,
  readConfig,
  SecretResolver,
  TAX_CODES,
  type BankMatched,
  type JevQuestions,
  type LedgerLine,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import type { Account } from "../domain/chart.js";
import { splitVat, suggestFor, validateRule, type BankRule, type Suggestion } from "../domain/matching.js";
import { fingerprintLines, linesDatedAfter, parseStatement, runningBalanceBreak, statementSanityProblem, type ParsedLine, type ParsedStatement, type StatementFormat } from "../domain/statements.js";
import { AccountingError, addDays, dayText, todayIso } from "../domain/util.js";
import { routeBookkeeping } from "./agent.js";
import { ensureBook, loadChart, type Chart } from "./books.js";
import {
  actorRecord,
  assertOwnKey,
  BOOK_CURRENCY,
  errorMessage,
  money,
  newId,
  openIssue,
  ORIGIN,
  privateR2,
  r2Url,
  readSettings,
  requireUser,
  safeFileName,
  WORK_ORIGINS,
  type Actor,
} from "./common.js";
import { postJournal, reverseJournal } from "./journals.js";
import { linkImportToEmail } from "./statement-emails.js";

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const MAX_JEV_LINES = 150;
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export async function saveBankAccount(ctx: PluginContext, companyId: string, input: Record<string, unknown>): Promise<db.BankAccountRow> {
  await ensureBook(ctx, companyId);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new AccountingError("Bank account name is required");
  const chart = await loadChart(ctx, companyId);
  const existing = await db.listBankAccounts(ctx.db, companyId);
  let code = typeof input.accountCode === "string" && input.accountCode.trim() ? input.accountCode.trim() : "";
  const id = typeof input.id === "string" && input.id ? input.id : null;
  if (code) {
    const account = chart.byCode.get(code);
    if (!account) throw new AccountingError(`Unknown account ${code}`, "unknown_account");
    if (account.subtype !== "bank" && account.subtype !== "cash" && account.subtype !== "current_liability") {
      throw new AccountingError("Link a bank account to a Bank, Cash or credit-card (current liability) account");
    }
    const other = existing.find((b) => b.accountCode === code && b.id !== id);
    if (other) throw new AccountingError(`${other.name} already uses account ${code}`, "conflict");
  } else if (!id) {
    const bankRole = chart.roles.get("bank");
    if (bankRole && !existing.some((b) => b.accountCode === bankRole)) code = bankRole;
    else {
      let n = 1020;
      while (chart.byCode.has(String(n)) && n < 1099) n += 10;
      code = String(n);
      await db.insertAccount(ctx.db, companyId, {
        id: newId(),
        code,
        name: `Bank – ${name}`.slice(0, 120),
        type: "asset",
        subtype: "bank",
        cashFlow: "cash",
        description: "Created with the bank account.",
      });
    }
  }
  const row: db.BankAccountRow = {
    id: id ?? newId(),
    name: name.slice(0, 120),
    accountCode: code,
    bankName: typeof input.bankName === "string" ? input.bankName.trim().slice(0, 80) : "",
    numberLast4: typeof input.numberLast4 === "string" ? input.numberLast4.replace(/\D/g, "").slice(-4) : "",
    currency: BOOK_CURRENCY,
    active: input.active !== false,
  };
  if (id) {
    const current = existing.find((b) => b.id === id);
    if (!current) throw new AccountingError("Bank account not found", "not_found");
    if (!code) row.accountCode = current.accountCode;
    await db.updateBankAccount(ctx.db, companyId, row);
  } else {
    await db.insertBankAccount(ctx.db, companyId, row);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Statement import (presigned PUT to private R2, then parsed by the worker)
// ---------------------------------------------------------------------------

export async function statementUploadUrl(ctx: PluginContext, companyId: string, input: { fileName?: unknown; bytes?: unknown }) {
  const cfg = await privateR2(ctx, companyId);
  if (!cfg) throw new AccountingError("Set up the private R2 bucket in the Accounting settings to upload files over 1 MB. Smaller files can be imported directly.", "not_configured");
  const bytes = Number(input.bytes ?? 0);
  if (bytes > MAX_STATEMENT_BYTES) throw new AccountingError("Statement files can be at most 10 MB");
  const month = new Date().toISOString().slice(0, 7);
  const key = `${cfg.prefix}/${companyId}/statements/${month}/${newId()}-${safeFileName(String(input.fileName ?? "statement"))}`;
  return { uploadUrl: r2Url(cfg, "PUT", key, 900), objectKey: key, expiresInSec: 900 };
}

/**
 * Download a statement from a link (e.g. the Mailbox `get-attachment` tool's
 * `url`). Only https, through the host's SSRF-guarded fetch, following a few
 * redirects (each hop checked again). Bytes, not text: a PDF's bytes must
 * survive intact for Claude to read (decoding as UTF-8 text would corrupt
 * them, see `decodeText`/`isPdfBytes` below).
 */
async function fetchStatementUrlBytes(ctx: PluginContext, raw: string): Promise<Uint8Array> {
  let current: URL;
  try {
    current = new URL(raw.trim());
  } catch {
    throw new AccountingError("url must be a full https link (the one the Mailbox get-attachment tool returned)");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "https:") throw new AccountingError("url must be an https link");
    let res: Response;
    try {
      res = await ctx.http.fetch(current.toString(), { method: "GET", headers: { Accept: "application/pdf, text/csv, application/x-ofx, text/plain, */*" } });
    } catch (error) {
      throw new AccountingError(`Could not download the statement: ${errorMessage(error)}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new AccountingError(`Could not download the statement (HTTP ${res.status}). Links from get-attachment expire: get a fresh one and try again.`);
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > MAX_STATEMENT_BYTES) throw new AccountingError("Statement files can be at most 10 MB");
    return buffer;
  }
  throw new AccountingError("Too many redirects downloading the statement");
}

/** Magic-byte sniff: `%PDF` at the start of the file. */
function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function decodeText(bytes: Uint8Array): string {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.includes("�")) text = new TextDecoder("latin1").decode(bytes);
  return text;
}

/** The plugin does not read PDFs itself: the Bookkeeper reads them with its `pdf` skill and imports the rows as CSV. */
const PDF_NEEDS_READING =
  "This is a PDF statement. Read it with your pdf skill, write the rows as CSV (Date, Description, Reference, Amount, Balance on every line), " +
  "then call import-statement again with that CSV as content and the same fileName and messageId. The import refuses a CSV whose balances do not add up. " +
  "A person with a PDF uploads it on Accounting → Bank, which hands it to the Bookkeeper.";

function assertRunningBalance(lines: ParsedLine[]): void {
  const broken = runningBalanceBreak(lines);
  if (broken === "missing") throw new AccountingError("A Balance is needed on every line: read the running balance column from the statement for each row.");
  if (broken) {
    throw new AccountingError(
      `Row ${broken.row} (${broken.date}): the balance should be ${money(broken.expectedMinor)} from the row before it, but the CSV says ${money(broken.foundMinor)}. ` +
        "A row was misread or skipped near there, or an amount has the wrong sign (an amount's sign is the direction its balance moved): check it against the PDF, fix the CSV and import again. Nothing was imported.",
    );
  }
}

/**
 * Every import is checked before anything is saved: no real statement is all
 * one side of the ledger or without descriptions, and when every row has a
 * balance the balances must add up. An agent's CSV always needs the balance
 * column (it is typed from a PDF, which is where amounts and columns slip).
 * `checkRunningBalance: true` also demands the balances.
 */
function assertStatementReadable(parsed: ParsedStatement, actor: Actor, demandBalances: boolean): void {
  const problem = statementSanityProblem(parsed.lines);
  if (problem) throw new AccountingError(`${problem} Nothing was imported.`);
  const balanced = parsed.lines.every((l) => l.balanceMinor != null);
  if (!balanced && parsed.format === "csv" && (actor.kind === "agent" || demandBalances)) {
    throw new AccountingError("This CSV has no Balance on every row. Add the running balance column from the statement so the import can check the rows add up. Nothing was imported.");
  }
  if (balanced) assertRunningBalance(parsed.lines);
}

async function ownObjectKey(ctx: PluginContext, companyId: string, raw: unknown): Promise<string | null> {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return null;
  const cfg = await privateR2(ctx, companyId);
  if (!cfg) throw new AccountingError("The private R2 bucket is not set up", "not_configured");
  assertOwnKey(cfg, companyId, key);
  return key;
}

interface StatementSource {
  bytes: Uint8Array;
  isPdf: boolean;
  objectKey: string | null;
}

async function statementSource(ctx: PluginContext, companyId: string, input: { content?: unknown; objectKey?: unknown; url?: unknown; fileName?: unknown }): Promise<StatementSource> {
  if (typeof input.content === "string" && input.content.trim()) {
    // `content` is plain text (pasted or read client-side with file.text()), so it can only ever carry CSV/OFX/MT940:
    // a PDF's bytes are already corrupted by the time they reach here as a JSON string. PDFs must use url or objectKey.
    if (input.content.length > 1_000_000) throw new AccountingError("Files over 1 MB must be uploaded to the private bucket first (or passed as a link in url)");
    if (input.content.startsWith("%PDF")) throw new AccountingError(PDF_NEEDS_READING);
    return { bytes: new TextEncoder().encode(input.content), isPdf: false, objectKey: null };
  }
  if (typeof input.url === "string" && input.url.trim()) {
    const bytes = await fetchStatementUrlBytes(ctx, input.url);
    return { bytes, isPdf: isPdfBytes(bytes), objectKey: null };
  }
  const key = typeof input.objectKey === "string" ? input.objectKey : "";
  if (!key) throw new AccountingError("Give the statement text (content), a download link (url) or the uploaded file's key");
  const cfg = await privateR2(ctx, companyId);
  if (!cfg) throw new AccountingError("The private R2 bucket is not set up", "not_configured");
  assertOwnKey(cfg, companyId, key);
  const res = await fetch(r2Url(cfg, "GET", key, 300));
  if (!res.ok) throw new AccountingError(`Could not read the uploaded file (HTTP ${res.status})`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_STATEMENT_BYTES) throw new AccountingError("Statement files can be at most 10 MB");
  return { bytes: buffer, isPdf: isPdfBytes(buffer), objectKey: key };
}

export interface ImportResult {
  statementId: string | null;
  /** The statement email this import was linked to (`messageId`), and what it now says. */
  statementEmail: { messageId: string; status: db.StatementEmailStatus } | null;
  duplicateFile: boolean;
  format: StatementFormat;
  lines: number;
  added: number;
  duplicates: number;
  periodStart: string | null;
  periodEnd: string | null;
  openingMinor: number | null;
  closingMinor: number | null;
  suggested: number;
  jevAsked: number;
  issueId: string | null;
  /** Lines dated after today: they count nowhere until then and a person checks the date. */
  futureLines: number;
  firstFutureDate: string | null;
}

/**
 * The bank account a tool call means: the given id, or the only active one.
 * With several and no id, the error lists them so the agent can choose.
 */
export async function resolveBankAccount(ctx: PluginContext, companyId: string, bankAccountId: unknown): Promise<db.BankAccountRow> {
  const id = typeof bankAccountId === "string" ? bankAccountId.trim() : "";
  if (id) {
    const bank = await db.getBankAccount(ctx.db, companyId, id);
    if (!bank) throw new AccountingError(`Bank account ${id} not found. list-bank-accounts gives the ids.`, "not_found");
    return bank;
  }
  const active = (await db.listBankAccounts(ctx.db, companyId)).filter((b) => b.active);
  if (active.length === 1) return active[0]!;
  if (active.length === 0) throw new AccountingError(`No bank account is set up yet. A person adds one under Accounting → Bank (ask with ${ASK_OWNER_TOOL}).`, "not_found");
  throw new AccountingError(`Give bankAccountId, one of: ${active.map((b) => `${b.id} (${b.name}${b.numberLast4 ? ` ••${b.numberLast4}` : ""})`).join(", ")}`);
}

export async function importStatement(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  input: {
    bankAccountId?: unknown;
    content?: unknown;
    objectKey?: unknown;
    url?: unknown;
    fileName?: unknown;
    format?: unknown;
    messageId?: unknown;
    checkRunningBalance?: unknown;
    pdfObjectKey?: unknown;
    skipChecks?: unknown;
  },
): Promise<ImportResult> {
  await ensureBook(ctx, companyId);
  const bankAccountId = typeof input.bankAccountId === "string" ? input.bankAccountId : "";
  const bank = bankAccountId ? await db.getBankAccount(ctx.db, companyId, bankAccountId) : null;
  if (!bank) throw new AccountingError("Choose the bank account this statement belongs to", "not_found");
  const messageId = typeof input.messageId === "string" && input.messageId.trim() ? input.messageId.trim().slice(0, 300) : null;
  const source = await statementSource(ctx, companyId, input);
  if (source.isPdf) throw new AccountingError(PDF_NEEDS_READING);
  // A CSV read from an uploaded PDF keeps the PDF as its file (audit trail, and the PDF batch's done-check).
  const objectKey = source.objectKey ?? (await ownObjectKey(ctx, companyId, input.pdfObjectKey));
  const format = ["csv", "ofx", "mt940"].includes(String(input.format)) ? (String(input.format) as StatementFormat) : "auto";
  const parsed = parseStatement(decodeText(source.bytes), format);
  if (input.skipChecks === true) requireUser(actor, "import a file that fails the statement checks");
  else assertStatementReadable(parsed, actor, input.checkRunningBalance === true);
  const seen = await db.statementByDigest(ctx.db, bank.id, parsed.digest);
  if (seen) {
    if (objectKey && !seen.objectKey) await db.linkStatementObjectKey(ctx.db, companyId, seen.id, objectKey);
    return {
      statementId: seen.id,
      statementEmail: messageId ? { messageId, status: await linkImportToEmail(ctx, companyId, messageId, seen.id, 0, actor) } : null,
      duplicateFile: true,
      format: parsed.format,
      lines: parsed.lines.length,
      added: 0,
      duplicates: parsed.lines.length,
      periodStart: seen.periodStart,
      periodEnd: seen.periodEnd,
      openingMinor: seen.openingMinor,
      closingMinor: seen.closingMinor,
      suggested: 0,
      jevAsked: 0,
      issueId: null,
      futureLines: 0,
      firstFutureDate: null,
    };
  }
  const statementId = newId();
  await db.insertStatement(
    ctx.db,
    companyId,
    {
      id: statementId,
      bankAccountId: bank.id,
      fileName: typeof input.fileName === "string" ? input.fileName.slice(0, 200) : "",
      format: parsed.format,
      objectKey,
      digest: parsed.digest,
      lineCount: parsed.lines.length,
      newCount: 0,
      duplicateCount: 0,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      openingMinor: parsed.openingMinor,
      closingMinor: parsed.closingMinor,
      createdAt: null,
    },
    actorRecord(actor),
  );
  const fingerprints = fingerprintLines(bank.id, parsed.lines);
  const rows = parsed.lines.map((line, i) => ({
    id: newId(),
    bank_account_id: bank.id,
    statement_id: statementId,
    date: line.date,
    amount_minor: line.amountMinor,
    description: line.description,
    reference: line.reference,
    counterparty: line.counterparty,
    balance_minor: line.balanceMinor,
    fingerprint: fingerprints[i]!,
  }));
  const added = await db.insertBankLines(ctx.db, companyId, rows);
  await db.updateStatementCounts(ctx.db, companyId, statementId, added, rows.length - added);
  const refreshed = added > 0 ? await refreshSuggestions(ctx, companyId, { statementId }) : { lines: 0, suggested: 0, jevAsked: 0 };
  const future = linesDatedAfter(rows, todayIso());
  let issueId: string | null = null;
  if (added > 0) issueId = await openReconcileIssue(ctx, companyId, bank, statementId, added, parsed.periodStart, parsed.periodEnd, future);
  return {
    statementId,
    statementEmail: messageId ? { messageId, status: await linkImportToEmail(ctx, companyId, messageId, statementId, added, actor) } : null,
    duplicateFile: false,
    format: parsed.format,
    lines: rows.length,
    added,
    duplicates: rows.length - added,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    openingMinor: parsed.openingMinor,
    closingMinor: parsed.closingMinor,
    suggested: refreshed.suggested,
    jevAsked: refreshed.jevAsked,
    issueId,
    futureLines: future.count,
    firstFutureDate: future.first,
  };
}

/** The `list-bank-accounts` tool: ids, open lines, the last statement and how far each account is reconciled. */
export async function bankAccountsView(ctx: PluginContext, companyId: string, includeInactive = false) {
  const [banks, counts, statements, recs] = await Promise.all([
    db.listBankAccounts(ctx.db, companyId),
    db.lineCountsByAccount(ctx.db, companyId),
    db.listStatements(ctx.db, companyId),
    db.listReconciliations(ctx.db, companyId),
  ]);
  return {
    bankAccounts: banks
      .filter((b) => includeInactive || b.active)
      .map((b) => {
        const open = counts.filter((c) => c.bankAccountId === b.id && (c.status === "unreconciled" || c.status === "matching")).reduce((s, c) => s + c.count, 0);
        const last = statements.find((s) => s.bankAccountId === b.id) ?? null;
        const mine = recs.filter((r) => r.bankAccountId === b.id);
        const locked = mine.filter((r) => r.status === "locked").sort((x, y) => y.periodEnd.localeCompare(x.periodEnd))[0] ?? null;
        const pending = mine.find((r) => r.status === "pending_approval") ?? null;
        return {
          id: b.id,
          name: b.name,
          bankName: b.bankName || null,
          numberLast4: b.numberLast4 || null,
          accountCode: b.accountCode,
          active: b.active,
          openLines: open,
          lastStatement: last ? { fileName: last.fileName || null, periodStart: last.periodStart, periodEnd: last.periodEnd, importedAt: last.createdAt } : null,
          reconciledTo: locked?.periodEnd ?? null,
          awaitingApproval: pending ? { periodStart: pending.periodStart, periodEnd: pending.periodEnd, approvalIssueId: pending.approvalIssueId } : null,
        };
      }),
  };
}

/** The `import-statement` tool: import, then say exactly what comes next. */
/**
 * Does this statement join up with its neighbours? A statement's opening
 * balance is the previous one's closing balance, so a difference means a
 * statement (or lines) in between are missing. Warnings, not refusals: the
 * agent imports oldest first and asks a person about the gaps.
 */
export async function continuityWarnings(ctx: PluginContext, companyId: string, bankAccountId: string, statementId: string | null): Promise<string[]> {
  if (!statementId) return [];
  const all = await db.listStatements(ctx.db, companyId, bankAccountId);
  const me = all.find((x) => x.id === statementId);
  if (!me || !me.periodStart || !me.periodEnd) return [];
  const others = all.filter((x) => x.id !== me.id && x.periodStart && x.periodEnd);
  const previous = others.filter((x) => x.periodEnd! < me.periodStart!).sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!))[0];
  const following = others.filter((x) => x.periodStart! > me.periodEnd!).sort((a, b) => a.periodStart!.localeCompare(b.periodStart!))[0];
  const out: string[] = [];
  if (previous && previous.closingMinor != null && me.openingMinor != null && previous.closingMinor !== me.openingMinor) {
    out.push(`Opens at ${money(me.openingMinor)} but the previous statement (${dayText(previous.periodStart)} to ${dayText(previous.periodEnd)}) closed at ${money(previous.closingMinor)}: ${money(me.openingMinor - previous.closingMinor)} is missing between them (a statement, or lines).`);
  }
  if (following && following.openingMinor != null && me.closingMinor != null && following.openingMinor !== me.closingMinor) {
    out.push(`Closes at ${money(me.closingMinor)} but the next statement (${dayText(following.periodStart)} to ${dayText(following.periodEnd)}) opens at ${money(following.openingMinor)}: ${money(following.openingMinor - me.closingMinor)} is missing between them (a statement, or lines).`);
  }
  return out;
}

export async function importStatementTool(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  p: { bankAccountId?: unknown; content?: unknown; url?: unknown; fileName?: unknown; format?: unknown; messageId?: unknown; checkRunningBalance?: unknown; pdfObjectKey?: unknown },
) {
  const bank = await resolveBankAccount(ctx, companyId, p.bankAccountId);
  const r = await importStatement(ctx, companyId, actor, {
    bankAccountId: bank.id,
    content: p.content,
    url: p.url,
    fileName: p.fileName,
    format: p.format,
    messageId: p.messageId,
    checkRunningBalance: p.checkRunningBalance,
    pdfObjectKey: p.pdfObjectKey,
  });
  const warnings = r.duplicateFile ? [] : await continuityWarnings(ctx, companyId, bank.id, r.statementId);
  const next: string[] = [];
  if (warnings.length) next.push(`This statement does not join up with its neighbour: ${warnings.join(" ")} Import the missing statement first if you have it; otherwise list the gap in your one ask to the owner (${ASK_OWNER_TOOL}).`);
  if (r.futureLines > 0) next.push(`${r.futureLines} line(s) are dated after today (first ${dayText(r.firstFutureDate)}). A bank statement only has money that already moved, so the date is probably wrong: don't reconcile those lines. Ask a person to check them (${ASK_OWNER_TOOL}); they count in no balance until that day.`);
  if (r.duplicateFile) next.push("This exact file was imported before, so nothing new was added.");
  else if (r.added === 0) next.push("Every line in the file was already imported (duplicates skipped). Nothing new to reconcile.");
  else if (r.issueId) next.push(`Reconcile the ${r.added} new line(s) on the reconcile issue ${r.issueId} (list-bank-lines with status "unreconciled" and bankAccountId "${bank.id}").`);
  else next.push(`Reconcile the ${r.added} new line(s): list-bank-lines with status "unreconciled" and bankAccountId "${bank.id}".`);
  if (!r.duplicateFile && r.added > 0 && r.periodStart && r.periodEnd) {
    next.push(
      r.openingMinor == null || r.closingMinor == null
        ? `When no line is open, prepare-reconciliation with bankAccountId "${bank.id}", periodStart ${r.periodStart} and periodEnd ${r.periodEnd}. The file has no opening or closing balance, so pass openingMinor and closingMinor from the statement.`
        : `When no line is open, prepare-reconciliation with bankAccountId "${bank.id}", periodStart ${r.periodStart} and periodEnd ${r.periodEnd}.`,
    );
  }
  next.push(
    r.statementEmail
      ? `The statement email ${r.statementEmail.messageId} is now marked ${r.statementEmail.status === "imported" ? "imported" : "already imported"}. Then mark the statement issue done with this result.`
      : "Then mark the statement issue done with this result. (From a statement email? Pass its messageId so the email shows as imported.)",
  );
  return {
    statementId: r.statementId,
    statementEmail: r.statementEmail,
    bankAccount: { id: bank.id, name: bank.name },
    format: r.format,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    openingMinor: r.openingMinor,
    closingMinor: r.closingMinor,
    linesInFile: r.lines,
    imported: r.added,
    duplicatesSkipped: r.duplicates,
    duplicateFile: r.duplicateFile,
    suggested: r.suggested,
    reconcileIssueId: r.issueId,
    futureLines: r.futureLines,
    firstFutureDate: r.firstFutureDate,
    warnings,
    next,
  };
}

/** The "Reconcile N new bank lines" issue body: the exact steps and tools. */
export function reconcileIssueText(bank: { id: string; name: string }, added: number, start: string | null, end: string | null, future: { count: number; first: string | null } = { count: 0, first: null }): string {
  const period = start && end ? `from \`${start}\` to \`${end}\`` : "for the statement period";
  return [
    `A statement for **${bank.name}** (${dayText(start)} to ${dayText(end)}) added ${added} line${added === 1 ? "" : "s"}. Follow the \`pib-bookkeeping\` skill:`,
    ...(future.count > 0
      ? ["", `**${future.count} line${future.count === 1 ? " is" : "s are"} dated after today (first ${dayText(future.first)}).** A statement only holds money that already moved, so the date is probably wrong. Don't reconcile ${future.count === 1 ? "it" : "them"} (agents can't): ask a person to check the date with \`${ASK_OWNER_TOOL}\`. ${future.count === 1 ? "It counts" : "They count"} in no balance until that day.`]
      : []),
    "",
    `1. \`list-bank-lines\` with \`status: "unreconciled"\` and \`bankAccountId: "${bank.id}"\`. Each line lists its suggestions, best first.`,
    "2. Accept the safe ones with `accept-categorisation`: a journal match, an exact invoice or bill match, a bank-rule category, or an obviously right Jev category. Categorise a clear line to an account (`accountCode`, `taxCode`). `suggest-categorisation` asks again for lines with no suggestion.",
    `3. Lines you cannot place from the bank line and the books: never guess. Ask once with \`${ASK_OWNER_TOOL}\`, every unclear line in one list (date, amount, description, your best guess). If accepting is switched off for agents, put your proposed categories in the same ask.`,
    `4. When no line is open for the period, \`prepare-reconciliation\` with \`bankAccountId: "${bank.id}"\` ${period}. It opens the approval issue for a person once the difference is zero.`,
    `5. Mark this issue done with what you did (lines matched, categorised and asked about, the approval issue). Closing it checks that every line from this statement is matched, categorised or excluded${future.count > 0 ? " (except the future-dated ones, which wait for a person)" : ""}; while a person still has to answer about a line, leave the issue with them instead.`,
  ].join("\n");
}

/** A statement added lines: one issue for the Bookkeeper (else the Operator or the owner), so nothing waits silently. */
async function openReconcileIssue(ctx: PluginContext, companyId: string, bank: db.BankAccountRow, statementId: string, added: number, start: string | null, end: string | null, future: { count: number; first: string | null } = { count: 0, first: null }): Promise<string | null> {
  try {
    const route = await routeBookkeeping(ctx, companyId);
    const issue = await openIssue(ctx, {
      companyId,
      title: `Reconcile ${added} new bank line${added === 1 ? "" : "s"} (${bank.name})`,
      description: reconcileIssueText(bank, added, start, end, future),
      originKind: ORIGIN,
      // The statement's own lines are what its done-check looks at.
      originId: `${WORK_ORIGINS.reconcile}${statementId}`,
      wakeReason: "New bank lines to reconcile",
    }, route);
    return issue.id;
  } catch (error) {
    ctx.logger.warn("Reconcile issue could not be opened", { companyId, error: errorMessage(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// PDF statements a person uploaded: the Bookkeeper reads them (its pdf skill)
// ---------------------------------------------------------------------------

const MAX_PDF_BATCH = 60;

interface PdfBatch {
  bankAccountId: string;
  files: Array<{ objectKey: string; fileName: string }>;
}

const pdfBatchMark = (batchId: string) => `pdf-batch:${batchId}`;

export async function readPdfBatch(ctx: PluginContext, companyId: string, batchId: string): Promise<PdfBatch | null> {
  const raw = await db.getMark(ctx.db, companyId, pdfBatchMark(batchId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PdfBatch;
  } catch {
    return null;
  }
}

/** The "Read N PDF bank statements" issue body. */
export function pdfBatchIssueText(bank: { id: string; name: string }, batchId: string, fileNames: string[]): string {
  return [
    `${fileNames.length === 1 ? "A PDF bank statement was" : `${fileNames.length} PDF bank statements were`} uploaded for **${bank.name}**. Follow the PDF statements section of the \`pib-bookkeeping\` skill:`,
    "",
    ...fileNames.slice(0, 20).map((n) => `- ${n}`),
    ...(fileNames.length > 20 ? [`- …and ${fileNames.length - 20} more`] : []),
    "",
    `1. \`pdf-statements\` with \`batchId: "${batchId}"\`: each PDF already downloaded to a local path you can open, and which are imported already.`,
    "2. Read each page as a picture (Claude: read the PDF pages; Hermes: `pdf_page_image.py`), not as extracted text, which runs columns together and loses the sign. Cross-check numbers with `pdf_read.py --text`. A page with no text is a scan: use the OCR route.",
    "3. Know the columns first. FNB: Description, Amount, Balance, Accrued Bank Charges. Only Amount moves the balance; the charges column is not an amount and stays out. An amount followed by `Cr` is money in, an amount without it is money out. The sign of an amount is the direction its balance moved.",
    "4. Write the CSV: header `Date,Description,Reference,Amount,Balance`, every line in the order printed, dates YYYY-MM-DD, money in positive and money out negative, the running Balance on every row, the Description exactly as printed without the amount.",
    `5. **Oldest statement only, first.** \`import-statement\` with that CSV as \`content\`, \`bankAccountId: "${bank.id}"\`, the file's \`fileName\` and its \`objectKey\` as \`pdfObjectKey\`. The import is refused, with nothing saved, when balances do not add up, every line is on one side or descriptions are missing: fix the CSV, never work around it. Then stop and ask once (\`${ASK_OWNER_TOOL}\`) with its period, opening and closing balance and its first and last three lines, and "please compare these with your bank app". Carry on only when the owner says they match.`,
    "6. The rest, oldest first. A result `warnings` entry means a statement does not join up with its neighbour (its opening is not the previous closing): a missing statement or lines. Import what you can and put every gap in one ask.",
    "7. When every file is imported, work the reconcile issues. If opening balances are not posted yet (the Cockpit warns), put the cut-over in one ask: the day before the first statement starts, and that statement's opening balance.",
    "8. Mark this issue done. Closing it checks that every file has an imported statement.",
  ].join("\n");
}

/**
 * A person uploaded PDF statements on the Bank page (to the private bucket):
 * one issue for the Bookkeeper to read them all, however many there are.
 */
export async function queuePdfStatements(ctx: PluginContext, companyId: string, actor: Actor, input: { bankAccountId?: unknown; files?: unknown }) {
  requireUser(actor, "hand PDF statements to the Bookkeeper");
  await ensureBook(ctx, companyId);
  const bank = await resolveBankAccount(ctx, companyId, input.bankAccountId);
  const list = Array.isArray(input.files) ? input.files : [];
  if (list.length === 0) throw new AccountingError("Upload at least one PDF statement");
  if (list.length > MAX_PDF_BATCH) throw new AccountingError(`At most ${MAX_PDF_BATCH} statements at a time`);
  const cfg = await privateR2(ctx, companyId);
  if (!cfg) throw new AccountingError("Set up the private R2 bucket in the Accounting settings to upload PDF statements.", "not_configured");
  const files = list.map((f) => {
    const item = (f ?? {}) as Record<string, unknown>;
    const objectKey = typeof item.objectKey === "string" ? item.objectKey.trim() : "";
    if (!objectKey) throw new AccountingError("Each file needs the objectKey from its upload");
    assertOwnKey(cfg, companyId, objectKey);
    const fileName = typeof item.fileName === "string" && item.fileName.trim() ? item.fileName.trim().slice(0, 200) : "statement.pdf";
    return { objectKey, fileName };
  });
  const batchId = newId();
  await db.setMark(ctx.db, companyId, pdfBatchMark(batchId), JSON.stringify({ bankAccountId: bank.id, files } satisfies PdfBatch));
  const route = await routeBookkeeping(ctx, companyId);
  const issue = await openIssue(ctx, {
    companyId,
    title: `Read ${files.length} PDF bank statement${files.length === 1 ? "" : "s"} (${bank.name})`,
    description: pdfBatchIssueText(bank, batchId, files.map((f) => f.fileName)),
    originKind: ORIGIN,
    originId: `${WORK_ORIGINS.pdf}${batchId}`,
    wakeReason: "PDF bank statements to read",
  }, route);
  return { batchId, issueId: issue.id, files: files.length, assignedTo: route.via };
}

/**
 * Where a batch's PDFs are put for the agent to read: a private folder on the
 * server the agent runs on. The agent gets a path, never a link: a signed
 * link carries a credential, and the platform blanks credentials in what an
 * agent sees, so a link arrives broken.
 */
function statementWorkDir(companyId: string, batchId: string): string {
  const root =
    process.env.PIB_ACCOUNTING_WORKDIR ||
    path.join(process.env.PAPERCLIP_HOME || path.join(homedir(), ".paperclip"), "instances", process.env.PAPERCLIP_INSTANCE_ID || "default", "data", "accounting-statements");
  return path.join(root, companyId, batchId);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Agent tool: the batch's PDFs, each already downloaded to a local path the
 * agent can open, and whether it is imported. A file that is imported is
 * removed from disk again.
 */
export async function pdfStatementsTool(ctx: PluginContext, companyId: string, input: { batchId?: unknown }) {
  const batchId = typeof input.batchId === "string" ? input.batchId.trim() : "";
  const batch = batchId ? await readPdfBatch(ctx, companyId, batchId) : null;
  if (!batch) throw new AccountingError("No PDF batch with that id. The id is in the \"Read N PDF bank statements\" issue.", "not_found");
  const cfg = await privateR2(ctx, companyId);
  if (!cfg) throw new AccountingError("The private R2 bucket is not set up", "not_configured");
  const bank = await db.getBankAccount(ctx.db, companyId, batch.bankAccountId);
  const imported = await db.importedObjectKeys(ctx.db, companyId, batch.files.map((f) => f.objectKey));
  const dir = statementWorkDir(companyId, batchId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files: Array<{ fileName: string; objectKey: string; imported: boolean; path: string | null }> = [];
  for (const [i, f] of batch.files.entries()) {
    const local = path.join(dir, `${String(i + 1).padStart(2, "0")}-${safeFileName(f.fileName)}`);
    if (imported.has(f.objectKey)) {
      await rm(local, { force: true });
      files.push({ fileName: f.fileName, objectKey: f.objectKey, imported: true, path: null });
      continue;
    }
    if (!(await fileExists(local))) {
      assertOwnKey(cfg, companyId, f.objectKey);
      const res = await fetch(r2Url(cfg, "GET", f.objectKey, 300));
      if (!res.ok) throw new AccountingError(`Could not read ${f.fileName} from storage (HTTP ${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_STATEMENT_BYTES) throw new AccountingError("Statement files can be at most 10 MB");
      await writeFile(local, bytes, { mode: 0o600 });
    }
    files.push({ fileName: f.fileName, objectKey: f.objectKey, imported: false, path: local });
  }
  return {
    bankAccount: bank ? { id: bank.id, name: bank.name } : { id: batch.bankAccountId, name: null },
    files,
    next: files.every((f) => f.imported)
      ? ["Every file is imported. Work the reconcile issues, then mark the PDF issue done."]
      : ["Open each file at its path and read its pages as pictures, oldest statement first, then import it with import-statement (content = the CSV, pdfObjectKey = its objectKey). The path is a local file on this server."],
  };
}

// ---------------------------------------------------------------------------
// Suggestions (rules, matches, Jev)
// ---------------------------------------------------------------------------

export function categoryQuestions(accounts: Account[], direction: "in" | "out"): JevQuestions | null {
  const options = accounts
    .filter((a) => a.active && (direction === "out" ? a.type === "expense" : a.type === "income"))
    .slice(0, 255);
  if (options.length < 2) return null;
  return {
    account: {
      type: "choice",
      instructions: `Which ${direction === "out" ? "expense" : "income"} account in a South African small business's books does this bank ${direction === "out" ? "payment" : "receipt"} belong to?`,
      criteria: Object.fromEntries(options.map((a) => [a.code, a.name])),
    },
    vat_applies: {
      type: "noul",
      instructions: "Does this amount include 15% South African VAT charged by a VAT vendor (so VAT can be claimed or must be paid over)?",
      criteria: { true: "A normal taxable purchase or sale from a VAT-registered business.", false: "Bank charges, interest, salaries, insurance, fines, transfers, or a non-VAT supplier." },
    },
    is_transfer: {
      type: "noul",
      instructions: "Is this a movement between the business's own accounts (bank transfer, credit card settlement, loan) rather than income or an expense?",
    },
  };
}

export function jevState(line: db.BankLineRow): Record<string, string> {
  return {
    description: line.description.slice(0, 200),
    counterparty: (line.counterparty ?? "").slice(0, 100),
    reference: (line.reference ?? "").slice(0, 100),
    direction: line.amountMinor > 0 ? "money in" : "money out",
    amountBucket: amountBucket(line.amountMinor),
  };
}

export async function refreshSuggestions(
  ctx: PluginContext,
  companyId: string,
  f: { bankAccountId?: string | null; statementId?: string | null; lineIds?: string[] | null; useJev?: boolean },
): Promise<{ lines: number; suggested: number; jevAsked: number }> {
  const lines = await db.listBankLines(ctx.db, companyId, {
    bankAccountId: f.bankAccountId ?? null,
    statementId: f.statementId ?? null,
    ids: f.lineIds ?? null,
    statuses: ["unreconciled"],
    limit: 2000,
  });
  if (lines.length === 0) return { lines: 0, suggested: 0, jevAsked: 0 };
  const chart = await loadChart(ctx, companyId);
  const [items, rules, banks, refused] = await Promise.all([
    db.listOpenItems(ctx.db, companyId, { currency: BOOK_CURRENCY }),
    db.listRules(ctx.db, companyId),
    db.listBankAccounts(ctx.db, companyId),
    db.refusedMatches(ctx.db, companyId),
  ]);
  const bankCode = new Map(banks.map((b) => [b.id, b.accountCode]));
  const journalsByBank = new Map<string, Awaited<ReturnType<typeof db.unlinkedBankJournals>>>();
  for (const bankId of new Set(lines.map((l) => l.bankAccountId))) {
    const code = bankCode.get(bankId);
    const account = code ? chart.byCode.get(code) : null;
    const own = lines.filter((l) => l.bankAccountId === bankId).map((l) => l.date).sort();
    journalsByBank.set(
      bankId,
      account && own.length ? await db.unlinkedBankJournals(ctx.db, companyId, account.id, addDays(own[0]!, -10), addDays(own[own.length - 1]!, 10)) : [],
    );
  }
  const openItems = items.map((i) => ({ key: i.key, kind: i.kind, number: i.number, counterpartyName: i.counterpartyName, currency: i.currency, outstandingMinor: i.outstandingMinor, refs: i.refs, dueDate: i.dueDate }));
  const needJev: db.BankLineRow[] = [];
  let suggested = 0;
  const computed = new Map<string, Suggestion[]>();
  for (const line of lines) {
    // An invoice or bill Billing refused for this line is not suggested again (no accept-refuse loop).
    const refusedHere = refused.get(line.id);
    const suggestions = suggestFor(line, { items: openItems, journals: journalsByBank.get(line.bankAccountId) ?? [], rules, bookCurrency: BOOK_CURRENCY }).filter(
      (s) => !(s.kind === "open_item" && refusedHere?.has(s.key)),
    );
    computed.set(line.id, suggestions);
    if (suggestions.length) suggested += 1;
    const strong = suggestions.some((s) => (s.kind === "open_item" && s.basis === "exact") || s.kind === "journal" || (s.kind === "category" && s.source === "rule"));
    if (!strong && !line.jev) needJev.push(line);
  }
  let jevAsked = 0;
  const jevResults = new Map<string, Record<string, unknown>>();
  if (f.useJev !== false && needJev.length) {
    const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
    const jev = await decisionConfig(new SecretResolver(ctx, companyId, config), config);
    if (jev) {
      const batch = needJev.slice(0, MAX_JEV_LINES);
      const results = await decideMany(batch, 5, (line) => {
        const questions = categoryQuestions(chart.accounts, line.amountMinor > 0 ? "in" : "out");
        if (!questions) return Promise.resolve(null);
        return decide(ctx, companyId, { config: jev, purpose: "bank_line_category", subject: { kind: "bank_line", id: line.id }, state: jevState(line), questions });
      });
      batch.forEach((line, i) => {
        const r = results[i];
        if (!r) return;
        jevAsked += 1;
        const account = r.answers.account;
        const vat = r.answers.vat_applies;
        const transfer = r.answers.is_transfer;
        jevResults.set(line.id, {
          model: r.model,
          accountCode: account?.type === "choice" ? account.choice : null,
          confidence: confidenceOf(account),
          vatApplies: vat?.type === "noul" ? vat.noul : null,
          isTransfer: transfer?.type === "noul" ? transfer.noul : null,
          decisionIds: r.ids,
        });
      });
    }
  }
  const updates: Array<{ id: string; suggestions: Suggestion[]; jev?: unknown }> = [];
  for (const line of lines) {
    const suggestions = computed.get(line.id) ?? [];
    const jev = jevResults.get(line.id) ?? line.jev;
    if (jev && typeof jev.accountCode === "string" && chart.byCode.has(jev.accountCode) && !suggestions.some((s) => s.kind === "category")) {
      const vatApplies = typeof jev.vatApplies === "number" ? jev.vatApplies : null;
      suggestions.push({
        kind: "category",
        source: "jev",
        accountCode: jev.accountCode,
        taxCode: vatApplies != null && vatApplies >= 0.5 ? "za_std_15" : null,
        counterparty: line.counterparty,
        confidence: Math.min(0.8, Number(jev.confidence ?? 0)),
        vatApplies,
        isTransfer: typeof jev.isTransfer === "number" ? jev.isTransfer : null,
      });
      if (suggestions.length === 1) suggested += 1;
    }
    updates.push({ id: line.id, suggestions: suggestions.sort((a, b) => b.confidence - a.confidence), ...(jevResults.has(line.id) ? { jev: jevResults.get(line.id) } : {}) });
  }
  for (let i = 0; i < updates.length; i += 500) await db.setSuggestionsBatch(ctx.db, companyId, updates.slice(i, i + 500));
  return { lines: lines.length, suggested, jevAsked };
}

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

async function requireLine(ctx: PluginContext, companyId: string, lineId: unknown): Promise<{ line: db.BankLineRow; bank: db.BankAccountRow }> {
  const id = typeof lineId === "string" ? lineId : "";
  const line = id ? await db.getBankLine(ctx.db, companyId, id) : null;
  if (!line) throw new AccountingError("Bank line not found", "not_found");
  if (line.reconciliationId) throw new AccountingError("This line is in a locked reconciliation", "conflict");
  const bank = await db.getBankAccount(ctx.db, companyId, line.bankAccountId);
  if (!bank) throw new AccountingError("Bank account not found", "not_found");
  return { line, bank };
}

/** A bank line dated after today waits for a person to check its date: agents may not reconcile it. */
export function assertAgentMayTouchDate(actor: Actor, line: { date: string }, today = todayIso()): void {
  if (actor.kind === "agent" && line.date > today) {
    throw new AccountingError(`This bank line is dated ${dayText(line.date)}, after today, so its date is probably wrong. A person checks it first (ask with ${ASK_OWNER_TOOL}).`, "forbidden");
  }
}

/** Who may accept: a board user always; an agent only when the setting allows (and only exact open-item matches). */
async function assertMayAccept(ctx: PluginContext, companyId: string, actor: Actor, suggestion: Suggestion | null): Promise<void> {
  if (actor.kind === "user") return;
  if (actor.kind !== "agent") throw new AccountingError("Only a person or the Bookkeeper can accept bank suggestions", "forbidden");
  const settings = await readSettings(ctx, companyId);
  if (!settings.agentsMayAcceptCategorisation) {
    throw new AccountingError("A board user must accept this. (Turn on 'Agents may accept bank categorisation' in the Accounting settings to let the Bookkeeper do it.)", "forbidden");
  }
  if (suggestion?.kind === "open_item" && suggestion.basis !== "exact") {
    throw new AccountingError("Only exact matches (same amount and the invoice number in the bank line) can be accepted by an agent. Leave this one for a person.", "forbidden");
  }
}

export async function acceptSuggestion(ctx: PluginContext, companyId: string, actor: Actor, input: { lineId?: unknown; index?: unknown }): Promise<db.BankLineRow> {
  const { line, bank } = await requireLine(ctx, companyId, input.lineId);
  if (line.status !== "unreconciled") throw new AccountingError(`This line is already ${line.status}`, "conflict");
  const index = input.index == null ? 0 : Number(input.index);
  const suggestion = line.suggestions[index];
  if (!suggestion) throw new AccountingError("That suggestion no longer exists; refresh the suggestions", "not_found");
  await assertMayAccept(ctx, companyId, actor, suggestion);
  assertAgentMayTouchDate(actor, line);
  if (suggestion.kind === "open_item") return acceptOpenItem(ctx, companyId, actor, line, bank, suggestion.key, suggestion.basis === "reference" ? "manual" : suggestion.basis);
  if (suggestion.kind === "journal") return linkJournal(ctx, companyId, line, bank, suggestion.journalId);
  return categorise(ctx, companyId, actor, { lineId: line.id, accountCode: suggestion.accountCode, taxCode: suggestion.taxCode, counterparty: suggestion.counterparty }, true);
}

export async function acceptOpenItem(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  line: db.BankLineRow,
  bank: db.BankAccountRow,
  openItemKey: string,
  basis: BankMatched["basis"],
): Promise<db.BankLineRow> {
  const item = await db.getOpenItem(ctx.db, companyId, openItemKey);
  if (!item) throw new AccountingError("That invoice or bill is no longer open", "not_found");
  const kind = line.amountMinor > 0 ? "receivable" : "payable";
  if (item.kind !== kind) throw new AccountingError(`Money ${line.amountMinor > 0 ? "in" : "out"} can only settle a ${kind}`);
  if (Math.abs(line.amountMinor) > item.outstandingMinor) throw new AccountingError(`The bank amount is more than the ${money(item.outstandingMinor)} still open on ${item.number}`);
  // Billing answers each key once, so matching the same line and item again (after a refusal or an undo) needs a new key.
  const base = `bank:${line.id}:${item.key}`;
  const used = new Set(await db.matchKeysFor(ctx.db, base));
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}:${n}`;
  const payload: BankMatched = {
    key,
    bankTxId: line.id,
    bankAccountRole: "bank",
    bankAccountCode: bank.accountCode,
    openItemKey: item.key,
    kind,
    amountMinor: Math.abs(line.amountMinor),
    currency: BOOK_CURRENCY,
    date: line.date,
    reference: line.reference ?? line.description.slice(0, 120),
    basis,
    matchedBy: { userId: actor.kind === "user" ? actor.userId : null, agentId: actor.kind === "agent" ? actor.agentId : null },
  };
  const moved = await db.setLineState(ctx.db, companyId, line.id, ["unreconciled"], {
    status: "matching",
    match: { kind: "open_item", key: item.key, number: item.number, basis, outboxKey: payload.key, by: actorRecord(actor) },
    journalId: null,
    note: `Sent to Billing to settle ${item.number}.`,
  });
  if (!moved) throw new AccountingError("This line changed; refresh and try again", "conflict");
  await enqueue(ctx, companyId, OPEN_ITEM_EVENTS.bankMatched, payload as unknown as { key: string } & Record<string, unknown>);
  return (await db.getBankLine(ctx.db, companyId, line.id))!;
}

async function linkJournal(ctx: PluginContext, companyId: string, line: db.BankLineRow, bank: db.BankAccountRow, journalId: string): Promise<db.BankLineRow> {
  const journal = await db.journalById(ctx.db, companyId, journalId);
  if (!journal) throw new AccountingError("Journal not found", "not_found");
  const effect = journal.lines.filter((l) => l.accountCode === bank.accountCode).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
  if (effect !== line.amountMinor) throw new AccountingError(`${journal.number} moves ${money(effect)} on this bank, the line is ${money(line.amountMinor)}`);
  const ok = await db.setLineState(ctx.db, companyId, line.id, ["unreconciled", "matching"], {
    status: "reconciled",
    match: { kind: "journal", journalId: journal.id, journalNumber: journal.number },
    journalId: journal.id,
    note: null,
  });
  if (!ok) throw new AccountingError("This line changed; refresh and try again", "conflict");
  return (await db.getBankLine(ctx.db, companyId, line.id))!;
}

export async function matchToJournal(ctx: PluginContext, companyId: string, actor: Actor, input: { lineId?: unknown; journalId?: unknown }): Promise<db.BankLineRow> {
  await assertMayAccept(ctx, companyId, actor, null);
  const { line, bank } = await requireLine(ctx, companyId, input.lineId);
  assertAgentMayTouchDate(actor, line);
  if (typeof input.journalId !== "string") throw new AccountingError("journalId is required");
  return linkJournal(ctx, companyId, line, bank, input.journalId);
}

export async function matchToOpenItem(ctx: PluginContext, companyId: string, actor: Actor, input: { lineId?: unknown; openItemKey?: unknown }): Promise<db.BankLineRow> {
  if (actor.kind !== "user") throw new AccountingError("Only a board user can match a line to an invoice or bill by hand", "forbidden");
  const { line, bank } = await requireLine(ctx, companyId, input.lineId);
  if (line.status !== "unreconciled") throw new AccountingError(`This line is already ${line.status}`, "conflict");
  if (typeof input.openItemKey !== "string") throw new AccountingError("openItemKey is required");
  return acceptOpenItem(ctx, companyId, actor, line, bank, input.openItemKey, "manual");
}

/** The lines of a category journal for a bank line (VAT split by the tax code). */
export function categoryLines(input: {
  amountMinor: number;
  bankCode: string;
  accountCode: string;
  taxCode: string | null;
  rateBps: number;
  memo: string;
  counterparty: string | null;
  lineId: string;
}): LedgerLine[] {
  const gross = Math.abs(input.amountMinor);
  const out = input.amountMinor < 0;
  const taxCode = (input.taxCode ?? null) as LedgerLine["taxCode"];
  const { netMinor, vatMinor } = taxCode ? splitVat(gross, input.rateBps) : { netMinor: gross, vatMinor: 0 };
  const dims = { bankLineId: input.lineId, ...(input.counterparty ? { counterparty: input.counterparty.slice(0, 120) } : {}) };
  const lines: LedgerLine[] = [];
  const bank: LedgerLine = { accountCode: input.bankCode, debitMinor: out ? 0 : gross, creditMinor: out ? gross : 0, memo: input.memo, dimensions: dims };
  const account: LedgerLine = {
    accountCode: input.accountCode,
    debitMinor: out ? netMinor : 0,
    creditMinor: out ? 0 : netMinor,
    memo: input.memo,
    taxCode,
    taxBaseMinor: taxCode ? netMinor : null,
    dimensions: dims,
  };
  lines.push(out ? account : bank);
  if (vatMinor > 0) {
    lines.push({
      role: out ? "vat_input" : "vat_output",
      debitMinor: out ? vatMinor : 0,
      creditMinor: out ? 0 : vatMinor,
      memo: `VAT on ${input.memo}`.slice(0, 200),
      taxCode,
      taxBaseMinor: netMinor,
      dimensions: dims,
    });
  }
  lines.push(out ? bank : account);
  return lines;
}

export async function categorise(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  input: { lineId?: unknown; accountCode?: unknown; taxCode?: unknown; memo?: unknown; counterparty?: unknown },
  alreadyChecked = false,
): Promise<db.BankLineRow> {
  if (!alreadyChecked) await assertMayAccept(ctx, companyId, actor, null);
  const { line, bank } = await requireLine(ctx, companyId, input.lineId);
  assertAgentMayTouchDate(actor, line);
  if (line.status !== "unreconciled") throw new AccountingError(`This line is already ${line.status}`, "conflict");
  const chart: Chart = await loadChart(ctx, companyId);
  const accountCode = typeof input.accountCode === "string" ? input.accountCode.trim() : "";
  const account = chart.byCode.get(accountCode);
  if (!account) throw new AccountingError(`Unknown account ${accountCode}`, "unknown_account");
  if (account.code === bank.accountCode) throw new AccountingError("Choose an account other than this bank's own account");
  const taxCode = typeof input.taxCode === "string" && input.taxCode ? input.taxCode : null;
  if (taxCode && !(taxCode in TAX_CODES)) throw new AccountingError(`Unknown tax code ${taxCode}`);
  const rates = await db.listTaxRates(ctx.db, companyId);
  const rate = taxCode ? rates.filter((r) => r.code === taxCode && r.effectiveFrom <= line.date && (!r.effectiveTo || r.effectiveTo >= line.date)).sort((a, b) => b.version - a.version)[0] : null;
  const rateBps = taxCode ? rate?.rateBps ?? Math.round((TAX_CODES[taxCode as keyof typeof TAX_CODES]?.rate ?? 0) * 10_000) : 0;
  const memo = (typeof input.memo === "string" && input.memo.trim() ? input.memo.trim() : line.description).slice(0, 200);
  const counterparty = typeof input.counterparty === "string" && input.counterparty.trim() ? input.counterparty.trim() : line.counterparty;
  const previous = await db.journalsWithSourcePrefix(ctx.db, companyId, `bank:${line.id}:category`);
  const { journal } = await postJournal(ctx, companyId, {
    sourceKey: `bank:${line.id}:category:${previous.length + 1}`,
    source: { plugin: "partnersinbiz.accounting", kind: "bank_line", id: line.id },
    kind: "bank",
    date: line.date,
    memo,
    lines: categoryLines({ amountMinor: line.amountMinor, bankCode: bank.accountCode, accountCode: account.code, taxCode, rateBps, memo, counterparty, lineId: line.id }),
    postedBy: actor,
  });
  const ok = await db.setLineState(ctx.db, companyId, line.id, ["unreconciled"], {
    status: "reconciled",
    match: { kind: "category", accountCode: account.code, taxCode, journalId: journal.id, journalNumber: journal.number, by: actorRecord(actor) },
    journalId: journal.id,
    note: null,
  });
  if (!ok) {
    // Someone else reconciled it meanwhile: undo our journal.
    await reverseJournal(ctx, companyId, journal.id, { postedBy: { kind: "system", reason: "Bank line changed while categorising" } });
    throw new AccountingError("This line changed; refresh and try again", "conflict");
  }
  // Teach Jev: a person chose a different account than it suggested.
  const jev = line.jev as { accountCode?: string; decisionIds?: Record<string, string> } | null;
  if (jev?.decisionIds?.account && jev.accountCode && jev.accountCode !== account.code) {
    await correctDecision(ctx, companyId, jev.decisionIds.account, account.code, actor.kind === "user" ? actor.userId : null).catch(() => false);
  }
  return (await db.getBankLine(ctx.db, companyId, line.id))!;
}

export async function excludeLine(ctx: PluginContext, companyId: string, actor: Actor, input: { lineId?: unknown; note?: unknown }): Promise<db.BankLineRow> {
  await assertMayAccept(ctx, companyId, actor, null);
  const { line } = await requireLine(ctx, companyId, input.lineId);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 300) : "";
  if (!note) throw new AccountingError("Say why this line is excluded (e.g. duplicate, not ours)");
  const ok = await db.setLineState(ctx.db, companyId, line.id, ["unreconciled"], { status: "excluded", match: { kind: "excluded", by: actorRecord(actor) }, journalId: null, note });
  if (!ok) throw new AccountingError(`This line is already ${line.status}`, "conflict");
  return (await db.getBankLine(ctx.db, companyId, line.id))!;
}

/** Undo a reconciliation on an unlocked line. A category journal is reversed. */
export async function undoLine(ctx: PluginContext, companyId: string, actor: Actor, input: { lineId?: unknown }): Promise<db.BankLineRow> {
  if (actor.kind !== "user") throw new AccountingError("Only a board user can undo a reconciled line", "forbidden");
  const { line } = await requireLine(ctx, companyId, input.lineId);
  const match = (line.match ?? {}) as { kind?: string; journalId?: string; outboxKey?: string };
  if (line.status === "matching") {
    const out = match.outboxKey ? await outboxStatus(ctx, match.outboxKey) : null;
    if (out && out.status === "pending") throw new AccountingError("Billing has not answered this match yet. Wait for it, or cancel the payment in Billing.", "conflict");
    // needs_review: Billing is waiting for a person; undoing here is safe (a later payment journal still reconciles the line).
    if (out && out.status === "done" && (out.result as { status?: string } | null)?.status !== "needs_review") {
      throw new AccountingError("Billing already recorded this payment. Reverse it in Billing first.", "conflict");
    }
  }
  if (line.status === "reconciled" && match.kind === "category" && match.journalId) {
    await reverseJournal(ctx, companyId, match.journalId, { postedBy: actor, memo: `Undo bank categorisation: ${line.description}`.slice(0, 200) });
  }
  if (line.status === "reconciled" && match.kind === "open_item") {
    throw new AccountingError("This line settled an invoice or bill in Billing. Reverse the payment there; its reversal un-reconciles the line.", "conflict");
  }
  const ok = await db.setLineState(ctx.db, companyId, line.id, ["reconciled", "excluded", "matching"], { status: "unreconciled", match: null, journalId: null, note: null });
  if (!ok) throw new AccountingError("Nothing to undo", "conflict");
  await refreshSuggestions(ctx, companyId, { lineIds: [line.id], useJev: false });
  return (await db.getBankLine(ctx.db, companyId, line.id))!;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function saveRule(ctx: PluginContext, companyId: string, input: Record<string, unknown>): Promise<BankRule> {
  const valid = validateRule(input);
  const chart = await loadChart(ctx, companyId);
  if (!chart.byCode.has(valid.accountCode)) throw new AccountingError(`Unknown account ${valid.accountCode}`, "unknown_account");
  const rule: BankRule = { id: typeof input.id === "string" && input.id ? input.id : newId(), ...valid };
  await db.upsertRule(ctx.db, companyId, rule);
  return rule;
}
