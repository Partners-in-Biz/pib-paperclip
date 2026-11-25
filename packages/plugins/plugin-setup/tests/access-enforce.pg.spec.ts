/**
 * While on `enforce` (PAR-12578 plan, 4.3 and 9): the red flag after 15 minutes,
 * the one hourly-job entry per day per plugin and company, and the way-out runbook.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GUARDED_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAccessSettings, recordAccessSync, setAccessMode } from "../src/access-store.js";
import { ACCESS_PEERS, ACCESS_RED_AFTER_MS, accessPluginStatus, accessStatus, noteRedPlugins } from "../src/access-sync.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const CO = "0b5e1c7a-1111-4a2b-8c3d-000000000001";
const OTHER = "0b5e1c7a-1111-4a2b-8c3d-000000000002";
const OWNER = { type: "user", userId: "owner" };
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-17T10:00:00.000Z");

const MEMBERS = [
  { principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" },
  { principalType: "user", principalId: "u1", membershipRole: "member", status: "active" },
];

function world(opts: { activityFails?: () => boolean } = {}) {
  const activity: Array<{ companyId: string; message: string; metadata: Record<string, unknown> }> = [];
  const ctx = {
    db: pg.db,
    config: { get: async () => ({ modules: {} }) },
    state: { get: async () => null },
    access: {
      members: {
        list: async () => MEMBERS,
      },
    },
    activity: {
      log: async (entry: { companyId: string; message: string; metadata: Record<string, unknown> }) => {
        if (opts.activityFails?.()) throw new Error("activity down");
        activity.push(entry);
      },
    },
    events: { emit: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return { ctx, activity };
}

async function confirmAll(ctx: PluginContext, companyId: string, rev: number, skip: string[] = []) {
  for (const pluginKey of ACCESS_PEERS) {
    if (!skip.includes(pluginKey)) await recordAccessSync(ctx, { companyId, pluginKey, rev, syncedAt: new Date(T0).toISOString() });
  }
}

/** Puts the company on `enforce` at `rev` 1, changed at `at`. */
async function onEnforce(ctx: PluginContext, companyId: string, at: number) {
  await setAccessMode(ctx, companyId, "enforce", "owner", new Date(at).toISOString());
}

