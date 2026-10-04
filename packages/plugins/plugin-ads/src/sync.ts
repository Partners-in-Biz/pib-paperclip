/**
 * Read-only sync: pulls campaigns and day-by-day numbers for each registered ad account into the rollups and the spend ledger.
 * The platforms restate recent days (late conversions, refunds, invalid clicks), so every sync re-reads the last few days and rewrites them;
 * a day the platform stops returning is set to zero, and the ledger records each change. Nothing here changes an ad.
 *
 * How far back a read goes follows the last GOOD read, not a fixed 3 days: an account whose sign-in lapsed (a Google "Testing" refresh token
 * lasts 7 days), or whose platform was down, would otherwise come back with a hole in its numbers and every month-to-date figure (cap pacing, the
 * 90% pause request, the over-cap check) would understate spend. Only a read that covered all of that window moves the "last good read" forward.
 */
import { audit, dailyRows, getConnection, listAccounts, recordDaily, updateAccount, updateConnection, upsertCampaign, type AccountRow } from "./db.js";
import { addDays, daysBetween, monthOf, monthStart, todayIn } from "./dates.js";
import { errorMessage } from "./domain.js";
import { markConnected, markNeedsReconnect, tokenFor } from "./connections.js";
import { ProviderError } from "./providers/http.js";
import type { InsightRow } from "./providers/types.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";

/** Days re-read on a normal sync, on the first sync of an account, and at most on a backfill. */
export const SYNC_DAYS = 3;
export const FIRST_SYNC_DAYS = 30;
export const MAX_BACKFILL_DAYS = 90;
const MAX_ACCOUNTS_PER_RUN = 40;

export interface SyncResult {
  accountId: string;
  ok: boolean;
  campaigns: number;
  days: number;
  ledgerEntries: number;
  error?: string;
  needsReconnect?: boolean;
  /** Days since the last good read, when the read had to reach back further than a normal one (an outage was backfilled). */
  gapDays?: number;
  /** The gap was longer than a read may go back: the oldest days are missing from the numbers. */
  truncated?: boolean;
  /** A short read (an explicit `days` below what was needed): the "last good read" did not move, so the next read still backfills. */
  partial?: boolean;
}

export interface SyncWindow {
  /** What a complete read of this account needs, before the backfill limit. */
  wantedDays: number;
  /** What a read will actually ask for. */
  days: number;
  /** Days since the last good read; null on a first read. */
  gapDays: number | null;
  truncated: boolean;
}

/**
 * How many days to read: everything since the last good read plus the last few days before it (the platform restates those), at least a month's
 * start on a first read so the month-to-date is whole, and never more than MAX_BACKFILL_DAYS. Pure.
 */
export function syncWindow(input: { lastOkAt: string | null; until: string; timezone: string }): SyncWindow {
  const sinceMonthStart = daysBetween(monthStart(monthOf(input.until)), input.until) + 1;
  const lastOk = input.lastOkAt ? Date.parse(input.lastOkAt) : Number.NaN;
  let wantedDays: number;
  let gapDays: number | null;
  if (!Number.isFinite(lastOk)) {
    wantedDays = Math.max(FIRST_SYNC_DAYS, sinceMonthStart);
    gapDays = null;
  } else {
    gapDays = Math.max(0, daysBetween(todayIn(input.timezone, new Date(lastOk)), input.until));
    wantedDays = gapDays + SYNC_DAYS;
  }
  const days = Math.max(1, Math.min(wantedDays, MAX_BACKFILL_DAYS));
  return { wantedDays, days, gapDays, truncated: wantedDays > MAX_BACKFILL_DAYS };
}

