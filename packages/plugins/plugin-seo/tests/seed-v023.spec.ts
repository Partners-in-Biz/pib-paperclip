/**
 * Seeding a sprint's plan: a sprint a person switched AI search and Google Analytics on for also gets the GEO tasks and a
 * Google Analytics row beside Search Console, PageSpeed and Bing; a sprint with them off (every new sprint, and every
 * sprint that existed before) gets neither, so nothing about it differs from a 0.22.0 sprint.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { seedTemplate } from "../src/service/sprints.js";
import { GEO_TASK_KEYS } from "../src/templates/geo.js";
import { executed, seoHost, sprintRoutes, sprintRoutesOff } from "./helpers/seo-host.js";

const seeded = async (routes: typeof sprintRoutes) => {
  const h = seoHost({ routes });
  const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
  const result = await seedTemplate(h.env, sprint);
  return { h, result };
};

describe("seeding a sprint with the extras switched on", () => {
  it("adds a disconnected Google Analytics integration next to the other providers", async () => {
    const { h } = await seeded(sprintRoutes);
    const rows = executed(h, /INSERT INTO plugin_seo_8099f8879a\.integrations /).map((e) => [e.params[3], e.params[4]]);
    expect(rows).toEqual([["gsc", "disconnected"], ["pagespeed", "enabled"], ["bing", "disabled"], ["ga4", "disconnected"]]);
  });

  it("adds the GEO tasks after the plan's own, in one idempotent insert", async () => {
    const { h, result } = await seeded(sprintRoutes);
    const inserts = executed(h, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/);
    expect(inserts).toHaveLength(2); // the plan, then the add-on
    const text = JSON.stringify(inserts[1]!.params);
    for (const key of GEO_TASK_KEYS) expect(text).toContain(key);
    expect(JSON.stringify(inserts[0]!.params)).not.toContain("-geo-");
    expect(result.tasks).toBeGreaterThan(0);
  });
});

describe("seeding a sprint with the extras off (what a new sprint is)", () => {
  it("adds no Google Analytics integration: only Search Console, PageSpeed and Bing", async () => {
    const { h } = await seeded(sprintRoutesOff);
    const rows = executed(h, /INSERT INTO plugin_seo_8099f8879a\.integrations /).map((e) => [e.params[3], e.params[4]]);
    expect(rows).toEqual([["gsc", "disconnected"], ["pagespeed", "enabled"], ["bing", "disabled"]]);
  });

  it("seeds the plan's tasks only: no GEO task", async () => {
    const { h } = await seeded(sprintRoutesOff);
    const inserts = executed(h, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/);
    expect(inserts).toHaveLength(1);
    const text = JSON.stringify(inserts[0]!.params);
    for (const key of GEO_TASK_KEYS) expect(text).not.toContain(key);
    expect(text).not.toContain("geo-");
  });
});
