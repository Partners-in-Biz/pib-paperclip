/**
 * Bank lines Accounting matched to our open items (`bank.matched`).
 *
 * An exact match (amount and reference) for no more than what is owed
 * settles at once; anything else opens a review issue for a person and
 * answers `needs_review`. The answer (`bank.match.result`) is emitted every
 * time the match arrives, so Accounting's retries always get it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, formatMoneyMinor, OPEN_ITEM_EVENTS, PIB_PLUGINS, receiveOnce, type BankMatched, type BankMatchResult } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalance } from "./balances.js";
import type { BillingSettings } from "./config.js";
import { BillingError } from "./domain.js";
import { recordDecisionIssue } from "./pop.js";
import { billPaidMinor, getBill, settle, settleBill, unreconciledPayment } from "./settle.js";

export const BANK_MATCHED_EVENT = `plugin.${PIB_PLUGINS.accounting}.${OPEN_ITEM_EVENTS.bankMatched}` as const;

export type BankDecision =
  | { action: "settle"; reason: string }
  | { action: "review"; reason: string }
  | { action: "reject"; reason: string };

/**
 * Pure rule: settle an exact match, or a match a person confirmed in
 * Accounting, in the item's currency for no more than is owed. A bank line equal to a payment a person already recorded
 * (POP or manual) only reconciles that payment, so it is safe on an exact
 * or amount match.
 */
export function decideBankMatch(match: Pick<BankMatched, "basis" | "amountMinor" | "currency"> & { matchedBy?: BankMatched["matchedBy"] }, item: { outstandingMinor: number; currency: string; open: boolean; recordedPaymentMatches?: boolean }): BankDecision {
  if (!Number.isInteger(match.amountMinor) || match.amountMinor <= 0) return { action: "reject", reason: "The amount must be a positive integer in minor units" };
  if (item.recordedPaymentMatches && (match.basis === "exact" || match.basis === "amount") && (!match.currency || match.currency === item.currency)) {
    return { action: "settle", reason: "Matches a payment already recorded" };
  }
  if (!item.open) return { action: "review", reason: "The item is not open any more (already paid, cancelled or still a draft)" };
  if (match.currency && match.currency !== item.currency) return { action: "review", reason: `The bank line is in ${match.currency}, the item in ${item.currency}` };
  // A person who accepted the match in Accounting has already reviewed it; asking again only adds a bottleneck.
  const personConfirmed = Boolean(match.matchedBy?.userId);
  if (match.basis !== "exact" && !personConfirmed) return { action: "review", reason: match.basis === "amount" ? "Only the amount matched, not the reference" : "Matched in Accounting without a person confirming it" };
  if (match.amountMinor > item.outstandingMinor) return { action: "review", reason: "The bank line is more than what is owed (overpayment)" };
  return { action: "settle", reason: personConfirmed && match.basis !== "exact" ? "Confirmed by a person in Accounting" : "Exact match" };
}

export function parseOpenItemKey(key: string): { kind: "invoice" | "bill"; id: string } | null {
  const match = /^(invoice|bill):(.+)$/.exec(String(key ?? ""));
  return match ? { kind: match[1] as "invoice" | "bill", id: match[2]! } : null;
}

async function emitResult(ctx: PluginContext, companyId: string, result: BankMatchResult): Promise<void> {
  try {
    await ctx.events.emit(OPEN_ITEM_EVENTS.bankMatchResult, companyId, result);
  } catch (error) {
    ctx.logger.info("bank.match.result emit failed; Accounting will re-send the match", { key: result.key, error: error instanceof Error ? error.message : String(error) });
  }
}

