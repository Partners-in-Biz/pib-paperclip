/**
 * Bank reconciliation for one bank account and statement period.
 *
 * - Statement check: opening + every line in the period must equal the
 *   statement's closing balance (difference 0), so no line is missing.
 * - Every line in the period is reconciled (matched to a journal) or
 *   excluded (with a note).
 * - The ledger balance of the bank's chart account at the period end is
 *   shown next to the statement balance; a gap there means journals on the
 *   bank account that no statement line explains.
 */
export type BankLineStatus = "unreconciled" | "matching" | "reconciled" | "excluded";

export interface ReconciliationSummary {
  openingMinor: number;
  closingMinor: number;
  linesTotalMinor: number;
  computedClosingMinor: number;
  differenceMinor: number;
  unreconciledCount: number;
  glBalanceMinor: number;
  glDifferenceMinor: number;
  ready: boolean;
  blockers: string[];
}

export function reconciliationSummary(input: {
  openingMinor: number;
  closingMinor: number;
  lines: Array<{ amountMinor: number; status: BankLineStatus }>;
  glBalanceMinor: number;
}): ReconciliationSummary {
  const linesTotalMinor = input.lines.reduce((s, l) => s + l.amountMinor, 0);
  const computedClosingMinor = input.openingMinor + linesTotalMinor;
  const differenceMinor = input.closingMinor - computedClosingMinor;
  const unreconciledCount = input.lines.filter((l) => l.status === "unreconciled" || l.status === "matching").length;
  const blockers: string[] = [];
  if (differenceMinor !== 0) blockers.push("Opening balance plus the statement lines does not equal the closing balance. A line may be missing, or the balances are wrong.");
  if (unreconciledCount > 0) blockers.push(`${unreconciledCount} line${unreconciledCount === 1 ? " is" : "s are"} not reconciled yet.`);
  return {
    openingMinor: input.openingMinor,
    closingMinor: input.closingMinor,
    linesTotalMinor,
    computedClosingMinor,
    differenceMinor,
    unreconciledCount,
    glBalanceMinor: input.glBalanceMinor,
    glDifferenceMinor: input.closingMinor - input.glBalanceMinor,
    ready: blockers.length === 0,
    blockers,
  };
}
