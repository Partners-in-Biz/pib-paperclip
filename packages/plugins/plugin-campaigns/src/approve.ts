/**
 * Page actions `campaigns.approve` and `campaigns.send-back` (plan PAR-9192
 * rev 2, section 5.1). Only a signed-in person acts. A client campaign, and an
 * own campaign that reaches current clients (Q7), needs the company owner
 * (F18); other own campaigns any board member (Q5a). Both act on the campaign
 * whoever holds the approval issue (PAR-5821). The plugin's own issue update
 * is ignored by the approval handler (F3), so the launch runs once here;
 * `claimLaunch` is the second guard.
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { readCompanyRoles } from "@partnersinbiz/pib-plugin-kit";
import { approvalAudience, audienceChangedMessage, customerCount } from "./approval-audience.js";
import { getCampaign, listSteps, setApprovalAudience, setClientYes } from "./db.js";
import { CampaignError, type CampaignDraft } from "./domain.js";
import { messagingSetup } from "./messaging.js";
import { approverUserId, companyOwnerUserId } from "./owner.js";
import { optionalString, requiredString } from "./params.js";

/** The worker's own launch and refusal paths, passed in so there is one of each. */
export interface ApprovalPaths {
  launchOnApproval(ctx: PluginContext, companyId: string, campaign: CampaignDraft, issueId: string, approvedByUserId: string | null): Promise<{ status: string; enrolled: number; alreadyLaunched?: boolean } | null>;
  onApprovalRefused(ctx: PluginContext, companyId: string, campaign: CampaignDraft, issueId: string): Promise<void>;
}

/** The person calling, or a refusal: an agent, or a call with no signed-in user. */
export function personOnly(context: PluginPerformActionContext): { companyId: string; userId: string } {
  if (context.actor.agentId) throw new CampaignError("Only a person can approve or send back a campaign launch. Agents ask for approval (request-campaign-approval) and wait.");
  if (!context.actor.userId) throw new CampaignError("Sign in as a person to approve or send back a campaign launch.");
  if (!context.companyId) throw new CampaignError("Company is required");
  return { companyId: context.companyId, userId: context.actor.userId };
}

/** A draft with an approval that is still open (or done but not launched). */
async function openApproval(ctx: PluginContext, companyId: string, campaignId: string): Promise<{ campaign: CampaignDraft; issueId: string; issueStatus: string; issueAgentId: string | null }> {
  const campaign = await getCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== companyId) throw new CampaignError("Campaign was not found");
  if (campaign.status !== "draft") throw new CampaignError(`This campaign is ${campaign.status}, not a draft waiting for approval. Nothing to approve or send back.`);
  if (!campaign.approvalIssueId) throw new CampaignError("No approval is open for this campaign. Its agent asks for one with request-campaign-approval.");
  const issue = await ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null);
  if (!issue) throw new CampaignError(`The approval issue ${campaign.approvalIssueId} was not found. Ask for approval again.`);
  if (issue.status === "cancelled") throw new CampaignError("This approval was cancelled. The campaign needs a new approval (request-campaign-approval).");
  return { campaign, issueId: issue.id, issueStatus: issue.status, issueAgentId: issue.assigneeAgentId ?? null };
}

/** Q5a, Q7, F18: who may decide on this campaign. Throws with the reason when the caller may not. */
async function assertMayDecide(ctx: PluginContext, companyId: string, userId: string, campaign: CampaignDraft, contactIds: string[]): Promise<void> {
  const clients = campaign.clientRef ? 0 : await customerCount(ctx, companyId, contactIds);
  if (!campaign.clientRef && clients === 0) return;
  const why = campaign.clientRef ? "a client's campaign" : `an own campaign that reaches ${clients} current client${clients === 1 ? "" : "s"}`;
  const owner = await companyOwnerUserId(ctx, companyId);
  if (!owner) throw new CampaignError(`This is ${why}, so only the company owner decides, and no company owner is known. Set the owner in the Cockpit first.`);
  if (owner !== userId) throw new CampaignError(`This is ${why}, so only the company owner decides on it.`);
}

/** Who a launch would enroll now, from the same resolution as the launch. */
async function currentAudience(ctx: PluginContext, companyId: string, campaign: CampaignDraft) {
  const steps = await listSteps(ctx, campaign.id);
  const setup = await messagingSetup(ctx, companyId);
  return approvalAudience(ctx, companyId, campaign, steps, setup.config.defaultCountry);
}

