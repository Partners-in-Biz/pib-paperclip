/**
 * What the daily run does for the 0.23.0 features. The pieces have their own tests; these prove the daily job actually
 * calls them, in the right order, and that one failing never stops the rest.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { companyInfo } from "../src/service/common.js";
import { runDailyForSprint } from "../src/service/jobs.js";
import { site } from "./helpers/geo-site.js";
import { executed, integrationRow, needsYouRoutes, seoHost, sprintRoutes, type Route } from "./helpers/seo-host.js";

const agent = { id: "agent-1", status: "idle" };

/** Every item any Needs you write of this run saved (each write holds the item it added). */
function allSavedItems(h: ReturnType<typeof host>): Array<Record<string, unknown>> {
  return executed(h, /INSERT INTO plugin_seo_8099f8879a\.needs_you /).flatMap((w) => JSON.parse(String(w.params[4])) as Array<Record<string, unknown>>);
}

/** Google with a service account that sees no Analytics property at all: the grant is the next step. */
const emptyGoogle = (url: string): Response | undefined => {
  if (url.includes("analyticsadmin.googleapis.com")) return new Response(JSON.stringify({}), { status: 200 });
  if (url.includes("searchconsole") || url.includes("webmasters")) return new Response(JSON.stringify({ siteEntry: [] }), { status: 200 });
  return undefined;
};

function host(routes: Route[] = [], options: Parameters<typeof seoHost>[0] = {}) {
  return seoHost({
    routes: [
      ...needsYouRoutes(),
      [/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 AND provider = \$3/, (p) => [integrationRow(String(p[2]))]],
      ...routes,
      ...sprintRoutes,
    ],
    site: site().fetcher,
    google: emptyGoogle,
    ...options,
  });
}

async function runDaily(h: ReturnType<typeof host>) {
  const info = await companyInfo(h.env, "co-1");
  const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
  return runDailyForSprint(h.env, info, sprint, { agent, projectId: "proj-1" });
}

describe("the daily run and AI search", () => {
  it("records the sprint's first AI-search audit as a scheduled one", async () => {
    const h = host();
    const result = await runDaily(h);
    expect(result.geoAudited).toBe(true);
    const audits = executed(h, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/);
    // The day-32 snapshot carries its own audit; the schedule adds the sprint's first dated one.
    const audit = audits.find((a) => a.params[10] === "scheduled");
    expect(audit).toBeDefined();
    expect(audit!.params).toContain("sp-1");
  });

  it("does not audit twice when the sprint was audited this week", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [{ id: "g-1", sprint_id: "sp-1", audited_on: "2026-10-02", audited_at: "2026-10-02T06:00:00Z", score: 80, band: "good", complete: true, breakdown: {}, sections: {}, finding_count: 0, source: "scheduled" }]]]);
    const result = await runDaily(h);
    expect(result.geoAudited).toBe(false);
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/)).toHaveLength(0);
  });

  it("keeps going when the client's site cannot be read", async () => {
    const h = host([], { site: (async () => { throw new Error("connection refused"); }) as never });
    const result = await runDaily(h);
    expect(result.sprintId).toBe("sp-1");
    // The run still wrote its record for the day.
    expect(executed(h, /UPDATE plugin_seo_8099f8879a\.sprints SET/).some((e) => /last_daily_on/.test(e.sql))).toBe(true);
  });
});

describe("the daily run and Google Analytics", () => {
  it("looks for the sprint's property and raises the one-time grant when the service account sees none", async () => {
    const h = host();
    const result = await runDaily(h);
    expect(h.googleCalls.some((c) => c.url.includes("analyticsadmin.googleapis.com"))).toBe(true);
    expect(result.warnings.filter((w) => w.startsWith("GA4"))).toEqual([]); // a grant waiting on a person is not a warning
    const items = allSavedItems(h);
    expect(items.some((i) => i.key === "ga4_access" && i.check === "ga4_access")).toBe(true);
  });

  it("does not look for a property on a sprint that has not started", async () => {
    const h = host([], { now: "2026-08-25T08:00:00Z" });
    await runDaily(h);
    expect(h.googleCalls.some((c) => c.url.includes("analyticsadmin.googleapis.com"))).toBe(false);
  });
});
