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
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  amountBucket,
  confidenceOf,
  correctDecision,
  createWorkIssue,
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
import { fingerprintLines, parseStatement, type StatementFormat } from "../domain/statements.js";
import { AccountingError, addDays, formatRand } from "../domain/util.js";
import { ensureBook, loadChart, type Chart } from "./books.js";
import {
  actorRecord,
  assertOwnKey,
  BOOK_CURRENCY,
  errorMessage,
  newId,
  ORIGIN,
  privateR2,
  r2Url,
  readSettings,
  safeFileName,
  type Actor,
} from "./common.js";
import { postJournal, reverseJournal } from "./journals.js";

const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const MAX_JEV_LINES = 150;

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

async function statementText(ctx: PluginContext, companyId: string, input: { content?: unknown; objectKey?: unknown }): Promise<{ text: string; objectKey: string | null }> {
  if (typeof input.content === "string" && input.content.trim()) {
    if (input.content.length > 1_000_000) throw new AccountingError("Files over 1 MB must be uploaded to the private bucket first");
    return { text: input.content, objectKey: null };
  }
  const key = typeof input.objectKey === "string" ? input.objectKey : "";
  if (!key) throw new AccountingError("Give the statement content or the uploaded file's key");
  const cfg = await privateR2(ctx, companyId);
  if (!cfg) throw new AccountingError("The private R2 bucket is not set up", "not_configured");
  assertOwnKey(cfg, companyId, key);
  const res = await fetch(r2Url(cfg, "GET", key, 300));
  if (!res.ok) throw new AccountingError(`Could not read the uploaded file (HTTP ${res.status})`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_STATEMENT_BYTES) throw new AccountingError("Statement files can be at most 10 MB");
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (text.includes("�")) text = new TextDecoder("latin1").decode(buffer);
  return { text, objectKey: key };
}

export interface ImportResult {
  statementId: string | null;
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
}

export async function importStatement(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  input: { bankAccountId?: unknown; content?: unknown; objectKey?: unknown; fileName?: unknown; format?: unknown },
): Promise<ImportResult> {
  await ensureBook(ctx, companyId);
  const bankAccountId = typeof input.bankAccountId === "string" ? input.bankAccountId : "";
  const bank = bankAccountId ? await db.getBankAccount(ctx.db, companyId, bankAccountId) : null;
  if (!bank) throw new AccountingError("Choose the bank account this statement belongs to", "not_found");
  const { text, objectKey } = await statementText(ctx, companyId, input);
  const format = ["csv", "ofx", "mt940"].includes(String(input.format)) ? (String(input.format) as StatementFormat) : "auto";
  const parsed = parseStatement(text, format);
  const seen = await db.statementByDigest(ctx.db, bank.id, parsed.digest);
  if (seen) {
    return {
      statementId: seen.id,
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
  let issueId: string | null = null;
  if (added > 0) issueId = await openReconcileIssue(ctx, companyId, bank, added, parsed.periodStart, parsed.periodEnd);
  return {
    statementId,
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
  };
}

/** When a Bookkeeper is linked, hand it the new lines. Set by the worker (agent.ts). */
let bookkeeperLookup: ((ctx: PluginContext, companyId: string) => Promise<{ id: string; status: string } | null>) | null = null;
export function setBookkeeperLookup(fn: typeof bookkeeperLookup): void {
  bookkeeperLookup = fn;
}

async function openReconcileIssue(ctx: PluginContext, companyId: string, bank: db.BankAccountRow, added: number, start: string | null, end: string | null): Promise<string | null> {
  const agent = bookkeeperLookup ? await bookkeeperLookup(ctx, companyId).catch(() => null) : null;
  if (!agent) return null;
  try {
    const issue = await createWorkIssue(ctx, {
      companyId,
      title: `Reconcile ${added} new bank line${added === 1 ? "" : "s"} (${bank.name})`,
      description: [
        `A statement for **${bank.name}** (${start ?? "?"} to ${end ?? "?"}) added ${added} line${added === 1 ? "" : "s"}.`,
        "",
        "Follow the `pib-bookkeeping` skill: review the suggestions with `list-bank-lines`, accept the safe ones, categorise the rest, and leave anything you are unsure about for a person with a comment here.",
      ].join("\n"),
      assigneeAgentId: agent.id,
      originKind: ORIGIN,
      originId: `reconcile:${bank.id}:${end ?? "?"}`,
      wake: !["paused", "pending_approval", "terminated"].includes(agent.status),
      wakeReason: "New bank lines to reconcile",
    });
    return issue.id;
  } catch (error) {
    ctx.logger.info("Reconcile issue skipped", { companyId, error: errorMessage(error) });
    return null;
  }
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
  const [items, rules, banks] = await Promise.all([
    db.listOpenItems(ctx.db, companyId, { currency: BOOK_CURRENCY }),
    db.listRules(ctx.db, companyId),
    db.listBankAccounts(ctx.db, companyId),
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
    const suggestions = suggestFor(line, { items: openItems, journals: journalsByBank.get(line.bankAccountId) ?? [], rules, bookCurrency: BOOK_CURRENCY });
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
  if (Math.abs(line.amountMinor) > item.outstandingMinor) throw new AccountingError(`The bank amount is more than the ${formatRand(item.outstandingMinor)} still open on ${item.number}`);
  const payload: BankMatched = {
    key: `bank:${line.id}:${item.key}`,
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
  if (effect !== line.amountMinor) throw new AccountingError(`${journal.number} moves ${formatRand(effect)} on this bank, the line is ${formatRand(line.amountMinor)}`);
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
