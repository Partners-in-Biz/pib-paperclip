/**
 * Posting. Every journal goes through `postJournal`: validate and balance,
 * map roles to accounts, check the period (open / soft-closed / closed) and
 * VAT lock, convert to ZAR, number it (JNL-000123) and chain its hash to the
 * previous journal, then insert it as one row.
 *
 * Numbering is single-statement safe: seq = last + 1 read inside a
 * per-company lock, and a unique (company_id, seq) index turns any race into
 * an error that is retried with the next number. A repeated source key hits
 * ON CONFLICT (company_id, source_key) DO NOTHING and returns the journal
 * already posted, so postings are idempotent.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { LedgerLine } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import {
  bankTxIds,
  convertToBook,
  GENESIS_HASH,
  journalHash,
  journalNumber,
  resolveLines,
  reverseLines,
  totalDebit,
  validatePostingInput,
  verifyChain,
  type ChainCheck,
  type Journal,
  type JournalKind,
  type JournalLine,
  type JournalSource,
} from "../domain/journal.js";
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { AccountingError, formatRand, isIsoDate, monthOf, todayIso } from "../domain/util.js";
import { ensureBook, loadChart, roleAccount } from "./books.js";
import { actorRecord, BOOK_CURRENCY, closeIssue, commentOn, errorMessage, newId, ORIGIN, requireUser, withLock, type Actor } from "./common.js";

export interface PostInput {
  sourceKey: string;
  source: JournalSource;
  kind: JournalKind;
  date: string;
  memo: string;
  currency?: string | null;
  fxRate?: number | null;
  /** Lines by role or account code (from senders and people). */
  lines?: LedgerLine[];
  /** Lines already resolved to accounts in the book currency (reversals). */
  resolved?: JournalLine[];
  reversesId?: string | null;
  postedBy: Actor;
  /** Manual (approved) journals and reversals may post into a soft-closed period. */
  allowSoftClosed?: boolean;
}

export interface PostResult {
  journal: Journal;
  created: boolean;
}

/** Reject postings dated in a closed period or a locked VAT period. */
export async function assertPostable(ctx: PluginContext, companyId: string, date: string, allowSoftClosed: boolean): Promise<void> {
  const period = monthOf(date);
  const status = await db.periodStatus(ctx.db, companyId, period);
  if (status === "closed") throw new AccountingError(`The period ${period} is closed. Reopen it under Accounting → Journals → Periods, or post with a date in an open period.`, "closed_period");
  if (status === "soft_closed" && !allowSoftClosed) {
    throw new AccountingError(`The period ${period} is soft-closed. Only approved manual journals and reversals may post into it.`, "closed_period");
  }
  const locked = await db.lockedVatPeriodFor(ctx.db, companyId, date);
  if (locked) throw new AccountingError(`The VAT period ${locked.start} to ${locked.end} is locked (return approved). Post with a later date.`, "vat_locked");
}

function isSeqClash(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("journals_seq") || (message.includes("duplicate key") && !message.includes("journals_source"));
}

