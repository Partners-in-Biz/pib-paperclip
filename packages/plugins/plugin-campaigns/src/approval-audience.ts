/**
 * The approved audience: who a launch would enroll right now, as a count and a
 * hash of the sorted contact ids. Stored when approval is requested and
 * compared before a launch, so someone tagged between the request and the
 * approval is noticed. Uses the same resolution as the launch (`launchAudience`).
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listCrmContacts } from "@partnersinbiz/pib-plugin-kit";
import { launchAudience } from "./audience.js";
import type { CampaignDraft, CampaignStepDraft } from "./domain.js";

export interface ApprovalAudience {
  /** Contact ids a launch would enroll, sorted. */
  contactIds: string[];
  count: number;
  hash: string;
}

/** Same people in any order give the same hash; one more or one less changes it. */
export function audienceFingerprint(contactIds: Iterable<string>): ApprovalAudience {
  const sorted = [...new Set(contactIds)].sort();
  const hash = createHash("sha256").update(sorted.join("\n")).digest("hex");
  return { contactIds: sorted, count: sorted.length, hash };
}

/** The people a launch of this campaign would enroll now (the launch's own resolution, no explicit ids). */
export async function approvalAudience(
  ctx: PluginContext,
  companyId: string,
  campaign: CampaignDraft,
  steps: CampaignStepDraft[],
  defaultCountry?: string,
): Promise<ApprovalAudience> {
  const { eligible } = await launchAudience(ctx, companyId, campaign, steps, [], defaultCountry);
  return audienceFingerprint(eligible.map((contact) => contact.id));
}

/** The refusal when the people a launch would reach are not the ones the approver saw. */
export function audienceChangedMessage(before: number | null | undefined, now: number): string {
  return `The audience changed since you looked (${before ?? "unknown"}, now ${now}). Look again.`;
}

/** How many of these contacts are current clients (CRM lifecycle `customer`, F17). */
export async function customerCount(ctx: PluginContext, companyId: string, contactIds: string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  const rows = await listCrmContacts(ctx, ctx.db.namespace, companyId, { ids: contactIds });
  return rows.filter((row) => row.lifecycle === "customer").length;
}
