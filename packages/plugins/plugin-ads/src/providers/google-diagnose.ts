/**
 * `diagnose-google-campaign` (PAR-11049): why does an ENABLED Google campaign not serve? Read-only GAQL, one query per section, so a
 * failing section (a field the API version lacks, a permission) comes back as `{ error }` and the rest still answers.
 * The runner is injected (the provider passes its own paged GAQL call), so tests need no network.
 */
export type GaqlRunner = (query: string, label: string) => Promise<Array<Record<string, any>>>;

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

const digitsOnly = (v: string) => v.replace(/\D/g, "");

async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CampaignDiagnosis {
  campaignId: string;
  customerId: string;
  readOnly: true;
  campaign: Section<Record<string, unknown> | null>;
  adGroups: Section<Array<Record<string, unknown>>>;
  ads: Section<Array<Record<string, unknown>>>;
  keywords: Section<Array<Record<string, unknown>>>;
  billing: Section<{ customerStatus: unknown; billingSetups: Array<Record<string, unknown>> }>;
  targeting: Section<{ locations: number; schedules: number; other: number }>;
}

export async function diagnoseCampaign(run: GaqlRunner, customerId: string, campaignId: string): Promise<CampaignDiagnosis> {
  const cid = digitsOnly(campaignId);
  if (!cid) throw new Error("campaignId must be the Google campaign id (digits).");
  const [campaign, adGroups, ads, keywords, billing, targeting] = await Promise.all([
    section(async () => {
      const rows = await run(
        `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, campaign.primary_status_reasons, campaign.bidding_strategy_type, campaign.start_date, campaign.end_date FROM campaign WHERE campaign.id = ${cid}`,
        "Google campaign",
      );
      return rows[0]?.campaign ?? null;
    }),
    section(async () => {
      const rows = await run(
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.primary_status_reasons, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${cid}`,
        "Google ad groups",
      );
      return rows.map((r) => r.adGroup ?? {});
    }),
    section(async () => {
      const rows = await run(
        `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.primary_status, ad_group_ad.primary_status_reasons, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad WHERE campaign.id = ${cid}`,
        "Google ads",
      );
      return rows.map((r) => ({ adGroupId: r.adGroup?.id, ...(r.adGroupAd ?? {}) }));
    }),
    section(async () => {
      const rows = await run(
        `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.system_serving_status, ad_group_criterion.approval_status FROM ad_group_criterion WHERE campaign.id = ${cid} AND ad_group_criterion.type = 'KEYWORD'`,
        "Google keywords",
      );
      return rows.map((r) => ({ adGroupId: r.adGroup?.id, ...(r.adGroupCriterion ?? {}) }));
    }),
    section(async () => {
      const customerRows = await run("SELECT customer.id, customer.status FROM customer LIMIT 1", "Google customer status");
      const setups = await run("SELECT billing_setup.id, billing_setup.status, billing_setup.payments_account FROM billing_setup", "Google billing setup");
      return { customerStatus: customerRows[0]?.customer?.status ?? null, billingSetups: setups.map((r) => r.billingSetup ?? {}) };
    }),
    section(async () => {
      const rows = await run(`SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative FROM campaign_criterion WHERE campaign.id = ${cid}`, "Google targeting");
      const count = { locations: 0, schedules: 0, other: 0 };
      for (const r of rows) {
        const t = String(r.campaignCriterion?.type ?? "").toUpperCase();
        if (t === "LOCATION") count.locations += 1;
        else if (t === "AD_SCHEDULE") count.schedules += 1;
        else count.other += 1;
      }
      return count;
    }),
  ]);
  return { campaignId: cid, customerId: digitsOnly(customerId), readOnly: true, campaign, adGroups, ads, keywords, billing, targeting };
}
