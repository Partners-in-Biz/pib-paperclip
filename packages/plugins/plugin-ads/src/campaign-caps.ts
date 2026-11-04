/**
 * The hard cap of one campaign, as a row. Only a signed-in person writes one (an agent, the owner's delegate included, cannot). `campaignCap.ts` enforces it:
 * a change that adds spend to a campaign without a row is refused. A create_campaign proposal may carry `capMinor`; the row is written when the owner's own yes has run it.
 */
import { resolveAccess } from "@partnersinbiz/pib-plugin-kit";
import { audit, campaignKnown, getAccount, getCampaignCap, listCampaignCaps, listCampaignsWithoutCap, upsertCampaignCap, type CampaignCapRow } from "./db.js";
import { AdsError, minorField, optionalString } from "./domain.js";
import { formatMoney } from "./money.js";
import type { AdsRuntime } from "./runtime.js";

export function capView(row: CampaignCapRow, currency?: string) {
  return { platform: row.platform, campaignExternalId: row.external_campaign_id, capMinor: row.cap_minor, ...(currency ? { cap: formatMoney(row.cap_minor, currency) } : {}), createdAt: row.created_at, setBy: row.set_by, proposalId: row.proposal_id };
}

/**
 * Who may set a cap (PAR-7300): the company's owner or an admin, and nobody else. Another signed-in member, however much access the Ads page gave them, is refused;
 * so is anyone whose role cannot be read (fail closed). The kit's `resolveAccess` reads the role from the host (`access.members.read`); `bypass` is true only
 * for owner, admin and the local board. Refusals go to the activity log (`activity.log.write`), best effort.
 */
export async function requireCapSetter(rt: AdsRuntime, userId: string, what: string): Promise<void> {
  const access = await resolveAccess(rt.ctx, rt.companyId, { type: "user", userId });
  if (access.bypass) return;
  await rt.ctx.activity.log({ companyId: rt.companyId, message: `Refused: ${userId} tried to ${what} (owner or admin only)`, entityType: "plugin_ads_cap", entityId: userId, metadata: { reason: access.reason ?? "not owner or admin" } }).catch(() => undefined);
  throw new AdsError("Only the company owner or an admin can set a campaign cap.");
}

/** Sets (or changes) the cap of a known campaign and returns the row read back from the table. */
export async function setCampaignCap(rt: AdsRuntime, actor: { userId: string | null }, params: Record<string, unknown>) {
  if (!actor.userId) throw new AdsError("Only a signed-in person sets a campaign cap. An agent cannot.");
  await requireCapSetter(rt, actor.userId, "set a campaign cap");
  const accountId = optionalString(params, "accountId", 80);
  const externalId = optionalString(params, "campaignExternalId", 120);
  if (!accountId || !externalId) throw new AdsError("accountId and campaignExternalId are required (from list-ad-campaigns).");
  const capMinor = minorField(params, "capMinor", { required: true })!;
  if (capMinor <= 0) throw new AdsError("The cap must be more than zero.");
  const account = await getAccount(rt.ctx, rt.companyId, accountId);
  if (!account) throw new AdsError("That ad account was not found.");
  if (!(await campaignKnown(rt.ctx, rt.companyId, account.id, externalId))) throw new AdsError("That campaign is not known for this account. Read the numbers first, then set the cap.");
  const previous = await getCampaignCap(rt.ctx, rt.companyId, account.platform, externalId);
  await upsertCampaignCap(rt.ctx, rt.companyId, { platform: account.platform, externalCampaignId: externalId, capMinor, setBy: `user:${actor.userId}`, proposalId: null });
  const row = await getCampaignCap(rt.ctx, rt.companyId, account.platform, externalId);
  if (!row || row.cap_minor !== capMinor) throw new AdsError("The cap was not saved: the read-back does not match. Nothing was changed on the platform.");
  await audit(rt.ctx, rt.companyId, { actor: `user:${actor.userId}`, action: "campaign.cap_set", scopeKey: account.scope_key, subject: externalId, detail: { platform: account.platform, capMinor, previousCapMinor: previous?.cap_minor ?? null } });
  return { ok: true, cap: capView(row, account.currency) };
}

/** What a create_campaign approval writes, once the campaign has an external id. `approvedBy` must be a person; the owner's delegate does not set caps. */
export async function writeProposalCap(rt: AdsRuntime, input: { platform: string; externalCampaignId: string; capMinor: number; approvedBy: string; proposalId: string; scopeKey: string }): Promise<boolean> {
  if (!input.approvedBy.startsWith("user:")) return false;
  try {
    await requireCapSetter(rt, input.approvedBy.slice("user:".length), "record a proposal cap");
  } catch {
    return false;
  }
  await upsertCampaignCap(rt.ctx, rt.companyId, { platform: input.platform, externalCampaignId: input.externalCampaignId, capMinor: input.capMinor, setBy: input.approvedBy, proposalId: input.proposalId });
  await audit(rt.ctx, rt.companyId, { actor: input.approvedBy, action: "campaign.cap_set", scopeKey: input.scopeKey, subject: input.externalCampaignId, detail: { platform: input.platform, capMinor: input.capMinor, proposalId: input.proposalId } });
  return true;
}

/** Every cap row, and the known campaigns that have none. */
export async function campaignCapsRecord(rt: AdsRuntime) {
  const [caps, lacking] = await Promise.all([listCampaignCaps(rt.ctx, rt.companyId), listCampaignsWithoutCap(rt.ctx, rt.companyId)]);
  return { caps: caps.map((c) => capView(c)), withoutCap: lacking, note: "A change that adds spend to a campaign without a cap, or past its cap, is refused. Pausing is always allowed." };
}
