/**
 * Cut-over: import the opening trial balance at the cut-over date as one
 * opening journal. Open receivables and payables come from Billing's
 * projection; the preview compares them with the TB's AR and AP.
 *
 * A business that started on these books has nothing to bring over: a board
 * user says so once ("We started on these books", `skipCutover`), which
 * clears the opening-balances warning in the Cockpit and Setup. Posting
 * opening balances later undoes the skip.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { openingJournalLines, parseOpeningTb } from "../domain/cutover.js";
import { dayLabel } from "../domain/dates.js";
import { AccountingError, requireDate } from "../domain/util.js";
import { ensureBook, loadChart, roleAccount } from "./books.js";
import { actorRecord, BOOK_CURRENCY, newId, requireUser, type Actor } from "./common.js";
import { postJournal } from "./journals.js";

/** The opening journal when it is posted (not reversed), else null. */
async function postedOpening(ctx: PluginContext, companyId: string, book: db.BookRow) {
  if (!book.openingJournalId) return null;
  const journal = await db.journalById(ctx.db, companyId, book.openingJournalId);
  return journal && journal.status === "posted" ? journal : null;
}

/**
 * "We started on these books": there are no earlier books to bring over, so
 * balances start at zero. Board users only. Refused while opening balances
 * are posted. Returns the book.
 */
export async function skipCutover(ctx: PluginContext, companyId: string, actor: Actor): Promise<{ book: db.BookRow }> {
  requireUser(actor, "say the business started on these books");
  const book = await ensureBook(ctx, companyId);
  const opening = await postedOpening(ctx, companyId, book);
  if (opening) throw new AccountingError(`Opening balances are already posted (${opening.number}), so there is nothing to skip. To start from zero instead, reverse that journal under Journals first.`, "conflict");
  if (!book.cutoverSkippedAt) await db.setCutoverSkipped(ctx.db, companyId, actorRecord(actor));
  return { book: (await db.getBook(ctx.db, companyId))! };
}

/** Undo "We started on these books" (board users only). Returns the book. */
export async function undoSkipCutover(ctx: PluginContext, companyId: string, actor: Actor): Promise<{ book: db.BookRow }> {
  requireUser(actor, "undo \"We started on these books\"");
  await ensureBook(ctx, companyId);
  await db.clearCutoverSkipped(ctx.db, companyId);
  return { book: (await db.getBook(ctx.db, companyId))! };
}

export async function previewCutover(ctx: PluginContext, companyId: string, input: { csv?: unknown }) {
  await ensureBook(ctx, companyId);
  if (typeof input.csv !== "string" || !input.csv.trim()) throw new AccountingError("Paste or upload the opening trial balance (CSV)");
  if (input.csv.length > 1_000_000) throw new AccountingError("The trial balance file is too large (1 MB max)");
  const tb = parseOpeningTb(input.csv);
  const chart = await loadChart(ctx, companyId);
  const unknown = tb.lines.filter((l) => !chart.byCode.has(l.code)).map((l) => l.code);
  const inactive = tb.lines.filter((l) => chart.byCode.get(l.code)?.active === false).map((l) => l.code);
  const ar = roleAccount(chart, "ar");
  const ap = roleAccount(chart, "ap");
  const [receivables, payables] = await Promise.all([
    db.listOpenItems(ctx.db, companyId, { kind: "receivable", currency: BOOK_CURRENCY }),
    db.listOpenItems(ctx.db, companyId, { kind: "payable", currency: BOOK_CURRENCY }),
  ]);
  const tbAr = tb.lines.filter((l) => l.code === ar?.code).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
  const tbAp = tb.lines.filter((l) => l.code === ap?.code).reduce((s, l) => s + l.creditMinor - l.debitMinor, 0);
  const book = await db.getBook(ctx.db, companyId);
  return {
    lines: tb.lines.map((l) => ({ ...l, accountName: chart.byCode.get(l.code)?.name ?? null })),
    totalDebitMinor: tb.totalDebitMinor,
    totalCreditMinor: tb.totalCreditMinor,
    differenceMinor: tb.differenceMinor,
    balanced: tb.differenceMinor === 0,
    unknownCodes: unknown,
    inactiveCodes: inactive,
    checks: {
      receivables: { trialBalanceMinor: tbAr, openItemsMinor: receivables.reduce((s, i) => s + i.outstandingMinor, 0), count: receivables.length },
      payables: { trialBalanceMinor: tbAp, openItemsMinor: payables.reduce((s, i) => s + i.outstandingMinor, 0), count: payables.length },
    },
    existingOpeningJournalId: book?.openingJournalId ?? null,
  };
}

export async function postCutover(ctx: PluginContext, companyId: string, actor: Actor, input: { csv?: unknown; date?: unknown; balanceToEquity?: unknown }) {
  requireUser(actor, "post opening balances");
  const date = requireDate(input.date, "date");
  const preview = await previewCutover(ctx, companyId, input);
  if (preview.unknownCodes.length) throw new AccountingError(`Add these accounts to the chart first: ${preview.unknownCodes.join(", ")}`, "unknown_account");
  const book = await ensureBook(ctx, companyId);
  const current = await postedOpening(ctx, companyId, book);
  if (current) throw new AccountingError(`Opening balances are already posted (${current.number}). Reverse that journal first to post new ones.`, "conflict");
  const chart = await loadChart(ctx, companyId);
  const obe = roleAccount(chart, "opening_balance_equity");
  if (!obe) throw new AccountingError("Map the Opening balance equity role under Chart & roles first", "unknown_role");
  const lines = openingJournalLines(parseOpeningTb(String(input.csv)), obe.code, input.balanceToEquity === true);
  const { journal } = await postJournal(ctx, companyId, {
    sourceKey: `cutover:${newId()}`,
    source: { plugin: "partnersinbiz.accounting", kind: "opening_balances", id: date },
    kind: "opening",
    date,
    memo: `Opening balances at ${dayLabel(date)}`,
    lines,
    postedBy: actor,
    allowSoftClosed: true,
  });
  await db.setCutover(ctx.db, companyId, date, journal.id);
  // Opening balances after all: the business did have earlier books.
  await db.clearCutoverSkipped(ctx.db, companyId);
  return { journal, preview };
}
