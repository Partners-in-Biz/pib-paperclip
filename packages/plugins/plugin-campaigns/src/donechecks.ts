/**
 * Done checks: when an agent closes an issue Campaigns handed it, Campaigns
 * looks at the outcome in its own data (never Jev, never the network).
 * Unfinished work reopens the issue with what is missing (kit
 * `registerDoneChecks`); a person's close, and the launch approval (a
 * person's decision), are never checked.
 *
 * - Step issues and "Email not sent": the contact moved on (closing the issue
 *   does that) or was stopped.
 * - "Revise campaign": the draft changed after the refusal and approval was
 *   asked again (or it is no longer a draft).
 * - Replies: answered or a decision logged (`log-reply`), the contact stopped
 *   after the reply, or the address on the do-not-email list.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getCrmContact, type DoneCheckIssue, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { campaignEditedAt, contactSuppressed, enrollmentById, enrollmentState, getCampaign, replyLogged } from "./db.js";
import { CAMPAIGN_ORIGINS, parsePairOrigin, parseStepOrigin } from "./origins.js";

const done: DoneCheckResult = { done: true };

async function contactName(ctx: PluginContext, companyId: string, contactId: string): Promise<{ name: string; emails: string[] }> {
  const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, contactId).catch(() => null);
  return { name: contact?.name ?? `contact:${contactId}`, emails: contact?.emails ?? [] };
}

/**
 * A step issue (or "Email not sent") is done when its contact is no longer on
 * that step with this issue open: moved on, finished, or stopped. Closing the
 * issue moves them on (the plugin's own handler runs first), so this only
 * fails when that did not happen.
 */
export async function checkStepIssue(ctx: PluginContext, issue: DoneCheckIssue, prefix: string): Promise<DoneCheckResult> {
  const parsed = parseStepOrigin(issue.originId, prefix);
  if (!parsed) return done;
  const enrollment = await enrollmentById(ctx, parsed.enrollmentId);
  if (!enrollment || enrollment.companyId !== issue.companyId) return done;
  const stillHere = enrollment.status === "running" && enrollment.stepPosition === parsed.position && enrollment.openIssueId === issue.id;
  if (!stillHere) return done;
  const [campaign, contact] = await Promise.all([getCampaign(ctx, enrollment.campaignId), contactName(ctx, issue.companyId, enrollment.contactId)]);
  return {
    done: false,
    missing: [`${contact.name} is still on step ${parsed.position} of campaign "${campaign?.name ?? enrollment.campaignId}": closing this issue should move them on. Close it again, or cancel it to stop the campaign for them.`],
  };
}

/** "Revise campaign": the draft changed after the refusal and a new approval is open (or it is no longer a draft). */
export async function checkRevise(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const parsed = parsePairOrigin(issue.originId, CAMPAIGN_ORIGINS.revise);
  if (!parsed) return done;
  const campaign = await getCampaign(ctx, parsed.id);
  if (!campaign || campaign.companyId !== issue.companyId || campaign.status !== "draft") return done;
  const refusedAt = issue.createdAt;
  const editedAt = await campaignEditedAt(ctx, campaign.id);
  const edited = Boolean(editedAt && (!refusedAt || Date.parse(editedAt) >= Date.parse(refusedAt)));
  let asked = false;
  if (campaign.approvalIssueId && campaign.approvalIssueId !== parsed.rest) {
    const approval = await ctx.issues.get(campaign.approvalIssueId, issue.companyId).catch(() => null);
    asked = Boolean(approval && approval.status !== "cancelled");
  }
  const missing: string[] = [];
  if (!edited) missing.push(`Campaign "${campaign.name}" has not changed since its approval was refused: fix what the approver asked for (\`update-campaign\`, \`add-campaign-step\`, \`create-ab-variant\` or \`set-step-html\`).`);
  if (!asked) missing.push(`Campaign "${campaign.name}" has no new approval: \`request-campaign-approval\` (campaignId \`${campaign.id}\`) once it is fixed.`);
  return missing.length ? { done: false, missing } : done;
}

/**
 * A reply issue is done when the reply was answered or a decision logged with
 * `log-reply`, the contact's address is on the do-not-email list, or their
 * campaign was stopped after the reply came in.
 */
export async function checkReply(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const parsed = parsePairOrigin(issue.originId, CAMPAIGN_ORIGINS.reply);
  if (!parsed) return done;
  const messageId = parsed.rest;
  if (await replyLogged(ctx, issue.companyId, messageId)) return done;
  const enrollment = await enrollmentState(ctx, parsed.id);
  if (!enrollment || enrollment.companyId !== issue.companyId) return done;
  const contact = await contactName(ctx, issue.companyId, enrollment.contactId);
  if (await contactSuppressed(ctx, issue.companyId, enrollment.contactId, contact.emails)) return done;
  // Stopped after the reply came in (the issue opens with it): a stop the plugin made before that is not a decision.
  if (enrollment.status === "stopped" && enrollment.updatedAt && issue.createdAt && Date.parse(enrollment.updatedAt) > Date.parse(issue.createdAt)) return done;
  const campaign = await getCampaign(ctx, enrollment.campaignId);
  return {
    done: false,
    missing: [`The reply from ${contact.name} to campaign "${campaign?.name ?? enrollment.campaignId}" has no answer or decision yet: answer it (\`partnersinbiz.mailbox:create-draft\`) and log it with \`log-reply\` (messageId \`${messageId}\`), or \`stop-enrollment\` / \`suppress-address\`.`],
  };
}

/** Every kind of work Campaigns hands to agents, matched by origin id prefix. */
export const CAMPAIGN_DONE_CHECKS: DoneCheckRule[] = [
  { originPrefix: CAMPAIGN_ORIGINS.step, label: "Campaign step", check: (issue, ctx) => checkStepIssue(ctx, issue, CAMPAIGN_ORIGINS.step) },
  { originPrefix: CAMPAIGN_ORIGINS.sendFailed, label: "Campaign email not sent", check: (issue, ctx) => checkStepIssue(ctx, issue, CAMPAIGN_ORIGINS.sendFailed) },
  { originPrefix: CAMPAIGN_ORIGINS.revise, label: "Revise campaign", check: (issue, ctx) => checkRevise(ctx, issue) },
  { originPrefix: CAMPAIGN_ORIGINS.reply, label: "Campaign reply", check: (issue, ctx) => checkReply(ctx, issue) },
];