describe.skipIf(!available)("access on enforce, on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  describe("the red flag while on enforce", () => {
    it("is red only after 15 minutes behind, only for a plugin behind, and never on report", async () => {
      const { ctx } = world();
      await onEnforce(ctx, CO, T0);
      await confirmAll(ctx, CO, 1, ["partnersinbiz.ads", "partnersinbiz.crm"]);
      await recordAccessSync(ctx, { companyId: CO, pluginKey: "partnersinbiz.crm", rev: 0, syncedAt: new Date(T0).toISOString() });
      const settings = await getAccessSettings(ctx, CO);
      const at = async (ms: number) => (await accessPluginStatus(ctx, settings, CO, () => ms)).filter((p) => p.red).map((p) => p.pluginKey).sort();

      expect(await at(T0 + ACCESS_RED_AFTER_MS)).toEqual([]);
      expect(await at(T0 + ACCESS_RED_AFTER_MS + 1)).toEqual(["partnersinbiz.ads", "partnersinbiz.crm"]);

      const all = await accessPluginStatus(ctx, settings, CO, () => T0 + DAY);
      expect(all.map((p) => p.pluginKey)).toEqual([...GUARDED_PLUGINS]);
      expect(all.find((p) => p.pluginKey === PLUGIN_ID)).toMatchObject({ confirmed: true, red: false });
      expect(all.find((p) => p.pluginKey === "partnersinbiz.ads")).toMatchObject({ rev: null, confirmed: false, red: true });
      expect(all.find((p) => p.pluginKey === "partnersinbiz.crm")).toMatchObject({ rev: 0, confirmed: false, red: true });

      await setAccessMode(ctx, CO, "report", "owner", new Date(T0).toISOString());
      expect((await accessPluginStatus(ctx, await getAccessSettings(ctx, CO), CO, () => T0 + DAY)).some((p) => p.red)).toBe(false);
    });

    it("is shown to an owner or admin only", async () => {
      const { ctx } = world();
      await onEnforce(ctx, CO, T0);
      expect(await accessStatus(ctx, CO, { type: "user", userId: "u1" })).toMatchObject({ ok: false });
      const status = await accessStatus(ctx, CO, OWNER, () => T0 + DAY);
      expect(status).toMatchObject({ ok: true, mode: "enforce", rev: 1 });
      expect(status.ok && status.plugins.filter((p) => p.red)).toHaveLength(ACCESS_PEERS.length);
    });
  });

  describe("the hourly entry", () => {
    it("writes one entry per day per plugin and company, not more", async () => {
      const { ctx, activity } = world();
      await onEnforce(ctx, CO, T0);
      await onEnforce(ctx, OTHER, T0);
      await confirmAll(ctx, CO, 1, ["partnersinbiz.ads"]);
      await confirmAll(ctx, OTHER, 1, ["partnersinbiz.crm", "partnersinbiz.voice"]);

      // Two runs at the same time first, then every hour to the end of the day (UTC).
      const hour = 3_600_000;
      const pair = await Promise.all([noteRedPlugins(ctx, () => T0 + hour), noteRedPlugins(ctx, () => T0 + hour)]);
      expect(pair[0].noted + pair[1].noted).toBe(3);
      for (let h = 2; h < 14; h++) expect(await noteRedPlugins(ctx, () => T0 + h * hour)).toEqual({ noted: 0, failed: 0 });
      expect(activity.map((e) => [e.companyId, e.metadata.pluginKey])).toEqual([
        [CO, "partnersinbiz.ads"],
        [OTHER, "partnersinbiz.crm"],
        [OTHER, "partnersinbiz.voice"],
      ]);
      expect(activity[0]!.message).toContain("partnersinbiz.ads has not confirmed");
      expect(activity[0]!.metadata).toMatchObject({ rev: 1, confirmedRev: null });

      // The next day (UTC), once more each.
      expect(await noteRedPlugins(ctx, () => T0 + DAY)).toEqual({ noted: 3, failed: 0 });
      expect(await noteRedPlugins(ctx, () => T0 + DAY + hour)).toEqual({ noted: 0, failed: 0 });
      expect(activity).toHaveLength(6);
    });

    it("writes nothing before 15 minutes, for a confirmed plugin, or off enforce", async () => {
      const { ctx, activity } = world();
      await onEnforce(ctx, CO, T0);
      expect(await noteRedPlugins(ctx, () => T0 + ACCESS_RED_AFTER_MS)).toEqual({ noted: 0, failed: 0 });
      await confirmAll(ctx, CO, 1);
      expect(await noteRedPlugins(ctx, () => T0 + DAY)).toEqual({ noted: 0, failed: 0 });
      await setAccessMode(ctx, OTHER, "report", "owner", new Date(T0).toISOString());
      expect(await noteRedPlugins(ctx, () => T0 + DAY)).toEqual({ noted: 0, failed: 0 });
      expect(activity).toEqual([]);
    });

    it("tries again the next hour when the entry could not be written", async () => {
      let down = true;
      const { ctx, activity } = world({ activityFails: () => down });
      await onEnforce(ctx, CO, T0);
      await confirmAll(ctx, CO, 1, ["partnersinbiz.ads"]);
      expect(await noteRedPlugins(ctx, () => T0 + 3_600_000)).toEqual({ noted: 0, failed: 1 });
      down = false;
      expect(await noteRedPlugins(ctx, () => T0 + 7_200_000)).toEqual({ noted: 1, failed: 0 });
      expect(activity).toHaveLength(1);
    });
  });
});

describe("the way-out runbook", () => {
  const deploy = readFileSync(fileURLToPath(new URL("../../DEPLOY.md", import.meta.url)), "utf8");

  it("is in packages/plugins/DEPLOY.md with the SQL for Setup's schema", () => {
    expect(deploy).toContain("## Access switch: the way out");
    expect(deploy).toContain(`UPDATE ${NAMESPACE}.access_settings SET mode = 'off', rev = rev + 1, updated_at = now() WHERE company_id = '<company>';`);
    expect(deploy).toContain("plugin_database_namespaces");
  });
});
