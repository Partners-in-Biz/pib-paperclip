/**
 * Installs and the daily results report: the additive `installs` column, cost per install, and one info alert per platform and day that rides the
 * alerts flow without disturbing the zero-delivery rule. Runs only with embedded Postgres (`describe.skipIf`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateCompany } from "../src/evaluate.js";
import { dailyRows, getAccount, listAlerts, summaryRows } from "../src/db.js";
import { postDailyReports } from "../src/report.js";
import { syncAccount } from "../src/sync.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { COMPANY, world, type World } from "./helpers/world.js";
import { syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const DAY = "2026-10-14";

describe.skipIf(!available)("installs and the daily results report", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w, { spend: 8000 }));
  });

  const resync = async () => syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);

  it("stores installs from an insight row, and 0 for a platform that reports none", async () => {
    w.mock.insightRows["ext-1"] = w.mock.insightRows["ext-1"]!.map((r) => (r.campaignExternalId === "c1" && r.day === DAY ? { ...r, installs: 12 } : r));
    await resync();
    const rows = await dailyRows(w.ctx, COMPANY, DAY, accountId);
    expect(rows.find((r) => r.campaign_external_id === "c1" && r.day === DAY)?.installs).toBe(12);
    expect(rows.filter((r) => r.campaign_external_id !== "c1").every((r) => r.installs === 0)).toBe(true);
    const [total] = await summaryRows(w.ctx, COMPANY, { since: DAY, until: DAY, groupBy: "platform" });
    expect(total?.installs).toBe(12);
  });

  it("still accepts an insert that does not name the installs column (old code, old rows)", async () => {
    await pg.client.query(
      `INSERT INTO ${w.ctx.db.namespace}.daily (company_id, account_id, campaign_external_id, day, spend_minor, impressions, clicks, conversions, conversion_value_minor, currency, synced_at)
       VALUES ($1, $2, 'legacy', '2026-10-01', 100, 10, 1, 0, 0, 'ZAR', now())`,
      [COMPANY, accountId],
    );
    const legacy = (await dailyRows(w.ctx, COMPANY, "2026-10-01", accountId)).find((r) => r.campaign_external_id === "legacy");
    expect(legacy).toMatchObject({ spend: 100, installs: 0 });
  });

  it("posts one report for the day with installs and cost per install, and refreshes it in place when the day is restated", async () => {
    w.mock.insightRows["ext-1"] = w.mock.insightRows["ext-1"]!.map((r) => (r.day === DAY ? { ...r, installs: 4 } : r));
    await resync();
    const first = await postDailyReports(w.rt());
    expect(first).toEqual({ day: DAY, reports: 1 });
    const reports = (await listAlerts(w.ctx, COMPANY, {})).filter((a) => a.kind === "daily_report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ severity: "info", issue_id: null, dedupe_key: `daily_report:mock:ZAR:${DAY}` });
    const detail = reports[0]!.detail as Record<string, number>;
    expect(detail.installs).toBe(8);
    expect(detail.spendMinor).toBe(10_000);
    expect(detail.cpiMinor).toBe(1250);
    expect(reports[0]!.body).toContain("8 installs");

    w.mock.insightRows["ext-1"] = w.mock.insightRows["ext-1"]!.map((r) => (r.day === DAY ? { ...r, installs: 8 } : r));
    await resync();
    await postDailyReports(w.rt());
    const again = (await listAlerts(w.ctx, COMPANY, {})).filter((a) => a.kind === "daily_report");
    expect(again).toHaveLength(1);
    expect((again[0]!.detail as Record<string, number>).installs).toBe(16);
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-alert:"))).toHaveLength(0);
  });

  it("posts nothing for a day with no rows, and a platform with no installs reports cost per install as n/a", async () => {
    expect(await postDailyReports(w.rt(), { day: "2026-09-01" })).toEqual({ day: "2026-09-01", reports: 0 });
    await postDailyReports(w.rt());
    const [report] = (await listAlerts(w.ctx, COMPANY, {})).filter((a) => a.kind === "daily_report");
    expect(report!.body).toContain("0 installs (cost per install n/a)");
  });

  it("keeps the zero-delivery alert firing next to the report", async () => {
    w.mock.insightRows["ext-1"] = w.mock.insightRows["ext-1"]!.filter((r) => !(r.campaignExternalId === "c1" && r.day === DAY));
    await resync();
    await evaluateCompany(w.rt());
    await postDailyReports(w.rt());
    const kinds = (await listAlerts(w.ctx, COMPANY, {})).map((a) => `${a.kind}:${a.campaign_external_id ?? ""}`);
    expect(kinds).toContain("zero_delivery:c1");
    expect(kinds).toContain("daily_report:");
  });
});
