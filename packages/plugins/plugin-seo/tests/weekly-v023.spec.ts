/**
 * The weekly review's numbers beyond rankings: GA4 organic traffic and key events, and AI-search readiness. They reach the
 * review's own result and the approval issue the owner reads.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { approvalIssueDescription, type ProposalCopy } from "../src/engine/copy.js";
import { companyInfo } from "../src/service/common.js";
import { sprintCopy } from "../src/service/context.js";
import { detectSignals, detectSignalsTool, weeklyNumbers } from "../src/service/optimize.js";
import { integrationRow, needsYouRoutes, seoHost, sprintRoutes, type Route, type Row } from "./helpers/seo-host.js";

const GA4_WEEK: Row = { week_start: "2026-09-21", property_id: "222222222", sessions: 500, engaged_sessions: 380, users: 410, key_events: 40, organic_sessions: 200, organic_engaged_sessions: 150, organic_users: 170, organic_key_events: 12, channels: [], landing_pages: [], sources: [], key_event_names: [], ai_referrals: [] };
const GEO_AUDIT: Row = { id: "g-1", sprint_id: "sp-1", audited_on: "2026-10-01", audited_at: "2026-10-01T06:00:00Z", score: 72, band: "good", complete: true, breakdown: {}, sections: {}, finding_count: 2, source: "scheduled" };
const LIVE_PAGE: Row = { id: "c1", company_id: "co-1", sprint_id: "sp-1", title: "VAT guide", type: "post", status: "live", target_url: "https://acme.co.za/blog/vat-guide", published_on: "2026-09-01", impressions: 0, social_post_ids: [], links_to_pillar_ids: [] };

const ga4Connected = integrationRow("ga4", { status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222" } });
const gscConnected = integrationRow("gsc", { status: "connected", last_pull_at: "2026-10-03T06:00:00Z" });

/** Routes for a sprint with Search Console, GA4 and an AI-search audit, and one page that earned nothing: a proposal. */
function withNumbers(): Route[] {
  return [
    [/FROM plugin_seo_8099f8879a\.integrations/, (p, sql) => (/provider = \$3/.test(sql) ? [p[2] === "ga4" ? ga4Connected : gscConnected] : [ga4Connected, gscConnected])],
    [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [GA4_WEEK]],
    [/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT]],
  ];
}

const proposalRoutes: Route[] = [
  [/FROM plugin_seo_8099f8879a\.content/, () => [LIVE_PAGE]],
  [/count\(\*\)::int AS count FROM plugin_seo_8099f8879a\.optimizations/, () => [{ count: 0 }]],
  [/FROM plugin_seo_8099f8879a\.optimizations WHERE id = \$1 AND company_id = \$2/, (p) => [{ id: p[0], company_id: "co-1", sprint_id: "sp-1", signal_type: "zero_impression_content", severity: "medium", subject: "c1", evidence: { url: LIVE_PAGE.target_url }, hypothesis: "The page earned no impressions", hypothesis_type: "title", proposed_action: "Rewrite the title", proposed_tasks: [{ title: "Rewrite the title" }], target_keyword_ids: [], status: "proposed", approval_issue_id: null }]],
  [/FROM plugin_seo_8099f8879a\.optimizations WHERE company_id = \$1 AND sprint_id = \$2/, () => []],
];

function host(routes: Route[]) {
  return seoHost({ routes: [...needsYouRoutes(), ...routes, ...sprintRoutes] });
}

const sprintOf = async (h: ReturnType<typeof host>) => (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;

describe("the numbers beyond rankings", () => {
  it("are the GA4 organic line and the AI-search line, and nothing when neither exists", async () => {
    const h = host(withNumbers());
    const numbers = await weeklyNumbers(h.env, await sprintOf(h));
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toMatch(/^Organic traffic \(GA4\) week of 2026-09-21: 200 sessions/);
    expect(numbers[1]).toMatch(/^AI-search readiness 72\/100 \(good\)/);

    const bare = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => []]]);
    expect(await weeklyNumbers(bare.env, await sprintOf(bare))).toEqual([]);
  });

  it("come back with the weekly review's own result", async () => {
    const h = host(withNumbers());
    const result = await detectSignalsTool(h.env, "co-1", { sprintId: "sp-1" });
    expect(result.numbers).toHaveLength(2);
    expect(result.numbers[0]).toContain("Organic traffic (GA4)");
    expect(result.numbers[1]).toContain("AI-search readiness 72/100");
  });

  it("lead the approval issue the owner reads, ahead of the proposals", async () => {
    const h = host([...withNumbers(), ...proposalRoutes]);
    const info = await companyInfo(h.env, "co-1");
    const result = await detectSignals(h.env, info, await sprintOf(h), { propose: true });
    expect(result.proposalsCreated).toHaveLength(1);
    const issue = h.created.find((c) => /optimiz|SEO/i.test(String(c.input.title)) && /optimizationId/.test(String(c.input.description)));
    expect(issue).toBeDefined();
    const text = String(issue!.input.description);
    expect(text).toContain("**This week's numbers**");
    expect(text).toContain("- Organic traffic (GA4) week of 2026-09-21");
    expect(text).toContain("- AI-search readiness 72/100");
    expect(text.indexOf("This week's numbers")).toBeLessThan(text.indexOf("### "));
  });
});

describe("the approval issue text", () => {
  const sprint = sprintCopy({ id: "sp-1", siteName: "Acme", siteUrl: "https://acme.co.za", clientName: null, autopilotMode: "safe", notes: null, templateId: "outrank-90" } as never);
  const proposal: ProposalCopy = { id: "o-1", signalType: "stuck_page", severity: "high", hypothesis: "H", proposedAction: "A", evidence: { url: "https://acme.co.za/" }, taskTitles: ["T1", "T2"] };

  it("shows the numbers only when there are some", () => {
    const without = approvalIssueDescription(sprint, [proposal], null);
    expect(without).not.toContain("This week's numbers");
    const withNumbers = approvalIssueDescription(sprint, [proposal], null, ["Organic traffic is up", "AI readiness 70/100"]);
    expect(withNumbers).toContain("**This week's numbers**\n- Organic traffic is up\n- AI readiness 70/100\n");
    expect(withNumbers).toContain("### H");
  });
});
