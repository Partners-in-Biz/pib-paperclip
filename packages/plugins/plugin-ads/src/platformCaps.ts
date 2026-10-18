/**
 * Check that the ad platform has the required caps set before a spend-kind change.
 * Fail closed: if we cannot verify the caps exist, refuse the proposal.
 */
import { getAccount, getConnection, type AccountRow } from "./db.js";
import { AdsError, errorMessage } from "./domain.js";
import { tokenFor } from "./connections.js";
import { SPEND_KINDS, type ProposalKind } from "./platforms.js";
import type { CampaignTarget } from "./proposal-input.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";

/**
 * Verify that the ad account has the required platform-side caps set.
 * - spendCapMinor must not be null (the account's platform spend cap must exist)
 * - All ad sets for the campaign (or all ad sets if campaignExternalId is null) must have lifetimeBudgetMinor set
 * Throws AdsError if any check fails.
 */
export async function assertPlatformCaps(
  rt: AdsRuntime,
  account: { id: string; connection_id: string | null },
  campaignExternalId: string | null
): Promise<void> {
  const conn = account.connection_id ? await getConnection(rt.ctx, rt.companyId, account.connection_id) : null;
  if (!conn || (conn.status !== "connected" && conn.status !== "expiring")) {
    throw new AdsError("The connection for this ad account needs signing in again before anything can change.");
  }

  let env;
  try {
    env = await providerEnv(rt, conn.platform);
  } catch (error) {
    throw new AdsError(errorMessage(error));
  }

  let token;
  try {
    token = await tokenFor(rt, conn);
  } catch (error) {
    throw new AdsError(errorMessage(error));
  }

  const provider = rt.provider(conn.platform);
  const acc = await getAccount(rt.ctx, rt.companyId, account.id);
  if (!acc) throw new AdsError("That ad account was not found.");

  const ref = {
    externalId: acc.external_id,
    currency: acc.currency,
    loginCustomerId: acc.login_customer_id,
  };

  let caps;
  try {
    caps = await provider.accountCaps(env, token, ref);
  } catch (error) {
    throw new AdsError(`Could not verify platform spend caps: ${errorMessage(error)}`, "platform_caps_unverified");
  }

  if (caps.spendCapMinor === null) {
    throw new AdsError("The ad account has no platform spend cap (Meta spend_cap / Google account budget limit). Set one on the platform first.", "no_platform_cap");
  }

  const relevantSets = campaignExternalId ? caps.adSets.filter((s) => s.campaignExternalId === campaignExternalId) : caps.adSets;
  const withoutBudget = relevantSets.filter((s) => s.lifetimeBudgetMinor === null);
  if (withoutBudget.length > 0) {
    const ids = withoutBudget
      .slice(0, 3)
      .map((s) => s.externalId)
      .join(", ");
    const suffix = withoutBudget.length > 3 ? ` and ${withoutBudget.length - 3} more` : "";
    throw new AdsError(`Ad set${withoutBudget.length === 1 ? "" : "s"} ${ids}${suffix} ${withoutBudget.length === 1 ? "has" : "have"} no lifetime budget set on the platform. Set one on each first.`, "adset_no_lifetime_budget");
  }
}

/**
 * Dispatch per-kind platform caps assertions for spend-kind changes.
 * Gates on SPEND_KINDS: does nothing for non-spend kinds.
 * Skips silently when an account is not found (matching current semantics).
 */
export async function assertPlatformCapsFor(rt: AdsRuntime, kind: ProposalKind, payload: Record<string, unknown>): Promise<void> {
  if (!SPEND_KINDS.includes(kind)) return;

  if (kind === "create_campaign") {
    const accountId = payload.accountId;
    if (!accountId) return;
    const account = await getAccount(rt.ctx, rt.companyId, String(accountId));
    if (!account) return;
    await assertPlatformCaps(rt, account, null);
  } else if (kind === "change_budget") {
    const accountId = payload.accountId;
    if (!accountId) return;
    const account = await getAccount(rt.ctx, rt.companyId, String(accountId));
    if (!account) return;
    await assertPlatformCaps(rt, account, String(payload.campaignExternalId));
  } else if (kind === "create_ad_set") {
    const accountId = payload.accountId;
    if (!accountId) return;
    const account = await getAccount(rt.ctx, rt.companyId, String(accountId));
    if (!account) return;
    await assertPlatformCaps(rt, account, String(payload.campaignExternalId));
  } else if (kind === "resume_campaign") {
    const targets = (payload.targets as CampaignTarget[]) ?? [];
    for (const t of targets) {
      const account = await getAccount(rt.ctx, rt.companyId, t.accountId);
      if (!account) continue;
      await assertPlatformCaps(rt, account, t.campaignExternalId);
    }
  }
}