export async function postJournal(ctx: PluginContext, companyId: string, input: PostInput): Promise<PostResult> {
  const sourceKey = input.sourceKey.trim();
  if (!sourceKey || sourceKey.length > 300) throw new AccountingError("sourceKey is required (at most 300 characters)");
  const existing = await db.journalBySourceKey(ctx.db, companyId, sourceKey);
  if (existing) return { journal: existing, created: false };

  const book = await ensureBook(ctx, companyId);
  const currency = (input.currency || book.currency || BOOK_CURRENCY).toUpperCase();
  let lines: JournalLine[];
  let fxRate: number | null = null;
  if (input.resolved) {
    if (!isIsoDate(input.date)) throw new AccountingError("date must be a real date written YYYY-MM-DD");
    lines = input.resolved;
    fxRate = input.fxRate ?? null;
    const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
    const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
    if (lines.length < 2 || debit !== credit || debit <= 0) throw new AccountingError("The journal does not balance", "unbalanced");
  } else {
    const candidate = { date: input.date, lines: input.lines ?? [], currency, memo: input.memo };
    validatePostingInput(candidate);
    const chart = await loadChart(ctx, companyId);
    const resolved = resolveLines(candidate.lines, chart);
    const rounding = roleAccount(chart, "rounding");
    const converted = convertToBook(resolved, {
      currency,
      bookCurrency: book.currency,
      fxRate: input.fxRate,
      rounding: rounding ? { accountId: rounding.id, accountCode: rounding.code } : null,
    });
    lines = converted.lines;
    fxRate = converted.fxRate;
  }
  await assertPostable(ctx, companyId, input.date, Boolean(input.allowSoftClosed));

  return withLock(`journal:${companyId}`, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const again = await db.journalBySourceKey(ctx.db, companyId, sourceKey);
      if (again) return { journal: again, created: false };
      const last = await db.lastJournal(ctx.db, companyId);
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? GENESIS_HASH;
      const content = {
        companyId,
        seq,
        number: journalNumber(seq),
        date: input.date,
        memo: (input.memo ?? "").slice(0, 500),
        kind: input.kind,
        currency,
        fxRate,
        bookCurrency: book.currency,
        sourceKey,
        source: { plugin: String(input.source.plugin ?? ""), kind: String(input.source.kind ?? ""), id: String(input.source.id ?? "") },
        lines,
        reversesId: input.reversesId ?? null,
        prevHash,
      };
      const journal: Journal = {
        ...content,
        id: newId(),
        status: "posted",
        reversedById: null,
        totalMinor: totalDebit(lines),
        postedBy: actorRecord(input.postedBy),
        hash: journalHash(content),
      };
      try {
        const inserted = await db.insertJournal(ctx.db, journal);
        if (!inserted) {
          const winner = await db.journalBySourceKey(ctx.db, companyId, sourceKey);
          if (winner) return { journal: winner, created: false };
          continue;
        }
      } catch (error) {
        if (isSeqClash(error) && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 80));
          continue;
        }
        throw error;
      }
      if (journal.reversesId) await db.markReversed(ctx.db, companyId, journal.reversesId, journal.id);
      await linkBankLines(ctx, companyId, journal).catch((error) =>
        ctx.logger.info("Bank line link after posting failed", { journalId: journal.id, error: errorMessage(error) }),
      );
      return { journal, created: true };
    }
    throw new AccountingError("Could not number the journal; try again", "conflict");
  });
}

/**
 * A payment journal from Billing carries the bank line id in
 * dimensions.bankTxId. When it arrives, the waiting bank line is reconciled
 * against it (if the journal touches that bank's account).
 */
export async function linkBankLines(ctx: PluginContext, companyId: string, journal: Journal): Promise<number> {
  const ids = bankTxIds(journal.lines);
  if (ids.length === 0) return 0;
  let linked = 0;
  for (const id of ids) {
    const line = await db.getBankLine(ctx.db, companyId, id);
    if (!line || line.status === "reconciled" || line.status === "excluded") continue;
    const bank = await db.getBankAccount(ctx.db, companyId, line.bankAccountId);
    const touches = bank ? journal.lines.some((l) => l.accountCode === bank.accountCode) : false;
    if (!touches) {
      await db.setLineState(ctx.db, companyId, id, ["unreconciled", "matching"], {
        status: line.status,
        match: line.match,
        journalId: null,
        note: `${journal.number} names this line but posts to another bank account. Check it, then match by hand.`,
      });
      continue;
    }
    const ok = await db.setLineState(ctx.db, companyId, id, ["unreconciled", "matching"], {
      status: "reconciled",
      match: { ...(line.match ?? {}), journalId: journal.id, journalNumber: journal.number, via: "payment journal" },
      journalId: journal.id,
      note: null,
    });
    if (ok) linked += 1;
  }
  return linked;
}

