/**
 * Fixed assets: straight-line depreciation by whole months, starting with
 * the month depreciation starts. Month k's charge is
 * round(base × k / life) − round(base × (k − 1) / life), so the charges add
 * up to exactly cost − residual with no leftover cents.
 */
import { AccountingError, addMonths, isIsoDate, monthOf } from "./util.js";

export interface AssetLike {
  id: string;
  name: string;
  costMinor: number;
  residualMinor: number;
  lifeMonths: number;
  depreciationStart: string;
  /** Months up to and including this one were depreciated before cut-over (not posted here). */
  openingThrough: string | null;
  status: "active" | "disposed";
  disposedDate: string | null;
}

export interface ScheduleRow {
  month: string;
  amountMinor: number;
  accumulatedMinor: number;
  bookValueMinor: number;
}

export function validateAsset(input: Record<string, unknown>) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new AccountingError("Asset name is required");
  const cost = Number(input.costMinor);
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new AccountingError("Cost must be more than 0 cents");
  const residual = input.residualMinor == null || input.residualMinor === "" ? 0 : Number(input.residualMinor);
  if (!Number.isSafeInteger(residual) || residual < 0 || residual > cost) throw new AccountingError("Residual value must be between 0 and the cost");
  const life = Number(input.lifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 600) throw new AccountingError("Useful life must be 1–600 months");
  if (!isIsoDate(input.acquiredDate)) throw new AccountingError("Acquired date must be YYYY-MM-DD");
  const start = input.depreciationStart ? String(input.depreciationStart) : String(input.acquiredDate);
  if (!isIsoDate(start)) throw new AccountingError("Depreciation start must be YYYY-MM-DD");
  const openingThrough = typeof input.openingThrough === "string" && input.openingThrough ? input.openingThrough : null;
  if (openingThrough && !/^\d{4}-\d{2}$/.test(openingThrough)) throw new AccountingError("Opening depreciation month must be YYYY-MM");
  const openingAccumulated = input.openingAccumulatedMinor == null || input.openingAccumulatedMinor === "" ? 0 : Number(input.openingAccumulatedMinor);
  if (!Number.isSafeInteger(openingAccumulated) || openingAccumulated < 0) throw new AccountingError("Opening accumulated depreciation must be whole cents");
  return {
    name: name.slice(0, 120),
    category: typeof input.category === "string" ? input.category.trim().slice(0, 60) : "",
    costMinor: cost,
    residualMinor: residual,
    lifeMonths: life,
    acquiredDate: String(input.acquiredDate),
    depreciationStart: start,
    openingThrough,
    openingAccumulatedMinor: openingAccumulated,
  };
}

export function depreciationSchedule(asset: Pick<AssetLike, "costMinor" | "residualMinor" | "lifeMonths" | "depreciationStart">): ScheduleRow[] {
  const base = asset.costMinor - asset.residualMinor;
  const first = monthOf(asset.depreciationStart);
  const rows: ScheduleRow[] = [];
  let prev = 0;
  for (let k = 1; k <= asset.lifeMonths; k += 1) {
    const cumulative = Math.round((base * k) / asset.lifeMonths);
    const amount = cumulative - prev;
    prev = cumulative;
    rows.push({ month: addMonths(first, k - 1), amountMinor: amount, accumulatedMinor: cumulative, bookValueMinor: asset.costMinor - cumulative });
  }
  return rows;
}

/**
 * Months still to post up to `throughMonth`: after cut-over, not yet posted,
 * and (for a disposed asset) before the disposal month.
 */
export function dueDepreciation(asset: AssetLike, throughMonth: string, postedMonths: ReadonlySet<string>): ScheduleRow[] {
  const stop = asset.status === "disposed" && asset.disposedDate ? addMonths(monthOf(asset.disposedDate), -1) : throughMonth;
  const last = stop < throughMonth ? stop : throughMonth;
  return depreciationSchedule(asset).filter(
    (row) => row.month <= last && !postedMonths.has(row.month) && (!asset.openingThrough || row.month > asset.openingThrough) && row.amountMinor > 0,
  );
}

/** Accumulated depreciation by the end of `month` per the schedule. */
export function accumulatedThrough(asset: Pick<AssetLike, "costMinor" | "residualMinor" | "lifeMonths" | "depreciationStart">, month: string): number {
  let acc = 0;
  for (const row of depreciationSchedule(asset)) if (row.month <= month) acc = row.accumulatedMinor;
  return acc;
}

/**
 * Disposal journal lines (by account code): take the asset and its
 * accumulated depreciation off the books; proceeds to `proceedsCode`; the
 * difference is the profit (credit) or loss (debit) on disposal.
 */
export function disposalLines(input: {
  costMinor: number;
  accumulatedMinor: number;
  proceedsMinor: number;
  assetCode: string;
  accumulatedCode: string;
  proceedsCode: string;
  gainLossCode: string;
  memo: string;
}) {
  const lines: Array<{ accountCode: string; debitMinor: number; creditMinor: number; memo: string }> = [];
  if (input.accumulatedMinor > 0) lines.push({ accountCode: input.accumulatedCode, debitMinor: input.accumulatedMinor, creditMinor: 0, memo: input.memo });
  if (input.proceedsMinor > 0) lines.push({ accountCode: input.proceedsCode, debitMinor: input.proceedsMinor, creditMinor: 0, memo: `${input.memo} – proceeds` });
  lines.push({ accountCode: input.assetCode, debitMinor: 0, creditMinor: input.costMinor, memo: input.memo });
  const loss = input.costMinor - input.accumulatedMinor - input.proceedsMinor;
  if (loss > 0) lines.push({ accountCode: input.gainLossCode, debitMinor: loss, creditMinor: 0, memo: `${input.memo} – loss on disposal` });
  if (loss < 0) lines.push({ accountCode: input.gainLossCode, debitMinor: 0, creditMinor: -loss, memo: `${input.memo} – profit on disposal` });
  return { lines, gainMinor: -loss };
}
