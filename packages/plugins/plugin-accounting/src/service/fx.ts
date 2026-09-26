/**
 * Daily FX rates from frankfurter.app (ECB reference rates) and period-end
 * revaluation of open foreign-currency items. The revaluation journal
 * (`fx-reval:<YYYY-MM>`) is reversed on the first day of the next month
 * (`fx-reval:<YYYY-MM>:reversal`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { invertRates, parseFrankfurter, revalue, type FxItem } from "../domain/fx.js";
import { AccountingError, addMonths, firstDayOfMonth, lastDayOfMonth, monthOf, requireMonth, todayIso } from "../domain/util.js";
import { BOOK_CURRENCY, errorMessage, type Actor } from "./common.js";
import { postJournal, reverseJournal } from "./journals.js";

/** frankfurter.app, with its newer host as a fallback (same ECB data). */
export const FX_URLS = ["https://api.frankfurter.app/latest?from=ZAR", "https://api.frankfurter.dev/v1/latest?base=ZAR"];

export async function fetchRates(ctx: PluginContext, fetchImpl: typeof fetch = fetch): Promise<{ date: string; saved: number }> {
  let body: ReturnType<typeof parseFrankfurter> | null = null;
  let lastError = "";
  for (const url of FX_URLS) {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      body = parseFrankfurter(await res.json());
      break;
    } catch (error) {
      lastError = errorMessage(error);
    }
  }
  if (!body) throw new AccountingError(`FX rates request failed (${lastError})`);
  const rates = invertRates(body.rates);
  const saved = await db.saveFxRates(ctx.db, BOOK_CURRENCY, body.date, rates, "frankfurter.app");
  return { date: body.date, saved };
}

export async function revalueMonth(ctx: PluginContext, companyId: string, actor: Actor, monthInput: unknown) {
  const month = requireMonth(monthInput ?? addMonths(monthOf(todayIso()), -1), "month");
  const end = lastDayOfMonth(month);
  const key = `fx-reval:${month}`;
  const existing = await db.journalBySourceKey(ctx.db, companyId, key);
  if (existing) return { month, journal: existing, reversal: await db.reversalOf(ctx.db, companyId, existing.id), items: [], skipped: [], already: true };
  const open = (await db.listOpenItems(ctx.db, companyId)).filter((i) => i.currency !== BOOK_CURRENCY && i.outstandingMinor > 0);
  if (open.length === 0) return { month, journal: null, reversal: null, items: [], skipped: [], already: false };
  const rates = await db.ratesOnOrBefore(ctx.db, BOOK_CURRENCY, end, [...new Set(open.map((i) => i.currency))]);
  const items: FxItem[] = [];
  for (const item of open) {
    items.push({
      key: item.key,
      kind: item.kind,
      number: item.number,
      currency: item.currency,
      outstandingMinor: item.outstandingMinor,
      bookedRate: (await db.bookedRateFor(ctx.db, companyId, item.itemId)) ?? 0,
    });
  }
  const result = revalue(items, new Map([...rates].map(([c, r]) => [c, r.rate])));
  if (result.lines.length === 0) return { month, journal: null, reversal: null, items: result.items, skipped: result.skipped, already: false };
  const { journal } = await postJournal(ctx, companyId, {
    sourceKey: key,
    source: { plugin: "partnersinbiz.accounting", kind: "fx_revaluation", id: month },
    kind: "fx_revaluation",
    date: end,
    memo: `Unrealised FX revaluation at ${end}`,
    lines: result.lines.map((l) => ({ role: l.role, debitMinor: l.debitMinor, creditMinor: l.creditMinor, memo: l.memo })),
    postedBy: actor,
  });
  let reversal = null;
  try {
    reversal = (
      await reverseJournal(ctx, companyId, journal.id, {
        date: firstDayOfMonth(addMonths(month, 1)),
        memo: `Reverse unrealised FX revaluation of ${month}`,
        sourceKey: `${key}:reversal`,
        postedBy: actor,
      })
    ).journal;
  } catch (error) {
    ctx.logger.warn("FX revaluation reversal failed; reverse it by hand", { companyId, month, error: errorMessage(error) });
  }
  return { month, journal, reversal, items: result.items, skipped: result.skipped, already: false };
}
