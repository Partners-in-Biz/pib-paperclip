import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addGrantedUser,
  bumpAccessRev,
  getAccessSettings,
  listAccessRefusals,
  listAccessSettings,
  listAccessSync,
  recordAccessRefusal,
  recordAccessSync,
  removeGrantedUser,
  setAccessMode,
} from "../src/access-store.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const CO = "co-1";
const OTHER = "co-2";
const NOW = "2026-11-17T10:00:00.000Z";

function world() {
  return { ctx: { db: pg.db } as unknown as PluginContext };
}

describe.skipIf(!available)("Setup access tables on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  describe("access_settings", () => {
    it("adds an id without changing rev, never twice, and keeps other companies apart", async () => {
      const { ctx } = world();
      expect(await getAccessSettings(ctx, CO)).toBeNull();
      await addGrantedUser(ctx, CO, "u1", "owner", NOW);
      await addGrantedUser(ctx, CO, "u1", "owner", NOW);
      await addGrantedUser(ctx, CO, "u2", "admin2", NOW);
      await addGrantedUser(ctx, OTHER, "u9", "owner", NOW);
      expect(await getAccessSettings(ctx, CO)).toEqual({ companyId: CO, mode: "off", rev: 0, grantedUserIds: ["u1", "u2"], updatedAt: NOW, updatedBy: "admin2" });
      expect((await listAccessSettings(ctx)).map((row) => [row.companyId, row.grantedUserIds])).toEqual([
        [CO, ["u1", "u2"]],
        [OTHER, ["u9"]],
      ]);
    });

    it("raises rev by one per change: grant, removal and switch", async () => {
      const { ctx } = world();
      await addGrantedUser(ctx, CO, "u1", "owner", NOW);
      expect(await bumpAccessRev(ctx, CO, "owner", NOW)).toBe(1);
      expect(await setAccessMode(ctx, CO, "report", "owner", NOW)).toBe(2);
      expect(await removeGrantedUser(ctx, CO, "u1", "owner", NOW)).toBe(3);
      expect(await getAccessSettings(ctx, CO)).toMatchObject({ mode: "report", rev: 3, grantedUserIds: [] });
      // A switch on a company with no row starts it at rev 1.
      expect(await setAccessMode(ctx, OTHER, "off", "owner", NOW)).toBe(1);
    });

    it("refuses a mode the table does not know", async () => {
      await expect(pg.client.query(`INSERT INTO ${NAMESPACE}.access_settings (company_id, mode) VALUES ('x', 'open')`)).rejects.toThrow();
    });
  });

  describe("access_sync", () => {
    it("keeps the highest confirmed rev per plugin; a late older confirmation changes nothing", async () => {
      const { ctx } = world();
      await recordAccessSync(ctx, { companyId: CO, pluginKey: "partnersinbiz.ads", rev: 3, syncedAt: NOW });
      await recordAccessSync(ctx, { companyId: CO, pluginKey: "partnersinbiz.ads", rev: 2, syncedAt: "2026-11-17T10:05:00.000Z" });
      await recordAccessSync(ctx, { companyId: CO, pluginKey: "partnersinbiz.crm", rev: 1, syncedAt: NOW });
      await recordAccessSync(ctx, { companyId: CO, pluginKey: "partnersinbiz.crm", rev: 4, syncedAt: "2026-11-17T10:06:00.000Z" });
      await recordAccessSync(ctx, { companyId: OTHER, pluginKey: "partnersinbiz.ads", rev: 9, syncedAt: NOW });
      expect(await listAccessSync(ctx, CO)).toEqual([
        { companyId: CO, pluginKey: "partnersinbiz.ads", rev: 3, syncedAt: NOW },
        { companyId: CO, pluginKey: "partnersinbiz.crm", rev: 4, syncedAt: "2026-11-17T10:06:00.000Z" },
      ]);
    });
  });

  describe("access_refusals", () => {
    it("keeps the newest 500 per company, newest first, and leaves other companies alone", async () => {
      const { ctx } = world();
      const at = (i: number) => new Date(Date.UTC(2026, 10, 17, 0, 0, i)).toISOString();
      await recordAccessRefusal(ctx, { companyId: OTHER, pluginKey: "partnersinbiz.ads", userId: "u9", key: "ads.list", permission: null, viaAgentId: null, createdAt: at(0) });
      for (let i = 0; i < 502; i++) {
        await recordAccessRefusal(ctx, { companyId: CO, pluginKey: "partnersinbiz.crm", userId: "u1", key: `k${i}`, permission: "crm.contacts:view", viaAgentId: i % 2 ? "agent-1" : null, createdAt: at(i + 1) });
      }
      const rows = await listAccessRefusals(ctx, CO);
      expect(rows).toHaveLength(500);
      expect(rows[0]).toEqual({ companyId: CO, pluginKey: "partnersinbiz.crm", userId: "u1", key: "k501", permission: "crm.contacts:view", viaAgentId: "agent-1", createdAt: at(502) });
      expect(rows.at(-1)!.key).toBe("k2");
      expect((await listAccessRefusals(ctx, CO, 3)).map((row) => row.key)).toEqual(["k501", "k500", "k499"]);
      expect(await listAccessRefusals(ctx, OTHER)).toHaveLength(1);
    }, 60_000);
  });
});
