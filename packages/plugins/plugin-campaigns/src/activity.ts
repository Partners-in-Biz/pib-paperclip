/**
 * Who acts on a campaign, and the host activity entry each gated mutation writes (plan PAR-9192 rev. 2, 5.2): who, what,
 * which campaign, in which mode. Needs `activity.log.write` (declared in 0.10, Stage 3a).
 *
 * A page action called by an agent is an agent: the page cannot be used to skip the agent rules.
 */
import type { PluginContext, PluginPerformActionContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { CAMPAIGN_MODE_LABELS, DEFAULT_CAMPAIGN_MODE, type CampaignMode } from "@partnersinbiz/pib-plugin-kit";
import type { CampaignDraft } from "./domain.js";

export type CampaignActor = { kind: "agent"; id: string } | { kind: "user"; id: string } | { kind: "auto" };

/** `agent:<id>`, `user:<id>` or `auto`, as `paused_by` stores it. */
export function actorRef(actor: CampaignActor): string {
  return actor.kind === "auto" ? "auto" : `${actor.kind}:${actor.id}`;
}

/** A tool call is always an agent's. */
export function toolActor(run: Pick<ToolRunContext, "agentId">): CampaignActor | null {
  return run.agentId ? { kind: "agent", id: run.agentId } : null;
}

/** The caller of a page action: an agent when the host names one, else the signed-in person, else nobody known. */
export function actionActor(context: Pick<PluginPerformActionContext, "actor">): CampaignActor | null {
  const actor = context.actor;
  if (actor.agentId) return { kind: "agent", id: actor.agentId };
  if (actor.type === "user" && actor.userId) return { kind: "user", id: actor.userId };
  return null;
}

export interface CampaignActivity {
  companyId: string;
  actor: CampaignActor | null;
  /** What happened, as a verb phrase: "paused", "set the mode to Off". Also `metadata.action` as a short key. */
  action: string;
  summary: string;
  campaign: Pick<CampaignDraft, "id" | "name"> & { autopilotMode?: CampaignMode };
  /** The mode the campaign is in after the change (default: the campaign's). */
  mode?: CampaignMode;
  details?: Record<string, unknown>;
}

/**
 * Writes one activity entry. Never throws: a stop (pause) or a lowered mode must not be undone because the log failed,
 * so a failure is logged and reported as `false`.
 */
export async function logCampaignActivity(ctx: PluginContext, entry: CampaignActivity): Promise<boolean> {
  const mode = entry.mode ?? entry.campaign.autopilotMode ?? DEFAULT_CAMPAIGN_MODE;
  const who = entry.actor ? actorRef(entry.actor) : "unknown";
  try {
    await ctx.activity.log({
      companyId: entry.companyId,
      message: `${who} ${entry.summary} campaign "${entry.campaign.name}" (mode ${CAMPAIGN_MODE_LABELS[mode]})`,
      entityType: "plugin_campaigns_campaign",
      entityId: entry.campaign.id,
      metadata: { actor: who, action: entry.action, campaignId: entry.campaign.id, campaignName: entry.campaign.name, mode, ...entry.details },
    });
    return true;
  } catch (error) {
    ctx.logger.warn("Could not write the campaign activity entry", { campaignId: entry.campaign.id, action: entry.action, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