export async function reverseJournal(
  ctx: PluginContext,
  companyId: string,
  journalId: string,
  input: { date?: string | null; memo?: string | null; sourceKey?: string | null; source?: JournalSource | null; postedBy: Actor },
): Promise<PostResult> {
  const original = await db.journalById(ctx.db, companyId, journalId);
  if (!original) throw new AccountingError("Journal not found", "not_found");
  const earlier = await db.reversalOf(ctx.db, companyId, original.id);
  if (earlier) return { journal: earlier, created: false };
  if (original.reversesId) throw new AccountingError(`${original.number} is itself a reversal. Post a new journal instead.`, "conflict");
  let date = input.date && isIsoDate(input.date) ? input.date : original.date;
  if (!input.date) {
    // Default: the original date when its period is still open, else today.
    try {
      await assertPostable(ctx, companyId, date, true);
    } catch {
      date = todayIso();
    }
  }
  return postJournal(ctx, companyId, {
    sourceKey: input.sourceKey || `reverse:${original.sourceKey}`,
    source: input.source ?? { ...original.source, kind: original.source.kind || original.kind },
    kind: "reversal",
    date,
    memo: input.memo || `Reversal of ${original.number}${original.memo ? `: ${original.memo}` : ""}`,
    currency: original.currency,
    fxRate: original.fxRate,
    resolved: reverseLines(original.lines),
    reversesId: original.id,
    postedBy: input.postedBy,
    allowSoftClosed: true,
  });
}

// ---------------------------------------------------------------------------
// Audit chain
// ---------------------------------------------------------------------------

export async function verifyJournalChain(ctx: PluginContext, companyId: string): Promise<ChainCheck & { total: number }> {
  let after = 0;
  let prev = GENESIS_HASH;
  let checked = 0;
  for (let page = 0; page < 1000; page += 1) {
    const batch = await db.journalsForChain(ctx.db, companyId, after, 500);
    if (batch.length === 0) break;
    const result = verifyChain(batch, prev, after + 1);
    checked += result.checked;
    if (!result.ok) return { ...result, checked, total: checked };
    prev = result.lastHash;
    after = batch[batch.length - 1]!.seq;
  }
  return { ok: true, checked, firstBadSeq: null, problem: null, lastHash: prev, total: checked };
}

// ---------------------------------------------------------------------------
// Manual journals: draft → approval issue → post
// ---------------------------------------------------------------------------

export interface DraftInput {
  id?: string | null;
  date: unknown;
  memo?: unknown;
  currency?: unknown;
  fxRate?: unknown;
  lines: unknown;
}

function draftLines(raw: unknown): LedgerLine[] {
  if (!Array.isArray(raw)) throw new AccountingError("lines must be a list");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") throw new AccountingError(`Line ${i + 1} must be an object`);
    const l = item as Record<string, unknown>;
    const debit = l.debitMinor == null || l.debitMinor === "" ? 0 : Number(l.debitMinor);
    const credit = l.creditMinor == null || l.creditMinor === "" ? 0 : Number(l.creditMinor);
    return {
      accountCode: typeof l.accountCode === "string" && l.accountCode.trim() ? l.accountCode.trim() : undefined,
      role: typeof l.role === "string" && l.role.trim() && !l.accountCode ? (l.role.trim() as LedgerLine["role"]) : undefined,
      debitMinor: debit,
      creditMinor: credit,
      memo: typeof l.memo === "string" ? l.memo.slice(0, 200) : null,
      taxCode: typeof l.taxCode === "string" && l.taxCode ? (l.taxCode as LedgerLine["taxCode"]) : null,
      taxBaseMinor: l.taxBaseMinor == null || l.taxBaseMinor === "" ? null : Number(l.taxBaseMinor),
      clientKind: l.clientKind === "company" || l.clientKind === "contact" ? l.clientKind : null,
      clientRef: typeof l.clientRef === "string" && l.clientRef ? l.clientRef : null,
    } as LedgerLine;
  });
}

