/**
 * The per-campaign hard cap, enforced (PAR-6682). Every change that adds spend to a campaign is refused unless:
 *   - the campaign has a cap row (`campaign_caps`; a create_campaign proposal carries its own `capMinor` instead, written when it runs);
 *   - a fresh provider insights read of the campaign's spend since the row's `created_at` day worked;
 *   - that spend plus what the change adds stays at or under the cap.
 * A failed read refuses. An empty read (the platform answered, with no rows at all) for a campaign that has spend on record in `daily` is a failed
 * read too, not zero (the same outage `sync.ts` guards against before zeroing days). The window starts on the day of `created_at` in the account's
 * timezone, so same-day spend from before the row counts toward the cap (day grain, on purpose: conservative). Pause and other non-spend kinds pass.
 */
import { getAccount, getCampaignCap, getConnection, table, type AccountRow } from "./db.js";
import { AdsError, errorMessage } from "./domain.js";
import { tokenFor } from "./connections.js";
import { todayIn } from "./dates.js";
import { SPEND_KINDS, type ProposalKind } from "./platforms.js";
import type { CampaignTarget } from "./proposal-input.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";

/** One campaign a change touches, and what the change adds to its spend (minor units, at most one day of a daily budget, or an ad set's lifetime). */
interface CapCheck {
  accountId: string;
  campaignExternalId: string;
  addMinor: number;
}

function checksOf(kind: ProposalKind, payload: Record<string, unknown>): CapCheck[] {
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  if (kind === "change_budget") return [{ accountId: String(payload.accountId ?? ""), campaignExternalId: String(payload.campaignExternalId ?? ""), addMinor: num(payload.newDailyBudgetMinor) }];
  if (kind === "create_ad_set") return [{ accountId: String(payload.accountId ?? ""), campaignExternalId: String(payload.campaignExternalId ?? ""), addMinor: num(payload.lifetimeBudgetMinor) }];
  if (kind === "resume_campaign") return ((payload.targets as CampaignTarget[]) ?? []).map((t) => ({ accountId: t.accountId, campaignExternalId: t.campaignExternalId, addMinor: num(t.dailyBudgetMinor) }));
  // A spend kind with no branch here must not pass silently (PAR-3765).
  throw new AdsError(`The campaign cap cannot be checked for a ${kind} change, so it will not run.`, "campaign_cap_unchecked");
}

/** Throws an AdsError (codes: no_campaign_cap, over_campaign_cap, campaign_spend_unread) when a spend-raising change would break a campaign's cap. */
export async function assertCampaignCap(rt: AdsRuntime, kind: ProposalKind, payload: Record<string, unknown>): Promise<void> {
  if (!SPEND_KINDS.includes(kind)) return;
  if (kind === "create_campaign") {
    // A new campaign is always created paused, so creating it spends nothing; switching it on is a resume, which needs the cap row
    // (written from `capMinor` when the owner's own yes runs the create). A cap given here must cover at least one day of the budget.
    if (payload.capMinor === null || payload.capMinor === undefined) return;
    const capMinor = Number(payload.capMinor);
    const daily = Number(payload.dailyBudgetMinor) || 0;
    if (daily > capMinor) throw new AdsError(`One day of this budget (${daily}) is more than the campaign's cap (${capMinor}, minor units).`, "over_campaign_cap");
    return;
  }
  const reads = new Map<string, Promise<{ rows: Array<{ campaignExternalId: string; spendMinor: number }> }>>();
  for (const check of checksOf(kind, payload)) {
    const account = check.accountId ? await getAccount(rt.ctx, rt.companyId, check.accountId) : null;
    if (!account || !check.campaignExternalId) throw new AdsError("The campaign's ad account was not found, so its cap cannot be checked.", "no_campaign_cap");
    const cap = await getCampaignCap(rt.ctx, rt.companyId, account.platform, check.campaignExternalId);
    if (!cap) throw new AdsError(`Campaign ${check.campaignExternalId} has no hard cap, so a change that adds spend will not run. The owner or an admin sets one first; pausing is always allowed.`, "no_campaign_cap");
    const timezone = account.timezone ?? rt.config.timezone;
    const until = todayIn(timezone, rt.now());
    const from = todayIn(timezone, new Date(cap.created_at));
    const since = from > until ? until : from;
    const key = `${account.id}|${since}`;
    if (!reads.has(key)) reads.set(key, readSpend(rt, account, since, until));
    let rows;
    try {
      ({ rows } = await reads.get(key)!);
    } catch (error) {
      throw new AdsError(`The campaign's spend could not be read from the platform (${errorMessage(error).slice(0, 160)}), so its cap cannot be checked. Nothing was changed.`, "campaign_spend_unread");
    }
    if (rows.length === 0 && (await hadSpend(rt, account.id, check.campaignExternalId))) {
      throw new AdsError("The platform returned no numbers at all for an account whose campaign has spent before: that is a failed read, not zero. Try again after the next sync.", "campaign_spend_unread");
    }
    const spent = rows.filter((r) => r.campaignExternalId === check.campaignExternalId).reduce((sum, r) => sum + (Number(r.spendMinor) || 0), 0);
    if (spent + check.addMinor > cap.cap_minor) {
      throw new AdsError(`Campaign ${check.campaignExternalId} has spent ${spent} since ${since}; with ${check.addMinor} more that is over its cap of ${cap.cap_minor} (minor units). Propose a smaller change, or ask the owner to raise the cap.`, "over_campaign_cap");
    }
  }
}

/** A fresh insights read for the account over the window. Any failure (no connection, no token, platform error) is thrown. */
async function readSpend(rt: AdsRuntime, account: AccountRow, since: string, until: string) {
  const conn = account.connection_id ? await getConnection(rt.ctx, rt.companyId, account.connection_id) : null;
  if (!conn || (conn.status !== "connected" && conn.status !== "expiring")) throw new Error("the connection needs signing in again");
  const env = await providerEnv(rt, conn.platform);
  const token = await tokenFor(rt, conn);
  const ref = { externalId: account.external_id, currency: account.currency, loginCustomerId: account.login_customer_id, conversionActions: account.conversion_actions };
  const rows = await rt.provider(conn.platform).insights(env, token, ref, { since, until });
  return { rows };
}

async function hadSpend(rt: AdsRuntime, accountId: string, campaignExternalId: string): Promise<boolean> {
  const rows = await rt.ctx.db.query<Record<string, unknown>>(`SELECT 1 AS one FROM ${table(rt.ctx, "daily")} WHERE company_id = $1 AND account_id = $2 AND campaign_external_id = $3 AND spend_minor > 0 LIMIT 1`, [rt.companyId, accountId, campaignExternalId]);
  return rows.length > 0;
}
