/**
 * A new sprint is seeded with the GEO tasks and a Google Analytics row beside Search Console, PageSpeed and Bing, so the
 * Setup checklist and the daily property search have somewhere to record what they find.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { seedTemplate } from "../src/service/sprints.js";
import { GEO_TASK_KEYS } from "../src/templates/geo.js";
import { executed, seoHost, sprintRoutes } from "./helpers/seo-host.js";

describe("seeding a sprint", () => {
  it("adds a disconnected Google Analytics integration next to the other providers", async () => {
    const h = seoHost({ routes: sprintRoutes });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    await seedTemplate(h.env, sprint);
    const rows = executed(h, /INSERT INTO plugin_seo_8099f8879a\.integrations /).map((e) => [e.params[3], e.params[4]]);
    expect(rows).toEqual([["gsc", "disconnected"], ["pagespeed", "enabled"], ["bing", "disabled"], ["ga4", "disconnected"]]);
  });

  it("puts the GEO tasks in the first insert of tasks", async () => {
    const h = seoHost({ routes: sprintRoutes });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    await seedTemplate(h.env, sprint);
    const text = executed(h, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/).map((e) => JSON.stringify(e.params)).join(" ");
    for (const key of GEO_TASK_KEYS) expect(text).toContain(key);
  });
});