/** Validate a manual journal against the chart without posting it. */
async function checkDraft(ctx: PluginContext, companyId: string, input: DraftInput) {
  const lines = draftLines(input.lines);
  const currency = typeof input.currency === "string" && input.currency ? input.currency.toUpperCase() : BOOK_CURRENCY;
  const fxRate = input.fxRate == null || input.fxRate === "" ? null : Number(input.fxRate);
  const candidate = { date: input.date, lines, currency, memo: typeof input.memo === "string" ? input.memo : "" };
  validatePostingInput(candidate);
  const chart = await loadChart(ctx, companyId);
  resolveLines(candidate.lines, chart);
  if (currency !== BOOK_CURRENCY && !(fxRate && fxRate > 0)) throw new AccountingError("Give the exchange rate for a foreign-currency journal", "fx_rate_required");
  return { date: candidate.date, memo: candidate.memo.slice(0, 500), currency, fxRate, lines };
}

export async function saveDraft(ctx: PluginContext, companyId: string, input: DraftInput, actor: Actor): Promise<db.DraftRow> {
  await ensureBook(ctx, companyId);
  const checked = await checkDraft(ctx, companyId, input);
  if (input.id) {
    const current = await db.getDraft(ctx.db, companyId, input.id);
    if (!current) throw new AccountingError("Draft not found", "not_found");
    if (current.status !== "draft") throw new AccountingError("Only a draft can be edited. Cancel the approval request first.", "conflict");
    await db.updateDraftContent(ctx.db, companyId, input.id, { ...checked, lines: checked.lines });
    return (await db.getDraft(ctx.db, companyId, input.id))!;
  }
  const draft: db.DraftRow = {
    id: newId(),
    companyId,
    date: checked.date,
    memo: checked.memo,
    currency: checked.currency,
    fxRate: checked.fxRate,
    lines: checked.lines as unknown as Array<Record<string, unknown>>,
    status: "draft",
    approvalIssueId: null,
    createdBy: actorRecord(actor),
    approvedBy: null,
    journalId: null,
    error: null,
    createdAt: null,
  };
  await db.insertDraft(ctx.db, draft);
  return draft;
}

function draftSummary(d: db.DraftRow): string {
  const rows = d.lines
    .map((l) => `| ${String(l.accountCode ?? l.role ?? "")} | ${l.memo ?? ""} | ${Number(l.debitMinor) ? formatRand(Number(l.debitMinor)) : ""} | ${Number(l.creditMinor) ? formatRand(Number(l.creditMinor)) : ""} |`)
    .join("\n");
  return `| Account | Memo | Debit | Credit |\n|---|---|---:|---:|\n${rows}`;
}

