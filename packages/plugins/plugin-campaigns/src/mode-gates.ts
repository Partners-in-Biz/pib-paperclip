/**
 * The mode gates in the shared functions (plan PAR-9192 rev. 2, 5.2): what an agent may do on a campaign without a
 * person, checked inside `launch`, `launchCampaign`, `setStatus`, `enroll`, `declareWinner`, the draft edits and the
 * results reads, so the tool and the page action meet the same rule.
 *
 * Who is gated: an agent, and a caller nobody knows (a tool call without an agent, a page action without a signed-in
 * person). A person passes, and so does the plugin itself (`auto`) when it acts on a person's approval.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { agentMay, CAMPAIGN_MODE_LABELS, DEFAULT_CAMPAIGN_MODE, type CampaignAgentAction, type CampaignScope } from "@partnersinbiz/pib-plugin-kit";
import { actorRef, type CampaignActor } from "./activity.js";
import { customerCount } from "./approval-audience.js";
import { launchAudience } from "./audience.js";
import { isClientCampaign } from "./brands.js";
import { campaignStats, listSteps } from "./db.js";
import { CampaignError, type CampaignDraft } from "./domain.js";
import { abSuggestionFor } from "./mail.js";

export function isGatedCaller(actor: CampaignActor | null): boolean {
  return !actor || actor.kind === "agent";
}

/** Resume after the caller's own pause, or after someone else's (a person, the automatic pause, or unknown). */
export function resumeRule(campaign: Pick<CampaignDraft, "pausedBy">, actor: CampaignActor | null): CampaignAgentAction {
  return actor && campaign.pausedBy && campaign.pausedBy === actorRef(actor) ? "resume-own-pause" : "resume-other-pause";
}

/**
 * Client campaign, and whether an own campaign reaches a current client. Only the launch rows name the approver from
 * it (person, or the owner); the other rows in this module do not read the scope.
 */
async function scopeFor(ctx: PluginContext, companyId: string, campaign: CampaignDraft, action: CampaignAgentAction): Promise<CampaignScope> {
  const isClient = await isClientCampaign(ctx, companyId, campaign).catch(() => false);
  if (action !== "first-launch" || isClient) return { isClient, reachesClients: false };
  const reachesClients = await (async () => {
    const steps = await listSteps(ctx, campaign.id);
    const { eligible } = await launchAudience(ctx, companyId, campaign, steps, []);
    return (await customerCount(ctx, companyId, eligible.map((contact) => contact.id))) > 0;
  })().catch(() => false);
  return { isClient, reachesClients };
}

/**
 * Refuses an agent (or an unknown caller) what the campaign's mode does not allow, with the sentence that tells it to
 * ask a person on the campaign's task. A "yes" with a condition checks the condition here. Changes nothing.
 */
export async function assertAgentMay(
  ctx: PluginContext,
  companyId: string,
  campaign: CampaignDraft,
  actor: CampaignActor | null,
  action: CampaignAgentAction,
  detail: { winner?: "a" | "b" } = {},
): Promise<void> {
  if (!isGatedCaller(actor)) return;
  const mode = campaign.autopilotMode ?? DEFAULT_CAMPAIGN_MODE;
  const decision = agentMay(mode, action, await scopeFor(ctx, companyId, campaign, action));
  if (!decision.allowed) throw new CampaignError(actor ? decision.reason : `${decision.reason} (The caller is not known, so it counts as an agent.)`);
  if (decision.condition === "significance") {
    // The existing rule (suggest-ab-winner): a clear verdict, and the agent picks the version it names.
    const suggestion = await abSuggestionFor(ctx, campaign.id);
    if (!suggestion.suggestion || suggestion.suggestion !== detail.winner) {
      throw new CampaignError(
        `In ${CAMPAIGN_MODE_LABELS[mode]} mode an agent picks the A/B winner only when suggest-ab-winner names that version; now: ${suggestion.reason} Wait for more sends, or a person picks it on the campaign screen.`,
      );
    }
  }
  if (decision.condition === "all-enrollments-finished") {
    const { running } = await campaignStats(ctx, campaign.id);
    if (running > 0) {
      throw new CampaignError(
        `In ${CAMPAIGN_MODE_LABELS[mode]} mode an agent completes a campaign only when every enrollment is finished; ${running} still running. Wait, or say so on the campaign's task and a person completes it on the campaign screen.`,
      );
    }
  }
}