export async function syncAccount(rt: AdsRuntime, account: AccountRow, options: { days?: number } = {}): Promise<SyncResult> {
  const fail = async (message: string, needsReconnect = false): Promise<SyncResult> => {
    await updateAccount(rt.ctx, rt.companyId, account.id, { syncOk: false, syncError: message.slice(0, 400), at: rt.now().toISOString() });
    return { accountId: account.id, ok: false, campaigns: 0, days: 0, ledgerEntries: 0, error: message, ...(needsReconnect ? { needsReconnect } : {}) };
  };
  const conn = account.connection_id ? await getConnection(rt.ctx, rt.companyId, account.connection_id) : null;
  if (!conn || conn.status === "disabled") return fail("No connection is linked to this ad account. Connect the platform again.");
  try {
    const token = await tokenFor(rt, conn);
    const env = await providerEnv(rt, conn.platform);
    const provider = rt.provider(conn.platform);
    const ref = { externalId: account.external_id, currency: account.currency, loginCustomerId: account.login_customer_id, conversionActions: account.conversion_actions };
    const timezone = account.timezone ?? rt.config.timezone;
    const until = todayIn(timezone, rt.now());
    const window = syncWindow({ lastOkAt: account.last_sync_ok_at, until, timezone });
    const days = options.days === undefined ? window.days : Math.max(1, Math.min(Math.floor(options.days), MAX_BACKFILL_DAYS));
    // A short read (an agent asked for 1 day, or a change was just made) is still useful, but it must not claim the older days were read.
    const partial = options.days !== undefined && days < window.days;
    const since = addDays(until, -(days - 1));

    const campaigns = await provider.listCampaigns(env, token, ref);
    for (const c of campaigns) {
      await upsertCampaign(rt.ctx, rt.companyId, account.id, c);
    }
    const insights = await provider.insights(env, token, ref, { since, until });

    const seen = new Set<string>();
    let ledgerEntries = 0;
    const known = new Set(campaigns.map((c) => c.externalId));
    for (const row of insights) {
      seen.add(`${row.campaignExternalId}|${row.day}`);
      if (!known.has(row.campaignExternalId)) {
        // A campaign the list did not return (archived since): keep its numbers under its name.
        await upsertCampaign(rt.ctx, rt.companyId, account.id, { externalId: row.campaignExternalId, name: row.campaignName || row.campaignExternalId, status: "archived", rawStatus: "NOT_LISTED", objective: null, channel: null, dailyBudgetMinor: null, lifetimeBudgetMinor: null });
        known.add(row.campaignExternalId);
      }
      ledgerEntries += (await recordDaily(rt.ctx, rt.companyId, account, toDaily(row))).ledgerEntry ? 1 : 0;
    }
    // A day we hold that the platform no longer returns was restated to nothing: zero it, so the ledger explains the drop. Only when the platform
    // returned something for the window: an empty answer for every day (a permission gone quiet, an outage that answers 200) must never wipe real spend.
    if (insights.length > 0) {
      for (const old of await dailyRows(rt.ctx, rt.companyId, since, account.id)) {
        if (old.day > until || seen.has(`${old.campaign_external_id}|${old.day}`) || (old.spend === 0 && old.impressions === 0 && old.clicks === 0)) continue;
        ledgerEntries += (await recordDaily(rt.ctx, rt.companyId, account, { campaignExternalId: old.campaign_external_id, day: old.day, spendMinor: 0, impressions: 0, clicks: 0, conversions: 0, valueMinor: 0 })).ledgerEntry ? 1 : 0;
      }
    }
    await updateAccount(rt.ctx, rt.companyId, account.id, { syncOk: true, at: rt.now().toISOString(), ...(partial ? { partial: true } : {}) });
    if (conn.status !== "connected") await markConnected(rt, conn);
    else await updateConnection(rt.ctx, rt.companyId, conn.id, { lastOk: true });
    const backfilled = !partial && window.gapDays !== null && window.gapDays >= 2;
    if (!partial && (backfilled || window.truncated)) {
      // An outage was read back (or was too long to read back in full): say so, with the days, so a month-to-date that jumped has its explanation.
      await audit(rt.ctx, rt.companyId, { actor: "system", action: window.truncated ? "sync.gap_truncated" : "sync.backfilled", scopeKey: account.scope_key, subject: account.id, detail: { lastOkAt: account.last_sync_ok_at, gapDays: window.gapDays, readDays: days, wantedDays: window.wantedDays } });
      if (window.truncated) rt.ctx.logger.info("Ads sync gap is longer than a read can go back", { accountId: account.id, gapDays: window.gapDays, readDays: days });
    }
    return { accountId: account.id, ok: true, campaigns: campaigns.length, days, ledgerEntries, ...(backfilled && !partial ? { gapDays: window.gapDays! } : {}), ...(window.truncated && !partial ? { truncated: true } : {}), ...(partial ? { partial: true } : {}) };
  } catch (error) {
    if (error instanceof ProviderError && error.tokenInvalid) {
      await markNeedsReconnect(rt, conn, error.message);
      return fail(error.message, true);
    }
    const message = errorMessage(error);
    rt.ctx.logger.info("Ads sync failed", { accountId: account.id, platform: account.platform, error: message });
    await audit(rt.ctx, rt.companyId, { actor: "system", action: "sync.failed", scopeKey: account.scope_key, subject: account.id, detail: { error: message.slice(0, 200) } });
    return fail(message);
  }
}

function toDaily(row: InsightRow) {
  return { campaignExternalId: row.campaignExternalId, day: row.day, spendMinor: row.spendMinor, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, valueMinor: row.valueMinor };
}

export interface CompanySync {
  accounts: number;
  ok: number;
  failed: number;
  skipped: number;
  results: SyncResult[];
}

/** Every active account of a company, one after another (the platforms rate-limit per account, and the host limits secret reads per company). */
export async function syncCompany(rt: AdsRuntime, options: { days?: number; accountId?: string; limit?: number } = {}): Promise<CompanySync> {
  const accounts = (await listAccounts(rt.ctx, rt.companyId)).filter((a) => a.status === "active" && (!options.accountId || a.id === options.accountId)).slice(0, Math.min(options.limit ?? MAX_ACCOUNTS_PER_RUN, MAX_ACCOUNTS_PER_RUN));
  const out: CompanySync = { accounts: accounts.length, ok: 0, failed: 0, skipped: 0, results: [] };
  for (const account of accounts) {
    const conn = account.connection_id ? await getConnection(rt.ctx, rt.companyId, account.connection_id) : null;
    if (conn?.status === "needs_reconnect") {
      out.skipped += 1;
      continue;
    }
    const result = await syncAccount(rt, account, options.days === undefined ? {} : { days: options.days });
    out.results.push(result);
    if (result.ok) out.ok += 1;
    else out.failed += 1;
  }
  return out;
}