export async function requestDraftApproval(ctx: PluginContext, companyId: string, draftId: string, actor: Actor): Promise<db.DraftRow> {
  const draft = await db.getDraft(ctx.db, companyId, draftId);
  if (!draft) throw new AccountingError("Draft not found", "not_found");
  if (draft.status !== "draft") throw new AccountingError("Approval was already requested for this journal", "conflict");
  await checkDraft(ctx, companyId, draft);
  const total = draft.lines.reduce((s, l) => s + Number(l.debitMinor ?? 0), 0);
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve journal: ${draft.memo || "manual journal"} (${formatRand(total)})`,
    description: [
      `A manual journal dated ${draft.date} is waiting for approval. It was prepared by ${actor.kind === "agent" ? "an agent" : "a board user"}.`,
      "",
      draftSummary(draft),
      "",
      "To approve, open **Accounting → Journals → Drafts** and click **Approve and post**, or mark this issue done yourself (a person must do it; an agent marking it done does not count).",
      "To refuse it, cancel this issue.",
    ].join("\n"),
    originKind: ORIGIN,
    originId: `draft:${draft.id}`,
    wake: false,
  });
  await db.setDraftStatus(ctx.db, companyId, draft.id, ["draft"], { status: "pending_approval", approvalIssueId: issue.id, error: null });
  return (await db.getDraft(ctx.db, companyId, draft.id))!;
}

/** A person approves: the draft posts as a manual journal. */
export async function approveDraft(ctx: PluginContext, companyId: string, draftId: string, actor: Actor, via: "page" | "issue" = "page"): Promise<{ draft: db.DraftRow; journal: Journal | null }> {
  const userId = requireUser(actor, "approve a journal");
  const draft = await db.getDraft(ctx.db, companyId, draftId);
  if (!draft) throw new AccountingError("Draft not found", "not_found");
  if (draft.status === "posted" && draft.journalId) return { draft, journal: await db.journalById(ctx.db, companyId, draft.journalId) };
  if (draft.status === "draft") throw new AccountingError("Request approval first. A manual journal posts only after its approval issue.", "conflict");
  if (draft.status !== "pending_approval") throw new AccountingError(`This journal is ${draft.status}`, "conflict");
  try {
    const { journal } = await postJournal(ctx, companyId, {
      sourceKey: `manual:${draft.id}`,
      source: { plugin: "partnersinbiz.accounting", kind: "manual_journal", id: draft.id },
      kind: "manual",
      date: draft.date,
      memo: draft.memo,
      currency: draft.currency,
      fxRate: draft.fxRate,
      lines: draft.lines as unknown as LedgerLine[],
      postedBy: actor,
      allowSoftClosed: true,
    });
    await db.setDraftStatus(ctx.db, companyId, draft.id, ["draft", "pending_approval"], { status: "posted", approvedBy: userId, journalId: journal.id, error: null });
    if (via === "page") await closeIssue(ctx, companyId, draft.approvalIssueId, "done", `Approved and posted as ${journal.number}.`);
    else if (draft.approvalIssueId) await commentOn(ctx, companyId, draft.approvalIssueId, `Posted as ${journal.number}.`);
    return { draft: (await db.getDraft(ctx.db, companyId, draft.id))!, journal };
  } catch (error) {
    const message = errorMessage(error);
    await db.setDraftStatus(ctx.db, companyId, draft.id, ["draft", "pending_approval"], { status: "draft", error: message });
    if (draft.approvalIssueId) await commentOn(ctx, companyId, draft.approvalIssueId, `Could not post: ${message}. The journal is back in draft; fix it and request approval again.`);
    throw error;
  }
}

export async function cancelDraft(ctx: PluginContext, companyId: string, draftId: string, reason: string | null): Promise<db.DraftRow> {
  const draft = await db.getDraft(ctx.db, companyId, draftId);
  if (!draft) throw new AccountingError("Draft not found", "not_found");
  if (draft.status === "posted") throw new AccountingError("A posted journal cannot be cancelled; reverse it instead.", "conflict");
  await db.setDraftStatus(ctx.db, companyId, draft.id, ["draft", "pending_approval", "rejected"], { status: "cancelled", error: reason });
  await closeIssue(ctx, companyId, draft.approvalIssueId, "cancelled", reason ? `Cancelled: ${reason}` : "Cancelled.");
  return (await db.getDraft(ctx.db, companyId, draft.id))!;
}

/**
 * Approval by issue: a person marking the approval issue done posts the
 * journal; cancelling it cancels the draft. Agents marking it done do not
 * count (the plugin comments instead).
 */
export async function onDraftIssue(ctx: PluginContext, companyId: string, draft: db.DraftRow, issueStatusValue: string, actor: { type?: string; id?: string }): Promise<void> {
  if (draft.status !== "pending_approval") return;
  if (issueStatusValue === "cancelled") {
    await db.setDraftStatus(ctx.db, companyId, draft.id, ["pending_approval"], { status: "cancelled", error: "Approval issue cancelled" });
    return;
  }
  if (issueStatusValue !== "done") return;
  if (actor.type === "user" && actor.id) {
    await approveDraft(ctx, companyId, draft.id, { kind: "user", userId: actor.id }, "issue").catch(() => undefined);
    return;
  }
  if (draft.approvalIssueId) {
    await commentOn(ctx, companyId, draft.approvalIssueId, "This issue was closed without a person's approval, so the journal was not posted. A board user can approve it in Accounting → Journals → Drafts.");
  }
}

export { draftLines as parseDraftLines };
