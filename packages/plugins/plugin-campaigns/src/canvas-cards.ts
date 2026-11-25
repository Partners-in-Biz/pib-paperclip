/**
 * The Campaigns card on a planning canvas (PAR-14389 plan C.2, ticket PAR-14423). One kind, `card-campaign`, built on
 * the page's own store reads: `resolve` is `campaigns.detail`'s record check (same company, else hidden), `search` is
 * `campaigns.load`'s own list (PiB's own campaigns, matched on name or status as the page's search box does) and
 * `related` is that list for one CRM client. The three actions sit behind the access guard under `campaigns.view`.
 */
import { PIB_PLUGINS, type CanvasCardCall, type CanvasCardInput, type CanvasCardKind } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getCampaign, listCampaigns, searchCampaigns } from "./db.js";
import { deliveryLabel } from "./detail.js";
import type { CampaignDraft } from "./domain.js";

export const CAMPAIGN_CARD = "card-campaign";

const STATUS_LABEL: Record<string, string> = { active: "Active", completed: "Completed", draft: "Draft", scheduled: "Scheduled", paused: "Paused" };

/** The CRM slot ids a campaign's client can be asked by. */
const CRM_CARD_KIND: Record<string, "company" | "contact"> = { "card-company": "company", "card-contact": "contact" };

export function campaignCard(campaign: CampaignDraft): CanvasCardInput {
  return {
    id: campaign.id,
    title: campaign.name,
    subtitle: campaign.clientName ? `For ${campaign.clientName}` : "PiB's own campaign",
    status: STATUS_LABEL[campaign.status] ?? campaign.status,
    meta: [{ label: "Delivery", value: deliveryLabel(campaign.delivery) }],
    href: `/campaigns?campaign=${encodeURIComponent(campaign.id)}`,
  };
}

export function campaignCardKind(ctx: PluginContext): CanvasCardKind {
  return {
    type: CAMPAIGN_CARD,
    async resolve(ids: string[], call: CanvasCardCall) {
      const found = await Promise.all(ids.map((id) => getCampaign(ctx, id)));
      // The page's detail check: a record of another company, an unknown id and a deleted one all read as nothing.
      return found.filter((c): c is CampaignDraft => c !== null && c.companyId === call.companyId).map(campaignCard);
    },
    async search({ q, limit }, call) {
      return (await searchCampaigns(ctx, call.companyId, q, limit)).map(campaignCard);
    },
    async related({ of }, call) {
      const kind = of.plugin === PIB_PLUGINS.crm ? CRM_CARD_KIND[of.type] : undefined;
      if (!kind) return [];
      const rows = await listCampaigns(ctx, call.companyId, { kind, id: of.id });
      return rows.length ? [{ relation: "campaigns", label: "Campaigns", cards: rows.map(campaignCard) }] : [];
    },
  };
}