export async function approveAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, paths: ApprovalPaths) {
  const { companyId, userId } = personOnly(context);
  const { campaign, issueId } = await openApproval(ctx, companyId, requiredString(params, "campaignId"));
  const shownHash = requiredString(params, "audienceHash");
  const audience = await currentAudience(ctx, companyId, campaign);
  await assertMayDecide(ctx, companyId, userId, campaign, audience.contactIds);
  if (audience.hash !== shownHash) {
    const shownCount = typeof params.audienceCount === "number" ? params.audienceCount : shownHash === campaign.approvalAudienceHash ? campaign.approvalAudienceCount : null;
    throw new CampaignError(audienceChangedMessage(shownCount, audience.count));
  }
  if (campaign.clientRef) {
    const ref = optionalString(params, "clientYesRef");
    if (!ref || params.clientYesSeen !== true) throw new CampaignError("Record the client's yes: where they said yes (a link to the comment or email), and tick that you have seen it.");
    await setClientYes(ctx, campaign.id, { ref, by: userId });
  }
  // The person approved the audience they saw: that is the one a launch compares with now.
  await setApprovalAudience(ctx, campaign.id, audience);
  // Done and with that person, whoever held it (the Reviewer, or blocked by an agent: PAR-5821). Our own update does not launch (F3).
  await ctx.issues.update(issueId, { status: "done", assigneeAgentId: null, assigneeUserId: userId }, companyId);
  const fresh = (await getCampaign(ctx, campaign.id)) ?? campaign;
  const result = await paths.launchOnApproval(ctx, companyId, fresh, issueId, userId);
  if (!result) {
    const failed = await getCampaign(ctx, campaign.id);
    return { campaignId: campaign.id, approved: true, launched: false, error: failed?.launchError ?? "The launch failed. The approval issue says why." };
  }
  return { campaignId: campaign.id, approved: true, launched: !result.alreadyLaunched, alreadyLaunched: result.alreadyLaunched === true, status: result.status, enrolled: result.enrolled };
}

export async function sendBackAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, paths: ApprovalPaths) {
  const { companyId, userId } = personOnly(context);
  const note = optionalString(params, "note");
  if (!note) throw new CampaignError("Say what to change: a note is required to send a campaign back.");
  const { campaign, issueId } = await openApproval(ctx, companyId, requiredString(params, "campaignId"));
  const audience = await currentAudience(ctx, companyId, campaign);
  await assertMayDecide(ctx, companyId, userId, campaign, audience.contactIds);
  await sendBackApproval(ctx, companyId, campaign, issueId, `Sent back: ${note}`, paths);
  return { campaignId: campaign.id, sentBack: true, approvalIssueId: issueId };
}

/** Send back: the note on the issue, the issue cancelled, and the existing refusal path (the Revise issue). */
async function sendBackApproval(ctx: PluginContext, companyId: string, campaign: CampaignDraft, issueId: string, comment: string, paths: ApprovalPaths): Promise<void> {
  await ctx.issues.createComment(issueId, comment, companyId);
  await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
  await paths.onApprovalRefused(ctx, companyId, campaign, issueId);
}

/**
 * Agent tool `review-campaign-approval` (plan section 5.1, Reviewer verdict).
 * Only the company's Reviewer (the one the kit routes approvals to), and only
 * while the approval issue is with it. Pass comments the note and hands the
 * issue to the approver person with no agent on it, so the Cockpit shows it at
 * once (`issue_agent_id` is null). Changes does what Send back does.
 */
export async function reviewApprovalTool(ctx: PluginContext, companyId: string, agentId: string | null | undefined, params: Record<string, unknown>, paths: ApprovalPaths) {
  if (!agentId) throw new CampaignError("Only the company's Reviewer agent gives a review verdict. A person approves or sends back on the campaign screen.");
  const reviewer = (await readCompanyRoles(ctx, companyId)).roles?.reviewerAgentId ?? null;
  if (!reviewer || reviewer !== agentId) throw new CampaignError("Only the company's Reviewer agent gives a review verdict on a campaign launch. Wait for the approval to be decided.");
  const verdict = requiredString(params, "verdict");
  if (verdict !== "pass" && verdict !== "changes") throw new CampaignError("verdict must be pass or changes");
  const note = optionalString(params, "note");
  if (!note) throw new CampaignError(verdict === "pass" ? "Add a note: what you checked." : "Add a note: what to change.");
  const { campaign, issueId, issueStatus, issueAgentId } = await openApproval(ctx, companyId, requiredString(params, "campaignId"));
  if (issueStatus === "done" || issueAgentId !== agentId) throw new CampaignError("This approval is not with you any more: a person decides it now. Nothing to review.");
  if (verdict === "changes") {
    await sendBackApproval(ctx, companyId, campaign, issueId, `Reviewer asked for changes: ${note}`, paths);
    return { campaignId: campaign.id, verdict, sentBack: true, approvalIssueId: issueId };
  }
  // The PR 3 rule: the owner decides a client's campaign or one that reaches current clients; else the approver by the kit's chain.
  const audience = await currentAudience(ctx, companyId, campaign);
  const ownerOnly = Boolean(campaign.clientRef) || (await customerCount(ctx, companyId, audience.contactIds)) > 0;
  const person = ownerOnly ? await companyOwnerUserId(ctx, companyId) : await approverUserId(ctx, companyId, campaign);
  if (!person) throw new CampaignError("No approver is known for this company (set the owner in the Cockpit). The approval stays with you; a person sees it after 24 hours.");
  await ctx.issues.createComment(issueId, `Reviewer pass: ${note}\n\nOver to the approver: open the campaign to approve or send back.`, companyId);
  await ctx.issues.update(issueId, { assigneeAgentId: null, assigneeUserId: person, ...(issueStatus === "backlog" ? { status: "todo" } : {}) }, companyId);
  return { campaignId: campaign.id, verdict, approvalIssueId: issueId, assignedToUserId: person, next: "Done. A person approves or sends it back now." };
}