async function openReview(ctx: PluginContext, companyId: string, match: BankMatched, label: string, reason: string, settings: BillingSettings): Promise<string | null> {
  try {
    const amount = formatMoneyMinor(match.amountMinor, match.currency || "ZAR");
    const issue = await createWorkIssue(ctx, {
      companyId,
      title: `Check bank ${match.kind === "payable" ? "payment" : "receipt"} of ${amount} for ${label}`,
      description: [
        `Accounting matched bank line ${match.bankTxId} (${match.date}${match.reference ? `, reference "${match.reference}"` : ""}) of ${amount} to ${label}.`,
        `It needs a person because: ${reason}.`,
        "",
        `Mark this issue done to record ${amount} against ${label}${match.kind === "receivable" ? " (anything above what is owed stays with the customer as credit)" : ""}.`,
        "Cancel this issue if the match is wrong; then fix it in Accounting.",
      ].join("\n"),
      originKind: `plugin:${PIB_PLUGINS.billing}`,
      originId: match.key,
      ...(settings.reviewerUserId ? { assigneeUserId: settings.reviewerUserId } : {}),
    });
    await recordDecisionIssue(ctx, { issueId: issue.id, companyId, kind: "bank_match", subjectKind: match.kind === "payable" ? "bill" : "invoice", subjectId: parseOpenItemKey(match.openItemKey)?.id ?? "", payload: match as unknown as Record<string, unknown> });
    return issue.id;
  } catch (error) {
    ctx.logger.info("Bank match review issue not opened", { key: match.key, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Settle a match (used by the exact path and by a person approving the review issue). */
export async function settleBankMatch(ctx: PluginContext, companyId: string, match: BankMatched, settings: BillingSettings, createdBy: string | null): Promise<{ paymentId: string; confirmedPopIds: string[] }> {
  const item = parseOpenItemKey(match.openItemKey);
  if (!item) throw new BillingError("Unknown open item");
  const common = {
    companyId,
    amountMinor: match.amountMinor,
    sourceKey: `bank:${match.bankTxId}`,
    source: "bank" as const,
    paidAt: match.date,
    method: "eft",
    reference: match.reference,
    bankTxId: match.bankTxId,
    bankAccountRole: match.bankAccountRole,
    bankAccountCode: match.bankAccountCode ?? null,
    createdBy,
  };
  if (item.kind === "invoice") {
    const result = await settle(ctx, { ...common, invoiceId: item.id }, settings);
    return { paymentId: result.paymentId, confirmedPopIds: result.confirmedPopIds };
  }
  const result = await settleBill(ctx, { ...common, billId: item.id }, settings);
  return { paymentId: result.paymentId, confirmedPopIds: [] };
}

/** Handler for `plugin.partnersinbiz.accounting.bank.matched`. Returns ids of POP issues to close. */
export async function onBankMatched(ctx: PluginContext, companyId: string, match: BankMatched, settings: BillingSettings): Promise<{ result: BankMatchResult; closePops: string[] }> {
  let closePops: string[] = [];
  if (!match?.key || !match.bankTxId || !match.openItemKey) {
    return { result: { key: String(match?.key ?? ""), status: "rejected", error: "The match is missing its key, bank line or open item" }, closePops };
  }
  const { result } = await receiveOnce<BankMatchResult & Record<string, unknown>>(ctx, companyId, BANK_MATCHED_EVENT, match.key, async () => {
    const item = parseOpenItemKey(match.openItemKey);
    if (!item) return { key: match.key, status: "rejected", error: `Unknown open item ${match.openItemKey}` };
    let label: string;
    let decision: BankDecision;
    if (item.kind === "invoice") {
      const balance = await invoiceBalance(ctx, item.id);
      if (!balance || balance.invoice.company_id !== companyId) return { key: match.key, status: "rejected", error: "Invoice was not found" };
      label = `invoice ${balance.invoice.number}`;
      const recorded = await unreconciledPayment(ctx, balance.invoice.id, match.amountMinor);
      decision = decideBankMatch(match, { outstandingMinor: balance.outstandingMinor, currency: balance.invoice.currency, open: balance.outstandingMinor > 0, recordedPaymentMatches: Boolean(recorded) });
    } else {
      const bill = await getBill(ctx, item.id);
      if (!bill || bill.company_id !== companyId) return { key: match.key, status: "rejected", error: "Bill was not found" };
      const outstanding = Math.max(0, Number(bill.total_minor) - (await billPaidMinor(ctx, bill.id)));
      label = `the bill from ${bill.supplier_name}`;
      decision = decideBankMatch(match, { outstandingMinor: outstanding, currency: bill.currency, open: bill.status === "approved" || bill.status === "partially_paid" });
    }
    if (decision.action === "reject") return { key: match.key, status: "rejected", error: decision.reason };
    if (decision.action === "settle") {
      const settled = await settleBankMatch(ctx, companyId, match, settings, "bank match");
      closePops = settled.confirmedPopIds;
      return { key: match.key, status: "settled", paymentId: settled.paymentId };
    }
    await openReview(ctx, companyId, match, label, decision.reason, settings);
    return { key: match.key, status: "needs_review", error: decision.reason };
  });
  await emitResult(ctx, companyId, result);
  return { result, closePops };
}

export async function emitBankMatchResult(ctx: PluginContext, companyId: string, result: BankMatchResult): Promise<void> {
  await emitResult(ctx, companyId, result);
}
